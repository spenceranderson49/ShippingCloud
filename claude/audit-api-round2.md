# API + Invoicing + Multi-carrier audit — builds v468–v477 (round 2)

Date: 2026-07-11 · Scope: `netlify/functions/{api.js,api-engine.js,fedex.js,ship.js,track-sync.mjs,db.js}`, `src/App.jsx` (ApiAdmin / BillingAdmin / CUSTOM_CARRIERS / enabledCarriers).
Method: read all in-scope code, `node --check` on every function, programmatic diff of the shared engine functions between `src/App.jsx` and `api-engine.js`, trace of every test-mode / auth / carrier path.

---

## Ranked fix list

| # | Sev | Finding | Location |
|---|-----|---------|----------|
| 1 | **CRITICAL** | `insertNew` is undefined — every `POST /v1/labels` with an `Idempotency-Key` returns 500, never books | api.js:282 |
| 2 | **HIGH** | Webhook delivery is a blind SSRF: weak URL allowlist + no redirect guard + no send-time recheck (metadata/RFC1918 reachable) | api.js:105,115 |
| 3 | **HIGH** | Voided labels stay billable via `/v1/billing` & on-the-fly `/v1/invoices` — `rec_` rows never marked Voided | api.js:222,329-341,432 |
| 4 | **HIGH** | Idempotency mutex (once #1 is fixed) never clears the `pending` row on failure → permanent 409 lockout | api.js:282-286 |
| 5 | MED | `rec_` billing rows grow unbounded (never pruned) — the old F7 leak reintroduced | api.js:222 |
| 6 | MED | Invoice-number collision: two admins/tabs mint the same `INV-YYYY-NNNN` | App.jsx:4481,4488 |
| 7 | MED | No shipment-level "invoiced" flag → the same shipments can be re-invoiced (double billing) behind a dismissable confirm | App.jsx:4479-4485 |
| 8 | LOW/MED | track-sync SSRF regex misses 172.16–31.x, IPv6, DNS-rebind (still better than api.js — has `redirect:manual` + blocks 169.254) | track-sync.mjs:197 |
| 9 | LOW/MED (PLAUSIBLE) | Multi-commodity customs: item values need not sum to `declared_value_total`; no reconciliation | ship.js:274-292 |
| 10 | LOW | Overpayment not capped → negative balance displayed | App.jsx:4495 |
| 11 | LOW | Concurrent `apiKeyCreate` last-write-wins can drop a key | db.js:742-748 |
| 12 | LOW | Unescaped SQL-LIKE metachars in the `rec_` reconcile pattern (not exploitable today) | api.js:431 |

---

## CRITICAL

### 1. `insertNew` is not defined — the idempotency path 500s on every first call
`api.js:282`:
```js
const res0 = await insertNew(irow, { status: "pending", at: Date.now() });
if (res0.conflict) return ERR(409, "in_progress", ...);
```
`insertNew` is referenced **exactly once in the entire repo and defined nowhere** (confirmed by grep across the tree; the file is `"use strict"`, so the reference throws `ReferenceError` at runtime, not a silent undefined). `node --check` passes because it is only a syntax check.

**Failure scenario:** A client that follows best practice and always sends `Idempotency-Key` on `POST /v1/labels`:
- First call: the "replay" lookup (`getStore(irow)`) returns nothing → falls into `insertNew(...)` → ReferenceError → caught by the top-level `catch` at api.js:448 → `500 internal_error`. No label is booked, no `pending` row is written.
- Every retry repeats the same 500. The customer can **never** book a label through the documented safe-retry flow. Labels sent **without** the header still work (api.js:288), which is why casual testing misses it.

This is invisible to CI: `claude/tests/api.mjs` runs the handler only with SUPABASE unconfigured (everything fails closed at 503 before reaching line 282) and has **zero** idempotency coverage (`grep -i idempot` → none).

**Fix sketch:** implement the intended conditional-insert helper and make it a true PK-conflict detector:
```js
async function insertNew(key, value){
  // NOTE: the module-wide pg() default Prefer is "resolution=merge-duplicates" (UPSERT) — that
  // must be OVERRIDDEN here or the insert silently upserts and the mutex fails open.
  const r = await pg("app_stores", {
    method:"POST",
    headers:{ Prefer:"return=minimal" },           // no merge-duplicates → PK (tenant,key) conflict → 409
    body: JSON.stringify([{ tenant: TENANT, key, value }])
  });
  return { ok: r.ok, conflict: r.status === 409 };
}
```
Then add an idempotency test to `api.mjs`. **Verify the PostgREST behavior:** with `Prefer: return=minimal` (no `resolution=merge-duplicates`) a duplicate `(tenant,key)` returns **409 Conflict**; the current default header (`resolution=merge-duplicates`, api.js:25) would instead UPSERT and return 201, so the mutex would "fail open" (two containers both proceed to book) even once `insertNew` exists. The override above is load-bearing.

---

## HIGH

### 2. Webhook delivery is a blind SSRF (metadata service + internal network reachable)
Registration guard, `api.js:105`:
```js
const validHookUrl = (u) => { try { const x=new URL(String(u));
  return x.protocol==="https:" && !/localhost|127\.|\.local$/i.test(x.hostname);
} catch(e){ return false; } };
```
This blocks only `localhost`, `127.*`, `*.local`. It **allows** `https://169.254.169.254/…` (cloud metadata), `https://10.x`, `https://192.168.x`, `https://172.16-31.x`, `https://[::1]`, and decimal/hex IP forms. Then `fireHooks` (api.js:112-118) POSTs the signed event to `h.url` with:
```js
await fetch(h.url, { method:"POST", headers:{…}, body, signal: ctrl.signal });
```
No `redirect:"manual"` (defaults to `follow`) and **no re-check of the URL at send time**. So:
- A registered `https://169.254.169.254/latest/…` or `https://10.0.0.5/internal` receives blind POSTs on every `label.created` / `label.voided`.
- Even a "public" host that 302-redirects to `169.254.169.254` is followed, bypassing any allowlist.

The task's premise ("does it match api.js's stricter `isPrivateHost`") is inverted: **api.js has no `isPrivateHost`**, and its `validHookUrl` is *weaker* than track-sync's inline regex. `track-sync.mjs:197` at least blocks `10./192.168./169.254./0.` and uses `redirect:"manual"` (line 199); api.js `fireHooks` does neither.

**Fix sketch:** share one strict `isPrivateHost` (RFC1918 incl. 172.16/12, 169.254/16, 127/8, `::1`, `fc00::/7`, `0.0.0.0`, and reject bare-IP + non-https) used by BOTH `validHookUrl` and `fireHooks`; add `redirect:"manual"` to the api.js fetch; re-validate the final host at send time (defends against DNS rebinding between register and fire). Mirror the same into track-sync (see #8).

### 3. Voided labels remain billable through the API
On book, api.js:222 writes a durable per-record billing row `u/api_<id>/rec_<id>` with `status:"Label created"`. `/v1/billing` and on-the-fly `/v1/invoices` reconcile from those rows and only exclude `status === "Voided"` (api.js:432, 437). **The void handler never touches the `rec_` row** — it updates only the `shipStoreKey` array (api.js:338). So once at least one `rec_` row exists, a voided label is still counted in `total_charges` and appears as a billable line forever. The array-fallback path (api.js:434) *does* reflect voids, but it only runs when the `rec_` reconcile returns nothing — so the durable path (the whole point of F2) systematically **over-bills** voided shipments.

**Fix sketch:** in the void handler, also `putStore("u/api_"+client.id+"/rec_"+id, {…, status:"Voided"})` (merge-update). The reconcile filter already drops `Voided`, so this closes it.

### 4. Idempotency `pending` row is never cleared on failure → permanent lockout (latent behind #1)
Even after #1 is fixed, api.js:282-286:
```js
const res0 = await insertNew(irow, { status:"pending", … });
if (res0.conflict) return ERR(409,"in_progress",…);
const r = await bookLabel(body);               // if this THROWS, control jumps to the outer catch
putStore(irow, { status:"done", … }).catch(()=>{});
return J(r.code, r.resp);
```
`bookLabel` mostly returns error objects, but it can **throw** (e.g. `require`/`fetch` inside `callFn`, `getStore`/`putStore` rejection). If it throws, the outer `catch` returns 500 and the `pending` row is neither promoted to `done` nor deleted. Every subsequent retry with the same key hits `insertNew` → `conflict` → **409 forever** = a per-key permanent lockout. There is no TTL on `pending`.

**Fix sketch:** wrap the book in try/finally; on any non-success, delete (or reset) the `pending` row. Add a staleness check on replay: treat a `pending` row older than N minutes as abandoned and allow re-book.

---

## MED

### 5. `rec_` billing rows are unbounded
`u/api_<id>/rec_<id>` rows (api.js:222) are written per label and **never pruned** — exactly the F7 growth pattern the durable-row design was supposed to avoid elsewhere. Over time the `like.…/rec_*` reconcile (api.js:431) scans an ever-growing set. **Fix:** prune/roll `rec_` rows older than the retention window (e.g. keep 13 months), or fold settled months into a monthly aggregate row.

### 6. Invoice-number collision
`nextNumber()` (App.jsx:4481) computes `count(existing INV-<yr>-*) + 1` at preview time; `issue()` (4490) persists `preview.number`. Two admins (or two tabs) previewing the same year before either issues both compute the same N → duplicate `INV-YYYY-NNNN`. Counting includes voided invoices (numbers retained), so it won't *reuse*, but concurrent minting collides. **Fix:** derive the number at `issue()` from a monotonic counter persisted atomically, or a max()+1 over the freshly-read list inside the setInvoices updater.

### 7. Same shipments re-invoiceable (double billing)
`shipsForClient` (App.jsx:4479) selects every non-voided shipment for the client+month with **no per-shipment "invoiced" marker anywhere**. The only guard (4485) is a dismissable "an invoice for this customer+month already exists — create another?" confirm, and it ignores voided invoices. Re-issuing (or clicking through the confirm) bills the same shipments again. Voiding-then-reissuing is correctly allowed (intended), but there is nothing to stop a genuine duplicate issue. **Fix:** stamp `invoicedBy`/`invoiceId` on each shipment when an invoice is issued and exclude already-invoiced shipments from `shipsForClient` (clear the stamp when the invoice is voided).

---

## LOW / informational

### 8. track-sync SSRF regex incomplete
`track-sync.mjs:197` blocks `localhost/127./10./192.168./169.254./0.` and `.local`, and uses `redirect:"manual"` — good — but misses `172.16.0.0–172.31.255.255` (the other RFC1918 block), IPv6 literals (`[::1]`, `fc00::/7`), and DNS-rebinding. Consolidate with the shared `isPrivateHost` from #2.

### 9. Multi-commodity customs total not reconciled (PLAUSIBLE)
`ship.js:274-292` builds `commodities[]` from `o.commodities` with per-item `customsValue = unit*qty`, but never checks that the sum equals `declaredTotal` (used only in the single-commodity fallback). An API caller can pass `customs.items` whose values sum to less than `declared_value_total`, producing a customs declaration that diverges from the insured value; if all item values are 0 while `declaredTotal>0` (the intl guard at ship.js:269 only checks the declared total), FedEx may reject or customs may hold. Edge weights/qtys are otherwise well-guarded (`Math.max(0.1,…)`, `Math.max(1,…)`, `+x||0`). **Fix:** validate/renormalize commodity totals against the declared value, or reject on mismatch.

### 10. Overpayment not capped
`recordPayment` (App.jsx:4495) accepts any positive amount; `balanceOf` (4497) can go negative and renders as `partial -$X`. **Fix:** clamp to balance or warn on overpay.

### 11. Concurrent `apiKeyCreate` lost-update
`db.js:742-748` read-modify-writes the shared `apiKeys` array; two simultaneous creates last-write-wins and one key is lost. Admin-only and rare. (api.js correctly avoids this for last-used stamps by writing per-key rows — F6 stayed fixed, api.js:152.)

### 12. Unescaped LIKE metacharacters (not exploitable)
`api.js:431` interpolates the key prefix into `like.…*` without escaping `_`/`%`. Because the client id is followed by a literal `/`, the SQL `_` wildcards stay position-anchored and client "1" cannot match client "11" (verified by hand). Harmless today; escape `_`/`%` as defense-in-depth if ids ever contain them.

---

## Checked and found OK

- **api-engine parity (F4): no drift.** Programmatic comment-stripped diff shows `rateSellFor`, `baseCostLookup`, `canonSvc`, `rateProfileFor`, `customCarrierQuotes`, and `CUSTOM_CARRIERS` are **code-identical** between `src/App.jsx` and `netlify/functions/api-engine.js` (only a one-word comment differs in `rateSellFor`: "England-style" vs "matrix-style"). `claude/tests/api.mjs` still reconstructs `rateSellFor` live from App.jsx and asserts parity across the basis/mode/floor matrix, plus a custom-carrier case — coverage is valid. API prices match the portal.
- **Multi-carrier privacy (F3): airtight on all four surfaces.** Ship (App.jsx:6979 `client.enabledCarriers.length && !intl`), QuickQuote (App.jsx:8967, `effClient` = the viewer's own `client` per App.jsx:8902), `/v1/rates` (api.js:256 → `customCarrierQuotes`), and `/v1/services` (api.js:233 `includes(cc.id)`) all gate on a **length** check. `customCarrierQuotes` returns `[]` when `enabledCarriers` is `[]` or undefined (api-engine.js:427-428). A customer with `enabledCarriers=[]`/undefined sees exactly zero custom carriers everywhere. The api.mjs test asserts this ("custom carriers invisible unless enabled").
- **customCarrierQuotes edge cases:** missing rate card → `cost==null` skip; non-numeric/missing `toZip` → `zone==null` → `[]`; blocked service → skip; weight 0 → `ruleWeightFor`/`baseCostLookup` floor to ≥1. No NaN leaks.
- **Test-mode carrier isolation (F7):** test keys **never** trigger a booking (`ship.js`), `cancelShipment`, `pickup`, or live `track` — all gated on `!isTest` (api.js:203, 335, 350, 393-394) or short-circuited to `TEST…`/`TESTPICKUP…` stubs. Test keys do make read-only real FedEx **address-validation** (api.js:163, ungated) and real rate quotes — both intended ("test keys: real quotes"), harmless. `cancelShipment` confirmed never reached for test keys.
- **`/v1/billing` LIKE pattern (F2 syntax):** `key=like.<encoded>*` with `*` as the wildcard is the correct PostgREST form (confirmed by `db.js:765` `listBackups` using the identical `like.<encoded>*` shape). `encodeURIComponent` leaves the trailing `*` raw. It matches `rec_` rows correctly — billing does **not** silently return 0 for this reason. (The real billing bugs are #3 and #5, not the pattern.)
- **track-sync before/after diff (F6): correct, no spam.** The status-update `.map` (track-sync.mjs:146-162) builds new objects and never mutates `rows[ri].value`, so the `before` map (line 172) truly holds pre-update statuses; `after` is the freshly-computed `changed` value. An event fires only when `before.get(tracking) !== s.status` on a store that was actually `dirty`. An unchanged status cannot re-fire every 30 min.
- **printInv HTML escaping (F5):** `esc` (App.jsx:4499) covers `& < >`; every user-controlled value (`inv.number/terms/month`, `c.name/email`, item fields, `bSettings.note/payUrl`, `brandWordmark0`) is passed through it and sits in text nodes, not quoted attributes, so the missing `"`/`'` escaping is not reachable. `</script>` is neutralized by `<`→`&lt;`. Numeric `money(...)` values are safe. No injection found.
- **balanceOf / partial-payment math** (App.jsx:4495-4497): correct rounding, `paid>=total-0.005 ⇒ paid`; record/void buttons hidden for voided invoices (4535-4536).
- **API-level void handling of issued invoices:** `/v1/invoices` correctly excludes admin invoices with `status==="void"` (api.js:414). (The billing over-count in #3 is a *separate*, on-the-fly path.)
- **Auth & routing:** `node --check` passes for all in-scope functions. The API-key gate (api.js:140-149) runs before every route except OPTIONS (204) and the benign unauthenticated root `GET /v1` (name/version only). No route reads a mutating body before auth. fedex.js/ship.js are gated by the internal HMAC key (fedex.js:316-331, ship.js analogous). CORS is `*` but auth is header-based (no cookies), so wildcard is acceptable. Top-level catches return generic messages; the only raw carrier-error surface (`booking_failed`) strips "FedEx"→"the carrier" (api.js:206); no SUPABASE/env names observed on any API path.
