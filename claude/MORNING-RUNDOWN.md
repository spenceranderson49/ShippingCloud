# Morning rundown — overnight work (2026-07-10)

Hey Spencer — here's everything I did while you were asleep. Short version at the top, details below. **All of it is on `staging` (build `addr-v396`), nothing touched production (`main`).** Test on the sandbox, and when you're happy I'll promote it to prod.

---

## The one-line summary
You asked for **A + B + C + D + E**, plus a **database storage audit**, **tighter security**, and **2FA**. Done:

| # | You asked for | Status |
|---|---|---|
| A | Deep bug audit + safe fixes | ✅ Done — found 5 issues, fixed 3 safe ones, flagged 2 |
| B | Regression test suite | ✅ Done — automated tests that prove the risky flows still work |
| C | Security review + tighten | ✅ Done — full review, verdict "tight," no high-severity holes |
| D | Performance + mobile pass | ✅ Done — see §5 |
| E | Declared value on multipiece | ✅ Done — per-box OR same amount on every box |
| — | Database storage audit | ✅ Done — how much storage you'll need + the one thing to fix |
| — | Make security tight | ✅ Done (part of C) |
| — | Set up 2FA | ✅ Done — opt-in, tested against the official standard |

---

## 1. Declared value on multipiece (E)
When you have more than one box **and** you've entered a declared value, you now get a choice:
- **Same amount on every box** (default — the simple case), or
- **A different declared value per box** — a small input appears on each piece.

It only shows up when it's relevant (multiple boxes + declared value), so it doesn't clutter the normal one-box flow. The booking sends the right per-piece values to FedEx, and the insurance quote adds them up across the boxes.

## 2. Two-factor authentication (2FA) — NEW
- **Opt-in and off by default** — I built it so it **cannot lock anyone out**. Nothing changes at sign-in until a user deliberately turns it on.
- Turn it on under **Settings → General → "Two-factor authentication."** It shows a setup key you add to any free authenticator app (Google Authenticator, Authy, 1Password), then you confirm one code to switch it on.
- After that, signing in asks for your password **plus** the 6-digit code.
- To turn it off you need a current code (or your password) — a stolen browser session can't disable it.
- **Backup codes (NEW, v398):** when you turn on 2FA you get 10 one-time backup codes. If you don't have your phone, any one of them gets you in (each works once). You can copy them, see how many are left, and generate a fresh set anytime. So you're not dependent on your phone at all.
- **Lost your phone AND your backup codes?** As admin you can turn a user's 2FA back off from the Users list (an amber "Reset 2FA" button appears next to anyone who has it on) — so no one ever gets permanently locked out.
- **This is the single biggest security upgrade** — I'd recommend turning it on for the admin login first.
- I verified the code-generation against the **official industry standard (RFC 6238)** — the codes we expect match exactly what your phone app produces. It's not hand-wavy; there's an automated test proving it.

## 3. Bug audit (A) — what I found and fixed
I did a deep correctness pass. Five issues surfaced; I fixed the three that were safe and left two alone on purpose:
- ✅ **Shipped-notification crash guard** — a notification path could throw if a record had no recipient name; now guarded.
- ✅ **Tracking pushed to the wrong store** — with multiple Shopify stores, tracking could go to the wrong one; now it routes to the store the order actually came from (and logs if it can't tell).
- ✅ **Auto-refresh loop hardening** — the Shopify auto-sync effect was re-subscribing more than it should; tightened its trigger.
- ⏸️ **Left alone (on purpose):** a dedupe-key change that would've risked breaking existing de-duplication, and some dead code — both riskier to touch than to leave. Flagged in the handoff.

## 4. Security review (C) + storage audit
- **Security verdict: tight. No high-severity issues.** Full writeup in `claude/SECURITY-REVIEW.md`. Highlights: no XSS holes, passwords properly hashed, sessions signed, tenant/user isolated, secrets stay server-side. The top recommendation was 2FA — which is now done.
- **Storage audit** in `claude/DB-STORAGE-AUDIT.md`. Bottom line: **storage cost is negligible for years** (1,000 active users ≈ ~10 GB ≈ well within a $25/mo Supabase Pro plan). The one thing worth fixing eventually: each user's label PDFs (~6 MB) are stored inside the synced database row — moving those out (device-local or object storage) is the single highest-leverage cleanup. I **flagged but did not change** it, because it affects cross-device label reprint and that's your call.

## 5. Performance + mobile (D)
Good news first: the app is already in solid shape — wide tables all scroll on phones, modals go full-screen on mobile, and lots of the heavy math is already cached. Full findings are in `claude/PERF-MOBILE-AUDIT.md`. What I did and didn't touch:

**Fixed (safe, no behavior change):**
- **Orders list** — the filter+sort now only recomputes when the orders/filter/search actually change, not on every click or keystroke.
- **Rate-estimate cache** — was growing forever during a long session; now capped.
- Hoisted a small lookup table out of the render loop.

**The big one — now DONE (v399):**
- The **Batch screen** was recomputing every order's rate many times per render (laggy at hundreds of open orders). I fixed it the safe way: the rates are computed once and cached, and the code falls back to a live recompute on any cache miss — so the price you see is provably identical to before, just far faster. On a 200-order batch that's ~200 rate calculations instead of ~15,000+ per click. No wrong-price risk by design.

**Mobile:** no real problems found — a couple of icon buttons are slightly small for fingers, nothing broken.

## 6. Regression tests (B)
There's now an automated test suite in `claude/tests/` that proves the scary flows still work without a browser:
- the print / hands-free booking path,
- the multi-Shopify routing,
- the 2FA code math (against the official standard).
Run them all with `claude/tests/run.sh`. **20 + 13 checks passing, smoke test green.**

---

## What I need from you (quick)
1. **Try 2FA on the sandbox admin login** — Settings → General → set it up, sign out, sign back in with a code. Confirm it feels right before we turn it on for real.
2. **Test declared value on a multipiece** — book 2+ boxes with a declared value, try both "same on each" and "per box."
3. **Multi-Shopify** still needs a live prod test (the connect flow only works on production, not sandbox).
4. Tell me when you want to **promote `staging` → production**. Prod is still the old, known-good build, so there's no rush.

Nothing is on production yet. Everything above is safe to poke at on the sandbox.
