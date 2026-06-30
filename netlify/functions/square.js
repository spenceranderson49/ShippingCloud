/* ════════════════════════════════════════════════════════════════════════
   Square  ⇄  ShippingCloud
   Auth: OAuth2 or a Personal Access Token. Simplest: create an app at
   developer.squareup.com → use the Access Token (and Location ID). Token auth.
   App passes { token, locationId, env? }  (env "production"|"sandbox")
     POST { action:"sync",    token, locationId }                       → { ok, orders }
     POST { action:"fulfill", token, orderId, tracking, carrier, version }
   Square fulfillment is via order "fulfillments" state → COMPLETED with a note.
   ════════════════════════════════════════════════════════════════════════ */
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const base = (env) => (env === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com");
const H = (tok) => ({ "Authorization": "Bearer " + tok, "Content-Type": "application/json", "Square-Version": "2024-07-17" });

async function syncOrders(c) {
  const body = { location_ids: [c.locationId], query: { filter: { state_filter: { states: ["OPEN"] }, fulfillment_filter: { fulfillment_states: ["PROPOSED", "RESERVED"] } } }, limit: 50 };
  const r = await fetch(base(c.env) + "/v2/orders/search", { method: "POST", headers: H(c.token), body: JSON.stringify(body) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
  if (r.status === 401) return { ok: false, error: "Square rejected the token (401)." };
  if (!r.ok) return { ok: false, error: "Square HTTP " + r.status + (t ? ": " + t.slice(0, 200) : "") };
  const orders = ((d && d.orders) || []).map((o) => {
    const f = (o.fulfillments && o.fulfillments[0]) || {};
    const sd = (f.shipment_details) || {};
    const a = (sd.recipient && sd.recipient.address) || {};
    return {
      id: "sq-" + o.id, squareId: o.id, squareVersion: o.version, name: "#" + S(o.id).slice(-6),
      customer: S(sd.recipient && sd.recipient.display_name),
      company: "", address1: S(a.address_line_1), address2: S(a.address_line_2),
      city: S(a.locality), state: S(a.administrative_district_level_1), zip: S(a.postal_code), country: S(a.country || "US"),
      phone: S(sd.recipient && sd.recipient.phone_number), email: S(sd.recipient && sd.recipient.email_address),
      total: o.total_money ? S(o.total_money.amount / 100) : "",
      weight: 1, items: (o.line_items || []).map((li) => `${li.quantity}× ${li.name}`).join(", "),
      source: "Square", shippingService: "Standard", status: "unfulfilled", date: S(o.created_at).slice(0, 10),
    };
  });
  return { ok: true, count: orders.length, orders };
}

async function fulfill(c, b) {
  // mark the order's shipment fulfillment COMPLETED and stash tracking in the note
  const payload = { order: { version: Number(b.version), fulfillments: [{ uid: b.fulfillmentUid || undefined, state: "COMPLETED", shipment_details: { carrier: S(b.carrier) || "FedEx", tracking_number: S(b.tracking) } }] }, idempotency_key: "sc-" + Date.now() };
  const r = await fetch(base(c.env) + `/v2/orders/${encodeURIComponent(b.orderId)}`, { method: "PUT", headers: H(c.token), body: JSON.stringify(payload) });
  const t = await r.text();
  if (!r.ok) return { ok: false, error: "Square update HTTP " + r.status + (t ? ": " + t.slice(0, 250) : "") };
  return { ok: true };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); }
    const c = { token: S(b.token).trim(), locationId: S(b.locationId).trim(), env: S(b.env).trim() || "production" };
    if (!c.token) return J({ ok: false, error: "Missing token." });
    if (b.action === "fulfill") return J(await fulfill(c, b));
    if (!c.locationId) return J({ ok: false, error: "Missing locationId for sync." });
    return J(await syncOrders(c));
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
