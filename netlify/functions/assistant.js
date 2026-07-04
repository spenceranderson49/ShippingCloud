/* ShippingCloud assistant — relays in-app chat to Anthropic's Claude API.
   The API key lives ONLY in the ANTHROPIC_API_KEY Netlify env var; it never
   reaches the browser. Model can be swapped with ASSISTANT_MODEL. */

const MODEL = process.env.ASSISTANT_MODEL || "claude-haiku-4-5-20251001";
const MAX_MSGS = 16;      // history window sent to the model
const MAX_CHARS = 4000;   // per-message cap
const MAX_TOKENS = 700;   // reply cap — keeps answers tight and cost low

const SYSTEM = `You are Claude, made by Anthropic, serving as the in-app assistant for ShippingCloud (shippingcloud.net) — a multi-carrier shipping platform with enterprise FedEx and DHL rates, built and supported by shipping people.

What the platform does, by tab:
- Ship: quote and book shipments. Enter sender/recipient, packages, and options (residential, signature, insurance); compare live rates across services and print labels.
- Orders: orders from Shopify and other connected stores, or entered manually. Fulfill an order straight into a shipment.
- Shipments: every label booked — tracking, status, cost, and details.
- Drafts: partially-filled shipments saved to finish later.
- Returns: create RMA return labels for customers in a couple of clicks.
- Pickups: schedule carrier pickups with confirmation codes.
- Batch: process many shipments at once.
- Invoices: carrier invoices and auditing.
- Autopilot: automation rules — e.g. "orders under 1 lb always ship Ground" — so routine decisions happen automatically.
- Address Book: saved recipients, searchable from the Ship form.
- Scan: barcode scan-to-verify workflows.
- Dashboard: volume, spend, on-time performance, and trends.
- Settings: package sizes, box logic (the platform picks the right box and can rate live shopping-cart contents), warehouses, checkout rates, email notifications, reference fields, billing, and the ledger.

How to behave:
- Be brief, concrete, and warm. Point to tabs by name ("head to Returns and click New return").
- You may say you are Claude (the feature is called "Ask Claude"), but you speak for ShippingCloud here — you do not represent Anthropic, and Anthropic does not endorse ShippingCloud.
- Give genuinely useful shipping advice (packaging, service selection, residential vs commercial, dimensional weight, insurance) when asked.
- NEVER invent prices, discounts, or rate numbers. Real rates come from quoting in the Ship tab. For pricing, account, or billing specifics, direct people to support: (801) 555-0123 or support@shippingcloud.net.
- Never discuss internal systems, credentials, API keys, other customers, or how the platform is built. Politely steer off-topic conversations back to shipping.
- If the person is exploring the public demo, everything they see is sample data — encourage them to click around, and mention they can create a real account from the banner up top when ready.`;

exports.handler = async (event) => {
  const J = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  if (event.httpMethod !== "POST") return J(405, { ok: false, error: "POST only" });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return J(200, { ok: false, error: "The assistant isn't configured yet — set ANTHROPIC_API_KEY in Netlify and redeploy." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return J(400, { ok: false, error: "Bad JSON" }); }

  const raw = Array.isArray(body.messages) ? body.messages : [];
  const msgs = raw
    .slice(-MAX_MSGS)
    .map(m => ({ role: m && m.role === "assistant" ? "assistant" : "user", content: String((m && m.content) || "").slice(0, MAX_CHARS) }))
    .filter(m => m.content.trim());
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return J(400, { ok: false, error: "Send a user message." });

  const who = body.context === "admin" ? "the platform administrator"
    : body.context === "demo" ? "a visitor exploring the public demo (everything they see is sample data)"
    : "a signed-in customer";

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM + "\n\nThe person you are talking to right now is " + who + ".", messages: msgs })
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data) return J(200, { ok: false, error: (data && data.error && data.error.message) || ("Assistant error (" + r.status + ")") });
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").trim();
    return J(200, { ok: true, text: text || "Hmm, I came back empty — try asking that another way?" });
  } catch (e) {
    return J(200, { ok: false, error: "Couldn't reach the assistant just now — give it another try in a moment." });
  }
};
