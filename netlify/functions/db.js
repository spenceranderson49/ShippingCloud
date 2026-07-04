/* ════════════════════════════════════════════════════════════════════════
   POST /.netlify/functions/db — ShippingCloud cloud database + auth
   ------------------------------------------------------------------------
   The ONLY thing that talks to the database. The browser never sees a
   database key. Backed by Supabase Postgres via its REST API (plain fetch,
   zero dependencies), table `app_stores` (tenant, key, value jsonb).

   Env vars (Netlify): SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SECRET
   (SESSION_SECRET optional — derived from the service key if unset).

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
  const r = await pg("app_stores?tenant=eq.main&key=eq." + encodeURIComponent(key) + "&select=value");
  if (!r.ok) return { ok: false, err: r };
  return { ok: true, value: Array.isArray(r.data) && r.data[0] ? r.data[0].value : undefined };
};
const putStores = async (map) => {
  const rows = Object.keys(map).map((k) => ({ tenant: "main", key: k, value: map[k], updated_at: new Date().toISOString() }));
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
    if (!payload || !payload.uid || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

/* ── users store hygiene: hashes never leave; plaintext never stored ── */
const stripUsers = (arr) => (Array.isArray(arr) ? arr : []).map((u) => ({ ...u, password: "", passHash: undefined }));
function mergeUsersForWrite(incoming, current) {
  const cur = Array.isArray(current) ? current : [];
  const byEmail = {}; for (const u of cur) if (u && u.email) byEmail[String(u.email).toLowerCase()] = u;
  return (Array.isArray(incoming) ? incoming : []).map((u) => {
    if (!u) return u;
    const existing = u.email ? byEmail[String(u.email).toLowerCase()] : null;
    const out = { ...u, password: "" };
    if (existing && existing.passHash) out.passHash = existing.passHash;      // NEVER change an existing password via a store write
    else if (u.password) out.passHash = hashPw(u.password);                    // brand-new user: hash their initial password
    return out;
  });
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
const canWriteKey = (auth, key) => auth.role === "admin" ? key !== "session" : String(key).startsWith(userScope(auth));
const SYNC_BLOCK = { session: 1 }; // never stored server-side

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, body: "" };
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let body = {}; try { body = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON body" }); }
    const action = body.action || "";

    if (action === "ping") return J({ ok: true, configured: configured() });
    if (!configured()) return J({ ok: false, notConfigured: true, error: "Cloud database isn't configured yet (SUPABASE_URL / SUPABASE_SERVICE_KEY env vars)." });

    /* ── login (+ first-ever bootstrap) ── */
    if (action === "login") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!email || !password) return J({ ok: false, error: "Enter your email and password." });
      const cur = await getStore("users");
      if (!cur.ok) return J({ ok: false, error: "Database error: " + ((cur.err && cur.err.text) || cur.err && cur.err.status || "unreachable") + ". Check the SQL setup step and env vars." });
      let users = Array.isArray(cur.value) ? cur.value : [];
      if (!users.length) {
        // BOOTSTRAP: very first login creates the admin account with this email + password.
        const admin = { id: "u1", name: email.split("@")[0], email, role: "admin", clientId: null, status: "active", password: "", passHash: hashPw(password), lastLogin: new Date().toLocaleDateString() };
        const w = await putStores({ users: [admin] });
        if (!w.ok) return J({ ok: false, error: "Could not create the admin account: " + ((w.err && w.err.text) || "").slice(0, 200) });
        return J({ ok: true, bootstrap: true, token: makeToken(admin), user: { ...admin, passHash: undefined } });
      }
      const u = users.find((x) => x && String(x.email || "").toLowerCase() === email);
      if (!u || !checkPw(password, u.passHash)) return J({ ok: false, error: "Incorrect email or password." });
      if (u.status && u.status !== "active") return J({ ok: false, error: "This account is inactive. Contact your administrator." });
      return J({ ok: true, token: makeToken(u), user: { ...u, password: "", passHash: undefined } });
    }

    /* ── request access (no auth): stores a pending signup for admin approval ── */
    if (action === "requestAccess") {
      const name = String(body.name || "").trim().slice(0, 80);
      const email = String(body.email || "").trim().toLowerCase().slice(0, 120);
      const company = String(body.company || "").trim().slice(0, 120);
      const password = String(body.password || "");
      if (!name || !/.+@.+\..+/.test(email) || password.length < 4) return J({ ok: false, error: "Enter your name, a valid email, and a password (4+ characters)." });
      const [curU, curR] = await Promise.all([getStore("users"), getStore("signupRequests")]);
      const users = (curU.ok && Array.isArray(curU.value)) ? curU.value : [];
      if (users.some((u) => u && String(u.email || "").toLowerCase() === email)) return J({ ok: false, error: "That email already has a login. Try signing in." });
      let reqs = (curR.ok && Array.isArray(curR.value)) ? curR.value : [];
      reqs = reqs.filter((r) => r && String(r.email || "").toLowerCase() !== email);   // resubmission replaces
      if (reqs.length >= 100) return J({ ok: false, error: "Too many pending requests right now — please try again later." });
      const volume = String(body.volume || "").slice(0, 40);
      const carrier = String(body.carrier || "").slice(0, 40);
      let invoiceName = "", invoiceKey = "";
      const inv = body.invoice;
      if (inv && inv.data) {
        if (String(inv.data).length > MAX_UPLOAD_B64) return J({ ok: false, error: "That file is too large — please upload one under 3 MB (a single recent invoice is perfect)." });
        if (inv.type && !OK_UPLOAD_TYPES.includes(String(inv.type))) return J({ ok: false, error: "Please upload a PDF, CSV, Excel file, or image of your invoice." });
        invoiceKey = "inv_" + crypto.createHash("sha1").update(email + "|" + Date.now()).digest("hex");
        invoiceName = String(inv.name || "invoice").slice(0, 120);
        const up = await blobOp(invoiceKey, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: invoiceName, type: String(inv.type || "application/octet-stream"), data: String(inv.data) }) });
        if (!up || !up.ok) { invoiceKey = ""; invoiceName = ""; }   // upload failed → request still goes through without the file
      }
      reqs.push({ id: "req" + Date.now(), name, email, company, volume, carrier, invoiceName, invoiceKey, passHash: hashPw(password), requestedAt: new Date().toISOString() });
      const w = await putStores({ signupRequests: reqs });
      if (!w.ok) return J({ ok: false, error: "Could not save your request — try again." });
      return J({ ok: true, pending: true });
    }

    /* ── everything below requires a valid session ── */
    const auth = verifyToken(body.token);
    if (!auth) return J({ ok: false, authFailed: true, error: "Session expired — sign in again." });

    if (action === "getAll") {
      const r = await pg("app_stores?tenant=eq.main&select=key,value");
      if (!r.ok) return J({ ok: false, error: "Database error " + r.status });
      const stores = {};
      for (const row of (Array.isArray(r.data) ? r.data : [])) {
        if (!row || row.key == null) continue;
        if (auth.role !== "admin" && !String(row.key).startsWith(userScope(auth))) continue;
        stores[row.key] = (row.key === "users" || row.key === "signupRequests") ? stripUsers(row.value) : row.value;
      }
      if (auth.role !== "admin") {
        delete stores.users;
        // hand each customer ONLY their own feature flags (admin manages the full map)
        const allFlags = (Array.isArray(r.data) ? r.data : []).find((row) => row && row.key === "featureFlags");
        stores.myFeatures = (allFlags && allFlags.value && allFlags.value[auth.uid]) || {};
      }
      return J({ ok: true, stores });
    }

    if (action === "putMany") {
      const incoming = (body.stores && typeof body.stores === "object") ? body.stores : {};
      const toWrite = {}; const rejected = [];
      for (const key of Object.keys(incoming)) {
        if (SYNC_BLOCK[key] || !canWriteKey(auth, key)) { rejected.push(key); continue; }
        toWrite[key] = incoming[key];
      }
      if ("users" in toWrite) {
        const cur = await getStore("users");
        toWrite.users = mergeUsersForWrite(toWrite.users, cur.ok ? cur.value : []);
      }
      const w = await putStores(toWrite);
      if (!w.ok) return J({ ok: false, error: "Save failed: " + ((w.err && w.err.text) || "").slice(0, 200) });
      return J({ ok: true, saved: Object.keys(toWrite), rejected });
    }

    if (action === "setPassword") {
      const email = String(body.email || "").trim().toLowerCase();
      const newPassword = String(body.newPassword || "");
      if (!email || newPassword.length < 4) return J({ ok: false, error: "Password must be at least 4 characters." });
      if (auth.role !== "admin" && String(auth.email || "").toLowerCase() !== email) return J({ ok: false, error: "You can only change your own password." });
      const cur = await getStore("users");
      const users = (cur.ok && Array.isArray(cur.value)) ? cur.value : [];
      const idx = users.findIndex((x) => x && String(x.email || "").toLowerCase() === email);
      if (idx < 0) return J({ ok: false, error: "No user with that email." });
      users[idx] = { ...users[idx], password: "", passHash: hashPw(newPassword) };
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
      reqs.push({ id: "fx" + Date.now(), uid: auth.uid, name, email: auth.email || "", volume, carrier, invoiceName, invoiceKey, requestedAt: new Date().toISOString() });
      const w = await putStores({ fedexRequests: reqs });
      if (!w.ok) return J({ ok: false, error: "Could not save your request — try again." });
      return J({ ok: true });
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
      const newUser = { id: "u" + Date.now(), name: req.name, email: req.email, company: req.company || "", role: String(body.role || "customer") === "admin" ? "admin" : "customer", clientId: body.clientId || null, status: "active", password: "", passHash: req.passHash, lastLogin: "—" };
      const w = await putStores({ users: [...users, newUser], signupRequests: remaining });
      if (!w.ok) return J({ ok: false, error: "Save failed." });
      return J({ ok: true, users: stripUsers([...users, newUser]), requests: stripUsers(remaining) });
    }

    return J({ ok: false, error: "Unknown action." });
  } catch (e) {
    return J({ ok: false, error: "Function error: " + ((e && e.message) || String(e)) });
  }
};
