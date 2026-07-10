/* Boots the built retail bundle in jsdom, seeds an admin session, then WALKS the app:
   every main tab (via the sc-nav event the app itself uses) and every Settings section
   (by clicking the real sidebar buttons). Any runtime error on any screen fails the test —
   this catches "X is not defined" crashes that only appear when a screen actually renders.
   Requires `dist/` (run a shippingcloud build first). */
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
window.HTMLElement.prototype.scrollIntoView = () => {};
window.fetch = async () => ({ ok: true, json: async () => ({ ok: true }), text: async () => "" });
window.localStorage.setItem("sc_session", JSON.stringify({ id: "u1", name: "Spencer", email: "spencer@shippingcloud.net", role: "admin", clientId: null, status: "active" }));
const errs = [];
const where = { now: "boot" };
window.addEventListener("error", e => errs.push(`[${where.now}] window.error: ` + (e.error && e.error.stack || e.message)));
console.error = (...a) => { const s = a.join(" "); if (!/Not implemented|navigation|act\(/.test(s)) errs.push(`[${where.now}] console.error: ` + s.slice(0, 300)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
const btnByText = (label) => [...window.document.querySelectorAll("button")].find(b => (b.textContent || "").trim() === label);

try { window.eval(code); } catch (e) { errs.push("EVAL THREW: " + (e.stack || e)); }

const MAIN_TABS = ["ship", "orders", "shipments", "batch", "returns", "pickups", "invoices", "rules", "drafts", "scan", "settings"];
const SETTINGS_SECTIONS = ["General", "Customizations", "Ship screen", "Orders", "Carrier accounts", "Warehouses", "Package sizes", "Box logic", "Product catalog", "Reference Fields", "Print settings", "Commercial invoice", "Other documents", "Manifests", "Integrations", "Email automation", "Checkout rates", "Reports", "Billing", "Subscription"];

(async () => {
  await sleep(1200);
  if ((window.document.body.textContent || "").length < 50) { console.log("SMOKE FAIL — app never mounted"); process.exit(1); }

  for (const tab of MAIN_TABS) {
    where.now = "tab:" + tab;
    window.dispatchEvent(new window.CustomEvent("sc-nav", { detail: { tab } }));
    await sleep(250);
  }

  // walk every settings section by clicking the real sidebar buttons
  where.now = "tab:settings";
  window.dispatchEvent(new window.CustomEvent("sc-nav", { detail: { tab: "settings" } }));
  await sleep(300);
  const missing = [];
  for (const label of SETTINGS_SECTIONS) {
    where.now = "settings:" + label;
    // scope to the SETTINGS sidebar (the aside with the "Search settings…" box) — the main nav is
    // also an <aside> and has its own "Orders" button that would navigate away from Settings
    const settingsAside = [...window.document.querySelectorAll("aside")].find(a => a.querySelector('input[placeholder="Search settings…"]'));
    const scoped = settingsAside && [...settingsAside.querySelectorAll("button")].find(x => (x.textContent || "").trim() === label);
    const b = scoped || btnByText(label);
    if (!b) { missing.push(label); continue; }
    click(b);
    await sleep(200);
  }

  const fatal = errs.filter(e => !/ResizeObserver|matchMedia|scrollIntoView|getContext|createObjectURL/.test(e));
  console.log("tabs walked:", MAIN_TABS.length, "| sections walked:", SETTINGS_SECTIONS.length - missing.length + "/" + SETTINGS_SECTIONS.length, missing.length ? "(missing: " + missing.join(", ") + ")" : "", "| fatal errors:", fatal.length);
  fatal.slice(0, 8).forEach(e => console.log("  -", e.slice(0, 260)));
  // a missing section button is a failure too — it means the sidebar didn't render or a label changed
  const pass = fatal.length === 0 && missing.length <= 2;   // tolerate ≤2 label changes, not a dead sidebar
  console.log(pass ? "SMOKE PASS" : "SMOKE FAIL");
  process.exit(pass ? 0 : 1);
})();
