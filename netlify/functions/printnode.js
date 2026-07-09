/* PrintNode relay — powers the zero-dialog "Direct printing" feature.
   The person installs the free PrintNode client on the label workstation, pastes their
   PrintNode API key in Settings → Printer settings, and picks a printer. Labels are then
   POSTed here as pdf_base64 and PrintNode's local agent prints them silently.
   The API key comes from the caller's own per-login settings (same trust model as the
   England credentials flowing through quote.js/ship.js). Nothing is stored server-side. */
const API = "https://api.printnode.com";

exports.handler = async (event) => {
  const J = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  if (event.httpMethod !== "POST") return J(405, { ok: false, error: "POST only" });

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch { return J(400, { ok: false, error: "Bad JSON" }); }

  const key = String(b.apiKey || "").trim();
  if (!key) return J(200, { ok: false, error: "No PrintNode API key — paste it in Settings → Printer settings." });
  const auth = "Basic " + Buffer.from(key + ":").toString("base64");

  try {
    if (b.action === "printers") {
      const r = await fetch(API + "/printers", { headers: { Authorization: auth } });
      const d = await r.json().catch(() => null);
      if (!r.ok) return J(200, { ok: false, error: (d && (d.message || d.error)) || ("PrintNode rejected the key (" + r.status + ")") });
      const printers = (Array.isArray(d) ? d : []).map(p => ({
        id: p.id,
        name: p.name || ("Printer " + p.id),
        state: p.state || "",
        computer: (p.computer && p.computer.name) || ""
      }));
      return J(200, { ok: true, printers });
    }

    if (b.action === "print") {
      const printerId = +b.printerId;
      const content = String(b.pdfBase64 || "");
      if (b.contentType === "raw_html" || (!content && b.html)) return J(200, { ok: false, error: "PrintNode can only print PDFs — HTML documents fall back to the browser print window." });
      if (!printerId || !content) return J(200, { ok: false, error: "printerId and pdfBase64 are required" });
      if (content.length > 8 * 1024 * 1024) return J(200, { ok: false, error: "Label PDF too large" });
      /* THE silent black hole: PrintNode happily ACCEPTS jobs while the desktop agent is offline —
         they just sit in a cloud queue, nothing prints, and the app thought everything was fine.
         Check the printer's computer state first and refuse loudly, so the app falls back to the
         visible print dialog and tells the person WHY. */
      try {
        const pr = await fetch(API + "/printers/" + printerId, { headers: { Authorization: auth } });
        const pd = await pr.json().catch(() => null);
        const pinfo = Array.isArray(pd) ? pd[0] : pd;
        const compState = String((pinfo && pinfo.computer && pinfo.computer.state) || "").toLowerCase();
        const compName = (pinfo && pinfo.computer && pinfo.computer.name) || "the label computer";
        if (compState === "disconnected") {
          return J(200, { ok: false, offline: true, error: "The PrintNode app on \"" + compName + "\" is OFFLINE — nothing can print. Open PrintNode on that computer and sign in, then try again." });
        }
      } catch (e) { /* state check failed — don't block the job on it */ }
      const r = await fetch(API + "/printjobs", {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          printerId,
          title: String(b.title || "Shipping label").slice(0, 120),
          contentType: "pdf_base64",
          content,
          source: "ShippingCloud"
        })
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) return J(200, { ok: false, error: (d && (d.message || d.error)) || ("PrintNode error " + r.status) });
      return J(200, { ok: true, jobId: d });
    }

    return J(400, { ok: false, error: "Unknown action" });
  } catch (e) {
    return J(200, { ok: false, error: (e && e.message) || "Could not reach PrintNode" });
  }
};
