/* ════════════════════════════════════════════════════════════════════════
   Walmart Marketplace  ⇄  ShippingCloud
   Auth: client_id + client_secret (Basic) → OAuth token. Create credentials in
   Walmart Seller Center → Developer → API Key Management.
   App passes { clientId, clientSecret } in the body.
     POST { action:"sync",    clientId, clientSecret }                 → { ok, orders }
     POST { action:"fulfill", clientId, clientSecret, orderId, lines[], tracking, carrier }
   ════════════════════════════════════════════════════════════════════════ */
const crypto = require("crypto");
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const BASE = "https://marketplace.walmartapis.com";

async function token(c) {
  const r = await fetch(BASE + "/v3/token", {
    method: "POST",
    headers: { "Authorization": "Basic " + Buffer.from(c.clientId + ":" + c.clientSecret).toString("base64"), "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json", "WM_SVC.NAME": "Walmart Marketplace", "WM_QOS.CORRELATION_ID": crypto.randomUUID() },
    body: "grant_type=client_credentials",
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Walmart token failed: " + JSON.stringify(d).slice(0, 160));
  return d.access_token;
}
const wmHeaders = (tok) => ({ "WM_SEC.ACCESS_TOKEN": tok, "WM_QOS.CORRELATION_ID": crypto.randomUUID(), "WM_SVC.NAME": "Walmart Marketplace", "Accept": "application/json", "Content-Type": "application/json" });

async function syncOrders(c) {
  const tok = await token(c);
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const r = await fetch(BASE + `/v3/orders?createdStartDate=${since}&status=Created&limit=50`, { headers: wmHeaders(tok) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
  if (!r.ok) return { ok: false, error: "Walmart HTTP " + r.status + (t ? ": " + t.slice(0, 200) : "") };
  const list = (d && d.list && d.list.elements && d.list.elements.order) || [];
  const orders = list.map((o) => {
    const sa = (o.shippingInfo && o.shippingInfo.postalAddress) || {};
    const lines = (o.orderLines && o.orderLines.orderLine) || [];
    return {
      id: "wmt-" + o.purchaseOrderId, walmartId: o.purchaseOrderId, name: S(o.customerOrderId),
      customer: S(sa.name), company: "", address1: S(sa.address1), address2: S(sa.address2),
      city: S(sa.city), state: S(sa.state), zip: S(sa.postalCode), country: S(sa.country || "USA"),
      phone: S(o.shippingInfo && o.shippingInfo.phone), email: S(o.customerEmailId),
      total: "", weight: 1, items: lines.map((l) => `${(l.orderLineQuantity && l.orderLineQuantity.amount) || 1}× ${l.item && l.item.productName}`).join(", "),
      source: "Walmart", shippingService: S(o.shippingInfo && o.shippingInfo.methodCode) || "Standard",
      status: "unfulfilled", date: o.orderDate ? new Date(Number(o.orderDate)).toISOString().slice(0, 10) : "",
      lines: lines.map((l) => ({ lineNumber: l.lineNumber, qty: (l.orderLineQuantity && l.orderLineQuantity.amount) || 1 })),
    };
  });
  return { ok: true, count: orders.length, orders };
}

async function fulfill(c, b) {
  const tok = await token(c);
  const lines = (b.lines || []).map((l) => ({
    lineNumber: String(l.lineNumber),
    orderLineStatuses: { orderLineStatus: [{ status: "Shipped", statusQuantity: { unitOfMeasurement: "EACH", amount: String(l.qty || 1) }, trackingInfo: { shipDateTime: Date.now(), carrierName: { carrier: S(b.carrier) || "FedEx" }, methodCode: "Standard", trackingNumber: S(b.tracking) } }] },
  }));
  const payload = { orderShipment: { orderLines: { orderLine: lines } } };
  const r = await fetch(BASE + `/v3/orders/${encodeURIComponent(b.orderId)}/shipping`, { method: "POST", headers: wmHeaders(tok), body: JSON.stringify(payload) });
  const t = await r.text();
  if (!r.ok) return { ok: false, error: "Walmart ship HTTP " + r.status + (t ? ": " + t.slice(0, 250) : "") };
  return { ok: true };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); }
    const c = { clientId: S(b.clientId).trim(), clientSecret: S(b.clientSecret).trim() };
    if (!c.clientId || !c.clientSecret) return J({ ok: false, error: "Missing clientId/clientSecret." });
    if (b.action === "fulfill") return J(await fulfill(c, b));
    return J(await syncOrders(c));
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
