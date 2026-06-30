/* ════════════════════════════════════════════════════════════════════════
   ShipStation  ⇄  ShippingCloud
   Auth: API key + secret (Basic auth). Get them in ShipStation →
   Account → API Settings. App passes { apiKey, apiSecret } in the body.
     POST { action:"sync",    apiKey, apiSecret }                          → { ok, orders }
     POST { action:"fulfill", apiKey, apiSecret, orderId, tracking, carrier }
   ════════════════════════════════════════════════════════════════════════ */
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const BASE = "https://ssapi.shipstation.com";
const auth = (c) => "Basic " + Buffer.from(c.apiKey + ":" + c.apiSecret).toString("base64");

// ShipStation carrier code mapping
const CARRIER = { FedEx: "fedex", UPS: "ups", USPS: "stamps_com", DHL: "dhl_express_canada" };

async function syncOrders(c) {
  const url = BASE + "/orders?orderStatus=awaiting_shipment&pageSize=100";
  const r = await fetch(url, { headers: { "Authorization": auth(c), "Content-Type": "application/json" } });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
  if (r.status === 401) return { ok: false, error: "ShipStation rejected the credentials (401)." };
  if (!r.ok) return { ok: false, error: "ShipStation HTTP " + r.status + (t ? ": " + t.slice(0, 200) : "") };
  const orders = ((d && d.orders) || []).map((o) => {
    const a = o.shipTo || {};
    return {
      id: "ss-" + o.orderId, shipstationId: o.orderId, name: o.orderNumber,
      customer: S(a.name), company: S(a.company), address1: S(a.street1), address2: S(a.street2),
      city: S(a.city), state: S(a.state), zip: S(a.postalCode), country: S(a.country || "US"),
      phone: S(a.phone), email: S(o.customerEmail),
      total: S(o.orderTotal), weight: o.weight ? Math.round((o.weight.value / (o.weight.units === "ounces" ? 16 : 1)) * 100) / 100 : 1,
      items: (o.items || []).map((it) => `${it.quantity}× ${it.name}`).join(", "),
      source: "ShipStation", shippingService: S(o.requestedShippingService) || "Standard",
      status: "unfulfilled", date: S(o.orderDate).slice(0, 10),
    };
  });
  return { ok: true, count: orders.length, orders };
}

async function fulfill(c, b) {
  const payload = {
    orderId: Number(b.orderId), carrierCode: CARRIER[b.carrier] || "fedex",
    trackingNumber: S(b.tracking), notifyCustomer: b.notifyCustomer !== false, notifySalesChannel: true,
  };
  const r = await fetch(BASE + "/orders/markasshipped", { method: "POST", headers: { "Authorization": auth(c), "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
  if (!r.ok) return { ok: false, error: "Mark-shipped HTTP " + r.status + (t ? ": " + t.slice(0, 200) : "") };
  return { ok: true, orderId: d && d.orderId };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); }
    const c = { apiKey: S(b.apiKey).trim(), apiSecret: S(b.apiSecret).trim() };
    if (!c.apiKey || !c.apiSecret) return J({ ok: false, error: "Missing apiKey/apiSecret." });
    if (b.action === "fulfill") return J(await fulfill(c, b));
    return J(await syncOrders(c));
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
