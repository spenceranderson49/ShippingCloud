/* ════════════════════════════════════════════════════════════════════════
   Push on-hand stock levels back to Shopify so the store can't oversell.
   The SPA passes { shop, token, updates:[{sku, available}] }. We resolve the
   store's primary location, map each SKU → inventory_item_id via the products
   API, and set the level. Requires the store to have reconnected with the
   read_inventory/write_inventory scopes (added to shopify-auth).
     POST { shop, token, updates:[{sku, available}] }  →  { ok, synced, skipped, notes }
   ════════════════════════════════════════════════════════════════════════ */
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const API = "2024-07";
const { ensureFresh } = require("./shopify-token");

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, body: "" };
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); }
    const shop = S(b.shop).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || (!S(b.token) && !S(b.refreshToken))) return J({ ok: false, error: "Connect a Shopify store first." });
    /* Expiring tokens: refresh if near expiry, return the rotated token to the SPA as `newAuth`. */
    const fresh = await ensureFresh({ shop, token: b.token, refreshToken: b.refreshToken, tokenExp: b.tokenExp });
    const token = fresh.token;
    const RA = (o) => J(fresh.refreshed ? { ...o, newAuth: { token: fresh.token, refreshToken: fresh.refreshToken, tokenExp: fresh.tokenExp } } : o);
    if (!token) return RA({ ok: false, error: "Shopify session expired — reconnect the store.", needsReconnect: true });
    const updates = Array.isArray(b.updates) ? b.updates.slice(0, 500) : [];
    if (!updates.length) return RA({ ok: true, synced: 0, skipped: 0 });
    const H = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };

    // 1) primary (or first active) location
    const lr = await fetch(`https://${shop}/admin/api/${API}/locations.json`, { headers: H });
    if (lr.status === 403) return RA({ ok: false, error: "This store needs to reconnect to grant inventory access (read_inventory / write_inventory).", needsReconnect: true });
    const ld = await lr.json().catch(() => ({}));
    if (!lr.ok) return J({ ok: false, error: "Shopify locations HTTP " + lr.status });
    const locs = ld.locations || [];
    const loc = locs.find((l) => l.active !== false) || locs[0];
    if (!loc) return J({ ok: false, error: "No Shopify location found." });

    // 2) map sku → inventory_item_id (first 250 products/variants)
    const pr = await fetch(`https://${shop}/admin/api/${API}/products.json?limit=250&fields=variants`, { headers: H });
    const pd = await pr.json().catch(() => ({}));
    if (!pr.ok) return J({ ok: false, error: "Shopify products HTTP " + pr.status });
    const bySku = {}; const tracked = {};
    for (const p of (pd.products || [])) for (const v of (p.variants || [])) {
      const sku = S(v.sku).trim().toLowerCase();
      if (sku) { bySku[sku] = v.inventory_item_id; tracked[sku] = v.inventory_management === "shopify"; }
    }

    // 3) set levels
    let synced = 0, skipped = 0; const notes = [];
    for (const u of updates) {
      const sku = S(u.sku).trim().toLowerCase();
      const available = Math.max(0, Math.round(+u.available || 0));
      const invItem = bySku[sku];
      if (!invItem) { skipped++; continue; }                       // SKU not in Shopify
      if (!tracked[sku]) { skipped++; notes.push(sku + ": tracking off in Shopify"); continue; }
      const r = await fetch(`https://${shop}/admin/api/${API}/inventory_levels/set.json`, { method: "POST", headers: H, body: JSON.stringify({ location_id: loc.id, inventory_item_id: invItem, available }) });
      if (r.ok) synced++; else { skipped++; if (notes.length < 8) notes.push(sku + ": HTTP " + r.status); }
    }
    return RA({ ok: true, synced, skipped, location: loc.name || "", notes: notes.slice(0, 8) });
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
