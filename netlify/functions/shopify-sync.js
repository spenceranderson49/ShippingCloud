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

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, body: "" };
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let body = {}; try { body = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON body" }); }
    const shop = S(body.shop).toLowerCase();
    const token = S(body.token);
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !token) return J({ ok: false, error: "Connect a Shopify store first (missing shop/token)." });

    const params = new URLSearchParams({ status: "open", fulfillment_status: "unfulfilled", limit: "100", order: "created_at desc" });
    if (body.sinceId) params.set("since_id", S(body.sinceId));
    const url = `https://${shop}/admin/api/${API}/orders.json?${params.toString()}`;

    let r, text, d = null;
    try {
      r = await fetch(url, { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } });
      text = await r.text(); try { d = JSON.parse(text); } catch {}
    } catch (e) { return J({ ok: false, error: "Shopify fetch failed: " + (e && e.message) }); }
    if (r.status === 401) return J({ ok: false, error: "Shopify rejected the token (401) — reconnect the store." });
    if (!r.ok) return J({ ok: false, error: "Shopify HTTP " + r.status + (d && d.errors ? ": " + JSON.stringify(d.errors) : (text ? ": " + text.slice(0, 200) : "")) });

    const orders = (d.orders || []).map(transform);
    return J({ ok: true, count: orders.length, orders });
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
