/* ════════════════════════════════════════════════════════════════════════
   Amazon Selling Partner API (SP-API)  ⇄  ShippingCloud
   Auth: Login-with-Amazon (LWA) refresh token. You create an SP-API app in
   Seller Central → Develop Apps, authorize it on your seller account, and get
   a refresh_token + LWA client_id + client_secret. App passes:
     { refreshToken, lwaClientId, lwaClientSecret, region?, marketplaceId? }
   (region: "na" default | "eu" | "fe";  US marketplaceId = ATVPDKIKX0DER)
     POST { action:"sync",    ...creds }                              → { ok, orders }
     POST { action:"confirm", ...creds, orderId, tracking, carrier, shipDate? }
   Modern SP-API no longer requires AWS SigV4 signing — the LWA access token is
   sufficient for these calls.
   ════════════════════════════════════════════════════════════════════════ */
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const HOST = { na: "sellingpartnerapi-na.amazon.com", eu: "sellingpartnerapi-eu.amazon.com", fe: "sellingpartnerapi-fe.amazon.com" };
const DEFAULT_MKT = "ATVPDKIKX0DER"; // amazon.com (US)

async function lwaToken(c) {
  const r = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refreshToken, client_id: c.lwaClientId, client_secret: c.lwaClientSecret }).toString(),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("LWA token failed: " + JSON.stringify(d).slice(0, 160));
  return d.access_token;
}

async function spGet(host, path, token) {
  const r = await fetch("https://" + host + path, { headers: { "x-amz-access-token": token, "Content-Type": "application/json" } });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
  return { r, d, t };
}

async function syncOrders(c) {
  const host = HOST[c.region || "na"] || HOST.na;
  const token = await lwaToken(c);
  const mkt = c.marketplaceId || DEFAULT_MKT;
  const after = new Date(Date.now() - 30 * 86400000).toISOString();
  const { r, d, t } = await spGet(host, `/orders/v0/orders?MarketplaceIds=${mkt}&OrderStatuses=Unshipped&CreatedAfter=${encodeURIComponent(after)}`, token);
  if (r.status === 403) return { ok: false, error: "Amazon SP-API 403 — check the app authorization / roles." };
  if (!r.ok) return { ok: false, error: "SP-API HTTP " + r.status + (t ? ": " + t.slice(0, 200) : "") };
  const list = (d && d.payload && d.payload.Orders) || [];
  const orders = [];
  for (const o of list) {
    let addr = {};
    try { const a = await spGet(host, `/orders/v0/orders/${o.AmazonOrderId}/address`, token); addr = (a.d && a.d.payload && a.d.payload.ShippingAddress) || {}; } catch {}
    const lines = (addr.AddressLine1 ? [addr.AddressLine1, addr.AddressLine2, addr.AddressLine3] : []).filter(Boolean);
    orders.push({
      id: "amz-" + o.AmazonOrderId, amazonId: o.AmazonOrderId, name: o.AmazonOrderId,
      customer: S(addr.Name), company: "",
      address1: S(lines[0]), address2: S(lines[1]),
      city: S(addr.City), state: S(addr.StateOrRegion), zip: S(addr.PostalCode), country: S(addr.CountryCode || "US"),
      phone: S(addr.Phone), email: S(o.BuyerInfo && o.BuyerInfo.BuyerEmail),
      total: o.OrderTotal ? S(o.OrderTotal.Amount) : "", weight: 1,
      items: S(o.NumberOfItemsUnshipped) + " item(s)",
      source: "Amazon", shippingService: S(o.ShipmentServiceLevelCategory) || "Standard",
      status: "unfulfilled", date: S(o.PurchaseDate).slice(0, 10),
    });
  }
  return { ok: true, count: orders.length, orders };
}

async function confirmShipment(c, b) {
  const host = HOST[c.region || "na"] || HOST.na;
  const token = await lwaToken(c);
  const mkt = c.marketplaceId || DEFAULT_MKT;
  // confirmShipment requires the order's item ids + quantities
  let items = [];
  try {
    const it = await spGet(host, `/orders/v0/orders/${b.orderId}/orderItems`, token);
    items = ((it.d && it.d.payload && it.d.payload.OrderItems) || []).map((x) => ({ orderItemId: x.OrderItemId, quantity: Number(x.QuantityOrdered) || 1 }));
  } catch {}
  const payload = {
    marketplaceId: mkt,
    packageDetail: {
      packageReferenceId: "SC" + Date.now(),
      carrierCode: S(b.carrier) || "FedEx",
      trackingNumber: S(b.tracking),
      shipDate: b.shipDate || new Date().toISOString(),
      orderItems: items,
    },
  };
  const r = await fetch("https://" + host + `/orders/v0/orders/${b.orderId}/shipmentConfirmation`, {
    method: "POST", headers: { "x-amz-access-token": token, "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
  if (!r.ok) return { ok: false, error: "confirmShipment HTTP " + r.status + (t ? ": " + t.slice(0, 250) : ""), hint: "Some accounts must instead submit a POST_ORDER_FULFILLMENT_DATA feed via the Feeds API." };
  return { ok: true, result: d || "submitted" };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); }
    const c = { refreshToken: S(b.refreshToken).trim(), lwaClientId: S(b.lwaClientId).trim(), lwaClientSecret: S(b.lwaClientSecret).trim(), region: S(b.region).trim() || "na", marketplaceId: S(b.marketplaceId).trim() };
    if (!c.refreshToken || !c.lwaClientId || !c.lwaClientSecret) return J({ ok: false, error: "Missing refreshToken / lwaClientId / lwaClientSecret." });
    if (b.action === "confirm" || b.action === "fulfill") return J(await confirmShipment(c, b));
    return J(await syncOrders(c));
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
