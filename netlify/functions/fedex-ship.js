/* ════════════════════════════════════════════════════════════════════════
   POST /.netlify/functions/fedex-ship  —  direct FedEx Ship API (label certification)
   ------------------------------------------------------------------------
   Talks to FedEx's own REST API (NOT England/Webship). Built for the label
   certification pass: generate real sandbox labels for each service, download
   the PDFs, submit them to FedEx, flip FEDEX_ENV=production when certified.

   Credentials come ONLY from Netlify environment variables (never the repo —
   the repo is public):
     FEDEX_API_KEY          — API key from the Developer Portal project
     FEDEX_SECRET_KEY       — Secret key from the same project
     FEDEX_ACCOUNT_NUMBER   — the TEST shipping account shown on the project
                              page next to the test key (9 digits)
     FEDEX_ENV              — "sandbox" (default) or "production"
   All three must be set as NORMAL (non-secret) vars, then redeploy.

   Actions: {action:"status"} → config check + OAuth ping
            {action:"ship", shipment:{...}} → create label, returns
              {ok, tracking, service, labelBase64, labelType:"PDF"}
   Always returns HTTP 200 with JSON; FedEx errors are surfaced verbatim in
   .error/.detail so certification failures are debuggable from the UI.
   ════════════════════════════════════════════════════════════════════════ */

const J = (obj) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const BASE = () => (String(process.env.FEDEX_ENV || "sandbox").toLowerCase() === "production"
  ? "https://apis.fedex.com" : "https://apis-sandbox.fedex.com");

const CFG = () => ({
  key: process.env.FEDEX_API_KEY || "",
  secret: process.env.FEDEX_SECRET_KEY || "",
  account: process.env.FEDEX_ACCOUNT_NUMBER || "",
});

/* OAuth token, cached in the warm lambda for its lifetime. */
let TOK = { v: null, exp: 0 };
async function token() {
  if (TOK.v && Date.now() < TOK.exp - 60000) return TOK.v;
  const { key, secret } = CFG();
  const r = await fetch(BASE() + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&client_id=" + encodeURIComponent(key) + "&client_secret=" + encodeURIComponent(secret),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const msg = (j.errors && j.errors[0] && (j.errors[0].message || j.errors[0].code)) || ("OAuth failed (HTTP " + r.status + ")");
    const err = new Error(msg); err.detail = j; throw err;
  }
  TOK = { v: j.access_token, exp: Date.now() + (Number(j.expires_in || 3600) * 1000) };
  return TOK.v;
}

const SERVICE_TYPES = {
  ground: "FEDEX_GROUND",
  home: "GROUND_HOME_DELIVERY",
  express_saver: "FEDEX_EXPRESS_SAVER",
  "2day": "FEDEX_2_DAY",
  "2day_am": "FEDEX_2_DAY_AM",
  standard_overnight: "STANDARD_OVERNIGHT",
  priority_overnight: "PRIORITY_OVERNIGHT",
  first_overnight: "FIRST_OVERNIGHT",
};
const SIG = { none: null, service_default: "SERVICE_DEFAULT", indirect: "INDIRECT", direct: "DIRECT", adult: "ADULT", no_signature: "NO_SIGNATURE_REQUIRED" };

function addr(a, residential) {
  return {
    contact: {
      personName: String(a.name || "").slice(0, 70) || "Shipping Dept",
      phoneNumber: String(a.phone || "8015550100").replace(/\D/g, "").slice(0, 15) || "8015550100",
      companyName: String(a.company || "").slice(0, 70) || undefined,
    },
    address: {
      streetLines: [a.address1, a.address2].filter(Boolean).map((s) => String(s).slice(0, 35)),
      city: String(a.city || "").slice(0, 35),
      stateOrProvinceCode: String(a.state || "").toUpperCase().slice(0, 2),
      postalCode: String(a.zip || "").slice(0, 10),
      countryCode: String(a.country || "US").toUpperCase().slice(0, 2),
      residential: !!residential,
    },
  };
}

async function ship(s) {
  const { account } = CFG();
  const svc = SERVICE_TYPES[s.service] || s.service || "FEDEX_GROUND";
  const residential = svc === "GROUND_HOME_DELIVERY" ? true : !!s.residential;
  const pkg = {
    weight: { units: "LB", value: Math.max(0.1, Number(s.weight) || 1) },
  };
  if (Number(s.L) && Number(s.W) && Number(s.H)) {
    pkg.dimensions = { length: Math.round(+s.L), width: Math.round(+s.W), height: Math.round(+s.H), units: "IN" };
  }
  if (Number(s.declaredValue) > 0) pkg.declaredValue = { amount: Number(s.declaredValue), currency: "USD" };
  const sig = SIG[s.signature] || null;
  if (sig) pkg.packageSpecialServices = { specialServiceTypes: ["SIGNATURE_OPTION"], signatureOptionType: sig };

  const body = {
    labelResponseOptions: "LABEL",
    requestedShipment: {
      shipper: addr(s.from || {}, false),
      recipients: [addr(s.to || {}, residential)],
      shipDatestamp: (s.shipDate || new Date().toISOString().slice(0, 10)),
      serviceType: svc,
      packagingType: s.packaging || "YOUR_PACKAGING",
      pickupType: s.pickupType || "USE_SCHEDULED_PICKUP",
      blockInsightVisibility: false,
      shippingChargesPayment: { paymentType: "SENDER" },
      labelSpecification: {
        imageType: s.labelFormat === "ZPL" ? "ZPLII" : "PDF",
        labelStockType: s.labelFormat === "ZPL" ? "STOCK_4X6" : (s.labelStock || "PAPER_4X6"),
      },
      requestedPackageLineItems: [pkg],
    },
    accountNumber: { value: account },
  };
  if (s.reference) {
    body.requestedShipment.requestedPackageLineItems[0].customerReferences = [{ customerReferenceType: "CUSTOMER_REFERENCE", value: String(s.reference).slice(0, 40) }];
  }

  const t = await token();
  const r = await fetch(BASE() + "/ship/v1/shipments", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + t, "x-locale": "en_US" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = (j.errors && j.errors[0]) || {};
    return { ok: false, error: e.message || ("FedEx HTTP " + r.status), code: e.code || null, detail: j.errors || j, sent: body };
  }
  const ts = j.output && j.output.transactionShipments && j.output.transactionShipments[0];
  if (!ts) return { ok: false, error: "FedEx returned no shipment.", detail: j };
  const piece = (ts.pieceResponses && ts.pieceResponses[0]) || {};
  const doc = (piece.packageDocuments && piece.packageDocuments[0]) || {};
  return {
    ok: true,
    tracking: ts.masterTrackingNumber || piece.trackingNumber || piece.masterTrackingNumber || "",
    service: ts.serviceType || svc,
    serviceName: (ts.serviceName || "").trim() || undefined,
    labelBase64: doc.encodedLabel || null,
    labelType: doc.docType || (s.labelFormat === "ZPL" ? "ZPL" : "PDF"),
    env: String(process.env.FEDEX_ENV || "sandbox"),
    alerts: ts.alerts || undefined,
  };
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
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*" }, body: "" };
  let p = {};
  try { p = JSON.parse(event.body || "{}"); } catch (e) { return J({ ok: false, error: "Bad JSON body." }); }
  const gateAuth = scAuth(p);
  if (!gateAuth) return J({ ok: false, authFailed: true, error: "Sign in first \u2014 your session may have expired." });
  if (!scAllow("fedexship:" + gateAuth.uid, 120)) return J({ ok: false, error: "Too many requests at once \u2014 give it a few seconds." });
  const { key, secret, account } = CFG();

  if (p.action === "status") {
    const missing = [!key && "FEDEX_API_KEY", !secret && "FEDEX_SECRET_KEY", !account && "FEDEX_ACCOUNT_NUMBER"].filter(Boolean);
    if (missing.length) return J({ ok: true, configured: false, missing, env: String(process.env.FEDEX_ENV || "sandbox") });
    try { await token(); return J({ ok: true, configured: true, auth: true, env: String(process.env.FEDEX_ENV || "sandbox"), account: account.slice(0, 3) + "•••" + account.slice(-2) }); }
    catch (e) { return J({ ok: true, configured: true, auth: false, error: e.message, detail: e.detail || null, env: String(process.env.FEDEX_ENV || "sandbox") }); }
  }

  if (p.action === "ship") {
    const missing = [!key && "FEDEX_API_KEY", !secret && "FEDEX_SECRET_KEY", !account && "FEDEX_ACCOUNT_NUMBER"].filter(Boolean);
    if (missing.length) return J({ ok: false, error: "Missing Netlify env vars: " + missing.join(", ") + ". Add them as NORMAL (non-secret) vars and redeploy." });
    try { return J(await ship(p.shipment || {})); }
    catch (e) { return J({ ok: false, error: e.message || "FedEx request failed.", detail: e.detail || null }); }
  }

  return J({ ok: false, error: "Unknown action." });
};
