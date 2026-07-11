/* ════════════════════════════════════════════════════════════════════════
   ShippingCloud API v1  (branded "ShipHub API" on FreightWire sites)
   The platform's own public REST API: partners and customers integrate their
   systems directly — quotes priced through THEIR rate card, label booking,
   shipments, void, tracking links, pickups, billing summaries and invoices.
   Docs: /api-docs.html · Base: /api/v1 (redirect) or /.netlify/functions/api/v1

   Auth: per-customer API keys minted in Admin → API (db.js apiKeyCreate).
     Authorization: Bearer sck_live_xxxxxxxx…   (or X-API-Key header)
   Keys are stored HASHED (sha256); the full key is shown once at creation.

   Pricing runs the exact engine the app uses (netlify/functions/api-engine.js,
   auto-generated from src/App.jsx — claude/tests/api.mjs asserts parity), so a
   quote through the API matches the customer's portal to the penny.
   ════════════════════════════════════════════════════════════════════════ */
"use strict";
const crypto = require("crypto");
const E = require("./api-engine.js");

/* ── Supabase store access (same table + tenant wall as db.js) ── */
const CFG = () => ({ url: (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, ""), key: (process.env.SUPABASE_SERVICE_KEY || "").trim() });
const TENANT = (process.env.DB_TENANT || "main").trim() || "main";
async function pg(path, opts) {
  const c = CFG();
  const r = await fetch(c.url + "/rest/v1/" + path, { ...(opts || {}), headers: { apikey: c.key, Authorization: "Bearer " + c.key, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal", ...((opts || {}).headers || {}) } });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { ok: r.ok, status: r.status, data };
}
async function getStore(key) {
  const r = await pg("app_stores?tenant=eq." + encodeURIComponent(TENANT) + "&key=eq." + encodeURIComponent(key) + "&select=value");
  if (!r.ok) return { ok: false };
  const row = Array.isArray(r.data) && r.data[0];
  return { ok: true, value: row ? row.value : undefined };
}
async function putStore(key, value) {
  const r = await pg("app_stores", { method: "POST", body: JSON.stringify([{ tenant: TENANT, key, value }]) });
  return { ok: r.ok };
}

/* ── internal auth for in-process calls into quote.js / ship.js / fedex.js ── */
const scSecret = () => { const s = (process.env.SESSION_SECRET || "").trim(); if (s) return s; const k = (process.env.SUPABASE_SERVICE_KEY || "").trim(); return k ? crypto.createHash("sha256").update("sc1|" + k).digest("hex") : ""; };
const internalKey = () => { const s = scSecret(); return s ? crypto.createHmac("sha256", s).update("internal:carrier").digest("hex") : ""; };
async function callFn(mod, body) {
  const res = await require(mod).handler({ httpMethod: "POST", body: JSON.stringify({ ...body, internalKey: internalKey() }), headers: {} });
  try { return JSON.parse(res.body || "{}"); } catch (e) { return {}; }
}

/* ── responses (ShipEngine-style envelope) ── */
const J = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, X-API-Key, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }, body: JSON.stringify(obj) });
const ERR = (code, ecode, msg) => J(code, { error: { code: ecode, message: msg } });

/* ── per-key burst limit (per warm container — the auth gate is the hard control) ── */
const HITS = {};
const allow = (k, max) => { const w = Math.floor(Date.now() / 60000), kk = k + ":" + w; HITS[kk] = (HITS[kk] || 0) + 1; if (Object.keys(HITS).length > 4000) { for (const x in HITS) { if (!x.endsWith(":" + w)) delete HITS[x]; } } return HITS[kk] <= max; };

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const num = (v, d) => { const n = +v; return isFinite(n) ? n : d; };
const S = (v) => (v == null ? "" : String(v));

/* normalize an API package → engine/quote piece */
const pieceOf = (p) => ({ weight: Math.max(0.1, num(p.weight, 1)), length: Math.max(1, Math.round(num(p.length, 12))), width: Math.max(1, Math.round(num(p.width, 9))), height: Math.max(1, Math.round(num(p.height, 4))), declaredValue: num(p.declared_value, 0) || undefined });
const ctxPieces = (pieces) => pieces.map((p) => ({ weight: p.weight, L: p.length, W: p.width, H: p.height }));

async function loadWorld() {
  const [kRes, cRes, rRes] = await Promise.all([getStore("apiKeys"), getStore("clients"), getStore("rateRules")]);
  const keys = (kRes.ok && Array.isArray(kRes.value)) ? kRes.value : [];
  const clients = (cRes.ok && Array.isArray(cRes.value)) ? cRes.value : [];
  const rules = (rRes.ok && rRes.value && typeof rRes.value === "object") ? rRes.value : E.DEFAULT_RATE_RULES;
  try { E.setDimCfg(rules.dimDivisors); } catch (e) {}
  return { keys, clients, rules };
}

function priceRates(liveRates, world, client, fromZip, toZip, pieces) {
  const blocked = new Set((client && client.blockedServices) || []);
  return (liveRates || [])
    .filter((r) => !blocked.has(E.canonSvc(r.label)))
    .map((r) => {
      const sell = E.rateSellFor(r.cost, r.label, { rules: world.rules, client, list: r.list, listBase: r.listBase, surcharges: r.surcharges, fromZip, toZip, weight: E.ruleWeightFor(ctxPieces(pieces), r.label) });
      return sell == null ? null : {
        service_code: r.key, service: r.label, carrier: "fedex",
        amount: Math.round(sell * 100) / 100, currency: "USD",
        delivery_days: r.maxDays ?? r.minDays ?? null,
        package_type: r.packageTypeCode || null,
        one_rate: !!r._oneRate || undefined,
      };
    }).filter(Boolean).sort((a, b) => a.amount - b.amount);
}

const shipStoreKey = (client) => "u/api_" + client.id + "/shipments";

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return J(204, {});
    const c = CFG();
    if (!c.url || !c.key) return ERR(503, "not_configured", "The API isn't enabled on this site yet.");

    /* path: /.netlify/functions/api/v1/... or /api/v1/... via redirect */
    const parts = S(event.path).replace(/^\/\.netlify\/functions\/api/, "").replace(/^\/api(?=\/)/, "").split("/").filter(Boolean);
    if (!parts.length || parts[0] !== "v1") return ERR(404, "not_found", "Unknown path — the current version is /v1. See /api-docs.html");
    const seg = parts.slice(1); // after v1
    const method = event.httpMethod;
    let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) { if (method === "POST") return ERR(400, "bad_json", "Request body must be valid JSON."); }
    const qs = event.queryStringParameters || {};

    if (!seg.length && method === "GET") return J(200, { name: "ShippingCloud API", version: "v1", docs: "/api-docs.html", status: "ok" });

    /* ── authenticate the API key ── */
    const rawKey = S((event.headers && (event.headers["x-api-key"] || event.headers["X-Api-Key"])) || "").trim() || S((event.headers && (event.headers.authorization || event.headers.Authorization)) || "").replace(/^Bearer\s+/i, "").trim();
    if (!rawKey) return ERR(401, "missing_key", "Send your API key as 'Authorization: Bearer <key>' or 'X-API-Key: <key>'.");
    const world = await loadWorld();
    const h = sha(rawKey);
    const keyRow = world.keys.find((k) => k && k.hash === h && !k.revoked);
    if (!keyRow) return ERR(401, "invalid_key", "That API key isn't valid (or was revoked).");
    const client = world.clients.find((x) => x && x.id === keyRow.clientId);
    if (!client) return ERR(403, "no_account", "This key isn't attached to an active account — contact support.");
    if (client.status && client.status !== "active") return ERR(403, "account_inactive", "This account is inactive — contact support.");
    if (!allow("k:" + keyRow.id, 240)) return ERR(429, "rate_limited", "Too many requests — slow down (240/min per key).");
    /* best-effort last-used stamp (never blocks the request) */
    if (!keyRow.lastUsed || Date.now() - new Date(keyRow.lastUsed).getTime() > 3600e3) {
      keyRow.lastUsed = new Date().toISOString();
      putStore("apiKeys", world.keys).catch(() => {});
    }
    const fedexAccount = (client.fedex && S(client.fedex.accountNumber).trim()) || undefined;

    /* ── GET /v1/services ── */
    if (seg[0] === "services" && method === "GET") {
      const blocked = new Set(client.blockedServices || []);
      const services = E.RATE_SERVICES.fedex.filter((sv) => !blocked.has(sv.k)).map((sv) => ({ service_code: sv.k, service: sv.l, group: sv.g || "FedEx", one_rate: !!sv.or }));
      return J(200, { services });
    }

    /* ── POST /v1/rates ── */
    if (seg[0] === "rates" && method === "POST") {
      const from_zip = S(body.from_zip || (body.from && body.from.zip)).trim();
      const to_zip = S(body.to_zip || (body.to && body.to.zip)).trim();
      const pkgs = Array.isArray(body.packages) && body.packages.length ? body.packages.map(pieceOf) : null;
      if (!from_zip || !to_zip || !pkgs) return ERR(422, "invalid_request", "from_zip, to_zip and packages[{weight,length,width,height}] are required.");
      const q = await callFn("./quote.js", {
        carriers: "fedex", fromZip: from_zip, toZip: to_zip,
        fromCountry: S(body.from_country || "US"), toCountry: S(body.to_country || "US"),
        residential: body.residential !== false,
        signature: !!body.signature && body.signature !== "none", signatureOption: S(body.signature || "none"),
        saturdayDelivery: !!body.saturday_delivery,
        packageTypeCode: S(body.package_type || ""),
        fedexAccount, pieces: pkgs,
      });
      if (!q || !q.live) return ERR(502, "rates_unavailable", (q && q.error) || "Live rates are temporarily unavailable.");
      const rates = priceRates(q.rates, world, client, from_zip, to_zip, pkgs);
      return J(200, { rates, rate_count: rates.length });
    }

    /* ── POST /v1/labels ── */
    if (seg[0] === "labels" && method === "POST" && seg.length === 1) {
      const sc = S(body.service_code).trim();
      const to = body.to || {}, from = body.from || {};
      const pkgs = Array.isArray(body.packages) && body.packages.length ? body.packages.map(pieceOf) : null;
      if (!sc || !pkgs || !S(to.zip).trim() || !S(from.zip).trim()) return ERR(422, "invalid_request", "service_code, from{...zip}, to{...zip} and packages[] are required.");
      if ((client.blockedServices || []).includes(E.canonSvc(sc))) return ERR(403, "service_not_enabled", "That service isn't enabled on this account.");
      /* 1) live-quote the lane so the charge is the customer's real sell price */
      const q = await callFn("./quote.js", { carriers: "fedex", fromZip: S(from.zip), toZip: S(to.zip), fromCountry: S(from.country || "US"), toCountry: S(to.country || "US"), residential: body.residential !== false, signature: !!body.signature && body.signature !== "none", signatureOption: S(body.signature || "none"), saturdayDelivery: !!body.saturday_delivery, packageTypeCode: S(body.package_type || ""), fedexAccount, pieces: pkgs });
      const live = (q && q.live && q.rates) || [];
      const hit = live.find((r) => r.key === sc) || live.find((r) => E.canonSvc(r.label) === E.canonSvc(sc));
      if (!hit) return ERR(422, "service_unavailable", "FedEx isn't offering '" + sc + "' for this shipment. GET /v1/rates to see what's available.");
      const priced = priceRates([hit], world, client, S(from.zip), S(to.zip), pkgs)[0];
      if (!priced) return ERR(422, "service_unavailable", "That service can't be priced for this account.");
      /* 2) book */
      const order = {
        reference: S(body.reference).slice(0, 40), orderNumber: S(body.reference).slice(0, 40),
        invoiceNo: S(body.invoice_number).slice(0, 40), poNo: S(body.po_number).slice(0, 40), department: S(body.department).slice(0, 40),
        shipmentDate: S(body.ship_date) || new Date().toISOString().slice(0, 10),
        labelStock: S(body.label_stock || "4x6"),
        carrierCode: "fedex", serviceCode: hit.serviceCode, packageTypeCode: hit._oneRate ? (hit.packageTypeCode || S(body.package_type || "")) : "",
        shippingService: hit.label, contentDescription: S(body.contents || "Merchandise"),
        residential: body.residential !== false, signatureOption: S(body.signature || "none"),
        saturdayDelivery: !!body.saturday_delivery, insuranceAmount: num(body.declared_value_total, 0) || null,
        sender: { name: S(from.name), company: S(from.company), address1: S(from.address1), address2: S(from.address2), city: S(from.city), state: S(from.state), zip: S(from.zip), country: S(from.country || "US"), phone: S(from.phone), email: S(from.email) },
        receiver: { name: S(to.name), company: S(to.company), address1: S(to.address1), address2: S(to.address2), city: S(to.city), state: S(to.state), zip: S(to.zip), country: S(to.country || "US"), phone: S(to.phone), email: S(to.email) },
        pieces: pkgs.map((p) => ({ weight: Math.ceil(p.weight), length: p.length, width: p.width, height: p.height, declaredValue: p.declaredValue })),
        fedexAccount,
      };
      const res = await callFn("./ship.js", { action: "ship", order });
      if (!res || !res.ok) return ERR(502, "booking_failed", (res && res.error) || "Booking failed.");
      /* 3) record the shipment on the account (shows in the admin dashboard + billing) */
      const rec = {
        id: Date.now(), date: new Date().toLocaleDateString(), time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        tracking: S(res.tracking), carrier: "FedEx", service: hit.label,
        recipient: order.receiver, sender: order.sender, fromZip: order.sender.zip, toZip: order.receiver.zip,
        weight: pkgs.reduce((a, p) => a + p.weight, 0), pieces: order.pieces, dims: { L: pkgs[0].length, W: pkgs[0].width, H: pkgs[0].height },
        cost: hit.cost, sell: priced.amount, billTo: "sender", status: "Label created", lastScan: "Label created",
        reference: order.reference, invoiceNo: order.invoiceNo, poNo: order.poNo, department: order.department,
        client: client.name, _src: "api",
      };
      try { const cur = await getStore(shipStoreKey(client)); const arr = (cur.ok && Array.isArray(cur.value)) ? cur.value : []; await putStore(shipStoreKey(client), [rec, ...arr].slice(0, 5000)); } catch (e) {}
      return J(201, { label_id: String(rec.id), tracking_number: rec.tracking, tracking_url: "https://www.fedex.com/fedextrack/?trknbr=" + encodeURIComponent(rec.tracking), service_code: sc, service: hit.label, charge: { amount: priced.amount, currency: "USD" }, label_pdf_base64: res.labelPdfBase64 || null });
    }

    /* ── GET /v1/shipments · POST /v1/shipments/{id}/void ── */
    if (seg[0] === "shipments") {
      const cur = await getStore(shipStoreKey(client));
      const arr = (cur.ok && Array.isArray(cur.value)) ? cur.value : [];
      if (method === "GET" && seg.length === 1) {
        const lim = Math.min(200, Math.max(1, num(qs.limit, 50)));
        return J(200, { shipments: arr.slice(0, lim).map((x) => ({ label_id: String(x.id), created: x.date, tracking_number: x.tracking, service: x.service, status: x.status, charge: { amount: x.sell, currency: "USD" }, reference: x.reference || null, to: { name: (x.recipient || {}).name, city: (x.recipient || {}).city, state: (x.recipient || {}).state, zip: x.toZip } })), count: arr.length });
      }
      if (method === "POST" && seg.length === 3 && seg[2] === "void") {
        const id = seg[1];
        const hit = arr.find((x) => String(x.id) === id);
        if (!hit) return ERR(404, "not_found", "No shipment with label_id " + id + " on this account.");
        if (hit.status === "Voided") return J(200, { label_id: id, status: "Voided", note: "Already voided." });
        await putStore(shipStoreKey(client), arr.map((x) => String(x.id) === id ? { ...x, status: "Voided", voidedAt: new Date().toLocaleString() } : x));
        return J(200, { label_id: id, status: "Voided", note: "Marked void; the carrier refund is processed automatically." });
      }
    }

    /* ── GET /v1/tracking/{number} ── */
    if (seg[0] === "tracking" && method === "GET" && seg[1]) {
      const n = S(seg[1]);
      const cur = await getStore(shipStoreKey(client));
      const hit = ((cur.ok && cur.value) || []).find((x) => S(x.tracking) === n);
      return J(200, { tracking_number: n, status: hit ? hit.status : "unknown", last_scan: hit ? (hit.lastScan || null) : null, tracking_url: "https://www.fedex.com/fedextrack/?trknbr=" + encodeURIComponent(n) });
    }

    /* ── POST /v1/pickups ── */
    if (seg[0] === "pickups" && method === "POST") {
      const res = await callFn("./fedex.js", { action: "pickup", date: S(body.date), readyTime: S(body.ready_time || "09:00"), closeTime: S(body.close_time || "17:00"), totalWeight: num(body.total_weight, 1), packageLocation: S(body.package_location || "FRONT"), residential: !!body.residential, address: body.address || {}, account: fedexAccount });
      if (!res || !res.ok) return ERR(502, "pickup_failed", (res && res.error) || "Pickup scheduling failed.");
      return J(201, { confirmation: res.confirmationCode || res.confirmation || "PENDING", location: res.location || null });
    }

    /* ── GET /v1/rate-card — the account's pricing configuration, machine-readable ── */
    if (seg[0] === "rate-card" && method === "GET") {
      const prof = E.rateProfileFor(world.rules, client.id) || {};
      const blocked = new Set(client.blockedServices || []);
      const services = E.RATE_SERVICES.fedex.filter((sv) => !blocked.has(sv.k)).map((sv) => { const r = (prof.services || {})[sv.k] || null; return { service_code: sv.k, service: sv.l, pricing: r ? { basis: r.basis || "percent", value: r.pct != null && r.pct !== "" ? +r.pct : null, minimum: r.min != null && r.min !== "" ? +r.min : null } : { basis: "account_default", value: client.markup != null && client.markup !== "" ? +client.markup : null } }; });
      const surcharges = E.FEDEX_SURCHARGES.map((su) => { const r = (prof.surcharges || {})[su.id]; if (!r || r.amount == null || r.amount === "") return null; return { fee: su.aka || su.desc, mode: r.type || (su.app ? "fixed" : "percent"), value: +r.amount }; }).filter(Boolean);
      return J(200, { account: client.name, currency: "USD", services, surcharge_overrides: surcharges, note: "Rates quote live per shipment — POST /v1/rates for exact prices." });
    }

    /* ── GET /v1/billing/summary · GET /v1/invoices?month=YYYY-MM ── */
    if ((seg[0] === "billing" || seg[0] === "invoices") && method === "GET") {
      const cur = await getStore(shipStoreKey(client));
      const arr = (cur.ok && Array.isArray(cur.value)) ? cur.value : [];
      const inMonth = (x, ym) => { const t = (typeof x.id === "number" && x.id > 1e12) ? new Date(x.id) : new Date(x.date); return !isNaN(t) && t.toISOString().slice(0, 7) === ym; };
      const month = S(qs.month || new Date().toISOString().slice(0, 7));
      const rows = arr.filter((x) => x.status !== "Voided" && inMonth(x, month));
      const total = Math.round(rows.reduce((a, x) => a + (+x.sell || 0), 0) * 100) / 100;
      if (seg[0] === "billing") return J(200, { month, shipments: rows.length, total_charges: total, currency: "USD" });
      if (S(qs.format) === "csv") {
        const csv = "date,tracking,service,reference,amount\n" + rows.map((x) => [x.date, x.tracking, (x.service || "").replace(/,/g, " "), (x.reference || "").replace(/,/g, " "), (+x.sell || 0).toFixed(2)].join(",")).join("\n");
        return { statusCode: 200, headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=invoice-" + month + ".csv", "Access-Control-Allow-Origin": "*" }, body: csv };
      }
      return J(200, { month, currency: "USD", line_items: rows.map((x) => ({ date: x.date, tracking_number: x.tracking, service: x.service, reference: x.reference || null, amount: +x.sell || 0 })), shipment_count: rows.length, total: total });
    }

    return ERR(404, "not_found", "Unknown endpoint. See /api-docs.html for the full reference.");
  } catch (e) {
    return ERR(500, "internal_error", "Something went wrong on our side — try again or contact support.");
  }
};
