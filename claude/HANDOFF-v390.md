# ShippingCloud — Engineering Handoff (v390)

**Date:** 2026-07-10 · **Build:** `addr-v390` (on `staging`; **prod/`main` is still old code**)
**Owner:** Spencer Anderson (spenceranderson49@gmail.com) — non-technical; deliver COMPLETE files or push to staging, explain in plain language, give numbered status updates.
**Branch this session:** `claude/printer-after-print-shp-screen-g8xnjd`

> Read the original `HANDOFF.md` (uploaded, dated 2026-07-09) first for the deep background — brands, Netlify sites, Supabase, deploy pipeline. This doc is the delta since then.

---

## 0. TL;DR of where things stand

- **GitHub push now WORKS.** Spencer *installed* (not just authorized) the Claude GitHub App on `spenceranderson49/ShippingCloud`. I commit to the branch and push directly to `staging` to test. No more manual file uploads.
- **The v376 settings reorg is finally in git** (it had been delivered as a file but never pushed). Commit `bdcbfb3`.
- **A pile of settings/UX work shipped to `staging`** (see §2).
- **THE open problem: hands-free silent printing works on PROD but NOT on SANDBOX.** Prod (old code) prints silently; sandbox (new code, v390) still shows the browser print dialog / makes Spencer click Print. Root-caused to a re-render the sandbox tenant's label settings trigger; fixes deployed (v389 retry-with-original, v390 strip data: prefix) but **not yet confirmed working by Spencer.** See §3 — this is the first thing to close.

---

## 1. Deploy / workflow (CHANGED — push works now)

- **Develop on** `claude/printer-after-print-shp-screen-g8xnjd`. Commit there.
- **To test on staging:** land the file on the `staging` branch and push — Netlify auto-builds the staging sites. Pattern used all session:
  ```bash
  git checkout -B staging origin/staging
  git checkout claude/printer-after-print-shp-screen-g8xnjd -- src/App.jsx
  git commit -m "... (addr-vNNN)"
  git push -u origin staging
  git checkout claude/printer-after-print-shp-screen-g8xnjd
  ```
- **Prod = `main`.** NOT updated this session. Prod runs the pre-session code (~v375/v376 era). When promoting, test carefully — the new code is a large diff.
- **Commit identity:** `git config user.email noreply@anthropic.com && git config user.name Claude`. Commits still show **"Unverified"** on GitHub (no signing key in this env) — cosmetic, ignore.
- **`BUILD_TAG`** (src/App.jsx line ~109) — bump every release. Currently `addr-v390`. It renders in the footer; Spencer can read it to confirm which build he's on.

## 1a. Validation loop (run before every push)

```bash
npm install                              # fresh container has no node_modules
npm install --no-save jsdom              # for the harness below
# syntax gate (react typedef noise is benign):
npx tsc --noEmit --allowJs --checkJs false --jsx preserve --target es2020 \
  --module esnext --moduleResolution bundler src/App.jsx
# build all 3 brands (shippingcloud LAST so dist/ holds the retail bundle):
for b in shiphub admin shippingcloud; do VITE_BRAND=$b npx vite build; done
# jsdom smoke (recreate /tmp/smoke.js — see §5):
NODE_PATH=$PWD/node_modules node /tmp/smoke.js
```

There is also a **deterministic logic harness** pattern (`/tmp/hf_test.js`) that extracts `openLabelOrDirectPrint` / `directPrintPdf` straight from source by brace-matching and runs them with mocked `fetch`/PrintNode — invaluable for proving the hands-free branch without a browser. Recreate it from §5.

---

## 2. What shipped this session (all on `staging`, v382–v390)

Commits (newest first): `git log origin/main..HEAD`.

1. **Import v376 reorg** (`bdcbfb3`) — grouped Settings sidebar (`SEC_GROUPS`), Ship screen as its own top-level section (`sec==="shipscreen"` → `<Customize only="ship"/>`). Was delivered-but-never-pushed; now in git + a `.gitignore`.
2. **Appearance live preview** — surface colors (header/nav/page = `headerBg`/`navBg`/`pageBg`), accent, and the Freightwire logo tint now preview **live on the real app chrome** before Save. Mechanism: the Appearance editor broadcasts its draft over a `sc-look-preview` CustomEvent; App holds `const [lookPreview,setLookPreview]` and `const srf=lookPreview||custom`, and the chrome (header/nav/main, ~lines 5380–5435) reads `srf.*` instead of `custom.*`. Cleared on unmount. Added a **"Reset accent & surfaces"** button in the Surface colors block.
3. **Print + automation settings unified** into ONE "Ship & print automation" panel in **Print settings** (`PrinterSettings`), top-to-bottom:
   - **1 · When a matching order comes in** (Autopilot): Ship dropdown = *I choose the service* / *Pre-select — other services still show* / *Pre-select — hide the other services*; Batch dropdown = *Do nothing* / *Fill in services* / *Fill in & auto-book*. These set `autoRulesOnShip`/`autoBookOnShip`/`matchedOnly` and `autoRulesInBatch`/`autoBookBatch`. **"Book & print automatically" was removed from the Ship dropdown** (Ship always requires a Book click now); auto-book only lives on Batch.
   - **2 · When a label is created** (3-mode radio): *Hands-free* (`skipBookedSummary`) / *Print automatically, keep the summary* (`directNoPreview`) / *Show a preview first*.
   - **3 · Clear the form after each print** (`resetAfterPrint`).
   - Removed the redundant standalone "Automatically print every label" toggle AND the legacy "Auto-open the print dialog" checkbox (`printer.autoPrint`). Folded the old `matchedOnly` ("Only show the requested service") toggle out of Ship-screen settings into the Ship dropdown.
   - The old Ship-screen "Autopilot" and "After booking" panels were **removed** (consolidated here).
4. **Hands-free printing fixes** — see §3 for the full saga.

**Still-OPEN items from Spencer's original list (NOT done):**
- **6.** Remove "coming soon" / placeholder text (customers will see it).
- **7.** Hide admin-**locked** services *completely* from the customer view (currently greyed out) until admin enables them. (`matchedOnly`/`hiddenServices`/locked logic lives in `Customize`; the collapse/lock is around line ~6420 `collapseBase` and the `SVC` list / `locked` set in `Customize`.)
- **8.** Rename "Carrier accounts" → "FedEx Account" **on ShipHub only** (`BRAND.fw`), not ShippingCloud. (Section label is in `SETTINGS_SEC_LIST` / `SEC_GROUPS` / the `links` array in Settings, ~line 73 & ~8393.)
- **9.** Move **Reports** under the **Account** group in `SEC_GROUPS`.
- **5.** General whole-settings intuitiveness pass.

---

## 3. THE hands-free printing saga (the thing to finish)

**Symptom:** In hands-free mode, the label should print silently to the PrintNode printer with no dialog/preview. **Works on prod, still shows the print dialog on sandbox.**

**Confirmed facts (via the in-app "Diagnose hands-free" button, which runs from Spencer's browser):**
- PrintNode **key is VALID** (43 chars, ends `…MYSoE`), printer id `75623348` (JD-268BT), computer online.
- `window.__scDirectPrint` on sandbox shows `on=true, printer="75623348"`.
- The **Diagnose test page PRINTS silently** on sandbox — so PrintNode + key + printer all work.
- But a **booked label** falls to the dialog.

**Why (root cause):** The only difference between the test page and a booked label is that `directPrintPdf` (src/App.jsx ~line 784) runs the label through a **re-render** (`pdfToImages` → `composeForStock` → `imgsToLabelPdf`) for doc-tab/stock composition when `comp.changed` is true. That's driven by `window.__scLabelStock` (label size / doc-tab), which **differs between the prod and sandbox tenants**. On sandbox the re-render produces a payload PrintNode rejects → dialog. Prod's settings don't trigger it (or produce a valid one).
> The ORIGINAL prod `directPrintPdf` is nearly identical (same re-render, no retry, no prefix strip) — confirming it's a tenant-data difference, not a code regression.

**Fixes deployed (awaiting Spencer's confirmation):**
- **v389** — `directPrintPdf` now only adopts the re-rendered payload if it's a valid, non-oversized (`>200 && <8MB`) PDF string, and **if the send is rejected it automatically retries with the carrier's ORIGINAL PDF** (the one the diagnostic proved prints). Verified with the `/tmp/hf_test2.js` harness (re-render rejected → retries original → silent success).
- **v390** — the send now **strips any `data:...;base64,` prefix** before POSTing to PrintNode (a canvas `toDataURL` re-render or carrier payload can carry one; the validity check stripped it but the send didn't).

**Other hands-free fixes shipped this session:**
- **Never show the preview modal in hands-free** — `openLabelOrDirectPrint` branches on MODE, not the stale `dp.enabled` flag. On silent-print failure, hands-free prints via a hidden frame / images, never the `LabelPreviewModal`.
- **`window.__scDirectPrint.enabled` is now DERIVED** from `!!(apiKey && printerId)` (was a stored flag that went stale when the standalone toggle was removed). Sync effect ~line 5155.
- **Tiny-in-the-corner FIXED** — `printPdfUrl` (~line 989) now wraps the PDF in an `@page`-pinned frame at the label-stock size (was loading the raw PDF → printed actual-size in the corner of letter paper).
- **Blank/half labels FIXED** — the hands-free browser fallback now renders to images and prints via `printImagePages` (which waits for every image to fully decode; the `<embed>` timer path fired before load).
- **Real PrintNode error is surfaced** — `directPrintPdf` dispatches `sc-direct-print-failed` with PrintNode's actual message; the `SaveToast` shows it.

**The diagnostic tool (keep it, it's the only PrintNode visibility we have):** "Diagnose hands-free" button in Print settings (next to "Send test page"). It (1) validates the key via `/printers`, (2) runs the **real** `directPrintPdf` path against a test PDF, (3) dumps `format / size / mode / legacyAutoPrint / routes / pn.on / printer / key tail`. **The environment BLOCKS egress to `api.printnode.com` (proxy 403), so Claude cannot test PrintNode directly — this button (running in Spencer's browser) is the only way to see PrintNode's response.**

**NEXT STEPS to close it:**
1. Have Spencer confirm the sandbox footer says `addr-v390` (hard-refresh if not) and re-test hands-free.
2. If still failing: get a screenshot of the **Diagnose** line. Green "Full auto-print path WORKED" ⇒ hands-free will work (same path). If red, the dump shows the culprit setting (watch `format=` — a non-PDF `ZPL`/`PNG` label would be rejected; `routes=` > 0; `legacyAutoPrint=true`).
3. Consider: if `format` is ZPL/PNG on sandbox, the label isn't a PDF and PrintNode's `pdf_base64` send can't work — that would need format normalization or a clear message.

---

## 4. Netlify function: `netlify/functions/printnode.js` (unchanged, but relevant)

- POST `{action:"print", apiKey, printerId, pdfBase64}` → PrintNode. Trims the key, Basic-auths, **checks the printer's computer state and refuses with `offline:true` if `computer.state==="disconnected"`** (so a dead agent doesn't silently swallow the job). Rejects `raw_html`, and PDFs > 8 MB. Returns `{ok:true, jobId}` or `{ok:false, error}`.
- The **PrintNode desktop agent must be running & signed in on the label computer (AFOFFICE)** for any silent print — the website showing "connected" is not the same thing.

---

## 5. Recreate the test harnesses (not in repo)

**`/tmp/smoke.js`** — boots the retail bundle in jsdom, seeds an admin `sc_session`, mocks `fetch`, asserts it mounts (`body.textContent.length > 50`) with 0 fatal errors (filter jsdom "Not implemented: navigation" noise). Run with `NODE_PATH=$PWD/node_modules node /tmp/smoke.js`.

**`/tmp/hf_test.js`** — extracts `labelPdfLooksValid`, `directPrintPdf`, `openLabelOrDirectPrint` from `src/App.jsx` by regex + brace-matching (capture the optional `async` prefix!), evals them with stubs (`window.__scDirectPrint`, `fetch` returning `{ok:true/false}`, `pdfToImages`/`composeForStock`/`imgsToLabelPdf`, `cz`, `docCtxFor`, `pdfBlobUrl`, `printPdfUrl`, `printImagePages`), then asserts the hands-free path: PrintNode-OK ⇒ no `setLabelPreview`, no dialog; re-render-rejected ⇒ retries original ⇒ silent. This is how the fixes were verified without a browser.

---

## 6. Working style (unchanged)

Spencer is fast-moving, non-technical, often mid-emergency and **gets frustrated when a fix doesn't land** — the printing saga ran many rounds. What helps: fix root causes, validate before delivering, give numbered status updates, and when you truly need a fact only his browser/PrintNode can show, ask for **one screenshot** and decode it for him rather than asking him to interpret. Keep `claude/` session notes updated each release.
