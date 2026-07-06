// AI HS-code suggestion — asks Claude to classify an item description.
// Requires ANTHROPIC_API_KEY set as a (non-secret) Netlify environment variable.
const J = (obj, status = 200) => ({ statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return J({ ok: false, error: "POST only" }, 405);
  const key = process.env.ANTHROPIC_API_KEY || "";
  if (!key) return J({ ok: false, error: "ANTHROPIC_API_KEY is not configured on Netlify." });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (_) {}
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
          `Classify this product for a US export commercial invoice with a 6-10 digit HTS/HS code.\nProduct: "${desc}"${dest ? `\nDestination: ${dest}` : ""}\nRespond ONLY with JSON, no markdown: {"code":"XXXX.XX.XXXX","reason":"<10 words why>","confidence":"high|medium|low"}` }],
      }),
    });
    const d = await r.json();
    const text = ((d.content || []).find((c) => c.type === "text") || {}).text || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (!parsed.code) throw new Error("no code");
    return J({ ok: true, code: String(parsed.code), reason: String(parsed.reason || ""), confidence: String(parsed.confidence || "") });
  } catch (e) {
    return J({ ok: false, error: "Claude lookup failed: " + (e.message || "unknown") });
  }
};
