// ============================================================================
//  auth_errors_test.mjs — the sign-in screen's promise that it will never tell
//  a stranger what it is built on.
//
//  Two things are checked, and the second one is a security property rather
//  than a nicety:
//
//    1. Real provider failures are classified correctly, so the person gets a
//       sentence they can act on rather than a shrug.
//    2. NOTHING that names the infrastructure can escape. Every error string
//       the provider actually emits — including the ones that quote table
//       names, policy names and the auth server by name — is fed in, and the
//       output is asserted clean.
//
//    usage:  node tests/auth_errors_test.mjs
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.window = globalThis.window || {};
// Node 24 ships a real read-only `navigator`; replace it so the offline
// branch can be exercised.
Object.defineProperty(globalThis, "navigator",
  { value: { onLine: true }, configurable: true, writable: true });
(0, eval)(fs.readFileSync(path.join(root, "js/lib/auth-errors.js"), "utf8"));
const E = globalThis.AuthErrors;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n          " + detail : "") + "\n"); }
};
const eq = (got, want, msg) => ok(got === want, msg, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

process.stdout.write("\nclassification — by provider code\n");
eq(E.code({ code: "invalid_credentials", status: 400 }), "invalid_credentials", "invalid_credentials");
eq(E.code({ code: "email_not_confirmed" }), "email_not_confirmed", "email_not_confirmed");
eq(E.code({ code: "user_already_exists" }), "user_already_exists", "user_already_exists");
eq(E.code({ code: "over_email_send_rate_limit" }), "email_rate_limited", "email send rate limit");
eq(E.code({ code: "anonymous_provider_disabled" }), "guest_disabled", "guest sign-in switched off");
eq(E.code({ code: "refresh_token_not_found" }), "session_expired", "dead refresh token");
eq(E.code({ code: "weak_password" }), "weak_password", "weak password");
eq(E.code({ code: "otp_expired" }), "otp_expired", "expired one-time code");

process.stdout.write("\nclassification — by message, when there is no code\n");
eq(E.code(new Error("Invalid login credentials")), "invalid_credentials", "legacy wrong-password text");
eq(E.code(new Error("Email not confirmed")), "email_not_confirmed", "legacy unconfirmed text");
eq(E.code(new Error("User already registered")), "user_already_exists", "legacy duplicate text");
eq(E.code(new Error("Password should be at least 6 characters")), "weak_password", "length complaint");
eq(E.code(new Error("Token has expired or is invalid")), "otp_expired", "expired token text");
eq(E.code(new Error("Email rate limit exceeded")), "email_rate_limited", "email rate text");
eq(E.code(new TypeError("Failed to fetch")), "offline", "browser network failure");
eq(E.code({ status: 429 }), "rate_limited", "bare 429");
eq(E.code({ status: 503 }), "unavailable", "bare 503");
eq(E.code({ status: 401 }), "invalid_credentials", "bare 401");
eq(E.code(null), "unknown", "nothing at all");
eq(E.code({ message: "banana peel incident" }), "unknown", "unrecognised text");

process.stdout.write("\nretry-after\n");
eq(E.retryAfter({ message: "For security purposes, you can only request this after 47 seconds." }), 47,
  "seconds parsed out of the sentence");
eq(E.retryAfter({ retryAfter: 12 }), 12, "explicit retryAfter field");
eq(E.retryAfter(new Error("nope")), 0, "no hint at all");
ok(E.retryAfter({ retryAfter: 999999 }) <= 3600, "an absurd retry-after is capped");

process.stdout.write("\nthe leak fence — real strings the provider emits\n");
// Every one of these is a genuine error string from the stack behind this app.
// Not one of them may reach a user's screen intact.
const REAL_LEAKS = [
  'new row violates row-level security policy for table "houses"',
  'relation "public.agent_profiles" does not exist',
  "AuthApiError: Invalid Refresh Token: Refresh Token Not Found",
  "JWT expired",
  'permission denied for schema public',
  "Could not find the 'owner_user_id' column of 'trucks' in the schema cache",
  "PGRST301: JWSError JWSInvalidSignature",
  "supabase.auth.signInWithPassword is not a function",
  "FetchError: request to https://kkdpacoiwntrcukgwksh.supabase.co/auth/v1/token failed",
  "duplicate key value violates unique constraint \"admins_pkey\"",
  "GoTrue: signup requires a valid password",
  "Clerk: session token could not be minted",
  "invalid input syntax for type uuid",
  "the anon key is missing from the request",
  "service_role key must not be used in the browser",
];
for (const raw of REAL_LEAKS) {
  const out = E.message(new Error(raw));
  const label = raw.length > 46 ? raw.slice(0, 46) + "…" : raw;
  ok(!E.leaks(out), "sealed: " + label, "leaked: " + out);
}

process.stdout.write("\nthe leak fence — redact() on arbitrary text\n");
ok(E.redact("Cannot reach Supabase: network error") !== "Cannot reach Supabase: network error",
  "a vendor name replaces the whole sentence");
ok(!E.leaks(E.redact("run supabase/features/house/house_tenancies.sql")),
  "an operator instruction is not shown to the public");
eq(E.redact("Check your inbox and try again."), "Check your inbox and try again.",
  "clean text passes through untouched");
eq(E.redact(""), "", "empty stays empty");
eq(E.redact(null), "", "null becomes empty, not the string 'null'");

process.stdout.write("\nevery built-in message is clean and non-empty\n");
for (const key of Object.keys(E.MESSAGES)) {
  const m = E.message(key);
  ok(!!m && m.length > 12 && !E.leaks(m), "message(" + key + ")", m);
}

process.stdout.write("\na hostile translation cannot become a leak\n");
globalThis.window.t = (k) => (k === "auth_err_credentials" ? "Supabase says your password is wrong" : k);
ok(!E.leaks(E.message({ code: "invalid_credentials" })),
  "a translation that names the vendor is dropped for the safe English");
globalThis.window.t = (k) => (k === "auth_err_credentials" ? "Barua pepe na nenosiri havilingani." : k);
eq(E.message({ code: "invalid_credentials" }), "Barua pepe na nenosiri havilingani.",
  "a clean translation is used");
delete globalThis.window.t;

process.stdout.write("\nwhere the message belongs\n");
ok(E.isUserFixable({ code: "invalid_credentials" }), "a wrong password is the person's to fix");
ok(!E.isUserFixable({ status: 503 }), "our outage is not the person's to fix");

process.stdout.write("\noffline beats everything\n");
globalThis.navigator.onLine = false;
eq(E.code({ code: "invalid_credentials" }), "offline", "a dead network is reported as a dead network");
globalThis.navigator.onLine = true;

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
