# Second audit round — findings & fixes (2026-07-10, addr-v400)

Two adversarial review agents went over (a) the new 2FA code and (b) the booking/rating/declared-value paths. Here's what they found, what I fixed (safe + confirmed), and what I deliberately left for you (touches money/insurance billing or needs a bigger change).

## ✅ Fixed this round (safe, tested, on staging)

### Booking / rating
1. **HIGH — Batch booked a different service than the row showed (when a "specific service" rule was set).** The preview priced the exact service (e.g. "FedEx 2Day") but the booking loop used a loose text match that could grab "FedEx One Rate 2Day" instead — or, on no match, book an arbitrary rate. Now the booking uses the *exact same* picker as the preview: exact service → cheapest of that carrier → otherwise skip with "No rate" (never a silent wrong booking). `App.jsx` Batch `run()`.
2. **MED — Per-box declared value silently dropped when you delete a box down to one.** If you set "per box" values on a multipiece then deleted boxes until one remained, that last box shipped **uninsured** (the per-box field disappears and the shared field was empty). Now deleting back to a single box moves the remaining box's value into the shared "Insure $" field and exits per-box mode — nothing is lost, and quote + booking stay in agreement. `App.jsx` `delPiece`.

### 2FA (hardening the code I wrote earlier tonight)
3. **MED — `totpBegin` could downgrade already-on 2FA + wipe backup codes.** A stolen session (without the phone) could call the "start setup" endpoint and silently turn enforcement off and destroy the backup codes. Fixed: setup now stashes a *separate* pending secret and never touches the live secret/backup until you confirm a code. Enforcement only flips on confirmed enable.
4. **MED — Renaming a user's email wiped their password hash AND 2FA secret (lockout).** The "preserve secrets on save" logic matched users by email, so an email change lost the match. Now it matches by the stable user id (email fallback) — renames keep password + 2FA intact. (This also fixes a pre-existing password-loss bug.) Proven by a new automated test.
5. **LOW-MED — A failed write when spending a backup code left it reusable.** Login now refuses if it can't record the code as used, so a one-time code can never be replayed.
6. **LOW — Login could fail *open* on a corrupted 2FA record.** If a record was marked "2FA on" but somehow had no secret, login fell back to password-only. Now it fails closed (admin can reset).

Tests: 32/32 in `claude/tests/totp.mjs` (crypto + backup codes + email-rename preservation), regression 20/20, smoke green, all 3 brands build.

## ⏸️ Left for you (RISKY — I won't touch these unsupervised)

These need a decision or knowledge of how the England/FedEx billing endpoint treats a field — getting them wrong could mis-bill insurance or customs, so I flagged rather than guessed:

- **MED-HIGH — Multipiece insurance total may differ between the quote and the booking.** For a multi-box shipment, the *quote* prices insurance on the full declared total (value × number of boxes) but the *order-level* `insuranceAmount` sent at booking isn't multiplied the same way, and the new per-box `declaredValue` fields ride alongside it. Depending on which field England actually bills insurance on, this could double-count or under-declare. **Needs:** confirmation of how the England ship endpoint uses `insuranceAmount` (order-level) vs per-piece `declaredValue`. Once we know that, it's a one-line alignment.
- **LOW-MED — International multipiece per-piece declared value is always blank.** The intl branch reads a piece field (`p.value`) that never gets set, so per-piece declared value is omitted on international multipiece labels. Insurance still flows at the order level. **Needs:** confirmation of whether England wants per-piece customs value here (and from which field) before wiring it up.
- **MED — No rate-limiting/lockout on login attempts.** With a known password, TOTP codes could be brute-forced slowly (no throttle). Lower risk because of the 6-digit × 90-second window, but worth adding a per-account attempt counter. It's a moderate change (needs a small counter store) — flagged for a supervised session.
- **LOW — TOTP codes are replayable within their ~90-second validity window;** and all user-record writes are last-write-wins (no row versioning). Both are minor/architectural — noted for awareness, not urgent.

Bottom line: the confirmed, safe bugs are fixed and tested; the remaining items all touch billing math or need a bigger change, so they're documented for us to do together.
