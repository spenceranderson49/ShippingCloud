# Admin Portal Audit — findings only

Scope: the admin portal in `src/App.jsx` (~13,009 lines): `AdminPortal` (4402), `AdminDashboard` (3254), `CustomersMaster` (3815), `CustomerDetail` (3409), `RatesAdmin` (3928), `UsersAdmin` (4648), `CustomizationsAdmin` (4584), `Branding` (3059), `Domains` (3008), `PlatformAccountsAdmin` (4512), `FedexCertLab` (3127), plus the stores they write (`rateRules`, `clients`, `users`, `featureFlags`, `settings`).

Severity = impact on the owner's daily workflow. Fix size = what it takes to implement tonight (small = <30 min, medium = 1-2 h, large = an evening).

---

## 1. REDUNDANCY — same thing editable in two (or three) places

### 1.1 HIGH — Rate rules editable through TWO independent drafts of the same store; last save silently wipes the other
- Where: `RatesAdmin` (src/App.jsx:3929-3931) and `CustomerDetail` rates tab (src/App.jsx:3414-3416). Both do `usePersist("rateRules")` + their own `useDraft` copy of the ENTIRE rules object (all profiles, all customers' assignments, baseCosts, dimDivisors).
- Behavior difference: none in math — same store, same engine. But the drafts are independent whole-object snapshots. `useDraft` (3892-3903) only follows the committed store while its own draft is clean. The AdminPortal tab model lets both be open at once (a customer tab plus the "rates" section tab via `openSection("rates")`, src/App.jsx:3654, 4463). Edit customer A's markup in their tab, edit a base-cost import in RatesAdmin, save both → whichever saved second overwrites the first's committed changes with its stale copy of that part of the object. Same hazard with two customer tabs open.
- Fix (medium): make Save merge instead of replace — commit only the keys the draft actually changed (diff draft vs base, patch the current committed value), or block/flush: when a second rateRules draft goes dirty, show "unsaved rate changes in another tab" and disable Save until the other is saved/undone. The diff-merge in `useDraft.save` is ~20 lines and fixes every instance at once.

### 1.2 HIGH — Rate-profile assignment editable in THREE places, one of which writes live
- Where: (a) `CustomerDetail` rates tab "prices from" select (src/App.jsx:3581) → goes through the draft, needs Save; (b) `RatesAdmin` "Assign customers" panel + per-customer select (src/App.jsx:4167-4181) → draft, needs Save; (c) `UsersAdmin` per-login "Rates: X" button (src/App.jsx:4757, 4765-4773) → `setRateRules` from `usePersist` directly (4649) — **commits instantly, no DraftBar, no undo**.
- This is exactly the "rate-adjacent edit that still writes live" the owner wants gone, and it's per-login UI for a per-company setting (confusing: changing it on one login changes every login of the company — the copy admits this).
- Fix (small): delete the `rpOpen` select from UsersAdmin (4650, 4757, 4765-4773) and make the "Rates: Default" chip a link that opens the customer's record (rates tab). Keep CustomerDetail as the canonical place; RatesAdmin's assign panel is fine as bulk view.

### 1.3 HIGH — Dim divisors editable in two places, both "platform-wide", inside per-customer context
- Where: `RatesAdmin` → "Dim divisors" tab (src/App.jsx:4236-4250) and `CustomerDetail` rates tab inline row (src/App.jsx:3567-3578). Identical fields, same `rules.dimDivisors`, but each sits in a different draft (finding 1.1 applies). Also confusing: a control on a single customer's screen that changes every customer.
- Fix (small): remove the inline dim-divisor row from CustomerDetail's rates tab, replace with a one-line note + link "Dim divisors (platform-wide) → Rates section". Keeps one editor, one draft.

### 1.4 MED — Weight-break editors: two different UIs with different capabilities on the same data
- Where: `CustomerDetail` rates tab breaks editor supports per-zone % and per-break Min $ and a "standard ranges" seeder (src/App.jsx:3614-3640); `RatesAdmin` services tab breaks editor is upTo/% only — no zones, no min, no seeding (src/App.jsx:4225-4229). Both write `services[k].breaks` on the same profiles. An owner who sets a break Min $ in CustomerDetail then opens RatesAdmin can't even see it.
- Fix (medium): extract the CustomerDetail breaks editor into a shared component and use it in both places (or drop the breaks UI from RatesAdmin entirely and send people to the customer tab).

### 1.5 MED — Accessorial rules: inline-table edit vs double-click modal for the same rows
- Where: `CustomerDetail` rates tab edits surcharge type/amount inline in the table (src/App.jsx:3662-3680); `RatesAdmin` surcharges tab requires discovering **double-click** to open a modal (src/App.jsx:4282, 4331-4345). Double-click is the only affordance and is invisible; the two screens also group rows differently (category chips + one list vs four segment boxes).
- Fix (small): in RatesAdmin, make the row single-click (or add a visible Edit button) and reuse the inline editing pattern; note the modal copy at 4341-4342 says changes "hit quotes immediately" which is no longer true under the draft — stale copy, fix the text.

### 1.6 MED — Per-login feature toggles in three sections (same `featureFlags` store, three pivots)
- Where: `UsersAdmin` → "Tabs & logo" checkbox list per login (src/App.jsx:4774-4809); `CustomizationsAdmin` → chip per login per feature (src/App.jsx:4610-4616); `CustomerDetail` → Features tab, all-logins-at-once toggles (src/App.jsx:3773-3796). All write the same flags identically (`setFlag`/`setCompanyFeature`), so no divergence — but three places to look for "why does this customer see the Batch tab?".
- Fix (medium): keep two pivots at most. CustomerDetail Features (by company — the owner's mental model) + CustomizationsAdmin (by feature — rollout view). In UsersAdmin, reduce "Tabs & logo" to the per-login logo upload plus a link "Features → customer record", or leave it but this is the first candidate to fold.

### 1.7 MED — Customer identity duplicated across CustomersMaster row / CustomerDetail / UsersAdmin
- Name/contact/email shown in CustomersMaster (3866) and editable in CustomerDetail profile (3491-3494) — fine (read vs edit). But **login name/email are editable in two places with different behavior**: CustomerDetail logins tab edits them as raw inputs live on keystroke (src/App.jsx:3530), UsersAdmin shows them read-only (4750). Live-editing an email is dangerous in cloud mode where email is the login key and passwords are keyed by email (`setPassword` by email, 3465).
- Fix (small): make login name/email read-only in CustomerDetail's logins tab (or edit-pencil → prompt), matching UsersAdmin.
- Also duplicated: "Log in as", "Password", "Co. admin", enable/disable, delete — present per-login in both UsersAdmin (4756-4763) and CustomerDetail logins tab (3532-3536). Behavior is identical (same code patterns). Acceptable, but if you slim one, slim UsersAdmin's row and keep the customer record as the working surface.

### 1.8 MED — Login→customer assignment fixable in three places
- `UsersAdmin` orphan panel (src/App.jsx:4675-4696), `CustomersMaster` "Logins with no customer" panel (3876-3883), and implicit per-login via customer record. The two warning panels have different copy and slightly different semantics (orphans = dead clientId; unassigned = null clientId) — a login with a dead ID appears only in UsersAdmin, one with no ID only in CustomersMaster.
- Fix (small): merge both conditions into one panel (show in CustomersMaster, since that's the daily screen) covering `!clientId || !clientIds.has(clientId)`.

### 1.9 LOW — Two "new customer" forms and two delete-customer paths
- New-customer form in `CustomersMaster` (3849-3857) and a third dead one in unused `CustomersAdmin` (4539-4547; see 5.1). Delete on the CustomersMaster row hover (3864) and in CustomerDetail → Notes tab (3809) with different confirm wording. Fix (small): keep row delete only, or move delete to a proper "Danger zone" at the bottom of the profile tab — Notes is a weird place for it.

### 1.10 LOW — Section has two names depending on how you reach it
- Sidebar item says "Rates & dim divisors" (`NAV_GROUPS`, src/App.jsx:4440); the same section opened from a customer record is titled "Advanced rates — tables & sheets" (`SECTION_META.rates` override, 4444 — the comment there even claims rates is "off the sidebar", which it isn't). Also `ADMIN_SECTIONS` (line 91) and `NAV_GROUPS` (4437-4442) are two parallel lists of the same sections that must be kept in sync by hand.
- Fix (small): derive NAV_GROUPS items from ADMIN_SECTIONS (single source), pick one label.

---

## 2. UNNECESSARY — things the operator never needs / that do nothing

### 2.1 HIGH — PlatformAccountsAdmin: an entire admin section of toggles that are read by nothing
- Where: `PlatformAccountsAdmin` (src/App.jsx:4512-4529), sidebar "Experience → Carrier accounts". It toggles `settings.platforms` (ups/usps/amazon/uniuni). Grep of all reads: the ONLY consumers are this component and the identical toggle block inside Settings → Carrier accounts (`CarrierAccounts`, 12329-12330). No quote path, service list, or booking path reads `settings.platforms` — the platform is FedEx-via-England only. So this is (a) a dead feature toggle set and (b) a duplicate of a Settings-page control.
- Fix (small): remove the `platforms` section from ADMIN_SECTIONS/NAV_GROUPS and delete `PlatformAccountsAdmin`; optionally also delete the duplicate toggle block in `CarrierAccounts`. One fewer sidebar item the owner has to wonder about.

### 2.2 HIGH — CustomerDetail "Label preferences" tab: every field written, none ever read
- Where: src/App.jsx:3747-3759. `prefs.labelSize/labelFormat/defaultService/signature/packingSlip/packaging/residentialDefault/saturdayOk/emailLabels` are written to the client record. Grep of reads: the ship flow uses **the login's own `settings.printer`** (10234, 10474-10497) and per-shipment choices; no code path reads `client.prefs` for any of these. The owner can set "ZPL, 4×6, adult signature" here and nothing anywhere changes — worse than useless, it's misleading.
- Fix (small tonight / medium properly): delete the tab (small), or wire the three that matter (defaultService, residentialDefault, signature) into the customer's quote defaults (medium). Recommend delete now, wire later if asked for.

### 2.3 MED — Address tab: business + billing address and "default ship-from" checkbox are write-only
- Where: src/App.jsx:3505-3525. `c.address`, `c.billing`, `prefs.shipFromBusiness` have zero readers (ship-from comes from `settings.sender` / `client.origin` at 6161, 6568 — only `origin` on the profile tab is real). The checkbox at 3516 literally promises behavior that doesn't exist.
- Fix (small): remove the "Use this address as their default ship-from" checkbox (it lies); keep the address block only if the owner wants it as a rolodex — if so, retitle "Address (reference only)". The billing-address block has no billing feature behind it — remove.

### 2.4 MED — FedEx tier tab: two account-number fields, one real, one dead — plus a page of reference-only fields
- Where: src/App.jsx:3721 (`fx.accountNumber` — READ by `englandFor` at 360, drives real quoting/booking) vs 3726 (`fx.acctNo` — never read anywhere). Two fields labeled "FedEx account #" on the same tab; filling the wrong one silently does nothing. That's a booking-outage-by-typo waiting to happen.
- The rest of the tab (tier, earnedTier, effective, review, fuel, rep, minCharge, billPeriod, oneRate checkbox, notes — 3727-3744) is reference-only except `listDiscount`/`svcDisc`, which feed the useful "Apply this tier to rates" button (3710-3718).
- Fix (small): delete the `fx.acctNo` field, keep the single real one with its explanation; collapse the reference fields into a labeled "Reference only — doesn't affect pricing" group so the two live controls (account #, list-discount + apply) stand out.
- Also note: "Apply this tier" mutates the **rates draft** (`upRules`) from the FedEx tab, where no DraftBar is visible — see 4.4.

### 2.5 MED — CustomerDetail "Credentials" tab is a static info panel
- Where: src/App.jsx:3799-3805 — no controls, just a note that England creds live in Settings → Carrier accounts. A whole tab for one sentence. Fix (small): drop the tab, put the sentence at the top of the FedEx tier tab (which is the actual per-customer credential surface).

### 2.6 MED — Domains section: a registry that registers nothing
- Where: `Domains` (src/App.jsx:3008-3056). `settings.domains` is written here and read nowhere else; the "live/pending DNS" badge is a manual toggle (3046) with no check behind it; actual white-label serving is done in Netlify + DNS as the info box admits (3051-3054). Also its `clients` prop is unused.
- Fix: if white-labeling is a real current activity, keep it as a checklist but retitle honestly ("Domain checklist — tracking only"). If not (solo operator, one brand): remove from the sidebar (small). At minimum drop the fake status toggle.

### 2.7 LOW — FedexCertLab ("FedEx labels" in Pricing group)
- Where: src/App.jsx:3127-3249. This is certification tooling: generate sandbox labels, download PDFs, submit to FedEx. Once certification is done and `FEDEX_ENV=production` is set, its day-to-day value is only the connection-status header. It sits under "Pricing" where the owner looks for rates.
- Fix (small): after certification, either remove it from ADMIN_SECTIONS or move the status pill into the Rates screen / Settings → Carrier accounts and retire the lab. Not urgent; it's self-contained.

### 2.8 LOW — Supplies tab is a structured notepad
- Where: src/App.jsx:3761-3771. `prefs.supplies` has no readers — no reorder flow, no packout report. It's fine as CRM notes if the owner actually uses it; otherwise fold into the Notes tab. Fix (small if removing).

### 2.9 LOW — Profile-tab fields with no readers
- `plan` (3498; only reader is dead code at 4564), `acctNo` "Account number (yours)" (3499), `website` (3500), `volume` (3502) are write-only. `since` is display-only in dead code. Fix (small): cut to Company/Contact/Email/Phone/Origin/Status + notes; every removed field makes the ones that matter (Origin ZIP feeds quoting at 6161) more findable.

---

## 3. SMOOTHNESS — friction in the common flows

### 3.1 Flow timings as built
- (a) **New customer's markup + services**: Customers → New customer (form incl. markup) → Create & open → Rates tab → set markup → **Save rates** → Services tab → uncheck. ~8-10 interactions but linear and good — `createCustomer` auto-opens the record (3840), the best flow in the portal. One wrinkle: markup appears in the create form AND on the Rates tab; the profile tab then says "Markup is set on the Rates tab — the only place pricing is edited" (3496), which the create form contradicts. Fix (small): drop markup from the create form, let the record's Rates tab be the single place (it opens right after create anyway).
- (b) **Today's margin**: Dashboard default period is Today; "Est. margin" stat is immediately visible (3312). 1 click. Good.
- (c) **"What did customer X pay for shipment Y?"**: weak — see 3.2/3.3.
- (d) **Block a service for one customer**: Customers → open customer → Services → uncheck. 4 clicks, instant-write, works (`blockedServices` is read throughout the quote paths, 6748 etc.). Good.

### 3.2 HIGH — No shipment search anywhere in admin; no per-customer shipment history
- The dashboard feed (3352-3378) is the only shipment surface and has **no search box** — not by tracking, not by customer, not by reference. To answer "what did X pay for Y" the owner sets a period and eyeballs up to 400 rows. `CustomerDetail` has 11 tabs but **no Shipments/History tab** at all — the one question a customer will actually phone about has no direct answer path.
- Fix (medium): add a text filter over `inP` in AdminDashboard (match customer/tracking/service — one `useState` + one `.filter`, ~10 lines), and add a "Shipments" tab to CustomerDetail that filters `platform.ships` by the customer's logins/name (requires passing `platform` or ships into CustomerDetail — plumbing exists via AdminPortal).

### 3.3 HIGH — Dashboard feed doesn't link customers to their records (the prop is already there)
- `AdminDashboard` receives `openCustomer` (3254) and never calls it — customer names in the live feed (3361), the drill-down (3334, 3340), and the by-customer rollup (3387) are plain text. The wiring exists one level up (4464/4481); the dashboard just doesn't use it. Note the feed's customer key is a display name (`custOf`), so linking needs a name→client lookup (clients aren't passed in — add the prop).
- Fix (small): pass `clients`, resolve name→id, wrap the name cells in a button calling `openCustomer(id)`. This single fix removes the "see something odd on the dashboard → go to Customers → search the same name" bounce.

### 3.4 MED — UsersAdmin list has no search or sort
- Where: 4746-4821. Every login on the platform in creation order, with up to 8 action buttons per row. CustomersMaster got search+sort (3844-3845); the logins list didn't. With 30+ logins, finding one is a scroll hunt.
- Fix (small): copy the CustomersMaster search/sort pattern (name/email filter, sort by last login).

### 3.5 MED — CustomerDetail has 11 tabs; ~5 are write-only dead ends
- TABS (3473): profile, address, logins, rates, services, fedex, labels, supplies, features, creds, notes. Findings 2.2-2.9 kill or shrink address/labels/supplies/creds and half of fedex/profile. Cutting them isn't just cleanup — it changes the daily experience of opening a customer from "which of 11 tabs?" to ~6 meaningful ones (profile, logins, rates, services, fedex, notes).
- Fix (medium): apply section 2 removals; this is the highest-leverage "get rid of the unnecessary" item.

### 3.6 LOW — Rail click drops open customer tabs
- `railPick` (4462) and the sidebar-driven effect (4457-4461) replace the whole tab set, closing any open customer records without warning — including ones with an unsaved rates draft (draft state lives inside CustomerDetail and dies on unmount). Combined with 4.4 this can silently discard rate edits.
- Fix (medium): keep customer tabs when switching sections (only swap the section tab), or confirm before dropping a tab whose draft is dirty (needs a dirty-flag lift or a `beforeunload`-style registry).

### 3.7 LOW — Hourly chart drops evening/early-morning shipments
- Buckets run 6am-8pm only (3277); a 9:30pm label lands in daily/weekly but silently vanishes from "Today — hourly", so the day's totals and hourly bars disagree. Fix (small): extend to actual data range or 0-23.

### 3.8 LOW — Loading-state banner repeats three times
- The `partial` "loading platform-wide data" strip renders inside each of the three Combo charts (3288). Fix (small): render once above the grid.

---

## 4. CONSISTENCY — same concept, different patterns

### 4.1 HIGH — Draft-vs-instant is inconsistent exactly where money is involved
Committed-instantly (no DraftBar, one keystroke = global write via the persist bus + cloud queue):
- `UsersAdmin` rate-profile assignment (4768) — **rate-adjacent, writes live** (finding 1.2).
- `CustomerDetail` profile/services/fedex/labels/supplies/notes — every keystroke writes `clients` (upClient at 3424). Services toggles are fine instant; but the **FedEx account number** (3721) is a live credential edit with no confirm — a half-typed account number is briefly the live booking account for that customer.
- `CustomizationsAdmin` / UsersAdmin feature flags — instant (acceptable for toggles).
- `Domains`, `PlatformAccountsAdmin` — instant (moot if removed).

Drafted (press-to-save): rates in both RatesAdmin and CustomerDetail (good — this is the owner's stated preference), Branding (local state + Save, 3060-3063).

Fix (medium): the two that matter are 1.2 (delete the live rate-assign control) and the FedEx account field (debounce + explicit "Save account #" button, small). Document the rule: anything that changes a price or a credential is drafted; toggles/notes may be instant.

### 4.2 MED — Branding mixes draft and instant in the same panel
- The whole Branding form is a draft with a Save button, EXCEPT the "public welcome page" toggle (3103), which calls `setPublicBrand` instantly, and Reset (3064) which commits instantly without confirm. Two adjacent toggles, opposite semantics.
- Fix (small): fold `publicBrand.showLogo` into the draft object and write it on Save; add a confirm to Reset.

### 4.3 MED — DraftBar exists but RatesAdmin/CustomerDetail also hand-roll a second footer save bar
- RatesAdmin has DraftBar at top (4142) plus a duplicate bottom bar (4393-4397); CustomerDetail rates tab likewise (3548 top, 3682-3687 bottom) — the bottom bars lack DraftBar's cloud-save confirmation states, so the same Save button reports differently top vs bottom.
- Fix (small): reuse `DraftBar` (or a slim variant) for the bottom bars, or drop the bottom bars.

### 4.4 MED — "Apply this tier to rates" writes the rates draft from a tab with no draft UI
- src/App.jsx:3710-3718: the button on the FedEx tier tab mutates the shared rates draft via `upRules`, flashes "Applied…", but the DraftBar lives on the Rates tab — if the owner doesn't visit Rates and press Save (or the tab gets dropped, 3.6), the "applied" change evaporates. The flash message says it's done when it isn't.
- Fix (small): after applying, jump to the rates tab (`setTab("rates")`) where the amber "Unsaved changes" bar is visible, and change the flash to "Staged — press Save rates to make it live."

### 4.5 LOW — Four toggle idioms, several money/date formats
- Toggles: `Toggle` component (Branding 3102), hand-rolled pill (PlatformAccountsAdmin 4524, CustomerDetail features 3780), checkboxes (UsersAdmin 4779), chip buttons (CustomizationsAdmin 4613). Money: `money()` in dashboards, raw `"$"+x.toFixed(2)` in rate sheets/modals, `num2` defined-and-unused (3978). Dates: `toLocaleDateString()` (Domains "created"), `YYYY-MM` string (`since`), free-string `lastLogin`, numeric month/day in charts. None of these breaks anything; standardize opportunistically when touching each section (small each).
- RatesAdmin hide-row tooltip (4219) and CustomerDetail's (3612) both reference "the checkbox turns the rule off", but the on/off checkbox lives on a different tab (Services) — stale copy. Fix (small).

---

## 5. DEAD WEIGHT in admin-only code

### 5.1 HIGH (as risk of divergence, not user impact) — `CustomersAdmin` is defined and never rendered
- src/App.jsx:4530-4583 (~55 lines). Not in `sectionBody` (4472-4482), not referenced anywhere else. It contains a *third* new-customer form, a second markup editor, and — notably — the only UI for per-client England credentials (`c.england`, 4568-4576) including the double-markup warning. But `englandFor` (352-361) explicitly **ignores `c.england`** ("Per-customer England fields are ignored"), so even alive this editor would write dead fields. Delete the whole component, plus `CustomerDetail`'s unused `upEng` helper (3427).

### 5.2 MED — Computed-but-unused platform/login stats in AdminPortal
- `platform.total/t30/rev/latest/shippers` (4423-4427) and `loginStats.recent` (4433) are computed every render and read by nothing (AdminDashboard uses only `ships/_partial/openOrders/margin` and `total/active/week`). `latest` sorts a copy of all shipments each time. Fix (small): delete the dead fields.

### 5.3 MED — Unused props and state
- `AdminPortal`: `ledger` prop accepted (4402), never used.
- `AdminDashboard`: `openCustomer` prop never used (see 3.3 — wire it rather than delete it).
- `CustomerDetail`: `settings` prop never used (3409).
- `Domains`: `clients` prop never used (3008).
- `AdminPortal`: `const [launch,setLaunch]=useState(false)` (4468) — the "+ Open" launcher it belonged to is gone; both are unused.
- `RatesAdmin`: `num2` helper (3978) unused.
- Fix (small): delete each.

### 5.4 LOW — ADMIN_SECTIONS vs NAV_GROUPS vs sectionBody triple-list
- Line 91 (`ADMIN_SECTIONS`, used for permissions + the sidebar-driven admin build via 6229), 4437-4442 (`NAV_GROUPS`, used for the in-tab rail), 4472-4482 (`sectionBody` keys). Today all nine keys line up in all three; nothing enforces it, and 4444's stale comment shows they already drifted once. Fix (small): build NAV_GROUPS from ADMIN_SECTIONS and add a dev-time assert that every section key has a sectionBody branch.

### 5.5 LOW — `scrubLegacyDefaults` (4959-4967) hardcodes a former customer's name/address to scrub
- One-time migration for "Riley Blake Designs" seed data that now runs on every settings load. Harmless; remove once confident no device still carries the old seed.

---

## TOP 10 — ranked by "makes the owner's day smoother tonight"

1. **Link dashboard → customer records and add a feed search** (3.2 + 3.3, small+medium). The dashboard is where every day starts; today it's a dead end. Wire `openCustomer` on customer names; add tracking/customer text filter.
2. **Delete the write-only CustomerDetail tabs/fields** (2.2, 2.3, 2.5, 2.8, 2.9 → 3.5, medium). 11 tabs → ~6; nothing the owner sets stops silently doing nothing.
3. **Remove the dead `fx.acctNo` FedEx-account field** (2.4, small). Two identical-looking fields where only one books labels is the single most dangerous piece of UI in the portal.
4. **Kill the live rate-profile select in UsersAdmin** (1.2, small). Last rate-adjacent control that writes globally without press-to-save.
5. **Make rateRules Save merge-by-diff (or single-draft guard)** (1.1, medium). Prevents the silent cross-tab overwrite of saved rate work — invisible until it costs real money.
6. **"Apply tier to rates" → jump to Rates tab + honest message** (4.4, small). Stops "I applied it but the quotes didn't change".
7. **Remove PlatformAccountsAdmin section (and its Settings duplicate)** (2.1, small). One less sidebar item; zero functionality lost because it had none.
8. **Add a Shipments tab to CustomerDetail** (3.2 second half, medium). Directly answers "what did X pay for Y" from the customer's record.
9. **Search/sort on the UsersAdmin list** (3.4, small). Copy the pattern from CustomersMaster.
10. **Delete dead code: `CustomersAdmin`, `upEng`, unused platform stats, unused props/state, `num2`** (5.1-5.3, small). ~120 lines gone, and removes the trap of "improving" the England-per-client editor that nothing reads.

Honorable mentions if time remains: single dim-divisor editor (1.3), unify weight-break editors (1.4), fold `publicBrand` toggle into the Branding draft (4.2), merge the two orphan-login panels (1.8), drop markup from the create-customer form (3.1a), extend hourly chart to 24h (3.7).
