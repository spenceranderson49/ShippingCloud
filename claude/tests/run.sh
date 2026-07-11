#!/usr/bin/env bash
# Full test run: builds the retail bundle, then runs smoke + logic regression tests.
set -e
cd "$(dirname "$0")/../.."
[ -d node_modules ] || npm install
npm ls jsdom >/dev/null 2>&1 || npm install --no-save jsdom
echo "== function syntax (every netlify function) =="
for f in netlify/functions/*.js netlify/functions/*.mjs; do node --check "$f"; done
echo "== building all three brand bundles =="
VITE_BRAND=shiphub npx vite build --outDir dist-shiphub >/dev/null 2>&1
VITE_BRAND=admin npx vite build --outDir dist-admin >/dev/null 2>&1
VITE_BRAND=shippingcloud npx vite build >/dev/null 2>&1
echo "== rates engine =="
NODE_PATH="$PWD/node_modules" node claude/tests/rates.mjs
echo "== regression (logic) =="
NODE_PATH="$PWD/node_modules" node claude/tests/regression.mjs
echo "== API (engine parity + handler) =="
NODE_PATH="$PWD/node_modules" node claude/tests/api.mjs
echo "== 2FA =="
NODE_PATH="$PWD/node_modules" node claude/tests/totp.mjs
echo "== brand boots (shiphub + admin) =="
NODE_PATH="$PWD/node_modules" node claude/tests/boot.mjs dist-shiphub https://freightwireship.com/
NODE_PATH="$PWD/node_modules" node claude/tests/boot.mjs dist-admin https://admin.shippingcloud.net/
echo "== smoke (render) =="
NODE_PATH="$PWD/node_modules" node claude/tests/smoke.mjs
echo "ALL TESTS PASSED"
