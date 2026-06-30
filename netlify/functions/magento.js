/* ════════════════════════════════════════════════════════════════════════
   Magento / Adobe Commerce  ⇄  ShippingCloud
   Auth: Integration access token (Magento Admin → System → Integrations →
   create integration → activate → copy the Access Token). Token auth, no OAuth.
   App passes { storeUrl, token } in the body.
     POST { action:"sync",    storeUrl, token }                         → { ok, orders }
     POST { action:"fulfill", storeUrl, token, orderId, tracking, carrier }
   ════════════════════════════════════════════════════════════════════════ */
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const api = (u) => S(u).replace(/\/+$/, "") + "/rest/V1";
const H = (tok) => ({ "Authorization": "Bearer " + tok, "Content-Type": "application/json", "Accept": "application/json" });

async function syncOrders(c) {
  // pending/processing orders, not yet shipped
  const qs = "searchCriteria[filterGroups][0][filters][0][field]=status&searchCriteria[filterGroups][0][filters][0][value]=processing&searchCriteria[filterGroups][0][filters][0][conditionType]=eq&searchCriteria[pageSize]=50";
  const r = await fetch(api(c.storeUrl) + "/orders?" + qs, { headers: H(c.token) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
  if (r.status === 401) return { ok: false, error: "Magento rejected the token (401)." };
  if (!r.ok) return { ok: false, error: "Magento HTTP " + r.status + (t ? ": " + t.slice(0, 200) : "") };
  const orders = ((d && d.items) || []).map((o) => {
    const a = (o.extension_attributes && o.extension_attributes.shipping_assignments && o.extension_attributes.shipping_assignments[0] && o.extension_attributes.shipping_assignments[0].shipping && o.extension_attributes.shipping_assignments[0].shipping.address) || (o.billing_address || {});
    return {
      id: "mag-" + o.entity_id, magentoId: o.entity_id, name: "#" + (o.increment_id || o.entity_id),
      customer: [a.firstname, a.lastname].filter(Boolean).join(" "),
      company: S(a.company), address1: S(a.street && a.street[0]), address2: S(a.street && a.street[1]),
      city: S(a.city), state: S(a.region_code || a.region), zip: S(a.postcode), country: S(a.country_id || "US"),
      phone: S(a.telephone), email: S(o.customer_email),
      total: S(o.grand_total), weight: Number(o.weight) || 1,
      items: (o.items || []).map((it) => `${Math.round(it.qty_ordered)}× ${it.name}`).join(", "),
      source: "Magento", shippingService: S(o.shipping_description) || "Standard",
      status: "unfulfilled", date: S(o.created_at).slice(0, 10),
    };
  });
  return { ok: true, count: orders.length, orders };
}

async function fulfill(c, b) {
  // create shipment, then attach a track
  const shipRes = await fetch(api(c.storeUrl) + `/order/${b.orderId}/ship`, { method: "POST", headers: H(c.token), body: JSON.stringify({ notify: true, tracks: [{ track_number: S(b.tracking), title: S(b.carrier) || "FedEx", carrier_code: (S(b.carrier) || "fedex").toLowerCase() }] }) });
  const t = await shipRes.text();
  if (!shipRes.ok) return { ok: false, error: "Magento ship HTTP " + shipRes.status + (t ? ": " + t.slice(0, 250) : "") };
  let shipmentId = null; try { shipmentId = JSON.parse(t); } catch {}
  return { ok: true, shipmentId };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); }
    const c = { storeUrl: S(b.storeUrl).trim(), token: S(b.token).trim() };
    if (!c.storeUrl || !c.token) return J({ ok: false, error: "Missing storeUrl/token." });
    if (b.action === "fulfill") return J(await fulfill(c, b));
    return J(await syncOrders(c));
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
