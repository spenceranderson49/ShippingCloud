# HANDOFF — Partner Brands System (white-label engine)
Start a NEW chat in this project and say: "Build the Partner Brands system per the handoff doc."

## Current state (as of addr-v131)
- Two brands live: ShippingCloud (retail, shippingcloud.net) + Freightwire Ship (client portal, freightwireship.com)
- Brand selection is BUILD-TIME: VITE_BRAND env var per Netlify site → const BRAND (App.jsx ~line 44)
- FW login page: Landing() has `if(BRAND.fw) return (...)` block (~line 1550): logo img (FW_LOGO, line 8 — SINGLE declaration, transparent PNG; do NOT duplicate, DEFAULT_BRAND line 10 references it), title split-weight "Freightwire"+blue "Ship", tagline "Your shipping platform & partner" (black &), 8 feature bullets, footer "© Freightwire · LegalLinks"
- In-app header: AppInner `const brand=BRAND.fw?{...name1:"FREIGHT",name2:"WIRE SHIP",dark,primary}:...` (~line 2055)
- Existing machinery: settings.brand per-account override; unauthenticated db.js action "publicConfig" (getStore publicBrand); per-client markup in Admin→Clients; company-admin logins; both sites share one Supabase

## Goal
Admin screen where Spencer creates a BRAND per white-label partner: upload logo (base64, ≤100KB, auto-resize), pick 2 colors (primary/dark), edit title words (name1/name2), tagline, up to 8 bullets, footer company name, and the DOMAIN it serves. Login page + in-app header render from this config, resolved by window.location.hostname at runtime. Zero code per new partner. FW + SC become seed rows (migration: current hardcoded values become brand records; VITE_BRAND stays as fallback).

## Design
1. Store: global store key "partnerBrands" = [{id,domain,name1,name2,logoB64,primary,dark,tagline,bullets[],footer,active}]. Admin-only writes (new db.js action "setPartnerBrands", admin token). Reads: extend "publicConfig" action to accept {host} and return matching brand (sanitized).
2. Client boot: before Landing renders, fetch publicConfig{host:location.hostname}; if brand match → render the FW-style login layout with that brand's values (generalize the current if(BRAND.fw) block into <BrandedGate brand={pb}/>); else current behavior. Cache in localStorage to avoid flash.
3. In-app: AppInner brand object merges partnerBrand (by host) > BRAND.fw defaults > DEFAULT_BRAND > settings.brand.
4. Admin UI: new Admin section "Partner brands": list + editor (logo file input → canvas resize to ~480px wide PNG → base64; live preview panel reusing the login layout).
5. Netlify: each partner domain = add domain alias to the SAME freightwire Netlify site (Domain management → add alias). Document for Spencer.
6. Emails/legal: brand.footer replaces "Freightwire" in FW footer; email templates keep ShippingCloud for now (phase 2).

## Validation ritual (MANDATORY — updated after 7/4 outages)
1. tsc grep TS1xxx|2451|2300 = 0; brace balance; no literal \u escapes
2. grep -c per new top-level const == 1 (duplicate-const check!)
3. rm -rf dist && npx vite build (deps: npm install; package.json fetched from GitHub raw)
4. jsdom runtime render test WITH cloud path forced (mock fetch on /.netlify/functions/db → {ok,configured:true}); assert #root >100 chars; test BOTH: default brand AND a mocked partnerBrand host
5. node --check on db.js; extend /tmp/test-db.cjs pattern for setPartnerBrands (admin-gated) + publicConfig host resolution
6. PREVIEW HTML for Spencer before he uploads anything visual

## Notes / traps
- publicConfig is PRE-AUTH in db.js — keep reads unauthenticated, writes token-gated (see requestReset placement for the public zone)
- getStore returns {ok,value} NOT the value (bit me in v123)
- CloudAuth owns fp/mode state — don't reference outside (7/4 outage #1)
- FW_LOGO must remain single, at top (7/4 outage #2)
- Spencer's flow: complete files, commit direct to main, both sites build from one repo
- Pending unrelated: rotate SESSION_SECRET + SUPABASE_SERVICE_KEY + Anthropic key (screenshot leak); reinstall carrier callbacks after rotation; interior FW de-branding pass (hide DHL/rate-shop language when partner brand active) — fold into this build if budget allows
