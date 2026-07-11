# UX-Correctness + Dead-Code Audit — src/App.jsx

Date: 2026-07-11 · Build audited: `addr-v448` (src/App.jsx, 13,086 lines) · Findings only — no files edited.

Severity: **HIGH** = users type in it / silent data loss · **MED** = state loss or interaction breaks on click · **LOW** = cosmetic / keyboard-focus only.

---

## 1. Focus-loss bug class — component types defined inside a render body, used as JSX

React compares element types by reference. A component defined inside another component's body is a
*new type on every parent render*, so its subtree unmounts/remounts each render: inputs drop focus
after one character, selects/panels snap shut, local state resets.

**Known-fixed, verified:**
- `GeneralSettings` `F` — src/App.jsx:11822, called as `{F({...})}` (11829-11832); fix comment at 11819-11821. ✔
- `Customize` `Num` — src/App.jsx:12071, called as `{Num({...})}` (12129-12131, 12145, 12172, 12174); fix comment at 12070. ✔

### Offenders (in priority order)

| # | Definition | Used as JSX at | Wraps | Users type? | Severity |
|---|---|---|---|---|---|
| 1 | `In` inside `CIEditor` — **src/App.jsx:11669** | 11687-11729 (~20 instances) | `<input>`: exporter + consignee addresses, invoice #, weight, packages, freight $, insurance $, marks, broker, line-item qty & unit $ | **Yes, constantly.** Every keystroke → `setDoc` → CIEditor re-renders → new `In` type → input remounts → cursor lost. One-letter-at-a-time across the whole Commercial Invoice editor. Fix: hoist `In` to module scope (props are already self-contained) or call as `{In({...})}`. | **HIGH** |
| 2 | `ColorRow` inside `Branding` — **src/App.jsx:3060** | 3088-3089 | `<input type="color">` + **typed hex `<input>`** | Yes — typing a hex code loses focus per character; picker drag remounts mid-drag. Fix: hoist (takes `b`,`set` as props) or call as function. | **HIGH** |
| 3 | `SectionBody` inside `AdminPortal` — **src/App.jsx:4459** | 4491 | **Entire admin sections** (CustomersMaster, RatesAdmin, Branding, Domains, PlatformAccountsAdmin, UsersAdmin, CustomizationsAdmin, FedexCertLab, AdminDashboard) | Indirect but the worst offender. Any AdminPortal re-render — every `setUsers`/`setClients`/`setSettings`/`setFeatureFlags`, the 120s order auto-sync (6112), the 20s cloud poll / tab-focus poll (5073, 5077-5078 → PERSIST_BUS → AppInner) — recreates the type and **fully remounts the active section**. Concrete symptoms verified in code: (a) **UsersAdmin**: "Tabs & logo" (4760), "Portal access" (4796) and "Rates:" (4751) panels snap shut after *every* checkbox click, because the click writes global state and the remount resets `featOpen/accessOpen/rpOpen`; the New-login form (`f`) is wiped by any background sync. (b) **Branding**: unsaved draft `b` (3054) silently wiped when a publicBrand toggle (3096) is flipped or a poll lands; the "✓ Saved" flash (3055) can never be seen because the post-save remount resets it. (c) **RatesAdmin**: the whole unsaved `useDraft` rate edit + import textarea (3921, 3938) is destroyed by any background order sync or cloud poll mid-edit. (d) **Domains/CustomersMaster**: in-progress add-forms wiped by background updates. Fix: replace `<SectionBody k={cur.key}/>` with `{sectionBody(cur.key)}` (plain function call) or hoist to a top-level component. | **HIGH** |
| 4 | `Ed` + `Opts` inside `FieldLists` — **src/App.jsx:12015 / 12011** | 12034-12037 (`Ed`), via `extra={<Opts/>}` (12035-12037) | `Ed` wraps an add-value `<input>` **and holds `useState` (12016) inside a render-scoped component**; `Opts` wraps two checkboxes writing `settings.custom` | Typing inside one `Ed` is safe *until* any global write: clicking "Add", deleting a chip, or ticking Required/Lock re-renders FieldLists → all four `Ed` panels remount → half-typed text in the other panels is lost, checkbox focus lost. Fix: hoist both; pass `fl/setList/c/setC` as props. | **MED** |
| 5 | `Sel` inside `Customize` — **src/App.jsx:12068** | 12128, 12132, 12142, 12144, 12171, 12209-12213 | `<select>` (theme, text size, density, default view, signature defaults, start tab, confetti…) | No typing, but each change remounts the select — focus lost; keyboard arrow-selection (change fires per step) remounts mid-interaction. | **MED** |
| 6 | `Tog` inside `Customize` — **src/App.jsx:12065** | ~20 uses (12114-12127, 12143, 12170, 12173, 12212) | `<input type="checkbox">` | Click lands; focus + keyboard space-toggle flow lost after each toggle. | **LOW** |
| 7 | `Opt` / `Box` inside `PrinterSettings` (inside an IIFE in render) — **src/App.jsx:10321 / 10325** | 10329-10346 | `<input type="radio">` — the four print-flow choice groups | Radios remount after every pick (each pick writes `settings.custom`); mouse OK, keyboard radio-group navigation and focus broken. | **LOW-MED** |
| 8 | `FeatureRow` inside `CustomizationsAdmin` — **src/App.jsx:4584** | 4626, 4630 | Buttons/chips only | Focus loss per chip click; compounded by #3. | **LOW** |
| 9 | `Up` inside `AssetLibrary` — **src/App.jsx:11570** | 11576-11578 | hidden `<input type="file">` | File dialog is modal; barely observable. | **LOW** |

Display-only nested types (no inputs, remount is cosmetic-cost only, not bugs): `Landing F/NavTab` (5319-5320), `LegalLinks H/P` (5252-5253), `AdminDashboard Combo` (3278), `Dashboard Ring/Tile/MixBar` (8787-8798), `OrderDetail Info` (8033), `OrderShipModal Row2` (8262), `Shipments PendingBar/Row` (8452, 8516), `LabelPreviewModal D` (7512), `TransitAudit Stat` (12542), `Ship PackNote` (6974), `AppInner SandboxBanner` (6031), `Batch Chip` (9245).

### Audited and CLEAN (helpers exist but are function-called or contain no nested input components)

- **DraftBar** (3896) — top-level, always-mounted fixed-height sticky bar. Clean.
- **CustomerDetail** (3400) — `A`/`fa` (3452-3453) are prop factories; all fields top-level `Field/Input/Select`; rendered directly at 4492 (NOT inside SectionBody), so per-keystroke `setClients` writes keep focus. Clean.
- **RatesAdmin** (3919) — no nested component types of its own (but lives under SectionBody, see #3).
- **ServiceList `Row`** (7606) — called via `.map(Row)` (7704-7705), not JSX. Clean.
- **Batch `OrderRow`** (9247) — called via `.map(OrderRow)` (9430, 9439). Clean.
- **OrderEditForm `F`** (10846) — called `{F("customer","Name")}`. Clean.
- **FedexCertLab `A`** (3132) — prop factory. Clean.
- Returns, Scan, OtherDocs, CIHistory, Notifications, Integrations, CheckoutRates, Warehouses, BoxesSettings, BoxLogic, ProductCatalog, ReferenceFields, AddressBook, Billing, QuickQuote, RuleEditorModal, RulesTab, AutomationRules — all inputs inline or top-level components. Clean (one line each; ProductCatalog/PrinterSettings dead helpers listed in §4).

---

## 2. Layout shift — content mounting/unmounting above interactive areas

Fixed-height work already verified in code: hands-free status strip (7158-7173, `min-h-[38px]`, comment says "screen never jumps"), order-loaded box (7119-7122 `min-h-[38px]`), ServiceList tombstones + fixed ladder order + skeleton rows (7583-7604) — service rows never collapse or reorder mid-load. Accessorial tables noted done per brief.

Remaining offenders:

- **src/App.jsx:7091-7099 (Ship)** — PO-Box banner (appears while typing address1), hazmat banner, and duplicate-label banner (appears while typing Ref #) mount between the packages editor and the service list — rows the user is about to click move mid-typing. MED. Fix sketch: reserve a single fixed-height advisory slot (like the hands-free strip) that swaps text.
- **src/App.jsx:7132-7157 (Ship)** — rate-source banner (mounts only when `ready` flips true, and swaps to admin diag line 7139), dvPriced warning (7142), live-rate error (7145), `quoteProblems` (7150) and `quoteAdvisories` (7154) all mount/unmount directly above `<ServiceList>`; entering/removing a weight digit can pop a multi-line banner in and shove the Print-label buttons down. MED.
- **src/App.jsx:7856 (Orders)** — `syncMsg` banner mounts above toolbar + table for 5s then unmounts; the whole table jumps twice per sync. LOW-MED. Same pattern: Batch `msg` (9295), AddressBook `msg` (11300), ProductCatalog `msg` (9921, 5s flash) + "no dimensions" banner (9932), Integrations `msg` (11493, below controls — mild). Fix sketch: toast overlay or fixed-height status row.
- **src/App.jsx:8452 (Shipments)** — `PendingBar` mounts above the shipments list when pendingShips exist. LOW (infrequent).
- **src/App.jsx:10356-10398 (PrinterSettings)** — after "Find my printers", the Label-printer row + "More printers" panel + `pnMsg` all mount mid-panel, pushing later panels down. LOW (single deliberate action).
- **Settings shell (9705)** — sidebar + sections stable, sections rendered inline with stable types. Clean.
- **GeneralSettings / Customize / CustomerDetail tabs** — no above-input mounting. Clean.

---

## 3. Settings drift — written-never-read / read-never-written

Method: every `cz(settings)/custom.*` key in `CUSTOM_DEFAULTS` (2817-2828) plus `settings.*` keys grep-counted for writer + reader sites.

**Written but never read (no-op UI — user flips it, nothing changes):**
- `settings.printer.rotate` — "Rotate label 180°" checkbox **10465**; only other occurrence is the default literal (10198). No print path reads it. MED (broken promise on a physical-printer workaround). Fix: honor in the label render/print pipeline or remove the checkbox.
- `settings.printer.printer` — "Default printer (optional)" text field **10464**; never read. LOW. (Real routing uses `printers`/`printRoutes`/`printNode`.) Remove or wire up.
- `settings.printer.packingSlip` — "Generate a packing slip with each label" checkbox **10468**; never read — the working toggle is `custom.autoPackSlip` (10403) **on the same page**, so two toggles claim the same job and only one works. MED. Remove the dead one.
- `settings.printer.slipSize` — "Packing slip size" select **10470**; never read (packing-slip HTML has no size parameter). LOW-MED.
- `settings.printer.format` — PDF/PNG/ZPL select **10457**; read only by the diagnostics dump string (10377), never by the label pipeline. MED (users picking ZPL for a Zebra get PDFs).
- `settings.supportPhone` — GeneralSettings field **11832**; never read anywhere (supportEmail *is* read at 11771). LOW.
- `client.prefs.labelSize` / `client.prefs.packingSlip` — CustomerDetail → "Label preferences" tab **3739 / 3743**; written by admins, read by nothing (the customer's own `settings.printer` governs). MED as admin-facing false affordance.
- `client.prefs.shipFromBusiness` — "Use this address as their default ship-from" checkbox **3507**; never read — the customer's ship-from never changes. MED.
- (`client.prefs.supplies` / `suppliesNotes` (3752-3761) are record-keeping only — plausibly intentional, note in passing.)

**Read but never written (legacy inputs — OK but document):**
- `custom.directNoPreview` — read at 6841, 7097, 10310, 10377 etc.; no UI writes it anymore (superseded by `previewBeforePrint`). Intentional back-compat per comments; candidate for a migration + removal.
- `custom.packSlipPrinterId` — legacy slot: still read as fallback in `docVal` (10265), writes only clear it (10269). Intentional; removable after migration.

**Duplicate/conflicting editors for the same key:**
- `settings.defaultBillTo` — edited in **GeneralSettings 11849** (options: sender/third only) *and* **Billing 11535** (sender/receiver/third). If a user picks "receiver" in Billing, the GeneralSettings select silently renders as if "sender" were chosen (value not among its options). LOW-MED. Fix: same option set in both, or one editor.

All other `CUSTOM_DEFAULTS` keys verified to have both a writer and at least one live reader (hotkeys 5899, stuckDays 8438, seasonal 6268, startTab 5897, density 7793/8478, orderViews 7795, etc.). `SLIP_OPTS`/`CI_OPTS` module mirrors are synced by AppInner (5888, 6140) and read by the print builders (1637-1638, 1884, 1925). Clean.

---

## 4. Dead code

Functions/components defined and never referenced (each verified by grep — only hit is the definition):

- **`surchargeAdjust(lines,svcLabel,prof)`** — src/App.jsx:2387-2398 (+doc comment 2384-2386). Superseded by the base/fee split pricing engine (`rateSellFor` `_parts`). Safe delete.
- **`AutomationRules`** — src/App.jsx:10612-10637. Legacy rules editor; `RulesTab`/`RuleEditorModal` is the live one. Safe delete.
- **`CommercialInvoice`** — src/App.jsx:7322-~7352. React preview component; printing now goes through `printCommercialInvoice` HTML. Safe delete.
- **`Company`** — src/App.jsx:12315-~12334. Replaced by GeneralSettings ("Your company" + "Default sender"); no `sec==="company"` exists. Safe delete.
- **`Ledger`** — src/App.jsx:12849-~12877 (the `addLedger` *function* is used at 6089; the Ledger UI component is not). Safe delete.
- **`Clients`** — src/App.jsx:12878-12886. Safe delete.
- **`ClientInvoices`** — src/App.jsx:12569-~12642. `Invoices` (12501) now renders only CarrierAudit/TransitAudit. Safe delete (12578-12580 Stat2 usage goes with it).
- **`EditField`** — src/App.jsx:13085. Never used. Safe delete.
- **`Toggle` (local)** in `Customize` — src/App.jsx:12099-12102. Shadows the (used) top-level Toggle but is itself never rendered. Safe delete.
- **`ApTog`** in `PrinterSettings` — src/App.jsx:10207. Both toggles in that panel are hand-rolled inline (10403, 10563). Safe delete.
- **`Cell`** in `ProductCatalog` — src/App.jsx:9915. Edit rows use `Field/Input`. Safe delete.

Dead props / vestigial values:
- `ServiceList` props **`best`** and **`showCost`** (7551) — never referenced in the body; Ship passes `best={best}` where `best` is the constant `null` (6762). Remove both plus the constant.
- `Invoices` props `invoices, setInvoices, client` (12501) — unused since the audit-tabs rewrite.

Unreachable branch:
- **`sec==="cihistory"` branch** — src/App.jsx:9763. "cihistory" is not in `SEC_GROUPS`, and 9731 resets any unknown/hidden `sec` to "general", so the branch (an exact duplicate of `cieditor` at 9762) can effectively never render. Safe delete.

Dead files (not imported anywhere; `src/main.jsx` imports only `./App.jsx`):
- **`src/App (1).jsx`** and **`src/quote (1).js`** — stray duplicate copies. Delete from the repo.

---

## 5. State resets across entity switches

- **CustomerDetail (3400)** is rendered without a `key` (4492) and its instance is reused when switching between open customer tabs (`cid` prop changes):
  - `mk` markup draft — **handled**: reset via `useEffect(...,[cid])` at 3421. Verified. ✔
  - `lf` new-login form (3409) — **not reset on cid change**: a half-typed name/email/temp-password for customer A survives into customer B's Logins tab; clicking "Add login" attaches it to B. MED. Fix: clear `lf` in the same `[cid]` effect, or `key={cid}` the component (which also cleans the items below).
  - `tab`, `surQ`, `surTab`, `svcFilter`, `openBrk` persist across cid switches — mostly benign (sticky tab is arguably a feature); `openBrk` leaves weight-break editors expanded against a different customer's profile. LOW.
  - The rates draft (`_rd` over global `rateRules`, 3405-3407) is shared storage, so carrying dirty state across customers is semantically correct (edits target profiles, not the cid). OK.
- **OrderShipModal** — keyed correctly: `<OrderShipModal key={open.id} …>` (7944); prev/next navigation via `onNav=setOpen` changes the key and remounts fresh. ✔
- **RuleEditorModal** — mounted only while `editing` is set (11260) and unmounted on close, so `r` state (10862) can't leak between rules; there is no path that swaps `rule` while open. ✔
- **Ship `prefill` / `applyOrder`** — insurance/signature/declared-value explicitly reset before auto-rules run (6575-6587, comment documents the old carry-over bug); `ruleAppliedRef`/`ruleAcct` reset when order deselects (6630). ✔
- **Ship `emailMsg`** (6475) — seeded from `settings.emailMessage` once at mount and never re-synced; if the setting loads/changes after mount (cloud sync) the box shows the stale default. LOW.
- **QuickQuote / NewOrderForm / OrderEditForm** — modal-scoped state, mounted on open. ✔

---

## 6. Loading / empty states

Good coverage overall — verified clean: app boot spinner + offline/netfail screens (5752-5754); Ship service list renders a domestic/intl **skeleton** so an empty or wrong-country list never flashes (6680-6691, 7723); stale rates are cleared while re-fetching so old prices are never bookable (6711 comment); QuickQuote skeleton (8664); Orders `LiveEstRate` pulse "…" + "no ship-from ZIP" hint (7784, 7783); address check "Checking with FedEx…" (6982); empty states present in Orders (7916), ProductCatalog (9956), Warehouses (9819), CustomersMaster (3852), CIHistory (11617), AddressBook (11317), Returns (9479), Scan, Pickups/Manifests/Drafts via `Empty` (8596, 9538, 12485), GeneralSettings audit log (11854), Notifications email log (10603).

Remaining issues:

- **src/App.jsx:4399-4418 (AdminDashboard `platform`)** — when the admin's cloud snapshot hasn't populated (`CLOUD.snapshot` empty), it silently falls back to *the admin's own* shipments/orders and renders them as "platform-wide" stats with no loading or "partial data" indicator — misleading numbers rather than a loading state. MED. Fix: show a "syncing platform data…" note when `!sawCloud` in cloud mode.
- **src/App.jsx:11906-11914 (TwoFactorPanel)** — `status===null` is the loading state; verify the render shows a spinner rather than the disabled/off layout (the local-mode fallback immediately writes `enabled:false`, so a cloud user sees a brief "2FA off" flash before the real status arrives). LOW.
- **src/App.jsx:9612 (CheckoutRates preview)** — quotes come from the offline estimator even for live accounts; the mock checkout implies "buyers see this" with no "estimate" qualifier. LOW (it is a labeled preview).
- **src/App.jsx:3470 (CustomerDetail `flash`)** — save feedback is a 2.2s inline text; on slow cloud saves there's no failure feedback here (DraftBar covers the Rates tab only). LOW.

---

## Suggested fix order

1. Hoist `In` (CIEditor) and `ColorRow` (Branding) — two 5-minute fixes that end one-letter-at-a-time typing.
2. Convert `SectionBody` to a plain function call `{sectionBody(k)}` — one-line change; stops admin-section state wipes and panel-snapping.
3. Hoist FieldLists `Ed`/`Opts` (Ed's internal `useState` makes this the most bug-prone remaining pattern).
4. Reset `lf` on `cid` change in CustomerDetail (or key it by cid).
5. Delete the §4 dead code (~350 lines) and the two stray `(1)` files.
6. Wire up or remove the four no-op printer settings (`rotate`, `format`, `packingSlip`, `slipSize`) and `prefs.shipFromBusiness` — silent-no-op settings erode trust fastest.
7. Reserve fixed-height advisory slots on Ship above the service list; convert list-top flash banners (Orders/Batch/ProductCatalog/AddressBook) to toasts.
