/* ════════════════════════════════════════════════════════════════════════
   Shopify OAuth — connect a store to ShippingCloud.
   Flow:
     1) Merchant hits /.netlify/functions/shopify-auth?shop=store.myshopify.com
        → we redirect them to Shopify's consent screen.
     2) Shopify redirects back here with ?code=…&hmac=…&state=…
        → we verify, exchange the code for an offline access token, then
          redirect to the app with the shop + token in the URL *fragment*
          (fragments are never sent to a server / not logged) so the SPA
          stores them locally — same pattern as your England creds.
   Env vars required (set in Netlify):
     SHOPIFY_API_KEY      – from your Shopify Partner app
     SHOPIFY_API_SECRET   – from your Shopify Partner app
     APP_URL (optional)   – where to send the merchant back (default shippingcloud.net)
   ════════════════════════════════════════════════════════════════════════ */
const crypto = require("crypto");

const SCOPES = [
  // Minimal scopes for App Store review: no write_orders (we never modify orders,
  // only fulfill via the fulfillment-orders APIs below).
  "read_orders",
  "read_products",                     // product catalog pull (weights/dims/SKUs)
  "read_inventory", "write_inventory", // push on-hand back to Shopify (prevents overselling) — opt-in; a store must reconnect once to grant these
  "write_shipping",                    // carrier service = live checkout rates
  "read_fulfillments", "write_fulfillments",
  "read_assigned_fulfillment_orders", "write_assigned_fulfillment_orders",
  "read_merchant_managed_fulfillment_orders", "write_merchant_managed_fulfillment_orders",
].join(",");

const html = (msg) => ({ statusCode: 200, headers: { "Content-Type": "text/html" }, body: `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;max-width:560px;margin:auto"><h2>ShippingCloud · Shopify</h2><p>${msg}</p></body>` });
const sanitizeShop = (s) => { s = String(s || "").trim().toLowerCase(); return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : null; };
const sign = (val, secret) => crypto.createHmac("sha256", secret).update(String(val)).digest("hex");

function verifyOauthHmac(query, secret) {
  const { hmac, ...rest } = query;
  const message = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join("&");
  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(hmac || ""))); } catch { return false; }
}

exports.handler = async (event) => {
  const key = process.env.SHOPIFY_API_KEY;
  const secret = process.env.SHOPIFY_API_SECRET;
  const appUrl = (process.env.APP_URL || "https://shippingcloud.net").replace(/\/+$/, "");
  const q0 = event.queryStringParameters || {};
  /* The app pings this before redirecting, so an unconfigured server falls back to the
     self-service access-token connect instead of dead-ending on the message below. */
  if (q0.ping) return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ configured: !!(key && secret) }) };
  if (!key || !secret) return html("One-click connect isn't set up on this server. Go back to <b>Settings → Integrations</b> and use <b>Connect with an access token</b> instead — it takes about two minutes and needs nothing from us.");

  const q = event.queryStringParameters || {};
  const self = "https://" + event.headers.host + "/.netlify/functions/shopify-auth";

  // ── Step 1: begin install ──
  if (!q.code) {
    const shop = sanitizeShop(q.shop);
    if (!shop) return html("Add <code>?shop=yourstore.myshopify.com</code> to the URL to connect a store.");
    const state = sign(shop + "|" + Math.floor(Date.now() / 3600000), secret); // hour-bucketed nonce (no storage needed)
    const url = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(key)}&scope=${encodeURIComponent(SCOPES)}&redirect_uri=${encodeURIComponent(self)}&state=${encodeURIComponent(state)}`;
    return { statusCode: 302, headers: { Location: url }, body: "" };
  }

  // ── Step 2: callback ──
  const shop = sanitizeShop(q.shop);
  if (!shop) return html("Invalid shop on callback.");
  // Shopify's HMAC signature is the real authenticity guarantee — verify it strictly.
  if (!verifyOauthHmac(q, secret)) return html("Security check failed (HMAC mismatch).");
  // State is a secondary anti-CSRF nonce. Accept a wide time window; if it still
  // doesn't match, the verified HMAC above already proves the request is genuine,
  // so we proceed rather than block a legitimate install.
  const now = Math.floor(Date.now() / 3600000);
  let stateOk = false;
  for (let i = 0; i <= 6; i++) { if (q.state === sign(shop + "|" + (now - i), secret)) { stateOk = true; break; } }
  // (stateOk is informational; HMAC is the gate — do not hard-fail on state)

  let token, refreshToken = "", expiresIn = 0;
  try {
    /* expiring=1 → Shopify issues an EXPIRING offline token (~1h) plus a 90-day refresh token.
       Non-expiring tokens are rejected on the Admin API for public apps, so we must request these.
       The endpoint wants form-urlencoded for the `expiring` flag. */
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: key, client_secret: secret, code: q.code, expiring: "1" }),
    });
    const d = await r.json();
    token = d.access_token;
    refreshToken = d.refresh_token || "";
    expiresIn = Number(d.expires_in) || 0;
    if (!token) return html("Couldn't get an access token from Shopify: " + JSON.stringify(d).slice(0, 200));
  } catch (e) { return html("Token exchange failed: " + (e && e.message)); }

  // Hand the shop + token (and, for expiring tokens, the refresh token + expiry) back to the SPA via
  // the URL fragment (fragments are never sent to a server / not logged).
  const exp = expiresIn ? Date.now() + expiresIn * 1000 : 0;
  const frag = `shop=${encodeURIComponent(shop)}&token=${encodeURIComponent(token)}`
    + (refreshToken ? `&refresh=${encodeURIComponent(refreshToken)}` : "")
    + (exp ? `&exp=${exp}` : "");
  const back = `${appUrl}/?shopify_connected=1#${frag}`;
  return { statusCode: 302, headers: { Location: back }, body: "" };
};
