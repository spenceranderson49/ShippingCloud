/* ════════════════════════════════════════════════════════════════════════
   weather.js — destination weather advisor for the Ship screen.
   Given the receiver's ZIP (+ optional ship/delivery date), returns the delivery-day
   forecast, a weather-delay risk flag, and a packaging suggestion (add ice/insulation
   when it's hot, protect liquids when it's freezing).
     in:  { token, zip, date? (yyyy-mm-dd) }
     out: { ok, city, state, day, tempHigh, tempUnit, condition, delayRisk, delayReason, alerts:[…], advice:[…] }
   Free data — no API key: ZIP→lat/lon via Zippopotam, forecast + alerts via the U.S.
   National Weather Service (api.weather.gov). US destinations only. Session-gated. */
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
const hits = {};
function allow(k, max) { const w = Math.floor(Date.now() / 60000), kk = k + ":" + w; hits[kk] = (hits[kk] || 0) + 1; if (Object.keys(hits).length > 4000) { for (const x in hits) { if (!x.endsWith(":" + w)) delete hits[x]; } } return hits[kk] <= max; }

const cache = {};   // zip|date -> { at, data }
const UA = { "User-Agent": "FreightWireShippingHub/1.0 (support@freightwireship.com)", Accept: "application/geo+json" };

/* Events that realistically slow a courier down. */
const DELAY_RE = /(winter storm|blizzard|ice storm|freezing rain|snow|hurricane|tropical storm|tornado|flood|high wind|wind advisory|dense fog|storm warning)/i;

async function jget(url, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try { const r = await fetch(url, { headers: headers || UA, signal: ctrl.signal }); const j = await r.json().catch(() => null); return r.ok ? j : null; }
  catch (e) { return null; } finally { clearTimeout(t); }
}

exports.handler = async (event) => {
  const respond = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  if (event.httpMethod === "OPTIONS") return respond(200, { ok: true });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return respond(200, { ok: false, error: "Bad request body" }); }
  const auth = scAuth(body);
  if (!auth) return respond(200, { ok: false, authFailed: true, error: "Sign in to check weather." });
  if (!allow("wx:" + auth.uid, 120)) return respond(200, { ok: false, error: "Too many weather checks — give it a moment." });

  const zip = String(body.zip || "").trim().slice(0, 5);
  if (!/^\d{5}$/.test(zip)) return respond(200, { ok: false, error: "US ZIP required." });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? body.date : "";
  const ckey = zip + "|" + date;
  if (cache[ckey] && Date.now() - cache[ckey].at < 30 * 60 * 1000) return respond(200, cache[ckey].data);

  // 1) ZIP -> lat/lon (Zippopotam, free, no key)
  const zp = await jget("https://api.zippopotam.us/us/" + zip, { "User-Agent": UA["User-Agent"] });
  const place = zp && zp.places && zp.places[0];
  if (!place) return respond(200, { ok: false, error: "Couldn't locate that ZIP." });
  const lat = (+place.latitude).toFixed(4), lon = (+place.longitude).toFixed(4);
  const city = place["place name"] || "", state = place["state abbreviation"] || "";

  // 2) NWS gridpoint -> forecast URL
  const pts = await jget(`https://api.weather.gov/points/${lat},${lon}`);
  const fcUrl = pts && pts.properties && pts.properties.forecast;
  if (!fcUrl) return respond(200, { ok: false, error: "Forecast unavailable for that area." });

  // 3) forecast periods + 4) active alerts (in parallel)
  const [fc, al] = await Promise.all([jget(fcUrl), jget(`https://api.weather.gov/alerts/active?point=${lat},${lon}`)]);
  const periods = (fc && fc.properties && fc.properties.periods) || [];
  if (!periods.length) return respond(200, { ok: false, error: "No forecast returned." });

  // multi-day forecast (daytime highs) so the UI can show current + any delivery date from one call
  const days = periods.filter(p => p.isDaytime).map(p => ({
    date: String(p.startTime || "").slice(0, 10),
    name: p.name || "",
    high: p.temperature,
    unit: p.temperatureUnit || "F",
    condition: p.shortForecast || "",
    delayRisk: DELAY_RE.test(p.shortForecast || ""),
  }));
  const first = periods[0];
  const current = first ? { temp: first.temperature, unit: first.temperatureUnit || "F", condition: first.shortForecast || "", name: first.name || "", isDaytime: !!first.isDaytime } : null;

  // pick the daytime period matching the delivery date, else the next daytime period
  let pick = null;
  if (date) pick = periods.find(p => p.isDaytime && String(p.startTime || "").slice(0, 10) === date);
  if (!pick) pick = periods.find(p => p.isDaytime) || periods[0];

  const tempHigh = pick.temperature;
  const tempUnit = pick.temperatureUnit || "F";
  const condition = pick.shortForecast || "";
  const day = pick.name || "";

  // alerts
  const feats = (al && al.features) || [];
  const alerts = feats.map(f => (f.properties && f.properties.event) || "").filter(Boolean).slice(0, 4);
  let delayRisk = false, delayReason = "";
  const sevAlert = feats.find(f => f.properties && /severe|extreme/i.test(f.properties.severity || "") && DELAY_RE.test((f.properties.event || "") + " " + (f.properties.headline || "")));
  if (sevAlert) { delayRisk = true; delayReason = sevAlert.properties.event; }
  else if (DELAY_RE.test(condition)) { delayRisk = true; delayReason = condition; }

  // packaging advice
  const advice = [];
  const isF = /F/i.test(tempUnit);
  const hot = isF ? tempHigh >= 80 : tempHigh >= 27;
  const freeze = isF ? tempHigh <= 32 : tempHigh <= 0;
  if (hot) advice.push(`Warm at the destination (${tempHigh}°${tempUnit} ${day.toLowerCase()}). For chocolate, cosmetics or other heat-sensitive items, add ice packs or an insulated liner.`);
  if (freeze) advice.push(`Freezing at the destination (${tempHigh}°${tempUnit} ${day.toLowerCase()}). Protect liquids and anything that can freeze/crack.`);
  if (delayRisk) advice.push(`${delayReason} near the destination — build in a buffer or warn the customer of a possible weather delay.`);

  const data = { ok: true, city, state, day, tempHigh, tempUnit, condition, delayRisk, delayReason, alerts, advice, current, days };
  cache[ckey] = { at: Date.now(), data };
  if (Object.keys(cache).length > 2000) { for (const k in cache) { if (Date.now() - cache[k].at > 30 * 60 * 1000) delete cache[k]; } }
  return respond(200, data);
};
