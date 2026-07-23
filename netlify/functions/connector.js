/* ════════════════════════════════════════════════════════════════════════
   POST /.netlify/functions/connector — the ShippingHub side of the on-prem
   Full Circle ODBC connector (see the Lagence-Rust-Connector repo).

   Two callers, two auth models:
     • THE CONNECTOR (Rust agent on L'AGENCE's box) — sends header  x-fw-key: <FW_CONNECTOR_KEY>.
         hello / heartbeat  → report it's online
         pullQueue          → get + clear the scanned pick-tickets waiting to be pulled
         order              → hand back an order it read from Full Circle over ODBC
         confirmations      → get the ship-confirmation rows to drop on the Z: drive
         confirmed          → ack the rows it wrote (so we stop handing them back)
     • THE APP (browser) — sends a normal signed session token (body.token).
         enqueuePull        → a pick-ticket was scanned; queue it for the connector
         getOrder           → fetch the order the connector pulled for that key
         pushConfirm        → a label was booked; queue its fedxucc.csv row(s) for the drop
         connStatus         → is the connector online? (admin health, no login into the box)

   State lives in Supabase `app_stores` (same KV the app uses). Always HTTP 200 JSON.
   Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SECRET (optional), FW_CONNECTOR_KEY.
   ════════════════════════════════════════════════════════════════════════ */
const crypto = require("crypto");
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const CFG = () => ({ url: (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, ""), key: (process.env.SUPABASE_SERVICE_KEY || "").trim() });
const TENANT = (process.env.DB_TENANT || "main").trim() || "main";
const enc = encodeURIComponent;

/* ── Supabase KV (same pattern as db.js) ── */
async function pg(path, opts = {}) {
  const c = CFG();
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(c.url + "/rest/v1/" + path, { ...opts, headers: { apikey: c.key, Authorization: "Bearer " + c.key, "Content-Type": "application/json", ...(opts.headers || {}) }, signal: ctrl.signal });
    const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
    return { ok: r.ok, status: r.status, data };
  } catch (e) { return { ok: false, status: 0, text: (e && e.message) || "network" }; }
  finally { clearTimeout(t); }
}
const getStore = async (key) => { const r = await pg("app_stores?tenant=eq." + enc(TENANT) + "&key=eq." + enc(key) + "&select=value"); return r.ok ? (Array.isArray(r.data) && r.data[0] ? r.data[0].value : undefined) : undefined; };
const putStore = async (key, value) => pg("app_stores?on_conflict=tenant,key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ tenant: TENANT, key, value, updated_at: new Date().toISOString() }]) });

/* ── connector key (constant-time) ── */
function connKeyOk(event) {
  const h = event.headers || {};
  const got = String(h["x-fw-key"] || h["X-Fw-Key"] || h["X-FW-KEY"] || "");
  const want = (process.env.FW_CONNECTOR_KEY || "").trim();
  if (!want || !got || got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch { return false; }
}

/* ── app session token (same as the other gated functions) ── */
const scSecret = () => { const s = (process.env.SESSION_SECRET || "").trim(); if (s) return s; const k = (process.env.SUPABASE_SERVICE_KEY || "").trim(); return k ? crypto.createHash("sha256").update("sc1|" + k).digest("hex") : ""; };
function scAuth(body) {
  const sec = scSecret(); if (!sec) return { uid: "local", local: true };
  try {
    const [p, sig] = String((body && body.token) || "").split(".");
    if (!p || !sig) return null;
    const want = Buffer.from(crypto.createHmac("sha256", sec).update(p).digest("hex"), "hex");
    const got = Buffer.from(sig, "hex");
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const d = JSON.parse(Buffer.from(String(p).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (!d || d.kind || !d.uid || !d.exp || Date.now() > d.exp) return null;
    return d;
  } catch { return null; }
}

const K = {
  status: "conn:status",
  pull: "conn:pull",
  confirm: "conn:confirm",
  order: (k) => "conn:order:" + String(k).replace(/[^\w.\-]/g, "_").slice(0, 60),
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return J({ ok: true });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "bad body" }); }
  const action = String(body.action || "");
  if (!CFG().url || !CFG().key) return J({ ok: false, error: "Server storage isn't configured (SUPABASE_URL / SERVICE_KEY)." });

  /* ── connector-side (x-fw-key) ── */
  const CONN = ["hello", "heartbeat", "pullQueue", "order", "confirmations", "confirmed"];
  if (CONN.includes(action)) {
    if (!connKeyOk(event)) return J({ ok: false, error: "Bad or missing connector key." });

    if (action === "hello" || action === "heartbeat") {
      const prev = (await getStore(K.status)) || {};
      await putStore(K.status, { online: true, lastSeen: Date.now(), table: body.table || prev.table, drop: body.drop || prev.drop });
      return J({ ok: true });
    }
    if (action === "pullQueue") {
      const q = await getStore(K.pull); const keys = Array.isArray(q) ? q : [];
      if (keys.length) await putStore(K.pull, []);
      return J({ ok: true, keys });
    }
    if (action === "order") {
      const key = String(body.key || ""); if (!key) return J({ ok: false, error: "no key" });
      await putStore(K.order(key), { order: body.order || null, at: Date.now() });
      return J({ ok: true });
    }
    if (action === "confirmations") {
      const doc = (await getStore(K.confirm)) || { header: "", rows: [] };
      const rows = Array.isArray(doc.rows) ? doc.rows : [];
      if (!rows.length) return J({ ok: true, csv: "", ids: [] });
      const csv = (doc.header ? doc.header + "\r\n" : "") + rows.map((r) => r.line).join("\r\n") + "\r\n";
      return J({ ok: true, csv, ids: rows.map((r) => r.id) });
    }
    if (action === "confirmed") {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String);
      const doc = (await getStore(K.confirm)) || { header: "", rows: [] };
      const rows = (Array.isArray(doc.rows) ? doc.rows : []).filter((r) => !ids.includes(String(r.id)));
      await putStore(K.confirm, { header: doc.header || "", rows });
      return J({ ok: true, remaining: rows.length });
    }
  }

  /* ── app-side (session token) ── */
  const auth = scAuth(body);
  if (!auth) return J({ ok: false, authFailed: true, error: "Sign in." });

  if (action === "connStatus") {
    const st = (await getStore(K.status)) || null;
    const online = !!(st && st.lastSeen && Date.now() - st.lastSeen < 60000);
    return J({ ok: true, status: st, online });
  }
  if (action === "enqueuePull") {
    const key = String(body.key || "").trim(); if (!key) return J({ ok: false, error: "no key" });
    const q = (await getStore(K.pull)) || []; const arr = Array.isArray(q) ? q : [];
    if (!arr.includes(key)) arr.push(key);
    await putStore(K.pull, arr.slice(-200));
    return J({ ok: true });
  }
  if (action === "getOrder") {
    const d = await getStore(K.order(String(body.key || "")));
    return J({ ok: true, order: (d && d.order) || null, at: (d && d.at) || null });
  }
  if (action === "pushConfirm") {
    const rows = (Array.isArray(body.rows) ? body.rows : []).filter((r) => r && r.line).map((r) => ({ id: String(r.id || Date.now()), line: String(r.line) }));
    if (!rows.length) return J({ ok: false, error: "no rows" });
    const doc = (await getStore(K.confirm)) || { header: "", rows: [] };
    const existing = Array.isArray(doc.rows) ? doc.rows : [];
    const seen = new Set(existing.map((r) => r.id));
    const merged = existing.concat(rows.filter((r) => !seen.has(r.id)));
    await putStore(K.confirm, { header: String(body.header || doc.header || ""), rows: merged.slice(-1000) });
    return J({ ok: true, pending: merged.length });
  }

  return J({ ok: false, error: "Unknown action: " + action });
};
