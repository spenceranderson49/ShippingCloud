# ShippingCloud → Shopify PUBLIC app — the complete playbook
_Last updated: addr-v448 · written for Spencer, plain language, in order._

## The honest picture first
- A **custom app** (what "ShippingCloud Live" is today) is hard-locked by Shopify to the ONE store it was created for. That's why the install link said "invalid" on the second store. No setting un-locks it.
- A **public app** installs on unlimited stores with one click — but Shopify requires it to pass **App Store review** (typically 1–3 weeks, free). There is no longer an "unlisted" middle option.
- **Until approval lands, the access-token method keeps working** for any store, today. Public app = the long-term fix; token = the bridge.
- Good news: **most of the technical requirements are already built and deployed** — OAuth flow, HMAC verification, minimal scopes, and the mandatory GDPR compliance webhooks. What's left is mostly clicking through the Partner Dashboard and writing listing content (drafted for you below).

## What's already DONE in the codebase (no action needed)
| Requirement | Where | Status |
|---|---|---|
| OAuth install + callback (HMAC-verified, offline token) | `/.netlify/functions/shopify-auth` | ✅ live |
| Minimal scopes (review-friendly) | same file | ✅ see scope list below |
| GDPR compliance webhooks (all 3 topics, 401 on bad HMAC) | `/.netlify/functions/shopify-compliance` | ✅ live |
| Auto-detect: OAuth if configured, token flow if not | Integrations page | ✅ live |
| Multi-store per login | shopifyConns | ✅ live |

## Step 1 — Shopify Partner account & the app (your clicks, ~20 min)
1. Go to **partners.shopify.com** → sign up (free) with spencer@… → create your Partner organization.
2. **Apps → Create app → Create app manually.** Name: **ShippingCloud** (or ShipHub — must match your brand everywhere).
3. In the app's **Configuration**:
   - **App URL:** `https://shippingcloud.net/` (or your primary customer domain)
   - **Allowed redirection URL(s)** — add ALL of these, one per line:
     - `https://shippingcloud.net/.netlify/functions/shopify-auth`
     - `https://www.shippingcloud.net/.netlify/functions/shopify-auth`
     - `https://freightwireship.com/.netlify/functions/shopify-auth`
     - `https://www.freightwireship.com/.netlify/functions/shopify-auth`
     - `https://shiphub-staging.netlify.app/.netlify/functions/shopify-auth`  ← keeps the sandbox testable
   - **Embedded app: OFF** (we're a standalone app — merchants use our site, not an iframe in Shopify admin). This also means App Bridge/session tokens are NOT required.
4. Copy the **Client ID** and **Client secret**.

## Step 2 — Netlify env vars (your clicks, ~5 min per site)
On EACH Netlify site (shippingcloud prod, freightwire prod, both staging sites):
- `SHOPIFY_API_KEY` = Client ID
- `SHOPIFY_API_SECRET` = Client secret
- `APP_URL` = that site's own URL (e.g. `https://freightwireship.com`)
Then **redeploy** each site (Deploys → Trigger deploy). After this, the "Add store" button automatically switches from the token flow to one-click OAuth — no code change needed.

## Step 3 — Scopes (enter in Partner Dashboard → API access)
Request EXACTLY these (they match the code):
```
read_orders, read_products, write_shipping,
read_fulfillments, write_fulfillments,
read_assigned_fulfillment_orders, write_assigned_fulfillment_orders,
read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders
```
**One decision for you:** the "Save these changes back to Shopify" button (address/email push-back) needs `write_orders`, which the OAuth scope list deliberately leaves out to keep review easy. Options:
- **A (recommended to start):** submit without `write_orders`. Push-back stays available for token-connected stores; OAuth stores just won't have that one button. Add the scope in a later release.
- **B:** include `write_orders` now and justify it in the review notes: "Merchants correct shipping addresses in our fulfillment UI; the app writes the corrected address back to the order." Slightly more review scrutiny.

## Step 4 — Protected customer data (Partner Dashboard → API access → Protected customer data)
We read customer name/address/phone/email to print shipping labels, so Shopify requires this declaration:
- Purpose: **Order fulfillment / shipping label generation** (select "App functionality"). Not used for marketing, analytics, or resale — say exactly that.
- Data minimization: we only pull open-order fields needed on a label.
- Retention: order data lives in the merchant's own account store; on `shop/redact` webhook we purge (endpoint already live).
- Security: TLS everywhere; data at rest in Supabase (AES-256 at rest, SOC 2 provider); access limited to the merchant's own login.
Request **name, address, email, phone** fields.

## Step 5 — Compliance webhooks (Partner Dashboard → Configuration → Compliance webhooks)
Set all three to the SAME URL (use your primary domain):
```
https://shippingcloud.net/.netlify/functions/shopify-compliance
```
Shopify's automated check will POST with bad signatures expecting 401 and good ones expecting 200 — this endpoint already does exactly that.

## Step 6 — The listing (content drafted for you — edit voice to taste)
- **App name:** ShippingCloud
- **Tagline (70 chars):** "Discounted FedEx labels, live rates, and hands-free order fulfillment."
- **Description (draft):**
  > ShippingCloud connects your store to deeply discounted FedEx rates with zero manual work. Orders flow in automatically; our Autopilot picks the right service by your rules; labels print hands-free the moment you scan an order — and tracking flows back to your store and your customer instantly. Quick quotes, multi-box shipments, insurance, signatures, One Rate, returns, and live checkout rates — all in one clean dashboard built for teams that ship every day.
- **Key features bullets:** auto order sync · rule-based service selection (Autopilot) · scan-to-print hands-free labels · tracking pushed back automatically · live discounted FedEx rates incl. One Rate · multi-store support.
- **Assets you must create:** app icon **1200×1200** PNG; **3–6 screenshots at 1600×900** (suggest: Ship screen with rates, Orders page, Autopilot rules, Quick quote, the booked-label preview); optional 2–3 min demo video (reviewers love it).
- **URLs Shopify requires:** support email, support/FAQ page, and a **privacy policy URL** — tell me and I'll generate a privacy-policy page on the site (10 minutes of work) before you submit.
- **Pricing:** select **Free** (you bill customers directly; no Shopify Billing API involvement — this also simplifies review).

## Step 7 — Pre-submission test (do this on a fresh dev store)
Partner Dashboard lets you create free **development stores**. On one:
1. Install via your app's install link → Shopify consent screen shows YOUR scopes → approve → you land back on ShippingCloud with the store connected. (This whole path is live code today.)
2. Sync orders, book a test label (void it), see tracking push.
3. Uninstall the app from the store, reinstall — must work cleanly.
4. In the listing form, provide the reviewer a **demo login** to a sandbox ShippingCloud account + these test steps.

## Step 8 — Submit & what to expect
- Submit from the Partner Dashboard → App Store listing → Submit for review.
- Typical: first response in ~5–10 business days; total 1–3 weeks with one round of feedback.
- Most common rejections (all already handled here): broken install flow, missing privacy policy (do Step 6), compliance webhooks failing HMAC (ours pass), over-asking scopes (ours are minimal).

## Division of labor
- **Only you can:** create the Partner account/app, paste env vars into Netlify, approve the listing content, create the icon/screenshots, click Submit.
- **Already done / I'll do on request:** all app code; privacy-policy page; any review feedback fixes; adding `write_orders` later; screenshots checklist review if you paste them here.
