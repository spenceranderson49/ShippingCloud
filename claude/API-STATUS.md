# ShippingCloud API — status & rundown (for Spencer)

_All of this is on **staging only** (current build addr-v479). Production is untouched at v464._

## What it is
Your own public REST API — the thing that replaces the England/wholesale API for anyone integrating with **you**. It sits by itself in **Admin → API** (and billing in **Admin → Billing & invoices**). It reads your rate cards and customer list but writes only to its own storage — it cannot affect the Ship tab, orders, or the portal. Nothing about it, other carriers, or internal mechanics shows on the customer end.

## How you use it (no code needed)
1. **Admin → API → create a key.** Defaults to **Test mode** — a test key quotes real prices but can NEVER book a real label, schedule a real pickup, or bill. Live keys are an explicit choice. Badges show which is which.
2. **The Playground** (same page): paste a key, pick a call, hit Send, see the response. Drive the whole API without a terminal.
3. **Admin → Billing:** generate invoices from what each customer shipped, issue them, record payments, print/PDF.

## Endpoints live now
| Area | Endpoints |
|---|---|
| Rates | `POST /v1/rates` (priced through the customer's own rate card) |
| Labels | `POST /v1/labels`, `GET /v1/labels/{id}` (re-download), `POST /v1/labels/batch` (≤100), `POST /v1/returns` |
| Shipments | `GET /v1/shipments` (paginated), `POST /v1/shipments/{id}/void` (real FedEx cancel) |
| Tracking | `GET /v1/tracking/{n}` — live FedEx scans, normalized status, ETA |
| Pickups | `POST /v1/pickups`, `GET /v1/pickups`, `POST /v1/pickups/{conf}/cancel` |
| Addresses | `POST /v1/addresses/validate` (verified/warning/unverified/error + matched address) |
| Account | `GET /v1/account`, `GET /v1/services`, `GET /v1/rate-card` |
| Billing | `GET /v1/billing/summary`, `GET /v1/invoices`, `GET /v1/invoices/{id}` |
| Webhooks | `POST/GET/DELETE /v1/webhooks` — signed (HMAC), label.created/voided |
| Safety | `Idempotency-Key` header (mutex — can't double-book) |
| Docs | `/api-docs.html` |

## Where we stand vs ShipEngine / EasyPost / Shippo
We're **ahead** on three things none of them expose to customers: rate-card introspection, billing/invoice endpoints, and idempotency. We **match** them on rating, labels, re-download, void, address validation, services, pickups, webhooks, batch, returns, tracking, pagination, customs. We deliberately **skip** (they're anti-goals for a reseller): customer-managed multi-carrier accounts, standalone insurance/claims, rate-shopper. The one remaining "someday" is official SDKs (Node/Python wrappers) — adoption polish, not a capability gap.

## Multi-carrier (admin-only, invisible to customers)
**Admin → Rates → Other carriers:** load rate cards (paste zone×weight, same as FedEx) for **UniUni, USPS, UPS (DAP), DHL eCommerce**. Then enable a carrier **per customer** on their record. Until you check that box, the customer sees pure FedEx everywhere — portal, Quick quote, and API. Enabled carriers quote through your same markup engine (quote-only today; label printing stays on carriers with a live API).

## Security/correctness audit — all fixed (v474)
A full competitive + implementation audit ran. The 9 findings are all fixed: the concurrent double-book race (HIGH), webhook SSRF, void-not-cancelling-at-FedEx, unbounded PDF growth, a revoked-key resurrection race, malformed-body 500s, and carrier-name leakage. Details in `claude/audit-api-competitive.md`.

## Decisions waiting for you (nothing blocking)
1. **Customer invoice view + pay-online:** the admin invoicing works today. Turning on a *customer-facing* "your invoices / pay now" screen is a flag I left OFF (you said keep the customer end clean). Say when you want it and I'll wire the customer view + a payment link.
2. **Real carrier label APIs** beyond FedEx (so UniUni/USPS labels *print*, not just quote) — each needs that carrier's API creds; tell me which to wire first.
3. **Production promote** whenever you're ready — the API is one deploy from live.


## Note on the v474→v479 repair (transparency)
During the API hardening, one edit script aborted mid-run and silently failed to save six fixes — while a later script wrote a *call* to one of them (`insertNew`). That would have made every idempotent booking return a 500. It was caught by the round-2 audit **and** an independent verification pass **before anything went live** (the API needs keys that aren't set on staging yet, so nothing had booked). v479 genuinely applies all six (idempotency mutex, webhook SSRF hardening, capped label-PDF storage, robust package parsing, neutral errors) plus invoice de-duplication, and pins the idempotency path + SSRF guard with regression tests. Lesson logged: every edit batch is now followed by a grep-verify that the change is actually present, not just that the script printed OK.
