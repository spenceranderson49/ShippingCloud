/* email.js — sends real email through Resend (resend.com).
   Token-gated relay: only signed-in ShippingCloud sessions can send, so this can
   never become an open relay. Until RESEND_API_KEY is set in Netlify env vars,
   it answers { ok:true, sent:false, configured:false } and the app keeps logging
   emails exactly as before — zero breakage, flips live with one env var + redeploy.

   Env: RESEND_API_KEY (required to actually send)
        EMAIL_FROM     (optional, default "ShippingCloud <notify@shippingcloud.net>"
                        — the domain must be verified in the Resend dashboard)
        SESSION_SECRET (shared with db.js for token verification) */

const crypto = require("crypto");
const J = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

/* mirror of db.js token verification */
function verifyToken(token) {
  try {
    const [p, sig] = String(token || "").split(".");
    if (!p || !sig) return null;
    const _sec = (process.env.SESSION_SECRET || "").trim() || ((process.env.SUPABASE_SERVICE_KEY || "").trim() ? crypto.createHash("sha256").update("sc1|" + (process.env.SUPABASE_SERVICE_KEY || "").trim()).digest("hex") : "");
    const want = Buffer.from(crypto.createHmac("sha256", _sec).update(p).digest("hex"), "hex");
    const got = Buffer.from(sig, "hex");
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const data = JSON.parse(Buffer.from(String(p).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (!data || data.kind || !data.uid || !data.exp || Date.now() > data.exp) return null;
    return data;
  } catch (e) { return null; }
}

const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function shippedHtml(p) {
  const track = esc(p.tracking || "");
  const url = p.trackUrl ? esc(p.trackUrl) : (track ? "https://www.fedex.com/fedextrack/?trknbr=" + track : "");
  return `<!doctype html><body style="margin:0;background:#fafaf9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917;">
  <div style="max-width:520px;margin:0 auto;padding:28px 20px;">
    <div style="font-size:22px;font-weight:800;color:#0c4a6e;">${p.brand?esc(p.brand):'Shipping<span style="color:#0086E0;">Cloud</span>'}</div>
    <div style="background:#fff;border:1px solid #e7e5e4;border-radius:14px;padding:22px;margin-top:14px;">
      <div style="font-size:17px;font-weight:700;">${esc(p.title || "Your order is on the way")}</div>
      ${p.line ? `<p style="font-size:14px;color:#57534e;margin:10px 0 0;">${esc(p.line)}</p>` : ""}
      ${track ? `<p style="font-size:13px;color:#78716c;margin:14px 0 4px;">Tracking number</p>
      <div style="font-family:monospace;font-size:15px;">${track}</div>` : ""}
      ${url ? `<a href="${url}" style="display:inline-block;margin-top:16px;background:#0086E0;color:#fff;text-decoration:none;font-weight:600;border-radius:8px;padding:10px 18px;font-size:14px;">Track your package</a>` : ""}
      ${p.service ? `<p style="font-size:12px;color:#a8a29e;margin:16px 0 0;">${esc(p.service)}${p.eta ? " \u00b7 estimated delivery " + esc(p.eta) : ""}</p>` : ""}
    </div>
    <p style="font-size:11px;color:#a8a29e;margin-top:14px;">${esc(p.footer || "Sent by "+(p.brand||"ShippingCloud")+" on behalf of the sender.")}</p>
  </div></body>`;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return J(405, { ok: false, error: "POST only" });
    let body = null; try { body = JSON.parse(event.body || "{}"); } catch {}
    if (!body) return J(400, { ok: false, error: "Bad JSON" });

    const auth = verifyToken(body.token);
    if (!auth) return J(200, { ok: false, authFailed: true, error: "Sign in to send email." });

    const key = (process.env.RESEND_API_KEY || "").trim();
    if (!key) return J(200, { ok: true, sent: false, configured: false, note: "Set RESEND_API_KEY in Netlify env vars (then redeploy) to send for real." });

    const to = String(body.to || "").trim();
    if (!/.+@.+\..+/.test(to)) return J(200, { ok: false, error: "Valid recipient email required." });
    const subject = String(body.subject || "Update on your shipment").slice(0, 200);
    const from = (process.env.EMAIL_FROM || "ShippingCloud <notify@shippingcloud.net>").trim();
    const html = body.html ? String(body.html).slice(0, 100000) : shippedHtml(body.template || {});

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) return J(200, { ok: false, error: "Resend " + r.status + ": " + JSON.stringify((d && (d.message || d.error)) || d).slice(0, 200) });
    return J(200, { ok: true, sent: true, id: d && d.id });
  } catch (e) {
    return J(200, { ok: false, error: "Email function error: " + (e.message || String(e)) });
  }
};
