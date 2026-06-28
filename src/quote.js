/* ════════════════════════════════════════════════════════════════════════
   POST /.netlify/functions/quote
   ------------------------------------------------------------------------
   Live carrier rates for the ShippingCloud app (Ship tab + Quick quote).
   Proxies to the England Logistics (Rock Solid) eCommerce API so your real
   negotiated FedEx/UPS rates come back to the browser. Your API key never
   leaves the server when you store it as a Netlify env var.

   Credentials are read from (in order):
     1. the request body  { account: { apiKey, customerId, base } }   ← lets you
        test by typing them into Settings → Carrier accounts
     2. Netlify env vars  ENGLAND_API_KEY / ENGLAND_CUSTOMER_ID / ENGLAND_API_BASE
        ← recommended for production (key stays secret, server-side)

   Returns the app's native rate shape:
     { live:true, rates:[ { key, carrier, label, cost, minDays, maxDays } ] }
   On any problem it returns 200 with { live:false, error, rates:[] } so the
   app cleanly falls back to estimated rates instead of breaking.
   ════════════════════════════════════════════════════════════════════════ */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", ...CORS },
  body: JSON.stringify(body),
});

// England carrierCode → the display names the app already styles
const CARRIER_NAME = { FEDEX: "FedEx", FDX: "FedEx", FXSP: "FedEx", UPS: "UPS", USPS: "USPS", DHL: "DHL" };
function carrierName(code) {
  const c = String(code || "").toUpperCase();
  return CARRIER_NAME[c] || (c ? c.charAt(0) + c.slice(1).toLowerCase() : "FedEx");
}
function firstNum(...vals) {
  for (const v of vals) { const n = Number(v); if (!isNaN(n) && n > 0) return n; }
  return undefined;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { live: false, error: "Use POST", rates: [] });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(200, { live: false, error: "Bad JSON body", rates: [] }); }

  const acct = body.account || {};
  const base = (acct.base || process.env.ENGLAND_API_BASE || "https://englandship.rocksolidinternet.com").replace(/\/+$/, "");
  const apiKey = acct.apiKey || process.env.ENGLAND_API_KEY || "";
  const customerId = acct.customerId || process.env.ENGLAND_CUSTOMER_ID || "";

  if (!apiKey || !customerId) {
    return json(200, { live: false, error: "Missing England API key or customer ID.", rates: [] });
  }

  const pieces = Array.isArray(body.pieces) && body.pieces.length
    ? body.pieces
    : [{ weight: body.weight || 1, length: body.L || 12, width: body.W || 9, height: body.H || 4 }];

  const payload = {
    sender:   { country: body.fromCountry || "US", zip: String(body.fromZip || "").trim() },
    receiver: { country: body.toCountry   || "US", zip: String(body.toZip   || "").trim() },
    residential: !!body.residential,
    pieces: pieces.map(p => ({
      weight: +p.weight || +p.wt || 1,
      length: +p.length || +p.L || 1,
      width:  +p.width  || +p.W || 1,
      height: +p.height || +p.H || 1,
    })),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), parseInt(process.env.RATE_FETCH_TIMEOUT_MS || "9000", 10));
  try {
    const r = await fetch(`${base}/restapi/v1/customers/${encodeURIComponent(customerId)}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }

    if (!r.ok) {
      const msg = (data && (data.message || data.error)) || `England API returned ${r.status}`;
      return json(200, { live: false, error: msg, rates: [] });
    }

    const quotes = (data && (data.quotes || data.rates || data.Quotes)) || [];
    if (!Array.isArray(quotes) || quotes.length === 0) {
      return json(200, { live: false, error: "No rates returned for this shipment.", rates: [], raw: data });
    }

    const rates = quotes.map((q, i) => {
      const amount = firstNum(q.totalAmount, q.total, q.amount, q.rate, q.price) || 0;
      const desc = q.serviceDescription || q.serviceName || q.service || q.serviceCode || "Service";
      const code = (q.serviceCode || desc).toString().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      const days = firstNum(q.transitDays, q.deliveryDays, q.estimatedDeliveryDays, q.commitDays, q.businessDaysInTransit);
      return {
        key: code || `svc_${i}`,
        carrier: carrierName(q.carrierCode || q.carrier),
        label: desc,
        cost: Math.round(amount * 100) / 100,
        minDays: days, maxDays: days,
      };
    }).filter(x => x.cost > 0).sort((a, b) => a.cost - b.cost);

    if (!rates.length) return json(200, { live: false, error: "Rates came back empty/zero.", rates: [], raw: data });
    return json(200, { live: true, rates });
  } catch (e) {
    const msg = e.name === "AbortError" ? "England API timed out." : (e.message || "England request failed.");
    return json(200, { live: false, error: msg, rates: [] });
  } finally {
    clearTimeout(timer);
  }
};
