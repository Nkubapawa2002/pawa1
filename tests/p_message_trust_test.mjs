// ============================================================================
// p_message_trust_test.mjs — key pinning, written as the ways it could betray.
//
// js/lib/pm-trust.js is what turns trust-on-first-use into something stronger:
// it writes down the key it saw and shouts when a different one turns up. The
// value of that is entirely in the edge cases, because the happy path — same
// key, same person — is also the path a completely broken implementation
// takes. So every test here is a way the alarm could fail to fire, or fire
// and then quietly un-fire:
//
//   · the alarm forgets itself on reload            (it must be stored)
//   · fetching the substituted key again clears it  (it must be sticky)
//   · a changed key inherits the old key's verified badge
//   · one identity's decisions leak into another's  (guest vs signed-in)
//   · accepting a change silently means "verified"
//
//   usage:  node tests/p_message_trust_test.mjs
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// A real-enough localStorage, kept outside the sandbox so a "reload" can be
// simulated by building a fresh sandbox over the same bytes.
const disk = new Map();
const makeWindow = () => {
  const sandbox = {
    console,
    localStorage: {
      getItem: (k) => (disk.has(k) ? disk.get(k) : null),
      setItem: (k, v) => disk.set(k, String(v)),
      removeItem: (k) => disk.delete(k),
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(ROOT, "js/lib/pm-trust.js"), "utf8"), ctx,
    { filename: "pm-trust.js" });
  return sandbox.PMTrust;
};

let PMTrust = makeWindow();
const reload = () => { PMTrust = makeWindow(); };

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);

const ME = "user_asha", GUEST = "guest_7f3c";
const JUMA = "user_juma";
const KEY_A = "AAAA-juma-original-public-key";
const KEY_B = "BBBB-juma-substituted-public-key";

section("1. First sight");
{
  const r = PMTrust.record(ME, JUMA, KEY_A, "Juma Mwanga");
  ok(r.status === "new", "a key never seen before is recorded, not questioned");
  ok(r.changed === false, "and raises nothing — there is nothing to contradict");
  ok(r.verified === false, "but it is NOT verified: nobody has checked anything yet");
  ok(PMTrust.status(ME, JUMA).status === "seen", "it is on file as merely seen");
}

section("2. The same key again");
{
  const r = PMTrust.record(ME, JUMA, KEY_A, "Juma Mwanga");
  ok(r.status === "same", "the key that is already on file is recognised");
  ok(r.changed === false, "and stays quiet");
}

section("3. Verifying it");
{
  PMTrust.markVerified(ME, JUMA, KEY_A, "Juma Mwanga");
  ok(PMTrust.status(ME, JUMA).verified === true, "comparing the number out of band is remembered");
  reload();
  ok(PMTrust.status(ME, JUMA).verified === true,
     "and survives a reload — a verification that evaporates is not one");
}

section("4. The substitution");
{
  const r = PMTrust.record(ME, JUMA, KEY_B, "Juma Mwanga");
  ok(r.status === "changed", "a different key for a known person is caught");
  ok(r.changed === true, "and raises the alarm");
  ok(r.verified === false, "the new key is NOT verified — what was verified is gone");
  ok(r.wasVerified === true,
     "and the dialog is told the old one HAD been checked, which is the worse case");
}

section("5. The alarm cannot be waited out");
{
  // The attacker's cheapest move against a warning is to do nothing and let
  // it be re-fetched away. This is the test that says it will not work.
  const again = PMTrust.record(ME, JUMA, KEY_B, "Juma Mwanga");
  ok(again.changed === true, "fetching the substituted key again does NOT clear the warning");
  reload();
  ok(PMTrust.status(ME, JUMA).changed === true, "and neither does a reload");
  const third = PMTrust.record(ME, JUMA, KEY_B, "Juma Mwanga");
  ok(third.status === "changed", "however many times it arrives, it is still the changed key");
}

section("6. Two ways out, both requiring a person");
{
  PMTrust.accept(ME, JUMA);
  const s = PMTrust.status(ME, JUMA);
  ok(s.changed === false, "'they changed phone' clears the alarm");
  ok(s.verified === false,
     "but lands on SEEN, never VERIFIED — this key has been checked by nobody");

  PMTrust.markVerified(ME, JUMA, KEY_B, "Juma Mwanga");
  ok(PMTrust.status(ME, JUMA).verified === true, "comparing the new number is the other way out");

  // And the pin moved: the OLD key must now be the one that alarms.
  const back = PMTrust.record(ME, JUMA, KEY_A, "Juma Mwanga");
  ok(back.changed === true, "after which the original key is itself a change");
}

section("7. One browser, two identities");
{
  // Section 6 left the account's pin on KEY_A and alarmed; settle it first,
  // so what this section measures is the boundary between identities and not
  // the leftovers of the previous one.
  PMTrust.markVerified(ME, JUMA, KEY_A, "Juma Mwanga");

  // A guest session and a signed-in account share a localStorage. They must
  // not share a verdict: the guest never checked anything.
  PMTrust.record(GUEST, JUMA, KEY_B, "Juma Mwanga");
  ok(PMTrust.status(GUEST, JUMA).verified === false,
     "a guest does not inherit the account's verification of the same person");
  ok(PMTrust.status(ME, JUMA).verified === true, "and the account keeps its own");

  const swap = PMTrust.record(GUEST, JUMA, KEY_A, "Juma Mwanga");
  ok(swap.changed === true, "the guest's own history is what its alarm is measured against");
  ok(PMTrust.status(ME, JUMA).changed === false, "and firing it does not disturb the account");
}

section("8. Ending a guest session");
{
  PMTrust.forgetAll(GUEST);
  ok(PMTrust.status(GUEST, JUMA).status === "unknown",
     "the guest's pinned keys go with the guest identity");
  ok(PMTrust.status(ME, JUMA).verified === true, "the account's are untouched");
  reload();
  ok(PMTrust.status(GUEST, JUMA).status === "unknown", "and they stay gone");
}

section("9. Nothing is recorded from nothing");
{
  ok(PMTrust.record(ME, JUMA, "") === null, "an empty key is not a key and is not written down");
  ok(PMTrust.record(null, JUMA, KEY_A) === null, "nor is anything recorded without an owner");
  ok(PMTrust.status(ME, "user_nobody").status === "unknown",
     "someone never seen is 'unknown', not 'fine'");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
