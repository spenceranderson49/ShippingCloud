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
/* insert-or-conflict: plain POST WITHOUT resolution=merge-duplicates → a duplicate (tenant,key)
   returns 409 instead of upserting. {inserted:true} = we won the row, {conflict:true} = it
   already existed. This is the real cross-container mutex the idempotency guard relies on. */
async function insertNew(key, value) {
  const c = CFG();
  const r = await fetch(c.url + "/rest/v1/app_stores", { method: "POST", headers: { apikey: c.key, Authorization: "Bearer " + c.key, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify([{ tenant: TENANT, key, value }]) });
  if (r.status === 409) return { conflict: true };
  return { inserted: r.ok };
}

/* ── internal auth for in-process calls into quote.js / ship.js / fedex.js ── */
const scSecret = () => { const s = (process.env.SESSION_SECRET || "").trim(); if (s) return s; const k = (process.env.SUPABASE_SERVICE_KEY || "").trim(); return k ? crypto.createHash("sha256").update("sc1|" + k).digest("hex") : ""; };
const internalKey = () => { const s = scSecret(); return s ? crypto.createHmac("sha256", s).update("internal:carrier").digest("hex") : ""; };
async function callFn(mod, body) {
  const res = await require(mod).handler({ httpMethod: "POST", body: JSON.stringify({ ...body, internalKey: internalKey() }), headers: {} });
  try { return JSON.parse(res.body || "{}"); } catch (e) { return {}; }
}

/* ── responses (ShipEngine-style envelope) ── */
const J = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, X-API-Key, Content-Type", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS" }, body: JSON.stringify(obj) });
const ERR = (code, ecode, msg) => J(code, { error: { code: ecode, message: msg } });

/* ── per-key burst limit (per warm container — the auth gate is the hard control) ── */
const HITS = {};
const allow = (k, max) => { const w = Math.floor(Date.now() / 60000), kk = k + ":" + w; HITS[kk] = (HITS[kk] || 0) + 1; if (Object.keys(HITS).length > 4000) { for (const x in HITS) { if (!x.endsWith(":" + w)) delete HITS[x]; } } return HITS[kk] <= max; };

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const num = (v, d) => { const n = +v; return isFinite(n) ? n : d; };
const S = (v) => (v == null ? "" : String(v));

/* normalize an API package → engine/quote piece */
const pieceOf = (p0) => { const p = (p0 && typeof p0 === "object") ? p0 : {}; return { weight: Math.max(0.1, num(p.weight, 1)), length: Math.max(1, Math.round(num(p.length, 12))), width: Math.max(1, Math.round(num(p.width, 9))), height: Math.max(1, Math.round(num(p.height, 4))), declaredValue: num(p.declared_value, 0) || undefined }; };
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

/* normalize any carrier/internal status string → a stable set integrators can switch on */
function normStatus(raw, fedexCode) {
  const s = String(raw || "").toLowerCase();
  if (fedexCode === "DL" || /delivered/.test(s)) return "delivered";
  if (fedexCode === "RS" || /return/.test(s)) return "returned";
  if (/void/.test(s)) return "voided";
  if (fedexCode === "DE" || /exception|delay|held|clearance/.test(s)) return "exception";
  if (fedexCode === "OD" || fedexCode === "IT" || /transit|out for delivery|departed|arrived|picked up|in fedex possession/.test(s)) return "in_transit";
  if (fedexCode === "PU" || /label created|shipment information|order processed/.test(s)) return "pre_transit";
  return "unknown";
}
const shipStoreKey = (client, isTest) => "u/api_" + client.id + (isTest ? "/testShipments" : "/shipments");   /* testShipments doesn't match the dashboard's (shipments|orders) scan — test traffic is invisible to ops/billing */
const labelPdfKey = (client) => "u/api_" + client.id + "/labelPdfs";   /* one capped store, not unbounded per-label rows (F7) */
const pickupStoreKey = (client) => "u/api_" + client.id + "/pickups";
const hookStoreKey = (client) => "u/api_" + client.id + "/webhooks";
const idemStoreKey = (client) => "u/api_" + client.id + "/idem";
const isPrivateHost = (host) => {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;   // IPv6 loopback/ULA/link-local
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) { const o = m.slice(1).map(Number); if (o[0] === 10 || o[0] === 127 || o[0] === 0 || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 169 && o[1] === 254) || (o[0] === 100 && o[1] >= 64 && o[1] <= 127)) return true; }
  return false;
};
const validHookUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === "https:" && !isPrivateHost(x.hostname); } catch (e) { return false; } };
/* fire-and-forget signed webhooks: X-SC-Signature = hex hmac-sha256(secret, rawBody) */
async function fireHooks(client, eventName, payload) {
  try {
    const cur = await getStore(hookStoreKey(client));
    const hooks = ((cur.ok && cur.value) || []).filter((h) => h && !h.disabled && (!h.events || !h.events.length || h.events.includes(eventName)));
    const body = JSON.stringify({ event: eventName, created: new Date().toISOString(), data: payload });
    await Promise.all(hooks.slice(0, 5).map(async (h) => {
      try {
        if (!validHookUrl(h.url)) return;   // re-validate at delivery (registration check isn't enough vs DNS rebinding)
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
        await fetch(h.url, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", "X-SC-Event": eventName, "X-SC-Signature": crypto.createHmac("sha256", String(h.secret || "")).update(body).digest("hex") }, body, signal: ctrl.signal });
        clearTimeout(t);
      } catch (e) { /* best-effort — receivers poll /v1/shipments as the source of truth */ }
    }));
  } catch (e) {}
}
module.exports.validHookUrl = validHookUrl;

/* map friendly proposal modes → the engine's service-rule basis (same as the Rates tab) */
function svcRuleFromInput(x) {
  if (!x || typeof x !== "object") return null;
  const mode = String(x.mode || "").toLowerCase();
  const v = num(x.value, null);
  const min = num(x.min, null);
  if (mode === "none" || mode === "no_discount") return null;                 // no rule → account default / raw cost
  if (mode === "discount_off_list" || mode === "list") return { basis: "list", pct: v, ...(min != null ? { min } : {}) };
  if (mode === "markup_over_cost" || mode === "percent") return { basis: "percent", pct: v, ...(min != null ? { min } : {}) };
  if (mode === "dollars_over_cost" || mode === "fixed") return { basis: "fixed", pct: v };
  if (mode === "flat") return { basis: "flat", pct: v };
  return null;
}
/* map friendly fee modes → the engine's surcharge-rule type */
function feeRuleFromInput(x) {
  if (!x || typeof x !== "object") return null;
  const mode = String(x.mode || "").toLowerCase();
  const v = num(x.value, null);
  if (v == null && mode !== "list") return null;
  if (mode === "discount_off_list" || mode === "listpct" || mode === "list") return { type: "listpct", amount: v || 0 };
  if (mode === "markup_percent" || mode === "percent") return { type: "percent", amount: v };
  if (mode === "dollars_over" || mode === "add") return { type: "add", amount: v };
  if (mode === "flat" || mode === "fixed") return { type: "fixed", amount: v };
  return null;
}
async function provisionCustomer(body) {
  const cust = body.customer || {};
  const name = S(cust.name || cust.company).trim();
  if (!name) return ERR(422, "invalid_request", "customer.name is required.");
  /* fresh read (not the auth snapshot) so we never clobber a concurrent portal edit */
  const [cRes, rRes] = await Promise.all([getStore("clients"), getStore("rateRules")]);
  /* Refuse on a real read failure — never treat an unreadable store as empty and then
     write the whole array back (that would erase every customer + rate card). */
  if (!cRes.ok || !rRes.ok) return ERR(503, "db_unavailable", "Storage is briefly unavailable — nothing was changed. Try again in a moment.");
  const clients = Array.isArray(cRes.value) ? cRes.value : [];
  const rules = (rRes.ok && rRes.value && typeof rRes.value === "object") ? rRes.value : { profiles: [{ id: "default", name: "Default", services: {}, surcharges: {} }], assign: {}, baseCosts: {} };
  rules.profiles = Array.isArray(rules.profiles) && rules.profiles.length ? rules.profiles : [{ id: "default", name: "Default", services: {}, surcharges: {} }];
  rules.assign = rules.assign || {};
  /* find existing customer by external_id or email, else create */
  const em = S(cust.email).trim().toLowerCase();
  let client = clients.find((c) => c && ((cust.external_id && c.externalId === cust.external_id) || (em && S(c.email).toLowerCase() === em)));
  let created = false;
  if (!client) {
    client = { id: "c" + Date.now() + Math.floor(Math.random() * 1000), name, contact: S(cust.contact), email: S(cust.email), phone: S(cust.phone), origin: S(cust.origin), markup: "", status: "active", since: new Date().toISOString().slice(0, 7), plan: "Standard", createdAt: new Date().toISOString(), externalId: cust.external_id || undefined, blockedServices: [] };
    clients.push(client); created = true;
  } else { client.name = name; if (cust.email) client.email = S(cust.email); if (cust.contact) client.contact = S(cust.contact); }
  /* build this customer's OWN profile from the proposal (never touches the shared Default) */
  const svcRules = {}; const p = body.pricing || {};
  for (const [k, v] of Object.entries(p.services || {})) { const r = svcRuleFromInput(v); if (r && r.pct != null) svcRules[k] = r; }
  const feeRules = {}; for (const [k, v] of Object.entries(p.fees || {})) { const r = feeRuleFromInput(v); if (r) feeRules[k] = r; }
  const assigned = rules.assign[client.id];
  let prof = assigned && rules.profiles.find((x) => x.id === assigned && x.id !== "default");
  if (!prof) { prof = { id: "p" + Date.now(), name: client.name, services: {}, surcharges: {} }; rules.profiles.push(prof); rules.assign[client.id] = prof.id; }
  if (body.replace !== false) { prof.services = svcRules; prof.surcharges = feeRules; }
  else { prof.services = { ...(prof.services || {}), ...svcRules }; prof.surcharges = { ...(prof.surcharges || {}), ...feeRules }; }
  if (typeof p.account_markup === "number") client.markup = p.account_markup;
  const w1 = await putStore("clients", clients);
  const w2 = await putStore("rateRules", rules);
  if (!w1.ok || !w2.ok) return ERR(502, "save_failed", "Couldn't save — try again.");
  return J(created ? 201 : 200, { customer_id: client.id, external_id: client.externalId || null, profile_id: prof.id, created, services_set: Object.keys(svcRules).length, fees_set: Object.keys(feeRules).length, note: "Live in the Rates tab. Press nothing — it's saved." });
}
async function saveReport(body) {
  const rep = { id: "rpt" + Date.now(), title: S(body.title || "Report"), type: S(body.type || "optimization"), customer_external_id: body.customer_external_id || null, data: body.data || null, received: new Date().toISOString() };
  const cur = await getStore("proposalReports");
  if (!cur.ok) return ERR(503, "db_unavailable", "Storage is briefly unavailable — nothing was saved. Try again.");
  const arr = Array.isArray(cur.value) ? cur.value : [];
  await putStore("proposalReports", [rep, ...arr].slice(0, 1000));
  return J(201, { report_id: rep.id, note: "Saved. Visible in Admin → API → Reports." });
}
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
    const isAdminKey = (keyRow.mode || "live") === "admin";
    if (isAdminKey) {
      /* ── admin provisioning surface (your proposal tool → the Rates tab) ── */
      if (!allow("k:" + keyRow.id, 120)) return ERR(429, "rate_limited", "Too many requests — slow down.");
      if (seg[0] === "admin" && seg[1] === "customers" && method === "POST") return await provisionCustomer(body);
      if (seg[0] === "admin" && seg[1] === "reports" && method === "POST") return await saveReport(body);
      if (seg[0] === "account" && method === "GET") return J(200, { account: "admin", mode: "admin", key_prefix: keyRow.prefix, capabilities: ["provision_customers", "save_reports"], docs: "/api-docs.html" });
      return ERR(404, "not_found", "Admin keys can call POST /v1/admin/customers and POST /v1/admin/reports. See /api-docs.html.");
    }
    const client = world.clients.find((x) => x && x.id === keyRow.clientId);
    if (!client) return ERR(403, "no_account", "This key isn't attached to an active account — contact support.");
    if (client.status && client.status !== "active") return ERR(403, "account_inactive", "This account is inactive — contact support.");
    if (!allow("k:" + keyRow.id, 240)) return ERR(429, "rate_limited", "Too many requests — slow down (240/min per key).");
    /* best-effort last-used stamp (never blocks the request) */
    if (!keyRow.lastUsed || Date.now() - new Date(keyRow.lastUsed).getTime() > 3600e3) {
      putStore("u/api_" + client.id + "/keyUsage_" + keyRow.id, { lastUsed: new Date().toISOString() }).catch(() => {});   /* per-key row — never rewrites the shared apiKeys array (F6) */
    }
    const fedexAccount = (client.fedex && S(client.fedex.accountNumber).trim()) || undefined;
    const isTest = (keyRow.mode || "live") === "test";   /* test keys: real quotes, ZERO real bookings/pickups */

    /* ── GET /v1/account — who am I ── */
    if (seg[0] === "account" && method === "GET") {
      return J(200, { account: client.name, mode: keyRow.mode || "live", key_prefix: keyRow.prefix, services_enabled: E.RATE_SERVICES.fedex.filter((sv) => !(client.blockedServices || []).includes(sv.k)).length, rate_limit_per_minute: 240, docs: "/api-docs.html" });
    }

    /* ── POST /v1/addresses/validate ── */
    if (seg[0] === "addresses" && seg[1] === "validate" && method === "POST") {
      const a = body.address || body;
      const res = await callFn("./fedex.js", { action: "address", address1: S(a.address1), address2: S(a.address2), city: S(a.city), state: S(a.state), zip: S(a.zip), country: S(a.country || "US") });
      if (!res || !res.ok) return ERR(502, "validation_unavailable", (res && res.error) || "Address validation is temporarily unavailable.");
      const norm = res.normalized || null;
      const status = res.deliverable === false ? "error" : (res.issues && res.issues.length ? "warning" : (norm ? "verified" : "unverified"));
      return J(200, { status, valid: res.deliverable !== false, classification: res.classification || null, residential: res.classification ? (res.classification === "RESIDENTIAL") : null, matched_address: norm, messages: res.issues || [] });
    }

  async function bookLabel(b) {
      const sc = S(b.service_code).trim();
      const to = b.to || {}, from = b.from || {};
      const pkgs = Array.isArray(b.packages) && b.packages.length ? b.packages.map(pieceOf) : null;
      if (!sc || !pkgs || !S(to.zip).trim() || !S(from.zip).trim()) return { code: 422, resp: { error: { code: "invalid_request", message: "service_code, from{...zip}, to{...zip} and packages[] are required." } } };
      if ((client.blockedServices || []).includes(E.canonSvc(sc))) return { code: 403, resp: { error: { code: "service_not_enabled", message: "That service isn't enabled on this account." } } };
      if (E.CUSTOM_CARRIERS.some((cc) => cc.services.some(([k]) => k === sc))) return { code: 422, resp: { error: { code: "quote_only_carrier", message: "That carrier is quote-only on this account — labels aren't issued through this API for it yet." } } };
      /* 1) live-quote the lane so the charge is the customer's real sell price */
      const q = await callFn("./quote.js", { carriers: "fedex", fromZip: S(from.zip), toZip: S(to.zip), fromCountry: S(from.country || "US"), toCountry: S(to.country || "US"), residential: b.residential !== false, signature: !!b.signature && b.signature !== "none", signatureOption: S(b.signature || "none"), saturdayDelivery: !!b.saturday_delivery, packageTypeCode: S(b.package_type || ""), fedexAccount, pieces: pkgs });
      const live = (q && q.live && q.rates) || [];
      const hit = live.find((r) => r.key === sc) || live.find((r) => E.canonSvc(r.label) === E.canonSvc(sc));
      if (!hit) return { code: 422, resp: { error: { code: "service_unavailable", message: "FedEx isn't offering '" + sc + "' for this shipment. GET /v1/rates to see what's available." } } };
      const priced = priceRates([hit], world, client, S(from.zip), S(to.zip), pkgs)[0];
      if (!priced) return { code: 422, resp: { error: { code: "service_unavailable", message: "That service can't be priced for this account." } } };
      /* 2) book */
      const order = {
        reference: S(b.reference).slice(0, 40), orderNumber: S(b.reference).slice(0, 40),
        invoiceNo: S(b.invoice_number).slice(0, 40), poNo: S(b.po_number).slice(0, 40), department: S(b.department).slice(0, 40),
        shipmentDate: S(b.ship_date) || new Date().toISOString().slice(0, 10),
        labelStock: S(b.label_stock || "4x6"),
        carrierCode: "fedex", serviceCode: hit.serviceCode, packageTypeCode: hit._oneRate ? (hit.packageTypeCode || S(b.package_type || "")) : "",
        shippingService: hit.label, contentDescription: S((b.customs && b.customs.contents) || b.contents || "Merchandise"),
        residential: b.residential !== false, signatureOption: S(b.signature || "none"),
        saturdayDelivery: !!b.saturday_delivery, insuranceAmount: num(b.declared_value_total, 0) || (b.customs && num(b.customs.value_total, 0)) || null,
        contentDescription2: undefined,
        commodities: (body.customs && Array.isArray(body.customs.items)) ? body.customs.items.map((it) => ({ description: S(it.description), quantity: num(it.quantity, 1), unitPrice: num(it.value, 0), value: num(it.value, 0), hsCode: S(it.hs_code), countryOfOrigin: S(it.country_of_origin || "US"), weight: num(it.weight, 0) })) : undefined,
        sender: { name: S(from.name), company: S(from.company), address1: S(from.address1), address2: S(from.address2), city: S(from.city), state: S(from.state), zip: S(from.zip), country: S(from.country || "US"), phone: S(from.phone), email: S(from.email) },
        receiver: { name: S(to.name), company: S(to.company), address1: S(to.address1), address2: S(to.address2), city: S(to.city), state: S(to.state), zip: S(to.zip), country: S(to.country || "US"), phone: S(to.phone), email: S(to.email) },
        pieces: pkgs.map((p) => ({ weight: Math.ceil(p.weight), length: p.length, width: p.width, height: p.height, declaredValue: p.declaredValue })),
        fedexAccount,
      };
      const res = isTest
        ? { ok: true, tracking: "TEST" + String(Date.now()).slice(-10), labelPdfBase64: null }
        : await callFn("./ship.js", { action: "ship", order });
      if (!res || !res.ok) return { code: 502, resp: { error: { code: "booking_failed", message: String((res && res.error) || "Booking failed.").replace(/FedEx/gi, "the carrier") } } };
      /* 3) record the shipment on the account (shows in the admin dashboard + billing) */
      const rec = {
        id: Date.now(), date: new Date().toLocaleDateString(), time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        tracking: S(res.tracking), carrier: "FedEx", service: hit.label,
        recipient: order.receiver, sender: order.sender, fromZip: order.sender.zip, toZip: order.receiver.zip,
        weight: pkgs.reduce((a, p) => a + p.weight, 0), pieces: order.pieces, dims: { L: pkgs[0].length, W: pkgs[0].width, H: pkgs[0].height },
        cost: hit.cost, sell: priced.amount, billTo: "sender", status: "Label created", lastScan: "Label created",
        reference: order.reference, invoiceNo: order.invoiceNo, poNo: order.poNo, department: order.department,
        client: client.name, _src: "api", _test: isTest || undefined,
      };
      if (isTest) rec.status = "Test label";
      /* live dashboard array (best-effort; can lose a record under a concurrent write) */
      try { const cur = await getStore(shipStoreKey(client, isTest)); const arr = (cur.ok && Array.isArray(cur.value)) ? cur.value : []; await putStore(shipStoreKey(client, isTest), [rec, ...arr].slice(0, 5000)); } catch (e) {}
      /* durable per-record billing row — its own key, so NO concurrent booking can clobber it.
         /v1/billing + /v1/invoices reconcile from these so a booked label is ALWAYS billable (F2). */
      if (!isTest) { putStore("u/api_" + client.id + "/rec_" + rec.id, { id: rec.id, date: rec.date, tracking: rec.tracking, service: rec.service, reference: rec.reference || "", sell: rec.sell, status: "Label created" }).catch(() => {}); }
      if (res.labelPdfBase64) { (async () => { try { const cur = await getStore(labelPdfKey(client)); const arr = (cur.ok && Array.isArray(cur.value)) ? cur.value : []; await putStore(labelPdfKey(client), [{ id: String(rec.id), pdf: res.labelPdfBase64, tracking: rec.tracking, created: new Date().toISOString() }, ...arr].slice(0, 200)); } catch (e) {} })(); }
      const resp = { test: isTest || undefined, label_id: String(rec.id), tracking_number: rec.tracking, tracking_url: "https://www.fedex.com/fedextrack/?trknbr=" + encodeURIComponent(rec.tracking), service_code: sc, service: hit.label, charge: { amount: priced.amount, currency: "USD" }, label_pdf_base64: res.labelPdfBase64 || null };
      fireHooks(client, "label.created", { label_id: resp.label_id, tracking_number: resp.tracking_number, service_code: sc, charge: resp.charge, reference: order.reference || null, test: isTest || undefined });
      return { code: 201, resp };
  }

    /* ── GET /v1/services ── */
    if (seg[0] === "services" && method === "GET") {
      const blocked = new Set(client.blockedServices || []);
      let services = E.RATE_SERVICES.fedex.filter((sv) => !blocked.has(sv.k)).map((sv) => ({ service_code: sv.k, service: sv.l, group: sv.g || "FedEx", one_rate: !!sv.or }));
      for (const cc of E.CUSTOM_CARRIERS) { if ((client.enabledCarriers || []).includes(cc.id)) services = services.concat(cc.services.filter(([k]) => !blocked.has(k)).map(([k, l]) => ({ service_code: k, service: l, group: cc.name, quote_only: true }))); }
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
      if (!q || !q.live) return ERR(502, "rates_unavailable", "Live rates are temporarily unavailable — try again shortly.");
      let rates = priceRates(q.rates, world, client, from_zip, to_zip, pkgs);
      /* other carriers — ONLY when the admin enabled them on this account */
      try {
        const extra = E.customCarrierQuotes(world.rules, client, { fromZip: from_zip, toZip: to_zip, pieces: ctxPieces(pkgs) })
          .map((r) => ({ service_code: r.key, service: r.label, carrier: r.carrier.toLowerCase().replace(/[^a-z0-9]+/g, "_"), amount: Math.round(r.sell * 100) / 100, currency: "USD", delivery_days: null, quote_only: true }));
        rates = rates.concat(extra).sort((a, b) => a.amount - b.amount);
      } catch (e) {}
      return J(200, { rates, rate_count: rates.length });
    }

    /* ── GET /v1/labels/{id} — re-download a label PDF ── */
    if (seg[0] === "labels" && method === "GET" && seg[1]) {
      const cur = await getStore(labelPdfKey(client));
      const rowp = ((cur.ok && cur.value) || []).find((x) => x && x.id === seg[1]);
      if (!rowp) return ERR(404, "not_found", "No stored label PDF for that label_id (the last 200 labels are retained).");
      return J(200, { label_id: seg[1], tracking_number: rowp.tracking || null, label_pdf_base64: rowp.pdf || null, created: rowp.created || null });
    }

    /* ── POST /v1/labels ── */
    if (seg[0] === "labels" && method === "POST" && seg.length === 1) {
      /* Idempotency-Key: replaying the same key returns the ORIGINAL response — a network
         retry can never double-book a label. */
      const idemKey = S((event.headers && (event.headers["idempotency-key"] || event.headers["Idempotency-Key"])) || "").slice(0, 80);
      if (idemKey) {
        const irow = "u/api_" + client.id + "/idemk_" + sha(idemKey).slice(0, 40);
        /* replay a completed one */
        const done = await getStore(irow);
        if (done.ok && done.value && done.value.status === "done") return { ...J(done.value.code || 201, done.value.resp), headers: { ...J(200, {}).headers, "Idempotency-Replayed": "true" } };
        /* MUTEX: only the container that wins the INSERT proceeds to book — a concurrent sibling
           gets a conflict and returns 409. A pending row older than 3 min means the original
           booking crashed/timed out mid-flight, so we RECLAIM it rather than lock the key forever. */
        const res0 = await insertNew(irow, { status: "pending", at: Date.now() });
        if (res0.conflict) {
          const stale = done.ok && done.value && done.value.status === "pending" && done.value.at && (Date.now() - done.value.at > 180000);
          if (!stale) return ERR(409, "in_progress", "A label with this Idempotency-Key is already being created — retry shortly to fetch the result.");
          await putStore(irow, { status: "pending", at: Date.now() });   // take over the stale lock
        }
        let r;
        try { r = await bookLabel(body); }
        catch (e) { putStore(irow, { status: "failed", at: Date.now() }).catch(() => {}); throw e; }
        if (r.code >= 400) { putStore(irow, { status: "failed", at: Date.now() }).catch(() => {}); return J(r.code, r.resp); }   // don't cache a failure as "done"
        putStore(irow, { status: "done", code: r.code, resp: { ...r.resp, label_pdf_base64: null } }).catch(() => {});
        return J(r.code, r.resp);
      }
      const r = await bookLabel(body);
      return J(r.code, r.resp);
    }

    /* ── POST /v1/labels/batch — up to 100 labels in one call ── */
    if (seg[0] === "labels" && seg[1] === "batch" && method === "POST") {
      const items = Array.isArray(body.shipments) ? body.shipments : [];
      if (!items.length) return ERR(422, "invalid_request", "shipments[] is required (each item is a normal /v1/labels body).");
      if (items.length > 100) return ERR(422, "too_many", "Batch is capped at 100 shipments per call.");
      const out = [];
      for (let i = 0; i < items.length; i++) {
        try { const r = await bookLabel(items[i] || {}); out.push(r.code === 201 ? { status: "success", ...r.resp } : { status: "error", index: i, ...r.resp }); }
        catch (e) { out.push({ status: "error", index: i, error: { code: "internal_error", message: "Failed to process this shipment." } }); }
      }
      const ok = out.filter((x) => x.status === "success").length;
      return J(207, { batch: true, total: items.length, succeeded: ok, failed: items.length - ok, results: out });
    }

    /* ── POST /v1/returns — a prepaid return label (from ↔ to swapped by default) ── */
    if (seg[0] === "returns" && method === "POST") {
      const b = { ...body };
      if (!b.from || !b.to) return ERR(422, "invalid_request", "from{...} (the return recipient — usually you) and to{...} (the customer returning) are required.");
      /* a return ships FROM the buyer TO the merchant: swap unless the caller set them explicitly */
      if (b.swap !== false) { const t = b.from; b.from = b.to; b.to = t; }
      b.reference = b.reference || "RETURN";
      const r = await bookLabel(b);
      if (r.code === 201) r.resp.is_return = true;
      return J(r.code, r.resp);
    }

    /* ── GET /v1/shipments · POST /v1/shipments/{id}/void ── */
    if (seg[0] === "shipments") {
      const cur = await getStore(shipStoreKey(client, isTest));
      const arr = (cur.ok && Array.isArray(cur.value)) ? cur.value : [];
      if (method === "GET" && seg.length === 1) {
        const lim = Math.min(200, Math.max(1, num(qs.limit, 50)));
        const page = Math.max(1, num(qs.page, 1));
        const start = (page - 1) * lim;
        const slice = arr.slice(start, start + lim);
        return J(200, { shipments: slice.map((x) => ({ label_id: String(x.id), created: x.date, tracking_number: x.tracking, service: x.service, status: normStatus(x.status, x.trackCode), status_detail: x.status, charge: { amount: x.sell, currency: "USD" }, reference: x.reference || null, to: { name: (x.recipient || {}).name, city: (x.recipient || {}).city, state: (x.recipient || {}).state, zip: x.toZip } })), page, limit: lim, total: arr.length, has_more: start + lim < arr.length });
      }
      if (method === "POST" && seg.length === 3 && seg[2] === "void") {
        const id = seg[1];
        const hit = arr.find((x) => String(x.id) === id);
        if (!hit) return ERR(404, "not_found", "No shipment with label_id " + id + " on this account.");
        if (hit.status === "Voided") return J(200, { label_id: id, status: "Voided", note: "Already voided." });
        let cancelNote = "Marked void.";
        if (!isTest && hit.tracking) {
          try { const cx = await callFn("./fedex.js", { action: "cancelShipment", trackingNumber: hit.tracking, account: fedexAccount }); cancelNote = (cx && cx.ok) ? "Voided and cancelled with the carrier — the label credit is automatic." : "Voided here, but the carrier cancel didn't confirm — verify the refund or contact support."; } catch (e) { cancelNote = "Voided here; the carrier cancel couldn't be reached — verify the refund."; }
        }
        await putStore(shipStoreKey(client, isTest), arr.map((x) => String(x.id) === id ? { ...x, status: "Voided", voidedAt: new Date().toLocaleString() } : x));
        if (!isTest) putStore("u/api_" + client.id + "/rec_" + id, { id: hit.id, date: hit.date, tracking: hit.tracking, service: hit.service, reference: hit.reference || "", sell: hit.sell, status: "Voided" }).catch(() => {});
        fireHooks(client, "label.voided", { label_id: id, tracking_number: hit.tracking || null });
        return J(200, { label_id: id, status: "Voided", note: cancelNote });
      }
    }

    /* ── GET /v1/tracking/{number} ── */
    if (seg[0] === "tracking" && method === "GET" && seg[1]) {
      const n = S(seg[1]);
      const cur = await getStore(shipStoreKey(client, isTest));
      const hit = ((cur.ok && cur.value) || []).find((x) => S(x.tracking) === n);
      let live = null;
      if (!isTest) { try { live = await callFn("./fedex.js", { action: "track", trackingNumber: n }); } catch (e) {} }
      const rawStatus = (live && live.ok && live.status) || (hit && hit.status) || "unknown";
      const code = (live && live.ok && live.code) || (hit && hit.trackCode) || "";
      return J(200, { tracking_number: n, status: normStatus(rawStatus, code), status_detail: rawStatus, estimated_delivery: (live && live.ok && live.estDelivery) || null, events: (live && live.ok && live.events) || (hit && hit.lastScan ? [{ status: hit.lastScan }] : []), tracking_url: "https://www.fedex.com/fedextrack/?trknbr=" + encodeURIComponent(n) });
    }

    /* ── GET /v1/pickups · POST /v1/pickups/{confirmation}/cancel ── */
    if (seg[0] === "pickups" && method === "GET") {
      const cur = await getStore(pickupStoreKey(client));
      return J(200, { pickups: ((cur.ok && cur.value) || []).slice(0, 100) });
    }
    if (seg[0] === "pickups" && method === "POST" && seg.length === 3 && seg[2] === "cancel") {
      const conf = seg[1];
      const cur = await getStore(pickupStoreKey(client));
      if (!cur.ok) return ERR(503, "db_unavailable", "Storage is briefly unavailable — nothing was changed. Try again.");
      const arr = Array.isArray(cur.value) ? cur.value : [];
      const hit = arr.find((p) => S(p.confirmation) === conf);
      if (isTest || /^TESTPICKUP/.test(conf)) { await putStore(pickupStoreKey(client), arr.map((p) => S(p.confirmation) === conf ? { ...p, status: "canceled" } : p)); return J(200, { confirmation: conf, status: "canceled", test: true }); }
      const res = await callFn("./fedex.js", { action: "pickupCancel", confirmationCode: conf, carrierCode: "FDXE", date: hit ? hit.date : S(body.date), location: hit ? hit.location : S(body.location), account: fedexAccount });
      if (!res || !res.ok) return ERR(502, "cancel_failed", (res && res.error) || "Pickup cancel failed.");
      await putStore(pickupStoreKey(client), arr.map((p) => S(p.confirmation) === conf ? { ...p, status: "canceled" } : p));
      return J(200, { confirmation: conf, status: "canceled" });
    }

    /* ── GET/POST/DELETE /v1/webhooks — signed event delivery ── */
    if (seg[0] === "webhooks") {
      const cur = await getStore(hookStoreKey(client));
      const hooks = (cur.ok && Array.isArray(cur.value)) ? cur.value : [];
      if (method === "GET") return J(200, { webhooks: hooks.map((h) => ({ id: h.id, url: h.url, events: h.events || ["label.created", "label.voided"], created: h.created })) });
      if (method === "POST" && seg.length === 1) {
        if (!validHookUrl(body.url)) return ERR(422, "invalid_url", "Webhook URLs must be public https:// endpoints.");
        if (hooks.length >= 5) return ERR(422, "too_many", "Maximum 5 webhooks per account — delete one first.");
        const secret = "whsec_" + crypto.randomBytes(24).toString("hex");
        const row = { id: "wh" + Date.now(), url: S(body.url), events: Array.isArray(body.events) && body.events.length ? body.events.map(S) : ["label.created", "label.voided"], secret, created: new Date().toISOString() };
        await putStore(hookStoreKey(client), [...hooks, row]);
        return J(201, { id: row.id, url: row.url, events: row.events, secret, note: "Store the secret now — every delivery is signed: X-SC-Signature = hex HMAC-SHA256(secret, raw body)." });
      }
      if (method === "DELETE" && seg[1]) {
        await putStore(hookStoreKey(client), hooks.filter((h) => h.id !== seg[1]));
        return J(200, { deleted: seg[1] });
      }
    }

    /* ── POST /v1/pickups ── */
    if (seg[0] === "pickups" && method === "POST") {
      if (isTest) { const pk = { confirmation: "TESTPICKUP" + String(Date.now()).slice(-6), location: null, date: S(body.date), status: "scheduled", test: true, created: new Date().toISOString() }; try { const cur = await getStore(pickupStoreKey(client)); await putStore(pickupStoreKey(client), [pk, ...((cur.ok && cur.value) || [])].slice(0, 200)); } catch (e) {} return J(201, pk); }
      const res = await callFn("./fedex.js", { action: "pickup", date: S(body.date), readyTime: S(body.ready_time || "09:00"), closeTime: S(body.close_time || "17:00"), totalWeight: num(body.total_weight, 1), packageLocation: S(body.package_location || "FRONT"), residential: !!body.residential, address: body.address || {}, account: fedexAccount });
      if (!res || !res.ok) return ERR(502, "pickup_failed", (res && res.error) || "Pickup scheduling failed.");
      const pk = { confirmation: res.confirmationCode || res.confirmation || "PENDING", location: res.location || null, date: S(body.date), status: "scheduled", created: new Date().toISOString() };
      try { const cur = await getStore(pickupStoreKey(client)); await putStore(pickupStoreKey(client), [pk, ...((cur.ok && cur.value) || [])].slice(0, 200)); } catch (e) {}
      return J(201, pk);
    }

    /* ── GET /v1/rate-card — the account's pricing configuration, machine-readable ── */
    if (seg[0] === "rate-card" && method === "GET") {
      const prof = E.rateProfileFor(world.rules, client.id) || {};
      const blocked = new Set(client.blockedServices || []);
      const services = E.RATE_SERVICES.fedex.filter((sv) => !blocked.has(sv.k)).map((sv) => { const r = (prof.services || {})[sv.k] || null; return { service_code: sv.k, service: sv.l, pricing: r ? { basis: r.basis || "percent", value: r.pct != null && r.pct !== "" ? +r.pct : null, minimum: r.min != null && r.min !== "" ? +r.min : null } : { basis: "account_default", value: client.markup != null && client.markup !== "" ? +client.markup : null } }; });
      const surcharges = E.FEDEX_SURCHARGES.map((su) => { const r = (prof.surcharges || {})[su.id]; if (!r || r.amount == null || r.amount === "") return null; return { fee: su.aka || su.desc, mode: r.type || (su.app ? "fixed" : "percent"), value: +r.amount }; }).filter(Boolean);
      return J(200, { account: client.name, currency: "USD", services, surcharge_overrides: surcharges, note: "Rates quote live per shipment — POST /v1/rates for exact prices." });
    }

    /* ── issued invoices (admin-generated) take precedence over the on-the-fly month rollup ── */
    if (seg[0] === "invoices") {
      const iCur = await getStore("invoicesIssued");
      const issued = ((iCur.ok && iCur.value) || []).filter((v) => v && v.clientId === client.id && v.status !== "void");
      if (method === "GET" && seg[1]) {   /* GET /v1/invoices/{id} */
        const inv = issued.find((v) => v.id === seg[1] || v.number === seg[1]);
        if (!inv) return ERR(404, "not_found", "No invoice with that id/number on this account.");
        const paid = (inv.payments || []).reduce((a, p) => a + (+p.amount || 0), 0);
        return J(200, { id: inv.id, number: inv.number, period: inv.month, status: inv.status, terms: inv.terms || null, issued: inv.issuedAt || null, total: inv.total, paid: Math.round(paid * 100) / 100, balance: Math.round((inv.total - paid) * 100) / 100, currency: "USD", line_items: inv.items });
      }
      if (method === "GET" && !seg[1] && issued.length) {   /* GET /v1/invoices — list issued */
        return J(200, { invoices: issued.map((inv) => { const paid = (inv.payments || []).reduce((a, p) => a + (+p.amount || 0), 0); return { id: inv.id, number: inv.number, period: inv.month, status: inv.status, total: inv.total, balance: Math.round((inv.total - paid) * 100) / 100, currency: "USD" }; }), count: issued.length });
      }
    }

    /* ── GET /v1/billing/summary · GET /v1/invoices?month=YYYY-MM (on-the-fly, when none issued) ── */
    if ((seg[0] === "billing" || seg[0] === "invoices") && method === "GET") {
      let arr = [];
      if (!isTest) {
        /* reconcile from the durable per-record rows so a label lost from the array is still billed */
        const rr = await pg("app_stores?tenant=eq." + encodeURIComponent(TENANT) + "&key=like." + encodeURIComponent("u/api_" + client.id + "/rec_") + "*&select=value");
        if (rr.ok && Array.isArray(rr.data)) arr = rr.data.map((x) => x.value).filter((v) => v && v.status !== "Voided");
      }
      if (!arr.length) { const cur = await getStore(shipStoreKey(client, isTest)); arr = (cur.ok && Array.isArray(cur.value)) ? cur.value : []; }
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
