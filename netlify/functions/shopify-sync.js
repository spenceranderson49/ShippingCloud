/* ════════════════════════════════════════════════════════════════════════
   Shopify → ShippingCloud : pull unfulfilled orders on demand.
   The SPA passes the { shop, token } it stored at connect time (same pattern
   as England creds), we fetch open/unfulfilled orders from the Shopify Admin
   API and transform them into ShippingCloud's order shape.
     POST { shop, token, sinceId? }  →  { ok, orders:[…] }
   ════════════════════════════════════════════════════════════════════════ */
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const API = "2024-07";
const { ensureFresh } = require("./shopify-token");

const gramsToLb = (g) => Math.round(((Number(g) || 0) / 453.592) * 100) / 100;

function transform(o) {
  const a = o.shipping_address || o.billing_address || {};
  const weightG = (o.line_items || []).reduce((s, li) => s + (Number(li.grams) || 0) * (Number(li.quantity) || 1), 0);
  const itemsTxt = (o.line_items || []).map((li) => `${li.quantity}× ${li.title}`).join(", ");
  const lineItems = (o.line_items || []).map((li) => ({
    id: S(li.id),
    title: S(li.title),
    variant: S(li.variant_title),
    sku: S(li.sku),
    quantity: Number(li.quantity) || 1,
    price: S(li.price),
    grams: Number(li.grams) || 0,
    productId: S(li.product_id),
    variantId: S(li.variant_id),
    image: "",   // filled by enrichLineItemImages() after the orders come back
  }));
  return {
    id: "shp_" + o.id,
    shopifyId: o.id,
    name: o.name || ("#" + o.order_number),
    customer: S(a.name) || S((o.customer && (o.customer.first_name + " " + o.customer.last_name))).trim() || S(o.email),
    company: S(a.company),
    address1: S(a.address1), address2: S(a.address2),
    city: S(a.city), state: S(a.province_code || a.province), zip: S(a.zip),
    country: S(a.country_code || a.country || "US"),
    phone: S(a.phone || o.phone || (o.customer && o.customer.phone)),
    email: S(o.email || (o.customer && o.customer.email)),
    total: S(o.total_price),
    subtotal: S(o.subtotal_price),
    shippingPaid: S(o.total_shipping_price_set && o.total_shipping_price_set.shop_money && o.total_shipping_price_set.shop_money.amount),
    tax: S(o.total_tax),
    currency: S(o.currency || "USD"),
    financialStatus: S(o.financial_status),
    weight: gramsToLb(weightG) || 1,
    items: itemsTxt,
    lineItems: lineItems,
    itemCount: (o.line_items || []).reduce((s, li) => s + (Number(li.quantity) || 0), 0),
    source: "Shopify",
    shippingService: S((o.shipping_lines && o.shipping_lines[0] && o.shipping_lines[0].title) || "Standard"),
    status: "unfulfilled",
    date: S(o.created_at).slice(0, 10),
    note: S(o.note),
  };
}

/* Shopify order line_items don't carry image URLs, so do ONE products fetch for every product in the
   batch and map product/variant → photo. Best-effort: a failure just leaves images blank. */
async function enrichLineItemImages(orders, shop, token) {
  try {
    const ids = [...new Set(orders.flatMap((o) => (o.lineItems || []).map((li) => li.productId).filter(Boolean)))].slice(0, 250);
    if (!ids.length) return;
    const url = `https://${shop}/admin/api/${API}/products.json?ids=${ids.join(",")}&fields=id,image,images,variants&limit=250`;
    const r = await fetch(url, { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } });
    if (!r.ok) return;
    const d = await r.json().catch(() => ({}));
    const prodImg = {};      // product_id → featured image src
    const varImg = {};       // variant_id → its own image src (falls back to product featured)
    for (const p of (d.products || [])) {
      const pid = S(p.id);
      const featured = (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || "";
      if (featured) prodImg[pid] = featured;
      const byImgId = {}; for (const im of (p.images || [])) byImgId[S(im.id)] = im.src;
      for (const v of (p.variants || [])) {
        const vid = S(v.id);
        varImg[vid] = (v.image_id && byImgId[S(v.image_id)]) || featured || "";
      }
    }
    for (const o of orders) for (const li of (o.lineItems || [])) {
      li.image = varImg[li.variantId] || prodImg[li.productId] || "";
    }
  } catch (e) { /* images are a nicety — never fail the sync over them */ }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, body: "" };
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let body = {}; try { body = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON body" }); }
    const shop = S(body.shop).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || (!S(body.token) && !S(body.refreshToken))) return J({ ok: false, error: "Connect a Shopify store first (missing shop/token)." });
    /* Expiring tokens: refresh before use if near expiry, then hand the rotated token back to the
       SPA as `newAuth` so the stored connection stays current. `let` so the fresh token is used below. */
    const fresh = await ensureFresh({ shop, token: body.token, refreshToken: body.refreshToken, tokenExp: body.tokenExp });
    let token = fresh.token;
    const RA = (o) => J(fresh.refreshed ? { ...o, newAuth: { token: fresh.token, refreshToken: fresh.refreshToken, tokenExp: fresh.tokenExp } } : o);
    if (!token) return RA({ ok: false, error: "Shopify session expired — reconnect the store.", needsReconnect: true });

    // ── carrier service: register/inspect the live checkout-rates callback ──
    if (body.action === "installCarrier" || body.action === "carrierStatus") {
      const crypto = require("crypto");
      const uid = String(body.uid || "");
      if (body.action === "installCarrier" && !uid) return J({ ok: false, error: "Missing account id." });
      const cbKey = crypto.createHmac("sha256", process.env.SESSION_SECRET || "").update("carrier:" + uid).digest("hex").slice(0, 32);
      const appUrl = (process.env.APP_URL || "").replace(/\/+$/, "");
      const callback = appUrl + "/.netlify/functions/shopify-rates?uid=" + encodeURIComponent(uid) + "&key=" + cbKey;
      const listUrl = `https://${shop}/admin/api/${API}/carrier_services.json`;
      const lr = await fetch(listUrl, { headers: { "X-Shopify-Access-Token": token } });
      const ld = await lr.json().catch(() => ({}));
      if (!lr.ok) return J({ ok: false, error: "Shopify " + lr.status + ": " + JSON.stringify(ld).slice(0, 200) + (lr.status === 403 ? " \u2014 the app needs the write_shipping scope." : "") });
      const mine = (ld.carrier_services || []).find((c) => /shippingcloud/i.test(c.name || ""));
      if (body.action === "carrierStatus") return RA({ ok: true, installed: !!mine, service: mine || null, callback });
      const payload = { carrier_service: { name: "ShippingCloud", callback_url: callback, service_discovery: true, format: "json" } };
      const wr = mine
        ? await fetch(`https://${shop}/admin/api/${API}/carrier_services/${mine.id}.json`, { method: "PUT", headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ carrier_service: { id: mine.id, ...payload.carrier_service } }) })
        : await fetch(listUrl, { method: "POST", headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const wd = await wr.json().catch(() => ({}));
      if (!wr.ok) return J({ ok: false, error: "Shopify " + wr.status + ": " + JSON.stringify(wd.errors || wd).slice(0, 250) + (wr.status === 422 && /carrier/i.test(JSON.stringify(wd)) ? " \u2014 carrier-calculated rates may not be enabled on this store\u2019s Shopify plan." : "") });
      return RA({ ok: true, installed: true, updated: !!mine, service: wd.carrier_service || null, callback });
    }

    // ── products pull: build a dimensioned catalog from Shopify variants ──
    if (body.action === "products") {
      const purl = `https://${shop}/admin/api/${API}/products.json?limit=250`;
      let pr, ptext, pd = null;
      try {
        pr = await fetch(purl, { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } });
        ptext = await pr.text(); try { pd = JSON.parse(ptext); } catch {}
      } catch (e) { return J({ ok: false, error: "Shopify fetch failed: " + (e && e.message) }); }
      if (pr.status === 401) return RA({ ok: false, error: "Shopify rejected the token (401) — reconnect the store.", needsReconnect: true });
      if (!pr.ok) return RA({ ok: false, error: "Shopify HTTP " + pr.status });
      const products = [];
      for (const p2 of (pd.products || [])) {
        for (const v of (p2.variants || [])) {
          const title = (p2.variants || []).length > 1 ? `${p2.title} — ${v.title}` : p2.title;
          products.push({
            id: "shpf_" + v.id,
            sku: S(v.sku),
            name: S(title),
            wt: gramsToLb(v.grams || (v.weight_unit === "lb" ? (v.weight || 0) * 453.592 : v.weight_unit === "oz" ? (v.weight || 0) * 28.35 : v.weight_unit === "kg" ? (v.weight || 0) * 1000 : v.weight || 0)),
            l: 0, w: 0, h: 0,
            value: Number(v.price) || 0,
            origin: "", hs: "",
            shopifyVariantId: S(v.id)
          });
        }
      }
      return RA({ ok: true, count: products.length, products });
    }

    const params = new URLSearchParams({ status: "open", fulfillment_status: "unfulfilled", limit: "100", order: "created_at desc" });
    if (body.sinceId) params.set("since_id", S(body.sinceId));
    const url = `https://${shop}/admin/api/${API}/orders.json?${params.toString()}`;

    let r, text, d = null;
    try {
      r = await fetch(url, { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } });
      text = await r.text(); try { d = JSON.parse(text); } catch {}
    } catch (e) { return J({ ok: false, error: "Shopify fetch failed: " + (e && e.message) }); }
    if (r.status === 401) return RA({ ok: false, error: "Shopify rejected the token (401) — reconnect the store.", needsReconnect: true });
    if (!r.ok) return RA({ ok: false, error: "Shopify HTTP " + r.status + (d && d.errors ? ": " + JSON.stringify(d.errors) : (text ? ": " + text.slice(0, 200) : "")) });

    const orders = (d.orders || []).map(transform);
    await enrichLineItemImages(orders, shop, token);   // attach product photos so order details show pictures
    return RA({ ok: true, count: orders.length, orders });
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
