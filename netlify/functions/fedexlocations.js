/* ════════════════════════════════════════════════════════════════════════
   fedexlocations.js — FedEx Location Search (drop-off / hold-at-location finder)
   Powers the Ship page "Find a FedEx location near the recipient" panel.
     in:  { token, postalCode, countryCode|country, city, state, streetLines,
            radius (mi), holdService ("FEDEX_GROUND"|"FEDEX_EXPRESS"), max }
     out: { ok:true, locations:[{ id, type, name, address1, city, state, zip,
            country, phone, distance, distanceUnits, hours, holdEligible }] }
   Same OAuth creds + session gate as quote.js.
   ════════════════════════════════════════════════════════════════════════ */

const ENV = (process.env.FEDEX_ENV || "production").toLowerCase();
const BASE = ENV === "sandbox" ? "https://apis-sandbox.fedex.com" : "https://apis.fedex.com";
const CLIENT_ID = process.env.FEDEX_CLIENT_ID || process.env.FEDEX_API_KEY || process.env.FEDEX_KEY || "";
const CLIENT_SECRET = process.env.FEDEX_CLIENT_SECRET || process.env.FEDEX_SECRET_KEY || process.env.FEDEX_SECRET || "";

const ISO2 = { "united states":"US","usa":"US","u.s.":"US","u.s.a.":"US","united states of america":"US","canada":"CA","mexico":"MX","united kingdom":"GB","great britain":"GB","uk":"GB","england":"GB","australia":"AU","germany":"DE","france":"FR","italy":"IT","spain":"ES","netherlands":"NL","belgium":"BE","switzerland":"CH","austria":"AT","sweden":"SE","norway":"NO","denmark":"DK","finland":"FI","ireland":"IE","portugal":"PT","poland":"PL","japan":"JP","china":"CN","hong kong":"HK","taiwan":"TW","south korea":"KR","singapore":"SG","india":"IN","new zealand":"NZ","ukraine":"UA" };
function toISO(v) { const s = String(v == null ? "" : v).trim(); if (!s) return "US"; if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase(); return ISO2[s.toLowerCase()] || s; }

let _tok = null;
async function getToken() {
  if (_tok && Date.now() < _tok.exp - 60000) return _tok.token;
  const r = await fetch(BASE + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("FedEx auth failed (" + r.status + "): " + ((j.errors && j.errors[0] && j.errors[0].message) || JSON.stringify(j).slice(0, 200)));
  _tok = { token: j.access_token, exp: Date.now() + ((+j.expires_in || 3000) * 1000) };
  return _tok.token;
}

/* ── session gate (mirror quote.js) — the account's own signed-in token or an internal HMAC ── */
const scCrypto = require("crypto");
const scSecret = () => { const s = (process.env.SESSION_SECRET || "").trim(); if (s) return s; const k = (process.env.SUPABASE_SERVICE_KEY || "").trim(); return k ? scCrypto.createHash("sha256").update("sc1|" + k).digest("hex") : ""; };
function scAuth(body) {
  const sec = scSecret();
  if (!sec) return { uid: "local", local: true };
  try {
    const [p, sig] = String((body && body.token) || "").split(".");
    if (!p || !sig) return null;
    const want = Buffer.from(scCrypto.createHmac("sha256", sec).update(p).digest("hex"), "hex");
    const got = Buffer.from(sig, "hex");
    if (want.length !== got.length || !scCrypto.timingSafeEqual(want, got)) return null;
    const d = JSON.parse(Buffer.from(String(p).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (!d || d.kind || !d.uid || !d.exp || Date.now() > d.exp) return null;
    return d;
  } catch (e) { return null; }
}
const scHits = {};
function scAllow(k, max) { const w = Math.floor(Date.now() / 60000), kk = k + ":" + w; scHits[kk] = (scHits[kk] || 0) + 1; if (Object.keys(scHits).length > 4000) { for (const x in scHits) { if (!x.endsWith(":" + w)) delete scHits[x]; } } return scHits[kk] <= max; }

/* FedEx nests location data a few different ways across API versions — dig defensively. */
const pick = (o, ...keys) => { for (const k of keys) { if (o && o[k] != null) return o[k]; } return undefined; };
function normLoc(item) {
  const ca = pick(item, "contactAndAddress", "locationContactAndAddress") || {};
  const addr = pick(ca, "address") || pick(item, "address") || {};
  const contact = pick(ca, "contact") || pick(item, "contact") || {};
  const detail = pick(item, "locationDetail", "distributionCenterLocationDetail") || {};
  const dist = pick(item, "distance") || {};
  const street = Array.isArray(addr.streetLines) ? addr.streetLines.filter(Boolean).join(", ") : (addr.streetLines || addr.streetLine1 || "");
  const hoursArr = pick(detail, "normalHours", "storeHours", "regularHours") || pick(item, "storeHours") || [];
  const hours = Array.isArray(hoursArr)
    ? hoursArr.map(h => { const day = pick(h, "dayOfWeek", "day") || ""; const ops = (pick(h, "operationalHours", "hours") || []); const first = Array.isArray(ops) && ops[0] ? ((ops[0].begins || ops[0].open || "") + "–" + (ops[0].ends || ops[0].close || "")) : ""; return day ? (String(day).slice(0, 3) + " " + first).trim() : ""; }).filter(Boolean)
    : [];
  return {
    id: pick(item, "locationId") || pick(detail, "locationId") || "",
    type: (pick(detail, "locationType") || pick(item, "locationType") || "").replace(/_/g, " "),
    name: pick(contact, "companyName", "personName") || pick(detail, "locationType") || "FedEx location",
    address1: street,
    city: addr.city || "",
    state: addr.stateOrProvinceCode || "",
    zip: addr.postalCode || "",
    country: addr.countryCode || "",
    phone: pick(contact, "phoneNumber") || "",
    distance: dist.value != null ? Math.round(+dist.value * 10) / 10 : null,
    distanceUnits: dist.units || "MI",
    hours,
    holdEligible: !!(pick(detail, "redirectToHoldEligibility", "holdAtLocationEligible") || (Array.isArray(detail.locationCapabilities) && detail.locationCapabilities.some(c => /hold/i.test(JSON.stringify(c)))))
  };
}

exports.handler = async (event) => {
  const respond = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  if (event.httpMethod === "OPTIONS") return respond(200, { ok: true });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return respond(200, { ok: false, error: "Bad request body" }); }
  const auth = scAuth(body);
  if (!auth) return respond(200, { ok: false, authFailed: true, error: "Sign in to search FedEx locations." });
  if (!scAllow("loc:" + auth.uid, 120)) return respond(200, { ok: false, error: "Too many location searches — give it a few seconds." });
  if (!CLIENT_ID || !CLIENT_SECRET) return respond(200, { ok: false, error: "FedEx isn't connected on this site yet." });

  const postalCode = String(body.postalCode || body.zip || "").trim();
  const countryCode = toISO(body.countryCode || body.country || "US");
  const city = String(body.city || "").trim();
  const state = String(body.state || "").trim();
  const streetLines = Array.isArray(body.streetLines) ? body.streetLines.filter(Boolean) : (body.address1 ? [String(body.address1)] : []);
  if (!postalCode && !city) return respond(200, { ok: false, error: "Enter a ZIP/postal code or city to search near." });
  const radius = Math.min(500, Math.max(1, +body.radius || 25));
  const max = Math.min(50, Math.max(1, +body.max || 15));

  const address = { countryCode };
  if (streetLines.length) address.streetLines = streetLines.slice(0, 2);
  if (city) address.city = city;
  if (state) address.stateOrProvinceCode = state;
  if (postalCode) address.postalCode = postalCode;

  const req = {
    locationSearchCriterion: "ADDRESS",
    location: { address },
    locationsSummaryRequestControlParameters: { distance: { units: "MI", value: radius } },
    sort: { criteria: "DISTANCE", order: "LOWEST_TO_HIGHEST" },
    multipleMatchesAction: "RETURN_ALL"
  };
  /* Only surface locations that can hold a package for pickup, when the caller asks for it. */
  if (body.holdService) {
    req.locationsSummaryRequestControlParameters.constraints = { supportedRedirectToHoldServices: [String(body.holdService)] };
  }

  try {
    const token = await getToken();
    /* FedEx has shipped this API under a couple of paths across versions; try the documented one
       first, fall back to alternates on a hard 404 so a path rename doesn't dead-end the finder. */
    const PATHS = ["/location/v1/locations/search", "/location/v1/locations", "/locations/v1/locations/search"];
    let rr = null, j = {}, lastCode = "", lastStatus = 0, usedPath = "";
    for (const p of PATHS) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      rr = await fetch(BASE + p, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, "x-locale": "en_US" },
        body: JSON.stringify(req),
        signal: ctrl.signal
      });
      clearTimeout(t);
      j = await rr.json().catch(() => ({}));
      usedPath = p;
      if (rr.ok) break;
      lastStatus = rr.status; lastCode = (j.errors && j.errors[0] && j.errors[0].code) || "";
      if (rr.status !== 404) break;   // a non-404 error is a real answer from the right endpoint — stop probing
    }
    if (!rr.ok) {
      const e0 = (j.errors && j.errors[0]) || {};
      let msg = e0.message || (j.output && j.output.alerts && j.output.alerts[0] && j.output.alerts[0].message) || ("FedEx location search failed (" + rr.status + ")");
      /* A 404 across every path means the Location Search API product isn't enabled on this FedEx
         developer project — the credentials rate & ship fine, this is just a separate product to add.
         Say so plainly instead of echoing FedEx's opaque "resource no longer available". */
      if (rr.status === 404) msg = "FedEx Location Search isn't enabled on your FedEx account yet. It's a separate FedEx API product — add \"Location Search API\" to your FedEx Developer project (the same one holding your API key), then try again. Rating and shipping are unaffected.";
      return respond(200, { ok: false, error: msg, fxCode: e0.code || lastCode, fxStatus: rr.status, fxPath: usedPath });
    }
    const out = j.output || {};
    const list = out.locationDetailList || out.locations || out.matchedLocations || [];
    const locations = (Array.isArray(list) ? list : []).map(normLoc).filter(l => l.address1 || l.city).slice(0, max);
    return respond(200, { ok: true, count: locations.length, locations, searchedNear: { postalCode, city, state, countryCode, radius } });
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "FedEx took too long to respond" : ((e && e.message) || "FedEx location search failed");
    return respond(200, { ok: false, error: msg });
  }
};
