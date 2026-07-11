/* ShippingCloud assistant — relays in-app chat to Anthropic's Claude API.
   The API key lives ONLY in the ANTHROPIC_API_KEY Netlify env var; it never
   reaches the browser. Model can be swapped with ASSISTANT_MODEL. */

const MODEL = process.env.ASSISTANT_MODEL || "claude-haiku-4-5-20251001";
const MAX_MSGS = 16;      // history window sent to the model
const MAX_CHARS = 4000;   // per-message cap
const MAX_TOKENS = 700;   // reply cap — keeps answers tight and cost low

/* Copilot tools: Claude proposes actions; the BROWSER executes them against local
   data and the human always presses the final "Create labels" button. The server
   never touches orders — it only relays which actions Claude chose. */
const TOOLS = [
  {
    name: "batch_orders",
    description: "Stage a batch in the Batch tab: filter the open orders, select every match, and optionally force a shipping service for them. Use when the person asks to batch/select/queue orders by any criteria (product, SKU, state, zone, source, weight, order value, age). This only SELECTS — the person reviews and clicks Create labels themselves.",
    input_schema: { type: "object", properties: {
      productContains: { type: "string", description: "Match orders whose items/product text contains this (case-insensitive)" },
      skus: { type: "array", items: { type: "string" }, description: "Match these exact SKUs" },
      states: { type: "array", items: { type: "string" }, description: "2-letter destination states" },
      zones: { type: "array", items: { type: "string" }, description: "Shipping zones as numbers in strings, e.g. [\"2\",\"3\"]" },
      sources: { type: "array", items: { type: "string" }, description: "Order sources, e.g. Shopify, Manual, CSV import" },
      weightMin: { type: "number" }, weightMax: { type: "number" },
      totalMin: { type: "number" }, totalMax: { type: "number" },
      ageMaxDays: { type: "number", description: "Only orders at most this many days old" },
      ageMinDays: { type: "number", description: "Only orders at least this many days old (use for stale/old orders)" },
      service: { type: "string", description: "Optional service to force for the selected orders, e.g. FedEx - 2Day, ANY - Cheapest Ground, DHL - Express Worldwide" }
    } }
  },
  {
    name: "create_rule",
    description: "Create a new Autopilot automation rule (if CONDITION then ship with SERVICE). It saves into the shared Autopilot pipeline. Use when the person describes an if-this-then-that shipping rule.",
    input_schema: { type: "object", required: ["property","operator","value","service"], properties: {
      name: { type: "string", description: "Short human name for the rule" },
      property: { type: "string", description: "One of: To Postal, To State, To Country, To City, Recipient Name, Zone, Item Count, Item SKUs, Item Name, Item Weight (oz), Order Value, Package Weight, Cubic Volume, Requested Service, Store / Source, Tag Names, Order Note, Status" },
      operator: { type: "string", description: "Text/list ops: IN, NOT IN, =, != ; number ops: =, !=, >, <, >=, <=" },
      value: { type: "string", description: "Comparison value; comma-separate lists" },
      service: { type: "string", description: "Service to set, e.g. FedEx - Priority Overnight, ANY - Cheapest Ground, DHL - Express Worldwide" }
    } }
  },
  {
    name: "apply_autopilot",
    description: "Run the person's enabled Autopilot rules across the open orders in the Batch tab: routes services and applies holds. Use when asked to run autopilot, apply my rules, or after creating a rule they want used right away.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "prefill_shipment",
    description: "Open the Ship tab with the form pre-filled so the person can review, quote, and book one shipment. Use when they describe a single package to send (\"ship 5 lb to Jane in Austin\", \"start a label to Acme Corp\"). You can name a saved contact and it will be looked up. Never claim you booked it \u2014 they still quote and click Buy.",
    input_schema: { type: "object", properties: {
      contactName: { type: "string", description: "Name of a saved address-book contact to load as the recipient" },
      name: { type: "string" }, company: { type: "string" },
      address1: { type: "string" }, city: { type: "string" }, state: { type: "string" }, zip: { type: "string" },
      phone: { type: "string" }, email: { type: "string" },
      country: { type: "string", description: "Destination country for international shipments \u2014 full name (\"Canada\") or 2-letter code (\"CA\"). Omit or use \"United States\" for domestic. Setting a non-US country switches the Ship tab to international mode with the commercial invoice section." },
      weight: { type: "number", description: "Package weight in pounds" },
      residential: { type: "boolean" },
      reference: { type: "string", description: "Reference note for the label" }
    } }
  },
  {
    name: "add_address",
    description: "Save a contact to the address book. Use when the person dictates an address to remember (\"save Acme Corp, 123 Main St, Austin TX 78701\").",
    input_schema: { type: "object", required: ["name"], properties: {
      name: { type: "string" }, company: { type: "string" },
      address1: { type: "string" }, city: { type: "string" }, state: { type: "string" }, zip: { type: "string" },
      phone: { type: "string" }, email: { type: "string" }, country: { type: "string", description: "Country name or 2-letter code; omit for US" }
    } }
  },
  {
    name: "go_to_tab",
    description: "Navigate the app to a tab. Valid: ship, orders, shipments, drafts, returns, pickups, batch, invoices, rules (Autopilot), addresses, scan, dashboard, settings.",
    input_schema: { type: "object", required: ["tab"], properties: { tab: { type: "string" } } }
  }
];

const SYSTEM = (product, site) => `You are ${product} AI, the in-app assistant for ${product} (${site}) — a multi-carrier shipping platform with enterprise FedEx and DHL rates, built and supported by shipping people.

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
- Refer to yourself as ${product} AI (the feature is called "Ask ${product} AI"). If someone asks directly what technology powers you, you may say you are built on Anthropic's Claude models, but you speak for ${product} here — you do not represent Anthropic, and Anthropic does not endorse ${product}.
- Give genuinely useful shipping advice (packaging, service selection, residential vs commercial, dimensional weight, insurance) when asked.
- NEVER invent prices, discounts, or rate numbers. Real rates come from quoting in the Ship tab. For pricing, account, or billing specifics, direct people to support at support@${site}.
- Never discuss internal systems, credentials, API keys, other customers, or how the platform is built. Politely steer off-topic conversations back to shipping.
You are also a COPILOT with tools that act on the app:
- batch_orders stages a selection in the Batch tab; create_rule writes an Autopilot rule; apply_autopilot runs the rules; prefill_shipment opens a pre-filled Ship form; add_address saves a contact; go_to_tab navigates.
- Use tools eagerly when the person asks you to DO something ("batch the camp mugs", "select everything going to Texas under 5 lb", "make a rule that orders over $500 get overnight"). Prefer acting over explaining how to click.
- You STAGE work — you never print or book labels. After batch_orders or apply_autopilot, tell the person to review the selection and hit Create labels themselves. Never claim a label was created.
- The app context message lists the products, SKUs, states, zones, sources and saved address-book names that actually exist right now — match the person’s words to those real values (e.g. "mugs" → the product containing "Camp Mug"). If nothing plausibly matches, say so instead of guessing.
- Combine tools when natural: create_rule then apply_autopilot when someone says "make a rule and run it".
- Keep the accompanying text short: one line about what you staged and what to check.
- If the person is exploring the public demo, everything they see is sample data — encourage them to click around, and mention they can create a real account from the banner up top when ready.`;

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
  const J = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  if (event.httpMethod !== "POST") return J(405, { ok: false, error: "POST only" });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return J(200, { ok: false, error: "The assistant is offline right now — try again later." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return J(400, { ok: false, error: "Bad JSON" }); }
  const gateAuth = scAuth(body);
  if (!gateAuth) return J(200, { ok: false, authFailed: true, error: "Sign in to use the assistant." });
  if (!scAllow("assistant:" + gateAuth.uid, 30)) return J(200, { ok: false, error: "One moment \u2014 too many questions at once." });

  const raw = Array.isArray(body.messages) ? body.messages : [];
  const msgs = raw
    .slice(-MAX_MSGS)
    .map(m => ({ role: m && m.role === "assistant" ? "assistant" : "user", content: String((m && m.content) || "").slice(0, MAX_CHARS) }))
    .filter(m => m.content.trim());
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return J(400, { ok: false, error: "Send a user message." });

  /* brand comes from the client build (BRAND.product): "ShipHub" on freightwireship.com and
     the admin HQ, "ShippingCloud" on the retail site. Whitelisted — never trust free text. */
  const product = body.brand === "ShipHub" ? "ShipHub" : "ShippingCloud";
  const site = product === "ShipHub" ? "freightwireship.com" : "shippingcloud.net";

  const who = body.context === "admin" ? "the platform administrator"
    : body.context === "demo" ? "a visitor exploring the public demo (everything they see is sample data)"
    : "a signed-in customer";

  let ctx = "";
  try {
    if (body.appContext && typeof body.appContext === "object") {
      const raw = JSON.stringify(body.appContext);
      if (raw.length <= 6000) ctx = "\n\nCurrent app context (live, from the person’s browser): " + raw;
    }
  } catch (e) {}

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, tools: TOOLS, system: SYSTEM(product, site) + "\n\nThe person you are talking to right now is " + who + "." + ctx, messages: msgs })
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data) return J(200, { ok: false, error: (data && data.error && data.error.message) || ("Assistant error (" + r.status + ")") });
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").trim();
    const actions = (data.content || []).filter(c => c.type === "tool_use").map(c => ({ tool: c.name, input: c.input || {} })).slice(0, 5);
    return J(200, { ok: true, text: text || (actions.length ? "On it "+String.fromCharCode(8212) : "Hmm, I came back empty — try asking that another way?"), actions });
  } catch (e) {
    return J(200, { ok: false, error: "Couldn't reach the assistant just now — give it another try in a moment." });
  }
};
