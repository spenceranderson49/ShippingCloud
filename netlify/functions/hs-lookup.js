// AI HS-code suggestion — asks Claude to classify an item description.
// Requires ANTHROPIC_API_KEY set as a (non-secret) Netlify environment variable.
const J = (obj, status = 200) => ({ statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

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
  if (event.httpMethod !== "POST") return J({ ok: false, error: "POST only" }, 405);
  const key = process.env.ANTHROPIC_API_KEY || "";
  if (!key) return J({ ok: false, error: "ANTHROPIC_API_KEY is not configured on Netlify." });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (_) {}
  const gateAuth = scAuth(body);
  if (!gateAuth) return J({ ok: false, authFailed: true, error: "Sign in first \u2014 your session may have expired." });
  if (!scAllow("hs:" + gateAuth.uid, 30)) return J({ ok: false, error: "Too many lookups at once \u2014 give it a few seconds." });
  const desc = String(body.description || "").slice(0, 300);
  const dest = String(body.destination || "").slice(0, 60);
  if (!desc) return J({ ok: false, error: "Missing item description." });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content:
          `Classify this product for a US export commercial invoice. Give your TOP 3 candidate HTS/HS codes (6-10 digits), best first.\nProduct: "${desc}"${dest ? `\nDestination: ${dest}` : ""}\nRespond ONLY with JSON, no markdown: {"options":[{"code":"XXXX.XX.XXXX","reason":"<8 words why>","confidence":"high|medium|low"},...]}` }],
      }),
    });
    const d = await r.json();
    const text = ((d.content || []).find((c) => c.type === "text") || {}).text || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    const opts = Array.isArray(parsed.options) ? parsed.options.filter((x) => x && x.code).slice(0, 3) : (parsed.code ? [parsed] : []);
    if (!opts.length) throw new Error("no code");
    return J({ ok: true, code: String(opts[0].code), reason: String(opts[0].reason || ""), options: opts.map((x) => ({ code: String(x.code), reason: String(x.reason || ""), confidence: String(x.confidence || "") })) });
  } catch (e) {
    return J({ ok: false, error: "Claude lookup failed: " + (e.message || "unknown") });
  }
};
