# Handoff — 2026-07-15 session 2 (morning audit → v569, all in production)

Owner: Spencer Anderson (spenceranderson49@gmail.com). This session ran alongside another
Claude session (which merged the v561 train and promoted to main mid-day, plus its own
copy/UI commits). branch = staging = production(main) at **v569 / BUILD_TAG addr-v569**.

## What shipped today (this session), newest first
- **v569** Shipments list: Service in its own column; order Created · Recipient · Service ·
  Tracking · Ship-to · Reference · Status. Service tucks under the name on mobile only.
- **v568** Voided badge red; duplicate-address banner window 1 day (ref matches stay 7).
- **v567** Duplicate-label banner also matches by destination (street+ZIP) so ref-less manual
  shipments printed twice get flagged; hands-free booking guard deliberately left ref-only.
- **v566** ⚠️ MAJOR: rate store had NO Default profile (only LAGENCE) → `rateProfileFor`
  fell back to profiles[0] → **every unassigned customer priced from LAGENCE**. Fixed the
  data (snapshot `bak:rateRules:20260716T013909-default-profile-fix`, then prepended a blank
  Default), and hardened rateProfileFor in App.jsx + api-engine.js to never use profs[0].
  Also: "Rates & Dim Divisors" hidden from both admin rails per Spencer ("rates live per
  customer") — RatesAdmin still reachable via Customers → Rates tab → "Advanced" link.
- **v565** `_isUSCountry` used everywhere "international" is decided — Shopify's "US"
  no longer flags orders international (regression exposure from the v561 country fix);
  Autopilot-on-Ship (`autoRulesOnShip`) no longer defaults ON; offline banner only shows
  after a failed ~4s retry and self-clears on a 30s loop.
- **v564** Admin HQ boots into admin:overview (was double sidebar); customer FedEx Account
  page shows the number that ACTUALLY applies (login entry wins > admin company number —
  `englandFor` precedence flipped on purpose so what the customer sees is what applies);
  "(optional override)"/"Optional" wording gone; NO estimated rates on Ship/QuickQuote
  without a FedEx account (demo exempt); **email to spencer@freightwire.com on every login
  creation** (db.js `notifyLoginCreated`, env `LOGIN_ALERT_EMAIL` overrides; bulk merges
  send one summary line).
- **v563** Log In As works on admin.freightwireship.com (rail/landing follow the
  impersonated login — was admin rail over blank body, pre-dated v560); tracking copy
  button on Shipments (row + expanded).
- **v562** FedEx Account settings page ALWAYS visible to every customer (byoCarrier flag
  now gates only other carriers); admin Customers tab renamed "FedEx tier"→"FedEx Account".
- **v561** the audit fix train (15 fixes — see FIXLIST-2026-07-15.md) headlined by
  **Shopify checkout pricing through the admin rate engine** (raw cost → account SELL via
  api-engine rateSellFor → store's buyer markup + handling; blockedServices filtered;
  in-app preview matches).

## Infra changes (Netlify, no code)
- **adminportalx site had ZERO function creds** — added FEDEX_API_KEY/SECRET_KEY/ACCOUNT,
  ENGLAND_API_BASE/KEY/CUSTOMER_ID, GOOGLE_MAPS_API_KEY, ANTHROPIC_API_KEY,
  APP_URL=https://admin.freightwireship.com. That's why impersonated sessions there said
  "Live rates aren't available on this site yet."
- FedEx **Track API product is NOT enabled** on the developer.fedex.com project (verified:
  403 on /track/v1). track-sync.mjs runs every 30 min and exits quietly until Spencer adds
  the product — then statuses/last-scan/ETA go live with no release. NAG HIM.

## Open / watch-outs
- **Rates multi-tab draft clobber** (top open item): two dirty Rates drafts (RatesAdmin or
  CustomerDetail) silently revert each other on save. Until fixed: one Rates screen at a time.
- Remaining audit items: claude/FIXLIST-2026-07-15.md (#16–29) — admin API key creation,
  Billing partial-data + name matching, dead "Check for labels", API gaps (2025 book/SAT/
  One Rate), demo assistant, dead code (src/quote.js still present — delete), Branding/
  Domains persistence decision, "Add funds" no-payment.
- The auto-minted customer record named "Shopify" (from a store install) should be renamed
  or merged by Spencer.
- Checkout buyer prices now ride on the SELL, so stores live before v561 will quote higher
  at checkout by their account markup — trim their Buyer markup % if anyone complains.
- Deploy convention observed today: Spencer directed production pushes repeatedly; every
  release verified live by polling the bundle tag (curl https://site/assets/index-*.js |
  grep addr-v5xx). All three prod sites build from main; *-staging sites from staging.

## Evening additions (v570–v573, all in production)
- **v570** Shipments columns balanced (Recipient/Company/Ship-to share flex, Company column
  added, Service fits, status badge nowrap); track-sync: "In transit" needs a PHYSICAL scan —
  FedEx OC (label acknowledgment) stays "Label created".
- **v571** "Slip With Items" → "Create Packing Slip".
- **v572** FedEx state names normalized to 2-letter codes on every FedEx address path (fixes
  pickup HTTP 400 "StateOrProvinceCode is missing" for spelled-out states); pickup Ready/Close
  times are half-hour dropdowns (6a–8p).
- **v573** Company-admin deploy screens filtered: blocked services vanish (admin views keep
  the greyed lock look), tab hide/order/start-page lists only offer feature-enabled tabs
  (allowedTabs chain AppInner→Settings/CompanyAdmin→Customize). Checkout Rates: per-service
  custom buyer names (ck.names — UI, preview, and shopify-rates.js all use them). Spending
  cap removed entirely (setting, enforcement, default). Admin FedEx Account tab slimmed to
  account # + tier + One Rate / Ground Economy / DHL checkboxes (old fx.* tier-economics data
  stays stored, just not shown).
- Duplicate-label banner (v567/568): also matches same street+ZIP within 1 day when no Ref #;
  banner names the recipient when ref-less. Voided badge is rose.
- Statuses do NOT move yet: FedEx **Track API product still not enabled** on the portal
  project (verified 403). One click from Spencer turns the whole live-tracking pipeline on.

## Late-night additions (v574–v580, all in production)
- **v574** Autopilot match note shortened (rule → service + compact swap reason).
- **v575–v576** Ship polish: 16px section gaps when 1-2-3 headers off; section + rate-card
  borders #b9c6d5; rate list pixel-aligned with right column (hideTitle left an empty mb-2
  header div = 8px offset). Pixel-measured via the scratchpad playwright flow (demo hook +
  local tailwind route — cdn.tailwindcss.com must be route-fulfilled in headless).
  ⚠️ Hit the handoff's git-checkout trap once (uncommitted edits eaten); commit BEFORE
  temp screenshot builds — later runs did.
- **v577–v578** Address Check = its own bordered box (gap matches Sender↔Receiver at 16px,
  tops/bottoms flush, save icon right edge = receiver box right edge — all measured);
  check column 280/330px (receiver correspondingly narrower); address text 13→14px with
  pinned line-height; Sender/Receiver titles 15px.
- **v579** Required-field blue: outer 1.5px paint covers the grid's grey gap lines (no
  doubling), corner cells rounded so it hugs the box arc (wrappers lost overflow-hidden),
  reverts to plain grey the moment the field has a value. Verified with before/after renders.
- **v580** Packing slips v2: SLIP_OPTS carries settings.companyLogo + company; redesigned
  slip (logo header / PACKING SLIP block / two-column ship-to + facts / zebra table /
  ruled footer); pick list gets the logo; SlipComposerHost = edit-before-print modal
  (contentEditable + insertImage, opened via window event "sc-slip-compose") wired to all
  interactive Packing Slip buttons; batch/auto/PrintNode-routed slips keep the plain PDF
  path (no logo there yet — candidate follow-up).

## v581–v582 (in production)
- **v581** Packing slips: logo OR company name (no more doubled logo); slips print from an
  editable token template ({{LOGO}}/{{ORDER_META}}/{{SHIP_TO}}/{{FACTS}}/{{ITEMS}}/{{NOTE}}/
  {{FOOTER}}/{{THANKS}} in DEFAULT_SLIP_TEMPLATE, stored in settings.slipTemplate, synced via
  SLIP_OPTS.template). New Settings section "Packing Slips" (SlipSettings) under Documents &
  Printing — live-preview template editor + Add Image + Save/Reset. Composer "Edit Template"
  routes there (sc-nav now forwards {settingsSec}). ⚠️ First v581 commit was EMPTY (temp-build
  git-checkout ate the uncommitted work — the recurring trap); redone and pushed. RULE NOW:
  commit+push BEFORE any temp screenshot build, always.
- **v582** Customer Rates tab overhaul: dim divisor inputs clamp on BLUR not per-keystroke
  (was unusable — every digit clamped to [50,300]); markup blurb → one line "marks up all
  rates and accessorials X% over England cost"; rate-profile picker + "prices from" dropdown
  REMOVED (each account priced individually; engine still uses per-account forked profiles
  under the hood); added Copy Rates / Paste Rates — a base64 blob {markup,markupMin,listYear,
  services,surcharges} cloned onto another customer via upProfField. SlipSettings gains a Pick
  List card (settings.pickListTitle/pickListNote + logo, honored in printPickList).
- Track API STILL 403 (re-verified this round). Genuinely not enabled on FedEx portal — code
  side is ready; only Spencer's portal toggle is missing.

## v583–v585 (in production)
- **v583** FedEx account requests: "Done" now removes them server-side (new db.js action
  fedexRequestResolve — deletes the request by id/uid + its invoice blob; the old client-only
  filter kept getting restored by the next cloud poll, so dismissed requests reappeared).
  notifyFedexRequest emails FEDEX_ALERT_EMAIL||LOGIN_ALERT_EMAIL||spencer@freightwire.com on
  every request with details + the uploaded invoice ATTACHED (Resend attachments).
- **v584** ⭐ FedEx TRACKING LIVE. Spencer created a separate FedEx "Basic Integrated
  Visibility" project → creds wired as FEDEX_TRACK_KEY / FEDEX_TRACK_SECRET (set on all 3 prod
  sites; ship/rate stay on FEDEX_API_KEY). track-sync.mjs prefers the track creds, pulls
  includeDetailedScans (scan events + ETA + delivery), stores trackEvents/trackedAt per
  shipment. VERIFIED against live DB after manual kick: 118 shipments stamped, 103 with scan
  events, real statuses (111 In transit / 1 OFD / 1 Exception / 2 Delivered). Scheduled fn is
  HTTP-invokable (POST → 204) to force a run. Dashboard Live board → advanced-tracking UI:
  "Synced from FedEx" stamp, clickable status pills that filter, each row expands a scan
  timeline. NOTE: Track/Visibility works by tracking number — does NOT need accounts
  provisioned (only Ship does), so the separate project needed just one account attached.
- **v585** FedEx Location Finder: Settings → Find FedEx Locations (Shipping group) — search by
  ZIP or geolocation, radius picker, results (address/hours/phone/distance/map). Backend
  action "locations" in fedex.js → /location/v1/locations on the MAIN FEDEX_API_KEY project
  (Spencer enabled Locations Search there). Feature flag fedexLocations default ON,
  admin-toggleable. ⏳ Locations API still 403 as of this writing — FedEx entitlement not yet
  propagated (same lag Track had); the code shows a friendly "not active yet" msg and will
  work automatically once FedEx flips it. RE-TEST periodically.
- FedEx compliance note: Spencer's new Track project made him agree "not a vendor who
  sells/distributes." His model has reseller traits but FedEx shipping runs through England
  (who holds the contract); token persona = DirectIntegrator_B2B. Flagged to confirm with
  England/FedEx; England-sourced tracking would sidestep it entirely (England search API needs
  a keyword; couldn't confirm a status/scan endpoint blind — one email to Rock Solid to ask).
