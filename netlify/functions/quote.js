/* ════════════════════════════════════════════════════════════════════════
   POST /.netlify/functions/quote   —   live England (FedEx/UPS) rates
   ------------------------------------------------------------------------
   Rock Solid / eCommerce Webship API. Sends the FULL documented quote body
   (so no required field is missing), auth via "Authorization: RSIS <key>",
   requests FedEx + UPS, merges, and surfaces England's real error if any.
   Auto-retries the signatureOptionCode value so an enum mismatch can't fail.
   Always returns HTTP 200 with JSON.
   ════════════════════════════════════════════════════════════════════════ */

const J = (obj) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
const CARRIER_NAME = { FEDEX: "FedEx", UPS: "UPS", USPS: "USPS", DHL: "DHL" };
const carrierName = (c) => { const k = String(c || "").toUpperCase(); return CARRIER_NAME[k] || (k ? k[0] + k.slice(1).toLowerCase() : "FedEx"); };
const num = (...v) => { for (const x of v) { const n = Number(x); if (!isNaN(n) && n > 0) return n; } return undefined; };
const S = (n) => String(n);

/* ════════════════════════════════════════════════════════════════════════
   READ-THROUGH RATE CACHE  (Netlify Blobs, dependency-free & best-effort)
   ------------------------------------------------------------------------
   Every entry is a REAL England quote response keyed by the exact inputs
   that change the price. Repeat lanes serve in ms; a miss falls through to
   live England (identical to before) and stores the result. If Blobs is
   unavailable for any reason, everything degrades silently to live quoting —
   the cache can never break a quote.
   • Signature / Saturday / insurance are NOT in the key: England ignores them
     at quote time (they're applied client-side), so leaving them out is both
     correct and raises the hit rate.
   • To wipe the whole cache at once (e.g. after a FedEx GRI or a fuel change),
     bump CACHE_VERSION below ("v1" → "v2") and re-upload this one file.
   ════════════════════════════════════════════════════════════════════════ */
const CACHE_STORE = "rate-cache";
const CACHE_VERSION = "v1";                    // ← bump to invalidate ALL cached rates
// TTL backstop default 6h (the warmer re-quotes frequent lanes far more often than this).
// Tunable WITHOUT code changes: set Netlify env var RATE_CACHE_TTL_MINUTES (e.g. 120). 0 disables caching.
const CACHE_TTL_MS = (() => { const m = parseInt(process.env.RATE_CACHE_TTL_MINUTES, 10); return (isNaN(m) || m < 0 ? 360 : m) * 60 * 1000; })();

function blobsCtx() {
  try {
    const raw = process.env.NETLIFY_BLOBS_CONTEXT;
    if (!raw) return null;
    const ctx = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    if (!ctx || !ctx.token || !ctx.siteID || !(ctx.edgeURL || ctx.apiURL)) return null;
    return ctx;
  } catch { return null; }
}
function blobUrl(ctx, key) {
  const path = "/" + ctx.siteID + "/" + CACHE_STORE + "/" + encodeURIComponent(key);
  if (ctx.edgeURL) return new URL(path, ctx.edgeURL).toString();
  return new URL("/api/v1/blobs" + path, ctx.apiURL || "https://api.netlify.com").toString();
}
async function blobFetch(ctx, key, opts) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 2500);
  try { return await fetch(blobUrl(ctx, key), { ...opts, headers: { authorization: "Bearer " + ctx.token, ...(opts && opts.headers) }, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
// "Refresh rates" marker: any cache entry written BEFORE the marker is treated as gone.
const flushKeyFor = (customerId) => "flush_" + CACHE_VERSION + "_" + String(customerId || "");
async function cacheGet(key, flushKey) {
  const ctx = blobsCtx(); if (!ctx) return null;
  if (CACHE_TTL_MS === 0) return null;
  try {
    const [entryRes, markerRes] = await Promise.all([
      blobFetch(ctx, key),
      blobFetch(ctx, flushKey).catch(() => null),
    ]);
    if (!entryRes || !entryRes.ok) return null;              // 404 = miss
    const j = await entryRes.json();
    if (!j || !Array.isArray(j.rates) || !j.ts) return null;
    if (Date.now() - j.ts > CACHE_TTL_MS) return null;       // stale by age
    if (markerRes && markerRes.ok) {
      const m = await markerRes.json().catch(() => null);
      if (m && m.ts && j.ts <= m.ts) return null;            // written before last "Refresh rates" → gone
    }
    return j;
  } catch { return null; }
}
async function cachePut(key, rates) {
  const ctx = blobsCtx(); if (!ctx || CACHE_TTL_MS === 0) return;
  try { await blobFetch(ctx, key, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ts: Date.now(), rates }) }); }
  catch { /* best-effort: a failed write just means the next identical quote is a miss */ }
}
async function cacheFlush(customerId) {
  const ctx = blobsCtx();
  if (!ctx) return { ok: false, error: "Netlify Blobs isn't available on this site, so there's no cache to clear — all quotes are already pulling live from England." };
  try {
    const ts = Date.now();
    const r = await blobFetch(ctx, flushKeyFor(customerId), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ts }) });
    if (r && r.ok) return { ok: true, flushedAt: ts };
    return { ok: false, error: "Could not write the refresh marker (HTTP " + (r && r.status) + ")." };
  } catch (e) { return { ok: false, error: "Refresh failed: " + ((e && e.message) || String(e)) }; }
}

/* ── Lane tracking for the auto-warmer ──────────────────────────────────────
   Every real (non-warmer) quote records its lane: the exact re-quotable inputs,
   how often it's used, and when it was last used. warm-rates.mjs reads these to
   keep frequent lanes permanently fresh. NO SECRETS are stored — only the
   customer ID; the warmer authenticates with the Netlify env vars. */
function sanitizedLaneBody(body) {
  const pieces = (Array.isArray(body.pieces) && body.pieces.length ? body.pieces : [{ weight: body.weight || 1, L: body.L || 12, W: body.W || 9, H: body.H || 4 }])
    .map((p) => ({ weight: +p.weight || 1, length: +p.length || +p.L || 1, width: +p.width || +p.W || 1, height: +p.height || +p.H || 1 }));
  return {
    carriers: String(body.carriers || "fedex"),
    fromZip: String(body.fromZip || "").trim(), fromCountry: body.fromCountry || "US",
    toZip: String(body.toZip || "").trim(), toCountry: body.toCountry || "US",
    ...(body.toCity ? { toCity: body.toCity } : {}), ...(body.toState ? { toState: body.toState } : {}),
    residential: !!body.residential,
    packageTypeCode: String(body.packageTypeCode || ""),
    pieces,
    account: { customerId: (body.account && body.account.customerId) || process.env.ENGLAND_CUSTOMER_ID || "" },
  };
}
async function laneTouch(cacheKey, body) {
  const ctx = blobsCtx(); if (!ctx || CACHE_TTL_MS === 0) return;
  try {
    const laneKey = "lane_" + cacheKey;
    let count = 0;
    try { const r = await blobFetch(ctx, laneKey); if (r && r.ok) { const j = await r.json(); count = (j && j.count) || 0; } } catch {}
    await blobFetch(ctx, laneKey, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: sanitizedLaneBody(body), count: count + 1, lastUsed: Date.now() }) });
  } catch { /* best-effort */ }
}
function cacheKeyFor(body) {
  const crypto = require("crypto");
  const pcs = (Array.isArray(body.pieces) && body.pieces.length ? body.pieces : [{ weight: body.weight || 1, L: body.L || 12, W: body.W || 9, H: body.H || 4 }])
    .map((p) => [S(+p.weight || 1), S(+p.length || +p.L || 1), S(+p.width || +p.W || 1), S(+p.height || +p.H || 1)].join("x"))
    .join(",");
  const carriers = String(body.carriers || "fedex").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).sort().join("+");
  const parts = [
    CACHE_VERSION,
    (body.account && body.account.customerId) || process.env.ENGLAND_CUSTOMER_ID || "",
    carriers,
    (body.fromCountry || "US") + ":" + String(body.fromZip || "").trim(),
    (body.toCountry || "US") + ":" + String(body.toZip || "").trim(),
    body.residential ? "R" : "C",
    String(body.packageTypeCode || "").toLowerCase(),
    pcs,
  ].join("|");
  return "q_" + CACHE_VERSION + "_" + crypto.createHash("sha1").update(parts).digest("hex");
}

// Map the app's internal One Rate box codes to FedEx's canonical packaging type codes.
// FedEx One Rate pricing is only returned when a FedEx-branded packaging type is requested.
const PKG_MAP = { fedex_envelope:"FEDEX_ENVELOPE", fedex_pak:"FEDEX_PAK", fedex_extra_small_box:"FEDEX_SMALL_BOX", fedex_small_box:"FEDEX_SMALL_BOX", fedex_medium_box:"FEDEX_MEDIUM_BOX", fedex_large_box:"FEDEX_LARGE_BOX", fedex_extra_large_box:"FEDEX_EXTRA_LARGE_BOX", fedex_tube:"FEDEX_TUBE" };
const normPkg = (c) => { const k = String(c || "").toLowerCase(); return PKG_MAP[k] || (c || ""); };

function svcCodeFromName(name) {
  const n = String(name || "").toLowerCase().replace(/[®™]/g, "").replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const map = [
    ["home delivery", "fedex_home_delivery"], ["ground economy", "fedex_ground_economy"], ["ground", "fedex_ground"],
    ["express saver", "fedex_express_saver"], ["2day am", "fedex_2_day_am"], ["2 day am", "fedex_2_day_am"],
    ["2day", "fedex_2_day"], ["2 day", "fedex_2_day"], ["standard overnight", "fedex_standard_overnight"],
    ["priority overnight", "fedex_priority_overnight"], ["first overnight", "fedex_first_overnight"],
    ["international economy", "fedex_international_economy"], ["international priority", "fedex_international_priority"],
    ["international first", "fedex_international_first"],
  ];
  for (const [k, v] of map) if (n.includes(k)) return v;
  return "";
}
function mapQuotes(data, cc) {
  const quotes = (data && (data.quotes || data.rates)) || [];
  if (!Array.isArray(quotes)) return [];
  return quotes.map((q, i) => {
    const amount = num(q.totalAmount, q.total, q.amount, q.baseAmount) || 0;
    const desc = q.serviceDescription || q.serviceName || q.serviceCode || "Service";
    const code = (q.serviceCode || desc).toString().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const days = num(q.transitDays, q.deliveryDays, q.businessDaysInTransit);
    const surcharges = Array.isArray(q.surcharges) ? q.surcharges.map((s) => ({ label: s.description || s.name || "Surcharge", amount: num(s.amount) || 0 })) : [];
    const qwType = S(q.quotedWeightType || q.weightType || "").toLowerCase();
    const carrierCode = q.carrierCode || q.carrier || cc || "";
    const serviceCode = q.serviceCode || q.service || q.serviceType || q.svcCode || q.code || svcCodeFromName(desc);
    const pkgCode = q.packageTypeCode || q.packageType || (carrierCode ? String(carrierCode).toLowerCase() + "_custom_package" : "");
    return { key: code || ("svc_" + i), carrier: carrierName(carrierCode), carrierCode, serviceCode, packageTypeCode: pkgCode, label: desc, cost: Math.round(amount * 100) / 100, base: num(q.baseAmount) || null, surcharges, minDays: days, maxDays: days, zone: q.zone, quotedWeight: num(q.quotedWeight) || null, dimWeight: qwType.indexOf("dim") >= 0 };
  }).filter((x) => x.cost > 0);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, body: "" };
    if (event.httpMethod !== "POST") return J({ live: false, error: "Use POST", rates: [] });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { return J({ live: false, error: "Bad JSON body", rates: [] }); }

    // ── "Refresh rates" button: invalidate every cached quote for this England account ──
    if (body.action === "flushCache") {
      const custId = (body.account && body.account.customerId) || process.env.ENGLAND_CUSTOMER_ID || "";
      if (!custId) return J({ ok: false, error: "No England customer ID configured." });
      const res = await cacheFlush(custId);
      return J(res);
    }

    // ── read-through cache: serve a prior real England answer for identical inputs ──
    const custIdForCache = (body.account && body.account.customerId) || process.env.ENGLAND_CUSTOMER_ID || "";
    const cacheKey = cacheKeyFor(body);
    const isWarm = !!body._warm; // warmer traffic must not count as real usage
    if (!body.noCache) {
      const [hit] = await Promise.all([cacheGet(cacheKey, flushKeyFor(custIdForCache)), isWarm ? null : laneTouch(cacheKey, body)]);
      if (hit) return J({ live: true, cached: true, ts: hit.ts, rates: hit.rates });
    } else if (!isWarm) {
      await laneTouch(cacheKey, body);
    }

    const acct = body.account || {};
    const base = (acct.base || process.env.ENGLAND_API_BASE || "https://englandship.rocksolidinternet.com").replace(/\/+$/, "");
    const apiKey = (acct.apiKey || process.env.ENGLAND_API_KEY || "").trim();
    const customerId = (acct.customerId || process.env.ENGLAND_CUSTOMER_ID || "").trim();
    if (!apiKey || !customerId) return J({ live: false, error: "Missing England API key or customer ID.", rates: [] });

    const pieces = (Array.isArray(body.pieces) && body.pieces.length ? body.pieces : [{ weight: body.weight || 1, L: body.L || 12, W: body.W || 9, H: body.H || 4 }])
      .map((p) => ({
        weight: S(+p.weight || 1),
        length: S(+p.length || +p.L || 1),
        width: S(+p.width || +p.W || 1),
        height: S(+p.height || +p.H || 1),
        insuranceAmount: S(+p.insuranceAmount || 0),
        declaredValue: null,
      }));

    const receiver = { country: body.toCountry || "US", zip: String(body.toZip || "").trim() };
    if (body.toCity) receiver.city = body.toCity;
    if (body.toState) receiver.state = body.toState;

    // Full documented quote body. signatureOptionCode filled per-attempt.
    const mkBody = (cc, sig) => ({
      carrierCode: cc,
      serviceCode: "",
      packageTypeCode: normPkg(body.packageTypeCode),
      sender: { country: body.fromCountry || "US", zip: String(body.fromZip || "").trim() },
      receiver,
      residential: !!body.residential,
      signatureOptionCode: sig,
      saturdayDelivery: !!body.saturdayDelivery,
      contentDescription: "Merchandise",
      weightUnit: "lb",
      dimUnit: "in",
      currency: "USD",
      customsCurrency: "USD",
      pieces: (body.insuranceAmount ? pieces.map((p) => ({ ...p, insuranceAmount: String(body.insuranceAmount) })) : pieces),
      billing: { party: "sender" },
      providerAccountId: null,
    });

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
        return { ok: false, status: 0, text: e.name === "AbortError" ? "timeout" : (e.message || "network error") };
      } finally { clearTimeout(timer); }
    }

    // signature: use the app's chosen option; otherwise try "no signature" values
    const sigPick = body.signatureOption && body.signatureOption !== "none" ? String(body.signatureOption) : null;
    const sigCandidates = sigPick ? [sigPick, sigPick.toUpperCase(), "direct"] : ["none", "NONE", "no_signature_required", ""];
    async function quoteCarrier(cc) {
      let last = null;
      for (const sig of sigCandidates) {
        const res = await call(mkBody(cc, sig));
        if (res.ok) return { ok: true, data: res.data };
        const detail = (res.data && (res.data.error || res.data.message || res.data.errorMessage)) || (res.text || "").slice(0, 300);
        last = { status: res.status, detail };
        // only keep trying other signature values if THIS error is about signatureOptionCode
        if (!/signatureOption/i.test(detail || "")) break;
      }
      return { ok: false, err: last };
    }

    const carriers = (body.carriers || acct.carriers || process.env.ENGLAND_CARRIERS || "fedex,dhl").split(",").map((s) => s.trim()).filter(Boolean);
    let all = [];
    const tried = [];
    let firstErr = null;
    const raw = {};
    const results = await Promise.all(carriers.map(async (cc) => ({ cc, res: await quoteCarrier(cc) })));
    for (const { cc, res } of results) {
      if (res.ok) { raw[cc] = res.data; const r = mapQuotes(res.data, cc); all = all.concat(r); tried.push(cc + " → OK (" + r.length + ")"); }
      else { tried.push(cc + " → HTTP " + (res.err && res.err.status) + (res.err && res.err.detail ? (": " + res.err.detail) : "")); if (!firstErr) firstErr = res.err; }
    }

    const seen = {};
    for (const r of all) { const k = r.carrier + "|" + r.key; if (!seen[k] || r.cost < seen[k].cost) seen[k] = r; }
    const rates = Object.values(seen).sort((a, b) => a.cost - b.cost);

    if (rates.length) { await cachePut(cacheKey, rates); return J({ live: true, rates, raw, tried }); }
    if (firstErr) return J({ live: false, error: "England HTTP " + firstErr.status + (firstErr.detail ? (": " + firstErr.detail) : ""), england_status: firstErr.status, england_response: firstErr.detail, tried, rates: [] });
    return J({ live: false, error: "England returned no rates for this shipment.", tried, rates: [] });
  } catch (e) {
    return J({ live: false, error: "Function error: " + (e && e.message ? e.message : String(e)), rates: [] });
  }
};
