/* ════════════════════════════════════════════════════════════════════════
   QuickBooks Online  ⇄  ShippingCloud   (accounting / invoicing)
   OAuth2. Create an app at developer.intuit.com → get client id/secret, set the
   redirect URI to:  https://shippingcloud.net/.netlify/functions/quickbooks
   Env vars: QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_ENV ("production"|"sandbox"),
             APP_URL (optional, default https://shippingcloud.net)

   GET  (no code)            → redirect merchant to Intuit consent
   GET  ?code=…&realmId=…    → exchange code, redirect to app with tokens+realmId
   POST { action, realmId, accessToken, refreshToken, ... }:
     action:"createInvoice" { customerName, amount, description, email? }
     action:"refresh"       → { accessToken, refreshToken } (tokens rotate hourly)
   ════════════════════════════════════════════════════════════════════════ */
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const html = (m) => ({ statusCode: 200, headers: { "Content-Type": "text/html" }, body: `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;max-width:560px;margin:auto"><h2>ShippingCloud · QuickBooks</h2><p>${m}</p></body>` });
const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const apiBase = (env) => (env === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com");

function basicAuth() { return "Basic " + Buffer.from(process.env.QBO_CLIENT_ID + ":" + process.env.QBO_CLIENT_SECRET).toString("base64"); }

async function exchange(params) {
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Authorization": basicAuth(), "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" }, body: new URLSearchParams(params).toString() });
  return r.json();
}

async function qboPOST(env, realmId, accessToken, entity, payload) {
  const url = apiBase(env) + `/v3/company/${realmId}/${entity}?minorversion=70`;
  const r = await fetch(url, { method: "POST", headers: { "Authorization": "Bearer " + accessToken, "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify(payload) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
  return { r, d, t };
}
async function qboQuery(env, realmId, accessToken, q) {
  const url = apiBase(env) + `/v3/company/${realmId}/query?minorversion=70&query=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { "Authorization": "Bearer " + accessToken, "Accept": "application/json" } });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
  return { r, d, t };
}

async function findOrCreateCustomer(env, realmId, token, name, email) {
  const safe = name.replace(/'/g, "");
  const q = await qboQuery(env, realmId, token, `select * from Customer where DisplayName = '${safe}'`);
  const found = q.d && q.d.QueryResponse && q.d.QueryResponse.Customer && q.d.QueryResponse.Customer[0];
  if (found) return found.Id;
  const c = await qboPOST(env, realmId, token, "customer", { DisplayName: name, PrimaryEmailAddr: email ? { Address: email } : undefined });
  return c.d && c.d.Customer && c.d.Customer.Id;
}

exports.handler = async (event) => {
  const env = process.env.QBO_ENV || "production";
  const appUrl = (process.env.APP_URL || "https://shippingcloud.net").replace(/\/+$/, "");
  const self = "https://" + event.headers.host + "/.netlify/functions/quickbooks";

  // ── OAuth (GET) ──
  if (event.httpMethod === "GET") {
    if (!process.env.QBO_CLIENT_ID || !process.env.QBO_CLIENT_SECRET) return html("Set <b>QBO_CLIENT_ID</b> and <b>QBO_CLIENT_SECRET</b> in Netlify.");
    const q = event.queryStringParameters || {};
    if (!q.code) {
      const url = `${AUTH_URL}?client_id=${encodeURIComponent(process.env.QBO_CLIENT_ID)}&response_type=code&scope=${encodeURIComponent("com.intuit.quickbooks.accounting")}&redirect_uri=${encodeURIComponent(self)}&state=scqbo`;
      return { statusCode: 302, headers: { Location: url }, body: "" };
    }
    const tok = await exchange({ grant_type: "authorization_code", code: q.code, redirect_uri: self });
    if (!tok.access_token) return html("Token exchange failed: " + JSON.stringify(tok).slice(0, 200));
    const back = `${appUrl}/?qbo_connected=1#realmId=${encodeURIComponent(q.realmId || "")}&access=${encodeURIComponent(tok.access_token)}&refresh=${encodeURIComponent(tok.refresh_token)}`;
    return { statusCode: 302, headers: { Location: back }, body: "" };
  }

  // ── API (POST) ──
  try {
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); }

    if (b.action === "refresh") {
      const tok = await exchange({ grant_type: "refresh_token", refresh_token: S(b.refreshToken) });
      if (!tok.access_token) return J({ ok: false, error: "Refresh failed: " + JSON.stringify(tok).slice(0, 160) });
      return J({ ok: true, accessToken: tok.access_token, refreshToken: tok.refresh_token });
    }

    const realmId = S(b.realmId), token = S(b.accessToken);
    if (!realmId || !token) return J({ ok: false, error: "Missing realmId/accessToken (reconnect QuickBooks)." });

    if (b.action === "createInvoice") {
      const custId = await findOrCreateCustomer(env, realmId, token, S(b.customerName) || "ShippingCloud Customer", S(b.email));
      if (!custId) return J({ ok: false, error: "Could not resolve a QuickBooks customer." });
      const payload = {
        CustomerRef: { value: custId },
        Line: [{ Amount: Number(b.amount) || 0, DetailType: "SalesItemLineDetail", Description: S(b.description) || "Shipping", SalesItemLineDetail: { Qty: 1, UnitPrice: Number(b.amount) || 0 } }],
      };
      const inv = await qboPOST(env, realmId, token, "invoice", payload);
      if (!inv.r.ok) return J({ ok: false, error: "Invoice HTTP " + inv.r.status + (inv.t ? ": " + inv.t.slice(0, 200) : "") });
      return J({ ok: true, invoiceId: inv.d && inv.d.Invoice && inv.d.Invoice.Id, docNumber: inv.d && inv.d.Invoice && inv.d.Invoice.DocNumber });
    }

    return J({ ok: false, error: "Unknown action" });
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
