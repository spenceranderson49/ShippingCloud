/* ════════════════════════════════════════════════════════════════════════
   quote.js — addr-v228 — DIRECT FEDEX RATES (replaces the England/Rock Solid quote)
   Same endpoint, same request/response contract the app has always used:
     in:  {carriers, fromZip, toZip, fromCountry, toCountry, residential,
           packageTypeCode, pieces:[{weight,length,width,height}], account:{...}}
     out: {live:true, rates:[{key,carrier,carrierCode,serviceCode,label,cost,list,
           packageTypeCode,minDays,maxDays,surcharges:[{label,amount}]}]}
   cost = ACCOUNT rate on your FedEx account number (your raw England-billed rate).
   list = FedEx published LIST rate from the same call (powers "FedEx list − %").
   Env vars (Netlify, set as NORMAL non-secret, redeploy after changing):
     FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET, FEDEX_ACCOUNT, FEDEX_ENV ("production" default, "sandbox" for testing)
   ════════════════════════════════════════════════════════════════════════ */

const ENV = (process.env.FEDEX_ENV || "production").toLowerCase();
const BASE = ENV === "sandbox" ? "https://apis-sandbox.fedex.com" : "https://apis.fedex.com";
const CLIENT_ID = process.env.FEDEX_CLIENT_ID || process.env.FEDEX_API_KEY || process.env.FEDEX_KEY || "";
const CLIENT_SECRET = process.env.FEDEX_CLIENT_SECRET || process.env.FEDEX_SECRET_KEY || process.env.FEDEX_SECRET || "";
const ACCOUNT = process.env.FEDEX_ACCOUNT || process.env.FEDEX_ACCOUNT_NUMBER || process.env.FEDEX_ACCT || "";

/* Country dropdowns in the app store full names ("United States"); FedEx wants ISO-2.
   2-letter inputs pass through; unknown names pass through raw so FedEx names the problem
   instead of us silently misrouting a shipment. */
const ISO2 = { "united states":"US","usa":"US","u.s.":"US","u.s.a.":"US","united states of america":"US","canada":"CA","mexico":"MX","united kingdom":"GB","great britain":"GB","uk":"GB","england":"GB","australia":"AU","germany":"DE","france":"FR","italy":"IT","spain":"ES","netherlands":"NL","belgium":"BE","switzerland":"CH","austria":"AT","sweden":"SE","norway":"NO","denmark":"DK","finland":"FI","ireland":"IE","portugal":"PT","poland":"PL","czech republic":"CZ","czechia":"CZ","greece":"GR","hungary":"HU","romania":"RO","bulgaria":"BG","croatia":"HR","slovakia":"SK","slovenia":"SI","estonia":"EE","latvia":"LV","lithuania":"LT","luxembourg":"LU","iceland":"IS","japan":"JP","china":"CN","hong kong":"HK","taiwan":"TW","south korea":"KR","korea, south":"KR","republic of korea":"KR","singapore":"SG","malaysia":"MY","thailand":"TH","vietnam":"VN","philippines":"PH","indonesia":"ID","india":"IN","pakistan":"PK","bangladesh":"BD","sri lanka":"LK","israel":"IL","saudi arabia":"SA","united arab emirates":"AE","uae":"AE","qatar":"QA","kuwait":"KW","bahrain":"BH","oman":"OM","jordan":"JO","turkey":"TR","egypt":"EG","south africa":"ZA","nigeria":"NG","kenya":"KE","morocco":"MA","ghana":"GH","brazil":"BR","argentina":"AR","chile":"CL","colombia":"CO","peru":"PE","ecuador":"EC","uruguay":"UY","paraguay":"PY","bolivia":"BO","venezuela":"VE","costa rica":"CR","panama":"PA","guatemala":"GT","honduras":"HN","el salvador":"SV","nicaragua":"NI","dominican republic":"DO","jamaica":"JM","bahamas":"BS","barbados":"BB","trinidad and tobago":"TT","puerto rico":"PR","new zealand":"NZ","russia":"RU","ukraine":"UA","belarus":"BY","kazakhstan":"KZ","georgia":"GE","armenia":"AM","azerbaijan":"AZ" };
function toISO(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "US";
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return ISO2[s.toLowerCase()] || s;
}

/* Landed-cost FALLBACK estimate. FedEx's Estimated Duties & Taxes (EDT) is only returned on some
   lanes/accounts, so when it's absent we approximate duties + import VAT/GST ourselves from the
   destination's standard rates. This is a best-effort ESTIMATE (real duty is HS-code specific) —
   it's labelled as such in the UI, and it's what lets us show a landed cost to compete with DDP
   carriers instead of a blank. duty = general average import duty; vat = standard import VAT/GST;
   dm = de-minimis customs value (USD) under which the country typically waives duty (VAT still may
   apply, but we treat small parcels as clear to avoid overstating). */
const DEST_TAX = {
  GB:{vat:20,duty:4,dm:180}, DE:{vat:19,duty:4,dm:0}, FR:{vat:20,duty:4,dm:0}, IT:{vat:22,duty:4,dm:0}, ES:{vat:21,duty:4,dm:0},
  NL:{vat:21,duty:4,dm:0}, BE:{vat:21,duty:4,dm:0}, IE:{vat:23,duty:4,dm:0}, AT:{vat:20,duty:4,dm:0}, SE:{vat:25,duty:4,dm:0},
  DK:{vat:25,duty:4,dm:0}, FI:{vat:24,duty:4,dm:0}, PT:{vat:23,duty:4,dm:0}, PL:{vat:23,duty:4,dm:0}, CZ:{vat:21,duty:4,dm:0},
  GR:{vat:24,duty:4,dm:0}, RO:{vat:19,duty:4,dm:0}, HU:{vat:27,duty:4,dm:0}, NO:{vat:25,duty:4,dm:0}, CH:{vat:8.1,duty:3,dm:70},
  CA:{vat:5,duty:0,dm:20}, MX:{vat:16,duty:5,dm:50}, AU:{vat:10,duty:5,dm:670}, NZ:{vat:15,duty:5,dm:700}, JP:{vat:10,duty:4,dm:130},
  CN:{vat:13,duty:8,dm:8}, HK:{vat:0,duty:0,dm:99999}, SG:{vat:9,duty:0,dm:300}, KR:{vat:10,duty:8,dm:150}, IN:{vat:18,duty:10,dm:0},
  AE:{vat:5,duty:5,dm:270}, SA:{vat:15,duty:5,dm:70}, IL:{vat:17,duty:5,dm:75}, ZA:{vat:15,duty:8,dm:0}, BR:{vat:17,duty:12,dm:0},
  UA:{vat:20,duty:5,dm:170}, TR:{vat:20,duty:5,dm:0}, TH:{vat:7,duty:5,dm:40}, MY:{vat:8,duty:5,dm:120}, PH:{vat:12,duty:5,dm:200},
  VN:{vat:10,duty:8,dm:45}, ID:{vat:11,duty:7.5,dm:3},
};
function estDutyTax(destISO, custValue, shipping) {
  const t = DEST_TAX[String(destISO || "").toUpperCase()];
  if (!t || !(custValue > 0)) return null;
  const round = (n) => Math.round(n * 100) / 100;
  if (t.dm && custValue <= t.dm) return { duties: 0, taxes: 0, total: 0, estimated: true };   // under de-minimis → typically clears free
  const duties = round(custValue * (t.duty / 100));
  const taxes = round((custValue + duties + (+shipping || 0)) * (t.vat / 100));   // import VAT is on landed value (goods + duty + freight)
  return { duties, taxes, total: round(duties + taxes), estimated: true };
}

let _tok = null; // {token, exp}
async function getToken() {
  if (_tok && Date.now() < _tok.exp - 60000) return _tok.token;
  const r = await fetch(BASE + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("FedEx auth failed (" + r.status + "): " + (j.errors && j.errors[0] && j.errors[0].message || JSON.stringify(j).slice(0, 200)));
  _tok = { token: j.access_token, exp: Date.now() + ((+j.expires_in || 3000) * 1000) };
  return _tok.token;
}

/* serviceType → the labels/keys the app's canonSvc()/rateSvcKey() already parse */
const SVC = {
  FEDEX_GROUND:                       { key: "ground",              label: "FedEx Ground" },
  GROUND_HOME_DELIVERY:               { key: "home",                label: "FedEx Home Delivery" },
  SMART_POST:                         { key: "ground_economy",      label: "FedEx Ground Economy" },
  FEDEX_GROUND_ECONOMY:               { key: "ground_economy",      label: "FedEx Ground Economy" },
  FEDEX_EXPRESS_SAVER:                { key: "express_saver",       label: "FedEx Express Saver" },
  FEDEX_2_DAY:                        { key: "2day",                label: "FedEx 2Day" },
  FEDEX_2_DAY_AM:                     { key: "2day_am",             label: "FedEx 2Day A.M." },
  STANDARD_OVERNIGHT:                 { key: "standard_overnight",  label: "FedEx Standard Overnight" },
  PRIORITY_OVERNIGHT:                 { key: "priority_overnight",  label: "FedEx Priority Overnight" },
  FIRST_OVERNIGHT:                    { key: "first_overnight",     label: "FedEx First Overnight" },
  INTERNATIONAL_GROUND:               { key: "intl_ground_ca",      label: "FedEx International Ground" },
  FEDEX_INTERNATIONAL_CONNECT_PLUS:   { key: "intl_connect_plus",   label: "FedEx International Connect Plus" },
  INTERNATIONAL_ECONOMY:              { key: "intl_economy",        label: "FedEx International Economy" },
  INTERNATIONAL_PRIORITY:             { key: "intl_priority",       label: "FedEx International Priority" },
  FEDEX_INTERNATIONAL_PRIORITY:       { key: "intl_priority",       label: "FedEx International Priority" },
  FEDEX_INTERNATIONAL_PRIORITY_EXPRESS:{ key: "intl_priority_express", label: "FedEx International Priority Express" },
  INTERNATIONAL_FIRST:                { key: "intl_first",          label: "FedEx International First" },
  FEDEX_FIRST_FREIGHT:                { key: "first_overnight_freight", label: "FedEx First Overnight Freight" },
  FEDEX_1_DAY_FREIGHT:                { key: "1day_freight",        label: "FedEx 1Day Freight" },
  FEDEX_2_DAY_FREIGHT:                { key: "2day_freight",        label: "FedEx 2Day Freight" },
  FEDEX_3_DAY_FREIGHT:                { key: "3day_freight",        label: "FedEx 3Day Freight" },
  INTERNATIONAL_PRIORITY_FREIGHT:     { key: "intl_priority_freight", label: "FedEx International Priority Freight" },
  INTERNATIONAL_ECONOMY_FREIGHT:      { key: "intl_economy_freight", label: "FedEx International Economy Freight" }
};

const TRANSIT_DAYS = {
  ONE_DAY: 1, TWO_DAYS: 2, THREE_DAYS: 3, FOUR_DAYS: 4, FIVE_DAYS: 5, SIX_DAYS: 6, SEVEN_DAYS: 7,
  EIGHT_DAYS: 8, NINE_DAYS: 9, TEN_DAYS: 10, ELEVEN_DAYS: 11, TWELVE_DAYS: 12, THIRTEEN_DAYS: 13,
  FOURTEEN_DAYS: 14, FIFTEEN_DAYS: 15, SIXTEEN_DAYS: 16, SEVENTEEN_DAYS: 17, EIGHTEEN_DAYS: 18,
  NINETEEN_DAYS: 19, TWENTY_DAYS: 20
};

function pickDetail(details, wantList) {
  if (!Array.isArray(details)) return null;
  const isList = (t) => /LIST/.test(String(t || ""));
  const isAcct = (t) => /ACCOUNT|INCENTIVE|PREFERRED_ACCOUNT/.test(String(t || ""));
  let d = details.find(x => wantList ? isList(x.rateType) : isAcct(x.rateType));
  if (!d && !wantList) d = details.find(x => !isList(x.rateType)); // whatever isn't LIST
  if (!d && !wantList) d = details[0];
  return d || null;
}
const netOf = (d) => {
  if (!d) return null;
  const v = d.totalNetChargeWithDutiesAndTaxes != null && +d.totalNetChargeWithDutiesAndTaxes > 0
    ? null // prefer plain net charge below for domestic parity
    : null;
  const n = d.totalNetCharge != null ? +d.totalNetCharge : (d.totalNetFedExCharge != null ? +d.totalNetFedExCharge : null);
  return (n == null || isNaN(n)) ? null : Math.round(n * 100) / 100;
};

/* ── per-site backend switch ─────────────────────────────────────────────
   Set CARRIER_BACKEND=england in a Netlify site's env vars and this function
   delegates every request to ./quote-england.js (the pre-cutover England/Rock Solid
   implementation, restored from git history). Unset / "fedex" = direct FedEx. */
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
    if (!d || d.kind || !d.uid || !d.exp || Date.now() > d.exp) return null;   /* d.kind = special-purpose token (password reset) — never a session */
    return d;
  } catch (e) { return null; }
}
/* best-effort per-container burst limit (the auth gate above is the real control) */
const scHits = {};
function scAllow(k, max) { const w = Math.floor(Date.now() / 60000), kk = k + ":" + w; scHits[kk] = (scHits[kk] || 0) + 1; if (Object.keys(scHits).length > 4000) { for (const x in scHits) { if (!x.endsWith(":" + w)) delete scHits[x]; } } return scHits[kk] <= max; }

exports.handler = async (event) => {
  const respond = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  if (event.httpMethod === "OPTIONS") return respond(200, { ok: true });
  let gateBody = {}; try { gateBody = JSON.parse(event.body || "{}"); } catch (e) {}
  const gateAuth = scAuth(gateBody);
  if (!gateAuth) return respond(200, { live: false, authFailed: true, error: "Live rates are for signed-in accounts \u2014 sign in and try again.", rates: [] });
  if (!scAllow("quote:" + gateAuth.uid, 240)) return respond(200, { live: false, error: "Too many rate requests at once \u2014 give it a few seconds.", rates: [] });
  if ((process.env.CARRIER_BACKEND || "fedex").toLowerCase() === "england") {
    try { return await require("./quote-england.js").handler(event); }
    catch (e) {
      const msg = "Live rates are temporarily unavailable — showing estimates.";
      return respond(200, {live:false,error:msg,rates:[]});
    }
  }
  if (event.httpMethod === "OPTIONS") return respond(200, { ok: true });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return respond(200, { live: false, error: "Bad request body", rates: [] }); }

  if (body.action === "flushCache") return respond(200, { ok: true, flushed: true });

  if (!CLIENT_ID || !CLIENT_SECRET || !ACCOUNT) {
    return respond(200, { live: false, error: "Live rates aren't available on this site yet.", rates: [] });
  }

  const fromZip = String(body.fromZip || "").trim();
  const toZip = String(body.toZip || "").trim();
  if (!fromZip || !toZip) return respond(200, { live: false, error: "Origin and destination ZIP required", rates: [] });
  const PKG_MAP = { fedex_envelope: "FEDEX_ENVELOPE", fedex_pak: "FEDEX_PAK", fedex_extra_small_box: "FEDEX_EXTRA_SMALL_BOX", fedex_small_box: "FEDEX_SMALL_BOX", fedex_medium_box: "FEDEX_MEDIUM_BOX", fedex_large_box: "FEDEX_LARGE_BOX", fedex_tube: "FEDEX_TUBE" };
  const boxCode = String(body.packageTypeCode || "").trim().toLowerCase();
  const fedexPackaging = PKG_MAP[boxCode] || (/^FEDEX_/i.test(boxCode) ? boxCode.toUpperCase() : null);
  const SMARTPOST_HUB = String(body.smartPostHub || process.env.FEDEX_SMARTPOST_HUB || "").trim();
  const fromCountry = toISO(body.fromCountry || "US");
  const toCountry = toISO(body.toCountry || "US");
  const acct = String(body.fedexAccount || (body.account && body.account.fedexAccount) || ACCOUNT).replace(/\D/g, "") || ACCOUNT;
  /* Declared value + signature ride the RATE request so FedEx prices them in the returned
     amount — the quote is the REAL charge (raw FedEx + the app's markup), never a locally
     estimated fee. Per package, exactly like the booking. */
  const SIGQ = { direct: "DIRECT", indirect: "INDIRECT", adult: "ADULT" };
  const sigType = SIGQ[String(body.signatureOption || "none").toLowerCase()] || null;
  const money$ = (v) => +String(v == null ? "" : v).replace(/[^0-9.]/g, "") || 0;
  const rawPieces = (Array.isArray(body.pieces) && body.pieces.length ? body.pieces : [{ weight: 1, length: 12, width: 9, height: 4 }]);
  const pieces = rawPieces.map(p => {
      const it = {
        weight: { units: "LB", value: Math.max(0.1, +p.weight || 1) },
        dimensions: { length: Math.max(1, Math.round(+p.length || 12)), width: Math.max(1, Math.round(+p.width || 9)), height: Math.max(1, Math.round(+p.height || 4)), units: "IN" }
      };
      const dv = money$(p.declaredValue);
      if (dv > 0) it.declaredValue = { amount: Math.round(dv * 100) / 100, currency: "USD" };
      if (sigType) it.packageSpecialServices = { signatureOptionType: sigType };
      return it;
    });

  const req = {
    accountNumber: { value: acct },
    rateRequestControlParameters: { returnTransitTimes: true, rateSortOrder: "COMMITASCENDING" },
    requestedShipment: {
      shipper: { address: { postalCode: fromZip, countryCode: fromCountry } },
      recipient: { address: { postalCode: toZip, countryCode: toCountry, residential: !!body.residential } },
      pickupType: "USE_SCHEDULED_PICKUP",
      rateRequestType: ["ACCOUNT", "LIST"],
      requestedPackageLineItems: pieces
    }
  };
  /* INTERNATIONAL: FedEx's rate API only returns international services when the request
     carries a customs block (commodities + customs value). Without this, an intl request
     errors out and the app showed NO services — the root cause of "no international rates".
     Declared value falls back to the insurance amount, then $100. */
  let _custValue = 0;   // customs value for the landed-cost fallback estimate (set in the intl block below)
  if (toCountry !== fromCountry) {
    const totalWt = pieces.reduce((a, p) => a + ((p.weight && p.weight.value) || 1), 0);
    const declared = Math.max(1, +body.declaredValue || +body.insuranceAmount || 100);
    /* Per-line commodities when the caller sends them (each with HS code + value) → sharper
       duty/tax estimates. Falls back to one lumped commodity at the declared value. */
    const inCom = Array.isArray(body.commodities) ? body.commodities.filter(c => c && (+c.value > 0 || c.description)) : [];
    const commodities = inCom.length ? inCom.map(c => ({
      description: String(c.description || "Merchandise").slice(0, 70),
      countryOfManufacture: toISO(c.origin || fromCountry || "US"),   // UI stores full names ("United States"); FedEx rejects the customs block unless this is ISO-2
      ...(c.hsCode ? { harmonizedCode: String(c.hsCode).replace(/[^0-9.]/g, "").slice(0, 14) } : {}),
      quantity: Math.max(1, +c.quantity || 1),
      quantityUnits: "PCS",
      weight: { units: "LB", value: Math.max(0.1, +c.weight || (totalWt / inCom.length) || 0.1) },
      unitPrice: { amount: Math.max(0.01, +c.value || 1), currency: "USD" },
      customsValue: { amount: Math.max(0.01, (+c.value || 1) * Math.max(1, +c.quantity || 1)), currency: "USD" }
    })) : [{
      description: String(body.contentsDesc || "Merchandise").slice(0, 70),
      countryOfManufacture: fromCountry || "US",
      quantity: 1,
      quantityUnits: "PCS",
      weight: { units: "LB", value: Math.max(0.1, totalWt) },
      unitPrice: { amount: declared, currency: "USD" },
      customsValue: { amount: declared, currency: "USD" }
    }];
    /* customs value used for the fallback duty/VAT estimate — from REAL inputs only (entered
       commodity values, or an explicit declared/insured value). If neither was given we leave it 0
       so we DON'T invent a landed cost off the $100 default. */
    _custValue = inCom.length
      ? inCom.reduce((a, c) => a + Math.max(0, (+c.value || 0)) * Math.max(1, +c.quantity || 1), 0)
      : (+body.declaredValue || +body.insuranceAmount || 0);
    req.requestedShipment.customsClearanceDetail = {
      /* Who pays duties/taxes: DDP (SENDER) prepays so the recipient owes nothing at the door;
         DDU/DAP (RECIPIENT) leaves it to the buyer. Caller's ddp flag drives it (default DDP). */
      dutiesPayment: { paymentType: body.ddp === false ? "RECIPIENT" : "SENDER" },
      commodities
    };
    /* Ask FedEx to return Estimated Duties & Taxes with the rate so we can show landed cost. */
    req.requestedShipment.edtRequestType = "ALL";
    delete req.requestedShipment.recipient.address.residential;   // classification is US-only; intl requests reject it on some lanes
  }
  /* Ground Economy (SmartPost) is only returned when the request carries your hub —
     set FEDEX_SMARTPOST_HUB in Netlify env (the hub FedEx assigned to the account). */
  if (SMARTPOST_HUB && toCountry === "US" && fromCountry === "US") {
    req.requestedShipment.smartPostInfoDetail = { indicia: "PARCEL_SELECT", hubId: SMARTPOST_HUB };
  }
  /* One Rate is only returned when asked for with FedEx packaging — when the shipper picked a
     FedEx box, run a second rate call in parallel and merge its flat prices in. */
  let oneRateReq = null;
  if (fedexPackaging && toCountry === "US" && fromCountry === "US") {
    oneRateReq = JSON.parse(JSON.stringify(req));
    delete oneRateReq.requestedShipment.smartPostInfoDetail;
    oneRateReq.requestedShipment.packagingType = fedexPackaging;
    oneRateReq.requestedShipment.shipmentSpecialServices = { specialServiceTypes: ["FEDEX_ONE_RATE"] };
    /* One Rate drops the DIMENSIONS (the FedEx box defines them) but must keep declared value +
       signature — stripping them quoted a flat price without the coverage/signature fees while
       ship.js still booked them, so the bill came in higher than the quote. */
    oneRateReq.requestedShipment.requestedPackageLineItems = pieces.map(pp => {
      const it = { weight: pp.weight };
      if (pp.declaredValue) it.declaredValue = pp.declaredValue;
      if (pp.packageSpecialServices) it.packageSpecialServices = pp.packageSpecialServices;
      return it;
    });
  }

  try {
    const token = await getToken();
    const rateCall = async (payload) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 22000);
      const rr = await fetch(BASE + "/rate/v1/rates/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, "x-locale": "en_US" },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
      clearTimeout(t);
      const jj = await rr.json().catch(() => ({}));
      return { r: rr, j: jj };
    };
    const [main, orRes] = await Promise.all([rateCall(req), oneRateReq ? rateCall(oneRateReq).catch((e) => ({ _threw: (e && e.message) || "One Rate request failed" })) : Promise.resolve(null)]);
    const r = main.r, j = main.j;
    if (!r.ok) {
      let msg = (Array.isArray(j.errors) && j.errors.length ? j.errors.map((e) => e.message || e.code).filter(Boolean).join("; ") : "") || ("FedEx rate error " + r.status);
      if (/mismatch|should match the shipper|not\s*authorized|account.*(invalid|not\s*found)/i.test(msg)) {
        msg = "FedEx doesn't recognize account #" + acct + " on your API credentials — add it in the FedEx Developer Portal (Manage Organization \u2192 Shipping accounts, with that account's billing address + EULA), attach it to your project, then retry. FedEx said: " + msg;
      }
      return respond(200, { live: false, error: msg, rates: [], _status: r.status });
    }
    const rates = [];
    const oneRateOk = !!(orRes && orRes.r && orRes.r.ok);
    let oneRateError = null;
    if (oneRateReq && !oneRateOk) {
      oneRateError = (orRes && orRes._threw)
        || (orRes && orRes.j && orRes.j.errors && orRes.j.errors[0] && (orRes.j.errors[0].message || orRes.j.errors[0].code))
        || ("FedEx returned no One Rate pricing for this box/lane" + (orRes && orRes.r ? (" (status " + orRes.r.status + ")") : ""));
    }
    const batches = [{ replies: (j.output && j.output.rateReplyDetails) || [], oneRate: false }];
    if (oneRateOk) batches.push({ replies: (orRes.j.output && orRes.j.output.rateReplyDetails) || [], oneRate: true });
    /* ESTIMATED DUTIES & TAXES (landed cost). FedEx returns EDT in a few shapes depending on lane —
       an itemized dutiesAndTaxes/ancillaryFeesAndTaxes array, or a total field. Parse defensively;
       if nothing is present (domestic, or FedEx returned none) the rate simply carries no duties. */
    const numAmt = (m) => { if (m == null) return 0; if (typeof m === "number") return m; if (typeof m === "object") return +m.amount || 0; return +m || 0; };
    const edtOf = (rd, det) => {
      const srd = (det && det.shipmentRateDetail) || {};
      const arrs = [srd.dutiesAndTaxes, det && det.dutiesAndTaxes, rd && rd.dutiesAndTaxes, srd.ancillaryFeesAndTaxes, det && det.ancillaryFeesAndTaxes].filter(Array.isArray);
      let duties = 0, taxes = 0, seen = false;
      for (const a of arrs) for (const x of a) {
        const amt = numAmt(x && x.amount != null ? x.amount : x);
        if (!amt) continue; seen = true;
        const t = String((x && (x.type || x.description)) || "").toLowerCase();
        if (/tax|vat|gst|hst/.test(t)) taxes += amt; else duties += amt;
      }
      const total = numAmt(srd.totalDutiesAndTaxes) || numAmt(srd.totalDutiesTaxesAndFees) || 0;
      if (!seen && total > 0) { duties = total; seen = true; }
      if (!seen) return null;
      return { duties: Math.round(duties * 100) / 100, taxes: Math.round(taxes * 100) / 100, total: Math.round((duties + taxes) * 100) / 100 };
    };
    for (const batch of batches) for (const rd of batch.replies) {
      const svc = SVC[rd.serviceType] || { key: String(rd.serviceType || "").toLowerCase(), label: String(rd.serviceName || rd.serviceType || "FedEx").replace(/[®™]/g, "").trim() };
      const acctD = pickDetail(rd.ratedShipmentDetails, false);
      const listD = pickDetail(rd.ratedShipmentDetails, true);
      const cost = netOf(acctD);
      const list = netOf(listD);
      if (cost == null && list == null) continue;
      let minDays = null, maxDays = null;
      const tt = rd.operationalDetail && rd.operationalDetail.transitTime;
      if (tt && TRANSIT_DAYS[tt]) { minDays = TRANSIT_DAYS[tt]; maxDays = TRANSIT_DAYS[tt]; }
      /* Fee breakdown, England-style: FedEx puts surcharges either on the shipment
         rate detail or per-package — harvest both, merge duplicates, clean labels. */
      const harvest = (det) => {
        const out = [];
        if (det && det.shipmentRateDetail && Array.isArray(det.shipmentRateDetail.surCharges)) out.push(...det.shipmentRateDetail.surCharges);
        if (!out.length && det && Array.isArray(det.ratedPackages)) {
          det.ratedPackages.forEach(p => {
            const prd = p.packageRateDetail || {};
            (prd.surcharges || prd.surCharges || []).forEach(x => out.push(x));
          });
        }
        return out;
      };
      const normLabel = (x) => String(x.description || x.type || "Surcharge").replace(/_/g, " ").toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase()).replace(/\bFedex\b/g, "FedEx");
      const merged = {};
      harvest(acctD).forEach(x => {
        const label = normLabel(x);
        const amt = +((x.amount && x.amount.amount != null) ? x.amount.amount : x.amount) || 0;
        if (amt) merged[label] = Math.round(((merged[label] || 0) + amt) * 100) / 100;
      });
      /* LIST amounts per fee line (same label normalization) — powers "% off LIST" surcharge
         pricing in Admin → Rates. Only attached where the account line also exists. */
      const listSur = {};
      harvest(listD).forEach(x => {
        const label = normLabel(x);
        const amt = +((x.amount && x.amount.amount != null) ? x.amount.amount : x.amount) || 0;
        if (amt) listSur[label] = Math.round(((listSur[label] || 0) + amt) * 100) / 100;
      });
      let surch = Object.keys(merged).map(label => ({ label, amount: merged[label], ...(listSur[label] != null ? { list: listSur[label] } : {}) }));
      /* LIST base = list total minus list fees — service-level "% off list" prices the BASE only */
      const listSurTotal = Object.values(listSur).reduce((a, v) => a + v, 0);
      let listBase = list != null ? Math.round((list - listSurTotal) * 100) / 100 : null;
      /* Fees FedEx itemized ONLY on the account detail (or worded differently between the two
         details) still sit INSIDE the list total — leaving them there makes a "list −%" service
         rule price that fee twice (once in the base, once via its own fee rule). Approximate
         their list share with the account amount (never higher than list). */
      if (listBase != null) {
        const acctOnly = Object.keys(merged).filter((lb) => listSur[lb] == null).reduce((a, lb) => a + merged[lb], 0);
        if (acctOnly > 0) listBase = Math.round((listBase - acctOnly) * 100) / 100;
        /* CLAMP: a fee worded differently between the two details would be subtracted twice
           (once per wording), and account-only fees can exceed a cheap lane's remaining base —
           list base must never fall below the ACCOUNT base (list ≥ account always) or 0. */
        const _acctFees = Object.values(merged).reduce((a, v) => a + v, 0);
        const _acctBase = cost != null ? Math.max(0, Math.round((cost - _acctFees) * 100) / 100) : 0;
        listBase = Math.max(_acctBase, Math.max(0, listBase));
      }
      if (!surch.length && acctD && acctD.shipmentRateDetail && +acctD.shipmentRateDetail.totalSurcharges > 0) {
        surch = [{ label: "Carrier surcharges", amount: Math.round(+acctD.shipmentRateDetail.totalSurcharges * 100) / 100 }];
      }
      const boxName = (batch.oneRate && fedexPackaging) ? fedexPackaging.replace(/^FEDEX_/, "").split("_").map(w => w[0] + w.slice(1).toLowerCase()).join(" ") : "";
      rates.push({
        key: batch.oneRate ? "or_" + svc.key : svc.key,
        carrier: "FedEx",
        carrierCode: "fedex",
        serviceCode: batch.oneRate ? rd.serviceType + "_ONE_RATE" : rd.serviceType,
        label: batch.oneRate ? (svc.label + " OneRate" + (boxName ? " - " + boxName : "")) : svc.label,
        cost: cost != null ? cost : list,
        list: list,
        listBase: listBase,
        packageTypeCode: batch.oneRate ? boxCode : "",
        _oneRate: batch.oneRate || undefined,
        minDays, maxDays,
        base: cost != null ? Math.round((cost - surch.reduce((a, x) => a + x.amount, 0)) * 100) / 100 : null,
        surcharges: surch,
        ...(() => {
          /* Prefer FedEx's own EDT; fall back to our destination-rate estimate so an international
             quote still shows a landed cost. dutiesEstimated marks which one the UI is showing. */
          const fx = edtOf(rd, acctD);
          const e = fx || (toCountry !== fromCountry ? estDutyTax(toCountry, _custValue, cost) : null);
          return e ? { duties: e.duties, taxes: e.taxes, dutiesAndTaxes: e.total, dutiesEstimated: !fx && !!e.estimated } : {};
        })(),
        _rateType: acctD && acctD.rateType || null
      });
    }
    rates.sort((a, b) => (a.cost || 0) - (b.cost || 0));
    if (!rates.length) {
      const alert = j.output && j.output.alerts && j.output.alerts[0] && j.output.alerts[0].message;
      return respond(200, { live: false, error: alert || "FedEx returned no rates for this shipment.", rates: [] });
    }
    /* Declared value verification: coverage over $100/package carries a FedEx fee. If we asked
       for it and NO returned rate itemizes a declared-value/insurance surcharge, say so — the
       app surfaces it instead of silently quoting without the fee. */
    const dvAsked = rawPieces.some(p => money$(p.declaredValue) > 100);
    const dvSeen = rates.some(q => (q.surcharges || []).some(x => /declared|insur/i.test(String(x.label || ""))));
    return respond(200, { live: true, provider: "fedex-direct", account: acct.replace(/^(\d{3})\d+(\d{2})$/, "$1****$2"), rates, dvRequested: dvAsked, dvPriced: dvAsked ? dvSeen : null, oneRateRequested: !!oneRateReq, oneRateOk, oneRateError });
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "FedEx took too long to respond" : ((e && e.message) || "FedEx request failed");
    return respond(200, { live: false, error: msg, rates: [] });
  }
};
