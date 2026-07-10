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
const API = "2026-01";
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

    /* ── updateOrder: push edited order info (shipping address / email / note) BACK to Shopify ── */
    if (body.action === "updateOrder") {
      const a = body.shippingAddress || null;
      const input = { id: "gid://shopify/Order/" + orderId };
      if (a) {
        const name = String(a.name || "").trim();
        input.shippingAddress = {
          firstName: name.split(/\s+/)[0] || name || undefined,
          lastName: name.split(/\s+/).slice(1).join(" ") || undefined,
          company: S(a.company) || undefined,
          address1: S(a.address1) || undefined,
          address2: S(a.address2) || undefined,
          city: S(a.city) || undefined,
          provinceCode: S(a.state) || undefined,
          zip: S(a.zip) || undefined,
          phone: S(a.phone) || undefined,
          countryCode: (S(a.country) || "US").slice(0, 2).toUpperCase()
        };
      }
      if (body.email) input.email = S(body.email);
      if (body.note != null) input.note = S(body.note).slice(0, 5000);
      const ur = await gql(shop, token,
        `mutation($input:OrderInput!){orderUpdate(input:$input){order{id} userErrors{field message}}}`,
        { input });
      if (ur.status === 401) return J({ ok: false, error: "Shopify rejected the token (401) — reconnect the store." });
      const upay = ((ur.data || {}).orderUpdate) || {};
      if (!ur.ok || (upay.userErrors || []).length) return J({ ok: false, error: "Order update failed: " + JSON.stringify((upay.userErrors && upay.userErrors.length ? upay.userErrors : ur.errors) || {}).slice(0, 250) });
      return J({ ok: true, updated: true });
    }

    // 1) open fulfillment orders for this order
    const fr = await gql(shop, token,
      `query($id:ID!){order(id:$id){fulfillmentOrders(first:20){nodes{id status}}}}`,
      { id: "gid://shopify/Order/" + orderId });
    if (fr.status === 401) return J({ ok: false, error: "Shopify rejected the token (401) — reconnect the store." });
    if (!fr.ok) return J({ ok: false, error: "Fulfillment-orders lookup failed: " + JSON.stringify(fr.errors || {}).slice(0, 200) });
    const all = (((fr.data || {}).order || {}).fulfillmentOrders || {}).nodes || [];
    const fos = all.filter((f) => ["OPEN", "IN_PROGRESS", "SCHEDULED"].includes(S(f.status).toUpperCase()));
    if (!fos.length) {
      /* Held orders must not silently get their old fulfillment's tracking replaced. */
      if (all.some((f) => S(f.status).toUpperCase() === "ON_HOLD")) return J({ ok: false, error: "This order is ON HOLD in Shopify — release the hold there, then push tracking again." });
      /* Already fulfilled → this is a RE-LABEL: update the existing fulfillment's tracking to
         the new number (and notify the customer) instead of failing. Newest successful one. */
      const xr = await gql(shop, token,
        `query($id:ID!){order(id:$id){fulfillments(first:50){id status trackingInfo{number}}}}`,
        { id: "gid://shopify/Order/" + orderId });
      if (xr.status === 401) return J({ ok: false, error: "Shopify rejected the token (401) — reconnect the store." });
      if (!xr.ok) return J({ ok: false, error: "Couldn't read the order's fulfillments: " + JSON.stringify(xr.errors || {}).slice(0, 200) });
      const allF = ((((xr.data || {}).order || {}).fulfillments) || []);
      const good = allF.filter((f) => S(f.status).toUpperCase() === "SUCCESS");
      const fulfills = good.length ? good : allF.filter((f) => S(f.status).toUpperCase() !== "CANCELLED");
      if (!fulfills.length) return J({ ok: false, error: "No open fulfillment orders and no existing fulfillment to update — check the order in Shopify." });
      /* TARGETED replace, plural numbers/urls form (plural REPLACES the fulfillment's whole
         tracking list — the singular field left stale numbers[] entries behind, which is why
         the "Tracking added" popover kept showing the old number). Targets: fulfillments that
         carry the tracking we're replacing (prevTracking) — falling back to the newest one —
         NEVER every fulfillment blindly, or a genuinely split order (two boxes, two numbers)
         would lose the other box's valid tracking. */
      const prev = S(body.prevTracking || "");
      const hasNum = (f, n) => n && Array.isArray(f.trackingInfo) && f.trackingInfo.some((ti) => ti && S(ti.number) === n);
      let targets = prev ? fulfills.filter((f) => hasNum(f, prev)) : [];
      if (!targets.length) targets = [fulfills[fulfills.length - 1]];
      let done = 0;
      for (let ti = 0; ti < targets.length; ti++) {
        const target = targets[ti];
        const ur = await gql(shop, token,
          `mutation($fulfillmentId:ID!,$trackingInfoInput:FulfillmentTrackingInput!,$notifyCustomer:Boolean){
             fulfillmentTrackingInfoUpdate(fulfillmentId:$fulfillmentId,trackingInfoInput:$trackingInfoInput,notifyCustomer:$notifyCustomer){
               fulfillment{id} userErrors{field message}}}`,
          { fulfillmentId: target.id,
            trackingInfoInput: { numbers: tracking ? [tracking] : [], urls: S(body.trackingUrl) ? [S(body.trackingUrl)] : [], company: S(body.carrier) || "FedEx" },
            /* notify on the FIRST update so a later failure can't swallow the email after tracking already changed */
            notifyCustomer: body.notifyCustomer !== false && ti === 0 });
        if (ur.status === 401) return J({ ok: false, error: "Shopify rejected the token (401) — reconnect the store." });
        const upay = ((ur.data || {}).fulfillmentTrackingInfoUpdate) || {};
        if (!ur.ok || (upay.userErrors || []).length) {
          const detail = JSON.stringify((upay.userErrors && upay.userErrors.length ? upay.userErrors : ur.errors) || {}).slice(0, 220);
          return J({ ok: false, error: "Tracking update failed" + (done ? " (after " + done + " of " + targets.length + " fulfillments were already updated — retrying is safe)" : "") + ": " + detail });
        }
        done++;
      }
      return J({ ok: true, fulfillmentId: numId(targets[targets.length - 1].id), status: "tracking_updated", updated: true });
    }

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
