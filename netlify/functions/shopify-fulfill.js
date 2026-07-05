/* ════════════════════════════════════════════════════════════════════════
   ShippingCloud → Shopify : push tracking + mark fulfilled.
   GraphQL Admin API edition (fulfillmentCreate; V2 is deprecated).
     1) order(id) → open fulfillment orders
     2) fulfillmentCreate with trackingInfo → fulfills + notifies buyer
     POST { shop, token, shopifyId, tracking, trackingUrl?, carrier?, notifyCustomer? }
       → { ok, fulfillmentId?, status? }        (same shape as the REST version)
   ════════════════════════════════════════════════════════════════════════ */
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const API = "2025-07";
const numId = (gid) => S(gid).split("/").pop();

async function gql(shop, token, query, variables) {
  let r, text, body = null;
  try {
    r = await fetch(`https://${shop}/admin/api/${API}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: variables || {} }),
    });
    text = await r.text(); try { body = JSON.parse(text); } catch {}
  } catch (e) { return { ok: false, status: 0, errors: [{ message: "Shopify fetch failed: " + (e && e.message) }] }; }
  if (r.status === 401) return { ok: false, status: 401, errors: [{ message: "unauthorized" }] };
  const errors = (body && body.errors) || null;
  return { ok: r.ok && !errors, status: r.status, data: body && body.data, errors, text };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, body: "" };
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let body = {}; try { body = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON body" }); }

    const shop = S(body.shop).toLowerCase();
    const token = S(body.token);
    const orderId = S(body.shopifyId || body.orderId).replace(/[^0-9]/g, "");
    const tracking = S(body.tracking);
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !token) return J({ ok: false, error: "Missing shop/token." });
    if (!orderId) return J({ ok: false, error: "Missing Shopify order id." });

    // 1) open fulfillment orders for this order
    const fr = await gql(shop, token,
      `query($id:ID!){order(id:$id){fulfillmentOrders(first:20){nodes{id status}}}}`,
      { id: "gid://shopify/Order/" + orderId });
    if (fr.status === 401) return J({ ok: false, error: "Shopify rejected the token (401) — reconnect the store." });
    if (!fr.ok) return J({ ok: false, error: "Fulfillment-orders lookup failed: " + JSON.stringify(fr.errors || {}).slice(0, 200) });
    const all = (((fr.data || {}).order || {}).fulfillmentOrders || {}).nodes || [];
    const fos = all.filter((f) => ["OPEN", "IN_PROGRESS", "SCHEDULED"].includes(S(f.status).toUpperCase()));
    if (!fos.length) return J({ ok: false, error: "No open fulfillment orders (order may already be fulfilled)." });

    // 2) create the fulfillment with tracking (all line items on each open FO)
    const cr = await gql(shop, token,
      `mutation($fulfillment:FulfillmentInput!){fulfillmentCreate(fulfillment:$fulfillment){
         fulfillment{id status} userErrors{field message}}}`,
      { fulfillment: {
          lineItemsByFulfillmentOrder: fos.map((f) => ({ fulfillmentOrderId: f.id })),
          trackingInfo: { number: tracking || null, url: S(body.trackingUrl) || null, company: S(body.carrier) || "FedEx" },
          notifyCustomer: body.notifyCustomer !== false,
        } });
    if (cr.status === 401) return J({ ok: false, error: "Shopify rejected the token (401) — reconnect the store." });
    if (!cr.ok) return J({ ok: false, error: "Fulfillment failed: " + JSON.stringify(cr.errors || {}).slice(0, 250) });
    const pay = ((cr.data || {}).fulfillmentCreate) || {};
    if ((pay.userErrors || []).length) return J({ ok: false, error: "Fulfillment failed: " + JSON.stringify(pay.userErrors).slice(0, 250) });

    const f = pay.fulfillment || {};
    return J({ ok: true, fulfillmentId: f.id ? numId(f.id) : null, status: S(f.status || "success").toLowerCase() });
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
