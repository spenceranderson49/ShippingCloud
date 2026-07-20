# Handoff — 2026-07-20 night 2 (v738 → v741)

Owner: Spencer Anderson (spenceranderson49@gmail.com).
Branch: `claude/system-full-circle-integration-g219k5` — all work committed and pushed here.
Build tag: `wmsfast-v741` (`src/App.jsx:140`). Builds clean.

This pass answered Spencer's re-sent full request. Two items were actively failing
(wiped rates, FedEx "Done" not removing rows); those went first, then everything else
on the list. **Three items are deliberately left un-shipped pending Spencer's yes/no —
see "Waiting on the owner" below. Do not build them without a go-ahead.**

---

## What shipped this pass (newest first)

- **v741 — Warehouse load speed.** Every WMS list now paints from cache instantly, and the
  refresh fires all reads in parallel (`Promise.all`, `src/App.jsx:10171`) — one round trip
  on a cold function instead of two. Background refresh pushes changed values in silently
  (`src/App.jsx:5847`); no "first sync…" banner (`src/App.jsx:6812`). NOTE: the deep bundle
  code-split (the biggest remaining lever) was **not** done — see "Known gaps".
- **v740 — Help mapping fix + missing sections.** Fixed a real bug where Purchase Orders
  showed the POS help. Added the missing Help sections: Purchase Orders, Point of Sale,
  Dropoffs, Mail Boxes, Links — each with steps, common mistakes, and Q&A.
- **v739 — Guided practice tour + welcome hand-off.** New 7-scene rehearsal
  (`PracticeRehearsal`, launched via `practiceTour` state `src/App.jsx:10126,10369`):
  receive → order lands → scan-pick → pack the suggested box → ship → stock counts down →
  low-stock → reorder. Throwaway data, nothing ships (`src/App.jsx:11377`). The quick
  pick→pack→ship rehearsal is kept as "Quick order" (`startPractice` `src/App.jsx:11328`).
  The first-run welcome's final step launches the full tour directly (`src/App.jsx:12364`).
- **v738 — Four things:**
  1. **FedEx "Done" bulletproofed.** The queue row is removed by identity + a signature of
     `[id,uid,email,name,requestedAt]` with `row`/`idx`/`len` sent to the server
     (`fedexRequestResolve`, `src/App.jsx:5364`); "Dismiss all" clears the whole list
     (`src/App.jsx:5359`). Seed rows (Test, Granite Seed) now actually leave and stay gone.
  2. **Help centered as a modal** instead of an inline block that pushed the page down.
  3. **Rate-safety client guard + banner** (see next section).
  4. Admin portal cleanup (rates rail entry stays hidden per prior owner request,
     `src/App.jsx:5122`).

Files touched this pass: `src/App.jsx` (+279/-31), `netlify/functions/db.js` (+23/-8).

---

## The rate-wipe defense (read this if Lagence still looks wrong)

Spencer's instruction — "rate info NEVER LEAVES" — was read as **it can never be erased**.
There are now six independent layers between a stray tab and negotiated rates:

1. **Customer logins can't write rates at all** — non-admin scope is blocked server-side
   (`canWriteKey`, `netlify/functions/db.js:315`).
2. **A fresh admin tab can't push its blank default** — first-render values are never synced;
   global writes held until real cloud data loads (`src/App.jsx:5666`).
3. **Client refuses to send an empty rate write** — a `rateRules` save carrying zero settings
   is blocked before it leaves the browser when the last-good value had content
   (`src/App.jsx:5720`, "blocked an empty rateRules write"). ← NEW this pass.
4. **Server refuses an empty-default overwrite** — measured across assignments + every
   profile's services/surcharges + cost tables, not just base costs (`db.js` putMany
   wipe-guards, `netlify/functions/db.js:1608,1652`).
5. **Self-heal from device cache** — if the cloud returns empty, cached full rates are kept
   and re-saved.
6. **Every save snapshotted** — `bak:` rows are server-written and un-forgeable
   (`db.js:315,1486`); newest 10 kept; Admin → Backups & Restore rolls any back.

The Rates page shows a green **"Rates protected"** banner with a live protected-settings
count and one-click **Back up now** (`src/App.jsx:4298`). Admin → Data Safety has a
**Back up now** for every critical store (`src/App.jsx:3654`).

**RECOVERY, if Lagence is still wrong on screen:** Admin → Backups & Restore → restore the
`rateRules` snapshot from *before* the wipe. The current state is snapshotted first, so the
restore itself is reversible.

---

## Waiting on the owner (do NOT build without a yes)

Each changes a live workflow or what every customer sees. I did not ship these overnight.

1. **Warehouse as a free "explore" tab for everyone?** — Recommend **yes, but read-only
   explore**, not full WMS. Not flipped because it makes a new tab appear for every live
   customer. On a yes: gate live data behind the existing `inventory` feature flag.
2. **Pick-list tie-together** — When WMS mode is on, make the shipping-side "Pick list"
   button *create a tracked WMS pick-list object* instead of only printing, so a ship batch
   becomes a real pick task and pack-verify closes back to the label. A focused project,
   not an overnight change — it rewires a live workflow.
3. **Returns → auto-restock** — a shipping-side return adds the unit back to WMS on-hand
   automatically. The second real integration gap.

---

## Known gaps / next work (ranked)

1. **Pick-list workflow objects aren't linked** across the two sides — they share the printed
   paper, not the tracked process. (= owner item #2 above.) Biggest remaining seam.
2. **Returns don't restock automatically.** (= owner item #3.)
3. **Ship-from addresses vs. WMS warehouses are two lists** for the same physical place.
4. **No single inventory ledger** showing every reason a number moved (sold/shipped/received/
   counted/returned) in one view.
5. **Deep bundle code-split not done** — the largest load-speed lever left. v741 did the safe
   cache-first + parallel-read version; the split is a real refactor that needs test time.

Already connected (for reference): orders are one shared list · product catalog shared ·
**box catalog is one list** (`settings.boxes` → WMS Containers, Ship Package Sizes,
cartonization, label L/W/H) · shipping a label auto-decrements WMS stock + fires low-stock
alerts · pick/packing-slip docs share templates.

Dropoffs (walk-in intake log) and Mail Boxes (rental registry) are **retail-counter** tools —
recommend a "front-desk" toggle, off by default for 3PL/ecommerce tenants. Each now has an
in-app Help section explaining this.

---

## How to verify / continue

- Build tag surfaces at `window.__SC_BUILD__` and the page footer (`src/App.jsx:7525`).
- Practice tour: To Ship → "Guided practice tour" (`src/App.jsx:11347`).
- Rate banner: Rates page, green "Rates protected" strip.
- To pick up owner item #1: gate the WMS tab render on `featureFlags.inventory` and a new
  read-only flag; the tab component already exists.
- Prior reports for context: `REPORT-2026-07-20.md` (morning), `REPORT-2026-07-20-night2.md`
  (this pass, prose), plus the HTML summary in `scratchpad/report.html`.
