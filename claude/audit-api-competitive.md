# ShippingCloud API — Competitive Gap Analysis + Deep Implementation Audit

Findings only. No files were edited. Date: 2026-07-11.
Scope: `netlify/functions/api.js`, `api-engine.js`, `db.js` (apiKey* + store layer),
`public/api-docs.html`, `ship.js`, `netlify.toml`.

Platform context that frames everything below: **this is a FedEx reseller.** One live
carrier (FedEx, booked in `ship.js`), Netlify Functions (stateless, multi-container,
no shared memory), Supabase `app_stores` as the only datastore (a single JSONB `value`
per `(tenant,key)` row — every write is read-modify-write of a whole array). The API's
job is to give a reseller's own customers programmatic access to *their* rate card +
FedEx booking. That reseller lens is what separates a "real gap" from "enterprise noise."

---

# PART 1 — COMPETITIVE GAP ANALYSIS

## Capability catalog of the three references

Condensed from the live docs/OpenAPI specs. Endpoint/enum specifics kept where they
matter for scoping our build.

| Area | ShipEngine | EasyPost | Shippo |
|---|---|---|---|
| **Rating** | `POST /v1/rates`, `/rates/estimate`, `/rates/bulk`, rate-shopper | `POST /shipments` auto-returns `rates[]`; SmartRate transit percentiles | `POST /shipments` returns `rates[]`; rates-at-checkout |
| **Label buy** | `POST /v1/labels` (inline / from rate / from shipment); pdf/png/zpl | `POST /shipments/:id/buy` (pick rate); label URL png/pdf/zpl | `POST /transactions` (from rate); label_url + zpl |
| **Batch/bulk** | `POST /v1/batches` + `/process/labels` (async), per-item `/errors` | `Batch` object: add/remove/buy/label/scan_form (async) | `Batch` object: create/add/remove/purchase (async) |
| **Return labels** | `POST /labels/:id/return` or `is_return_label` + `rma_number` | `is_return:true` on shipment create | `is_return:true` on shipment create |
| **Address validation** | `POST /v1/addresses/validate`, status verified/unverified/warning/error; residential indicator; `validate_and_clean` | `verify` / `verify_strict` / `verify_carrier`; `verifications{delivery,zip4}` | `validate:true` flag; `validation_results{is_valid,messages}` |
| **Tracking** | pull `GET /v1/tracking`; push `tracking/start`; codes UN/AC/IT/DE/EX/AT/NY/SP | `POST /trackers`; status enum pre_transit…delivered…failure; webhook events | `GET /tracks/:carrier/:num`; register for webhooks; status enums |
| **Manifests/SCAN** | `POST /v1/manifests` (async, form_download) | `POST /scan_forms` | Manifest object (USPS-oriented) |
| **Insurance** | Shipsurance connect + `insured_value`; `insurance_provider` | buy-time `insurance` or standalone `Insurance` object + Claims | `insurance_amount`/`insurance_currency` on parcel |
| **Customs/intl** | `customs` block, `customs_items[]`, incoterms, paperless | `CustomsInfo` + `CustomsItem[]`, contents_type, eel_pfc | customs declarations + items objects |
| **Carrier accounts** | connect/disconnect your carriers `/connections/carriers/*` | full CRUD `/carrier_accounts` + carrier_types | `carrier_accounts` CRUD |
| **Pickups** | `POST/GET/DELETE /v1/pickups` | `POST /pickups` + buy + cancel; pickup_rates | `POST /pickups` |
| **Webhooks** | CRUD `/environment/webhooks`; events batch/track/rate/carrier_connected; custom headers | CRUD `/webhooks`; many event types; HMAC `X-Hmac-Signature` (+v2 replay-safe) | webhooks; event types track_updated/transaction_created |
| **Test mode** | sandbox keys `TEST_`, isolated, watermarked labels | test vs prod keys (EZTK/EZAK); simulated tracking codes | test vs live token; test objects |
| **Idempotency** | none (dedupe via external_shipment_id) | none documented (use `reference`) | `SHIPPO-IDEMPOTENCY-KEY` header on POST |
| **Pagination** | `page`/`page_size` + `links{next,prev,first,last}` + `total` | cursor `before_id`/`after_id` + `has_more` | `page`/`results` count + `next`/`previous` URLs |
| **Error model** | `{request_id, errors:[{error_source,error_type,error_code,message}]}` | `{error:{code,message,errors[]}}` | field-keyed `{field:[msgs]}` / `detail` |
| **SDKs** | JS, Python, .NET, PHP (+Ruby/Java) | Python, Ruby, PHP, Node, .NET, Java, Go | Python, Node, Ruby, PHP, Java, Go, C#, Elixir |

## Gap table vs OUR API

Ours: `yes` = shipped, `partial` = present but shallow, `no` = absent. "Add cost" is
sized **for this codebase specifically** (Netlify fn + Supabase array-store +
FedEx-only `ship.js`).

| Capability | ShipEngine | EasyPost | Shippo | Ours | Add cost here | Matters for a FedEx reseller? |
|---|---|---|---|---|---|---|
| Single rate quote | yes | yes | yes | **yes** (`POST /v1/rates`, own rate card) | — | Core |
| Label buy (sync, PDF returned) | yes | yes | yes | **yes** (`POST /v1/labels`) | — | Core |
| Re-download label | yes | yes | yes | **yes** (`GET /v1/labels/{id}`) | — | Core |
| Void/refund label | yes | yes | yes | **partial** — marks store row Voided, **no FedEx cancel call** | Small | **YES** — today a void never reaches FedEx (§P2-F9) |
| Address validation | yes (levels) | yes (levels) | yes | **partial** — `valid`+classification, single address, FedEx-backed | Small | Yes, useful |
| Services list | yes | via rates | yes | **yes** (`/v1/services`) | — | Nice |
| Rate card introspection | no | no | no | **yes** (`/v1/rate-card`) — a differentiator | — | Yes (reseller USP) |
| Billing/invoice endpoints | no | no | no | **yes** (`/v1/billing`, `/v1/invoices` +csv) | — | Yes (reseller USP) |
| Pickups (schedule/cancel/list) | yes | yes | yes | **yes** | — | Yes |
| Webhooks (signed) | yes | yes (HMAC) | yes | **partial** — 2 event types, HMAC signed, SSRF-weak, no delivery log/retry | Medium | Yes but scope-limited |
| Tracking pull | yes | yes | yes | **partial** — returns only stored platform status, not live FedEx scans | Medium | **YES** — biggest functional gap |
| Tracking webhooks / status push | yes | yes | yes | **no** (only label.created/voided fire) | Medium | **YES** for customers automating fulfillment |
| Idempotency on buy | no | no | yes (header) | **partial** — works for sequential retry, **races on concurrent** (§P2-F1) | Small | Yes |
| Batch / bulk labels | yes | yes | yes | **no** | Large | Medium — high-volume shippers want it |
| Return labels | yes | yes | yes | **no** | Medium | **YES** — common reseller-customer ask |
| Manifests / SCAN / close-out | yes | yes | yes | **no** | Medium | Medium (FedEx less manifest-dependent than USPS) |
| International / customs docs | yes | yes | yes | **partial** — `customs.value+contents` only; single commodity; no HS/CI form | Medium | Medium (depends on customer intl mix) |
| Multi-carrier accounts CRUD | yes | yes | yes | **no** (carriers are admin-provisioned) | Large | **No** — anti-goal; reseller controls carriers |
| Insurance object / claims | yes | yes | yes | **partial** — declared_value priced into rate; no claims API | Medium | Low |
| Pagination (cursor/links) | yes | yes | yes | **no** — `?limit` only, no offset/cursor, 200 cap | Small | Medium (once volume grows) |
| Idempotency-Replay header | — | — | — | **yes** | — | Nice |
| Estimate-without-shipment | yes | via SmartRate | — | **no** | Small | Low |
| SDKs | 4+ | 7 | 8 | **no** (curl docs only) | Medium/Large | Medium (adoption friction) |
| Rate at bulk / rate-shopper | yes | — | — | **no** | Large | Low |

## Top 10 gaps worth building (ranked, sized)

Ranked by value **to a FedEx reseller giving customers integration access**, not by
parity with enterprise multi-carrier platforms.

1. **Live tracking pull-through** (Medium). Today `GET /v1/tracking/{n}` returns only
   the last stored platform status — a label booked and handed to FedEx shows
   "Label created" forever. Wire it to FedEx Track API (add a `track` action to
   `fedex.js`, normalize to a small status enum). This is the most visible hole:
   customers integrate precisely to stop logging into a portal to check tracking.

2. **Tracking webhooks / status-change push** (Medium). Extend the existing webhook
   machinery with `tracking.updated` events fed by a scheduled poll (`track-sync.mjs`
   already exists in the tree — reuse it). Turns the API from "book + forget" into a
   fulfillment automation surface.

3. **Real void→FedEx cancellation** (Small). `POST /v1/shipments/{id}/void` must call
   `ship.js`/`fedex.js` to actually cancel/refund at FedEx, not just flip a store flag.
   Current behavior silently under-refunds and the reseller keeps eating FedEx charges
   (also a P2 correctness finding, F9). Highest value-per-hour fix on the list.

4. **Return labels** (Medium). `POST /v1/labels` with `return:true` (swap shipper/
   recipient, set FedEx return service/RTN flags). Common e-commerce ask; the surcharge
   codes already exist in `api-engine.js` (`RTN`, `RTN-E`, `RETAG`).

5. **Concurrency-safe idempotency** (Small). Close the double-book race (F1): reserve
   the idempotency key *before* booking (insert-then-book), or gate on a store
   conditional write. Small change, prevents double-charging a customer.

6. **Cursor/offset pagination on `/v1/shipments` + `/v1/invoices`** (Small). Add
   `?before_id`/`?cursor` + `has_more`. At 5000-row caps a customer can't page history
   today. Cheap, unblocks reporting integrations.

7. **Richer address validation levels** (Small). Return a ShipEngine-style
   `status` (verified/warning/unverified/error) + candidate `matched_address`, and
   accept an array. Mostly reshaping the `fedex.js address` response already wired in.

8. **International/customs completeness** (Medium). Accept `customs_items[]`
   (description, qty, value, HS code, country_of_origin) and pass through to the
   `commodities[]` array `ship.js` already builds (currently collapses to one
   commodity). Needed for any customer shipping intl parcels for real.

9. **Batch labels** (Large). A `Batch` object (`POST /v1/batches` → add shipments →
   async purchase). Large because Netlify's per-invocation time budget forces a
   queue/worker pattern that doesn't exist yet. Only worth it once a high-volume
   customer asks — sequence it after 1–5.

10. **An official SDK (start with Node + Python thin wrappers)** (Medium). Not a
    capability gap but the #1 adoption-friction gap vs all three competitors. A
    generated client over the existing endpoints lowers the barrier for the exact
    small-integrator customers this API targets.

**Explicitly NOT worth building (enterprise noise for this platform):**
- Multi-carrier account CRUD / carrier-account management — the reseller *owns* the
  carrier relationship; letting customers attach their own carriers is an anti-goal.
- Standalone insurance object + claims API — declared-value coverage is already priced
  into the quote; claims are an ops/manual process at this scale.
- Rate-shopper / bulk-rate compare — meaningless with a single carrier.
- SmartRate transit percentiles, NLP address `recognize`, paperless-trade docs —
  polish that no small reseller customer will ask for before the top 8 land.

---

# PART 2 — DEEP IMPLEMENTATION AUDIT

Every finding verified against code and cited `file:line`. Items I could not fully
confirm from static reading are marked **PLAUSIBLE**.

## F1 — Concurrent idempotent bookings double-book (the docs' core promise is false under concurrency)
**Severity: HIGH.** `api.js:205-212` reads the idem store, and `api.js:260` writes it
*after* the label is booked at `api.js:242-244`. Two requests carrying the same
`Idempotency-Key` that arrive close together (network retry that didn't cancel the
first; two workers) both pass the `idem.find(...)` miss, both call `ship.js`, and both
book + charge a real FedEx label. The idem record is only persisted post-booking, so it
can't guard a concurrent sibling. `api-docs.html:99` promises "a retry can never
double-book or double-charge" — that holds only for *sequential* retries. Netlify runs
many concurrent containers, so this is reachable in normal operation.
**Fix sketch:** reserve the key before booking — write a `{k, status:"pending"}` idem
row first; if a concurrent writer already placed one, return 409/replay-wait; only then
book and update the row to the final response. Because the store is last-write-wins
JSONB this still isn't perfectly atomic, so pair it with a Supabase unique row per idem
key (`key = u/api_<id>/idem_<idemKey>`) and rely on the DB's insert-conflict as the true
mutex.

## F2 — Read-modify-write races lose shipment records → silent revenue leak
**Severity: MEDIUM (money).** `api.js:257` does
`getStore(shipStoreKey) … putStore([rec, ...arr])`. Two bookings for the same account
in the same second both read array `A`, each prepend their own record, each write back;
the second write clobbers the first record. The FedEx labels were really booked and the
customer really owes for both, but only one lands in the store that
`/v1/billing` + the admin dashboard bill from (`api.js:349-355`). Net effect: booked,
shipped, **not billed.** Same last-write-wins hazard hits the idem array (`api.js:260`),
pickups (`api.js:334`), void (`api.js:278`), and webhook registration (`api.js:319`).
**Fix sketch:** move append-heavy stores to per-record rows (`.../ship_<id>`) so writes
never collide, or perform the append via a Supabase RPC/`jsonb` server-side merge
instead of client read-modify-write. At minimum, document the concurrency ceiling.

## F3 — Webhook SSRF: `validHookUrl` is bypassable multiple ways
**Severity: MEDIUM (blind SSRF).** `api.js:94`:
`x.protocol==="https:" && !/localhost|127\.|\.local$/i.test(x.hostname)`. This blocks
only three spellings. It does **not** block:
- **Private IP literals**: `https://10.0.0.5`, `https://192.168.1.1`, `https://172.16.0.1` all pass.
- **Other loopback forms**: `https://[::1]` (IPv6), `https://0.0.0.0`.
- **Link-local / cloud metadata**: `https://169.254.169.254` passes the filter (fails
  TLS in practice since metadata is http-only, but internal https services on link-local do not).
- **DNS rebinding**: validation at registration (`api.js:315`) checks only the literal
  hostname string; the actual POST happens later in `fireHooks` (`api.js:104`) with a
  fresh DNS resolution — an attacker hostname that resolves to an internal IP passes.
- **Redirect pivot**: `fireHooks` uses `fetch(h.url, …)` with default redirect
  following (`api.js:104`) — a public https endpoint can `302` to
  `http://169.254.169.254/…` or `http://localhost/…` and the redirect target is never
  re-validated.
This is *blind* SSRF (fire-and-forget, response discarded, `api.js:106`), and the body
carries only label metadata — but it still lets a customer's key drive POSTs to the
platform's internal network and port-scan by timing.
**Fix sketch:** resolve the hostname and reject any RFC-1918/loopback/link-local/ULA/
reserved IP (all resolved addresses, not just the first); set `redirect:"manual"` in
`fireHooks` and refuse cross-origin/downgrade redirects; optionally pin the resolved IP
between validation and delivery.

## F4 — Voided shipments are never cancelled at FedEx
**Severity: MEDIUM (functional + money).** `api.js:273-281` (void) mutates the store row
to `status:"Voided"` and fires `label.voided`, but there is **no** call into
`ship.js`/`fedex.js` to request a FedEx label cancellation/refund. The note it returns —
"the carrier refund is processed automatically" (`api.js:280`, echoed in
`api-docs.html:75`) — is not backed by any code path. Unshipped FedEx labels are only
auto-credited by FedEx if actually voided via API within the void window; a local flag
doesn't trigger that. Reseller keeps paying FedEx for labels the customer believes were
refunded.
**Fix sketch:** add a `void`/`cancelShipment` action to `fedex.js` (FedEx
`PUT /ship/v1/shipments/cancel`) and call it (skipped for `isTest`) before flipping the
store status; surface real success/failure.

## F5 — Per-key rate limit is per-container, effectively unenforced
**Severity: LOW-MEDIUM.** `api.js:53-54` keeps `HITS` in module memory; `api.js:138`
enforces 240/min "per key." Netlify fans out across many warm containers with no shared
counter, so real throughput ≈ 240 × N-containers. The code itself concedes this ("the
auth gate is the hard control", `api.js:52`). Not a breach, but the documented
guarantee (`api-docs.html:39,116`) is not truly enforceable and a determined caller can
exceed it. Also the eviction sweep at `>4000` keys (`api.js:54`) is O(n) on a hot path.
**Fix sketch:** move the counter to Supabase (atomic increment per `key:minute` row) or
accept it as advisory and soften the docs. Low priority for a reseller with few keys.

## F6 — `apiKeys` store rewrite on last-used stamp can resurrect a revoked key
**Severity: LOW (narrow race). PLAUSIBLE.** `api.js:140-143`: on a request, if
`lastUsed` is >1h stale, the handler writes the **entire** `world.keys` array back via
`putStore("apiKeys", world.keys)`. `world.keys` is the snapshot loaded at
`api.js:131`. If an admin calls `apiKeyRevoke` (`db.js:752-757`, sets `revoked:true`)
during an in-flight request that loaded keys pre-revocation, the api.js write-back
persists the stale array and flips `revoked` back to false — un-revoking the key. The
1-hour throttle makes the window small, but it exists and it's security-relevant.
**Fix sketch:** don't rewrite the whole array for a telemetry stamp — either drop the
lastUsed write, or update just that key's row via a targeted merge, or re-read
immediately before writing.

## F7 — Unbounded label-PDF row growth
**Severity: MEDIUM (cost/scale).** Every booked label writes a **separate** store row
holding a base64 PDF: `labelStoreKey(client,id)` → `u/api_<id>/label_<id>`
(`api.js:90,258`). Unlike shipments (capped 5000, `api.js:257`), idem (50), pickups
(200), and webhooks (5), these label rows are **never pruned or capped.** Each is tens
of KB. Over time `app_stores` grows without bound, one permanent row per label ever
booked, per account — DB bloat and slower `like`/scan queries.
**Fix sketch:** cap retention (e.g. keep PDFs N days or last M per account and prune on
write), or move PDFs to object storage keyed by label_id, storing only a reference.

## F8 — Malformed-but-valid JSON body yields 500 instead of 422
**Severity: LOW (robustness).** `api.js:172,215` do
`body.packages.map(pieceOf)`. If `packages` is `[null]` or `[1]`, `pieceOf(null)`
dereferences `null.weight` (`api.js:61`) and throws; the outer catch
(`api.js:364-366`) returns a generic `500 internal_error`. A client sending a
structurally-odd-but-parseable body gets a server error, not a clean validation error.
**Fix sketch:** coerce non-object entries in `pieceOf` (`const p = pkg||{}`), or filter
`packages` to plain objects before mapping.

## F9 — Upstream carrier error strings leak to API consumers
**Severity: LOW (info disclosure).** Several paths pass raw upstream errors straight
through: `rates_unavailable` returns `q.error` (`api.js:183`), `booking_failed` returns
`res.error` (`api.js:245`), address `validation_unavailable` returns `res.error`
(`api.js:156`), pickup errors (`api.js:304,332`). `ship.js` mostly sanitizes and masks
the FedEx account number (`ship.js:299-301`), so the exposure is limited FedEx wording
rather than secrets — but it does confirm "FedEx" as the backend, contradicting the
docs' claim that "nothing about the upstream provider leaks" (`api-docs.html:121`).
**Fix sketch:** map upstream errors to platform-neutral messages for the API surface;
log the detail server-side only. Low priority.

## Items checked and found OK (so they aren't re-investigated later)

- **`shipStoreKey(client,isTest)` refactor is consistent.** Every call site passes
  `isTest`: `api.js:257, 267, 278, 287, 349`. Definition `api.js:89`. No call omits the
  arg, so test and live shipment/billing/tracking data never mix. Grep across `src` +
  `netlify` shows no other consumer of these `u/api_*` keys (only `api.js` writes them),
  so nothing outside expects the old single-arg shape. **No test/live bleed.**
- **Test-mode escape: none found.** `isTest` (`api.js:145`) gates every money path:
  labels short-circuit to a synthetic tracking number and never call `ship.js`
  (`api.js:242-244`); pickup create returns a fake `TESTPICKUP…` (`api.js:330`); pickup
  cancel matches `isTest || /^TESTPICKUP/` before any FedEx call (`api.js:302`). Rates
  and address validation intentionally hit FedEx for both modes (read-only, no cost).
  **No path lets a test key reach `ship.js`/`fedex.js` for a real booking.**
- **Key-hash auth is not timing-exploitable.** `api.js:132-133` compares
  `sha256(rawKey)` with stored `k.hash` via `===` (not `timingSafeEqual`). A timing leak
  would reveal bytes of the *stored hash*, not the key; recovering a key from its hash is
  a preimage break. Attacker already knows the hash of any key they submit, so the leak
  is inert. Acceptable as written (a constant-time compare would be tidier but isn't a
  vuln here).
- **Cross-account isolation holds.** Every store key derives from
  `client.id`/`keyRow.clientId` (`api.js:135, 89-93`). Label re-download, void,
  tracking, billing are all scoped to the caller's client; no IDOR to another account's
  data.
- **CORS is safe.** `Access-Control-Allow-Origin: *` with **no**
  `Allow-Credentials` (`api.js:49`); auth is a bearer/API-key header, not cookies, so
  wildcard origin carries no CSRF/credential risk.
- **JSON parse of the body doesn't crash.** `api.js:123` catches parse errors and
  returns `bad_json` (422-ish 400) for POST, `{}` otherwise; the whole handler is
  wrapped in try/catch (`api.js:112, 364`).
- **Path parsing is robust to the common edges.** `api.js:119` strips both prefix forms
  and `filter(Boolean)` drops empty segments, so trailing slashes
  (`/api/v1/rates/`) and doubled slashes normalize fine. The `/^\/api(?=\/)/` lookahead
  is precise (won't mangle `/apixyz`). Case-sensitivity is the only rough edge: an
  upper-case `/API/...` won't match the strip and 404s — cosmetic, not a security issue.
- **`netlify.toml` ordering is correct.** The `/api/*` rewrite (`netlify.toml:12-14`)
  precedes the SPA catch-all (`netlify.toml:20-23`), and real static files (e.g.
  `api-docs.html`) are served before redirects, so pretty API URLs, the docs page, and
  SPA routes don't collide.
- **Test-shipment invisibility is intentional and works.** `testShipments` key
  (`api.js:89`) deliberately fails the `db.js:706` wipe-guard regex
  `^u\/[^/]+\/(orders|shipments)$` and the ops/billing scan — live api shipments
  (`.../shipments`) *do* match and are protected. Working as designed.

## Ranked fix list

| # | Finding | Severity | Effort | Why this rank |
|---|---|---|---|---|
| 1 | **F1** concurrent idempotent double-book | HIGH | Small–Med | Directly double-charges customers; contradicts a documented guarantee; reachable in normal multi-container operation |
| 2 | **F3** webhook SSRF bypasses | MEDIUM | Small–Med | Customer-triggerable reach into internal network; several independent bypasses; cheap to close |
| 3 | **F2** RMW races drop shipment records | MEDIUM | Medium | Silent revenue leak — booked+shipped but unbilled |
| 4 | **F4** void never cancels at FedEx | MEDIUM | Small | Reseller keeps paying FedEx for "refunded" labels; also a Part-1 functional gap |
| 5 | **F7** unbounded label-PDF rows | MEDIUM | Small | Steady DB bloat; simple retention cap fixes it |
| 6 | **F6** revoked-key resurrection race | LOW–MED | Small | Security-relevant though narrow window; easy to eliminate |
| 7 | **F5** per-container rate limit | LOW–MED | Small | Documented limit not truly enforced; either back it with the store or soften docs |
| 8 | **F8** malformed body → 500 | LOW | Small | Robustness/DX polish |
| 9 | **F9** upstream error leakage | LOW | Small | Minor info disclosure; contradicts a docs claim |
