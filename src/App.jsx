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

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, body: "" };
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    if (!KEY()) return J({ ok: false, error: "Missing GOOGLE_MAPS_API_KEY env var" });
    let body = {}; try { body = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); }
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
