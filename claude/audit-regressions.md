# Regression audit — builds v449→v465 (staging, audited 2026-07-11)

Scope: `git log origin/main~2..origin/staging` (c854b09 v449 → 04a2296 v465), src/App.jsx + netlify/functions/*.
Line numbers reference the committed HEAD at audit time (36ad02d / origin/staging 04a2296 — **note:** uncommitted WIP edits (api.js, api-engine.js, db.js, App.jsx) landed in the working tree *during* this audit and shift line numbers below ~8000 by up to ~90 lines; those WIP files are out of scope).

Mechanical checks: `node --check` passes on all 34 functions; `VITE_BRAND=shippingcloud npx vite build` passes. All findings below are logic bugs verified against the code; uncertain items are marked PLAUSIBLE.

---

## CRITICAL

### C1. Slip composer serializes quantities in a format its own parser can't read — qty always prints as 1
`src/App.jsx:8392-8395` vs `parseItemsList` at `src/App.jsx:1621-1627` (v465)
`slipEditPrint` builds `itemsStr` as `"3 × Widget"` (qty **prefix**), then immediately reprints via `slipFromShipment` → `parseItemsList`, whose regex `/(.*?)(?:\s*[x×]\s*(\d+))?$/` only recognizes a **trailing** `x/× N`. Result (verified by executing the regex): Item = "3 × Widget", Qty = 1 — wrong on the feature's own happy path, first print included; reopening the composer shows the mangled row. Also (LOW) item names containing `,` or `;` split into separate rows on save/reprint.
**Fix:** emit `r.name+" x"+r.qty`, or better store structured `lineItems: rows` on the shipment and have `slipFromShipment` prefer `lineItems` (it currently parses only `sh.items` while `openSlipEdit` reads `sh.lineItems` — asymmetric).

### C2. Draft restore books labels with NO signature (books ≠ quoted)
`src/App.jsx:6629` (commitDraft) + `:7015` (restore) + v464 `useState` sig at `:6332-6333`
`commitDraft` snapshots only the boolean `signature`, never `sigOption`; restore calls `setSig(s.signature)` but never `setSigOption`. Post-v464 `sigOption` is deterministically the mount default (usually `"none"`), and booking sends `signatureOption:sigOption` (ship.js:209 reads only `signatureOption`). A draft saved with Direct signature books **unsigned**, while the stale `signature===true` mislabels the record/preview as signature-required. Pre-existing snapshot gap that v464 turned from "sometimes accidentally right" into "always wrong".
**Fix:** snapshot `sigOption` in commitDraft; on restore `setSigOption(s.sigOption||"none"); setSig((s.sigOption||"none")!=="none")`.

### C3. Signature silently resets to None on every tab switch, while the rest of the form persists
`src/App.jsx:6332-6333` (v464 `useState`) + `:6260` (`tab==="ship"&&<Ship/>` — Ship unmounts on tab switch)
v464 intended "signature defaults to None on every page open", but Ship remounts on every **tab** switch. Receiver, pieces, reference, insurance, residential, saturday all survive via `usePersist`; signature snaps back to default. Scenario: fill shipment → set Direct signature → hop to Orders to check something → return → form looks identical but signature is None → book an unsigned label. Harder to notice than the bug it fixed.
**Fix:** keep the persist but clear it once per real page load (module-level boot flag / sessionStorage), or lift sig state to the parent that owns `tab`.

---

## HIGH

### H1. quote.js `listBase` can double-subtract the same fee and go NEGATIVE — "FedEx list − %" rules undercharge
`netlify/functions/quote.js:313-323` (v452), consumed at `src/App.jsx:2552-2575` + `:2504` (no clamp anywhere)
`listBase = list − listSurTotal`, then additionally `− acctOnly` (account-detail fees with no same-label LIST line). Two failure modes, neither clamped at 0:
1. **Double subtraction:** a fee worded *differently* between the ACCOUNT and LIST details (the comment itself says "worded differently between the two details") is subtracted once via `listSurTotal` (list wording) and again via `acctOnly` (account wording). listBase lands below the true list base → every `basis:"list"` service rule sells too low.
2. **Negative:** when account-only fees (e.g. declared-value fee itemized only on the account detail) exceed the remaining base on a cheap shipment, `listBase` goes negative; `rateSellFor` computes `sell = list*(1-disc/100)` on the negative number. With no rule-Min/account-Min set the customer sees a negative/near-zero price.
**Fix:** clamp `listBase = Math.max(0, …)` server-side; when subtracting `acctOnly`, cap the subtraction so listBase never drops below, say, the account base (`cost − feeCost`); consider fuzzy label matching so the same fee isn't counted on both sides.

### H2. Quick-quote form is clobbered by the Ship snapshot after ANY visit to the Ship tab
`src/App.jsx:6647` (snapshot ts) + `:8620-8630` (seed) (v455)
The Ship tab stamps `window.__scShipSnap = {ts:Date.now(),…}` in an effect that runs on **every mount** — and Ship's form is fully persisted (`ship.receiver`, `ship.pieces`, … at 6319-6334), so the "anything typed on Ship" condition is almost always true. QuickQuote re-seeds whenever `qqForm._seedFrom !== s.ts`. So: type on Ship → open QQ (seeds) → edit the QQ shipment → close → click the Ship tab (view only, change nothing) → reopen QQ → your QQ edits are silently replaced by the Ship data. The code comment promises "reopening Quick quote without touching Ship keeps whatever you changed here" — untrue whenever Ship merely remounts. Same root cause makes "Clear quote" undo itself: `clearQuote` drops `_seedFrom`, so the next QQ open re-seeds from Ship.
**Fix:** derive the snapshot identity from content (hash of the snapshot fields), not `Date.now()`; keep `_seedFrom` on Clear.

### H3. Department field is sticky-persisted and never cleared — stale DEPARTMENT_NUMBER prints on later labels
`src/App.jsx:6322` (usePersist) vs `applyOrder` `:6526` and `newShipment` `:7019` (v465)
`applyOrder`/`newShipment` reset `invoiceNo`/`poNo` (with a comment about exactly this carry-over hazard) but **not** `department`; the draft-restore path doesn't apply `snap.department` either. Worst case: One Rate auto-fill in `department` mode (`:6563`) writes "FedEx Medium Box" once into the persisted field and it then rides as `DEPARTMENT_NUMBER` on every subsequent FedEx label (including non-One-Rate, across reloads) until manually cleared; if the admin later hides the field (`hideDept`) the stale value keeps being sent invisibly (booking payload includes `department` unconditionally, `:6893`).
**Fix:** `setDepartment("")` in applyOrder/newShipment; snapshot+restore department in drafts.

---

## MED

### M1. Orders "Est rate" chip prices weight breaks at actual weight, not billable — disagrees with every other surface
`src/App.jsx:7707` (LiveEstRate) vs `:9017` (order modal), `:11043` (Autopilot), `:8666` (QQ), `:6715` (Ship) (v452)
v452's claim is "weight breaks and list tables resolve by billable (dim) weight everywhere", and every surface passes `weight: ruleWeightFor(pieces,…)` — except LiveEstRate, which passes `weight: Math.max(1,Math.ceil(wt))` (actual weight) while quoting with the default 12×9×4 box (bills at 4 lb dim). A 1-lb order with weight-break rules shows an Est-rate priced from the 1-lb break while the modal/Batch/Autopilot price the same order from the 4-lb break — the orders list disagrees with what booking will charge.
**Fix:** `weight: ruleWeightFor([{weight:wt,L:12,W:9,H:4}],q.label)` (use the same default box as `ratesForOrder`).

### M2. Ship-tab shipment records never carry `department` — doc tabs / reprints show it blank
`src/App.jsx:6755` (`buildRec` includes reference/invoiceNo/poNo, not department) vs `recToDocCtx` `:1780` and `DOCTAB_FIELDS` `:10162` (v465)
v465 added Department to the doc-tab field list, but the main booking path (Ship tab) never saves it to the shipment REC, so a doc-tab zone bound to "Department" is always empty for Ship-tab bookings. Order modal's `baseRec` (`:8281`) has the same gap.
**Fix:** add `department` to `buildRec` and `baseRec`.

### M3. Order-ship modal drops `department` — One Rate "Department field" fill mode does nothing there
`src/App.jsx:8289-8290` (v465)
`_orFM = orFillMerge({reference,invoiceNo,poNo}, orBoxRefFill(...))` can produce `_orFM.department`, but the `bookOrderLabel` opts pass only `reference/invoiceNo/poNo` — `orderToEngland` (`:372`, which does read `opts.department`) never gets it, and no other field gets the box name. With Settings → Reference fields = "Department field", every One Rate label booked from the order modal loses the box annotation (Ship/Batch/Autopilot paths are correct via `..._orFill`). The modal also has no Department input.
**Fix:** pass `department:_orFM.department||""` in the opts at :8290.

### M4. England backend (`CARRIER_BACKEND=england`) silently drops `department`
`netlify/functions/ship-england.js:178-190`
`refBits` packs reference + `PO …` + `INV …` into `shipmentReference` but never `o.department` ("department" appears nowhere in the file). ship.js:151-152 delegates whole requests to it, so on England-backed sites the v465 "printed on FedEx labels" claim is false.
**Fix:** append `o.department ? "DEPT "+S(o.department) : ""` to `refBits`, mirroring PO/INV.

### M5. Welcome email can silently never send (fixed 4s race against the debounced cloud write)
`src/App.jsx:3476-3477` vs `netlify/functions/db.js:376-382` (v461)
`createLogin` fires `requestReset welcome:true` after a fixed `setTimeout(4000)`. If the debounced `putMany` fails once (retry at 10s), or the admin closes the tab within 4s (the pagehide beacon saves the user but the timeout dies), or other writes stretch the shared debounce timer, the server's `users.find(email)` misses and returns the anti-enumeration generic `{ok:true}` — no email, no error, while the admin was already told the welcome email "is on its way". (Otherwise the welcome branch is clean: all variables — `verifyToken`, `b64u`, `sign`, `u`, `wordmark` — are in scope; both `${isWelcome?…}` HTML branches are coherent (72h "Set my password" vs 1h reset); non-admins sending `welcome:true` just degrade to a normal 1h reset.)
**Fix:** server-side `createLogin` action that writes + emails atomically, or trigger the email off the confirmed save event and surface `found:false` to admin callers.

### M6. Password-reset tokens are accepted as full session tokens by every carrier gate (and db.js) — v461 stretches them to 72h
`netlify/functions/quote.js:117-126` (and the identical scAuth in ship/fedex/fedex-ship/ups/assistant/hs-lookup/places/*-england), `netlify/functions/db.js:382,433`
The v449 gates only check `d.uid && d.exp`; the pwreset token minted at db.js:382 has both (plus `kind:"pwreset"` which nothing checks). db.js's own session gate (line 433 `verifyToken`) has the same gap. A reset link (sitting in an inbox, 1h — now **72h** for v461 welcome links) is therefore a valid credential for booking labels, quoting, and reading/writing that uid's data namespaces, without ever setting a password.
**Fix:** reject `kind==="pwreset"` in `verifyToken`/`scAuth` for anything except `resetPassword`.

### M7. email.js verifies tokens with a different secret than db.js mints them — emails silently break when SESSION_SECRET is unset
`netlify/functions/email.js:20` vs `netlify/functions/db.js:43` (pre-existing, but now the odd one out — all v449 gates use the fallback)
db.js (and every v449 scSecret) falls back to `sha256("sc1|"+SUPABASE_SERVICE_KEY)` when `SESSION_SECRET` is unset; email.js HMACs with the raw (empty) `SESSION_SECRET` only. On a site relying on the derived secret, every shipment-notification email returns `authFailed` and is silently dropped (the app just logs it).
**Fix:** copy the `scSecret()` fallback into email.js.

### M8. CustomerDetail Shipments tab: unsorted multi-login feed + blind 300-row cut ("newest first" is false)
`src/App.jsx:3770` (v460)
`const rows=(ships||[]).filter(…).slice(0,300)` — no sort; `platform.ships` concatenates per-login arrays in snapshot-key order (built ~:4393-4412). A customer with 2+ logins sees login A's whole history then login B's (dates jump backwards mid-table); with >300 rows the slice can drop **all** of login B including the newest shipments, while the header promises "newest first".
**Fix:** sort by date desc before `.slice(0,300)`.

### M9. FedEx-tier "apply discount" writes through to the shared Default profile (bypasses the fork safeguard)
`src/App.jsx:3705-3712` (touched by v459; write path pre-existing)
`applyTierToRates` maps `profiles` directly via `upRules`. If the customer sits on the shared `"default"` profile this reprices **every** Default customer — the exact hazard the `forkProfile` comment at :3448 says can never happen; all other per-customer edits fork first. v459 only added `setTab("rates")`+toast (staging into the draft — that part is fine).
**Fix:** route through `forkProfile` when `prof.id==="default"`.

### M10. Multi-piece quotes put the FULL insurance amount on EVERY piece — PLAUSIBLE
`src/App.jsx:8638` (QuickQuote, v454) and `:6628` (Ship, when "DV each" is off)
`declaredValue:(+insurance||0)` is applied per piece, so 3 boxes + $1,000 insurance declares $3,000 total and FedEx prices (and books) 3× the DV fee, while `insuranceAmount` still says $1,000. Quote and booking are at least consistent with each other, and this may be intended "per-package value" semantics — but it disagrees with the single total-coverage field the user filled in. PLAUSIBLE money-wrong; confirm intended semantics.
**Fix (if unintended):** split `insurance/nPieces` per piece, or only attach DV to piece 0, matching the `insuranceAmount` total.

---

## LOW

- **L1. QuickQuote drops the `dvPriced` warning** — `src/App.jsx:8656` discards `res.dvPriced`; Ship surfaces `dvPriced===false` as a rose warning (`:7106`), QQ shows nothing when FedEx failed to price requested declared value. (v454)
- **L2. Required-department toast prints "undefined"** — `src/App.jsx:6875`: `need.push("department")` but `labelMap` has no `department` entry → "Receiver needs: undefined". (v465)
- **L3. deptRequired/deptLocked enforced only on the Ship tab** — Batch (`:9281`) and Autopilot (`:11138`) book without the required-field check; One Rate auto-fill writes a non-pick-list value into a locked field (`:6563`). Matches the pre-existing ref/inv/PO behavior, but the "required" toggle over-promises. (v465)
- **L4. AdminDashboard `cidOf` resolves by display-name equality, first match wins** — `src/App.jsx:3276`; two same-named clients → clicking a feed row opens the wrong customer record. Prefer `x._uid → users.find(...).clientId`. (v459)
- **L5. UsersAdmin rates chip can misreport the effective profile** — `src/App.jsx:4698`: deleted-profile assignment displays "Default" while the engine falls back to `profiles[0]` (`:3435`), which need not be Default. Also `setRateRules` (`:4577`) is now declared-but-unused. (v459)
- **L6. Reset-email button always alerts "sent"** — `src/App.jsx:3480,4689`: the server's anti-enumeration generic `{ok:true}` makes the admin UI claim a link was sent to disabled/unknown logins. Return `found` to admin-authenticated callers. (v461)
- **L7. Slip composer item names containing `,`/`;` split into separate rows** on save/reprint — same root cause as C1. (v465)
- **L8. Dead code left by v459/v460** — `PlatformAccountsAdmin` component (`:4494`) + `ADMIN_SECTION_ICONS.platforms` (`:92`) unused; CustomerDetail orphans `SUPPLY_ITEMS`/`upAddr`/`upPrefs`/`fa`/`pf`/`supplies` (`:3420-3488`). No crashes — verified no remaining references, no dangling nav keys, default tab valid.
- **L9. `src/api.js` is a dead client that posts to quote/ship WITHOUT a token** — no importers today, but any future use silently hits the v449 gate (`authFailed`). Delete or add the token.
- **L10. AdminDashboard feedQ deps omit `users`** — `src/App.jsx:3269-3274`: after a user rename, searching the new name won't match until `ships` changes identity. Cosmetic; no crash (all fields `String(v||"")`-guarded).

---

## Verified clean (checked, no bug found)

- **Session gates (v449):** every client call site sends `token:CLOUD.token` — getLiveRates (:327), shipCall (:426), fedexCall (:1395) (fedexTransit/fedexValidateAddress both route through it), placesCall (:1386), assistant (:5597), hs-lookup (:6450/:11627), ups test (:12375), fedex-ship status/ship (:3140/:3147), flushCache (:12358), email (:5983), sendBeacon putMany (:4985). `scAuth` is actually invoked in all 10 gated functions. Server-to-server: warm-rates (ESM→CJS `quoteFn.handler` works; sends `internalKey`) and shopify-rates (`internalKey`) are correct; track-sync talks to FedEx/Supabase directly, no gated calls. Places autocomplete is only used post-login (AddressCard → Ship). Sign-out reloads the page, so `window.__scShipSnap` cannot leak across logins. Gate correctly stands down only when neither SESSION_SECRET nor SUPABASE_SERVICE_KEY exists (bare local dev).
- **Rate engine (v449/v452):** empty-surcharge wrapper path is coherent (no double account-floor: inner call skips via `_noSurAdj`, wrapper floors the total at :2512); flat rules exempt from the floor on both paths (:2511-2512, :2579-2582); One Rate cost-null rows price via flat rules or hide (:2516-2525, :2032-2036); `ruleWeightFor` is NaN-safe (missing dims → `Math.max(ceil(weight),1)`, no caller passes empty pieces).
- **Quick quote (v454/455):** `cleanServiceList` dedupe is sound — OneRate keys (`or_*`) never collide with base services (rateSvcKey :2289-2304); skeleton→live swap keeps the priced row; residential==null exception keeps Ground+Home until classified (:1437, Ship passes `addrClassified?residential:null`). liveOR suppression correct (quote.js emits `_oneRate`/`or_` keys). `_seedFrom` persisting in qqForm is benign cross-device.
- **v461 welcome branch scoping:** `verifyToken` et al. all in scope in db.js; template literal valid; welcome flag admin-gated; `sendReset` defined in the scope that uses it (CustomerDetail :3480/:3529; UsersAdmin uses its own inline handler).
- **v464:** no leftover readers of removed sig persist keys; applyOrder/auto-sig/Autopilot/newShipment set both sig states coherently; order modal seeds from `o.signatureOption`.
- **v465 slip composer:** setShipments mapping preserves fields; portal z-[9998] above all other overlays; icons imported. PrintNode guide (v462/463) static and well-formed.
- **v459/v460:** Shipments-tab `lg` is declared (:3469) before `uidSet` (:3769) — no TDZ; margin math NaN-guarded; `CustomersAdmin` fully removed (zero references); removed CustomerDetail tabs have no dangling nav keys or deep links; removed `fx.acctNo` field has zero readers/writers.
- **Mechanical:** `node --check` clean ×34; production vite build clean.

---

## Ranked fix list

1. **C1** slip composer qty round-trip (feature broken on happy path) — App.jsx:8392 / :1621
2. **C2** draft restore books unsigned labels — App.jsx:6629/:7015
3. **C3** signature resets on tab switch — App.jsx:6332/:6260
4. **H1** listBase double-subtraction / negative → list-basis undercharge — quote.js:313-323
5. **H3** sticky department prints on wrong labels — App.jsx:6526/:7019/:6563
6. **H2** Ship snapshot clobbers Quick-quote edits — App.jsx:6647/:8620
7. **M6** pwreset tokens pass all session gates (72h welcome links) — db.js:382/:433, quote.js:117
8. **M5** welcome email 4s race → silently never sent — App.jsx:3476, db.js:376
9. **M9** tier-apply writes to shared Default profile — App.jsx:3705
10. **M1** Est-rate chip wrong weight basis — App.jsx:7707
11. **M2/M3/M4** department gaps (REC, order modal, England backend)
12. **M8** Shipments tab unsorted + truncated — App.jsx:3770
13. **M7** email.js secret mismatch — email.js:20
14. **M10** multi-piece DV duplication (confirm semantics first) — App.jsx:8638/:6628
15. L1-L10 as cleanup.
