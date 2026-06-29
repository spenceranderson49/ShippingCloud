/* ════════════════════════════════════════════════════════════════════════
   POST /.netlify/functions/ship   —   book a label on England (Rock Solid)
   ------------------------------------------------------------------------
   The eCommerce API has no single "buy label" call. The real flow is:
     1) Put Order      PUT  /restapi/v1/customers/:cid/integrations/:iid/orders/:oid
     2) (Webship books it — automatically if an auto-ship rule is set)
     3) Search Shipments POST /restapi/v1/customers/:cid/searchShipments {keyword:oid}
     4) Retrieve Label  GET  /restapi/v1/customers/:cid/shipments/:book/label/PDF
   Auth: Authorization: RSIS <apiKey>. Always returns HTTP 200 + JSON.

   Body:
     { action:"ship", account:{base,apiKey,customerId,integrationId}, order:{...} }
       → pushes the order, does a quick look for a booked shipment, returns
         { ok, orderId, booked, bookNumber?, tracking?, labelPdfBase64? }
     { action:"status", account:{...}, orderId|bookNumber }
       → looks again (app polls this); returns booked/tracking/label when ready
   ════════════════════════════════════════════════════════════════════════ */

const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const two = (v) => S(v).trim().slice(0, 2).toUpperCase();
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

function creds(acct) {
  return {
    base: (acct.base || process.env.ENGLAND_API_BASE || "https://englandship.rocksolidinternet.com").replace(/\/+$/, ""),
    apiKey: S(acct.apiKey || process.env.ENGLAND_API_KEY).trim(),
    customerId: S(acct.customerId || process.env.ENGLAND_CUSTOMER_ID).trim(),
    integrationId: S(acct.integrationId || process.env.ENGLAND_INTEGRATION_ID).trim(),
  };
}
const authHeaders = (apiKey) => ({ "Content-Type": "application/json", "Authorization": "RSIS " + apiKey });

async function req(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 9000);
  try {
    const r = await fetch(url, Object.assign({ signal: ctrl.signal }, opts));
    return r;
  } finally { clearTimeout(t); }
}

// find a booked shipment for an order id; returns {bookNumber,tracking,carrierCode,serviceCode} or null
async function findShipment(c, orderId) {
  const url = c.base + "/restapi/v1/customers/" + encodeURIComponent(c.customerId) + "/searchShipments";
  const r = await req(url, { method: "POST", headers: authHeaders(c.apiKey), body: JSON.stringify({ keyword: S(orderId) }) });
  const text = await r.text();
  if (!r.ok) return { error: "HTTP " + r.status + (text ? ": " + text.slice(0, 200) : "") };
  let data = null; try { data = JSON.parse(text); } catch {}
  const ships = (data && data.shipments) || [];
  const match = ships.find((s) => !s.voided && s.bookNumber && (
    (Array.isArray(s.orderIds) && s.orderIds.map(S).includes(S(orderId))) ||
    S(s.shipperReference) === S(orderId) || S(s.fulfillment && s.fulfillment.orderId) === S(orderId)
  )) || ships.find((s) => !s.voided && s.bookNumber);
  if (!match) return null;
  return { bookNumber: S(match.bookNumber), tracking: S(match.trackingNumber), trackingNumbers: match.trackingNumbers || [], carrierCode: match.carrierCode, serviceCode: match.serviceCode, cost: match.totalShippingCost };
}

// fetch the label PDF as base64
async function fetchLabel(c, bookNumber) {
  const url = c.base + "/restapi/v1/customers/" + encodeURIComponent(c.customerId) + "/shipments/" + encodeURIComponent(bookNumber) + "/label/PDF";
  const r = await req(url, { method: "GET", headers: { "Authorization": "RSIS " + c.apiKey } });
  if (!r.ok) { const t = await r.text(); return { error: "Label HTTP " + r.status + (t ? ": " + t.slice(0, 200) : "") }; }
  const buf = Buffer.from(await r.arrayBuffer());
  return { pdf: buf.toString("base64") };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, body: "" };
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let body = {}; try { body = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON body" }); }

    const c = creds(body.account || {});
    if (!c.apiKey || !c.customerId) return J({ ok: false, error: "Missing England API key or customer ID." });

    /* ---- action: status (app polls this after shipping) ---- */
    if (body.action === "status") {
      const orderId = S(body.orderId);
      const bookNumber = S(body.bookNumber);
      let found = bookNumber ? { bookNumber, tracking: S(body.tracking) } : await findShipment(c, orderId);
      if (!found) return J({ ok: true, booked: false });
      if (found.error) return J({ ok: false, error: found.error });
      const label = await fetchLabel(c, found.bookNumber);
      return J({ ok: true, booked: true, bookNumber: found.bookNumber, tracking: found.tracking, carrierCode: found.carrierCode, serviceCode: found.serviceCode, labelPdfBase64: label.pdf || null, labelError: label.error || null });
    }

    /* ---- action: ship (Put Order then a quick look) ---- */
    if (!c.integrationId) return J({ ok: false, error: "Missing England integration ID. Create a Rest API Integration in Webship (Settings → eCommerce Integrations → Add → Rest API) and paste the integration ID into ShippingCloud → Settings → Carrier accounts." });
    const o = body.order || {};
    if (!o.receiver || !o.receiver.zip) return J({ ok: false, error: "Receiver address is incomplete." });
    if (!o.sender || !o.sender.zip) return J({ ok: false, error: "Sender (ship-from) address is incomplete." });

    const orderId = S(o.orderId || ("SC" + Date.now()));
    const pieces = (Array.isArray(o.pieces) && o.pieces.length ? o.pieces : [{ weight: o.weight || 1, length: 12, width: 9, height: 4 }]);
    const payload = {
      orderId,
      orderDate: o.orderDate || today(),
      orderNumber: S(o.orderNumber || o.reference || orderId),
      fulfillmentStatus: "pending",
      shippingService: S(o.shippingService || "Standard"),
      shipperReference: S(o.reference || orderId),
      contentDescription: S(o.contentDescription || "Merchandise"),
      shippingTotal: S(o.shippingTotal || "0.00"),
      weightUnit: "lb", dimUnit: "in",
      dueByDate: o.dueByDate || plusDays(2),
      orderGroup: "ShippingCloud",
      sender: {
        name: S(o.sender.name), company: S(o.sender.company), address1: S(o.sender.address1), address2: S(o.sender.address2),
        city: S(o.sender.city), state: two(o.sender.state), zip: S(o.sender.zip), country: two(o.sender.country || "US"),
        phone: S(o.sender.phone), email: S(o.sender.email),
      },
      receiver: {
        name: S(o.receiver.name), company: S(o.receiver.company), address1: S(o.receiver.address1), address2: S(o.receiver.address2),
        city: S(o.receiver.city), state: two(o.receiver.state), zip: S(o.receiver.zip), country: two(o.receiver.country || "US"),
        phone: S(o.receiver.phone), email: S(o.receiver.email),
      },
      items: Array.isArray(o.items) && o.items.length ? o.items : [{ title: S(o.contentDescription || "Merchandise"), quantity: 1 }],
      packages: pieces.map((p) => ({ weight: S(+p.weight || 1), length: S(+p.length || +p.L || 12), width: S(+p.width || +p.W || 9), height: S(+p.height || +p.H || 4), insuranceAmount: o.insuranceAmount ? Number(o.insuranceAmount) : null, declaredValue: null })),
    };
    if (o.signatureOption && o.signatureOption !== "none") payload.signatureOptionCode = String(o.signatureOption);

    const putUrl = c.base + "/restapi/v1/customers/" + encodeURIComponent(c.customerId) + "/integrations/" + encodeURIComponent(c.integrationId) + "/orders/" + encodeURIComponent(orderId);
    let put, putText;
    try { put = await req(putUrl, { method: "PUT", headers: authHeaders(c.apiKey), body: JSON.stringify(payload) }); putText = await put.text(); }
    catch (e) { return J({ ok: false, error: "Put Order failed: " + (e.name === "AbortError" ? "timeout" : e.message) }); }
    if (!put.ok) {
      let d = null; try { d = JSON.parse(putText); } catch {}
      return J({ ok: false, error: "England HTTP " + put.status + ((d && (d.error || d.message)) ? ": " + (d.error || d.message) : (putText ? ": " + putText.slice(0, 250) : "")), orderId });
    }

    // quick look — booked already? (auto-ship). One short wait + one search to stay within timeout.
    await new Promise((res) => setTimeout(res, 2500));
    let found = await findShipment(c, orderId);
    if (found && !found.error && found.bookNumber) {
      const label = await fetchLabel(c, found.bookNumber);
      return J({ ok: true, orderId, pushed: true, booked: true, bookNumber: found.bookNumber, tracking: found.tracking, carrierCode: found.carrierCode, serviceCode: found.serviceCode, labelPdfBase64: label.pdf || null, labelError: label.error || null });
    }
    // pushed but not booked yet — app should poll action:"status"
    return J({ ok: true, orderId, pushed: true, booked: false, message: "Order pushed to your England account. If auto-ship is on in Webship it will book in a moment — otherwise ship it in Webship and the label/tracking will appear here." });
  } catch (e) {
    return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) });
  }
};
