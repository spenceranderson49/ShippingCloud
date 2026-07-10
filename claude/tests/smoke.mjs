/* Boots the built retail bundle in jsdom, seeds an admin session, asserts it mounts with no
   fatal runtime errors. Requires `dist/` (run a shippingcloud build first). */
import fs from "fs";
import { JSDOM } from "jsdom";
const files = fs.readdirSync("dist/assets").filter(f => f.endsWith(".js"));
const jsFile = "dist/assets/" + files.sort((a, b) => fs.statSync("dist/assets/" + b).size - fs.statSync("dist/assets/" + a).size)[0];
const code = fs.readFileSync(jsFile, "utf8");
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { runScripts: "outside-only", pretendToBeVisual: true, url: "https://shippingcloud.net/" });
const { window } = dom;
global.window = window; global.document = window.document;
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }); } catch (e) {}
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
window.scrollTo = () => {};
window.fetch = async () => ({ ok: true, json: async () => ({ ok: true }), text: async () => "" });
window.localStorage.setItem("sc_session", JSON.stringify({ id: "u1", name: "Spencer", email: "spencer@shippingcloud.net", role: "admin", clientId: null, status: "active" }));
const errs = [];
window.addEventListener("error", e => errs.push("window.error: " + (e.error && e.error.stack || e.message)));
console.error = (...a) => { const s = a.join(" "); if (!/Not implemented|navigation|act\(/.test(s)) errs.push("console.error: " + s.slice(0, 200)); };
try { window.eval(code); } catch (e) { errs.push("EVAL THREW: " + (e.stack || e)); }
setTimeout(() => {
  const txt = window.document.body.textContent || "";
  const fatal = errs.filter(e => !/ResizeObserver|matchMedia|scrollIntoView|getContext/.test(e));
  console.log("mounted length:", txt.length, "| fatal errors:", fatal.length);
  fatal.slice(0, 6).forEach(e => console.log("  -", e.slice(0, 220)));
  const pass = txt.length > 50 && fatal.length === 0;
  console.log(pass ? "SMOKE PASS" : "SMOKE FAIL");
  process.exit(pass ? 0 : 1);
}, 1200);
