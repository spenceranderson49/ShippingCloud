# Performance & mobile audit — ShippingCloud (overnight, 2026-07-10)

Read-only audit of `src/App.jsx`. The codebase is generally well-optimized (39 `useMemo` uses, the `JSON.stringify(...)`-in-deps idiom to avoid loop-inducing object deps, responsive modal patterns, all wide tables wrapped in `overflow-x-auto`). The real hot spots are concentrated in the **Batch** component. Mobile is in good shape.

## Fixed this session (safe, no behavior change) — addr-v397
- **#3 Orders `filtered`/`sorted`** (`App.jsx` ~6662) — wrapped in `useMemo` keyed on `[orders,filter,storeFilter,q]` / `[filtered,sort]`. Was re-filtering + copying + sorting on every render (every keystroke, every parent re-render).
- **#5 `EST_CACHE` unbounded** (`App.jsx` ~6612) — the `LiveEstRate` module cache never evicted; now capped at 2000 keys (drops oldest).
- **Trivial: `SOURCE_TONE`** — hoisted from inside `Orders` render to a module constant (was rebuilt every render).

## Flagged, NOT changed (RISKY — needs supervised review)
- **#1 `Batch.rateFor()` runs `quoteRates()` for every order, many times per render — the single biggest issue.**
  - Def `App.jsx:7771`; hot call sites: `8063-8064` (`dimValues("carrier")`), `8184`/`8193` (`visible.map(OrderRow)`), `7996` (`groups`), `8189` (group subtotal reduce), `7905` (`rows`).
  - `rateFor(o)` calls `quoteRates()` (iterates all `SERVICES`) with no memoization. The Carrier filter chip row calls it for every order in `pool` on every render; combined with per-row + grouping + subtotals, a batch of N orders triggers ~2–4×N `quoteRates` calls on every keystroke/checkbox/expand. At 200 orders ≈ 15–20k rate computations per render.
  - **Fix (do this WITH Spencer watching):** build one memoized rate map and read from it everywhere:
    ```js
    const ratesById = useMemo(() => {
      const m = {}; pool.forEach(o => { m[o.id] = /* current rateFor body */ }); return m;
    }, [orders, settings, client, rateRules, rule, specSvc, specCarrier, svcOv, packs]);
    const rateFor = (o) => ratesById[o.id] || {label:"—",cost:0,sell:0};
    ```
    RISK: getting the dependency list wrong could show a stale (wrong) price — that's why it wasn't shipped unsupervised.
- **#2 Batch derived lists** (`visible` 7807, `groups`/`groupKeys` 7996-97, `rows`/`totals` 7905-07, `dimValues` 7831) recompute every render. SAFE `useMemo` wraps — but they depend on #1's rate map, so do them together, after #1.

## Effect / re-render hazards (minor, not changed)
- **#4 `CLOUD_POLL`** (`4300-4303`) — module-level `setInterval` never cleared. Guarded singleton (checks `document.hidden`/`CLOUD.offline`), so not a runaway; acceptable. If tightened, gate on `visibilitychange`.
- Verified NOT bugs: auto-sync interval at `5307` IS cleaned up; the `join(",")`/`JSON.stringify(...)` effect deps are string primitives (correct idiom); no setState-in-render loops.

## List keys — clean
No harmful index keys. `key={i}` uses (batch results 8172, chat 4921, landing 4640, import preview 3603) are all append-only/static lists. All reorderable lists key on `o.id`/`s.id`/`k`.

## Mobile / responsive — good
- Every wide table has `min-w-[…]` inside an `overflow-x-auto` wrapper (2958, 3036, 3095, 3497, 3562, 3647, 6275, 6746). No viewport overflow.
- Modals use mobile-fullscreen patterns (`items-stretch sm:items-center`, `h-full sm:h-auto`, `max-h-[90vh]`): 6385, 7092, 9623, 10102.
- Minor: some per-row icon buttons (Orders `6782`, Trash2 `w-4 h-4`+`p-1` ≈ 24px) are below the 44px tap-target guideline — acceptable, bump padding if desired.

## Recommended order of attack (daytime)
#1 (Batch rate memoization) is by far the highest-impact and makes Batch feel dramatically snappier on large order sets; #2 is a clean follow-on; everything else is minor.
