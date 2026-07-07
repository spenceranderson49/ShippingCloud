/* ════════════════════════════════════════════════════════════════════════
   ship.js — addr-v228 — DIRECT FEDEX SHIP API (replaces the England/Rock Solid booking)
   Same endpoint + contract the app already speaks:
     {action:"ship", order:{...}}  → {ok:true, booked:true, tracking, orderId, labelPdfBase64}
     {action:"status", orderId}    → {ok:true, booked:false}   (FedEx books synchronously — nothing is ever pending)
     {action:"diag"}               → provider-accounts shape the Settings diagnostic expects
   FedEx is synchronous: the label comes back in the booking response, so the app's
   pollLabel() path short-circuits on res.booked and everything downstream is untouched.
   Env vars (Netlify, NORMAL non-secret, redeploy after changing):
     FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET, FEDEX_ACCOUNT, FEDEX_ENV ("production" default, "sandbox" for testing)
   ════════════════════════════════════════════════════════════════════════ */

const ENV = (process.env.FEDEX_ENV || "production").toLowerCase();
const BASE = ENV === "sandbox" ? "https://apis-sandbox.fedex.com" : "https://apis.fedex.com";
const CLIENT_ID = process.env.FEDEX_CLIENT_ID || process.env.FEDEX_API_KEY || process.env.FEDEX_KEY || "";
const CLIENT_SECRET = process.env.FEDEX_CLIENT_SECRET || process.env.FEDEX_SECRET_KEY || process.env.FEDEX_SECRET || "";
const ACCOUNT = process.env.FEDEX_ACCOUNT || process.env.FEDEX_ACCOUNT_NUMBER || process.env.FEDEX_ACCT || "";

let _tok = null;
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

/* Accepts either a FedEx serviceType straight off a live quote, a legacy England-ish
   code, or falls back to parsing the human service label. */
function serviceTypeFor(order) {
  const raw = String(order.serviceCode || "").trim();
  if (/^[A-Z0-9_]+$/.test(raw) && raw.length > 3) {
    const oneRate = /_ONE_RATE$/.test(raw);
    return { serviceType: raw.replace(/_ONE_RATE$/, ""), oneRate };
  }
  const t = (raw + " " + String(order.shippingService || "")).toLowerCase();
  const oneRate = /one\s*rate/.test(t);
  let st = null;
  if (/home/.test(t)) st = "GROUND_HOME_DELIVERY";
  else if (/ground\s*economy|smart\s*post/.test(t)) st = "SMART_POST";
  else if (/international/.test(t)) {
    if (/connect/.test(t)) st = "FEDEX_INTERNATIONAL_CONNECT_PLUS";
    else if (/priority\s*express/.test(t)) st = "FEDEX_INTERNATIONAL_PRIORITY_EXPRESS";
    else if (/economy/.test(t)) st = "INTERNATIONAL_ECONOMY";
    else if (/first/.test(t)) st = "INTERNATIONAL_FIRST";
    else if (/ground/.test(t)) st = "INTERNATIONAL_GROUND";
    else st = "FEDEX_INTERNATIONAL_PRIORITY";
  }
  else if (/first\s*overnight/.test(t)) st = "FIRST_OVERNIGHT";
  else if (/priority\s*overnight/.test(t)) st = "PRIORITY_OVERNIGHT";
  else if (/standard\s*overnight/.test(t)) st = "STANDARD_OVERNIGHT";
  else if (/2\s*day\s*a\.?m/.test(t)) st = "FEDEX_2_DAY_AM";
  else if (/2\s*day/.test(t)) st = "FEDEX_2_DAY";
  else if (/express\s*saver/.test(t)) st = "FEDEX_EXPRESS_SAVER";
  else if (/ground/.test(t)) st = "FEDEX_GROUND";
  return { serviceType: st || "FEDEX_GROUND", oneRate };
}

const PKG = {
  envelope: "FEDEX_ENVELOPE", pak: "FEDEX_PAK", xs_box: "FEDEX_EXTRA_SMALL_BOX", small_box: "FEDEX_SMALL_BOX",
  medium_box: "FEDEX_MEDIUM_BOX", large_box: "FEDEX_LARGE_BOX", xl_box: "FEDEX_EXTRA_LARGE_BOX", tube: "FEDEX_TUBE",
  FEDEX_ENVELOPE: "FEDEX_ENVELOPE", FEDEX_PAK: "FEDEX_PAK", FEDEX_SMALL_BOX: "FEDEX_SMALL_BOX",
  FEDEX_MEDIUM_BOX: "FEDEX_MEDIUM_BOX", FEDEX_LARGE_BOX: "FEDEX_LARGE_BOX", FEDEX_EXTRA_LARGE_BOX: "FEDEX_EXTRA_LARGE_BOX",
  FEDEX_EXTRA_SMALL_BOX: "FEDEX_EXTRA_SMALL_BOX", FEDEX_TUBE: "FEDEX_TUBE"
};
const SIG = { direct: "DIRECT", indirect: "INDIRECT", adult: "ADULT" };

function party(p) {
  const streets = [p.address1, p.address2].filter(Boolean).map(s => String(s).slice(0, 35));
  return {
    contact: {
      personName: String(p.name || p.company || "Shipping Dept").slice(0, 70),
      companyName: String(p.company || "").slice(0, 70) || undefined,
      phoneNumber: String(p.phone || "").replace(/\D/g, "").slice(0, 15) || "8015550100",
      emailAddress: p.email || undefined
    },
    address: {
      streetLines: streets.length ? streets : ["-"],
      city: String(p.city || "").slice(0, 35),
      stateOrProvinceCode: String(p.state || "").toUpperCase().slice(0, 2),
      postalCode: String(p.zip || "").trim(),
      countryCode: (p.country || "US").toUpperCase()
    }
  };
}

exports.handler = async (event) => {
  const respond = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  if (event.httpMethod === "OPTIONS") return respond(200, { ok: true });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return respond(200, { ok: false, error: "Bad request body" }); }
  const action = body.action || "ship";

  if (!CLIENT_ID || !CLIENT_SECRET || !ACCOUNT) {
    const err = "FedEx isn't configured: set FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET and FEDEX_ACCOUNT in Netlify (normal vars, then redeploy).";
    if (action === "diag") return respond(200, { ok: true, diag: { providerAccounts: { ok: false, status: 0, raw: err, providers: [], accounts: [] } } });
    return respond(200, { ok: false, error: err });
  }

  if (action === "status") return respond(200, { ok: true, booked: false, note: "Direct FedEx books synchronously — nothing is ever pending." });
  if (action === "flushCache") return respond(200, { ok: true });

  if (action === "diag" || action === "test") {
    try {
      await getToken();
      return respond(200, {
        ok: true,
        diag: { providerAccounts: { ok: true, providers: ["fedex"], accounts: [{ providerCode: "fedex", id: "fedex-direct", accountNumber: ACCOUNT }] }, env: ENV, base: BASE }
      });
    } catch (e) {
      return respond(200, { ok: true, diag: { providerAccounts: { ok: false, status: 401, raw: (e && e.message) || "Auth failed", providers: [], accounts: [] } } });
    }
  }

  if (action !== "ship") return respond(200, { ok: false, error: "Unknown action: " + action });

  const o = body.order || {};
  const sender = o.sender || {};
  const receiver = o.receiver || {};
  const acct = String(o.fedexAccount || (body.account && body.account.fedexAccount) || ACCOUNT).replace(/\D/g, "") || ACCOUNT;
  const { serviceType, oneRate } = serviceTypeFor(o);
  const intl = (receiver.country || "US").toUpperCase() !== (sender.country || "US").toUpperCase();
  const pieces = (Array.isArray(o.pieces) && o.pieces.length ? o.pieces : [{ weight: 1, length: 12, width: 9, height: 4 }]);
  const totalWeight = pieces.reduce((a, p) => a + (+p.weight || 0), 0) || 1;
  const declaredTotal = pieces.reduce((a, p) => a + (+p.declaredValue || 0), 0) || (+o.insuranceAmount || 0);

  const refs = [];
  if (o.reference) refs.push({ customerReferenceType: "CUSTOMER_REFERENCE", value: String(o.reference).slice(0, 40) });
  if (o.invoiceNo) refs.push({ customerReferenceType: "INVOICE_NUMBER", value: String(o.invoiceNo).slice(0, 40) });
  if (o.poNo) refs.push({ customerReferenceType: "P_O_NUMBER", value: String(o.poNo).slice(0, 40) });

  const lineItems = pieces.map((p, i) => {
    const it = {
      weight: { units: "LB", value: Math.max(0.1, +p.weight || 1) },
      dimensions: { length: Math.max(1, Math.round(+p.length || 12)), width: Math.max(1, Math.round(+p.width || 9)), height: Math.max(1, Math.round(+p.height || 4)), units: "IN" }
    };
    if (i === 0 && refs.length) it.customerReferences = refs;
    const sig = SIG[String(o.signatureOption || "none").toLowerCase()];
    if (sig) it.packageSpecialServices = { signatureOptionType: sig };
    if (i === 0 && +o.insuranceAmount > 0) it.declaredValue = { amount: Math.round(+o.insuranceAmount * 100) / 100, currency: "USD" };
    return it;
  });

  let payment = { paymentType: "SENDER", payor: { responsibleParty: { accountNumber: { value: acct } } } };
  if (o.billingParty === "third_party" && o.billingAccount) payment = { paymentType: "THIRD_PARTY", payor: { responsibleParty: { accountNumber: { value: String(o.billingAccount).replace(/\D/g, "") } } } };
  else if (o.billingParty === "receiver" && o.billingAccount) payment = { paymentType: "RECIPIENT", payor: { responsibleParty: { accountNumber: { value: String(o.billingAccount).replace(/\D/g, "") } } } };

  const shipmentSpecial = [];
  if (o.saturdayDelivery) shipmentSpecial.push("SATURDAY_DELIVERY");
  if (oneRate) shipmentSpecial.push("FEDEX_ONE_RATE");

  const requestedShipment = {
    shipper: party({ ...sender, country: sender.country || "US" }),
    recipients: [Object.assign(party({ ...receiver, country: receiver.country || "US" }), {})],
    shipDatestamp: (o.shipmentDate && /^\d{4}-\d{2}-\d{2}$/.test(o.shipmentDate)) ? o.shipmentDate : new Date().toISOString().slice(0, 10),
    serviceType,
    packagingType: PKG[String(o.packageTypeCode || "").trim()] || PKG[String(o.packageTypeCode || "").toLowerCase()] || "YOUR_PACKAGING",
    pickupType: "USE_SCHEDULED_PICKUP",
    blockInsightVisibility: false,
    shippingChargesPayment: payment,
    labelSpecification: { imageType: "PDF", labelStockType: "PAPER_4X6" },
    requestedPackageLineItems: lineItems
  };
  requestedShipment.recipients[0].address.residential = !!o.residential;
  if (shipmentSpecial.length) requestedShipment.shipmentSpecialServices = { specialServiceTypes: shipmentSpecial };
  if (intl) {
    const customsVal = Math.max(1, Math.round((declaredTotal || 1) * 100) / 100);
    requestedShipment.customsClearanceDetail = {
      dutiesPayment: { paymentType: "SENDER", payor: { responsibleParty: { accountNumber: { value: acct } } } },
      isDocumentOnly: false,
      commodities: [{
        description: String(o.contentDescription || "Merchandise").slice(0, 450),
        countryOfManufacture: (sender.country || "US").toUpperCase(),
        quantity: 1, quantityUnits: "PCS",
        unitPrice: { amount: customsVal, currency: "USD" },
        customsValue: { amount: customsVal, currency: "USD" },
        weight: { units: "LB", value: totalWeight }
      }]
    };
  }

  try {
    const token = await getToken();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    const r = await fetch(BASE + "/ship/v1/shipments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, "x-locale": "en_US" },
      body: JSON.stringify({ labelResponseOptions: "LABEL", accountNumber: { value: acct }, requestedShipment }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j.errors && j.errors[0] && (j.errors[0].message || j.errors[0].code)) || ("FedEx ship error " + r.status);
      return respond(200, { ok: false, error: msg, _status: r.status });
    }
    const ts = j.output && j.output.transactionShipments && j.output.transactionShipments[0];
    if (!ts) return respond(200, { ok: false, error: "FedEx returned no shipment in the response." });
    const tracking = ts.masterTrackingNumber || (ts.pieceResponses && ts.pieceResponses[0] && ts.pieceResponses[0].trackingNumber) || "";
    const labels = [];
    (ts.pieceResponses || []).forEach(pr => (pr.packageDocuments || []).forEach(doc => { if (doc.encodedLabel) labels.push(doc.encodedLabel); }));
    if (!labels.length && ts.shipmentDocuments) ts.shipmentDocuments.forEach(doc => { if (doc.encodedLabel) labels.push(doc.encodedLabel); });
    return respond(200, {
      ok: true, booked: true,
      orderId: tracking || String(Date.now()),
      bookNumber: tracking,
      tracking,
      labelPdfBase64: labels[0] || null,
      labels: labels.length > 1 ? labels : undefined,
      labelError: labels.length ? null : "Booked, but FedEx returned no label document — reprint from FedEx Ship Manager.",
      serviceName: ts.serviceName || serviceType,
      env: ENV
    });
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "FedEx took too long to respond" : ((e && e.message) || "FedEx request failed");
    return respond(200, { ok: false, error: msg });
  }
};
