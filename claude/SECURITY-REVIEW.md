# Security review — ShippingCloud (overnight)

**Date:** 2026-07-10. Reviewed `src/App.jsx` (client) + `netlify/functions/*.js` (db, printnode, shopify-auth/-sync/-fulfill, quote, fedex, places). No live pen-testing (env firewalled from Supabase/domains) — this is a code review.

## Verdict: tight. No high-severity issues found.

### Confirmed good
- **No dangerous DOM sinks** — zero `dangerouslySetInnerHTML`, `innerHTML`, `eval`, or `new Function` in the app. React auto-escapes all rendered values, so the UI has no stored/reflected XSS surface.
- **Printed-doc HTML is escaped** — every HTML generator (packing slip 1350, receipt 1449, doc tab 1507, pick list 1584, receipt-alt 1595, manifest 8247) defines an `esc()` and runs user fields through it before interpolation. Printed via a sandboxed same-origin iframe.
- **Auth (db.js)** — passwords: `scryptSync` + `timingSafeEqual`; sessions: HMAC tokens, length-checked timing-safe compare, 30-day expiry; reset tokens time-boxed + timing-safe; legacy plaintext upgraded on login. Password hashes are stripped from every user read (`stripUsers`).
- **Tenant + user isolation** — every read/write is `tenant=eq.<DB_TENANT>` scoped; per-user keys are namespaced `u/<uid>/…` and `canWriteKey`/`userScope` block a non-admin from reading or writing another user's keys; `session` is never persisted server-side.
- **Injection** — PostgREST paths use `encodeURIComponent` on tenant + key; values travel as JSON bodies. No string-built SQL.
- **OAuth token hygiene** — the Shopify token returned in the URL fragment is captured then **immediately wiped** via `history.replaceState` (App.jsx:5160–61), so it doesn't linger in history.
- **Credentials at rest** — PrintNode/England/Shopify keys live in per-user `settings` (namespaced, not readable cross-user). Not logged (the one reset log line prints a status message, not the token).

### Low-severity hardening notes (not fixed — low value / churn)
1. **`esc()` escapes `& < >` but not `" '`.** User fields land in *text* content (safe), but a couple of spots put user-controlled values near attributes (e.g. a company logo data-URL in `<img src>`). Worst case is **self-XSS in your own printed document** — no cross-user path. Optional: extend each `esc()` to also escape quotes.
2. **Session token in `localStorage`** (`cloud.token`) — standard for SPAs; means a successful XSS could read it, but there's no XSS sink (see above). Acceptable.
3. **Admin reads all users' settings** (by design) — fine, but worth remembering the admin login is a high-value target ⇒ **2FA on admin accounts is the highest-leverage hardening** (being added this session).

### Recommendation
The codebase is in good shape. The single most valuable security add is **two-factor auth**, especially on the built-in admin logins — implemented this session (opt-in, TOTP). Beyond that, optionally harden `esc()` quotes and consider a shorter session lifetime for admin roles.
