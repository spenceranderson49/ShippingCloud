/* ════════════════════════════════════════════════════════════════════════
   supplies-order.js — a customer submits a packaging-supplies order from the
   Packaging tab; this emails it to the account's supplies inbox so the team can
   fulfill / place the order. No external store — this IS the order.
     in:  { token, to, orderer, company, items:[{name,qty,price,cat,size}], note }
     out: { ok:true } | { ok:false, error }
   Session-gated (same signed token as the app). Sends via Resend (RESEND_API_KEY).
   ════════════════════════════════════════════════════════════════════════ */
const scCrypto = require("crypto");
const scSecret = () => { const s = (process.env.SESSION_SECRET || "").trim(); if (s) return s; const k = (process.env.SUPABASE_SERVICE_KEY || "").trim(); return k ? scCrypto.createHash("sha256").update("sc1|" + k).digest("hex") : ""; };
function scAuth(body) {
  const sec = scSecret();
  if (!sec) return { uid: "local", local: true };
  try {
    const [p, sig] = String((body && body.token) || "").split(".");
    if (!p || !sig) return null;
    const want = Buffer.from(scCrypto.createHmac("sha256", sec).update(p).digest("hex"), "hex");
    const got = Buffer.from(sig, "hex");
    if (want.length !== got.length || !scCrypto.timingSafeEqual(want, got)) return null;
    const d = JSON.parse(Buffer.from(String(p).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (!d || d.kind || !d.uid || !d.exp || Date.now() > d.exp) return null;
    return d;
  } catch (e) { return null; }
}
const hits = {};
function allow(k, max) { const w = Math.floor(Date.now() / 60000), kk = k + ":" + w; hits[kk] = (hits[kk] || 0) + 1; if (Object.keys(hits).length > 4000) { for (const x in hits) { if (!x.endsWith(":" + w)) delete hits[x]; } } return hits[kk] <= max; }
const esc = (s) => String(s == null ? "" : s).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const money = (n) => "$" + (Math.round((+n || 0) * 100) / 100).toFixed(2);

exports.handler = async (event) => {
  const respond = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  if (event.httpMethod === "OPTIONS") return respond(200, { ok: true });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return respond(200, { ok: false, error: "Bad request body" }); }
  const auth = scAuth(body);
  if (!auth) return respond(200, { ok: false, authFailed: true, error: "Sign in to submit an order." });
  if (!allow("sup:" + auth.uid, 20)) return respond(200, { ok: false, error: "Too many orders — give it a minute." });

  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) return respond(200, { ok: false, error: "Email isn't set up on this server yet (RESEND_API_KEY)." });

  const to = String(body.to || "").trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return respond(200, { ok: false, error: "No valid supplies inbox is configured — set one in the Packaging tab." });
  const items = Array.isArray(body.items) ? body.items.filter(i => i && i.name && (+i.qty > 0)) : [];
  if (!items.length) return respond(200, { ok: false, error: "Add a quantity to at least one item." });

  const orderer = String(body.orderer || auth.email || "a customer").slice(0, 160);
  const company = String(body.company || "").slice(0, 160);
  const note = String(body.note || "").slice(0, 1000);
  let total = 0;
  const rows = items.slice(0, 200).map(i => {
    const line = (+i.price || 0) * (+i.qty || 0); total += line;
    return `<tr><td style="padding:4px 10px;border-bottom:1px solid #eee">${esc(i.name)}${i.size ? ` <span style="color:#888">(${esc(i.size)})</span>` : ""}</td><td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:center">${esc(i.cat === "fedex" ? "FedEx" : "Supply")}</td><td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${+i.qty}</td><td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${(+i.price || 0) ? money(line) : "—"}</td></tr>`;
  }).join("");
  const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:640px">
    <h2 style="margin:0 0 4px">New packaging order</h2>
    <p style="color:#555;margin:0 0 14px">From <b>${esc(orderer)}</b>${company ? " · " + esc(company) : ""}</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead><tr style="text-align:left;color:#888;font-size:12px;text-transform:uppercase">
        <th style="padding:4px 10px">Item</th><th style="padding:4px 10px;text-align:center">Type</th><th style="padding:4px 10px;text-align:right">Qty</th><th style="padding:4px 10px;text-align:right">Est.</th>
      </tr></thead><tbody>${rows}</tbody>
      ${total > 0 ? `<tfoot><tr><td colspan="3" style="padding:6px 10px;text-align:right;font-weight:600">Estimated total</td><td style="padding:6px 10px;text-align:right;font-weight:600">${money(total)}</td></tr></tfoot>` : ""}
    </table>
    ${note ? `<p style="margin-top:14px"><b>Note:</b> ${esc(note)}</p>` : ""}
    <p style="color:#999;font-size:12px;margin-top:16px">Sent from the ShippingCloud Packaging tab.</p>
  </div>`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ from: (process.env.EMAIL_FROM || "ShippingCloud <notify@shippingcloud.net>").trim(), to: [to], reply_to: auth.email || undefined, subject: "Packaging order — " + orderer + (company ? " (" + company + ")" : ""), html }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return respond(200, { ok: false, error: "Couldn't send the order: " + ((d && d.message) || ("HTTP " + r.status)) });
    return respond(200, { ok: true });
  } catch (e) { return respond(200, { ok: false, error: "Couldn't send the order: " + ((e && e.message) || "network error") }); }
};
