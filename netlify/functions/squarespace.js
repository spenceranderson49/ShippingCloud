/* ════════════════════════════════════════════════════════════════════════
   Squarespace Commerce  ⇄  ShippingCloud
   Auth: API key (Squarespace → Settings → Advanced → Developer API Keys, with
   Orders + Inventory read/write). Token auth via Bearer.
   App passes { apiKey } in the body.
     POST { action:"sync",    apiKey }                                  → { ok, orders }
     POST { action:"fulfill", apiKey, orderId, tracking, carrier }
   ════════════════════════════════════════════════════════════════════════ */
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const BASE = "https://api.squarespace.com/1.0/commerce";
const H = (k) => ({ "Authorization": "Bearer " + k, "Content-Type": "application/json", "User-Agent": "ShippingCloud" });

async function syncOrders(c) {
  const r = await fetch(BASE + "/orders?fulfillmentStatus=PENDING", { headers: H(c.apiKey) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
  if (r.status === 401 || r.status === 403) return { ok: false, error: "Squarespace rejected the key (" + r.status + ")." };
  if (!r.ok) return { ok: false, error: "Squarespace HTTP " + r.status + (t ? ": " + t.slice(0, 200) : "") };
  const orders = ((d && d.result) || []).map((o) => {
    const a = o.shippingAddress || {};
    return {
      id: "sqsp-" + o.id, squarespaceId: o.id, name: "#" + (o.orderNumber || S(o.id).slice(-6)),
      customer: [a.firstName, a.lastName].filter(Boolean).join(" ") || S(o.customerEmail),
      company: "", address1: S(a.address1), address2: S(a.address2),
      city: S(a.city), state: S(a.state), zip: S(a.postalCode), country: S(a.countryCode || "US"),
      phone: S(a.phone), email: S(o.customerEmail),
      total: o.grandTotal ? S(o.grandTotal.value) : "",
      weight: 1, items: (o.lineItems || []).map((li) => `${li.quantity}× ${li.productName}`).join(", "),
      source: "Squarespace", shippingService: "Standard", status: "unfulfilled", date: S(o.createdOn).slice(0, 10),
    };
  });
  return { ok: true, count: orders.length, orders };
}

async function fulfill(c, b) {
  const payload = { shouldSendNotification: true, shipments: [{ shipDate: new Date().toISOString(), carrierName: S(b.carrier) || "FedEx", service: "Standard", trackingNumber: S(b.tracking), trackingUrl: S(b.trackingUrl) }] };
  const r = await fetch(BASE + `/orders/${encodeURIComponent(b.orderId)}/fulfillments`, { method: "POST", headers: H(c.apiKey), body: JSON.stringify(payload) });
  const t = await r.text();
  if (!r.ok) return { ok: false, error: "Squarespace fulfill HTTP " + r.status + (t ? ": " + t.slice(0, 250) : "") };
  return { ok: true };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); }
    const c = { apiKey: S(b.apiKey).trim() };
    if (!c.apiKey) return J({ ok: false, error: "Missing apiKey." });
    if (b.action === "fulfill") return J(await fulfill(c, b));
    return J(await syncOrders(c));
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
