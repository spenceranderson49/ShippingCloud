# Morning Audit — 2026-07-15 (v560, live everywhere)

Scope: every button and function on every customer page, every admin portal screen, and a
field-by-field trace of Admin → Rates through to the prices displayed on the site, the public
API, and Shopify checkout. Method: full static code audit (five parallel deep passes over
src/App.jsx + all netlify/functions), every claimed defect re-verified against the source, plus
a clean production build check. Build: **passes** (vite, 1503 modules, no errors).

Branch audited: v560 (`fe15130`) — identical on working branch, staging, and main.

---

## PART 1 — THE RATES QUESTION (the priority ask)

**Verdict: inside the platform, every field on the admin Rates screens is LIVE and moves
displayed prices.** Traced from each editor field → the `rateRules` store (draft → Save →
cloud) → the pricing engine (`rateSellFor`, App.jsx:2513) → the Ship screen, Quick Quote,
Orders "Est. rate" column, order ship modal, and rate sheets.

### Confirmed live (field → effect)

| Admin field | Live? | Where it bites |
|---|---|---|
| Service basis: % markup | ✅ | base freight ×(1+%) on every quote |
| Service basis: Fixed $ | ✅ | cost + $X |
| Service basis: Flat $ | ✅ | sells at exactly $X (exempt from profit floor, prices even with unknown cost — both deliberate, both verified) |
| Service basis: FedEx List −% | ✅ | live list from the quote, or imported `list:` table by zone/weight |
| Min $ (per service) | ✅ | floors the BASE on every path, including fallbacks |
| Zone overrides (per service) | ✅ | zone % beats service % |
| Weight breaks (upTo/%/Min/zone cells) | ✅ | most-specific-wins resolution verified identical everywhere |
| List year 2025 vs 2026 | ✅ portal | 2025 prices off imported `list2025:` table or the built-in 2025 book |
| Surcharge rules (±% over cost / $ over / flat $ / % off list) | ✅ | reprices the matched fee line on live quotes; blank amount = account markup; missing type defaults match what the editor shows |
| Signature / Saturday / declared-value fees | ✅ | via `surchargeFees` from the same rows (SIG-D/I/A, SAT, INS) |
| Profile assignment (customer → profile) | ✅ | `rateProfileFor` on every quote; Customers tab pickers write the same `assign` map |
| Account-wide markup % (Customer → Rates) | ✅ | applied after service rules; live preview on the tab uses the same engine |
| Min $ profit / label (Customer → Rates) | ✅ | floors sell vs TRUE total carrier cost |
| Dim divisors | ✅ | synced into billable-weight math on load and save |
| Base cost tables / One Rate table imports | ✅ | margin analysis, rate sheets, One Rate quoting |
| Blocked services (per customer) | ✅ | filtered out of every customer-visible list |
| Other-carrier rate cards + per-customer enable | ✅ | quote-only rows through the same rule engine |
| England tier | ✅ (display-only, as labeled) | cost estimate for margin analysis only |
| Hide row (services table) | ✅ (cosmetic-only, as labeled) | pricing untouched |

Safety plumbing also verified: rates edit a DRAFT and only commit on Save; the server refuses
any save that would wipe profiles or drop loaded rate-card tables (db.js F20 guard).

### Where admin rates do NOT reach (the exceptions you need to know)

1. **Shopify checkout ignores the admin Rates screens entirely.** `shopify-rates.js` never
   reads `rateRules`: buyer price = raw FedEx account cost ×(1 + the store's own Settings →
   Checkout Rates markup, default 20%) + handling. No profile rule, surcharge rule, list table,
   account markup, or Min-profit floor touches checkout prices. Partly by design (merchants set
   their own buyer markup), but note the buyer markup is applied to the merchant's RAW cost —
   not to the marked-up price the merchant actually pays you — so a merchant can be quoted
   checkout prices below what the label will cost them.
2. **Public API (v1/rates, customer API keys) — 3 gaps vs the portal:**
   - `listYear: 2025` without an imported 2025 table: portal prices off the built-in 2025 book;
     API falls back to account markup (the 2025 dataset is deliberately stubbed server-side,
     api-engine.js:273 — and the parity test masks exactly this).
   - Saturday-delivery fee: portal always adds the SAT rule fee; the API accepts
     `saturday_delivery:true` but never adds or reprices the fee.
   - Imported One Rate tables / flat One Rate rules: portal shows them even when FedEx returns
     no live One Rate; the API omits those rows entirely.
   Everything else (all bases, breaks, zones, mins, markups, surcharges, dim divisors, custom
   carriers) is character-identical between portal and API engines — verified line by line.
3. **Multi-tab editing hazard (real data-loss path):** RatesAdmin and every open Customer →
   Rates tab each draft the ENTIRE shared `rateRules` object. With two dirty drafts open,
   saving one then the other silently reverts the first save (second draft was built on the
   older snapshot). The server wipe-guards don't catch this. Save one rates screen at a time
   until fixed.

---

## PART 2 — BROKEN (button does not do what it says)

1. **Assistant chat — Send button** (App.jsx:6217). `onClick={send}` passes the click event as
   the message: the typed text is discarded and the literal string "[object Object]" is sent to
   the AI. Enter key and suggestion chips work; the button doesn't. Fix: `onClick={()=>send()}`.
2. **Cross-tab sign-out white-screens other tabs** (App.jsx:6805–6818). Two hooks sit below
   the `if(!currentUser) return <Login/>` early return — a Rules-of-Hooks violation. Signing
   out (or in) in one tab makes any other open tab throw "Rendered fewer hooks than expected"
   → white screen, above the error boundary. Fix: move `usePersist("fedexPrompt")` and the
   sticky-offset effect above the early returns.
3. **Rules → "Add Starter Rules"** (App.jsx:12024). The seed list was deliberately emptied
   (`SEED_RULESET=[]`), so the big blue button in the empty state adds zero rules with zero
   feedback. Remove the button or restore seeds.
4. **Rule editor → "Route to Printer" action** (App.jsx:11661). No input renders for this
   action type ("no options"), so there is nowhere to type the printer name and the rule always
   routes to the default printer — while Print Settings copy tells users to enter the printer's
   exact name. Also: switching action type from "Book on FedEx Account" leaks the stale account
   value into the printer route.
5. **Admin → API → Create key, Mode = "Integration (admin)"** (App.jsx:4758 vs db.js:926).
   The UI intentionally allows a customer-less admin key; the server unconditionally rejects
   empty clientId. The advertised flow can never succeed.

## PART 3 — DEGRADED (works, but not the way it claims)

6. **Ship tab loses the order's country** (App.jsx:7192; also Orders→Ship 8536, Scan 9488).
   Loading an order builds the receiver without `country`, defaulting to United States. An
   international order either never rates ("waiting for a valid ZIP") or quotes domestic. The
   order ship MODAL handles country correctly — only the Ship-tab paths drop it.
7. **"Send Shipping Label" / "Send Tracking Email"** (Ship, 7902). Neither sends what it says:
   no tracking number/link is passed into the email template, email.js has no attachment
   support (a label PDF cannot be sent), and both report "Sent ✓" even before a label exists.
8. **"Reprint" on the already-has-a-label banner** (Ship, 7768). Shipment records never carry
   the PDF this button looks for — it always lands on the "label isn't stored" error. The
   Shipments-tab reprint is the one that works.
9. **Shipments → "Check for labels"** (9187). The backend `status` action is hard-coded
   "nothing pending," so if the pending bar ever shows, the button can never resolve it.
10. **Checkout Rates "registered" badge** (10404). Defaults to green "registered" and nothing
    ever updates it — shows registered even with no Shopify connected.
11. **Admin → Branding "Save branding" & Domains "Create"** (3126, 3078). Both persist only
    into the signed-in admin's OWN per-login settings. No customer, partner, or other admin
    ever sees the change; the domains panel registers no tenant despite saying it does.
12. **Rules → apply-without-booking flow unreachable** (11833). `applyToOrders` (tags/holds/
    service without buying labels) is fully built but no button invokes it anymore.
13. **New customers/logins created without `createdAt`** (4042, 5116). Defeats the server
    guard that protects fresh rows from stale-tab overwrites — the exact incident class that
    erased two logins on 2026-07-13. The CustomerDetail create path does it right; copy it.
14. **Admin Billing** (4663). (a) Invoices can be previewed/issued from a partially-loaded
    snapshot right after page load — missing most of the month — with no warning (the Dashboard
    shows the partial-data banner; Billing ignores it). (b) Shipments match customers by NAME,
    so renaming a customer orphans their history from invoicing.
15. **Demo-mode assistant** always answers "Sign in to use the assistant" (no token in demo);
    the demo greeting invites questions it can never answer.
16. **Local-mode "Request account"** (3029) validates, claims "Request received," stores and
    sends nothing.
17. **Platform reseller accounts panel is unreachable** (5015) — defined, never rendered from
    any admin section.

## PART 4 — MINOR

- Batch zone chips show "ZNaN" when the customer record has no origin ZIP even though a sender
  ZIP is set (9803 uses `client.origin` only).
- New Order → Create with empty form silently does nothing (8671).
- Returns "Reason" default `"Wrong size"` matches no dropdown option (case mismatch, 10235).
- Address Book CSV import splits on raw commas — quoted fields ("Acme, Inc.") garble columns
  (12117); the proper CSV parser already exists in the file.
- Package Sizes: "Empty (lb)" column shown but not settable; boxes aren't editable (10781).
- Billing "Add funds" credits the prepaid balance with no payment step and no disclaimer
  (12353).
- Settings sub-section claims to persist across reloads but doesn't (10479).
- UsersAdmin "Send reset email" claims success even when the server says the login wasn't
  found (5212) — CustomerDetail's version handles it correctly.
- Branding public-page toggle overwrites the whole publicBrand object instead of merging (3166).
- Backups: Logins snapshots labeled "customers" in three places (works fine, wrong words).
- Creating a login with an email that already exists silently keeps the OLD password and adds a
  duplicate row (db.js merge-by-email) — the temp password the admin typed never works.
- Restricted admin's initial tab can render the full Dashboard once before the allow-list
  kicks in (4904) — cosmetic exposure.
- DraftBar "Saved to cloud ✓" reacts to ANY store save, not just the section you saved (4131).
- One Rate box pick doesn't pre-fill Department in the order ship modal (UI only; booking
  fills it correctly) (8953).
- Order "Detail" component and `src/quote.js` are dead code; src/quote.js is a stale,
  auth-less duplicate of the deployed quote function — delete so it can never be deployed by
  mistake.
- LabelPreview "public welcome logo" fetch on the landing page is fetched, never used (5799).
- CompanyAddressDeploy filters `status!=="deactivated"` but the server writes `"disabled"` —
  the exclusion never fires (6126).

## PART 5 — WHAT CHECKED OUT CLEAN

- **Every backend endpoint referenced by the UI exists** — all db.js actions (auth, 2FA,
  trusted devices, backups, company admin, API keys), quote/ship/fedex/email/printnode/
  places/hs-lookup, and all 14 connector functions. No dead fetch targets anywhere.
- **Sign-in / sign-up / email verification / 2FA / trusted devices**: full path UI → server
  verified, including backup codes, reset flows, and the 30/60/90 trust window.
- Label preview modal (all 12 buttons), service list, orders page, order ship modal, shipments,
  pickups, quick quote, scan, dashboard tiles, batch pipeline (import, saved batches,
  autopilot, create & print), returns/manifests/reports, product catalog (proper CSV parser),
  box logic, doc-tab designer, print settings, notifications, address book (except CSV import),
  connectors/integrations, 2FA panel, customize/deploy, carrier accounts, subscription, drafts,
  invoices, transit/carrier audits, address autocomplete.
- Admin: dashboard drill-downs, customers master + detail (all 9 tabs, atomic delete +
  tombstone, auto-fork off the shared Default profile), users admin (approve/deny, portal
  access, 2FA reset), backups (restore + pick-and-merge preserves passwords), FedEx cert lab,
  API playground/docs/reports, billing numbering & double-billing guards, customizations.
- Rates plumbing: draft/save/undo/reset everywhere, profile create/rename/delete with
  reassignment fallback, bulk quick-set confirms, imports (CSV/TSV/XLSX, One Rate), printable
  sheets/CSV export, margin view, wipe-guards server-side.

## Suggested fix order

1. Hooks-order crash on cross-tab sign-out (#2) — one-line move, kills a white-screen.
2. Assistant Send button (#1) — one-line fix, front-and-center feature.
3. Ship-tab country drop (#6) — international orders misquote as domestic.
4. Rates multi-tab draft clobber (Part 1.3) — data loss; at minimum warn when another rates
   draft is dirty.
5. `createdAt` on the two create paths (#13) — re-arms an existing data-loss guard.
6. Route-to-Printer field + Starter Rules button (#3, #4).
7. Label/tracking email honesty (#7) — either pass tracking + gate on booked label, or relabel.
8. Decide the Shopify-checkout pricing question (Part 1.1) — likely by design, but confirm the
   raw-cost-vs-sell-cost basis is what you want merchants to see.
