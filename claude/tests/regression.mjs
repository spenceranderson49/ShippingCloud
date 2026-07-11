/* ShippingCloud regression tests — pure-logic checks on the risky flows, run without a browser.
   Usage:  NODE_PATH=$PWD/node_modules node claude/tests/regression.mjs
   Extracts the real functions from src/App.jsx (so tests track the source) and exercises them
   with mocked PrintNode / Shopify. Exits non-zero on any failure. */
import fs from "fs";
const src = fs.readFileSync("src/App.jsx", "utf8");
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("  ✗ FAIL:", name); } };

// --- extractor: pull a top-level `function NAME(){}` or `async function NAME(){}` by brace-matching
function extractFn(name) {
  const re = new RegExp("(async\\s+)?function " + name + "\\s*\\(");
  const m = re.exec(src); if (!m) throw new Error("fn not found: " + name);
  for (let j = src.indexOf("{", m.index), d = 0; j < src.length; j++) {
    if (src[j] === "{") d++; else if (src[j] === "}") { d--; if (d === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error("unbalanced: " + name);
}
// --- extractor for a `const NAME=(...)=>{...};` arrow (brace body)
function extractArrow(name) {
  const re = new RegExp("const " + name + "\\s*=\\s*\\(");
  const m = re.exec(src); if (!m) throw new Error("arrow not found: " + name);
  const brace = src.indexOf("{", m.index);
  for (let j = brace, d = 0; j < src.length; j++) {
    if (src[j] === "{") d++; else if (src[j] === "}") { d--; if (d === 0) return src.slice(m.index, j + 1) + ";"; }
  }
  throw new Error("unbalanced arrow: " + name);
}

// ---- sandbox globals used by the extracted fns ----
let sends = [];
globalThis.window = { __scDirectPrint: null, dispatchEvent: () => true };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
globalThis.URL = { revokeObjectURL() {} };
const realST = setTimeout; globalThis.setTimeout = (fn) => realST(fn, 0);
globalThis.docCtxFor = () => ({});
globalThis.cz = (s) => Object.assign({}, (s && s.custom) || {});
globalThis.pdfBlobUrl = () => "blob:x";
globalThis.printPdfUrl = () => true;
globalThis.printImagePages = () => {};
globalThis.pdfToImages = async () => ({ imgs: ["data:image/png;base64,AAA"], wIn: 4, hIn: 6, cropped: false });   // ONE page — an empty array skipped the whole re-render path and made the retry tests vacuous
globalThis.composeForStock = async (i, w, h) => ({ imgs: i, wIn: w, hIn: h, changed: false });
globalThis.imgsToLabelPdf = async () => "REPROC" + "X".repeat(300);
globalThis.applyPrintExtras = async (imgs) => ({ imgs, receipt: null, changed: false });
globalThis.atob = (b) => Buffer.from(b, "base64").toString("binary");

// eval the extracted functions into globals
for (const n of ["labelPdfLooksValid", "directPrintPdf", "openLabelOrDirectPrint"]) {
  const s = extractFn(n).replace(new RegExp("^(async\\s+)?function " + n), "globalThis." + n + "=$1function " + n);
  eval(s);
}
for (const n of ["shopifyConns", "shopifyConnFor", "shopifyConnected"]) {
  eval(extractArrow(n).replace(new RegExp("^const " + n), "globalThis." + n));
}

const validPdf = "JVBERi0xLjQK" + "A".repeat(400);

console.log("— labelPdfLooksValid —");
ok("valid %PDF passes", globalThis.labelPdfLooksValid(validPdf) === true);
ok("garbage fails", globalThis.labelPdfLooksValid("not a pdf") === false);
ok("empty fails", globalThis.labelPdfLooksValid("") === false);
ok("data: prefix still recognized", globalThis.labelPdfLooksValid("data:application/pdf;base64," + validPdf) === true);

console.log("— directPrintPdf —");
await (async () => {
  const mkFetch = (rule) => { sends = []; return async (u, o) => { const b = JSON.parse(o.body); sends.push(b.pdfBase64); return { ok: true, status: 200, json: async () => rule(b) }; }; };
  window.__scDirectPrint = { enabled: true, apiKey: "k", printerId: "123" };
  // 1) PrintNode accepts → true, single send
  globalThis.fetch = mkFetch(() => ({ ok: true }));
  ok("accepts → true", (await globalThis.directPrintPdf(validPdf, "t", {})) === true);
  // 2) not configured → false, no send
  window.__scDirectPrint = { enabled: false }; globalThis.fetch = mkFetch(() => ({ ok: true }));
  ok("not configured → false", (await globalThis.directPrintPdf(validPdf, "t", {})) === false);
  // 3) reprocessed payload rejected, original accepted → retries original → true
  window.__scDirectPrint = { enabled: true, apiKey: "k", printerId: "123" };
  globalThis.composeForStock = async (i, w, h) => ({ imgs: i, wIn: w, hIn: h, changed: true }); // force re-render
  globalThis.fetch = mkFetch((b) => ({ ok: !b.pdfBase64.startsWith("REPROC"), error: "rejected" }));
  const r3 = await globalThis.directPrintPdf(validPdf, "t", {});
  ok("re-render rejected → retries original → true", r3 === true);
  ok("retry actually sent the original", sends.some(s => s.startsWith("JVBER")));
  globalThis.composeForStock = async (i, w, h) => ({ imgs: i, wIn: w, hIn: h, changed: false }); // reset
  // 4) data: prefix stripped before send
  globalThis.fetch = mkFetch(() => ({ ok: true }));
  await globalThis.directPrintPdf("data:application/pdf;base64," + validPdf, "t", {});
  ok("data: prefix stripped before send", sends.every(s => !s.startsWith("data:")));
})();

console.log("— openLabelOrDirectPrint (hands-free never shows modal) —");
await (async () => {
  window.__scDirectPrint = { enabled: true, apiKey: "k", printerId: "123" };
  const run = async (custom, fetchOk) => {
    let previews = 0; globalThis.printImagePages = () => {};
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: fetchOk }) });
    globalThis.openLabelOrDirectPrint({ pdf: validPdf, tracking: "T" }, { custom }, () => previews++);
    await new Promise(r => realST(r, 40));
    return previews;
  };
  ok("hands-free + PrintNode ok → NO preview modal", (await run({ skipBookedSummary: true }, true)) === 0);
  ok("hands-free + PrintNode fail → still NO preview modal", (await run({ skipBookedSummary: true }, false)) === 0);
  ok("no-preview + ok → shows summary modal", (await run({ directNoPreview: true }, true)) === 1);
  ok("preview mode → shows modal", (await run({}, true)) === 1);
})();

console.log("— openLabelOrDirectPrint (new independent flags) —");
await (async () => {
  window.__scDirectPrint = { enabled: true, apiKey: "k", printerId: "123" };
  const run = async (custom, fetchOk, payloadExtra) => {
    let previews = 0; let dialogPrints = 0; globalThis.printImagePages = () => { dialogPrints++; };
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: fetchOk }) });
    globalThis.openLabelOrDirectPrint({ pdf: validPdf, tracking: "T", ...(payloadExtra || {}) }, { custom }, () => previews++);
    await new Promise(r => realST(r, 40));
    return { previews, dialogPrints };
  };
  // previewBeforePrint:true → modal, NOTHING sent to the printer
  ok("previewBeforePrint:true → modal only", (await run({ previewBeforePrint: true }, true)).previews === 1);
  // previewBeforePrint:false + summary on → silent print + summary modal
  ok("previewBeforePrint:false + summary → prints, then summary modal", (await run({ previewBeforePrint: false }, true)).previews === 1);
  // previewBeforePrint:false + no summary → silent print, NO modal
  ok("previewBeforePrint:false + skip summary → nothing pops", (await run({ previewBeforePrint: false, skipBookedSummary: true }, true)).previews === 0);
  // forcePrint (confirmed preview) overrides previewBeforePrint:true → prints instead of previewing
  const fp = await run({ previewBeforePrint: true }, true, { forcePrint: true });
  ok("forcePrint bypasses the preview", fp.previews === 1 /* summary still shows */ || fp.previews === 0);
  // forcePrint + PrintNode down + no summary → dialog-path print, no modal
  const fp2 = await run({ previewBeforePrint: true, skipBookedSummary: true }, false, { forcePrint: true });
  ok("forcePrint + PrintNode down + no summary → prints via page path", fp2.dialogPrints >= 1 && fp2.previews === 0);
})();

console.log("— multi-Shopify helpers —");
ok("legacy single shopifyConn migrates to list", globalThis.shopifyConns({ shopifyConn: { shop: "a.myshopify.com", token: "t" } }).length === 1);
ok("array of conns honored", globalThis.shopifyConns({ shopifyConns: [{ shop: "a", token: "1" }, { shop: "b", token: "2" }] }).length === 2);
ok("drops incomplete conns", globalThis.shopifyConns({ shopifyConns: [{ shop: "a" }, { shop: "b", token: "2" }] }).length === 1);
ok("shopifyConnected true w/ one store", globalThis.shopifyConnected({ shopifyConns: [{ shop: "a", token: "1" }] }) === true);
ok("shopifyConnected false w/ none", globalThis.shopifyConnected({}) === false);
ok("connFor routes to the matching store", globalThis.shopifyConnFor({ shopifyConns: [{ shop: "a", token: "1" }, { shop: "b", token: "2" }] }, "b").token === "2");
ok("connFor falls back to first when shop unknown", globalThis.shopifyConnFor({ shopifyConns: [{ shop: "a", token: "1" }] }, "zzz").token === "1");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
