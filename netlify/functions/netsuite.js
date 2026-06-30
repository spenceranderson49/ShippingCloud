/* ════════════════════════════════════════════════════════════════════════
   NetSuite (SuiteTalk REST)  ⇄  ShippingCloud
   Auth: Token-Based Auth (TBA) via OAuth 1.0a signing. In NetSuite, enable
   SuiteTalk REST + TBA, create an Integration (consumer key/secret) and an
   Access Token (token id/secret). App passes:
     { accountId, consumerKey, consumerSecret, tokenId, tokenSecret }
   accountId example: "1234567" or "1234567_SB1" (sandbox). REST host derives
   from it: https://<accountIdLower-with-_to->.suitetalk.api.netsuite.com
     POST { action:"query", ...creds, q }     → run a SuiteQL query
     POST { action:"create", ...creds, record, body }  → create a record
   ════════════════════════════════════════════════════════════════════════ */
const crypto = require("crypto");
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));

const enc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
function restHost(accountId) { return "https://" + String(accountId).toLowerCase().replace(/_/g, "-") + ".suitetalk.api.netsuite.com"; }

function oauthHeader(c, method, url) {
  const oauth = {
    oauth_consumer_key: c.consumerKey, oauth_token: c.tokenId, oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(), oauth_nonce: crypto.randomBytes(16).toString("hex"), oauth_version: "1.0",
  };
  const u = new URL(url);
  const params = {};
  u.searchParams.forEach((v, k) => { params[k] = v; });
  Object.assign(params, oauth);
  const baseStr = [method.toUpperCase(), enc(u.origin + u.pathname), enc(Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join("&"))].join("&");
  const signingKey = enc(c.consumerSecret) + "&" + enc(c.tokenSecret);
  const sig = crypto.createHmac("sha256", signingKey).update(baseStr).digest("base64");
  oauth.oauth_signature = sig;
  const realm = String(c.accountId).toUpperCase().replace(/-/g, "_");
  const header = "OAuth realm=\"" + realm + "\"," + Object.keys(oauth).map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(",");
  return header;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return J({ ok: false, error: "Use POST" });
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); }
    const c = { accountId: S(b.accountId).trim(), consumerKey: S(b.consumerKey).trim(), consumerSecret: S(b.consumerSecret).trim(), tokenId: S(b.tokenId).trim(), tokenSecret: S(b.tokenSecret).trim() };
    for (const k of ["accountId", "consumerKey", "consumerSecret", "tokenId", "tokenSecret"]) if (!c[k]) return J({ ok: false, error: "Missing " + k });
    const host = restHost(c.accountId);

    if (b.action === "create") {
      const url = host + "/services/rest/record/v1/" + encodeURIComponent(S(b.record) || "salesOrder");
      const r = await fetch(url, { method: "POST", headers: { "Authorization": oauthHeader(c, "POST", url), "Content-Type": "application/json", "prefer": "transient" }, body: JSON.stringify(b.body || {}) });
      const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
      if (!r.ok) return J({ ok: false, error: "NetSuite create HTTP " + r.status + (t ? ": " + t.slice(0, 250) : "") });
      return J({ ok: true, id: (d && d.id) || (r.headers.get("location") || "").split("/").pop() });
    }

    // default: SuiteQL query
    const url = host + "/services/rest/query/v1/suiteql?limit=50";
    const r = await fetch(url, { method: "POST", headers: { "Authorization": oauthHeader(c, "POST", url), "Content-Type": "application/json", "prefer": "transient" }, body: JSON.stringify({ q: S(b.q) || "SELECT id, tranid, entity FROM transaction WHERE type='SalesOrd' AND status='SalesOrd:B'" }) });
    const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch {}
    if (r.status === 401) return J({ ok: false, error: "NetSuite auth failed (401) — check the TBA token/consumer keys + account id." });
    if (!r.ok) return J({ ok: false, error: "NetSuite HTTP " + r.status + (t ? ": " + t.slice(0, 250) : "") });
    return J({ ok: true, count: (d && d.items && d.items.length) || 0, items: (d && d.items) || [] });
  } catch (e) { return J({ ok: false, error: "Function error: " + (e && e.message ? e.message : String(e)) }); }
};
