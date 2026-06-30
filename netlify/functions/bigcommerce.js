/* ════════════════════════════════════════════════════════════════════════
   BigCommerce  ⇄  ShippingCloud
   Auth: store hash + API account token (no OAuth — create a "Store-level API
   account" in BigCommerce → Settings → API accounts). The app passes
   { storeHash, token } in the body (same pattern as England/Shopify).
     POST { action:"sync",    storeHash, token }                       → { ok, orders }
     POST { action:"fulfill", storeHash, token, orderId, tracking, carrier, service }
   ════════════════════════════════════════════════════════════════════════ */
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));

function base(h) { return `https://api.bigcommerce.com/stores/${encodeURIComponent(h)}`; }
function H(token) { return { "X-Auth-Token": token, "Content-Type": "application/json", "Accept": "application/json" }; }

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
  return { r, d, t };
}

async function syncOrders(c) {
  // status_id 11 = Awaiting Fulfillment. Pull those.
  const { r, d, t } = await getJSON(base(c.storeHash) + "/v2/orders?status_id=11&limit=50", { headers: H(c.token) });
  if (r.status === 401) return { ok: false, error: "BigCommerce rejected the token (401)." };
  if (r.status === 204) return { ok: true, orders: [] };
  if (!r.ok) return { ok: false, error: "BigCommerce HTTP " + r.status + (t ? ": " + t.slice(0, 200) : "") };
  const list = Array.isArray(d) ? d : [];
  const orders = [];
  for (const o of list) {
    let addr = {};
    try { const a = await getJSON(base(c.storeHash) + `/v2/orders/${o.id}/shippingaddresses`, { headers: H(c.token) }); addr = (Array.isArray(a.d) && a.d[0]) || {}; } catch {}
    orders.push({
      id: "bc-" + o.id, bigcommerceId: o.id, name: "#" + o.id,
      customer: [addr.first_name, addr.last_name].filter(Boolean).join(" ") || S(o.billing_address && (o.billing_address.first_name + " " + o.billing_address.last_name)).trim(),
      company: S(addr.company), address1: S(addr.street_1), address2: S(addr.street_2),
      city: S(addr.city), state: S(addr.state), zip: S(addr.zip), country: S(addr.country_iso2 || "US"),
      phone: S(addr.phone || (o.billing_address && o.billing_address.phone)), email: S(o.billing_address && o.billing_address.email),
      total: S(o.total_inc_tax), weight: Number(o.items_total) || 1, items: S(o.items_total) + " item(s)",
      source: "BigCommerce", shippingService: "Standard", status: "unfulfilled", date: S(o.date_created).slice(5, 16),
      orderAddressId: addr.id,
    });
  }
  return { ok: true, count: orders.length, orders };
}

async function fulfill(c, b) {
  // create a shipment on the order with tracking
  let items = [];
  try {
    const p = await getJSON(base(c.storeHash) + `/v2/orders/${b.orderId}/products`, { headers: H(c.token) });
    items = (Array.isArray(p.d) ? p.d : []).map((it) => ({ order_product_id: it.id, quantity: it.quantity }));
  } catch {}
  const payload = { order_address_id: b.orderAddressId, tracking_number: S(b.tracking), shipping_method: S(b.service) || "FedEx", shipping_provider: "", comments: "via ShippingCloud", items };
  const { r, d, t } = await getJSON(base(c.storeHash) + `/v2/orders/${b.orderId}/shipments`, { method: "POST", headers: H(c.token), body: JSON.stringify(payload) });
  if (!r.ok) return { ok: false, error: "Shipment HTTP " + r.status + (t ? ": " + t.slice(0, 200) : "") };
  // flip order to Shipped (status_id 2)
  try { await getJSON(base(c.storeHash) + `/v2/orders/${b.orderId}`, { method: "PUT", headers: H(c.token), body: JSON.stringify({ status_id: 2 }) }); } catch {}
  return { ok: true, shipmentId: d && d.id };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); }
    const c = { storeHash: S(b.storeHash).trim(), token: S(b.token).trim() };
    if (!c.storeHash || !c.token) return J({ ok: false, error: "Missing storeHash/token." });
    if (b.action === "fulfill") return J(await fulfill(c, b));
    return J(await syncOrders(c));
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
