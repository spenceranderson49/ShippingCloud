/* shopify-rates.js — Shopify Carrier Service callback.
   Shopify POSTs the buyer's cart + destination at checkout; we respond with live,
   box-logic-packed, margin-applied shipping options (+ delivery date estimates).

   Flow:  Shopify → this function
            1) verify ?uid & ?key   (key = HMAC(uid, SESSION_SECRET) — no DB lookup needed)
            2) load that account's settings from Supabase (products, boxes, boxLogic, checkout)
               plus the shared rateRules / clients / users stores
            3) cartonize the cart: catalog dims by SKU, ships-alone items, smallest-fit box,
               grams fallback for items not in the catalog (Shopify always sends grams)
            4) price: live England quote via our own /quote function (shared cache),
               fall back to the built-in estimator if England is slow/down
            5) raw carrier cost → the merchant's SELL price through the same rate engine the
               portal uses (profile service rules, surcharge rules, account markup — via
               api-engine rateSellFor), so Admin → Rates edits move checkout prices too;
               admin-blocked services never show at checkout
            6) apply checkout config on top of the SELL: enabled services, buyer markup +
               handling, free-shipping threshold, named vs tier presentation
            7) answer in Shopify's carrier-service shape with min/max delivery dates.

   Register via shopify-sync.js action "installCarrier". Requires the store's custom app
   to have the write_shipping scope, and third-party carrier-calculated rates enabled on
   the store's Shopify plan. */

const crypto = require("crypto");
const E = require("./api-engine.js");   // shared pricing engine — same math as the portal

const J = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const keyFor = (uid) => crypto.createHmac("sha256", process.env.SESSION_SECRET || "").update("carrier:" + uid).digest("hex").slice(0, 32);
/* internal auth for our own /quote call below — quote.js is session-gated (audit F1) */
const scSecret = () => { const s = (process.env.SESSION_SECRET || "").trim(); if (s) return s; const k = (process.env.SUPABASE_SERVICE_KEY || "").trim(); return k ? crypto.createHash("sha256").update("sc1|" + k).digest("hex") : ""; };
const scInternalKey = () => { const s = scSecret(); return s ? crypto.createHmac("sha256", s).update("internal:carrier").digest("hex") : ""; };

/* ── store loader (Supabase REST, service key) — one query for the account's settings plus
      the shared pricing stores (rateRules / clients / users) so checkout prices through the
      merchant's real rate profile ── */
async function loadStores(uid) {
  const base = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const svc = process.env.SUPABASE_SERVICE_KEY || "";
  if (!base || !svc) return { settings: null, rules: null, client: null };
  const sKey = "u/" + uid + "/settings";
  const keys = [sKey, "rateRules", "clients", "users"].map((k) => '"' + k + '"').join(",");
  const r = await fetch(base + "/rest/v1/app_stores?tenant=eq.main&key=in.(" + encodeURIComponent(keys) + ")&select=key,value", {
    headers: { apikey: svc, Authorization: "Bearer " + svc }
  });
  if (!r.ok) return { settings: null, rules: null, client: null };
  const rows = await r.json().catch(() => null);
  const val = (k) => { const row = Array.isArray(rows) ? rows.find((x) => x && x.key === k) : null; return row ? row.value : null; };
  const settings = val(sKey);
  const rules = val("rateRules");
  const users = Array.isArray(val("users")) ? val("users") : [];
  const clients = Array.isArray(val("clients")) ? val("clients") : [];
  /* uid is String(user.id || user.email) — match either, then the user's company record */
  const u = users.find((x) => x && (String(x.id) === uid || String(x.email || "").toLowerCase() === uid.toLowerCase())) || null;
  const client = (u && u.clientId) ? (clients.find((c) => c && c.id === u.clientId) || null) : null;
  return { settings, rules, client };
}

/* ── box logic (server port of the app's engine) ── */
const sortDesc3 = (a, b, c) => [+a || 0, +b || 0, +c || 0].sort((x, y) => y - x);
const boxVol = (b) => b.L * b.W * b.H;
const DEFAULT_BOXES = [
  { id: "d1", name: "Small box", L: 10, W: 8, H: 6, maxWt: 25, empty: 0.25 },
  { id: "d2", name: "Medium box", L: 14, W: 12, H: 8, maxWt: 45, empty: 0.45 },
  { id: "d3", name: "Large box", L: 20, W: 16, H: 14, maxWt: 70, empty: 0.8 },
];
function itemFitsBox(it, box, pad) {
  const [il, iw, ih] = sortDesc3(it.l, it.w, it.h);
  const [bl, bw, bh] = sortDesc3(box.L - pad, box.W - pad, box.H - pad);
  return il <= bl && iw <= bw && ih <= bh;
}
function pickBox(items, boxes, slack, pad) {
  const list = (boxes && boxes.length) ? boxes : DEFAULT_BOXES;
  const totalVol = items.reduce((a, it) => a + ((+it.l || 0) * (+it.w || 0) * (+it.h || 0)) * (it.qty || 1), 0);
  const totalWt = items.reduce((a, it) => a + (+it.wt || 0) * (it.qty || 1), 0);
  const need = totalVol * (slack || 1.3);
  const dimsKnown = items.some((it) => +it.l > 0 && +it.w > 0 && +it.h > 0);
  const sorted = [...list].sort((a, b) => boxVol(a) - boxVol(b));
  const fits = (box) => {
    if (boxVol(box) < need) return false;
    if (box.maxWt && box.maxWt < totalWt) return false;
    if (dimsKnown) { for (const it of items) { if (+it.l > 0 && !itemFitsBox(it, box, pad || 0)) return false; } }
    return true;
  };
  const fit = sorted.find(fits);
  if (fit) return { box: fit, count: 1, billWt: Math.round((totalWt + (fit.empty || 0)) * 10) / 10 };
  const big = sorted[sorted.length - 1] || DEFAULT_BOXES[2];
  const count = Math.max(1, Math.ceil(Math.max(boxVol(big) ? need / boxVol(big) : 1, big.maxWt ? totalWt / big.maxWt : 1)));
  return { box: big, count, billWt: Math.round((totalWt + (big.empty || 0) * count) * 10) / 10 };
}
/* cart → pieces. Catalog by SKU; ships-alone items get their own piece; grams fallback. */
function cartToPieces(items, products, boxes, bl) {
  const cfg = bl || {};
  const pad = +cfg.padding || 0;
  const bySku = {}; (products || []).forEach((p) => { if (p && p.sku) bySku[String(p.sku).toLowerCase()] = p; });
  const rows = [];
  for (const it of (items || [])) {
    if (it && it.requires_shipping === false) continue;
    const pr = it && it.sku ? bySku[String(it.sku).toLowerCase()] : null;
    const gramsLb = Math.max(0.05, ((+it.grams || 0) / 453.592));
    rows.push({
      l: pr ? +pr.l || 0 : 0, w: pr ? +pr.w || 0 : 0, h: pr ? +pr.h || 0 : 0,
      wt: pr && +pr.wt ? +pr.wt : Math.round(gramsLb * 100) / 100,
      qty: +it.quantity || 1,
      shipsAlone: !!(pr && pr.shipsAlone && +pr.l > 0),
    });
  }
  if (!rows.length) return null;
  const pieces = [];
  rows.filter((r) => r.shipsAlone).forEach((r) => {
    for (let k = 0; k < r.qty; k++) pieces.push({ weight: Math.max(0.1, r.wt), L: Math.ceil(r.l + pad), W: Math.ceil(r.w + pad), H: Math.ceil(r.h + pad) });
  });
  const rest = rows.filter((r) => !r.shipsAlone);
  if (rest.length) {
    const list = (boxes && boxes.length) ? boxes : DEFAULT_BOXES;
    const useBoxes = cfg.mode === "single"
      ? [{ id: "fb", name: "Default", L: +cfg.fallbackL || 12, W: +cfg.fallbackW || 9, H: +cfg.fallbackH || 4, maxWt: 150, empty: 0.3 }]
      : list;
    const pk = pickBox(rest, useBoxes, 1.3, pad);
    const per = Math.max(0.1, Math.round((pk.billWt / pk.count) * 10) / 10);
    for (let k = 0; k < pk.count; k++) pieces.push({ weight: per, L: pk.box.L, W: pk.box.W, H: pk.box.H });
  }
  return pieces.length ? pieces : null;
}

/* ── service key mapping + fallback pricing (mirrors the app's estimator) ── */
function labelKey(label) {
  const t = String(label || "").toLowerCase();
  if (/home delivery/.test(t)) return "fedex_home";
  if (/ground economy/.test(t)) return "fedex_econ";
  if (/ground/.test(t)) return "fedex_ground";
  if (/2 ?day.*a\.?m/.test(t)) return "fedex_2dayam";
  if (/2 ?day/.test(t)) return "fedex_2day";
  if (/express saver/.test(t)) return "fedex_saver";
  if (/first overnight/.test(t)) return "fedex_first";
  if (/priority overnight/.test(t)) return "fedex_prio";
  if (/standard overnight/.test(t)) return "fedex_std";
  return null;
}
const zoneEst = (o, d) => { const a = parseInt(String(o).slice(0, 3) || "840", 10); const b = parseInt(String(d).slice(0, 3) || "840", 10); return Math.min(8, Math.max(2, 2 + Math.round(Math.abs(a - b) / 90))); };
const FALLBACK_RATES = {
  fedex_ground: { base: 9.2, pz: 0.95, pl: 0.55, fuel: 0.16, res: 4.2, days: [1, 5], label: "FedEx Ground\u00ae" },
  fedex_home:   { base: 8.2, pz: 0.9,  pl: 0.52, fuel: 0.16, res: 0,   days: [1, 5], label: "FedEx Home Delivery\u00ae" },
  fedex_2day:   { base: 18,  pz: 2.2,  pl: 1.3,  fuel: 0.16, res: 0,   days: [2, 2], label: "FedEx 2Day\u00ae" },
  fedex_saver:  { base: 14,  pz: 1.6,  pl: 0.9,  fuel: 0.16, res: 0,   days: [3, 3], label: "FedEx Express Saver\u00ae" },
  fedex_prio:   { base: 38,  pz: 4.2,  pl: 2.6,  fuel: 0.16, res: 0,   days: [1, 1], label: "FedEx Priority Overnight\u00ae" },
  fedex_std:    { base: 30,  pz: 3.6,  pl: 2.1,  fuel: 0.16, res: 0,   days: [1, 1], label: "FedEx Standard Overnight\u00ae" },
};
function fallbackQuotes(fromZip, toZip, pieces) {
  const zone = zoneEst(fromZip, toZip);
  const wt = pieces.reduce((a, p) => a + (+p.weight || 0), 0);
  return Object.keys(FALLBACK_RATES).map((k) => {
    const r = FALLBACK_RATES[k];
    const cost = Math.round(((r.base + r.pz * zone + r.pl * wt) * (1 + r.fuel) + r.res) * 100) / 100;
    return { key: k, label: r.label, cost, days: r.days };
  });
}
function daysFor(label, fromZip, toZip) {
  const t = String(label || "").toLowerCase();
  if (/first overnight|priority overnight|standard overnight|overnight|next ?day/.test(t)) return [1, 1];
  if (/2 ?day/.test(t)) return [2, 2];
  if (/express saver|3 ?day/.test(t)) return [3, 3];
  const z = zoneEst(fromZip, toZip);
  const g = Math.min(5, Math.max(1, z - 1));
  return [Math.max(1, g - 1), g];
}
function addBizDays(n) {
  const d = new Date(); let left = n;
  while (left > 0) { d.setDate(d.getDate() + 1); const dow = d.getDay(); if (dow !== 0 && dow !== 6) left--; }
  return d.toISOString().slice(0, 10) + " 20:00:00 -0600";
}

/* ── live rates via our own quote function (shared England parsing + cache) ── */
async function liveQuotes(fromZip, dest, pieces) {
  const base = (process.env.APP_URL || "").replace(/\/+$/, "");
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6500);
  try {
    const r = await fetch(base + "/.netlify/functions/quote", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal,
      body: JSON.stringify({ internalKey: scInternalKey(), carriers: "fedex", fromZip, toZip: dest.zip, toCity: dest.city, toState: dest.state, toCountry: dest.country || "US", residential: true, pieces })
    });
    const d = await r.json().catch(() => null);
    if (d && d.live && Array.isArray(d.rates) && d.rates.length) {
      /* keep list/listBase/surcharges so the rate engine can price List−% rules and
         per-fee accessorial rules exactly like the portal does */
      return d.rates.map((q) => ({ key: labelKey(q.label), label: q.label, cost: +q.cost || 0, list: q.list, listBase: q.listBase, surcharges: q.surcharges, days: null })).filter((q) => q.key && q.cost > 0);
    }
    return null;
  } catch (e) { return null; }
  finally { clearTimeout(timer); }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "GET") return J(200, { ok: true, service: "ShippingCloud carrier rates", ready: true });
    if (event.httpMethod !== "POST") return J(405, { error: "POST only" });

    const qs = event.queryStringParameters || {};
    const uid = String(qs.uid || "");
    if (!uid || String(qs.key || "") !== keyFor(uid)) return J(403, { error: "Bad carrier key" });

    let body = null; try { body = JSON.parse(event.body || "{}"); } catch {}
    const rate = (body && body.rate) || {};
    const dest = rate.destination || {};
    const origin = rate.origin || {};
    const items = Array.isArray(rate.items) ? rate.items : [];
    if (!dest.postal_code || !items.length) return J(200, { rates: [] });

    const loaded = await loadStores(uid);
    const settings = loaded.settings || {};
    const rules = (loaded.rules && typeof loaded.rules === "object") ? loaded.rules : null;
    const client = loaded.client;
    if (rules) { try { E.setDimCfg(rules.dimDivisors); } catch {} }
    const ck = settings.checkout || {};
    const services = ck.services || { fedex_ground: true, fedex_home: true, fedex_2day: true };
    const markup = (ck.markup != null ? +ck.markup : 20);
    const handling = +ck.handling || 0;
    const freeThreshold = +ck.freeThreshold || 0;
    const presentation = ck.presentation || "named";

    const pieces = cartToPieces(items, settings.products, settings.boxes, settings.boxLogic)
      || [{ weight: Math.max(0.5, items.reduce((a, it) => a + ((+it.grams || 0) / 453.592) * (+it.quantity || 1), 0)), L: 12, W: 9, H: 4 }];

    const fromZip = String(origin.postal_code || (settings.sender && settings.sender.zip) || "").trim() || "84119";
    const destN = { zip: String(dest.postal_code || "").trim(), city: dest.city, state: dest.province, country: dest.country || "US" };

    let quotes = await liveQuotes(fromZip, destN, pieces);
    let source = "live";
    if (!quotes || !quotes.length) { quotes = fallbackQuotes(fromZip, destN.zip, pieces); source = "estimate"; }

    // admin-blocked services never show at checkout (same enforcement as the portal + API)
    const blocked = new Set(((client && client.blockedServices) || []).map(String));

    // enabled services only; buyer price = the merchant's SELL price (raw cost run through
    // the same rate engine as the portal: profile rules, surcharge rules, account markup)
    // ×(1+checkout markup%) + handling. With no rules/client loaded, sell = cost — identical
    // to the old behavior.
    const sellFor = (q) => {
      if (!rules) return q.cost;
      try {
        const wt = E.ruleWeightFor(pieces.map((p) => ({ weight: +p.weight || 0, L: p.L, W: p.W, H: p.H })), q.label);
        const s = E.rateSellFor(q.cost, q.label, { rules, client, list: q.list, listBase: q.listBase, surcharges: q.surcharges, fromZip, toZip: destN.zip, weight: wt });
        return (s != null && !isNaN(+s)) ? +s : q.cost;
      } catch { return q.cost; }
    };
    const names = (ck.names && typeof ck.names === "object") ? ck.names : {};
    let priced = quotes
      .filter((q) => services[q.key] && !blocked.has(E.canonSvc(q.label)))
      .map((q) => {
        const sell = sellFor(q);
        const buyer = Math.round((sell * (1 + markup / 100) + handling) * 100) / 100;
        const dd = q.days || daysFor(q.label, fromZip, destN.zip);
        /* merchant's custom checkout name (Settings → Checkout Rates) — buyers see it instead
           of the FedEx name; tiers presentation overwrites the label with the tier name anyway */
        const disp = String(names[q.key] || "").trim();
        return { ...q, label: disp || q.label, sell, buyer, dmin: dd[0], dmax: dd[1] };
      })
      .sort((a, b) => a.buyer - b.buyer);
    if (!priced.length) return J(200, { rates: [] });

    // free shipping: cheapest ground-family option becomes $0 above the cart threshold
    const subtotal = items.reduce((a, it) => a + ((+it.price || 0) * (+it.quantity || 1)), 0) / 100;
    if (freeThreshold > 0 && subtotal >= freeThreshold) {
      const g = priced.find((q) => /ground|home/i.test(q.label)) || priced[0];
      g.buyer = 0; g.free = true;
    }

    // presentation: named services, or collapsed Express/Standard/Economy tiers
    let out = priced;
    if (presentation === "tiers") {
      const tierOf = (q) => q.dmax <= 1 ? "Express" : q.dmax <= 3 ? "Standard" : "Economy";
      const best = {};
      priced.forEach((q) => { const t = tierOf(q); if (!best[t] || q.buyer < best[t].buyer) best[t] = { ...q, label: t + " Shipping" }; });
      out = ["Express", "Standard", "Economy"].map((t) => best[t]).filter(Boolean);
    }

    /* No delivery estimate is sent to buyers: this endpoint prices rates but does NOT pull FedEx's
       transit-times API, so any "arrives in N days" here would be a guess. Per policy we only ever
       surface FedEx-committed dates \u2014 so checkout shows the service + price only, never a guessed ETA. */
    const rates = out.map((q) => ({
      service_name: q.free ? "Free Shipping \u2014 " + q.label : q.label,
      service_code: (q.key || q.label).replace(/\W+/g, "_").toUpperCase(),
      total_price: String(Math.round(q.buyer * 100)),
      currency: "USD",
    }));

    console.log(`carrier-rates uid=${uid} items=${items.length} pieces=${pieces.length} source=${source} rates=${rates.length}`);
    return J(200, { rates });
  } catch (e) {
    // never break a checkout: an empty list lets Shopify fall back to the store's other rates
    return J(200, { rates: [] });
  }
};
