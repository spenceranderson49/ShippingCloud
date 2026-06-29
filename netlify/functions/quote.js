/* ════════════════════════════════════════════════════════════════════════
   POST /.netlify/functions/quote   —   live England (FedEx/UPS) rates
   ------------------------------------------------------------------------
   Matches the Rock Solid / eCommerce Webship API exactly:
     • Auth header:  Authorization: RSIS <apiKey>
     • POST /restapi/v1/customers/:customerId/quote
     • body uses weightUnit/dimUnit/currency, string weights & dims, billing
   Requests FedEx + UPS and merges. Always returns HTTP 200 with JSON so the
   app can show the real error if something is off.
   ════════════════════════════════════════════════════════════════════════ */

const J = (obj) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
const CARRIER_NAME = { FEDEX: "FedEx", UPS: "UPS", USPS: "USPS", DHL: "DHL", DHL_ECOMMERCE: "DHL" };
const carrierName = (c) => { const k = String(c || "").toUpperCase(); return CARRIER_NAME[k] || (k ? k[0] + k.slice(1).toLowerCase() : "FedEx"); };
const num = (...v) => { for (const x of v) { const n = Number(x); if (!isNaN(n) && n > 0) return n; } return undefined; };
const S = (n) => String(n);

function mapQuotes(data) {
  const quotes = (data && (data.quotes || data.rates)) || [];
  if (!Array.isArray(quotes)) return [];
  return quotes.map((q, i) => {
    const amount = num(q.totalAmount, q.total, q.amount, q.baseAmount) || 0;
    const desc = q.serviceDescription || q.serviceName || q.serviceCode || "Service";
    const code = (q.serviceCode || desc).toString().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const days = num(q.transitDays, q.deliveryDays, q.businessDaysInTransit, q.estimatedDeliveryDays);
    return {
      key: code || ("svc_" + i),
      carrier: carrierName(q.carrierCode || q.carrier),
      label: desc,
      cost: Math.round(amount * 100) / 100,
      minDays: days, maxDays: days,
      zone: q.zone,
    };
  }).filter((x) => x.cost > 0);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, body: "" };
    if (event.httpMethod !== "POST") return J({ live: false, error: "Use POST", rates: [] });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { return J({ live: false, error: "Bad JSON body", rates: [] }); }

    const acct = body.account || {};
    const base = (acct.base || process.env.ENGLAND_API_BASE || "https://englandship.rocksolidinternet.com").replace(/\/+$/, "");
    const apiKey = (acct.apiKey || process.env.ENGLAND_API_KEY || "").trim();
    const customerId = (acct.customerId || process.env.ENGLAND_CUSTOMER_ID || "").trim();
    if (!apiKey || !customerId) return J({ live: false, error: "Missing England API key or customer ID.", rates: [] });

    const pieces = (Array.isArray(body.pieces) && body.pieces.length ? body.pieces : [{ weight: body.weight || 1, L: body.L || 12, W: body.W || 9, H: body.H || 4 }])
      .map((p) => ({
        weight: S(+p.weight || +p.wt || 1),
        length: S(+p.length || +p.L || 1),
        width: S(+p.width || +p.W || 1),
        height: S(+p.height || +p.H || 1),
      }));

    const baseBody = {
      serviceCode: "",
      packageTypeCode: "",
      sender: { country: body.fromCountry || "US", zip: String(body.fromZip || "").trim() },
      receiver: { country: body.toCountry || "US", zip: String(body.toZip || "").trim() },
      residential: !!body.residential,
      weightUnit: "lb",
      dimUnit: "in",
      currency: "USD",
      pieces,
      billing: { party: "sender" },
    };
    const url = base + "/restapi/v1/customers/" + encodeURIComponent(customerId) + "/quote";
    const headers = { "Content-Type": "application/json", "Authorization": "RSIS " + apiKey };

    async function call(reqBody) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      try {
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(reqBody), signal: ctrl.signal });
        const text = await r.text();
        let data = null; try { data = JSON.parse(text); } catch {}
        return { ok: r.ok, status: r.status, data, text };
      } catch (e) {
        return { ok: false, status: 0, error: e.name === "AbortError" ? "timeout" : (e.message || "network error") };
      } finally { clearTimeout(timer); }
    }

    // Try once with no carrierCode (all carriers). If that errors or is empty,
    // fall back to requesting each carrier explicitly and merging.
    let all = [];
    let lastErr = null;
    const first = await call(baseBody);
    if (first.ok) all = mapQuotes(first.data);
    else lastErr = { status: first.status, detail: (first.data && (first.data.error || first.data.message)) || first.error || (first.text || "").slice(0, 400) };

    if (!all.length) {
      const carriers = (process.env.ENGLAND_CARRIERS || "fedex,ups").split(",").map((s) => s.trim()).filter(Boolean);
      for (const cc of carriers) {
        const res = await call(Object.assign({}, baseBody, { carrierCode: cc }));
        if (res.ok) { all = all.concat(mapQuotes(res.data)); }
        else if (!lastErr) lastErr = { status: res.status, detail: (res.data && (res.data.error || res.data.message)) || res.error || (res.text || "").slice(0, 400) };
      }
    }

    // de-dupe by carrier+service, keep cheapest, sort
    const seen = {};
    for (const r of all) { const k = r.carrier + "|" + r.key; if (!seen[k] || r.cost < seen[k].cost) seen[k] = r; }
    const rates = Object.values(seen).sort((a, b) => a.cost - b.cost);

    if (rates.length) return J({ live: true, rates });
    if (lastErr) return J({ live: false, error: "England returned HTTP " + lastErr.status, england_status: lastErr.status, england_response: lastErr.detail, rates: [] });
    return J({ live: false, error: "England returned no rates for this shipment.", rates: [] });
  } catch (e) {
    return J({ live: false, error: "Function error: " + (e && e.message ? e.message : String(e)), rates: [] });
  }
};
