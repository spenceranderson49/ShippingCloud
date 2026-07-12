# Freightwire — Proposal → Rates connection (for the developer)

**Goal:** when you finish a proposal in our proposal tool and hit "Send," it POSTs the
rate card (a discount/markup on each service and fee) straight into the Freightwire
admin **Rates** tab. No human copying. Sending again for the same customer just updates them.

You only need to call **one endpoint.**

---

## 1. Endpoint

```
POST https://app.freightwire.com/api/v1/admin/customers
```

(We'll give you a separate test URL to try against first, so nothing real is touched while you build.)

## 2. Authentication

Send the admin API key we issue you as a header — either of these works:

```
Authorization: Bearer sck_admin_xxxxxxxxxxxx
```
or
```
X-API-Key: sck_admin_xxxxxxxxxxxx
```

The key starts with `sck_admin_`. Keep it server-side; don't ship it in browser code.

## 3. Request body (JSON)

```json
{
  "customer": {
    "external_id": "YOUR-CUSTOMER-ID-123",
    "name": "Acme Corp",
    "email": "billing@acme.com",
    "contact": "Jane Doe",
    "phone": "555-123-4567",
    "origin": "84101"
  },
  "pricing": {
    "services": {
      "ground":              { "mode": "discount_off_list", "value": 25 },
      "home":                { "mode": "discount_off_list", "value": 25 },
      "priority_overnight":  { "mode": "markup_over_cost",   "value": 10 },
      "2day":                { "mode": "flat",               "value": 18.50 },
      "first_overnight":     { "mode": "none" }
    },
    "fees": {
      "FUEL":  { "mode": "discount_off_list", "value": 15 },
      "RES":   { "mode": "dollars_over",      "value": 1.25 },
      "SIG-D": { "mode": "none" }
    },
    "account_markup": 0
  },
  "replace": true
}
```

**Notes**
- `customer.name` is the only required field. `external_id` is strongly recommended —
  it's how we match "the same customer" on repeat sends (otherwise we fall back to email).
- `pricing.services` and `pricing.fees` are objects keyed by our service/fee keys (lists below).
- Omit any service/fee you're not setting, OR send `{ "mode": "none" }` to explicitly leave it
  at the default (no discount).
- `replace: true` (default) = this proposal REPLACES the customer's whole rate card.
  `replace: false` = merge (only overwrite the services/fees you send, leave the rest).
- `account_markup` (optional) = a flat % markup applied across the account.

## 4. Discount "mode" values

**For services** (`pricing.services`):

| mode | meaning | `value` is… |
|---|---|---|
| `discount_off_list` | % off the FedEx list rate | a percent, e.g. `25` = 25% off list |
| `markup_over_cost`  | % markup over our cost | a percent, e.g. `10` = cost + 10% |
| `dollars_over_cost` | flat dollars over our cost | dollars, e.g. `3` = cost + $3.00 |
| `flat`              | a fixed price for that service | dollars, e.g. `18.50` |
| `none`              | no discount (account default / raw) | — (omit `value`) |

**For fees** (`pricing.fees`):

| mode | meaning | `value` is… |
|---|---|---|
| `discount_off_list` | % off the fee's list amount | a percent, e.g. `15` = 15% off |
| `markup_percent`    | % markup on the fee | a percent |
| `dollars_over`      | flat dollars for the fee | dollars, e.g. `1.25` |
| `flat`              | fixed fee amount | dollars |
| `none`              | leave fee at default | — (omit `value`) |

## 5. Response

```json
{
  "customer_id": "c1720000000123",
  "external_id": "YOUR-CUSTOMER-ID-123",
  "profile_id": "p1720000000456",
  "created": true,
  "services_set": 5,
  "fees_set": 3,
  "note": "Live in the Rates tab. Press nothing — it's saved."
}
```

- `201` = new customer created. `200` = existing customer updated.
- `created: true/false` tells you which happened.
- Errors come back as `{ "error": { "code": "...", "message": "..." } }` with a 4xx/5xx status
  (e.g. `401 invalid_key`, `422 invalid_request` if `customer.name` is missing).

## 6. curl you can test with

```bash
curl -X POST https://app.freightwire.com/api/v1/admin/customers \
  -H "Authorization: Bearer sck_admin_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "customer": { "external_id": "TEST-1", "name": "Test Customer", "email": "test@x.com" },
    "pricing": {
      "services": { "ground": { "mode": "discount_off_list", "value": 20 } },
      "fees": { "FUEL": { "mode": "discount_off_list", "value": 10 } }
    },
    "replace": true
  }'
```

---

## Appendix A — Service keys

Send only the ones the proposal covers. The everyday ones:

```
ground                 FedEx Ground
home                   FedEx Home Delivery
ground_economy         FedEx Ground Economy
express_saver          FedEx Express Saver
2day                   FedEx 2Day
2day_am                FedEx 2Day A.M.
standard_overnight     FedEx Standard Overnight
priority_overnight     FedEx Priority Overnight
first_overnight        FedEx First Overnight
```

International: `intl_ground_ca, intl_connect_plus, intl_economy, intl_priority,
intl_priority_express, intl_first`.
Freight: `first_overnight_freight, 1day_freight, 2day_freight, 3day_freight,
intl_priority_freight, intl_economy_freight`.

One Rate (flat-rate packaging) keys follow the pattern
`or_<service>_<packaging>`, e.g. `or_2day_small_box`, `or_priority_overnight_envelope`,
`or_standard_overnight_medium_box`. (Full list of all 69 keys available on request —
you likely only need the everyday 9 above for proposals.)

## Appendix B — Common fee keys

```
FUEL      Fuel Surcharge (Express)
FUEL-G    Fuel Surcharge (Ground)
RES       Residential Delivery
RES-HD    Home Delivery Charge
DAS       Delivery Area Surcharge — Commercial
DAS-G     Delivery Area Surcharge — Ground
AH-D      Additional Handling — Dimensions
SIG-D     Direct Signature Required
INS       Declared Value (per $100 over $100)
ADDR      Address Correction
```

(79 fee keys total — full list on request. Most proposals only touch fuel + residential.)

---

## What I need from you (5 things)

1. Can your "Send" button POST the JSON in section 3 to our endpoint?
2. Will you store OUR `customer_id` from the response, so repeat sends update instead of duplicate?
   (Or just always send the same `external_id` and we handle matching.)
3. Do you need the full 69-service / 79-fee key list, or are the everyday keys enough?
4. Any services/fees in your proposals that DON'T map to the keys above? Send me the list.
5. Confirm you can keep the `sck_admin_` key server-side (not exposed in a browser).
