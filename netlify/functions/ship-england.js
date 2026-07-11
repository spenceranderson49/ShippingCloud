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
const PKG_MAP = { fedex_envelope:"FEDEX_ENVELOPE", fedex_pak:"FEDEX_PAK", fedex_extra_small_box:"FEDEX_SMALL_BOX", fedex_small_box:"FEDEX_SMALL_BOX", fedex_medium_box:"FEDEX_MEDIUM_BOX", fedex_large_box:"FEDEX_LARGE_BOX", fedex_extra_large_box:"FEDEX_EXTRA_LARGE_BOX", fedex_tube:"FEDEX_TUBE" };
const normPkg = (c) => { const k = String(c || "").toLowerCase(); return PKG_MAP[k] || (c || ""); };
const two = (v) => S(v).trim().slice(0, 2).toUpperCase();
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const digits = (v) => S(v).replace(/\D/g, "");
const phoneOrNull = (v) => { const d = digits(v); return d.length >= 10 ? d : null; };
const strOrNull = (v) => { const s = S(v).trim(); return s.length ? s : null; };
const nameOr = (v, fb) => { const s = S(v).trim(); return s.length ? s : (S(fb).trim() || "Recipient"); };

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

/* ── session gate (see claude/audit-security.md F1) ──────────────────────
   This endpoint spends real money or exposes the account's rate card, so the
   caller must present a valid ShippingCloud session token (body.token — the
   same HMAC token db.js issues at login). Server-to-server callers
   (warm-rates, shopify-rates) send body.internalKey instead — an HMAC only
   computable with this site's env secrets. With no SESSION_SECRET and no
   Supabase key configured there is no auth system at all (bare local dev),
   so the gate stands down rather than lock everything out. */
const scCrypto = require("crypto");
const scSecret = () => { const s = (process.env.SESSION_SECRET || "").trim(); if (s) return s; const k = (process.env.SUPABASE_SERVICE_KEY || "").trim(); return k ? scCrypto.createHash("sha256").update("sc1|" + k).digest("hex") : ""; };
const scInternalKey = () => { const s = scSecret(); return s ? scCrypto.createHmac("sha256", s).update("internal:carrier").digest("hex") : ""; };
function scAuth(body) {
  const sec = scSecret();
  if (!sec) return { uid: "local", local: true };
  const ik = String((body && body.internalKey) || "");
  if (ik) { const want = scInternalKey(); try { if (want && ik.length === want.length && scCrypto.timingSafeEqual(Buffer.from(ik), Buffer.from(want))) return { uid: "internal", internal: true }; } catch (e) {} }
  try {
    const [p, sig] = String((body && body.token) || "").split(".");
    if (!p || !sig) return null;
    const want = Buffer.from(scCrypto.createHmac("sha256", sec).update(p).digest("hex"), "hex");
    const got = Buffer.from(sig, "hex");
    if (want.length !== got.length || !scCrypto.timingSafeEqual(want, got)) return null;
    const d = JSON.parse(Buffer.from(String(p).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (!d || !d.uid || !d.exp || Date.now() > d.exp) return null;
    return d;
  } catch (e) { return null; }
}
/* best-effort per-container burst limit (the auth gate above is the real control) */
const scHits = {};
function scAllow(k, max) { const w = Math.floor(Date.now() / 60000), kk = k + ":" + w; scHits[kk] = (scHits[kk] || 0) + 1; if (Object.keys(scHits).length > 4000) { for (const x in scHits) { if (!x.endsWith(":" + w)) delete scHits[x]; } } return scHits[kk] <= max; }

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, body: "" };
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let body = {}; try { body = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON body" }); }
    const gateAuth = scAuth(body);
    if (!gateAuth) return J({ ok: false, authFailed: true, error: "Sign in to book labels." });
    if (!scAllow("ship:" + gateAuth.uid, 120)) return J({ ok: false, error: "Too many booking requests at once \u2014 give it a few seconds." });

    const c = creds(body.account || {});
    if (!c.apiKey || !c.customerId) return J({ ok: false, error: "Booking isn't set up on this site yet — contact support." });

    /* ---- action: diag — what can this key actually access? ---- */
    if (body.action === "diag") {
      const out = { customerId: c.customerId };
      async function probe(path) {
        try {
          const r = await req(c.base + path, { headers: authHeaders(c.apiKey) });
          const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
          return { status: r.status, ok: r.ok, data: d, raw: r.ok ? undefined : (t ? t.slice(0, 200) : "") };
        } catch (e) { return { status: 0, ok: false, raw: (e && e.message) || "error" }; }
      }
      const pa = await probe("/restapi/v1/customers/" + encodeURIComponent(c.customerId) + "/provider-accounts");
      const accts = (pa.data && pa.data.providerAccounts) || [];
      out.providerAccounts = { status: pa.status, ok: pa.ok, count: accts.length, providers: accts.map((a) => a.providerCode), accounts: accts.map((a) => ({ id: a.id, providerCode: a.providerCode, accountNumber: (a.accountFields && a.accountFields.accountNumber) || a.accountNumber || null })), raw: pa.raw };
      const sv = await probe("/restapi/v1/customers/" + encodeURIComponent(c.customerId) + "/services");
      out.services = { status: sv.status, ok: sv.ok, raw: sv.raw };
      return J({ ok: true, diag: out });
    }

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

    /* ---- action: ship — book a label directly (synchronous, v1 Book Shipment) ---- */
    const o = body.order || {};
    if (!o.receiver || !o.receiver.zip) return J({ ok: false, error: "Receiver address is incomplete." });
    if (!o.sender || !o.sender.zip) return J({ ok: false, error: "Sender (ship-from) address is incomplete." });
    if (!o.carrierCode || !o.serviceCode) return J({ ok: false, error: "Missing carrier/service code for this rate — re-quote the shipment and try again." });

    const CC = (v) => { const s = S(v).trim(); if (!s) return "US"; const m = { "united states": "US", "usa": "US", "u.s.": "US", "u.s.a.": "US", "canada": "CA", "mexico": "MX", "united kingdom": "GB", "great britain": "GB", "uk": "GB" }; const k = s.toLowerCase(); return m[k] || s.slice(0, 2).toUpperCase(); };
    const intl = CC(o.receiver.country || "US") !== "US";
    const pieces = (Array.isArray(o.pieces) && o.pieces.length ? o.pieces : [{ weight: o.weight || 1, length: 12, width: 9, height: 4 }]);

    // England requires providerAccountId (a string) identifying which carrier account to ship on.
    // Use an explicit override if given, otherwise look it up from /provider-accounts by carrier.
    let providerAccountId = strOrNull(o.providerAccountId);
    if (!providerAccountId) {
      try {
        const pr = await req(c.base + "/restapi/v1/customers/" + encodeURIComponent(c.customerId) + "/provider-accounts", { headers: authHeaders(c.apiKey) });
        const pt = await pr.text(); let pd = null; try { pd = JSON.parse(pt); } catch {}
        const accts = (pd && (pd.providerAccounts || pd.data)) || [];
        const want = S(o.carrierCode).toLowerCase();
        const match = accts.find((a) => S(a.providerCode).toLowerCase() === want) || (accts.length === 1 ? accts[0] : null);
        if (match && match.id != null) providerAccountId = String(match.id);
        if (!providerAccountId) {
          return J({ ok: false, error: accts.length
            ? ("This account isn't set up to book '" + S(o.carrierCode) + "' labels yet — contact support.")
            : ("Booking isn't enabled on this account yet (HTTP " + pr.status + ") — contact support.") });
        }
      } catch (e) {
        return J({ ok: false, error: "Couldn't reach the booking service (" + (e.name === "AbortError" ? "timeout" : e.message) + ") — try again or contact support." });
      }
    }

    // RockSolid/XPS exposes only ONE reference field (shipmentReference) — no separate PO/invoice fields —
    // so pack order ref + PO + invoice into it, trimmed to FedEx's ~40-char reference limit.
    const refBits = [S(o.reference || o.orderNumber), o.poNo ? ("PO " + S(o.poNo)) : "", o.invoiceNo ? ("INV " + S(o.invoiceNo)) : ""].filter(Boolean);
    const shipmentReference = (refBits.join("  ") || ("SC" + Date.now())).slice(0, 40);

    const shipBody = {
      carrierCode: S(o.carrierCode),
      serviceCode: S(o.serviceCode),
      packageTypeCode: normPkg(o.packageTypeCode) || (S(o.carrierCode).toLowerCase() + "_custom_package"),
      shipmentDate: o.shipmentDate || today(),
      shipmentReference: shipmentReference,
      orderNumber: S(o.orderNumber || o.reference || ""),
      contentDescription: S(o.contentDescription || "Merchandise"),
      sender: {
        name: nameOr(o.sender.name, o.sender.company), company: S(o.sender.company) || nameOr(o.sender.name, "Shipper"),
        address1: S(o.sender.address1), address2: S(o.sender.address2), city: S(o.sender.city),
        state: two(o.sender.state), zip: S(o.sender.zip), country: CC(o.sender.country || "US"),
        phone: phoneOrNull(o.sender.phone) || "0000000000", email: strOrNull(o.sender.email),
      },
      receiver: {
        name: nameOr(o.receiver.name, o.receiver.company), company: S(o.receiver.company),
        address1: S(o.receiver.address1), address2: S(o.receiver.address2), city: S(o.receiver.city),
        state: two(o.receiver.state), zip: S(o.receiver.zip), country: CC(o.receiver.country || "US"),
        phone: phoneOrNull(o.receiver.phone) || "0000000000", email: strOrNull(o.receiver.email),
      },
      residential: !!o.residential,
      signatureOptionCode: (o.signatureOption && o.signatureOption !== "none") ? String(o.signatureOption) : null,
      saturdayDelivery: !!o.saturdayDelivery,
      weightUnit: "lb", dimUnit: "in", currency: "USD", customsCurrency: "USD",
      labelImageFormat: "PDF",
      pieces: pieces.map((p) => ({
        weight: S(+p.weight || 1), length: S(+p.length || +p.L || 12), width: S(+p.width || +p.W || 9), height: S(+p.height || +p.H || 4),
        insuranceAmount: o.insuranceAmount ? String(o.insuranceAmount) : null,
        declaredValue: (intl && (p.declaredValue || p.value)) ? String(p.declaredValue || p.value) : null,
      })),
      billing: { party: S(o.billingParty || "sender"), account: strOrNull(o.billingAccount), country: o.billingZip ? CC(o.billingCountry || "US") : null, zip: strOrNull(o.billingZip) },
      providerAccountId: providerAccountId,
      approvePrepayRecharge: o.approvePrepayRecharge !== false,
    };
    if (!intl) shipBody.pieces.forEach((p) => { p.declaredValue = null; });

    const url = c.base + "/restapi/v1/customers/" + encodeURIComponent(c.customerId) + "/shipments";
    let r, t;
    try { r = await req(url, { method: "POST", headers: authHeaders(c.apiKey), body: JSON.stringify(shipBody) }); t = await r.text(); }
    catch (e) { return J({ ok: false, error: "Book Shipment failed: " + (e.name === "AbortError" ? "timeout" : e.message) }); }
    let d = null; try { d = JSON.parse(t); } catch {}
    if (!r.ok) return J({ ok: false, error: "Booking failed (HTTP " + r.status + ")" + ((d && (d.error || d.message)) ? ": " + String(d.error || d.message).slice(0, 200) : "") });
    const bookNumber = S(d && d.bookNumber);
    const tracking = S(d && d.trackingNumber);
    if (!bookNumber) return J({ ok: false, error: "Booked but no bookNumber returned: " + (t ? t.slice(0, 200) : "") });
    const label = await fetchLabel(c, bookNumber);
    return J({ ok: true, booked: true, bookNumber, tracking, zone: d && d.zone, prepayBalance: d && d.prepayBalance, labelPdfBase64: label.pdf || null, labelError: label.error || null });
  } catch (e) {
    return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) });
  }
};
