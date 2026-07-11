/* ════════════════════════════════════════════════════════════════════════
   POST /.netlify/functions/ups   —   live UPS APIs
   ------------------------------------------------------------------------
   action:"test"  → OAuth only: verifies the Client ID/Secret are valid.
   action:"rate"  → Rating API (Shop): live UPS rates for a shipment.
   OAuth: POST /security/v1/oauth/token (client_credentials, Basic auth).
   Creds from env (UPS_CLIENT_ID, UPS_CLIENT_SECRET, UPS_ACCOUNT) — the
   request body can override, so the app can pass a merchant's own account.
   Set UPS_ENV=test to hit the CIE sandbox (wwwcie.ups.com).
   Always returns HTTP 200 + JSON.
   ════════════════════════════════════════════════════════════════════════ */

const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));

function CC(c){ if(!c) return "US"; const t=String(c).trim(); if(t.length===2) return t.toUpperCase();
  const m={"united states":"US","united states of america":"US","usa":"US","canada":"CA","mexico":"MX","united kingdom":"GB","puerto rico":"PR"};
  return m[t.toLowerCase()]||"US"; }

// UPS service code → friendly name (US domestic + common intl)
const UPS_SERVICES = {
  "01":"UPS Next Day Air","02":"UPS 2nd Day Air","03":"UPS Ground","07":"UPS Worldwide Express",
  "08":"UPS Worldwide Expedited","11":"UPS Standard","12":"UPS 3 Day Select","13":"UPS Next Day Air Saver",
  "14":"UPS Next Day Air Early","54":"UPS Worldwide Express Plus","59":"UPS 2nd Day Air A.M.","65":"UPS Worldwide Saver",
};

function creds(body){
  const a = (body && body.account) || {};
  const test = S(a.env || process.env.UPS_ENV).toLowerCase() === "test";
  return {
    base: test ? "https://wwwcie.ups.com" : "https://onlinetools.ups.com",
    clientId: S(a.clientId || process.env.UPS_CLIENT_ID).trim(),
    clientSecret: S(a.clientSecret || process.env.UPS_CLIENT_SECRET).trim(),
    account: S(a.account || process.env.UPS_ACCOUNT).trim(),
  };
}

let _tok = null; // { token, exp } cached across warm invocations, keyed by clientId

async function token(c){
  if (_tok && _tok.key === c.clientId && _tok.exp > Date.now() + 30000) return _tok.token;
  const basic = Buffer.from(c.clientId + ":" + c.clientSecret).toString("base64");
  const r = await fetch(c.base + "/security/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": "Basic " + basic, "x-merchant-id": c.account || "" },
    body: "grant_type=client_credentials",
  });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  if (!r.ok || !d || !d.access_token) {
    const msg = (d && (d.response && d.response.errors ? JSON.stringify(d.response.errors) : (d.error_description || d.error))) || text.slice(0, 240);
    throw new Error("UPS auth HTTP " + r.status + (msg ? ": " + msg : ""));
  }
  _tok = { key: c.clientId, token: d.access_token, exp: Date.now() + (Number(d.expires_in || 3600) * 1000) };
  return _tok.token;
}

function addr(a){
  a = a || {};
  const lines = [a.address1, a.address2, a.address3].filter(Boolean).map(S);
  return {
    AddressLine: lines.length ? lines : [""],
    City: S(a.city),
    StateProvinceCode: S(a.state).toUpperCase().slice(0, 2),
    PostalCode: S(a.zip).slice(0, 10),
    CountryCode: CC(a.country),
  };
}

function ratePackages(pieces){
  const list = (Array.isArray(pieces) && pieces.length ? pieces : [{ weight: 1, L: 10, W: 8, H: 6 }]);
  return list.map((p) => ({
    PackagingType: { Code: "02" }, // customer-supplied package
    Dimensions: {
      UnitOfMeasurement: { Code: "IN" },
      Length: S(Math.max(1, Math.round(+p.L || +p.length || 1))),
      Width: S(Math.max(1, Math.round(+p.W || +p.width || 1))),
      Height: S(Math.max(1, Math.round(+p.H || +p.height || 1))),
    },
    PackageWeight: {
      UnitOfMeasurement: { Code: "LBS" },
      Weight: S(Math.max(0.1, +p.weight || 1)),
    },
  }));
}

async function rate(c, body){
  const tok = await token(c);
  const from = body.from || {};
  const to = body.to || {};
  const residential = !!body.residential;
  const shipTo = addr(to);
  if (residential) shipTo.ResidentialAddressIndicator = "Y";
  const req = {
    RateRequest: {
      Request: { SubVersion: "2409", TransactionReference: { CustomerContext: "shippingcloud" } },
      Shipment: {
        Shipper: { Name: S(from.company || from.name || "Shipper").slice(0, 35), ShipperNumber: c.account, Address: addr(from) },
        ShipTo: { Name: S(to.name || to.company || "Recipient").slice(0, 35), Address: shipTo },
        ShipFrom: { Name: S(from.company || from.name || "Shipper").slice(0, 35), Address: addr(from) },
        NumOfPieces: S((body.pieces || []).length || 1),
        Package: ratePackages(body.pieces),
      },
    },
  };
  const r = await fetch(c.base + "/api/rating/v2409/Shop", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + tok,
      "Content-Type": "application/json",
      "transId": "sc" + Date.now(),
      "transactionSrc": "shippingcloud",
    },
    body: JSON.stringify(req),
  });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  if (!r.ok || !d || !d.RateResponse) {
    const errs = d && d.response && d.response.errors ? d.response.errors.map((e) => e.message).join("; ") : text.slice(0, 240);
    return { ok: false, error: "UPS rating HTTP " + r.status + (errs ? ": " + errs : "") };
  }
  const rated = d.RateResponse.RatedShipment || [];
  const arr = Array.isArray(rated) ? rated : [rated];
  const rates = arr.map((rs) => {
    const code = S(rs.Service && rs.Service.Code);
    const total = rs.TotalCharges && rs.TotalCharges.MonetaryValue;
    const neg = rs.NegotiatedRateCharges && rs.NegotiatedRateCharges.TotalCharge && rs.NegotiatedRateCharges.TotalCharge.MonetaryValue;
    const cost = parseFloat(neg || total || 0);
    return {
      carrier: "UPS",
      key: "ups_" + code,
      label: UPS_SERVICES[code] || ("UPS service " + code),
      serviceCode: code,
      carrierCode: "UPS",
      packageTypeCode: "02",
      cost: Math.round(cost * 100) / 100,
      currency: S(rs.TotalCharges && rs.TotalCharges.CurrencyCode) || "USD",
      negotiated: !!neg,
    };
  }).filter((x) => x.cost > 0).sort((a, b) => a.cost - b.cost);
  return { ok: true, _fn: "ups-v1", rates };
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
  if (event.httpMethod !== "POST") return J({ ok: false, error: "POST only" });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch {}
  const gateAuth = scAuth(body);
  if (!gateAuth) return J({ ok: false, authFailed: true, error: "Sign in first \u2014 your session may have expired." });
  if (!scAllow("ups:" + gateAuth.uid, 120)) return J({ ok: false, error: "Too many requests at once \u2014 give it a few seconds." });
  const c = creds(body);
  if (!c.clientId || !c.clientSecret) return J({ ok: false, error: "Missing UPS Client ID / Secret (set them in the UPS panel or as UPS_CLIENT_ID / UPS_CLIENT_SECRET)." });
  const action = body.action || "test";
  try {
    if (action === "test") {
      await token(c);
      return J({ ok: true, _fn: "ups-v1", msg: "UPS connected" + (c.account ? " · account " + c.account : " · no account # yet (needed for rating)"), hasAccount: !!c.account });
    }
    if (action === "rate") {
      if (!c.account) return J({ ok: false, error: "UPS account number required for rating. Add it in the UPS panel." });
      return J(await rate(c, body));
    }
    return J({ ok: false, error: "Unknown action: " + action });
  } catch (e) {
    return J({ ok: false, error: (e && e.message) || "UPS error" });
  }
};
