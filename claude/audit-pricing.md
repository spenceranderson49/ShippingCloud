# Deep pricing audit — 2026-07-11

Scope: `src/App.jsx` (rateSellFor engine + 6 quoting surfaces), `netlify/functions/quote.js`, `netlify/functions/ship.js`.
Method: line-by-line trace of every ctx construction, the BASE/FEE wrapper, floors, One Rate keying, and quote-vs-book payloads. No files edited. Line numbers are exact as of this commit.

Legend: **[C]** critical (money wrong today) · **[H]** high · **[M]** medium · **[L]** low/informational.

---

## 1. Cross-surface consistency (same shipment, different price)

### F1 [C] OrderShipModal double-charges signature on live quotes
- `src/App.jsx:8197` (rate request sends `signatureOption:sigOption`) + `src/App.jsx:8216` (`applyAccessorials(q,{signatureOption:sigOption,...})` applied unconditionally, live or not).
- quote.js:133-146 puts the signature on every package of the rate request, so FedEx prices it **inside `cost` and itemizes it in `surcharges`**; rateSellFor's fee loop then sells that line (rule/markup/pass-through). applyAccessorials then adds the **local** signature fee a second time.
- Numeric: Direct signature, live Ground quote. FedEx cost $20.00 incl. itemized "Direct Signature Required" $6.55. rateSellFor (no rules) → sell $20.00 (fee passed through). applyAccessorials adds $6.55 again → customer sees **$26.55**; correct is $20.00. Overcharge = full signature fee on every signed modal shipment.
- The Ship tab already has the fix pattern: `src/App.jsx:6759` passes `signatureOption:_live?"none":sigOption` and `insuranceList:_live?null:...`. The modal (8216) and QuickQuote (below) don't.
- Fix sketch: in OrderShipModal pass `signatureOption: rateSrc.live?"none":sigOption` to applyAccessorials (insurance is OK there today because ratesForOrder sends no per-piece declaredValue — but see F8: the honest fix is to send DV to the quote AND book it, then suppress both local fees when live).

### F2 [C] QuickQuote double-charges signature on live quotes (same mechanism)
- `src/App.jsx:8652` sends `signatureOption:sigOption` to getLiveRates → FedEx itemizes the fee; `src/App.jsx:8667` then `applyAccessorials(q,{signatureOption:sigOption,...})` with no live-guard.
- Same $6.55/$8.05 overcharge as F1 whenever a signature is toggled in Quick quote with a live account.

### F3 [H] QuickQuote rule-weight drops ounces; every other surface includes them
- `src/App.jsx:8667` ctx weight: `pieces.reduce((a,p)=>a+(+p.weight||0),0)` — lb field only.
- Ship tab `src/App.jsx:6759` uses `totalWeight` = Σ(lb + oz/16) (`pw` at 6525). Modal 8213 same (lb+oz at 8160).
- Numeric: box of 4 lb 12 oz, service rule with weight break "up to 4 lb = 30%, over = 20%". QuickQuote resolves weight 4 → 30% markup; Ship tab resolves 4.75 → 20%. Cost $20 → QQ sell $26.00, Ship tab $24.00 for the identical shipment. Same skew for `basis:"list"` table lookups (4 lb row vs 5 lb row).
- Fix: use the same `totalWeight` (already computed at 8638) in the QQ ctx.

### F4 [H] Batch preview prices from local estimates while booking prices live — and from a different origin ZIP
- Preview: `src/App.jsx:9013-9018` `computeRate` uses `quoteRates(...)` (hardcoded demo RATES, `fromZip:client.origin`) even when `canBook` is true; the row price, group subtotals (9147) and the "Auto — {label}" caption all come from it.
- Booking: `src/App.jsx:9175` re-rates live with `fromZip:originZip` where `originZip=settings.sender.zip||client.origin` (8963), then charges `picked.sell` (9195+record).
- Two divergences: (a) demo-table estimate vs live FedEx cost; (b) if `client.origin ≠ settings.sender.zip`, even zoneEst-driven rules resolve different zones between the displayed and the booked price.
- Numeric: client.origin 10001, sender.zip 84101, dest 30301. Preview zone ≈2 (NYC→ATL is not, but zoneEst(10001,30301)=4 vs zoneEst(84101,30301)=6): a rule with zone %s (z4=20, z6=35) shows cost×1.20 in the table but books/charges cost×1.35.
- Fix: preview through `ratesForOrder`+rateSellFor when canBook (or at minimum use `originZip` in computeRate's ctx and quoteRates call).

### F5 [M] fromZip precedence differs per surface (zone rules flip)
- Ship tab 6595: `sender.zip → client.origin → settings.sender.zip`.
- OrderShipModal 8158: `settings.sender.zip → client.origin`.
- Orders Est column (LiveEstRate) 7748: `client.origin → settings.sender.zip` (reversed).
- Orders inline row: rate call uses `fromZip` (=settings.sender.zip||client.origin, 7996) but the **sell ctx** at 8012 uses `(settings.sender.zip)||""` only — if only client.origin is set, the live rate is correct but the rule ctx has no fromZip → `zoneEst` never runs → zone/list rules silently fall back to service %/account markup.
- Autopilot 11029: `settings.sender.zip → client.origin`.
- Any account where `client.origin ≠ settings.sender.zip` gets different zone-rule pricing for the same order depending on which screen quotes it.
- Fix: one shared originZip helper used by all six ctx builders.

### F6 [M] No surface uses billable (dim) weight for rule/list lookups
- All six ctxs pass **actual** scale weight (Ship 6759, modal 8213, LiveEst 7756, batch 9018, autopilot 11058, QQ 8667). FedEx's returned `cost`/`list` are dim-weight priced; `LIST_2025`/imported `list:` tables and weight breaks are keyed by *billable* weight.
- Numeric: 20×20×20 box, 5 lb actual → billable ceil(8000/139)=58 lb. `basis:"list"` with listYear 2025, zone 4: lookup uses the 5 lb row (~$15 list) instead of the 58 lb row (~$90). "List −30%" sells ~$10.50 against a live cost of ~$60 — the rule.min/markupMin floors are all that stands between this and selling far below cost. With listYear 2026 + live `c.list` the base is fine (FedEx's list is dim-weighted), so the bug bites exactly when 2025 book/imported tables or weight breaks are in play.
- Fix: compute billable weight per service family (the `billable()`/`dimFor()` helpers already exist at 204) and pass that as ctx.weight, or pass pieces and resolve inside rateSellFor.

### F7 [M] Quoted weight is ceil'd per piece, ctx weight is not
- getLiveRates (322) sends `Math.ceil(+p.weight||1)` per piece (correct: FedEx bills next full lb); every ctx passes the un-ceiled sum. For integer-lb list tables the `find(r=>+r[0]>=w)` lookup lands on the same row, but weight-break boundaries (`+c.weight<=+x.upTo`) disagree: a 2 lb 2 oz piece is FedEx-billed as 3 lb, yet a break "upTo 2.5" still claims it. Low dollar impact, but breaks are defined against billing weight in the admin's mental model. Fix: `Math.ceil` (per piece) before summing into ctx.weight.

### F8 [M] Declared-value handling differs by surface
- Ship tab: shared "Insure $" is applied **per box** — quote request carries it on every piece (6677) and estimate fees use `insuranceList` per box (6759).
- QuickQuote: `insurance` charged **once per shipment** (8667, `opts.insurance`), and never sent per-piece to FedEx (8652 shipPieces have no declaredValue) — so a 3-box $500-each QQ live quote adds one $4.60 local fee while the Ship tab's live quote for the same shipment carries 3 FedEx-priced DV surcharges (~$13.80) inside cost.
- OrderShipModal: single box, local fee only (ratesForOrder pieces carry no declaredValue) — quoted locally but **never booked** (see F10).

---

## 2. applyAccessorials interaction

### F9 [clean-with-caveat] Saturday is never double-counted today — because quote.js silently ignores it
- getLiveRates sends `saturdayDelivery` (322) but quote.js never reads it: no `SATURDAY_DELIVERY` shipmentSpecialServices in the rate request (quote.js:148-158). So FedEx never itemizes Saturday and the only Saturday money on a quote is applyAccessorials' flat `fees.sat` (default $16, admin SAT rule). No double count on any surface — verified.
- The caveat: ship.js **does** book `SATURDAY_DELIVERY` (ship.js:190), so the real FedEx invoice carries the true tariff Saturday charge while the customer paid the local flat fee and the shipment record's `cost` (q.cost) excludes it. If the tariff fee ≠ configured $16, margin is silently wrong on every Saturday label; and if anyone "fixes" quote.js to request Saturday, every surface that passes `saturday` into applyAccessorials (Ship 6759 included) instantly double-counts. Fix: price Saturday in the rate request (parity with signature/DV) and gate the local fee on `!live`, mirroring the signature pattern.
- Signature/DV double-count on live quotes: broken in modal + QQ (F1/F2), correct on Ship tab. Estimate (demo) mode: quoteRates already adds $6.15 signature into cost (302) and applyAccessorials adds the fee again — demo-only, cosmetic. [L]

---

## 3. One Rate

### F10 [L] Rule keying, hidden/blocked, alias, preference matching — clean
- Live OR rows (quote.js key `or_<svc>`, label "… OneRate - Medium Box") are always priced/filtered by **label**: rateSvcKey(label) → `or_<svc>_<box>` matches per-box rules; canonSvc strips the box for hidden/blocked/alias sets (1409-1411); svcPrefHit's prefix guard (2405-2415) correctly maps box-less prefs to any box and can't swallow `or_2day_am_*` from `or_2day`. Ship tab suppresses local OR placeholders when live OR rows exist (liveOR check ~6725); modal/QQ concat placeholders but cleanServiceList/no-live-OR keeps one row (dedupe keeps the priced one). Checked all of it — no mismatch found.
- One residual: table-priced OR placeholders (oneRateQuotes 2007) get ctx `{rules,client}` with no weight/zips, so a per-box rule that uses breaks/zones resolves differently than the same rule against a live OR row (full ctx). Only matters for admins who put breaks/zones on One Rate keys — unusual. [L]

### F11 [H] Live One Rate rows usually skip the account markupMin floor (see F13)
- One Rate is all-inclusive, so with no signature/DV the account detail has **zero itemized surcharges** → `surch=[]` → rateSellFor's wrapper (2480) is skipped (`c.surcharges.length` gate) → the aMin2 profit floor at 2509-2510 never runs. A standard Ground row on the same quote (has fuel line) does get the floor. Concrete numbers under F13.

---

## 4. quote.js

### F12 [H] listBase skew when ACCOUNT and LIST itemize different fee lines
- quote.js:270-279: `listBase = list − Σ(all LIST fee lines)`; the App's wrapper (2506) prices the base off listBase and carves `baseCost = cost − Σ(ACCOUNT fee lines)`.
- Case A — LIST-only fee (account discounts it to $0 so the $0 line is dropped by `if(amt)` at 266): listBase is correctly reduced, account base keeps everything. Fine.
- Case B — ACCOUNT-only fee (list detail doesn't itemize it, or FedEx words the description differently between ACCOUNT and LIST details so `normLabel` keys diverge): the fee is carved out of baseCost and priced by its fee rule, but its list-side counterpart **stays inside listBase** → a `basis:"list"` rule prices the fee twice.
- Numeric: list $30 of which $5 is a resi charge FedEx only itemized on the ACCOUNT detail ($4). listBase stays $30. Rule "list −20%": baseSell = 30×0.8 = $24, feeSell = $4 → $28. Correct: listBase $25 → $20 + $4 = $24. Overcharge $4.
- Fix sketch: match list fee lines to account lines by surcharge **type/code** (FedEx returns `type`) rather than normalized description; when an account line has no list twin, subtract the account amount from listBase as an approximation.

### F13 — see §6 (floors) for the wrapper-skip that also originates here.

### F14 [M] Multi-piece surcharge harvest is shipment-level OR per-package, never both
- quote.js:250-260: per-package `ratedPackages[].packageRateDetail.surcharges` are read **only if** `shipmentRateDetail.surCharges` is empty. If FedEx ever splits (shipment-level lines present + additional per-package-only lines), the per-package ones vanish from `surcharges` (and from listSur → listBase overstated). Total `cost` is still right, but the missed fees are priced by the **service** rule instead of their fee rules, and a list-basis base double-prices their list share (same shape as F12). I could not falsify FedEx's actual response shape from this repo (shipmentRateDetail normally aggregates everything), so flagging as a robustness defect: merge both sources and de-dupe by type+amount rather than either/or.

### F15 [L] One Rate second call — clean
- The OR request correctly drops dims but keeps per-piece DV + signature (196-201, comment documents the prior bug); merged rows get `or_` keys, `_ONE_RATE` serviceCode suffix (ship.js strips it, 37-39), the box code, and their own listBase. `dvRequested/dvPriced` verification (309-311) is sound. No issues found.

### F16 [L] `pickDetail` can silently price cost=list
- quote.js:83-86 + 290: if FedEx returns only LIST details (account not authorized for discounts on a service), `cost` falls back to `list` — margins on such rows are fictional (0 against list). Harmless today (rare), but a `_rateType` check before trusting cost would make it visible.

---

## 5. Quote-vs-book parity

### F17 [C] OrderShipModal books WITHOUT the signature / Saturday / declared value it quoted and charged
- Quote: 8197 sends `signatureOption`, `saturdayDelivery`, `insuranceAmount`; 8216 charges the customer local fees for all three (plus FedEx-priced signature — F1).
- Book: 8251 `bookOrderLabel(dest,{quote,box,weightLb,residential,packageTypeCode,sender,reference,invoiceNo,poNo})` — **no signatureOption, no saturdayDelivery, no insuranceAmount** → orderToEngland (362) defaults signature to "none".
- Numeric: adult signature + Saturday + $1,000 DV quoted in the modal: customer pays +$8.05(FedEx-priced) +$8.05(local dup, F1) +$16.00 +$10.35 ≈ **$42.45 of accessorials; the booked label carries none of them** — no signature service, no Saturday commitment, no declared-value coverage on the actual shipment.
- Fix: pass `signatureOption:sigOption, saturdayDelivery:sat, insuranceAmount:insurance` through printHere's opts *and* extend orderToEngland to carry them (see F18).

### F18 [C] orderToEngland cannot express Saturday, declared value, or per-piece DV at all
- `src/App.jsx:362-381`: the returned order has `signatureOption` but **no `saturdayDelivery`, no `insuranceAmount`, and pieces without `declaredValue`** — the exact fields ship.js reads (ship.js:159, 172-179, 190). Every Orders-based booking path (inline row 8026, modal 8251, Batch 9195, Autopilot 11065) is therefore structurally unable to book those services even if callers passed them.
- Corollary [C]: **international orders can never book from the Orders surfaces** — ship.js:232 rejects intl shipments with `declaredTotal=0`, and orderToEngland can never supply a customs value; meanwhile quote.js happily quoted the lane with a defaulted $100 customs value (165). Quoted-but-unbookable.
- Fix: add `saturdayDelivery:!!opts.saturdayDelivery, insuranceAmount:opts.insuranceAmount||null` and per-piece declaredValue to orderToEngland; thread opts from each caller.

### F19 [M] Autopilot rule actions "Request Signature" / "Set Insurance" / "Saturday Delivery" are neither priced nor booked by Autopilot/Batch
- Rules write `p.signatureOption`/insurance onto the order via Apply-only (10823), and the modal *quotes* from `o.signatureOption` (8145) — but Autopilot's own run loop rates (11056) and books (11065) without any of them, as does Batch (9175/9195). So the rule fires, the run report says "direct signature", and the label ships unsigned. Fix rides on F18's plumbing.

### F20 [clean] Everything else in quote-vs-book parity checks out
- Weights: quote ceils per piece (322), bookings ceil per piece (Ship tab 6866 `Math.ceil(pw(p))`, orderToEngland 379) — consistent. Dims: both sides `Math.round` server-side (quote.js:140, ship.js:169). Residential: flag rides both (quote.js:153, ship.js:216); intl quote drops it (178) while ship keeps it — FedEx tolerates it on ship; watch item only. SmartPost hub: both sides fall back to `FEDEX_SMARTPOST_HUB` env (quote.js:126, ship.js:221). packageTypeCode: both the Ship tab (6860) and orderToEngland (369) strip the box for non-One-Rate bookings, matching the quote's main call which never sets packagingType — consistent; ship.js's ground coercion (202) is a dead-man's switch, not a divergence. Ship tab booking passes signature/Saturday/DV/per-box DV correctly (6862, 6866).

---

## 6. Floors

### F21 [C] `client.markupMin` is skipped whenever a service rule prices a quote that has no itemized fee lines
- The profit floor exists in exactly two places: the wrapper (2509-2510, gated on `c.surcharges.length` at 2480) and `fallback()` (2541-2545, only reached when **no rule** answers). The rule paths (percent 2585-2601, fixed 2574, flat 2578, list 2551-2573) never consult it.
- Concrete: client `{markup:"", markupMin:5}`, Ground rule `basis:"percent", pct:3`.
  - Live quote **with** a $2 fuel line, cost $20: wrapper → baseSell 18×1.03=18.54 + fee 2 = 20.54 → floor: 20.54 < 20+5 → **$25.00**. Correct.
  - Live quote with **zero** fee lines (surch=[] — real: One Rate rows without sig/DV, or any lane where FedEx returns no itemized surcharges), cost $20: wrapper skipped → sell = 20×1.03 = **$20.60**. Profit $0.60 < $5 floor. Same skip on every local-estimate ctx (LiveEstRate offline 7765, Batch preview 9018, demo modes) since quoteRates rows carry no surcharges.
  - Same account, same rule, floor honored or not depending on whether FedEx happened to itemize a fee.
- Fix sketch: after the rule paths compute `sell`, apply `if(aMin!=null && sell<cost+aMin) sell=cost+aMin` before the rule-min/rounding return (flat basis is a judgment call — but the wrapper already imposes the floor on flat-priced live quotes via aMin2, so the non-wrapper flat path should match for consistency).
- Also change the wrapper gate `c.surcharges.length` → allow empty arrays through (`Array.isArray(c.surcharges)` alone), which fixes the live zero-fee case and F22 at once.

### F22 [M] When account surcharges are empty but LIST fees exist, list-basis pricing uses full list instead of listBase
- Non-wrapper list path (2555-2560) reads `c.list` (list **total**); `c.listBase` is only consumed via the wrapper (2506). If the account detail itemizes nothing (e.g. 100% fuel discount → $0 lines dropped) but LIST itemizes $3 fuel: cost $18, list $25, listBase $22, rule "list −20%" → sold at 25×0.8 = **$20.00** instead of the intended 22×0.8 = $17.60. The engine's own spec ("the base prices off the LIST BASE… never list-total", 2505) is violated on exactly these quotes. Fix folds into the F21 gate change, plus `list:(c.listBase??c.list)` in the non-wrapper path when listBase is present.

### F23 [clean] Remaining floor interactions verified correct
- `rule.min` survives every fallback (blank %, no table, no zone) via `ruleMin` in `fallback()` (2538-2547) — the historical "minimums not honored" bug stays fixed. Break-level `min` early-returning past the service min (2573, 2600) is documented intent. Wrapper aMin2 floors against **full** carrier cost including discounted-away fees (test rates.mjs:54 covers it). Inner-call fallback floors markupMin against baseCost only, but the wrapper re-floors vs full cost afterwards — net correct.

---

## 7. Misc / low

- **F24 [L]** "ANY - Cheapest 2 Day" pref regex `/^(or_)?2day/` (8994, 11015) also matches `2day_am` keys — can select 2Day A.M. when it's cheaper/unblocked. Add `(?!_am)`.
- **F25 [L]** Batch/Autopilot multi-box packs quote and book as **one** piece carrying total weight and box #1's dims (ratesForOrder 358-361 single-piece; orderToEngland 379 single-piece). Quote/book are consistent with each other, but both misprice true multi-piece dim weight and produce one label for N boxes. Known scope limit; noting for completeness.
- **F26 [L]** surchargeAdjust (2387) is dead weight relative to the wrapper's inline fee loop — two implementations of fee-rule pricing that could drift (the wrapper has the typeless-default fix, surchargeAdjust defaults typeless to percent implicitly via `r.type==="percent"?…:a` — a typeless rule there prices as **flat**, the exact bug 2493-2496 fixed). If it's still referenced anywhere in the future, it will reintroduce that bug; delete or align.

## Test-suite note
`claude/tests/rates.mjs` (104 asserts) covers the wrapper, fee-rule types, typeless default, list/listBase, and the min floors — but every markupMin case goes through the wrapper or fallback. F21 (rule path + no fee lines + markupMin) and F22 (empty account fees + listBase) have no coverage; both make good regression cases.
