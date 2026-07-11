# Regression tests

Guardrails for the flows that broke during the v382–v394 work. No browser needed.

- **`regression.mjs`** — extracts the real functions from `src/App.jsx` (brace-matching, so it tracks
  the source) and exercises them with mocked PrintNode/Shopify. Covers: label PDF validity, hands-free
  `directPrintPdf` (accept / retry-original-on-reject / strip `data:` prefix / not-configured),
  `openLabelOrDirectPrint` (hands-free never opens the preview modal), and the multi-store Shopify
  helpers (`shopifyConns` / `shopifyConnFor` / legacy migration).
- **`smoke.mjs`** — boots the built retail bundle in jsdom with a seeded admin session and asserts it
  mounts with zero fatal runtime errors.

## Run
```bash
bash claude/tests/run.sh            # builds + runs everything
# or individually (after a shippingcloud build):
NODE_PATH=$PWD/node_modules node claude/tests/regression.mjs
NODE_PATH=$PWD/node_modules node claude/tests/smoke.mjs
```

Add a new case to `regression.mjs` whenever a bug is fixed, so it can't silently come back.
