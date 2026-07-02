/* ════════════════════════════════════════════════════════════════════════
   ShippingCloud → Shopify : push tracking + mark fulfilled.
   When a label is booked in ShippingCloud for a Shopify order, the SPA calls
   this with the stored { shop, token } plus the order id + tracking. We use
   the modern Fulfillment Orders API (required on Shopify 2023+):
     1) GET  orders/{id}/fulfillment_orders.json   → open fulfillment orders
     2) POST fulfillments.json with tracking_info   → fulfills + notifies buyer
     POST { shop, token, shopifyId, tracking, trackingUrl?, carrier? }
       → { ok, fulfillmentId?, status? }
   ════════════════════════════════════════════════════════════════════════ */
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const API = "2024-07";

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, body: "" };
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let body = {}; try { body = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON body" }); }

    const shop = S(body.shop).toLowerCase();
    const token = S(body.token);
    const orderId = S(body.shopifyId || body.orderId);
    const tracking = S(body.tracking);
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !token) return J({ ok: false, error: "Missing shop/token." });
    if (!orderId) return J({ ok: false, error: "Missing Shopify order id." });

    const H = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };

    // 1) get open fulfillment orders for this order
    let fos = [];
    try {
      const r = await fetch(`https://${shop}/admin/api/${API}/orders/${encodeURIComponent(orderId)}/fulfillment_orders.json`, { headers: H });
      const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
      if (r.status === 401) return J({ ok: false, error: "Shopify rejected the token (401) — reconnect the store." });
      if (!r.ok) return J({ ok: false, error: "Fulfillment-orders HTTP " + r.status + (t ? ": " + t.slice(0, 200) : "") });
      fos = (d.fulfillment_orders || []).filter((f) => ["open", "in_progress", "scheduled"].includes(f.status));
    } catch (e) { return J({ ok: false, error: "Fulfillment-orders fetch failed: " + (e && e.message) }); }
    if (!fos.length) return J({ ok: false, error: "No open fulfillment orders (order may already be fulfilled)." });

    // 2) create the fulfillment with tracking
    const payload = {
      fulfillment: {
        line_items_by_fulfillment_order: fos.map((f) => ({ fulfillment_order_id: f.id })),
        tracking_info: { number: tracking || null, url: S(body.trackingUrl) || null, company: S(body.carrier) || "FedEx" },
        notify_customer: body.notifyCustomer !== false,
      },
    };
    let r2, t2, d2 = null;
    try {
      r2 = await fetch(`https://${shop}/admin/api/${API}/fulfillments.json`, { method: "POST", headers: H, body: JSON.stringify(payload) });
      t2 = await r2.text(); try { d2 = JSON.parse(t2); } catch {}
    } catch (e) { return J({ ok: false, error: "Create-fulfillment failed: " + (e && e.message) }); }
    if (!r2.ok) return J({ ok: false, error: "Fulfillment HTTP " + r2.status + (d2 && d2.errors ? ": " + JSON.stringify(d2.errors) : (t2 ? ": " + t2.slice(0, 200) : "")) });

    const f = (d2 && d2.fulfillment) || {};
    return J({ ok: true, fulfillmentId: f.id || null, status: f.status || "success" });
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
