# Handoff — ShippingCloud / Freightwire (2026-07-13, session 2 — DB restore)

Owner: **Spencer Anderson** (spenceranderson49@gmail.com) — non-technical. Multi-brand FedEx-reseller
shipping platform. Repo: `spenceranderson49/ShippingCloud`. Develop on branch
**`claude/admiring-volta-f5qnxr`** (check it out first — the last session's work lives there, NOT on main).

## ⚠️ Read first — safety protocol (Spencer has been burned by data loss; lead with data safety)
1. **STAGING ONLY** unless Spencer explicitly says "push to production."
2. **NEVER delete or bulk-overwrite admin/customer data.** Every DB write must be **additive/surgical**.
3. **Before ANY write, take a fresh full backup** (call the guardian, or snapshot the affected keys to
   `bak:<key>:<iso>` rows). The app also auto-snapshots critical stores and has wipe guards (F19/F20).
4. **Ask Spencer before any delete**, even a "cleanup" one. Show him exactly what will change first.
5. Commit trailers: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + the Claude-Session line.
   Do NOT put a model ID/name in commits, code, or pushed artifacts.

## Network / DB access (NEW this session)
- Spencer set the Claude environment **Network access → Full**, so a fresh session CAN reach Supabase.
- **Supabase project:** `https://cjggkmxlqvjhgbpzukvv.supabase.co`, table `app_stores (tenant, key, value jsonb)`.
- **Service key:** do NOT hardcode. Read `SUPABASE_SERVICE_KEY` (+ `SUPABASE_URL`) from Netlify env on the
  **production** site `65e219f6-c528-44cc-8134-3953a1bfa1b5` via the Netlify MCP `manage-env-vars`
  (`getAllEnvVars:true`). Auth header: `apikey: <key>` + `Authorization: Bearer <key>`.
- **Two tenants:** `main` = PRODUCTION (shippingcloud.net / freightwireship.com). `sandbox` = the old test
  DB that production was rebuilt from on 2026-07-11. Query any tenant with `?tenant=eq.<t>&key=eq.<k>`.

## What happened (root cause)
The 2026-07-11 sandbox→production migration did NOT carry every login's per-user data across. So some
production (`main`) accounts kept stale copies or the old factory **demo** Autopilot rules (rule names use
a "→" arrow; hand-made rules never do). Sandbox is the source of truth for LAgence's migrated data. This is
migration drift, not a bug in daily use, and not caused by any code deploy.

## Pending DB tasks (do these, snapshot-first, confirm deletes with Spencer)

### 1. LAgence rules — DONE (Spencer restored the 4 real rules via console). Verify only.
- Login `u1783446563465` (spenceranderson49@gmail.com, client `c1783447238484` "LAGENCE").
- `main` key `u/u1783446563465/ruleset` should now be the 4 real rules: **Overnight, 2DAY,
  Free Shipping | Home Delivery, Free Shipping | Ground Economy**. If it still shows the 7 arrow-named
  demo rules, restore the 4 from `sandbox` tenant same key.

### 2. LAgence logo — LIKELY STILL MISSING on production. Restore it.
- Header logo = `u/u1783446563465/settings`.**companyLogo** (a `data:image/png;base64,…`, ~18 KB).
- In `main` it is EMPTY; in `sandbox` it is present. Fix = read `companyLogo` from **sandbox**
  `u/u1783446563465/settings`, then MERGE it into the **main** `u/u1783446563465/settings` object
  (set only `.companyLogo`; keep everything else in main's settings as-is). Snapshot main's settings first.

### 3. Riley Blake — factory demo rules to clear (CONFIRM WITH SPENCER FIRST).
- Login `u1783917884617639` (rileyblake@testtest.com, client `c1783917884615275` "Riley Blake").
- `main` key `u/u1783917884617639/ruleset` = the **full 7-rule factory demo set** (6 arrow-named +
  the demo "Free Shipping"); no custom rules, no sandbox counterpart → it's all demo.
- Looks like a **test account** ("testtest.com"). Ask Spencer if it's real. If yes → clear the ruleset to
  `[]` (snapshot first). If it's just a test account, leave it.

### 4. Full drift audit (report, don't auto-fix).
- For every uid present in both tenants, compare `ruleset`, `settings.companyLogo`, and order/shipment
  counts (`u/<uid>/orders`, `u/<uid>/shipments`). Flag: accounts still carrying arrow-named demo rules;
  logos present in sandbox but missing in main; large order/shipment count gaps. **Do NOT auto-copy
  orders/shipments** — main may have NEWER records; report the gaps and let Spencer decide per account.
- Accounts seen in `main` at start of day: Demo Accounts, LAGENCE, Full Lagence Test, Granite Seed,
  Riley Blake. Demo Accounts is an intentional demo (its demo rules are fine).

## Code state (feature branch `claude/admiring-volta-f5qnxr`, all tested, NOT deployed)
Production `main` is at **addr-v508**. On the branch, tested (`bash claude/tests/run.sh` → ALL TESTS PASSED),
awaiting staging:
- **v509** admin login rows → primary + "···" overflow menu; consistent primary-button colors + Settings
  headers; db.js email punctuation.
- **v510** removed the "bring your own carrier account" section from Carrier Accounts.
- **v511** removed the curved "SHIPPINGHUB AI" wordmark from the floating assistant button.
- **v512** guardian-nightly: new drift alarm (job 2b) — flags real customer logins carrying factory demo
  rules or a newly-missing logo, in the nightly email. **Only runs on production**, so it needs to reach
  `main` to start alerting.
- **v513** new accounts start with an EMPTY product catalog (no sample goods); assistant renamed
  **"Freightwire AI"** on Freightwire/admin brands (ShippingCloud white-label keeps its own name).
- **v514** Company admin → "Shared address book": push the admin's address book to whole team / selected
  logins (rides on `companySetFlags` `_addresses` payload; additive/deduped; personal entries untouched).
  Also fixed a latent bug where `companySetFlags` coerced ALL flag values to booleans (flattening the
  `_custom`/`_products` deploy payloads to `false`).

## Deploy workflow (when Spencer approves staging/prod)
Feature branch → merge into `staging` (builds `shippingcloud-staging.netlify.app`) → only when approved,
merge into `main` (builds shippingcloud.net + freightwireship.com). Bump `BUILD_TAG="addr-vNNN"` near the
top of `src/App.jsx` each release. `netlify.toml` auto-deploys both. Netlify MCP available.
Staging uses a SEPARATE Supabase tenant — its data is a different copy (this caused past false alarms).

## How Spencer communicates
Non-technical, fast, rapid-fire, sends screenshots. Wants honest status ("a true rundown"), gets (rightly)
upset about data loss — always lead with the concrete reason his data is safe, then act.
