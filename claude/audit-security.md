# ShippingCloud — Security + Data-Safety Audit

Date: 2026-07-11 · Scope: netlify/functions/* + src/App.jsx print/session surfaces
Method: read every action/handler in scope, verified in code. No files edited.

Severity legend: CRITICAL / HIGH / MED / LOW.

---

## 0. Headline (read this first)

- **CRITICAL — carrier endpoints have NO authentication.** `quote.js`, `ship.js`,
  `fedex.js`, `fedex-ship.js`, `ups.js` never verify a session token. An
  unauthenticated internet caller can POST to `/.netlify/functions/ship` and book
  a REAL FedEx label on the site owner's account (creds from env). See F1.
- **HIGH — `assistant.js` is an open Anthropic proxy** (no token gate) → API-key cost abuse. See F2.
- **MED — `requestAccess` is an unauthenticated, un-rate-limited account/blob factory.** See F3.
- Most print surfaces DO escape user data correctly (packing slip, CI, manifest,
  doc tab, receipt, pick list, custom docs). The claimed "malicious order name"
  XSS is largely **NOT present** — order names are escaped. Residual unescaped
  sinks are admin-only values (rate-sheet profile names). See section 2.

---

## 1. db.js — auth/role gates per action

### F4. setPassword (self-service) requires NO current password — MED
`db.js:701-717`. Self path authorizes only on `auth.uid === users[idx].id` (good, UID-keyed,
comment at 709-712 correctly defends the changeEmail-token-staleness case). BUT there is
**no current-password re-check** for a self password change. `changeEmail` (721-737) and
`totpDisable` (474-487) both demand the password/OTP; `setPassword` does not.
- Attack: a hijacked/stolen session token (30-day, non-revocable — see F10) can silently
  reset the victim's own password, locking the real owner out, with no re-auth.
- Fix: require `checkPw(body.currentPassword, me.passHash)` on the non-admin self branch.

### F5. TOTP backup-code replay under concurrency — LOW/MED
`db.js:277-284` (login) and `consumeBackup` `156-166`. The used-state is persisted before a
session is granted (good — no single-request replay). But consume→write is read-modify-write
on the whole `users` array with last-write-wins. Two logins firing the SAME backup code within
the same ~1s window both read it unused, both mark used locally, both `putStores` succeed (LWW),
both get sessions → a one-time code used twice.
- Fix: conditional write (compare-and-set on the code hash) or a short per-uid lock.

### F6. changeEmail / TOTP suite — CLEAN (verify)
- `changeEmail` requires current password, preserves passHash+totp via spread, rejects email
  collision, reissues token. Correct.
- `totpBegin` stashes a *separate* `pendingSecret` and never touches a live secret/backup
  (defeats "stolen session silently drops 2FA"). `totpEnable` requires a valid code off the
  pending secret. `totpDisable`/`totpBackupRegen` require code-or-password. `clearTotp` is
  admin-only. Login fails CLOSED when enabled-but-secret-missing. All correct.

### F7. healClientFor minting — CLEAN
`db.js:231-239`, called from login (286-292) and getAll (513-518). No-ops for admin/demo and
for logins whose clientId already resolves; only mints on a successful read; requires a valid
authenticated user. Not abusable without valid creds. Minor: mint uses `Date.now()+rand(1000)`
ids — collision-improbable, acceptable.

### F8. approveSignup / company actions — CLEAN
- `approveSignup`/`denySignup` admin-gated (`794-813`), dup-email guarded, uses stored passHash.
- Company actions (`554-632`) require an ACTIVE `companyAdmin` with a `clientId`; every target is
  fenced by `sameCompany()` (same clientId, non-admin). `companySetActive` blocks self-deactivate.
  `companySetFlags` caps 64 keys. `companyCreateUser` dedupes email, 2000 cap. Correct.

### F9. putMany guards — mostly CLEAN, two gaps
`db.js:634-699`.
- `canWriteKey` (`213`): admin → any key except `session`; others → only `u/<uid>/` prefix.
  Namespace wall is enforced server-side. Correct.
- Stale-tab resurrection window (`647-661`): re-adds users/clients created in the last 15 min
  that an incoming whole-array write omitted. Correct and well-reasoned.
- CRITICAL-store wipe guard + `bak:` snapshots (`669-692`): refuses array→empty and
  rateRules→zero-profiles; snapshots prior value. Correct.
- **GAP 9a (MED):** only `["users","clients","rateRules","featureFlags"]` get wipe-guard +
  snapshot. Per-user stores `u/<uid>/orders`, `u/<uid>/shipments`, settings are NOT covered — a
  stale customer tab doing whole-array LWW can silently wipe that customer's own orders/shipments
  with no snapshot. See also F14.
- **GAP 9b (LOW, admin-only):** `bak:` prune builds a PostgREST `key=in.("a","b")` list from DB
  keys with only `.replace(/"/g,"")` (`688`). An admin can write an arbitrary key name
  (canWriteKey lets admin write anything but `session`), e.g. a key containing `,` or `)`; if it
  ever matched the `bak:` prefix it could malform the `in.()` filter. Customers cannot reach this
  (namespace wall blocks `bak:` keys). Self-tenant, admin-only → low. Fix: encode keys or filter
  by exact list via POST body, and never let app writes create `bak:`-prefixed keys.

### F3. requestAccess flood/dup — MED (moved up; it's the biggest db.js abuse surface)
`db.js:303-362`. Unauthenticated. Dup-email is rejected (`313`) and there's a 2000-user hard
cap (`314`) and a 199-cap on fedexRequests. BUT: no captcha, no rate limit, no per-IP throttle.
- Attack: script thousands of unique-email signups → each appends to the single `users` and
  `clients` JSONB rows (unbounded row growth → getAll/login parse-cost balloons for everyone),
  can attach a ~3.4 MB blob per signup (Netlify Blobs storage cost), and exhausts the 2000 cap
  to block legitimate signups. Also auto-mints a live customer + client each time.
- Fix: add a proof-of-work/captcha or per-IP rate limit; cap unapproved self-signups far below
  2000; defer client-record creation until admin approval.

---

## 2. HTML injection on printable surfaces

Verified every `document.write` / `window.open` / `printHtmlViaFrame` builder. Each has its own
local `esc()` that neutralizes `& < >`.

### CLEAN (user-controlled strings ARE escaped):
- `packingSlipHTML` `App.jsx:1627-1651` — company/orderName/to.*/items/note/tracking all `esc()`.
- `receiptHTML` `1728-1748` — labels/values/title `esc()`.
- `docTabHTML` `1786-1800` — label/value/tracking `esc()`.
- `printPickList` `1858-1867` — item names `esc()`.
- `printCommercialInvoice` `1871-1965` — consignee name/company/address/email/phone, item
  names/HS/origin, notes/broker all `esc()`; `o.name` order ref `esc()` (title + invoice #).
- `manifestHTML` `9498-9518` — recipient/sender/city/state/tracking/service all `esc()`.
- OtherDocs `print` `11762-11779` — name/title/body/sender fields `esc()`.
- `email.js` `shippedHtml` `31-46` — every template field `esc()`; also token-gated relay.

**Conclusion on the "malicious order name `<img onerror>`" scenario: NOT reproducible** — order
names/refs and Shopify-sourced customer names/addresses flow only through the escaped builders
above. This is a genuinely clean area.

### Residual unescaped sinks (LOW — admin-only values, image `src` data-URIs):
- Rate-sheet printers `printSheetsMulti` `App.jsx:4020`, `printAccSheet` `4044`, `printSheet`
  `4065`: interpolate `prof.name` and `sheet.l` **without** escaping. These are admin-set profile
  names / fixed service labels, not customer input → self-XSS only. Escape them for hygiene.
- Attribute-context image sources inserted raw (not escaped): `receiptHTML` `1744`
  `src="${logoUrl}"`; CI `1920/1957/1961` `src="${lh|signature|im.data}"`; OtherDocs `11770/
  11775/11777` `src="${letterhead|signature|data}"`. All are admin/settings-supplied data-URIs.
  A `"` in one would break out of the attribute; not currently reachable by a customer. LOW.

---

## 3. Token / session

### F10. 30-day HMAC token, no revocation — MED
`db.js:83` `makeToken` → `exp: now + 30d`; `verifyToken` `84-94` only checks signature + exp.
- No server-side revocation list, no "logout everywhere," no rotation on password change. A
  leaked token is valid for up to 30 days. Combined with F4 (no-password self reset) a stolen
  token is a full account takeover. Fix: add a per-user `tokenEpoch` in the users store, embed it
  in the token, bump it on password change / explicit revoke; reject tokens with a stale epoch.

### F11. clientId snapshot staleness — LOW
`makeToken` embeds `clientId` at login. If an admin reassigns the customer's client afterward,
the 30-day token still carries the old id. Mitigated: getAll (`513-518`) and login re-heal, and
`App.jsx:5913` re-resolves client from the live users row. Residual only if heal read fails.

### F12. "Log in as" impersonation keeps the ADMIN token — MED
`App.jsx:3526` & `4742`: impersonation does `lsSet("adminReturn",currentUser); lsSet("session",u);
reload()` but **never changes `CLOUD.token`** (`4993`, set only at login `2948/5187/5203`). So:
- The server still authorizes every getAll/putMany as the ADMIN (returns all stores, admin-write
  everywhere); the "see exactly what they see" view is a client-side illusion filtered in the
  browser, NOT the customer's server-scoped slice — so it does not faithfully reproduce the
  customer's data-isolation, and any save during impersonation writes with admin privilege.
- `adminReturn` persists in localStorage; an abandoned tab stays in impersonated-UI state on an
  admin-privileged token. It's an admin-only feature so not a privilege escalation, but the
  privilege is not actually dropped. Fix: mint a real scoped customer token server-side for
  impersonation (short-lived, audit-logged) instead of reusing the admin token.

---

## 4. Shopify functions

### F13. SSRF via `shop` — CLEAN (not exploitable)
`shopify-auth.js:30 sanitizeShop`, `shopify-sync.js:63`, `shopify-fulfill.js:39` all gate `shop`
with `^[a-z0-9][a-z0-9-]*\.myshopify\.com$` before any `https://${shop}` fetch. Destination is
constrained to the myshopify.com apex — no arbitrary-host SSRF. Correct.

### Shopify auth/token handling — mostly CLEAN, notes:
- `shopify-auth.js`: OAuth HMAC is verified strictly (`verifyOauthHmac`, timing-safe); `state` is
  a soft anti-CSRF nonce that intentionally does NOT hard-fail (HMAC is the gate) — acceptable per
  Shopify guidance. Token handed back in URL **fragment** (`87`) — standard SPA pattern; note it
  still lands in browser history/SPA memory (LOW, inherent to the pattern).
- `shopify-sync.js`/`shopify-fulfill.js` have **no ShippingCloud session gate** — they're a thin
  proxy to the Shopify Admin API keyed only by the caller-supplied `{shop,token}`. Since the token
  IS the Shopify credential, this isn't a privilege leak, but anyone holding a store token can
  drive it (order reads, fulfillment writes, `updateOrder` address/email edits) from anywhere.
  LOW given the token is the secret; consider still requiring a valid SC session for defense-in-depth.

### F15. Compliance webhook claims "no server-side data" — MED (accuracy/GDPR gap)
`shopify-compliance.js:57-73` HMAC-verifies (401 on bad sig, 200 on valid — correct for review)
but every topic only `console.log`s and asserts ShippingCloud warehouses no merchant customer
data. That's **not fully accurate**: Shopify orders synced via `shopify-sync.js/transform` are
persisted into the merchant's `u/<uid>/orders` (and shipments) rows in Supabase `app_stores`
(see db.js putMany), carrying customer names/addresses/emails/phones. `customers/redact` and
`shop/redact` do not purge those. Fix: on redact, actually scrub matching order records from the
tenant's per-user stores (or document a manual 30-day process and honor it).

---

## 5. quote.js / ship.js / fedex.js — unauthenticated

### F1. NO auth on carrier booking/rating — CRITICAL
`ship.js` (whole handler `113-302`), `quote.js` (`101-316`), `fedex.js`, `fedex-ship.js`, `ups.js`
parse `event.body` and act **without any `verifyToken`/session check** (confirmed: zero refs to
token/SESSION_SECRET in quote.js/ship.js/fedex-ship.js).
- `ship.js` books against `FEDEX_CLIENT_ID/SECRET/ACCOUNT` from env. An unauthenticated caller
  POSTing `{action:"ship", order:{...}}` gets a **real, billable FedEx label** on the owner's
  account, to/from any address, any service — from anywhere on the internet. This is direct
  financial loss + fraud/abuse exposure.
- Caller can even set `order.fedexAccount` / `billingParty` (`ship.js:153,186-187,228`) to steer
  billing; sender-paid falls back to the owner's account.
- `quote.js` leaks the owner's rate card (account + list pricing) to anyone.
- No rate limiting anywhere → also a cost-amplification/DoS vector against FedEx API quotas.
- Fix: require a valid SC session token on quote/ship/fedex/ups exactly like `email.js` does
  (`email.js:55-56`), reject otherwise; add per-session/IP rate limiting.

### F16. Credential / account echo in errors — MED (compounds F1)
- `ship.js:263` embeds the owner's FedEx **account number** verbatim (`"#"+acct`) in the error
  returned to an unauthenticated caller. `quote.js:311` masks it (`$1****$2`) — inconsistent;
  ship.js should mask too. FedEx client_secret is never echoed (auth errors only surface status)
  — good. Fix: mask the account in ship.js errors and gate the endpoint (F1) so errors aren't
  world-readable.

### Rate-limit absence — MED
None of quote/ship/fedex/ups/assistant implement any throttle. See F1/F2/F3.

---

## 6. Data safety

### F14. Concurrent / stale-tab loss on per-user stores — MED
`u/<uid>/orders` and `u/<uid>/shipments` are whole-array last-write-wins with NO wipe-guard and
NO snapshot (only `users/clients/rateRules/featureFlags` are CRITICAL in db.js `669`). Two tabs,
or a stale tab, can silently truncate a customer's orders/shipments. Fix: extend the wipe-guard +
`bak:` snapshot to per-user array stores, or move to row-level (per-record) writes.

### F17. Snapshots are written but there is NO restore path in the app — MED
db.js writes `bak:<key>:<iso>` rows and getAll skips them ("restored on request", `496`), but
**no `restore` action exists** anywhere in db.js (grep: only the skip, the write, and the prune).
The "anything is restorable" guarantee (`668`) is only true via **manual Supabase SQL** — there
is no operator UI/endpoint. Also only the newest 10 snapshots/key are kept; a burst of >10 bad
saves within one incident evicts the good baseline. Fix: add an admin-only `listBackups`/`restore`
action; consider time-based rather than count-based retention.

### Concurrent admin saves of settings/rateRules — LOW (mitigated)
`rateRules` is CRITICAL so a wipe is refused and every overwrite is snapshotted → a clobber is
recoverable (subject to F17's manual-restore caveat). Non-wiping concurrent edits (two admins on
different profiles) are still LWW — one silently overwrites the other, but the drafts mechanism
and snapshots blunt permanent loss. Acceptable; consider optimistic-concurrency (updated_at
check) on rateRules writes.

---

## Fix priority

1. **F1** (CRITICAL): put a session gate + rate limit on quote/ship/fedex/fedex-ship/ups. Nothing
   else matters as much — it's remote, unauthenticated, and directly bills real money.
2. **F2** (HIGH): token-gate assistant.js.
3. **F4, F10, F12** (MED): current-password on self setPassword; token revocation/epoch;
   real scoped token for impersonation.
4. **F3, F14, F15, F16, F17** (MED): signup throttle; per-user store snapshots; honest Shopify
   redact; mask account in ship errors; add a restore path.
5. **F5, F9b, section-2 residuals** (LOW): backup-code CAS; escape admin sheet names; encode bak
   prune keys.

## F2 (detail) — assistant.js open LLM proxy — HIGH
`assistant.js:108-156` has no `verifyToken`. Anyone can POST `{messages:[...]}` and burn the
owner's `ANTHROPIC_API_KEY` (capped 700 tokens/reply, 16-msg history, but unlimited request rate).
Cost-abuse + could be scripted as a free Claude relay. Fix: gate with the shared session token
like email.js, and rate-limit.
