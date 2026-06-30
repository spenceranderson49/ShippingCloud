/* ════════════════════════════════════════════════════════════════════════
   eBay  ⇄  ShippingCloud
   OAuth2. Create an app at developer.ebay.com, create a redirect "RuName", set
   its accepted URL to: https://shippingcloud.net/.netlify/functions/ebay
   Env vars: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME (the RuName, not a URL),
             EBAY_ENV ("production"|"sandbox"), APP_URL (optional)

   GET  (no code)   → redirect to eBay consent
   GET  ?code=…     → exchange, redirect to app with tokens
   POST { action, accessToken, refreshToken, ... }:
     action:"sync"                                  → { ok, orders }
     action:"fulfill" { orderId, lineItemIds[], tracking, carrier }
     action:"refresh"                               → fresh accessToken
   ════════════════════════════════════════════════════════════════════════ */
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const html = (m) => ({ statusCode: 200, headers: { "Content-Type": "text/html" }, body: `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;max-width:560px;margin:auto"><h2>ShippingCloud · eBay</h2><p>${m}</p></body>` });
const isSandbox = () => (process.env.EBAY_ENV || "production") === "sandbox";
const API = () => (isSandbox() ? "https://api.sandbox.ebay.com" : "https://api.ebay.com");
const AUTHH = () => (isSandbox() ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com");
const SCOPE = "https://api.ebay.com/oauth/api_scope/sell.fulfillment";
const basic = () => "Basic " + Buffer.from(process.env.EBAY_CLIENT_ID + ":" + process.env.EBAY_CLIENT_SECRET).toString("base64");

async function tokenReq(params) {
  const r = await fetch(API() + "/identity/v1/oauth2/token", { method: "POST", headers: { "Authorization": basic(), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
  return r.json();
}

function transform(o) {
  const ship = (o.fulfillmentStartInstructions && o.fulfillmentStartInstructions[0] && o.fulfillmentStartInstructions[0].shippingStep && o.fulfillmentStartInstructions[0].shippingStep.shipTo) || {};
  const addr = ship.contactAddress || {};
  return {
    id: "ebay-" + o.orderId, ebayId: o.orderId, name: S(o.legacyOrderId || o.orderId),
    customer: S(ship.fullName), company: "",
    address1: S(addr.addressLine1), address2: S(addr.addressLine2),
    city: S(addr.city), state: S(addr.stateOrProvince), zip: S(addr.postalCode), country: S(addr.countryCode || "US"),
    phone: S(ship.primaryPhone && ship.primaryPhone.phoneNumber), email: S(o.buyer && o.buyer.username),
    total: o.pricingSummary && o.pricingSummary.total ? S(o.pricingSummary.total.value) : "",
    weight: 1, items: (o.lineItems || []).map((li) => `${li.quantity}× ${li.title}`).join(", "),
    source: "eBay", shippingService: "Standard", status: "unfulfilled", date: S(o.creationDate).slice(0, 10),
    lineItemIds: (o.lineItems || []).map((li) => li.lineItemId),
  };
}

exports.handler = async (event) => {
  const appUrl = (process.env.APP_URL || "https://shippingcloud.net").replace(/\/+$/, "");

  // ── OAuth (GET) ──
  if (event.httpMethod === "GET") {
    if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET || !process.env.EBAY_RUNAME) return html("Set <b>EBAY_CLIENT_ID</b>, <b>EBAY_CLIENT_SECRET</b> and <b>EBAY_RUNAME</b> in Netlify.");
    const q = event.queryStringParameters || {};
    if (!q.code) {
      const url = `${AUTHH()}/oauth2/authorize?client_id=${encodeURIComponent(process.env.EBAY_CLIENT_ID)}&response_type=code&redirect_uri=${encodeURIComponent(process.env.EBAY_RUNAME)}&scope=${encodeURIComponent(SCOPE)}`;
      return { statusCode: 302, headers: { Location: url }, body: "" };
    }
    const tok = await tokenReq({ grant_type: "authorization_code", code: q.code, redirect_uri: process.env.EBAY_RUNAME });
    if (!tok.access_token) return html("Token exchange failed: " + JSON.stringify(tok).slice(0, 200));
    const back = `${appUrl}/?ebay_connected=1#access=${encodeURIComponent(tok.access_token)}&refresh=${encodeURIComponent(tok.refresh_token || "")}`;
    return { statusCode: 302, headers: { Location: back }, body: "" };
  }

  // ── API (POST) ──
  try {
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); }

    if (b.action === "refresh") {
      const tok = await tokenReq({ grant_type: "refresh_token", refresh_token: S(b.refreshToken), scope: SCOPE });
      if (!tok.access_token) return J({ ok: false, error: "Refresh failed: " + JSON.stringify(tok).slice(0, 160) });
      return J({ ok: true, accessToken: tok.access_token });
    }

    const token = S(b.accessToken);
    if (!token) return J({ ok: false, error: "Missing accessToken (reconnect eBay)." });
    const headers = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };

    if (b.action === "fulfill") {
      const payload = { lineItems: (b.lineItemIds || []).map((id) => ({ lineItemId: id, quantity: 1 })), shippedDate: new Date().toISOString(), shippingCarrierCode: S(b.carrier) || "FedEx", trackingNumber: S(b.tracking) };
      const r = await fetch(API() + `/sell/fulfillment/v1/order/${encodeURIComponent(b.orderId)}/shipping_fulfillment`, { method: "POST", headers, body: JSON.stringify(payload) });
      const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
      if (!r.ok) return J({ ok: false, error: "Fulfillment HTTP " + r.status + (t ? ": " + t.slice(0, 250) : "") });
      return J({ ok: true, fulfillmentId: (d && d.fulfillmentId) || "created" });
    }

    // default: sync unshipped orders
    const r = await fetch(API() + `/sell/fulfillment/v1/order?filter=${encodeURIComponent("orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}")}&limit=50`, { headers });
    const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
    if (r.status === 401) return J({ ok: false, error: "eBay rejected the token (401) — reconnect." });
    if (!r.ok) return J({ ok: false, error: "eBay HTTP " + r.status + (t ? ": " + t.slice(0, 200) : "") });
    const orders = ((d && d.orders) || []).map(transform);
    return J({ ok: true, count: orders.length, orders });
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
