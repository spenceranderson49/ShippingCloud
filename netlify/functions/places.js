// Google Places proxy — keeps the Maps API key server-side.
// POST {action:"autocomplete", input, session}  -> { ok, predictions:[{description, placeId}] }
// POST {action:"details", placeId, session}      -> { ok, address:{address1, city, state, zip, country} }
const J = (obj, status = 200) => ({ statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
const KEY = () => process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY || "";

async function autocomplete(input, session, country) {
  const key = KEY();
  /* country: ISO-2 to scope suggestions to one country ("us" default keeps domestic behavior);
     empty string = GLOBAL search (used when the selected country isn't recognized). */
  const cc = country === undefined ? "us" : String(country || "").trim().toLowerCase();
  const url = "https://maps.googleapis.com/maps/api/place/autocomplete/json?input=" + encodeURIComponent(input) +
    "&types=address" + (cc ? "&components=country:" + encodeURIComponent(cc) : "") + "&key=" + key + (session ? "&sessiontoken=" + session : "");
  const r = await fetch(url);
  const d = await r.json();
  if (d.status && d.status !== "OK" && d.status !== "ZERO_RESULTS") {
    return { ok: false, error: "Places: " + d.status + (d.error_message ? " — " + d.error_message : ""), predictions: [] };
  }
  const predictions = (d.predictions || []).map((p) => ({ description: p.description, placeId: p.place_id }));
  return { ok: true, predictions };
}

function parseComponents(comps) {
  const g = (type, useShort) => {
    const c = (comps || []).find((x) => (x.types || []).includes(type));
    return c ? (useShort ? c.short_name : c.long_name) : "";
  };
  const streetNum = g("street_number");
  const route = g("route");
  const city = g("locality") || g("sublocality") || g("postal_town") || g("administrative_area_level_2");
  return {
    address1: [streetNum, route].filter(Boolean).join(" "),
    city,
    state: g("administrative_area_level_1", true),
    zip: g("postal_code"),
    country: g("country") || "United States",
  };
}

/* Postal code → city/region within a country (Google Geocoding). Powers the intl
   "type the postal code, city fills itself" behavior in the address form. */
async function zipcity(zip, country) {
  const key = KEY();
  const comp = "postal_code:" + encodeURIComponent(String(zip || "").trim()) + (country ? "|country:" + encodeURIComponent(String(country).trim()) : "");
  const url = "https://maps.googleapis.com/maps/api/geocode/json?components=" + comp + "&key=" + key;
  const r = await fetch(url);
  const d = await r.json();
  if (d.status !== "OK" || !d.results || !d.results[0]) return { ok: false, error: "Geocode: " + (d.status || "no match") };
  const a = parseComponents(d.results[0].address_components);
  return { ok: true, city: a.city || "", state: a.state || "", country: a.country || "" };
}

async function details(placeId, session) {
  const key = KEY();
  const url = "https://maps.googleapis.com/maps/api/place/details/json?place_id=" + encodeURIComponent(placeId) +
    "&fields=address_component&key=" + key + (session ? "&sessiontoken=" + session : "");
  const r = await fetch(url);
  const d = await r.json();
  if (d.status !== "OK") return { ok: false, error: "Places details: " + d.status + (d.error_message ? " — " + d.error_message : "") };
  return { ok: true, address: parseComponents(d.result && d.result.address_components) };
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
    if (!d || d.kind || !d.uid || !d.exp || Date.now() > d.exp) return null;   /* d.kind = special-purpose token (password reset) — never a session */
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
    if (!KEY()) return J({ ok: false, error: "Missing GOOGLE_MAPS_API_KEY env var" });
    let body = {}; try { body = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); }
    const gateAuth = scAuth(body);
    if (!gateAuth) return J({ ok: false, authFailed: true, error: "Sign in first \u2014 your session may have expired." });
    if (!scAllow("places:" + gateAuth.uid, 600)) return J({ ok: false, error: "Too many address lookups at once." });
    if (body.action === "details") return J(await details(body.placeId, body.session));
    if (body.action === "autocomplete") {
      if (!body.input || String(body.input).trim().length < 3) return J({ ok: true, predictions: [] });
      return J(await autocomplete(String(body.input).trim(), body.session, body.country));
    }
    if (body.action === "zipcity") {
      if (!body.zip || String(body.zip).trim().length < 3) return J({ ok: false, error: "zip too short" });
      return J(await zipcity(body.zip, body.country));
    }
    return J({ ok: false, error: "Unknown action" });
  } catch (e) {
    return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) });
  }
};
