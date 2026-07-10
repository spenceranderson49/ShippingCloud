/* 2FA / TOTP crypto test — extracts the real functions from netlify/functions/db.js
   (by name, brace-matched) and checks them against the RFC 6238 test vectors so we
   know the codes we generate match what Google Authenticator / Authy / 1Password produce.
   Run: NODE_PATH=$PWD/node_modules node claude/tests/totp.mjs */
import fs from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "../../netlify/functions/db.js"), "utf8");

/* pull a `function NAME(...){...}` block out of the source by brace-matching */
function extractFn(name) {
  const re = new RegExp("function\\s+" + name + "\\s*\\(");
  const m = re.exec(src);
  if (!m) throw new Error("could not find function " + name);
  let i = src.indexOf("{", m.index); let depth = 0; let start = i;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(m.index, i);
}
/* pull a `const NAME = ...;` single-expression declaration */
function extractConst(name) {
  const re = new RegExp("const\\s+" + name + "\\s*=\\s*[^;]+;");
  const m = re.exec(src);
  if (!m) throw new Error("could not find const " + name);
  return m[0];
}

const code = [
  extractConst("B32"),
  extractFn("b32encode"),
  extractFn("b32decode"),
  extractFn("totpAt"),
  extractFn("totpVerify"),
  "return { b32encode, b32decode, totpAt, totpVerify };",
].join("\n");

const factory = new Function("crypto", "Buffer", code);
const { b32encode, b32decode, totpAt, totpVerify } = factory(crypto, Buffer);

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", label); } };

// RFC 6238 seed "12345678901234567890" -> standard base32
const secret = b32encode(Buffer.from("12345678901234567890"));
ok(secret === "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "base32 encode matches RFC seed");

// 6-digit codes = last 6 of each 8-digit RFC vector
const vectors = [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"]];
for (const [t, expect] of vectors) ok(totpAt(secret, Math.floor(t / 30)) === expect, "TOTP T=" + t + " -> " + expect);

// round-trip base32
ok(b32decode(b32encode(Buffer.from("hello!"))).toString() === "hello!", "base32 round-trip");

// verify accepts the current code and rejects a wrong one (uses real Date.now)
const nowCounter = Math.floor(Date.now() / 1000 / 30);
ok(totpVerify(secret, totpAt(secret, nowCounter)) === true, "verify accepts current code");
ok(totpVerify(secret, "000000") === false || totpAt(secret, nowCounter) === "000000", "verify rejects a wrong code");
ok(totpVerify(secret, totpAt(secret, nowCounter - 1)) === true, "verify accepts prev-window code (skew)");
ok(totpVerify(secret, totpAt(secret, nowCounter - 3)) === false, "verify rejects far-past code");
ok(totpVerify(secret, "12345") === false, "verify rejects short code");

// ── backup codes ──
const bcCode = [
  extractConst("BC_ALPHA"),
  extractConst("normBackup"),
  extractConst("hashBackup"),
  extractFn("newBackupCodes"),
  extractFn("consumeBackup"),
  extractConst("backupLeft"),
  "return { newBackupCodes, consumeBackup, backupLeft, normBackup };",
].join("\n");
const { newBackupCodes, consumeBackup, backupLeft } = new Function("crypto", "Buffer", bcCode)(crypto, Buffer);

const { plain, stored } = newBackupCodes(10);
ok(plain.length === 10 && stored.length === 10, "10 backup codes generated");
ok(plain.every((c) => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c)), "codes are XXXX-XXXX format");
ok(new Set(plain).size === 10, "codes are unique");
ok(stored.every((s) => s.h && s.used === false), "stored codes are hashed + unused");
ok(!plain.some((c) => stored.some((s) => s.h === c)), "plaintext never equals a stored hash");
ok(backupLeft(stored) === 10, "backupLeft counts 10");

// consume one code
const first = plain[0];
const r1 = consumeBackup(stored, first);
ok(r1.ok === true, "valid backup code consumed");
ok(backupLeft(stored) === 9, "backupLeft drops to 9 after use");
const r2 = consumeBackup(stored, first);
ok(r2.ok === false, "same code cannot be reused");
ok(consumeBackup(stored, "ZZZZ-ZZZZ").ok === false, "unknown code rejected");
ok(consumeBackup(stored, plain[1].toLowerCase()).ok === true, "lowercase + normalized code accepted");
ok(consumeBackup(stored, "").ok === false, "empty code rejected");

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
