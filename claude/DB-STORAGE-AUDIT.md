# Database storage audit — ShippingCloud (Supabase)

**Date:** 2026-07-10 · Author: overnight audit. **I could not query the live DB** (this environment is firewalled from `*.supabase.co`), so these are **projections from the schema + code**, not live row counts. Numbers are engineering estimates — treat ±2×.

## Data model
One table: `app_stores(tenant text, key text, value jsonb, updated_at)`, PK `(tenant, key)`. Every logical object is one **row** = one JSON blob. Keys are either **global** (`GLOBAL_KEYS` in App.jsx:4086 — `users`, `clients`, `rateRules`, `featureFlags`, `signupRequests`, …) or **per-user** (`u/<uid>/<key>`, e.g. `u/u1/shipments`). `session` is never stored server-side; `ship.*` scratch keys are device-local and never synced.

So a tenant's total size ≈ Σ(global rows) + Σ over users of Σ(that user's per-user rows).

## The one that matters: `labels` (stored PDFs)
- App.jsx:5047 keeps `labels = { [shipmentId]: { pdf: <base64>, ts } }` for the **60 most recent bookings** (older ones are pruned). This powers 1-click reprint (App.jsx:7243).
- `labels` is **not** global and **not** scratch → **it syncs to the DB per user.**
- A FedEx 4×6 label PDF is ~40–150 KB base64. **60 of them ≈ 3–9 MB in a single jsonb row, per active user.** This dwarfs everything else and is a large row for Postgres jsonb (query/update cost grows with it).

## Everything else (small)
| Key | Nature | Rough size |
|---|---|---|
| `shipments` | metadata per booked label (recipient/sender/rates/tracking — **no PDF**, it references `labels` by id) | ~1–2 KB each; grows unbounded |
| `orders` | imported store orders | ~0.5–1 KB each; grows with volume |
| `emails` | notification log | ~0.3 KB each |
| `ledger`, `invoices`, `batches`, `manifests`, `returns`, `pickups`, `drafts` | logs/records | ~0.2–1 KB each |
| `settings` (per user) | customizations, boxes, products, addresses | ~2–15 KB |
| `users`, `clients`, `rateRules`, `featureFlags` (global) | accounts + config | bounded; ~1–5 KB × count |

## Projection (per **active** user)
Assume a shop shipping **~100 labels/month**:
- `labels`: **capped ~6 MB** (60 PDFs) — flat, does not grow past the cap.
- `shipments`: ~1.5 KB × 1,200/yr ≈ **1.8 MB/yr**, unbounded.
- `orders` + `emails` + `ledger`: ≈ **1–2 MB/yr** combined.
- `settings`: ~10 KB, flat.

**⇒ ~8–10 MB in year 1, then ~+3–4 MB/yr** (labels stay capped; shipments/orders/emails accrue).

| Active users | ~Year-1 DB size |
|---|---|
| 10 | ~0.1 GB |
| 100 | ~1 GB |
| 1,000 | ~9–10 GB |
| 5,000 | ~45–50 GB |

## Supabase cost
- Free tier: 0.5 GB DB. Pro ($25/mo): **8 GB included**, then **~$0.125/GB/mo**.
- So: 100 users ≈ within Pro; 1,000 users ≈ 10 GB ≈ ~$0.25/mo overage; 5,000 users ≈ 50 GB ≈ ~$5/mo. **Storage cost is negligible for a long time** — the real risks are row size and backup/egress, not $.

## Recommendations (ranked)
1. **Stop syncing `labels` (the PDFs) to the DB — keep them device-local, OR move them to Supabase Storage (object store) instead of the jsonb row.** This removes ~90% of per-user DB bytes and the large-row performance risk.
   - Cheapest change: add `labels` to the local-only set so it isn't cloud-synced (reprint then works only on the device that booked — acceptable, since it's already a "60 most recent" convenience and Edit-&-reship exists). *I did NOT make this change — it alters cross-device reprint, so it's your call. It's a ~1-line change (`labels:1` into the scratch/no-sync set).*
   - Better long-term: put label PDFs in **Supabase Storage** keyed by shipment id; store only the URL in `shipments`. Object storage is ~10× cheaper than DB rows and keeps jsonb small.
2. **Cap/prune growing logs.** `shipments`, `orders`, `emails`, `ledger` grow unbounded. Add a retention window (e.g. keep shipments 18 months in the hot row, archive older) so no single jsonb row grows without bound.
3. **Lower the label cap** from 60 → 25–30 if you keep it in the DB — cuts the biggest row ~2×.
4. **Watch the `orders` row** — if store syncs keep appending fulfilled orders, prune fulfilled ones older than N days.

## Bottom line
Storage **$** is not a concern at your scale for years. The real thing to fix is **the multi-MB `labels` jsonb row per user** — moving those PDFs out of the synced blob (device-local or object storage) is the single highest-leverage change for DB health and performance. Flagged, not changed, because it affects cross-device reprint.
