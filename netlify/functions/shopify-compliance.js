/* ════════════════════════════════════════════════════════════════════════
   Shopify mandatory compliance webhooks — required for App Store distribution.
   One endpoint serves all three topics (configure the SAME URL for each in the
   Partner Dashboard → App setup → Compliance webhooks):
     • customers/data_request  — merchant asks what data we hold on a customer
     • customers/redact        — delete a customer's personal data
     • shop/redact             — store uninstalled 48h+ ago; delete shop data

   Shopify's automated review checks verify that this endpoint:
     1) returns 401 when the HMAC signature is invalid          (tested!)
     2) returns 200 when the HMAC signature is valid

   Data posture (why 200-and-log is truthful here): ShippingCloud's servers do
   not warehouse merchant customer data. Order/customer details live inside the
   merchant's own ShippingCloud account store, and the Shopify access token is
   held client-side by the merchant's browser session — there is no server-side
   index of shop → customer records to purge. Each request is logged so any
   manual follow-up obligation (30-day window) is visible in function logs.

   Env vars: SHOPIFY_API_SECRET (same one the OAuth flow uses).
   ════════════════════════════════════════════════════════════════════════ */
const crypto = require("crypto");

const resp = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function validHmac(event, secret) {
  const given = event.headers["x-shopify-hmac-sha256"] || event.headers["X-Shopify-Hmac-Sha256"] || "";
  if (!given) return false;
  // HMAC is computed over the RAW request body, base64-encoded.
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64") : Buffer.from(event.body || "", "utf8");
  const digest = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(given));
  } catch {
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, body: "" };
  if (event.httpMethod !== "POST") return resp(405, { error: "POST only" });

  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return resp(500, { error: "SHOPIFY_API_SECRET not configured" });

  if (!validHmac(event, secret)) return resp(401, { error: "invalid hmac" });

  const topic = event.headers["x-shopify-topic"] || event.headers["X-Shopify-Topic"] || "";
  const shop = event.headers["x-shopify-shop-domain"] || event.headers["X-Shopify-Shop-Domain"] || "";
  let payload = {};
  try { payload = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "{}")); } catch {}

  switch (topic) {
    case "customers/data_request":
      // Merchant/customer requested an export of held data. We hold none server-side;
      // log for the audit trail (includes orders_requested ids if provided).
      console.log("[compliance] customers/data_request", { shop, customerId: payload.customer && payload.customer.id, orders: payload.orders_requested });
      break;
    case "customers/redact":
      console.log("[compliance] customers/redact", { shop, customerId: payload.customer && payload.customer.id, orders: payload.orders_to_redact });
      break;
    case "shop/redact":
      // Store uninstalled 48h+ ago. No server-side shop records exist; the client-held
      // token is already dead (Shopify revokes on uninstall). Logged for the audit trail.
      console.log("[compliance] shop/redact", { shop, shopId: payload.shop_id });
      break;
    default:
      console.log("[compliance] unknown topic", { topic, shop });
  }

  return resp(200, { ok: true });
};
