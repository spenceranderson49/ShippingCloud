#!/usr/bin/env bash
# Full test run: builds the retail bundle, then runs smoke + logic regression tests.
set -e
cd "$(dirname "$0")/../.."
[ -d node_modules ] || npm install
npm ls jsdom >/dev/null 2>&1 || npm install --no-save jsdom
echo "== building shippingcloud bundle =="
VITE_BRAND=shippingcloud npx vite build >/dev/null 2>&1
echo "== regression (logic) =="
NODE_PATH="$PWD/node_modules" node claude/tests/regression.mjs
echo "== smoke (render) =="
NODE_PATH="$PWD/node_modules" node claude/tests/smoke.mjs
echo "ALL TESTS PASSED"
