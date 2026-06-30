/* ════════════════════════════════════════════════════════════════════════
   WooCommerce  ⇄  ShippingCloud
   Auth: REST API consumer key + secret (WooCommerce → Settings → Advanced →
   REST API → Add key, Read/Write). App passes { storeUrl, key, secret }.
     POST { action:"sync",    storeUrl, key, secret }                       → { ok, orders }
     POST { action:"fulfill", storeUrl, key, secret, orderId, tracking, carrier }
   Note: tracking numbers in Woo live in the "Shipment Tracking" plugin; if it
   isn't installed we mark the order Completed and add an order note w/ tracking.
   ════════════════════════════════════════════════════════════════════════ */
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const auth = (c) => "Basic " + Buffer.from(c.key + ":" + c.secret).toString("base64");
const apiBase = (u) => S(u).replace(/\/+$/, "") + "/wp-json/wc/v3";

async function syncOrders(c) {
  const url = apiBase(c.storeUrl) + "/orders?status=processing&per_page=50";
  const r = await fetch(url, { headers: { "Authorization": auth(c), "Content-Type": "application/json" } });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
  if (r.status === 401) return { ok: false, error: "WooCommerce rejected the key/secret (401)." };
  if (!r.ok) return { ok: false, error: "WooCommerce HTTP " + r.status + (t ? ": " + t.slice(0, 200) : "") };
  const orders = (Array.isArray(d) ? d : []).map((o) => {
    const a = o.shipping && o.shipping.address_1 ? o.shipping : o.billing || {};
    return {
      id: "woo-" + o.id, woocommerceId: o.id, name: "#" + o.number,
      customer: [a.first_name, a.last_name].filter(Boolean).join(" "),
      company: S(a.company), address1: S(a.address_1), address2: S(a.address_2),
      city: S(a.city), state: S(a.state), zip: S(a.postcode), country: S(a.country || "US"),
      phone: S((o.billing && o.billing.phone) || a.phone), email: S(o.billing && o.billing.email),
      total: S(o.total), weight: (o.line_items || []).reduce((s, li) => s + (Number(li.quantity) || 1), 0) || 1,
      items: (o.line_items || []).map((li) => `${li.quantity}× ${li.name}`).join(", "),
      source: "WooCommerce", shippingService: (o.shipping_lines && o.shipping_lines[0] && o.shipping_lines[0].method_title) || "Standard",
      status: "unfulfilled", date: S(o.date_created).slice(0, 10),
    };
  });
  return { ok: true, count: orders.length, orders };
}

async function fulfill(c, b) {
  // mark completed + add a note carrying the tracking number
  const note = `Shipped via ${S(b.carrier) || "FedEx"} — tracking ${S(b.tracking)}${b.trackingUrl ? " (" + b.trackingUrl + ")" : ""} [ShippingCloud]`;
  const r = await fetch(apiBase(c.storeUrl) + `/orders/${b.orderId}`, { method: "PUT", headers: { "Authorization": auth(c), "Content-Type": "application/json" }, body: JSON.stringify({ status: "completed" }) });
  const t = await r.text();
  if (!r.ok) return { ok: false, error: "Woo update HTTP " + r.status + (t ? ": " + t.slice(0, 200) : "") };
  try { await fetch(apiBase(c.storeUrl) + `/orders/${b.orderId}/notes`, { method: "POST", headers: { "Authorization": auth(c), "Content-Type": "application/json" }, body: JSON.stringify({ note, customer_note: true }) }); } catch {}
  return { ok: true };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); }
    const c = { storeUrl: S(b.storeUrl).trim(), key: S(b.key).trim(), secret: S(b.secret).trim() };
    if (!c.storeUrl || !c.key || !c.secret) return J({ ok: false, error: "Missing storeUrl/key/secret." });
    if (b.action === "fulfill") return J(await fulfill(c, b));
    return J(await syncOrders(c));
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
