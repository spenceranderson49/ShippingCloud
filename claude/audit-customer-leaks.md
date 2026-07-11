# Customer-Facing Internal-Language Leak Audit

Date: 2026-07-11 · Scope: `src/App.jsx` (~13k lines) + `netlify/functions/*.js` · FINDINGS ONLY, no code changed.

**Ground rules applied:** "Customer-reachable" = rendered in any component NOT gated on `currentUser.role==="admin"` / `isAdmin` (App.jsx:6151) — i.e. every main tab (Ship, Orders, Shipments, Pickups, Batch, Autopilot, Invoices, Returns, Scan, Dashboard) and **all of Settings** (Settings sections default to policy `"on"` for customers — App.jsx:9752-9755 — including **Carrier accounts**; only demo loses Billing/Subscription). The demo visitor is `role:"customer"` (App.jsx:4872), so every customer finding below also applies to demo unless noted. Admin screens (AdminPortal at 6347, RatesAdmin, CustomerDetail, AdminDashboard, CustomersMaster, Branding, FedexCertLab) are correctly gated and their England/markup/margin/tier content was verified as admin-only — not reported.

**Key error plumbing (why server strings matter):** raw server `error` strings surface verbatim to customers in at least six places:
- Ship tab rate strip: `Estimated rates · ${rateSrc.error} …` — App.jsx:7158 (not admin-gated)
- Ship tab rose banner: `String(rateSrc.error).slice(0,300)` — App.jsx:7168-7171
- Ship tab booking status: `shipStatus.msg = res.error` — App.jsx:6889 → rendered 7305
- Orders modal booking: App.jsx:8037, 8262
- Batch per-row results: App.jsx:9228 → rendered 9448; Autopilot run: 11074 → 11171
- Settings → Carrier accounts test/diag: App.jsx:12353, 12363, 12424
(The admin-only rate diagnostic at App.jsx:7160-7164 — "Tried England on your main account… England rejected this key/ID pair" — IS correctly gated on `role==="admin"`, so it is not listed as a leak.)

---

## Section 1 — LEAKS (customer-reachable internal language)

### A. Ship / Shipments / Orders flow — "England" and "Webship" in plain sight

**L1 · HIGH · App.jsx:7302** — `Order pushed to England — waiting for it to book and return the label…`
Renders: Ship tab booking status strip, any customer booking a label on an England-backend site.
Replace: "Booking your label — waiting for the carrier to confirm…"

**L2 · HIGH · App.jsx:7304** — `Order is staged in your England account. Ship it in Webship (or turn on auto-ship), then go to Shipments → "Check for labels" to pull the label & tracking here.`
Renders: Ship tab, pending-timeout state. Names both the wholesaler and its internal tool, and tells the customer to use software they don't have.
Replace: "Your label is still being prepared by the carrier. Check Shipments → 'Check for labels' in a few minutes — or contact support if it doesn't appear."

**L3 · HIGH · App.jsx:8465** — `{n} order(s) staged in England, waiting to book in Webship. Once you ship it/them there (or auto-ship books it/them), pull the label + tracking here.`
Renders: Shipments tab amber PendingBar (all logins).
Replace: "{n} order(s) waiting on the carrier to finish the label. Click 'Check for labels' to pull tracking as soon as it's ready."

**L4 · HIGH · App.jsx:8461** — success toast `…still not booked in Webship`, and the error path shows the return of **App.jsx:6134** `"Connect England first"` (checkPendingLabels).
Renders: Shipments tab after clicking "Check for labels".
Replace: "…still processing with the carrier" / "Live label pickup isn't enabled on this account — contact support."

**L5 · HIGH · App.jsx:8505** — `window.confirm("Void this label?\n\n… Until England void is wired, also void it in Webship to trigger the carrier refund.")`
Renders: native confirm dialog on Shipments → Void label — every customer voiding a label reads this.
Replace: "Void this label?\n\nIt will be marked Voided here. The carrier refund is processed automatically; contact support if you don't see it within a few days."

**L6 · HIGH · App.jsx:8073** — `Demo rates — connect England`
Renders: Orders tab expanded row (rate cell), whenever live rates aren't available for a customer.
Replace: "Estimated rates — live pricing unavailable right now"

### B. Pickups — markup mechanics printed on a customer tab

**L7 · HIGH · App.jsx:8599 (strings built at App.jsx:1481 and 1486)** — the on-call pickup fee note renders `_pf.ruleDesc` + `— edit it on the Rates tab accessorials (Pickup & returns)`. `ruleDesc` values customers can see: **`account markup +20%`**, `your rule: fee + 25%`, `your rule: list − 10%`, `your rule: flat $X`, `FedEx default`.
Renders: Pickups tab fee box; `showCosts` comes from the `pickupCosts` feature which **defaults to true** (App.jsx:84, wired at 6342). This literally prints the customer's markup percentage on their own screen, plus an instruction pointing at an admin-only screen ("Rates tab accessorials") the customer cannot reach.
Replace: for non-admin, show only "On-call pickup fee" + amount; keep `ruleDesc` behind `isAdmin`.

### C. Settings → Carrier accounts (visible to every customer & the demo by default — App.jsx:9743/9777, policy default "on")

**L8 · HIGH · App.jsx:12349** — diag result: `No FedEx provider account on your customer. Providers found: … Add your FedEx account in Webship → Admin Settings → Carrier/Provider Accounts, or ask England to provision it.`
Renders: "Check booking access" button result (button NOT gated by SHOW_ENGLAND or role).
Replace: "This account isn't enabled for booking yet — contact support and we'll switch it on."

**L9 · HIGH · App.jsx:12351** — `Provider-accounts check returned HTTP {status}. Your API key isn't permitted to list/book — England must enable booking on your key.`
Same surface as L8. Replace: "Booking isn't enabled for this account yet — contact support."

**L10 · HIGH · App.jsx:12424** — `England said: {raw wholesaler response}` — hardcoded label + raw England API payload dump, NOT gated by SHOW_ENGLAND.
Renders: after a failed "Test connection". Replace: remove for non-admin, or "The rate service said: …" with a sanitized message.

**L11 · HIGH · App.jsx:12363** — `test.msg = res.error` passes through backend errors: `England HTTP 401: …`, `England returned no rates for this shipment.`, `Missing England API key or customer ID.` (see L18/L19 sources).
Replace: map to "Couldn't connect — check with support." for non-admin.

**L12 · HIGH · App.jsx:12358-12361** — a successful "Test connection" prints the platform's **raw account cost** for six services — `Connected — N live services returned (cheapest {money(cost)})` and detail lines `{label} — {money(cost)} (list {money(list)})`, plus `⚠ These look like LIST rates, not your account rates — the account may not carry discounts.`
Renders: Settings → Carrier accounts, any customer or demo visitor who clicks Test connection. `cost` here is the quote function's ACCOUNT rate — the **owner's raw England-billed cost**, pre-markup (client-side `rateSellFor` is never applied to this display). Exposes the owner's cost AND list-rate mechanics.
Replace: hide the Test connection tooling from non-admins entirely, or price the sample through the customer's rules before display and drop the "(list …)" and LIST-rate warning.

**L13 · HIGH · App.jsx:12325 + 12433 + 12442** — `const PROVIDERS=[{id:"england",name:"England Logistics API"},…]`; the "Add carrier account" provider dropdown and the saved-account subtitle show **"England Logistics API"**, and the form defaults to `provider:"england"` (12328) with an "England customer ID" field (12436).
Renders: Settings → Carrier accounts "Your own carrier accounts" panel for any customer with the `byoCarrier` feature (the feature's own admin description at App.jsx:89 even says "England always shows").
Replace: remove the England provider from the customer-facing dropdown (keep FedEx/UPS); if a BYO-England option must exist, label it generically ("Managed FedEx account").

**L14 · HIGH · App.jsx:5881 (renders at App.jsx:11542, selector at 7313-7314)** — default seeded settings contain `thirdPartyAccts:[{id:"tp1",carrier:"FedEx",account:"20601652",label:"England FedEx"}]` and `england:{…,account:"20601652"}`.
Renders: Settings → Billing "third-party accounts" list shows carrier + account number + label "England FedEx" to any customer on a fresh local-mode login. Leaks the wholesaler's name AND what appears to be the owner's real FedEx account number 20601652.
Replace: seed `thirdPartyAccts:[]` (like the demo seed at 4943 already does) and blank the account default.

**L15 · MED (HIGH on the England mirror build) · App.jsx:12400, 12404, 12408-12412, 12415, 12419, 12425** — the SHOW_ENGLAND panel: header "England Logistics — live rates", fields "England API key" / "England customer ID", the Webship how-to ("In Webship: gear/settings → eCommerce Integrations …"), the "Refresh rates" tooltip ("…use after changing pricing in England's backend"), and the env-var note naming `ENGLAND_API_KEY` / `ENGLAND_CUSTOMER_ID`.
`SHOW_ENGLAND` (App.jsx:147) is a **site-level build flag** (`VITE_CARRIER_BACKEND=england`), not a role gate — on the england.freightwireship.com build, every customer and demo visitor sees all of it.
Replace: additionally gate the whole panel on `isAdmin`.

**L16 · MED · App.jsx:12370, 12381-12382** — flush messages: `No England customer IDs configured yet.`, `Rates refreshed for N England account(s)… every quote now pulls fresh from England.` Only reachable via the SHOW_ENGLAND "Refresh rates" button — same exposure as L15.
Replace: "Rates refreshed — every quote now pulls fresh pricing."

### D. Server responses that reach customer screens

**L17 · HIGH · netlify/functions/quote-england.js:240, 324, 325** — `Missing England API key or customer ID.` · `England HTTP {status}: {detail}` (plus `england_status`/`england_response` fields) · `England returned no rates for this shipment.`
Surfaces: Ship tab rate strip (7158) and rose banner (7168-7171), Orders rate cell, and Settings test (L11) whenever `CARRIER_BACKEND=england`.
Replace server-side: "Live rates are temporarily unavailable ({status})." — keep the England detail in a server log or an admin-only field.

**L18 · HIGH · netlify/functions/ship-england.js:116, 170, 171, 174, 224** — `Missing England API key or customer ID.` · `No England carrier account matches '{code}'. England has: … Enter the provider account ID in Settings → England.` · `England returned no carrier accounts to ship on (HTTP {status}). Ask England to enable booking/provider-accounts on your key…` · `Couldn't look up your England carrier account: … Enter your provider account ID in Settings → England.` · `England HTTP {status}: …`
Surfaces: Ship tab booking error banner (7305), Orders modal (8037/8262), Batch rows (9228→9448), Autopilot run (11074→11171). Note "Settings → England" isn't even a real section name customers can find.
Replace: "Booking failed — the carrier account isn't set up for this service. Contact support." (log the detail server-side).

**L19 · HIGH · netlify/functions/quote.js:106 (duplicated in src/quote.js:106)** — `CARRIER_BACKEND=england is set but quote-england.js isn't deployed or failed: {message}` — returned as the quote `error`, so it lands on the customer Ship tab via 7158/7170.
Replace: "Live rates are temporarily unavailable — showing estimates."

**L20 · MED · netlify/functions/quote.js:153** — `FedEx isn't configured: set FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET and FEDEX_ACCOUNT in Netlify (normal vars, then redeploy).`
Surfaces: Ship tab rate strip/banner for every customer if the site is misconfigured. Env-var names + Netlify + reveals the single-platform-account architecture.
Replace: "Live rates aren't available yet on this site." (admin detail via a separate flag/log).

**L21 · MED · netlify/functions/ship.js:258** — `Ground Economy needs your FedEx SmartPost hub id — set FEDEX_SMARTPOST_HUB in the site's environment…` → shipStatus error banner (7305) on a customer booking attempt.
Replace: "Ground Economy isn't enabled on this account yet — pick another service or contact support."

**L22 · MED · netlify/functions/fedex.js:346, 371** — `Missing FedEx API key/secret (set FEDEX_API_KEY and FEDEX_SECRET_KEY env vars).` / `Missing FedEx account number (set FEDEX_ACCOUNT env var).`
Surfaces: Pickups tab error box (App.jsx:8587/8573 pass `res.error` straight through) when scheduling/cancelling pickups on a misconfigured site.
Replace: "Pickup scheduling isn't available right now — contact support."

**L23 · MED · netlify/functions/db.js:227, 249** — `Cloud database isn't configured yet (SUPABASE_URL / SUPABASE_SERVICE_KEY env vars).` · `Database error: … Check the SQL setup step and env vars.`
Surfaces: login / signup screens (Login pipes `d.error` into the on-screen error, App.jsx:2946-2958 region). Names Supabase + internal setup steps to anyone at the login page.
Replace: "We're having trouble reaching the server — try again in a moment."

**L24 · MED · netlify/functions/assistant.js:144** — `The assistant isn't configured yet — set ANTHROPIC_API_KEY in Netlify and redeploy.`
Surfaces: in-app chat bubble for customers/demo if the key is missing.
Replace: "The assistant is offline right now — try again later."

**L25 · MED · App.jsx:2936 and 5180** — forgot-password: `Reset emails aren't switched on for this site yet — no email was sent. (Admin: add RESEND_API_KEY in Netlify env vars and redeploy.)` — shown to any visitor using "Forgot password".
Replace: "Reset emails aren't available yet — contact support to reset your password." (Related source: netlify/functions/email.js:59.)

**L26 · MED · App.jsx:1368, 1370, 1372, 1375** — Integrations connector instructions shown in customer Settings → Integrations modals: "Send them to your admin to set as QBO_CLIENT_ID / QBO_CLIENT_SECRET in Netlify, or set them yourself.", "…set them as SF_CLIENT_ID / SF_CLIENT_SECRET in Netlify.", "Set EBAY_CLIENT_ID… in Netlify.", "Have an admin set QBWC_USER and QBWC_PASS in Netlify…"
Internal hosting/env-var machinery in customer-facing copy. Replace: "Contact support to finish connecting {service}" or hide the env-var steps behind isAdmin.

### E. Legal / terms (decision needed — likely intentional, but it names the mechanics)

**L27 · MED (flag for a business decision) · App.jsx:5285 and 5310** — Terms of Service shown from the public landing/login footer (LegalLinks, App.jsx:5264+): §1 "We are a software platform and **shipping reseller**…" and §6 header "**Markup and reseller pricing**" — "Prices shown to you may include **our margin** over negotiated carrier rates and do not necessarily reflect the carrier's own list or account rate."
This is deliberate legal disclosure and removing it has legal implications — but it is the one place a curious customer can read the words markup/margin/reseller. If softened, suggested §6 wording: "Pricing — Prices shown are our own retail rates and may differ from carrier-published or carrier-account rates." Get sign-off before changing.

**L28 · LOW · App.jsx:6020** — unresolved logins get `name:"(unknown customer — c1234…)"`. The old warning banner was removed (comment at 7137), but this synthetic name can still flow into shipment records (`client:` at 6140) and any UI that prints the client name. Replace fallback name with the login's own name or empty string.

---

## Section 2 — POLISH (redundancy, terminology, leftovers)

**P1 · HIGH · App.jsx:5259-5260 + netlify/functions/assistant.js:97** — placeholder support phone `(801) 555-0123` (a 555 number) is live on the public landing page (`CONTACT_PHONE`, comment even says "← REPLACE with your real number") and is what the AI assistant tells customers to call for pricing/billing. Must be replaced before launch.

**P2 · MED · App.jsx:2968** — signup success note: `Account request submitted. In production this would await admin approval; for now you can sign in with the demo accounts below.` Dev-scaffolding copy on the signup flow (local mode). Replace with real approval-pending copy.

**P3 · MED · brand mixing: "ShipHub AI" on the ShippingCloud brand** — the assistant is hardcoded as ShipHub AI everywhere regardless of brand: App.jsx:5651 ("Hi, I'm ShipHub AI!"), 5689 ("Ask ShipHub AI"), 5706 ("Powered by ShipHub AI"), 5708, 8481 ("Ask ShipHub AI about shipments" button on the Shipments tab), and netlify/functions/assistant.js:76/95 ("You are ShipHub AI… Refer to yourself as ShipHub AI") even when `product` is ShippingCloud. Suggest `${BRAND.product} AI` / a brand-keyed assistant name.

**P4 · MED · netlify/functions/email.js:36, 45, 64** — shipped-notification emails are hardcoded ShippingCloud: the `Shipping**Cloud**` logo header, footer default "Sent by ShippingCloud on behalf of the sender.", and default from `ShippingCloud <notify@shippingcloud.net>`. Recipients of ShipHub/FreightWire customers get the other brand's email. Parameterize by brand.

**P5 · MED · inconsistent insurance terminology** — the same concept is called: "Insure $" / "Insure $/box" (Ship tab, App.jsx:7105, 7129; Customize toggle "Hide the Insure $ field" 12131), "Insurance $" (Quick quote 8731, order modal 8425, CI options 8313, doc editor 11718), "Declared value" (7273, 7457, 10111), "Insurance / declared value" (7520, 8531), "Declared value coverage" (2069), and ship.js:268 says "(Insure $ / per-box values)". Pick one ("Declared value" matches FedEx) and use it everywhere.

**P6 · MED · two wordings for the same offline-rates state** — Ship tab: "Estimated rates… — turn on live rates in Settings → Carrier accounts to price with your real account" (7158) vs Orders tab: "Demo rates — connect England" (8073, also leak L6) vs Quick quote: just "Estimated" (8734). Align on one phrase; also "turn on live rates in Settings → Carrier accounts" is a confusing instruction for customers who don't control the platform account.

**P7 · MED · Settings → Carrier accounts shown to every customer by default** (App.jsx:9743, policy default "on") — even without `byoCarrier`, customers see a screen inviting them to toggle "Use live FedEx rates" and enter a "FedEx account # (optional override)" (12404, 12413) — platform plumbing that shouldn't be theirs to touch. Suggest defaulting the `carriers` section policy to off/locked for non-admin, non-byoCarrier logins.

**P8 · LOW · App.jsx:4530-4580** — `CustomersAdmin` is **dead code** (defined, never rendered; the live screen is `CustomersMaster` at 3815). It contains England credential fields, the double-markup warning, and markup editors — delete it to remove drift/leak risk.

**P9 · LOW · App.jsx:8537** — dead branch `{false&&isAdmin&&…<Info k="Cost → margin"…>}` right below the live admin-gated version (8533). Remove.

**P10 · LOW · App.jsx:10111 + 10114** — doc/receipt field is labeled "**Your cost**" and the default receipt line label is "**Cost**", but it prints the customer's own price (`cost:(r.sell??r.cost)` at 1788). Rename the field to "Rate" or "Total charged" for consistency with the Shipments breakdown (8532 "Total charged") — and note the `?? r.cost` fallback would print the owner's raw cost in the rare case a record has `cost` but no `sell` (older/admin-booked records); prefer `r.sell` only.

**P11 · LOW · App.jsx:5273 vs 5278** — footer link "Billing & rate accuracy" vs modal tab "Billing & Rate Accuracy" — inconsistent capitalization of the same destination.

**P12 · LOW · App.jsx:89** — byoCarrier feature description says customers connect accounts "on the Connections page", but the actual section is called "Carrier accounts" (nav: 9743). Admin-facing copy, but it will confuse whoever supports customers.

**P13 · LOW · src/quote.js** — a full copy of the Netlify quote function (England comments, env-var docs and all) lives inside `src/`. It isn't imported by the client (api.js posts to the endpoint), but it's a stray duplicate that will drift from `netlify/functions/quote.js`; move or delete.

**P14 · LOW · App.jsx:6102** — shipped-notification subject hardcodes a cloud emoji: `Your {company} order has shipped ☁️` — the ☁️ is ShippingCloud-brand flavored; drop or brand-key it (pairs with P4).

Not leaks (checked, fine): `"england":"GB"` country-name maps (App.jsx:235, quote.js ISO2) are invisible data; localStorage keys and code comments throughout; the assistant system prompt (assistant.js) never mentions England/markups and explicitly refuses to discuss internals; packing slips, labels, commercial invoices, tracking emails, and the Shopify checkout rates (shopify-rates.js:239-243) carry no internal language; Reports/Shipments CSV exports use `sell` only (9584); the Invoices cost-audit compares against `sell` (12758 region); the customer-facing "Buyer markup (%)" in Checkout rates (9672) is the customer's own markup on their buyers — legitimate feature wording.

---

## Count summary

| Category | HIGH | MED | LOW | Total |
|---|---|---|---|---|
| Leaks (Section 1) | 14 (L1–L14, L17–L19) → 17 items at HIGH | 10 (L15, L16, L20–L27) | 1 (L28) | **28** |
| Polish (Section 2) | 1 (P1) | 6 (P2–P7) | 7 (P8–P14) | **14** |
| **Grand total** | | | | **42 findings** |

Highest-impact fixes before launch, in order:
1. **L7** (Pickups prints "account markup +X%" to the customer — the single most direct markup exposure),
2. **L12** (Test connection shows the owner's raw cost + list rates to any customer/demo),
3. **L1–L6** (England/Webship strings across Ship/Shipments/Orders),
4. **L17–L19** (sanitize England server error strings — one server-side change kills many UI leaks at once),
5. **L14** (seeded "England FedEx" third-party account with a real account number),
6. **L8–L13** (Settings → Carrier accounts England strings) — or simply gate that whole section behind isAdmin (P7),
7. **P1** (placeholder 555 support phone on the public site and in the AI's mouth).
