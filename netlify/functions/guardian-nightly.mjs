/* guardian-nightly.mjs — nightly data guardian (scheduled, ~2am Mountain / 08:00 UTC).
   Runs server-side on Netlify with Supabase credentials, so it can read all your data.
   Three jobs, all best-effort (never throws — a failure is logged and the run ends quietly):

     1) INTEGRITY WATCHDOG — compares each store's count to last night's; flags a big drop
        (e.g. customers 8 -> 2) so you hear about missing data immediately, not by surprise.
     2) CUSTOMER SETUP QA — flags customers missing a login, or with no rates/markup set.
     2b) DRIFT / FACTORY-RULE SCAN — flags any real customer login still carrying the built-in
        demo Autopilot rules (names use a "→" arrow). Left behind by a migration, these can
        silently reroute real shipments — this is the alarm for the LAgence-style drift.
     3) OFF-SITE BACKUP — writes a full JSON snapshot of everything, keeps the last ~14 in the
        database, EMAILS it as ONE message to a single recipient (attachment) — from PRODUCTION
        only, so you never get duplicate nightly emails — and UPLOADS it to Google Drive if
        configured.

   Env vars:
     SUPABASE_URL / SUPABASE_SERVICE_KEY            (already set)
     DB_TENANT                                      (optional; default "main")
     RESEND_API_KEY                                 (already set for password emails) — enables the email
     EMAIL_FROM                                     (optional; sender)
     GUARDIAN_EMAIL                                 (optional; the single recipient — else first admin)
     GOOGLE_SERVICE_ACCOUNT_JSON + GDRIVE_FOLDER_ID (optional; enables Google Drive upload)
     GUARDIAN_DISABLED=1                            (optional; skip on a given site, e.g. staging)
*/
import crypto from "node:crypto";

const TENANT = (process.env.DB_TENANT || "main").trim() || "main";
const supa = () => ({ base: (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), key: process.env.SUPABASE_SERVICE_KEY || "" });
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sizeOf = (v) => Array.isArray(v) ? v.length : (v && typeof v === "object" ? (Array.isArray(v.profiles) ? v.profiles.length : Object.keys(v).length) : 0);

async function pgAll() {
  const { base, key } = supa();
  const r = await fetch(base + "/rest/v1/app_stores?tenant=eq." + encodeURIComponent(TENANT) + "&select=key,value", { headers: { apikey: key, Authorization: "Bearer " + key } });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}
async function pgUpsert(rows) {
  const { base, key } = supa();
  const r = await fetch(base + "/rest/v1/app_stores?on_conflict=tenant,key", { method: "POST", headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
  return r.ok;
}
async function pgPruneFullBackups() {
  try {
    const { base, key } = supa();
    const lr = await fetch(base + "/rest/v1/app_stores?tenant=eq." + encodeURIComponent(TENANT) + "&key=like." + encodeURIComponent("bak:full:") + "*&select=key&order=key.desc", { headers: { apikey: key, Authorization: "Bearer " + key } });
    const ks = (await lr.json().catch(() => [])) || [];
    for (const row of ks.slice(14)) await fetch(base + "/rest/v1/app_stores?tenant=eq." + encodeURIComponent(TENANT) + "&key=eq." + encodeURIComponent(row.key), { method: "DELETE", headers: { apikey: key, Authorization: "Bearer " + key } });
  } catch (e) { /* pruning is best-effort */ }
}

async function uploadToDrive(filename, content) {
  const saRaw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
  const folder = (process.env.GDRIVE_FOLDER_ID || "").trim();
  if (!saRaw || !folder) return "not configured";
  let sa; try { sa = JSON.parse(saRaw); } catch (e) { return "GOOGLE_SERVICE_ACCOUNT_JSON isn't valid JSON"; }
  if (!sa.client_email || !sa.private_key) return "service-account JSON missing client_email/private_key";
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive.file", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = crypto.sign("RSA-SHA256", Buffer.from(header + "." + claim), sa.private_key).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = header + "." + claim + "." + sig;
  const tr = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + jwt });
  const tj = await tr.json().catch(() => null);
  if (!tj || !tj.access_token) return "Google auth failed (check the service-account key)";
  const boundary = "gd" + now;
  const meta = { name: filename, parents: [folder] };
  const body = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta) + "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" + content + "\r\n--" + boundary + "--";
  const ur = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true", { method: "POST", headers: { Authorization: "Bearer " + tj.access_token, "Content-Type": "multipart/related; boundary=" + boundary }, body });
  if (!ur.ok) { const t = await ur.text().catch(() => ""); return "Drive upload rejected: " + t.slice(0, 160); }
  return "uploaded ✓";
}

async function emailSummary({ recipients, counts, alerts, qa, drift = [], driveNote, backupStr, stamp }) {
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key || !recipients.length) return;
  const baseFrom = (process.env.EMAIL_FROM || "Freightwire <notify@shippingcloud.net>").trim();
  const fromAddr = (baseFrom.match(/<([^>]+)>/) || [null, baseFrom])[1];
  const from = "Freightwire <" + fromAddr + ">";   // always brand the sender "Freightwire", ignoring EMAIL_FROM's display name
  const chip = (n, l) => `<span style="display:inline-block;background:#f5f5f4;border-radius:6px;padding:4px 10px;margin:2px;font-size:13px;">${l}: <b>${n}</b></span>`;
  const health = alerts.length ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;color:#b91c1c;"><b>⚠️ Data changes to check:</b><ul style="margin:6px 0 0 18px;padding:0;">${alerts.map((a) => `<li>${a}</li>`).join("")}</ul></div>` : `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;color:#15803d;">✅ All counts steady vs. last night — nothing dropped.</div>`;
  const qaBlock = qa.length ? `<div style="margin-top:12px;"><b>Customers needing setup (${qa.length}):</b><div style="font-size:13px;color:#57534e;white-space:pre-wrap;margin-top:4px;">${qa.slice(0, 50).join("<br>")}${qa.length > 50 ? "<br>…and " + (qa.length - 50) + " more" : ""}</div></div>` : `<div style="margin-top:12px;color:#15803d;font-size:13px;">✅ Every customer has a login and rates set.</div>`;
  const driftBlock = drift.length ? `<div style="margin-top:12px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px;color:#92400e;"><b>⚠️ Accounts to check — factory demo rules / missing logo (${drift.length}):</b><div style="font-size:13px;white-space:pre-wrap;margin-top:6px;">${drift.slice(0, 50).join("<br>")}${drift.length > 50 ? "<br>…and " + (drift.length - 50) + " more" : ""}</div><div style="font-size:12px;color:#a16207;margin-top:8px;">These carry the built-in demo Autopilot rules (or lost a logo) — usually a migration leftover. Clear the demo rules on any real customer so they can't reroute live shipments.</div></div>` : `<div style="margin-top:12px;color:#15803d;font-size:13px;">✅ No account is carrying factory demo rules; no logos went missing.</div>`;
  const html = `<body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1c1917;"><div style="max-width:560px;margin:0 auto;padding:24px 20px;">
    <div style="font-size:18px;font-weight:800;color:#0c4a6e;">Freightwire — nightly guardian</div>
    <div style="font-size:12px;color:#a8a29e;margin-bottom:12px;">${stamp} · tenant ${TENANT}</div>
    ${health}
    <div style="margin:12px 0;">${chip(counts.clients, "Customers")}${chip(counts.users, "Logins")}${chip(counts.profiles, "Rate profiles")}${chip(counts.rateCards, "Rate cards")}${chip(counts.invoices, "Invoices")}${chip(counts.shipments, "Shipments")}</div>
    ${qaBlock}
    ${driftBlock}
    <div style="margin-top:14px;font-size:13px;color:#57534e;">Full backup attached (JSON). Google Drive: <b>${driveNote}</b>. The last ~14 nightly backups are also kept inside the app.</div>
  </div></body>`;
  const attachment = { filename: "freightwire-backup-" + stamp + ".json", content: Buffer.from(backupStr).toString("base64") };
  try {
    await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key }, body: JSON.stringify({ from, to: recipients, subject: (alerts.length || drift.length ? "⚠️ " : "") + "Freightwire nightly backup & health — " + stamp, html, attachments: [attachment] }) });
  } catch (e) { console.log("[guardian] email error", e && e.message); }
}

export default async () => {
  try {
    if (process.env.GUARDIAN_DISABLED) return new Response("disabled", { status: 200 });
    const rows = await pgAll();
    if (!rows) { console.log("[guardian] no DB access"); return new Response("no-db", { status: 200 }); }
    const store = {};
    for (const r of rows) if (r && r.key && !String(r.key).startsWith("bak:")) store[r.key] = r.value;   // exclude existing backup rows from the snapshot

    const clients = Array.isArray(store.clients) ? store.clients : [];
    const users = Array.isArray(store.users) ? store.users : [];
    const rateRules = (store.rateRules && typeof store.rateRules === "object") ? store.rateRules : {};
    const invoices = Array.isArray(store.invoicesIssued) ? store.invoicesIssued : [];
    let shipments = 0; for (const k in store) if (/^u\/[^/]+\/shipments$/.test(k) && Array.isArray(store[k])) shipments += store[k].length;

    const counts = { clients: clients.length, users: users.length, profiles: sizeOf(rateRules), rateCards: (rateRules.baseCosts ? Object.keys(rateRules.baseCosts).length : 0), invoices: invoices.length, shipments };

    /* 1) integrity watchdog */
    const prev = (store["guardian:state"] && store["guardian:state"].counts) || {};
    const alerts = [];
    for (const k of Object.keys(counts)) {
      const was = prev[k] || 0, now = counts[k];
      if (was >= 3 && now < was * 0.7) alerts.push(`${k} dropped from ${was} to ${now} since last night`);
    }

    /* 2) customer setup QA */
    const loginByClient = {}; users.forEach((u) => { if (u && u.clientId) loginByClient[u.clientId] = (loginByClient[u.clientId] || 0) + 1; });
    const assign = rateRules.assign || {};
    const profById = {}; (rateRules.profiles || []).forEach((p) => { if (p) profById[p.id] = p; });
    const qa = [];
    clients.forEach((c) => {
      if (!c || !c.id) return;
      const issues = [];
      if (!loginByClient[c.id]) issues.push("no login");
      const pid = assign[c.id];
      const hasProfile = pid && pid !== "default" && profById[pid] && Object.keys((profById[pid].services) || {}).length;
      const hasMarkup = c.markup != null && c.markup !== "" && +c.markup !== 0;
      if (!hasProfile && !hasMarkup) issues.push("no rates/markup set");
      if (issues.length) qa.push("• " + (c.name || c.id) + ": " + issues.join(", "));
    });

    /* 2b) drift / factory-rule scan — a real customer login carrying the built-in demo rules
       (their names use the "→" arrow; hand-made rules never do) is a migration leftover that can
       reroute real shipments. Flag each one, with how many are ACTIVE. Also flag a login whose
       company logo went missing since we last recorded it having one. */
    const userById = {}; users.forEach((u) => { if (u && u.id) userById[u.id] = u; });
    const clientById = {}; clients.forEach((c) => { if (c && c.id) clientById[c.id] = c; });
    const drift = [];
    const logoSeen = (store["guardian:state"] && store["guardian:state"].logos) || {};
    const logoNow = {};
    for (const k in store) {
      const mr = /^u\/([^/]+)\/ruleset$/.exec(k);
      if (mr) {
        const u = userById[mr[1]];
        if (!u || (u.role || "customer") === "admin") continue;   // only real customer logins
        const demoRules = (Array.isArray(store[k]) ? store[k] : []).filter((r) => r && typeof r.name === "string" && r.name.indexOf("→") !== -1);
        if (demoRules.length) {
          const who = u.name || u.email || mr[1];
          const co = (u.clientId && clientById[u.clientId] && clientById[u.clientId].name) || "no customer";
          const active = demoRules.filter((r) => r.enabled).length;
          drift.push("• " + who + " (" + co + "): " + demoRules.length + " factory demo rule" + (demoRules.length > 1 ? "s" : "") + (active ? ", " + active + " ACTIVE" : " (all off)") + " — " + demoRules.map((r) => r.name).slice(0, 4).join("; "));
        }
      }
      const ms = /^u\/([^/]+)\/settings$/.exec(k);
      if (ms) {
        const u = userById[ms[1]];
        if (!u || (u.role || "customer") === "admin") continue;
        const hasLogo = !!(store[k] && typeof store[k] === "object" && store[k].companyLogo);
        if (hasLogo) logoNow[ms[1]] = 1;
        else if (logoSeen[ms[1]]) {
          const who = u.name || u.email || ms[1];
          const co = (u.clientId && clientById[u.clientId] && clientById[u.clientId].name) || "no customer";
          drift.push("• " + who + " (" + co + "): company logo is now MISSING (it had one before)");
        }
      }
    }

    /* 3) off-site backup */
    const stamp = new Date().toISOString().slice(0, 19).replace(/T/, "_").replace(/:/g, "-");
    const backup = { tenant: TENANT, at: new Date().toISOString(), counts, data: store };
    const backupStr = JSON.stringify(backup);
    await pgUpsert([{ tenant: TENANT, key: "bak:full:" + stamp, value: backup }, { tenant: TENANT, key: "guardian:state", value: { counts, logos: logoNow, at: new Date().toISOString() } }]);
    await pgPruneFullBackups();

    let driveNote = "not configured (set GOOGLE_SERVICE_ACCOUNT_JSON + GDRIVE_FOLDER_ID)";
    try { driveNote = await uploadToDrive("freightwire-backup-" + stamp + ".json", backupStr); } catch (e) { driveNote = "upload error: " + (e && e.message || e); }

    // ONE report email, to ONE fixed recipient, from PRODUCTION only.
    // Staging (non-"main" tenant) still writes its own backup above but never emails,
    // so a single nightly run can't fan out into a pile of duplicate messages.
    // Recipient is Spencer only — never the full admin list (that's what caused the flood).
    const solo = (process.env.GUARDIAN_EMAIL && process.env.GUARDIAN_EMAIL.trim()) || "spencer@freightwire.com";
    const recipients = TENANT === "main" && /.+@.+\..+/.test(solo) ? [solo] : [];
    await emailSummary({ recipients, counts, alerts, qa, drift, driveNote, backupStr, stamp });

    console.log("[guardian] ok — tenant", TENANT, "counts", JSON.stringify(counts), "alerts", alerts.length, "qa", qa.length, "drift", drift.length, "drive", driveNote, "emailed", recipients.length);
    return new Response("ok", { status: 200 });
  } catch (e) { console.log("[guardian] error", e && e.message); return new Response("err", { status: 200 }); }
};
export const config = { schedule: "0 8 * * *" };   // 08:00 UTC daily = ~2am Mountain
