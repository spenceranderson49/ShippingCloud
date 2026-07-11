# ShippingCloud — Engineering Handoff (v394)

**Date:** 2026-07-10 · **Build:** `addr-v394` (on `staging`; **prod/`main` is still old pre-session code**)
**Owner:** Spencer Anderson (spenceranderson49@gmail.com) — non-technical; push to `staging` to test, explain in plain language, give numbered status updates.
**Branch this session:** `claude/printer-after-print-shp-screen-g8xnjd`

> Read the original uploaded `HANDOFF.md` (2026-07-09) for deep background — brands, Netlify sites, Supabase, deploy pipeline. This doc is the delta since then.

---

## 0. Where things stand

- **GitHub push WORKS** (Spencer *installed*, not just authorized, the Claude GitHub App). Commit to the branch, push to `staging` to test. No more manual uploads.
- **v376 settings reorg is in git** (commit `bdcbfb3`) — it had been delivered as a file but never pushed.
- **Prod (`main`) is untouched this session** — still the pre-session build, which is why prod "just works" while sandbox exercises all the new code. Promote to `main` only after staging sign-off.
- **Hands-free auto-print: RESOLVED (v392).** The long saga turned out NOT to be a printing bug — see §3.
- **Big adds this session:** unified print/automation settings, multiple Shopify stores, a settings-audit cleanup pass, appearance live-preview, plus the earlier move/reorg work.

## 1. Deploy / validate workflow

- Develop on `claude/printer-after-print-shp-screen-g8xnjd`; commit there.
- Push to `staging` to test (Netlify auto-builds):
  ```bash
  git checkout -B staging origin/staging
  git checkout claude/printer-after-print-shp-screen-g8xnjd -- src/App.jsx
  git commit -m "... (addr-vNNN)"; git push -u origin staging
  git checkout claude/printer-after-print-shp-screen-g8xnjd
  ```
- `git config user.email noreply@anthropic.com && git config user.name Claude`. Commits show **"Unverified"** on GitHub (no signing key in env) — cosmetic.
- Bump `BUILD_TAG` (src/App.jsx ~line 109) every release; it shows in the footer so Spencer can confirm which build he's on. Now `addr-v394`.
- **Validation loop** (run before every push):
  ```bash
  npm install; npm install --no-save jsdom
  npx tsc --noEmit --allowJs --checkJs false --jsx preserve --target es2020 --module esnext --moduleResolution bundler src/App.jsx   # react typedef noise is benign
  for b in shiphub admin shippingcloud; do VITE_BRAND=$b npx vite build; done   # shippingcloud LAST
  NODE_PATH=$PWD/node_modules node /tmp/smoke.js
  ```
  `/tmp/smoke.js` boots the retail bundle in jsdom, seeds an admin `sc_session`, mocks fetch, asserts it mounts with 0 fatal errors. `/tmp/hf_test.js` extracts `openLabelOrDirectPrint`/`directPrintPdf` from source by brace-matching (capture the optional `async`!) and tests the hands-free path with mocked PrintNode — how the print fixes were proven without a browser. Recreate both as needed.

---

## 2. What shipped this session (v382–v394, all on `staging`)

`git log origin/main..HEAD` for the full list. Highlights:

- **v376 reorg import** — grouped Settings sidebar (`SEC_GROUPS`), Ship screen as its own top-level section (`sec==="shipscreen"` → `<Customize only="ship"/>`).
- **Appearance live preview** — surface colors (`headerBg`/`navBg`/`pageBg`), accent, and the Freightwire logo tint preview live on the real chrome before Save, via a `sc-look-preview` CustomEvent + `srf = lookPreview || custom` in App (chrome reads `srf.*`). "Reset accent & surfaces" button added.
- **Unified "Ship & print automation" panel** in Print settings (`PrinterSettings`):
  - **1 · When a matching order comes in** — Autopilot: Ship dropdown = *I choose / Pre-select show others / Pre-select hide others* (sets `autoRulesOnShip` + `matchedOnly`, does NOT touch auto-book); Batch dropdown = *Do nothing / Fill / Fill + auto-book*.
  - **2 · When a label is created** — the print MODE (see §3): *Hands-free (auto-books & prints)* / *You book — prints + summary* / *You book — preview first*.
  - **3 · Clear the form after each print** (`resetAfterPrint`).
  - Removed the redundant standalone "auto-print every label" toggle and the legacy "Auto-open the print dialog" checkbox.
- **Print pipeline hardening** (all still valid): `printPdfUrl` pins `@page` to label size (no more tiny-in-corner); hands-free browser fallback renders via `printImagePages` (waits for image decode — no blank/half); `directPrintPdf` validates the re-render, retries with the carrier's original on rejection, and strips any `data:` prefix; `window.__scDirectPrint.enabled` is derived from `apiKey && printerId`. A **"Diagnose hands-free"** button in Print settings runs the real path + dumps `format/mode/routes/...` (the only PrintNode visibility we have — egress to `api.printnode.com` is BLOCKED from Claude's env).
- **Multiple Shopify stores** — see §4.
- **Settings-audit cleanups** — see §5.
- **Smaller items:** "Carrier accounts" → **"FedEx Account"** on ShipHub only (`BRAND.fw`); **Reports** moved under **Account**; admin-locked services **hidden entirely** from the customer's Customizations list (already hidden from Ship rates); **Seasonal/holiday** touches default OFF and admin-only; **scan-mode** auto-focus made reliable (retry through page-settle, never steals focus); removed the "Coming soon…" placeholder text.

---

## 3. Hands-free auto-print — RESOLVED (final design in v392)

**The real problem was never printing.** After a long PrintNode detour, Spencer clarified: nothing pops up — he just had to click **the Ship button next to the service**; on prod it flips to *printing → shipped* by itself, on sandbox it didn't. That auto-fire is **`autoBookOnShip`** (auto-books a rule-matched order).

**Final design (what Spencer wanted):**
- **The Ship dropdown = service selection only** (which service, show/hide the others). It does NOT control booking.
- **The print MODE controls booking + printing:** picking **"Hands-free"** now sets `autoBookOnShip=true` **and** `autoRulesOnShip=true` (in `setMode`, ~line 9025), so a matching order books & prints itself with no click. The other two modes set `autoBookOnShip=false` (you click Book).
- **CAVEAT:** `autoBookOnShip` only fires for an order that **matches an Autopilot rule** (`matched.src==="autopilot"`, effect ~line 5896). No matching rule ⇒ it waits for a click. That's the same behavior as prod. If Spencer says "hands-free still makes me click," first check he has an **Autopilot rule** covering the test order.
- Print-pipeline fixes from the detour (§2) all stay — good hardening, just not the cause.

---

## 4. Multiple Shopify stores (NEW, v394)

- Connections live in **`settings.shopifyConns`** (array of `{shop, token, connectedAt}`). Legacy single **`settings.shopifyConn`** is still honored via the `shopifyConns(s)` helper (~line 1062), so existing connections keep working; the OAuth capture migrates the single → array.
- Helpers: `shopifyConns(s)` (array), `shopifyConnFor(s, shop)` (route to the right store), `shopifyConnected(s)`.
- **Connect** appends (dedupes by shop) instead of replacing. **Sync** loops every store and tags each order with **`o._shop`**; **tracking push-back** uses `shopifyConnFor(settings, ord._shop)` so it fulfills on the correct store. **Integrations UI** (`function Integrations`, ~line 10105) lists each store with per-store **Disconnect** + **"Add store."** Both sync paths updated: the shared `syncOrders` (~line 5275) and the Orders-tab `syncAll` (~line 6672).
- **Shopify OAuth is PRODUCTION-ONLY** (whitelist) per the original handoff — the connect flow can't be exercised on sandbox. Code + UI are complete; live multi-store testing happens on prod.

## 5. Settings-audit cleanups (v394)

- **Packing slips merged** — thank-you message + footer moved into **Print settings → Packing slip** (next to on/off + size, written via `setCust`); the Customizations "Packing slips" tab removed from `CTABS`.
- **"Printers & routing" hidden** behind an "Advanced" reveal (`showRouting` state) unless printers/routes already exist — PrintNode covers most shops. Still fully functional (Batch uses `settings.printers`/`printRoutes` to split jobs per named printer).
- **CI history folded into Commercial invoice** — dropped from `SEC_GROUPS`; the `cieditor` section now renders `CIEditor` + `CIHistory`. (`cihistory` still in `SETTINGS_SEC_LIST` for admin policy — harmless.)
- **Settings search box** — a "Search settings…" filter at the top of the sidebar (`secSearch` state) filters `SEC_GROUPS` by label.

---

## 6. Section map (current `SEC_GROUPS`)

- **Workspace:** General, Customizations
- **Shipping:** Ship screen, FedEx Account/Carrier accounts (brand-conditional), Warehouses, Package sizes, Box logic, Product catalog, Reference Fields
- **Documents & printing:** Print settings, Commercial invoice (+ CI history folded in), Other documents, Manifests
- **Automation & integrations:** Integrations, Email automation, Checkout rates
- **Account:** Reports, Billing, Subscription

Customize (Customizations) tabs: Services, [Ship screen — deployMode only], Orders & lists, Appearance.

---

## 7. Open items / next steps

1. **Confirm on sandbox** (Spencer testing): Hands-free auto-book (needs a matching Autopilot rule), the multi-Shopify UI, and the audit cleanups (packing-slip merge, collapsed Printers & routing, CI history under Commercial invoice, search box, "FedEx Account", Reports under Account, locked services hidden, scan-mode cursor).
2. **Live multi-Shopify test on prod** (OAuth is prod-only) — connect a 2nd store, confirm orders merge and tracking pushes to the right store.
3. **Promote staging → `main`** once signed off. Large diff; test carefully. New code is tenant-proof for printing, so it should be safe, but prod currently works on old code.
4. **General intuitiveness pass** is largely done; revisit label-panel grouping (Label / Doc tabs / Label branding) if desired — low priority.

## 8. Working style

Spencer is fast-moving, non-technical, and gets frustrated when a fix doesn't land (the print saga ran many rounds because the symptom was misread — "I have to click the print button" meant the Ship auto-book, not a print dialog). When a fact is only visible in his browser/PrintNode/Shopify (Claude's env is firewalled from all three), ask for **one screenshot** and decode it rather than making him interpret. Keep `claude/` handoff notes current each release.
