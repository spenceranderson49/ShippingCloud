// Google Places proxy — keeps the Maps API key server-side.
// POST {action:"autocomplete", input, session}  -> { ok, predictions:[{description, placeId}] }
// POST {action:"details", placeId, session}      -> { ok, address:{address1, city, state, zip, country} }
const J = (obj, status = 200) => ({ statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
const KEY = () => process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY || "";

async function autocomplete(input, session) {
  const key = KEY();
  const url = "https://maps.googleapis.com/maps/api/place/autocomplete/json?input=" + encodeURIComponent(input) +
    "&types=address&components=country:us&key=" + key + (session ? "&sessiontoken=" + session : "");
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
      return J(await autocomplete(String(body.input).trim(), body.session));
    }
    return J({ ok: false, error: "Unknown action" });
  } catch (e) {
    return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) });
  }
};
