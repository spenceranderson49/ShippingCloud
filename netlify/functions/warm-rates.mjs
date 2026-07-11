/* ════════════════════════════════════════════════════════════════════════
   warm-rates — scheduled auto-warmer for the rate cache (runs every 20 min)
   ------------------------------------------------------------------------
   Reads the lanes recorded by quote.js (your real shipping patterns), finds
   the ones whose cached price is missing, aging past REFRESH_AGE, or was
   invalidated by the "Refresh rates" button, and re-quotes them against
   England BY CALLING THE REAL quote.js HANDLER — so a warmed price goes
   through the exact same code path as a user quote. Result: your frequent
   lanes are permanently instant AND never older than ~REFRESH_AGE.

   Requires Netlify env vars ENGLAND_API_KEY + ENGLAND_CUSTOMER_ID (already
   set on this site). No netlify.toml entry needed — schedule is in-code.
   Safe by design: every step is best-effort; a failed run changes nothing
   except that the next user quote on that lane is a normal live call.
   ════════════════════════════════════════════════════════════════════════ */
import quoteFn from "./quote.js";
import crypto from "node:crypto";
/* internal auth for the quote.js handler — it is session-gated now (audit F1) */
const scSecret = () => { const s = (process.env.SESSION_SECRET || "").trim(); if (s) return s; const k = (process.env.SUPABASE_SERVICE_KEY || "").trim(); return k ? crypto.createHash("sha256").update("sc1|" + k).digest("hex") : ""; };
const scInternalKey = () => { const s = scSecret(); return s ? crypto.createHmac("sha256", s).update("internal:carrier").digest("hex") : ""; };

const CACHE_STORE = "rate-cache";
const CACHE_VERSION = "v1";                      // must match quote.js
const REFRESH_AGE_MS = 100 * 60 * 1000;          // re-quote lanes older than 100 min → nothing warm ever exceeds ~2h
const LANE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000; // lanes unused for 14 days get pruned
const MAX_REFRESH_PER_RUN = 12;                  // stay inside the function time limit
const PARALLEL = 4;                              // gentle on England
const TIME_BUDGET_MS = 7500;                     // hard stop before Netlify's timeout
const MAX_CONSECUTIVE_FAILURES = 3;              // if England is down, back off — don't hammer

function blobsCtx() {
  try {
    const raw = process.env.NETLIFY_BLOBS_CONTEXT;
    if (!raw) return null;
    const ctx = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    if (!ctx || !ctx.token || !ctx.siteID || !(ctx.edgeURL || ctx.apiURL)) return null;
    return ctx;
  } catch { return null; }
}
function storeUrl(ctx, key, params) {
  const path = "/" + ctx.siteID + "/" + CACHE_STORE + (key ? "/" + encodeURIComponent(key) : "");
  const u = ctx.edgeURL ? new URL(path, ctx.edgeURL) : new URL("/api/v1/blobs" + path, ctx.apiURL || "https://api.netlify.com");
  for (const k in (params || {})) u.searchParams.set(k, params[k]);
  return u.toString();
}
async function bfetch(ctx, key, opts, params) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 3000);
  try { return await fetch(storeUrl(ctx, key, params), { ...opts, headers: { authorization: "Bearer " + ctx.token, ...(opts && opts.headers) }, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
async function listLaneKeys(ctx) {
  const keys = []; let cursor = null;
  for (let page = 0; page < 10; page++) {                    // hard cap: 10 pages
    const params = { prefix: "lane_" }; if (cursor) params.cursor = cursor;
    const r = await bfetch(ctx, null, {}, params);
    if (!r || !r.ok) break;
    const j = await r.json().catch(() => null);
    if (!j || !Array.isArray(j.blobs)) break;
    for (const b of j.blobs) if (b && b.key) keys.push(b.key);
    if (!j.next_cursor || keys.length >= 500) break;
    cursor = j.next_cursor;
  }
  return keys;
}
async function getJson(ctx, key) {
  try { const r = await bfetch(ctx, key); if (!r || !r.ok) return null; return await r.json(); } catch { return null; }
}
async function mapLimit(items, limit, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

export default async () => {
  const started = Date.now();
  const status = { ts: started, lanesTracked: 0, checked: 0, refreshed: 0, failed: 0, pruned: 0, skipped: "" };
  const done = (extra) => new Response(JSON.stringify({ ...status, ...extra, ms: Date.now() - started }), { headers: { "Content-Type": "application/json" } });

  const ctx = blobsCtx();
  if (!ctx) { status.skipped = "Netlify Blobs unavailable"; return done(); }
  if (!(process.env.ENGLAND_API_KEY || "").trim() || !(process.env.ENGLAND_CUSTOMER_ID || "").trim()) {
    status.skipped = "ENGLAND_API_KEY / ENGLAND_CUSTOMER_ID env vars not set — warmer needs them to quote";
    await bfetch(ctx, "warm_status", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(status) }).catch(() => {});
    return done();
  }

  // 1) Load every tracked lane
  const laneKeys = await listLaneKeys(ctx);
  status.lanesTracked = laneKeys.length;
  const lanes = await mapLimit(laneKeys, 8, async (k) => ({ key: k, data: await getJson(ctx, k) }));

  // 2) Prune stale lanes; read flush markers per customer once
  const now = Date.now();
  const flushTs = {};
  const live = [];
  for (const l of lanes) {
    if (!l.data || !l.data.body || !l.data.lastUsed) continue;
    if (now - l.data.lastUsed > LANE_RETENTION_MS) {
      await bfetch(ctx, l.key, { method: "DELETE" }).catch(() => {});
      status.pruned++; continue;
    }
    live.push(l);
  }
  for (const l of live) {
    const cid = String((l.data.body.account && l.data.body.account.customerId) || "");
    if (!(cid in flushTs)) {
      const m = await getJson(ctx, "flush_" + CACHE_VERSION + "_" + cid);
      flushTs[cid] = (m && m.ts) || 0;
    }
  }

  // 3) Decide which lanes need re-quoting: cache entry missing, aging, or flushed.
  //    Multi-account: the main account warms with the env API key. To ALSO warm client
  //    accounts, set Netlify env var ENGLAND_ACCOUNTS to a JSON map of customerId→apiKey,
  //    e.g. {"20605511":"key-for-that-client","20605512":"another-key"}. Lanes for
  //    accounts with no known key are skipped cleanly (still cached-on-use + Refresh button).
  const envCustomerId = String(process.env.ENGLAND_CUSTOMER_ID || "").trim();
  const keyMap = {};
  try {
    const parsed = JSON.parse(process.env.ENGLAND_ACCOUNTS || "{}");
    if (Array.isArray(parsed)) { for (const a of parsed) if (a && a.customerId && a.apiKey) keyMap[String(a.customerId)] = String(a.apiKey); }
    else if (parsed && typeof parsed === "object") { for (const k in parsed) if (parsed[k]) keyMap[String(k)] = String(parsed[k]); }
  } catch { status.accountsEnvError = "ENGLAND_ACCOUNTS env var is not valid JSON — only the main account is being warmed"; }
  const candidates = [];
  await mapLimit(live, 8, async (l) => {
    const cid = String((l.data.body.account && l.data.body.account.customerId) || "");
    const isMain = !cid || cid === envCustomerId;
    if (!isMain && !keyMap[cid]) { status.foreignSkipped = (status.foreignSkipped || 0) + 1; return; }
    const cacheKey = l.key.slice("lane_".length);
    const entry = await getJson(ctx, cacheKey);
    status.checked++;
    const entryTs = (entry && entry.ts) || 0;
    const needs = !entry || (now - entryTs > REFRESH_AGE_MS) || (entryTs <= flushTs[cid]);
    if (needs) candidates.push({ ...l, entryTs, count: l.data.count || 0, apiKey: isMain ? null : keyMap[cid] });
  });
  // oldest cache first; heavier-used lanes win ties
  candidates.sort((a, b) => (a.entryTs - b.entryTs) || (b.count - a.count));
  const batch = candidates.slice(0, MAX_REFRESH_PER_RUN);

  // 4) Re-quote through the REAL quote.js handler (identical pricing path)
  let consecutiveFailures = 0;
  await mapLimit(batch, PARALLEL, async (l) => {
    if (Date.now() - started > TIME_BUDGET_MS) return;                 // stay inside the time limit
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;       // England down → back off
    try {
      const warmBody = { ...l.data.body, noCache: true, _warm: true, internalKey: scInternalKey() };
      if (l.apiKey) warmBody.account = { ...(warmBody.account || {}), apiKey: l.apiKey };
      const res = await quoteFn.handler({ httpMethod: "POST", body: JSON.stringify(warmBody) });
      const out = JSON.parse((res && res.body) || "{}");
      if (out && out.live && Array.isArray(out.rates) && out.rates.length) { status.refreshed++; consecutiveFailures = 0; }
      else { status.failed++; consecutiveFailures++; }
    } catch { status.failed++; consecutiveFailures++; }
  });

  // 5) Leave a status note (admin-visible later if wanted)
  await bfetch(ctx, "warm_status", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(status) }).catch(() => {});
  return done();
};

export const config = { schedule: "*/20 * * * *" };
