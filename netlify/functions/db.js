/* ════════════════════════════════════════════════════════════════════════
   POST /.netlify/functions/db — ShippingCloud cloud database + auth
   ------------------------------------------------------------------------
   The ONLY thing that talks to the database. The browser never sees a
   database key. Backed by Supabase Postgres via its REST API (plain fetch,
   zero dependencies), table `app_stores` (tenant, key, value jsonb).

   Env vars (Netlify): SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SECRET
   (SESSION_SECRET optional — derived from the service key if unset).
   DB_TENANT (optional, default "main"): which tenant's rows this site reads
   and writes in app_stores. Production sites leave it unset; the staging /
   sandbox sites set DB_TENANT=sandbox and get a completely separate copy of
   every store (users, clients, rates, settings, shipments) in the SAME
   Supabase project — nothing a sandbox login does can touch production.

   Actions:
   • ping                          → { configured }
   • login {email,password}        → { token, user }  (first-ever login
                                     bootstraps that email as the admin)
   • getAll {token}                → { stores }  admin: everything;
                                     others: only their own u/<uid>/ keys.
                                     Password hashes NEVER leave the server.
   • putMany {token, stores}       → { ok, saved } namespace-enforced writes
   • setPassword {token,email,newPassword} → admin (anyone) / self only

   Security model: scrypt password hashes; HMAC-SHA256 session tokens
   (30-day expiry, timing-safe verification); per-user namespace walls
   enforced HERE, not in the browser; users store is admin-write-only and
   served with hashes stripped. Always returns HTTP 200 JSON.
   ════════════════════════════════════════════════════════════════════════ */
const crypto = require("crypto");

const J = (obj) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
const CFG = () => ({
  url: (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, ""),
  key: (process.env.SUPABASE_SERVICE_KEY || "").trim(),
});
const configured = () => { const c = CFG(); return !!(c.url && c.key); };
/* Tenant wall: every store read/write below is scoped to this tenant. "main" = production. */
const TENANT = (process.env.DB_TENANT || "main").trim() || "main";
/* Default service set for a NEW customer — mirrors DEFAULT_BLOCKED_SERVICES in the app. */
const DEFAULT_BLOCKED_SERVICES = ["2day_am","intl_priority_express","intl_first","first_overnight_freight","1day_freight","2day_freight","3day_freight","intl_priority_freight","intl_economy_freight","or_first_overnight","or_priority_overnight","or_standard_overnight","or_2day_am","or_express_saver"];
const secret = () => (process.env.SESSION_SECRET || "").trim() || crypto.createHash("sha256").update("sc1|" + CFG().key).digest("hex");

/* ── Supabase PostgREST (service role) ── */
async function pg(path, opts = {}) {
  const c = CFG();
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(c.url + "/rest/v1/" + path, { ...opts, headers: { apikey: c.key, Authorization: "Bearer " + c.key, "Content-Type": "application/json", ...(opts.headers || {}) }, signal: ctrl.signal });
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
    return { ok: r.ok, status: r.status, data, text };
  } catch (e) { return { ok: false, status: 0, text: (e && e.message) || "network error" }; }
  finally { clearTimeout(t); }
}
const getStore = async (key) => {
  const r = await pg("app_stores?tenant=eq." + encodeURIComponent(TENANT) + "&key=eq." + encodeURIComponent(key) + "&select=value");
  if (!r.ok) return { ok: false, err: r };
  return { ok: true, value: Array.isArray(r.data) && r.data[0] ? r.data[0].value : undefined };
};
const putStores = async (map) => {
  const rows = Object.keys(map).map((k) => ({ tenant: TENANT, key: k, value: map[k], updated_at: new Date().toISOString() }));
  if (!rows.length) return { ok: true };
  const r = await pg("app_stores?on_conflict=tenant,key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
  return { ok: r.ok, err: r.ok ? null : r };
};

/* ── passwords (scrypt) + tokens (HMAC) ── */
const hashPw = (pw) => { const salt = crypto.randomBytes(16).toString("hex"); return "scrypt$" + salt + "$" + crypto.scryptSync(String(pw), salt, 64).toString("hex"); };
const checkPw = (pw, stored) => {
  try {
    const [scheme, salt, hex] = String(stored || "").split("$");
    if (scheme !== "scrypt" || !salt || !hex) return false;
    const calc = crypto.scryptSync(String(pw), salt, 64);
    const want = Buffer.from(hex, "hex");
    return calc.length === want.length && crypto.timingSafeEqual(calc, want);
  } catch { return false; }
};
const b64u = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const sign = (p) => crypto.createHmac("sha256", secret()).update(p).digest("hex");
const makeToken = (user) => { const p = b64u(JSON.stringify({ uid: String(user.id), email: user.email, role: user.role || "customer", clientId: user.clientId || null, exp: Date.now() + 30 * 24 * 3600 * 1000 })); return p + "." + sign(p); };
function verifyToken(token) {
  try {
    const [p, sig] = String(token || "").split(".");
    if (!p || !sig) return null;
    const want = Buffer.from(sign(p), "hex"); const got = Buffer.from(sig, "hex");
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const payload = JSON.parse(unb64u(p));
    if (!payload || payload.kind || !payload.uid || !payload.exp || Date.now() > payload.exp) return null;   /* kind = pwreset — only resetPassword may consume it */
    return payload;
  } catch { return null; }
}

/* ── two-factor auth (TOTP, RFC 6238) ── opt-in, off by default so no one can be locked out.
   Standard base32 (RFC 4648) for the shared secret so Google Authenticator / Authy / 1Password
   can scan the otpauth:// QR and produce matching 6-digit codes. HMAC-SHA1, 30-second step. */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32encode(buf) {
  let bits = 0, val = 0, out = "";
  for (let i = 0; i < buf.length; i++) { val = (val << 8) | buf[i]; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  const s = String(str || "").toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0, val = 0; const out = [];
  for (let i = 0; i < s.length; i++) { const idx = B32.indexOf(s[i]); if (idx < 0) continue; val = (val << 5) | idx; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
const newTotpSecret = () => b32encode(crypto.randomBytes(20));   // 160-bit secret
function totpAt(secretB32, counter) {
  const key = b32decode(secretB32);
  const buf = Buffer.alloc(8);
  // 64-bit counter, big-endian (write the low 32 bits; high bits are 0 until year ~10889)
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[off] & 0x7f) << 24) | ((hmac[off + 1] & 0xff) << 16) | ((hmac[off + 2] & 0xff) << 8) | (hmac[off + 3] & 0xff);
  return String(bin % 1000000).padStart(6, "0");
}
function totpVerify(secretB32, code, step) {
  const c = String(code || "").replace(/\D/g, "");
  if (c.length !== 6 || !secretB32) return false;
  const counter = Math.floor(Date.now() / 1000 / (step || 30));
  // accept the current step ±1 (clock skew tolerance)
  for (let w = -1; w <= 1; w++) {
    try { if (crypto.timingSafeEqual(Buffer.from(totpAt(secretB32, counter + w)), Buffer.from(c))) return true; } catch { /* length mismatch */ }
  }
  return false;
}
const otpauthUrl = (email, secretB32, issuer) =>
  "otpauth://totp/" + encodeURIComponent((issuer || "ShippingCloud") + ":" + email) +
  "?secret=" + secretB32 + "&issuer=" + encodeURIComponent(issuer || "ShippingCloud") + "&algorithm=SHA1&digits=6&period=30";

/* ── one-time backup codes ── the lost-phone escape hatch that doesn't need an admin.
   Codes are shown ONCE at setup; only their SHA-256 hashes are stored. High-entropy random,
   so a single fast hash + timing-safe compare is enough (no need for slow scrypt here). */
const BC_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O/1/I — easy to read/type
const normBackup = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const hashBackup = (code) => crypto.createHash("sha256").update(normBackup(code)).digest("hex");
function newBackupCodes(n) {
  const count = n || 10, plain = [], stored = [];
  for (let i = 0; i < count; i++) {
    const bytes = crypto.randomBytes(8);
    let raw = ""; for (let j = 0; j < 8; j++) raw += BC_ALPHA[bytes[j] % BC_ALPHA.length];
    const pretty = raw.slice(0, 4) + "-" + raw.slice(4);   // e.g. AB3K-9XQ7
    plain.push(pretty);
    stored.push({ h: hashBackup(pretty), used: false });
  }
  return { plain, stored };
}
/* returns {ok, remaining} — consumes (marks used) a matching unused code, timing-safe */
function consumeBackup(list, code) {
  const arr = Array.isArray(list) ? list : [];
  const want = hashBackup(code);
  if (!normBackup(code)) return { ok: false, list: arr };
  for (const e of arr) {
    if (e && !e.used && e.h && want.length === String(e.h).length) {
      try { if (crypto.timingSafeEqual(Buffer.from(want, "hex"), Buffer.from(e.h, "hex"))) { e.used = true; return { ok: true, list: arr }; } } catch { /* skip */ }
    }
  }
  return { ok: false, list: arr };
}
const backupLeft = (list) => (Array.isArray(list) ? list : []).filter((e) => e && !e.used).length;

/* ── users store hygiene: hashes never leave; plaintext never stored ── */
const stripUsers = (arr) => (Array.isArray(arr) ? arr : []).map((u) => ({ ...u, password: "", passHash: undefined, totp: u && u.totp ? { enabled: !!u.totp.enabled, backupLeft: backupLeft(u.totp.backup) } : undefined, email2fa: u && u.email2fa ? { enabled: !!u.email2fa.enabled } : undefined, trustedDevices: undefined }));
function mergeUsersForWrite(incoming, current) {
  const cur = Array.isArray(current) ? current : [];
  // Match on the STABLE id first (fall back to email) so renaming a user's email doesn't lose
  // their password hash or 2FA secret — an email-keyed lookup would miss the renamed record and
  // wipe both, locking the user out.
  const byId = {}, byEmail = {};
  for (const u of cur) { if (u && u.id != null) byId[String(u.id)] = u; if (u && u.email) byEmail[String(u.email).toLowerCase()] = u; }
  return (Array.isArray(incoming) ? incoming : []).map((u) => {
    if (!u) return u;
    const existing = (u.id != null && byId[String(u.id)]) || (u.email ? byEmail[String(u.email).toLowerCase()] : null) || null;
    const out = { ...u, password: "" };
    if (existing && existing.passHash) out.passHash = existing.passHash;      // NEVER change an existing password via a store write
    else if (u.password) out.passHash = hashPw(u.password);                    // brand-new user: hash their initial password
    // 2FA secret is never sent to the client (stripUsers removes it) — a store write must NOT wipe it.
    if (existing && existing.totp) out.totp = existing.totp;
    else delete out.totp;
    // Email 2FA is server-managed like the TOTP secret — a client store write must NOT enable/disable it.
    if (existing && existing.email2fa) out.email2fa = existing.email2fa;
    else delete out.email2fa;
    // Trusted-device tokens (skip-2FA-for-N-days) are server-managed too — never sent to the
    // client (stripUsers removes them), so a store write must not wipe or forge them.
    if (existing && existing.trustedDevices) out.trustedDevices = existing.trustedDevices;
    else delete out.trustedDevices;
    return out;
  });
}

/* ── email 2FA helpers: a 6-digit code emailed at sign-in (alternative to the authenticator app) ── */
const otpHash = (c) => crypto.createHash("sha256").update("otp:" + String(c)).digest("hex");
/* Trusted devices: after a successful 2FA sign-in the user can choose to trust the browser for
   30/60/90 days. Only the sha256 of the random token is stored; the raw token lives in that
   browser's localStorage. Presenting a valid, unexpired token skips the 2FA challenge. */
const devHash = (t) => crypto.createHash("sha256").update("dev:" + String(t)).digest("hex");
const TRUST_DAY_CHOICES = [30, 60, 90];
const maskEmail = (e) => { const s = String(e || ""); const at = s.indexOf("@"); if (at < 1) return s; return s[0] + "***" + s.slice(at); };
/* Owner alert: email whenever a new login lands in the users store, whatever the path
   (admin portal create, company-admin create, signup approval). Fire-and-forget — a mail
   hiccup must never fail the actual write. Restores/bulk merges send one summary line. */
async function notifyLoginCreated(created, via) {
  try {
    const key = (process.env.RESEND_API_KEY || "").trim(); if (!key || !created || !created.length) return;
    const to = (process.env.LOGIN_ALERT_EMAIL || "spencer@freightwire.com").trim();
    const from = (process.env.EMAIL_FROM || "ShippingCloud <notify@shippingcloud.net>").trim();
    const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const many = created.length > 5;
    const rows = many
      ? "<li>" + created.length + " logins added in one write (likely a restore/merge)</li>"
      : created.map((u) => "<li><b>" + esc(u.name || "(no name)") + "</b> — " + esc(u.email || "") + (u.role === "admin" ? " · <b>ADMIN</b>" : "") + (u.clientId ? " · company " + esc(u.clientId) : "") + "</li>").join("");
    const subject = many ? created.length + " logins added (" + via + ")" : "New login created: " + created.map((u) => u.email).join(", ").slice(0, 120);
    const html = '<body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1c1917"><div style="max-width:480px;margin:0 auto;padding:20px"><div style="font-size:15px;font-weight:700;margin-bottom:8px">New login' + (created.length > 1 ? "s" : "") + ' created</div><ul style="font-size:13px;line-height:1.7">' + rows + '</ul><div style="color:#78716c;font-size:12px">Created via ' + esc(via) + " · " + new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC</div></div></body>";
    await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key }, body: JSON.stringify({ from, to: [to], subject, html }) });
  } catch (e) {}
}
/* Owner alert on a new FedEx-account request — includes the customer's details and attaches
   the uploaded invoice (whatever they attached) so it's actionable straight from the inbox. */
async function notifyFedexRequest(req, invoice) {
  try {
    const key = (process.env.RESEND_API_KEY || "").trim(); if (!key || !req) return;
    const to = (process.env.FEDEX_ALERT_EMAIL || process.env.LOGIN_ALERT_EMAIL || "spencer@freightwire.com").trim();
    const from = (process.env.EMAIL_FROM || "ShippingCloud <notify@shippingcloud.net>").trim();
    const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const rows = [["Name", req.name], ["Email", req.email], ["Monthly volume", req.volume], ["Currently ships", req.carrier], ["Invoice attached", req.invoiceName || "(none)"], ["Requested", req.requestedAt]]
      .map((r) => '<tr><td style="padding:3px 10px 3px 0;color:#78716c">' + esc(r[0]) + '</td><td style="padding:3px 0;font-weight:600">' + esc(r[1] || "—") + "</td></tr>").join("");
    const html = '<body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1c1917"><div style="max-width:480px;margin:0 auto;padding:20px"><div style="font-size:15px;font-weight:700;margin-bottom:10px">New FedEx account request</div><table style="font-size:13px;line-height:1.5">' + rows + "</table>" + (req.invoiceName ? '<div style="color:#78716c;font-size:12px;margin-top:12px">Their uploaded invoice is attached to this email.</div>' : "") + "</div></body>";
    const body = { from, to: [to], subject: "FedEx account request — " + (req.name || req.email || "new customer"), html };
    /* attach the raw invoice the customer uploaded (base64), if any */
    if (invoice && invoice.data) body.attachments = [{ filename: (req.invoiceName || "invoice"), content: String(invoice.data) }];
    await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key }, body: JSON.stringify(body) });
  } catch (e) {}
}
async function sendOtpCode(event, to, code) {
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) return { ok: false, configured: false };
  const reqOrigin = String((event.headers && (event.headers.origin || event.headers.Origin)) || "").replace(/\/+$/, "");
  const BRANDS = { "https://shippingcloud.net": "ShippingCloud", "https://www.shippingcloud.net": "ShippingCloud", "https://freightwireship.com": "Freightwire", "https://www.freightwireship.com": "Freightwire", "https://admin.freightwireship.com": "Freightwire Admin" };
  const product = BRANDS[reqOrigin] || "ShippingCloud";
  const appUrl = BRANDS[reqOrigin] ? reqOrigin : (process.env.APP_URL || "").replace(/\/+$/, "");
  const isFw = product !== "ShippingCloud";
  const brandName = isFw ? "Freightwire ShippingHub" : "ShippingCloud";
  const header = isFw ? ('<img src="' + appUrl + '/fw-logo.png" alt="Freightwire" style="height:30px;vertical-align:middle;border:0;"> <span style="font-size:16px;font-weight:800;vertical-align:middle;color:#1F1B18;">SHIPPING<span style="color:#0086E0;">HUB</span></span>') : 'Shipping<span style="color:#0086E0;">Cloud</span>';
  const baseFrom = (process.env.EMAIL_FROM || "ShippingCloud <notify@shippingcloud.net>").trim();
  const fromAddr = (baseFrom.match(/<([^>]+)>/) || [null, baseFrom])[1];
  const from = product.replace(" Admin", "") + " <" + fromAddr + ">";
  const html = `<body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1c1917;"><div style="max-width:420px;margin:0 auto;padding:24px 20px;text-align:center;"><div style="font-size:18px;font-weight:800;color:#0c4a6e;">${header}</div><p style="font-size:14px;color:#57534e;margin-top:16px;">Your sign-in verification code:</p><div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#0c4a6e;margin:10px 0;">${code}</div><p style="font-size:12px;color:#a8a29e;">Expires in 10 minutes. If you didn’t try to sign in, ignore this email and change your password.</p></div></body>`;
  try { const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key }, body: JSON.stringify({ from, to: [to], subject: code + " is your " + brandName + " sign-in code", html }) }); return { ok: r.ok }; } catch (e) { return { ok: false }; }
}

/* ── uploaded files (UPS invoices from signup) live in Netlify Blobs ── */
function blobsCtx() {
  try {
    const raw = process.env.NETLIFY_BLOBS_CONTEXT;
    if (!raw) return null;
    const ctx = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    if (!ctx || !ctx.token || !ctx.siteID || !(ctx.edgeURL || ctx.apiURL)) return null;
    return ctx;
  } catch { return null; }
}
async function blobOp(key, opts) {
  const ctx = blobsCtx(); if (!ctx) return null;
  const path = "/" + ctx.siteID + "/uploads/" + encodeURIComponent(key);
  const url = ctx.edgeURL ? new URL(path, ctx.edgeURL).toString() : new URL("/api/v1/blobs" + path, ctx.apiURL || "https://api.netlify.com").toString();
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
  try { return await fetch(url, { ...(opts || {}), headers: { authorization: "Bearer " + ctx.token, ...((opts || {}).headers || {}) }, signal: ctrl.signal }); }
  catch { return null; } finally { clearTimeout(t); }
}
const MAX_UPLOAD_B64 = 4.6 * 1024 * 1024;   // ~3.4 MB file
const OK_UPLOAD_TYPES = ["application/pdf", "text/csv", "image/png", "image/jpeg", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];

const userScope = (auth) => "u/" + auth.uid + "/";
const canWriteKey = (auth, key) => String(key).startsWith("bak:") ? false : (auth.role === "admin" ? key !== "session" : String(key).startsWith(userScope(auth)));   /* bak: rows are server-written snapshots — no app write may forge or clobber them */
/* best-effort per-container throttle for the unauthenticated signup endpoint (F3) */
const RA_HITS = {};
const signupThrottleOk = (ip) => { const w = Math.floor(Date.now() / 3600000), k = String(ip || "?") + ":" + w; RA_HITS[k] = (RA_HITS[k] || 0) + 1; if (Object.keys(RA_HITS).length > 2000) { for (const x in RA_HITS) { if (!x.endsWith(":" + w)) delete RA_HITS[x]; } } return RA_HITS[k] <= 5; };
const SYNC_BLOCK = { session: 1 }; // never stored server-side

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, body: "" };
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let body = {}; try { body = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON body" }); }
    const action = body.action || "";

    if (action === "ping") return J({ ok: true, configured: configured() });
    if (!configured()) return J({ ok: false, notConfigured: true, error: "We’re having trouble reaching the server — try again in a moment." });

    /* ── login (+ first-ever bootstrap) ── */
    /* Every customer login must resolve to a real client record. Minted HERE (server-side)
       because customers cannot write the global users/clients stores themselves — a client-side
       "self-heal" can never persist and just wedges that browser's sync queue. Never mints on a
       failed read, and a no-op for admins/demo and for logins whose clientId resolves. */
    async function healClientFor(u, users, clients) {
      if (!u || (u.role || "customer") !== "customer" || u.demo) return null;
      if (u.clientId && clients.some((c) => c && c.id === u.clientId)) return null;
      /* If this login points at a customer that was DELETED on purpose (tombstoned), do NOT
         resurrect it — just unlink the login so it stops re-healing. Fixes "I delete a customer
         and it comes right back": a login still referencing the gone client used to re-mint it. */
      if (u.clientId) {
        const tRes = await getStore("deletedClients");
        const tomb = (tRes.ok && Array.isArray(tRes.value)) ? tRes.value : [];
        if (tomb.includes(u.clientId)) {
          try { await putStores({ users: users.map((x) => x && x.id === u.id ? { ...x, clientId: null } : x) }); } catch (e) {}
          return null;
        }
      }
      const id = "c" + Date.now() + Math.floor(Math.random() * 1000);
      const nc = { id, name: u.company || u.name || u.email || "New customer", contact: u.name || "", email: u.email || "", phone: "", origin: "", markup: "", status: "active", since: new Date().toISOString().slice(0, 7), plan: "Standard", selfSignup: true, createdAt: new Date().toISOString(), blockedServices: [...DEFAULT_BLOCKED_SERVICES] };
      const w = await putStores({ clients: [...clients, nc], users: users.map((x) => x && x.id === u.id ? { ...x, clientId: id } : x) });
      if (!w || !w.ok) return null;
      return { clientId: id, client: nc };
    }

    if (action === "login") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!email || !password) return J({ ok: false, error: "Enter your email and password." });
      const cur = await getStore("users");
      if (!cur.ok) return J({ ok: false, error: "We’re having trouble reaching the server — try again in a moment." });
      let users = Array.isArray(cur.value) ? cur.value : [];
      if (!users.length) {
        // BOOTSTRAP: very first login creates the admin account with this email + password.
        const admin = { id: "u1", name: email.split("@")[0], email, role: "admin", clientId: null, status: "active", password: "", passHash: hashPw(password), lastLogin: new Date().toLocaleDateString() };
        const w = await putStores({ users: [admin] });
        if (!w.ok) return J({ ok: false, error: "Could not create the admin account: " + ((w.err && w.err.text) || "").slice(0, 200) });
        return J({ ok: true, bootstrap: true, token: makeToken(admin), user: { ...admin, passHash: undefined } });
      }
      let u = users.find((x) => x && String(x.email || "").toLowerCase() === email);
      /* Self-heal stale hashes: if the scrypt hash doesn't match but the record still carries
         a plaintext password that DOES (legacy accounts, or a password changed through the old
         local-mode path which couldn't re-hash), accept it and migrate to a fresh hash. */
      if (u && !checkPw(password, u.passHash) && u.password && String(u.password) === password) {
        const nh = hashPw(password);
        const merged = users.map((x) => x && x.id === u.id ? { ...x, password: "", passHash: nh } : x);
        await putStores({ users: merged });
        users = merged;   // later writes in this request must not revert the migrated hash
        u = { ...u, passHash: nh };
      }
      if (!u || !checkPw(password, u.passHash)) return J({ ok: false, error: "Incorrect email or password." });
      if (u.status && u.status !== "active") return J({ ok: false, error: "This account is inactive. Contact your administrator." });
      /* Trusted device: a browser that already finished 2FA can be remembered for 30/60/90 days.
         Expired entries are pruned on every login; a matching token skips the code below. */
      const deviceTok = String(body.device || "").slice(0, 200);
      const trustDaysReq = TRUST_DAY_CHOICES.includes(Number(body.trustDays)) ? Number(body.trustDays) : 0;
      const devList = (Array.isArray(u.trustedDevices) ? u.trustedDevices : []).filter((d) => d && d.hash && d.exp > Date.now());
      let deviceTrusted = false;
      if (deviceTok) {
        const want = devHash(deviceTok);
        for (const d of devList) { try { if (crypto.timingSafeEqual(Buffer.from(want, "hex"), Buffer.from(String(d.hash), "hex"))) { deviceTrusted = true; break; } } catch (e) { /* malformed entry — skip */ } }
      }
      let secondFactorPassed = false;
      // Two-factor: only enforced once the user has fully enabled it (opt-in). Password is already verified here.
      if (!deviceTrusted && u.totp && u.totp.enabled) {
        // Fail CLOSED if the record is enabled but somehow missing its secret (corruption) — an
        // admin can clear 2FA to recover. Never let a broken record downgrade to password-only.
        if (!u.totp.secret) return J({ ok: false, needsTotp: true, error: "Two-factor is on but not set up correctly for this account — ask your administrator to reset it." });
        const raw = String(body.code || "");
        const code = raw.replace(/\D/g, "");
        if (!raw.trim()) return J({ ok: false, needsTotp: true, error: "Enter the 6-digit code from your authenticator app." });
        if (!totpVerify(u.totp.secret, code)) {
          // fall back to a one-time backup code (lost-phone escape hatch)
          const bc = consumeBackup(u.totp.backup, raw);
          if (!bc.ok) return J({ ok: false, needsTotp: true, error: "That code isn’t right or has expired — try the current one, or a backup code." });
          // A backup code is one-time — its "used" state MUST persist before we grant a session,
          // or a failed write would leave the code replayable. Refuse the login if we can't record it.
          const merged = users.map((x) => x && x.id === u.id ? { ...x, totp: { ...u.totp, backup: bc.list } } : x);
          const bw = await putStores({ users: merged });
          if (!bw.ok) return J({ ok: false, needsTotp: true, error: "Couldn’t verify your backup code just now — try again in a moment." });
          users = merged;   // keep the local copy current so later writes in this request don't resurrect the used code
        }
        secondFactorPassed = true;
      }
      /* Email 2FA (opt-in alternative to the authenticator app). Only when TOTP is NOT enabled.
         No code on the request → email a fresh one and ask for it; a wrong/expired code re-prompts. */
      if (!deviceTrusted && u.email2fa && u.email2fa.enabled && !(u.totp && u.totp.enabled)) {
        const raw = String(body.code || "").replace(/\s+/g, "");
        const p = u.email2fa.pending;
        const sendFresh = async (msg) => {
          const code = String(Math.floor(100000 + Math.random() * 900000));
          await putStores({ users: users.map((x) => x && x.id === u.id ? { ...x, email2fa: { enabled: true, pending: { hash: otpHash(code), exp: Date.now() + 10 * 60 * 1000, tries: 0 } } } : x) });
          const s = await sendOtpCode(event, u.email, code);
          return J({ ok: false, needsEmailCode: true, sentTo: maskEmail(u.email), error: s.ok ? msg : "Couldn't send your sign-in code email — try again in a moment." });
        };
        if (!raw) return await sendFresh("We emailed a 6-digit code to " + maskEmail(u.email) + ".");
        if (!p || !p.hash || !p.exp || Date.now() > p.exp) return await sendFresh("That code expired — we sent a new one.");
        if ((p.tries || 0) >= 6) return await sendFresh("Too many tries — we sent a fresh code.");
        let match = false;
        try { const a = Buffer.from(otpHash(raw), "hex"), b = Buffer.from(p.hash, "hex"); match = a.length === b.length && crypto.timingSafeEqual(a, b); } catch (e) { match = false; }
        if (!match) {
          await putStores({ users: users.map((x) => x && x.id === u.id ? { ...x, email2fa: { enabled: true, pending: { ...p, tries: (p.tries || 0) + 1 } } } : x) });
          return J({ ok: false, needsEmailCode: true, error: "That code isn’t right — check the latest email." });
        }
        const mergedE = users.map((x) => x && x.id === u.id ? { ...x, email2fa: { enabled: true } } : x);
        await putStores({ users: mergedE });   // valid — clear the used code
        users = mergedE;
        secondFactorPassed = true;
      }
      /* Trust this device: only after a code was actually verified on THIS request (never for
         password-only accounts, never when the challenge was skipped by an existing trust). */
      let newDeviceToken = null, newDeviceExp = 0;
      if (secondFactorPassed && trustDaysReq) {
        newDeviceToken = crypto.randomBytes(24).toString("hex");
        newDeviceExp = Date.now() + trustDaysReq * 24 * 3600 * 1000;
        const keep = devList.slice(-49);   // pruned of expired above; cap at 50 trusted browsers per account — shared warehouse logins can run 16+ stations; every entry still required a passed 2FA, so the cap is bloat control, not a security wall
        keep.push({ hash: devHash(newDeviceToken), exp: newDeviceExp, created: Date.now(), days: trustDaysReq });
        const mergedD = users.map((x) => x && x.id === u.id ? { ...x, trustedDevices: keep } : x);
        const dw = await putStores({ users: mergedD });
        if (!dw || !dw.ok) { newDeviceToken = null; newDeviceExp = 0; }   // sign-in still succeeds; the browser just isn't remembered
        else users = mergedD;
      }
      if ((u.role || "customer") === "customer") {
        const curC = await getStore("clients");
        if (curC.ok) {
          const healed = await healClientFor(u, users, Array.isArray(curC.value) ? curC.value : []);
          if (healed) u = { ...u, clientId: healed.clientId };
        }
      }
      return J({ ok: true, token: makeToken(u), deviceToken: newDeviceToken || undefined, deviceExp: newDeviceExp || undefined, user: { ...u, password: "", passHash: undefined, totp: u.totp ? { enabled: !!u.totp.enabled, backupLeft: backupLeft(u.totp.backup) } : undefined, email2fa: u.email2fa ? { enabled: !!u.email2fa.enabled } : undefined, trustedDevices: undefined } });
    }

    /* ── request access (no auth): stores a pending signup for admin approval ── */
    if (action === "publicConfig") {
      const cur = await getStore("publicBrand");
      const v = (cur.ok && cur.value) || {};
      return J({ ok: true, showLogo: v.showLogo === true });
    }

    if (action === "requestAccess") {
      const name = String(body.name || "").trim().slice(0, 80);
      const email = String(body.email || "").trim().toLowerCase().slice(0, 120);
      const company = String(body.company || "").trim().slice(0, 120);
      const password = String(body.password || "");
      const volume = String(body.volume || "").slice(0, 40);
      const carrier = String(body.carrier || "").slice(0, 40);
      if (!name || !/.+@.+\..+/.test(email) || password.length < 4) return J({ ok: false, error: "Enter your name, a valid email, and a password (4+ characters)." });
      const _raIp = (event.headers && (event.headers["x-nf-client-connection-ip"] || String(event.headers["x-forwarded-for"] || "").split(",")[0].trim())) || "";
      if (!signupThrottleOk(_raIp)) return J({ ok: false, error: "Too many signups from this connection — try again in an hour." });
      const [curU, curR, curF, curC] = await Promise.all([getStore("users"), getStore("signupRequests"), getStore("fedexRequests"), getStore("clients")]);
      const users = (curU.ok && Array.isArray(curU.value)) ? curU.value : [];
      if (users.some((u) => u && String(u.email || "").toLowerCase() === email)) return J({ ok: false, error: "That email already has a login. Try signing in." });
      if (users.length >= 2000) return J({ ok: false, error: "Signups are temporarily paused — give us a call." });
      /* Every self-serve signup IS a customer: mint the client record right here and assign the
         login to it, so the admin just opens the customer and sets rates — no manual "create a
         customer + attach the login" step, and the app never runs unassigned (at raw cost). */
      const clients = (curC.ok && Array.isArray(curC.value)) ? curC.value : [];
      const newClientId = "c" + Date.now() + Math.floor(Math.random() * 1000);
      const newClient = { id: newClientId, name: company || name, contact: name, email, phone: "", origin: "", markup: "", status: "active", since: new Date().toISOString().slice(0, 7), plan: "Standard", selfSignup: true, createdAt: new Date().toISOString(), blockedServices: [...DEFAULT_BLOCKED_SERVICES] };
      const newUser = { id: "u" + Date.now() + Math.floor(Math.random() * 1000), name, company, email, role: "customer", clientId: newClientId, status: "active", password: "", passHash: hashPw(password), volume, carrier, createdAt: new Date().toISOString(), lastLogin: new Date().toLocaleDateString() };
      const writes = { users: [...users, newUser], clients: [...clients, newClient] };
      const reqs = (curR.ok && Array.isArray(curR.value)) ? curR.value : [];
      const remaining = reqs.filter((r) => r && String(r.email || "").toLowerCase() !== email);
      if (remaining.length !== reqs.length) writes.signupRequests = remaining;   // clean any legacy pending request
      // FedEx-account intake collected before signup: file it against the new login
      const inv = body.invoice;
      if (volume || carrier || (inv && inv.data)) {
        let invoiceName = "", invoiceKey = "";
        if (inv && inv.data) {
          if (String(inv.data).length > MAX_UPLOAD_B64) return J({ ok: false, error: "That file is too large — please upload one under 3 MB." });
          if (inv.type && !OK_UPLOAD_TYPES.includes(String(inv.type))) return J({ ok: false, error: "Please upload a PDF, CSV, Excel file, or image of your invoice." });
          invoiceKey = "inv_" + crypto.createHash("sha1").update(newUser.id + "|" + Date.now()).digest("hex");
          invoiceName = String(inv.name || "invoice").slice(0, 120);
          const up = await blobOp(invoiceKey, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: invoiceName, type: String(inv.type || "application/octet-stream"), data: String(inv.data) }) });
          if (!up || !up.ok) { invoiceKey = ""; invoiceName = ""; }
        }
        const freqs = ((curF.ok && Array.isArray(curF.value)) ? curF.value : []).slice(0, 199);
        freqs.push({ id: "fx" + Date.now(), uid: newUser.id, name, email, volume, carrier, invoiceName, invoiceKey, requestedAt: new Date().toISOString() });
        writes.fedexRequests = freqs;
      }
      const w = await putStores(writes);
      if (!w.ok) return J({ ok: false, error: "Could not create your account — try again." });
      /* Concurrent-signup guard: two overlapping signups (or an admin save racing this one) are
         whole-array last-write-wins — verify OUR row survived, and if it got clobbered, merge it
         into the CURRENT arrays and rewrite (twice max). Without this, a signup can return ok
         with a session token whose account no longer exists. */
      for (let tries = 0; tries < 2; tries++) {
        const [chkU, chkC] = await Promise.all([getStore("users"), getStore("clients")]);
        const uArr = (chkU.ok && Array.isArray(chkU.value)) ? chkU.value : null;
        const cArr = (chkC.ok && Array.isArray(chkC.value)) ? chkC.value : null;
        if (!uArr) break;
        const uThere = uArr.some((x) => x && x.id === newUser.id);
        const cThere = !cArr || cArr.some((x) => x && x.id === newClientId);
        if (uThere && cThere) break;
        const fix = {};
        if (!uThere) fix.users = [...uArr, newUser];
        if (!cThere) fix.clients = [...(cArr || []), newClient];
        await putStores(fix);
      }
      return J({ ok: true, token: makeToken(newUser), user: { ...newUser, passHash: undefined }, fedexFiled: !!writes.fedexRequests });
    }
    // ── self-serve password reset ──
    if (action === "requestReset") {
      const email = String(body.email || "").trim().toLowerCase();
      const generic = { ok: true, note: "If that email has an account, a reset link is on its way." };
      if (!/.+@.+\..+/.test(email)) return J(generic);
      const curU = await getStore("users");
      const users = Array.isArray(curU.value) ? curU.value : [];
      const u = users.find((x) => x && String(x.email || "").toLowerCase() === email && x.status !== "disabled");
      const _adm = verifyToken(body.token);
      if (!u) return J(_adm && _adm.role === "admin" ? { ...generic, found: false } : generic); // never reveal which emails exist to anonymous callers
      /* welcome variant: only an authenticated ADMIN can request it (it says "an account was
         created for you", so it must never be triggerable by an anonymous visitor). 72h link —
         a brand-new user may not check email within the reset flow's 1 hour. */
      const _wAuth = verifyToken(body.token);
      const isWelcome = !!(body.welcome && _wAuth && _wAuth.role === "admin");
      const payload = b64u(JSON.stringify({ uid: String(u.id), kind: "pwreset", exp: Date.now() + (isWelcome ? 72 : 1) * 60 * 60 * 1000 }));
      const rtoken = payload + "." + sign(payload);
      /* Send the person back to the site they asked from, with that site's branding.
         Origin is whitelisted — never trusted raw — so a reset email can't be pointed
         at an attacker's domain. Unknown origins fall back to APP_URL (retail). */
      const ORIGIN_BRANDS = {
        "https://shippingcloud.net": "ShippingCloud", "https://www.shippingcloud.net": "ShippingCloud",
        "https://freightwireship.com": "Freightwire", "https://www.freightwireship.com": "Freightwire",
        "https://admin.freightwireship.com": "Freightwire Admin"
      };
      const reqOrigin = String((event.headers && (event.headers.origin || event.headers.Origin)) || "").replace(/\/+$/, "");
      const appUrl = ORIGIN_BRANDS[reqOrigin] ? reqOrigin : (process.env.APP_URL || "").replace(/\/+$/, "");
      const product = ORIGIN_BRANDS[reqOrigin] || "ShippingCloud";
      const isFw = product !== "ShippingCloud";
      const brandName = isFw ? "Freightwire ShippingHub" : "ShippingCloud";
      const wordmark = isFw
        ? ('<img src="' + appUrl + '/fw-logo.png" alt="Freightwire" style="height:34px;vertical-align:middle;border:0;"> <span style="font-size:17px;font-weight:800;letter-spacing:.04em;vertical-align:middle;color:#1F1B18;">SHIPPING<span style="color:#0086E0;">HUB</span></span>' + (product === "Freightwire Admin" ? ' <span style="font-weight:600;color:#78716c;font-size:13px;">Admin</span>' : ''))
        : 'Shipping<span style="color:#0086E0;">Cloud</span>';
      const link = appUrl + "/?reset=" + encodeURIComponent(rtoken);
      const key = (process.env.RESEND_API_KEY || "").trim();
      if (!key) { console.log("[requestReset] NOT SENT — RESEND_API_KEY is missing on this site. Set it (as a normal, non-secret var) and redeploy."); return J({ ...generic, configured: false }); }
      /* sender name follows the brand the request came from (Freightwire vs ShippingCloud),
         keeping the verified from-address from EMAIL_FROM so deliverability is unchanged */
      const baseFrom = (process.env.EMAIL_FROM || "ShippingCloud <notify@shippingcloud.net>").trim();
      const _fromAddr = (baseFrom.match(/<([^>]+)>/) || [null, baseFrom])[1];
      const from = product.replace(" Admin", "") + " <" + _fromAddr + ">";
      try {
        const rr = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
          body: JSON.stringify({ from, to: [email], subject: isWelcome ? ("Welcome to " + brandName + " — set your password") : ("Reset your " + brandName + " password"),
            html: `<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917;"><div style="max-width:480px;margin:0 auto;padding:28px 20px;"><div style="font-size:20px;font-weight:800;color:#0c4a6e;">${wordmark}</div>${isWelcome?`<p style="font-size:14px;color:#57534e;">An account was created for you. Click below to choose your password and sign in. This link works for 72 hours.</p>`:`<p style="font-size:14px;color:#57534e;">Someone (hopefully you) asked to reset the password for this account. This link works for 1 hour.</p>`}<a href="${link}" style="display:inline-block;background:#0086E0;color:#fff;text-decoration:none;font-weight:600;border-radius:8px;padding:10px 18px;font-size:14px;">${isWelcome?"Set my password":"Choose a new password"}</a>${isWelcome?"":`<p style="font-size:11px;color:#a8a29e;margin-top:16px;">Didn’t ask for this? Ignore this email — nothing changes.</p>`}</div></body>` }) });
        const rt = await rr.text().catch(() => "");
        if (rr.ok) console.log("[requestReset] sent OK via Resend from <" + from + "> (origin " + (reqOrigin || "none") + ")");
        else console.log("[requestReset] Resend REJECTED the send (" + rr.status + "): " + rt.slice(0, 300) + " — common causes: wrong API key, or the EMAIL_FROM domain isn't verified in the Resend dashboard.");
      } catch (e) { console.log("[requestReset] network error reaching Resend: " + ((e && e.message) || e)); }
      return J(generic);
    }
    if (action === "resetPassword") {
      const [pp, sig] = String(body.rtoken || "").split(".");
      let data = null;
      try {
        const want = Buffer.from(sign(pp), "hex"); const got = Buffer.from(sig || "", "hex");
        if (pp && sig && want.length === got.length && crypto.timingSafeEqual(want, got)) data = JSON.parse(unb64u(pp));
      } catch (e) {}
      if (!data || data.kind !== "pwreset" || !data.uid || Date.now() > data.exp) return J({ ok: false, error: "That reset link is invalid or expired — request a new one." });
      const password = String(body.password || "");
      if (password.length < 6) return J({ ok: false, error: "Password must be at least 6 characters." });
      const curU2 = await getStore("users");
      const users = Array.isArray(curU2.value) ? curU2.value : [];
      if (!users.find((x) => x && x.id === data.uid)) return J({ ok: false, error: "Account not found." });
      const merged = users.map((x) => x && x.id === data.uid ? { ...x, password: "", passHash: hashPw(password) } : x);
      const w = await putStores({ users: merged });
      if (!w.ok) return J({ ok: false, error: "Could not save — try again." });
      return J({ ok: true });
    }


    /* ── everything below requires a valid session ── */
    const auth = verifyToken(body.token);
    if (!auth) return J({ ok: false, authFailed: true, error: "Session expired — sign in again." });

    /* ── two-factor auth management (self-service, per logged-in user) ── */
    if (action === "totpBegin" || action === "totpEnable" || action === "totpDisable" || action === "totpStatus" || action === "totpBackupRegen") {
      const curU = await getStore("users");
      if (!curU.ok) return J({ ok: false, error: "Database error reading accounts." });
      const allUsers = Array.isArray(curU.value) ? curU.value : [];
      const me = allUsers.find((x) => x && x.id === auth.uid) || null;
      if (!me) return J({ ok: false, error: "Account not found." });

      if (action === "totpStatus") return J({ ok: true, enabled: !!(me.totp && me.totp.enabled), pending: !!(me.totp && me.totp.pendingSecret), backupLeft: backupLeft(me.totp && me.totp.backup) });

      if (action === "totpBackupRegen") {
        // regenerate the one-time backup codes; requires a current code or the password (it's a sensitive op)
        if (!me.totp || !me.totp.enabled || !me.totp.secret) return J({ ok: false, error: "Turn on 2FA first." });
        const code = String(body.code || "").replace(/\D/g, "");
        const pw = String(body.password || "");
        if (!(code && totpVerify(me.totp.secret, code)) && !(pw && checkPw(pw, me.passHash))) return J({ ok: false, error: "Enter a current 6-digit code (or your password) to make new backup codes." });
        const bc = newBackupCodes(10);
        const merged = allUsers.map((x) => x && x.id === auth.uid ? { ...x, totp: { ...me.totp, backup: bc.stored } } : x);
        const w = await putStores({ users: merged });
        if (!w.ok) return J({ ok: false, error: "Could not make new backup codes — try again." });
        return J({ ok: true, backupCodes: bc.plain });
      }

      if (action === "totpBegin") {
        // Generate a fresh secret and stash it as a SEPARATE pendingSecret. Never touch an
        // already-enabled secret or its backup codes here — otherwise a stolen session (no device)
        // could call totpBegin to silently drop enforcement + destroy backup codes. Enforcement
        // only flips on the confirmed totpEnable below.
        const secret = newTotpSecret();
        const merged = allUsers.map((x) => x && x.id === auth.uid ? { ...x, totp: { ...(x.totp || {}), pendingSecret: secret } } : x);
        const w = await putStores({ users: merged });
        if (!w.ok) return J({ ok: false, error: "Could not start 2FA setup — try again." });
        return J({ ok: true, secret, otpauth: otpauthUrl(me.email || auth.email || "user", secret, "ShippingCloud") });
      }

      if (action === "totpEnable") {
        const pending = me.totp && me.totp.pendingSecret;
        if (!pending) return J({ ok: false, error: "Start 2FA setup first." });
        const code = String(body.code || "").replace(/\D/g, "");
        if (!totpVerify(pending, code)) return J({ ok: false, error: "That code isn’t right or has expired — try the current one." });
        const bc = newBackupCodes(10);
        // promote the pending secret to the live one, issue backup codes, clear the pending field
        const merged = allUsers.map((x) => x && x.id === auth.uid ? { ...x, totp: { secret: pending, enabled: true, backup: bc.stored } } : x);
        const w = await putStores({ users: merged });
        if (!w.ok) return J({ ok: false, error: "Could not turn on 2FA — try again." });
        return J({ ok: true, enabled: true, backupCodes: bc.plain });
      }

      if (action === "totpDisable") {
        // require a current code (or the account password) to switch it off, so a hijacked session can't.
        if (me.totp && me.totp.enabled && me.totp.secret) {
          const code = String(body.code || "").replace(/\D/g, "");
          const pw = String(body.password || "");
          const okCode = code && totpVerify(me.totp.secret, code);
          const okPw = pw && checkPw(pw, me.passHash);
          if (!okCode && !okPw) return J({ ok: false, error: "Enter a current 6-digit code (or your password) to turn off 2FA." });
        }
        // if this leaves no second factor, trusted-device tokens are meaningless — drop them
        const merged = allUsers.map((x) => x && x.id === auth.uid ? { ...x, totp: undefined, trustedDevices: (x.email2fa && x.email2fa.enabled) ? x.trustedDevices : undefined } : x);
        const w = await putStores({ users: merged });
        if (!w.ok) return J({ ok: false, error: "Could not turn off 2FA — try again." });
        return J({ ok: true, enabled: false });
      }
    }

    /* ── email 2FA management (self-service): send a code to your own email, confirm, enable/disable ── */
    if (action === "email2faBegin" || action === "email2faEnable" || action === "email2faDisable" || action === "email2faStatus") {
      const curU = await getStore("users");
      if (!curU.ok) return J({ ok: false, error: "Database error reading accounts." });
      const allUsers = Array.isArray(curU.value) ? curU.value : [];
      const me = allUsers.find((x) => x && x.id === auth.uid) || null;
      if (!me) return J({ ok: false, error: "Account not found." });
      if (action === "email2faStatus") return J({ ok: true, enabled: !!(me.email2fa && me.email2fa.enabled), email: maskEmail(me.email) });
      if (action === "email2faBegin") {
        if (!me.email) return J({ ok: false, error: "Your account has no email on file." });
        const code = String(Math.floor(100000 + Math.random() * 900000));
        const merged = allUsers.map((x) => x && x.id === auth.uid ? { ...x, email2fa: { ...(x.email2fa || {}), pending: { hash: otpHash(code), exp: Date.now() + 10 * 60 * 1000, tries: 0 } } } : x);
        const w = await putStores({ users: merged });
        if (!w.ok) return J({ ok: false, error: "Could not start setup — try again." });
        const s = await sendOtpCode(event, me.email, code);
        if (!s.ok) return J({ ok: false, error: s.configured === false ? "Email sending isn’t set up on this site yet (RESEND_API_KEY)." : "Couldn’t send the code email — try again." });
        return J({ ok: true, sentTo: maskEmail(me.email) });
      }
      if (action === "email2faEnable") {
        const p = me.email2fa && me.email2fa.pending;
        if (!p || !p.exp || Date.now() > p.exp) return J({ ok: false, error: "That code expired — start again." });
        const raw = String(body.code || "").replace(/\s+/g, "");
        let match = false;
        try { const a = Buffer.from(otpHash(raw), "hex"), b = Buffer.from(p.hash, "hex"); match = a.length === b.length && crypto.timingSafeEqual(a, b); } catch (e) { match = false; }
        if (!match) return J({ ok: false, error: "That code isn’t right — check the latest email." });
        const merged = allUsers.map((x) => x && x.id === auth.uid ? { ...x, email2fa: { enabled: true } } : x);
        const w = await putStores({ users: merged });
        if (!w.ok) return J({ ok: false, error: "Could not enable — try again." });
        return J({ ok: true, enabled: true });
      }
      if (action === "email2faDisable") {
        const pw = String(body.password || "");
        if (!(pw && checkPw(pw, me.passHash))) return J({ ok: false, error: "Enter your password to turn off email verification." });
        // if this leaves no second factor, trusted-device tokens are meaningless — drop them
        const merged = allUsers.map((x) => x && x.id === auth.uid ? { ...x, email2fa: undefined, trustedDevices: (x.totp && x.totp.enabled) ? x.trustedDevices : undefined } : x);
        const w = await putStores({ users: merged });
        if (!w.ok) return J({ ok: false, error: "Could not disable — try again." });
        return J({ ok: true, enabled: false });
      }
    }

    if (action === "getAll") {
      const r = await pg("app_stores?tenant=eq." + encodeURIComponent(TENANT) + "&select=key,value");
      if (!r.ok) return J({ ok: false, error: "Database error " + r.status });
      const stores = {};
      for (const row of (Array.isArray(r.data) ? r.data : [])) {
        if (!row || row.key == null) continue;
        if (String(row.key).startsWith("bak:")) continue;   // safety snapshots — server-side only, restored on request
        if (auth.role !== "admin" && !String(row.key).startsWith(userScope(auth))) continue;
        stores[row.key] = (row.key === "users" || row.key === "signupRequests") ? stripUsers(row.value) : row.value;
      }
      if (auth.role !== "admin") {
        delete stores.users;
        // hand each customer ONLY their own feature flags (admin manages the full map)
        const rows = Array.isArray(r.data) ? r.data : [];
        const allFlags = rows.find((row) => row && row.key === "featureFlags");
        stores.myFeatures = (allFlags && allFlags.value && allFlags.value[auth.uid]) || {};
        // fresh access facts so company-admin approval works without re-login
        const usersRow = rows.find((row) => row && row.key === "users");
        const allUsers = (usersRow && Array.isArray(usersRow.value)) ? usersRow.value : [];
        let me = allUsers.find((x) => x && x.id === auth.uid) || null;
        /* Heal ACTIVE sessions too (not just fresh logins): a customer whose clientId is missing
           or points at a deleted client gets a real client minted and assigned right here, so the
           very next poll prices through the normal path — no re-login needed. */
        if (me && (me.role || "customer") === "customer" && usersRow) {
          const cRow0 = rows.find((row) => row && row.key === "clients");
          const clients0 = (cRow0 && Array.isArray(cRow0.value)) ? cRow0.value : [];
          const healed = await healClientFor(me, allUsers, clients0);
          if (healed) { me = { ...me, clientId: healed.clientId }; if (cRow0) cRow0.value = [...clients0, healed.client]; else rows.push({ key: "clients", value: [healed.client] }); }
        }
        stores.myAccess = { companyAdmin: !!(me && me.companyAdmin), clientId: (me && me.clientId) || null };
        /* Pricing facts a customer session needs to quote correctly. Withholding ALL global
           stores from non-admins also withheld the customer's OWN client record and rate
           profile — so every customer login resolved to "unknown customer" (the amber banner)
           and priced at raw carrier cost with no markup, because rateSellFor runs in the
           browser and had neither the client nor the rules. Send exactly the slice that
           belongs to them: their own client record and their assigned profile — never other
           customers' records, other profiles, or the assignment map. */
        const myCid = (me && me.clientId) || null;
        if (myCid) {
          const cRow = rows.find((row) => row && row.key === "clients");
          const myClient = (cRow && Array.isArray(cRow.value)) ? cRow.value.find((c) => c && c.id === myCid) : null;
          if (myClient) stores.clients = [myClient];
          const rrRow = rows.find((row) => row && row.key === "rateRules");
          const rr = (rrRow && rrRow.value && typeof rrRow.value === "object") ? rrRow.value : null;
          if (rr) {
            const profs = Array.isArray(rr.profiles) ? rr.profiles : [];
            const pid = (rr.assign && rr.assign[myCid]) || "default";
            const prof = profs.find((p) => p && p.id === pid) || profs.find((p) => p && p.id === "default") || null;
            stores.rateRules = { profiles: prof ? [prof] : [], assign: { [myCid]: prof ? prof.id : "default" }, baseCosts: (rr.baseCosts && typeof rr.baseCosts === "object") ? rr.baseCosts : {} };
          }
        }
        if (me && me.companyAdmin && me.clientId) {
          stores.companyUsers = allUsers
            .filter((x) => x && x.role !== "admin" && x.clientId === me.clientId)
            .map((x) => ({ id: x.id, name: x.name, email: x.email, status: x.status || "active", companyAdmin: !!x.companyAdmin, lastLogin: x.lastLogin || "—" }));
          const fmap = (allFlags && allFlags.value) || {};
          const cf = {}; stores.companyUsers.forEach((m) => { cf[m.id] = fmap[m.id] || {}; });
          stores.companyFlags = cf;
        }
      }
      return J({ ok: true, stores });
    }

    /* ── company admin: customers flagged companyAdmin manage logins for their own company only ── */
    if (action === "requestCompanyAdmin" || String(action).startsWith("company")) {
      const curU = await getStore("users");
      const allUsers = (curU.ok && Array.isArray(curU.value)) ? curU.value : [];
      const me = allUsers.find((x) => x && x.id === auth.uid) || null;
      if (!me || me.role === "admin") {
        if (action !== "requestCompanyAdmin" || !me) return J({ ok: false, error: "Not available for this login." });
      }

      if (action === "requestCompanyAdmin") {
        if (me.companyAdmin) return J({ ok: true, already: true });
        const cur = await getStore("companyAdminRequests");
        const list = (cur.ok && Array.isArray(cur.value)) ? cur.value : [];
        if (list.some((r2) => r2 && r2.uid === auth.uid)) return J({ ok: true, pending: true });
        list.push({ id: "car" + Date.now(), uid: auth.uid, name: me.name || "", email: me.email || "", clientId: me.clientId || null, date: new Date().toLocaleDateString() });
        const w = await putStores({ companyAdminRequests: list });
        if (!w.ok) return J({ ok: false, error: "Could not file the request — try again." });
        return J({ ok: true, pending: true });
      }

      // everything below requires an ACTIVE company admin
      if (!me.companyAdmin || (me.status && me.status !== "active") || !me.clientId) return J({ ok: false, error: "Company admin access required." });
      const sameCompany = (u2) => u2 && u2.role !== "admin" && u2.clientId === me.clientId;

      if (action === "companyCreateUser") {
        const name = String(body.name || "").trim().slice(0, 80);
        const email = String(body.email || "").trim().toLowerCase().slice(0, 120);
        const password = String(body.password || "");
        if (!name || !/.+@.+\..+/.test(email) || password.length < 4) return J({ ok: false, error: "Enter a name, valid email, and password (4+ characters)." });
        if (allUsers.some((x) => x && String(x.email || "").toLowerCase() === email)) return J({ ok: false, error: "That email already has a login." });
        if (allUsers.length >= 2000) return J({ ok: false, error: "User limit reached." });
        const nu = { id: "u" + Date.now() + Math.floor(Math.random() * 1000), name, email, role: "customer", clientId: me.clientId, status: "active", password, lastLogin: "—", createdBy: auth.uid };
        const merged = mergeUsersForWrite([...allUsers, nu], allUsers);
        const w = await putStores({ users: merged });
        if (!w.ok) return J({ ok: false, error: "Could not create the login — try again." });
        await notifyLoginCreated([nu], "Company Admin (" + maskEmail(auth.email || auth.uid) + ")");
        return J({ ok: true, user: { id: nu.id, name, email, status: "active", companyAdmin: false, lastLogin: "—" } });
      }

      if (action === "companySetFlags") {
        const uid = String(body.uid || "");
        const target = allUsers.find((x) => x && x.id === uid);
        if (!sameCompany(target)) return J({ ok: false, error: "That login isn’t in your company." });
        const raw = (body.flags && typeof body.flags === "object") ? body.flags : {};
        /* Feature toggles are booleans, but a few underscore keys carry DEPLOY PAYLOADS a company
           admin pushes to their team (customizations, product catalog, shared address book). Those
           must pass through as-is; every other key is coerced to a strict boolean. Unknown underscore
           keys are dropped so a crafted request can't smuggle in platform-only flags (e.g. _secPolicy). */
        const DEPLOY_KEYS = { _custom: 1, _products: 1, _addresses: 1 };
        const flags = {}; let n = 0;
        for (const k of Object.keys(raw)) {
          if (n >= 64) break;
          if (typeof k !== "string" || k.length > 64) continue;
          if (k.charAt(0) === "_") { if (DEPLOY_KEYS[k]) { flags[k] = raw[k]; n++; } continue; }
          flags[k] = raw[k] === true; n++;
        }
        const cur = await getStore("featureFlags");
        const map = (cur.ok && cur.value && typeof cur.value === "object") ? cur.value : {};
        map[uid] = flags;
        const w = await putStores({ featureFlags: map });
        if (!w.ok) return J({ ok: false, error: "Could not save — try again." });
        return J({ ok: true, uid, flags });
      }

      if (action === "companySetActive") {
        const uid = String(body.uid || "");
        if (uid === auth.uid) return J({ ok: false, error: "You can’t deactivate your own login." });
        const target = allUsers.find((x) => x && x.id === uid);
        if (!sameCompany(target)) return J({ ok: false, error: "That login isn’t in your company." });
        const status = body.active ? "active" : "disabled";
        const merged = mergeUsersForWrite(allUsers.map((x) => x && x.id === uid ? { ...x, status } : x), allUsers);
        const w = await putStores({ users: merged });
        if (!w.ok) return J({ ok: false, error: "Could not save — try again." });
        return J({ ok: true, uid, status });
      }

      if (action === "companySetPassword") {
        const uid = String(body.uid || "");
        const password = String(body.password || "");
        if (password.length < 4) return J({ ok: false, error: "Password must be at least 4 characters." });
        const target = allUsers.find((x) => x && x.id === uid);
        if (!sameCompany(target)) return J({ ok: false, error: "That login isn’t in your company." });
        // mergeUsersForWrite never rehashes existing users, so hash explicitly here
        const merged = allUsers.map((x) => x && x.id === uid ? { ...x, password: "", passHash: hashPw(password) } : x);
        const w = await putStores({ users: merged });
        if (!w.ok) return J({ ok: false, error: "Could not save — try again." });
        return J({ ok: true, uid });
      }

      return J({ ok: false, error: "Unknown company action." });
    }

    if (action === "putMany") {
      const incoming = (body.stores && typeof body.stores === "object") ? body.stores : {};
      const toWrite = {}; const rejected = [];
      for (const key of Object.keys(incoming)) {
        if (SYNC_BLOCK[key] || !canWriteKey(auth, key)) { rejected.push(key); continue; }
        toWrite[key] = incoming[key];
      }
      let _newLogins = [];
      if ("users" in toWrite) {
        const cur = await getStore("users");
        const _hadEmails = new Set((cur.ok && Array.isArray(cur.value) ? cur.value : []).map((u) => u && String(u.email || "").toLowerCase()).filter(Boolean));
        toWrite.users = mergeUsersForWrite(toWrite.users, cur.ok ? cur.value : []);
        _newLogins = (toWrite.users || []).filter((u) => u && u.email && !_hadEmails.has(String(u.email).toLowerCase()));
        /* STALE-TAB GUARD: an admin tab opened before a signup holds an old copy of this array;
           its next save (whole-array) would silently DELETE the fresh login. Re-add any current
           row the incoming write is missing that was created in the last 15 minutes — a tab that
           old can't have legitimately deleted it. Older rows stay deletable as normal. */
        const _cutU = Date.now() - 15 * 60 * 1000;
        const _haveU = new Set((toWrite.users || []).map((u) => u && u.id));
        for (const u of (cur.ok && Array.isArray(cur.value) ? cur.value : [])) {
          if (u && !_haveU.has(u.id) && u.createdAt && Date.parse(u.createdAt) > _cutU) toWrite.users.push(u);
        }
      }
      if ("clients" in toWrite && Array.isArray(toWrite.clients)) {
        /* same stale-tab guard for freshly-minted customer records */
        const curC = await getStore("clients");
        const _cutC = Date.now() - 15 * 60 * 1000;
        const _haveC = new Set(toWrite.clients.map((c) => c && c.id));
        for (const c of (curC.ok && Array.isArray(curC.value) ? curC.value : [])) {
          if (c && !_haveC.has(c.id) && c.createdAt && Date.parse(c.createdAt) > _cutC) toWrite.clients.push(c);
        }
      }
      /* MASS-LOSS GUARD (users + clients): deleting is done one record at a time in the admin UI,
         so a write missing TWO OR MORE existing rows is a stale tab flushing an old copy — not a
         delete. Re-add everything it "forgot". (This exact failure erased two customer logins
         twice on 2026-07-13.) A single missing row is still treated as a legitimate delete. */
      for (const storeKey of ["users", "clients"]) {
        if (!(storeKey in toWrite) || !Array.isArray(toWrite[storeKey])) continue;
        const curS = await getStore(storeKey);
        const curRows = (curS.ok && Array.isArray(curS.value)) ? curS.value.filter((x) => x && x.id != null) : [];
        const haveS = new Set(toWrite[storeKey].map((x) => x && x.id));
        const missing = curRows.filter((x) => !haveS.has(x.id));
        if (missing.length >= 2) toWrite[storeKey] = [...toWrite[storeKey], ...missing];
      }
      /* FEATURE-FLAGS MERGE: flags are saved as one object keyed by login id. Merge per login so a
         stale tab can change the logins it knows about but can never ERASE entries added after it
         loaded (this wiped a login's byoCarrier entry on 2026-07-13). */
      if ("featureFlags" in toWrite && toWrite.featureFlags && typeof toWrite.featureFlags === "object" && !Array.isArray(toWrite.featureFlags)) {
        const curF = await getStore("featureFlags");
        const curV = (curF.ok && curF.value && typeof curF.value === "object" && !Array.isArray(curF.value)) ? curF.value : {};
        toWrite.featureFlags = { ...curV, ...toWrite.featureFlags };
      }
      /* ── DATA-LOSS GUARDS on the business-critical global stores ──
         1. A write that would WIPE a non-empty store (empty array / rateRules with zero
            profiles) is refused — a stale tab or a race can never nuke the admin's rates,
            customers, or logins.
         2. Every overwrite of a critical store snapshots the CURRENT value first
            (bak:<key>:<iso> rows, newest 10 kept) — anything is restorable. */
      const CRITICAL = ["users", "clients", "rateRules", "featureFlags", "invoicesIssued", "salesReps", "proposalReports"];
      for (const key of CRITICAL) {
        if (!(key in toWrite)) continue;
        const cur = await getStore(key);
        const curVal = cur.ok ? cur.value : undefined;
        const curSize = Array.isArray(curVal) ? curVal.length : (curVal && typeof curVal === "object" ? Object.keys(curVal).length : 0);
        const nv = toWrite[key];
        const nvSize = Array.isArray(nv) ? nv.length : (nv && typeof nv === "object" ? Object.keys(nv).length : 0);
        const wipes = curSize > 0 && (nv == null || nvSize === 0 || (key === "rateRules" && (!nv.profiles || !nv.profiles.length) && curVal && curVal.profiles && curVal.profiles.length));
        /* F19: also refuse a SEVERE partial shrink of a list store (users/clients) — the classic
           multi-tab clobber, where a stale tab that loaded a short list saves it over the full one.
           Dropping a ≥5-entry list to ≤40% of its size is almost never a real bulk delete; refuse it
           and tell the client to reload. (Total wipes are already caught above; the per-overwrite
           snapshot below still runs for everything that IS allowed, so any change stays restorable.) */
        const bigShrink = !wipes && Array.isArray(curVal) && Array.isArray(nv) && curSize >= 5 && nvSize <= curSize * 0.4;
        if (wipes || bigShrink) { delete toWrite[key]; rejected.push(key + (bigShrink ? " (refused: would drop from " + curSize + " to " + nvSize + " entries — looks like a stale tab overwrote the full list; reload and try again)" : " (refused: would erase " + curSize + " existing entries — reload and try again)")); continue; }
        /* F20: protect loaded rate cards — a rateRules save that drops ALL cost tables (baseCosts)
           when some were loaded is a stale-tab overwrite, not a real edit. Refuse it. */
        if (key === "rateRules" && curVal && nv) {
          const curBC = (curVal.baseCosts && typeof curVal.baseCosts === "object") ? Object.keys(curVal.baseCosts).length : 0;
          const nvBC = (nv.baseCosts && typeof nv.baseCosts === "object") ? Object.keys(nv.baseCosts).length : 0;
          if (curBC >= 1 && nvBC === 0) { delete toWrite[key]; rejected.push("rateRules (refused: would drop " + curBC + " loaded rate card(s)/cost table(s) — reload and try again)"); continue; }
        }
        if (curVal !== undefined) {
          try {
            const ts = new Date().toISOString().replace(/[:.]/g, "-");
            await putStores({ ["bak:" + key + ":" + ts]: curVal });
            // prune: keep the newest 10 snapshots per key
            const lr = await pg("app_stores?tenant=eq." + encodeURIComponent(TENANT) + "&key=like." + encodeURIComponent("bak:" + key + ":") + "*&select=key&order=key.desc");
            const keys = (Array.isArray(lr.data) ? lr.data : []).map((r2) => r2.key);
            for (const bk of keys.slice(10)) { await pg("app_stores?tenant=eq." + encodeURIComponent(TENANT) + "&key=eq." + encodeURIComponent(bk), { method: "DELETE" }); }
          } catch (e) { /* backup must never block the save itself */ }
        }
      }
      /* ── same protection for each customer's own operational stores (F14): orders/shipments
         are whole-array last-write-wins from the browser, so a stale tab could silently truncate
         them. A write that would EMPTY a non-empty store is refused; a big shrink (≥25% gone,
         store had ≥8 rows) snapshots the current value first so it stays restorable. ── */
      for (const key of Object.keys(toWrite)) {
        if (!/^u\/[^/]+\/(orders|shipments)$/.test(key)) continue;
        const curP = await getStore(key);
        const curArr = (curP.ok && Array.isArray(curP.value)) ? curP.value : null;
        if (!curArr || !curArr.length) continue;
        const nv = toWrite[key];
        const nvLen = Array.isArray(nv) ? nv.length : 0;
        if (nv == null || nvLen === 0) { delete toWrite[key]; rejected.push(key + " (refused: would erase " + curArr.length + " records — reload and try again)"); continue; }
        if (curArr.length >= 8 && nvLen <= curArr.length * 0.75) {
          try {
            const ts = new Date().toISOString().replace(/[:.]/g, "-");
            await putStores({ ["bak:" + key + ":" + ts]: curArr });
            const lr = await pg("app_stores?tenant=eq." + encodeURIComponent(TENANT) + "&key=like." + encodeURIComponent("bak:" + key + ":") + "*&select=key&order=key.desc");
            const bkeys = (Array.isArray(lr.data) ? lr.data : []).map((r2) => r2.key);
            for (const bk of bkeys.slice(5)) { await pg("app_stores?tenant=eq." + encodeURIComponent(TENANT) + "&key=eq." + encodeURIComponent(bk), { method: "DELETE" }); }
          } catch (e) { /* backup must never block the save itself */ }
        }
      }
      /* rejectedOnly: every key was refused by policy (permissions / wipe-guard) — a retry can
         never succeed, so the client must DROP these keys instead of looping offline forever. */
      if (!Object.keys(toWrite).length) return J({ ok: false, rejectedOnly: true, rejected, error: "Nothing saved — " + rejected.join("; ") });
      const w = await putStores(toWrite);
      if (!w.ok) return J({ ok: false, error: "Save failed: " + ((w.err && w.err.text) || "").slice(0, 200) });
      if (_newLogins.length) await notifyLoginCreated(_newLogins, "admin portal (" + maskEmail(auth.email || auth.uid) + ")");
      return J({ ok: true, saved: Object.keys(toWrite), rejected });
    }

    /* ── ShippingCloud API keys (Admin → API): hashed at rest, full key returned ONCE ── */
    if (action === "apiKeys") {
      if (auth.role !== "admin") return J({ ok: false, error: "Admin only." });
      const cur = await getStore("apiKeys");
      const keys = (cur.ok && Array.isArray(cur.value)) ? cur.value : [];
      return J({ ok: true, keys: keys.map((k) => ({ id: k.id, mode: k.mode || "live", prefix: k.prefix, label: k.label, clientId: k.clientId, createdAt: k.createdAt, lastUsed: k.lastUsed || null, revoked: !!k.revoked })) });
    }
    if (action === "apiKeyCreate") {
      if (auth.role !== "admin") return J({ ok: false, error: "Admin only." });
      const mode = ["test","live","admin"].includes(String(body.mode || "live")) ? String(body.mode) : "live";
      // admin/integration keys are platform-wide, not tied to one customer, so they don't need a clientId
      const clientId = mode === "admin" ? "" : String(body.clientId || "");
      if (mode !== "admin" && !clientId) return J({ ok: false, error: "Pick the customer this key belongs to." });
      const cur = await getStore("apiKeys");
      const keys = (cur.ok && Array.isArray(cur.value)) ? cur.value : [];
      if (keys.filter((k) => !k.revoked).length >= 500) return J({ ok: false, error: "Key limit reached." });
      const raw = "sck_" + mode + "_" + crypto.randomBytes(24).toString("hex");
      const row = { id: "k" + Date.now(), mode, prefix: raw.slice(0, 14) + "…", label: String(body.label || "").slice(0, 60), clientId, hash: crypto.createHash("sha256").update(raw).digest("hex"), createdAt: new Date().toISOString() };
      const w = await putStores({ apiKeys: [...keys, row] });
      if (!w.ok) return J({ ok: false, error: "Save failed." });
      return J({ ok: true, key: raw, id: row.id, prefix: row.prefix });
    }
    if (action === "apiKeyRevoke") {
      if (auth.role !== "admin") return J({ ok: false, error: "Admin only." });
      const cur = await getStore("apiKeys");
      const keys = (cur.ok && Array.isArray(cur.value)) ? cur.value : [];
      const w = await putStores({ apiKeys: keys.map((k) => k.id === String(body.id) ? { ...k, revoked: true } : k) });
      return J(w.ok ? { ok: true } : { ok: false, error: "Save failed." });
    }

    /* ── snapshot management (F17): bak:<key>:<ts> rows are written by the wipe-guards above.
       listBackups shows what exists; restoreBackup puts one back — after snapshotting the
       CURRENT value first, so a restore is itself reversible. Admin only. ── */
    if (action === "deleteCustomer") {   // atomic delete: remove client + unlink its logins + tombstone (so heal can't resurrect it)
      if (auth.role !== "admin") return J({ ok: false, error: "Admin only." });
      const cid = String(body.clientId || "");
      if (!cid) return J({ ok: false, error: "No customer id." });
      const [cRes, uRes, tRes] = await Promise.all([getStore("clients"), getStore("users"), getStore("deletedClients")]);
      const clients = (cRes.ok && Array.isArray(cRes.value)) ? cRes.value : [];
      const users = (uRes.ok && Array.isArray(uRes.value)) ? uRes.value : [];
      const tomb = (tRes.ok && Array.isArray(tRes.value)) ? tRes.value : [];
      if (!clients.some((c) => c && c.id === cid)) {
        // already gone from clients — still make sure it's tombstoned + logins unlinked
        const nt = tomb.includes(cid) ? tomb : [...tomb, cid].slice(-1000);
        await putStores({ users: users.map((u) => u && u.clientId === cid ? { ...u, clientId: null } : u), deletedClients: nt });
        return J({ ok: true, removed: cid, already: true });
      }
      try { const ts = new Date().toISOString().replace(/[:.]/g, "-"); await putStores({ ["bak:clients:" + ts]: clients }); } catch (e) {}   // snapshot before an intentional delete
      const newClients = clients.filter((c) => c && c.id !== cid);
      const newUsers = users.map((u) => u && u.clientId === cid ? { ...u, clientId: null } : u);
      const newTomb = tomb.includes(cid) ? tomb : [...tomb, cid].slice(-1000);
      const w = await putStores({ clients: newClients, users: newUsers, deletedClients: newTomb });
      if (!w.ok) return J({ ok: false, error: "Delete failed: " + ((w.err && w.err.text) || "").slice(0, 150) });
      return J({ ok: true, removed: cid });
    }
    if (action === "listBackups") {
      if (auth.role !== "admin") return J({ ok: false, error: "Admin only." });
      const lr = await pg("app_stores?tenant=eq." + encodeURIComponent(TENANT) + "&key=like." + encodeURIComponent("bak:") + "*&select=key,value&order=key.desc");
      const rows = (Array.isArray(lr.data) ? lr.data : []);
      const SHOW = ["clients", "rateRules", "users", "featureFlags", "invoicesIssued", "salesReps", "proposalReports"];   // recovery UI focuses on the critical stores; per-customer op backups excluded here to keep the payload small
      const out = [];
      for (const r2 of rows) {
        const key = String(r2.key || "");
        const cut = key.lastIndexOf(":");
        const orig = key.startsWith("bak:") && cut > 4 ? key.slice(4, cut) : "";
        if (!SHOW.includes(orig)) continue;
        const ts = cut > 4 ? key.slice(cut + 1) : "";
        const v = r2.value;
        let count = 0, sample = [];
        try {
          if (Array.isArray(v)) { count = v.length; sample = v.slice(0, 8).map((x) => x && (x.name || x.email || x.id)).filter(Boolean); }
          else if (v && typeof v === "object") {
            if (Array.isArray(v.profiles)) { count = v.profiles.length; sample = v.profiles.slice(0, 8).map((p) => p && p.name).filter(Boolean); }
            else count = Object.keys(v).length;
          }
        } catch (e) {}
        out.push({ key, orig, ts, count, sample });
        if (out.length >= 200) break;
      }
      return J({ ok: true, backups: out });
    }
    if (action === "getBackup") {   // read one snapshot's full value (admin only) — powers the individual-customer picker
      if (auth.role !== "admin") return J({ ok: false, error: "Admin only." });
      const bkey = String(body.key || "");
      if (!bkey.startsWith("bak:")) return J({ ok: false, error: "Not a backup key." });
      const bak = await getStore(bkey);
      if (!bak.ok || bak.value === undefined) return J({ ok: false, error: "Backup not found." });
      return J({ ok: true, value: bak.value });
    }
    if (action === "restoreBackup") {
      if (auth.role !== "admin") return J({ ok: false, error: "Admin only." });
      const bkey = String(body.key || "");
      const cut = bkey.lastIndexOf(":");
      const orig = bkey.startsWith("bak:") && cut > 4 ? bkey.slice(4, cut) : "";
      if (!orig || orig === "session" || orig.startsWith("bak:")) return J({ ok: false, error: "Not a valid backup key." });
      const bak = await getStore(bkey);
      if (!bak.ok || bak.value === undefined) return J({ ok: false, error: "Backup not found." });
      try { const cur = await getStore(orig); if (cur.ok && cur.value !== undefined) { const ts = new Date().toISOString().replace(/[:.]/g, "-"); await putStores({ ["bak:" + orig + ":" + ts]: cur.value }); } } catch (e) {}
      const w = await putStores({ [orig]: bak.value });
      if (!w.ok) return J({ ok: false, error: "Restore failed: " + ((w.err && w.err.text) || "").slice(0, 150) });
      return J({ ok: true, restored: orig });
    }

    if (action === "setPassword") {
      const email = String(body.email || "").trim().toLowerCase();
      const newPassword = String(body.newPassword || "");
      if (!email || newPassword.length < 4) return J({ ok: false, error: "Password must be at least 4 characters." });
      const cur = await getStore("users");
      const users = (cur.ok && Array.isArray(cur.value)) ? cur.value : [];
      const idx = users.findIndex((x) => x && String(x.email || "").toLowerCase() === email);
      if (idx < 0) return J({ ok: false, error: "No user with that email." });
      /* Self-service is authorized by UID, not the token's embedded email — after a changeEmail,
         an old token still carries the OLD address, and if that address is later re-registered by
         someone else, an email-keyed check would let the old token reset the NEW user's password. */
      if (auth.role !== "admin" && String(users[idx].id) !== String(auth.uid)) return J({ ok: false, error: "You can only change your own password." });
      /* a stolen 30-day session token must not be enough to silently take the account over —
         the self path re-proves identity with the current password, exactly like changeEmail */
      if (auth.role !== "admin" && !checkPw(String(body.currentPassword || ""), users[idx].passHash)) return J({ ok: false, error: "Enter your current password to set a new one." });
      users[idx] = { ...users[idx], password: "", passHash: hashPw(newPassword) };
      const w = await putStores({ users });
      if (!w.ok) return J({ ok: false, error: "Save failed." });
      return J({ ok: true });
    }

    /* ── self-service: change your own login email, keeping the same password + 2FA ──
       Requires the current password (confirms it's really you, not a hijacked session). */
    if (action === "changeEmail") {
      const newEmail = String(body.newEmail || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!/.+@.+\..+/.test(newEmail)) return J({ ok: false, error: "Enter a valid email address." });
      const cur = await getStore("users");
      const users = (cur.ok && Array.isArray(cur.value)) ? cur.value : [];
      const me = users.find((x) => x && x.id === auth.uid) || null;
      if (!me) return J({ ok: false, error: "Account not found." });
      if (!checkPw(password, me.passHash)) return J({ ok: false, error: "That password isn’t right — enter your current password to change your email." });
      if (users.some((x) => x && x.id !== auth.uid && String(x.email || "").toLowerCase() === newEmail)) return J({ ok: false, error: "Another account already uses that email." });
      // spread ...x preserves passHash AND totp (secret + backup codes) — only the email changes
      const merged = users.map((x) => x && x.id === auth.uid ? { ...x, email: newEmail } : x);
      const w = await putStores({ users: merged });
      if (!w.ok) return J({ ok: false, error: "Could not save — try again." });
      // reissue the session token so its embedded email matches the new one
      const updated = { ...me, email: newEmail };
      return J({ ok: true, email: newEmail, token: makeToken(updated), user: { ...updated, password: "", passHash: undefined, totp: updated.totp ? { enabled: !!updated.totp.enabled, backupLeft: backupLeft(updated.totp.backup) } : undefined } });
    }

    /* ── admin: turn OFF a user's 2FA (lost-phone recovery) ── the only way back in for a
       user who enabled 2FA and lost their authenticator. Admin-only; can't be self-abused. */
    if (action === "clearTotp") {
      if (auth.role !== "admin") return J({ ok: false, error: "Admin only." });
      const email = String(body.email || "").trim().toLowerCase();
      if (!email) return J({ ok: false, error: "Which user?" });
      const cur = await getStore("users");
      const users = (cur.ok && Array.isArray(cur.value)) ? cur.value : [];
      const idx = users.findIndex((x) => x && String(x.email || "").toLowerCase() === email);
      if (idx < 0) return J({ ok: false, error: "No user with that email." });
      users[idx] = { ...users[idx], totp: undefined, trustedDevices: (users[idx].email2fa && users[idx].email2fa.enabled) ? users[idx].trustedDevices : undefined };
      const w = await putStores({ users });
      if (!w.ok) return J({ ok: false, error: "Save failed." });
      return J({ ok: true });
    }

    if (action === "getUpload") {
      if (auth.role !== "admin") return J({ ok: false, error: "Admin only." });
      const key = String(body.key || "");
      if (!/^inv_[0-9a-f]{40}$/.test(key)) return J({ ok: false, error: "Bad file reference." });
      const r = await blobOp(key);
      if (!r || !r.ok) return J({ ok: false, error: "File not found (it may have been cleaned up)." });
      const f = await r.json().catch(() => null);
      if (!f || !f.data) return J({ ok: false, error: "File unreadable." });
      return J({ ok: true, name: f.name || "invoice", type: f.type || "application/octet-stream", data: f.data });
    }

    /* ── logged-in "get my FedEx account" request (from the welcome popup) ── */
    if (action === "fedexRequest") {
      const volume = String(body.volume || "").slice(0, 40);
      const carrier = String(body.carrier || "").slice(0, 40);
      const name = String(body.name || "").slice(0, 80);
      let invoiceName = "", invoiceKey = "";
      const inv = body.invoice;
      if (inv && inv.data) {
        if (String(inv.data).length > MAX_UPLOAD_B64) return J({ ok: false, error: "That file is too large — please upload one under 3 MB." });
        if (inv.type && !OK_UPLOAD_TYPES.includes(String(inv.type))) return J({ ok: false, error: "Please upload a PDF, CSV, Excel file, or image of your invoice." });
        invoiceKey = "inv_" + crypto.createHash("sha1").update(auth.uid + "|" + Date.now()).digest("hex");
        invoiceName = String(inv.name || "invoice").slice(0, 120);
        const up = await blobOp(invoiceKey, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: invoiceName, type: String(inv.type || "application/octet-stream"), data: String(inv.data) }) });
        if (!up || !up.ok) { invoiceKey = ""; invoiceName = ""; }
      }
      const cur = await getStore("fedexRequests");
      let reqs = (cur.ok && Array.isArray(cur.value)) ? cur.value : [];
      const prior = reqs.find((r) => r && r.uid === auth.uid);
      if (prior && prior.invoiceKey && invoiceKey) await blobOp(prior.invoiceKey, { method: "DELETE" });
      reqs = reqs.filter((r) => r && r.uid !== auth.uid);
      if (reqs.length >= 200) return J({ ok: false, error: "Too many pending requests — try again later." });
      const newReq = { id: "fx" + Date.now(), uid: auth.uid, name, email: auth.email || "", volume, carrier, invoiceName, invoiceKey, requestedAt: new Date().toISOString() };
      reqs.push(newReq);
      const w = await putStores({ fedexRequests: reqs });
      if (!w.ok) return J({ ok: false, error: "Could not save your request — try again." });
      await notifyFedexRequest(newReq, inv);
      return J({ ok: true });
    }

    /* Admin dismisses a FedEx request — removes it server-side (a client-only filter kept
       getting restored by the next cloud poll) and deletes the stored invoice blob. */
    if (action === "fedexRequestResolve") {
      if (auth.role !== "admin") return J({ ok: false, error: "Admin only." });
      const id = String(body.id || ""), uid = String(body.uid || "");
      const cur = await getStore("fedexRequests");
      const reqs = (cur.ok && Array.isArray(cur.value)) ? cur.value : [];
      const gone = reqs.filter((r) => r && (r.id === id || (uid && r.uid === uid)));
      const kept = reqs.filter((r) => !(r && (r.id === id || (uid && r.uid === uid))));
      for (const g of gone) { if (g.invoiceKey) { try { await blobOp(g.invoiceKey, { method: "DELETE" }); } catch (e) {} } }
      const w = await putStores({ fedexRequests: kept });
      if (!w.ok) return J({ ok: false, error: "Couldn't update — try again." });
      return J({ ok: true, fedexRequests: kept });
    }

    if (action === "approveSignup" || action === "denySignup") {
      if (auth.role !== "admin") return J({ ok: false, error: "Admin only." });
      const email = String(body.email || "").trim().toLowerCase();
      const [curU, curR] = await Promise.all([getStore("users"), getStore("signupRequests")]);
      const users = (curU.ok && Array.isArray(curU.value)) ? curU.value : [];
      const reqs = (curR.ok && Array.isArray(curR.value)) ? curR.value : [];
      const req = reqs.find((r) => r && String(r.email || "").toLowerCase() === email);
      if (!req) return J({ ok: false, error: "Request not found (it may have been handled already)." });
      const remaining = reqs.filter((r) => r !== req);
      if (action === "denySignup") {
        if (req.invoiceKey) await blobOp(req.invoiceKey, { method: "DELETE" });
        const w = await putStores({ signupRequests: remaining });
        return w.ok ? J({ ok: true, requests: stripUsers(remaining) }) : J({ ok: false, error: "Save failed." });
      }
      if (users.some((u) => u && String(u.email || "").toLowerCase() === email)) return J({ ok: false, error: "A user with that email already exists — deny this request (or delete the existing user first)." });
      const newUser = { id: "u" + Date.now() + Math.floor(Math.random() * 1000), name: req.name, email: req.email, company: req.company || "", role: String(body.role || "customer") === "admin" ? "admin" : "customer", clientId: body.clientId || null, status: "active", password: "", passHash: req.passHash, lastLogin: "—" };
      const w = await putStores({ users: [...users, newUser], signupRequests: remaining });
      if (!w.ok) return J({ ok: false, error: "Save failed." });
      await notifyLoginCreated([newUser], "signup approval");
      return J({ ok: true, users: stripUsers([...users, newUser]), requests: stripUsers(remaining) });
    }

    return J({ ok: false, error: "Unknown action." });
  } catch (e) {
    return J({ ok: false, error: "Function error: " + ((e && e.message) || String(e)) });
  }
};
