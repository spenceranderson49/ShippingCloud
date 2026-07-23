/* ════════════════════════════════════════════════════════════════════════
   fullcircle-send.js — deliver a Full Circle ship-confirmation file.
   The SPA builds the UCC file (see the Full Circle Export admin screen) and posts it
   here to be delivered the way Aptean asks for at final scope:
     • "sftp"  — upload the file to Full Circle's SFTP host/folder.
     • "email" — email the file as an attachment (some ERPs ingest a watched mailbox).
     • "download" is handled entirely in the browser and never reaches this function.
     in:  { token, mode, filename, content, sftp:{host,port,username,password,privateKey,dir}, email:{to,from} }
     out: { ok:true, via:"sftp"|"email", detail } | { ok:false, error }
   Same signed-session gate as quote.js / fedexlocations.js. Admin-triggered.
   ════════════════════════════════════════════════════════════════════════ */
const scCrypto = require("crypto");
const scSecret = () => { const s = (process.env.SESSION_SECRET || "").trim(); if (s) return s; const k = (process.env.SUPABASE_SERVICE_KEY || "").trim(); return k ? scCrypto.createHash("sha256").update("sc1|" + k).digest("hex") : ""; };
function scAuth(body) {
  const sec = scSecret();
  if (!sec) return { uid: "local", local: true };
  try {
    const [p, sig] = String((body && body.token) || "").split(".");
    if (!p || !sig) return null;
    const want = Buffer.from(scCrypto.createHmac("sha256", sec).update(p).digest("hex"), "hex");
    const got = Buffer.from(sig, "hex");
    if (want.length !== got.length || !scCrypto.timingSafeEqual(want, got)) return null;
    const d = JSON.parse(Buffer.from(String(p).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (!d || d.kind || !d.uid || !d.exp || Date.now() > d.exp) return null;
    return d;
  } catch (e) { return null; }
}
const scHits = {};
function scAllow(k, max) { const w = Math.floor(Date.now() / 60000), kk = k + ":" + w; scHits[kk] = (scHits[kk] || 0) + 1; if (Object.keys(scHits).length > 4000) { for (const x in scHits) { if (!x.endsWith(":" + w)) delete scHits[x]; } } return scHits[kk] <= max; }

const safeName = (n) => String(n || "shipconfirm.txt").replace(/[^\w.\-]+/g, "_").slice(0, 120) || "shipconfirm.txt";

/* SFTP upload. ssh2-sftp-client is an optional dependency — lazy-require it so a missing
   install degrades to a clear message instead of taking the whole function down. */
async function sendSftp(cfg, filename, content) {
  let Client;
  /* Load the SFTP library through a runtime-resolved require so Netlify's function bundler doesn't
     try (and fail) to statically include an optional dependency that isn't installed. When we're
     ready to enable SFTP, add ssh2-sftp-client to package.json and this resolves at runtime. */
  try { const _req = (0, eval)("require"); Client = _req("ssh2-sftp-client"); }
  catch (e) { return { ok: false, error: "SFTP isn't available on this server yet (the ssh2-sftp-client library isn't installed). Use Email delivery, or ask us to enable SFTP." }; }
  const host = String(cfg.host || "").trim();
  if (!host) return { ok: false, error: "Enter the SFTP host." };
  const sftp = new Client();
  const conn = {
    host,
    port: Number(cfg.port) || 22,
    username: String(cfg.username || "").trim(),
    readyTimeout: 20000,
  };
  if (cfg.privateKey && String(cfg.privateKey).trim()) conn.privateKey = String(cfg.privateKey);
  if (cfg.password && String(cfg.password).length) conn.password = String(cfg.password);
  const dir = String(cfg.dir || "").replace(/\/+$/, "");
  const remote = (dir ? dir + "/" : "") + safeName(filename);
  try {
    await sftp.connect(conn);
    try { if (dir) await sftp.mkdir(dir, true); } catch (e) { /* dir may already exist */ }
    await sftp.put(Buffer.from(content, "utf8"), remote);
    return { ok: true, via: "sftp", detail: "Uploaded to " + remote };
  } catch (e) {
    return { ok: false, error: "SFTP upload failed: " + ((e && e.message) || "connection error") };
  } finally { try { await sftp.end(); } catch (e) {} }
}

/* Email the file as an attachment via Resend (already used elsewhere for account mail). */
async function sendEmail(cfg, filename, content) {
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) return { ok: false, error: "Email isn't set up on this server yet (RESEND_API_KEY)." };
  const to = String(cfg.to || "").trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { ok: false, error: "Enter a valid destination email." };
  const from = String(cfg.from || "").trim() || "ShippingHub <noreply@freightwireship.com>";
  const body = {
    from, to: [to],
    subject: "Full Circle ship confirmation — " + safeName(filename),
    text: "Attached is the ship-confirmation file (" + safeName(filename) + ").",
    attachments: [{ filename: safeName(filename), content: Buffer.from(content, "utf8").toString("base64") }],
  };
  try {
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: "Email failed: " + ((d && d.message) || ("HTTP " + r.status)) };
    return { ok: true, via: "email", detail: "Emailed to " + to };
  } catch (e) { return { ok: false, error: "Email failed: " + ((e && e.message) || "network error") }; }
}

exports.handler = async (event) => {
  const respond = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  if (event.httpMethod === "OPTIONS") return respond(200, { ok: true });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return respond(200, { ok: false, error: "Bad request body" }); }
  const auth = scAuth(body);
  if (!auth) return respond(200, { ok: false, authFailed: true, error: "Sign in as an admin to send the file." });
  if (!scAllow("fc:" + auth.uid, 60)) return respond(200, { ok: false, error: "Too many sends — give it a moment." });

  const content = String(body.content == null ? "" : body.content);
  if (!content.trim()) return respond(200, { ok: false, error: "Nothing to send — the file is empty." });
  const filename = safeName(body.filename);
  const mode = String(body.mode || "").toLowerCase();

  if (mode === "sftp") return respond(200, await sendSftp(body.sftp || {}, filename, content));
  if (mode === "email") return respond(200, await sendEmail(body.email || {}, filename, content));
  return respond(200, { ok: false, error: "Pick a delivery method (SFTP or Email) in the settings first." });
};
