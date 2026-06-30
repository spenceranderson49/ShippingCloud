/* ════════════════════════════════════════════════════════════════════════
   QuickBooks DESKTOP  ⇄  ShippingCloud   (via QuickBooks Web Connector / qbXML)
   ------------------------------------------------------------------------
   QB Desktop has no cloud REST API. The supported path is the QuickBooks Web
   Connector (QBWC): a small app that runs next to QuickBooks on the PC and
   POLLS a SOAP web service (this function) on a schedule. We hand it qbXML
   requests (e.g. InvoiceAddRq); it runs them against the open company file and
   posts back the qbXML response.

   SETUP
   1) Set env vars in Netlify: QBWC_USER, QBWC_PASS  (the QBWC login).
   2) Give the .qwc file below to QuickBooks Web Connector (File → Add an App).
      GET /.netlify/functions/quickbooks-desktop?qwc=1  returns a ready .qwc.
   3) Queue work from the app:
      POST { action:"enqueueInvoice", customer, amount, description }  → queued
      The next time QBWC runs, the invoice is created in QuickBooks Desktop.

   QUEUE STORAGE: uses Netlify Blobs when available (correct for production),
   with an in-memory fallback for quick tests. For reliable queuing keep Blobs on.
   ════════════════════════════════════════════════════════════════════════ */
const crypto = require("crypto");
const TEXT = (s) => ({ statusCode: 200, headers: { "Content-Type": "text/xml; charset=utf-8" }, body: s });
const J = (o) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
const S = (v) => (v == null ? "" : String(v));
const esc = (s) => S(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let MEM = []; // in-memory fallback queue of qbXML strings

async function store() {
  try { const m = await import("@netlify/blobs"); return m.getStore("qbwc-queue"); } catch { return null; }
}
async function enqueue(xml) {
  const st = await store();
  if (st) { const cur = JSON.parse((await st.get("pending")) || "[]"); cur.push(xml); await st.set("pending", JSON.stringify(cur)); return; }
  MEM.push(xml);
}
async function dequeue() {
  const st = await store();
  if (st) { const cur = JSON.parse((await st.get("pending")) || "[]"); const next = cur.shift() || null; await st.set("pending", JSON.stringify(cur)); return next; }
  return MEM.shift() || null;
}

function invoiceQbxml(o) {
  return `<?xml version="1.0" encoding="utf-8"?><?qbxml version="13.0"?><QBXML><QBXMLMsgsRq onError="stopOnError"><InvoiceAddRq><InvoiceAdd><CustomerRef><FullName>${esc(o.customer || "ShippingCloud Customer")}</FullName></CustomerRef><InvoiceLineAdd><Desc>${esc(o.description || "Shipping")}</Desc><Amount>${(Number(o.amount) || 0).toFixed(2)}</Amount></InvoiceLineAdd></InvoiceAdd></InvoiceAddRq></QBXMLMsgsRq></QBXML>`;
}

const xmlGet = (body, tag) => { const m = body.match(new RegExp("<(?:[a-zA-Z0-9]+:)?" + tag + ">([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?" + tag + ">")); return m ? m[1] : ""; };
const soap = (inner) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body>${inner}</soap:Body></soap:Envelope>`;

exports.handler = async (event) => {
  const self = "https://" + event.headers.host + "/.netlify/functions/quickbooks-desktop";

  // ── serve the .qwc config file ──
  if (event.httpMethod === "GET" && (event.queryStringParameters || {}).qwc) {
    const id = crypto.randomUUID(), owner = crypto.randomUUID();
    const qwc = `<?xml version="1.0"?><QBWCXML><AppName>ShippingCloud</AppName><AppID></AppID><AppURL>${self}</AppURL><AppDescription>ShippingCloud → QuickBooks Desktop</AppDescription><AppSupport>${self.replace(/\/[^/]*$/, "")}</AppSupport><UserName>${esc(process.env.QBWC_USER || "shippingcloud")}</UserName><OwnerID>{${owner}}</OwnerID><FileID>{${id}}</FileID><QBType>QBFS</QBType><Scheduler><RunEveryNMinutes>5</RunEveryNMinutes></Scheduler></QBWCXML>`;
    return { statusCode: 200, headers: { "Content-Type": "application/xml", "Content-Disposition": "attachment; filename=shippingcloud.qwc" }, body: qwc };
  }

  // ── JSON control API (queue work / check) ──
  if (event.httpMethod === "POST" && (event.headers["content-type"] || "").includes("application/json")) {
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return J({ ok: false, error: "Bad JSON" }); }
    if (b.action === "enqueueInvoice") { await enqueue(invoiceQbxml(b)); return J({ ok: true, queued: true }); }
    if (b.action === "enqueueRaw" && b.qbxml) { await enqueue(S(b.qbxml)); return J({ ok: true, queued: true }); }
    return J({ ok: false, error: "Unknown action" });
  }

  // ── QBWC SOAP endpoint ──
  const body = event.body || "";
  const reply = (name, payload) => TEXT(soap(`<${name}Response xmlns="http://developer.intuit.com/"><${name}Result>${payload}</${name}Result></${name}Response>`));

  if (body.includes("serverVersion")) return reply("serverVersion", "1.0");
  if (body.includes("clientVersion")) return reply("clientVersion", ""); // "" = accept

  if (body.includes("authenticate")) {
    const u = xmlGet(body, "strUserName"), p = xmlGet(body, "strPassword");
    const ok = u === (process.env.QBWC_USER || "shippingcloud") && p === (process.env.QBWC_PASS || "");
    const ticket = ok ? crypto.randomUUID() : "";
    // array of two strings: [ticket, ""] ("" = use the currently open company file; "nvu" = bad login)
    const arr = `<string>${ticket}</string><string>${ok ? "" : "nvu"}</string>`;
    return TEXT(soap(`<authenticateResponse xmlns="http://developer.intuit.com/"><authenticateResult>${arr}</authenticateResult></authenticateResponse>`));
  }

  if (body.includes("sendRequestXML")) {
    const next = await dequeue();
    return reply("sendRequestXML", next ? esc(next) : ""); // "" = no work to do
  }

  if (body.includes("receiveResponseXML")) {
    // could parse the qbXML response here; we just acknowledge complete.
    return reply("receiveResponseXML", "100");
  }
  if (body.includes("getLastError")) return reply("getLastError", "No more requests");
  if (body.includes("connectionError")) return reply("connectionError", "done");
  if (body.includes("closeConnection")) return reply("closeConnection", "OK - ShippingCloud done");

  return TEXT(soap("<fault>Unrecognized QBWC request</fault>"));
};
