/* ════════════════════════════════════════════════════════════════════════
   Shopify expiring-offline-token refresh (shared helper).
   Shopify requires EXPIRING offline access tokens for public apps (non-expiring
   tokens are rejected on the Admin API with a 403). Expiring tokens live ~1 hour
   and come with a 90-day refresh token. Refreshing needs the app's CLIENT SECRET,
   so it MUST happen server-side — never in the browser.
     ensureFresh({shop, token, refreshToken, tokenExp}) → {token, refreshToken, tokenExp, refreshed}
   Every Shopify function calls this before hitting the Admin API, and returns the
   new {token, refreshToken, tokenExp} to the SPA (as `newAuth`) whenever it rotates,
   so the stored connection stays current.
   ════════════════════════════════════════════════════════════════════════ */
const S = (v) => (v == null ? "" : String(v));
const isShop = (s) => /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(String(s || ""));

/* POST /admin/oauth/access_token with grant_type=refresh_token → new access + refresh token.
   Shopify returns the SAME refreshed response for ~1h, so a retried refresh is safe. */
async function shopifyRefresh(shop, refreshToken) {
  const key = process.env.SHOPIFY_API_KEY, secret = process.env.SHOPIFY_API_SECRET;
  if (!key || !secret || !refreshToken || !isShop(shop)) return null;
  try {
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: key, client_secret: secret, grant_type: "refresh_token", refresh_token: S(refreshToken) }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token) return null;
    return {
      token: d.access_token,
      refreshToken: d.refresh_token || refreshToken,
      tokenExp: Date.now() + ((Number(d.expires_in) || 3600) * 1000),
    };
  } catch (e) { return null; }
}

/* Refresh proactively when we hold a refresh token and the access token is missing or within
   2 minutes of expiry. A legacy connection with a refresh token but no stored expiry is treated
   as "refresh now". Connections with no refresh token (legacy non-expiring, or pasted tokens)
   pass straight through unchanged. */
async function ensureFresh(conn) {
  const shop = S(conn && conn.shop).toLowerCase();
  let token = S(conn && conn.token), refreshToken = S(conn && conn.refreshToken), tokenExp = Number(conn && conn.tokenExp) || 0;
  if (refreshToken && (!token || !tokenExp || Date.now() > tokenExp - 120000)) {
    const nu = await shopifyRefresh(shop, refreshToken);
    if (nu) return { ...nu, refreshed: true };
  }
  return { token, refreshToken, tokenExp, refreshed: false };
}

exports.shopifyRefresh = shopifyRefresh;
exports.ensureFresh = ensureFresh;
/* Netlify bundles every .js here as a function; this one is import-only. A harmless handler keeps
   a stray direct request from erroring — nothing ever calls it over HTTP. */
exports.handler = async () => ({ statusCode: 404, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "not a public endpoint" }) });
