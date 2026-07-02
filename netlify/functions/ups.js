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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return J({ ok: false, error: "POST only" });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch {}
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
