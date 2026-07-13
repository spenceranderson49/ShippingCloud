/* track-sync.mjs — scheduled FedEx tracking sync (every 30 minutes).
   Makes shipment statuses LIVE: scans every account's shipments in Supabase,
   asks the FedEx Track API where each undelivered package is, and writes back
   updated statuses, last-scan locations, ETAs, and on-time grades.

   Prerequisites (all env vars already set except the portal step):
     FEDEX_API_KEY / FEDEX_SECRET_KEY  — FedEx developer credentials
     + the "Track API" product added to the project on developer.fedex.com
     SUPABASE_URL / SUPABASE_SERVICE_KEY

   Until Track API is enabled on the portal project, FedEx returns 401/403 and
   this function exits quietly — zero harm. The moment it's enabled, statuses
   start moving with no code change. Dashboard, live board, Shipments, and the
   Transit audit all compute from this data, so they go live together. */

import crypto from "node:crypto";
const ACTIVE = ["Label created", "In transit", "Out for delivery"];
const MAX_PER_RUN = 120;   // 4 Track calls of 30 — well inside the 30s scheduled budget
const BATCH = 30;          // FedEx Track API max tracking numbers per call

const supa = () => ({
  base: (process.env.SUPABASE_URL || "").replace(/\/+$/, ""),
  key: process.env.SUPABASE_SERVICE_KEY || "",
});

async function pgGet(path) {
  const { base, key } = supa();
  const r = await fetch(base + "/rest/v1/" + path, { headers: { apikey: key, Authorization: "Bearer " + key } });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}
async function pgUpsert(rows) {
  const { base, key } = supa();
  const r = await fetch(base + "/rest/v1/app_stores?on_conflict=tenant,key", {
    method: "POST",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  return r.ok;
}

async function fedexToken() {
  const id = (process.env.FEDEX_API_KEY || "").trim();
  const secret = (process.env.FEDEX_SECRET_KEY || "").trim();
  if (!id || !secret) return null;
  const base = (process.env.FEDEX_API_BASE || "https://apis.fedex.com").replace(/\/+$/, "");
  const r = await fetch(base + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  return (d && d.access_token) ? { token: d.access_token, base } : null;
}

async function fedexTrack(auth, trackings) {
  const r = await fetch(auth.base + "/track/v1/trackingnumbers", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + auth.token },
    body: JSON.stringify({ includeDetailedScans: false, trackingInfo: trackings.map((t) => ({ trackingNumberInfo: { trackingNumber: t } })) }),
  });
  if (!r.ok) return { ok: false, status: r.status };
  const d = await r.json().catch(() => null);
  return { ok: true, data: d };
}

/* FedEx derivedStatus / latestStatusDetail.code → ShippingCloud status */
function mapStatus(latest) {
  const code = String((latest && latest.code) || "").toUpperCase();
  const derived = String((latest && latest.derivedCode) || (latest && latest.derivedStatus) || "").toUpperCase();
  const t = code + " " + derived;
  if (/\bDL\b|DELIVERED/.test(t)) return "Delivered";
  if (/\bOD\b|OUT_FOR_DELIVERY|OUT FOR DELIVERY/.test(t)) return "Out for delivery";
  if (/\bDE\b|\bSE\b|EXCEPTION|DELAY/.test(t)) return "Exception";
  if (/\bIT\b|\bDP\b|\bAR\b|\bPU\b|\bOC\b|IN_TRANSIT|PICKED_UP|ARRIVED|DEPARTED/.test(t)) return "In transit";
  return null;
}

function pickResult(data) {
  // → map of trackingNumber → {status,lastScan,actualDate,estDate}
  const out = {};
  const results = (data && data.output && data.output.completeTrackResults) || [];
  for (const res of results) {
    const tn = res.trackingNumber;
    const tr = (res.trackResults || [])[0];
    if (!tn || !tr) continue;
    const latest = tr.latestStatusDetail || {};
    const status = mapStatus(latest);
    const loc = latest.scanLocation || {};
    const lastScan = [latest.description, [loc.city, loc.stateOrProvinceCode].filter(Boolean).join(", ")].filter(Boolean).join(" \u2014 ");
    let actualDate = null, estDate = null;
    for (const dt of (tr.dateAndTimes || [])) {
      if (dt.type === "ACTUAL_DELIVERY") actualDate = dt.dateTime;
      if (dt.type === "ESTIMATED_DELIVERY" || dt.type === "COMMITMENT") estDate = dt.dateTime;
    }
    const w = tr.estimatedDeliveryTimeWindow && tr.estimatedDeliveryTimeWindow.window;
    if (!estDate && w && w.ends) estDate = w.ends;
    out[String(tn).replace(/\s+/g, "").toUpperCase()] = { status, lastScan: lastScan || null, actualDate, estDate };
  }
  return out;
}

export default async () => {
  const { base, key } = supa();
  if (!base || !key) { console.log("track-sync: supabase env missing"); return; }

  const rows = await pgGet("app_stores?tenant=eq.main&key=like.u/*/shipments&select=key,value");
  if (!Array.isArray(rows) || !rows.length) { console.log("track-sync: no shipment stores"); return; }

  // collect undelivered FedEx trackings across accounts, capped per run
  const jobs = []; // {rowIdx, shipIdx, tracking}
  rows.forEach((row, ri) => {
    const list = Array.isArray(row.value) ? row.value : [];
    list.forEach((s, si) => {
      if (jobs.length >= MAX_PER_RUN) return;
      if (s && s.carrier === "FedEx" && s.tracking && ACTIVE.includes(s.status)) {
        jobs.push({ ri, si, tracking: String(s.tracking).replace(/\s+/g, "") });
      }
    });
  });
  if (!jobs.length) { console.log("track-sync: nothing in motion"); return; }

  const auth = await fedexToken();
  if (!auth) { console.log("track-sync: FedEx auth unavailable (creds missing or Track API not yet enabled)"); return; }

  const updates = {}; // normalized tracking → result
  for (let i = 0; i < jobs.length; i += BATCH) {
    const chunk = jobs.slice(i, i + BATCH).map((j) => j.tracking);
    const res = await fedexTrack(auth, chunk);
    if (!res.ok) {
      console.log("track-sync: Track API HTTP " + res.status + (res.status === 401 || res.status === 403 ? " \u2014 add the Track API product to the FedEx portal project" : ""));
      if (res.status === 401 || res.status === 403) return; // no point retrying more chunks
      continue;
    }
    Object.assign(updates, pickResult(res.data));
  }
  if (!Object.keys(updates).length) { console.log("track-sync: no updates from FedEx"); return; }

  // apply to rows, write back only changed stores
  const changed = [];
  const touched = new Set(jobs.map((j) => j.ri));
  for (const ri of touched) {
    const row = rows[ri];
    let dirty = false;
    const list = (Array.isArray(row.value) ? row.value : []).map((s) => {
      if (!s || s.carrier !== "FedEx" || !s.tracking) return s;
      const u = updates[String(s.tracking).replace(/\s+/g, "").toUpperCase()];
      if (!u) return s;
      const next = { ...s };
      if (u.status && u.status !== s.status) { next.status = u.status; dirty = true; }
      if (u.lastScan && u.lastScan !== s.lastScan) { next.lastScan = u.lastScan; dirty = true; }
      if (u.estDate) { const d = new Date(u.estDate); if (!isNaN(d)) { const eta = d.toLocaleDateString(); if (eta !== s.eta) { next.eta = eta; dirty = true; } } }
      if (u.status === "Delivered") {
        const act = u.actualDate ? new Date(u.actualDate) : new Date();
        const est = u.estDate ? new Date(u.estDate) : null;
        const onTime = est ? act.getTime() <= est.getTime() + 3600 * 1000 : (s.onTime !== false);
        if (next.onTime !== onTime) { next.onTime = onTime; dirty = true; }
        if (!next.deliveredAt) { next.deliveredAt = act.toLocaleDateString(); dirty = true; }
      }
      return next;
    });
    if (dirty) changed.push({ tenant: "main", key: row.key, value: list });
  }

  /* collect status changes on API accounts (key = u/api_<clientId>/shipments) to push webhooks */
  const apiEvents = [];
  for (const ri of touched) {
    const key = rows[ri] && rows[ri].key;
    const m = /^u\/(api_[^/]+)\/shipments$/.exec(String(key || ""));
    if (!m) continue;
    const before = new Map((Array.isArray(rows[ri].value) ? rows[ri].value : []).map((s) => [String(s && s.tracking), s && s.status]));
    const after = (changed.find((c) => c.key === key) || {}).value;
    if (!after) continue;
    for (const s of after) {
      if (s && s.tracking && before.get(String(s.tracking)) !== s.status) apiEvents.push({ apiUid: m[1], tracking: s.tracking, status: s.status, ref: s.reference || null });
    }
  }

  if (changed.length) {
    const ok = await pgUpsert(changed);
    console.log(`track-sync: checked ${jobs.length}, updated ${changed.length} account store(s), write ${ok ? "ok" : "FAILED"}`);
  } else {
    console.log(`track-sync: checked ${jobs.length}, no changes`);
  }

  /* fire tracking.updated webhooks (signed) for API accounts whose shipment status moved */
  for (const ev of apiEvents.slice(0, 200)) {
    try {
      const hr = await pgGet("app_stores?tenant=eq.main&key=eq." + encodeURIComponent("u/" + ev.apiUid + "/webhooks") + "&select=value");
      const hooks = ((hr && hr[0] && hr[0].value) || []).filter((h) => h && !h.disabled && (!h.events || h.events.includes("tracking.updated")));
      if (!hooks.length) continue;
      const body = JSON.stringify({ event: "tracking.updated", created: new Date().toISOString(), data: { tracking_number: ev.tracking, status: ev.status, reference: ev.ref } });
      for (const h of hooks.slice(0, 5)) {
        try {
          const host = (() => { try { return new URL(h.url).hostname; } catch (e) { return ""; } })();
          if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /\.local$/.test(host)) continue;   // no internal targets
          const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
          await fetch(h.url, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", "X-SC-Event": "tracking.updated", "X-SC-Signature": crypto.createHmac("sha256", String(h.secret || "")).update(body).digest("hex") }, body, signal: ctrl.signal });
          clearTimeout(t);
        } catch (e) {}
      }
    } catch (e) {}
  }
};

export const config = { schedule: "*/30 * * * *" };
