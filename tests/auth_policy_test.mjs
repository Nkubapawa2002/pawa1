// ============================================================================
//  auth_policy_test.mjs — the rules the sign-in screen applies before it
//  touches the network: what counts as an email, what counts as a password
//  worth having, and when a browser has guessed enough for one afternoon.
//
//  The throttle takes its storage and its clock as arguments, so the escalating
//  lockout is tested in milliseconds instead of fifteen real minutes.
//
//    usage:  node tests/auth_policy_test.mjs
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.window = globalThis.window || {};
(0, eval)(fs.readFileSync(path.join(root, "js/lib/auth-policy.js"), "utf8"));
const P = globalThis.AuthPolicy;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n          " + detail : "") + "\n"); }
};
const eq = (got, want, msg) => ok(got === want, msg, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// A localStorage stand-in.
function memStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null),
           setItem: (k, v) => m.set(k, String(v)),
           removeItem: (k) => m.delete(k),
           _size: () => m.size };
}

process.stdout.write("\nemail\n");
ok(P.isEmail("juma@example.com"), "an ordinary address");
ok(P.isEmail("  Juma@Example.COM  "), "trimmed and lower-cased before checking");
ok(P.isEmail("a.b+tag@sub.domain.co.tz"), "plus tags and subdomains");
ok(!P.isEmail("juma@example"), "no top-level domain is rejected");
ok(!P.isEmail("juma.example.com"), "a missing @ is rejected");
ok(!P.isEmail("juma@example.com,"), "a trailing comma is rejected");
ok(!P.isEmail(""), "empty is not an address");
ok(!P.isEmail(null), "null is not an address");
eq(P.normalizeEmail("  JUMA@Example.com "), "juma@example.com", "normalize lowers and trims");

process.stdout.write("\npassword — the hard requirements\n");
ok(!P.scorePassword("").ok, "empty is not acceptable");
ok(!P.scorePassword("abc123").ok, "six characters is not enough");
eq(P.scorePassword("abc123").failed, "length", "and it says so: length");
ok(!P.scorePassword("abcdefgh").ok, "letters with no number");
eq(P.scorePassword("abcdefgh").failed, "varied", "a straight alphabet run is called out first");
ok(!P.scorePassword("kwerty12345").ok === false, "letters + numbers + length is acceptable");
ok(!P.scorePassword("password").ok, "the most common password of all");
eq(P.scorePassword("password").failed, "common", "and it says why");
ok(!P.scorePassword("tanzania1").ok, "a local common password");
ok(!P.scorePassword("11111111").ok, "one character repeated");
ok(P.scorePassword("juma2026house").ok, "an ordinary decent password");

process.stdout.write("\npassword — must not contain the email\n");
ok(!P.scorePassword("juma1234", "juma@example.com").ok, "the address's local part inside the password");
eq(P.scorePassword("juma1234", "juma@example.com").failed, "email", "and it says why");
ok(P.scorePassword("juma1234", "different@example.com").ok, "the same password for a different address is fine");
ok(P.scorePassword("ab12cdef", "ab@example.com").ok,
  "a two-letter local part is too short to be a meaningful match");

process.stdout.write("\npassword — the score ladder\n");
eq(P.scorePassword("").score, 0, "nothing scores 0");
eq(P.scorePassword("abc12").score, 0, "too short to even be weak");
eq(P.scorePassword("password").score, 1, "common passwords are capped at weak");
eq(P.scorePassword("juma2026h").score, 2, "meets the requirements: fair");
eq(P.scorePassword("Juma2026ho").score, 3, "mixed case and long enough: good");
eq(P.scorePassword("Juma-2026-Nyumba!").score, 4, "long, mixed, with a symbol: strong");
ok(P.scorePassword("Juma-2026-Nyumba!").checks.symbol, "the symbol check is reported for the UI");
ok(P.scorePassword("Juma-2026-Nyumba!").checks.long, "so is the length bonus");

process.stdout.write("\nthrottle — counting failures\n");
{
  const s = memStore();
  const t0 = 1_000_000;
  let st = P.attemptState(s, "juma@example.com", t0);
  ok(!st.locked && st.remaining === 5, "a fresh address starts with a full budget");

  for (let i = 1; i <= 4; i++) st = P.recordFailure(s, "juma@example.com", t0 + i * 1000);
  ok(!st.locked, "four failures is not a lockout");
  eq(st.remaining, 1, "one try left");

  st = P.recordFailure(s, "juma@example.com", t0 + 5000);
  ok(st.locked, "the fifth failure locks");
  eq(st.secondsLeft, 30, "for thirty seconds the first time");
}

process.stdout.write("\nthrottle — the lock expires, and escalates\n");
{
  const s = memStore();
  const t0 = 2_000_000;
  const id = "juma@example.com";
  for (let i = 1; i <= 5; i++) P.recordFailure(s, id, t0 + i);
  ok(P.attemptState(s, id, t0 + 29_000).locked, "still locked at 29s");
  ok(!P.attemptState(s, id, t0 + 31_000).locked, "free again at 31s");

  // Second offence: a longer cool-off.
  let st;
  for (let i = 1; i <= 5; i++) st = P.recordFailure(s, id, t0 + 40_000 + i);
  eq(st.secondsLeft, 60, "the second lockout is twice as long");
  for (let i = 1; i <= 5; i++) st = P.recordFailure(s, id, t0 + 200_000 + i);
  eq(st.secondsLeft, 300, "the third is five minutes");
}

process.stdout.write("\nthrottle — scope and forgiveness\n");
{
  const s = memStore();
  const t0 = 3_000_000;
  for (let i = 1; i <= 5; i++) P.recordFailure(s, "juma@example.com", t0 + i);
  ok(P.attemptState(s, "juma@example.com", t0 + 100).locked, "the guessed address is locked");
  ok(!P.attemptState(s, "asha@example.com", t0 + 100).locked,
    "someone else on the same device is not");

  // Old failures fall out of the window rather than accumulating forever.
  const s2 = memStore();
  P.recordFailure(s2, "asha@example.com", t0);
  P.recordFailure(s2, "asha@example.com", t0 + 1000);
  const later = t0 + 16 * 60 * 1000;
  eq(P.attemptState(s2, "asha@example.com", later).fails, 0, "failures age out after the window");

  // A success wipes the slate.
  const s3 = memStore();
  for (let i = 1; i <= 3; i++) P.recordFailure(s3, "juma@example.com", t0 + i);
  P.recordSuccess(s3, "juma@example.com");
  eq(P.attemptState(s3, "juma@example.com", t0 + 5000).remaining, 5, "signing in clears the record");
}

process.stdout.write("\nthrottle — obeying a server cool-off\n");
{
  const s = memStore();
  const t0 = 4_000_000;
  const st = P.lockFor(s, "juma@example.com", 47, t0);
  ok(st.locked, "a server-requested pause locks immediately");
  eq(st.secondsLeft, 47, "for exactly as long as asked");
  // A shorter follow-up must not shorten an existing lock.
  eq(P.lockFor(s, "juma@example.com", 5, t0).secondsLeft, 47, "a shorter request cannot cut it short");
}

process.stdout.write("\nthrottle — it survives bad input\n");
{
  const broken = { getItem: () => "{{{not json", setItem() {}, removeItem() {} };
  ok(!P.attemptState(broken, "juma@example.com").locked, "corrupt storage reads as 'no record'");
  const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); },
                     removeItem() { throw new Error("denied"); } };
  ok(!P.attemptState(throwing, "juma@example.com").locked, "storage that throws does not break sign-in");
  ok(!!P.recordFailure(throwing, "juma@example.com"), "and recording a failure still returns a state");
}

process.stdout.write("\nthrottle — the record cannot grow without bound\n");
{
  const s = memStore();
  const t0 = 5_000_000;
  for (let i = 0; i < 60; i++) P.recordFailure(s, `person${i}@example.com`, t0 + i);
  const kept = Object.keys(JSON.parse(s.getItem(P.THROTTLE.key))).length;
  ok(kept <= P.THROTTLE.maxEntries + 1, `only ${kept} addresses kept, not 60`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
