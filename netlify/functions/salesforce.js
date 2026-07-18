/* ════════════════════════════════════════════════════════════════════════
   Salesforce  ⇄  ShippingCloud   (CRM records / orders)
   OAuth2 web-server flow. Create a Connected App in Salesforce → enable OAuth,
   set callback URL to: https://shippingcloud.net/.netlify/functions/salesforce
   Env vars: SF_CLIENT_ID, SF_CLIENT_SECRET, SF_LOGIN_HOST (login.salesforce.com
             or test.salesforce.com for sandbox), APP_URL (optional)

   GET  (no code)      → redirect to Salesforce consent
   GET  ?code=…        → exchange, redirect to app with instanceUrl + tokens
   POST { action, instanceUrl, accessToken, refreshToken, ... }:
     action:"query"  { soql }                         → { ok, records }
     action:"create" { sobject, fields:{...} }         → { ok, id }
     action:"refresh"                                  → fresh accessToken
   ════════════════════════════════════════════════════════════════════════ */
const { safeExternalUrl } = require("./_ssrf.js");
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const html = (m) => ({ statusCode: 200, headers: { "Content-Type": "text/html" }, body: `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;max-width:560px;margin:auto"><h2>ShippingCloud · Salesforce</h2><p>${m}</p></body>` });
const API_V = "v60.0";

async function tokenReq(loginHost, params) {
  const r = await fetch(`https://${loginHost}/services/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
  return r.json();
}

exports.handler = async (event) => {
  const loginHost = process.env.SF_LOGIN_HOST || "login.salesforce.com";
  const appUrl = (process.env.APP_URL || "https://shippingcloud.net").replace(/\/+$/, "");
  const self = "https://" + event.headers.host + "/.netlify/functions/salesforce";

  // ── OAuth (GET) ──
  if (event.httpMethod === "GET") {
    if (!process.env.SF_CLIENT_ID || !process.env.SF_CLIENT_SECRET) return html("Set <b>SF_CLIENT_ID</b> and <b>SF_CLIENT_SECRET</b> in Netlify.");
    const q = event.queryStringParameters || {};
    if (!q.code) {
      const url = `https://${loginHost}/services/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(process.env.SF_CLIENT_ID)}&redirect_uri=${encodeURIComponent(self)}&scope=${encodeURIComponent("api refresh_token")}`;
      return { statusCode: 302, headers: { Location: url }, body: "" };
    }
    const tok = await tokenReq(loginHost, { grant_type: "authorization_code", code: q.code, client_id: process.env.SF_CLIENT_ID, client_secret: process.env.SF_CLIENT_SECRET, redirect_uri: self });
    if (!tok.access_token) return html("Token exchange failed: " + JSON.stringify(tok).slice(0, 200));
    const back = `${appUrl}/?sf_connected=1#instance=${encodeURIComponent(tok.instance_url)}&access=${encodeURIComponent(tok.access_token)}&refresh=${encodeURIComponent(tok.refresh_token || "")}`;
    return { statusCode: 302, headers: { Location: back }, body: "" };
  }

  // ── API (POST) ──
  try {
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); }

    if (b.action === "refresh") {
      const tok = await tokenReq(loginHost, { grant_type: "refresh_token", refresh_token: S(b.refreshToken), client_id: process.env.SF_CLIENT_ID, client_secret: process.env.SF_CLIENT_SECRET });
      if (!tok.access_token) return J({ ok: false, error: "Refresh failed: " + JSON.stringify(tok).slice(0, 160) });
      return J({ ok: true, accessToken: tok.access_token, instanceUrl: tok.instance_url });
    }

    const inst = S(b.instanceUrl).replace(/\/+$/, ""), token = S(b.accessToken);
    if (!inst || !token) return J({ ok: false, error: "Missing instanceUrl/accessToken (reconnect Salesforce)." });
    if (!safeExternalUrl(inst)) return J({ ok: false, error: "instanceUrl must be a public https:// Salesforce address." });
    const headers = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };

    if (b.action === "query") {
      const r = await fetch(`${inst}/services/data/${API_V}/query?q=${encodeURIComponent(S(b.soql))}`, { headers });
      const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
      if (!r.ok) return J({ ok: false, error: "Query HTTP " + r.status + (t ? ": " + t.slice(0, 200) : "") });
      return J({ ok: true, totalSize: d.totalSize, records: d.records });
    }

    if (b.action === "create") {
      const obj = S(b.sobject) || "Account";
      const r = await fetch(`${inst}/services/data/${API_V}/sobjects/${obj}`, { method: "POST", headers, body: JSON.stringify(b.fields || {}) });
      const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
      if (!r.ok) return J({ ok: false, error: "Create HTTP " + r.status + (t ? ": " + t.slice(0, 250) : "") });
      return J({ ok: true, id: d && d.id });
    }

    return J({ ok: false, error: "Unknown action" });
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
