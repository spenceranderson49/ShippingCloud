/* Brand boot test: mounts a built bundle from an arbitrary dist dir in JSDOM as an admin
   login and asserts the app renders and every main tab switches with zero fatal errors.
   Usage: node claude/tests/boot.mjs <distDir> <origin>
   (the full click-walker in smoke.mjs stays shippingcloud-specific; this covers the other
   brands' bundles, which share the code but boot with different BRAND config.) */
import fs from "fs";
import { JSDOM } from "jsdom";
const distDir = process.argv[2] || "dist";
const origin = process.argv[3] || "https://shippingcloud.net/";
const files = fs.readdirSync(distDir + "/assets").filter(f => f.endsWith(".js"));
const jsFile = distDir + "/assets/" + files.sort((a, b) => fs.statSync(distDir + "/assets/" + b).size - fs.statSync(distDir + "/assets/" + a).size)[0];
const code = fs.readFileSync(jsFile, "utf8");
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { runScripts: "outside-only", pretendToBeVisual: true, url: origin });
const { window } = dom;
global.window = window; global.document = window.document;
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }); } catch (e) {}
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};
window.fetch = async () => ({ ok: true, json: async () => ({ ok: true }), text: async () => "" });
window.localStorage.setItem("sc_session", JSON.stringify({ id: "u1", name: "Spencer", email: "spencer@shippingcloud.net", role: "admin", clientId: null, status: "active" }));
const errs = [];
const where = { now: "boot" };
window.addEventListener("error", e => errs.push(`[${where.now}] window.error: ` + (e.error && e.error.stack || e.message)));
console.error = (...a) => { const s = a.join(" "); if (!/Not implemented|navigation|act\(/.test(s)) errs.push(`[${where.now}] console.error: ` + s.slice(0, 300)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

try { window.eval(code); } catch (e) { errs.push("EVAL THREW: " + (e.stack || e)); }

const MAIN_TABS = ["ship", "orders", "shipments", "batch", "returns", "pickups", "rules", "scan", "settings", "admin"];
(async () => {
  await sleep(1200);
  if ((window.document.body.textContent || "").length < 50) { console.log("BOOT FAIL (" + distDir + ") — app never mounted"); process.exit(1); }
  for (const tab of MAIN_TABS) {
    where.now = "tab:" + tab;
    window.dispatchEvent(new window.CustomEvent("sc-nav", { detail: { tab } }));
    await sleep(200);
  }
  const fatal = errs.filter(e => !/ResizeObserver|Not implemented/.test(e));
  console.log(distDir + ": tabs switched, fatal errors: " + fatal.length);
  fatal.slice(0, 5).forEach(e => console.log("  " + e.slice(0, 260)));
  console.log(fatal.length ? "BOOT FAIL" : "BOOT PASS (" + distDir + ")");
  process.exit(fatal.length ? 1 : 0);
})();
