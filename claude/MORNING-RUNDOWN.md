# Morning rundown — overnight work (2026-07-11)

Hey Spencer — here's the full night's work in plain language. Short version first.
**Everything landed on `staging` only (now build `addr-v452`). Production is untouched at `addr-v448`, exactly as you asked.**
(Previous night's rundown for 07-10 is in the git history if you ever need it.)

---

## ⚠️ The one thing to read even if you skip the rest

The security audit found that the functions that **book real FedEx labels and quote your real rates had no login check at all**. Anyone on the internet who knew the URL could have booked labels billed to your FedEx account, or pulled your rate card — no account needed. Same for the AI assistant (anyone could burn your Anthropic credits) and the address/HS-code/Google-Maps helpers.

**This is fixed on staging** (every one of those endpoints now requires a valid login, and the app sends it automatically — customers won't notice anything). But **production still has the hole** because you froze production deploys. There's no sign anyone has abused it, but it's live money exposure on a public URL.

👉 **My recommendation: let me promote just this to production as soon as you're up.** One word from you and it goes out.

Side effect you'll notice: **"Take a peek" demo visitors now see ballpark estimate prices instead of your real account rates** — anonymous visitors shouldn't see your actual FedEx pricing anyway (fits what you asked for on the demo scrub).

---

## What went out to staging tonight (test on sandbox)

### addr-v449 — security gates + quoting money-bugs
- **Login now required** on quote / ship / FedEx tools / UPS / assistant / HS lookup / address autocomplete (the hole above). Server-to-server callers (the rate warmer, Shopify checkout rates) authenticate with an internal key — they keep working.
- **Signature was double-charged on live quotes** in Quick quote and the order pop-up: FedEx already prices the signature inside its quote, and we were adding our local signature fee on top. A customer with Direct signature paid ~$6.55 twice. Fixed — matches how the Ship tab already did it.
- **Orders now BOOK what they quoted:** the order pop-up (and Autopilot/Batch) quoted and charged signature / Saturday / declared value, but the actual FedEx label was booked with none of them — customers paid for coverage the package didn't have. All booking paths now carry them, and this also unblocks international orders from the Orders tab (they used to be rejected for a $0 customs value).
- **Your "Min $ profit per label" floor had a gap:** it silently didn't apply whenever FedEx returned a quote with no itemized fees (One Rate rows are the big one) or on estimate prices. Now it holds on every path. **Exception on purpose: flat-priced services stay EXACTLY their flat price** — your "$15.30 displays as $15.30" rule wins over the profit floor.
- Quick quote's rule lookups ignored ounces (a 4 lb 12 oz box priced differently than on the Ship tab) — fixed.
- "Cheapest 2 Day" could grab 2Day A.M. — fixed.
- FedEx account number no longer appears in error messages.
- 7 new regression tests pin all of this (rates suite is now 111 checks).

### addr-v450 — the "one-letter-at-a-time" bug class, killed in admin
- **Biggest one: any background sync (the 20-second cloud refresh, the 2-minute order sync, any save) fully reloaded the admin section you were working in** — that could silently wipe an unsaved rates draft or branding edit, and made the Users panels snap shut every click. Fixed for all admin sections.
- The Commercial Invoice editor typed one letter at a time (same bug you hit in company settings) — fixed. Same for the branding color boxes and the Ship-screen pick-list settings.
- A half-typed "new login" form no longer follows you when you switch to a different customer.
- Printed rate/accessorial sheets now escape names (hygiene).

### addr-v451 — your data protected server-side
- **Customer order/shipment lists can no longer be wiped by a stale tab:** a save that would erase everything is refused, and any save that removes a big chunk snapshots the old copy first.
- **Backups are now actually restorable** — before tonight snapshots were written but there was no way to restore one except me hand-editing the database. Now there's an admin-only restore that's itself reversible.
- **Changing your own password now requires the current password** (a stolen browser session can't silently take over an account). Your admin "reset customer password" button works exactly as before.
- Signup endpoint now throttled (5/hour per connection) so a script can't flood your customer list.
- One origin ZIP everywhere: Batch preview, the Orders list and the order pop-up all price from the same "ship from" ZIP that booking uses — zone-based rules can't show one price and book another anymore.

### addr-v452 — rates keyed by what FedEx actually bills
- **Weight breaks and list tables now look up by BILLABLE weight** (the higher of rounded-up actual weight and dimensional weight, using your dim divisors) on every screen. Before, a light-but-big box (5 lb, 20×20×20 = 58 lb billable) read the 5 lb row of your tables — "list −30%" could sell below cost on bulky packages. This is the correct FedEx behavior end to end now.
- List-basis rules can no longer double-price a fee FedEx only itemized on the account side.
- Deleted a dead leftover pricing function that could have re-introduced the $25-fuel bug, plus two stray duplicate files.

---

## Your PrintNode question (answered in chat, short recap)
PrintNode is built exactly for platforms like yours — no practical volume ceiling. Each customer already uses their own key/account so no one can slow anyone else down, and the offline-printer fallback is already built. The upgrade when you have real customer count: a PrintNode **Integrator account** — you get child accounts per customer automatically, customers never hear "PrintNode," you bake the cost into pricing. The real scale bottlenecks (in order): the database write pattern, FedEx API rate limits, then nothing for a long while. All plannable; none urgent.

## Shopify public app
Everything you need is written up in `claude/SHOPIFY-PUBLIC-APP.md` — the Partner-dashboard steps only you can click (~20 min), exact URLs/scopes to paste, the protected-data questionnaire answers, listing copy, and the review checklist. The compliance webhooks Shopify requires are already live. Your "installation link is invalid" error was the custom-app single-store rule — the public app removes it.

## What I'd like from you (when you have a minute)
1. **Say "promote the security fix"** → I'll take v449+ to production. (Everything else can bake on staging as long as you want.)
2. **Test on sandbox:** a Quick quote with a signature (price should NOT include a doubled signature fee) · an order-pop-up booking with signature/Saturday/insurance (check the FedEx label actually carries them) · edit rates in admin while leaving the tab open a few minutes (draft should survive) · type in the Commercial Invoice editor (should be smooth).
3. **England raw costs:** the workbook you sent is the customer-rates calculator — the true cost numbers live in a workbook it references called **"2026 T2025 Cost"** (and "REMS Base Rates"). Export and send those and I'll build the importer + real margin analysis on the Rates tab (the tier-estimate fallback works meanwhile).
4. **Small decisions, no rush:** a few printer settings do nothing today (label rotate, ZPL/PNG format, duplicate packing-slip toggle, slip size) — want them wired up or removed? Also two deeper security upgrades queued: sign-out-everywhere/token revocation, and making admin "Log in as" use a real customer-scoped session.

## Known items I deliberately did NOT touch tonight
- Production (frozen at v448 per your instruction — including the security fix, awaiting your go).
- Batch preview still prices from local estimates when live rates are on (books live; preview column is estimate) — bigger rebuild, on the list.
- Shopify GDPR redact currently doesn't purge synced order copies from the database — needs a small design decision, flagged in the security audit (F15).
- Ship-screen advisory banners can still nudge the service list down while typing — fix is a fixed-height slot; wanted your eyes on the design before moving things.

Full detail with file/line references: `claude/audit-security.md`, `claude/audit-pricing.md`, `claude/audit-ux.md`.
