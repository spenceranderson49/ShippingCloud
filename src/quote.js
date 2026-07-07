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

exports.handler = async (event) => {
  const respond = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  if (event.httpMethod === "OPTIONS") return respond(200, { ok: true });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return respond(200, { live: false, error: "Bad request body", rates: [] }); }

  if (body.action === "flushCache") return respond(200, { ok: true, flushed: true });

  if (!CLIENT_ID || !CLIENT_SECRET || !ACCOUNT) {
    return respond(200, { live: false, error: "FedEx isn't configured: set FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET and FEDEX_ACCOUNT in Netlify (normal vars, then redeploy).", rates: [] });
  }

  const fromZip = String(body.fromZip || "").trim();
  const toZip = String(body.toZip || "").trim();
  if (!fromZip || !toZip) return respond(200, { live: false, error: "Origin and destination ZIP required", rates: [] });
  const fromCountry = (body.fromCountry || "US").toUpperCase();
  const toCountry = (body.toCountry || "US").toUpperCase();
  const acct = String(body.fedexAccount || (body.account && body.account.fedexAccount) || ACCOUNT).replace(/\D/g, "") || ACCOUNT;
  const pieces = (Array.isArray(body.pieces) && body.pieces.length ? body.pieces : [{ weight: 1, length: 12, width: 9, height: 4 }])
    .map(p => ({
      weight: { units: "LB", value: Math.max(0.1, +p.weight || 1) },
      dimensions: { length: Math.max(1, Math.round(+p.length || 12)), width: Math.max(1, Math.round(+p.width || 9)), height: Math.max(1, Math.round(+p.height || 4)), units: "IN" }
    }));

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

  try {
    const token = await getToken();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 22000);
    const r = await fetch(BASE + "/rate/v1/rates/quotes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, "x-locale": "en_US" },
      body: JSON.stringify(req),
      signal: ctrl.signal
    });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j.errors && j.errors[0] && (j.errors[0].message || j.errors[0].code)) || ("FedEx rate error " + r.status);
      return respond(200, { live: false, error: msg, rates: [], _status: r.status });
    }
    const replies = (j.output && j.output.rateReplyDetails) || [];
    const rates = [];
    for (const rd of replies) {
      const svc = SVC[rd.serviceType] || { key: String(rd.serviceType || "").toLowerCase(), label: String(rd.serviceName || rd.serviceType || "FedEx").replace(/[®™]/g, "").trim() };
      const acctD = pickDetail(rd.ratedShipmentDetails, false);
      const listD = pickDetail(rd.ratedShipmentDetails, true);
      const cost = netOf(acctD);
      const list = netOf(listD);
      if (cost == null && list == null) continue;
      let minDays = null, maxDays = null;
      const tt = rd.operationalDetail && rd.operationalDetail.transitTime;
      if (tt && TRANSIT_DAYS[tt]) { minDays = TRANSIT_DAYS[tt]; maxDays = TRANSIT_DAYS[tt]; }
      const surch = ((acctD && acctD.shipmentRateDetail && acctD.shipmentRateDetail.surCharges) || [])
        .map(s => ({ label: s.description || s.type || "Surcharge", amount: Math.round((+s.amount || 0) * 100) / 100 }))
        .filter(s => s.amount);
      rates.push({
        key: svc.key,
        carrier: "FedEx",
        carrierCode: "fedex",
        serviceCode: rd.serviceType,
        label: svc.label,
        cost: cost != null ? cost : list,
        list: list,
        packageTypeCode: "",
        minDays, maxDays,
        surcharges: surch,
        _rateType: acctD && acctD.rateType || null
      });
    }
    rates.sort((a, b) => (a.cost || 0) - (b.cost || 0));
    if (!rates.length) {
      const alert = j.output && j.output.alerts && j.output.alerts[0] && j.output.alerts[0].message;
      return respond(200, { live: false, error: alert || "FedEx returned no rates for this shipment.", rates: [] });
    }
    return respond(200, { live: true, provider: "fedex-direct", account: acct.replace(/^(\d{3})\d+(\d{2})$/, "$1****$2"), rates });
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "FedEx took too long to respond" : ((e && e.message) || "FedEx request failed");
    return respond(200, { live: false, error: msg, rates: [] });
  }
};
