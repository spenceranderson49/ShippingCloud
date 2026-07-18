/* ════════════════════════════════════════════════════════════════════════
   Public branded tracking — NO login. Given a tracking number (and an optional
   brand id), returns the FedEx status + the shipper's public branding so the
   customer-facing tracking page can render it. Rate-limited by IP. The brand
   record is written by db.js (trackBrandSave); this only READS it.
     POST { n, b? }  /  GET ?n=…&b=…   →   { ok, status, events, estDelivery, brand }
   ════════════════════════════════════════════════════════════════════════ */
const crypto = require("crypto");
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const TENANT = (process.env.DB_TENANT || "main").trim() || "main";
const scSecret = () => { const s = (process.env.SESSION_SECRET || "").trim(); if (s) return s; const k = (process.env.SUPABASE_SERVICE_KEY || "").trim(); return k ? crypto.createHash("sha256").update("sc1|" + k).digest("hex") : ""; };
const internalKey = () => { const s = scSecret(); return s ? crypto.createHmac("sha256", s).update("internal:carrier").digest("hex") : ""; };

const hits = {};
const allow = (ip) => { const w = Math.floor(Date.now() / 60000), k = String(ip || "?") + ":" + w; hits[k] = (hits[k] || 0) + 1; if (Object.keys(hits).length > 5000) { for (const x in hits) { if (!x.endsWith(":" + w)) delete hits[x]; } } return hits[k] <= 30; };

async function getStore(key) {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const skey = process.env.SUPABASE_SERVICE_KEY || "";
  if (!url || !skey) return null;
  try {
    const r = await fetch(url + "/rest/v1/app_stores?tenant=eq." + encodeURIComponent(TENANT) + "&key=eq." + encodeURIComponent(key) + "&select=value", { headers: { apikey: skey, Authorization: "Bearer " + skey } });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    return (Array.isArray(d) && d[0]) ? d[0].value : null;
  } catch (e) { return null; }
}

async function callFedex(payload) {
  try {
    const res = await require("./fedex.js").handler({ httpMethod: "POST", body: JSON.stringify({ ...payload, internalKey: internalKey() }), headers: {} });
    return JSON.parse(res.body || "{}");
  } catch (e) { return { ok: false, error: "tracking is temporarily unavailable" }; }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }, body: "" };
  let body = {};
  if (event.httpMethod === "POST") { try { body = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); } }
  else body = event.queryStringParameters || {};

  const n = S(body.n || body.track || body.trackingNumber).replace(/\s/g, "").slice(0, 60);
  const brandId = S(body.b || body.brand).replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
  if (!n) return J({ ok: false, error: "Enter a tracking number." });

  const ip = (event.headers && (event.headers["x-nf-client-connection-ip"] || String(event.headers["x-forwarded-for"] || "").split(",")[0].trim())) || "";
  if (!allow(ip)) return J({ ok: false, error: "Too many lookups — wait a minute and try again." });

  let brand = null;
  if (brandId) { const b = await getStore("pub:track:" + brandId); if (b && typeof b === "object" && b.enabled !== false) brand = b; }

  const t = await callFedex({ action: "track", trackingNumber: n });
  if (!t || !t.ok) return J({ ok: false, error: (t && t.error) || "We couldn't find that tracking number yet. It can take a few hours after a label is created.", brand });
  return J({ ok: true, trackingNumber: n, status: t.status || "", code: t.code || "", events: Array.isArray(t.events) ? t.events.slice(0, 40) : [], estDelivery: t.estDelivery || null, brand });
};
