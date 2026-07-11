/* ════════════════════════════════════════════════════════════════════════
   POST /.netlify/functions/fedex   —   live FedEx APIs (production)
   ------------------------------------------------------------------------
   action:"transit"  → Rate & Transit Times  (POST /rate/v1/rates/quotes)
                       returns per-service transit days + delivery date
   action:"address"  → Address Validation    (POST /address/v1/addresses/resolve)
                       returns RESIDENTIAL / BUSINESS classification
   OAuth: POST /oauth/token (client_credentials). Creds from env:
     FEDEX_API_KEY, FEDEX_SECRET_KEY, FEDEX_ACCOUNT  (body can override).
   Always returns HTTP 200 + JSON.
   ════════════════════════════════════════════════════════════════════════ */

const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));

function CC(c){if(!c)return "US";const t=String(c).trim();if(t.length===2)return t.toUpperCase();const m={"united states":"US","united states of america":"US","usa":"US","u.s.":"US","u.s.a.":"US","canada":"CA","mexico":"MX","united kingdom":"GB","great britain":"GB","uk":"GB","england":"GB","puerto rico":"PR","australia":"AU","germany":"DE","france":"FR","italy":"IT","spain":"ES","netherlands":"NL","belgium":"BE","switzerland":"CH","austria":"AT","sweden":"SE","norway":"NO","denmark":"DK","finland":"FI","ireland":"IE","portugal":"PT","poland":"PL","czech republic":"CZ","czechia":"CZ","greece":"GR","hungary":"HU","romania":"RO","bulgaria":"BG","croatia":"HR","slovakia":"SK","slovenia":"SI","estonia":"EE","latvia":"LV","lithuania":"LT","luxembourg":"LU","iceland":"IS","japan":"JP","china":"CN","hong kong":"HK","taiwan":"TW","south korea":"KR","republic of korea":"KR","singapore":"SG","malaysia":"MY","thailand":"TH","vietnam":"VN","philippines":"PH","indonesia":"ID","india":"IN","israel":"IL","saudi arabia":"SA","united arab emirates":"AE","uae":"AE","qatar":"QA","kuwait":"KW","bahrain":"BH","oman":"OM","jordan":"JO","turkey":"TR","egypt":"EG","south africa":"ZA","nigeria":"NG","kenya":"KE","morocco":"MA","brazil":"BR","argentina":"AR","chile":"CL","colombia":"CO","peru":"PE","ecuador":"EC","uruguay":"UY","paraguay":"PY","bolivia":"BO","costa rica":"CR","panama":"PA","guatemala":"GT","honduras":"HN","el salvador":"SV","nicaragua":"NI","dominican republic":"DO","jamaica":"JM","bahamas":"BS","barbados":"BB","trinidad and tobago":"TT","new zealand":"NZ","ukraine":"UA"};return m[t.toLowerCase()]||"US";}
const DAYS = { ZERO_DAYS:0, ONE_DAY:1, TWO_DAYS:2, THREE_DAYS:3, FOUR_DAYS:4, FIVE_DAYS:5, SIX_DAYS:6, SEVEN_DAYS:7, EIGHT_DAYS:8, NINE_DAYS:9, TEN_DAYS:10, ELEVEN_DAYS:11, TWELVE_DAYS:12 };

let _tok = null; // { token, exp }  in-memory cache across warm invocations

function creds(body) {
  const a = body.account || {};
  return {
    base: (a.base || process.env.FEDEX_API_BASE || "https://apis.fedex.com").replace(/\/+$/, ""),
    key: S(a.apiKey || process.env.FEDEX_API_KEY).trim(),
    secret: S(a.secret || process.env.FEDEX_SECRET_KEY).trim(),
    account: S(a.account || process.env.FEDEX_ACCOUNT).trim(),
  };
}

async function token(c) {
  if (_tok && _tok.exp > Date.now() + 30000) return _tok.token;
  const r = await fetch(c.base + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&client_id=" + encodeURIComponent(c.key) + "&client_secret=" + encodeURIComponent(c.secret),
  });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  if (!r.ok || !d || !d.access_token) throw new Error("FedEx auth HTTP " + r.status + (d && d.errors ? ": " + JSON.stringify(d.errors) : (text ? ": " + text.slice(0, 200) : "")));
  _tok = { token: d.access_token, exp: Date.now() + (Number(d.expires_in || 3500) * 1000) };
  return _tok.token;
}

function fmtDate(s) { if (!s) return null; const d = new Date(s.length <= 10 ? s + "T00:00:00" : s); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
function bizDaysBetween(fromISO, toISO) {
  if (!fromISO || !toISO) return null;
  const a = new Date(fromISO + "T00:00:00"), b = new Date(toISO + "T00:00:00");
  if (isNaN(a) || isNaN(b) || b < a) return null;
  let d = 0; const cur = new Date(a);
  while (cur < b) { cur.setDate(cur.getDate() + 1); const dow = cur.getDay(); if (dow !== 0 && dow !== 6) d++; }
  return d;
}

async function transit(c, body, tk) {
  const today = new Date().toISOString().slice(0, 10);
  /* Countries arrive as full names from the app ("Canada") — FedEx wants ISO-2. The old code
     passed them RAW, so every international transit request errored and intl lanes showed no
     transit times. Also: international transit quotes need the same minimal customs block the
     rate call needs, or FedEx returns nothing. */
  const fromISO = CC(body.fromCountry || "US");
  const toISO = CC(body.toCountry || "US");
  const intl = fromISO !== toISO;
  const payload = {
    accountNumber: { value: c.account },
    // FedEx returns transit/commit data ONLY when asked here (per FedEx Rates & Transit Times API spec)
    rateRequestControlParameters: { returnTransitTimes: true },
    requestedShipment: {
      shipper: { address: { postalCode: S(body.fromZip), countryCode: fromISO, stateOrProvinceCode: S(body.fromState) || undefined } },
      recipient: { address: { postalCode: S(body.toZip), countryCode: toISO, residential: intl ? undefined : !!body.residential } },
      pickupType: "USE_SCHEDULED_PICKUP",
      shipDateStamp: body.shipDate || today,
      rateRequestType: ["LIST", "ACCOUNT"],
      requestedPackageLineItems: (Array.isArray(body.pieces) && body.pieces.length ? body.pieces : [{ weight: body.weight || 1 }]).map((p) => ({ weight: { units: "LB", value: Number(p.weight || p.wt || 1) } })),
    },
  };
  if (intl) {
    const totalWt = (Array.isArray(body.pieces) && body.pieces.length ? body.pieces : [{ weight: body.weight || 1 }]).reduce((a, p) => a + Number(p.weight || p.wt || 1), 0);
    const declared = Math.max(1, +body.declaredValue || +body.insuranceAmount || 100);
    payload.requestedShipment.customsClearanceDetail = {
      dutiesPayment: { paymentType: "SENDER" },
      commodities: [{ description: "Merchandise", countryOfManufacture: fromISO, quantity: 1, quantityUnits: "PCS", weight: { units: "LB", value: Math.max(0.1, totalWt) }, unitPrice: { amount: declared, currency: "USD" }, customsValue: { amount: declared, currency: "USD" } }]
    };
  }
  const r = await fetch(c.base + "/rate/v1/rates/quotes", {
    method: "POST",
    headers: { "Authorization": "Bearer " + tk, "Content-Type": "application/json", "X-locale": "en_US" },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  if (!r.ok) return { ok: false, error: "FedEx rate HTTP " + r.status + (d && d.errors ? ": " + (d.errors[0] && d.errors[0].message || JSON.stringify(d.errors)) : (text ? ": " + text.slice(0, 250) : "")) };
  const details = (d && d.output && d.output.rateReplyDetails) || [];
  try { console.log("FEDEX transit count=" + details.length + " sample=" + JSON.stringify((details[0] && { svc: details[0].serviceType, commit: details[0].commit, op: details[0].operationalDetail }) || {}).slice(0, 700)); } catch (e) {}
  const services = details.map((s) => {
    const op = s.operationalDetail || {};
    const commit = s.commit || {};
    const dd = commit.dateDetail || {};
    const td = commit.transitDays || {};
    // FedEx puts the transit enum at commit.transitTime (sometimes operationalDetail.transitTime)
    const transitEnum = commit.transitTime || op.transitTime || td.description || td.minimumTransitTime || null;
    // and the delivery date at commit.dateDetail.dayCxsFormat (sometimes .date / operationalDetail.deliveryDate)
    const deliveryDate = fmtDate(dd.dayCxsFormat || dd.date || op.deliveryDate || op.commitDate || commit.commitTimestamp);
    // Ground gives a day-count enum; express services (2Day/Overnight/Saver) usually give only a delivery DATE,
    // so fall back to computing business days from ship date → delivery date so ALL services get a transit count.
    let days = transitEnum && DAYS[transitEnum] != null ? DAYS[transitEnum] : null;
    if (days == null && deliveryDate) days = bizDaysBetween(body.shipDate || today, deliveryDate);
    return { serviceType: s.serviceType, serviceName: s.serviceName || s.serviceType, transitDays: days, transitLabel: transitEnum ? String(transitEnum).replace(/_/g, " ").toLowerCase() : null, deliveryDate, deliveryDay: dd.dayOfWeek || op.deliveryDay || null };
  }).filter((x) => x.serviceType);
  return { ok: true, _fn: "addr-v22", services, _sample: details[0] || null };
}

/* ════════════════════════════════════════════════════════════════
   ADDRESS:  deliverability  +  residential/commercial   (clean rebuild)
   - Deliverability  ← Address Validation API (DPV / Resolved flags)
   - Residential/Commercial ← Rate API (GROUND_HOME_DELIVERY vs FEDEX_GROUND)
     (the ONLY place FedEx reliably exposes res/commercial)
   ════════════════════════════════════════════════════════════════ */

// Rate the address (no residential flag) and read which Ground product FedEx offers.
async function rateClassify(c, a, fromZip, tk) {
  if (!fromZip || !c.account) return { classification: "UNKNOWN", services: [], error: "missing origin ZIP or FedEx account" };
  const today = new Date().toISOString().slice(0, 10);
  const probe = async (recipient) => {
    const payload = {
      accountNumber: { value: c.account },
      requestedShipment: {
        shipper: { address: { postalCode: S(fromZip), countryCode: "US" } },
        recipient: { address: recipient },
        pickupType: "USE_SCHEDULED_PICKUP",
        rateRequestType: ["ACCOUNT"],
        shipDateStamp: today,
        requestedPackageLineItems: [{ weight: { units: "LB", value: 1 } }],
      },
    };
    let r, t, d = null;
    try {
      r = await fetch(c.base + "/rate/v1/rates/quotes", { method: "POST", headers: { "Authorization": "Bearer " + tk, "Content-Type": "application/json", "X-locale": "en_US" }, body: JSON.stringify(payload) });
      t = await r.text(); try { d = JSON.parse(t); } catch {}
    } catch (e) { return { error: "rate fetch failed: " + (e && e.message), services: [] }; }
    if (!r.ok) return { error: "rate HTTP " + r.status + (d && d.errors && d.errors[0] ? ": " + d.errors[0].message : ""), services: [] };
    const det = (d && d.output && d.output.rateReplyDetails) || [];
    const services = det.map((x) => x.serviceType);
    let groundType = null, residentialSurcharge = false, surcharges = [];
    for (const s of det) {
      const st = String(s.serviceType || "");
      if (st === "GROUND_HOME_DELIVERY" || st === "FEDEX_GROUND") {
        groundType = st;
        const rsd = (s.ratedShipmentDetails && s.ratedShipmentDetails[0]) || {};
        const surs = (rsd.shipmentRateDetail && (rsd.shipmentRateDetail.surCharges || rsd.shipmentRateDetail.surcharges)) || [];
        surs.forEach((su) => surcharges.push(String(su.type || su.description || "")));
        if (surs.some((su) => /residential/i.test(String(su.type || su.description || "")))) residentialSurcharge = true;
      }
    }
    return { groundType, residentialSurcharge, services, surcharges };
  };
  // single full-address probe (kept to one rate call so the function stays well under Netlify's 10s limit)
  const p = await probe({ streetLines: [a.address1].filter(Boolean).map(S), city: S(a.city), stateOrProvinceCode: S(a.state), postalCode: S(a.zip), countryCode: CC(a.country) });
  // Residential surcharge is the most reliable signal; commercial ground product = business.
  let classification = "UNKNOWN";
  if (p.residentialSurcharge) classification = "RESIDENTIAL";
  else if (p.groundType === "FEDEX_GROUND") classification = "BUSINESS";
  else if (p.groundType === "GROUND_HOME_DELIVERY") classification = "RESIDENTIAL";
  try { console.log("FEDEX rateClassify=" + classification + " ground=" + p.groundType + " resiSur=" + p.residentialSurcharge + " services=" + (p.services || []).join(",")); } catch (e) {}
  return { classification, services: p.services || [], groundType: p.groundType || null, residentialSurcharge: !!p.residentialSurcharge, surcharges: p.surcharges || [], error: p.error || null };
}

// Address Validation API → deliverability + normalized address.
async function validateDeliverability(c, a, tk) {
  const lines = [a.address1, a.address2].filter(Boolean).map(S);
  const payload = { addressesToValidate: [{ address: { streetLines: lines.length ? lines : [""], city: S(a.city), stateOrProvinceCode: S(a.state), postalCode: S(a.zip), countryCode: CC(a.country) } }] };
  let r, t, d = null;
  const doFetch = async () => {
    const rr = await fetch(c.base + "/address/v1/addresses/resolve", { method: "POST", headers: { "Authorization": "Bearer " + tk, "Content-Type": "application/json", "X-locale": "en_US" }, body: JSON.stringify(payload) });
    const tt = await rr.text(); let dd = null; try { dd = JSON.parse(tt); } catch {}
    return { rr, tt, dd };
  };
  try {
    let out = await doFetch();
    if (out.rr.status >= 500) { await new Promise((res) => setTimeout(res, 400)); out = await doFetch(); } // one retry on FedEx 5xx
    r = out.rr; t = out.tt; d = out.dd;
  } catch (e) { return { deliverable: null, normalized: null, attrs: {}, error: "address fetch failed" }; }
  if (!r.ok) return { deliverable: null, normalized: null, attrs: {}, error: "address HTTP " + r.status };
  const ra = (d && d.output && d.output.resolvedAddresses && d.output.resolvedAddresses[0]) || null;
  const attrs = (ra && ra.attributes) || {};
  const deliverable = attrs.DPV === "true" || attrs.Resolved === "true";
  const classification = ((ra && ra.classification) || "UNKNOWN").toUpperCase();
  const normalized = ra ? { streetLines: ra.streetLinesToken || ra.streetLines || null, city: ra.city, state: ra.stateOrProvinceCode, zip: ra.postalCode, country: ra.countryCode } : null;
  return { deliverable, classification, normalized, attrs, error: null };
}

async function address(c, body, tk) {
  const a = body.address || {};
  // run both lookups together
  const [val, cls] = await Promise.all([
    validateDeliverability(c, a, tk),
    rateClassify(c, a, body.fromZip || "", tk),
  ]);
  const attrs = val.attrs || {};
  const issues = [];
  if (val.deliverable === false) {
    if (attrs.SuiteRequiredButMissing === "true") issues.push("Apartment/suite number required");
    else if (attrs.InvalidSuiteNumber === "true") issues.push("Invalid apartment/suite number");
    else if (attrs.MultipleMatches === "true") issues.push("Ambiguous — multiple matches found");
    else if (attrs.CityStateValidated === "true") issues.push("Street not found at this ZIP");
    else issues.push("Address not found by FedEx");
  }
  // Address Validation classification wins when it's definitive; otherwise use the rate-probe signal.
  const vc = (val.classification || "UNKNOWN").toUpperCase();
  const classification = (vc === "BUSINESS" || vc === "RESIDENTIAL") ? vc : cls.classification;
  return {
    ok: true,
    _fn: "addr-v21",
    deliverable: val.deliverable,                       // true / false / null(=couldn't check)
    classification,                                     // RESIDENTIAL | BUSINESS | UNKNOWN
    residential: classification === "RESIDENTIAL",
    source: (vc === "BUSINESS" || vc === "RESIDENTIAL") ? "validation" : "rate",
    normalized: val.normalized,
    issues: issues.length ? issues : null,
    debug: {
      validationClassification: vc,
      rateClassification: cls.classification,
      groundType: cls.groundType,
      residentialSurcharge: cls.residentialSurcharge,
      surcharges: cls.surcharges,
      services: cls.services,
      classifyError: cls.error,
      deliverError: val.error,
    },
  };
}

/* ════════ FEDEX PICKUP API ════════ */
async function pickupAvailability(c, body, tk) {
  const a = body.address || {};
  const payload = {
    associatedAccountNumber: { value: c.account },
    pickupAddress: { streetLines: [a.address1].filter(Boolean).map(S), city: S(a.city), stateOrProvinceCode: S(a.state), postalCode: S(a.zip), countryCode: CC(a.country) },
    pickupRequestType: ["SAME_DAY", "FUTURE_DAY"],
    dispatchDate: body.date || new Date().toISOString().slice(0, 10),
    packageReadyTime: body.readyTime || "10:00:00",
    customerCloseTime: body.closeTime || "17:00:00",
    carriers: [body.carrierCode || "FDXE"],
    countryRelationship: "DOMESTIC",
  };
  let r, t, d = null;
  try {
    r = await fetch(c.base + "/pickup/v1/pickups/availabilities", { method: "POST", headers: { "Authorization": "Bearer " + tk, "Content-Type": "application/json", "X-locale": "en_US" }, body: JSON.stringify(payload) });
    t = await r.text(); try { d = JSON.parse(t); } catch {}
  } catch (e) { return { ok: false, error: "availability fetch failed: " + (e && e.message) }; }
  if (!r.ok) return { ok: false, error: "availability HTTP " + r.status + (d && d.errors && d.errors[0] ? ": " + d.errors[0].message : "") };
  const o = (d && d.output) || {};
  return { ok: true, options: o.options || [], closeTimes: o.closeTimeDetails || [] };
}

async function schedulePickup(c, body, tk) {
  const a = body.address || {};
  const payload = {
    associatedAccountNumber: { value: c.account },
    originDetail: {
      pickupLocation: {
        contact: { personName: S(a.name) || "Shipping Dept", phoneNumber: S(a.phone) || "0000000000", companyName: S(a.company) || S(a.name) || "Shipper" },
        address: { streetLines: [a.address1, a.address2].filter(Boolean).map(S), city: S(a.city), stateOrProvinceCode: S(a.state), postalCode: S(a.zip), countryCode: CC(a.country), residential: !!body.residential },
      },
      readyDateTimestamp: (body.date || new Date().toISOString().slice(0, 10)) + "T" + (body.readyTime || "10:00:00"),
      customerCloseTime: body.closeTime || "17:00:00",
      packageLocation: body.packageLocation || "FRONT",
      buildingPart: body.buildingPart || "SUITE",
    },
    totalWeight: { units: "LB", value: Number(body.totalWeight) || 1 },
    packageCount: Number(body.packageCount) || 1,
    carrierCode: body.carrierCode || "FDXE",
    remarks: body.remarks || "",
    countryRelationship: "DOMESTIC",
  };
  let r, t, d = null;
  try {
    r = await fetch(c.base + "/pickup/v1/pickups", { method: "POST", headers: { "Authorization": "Bearer " + tk, "Content-Type": "application/json", "X-locale": "en_US" }, body: JSON.stringify(payload) });
    t = await r.text(); try { d = JSON.parse(t); } catch {}
  } catch (e) { return { ok: false, error: "pickup fetch failed: " + (e && e.message) }; }
  if (!r.ok) return { ok: false, error: "pickup HTTP " + r.status + (d && d.errors && d.errors[0] ? ": " + (d.errors[0].message || JSON.stringify(d.errors)) : (t ? ": " + t.slice(0, 200) : "")) };
  const o = (d && d.output) || {};
  return { ok: true, confirmationCode: o.pickupConfirmationCode || o.confirmationNumber || null, location: o.location || null, message: o.message || null };
}

async function cancelPickup(c, body, tk) {
  const payload = {
    associatedAccountNumber: { value: c.account },
    pickupConfirmationCode: S(body.confirmationCode),
    carrierCode: body.carrierCode || "FDXE",
    scheduledDate: S(body.date),
    location: S(body.location) || undefined,
    remarks: S(body.remarks) || undefined,
  };
  let r, t, d = null;
  try {
    r = await fetch(c.base + "/pickup/v1/pickups/cancel", { method: "PUT", headers: { "Authorization": "Bearer " + tk, "Content-Type": "application/json", "X-locale": "en_US" }, body: JSON.stringify(payload) });
    t = await r.text(); try { d = JSON.parse(t); } catch {}
  } catch (e) { return { ok: false, error: "cancel fetch failed: " + (e && e.message) }; }
  if (!r.ok) return { ok: false, error: "cancel HTTP " + r.status + (d && d.errors && d.errors[0] ? ": " + (d.errors[0].message || "") : "") };
  const o = (d && d.output) || {};
  return { ok: true, cancelled: true, message: o.cancelConfirmationMessage || o.message || "Pickup cancelled" };
}

/* ── session gate (see claude/audit-security.md F1) ──────────────────────
   This endpoint spends real money or exposes the account's rate card, so the
   caller must present a valid ShippingCloud session token (body.token — the
   same HMAC token db.js issues at login). Server-to-server callers
   (warm-rates, shopify-rates) send body.internalKey instead — an HMAC only
   computable with this site's env secrets. With no SESSION_SECRET and no
   Supabase key configured there is no auth system at all (bare local dev),
   so the gate stands down rather than lock everything out. */
const scCrypto = require("crypto");
const scSecret = () => { const s = (process.env.SESSION_SECRET || "").trim(); if (s) return s; const k = (process.env.SUPABASE_SERVICE_KEY || "").trim(); return k ? scCrypto.createHash("sha256").update("sc1|" + k).digest("hex") : ""; };
const scInternalKey = () => { const s = scSecret(); return s ? scCrypto.createHmac("sha256", s).update("internal:carrier").digest("hex") : ""; };
function scAuth(body) {
  const sec = scSecret();
  if (!sec) return { uid: "local", local: true };
  const ik = String((body && body.internalKey) || "");
  if (ik) { const want = scInternalKey(); try { if (want && ik.length === want.length && scCrypto.timingSafeEqual(Buffer.from(ik), Buffer.from(want))) return { uid: "internal", internal: true }; } catch (e) {} }
  try {
    const [p, sig] = String((body && body.token) || "").split(".");
    if (!p || !sig) return null;
    const want = Buffer.from(scCrypto.createHmac("sha256", sec).update(p).digest("hex"), "hex");
    const got = Buffer.from(sig, "hex");
    if (want.length !== got.length || !scCrypto.timingSafeEqual(want, got)) return null;
    const d = JSON.parse(Buffer.from(String(p).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (!d || !d.uid || !d.exp || Date.now() > d.exp) return null;
    return d;
  } catch (e) { return null; }
}
/* best-effort per-container burst limit (the auth gate above is the real control) */
const scHits = {};
function scAllow(k, max) { const w = Math.floor(Date.now() / 60000), kk = k + ":" + w; scHits[kk] = (scHits[kk] || 0) + 1; if (Object.keys(scHits).length > 4000) { for (const x in scHits) { if (!x.endsWith(":" + w)) delete scHits[x]; } } return scHits[kk] <= max; }

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, body: "" };
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let body = {}; try { body = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON body" }); }
    const gateAuth = scAuth(body);
    if (!gateAuth) return J({ ok: false, authFailed: true, error: "Sign in first \u2014 your session may have expired." });
    if (!scAllow("fedex:" + gateAuth.uid, 240)) return J({ ok: false, error: "Too many requests at once \u2014 give it a few seconds." });

    const c = creds(body);
    if (!c.key || !c.secret) return J({ ok: false, error: "This tool isn't available right now — contact support." });

    let tk;
    try { tk = await token(c); } catch (e) { return J({ ok: false, error: e.message }); }

    if (body.action === "address") {
      const out = await address(c, body, tk);
      return J(out);
    }
    if (body.action === "pickup") {
      if (!c.account) return J({ ok: false, error: "Missing FedEx account number." });
      const out = await schedulePickup(c, body, tk);
      return J(out);
    }
    if (body.action === "pickupAvailability") {
      if (!c.account) return J({ ok: false, error: "Missing FedEx account number." });
      const out = await pickupAvailability(c, body, tk);
      return J(out);
    }
    if (body.action === "pickupCancel") {
      if (!c.account) return J({ ok: false, error: "Missing FedEx account number." });
      const out = await cancelPickup(c, body, tk);
      return J(out);
    }
    // default: transit
    if (!c.account) return J({ ok: false, error: "Pickups aren't available on this account yet — contact support." });
    const out = await transit(c, body, tk);
    return J(out);
  } catch (e) {
    return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) });
  }
};
