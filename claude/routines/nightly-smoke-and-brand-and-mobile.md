# Routines: post-deploy smoke (#2), brand/copy consistency (#5), mobile/responsive (#6)

Three related quality routines. Each is ready to enable (interactive session or Schedules/Automations).
All are READ + REPORT — they never change code; they open a PR-worthy report and notify only on issues.

---

## #2 — Smoke test (verify the key flows still work)

- **Schedule (cron):** `0 10 * * *` → 10:00 UTC = **4:00 AM Mountain**, daily. (Also fire it on demand right after any deploy.)
- **Mode:** fresh session · **Notifications:** push + email (on failure)

**Prompt:**
You are the smoke tester for the ShippingCloud app. Verify the critical flows still work end-to-end after the latest deploy. Run `bash claude/tests/run.sh` (function syntax, brand bundle builds, rates engine, regression, API parity, 2FA, brand boots, render smoke) — it must end in "ALL TESTS PASSED". Then, using the jsdom boot/smoke harness in claude/tests/, walk the main tabs and admin sections and confirm zero fatal errors. If the app can be launched (see the `run` skill / Playwright with the pre-installed Chromium at /opt/pw-browsers/chromium), drive the highest-value path: sign-in screen renders → a quote renders services → the admin portal opens and the Customers, Rates, and Backups tabs render. Report PASS/FAIL per check to claude/smoke-<YYYY-MM-DD>.md and end with a one-line status. Do NOT change code; if a test is red, report the exact failure. Only alert loudly on a real failure.

---

## #5 — Brand & copy consistency

- **Schedule (cron):** `0 13 * * 2` → 13:00 UTC Tuesday = **7:00 AM Tue Mountain**, weekly.
- **Mode:** fresh session · **Notifications:** push + email

**Prompt:**
You are the brand/copy consistency checker for the ShippingCloud app. Scan src/App.jsx, public/*.html, and netlify/functions/* for: (1) hard-coded product/brand names in USER-FACING strings that should use BRAND.product instead (any literal "ShipHub", "ShippingHub", or "ShippingCloud" in visible copy — the wordmark component and brand-config are the only allowed literals; comments don't matter); (2) the wrong support email/domain for the brand; (3) typos, doubled words, and grammar errors in user-facing copy; (4) leftover placeholders (TODO, lorem, 555-01xx phone, "your-domain", xxx). Report each with file:line + fix to claude/brandcopy-<YYYY-MM-DD>.md. Do NOT change code. End with a one-line count; only escalate if a wrong brand name is reaching customers.

---

## #6 — Mobile / responsive check

- **Schedule (cron):** `0 13 * * 4` → 13:00 UTC Thursday = **7:00 AM Thu Mountain**, weekly.
- **Mode:** fresh session · **Notifications:** push + email

**Prompt:**
You are the mobile/responsive checker for the ShippingCloud app. Launch the app with the pre-installed Chromium (Playwright at /opt/pw-browsers/chromium; do NOT run "playwright install"). Load the key screens at a phone viewport (390×844) and a tablet viewport (820×1180): the landing/sign-in page, the Ship screen, Orders, the customer Settings, and the Admin portal (Customers, Rates, Backups). For each, check for: horizontal overflow / content cut off, overlapping or unreadable text, buttons pushed off-screen or too small to tap, and modals that don't fit. Capture a screenshot of any broken screen. Report each issue with the screen, viewport, and a one-line description to claude/mobile-<YYYY-MM-DD>.md (attach screenshots). Do NOT change code. End with a one-line summary; escalate only if a core flow is unusable on a phone.
