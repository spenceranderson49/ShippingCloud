/* ════════════════════════════════════════════════════════════════════════
   Wix eCommerce  ⇄  ShippingCloud
   Auth: API key (Wix → Settings → API Keys) + Site ID. Token auth via headers.
   App passes { apiKey, siteId } in the body.
     POST { action:"sync",    apiKey, siteId }                          → { ok, orders }
     POST { action:"fulfill", apiKey, siteId, orderId, tracking, carrier }
   ════════════════════════════════════════════════════════════════════════ */
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const BASE = "https://www.wixapis.com";
const H = (c) => ({ "Authorization": c.apiKey, "wix-site-id": c.siteId, "Content-Type": "application/json" });

async function syncOrders(c) {
  const body = { query: { filter: { "fulfillmentStatus": "NOT_FULFILLED" }, paging: { limit: 50 } } };
  const r = await fetch(BASE + "/ecom/v1/orders/search", { method: "POST", headers: H(c), body: JSON.stringify(body) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
  if (r.status === 401 || r.status === 403) return { ok: false, error: "Wix rejected the API key (" + r.status + ")." };
  if (!r.ok) return { ok: false, error: "Wix HTTP " + r.status + (t ? ": " + t.slice(0, 200) : "") };
  const orders = ((d && d.orders) || []).map((o) => {
    const ship = (o.shippingInfo && o.shippingInfo.logistics && o.shippingInfo.logistics.shippingDestination) || {};
    const a = ship.address || {};
    const cn = ship.contactDetails || {};
    return {
      id: "wix-" + o.id, wixId: o.id, name: "#" + (o.number || S(o.id).slice(-6)),
      customer: [cn.firstName, cn.lastName].filter(Boolean).join(" "),
      company: S(a.company), address1: S(a.addressLine1 || a.addressLine), address2: S(a.addressLine2),
      city: S(a.city), state: S(a.subdivisionFullname || a.subdivision), zip: S(a.postalCode), country: S(a.country || "US"),
      phone: S(cn.phone), email: S(o.buyerInfo && o.buyerInfo.email),
      total: o.priceSummary && o.priceSummary.total ? S(o.priceSummary.total.amount) : "",
      weight: 1, items: (o.lineItems || []).map((li) => `${li.quantity}× ${(li.productName && li.productName.original) || ""}`).join(", "),
      source: "Wix", shippingService: S(o.shippingInfo && o.shippingInfo.title) || "Standard",
      status: "unfulfilled", date: S(o.createdDate).slice(0, 10),
    };
  });
  return { ok: true, count: orders.length, orders };
}

async function fulfill(c, b) {
  const payload = { fulfillment: { lineItems: (b.lineItems || []).map((li) => ({ id: li.id, quantity: li.quantity || 1 })), trackingInfo: { trackingNumber: S(b.tracking), shippingProvider: S(b.carrier) || "FedEx", trackingLink: S(b.trackingUrl) } } };
  const r = await fetch(BASE + `/ecom/v1/fulfillments/orders/${encodeURIComponent(b.orderId)}/fulfillments`, { method: "POST", headers: H(c), body: JSON.stringify(payload) });
  const t = await r.text();
  if (!r.ok) return { ok: false, error: "Wix fulfill HTTP " + r.status + (t ? ": " + t.slice(0, 250) : "") };
  return { ok: true };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); }
    const c = { apiKey: S(b.apiKey).trim(), siteId: S(b.siteId).trim() };
    if (!c.apiKey || !c.siteId) return J({ ok: false, error: "Missing apiKey/siteId." });
    if (b.action === "fulfill") return J(await fulfill(c, b));
    return J(await syncOrders(c));
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
