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
  /* the app's FEDEX_ONERATE .code vocabulary (what quote rows carry) — missing these meant every
     One Rate booking fell to YOUR_PACKAGING + the FEDEX_ONE_RATE special, which FedEx rejects as
     "package type not valid" */
  fedex_envelope: "FEDEX_ENVELOPE", fedex_pak: "FEDEX_PAK", fedex_extra_small_box: "FEDEX_EXTRA_SMALL_BOX",
  fedex_small_box: "FEDEX_SMALL_BOX", fedex_medium_box: "FEDEX_MEDIUM_BOX", fedex_large_box: "FEDEX_LARGE_BOX",
  fedex_extra_large_box: "FEDEX_EXTRA_LARGE_BOX", fedex_tube: "FEDEX_TUBE",
  FEDEX_ENVELOPE: "FEDEX_ENVELOPE", FEDEX_PAK: "FEDEX_PAK", FEDEX_SMALL_BOX: "FEDEX_SMALL_BOX",
  FEDEX_MEDIUM_BOX: "FEDEX_MEDIUM_BOX", FEDEX_LARGE_BOX: "FEDEX_LARGE_BOX", FEDEX_EXTRA_LARGE_BOX: "FEDEX_EXTRA_LARGE_BOX",
  FEDEX_EXTRA_SMALL_BOX: "FEDEX_EXTRA_SMALL_BOX", FEDEX_TUBE: "FEDEX_TUBE"
};
const SIG = { direct: "DIRECT", indirect: "INDIRECT", adult: "ADULT" };
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
      countryCode: toISO(p.country || "US")
    }
  };
}

/* ── per-site backend switch ─────────────────────────────────────────────
   Set CARRIER_BACKEND=england in a Netlify site's env vars and this function
   delegates every request to ./ship-england.js (the pre-cutover England/Rock Solid
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
    if (!d || !d.uid || !d.exp || Date.now() > d.exp) return null;
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
  if (!gateAuth) return respond(200, { ok: false, authFailed: true, error: "Sign in to book labels." });
  if (!scAllow("ship:" + gateAuth.uid, 120)) return respond(200, { ok: false, error: "Too many booking requests at once \u2014 give it a few seconds." });
  if ((process.env.CARRIER_BACKEND || "fedex").toLowerCase() === "england") {
    try { return await require("./ship-england.js").handler(event); }
    catch (e) {
      const msg = "Booking is temporarily unavailable — try again in a moment.";
      return respond(200, {ok:false,error:msg});
    }
  }
  if (event.httpMethod === "OPTIONS") return respond(200, { ok: true });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return respond(200, { ok: false, error: "Bad request body" }); }
  const action = body.action || "ship";

  if (!CLIENT_ID || !CLIENT_SECRET || !ACCOUNT) {
    const err = "Booking isn't available on this site yet.";
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
  const intl = toISO(receiver.country || "US") !== toISO(sender.country || "US");
  const pieces = (Array.isArray(o.pieces) && o.pieces.length ? o.pieces : [{ weight: 1, length: 12, width: 9, height: 4 }]);
  const totalWeight = pieces.reduce((a, p) => a + (+p.weight || 0), 0) || 1;
  const money$ = (v) => +String(v == null ? "" : v).replace(/[^0-9.]/g, "") || 0;   // "$1,000" → 1000, junk → 0
  const declaredTotal = pieces.reduce((a, p) => a + money$(p.declaredValue), 0) || money$(o.insuranceAmount);

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
    /* Declared value is PER PACKAGE at FedEx. Honor each piece's own declaredValue (the app
       sends one per box — same-on-each or per-box amounts alike). Legacy fallback: if no piece
       carries one, put the order-level insuranceAmount on the first box like before. */
    const pdv = money$(p.declaredValue);
    if (pdv > 0) it.declaredValue = { amount: Math.round(pdv * 100) / 100, currency: "USD" };
    else if (i === 0 && !pieces.some(pp => money$(pp.declaredValue) > 0) && money$(o.insuranceAmount) > 0) it.declaredValue = { amount: Math.round(money$(o.insuranceAmount) * 100) / 100, currency: "USD" };
    return it;
  });

  /* For SENDER, FedEx derives the payor from the shipment's root accountNumber —
     including an explicit payor invites "Account Number Mismatch" rejections, so omit it. */
  let payment = { paymentType: "SENDER" };
  if (o.billingParty === "third_party" && o.billingAccount) payment = { paymentType: "THIRD_PARTY", payor: { responsibleParty: { accountNumber: { value: String(o.billingAccount).replace(/\D/g, "") } } } };
  else if (o.billingParty === "receiver" && o.billingAccount) payment = { paymentType: "RECIPIENT", payor: { responsibleParty: { accountNumber: { value: String(o.billingAccount).replace(/\D/g, "") } } } };

  const shipmentSpecial = [];
  if (o.saturdayDelivery) shipmentSpecial.push("SATURDAY_DELIVERY");
  if (oneRate) shipmentSpecial.push("FEDEX_ONE_RATE");

  /* FedEx packaging criteria, enforced here so bad combos fail with a plain-English message
     instead of FedEx's "package type not valid":
     1. One Rate REQUIRES FedEx packaging (envelope/pak/box/tube) — YOUR_PACKAGING + ONE_RATE is invalid.
     2. FedEx packaging is Express-only — Ground / Home Delivery / Ground Economy must be YOUR_PACKAGING. */
  let packagingType = PKG[String(o.packageTypeCode || "").trim()] || PKG[String(o.packageTypeCode || "").toLowerCase()] || "YOUR_PACKAGING";
  const groundish = /GROUND|HOME_DELIVERY|SMART_POST/.test(serviceType);
  if (oneRate && packagingType === "YOUR_PACKAGING") {
    return respond(200, { ok: false, error: "One Rate needs a FedEx box/envelope: this booking arrived with no recognizable FedEx packaging code (got \"" + (o.packageTypeCode || "none") + "\"). Pick the FedEx box on the shipment, or book the standard (non-One Rate) service instead." });
  }
  if (!oneRate && groundish && packagingType !== "YOUR_PACKAGING") packagingType = "YOUR_PACKAGING";   // FedEx boxes are invalid on ground services — coerce rather than fail the label

  const requestedShipment = {
    shipper: party({ ...sender, country: sender.country || "US" }),
    recipients: [Object.assign(party({ ...receiver, country: receiver.country || "US" }), {})],
    shipDatestamp: (o.shipmentDate && /^\d{4}-\d{2}-\d{2}$/.test(o.shipmentDate)) ? o.shipmentDate : new Date().toISOString().slice(0, 10),
    serviceType,
    packagingType,
    pickupType: "USE_SCHEDULED_PICKUP",
    blockInsightVisibility: false,
    shippingChargesPayment: payment,
    labelSpecification: { imageType: "PDF", labelStockType: ({ "4x6": "PAPER_4X6", "4x625": "PAPER_4X6", "4x65": "PAPER_4X6", "4x675": "PAPER_4X675", "4x8": "PAPER_4X8", "4x9": "PAPER_4X9", "letter": "PAPER_85X11_TOP_HALF_LABEL" })[o.labelStock] || "PAPER_4X6" },
    requestedPackageLineItems: lineItems
  };
  requestedShipment.recipients[0].address.residential = !!o.residential;
  if (shipmentSpecial.length) requestedShipment.shipmentSpecialServices = { specialServiceTypes: shipmentSpecial };
  /* Ground Economy (SmartPost) needs the account's hub on the SHIP call too — quote.js gates the
     rates on it, but booking without it is a guaranteed FedEx rejection. Single-package only. */
  if (serviceType === "SMART_POST") {
    const hub = String(o.smartPostHub || process.env.FEDEX_SMARTPOST_HUB || "").trim();
    if (!hub) return respond(200, { ok: false, error: "Ground Economy isn't enabled on this account yet — pick another service or contact support." });
    if (pieces.length > 1) return respond(200, { ok: false, error: "Ground Economy is single-package only — ship the boxes as separate shipments, or pick Ground/Home Delivery for the multipiece." });
    requestedShipment.smartPostInfoDetail = { indicia: "PARCEL_SELECT", hubId: hub };
  }
  /* Receiver-billed shipments MUST carry the receiver's FedEx account — silently falling back to
     SENDER made the shipper eat the freight with no warning. */
  if (o.billingParty === "receiver" && !o.billingAccount) {
    return respond(200, { ok: false, error: "Bill-to-receiver needs the receiver's FedEx account number — add it to the shipment (or bill the sender / a third party)." });
  }
  if (intl) {
    if (!(declaredTotal > 0)) return respond(200, { ok: false, error: "International shipments need a customs value — enter the shipment's declared value (Insure $ / per-box values) so the customs declaration is truthful. FedEx rejects (and customs holds) $0 declarations." });
    const customsVal = Math.max(1, Math.round((declaredTotal || 1) * 100) / 100);
    requestedShipment.customsClearanceDetail = {
      dutiesPayment: { paymentType: "SENDER" },
      isDocumentOnly: false,
      commodities: [{
        description: String(o.contentDescription || "Merchandise").slice(0, 450),
        countryOfManufacture: toISO(sender.country || "US"),
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
      let msg = (Array.isArray(j.errors) && j.errors.length ? j.errors.map((e) => e.message || e.code).filter(Boolean).join("; ") : "") || ("FedEx ship error " + r.status);
      if (/mismatch|not\s*authorized|account.*(invalid|not\s*found)/i.test(msg)) {
        msg = "FedEx doesn't recognize account #" + (String(acct).slice(0, 3) + "\u2022\u2022\u2022" + String(acct).slice(-2)) + " on your API credentials — it must be added to your FedEx Developer Portal organization (Manage Organization \u2192 Shipping accounts, using the account's billing address) and attached to your project. FedEx said: " + msg;
      }
      return respond(200, { ok: false, error: msg, _status: r.status });
    }
    const ts = j.output && j.output.transactionShipments && j.output.transactionShipments[0];
    if (!ts) return respond(200, { ok: false, error: "FedEx returned no shipment in the response." });
    const tracking = ts.masterTrackingNumber || (ts.pieceResponses && ts.pieceResponses[0] && ts.pieceResponses[0].trackingNumber) || "";
    /* Label harvest: FedEx puts the base64 under different keys depending on the
       response shape — encodedLabel is standard for labelResponseOptions:LABEL, but
       sweep every document array and every plausible field so a variant cannot
       leave the app label-less. */
    const labels = [];
    const grab = (doc) => { if (!doc) return; const b64 = doc.encodedLabel || doc.content || (doc.parts && doc.parts[0] && doc.parts[0].image) || null; if (b64 && typeof b64 === "string" && b64.length > 20 && /^[A-Za-z0-9+\/=\r\n]+$/.test(b64.slice(0, 400))) labels.push(b64); };
    (ts.pieceResponses || []).forEach(pr => { (pr.packageDocuments || pr.documents || []).forEach(grab); });
    (ts.shipmentDocuments || ts.documents || []).forEach(grab);
    let docShape = null;
    if (!labels.length) {
      try {
        const pr0 = ts.pieceResponses && ts.pieceResponses[0];
        docShape = "transactionShipments keys: " + Object.keys(ts).join(",")
          + (pr0 ? " | pieceResponses[0] keys: " + Object.keys(pr0).join(",") : "")
          + (pr0 && pr0.packageDocuments && pr0.packageDocuments[0] ? " | packageDocuments[0] keys: " + Object.keys(pr0.packageDocuments[0]).join(",") : "");
      } catch (e) {}
    }
    return respond(200, {
      ok: true, booked: true,
      orderId: tracking || String(Date.now()),
      bookNumber: tracking,
      tracking,
      labelPdfBase64: labels[0] || null,
      labels: labels.length > 1 ? labels : undefined,
      labelError: labels.length ? null : ("Booked, but no label was found in the FedEx response." + (docShape ? " [" + docShape + "]" : "")),
      serviceName: ts.serviceName || serviceType,
      env: ENV
    });
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "FedEx took too long to respond" : ((e && e.message) || "FedEx request failed");
    return respond(200, { ok: false, error: msg });
  }
};
