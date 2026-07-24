/* ════════════════════════════════════════════════════════════════════════
   alerts.js — service-disruption alerts for a shipment.

   Combines four sources into one list so the Ship screen can warn about anything
   that could delay a FedEx shipment:
     1. DESTINATION weather  — active National Weather Service alerts at the
        recipient's ZIP (winter storm, hurricane, flood, high wind, etc.).
     2. MEMPHIS HUB weather  — active NWS alerts at the FedEx World Hub in Memphis.
        Almost everything routes through Memphis, so a storm there delays the whole
        network even when the origin/destination look clear.
     3. FEDEX HOLIDAYS       — the ship date (or the next few days) is a FedEx
        holiday with no pickup/delivery.
     4. POSTED ALERTS        — anything an admin manually posts (power outage, road
        closure, world event, a FedEx Service Alert copied over) — the reliable way
        to surface disruptions no public API exposes.

   Actions (POST JSON):
     { token, action:"check", zip, date }            → { ok, alerts:[…] }   (any signed-in user)
     { token, action:"post", title, detail, until }  → { ok }               (admin only)
     { token, action:"list" }                        → { ok, posted:[…] }   (admin)
     { token, action:"clear", id }                   → { ok }               (admin)

   Free data, no API keys: Zippopotam (ZIP→lat/lon) + NWS (api.weather.gov).
   Posted alerts live in Supabase app_stores (key "svc:alerts"). Session-gated.
   ════════════════════════════════════════════════════════════════════════ */
const crypto = require("crypto");
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });

const scSecret = () => { const s = (process.env.SESSION_SECRET || "").trim(); if (s) return s; const k = (process.env.SUPABASE_SERVICE_KEY || "").trim(); return k ? crypto.createHash("sha256").update("sc1|" + k).digest("hex") : ""; };
function scAuth(body) {
  const sec = scSecret();
  if (!sec) return { uid: "local", local: true, role: "admin" };
  try {
    const [p, sig] = String((body && body.token) || "").split(".");
    if (!p || !sig) return null;
    const want = Buffer.from(crypto.createHmac("sha256", sec).update(p).digest("hex"), "hex");
    const got = Buffer.from(sig, "hex");
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const d = JSON.parse(Buffer.from(String(p).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (!d || d.kind || !d.uid || !d.exp || Date.now() > d.exp) return null;
    return d;
  } catch (e) { return null; }
}
const hits = {};
function allow(k, max) { const w = Math.floor(Date.now() / 60000), kk = k + ":" + w; hits[kk] = (hits[kk] || 0) + 1; if (Object.keys(hits).length > 4000) { for (const x in hits) { if (!x.endsWith(":" + w)) delete hits[x]; } } return hits[kk] <= max; }

const UA = { "User-Agent": "ShippingCloud/1.0 (support@shippingcloud.net)", Accept: "application/geo+json" };
async function jget(url, headers) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
  try { const r = await fetch(url, { headers: headers || UA, signal: ctrl.signal }); const j = await r.json().catch(() => null); return r.ok ? j : null; }
  catch (e) { return null; } finally { clearTimeout(t); }
}

/* Weather events that realistically slow a courier / air network. */
const DELAY_RE = /(winter storm|blizzard|ice storm|freezing rain|snow|hurricane|tropical|tornado|flood|high wind|wind advisory|dense fog|storm warning|extreme|red flag)/i;

/* ── FedEx US holiday calendar (no pickup/delivery on these; computed per year). ── */
function nthDow(y, m, dow, n) { // m 0-11, dow 0=Sun..6=Sat, n>0 = nth, n<0 = last
  if (n > 0) { const d = new Date(Date.UTC(y, m, 1)); const shift = (dow - d.getUTCDay() + 7) % 7; return new Date(Date.UTC(y, m, 1 + shift + (n - 1) * 7)); }
  const d = new Date(Date.UTC(y, m + 1, 0)); const shift = (d.getUTCDay() - dow + 7) % 7; return new Date(Date.UTC(y, m + 1, 0 - shift));
}
const isoDate = (d) => d.toISOString().slice(0, 10);
function fedexHolidays(year) {
  return [
    { date: isoDate(new Date(Date.UTC(year, 0, 1))), name: "New Year's Day" },
    { date: isoDate(nthDow(year, 4, 1, -1)), name: "Memorial Day" },
    { date: isoDate(new Date(Date.UTC(year, 6, 4))), name: "Independence Day" },
    { date: isoDate(nthDow(year, 8, 1, 1)), name: "Labor Day" },
    { date: isoDate(nthDow(year, 10, 4, 4)), name: "Thanksgiving Day" },
    { date: isoDate(new Date(Date.UTC(year, 11, 25))), name: "Christmas Day" },
  ];
}
/* Is `iso` (yyyy-mm-dd), or one of the next `look` days, a FedEx holiday? */
function holidayNear(iso, look) {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(iso || "") ? new Date(iso + "T12:00:00Z") : new Date();
  const years = new Set([base.getUTCFullYear(), base.getUTCFullYear() + 1]);
  const cal = [].concat(...[...years].map(fedexHolidays));
  for (let i = 0; i <= (look || 3); i++) {
    const d = new Date(base.getTime() + i * 86400000);
    const h = cal.find((x) => x.date === isoDate(d));
    if (h) return { name: h.name, date: h.date, days: i };
  }
  return null;
}

/* ── Supabase KV for admin-posted alerts (same pattern as connector.js). ── */
const CFG = () => ({ url: (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, ""), key: (process.env.SUPABASE_SERVICE_KEY || "").trim() });
const TENANT = (process.env.DB_TENANT || "main").trim() || "main";
const enc = encodeURIComponent;
async function pg(path, opts = {}) {
  const c = CFG(); if (!c.url || !c.key) return { ok: false, status: 0 };
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(c.url + "/rest/v1/" + path, { ...opts, headers: { apikey: c.key, Authorization: "Bearer " + c.key, "Content-Type": "application/json", ...(opts.headers || {}) }, signal: ctrl.signal });
    const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
    return { ok: r.ok, status: r.status, data };
  } catch (e) { return { ok: false, status: 0 }; } finally { clearTimeout(t); }
}
const K = "svc:alerts";
const getPosted = async () => { const r = await pg("app_stores?tenant=eq." + enc(TENANT) + "&key=eq." + enc(K) + "&select=value"); const v = r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0].value : null; return Array.isArray(v) ? v : []; };
const putPosted = async (arr) => pg("app_stores?on_conflict=tenant,key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ tenant: TENANT, key: K, value: arr, updated_at: new Date().toISOString() }]) });
/* Drop expired posted alerts (past their `until` date). */
const livePosted = (arr) => { const today = isoDate(new Date()); return (arr || []).filter((a) => !a.until || a.until >= today); };

/* NWS active alerts at a lat/lon → normalized rows. */
async function nwsAt(lat, lon) {
  const al = await jget(`https://api.weather.gov/alerts/active?point=${lat},${lon}`);
  const feats = (al && al.features) || [];
  return feats.map((f) => f.properties || {}).filter((p) => p.event)
    .map((p) => ({ event: p.event, severity: (p.severity || "").toLowerCase(), headline: p.headline || "", area: p.areaDesc || "" }));
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return J({ ok: true });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) { return J({ ok: false, error: "Bad request body" }); }
  const auth = scAuth(body);
  if (!auth) return J({ ok: false, authFailed: true, error: "Sign in to check service alerts." });
  const action = String(body.action || "check");
  const isAdmin = auth.local || auth.role === "admin";

  /* ── admin: manage posted alerts ── */
  if (action === "post" || action === "clear" || action === "list") {
    if (!isAdmin) return J({ ok: false, error: "Admins only." });
    let arr = livePosted(await getPosted());
    if (action === "list") return J({ ok: true, posted: arr });
    if (action === "clear") { arr = arr.filter((a) => String(a.id) !== String(body.id)); await putPosted(arr); return J({ ok: true, posted: arr }); }
    // post
    const title = String(body.title || "").trim().slice(0, 120);
    if (!title) return J({ ok: false, error: "Enter a short title." });
    const row = { id: String(body.id || (Date.now() + "" + Math.floor(Math.random() * 1000))), title, detail: String(body.detail || "").trim().slice(0, 400), area: String(body.area || "").trim().slice(0, 80), until: /^\d{4}-\d{2}-\d{2}$/.test(String(body.until || "")) ? body.until : "" };
    arr = [row, ...arr.filter((a) => a.id !== row.id)].slice(0, 40);
    await putPosted(arr);
    return J({ ok: true, posted: arr });
  }

  /* ── check: aggregate alerts for a shipment ── */
  if (!allow("al:" + auth.uid, 120)) return J({ ok: false, error: "Too many checks — give it a moment." });
  const zip = String(body.zip || "").trim().slice(0, 5);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? body.date : "";
  const alerts = [];

  // destination lat/lon (only if a valid ZIP was given)
  let dest = null;
  if (/^\d{5}$/.test(zip)) {
    const zp = await jget("https://api.zippopotam.us/us/" + zip, { "User-Agent": UA["User-Agent"] });
    const place = zp && zp.places && zp.places[0];
    if (place) dest = { lat: (+place.latitude).toFixed(4), lon: (+place.longitude).toFixed(4), city: place["place name"] || "", state: place["state abbreviation"] || "" };
  }

  // 1) destination + 2) Memphis hub NWS alerts (in parallel). Memphis World Hub ≈ 35.05,-89.98.
  const [destAl, memAl, posted] = await Promise.all([
    dest ? nwsAt(dest.lat, dest.lon) : Promise.resolve([]),
    nwsAt("35.0500", "-89.9800"),
    getPosted(),
  ]);

  for (const a of destAl) {
    if (!DELAY_RE.test(a.event + " " + a.headline)) continue;
    alerts.push({ kind: "weather", severity: /severe|extreme/.test(a.severity) ? "high" : "med", title: a.event, detail: (a.headline || "").slice(0, 160), area: dest ? `${dest.city}, ${dest.state}` : a.area, source: "NWS · destination" });
  }
  for (const a of memAl) {
    if (!DELAY_RE.test(a.event + " " + a.headline)) continue;
    alerts.push({ kind: "hub", severity: /severe|extreme/.test(a.severity) ? "high" : "med", title: "Memphis hub: " + a.event, detail: "Weather at the FedEx World Hub can delay the whole network. " + (a.headline || "").slice(0, 120), area: "Memphis, TN", source: "NWS · Memphis hub" });
  }

  // 3) FedEx holiday on/near the ship date
  const hol = holidayNear(date, 3);
  if (hol) alerts.push({ kind: "holiday", severity: "med", title: "FedEx holiday: " + hol.name, detail: hol.days === 0 ? "No FedEx pickup or delivery today — expect a day's delay." : `${hol.name} is ${hol.days} day${hol.days === 1 ? "" : "s"} out — no pickup/delivery that day; build in a buffer.`, area: "Nationwide", source: "FedEx holiday calendar" });

  // 4) admin-posted alerts (always shown while live)
  for (const p of livePosted(posted)) alerts.push({ kind: "posted", severity: "high", title: p.title, detail: p.detail || "", area: p.area || "", id: p.id, source: "Posted alert" });

  // most severe first, then hub/holiday/weather
  const rank = { high: 0, med: 1, low: 2 };
  alerts.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
  return J({ ok: true, alerts, dest: dest ? { city: dest.city, state: dest.state } : null });
};
