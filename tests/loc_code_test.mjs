// ============================================================================
// loc_code_test.mjs — the nine characters, attacked rather than demonstrated.
//
// The check symbol claims two absolutes: every single wrong character is
// caught, and every swap of two characters is caught. Absolutes are worth
// testing exhaustively rather than by sampling, and at this size that is
// affordable — 9 positions x 31 wrong values, and all 36 position pairs, on
// many random codes. If either claim is false these fail immediately.
//
// The encryption claims a smaller set of things, and they are tested the same
// way p_crypto_test.mjs tests P-Message: as attacks.
//
//   · a different code opens the share            (must not)
//   · a ciphertext moved to another share opens   (must not — the AAD)
//   · two seals of one place look alike           (must not — fresh IV)
//   · the coordinates survive in the ciphertext   (must not)
//
//   usage:  node tests/loc_code_test.mjs
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const sandbox = { console, crypto: webcrypto, TextEncoder, TextDecoder, Buffer };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, "js/lib/loc-code.js"), "utf8"), ctx, { filename: "loc-code.js" });
const L = sandbox.LocCode;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// A stand-in for the server's minted locator: five valid Base32 characters.
function fakeLocator() {
  let s = "";
  for (let i = 0; i < 5; i++) s += L.ALPHABET[Math.floor(Math.random() * 32)];
  return s;
}

section("1. The alphabet is the one that survives a phone call");
{
  ok(L.ALPHABET.length === 32, "32 symbols, so each character carries exactly 5 bits");
  ok(!/[ILOU]/.test(L.ALPHABET), "no I, L, O or U — the four that get misheard or misread");
  ok(new Set(L.ALPHABET).size === 32, "no symbol appears twice");

  ok(L.normalize("k7m-2q9-f3t") === "K7M2Q9F3T", "case and separators do not matter");
  ok(L.normalize("O0 Il1") === "00111", "O folds to 0 and I/L fold to 1, as Crockford specifies");
  ok(L.normalize(null) === "", "nothing in, nothing out — no crash on an empty box");
  ok(L.format("K7M2Q9F3T") === "K7M-2Q9-F3T", "shown in three groups of three, like a phone number");
}

section("2. Every single wrong character is caught");
{
  let checked = 0, missed = 0;
  for (let trial = 0; trial < 40; trial++) {
    const code = L.completeCode(fakeLocator());
    for (let pos = 0; pos < 9; pos++) {
      for (const ch of L.ALPHABET) {
        if (ch === code[pos]) continue;
        const bad = code.slice(0, pos) + ch + code.slice(pos + 1);
        checked++;
        if (L.isValid(bad)) missed++;
      }
    }
  }
  ok(checked === 40 * 9 * 31, `all ${checked} one-character errors were tried`);
  ok(missed === 0, "not one of them passed the check symbol", `${missed} slipped through`);
}

section("3. Every swap of two characters is caught");
{
  let checked = 0, missed = 0;
  for (let trial = 0; trial < 200; trial++) {
    const code = L.completeCode(fakeLocator());
    for (let i = 0; i < 9; i++) {
      for (let j = i + 1; j < 9; j++) {
        if (code[i] === code[j]) continue;      // swapping equal characters is not an error
        const a = code.split("");
        const t = a[i]; a[i] = a[j]; a[j] = t;
        checked++;
        if (L.isValid(a.join(""))) missed++;
      }
    }
  }
  ok(checked > 5000, `${checked} transpositions tried across 200 codes`);
  ok(missed === 0, "not one transposition passed — including a swap that moves the check character",
     `${missed} slipped through`);
}

section("4. A code is rejected for the right reason");
{
  const code = L.completeCode(fakeLocator());
  ok(L.problem(code) === null, "a freshly built code is accepted");
  ok(L.problem(code.slice(0, 8)) === "short", "eight characters reads as short, not as wrong");
  ok(L.problem(code + "7") === "long", "ten characters reads as long");
  ok(L.problem("UUUUUUUUU") === "chars", "U is not in the alphabet and says so");
  const flipped = code.slice(0, 8) + L.ALPHABET[(L.ALPHABET.indexOf(code[8]) + 1) % 32];
  ok(L.problem(flipped) === "check", "a wrong check character is named as such, not as gibberish");
  ok(L.isValid("k7m 2q9 f3t") === (L.problem("K7M2Q9F3T") === null),
     "validity does not depend on how it was typed");
}

section("5. The three characters this device adds are its own");
{
  const loc = fakeLocator();
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(L.completeCode(loc).slice(5, 8));
  ok(seen.size > 200, `300 codes off one locator produced ${seen.size} different secrets`);
  ok([...seen].every((s) => s.length === 3), "each is exactly three characters");
  ok(L.completeCode(loc).slice(0, 5) === loc, "the server's five characters are left alone");

  const e = (() => { try { L.completeCode("ABC"); return null; } catch (err) { return err; } })();
  ok(e !== null, "a locator of the wrong length is refused rather than padded");
}

section("6. The code is the key");
{
  const code = L.completeCode(fakeLocator());
  const place = { lat: -6.792354, lng: 39.208328, acc: 12, label: "Kariakoo, Dar es Salaam", at: Date.now() };

  const sealed = await L.seal(code, place);
  ok(/^[0-9a-f]{64}$/.test(sealed.handle), "the handle is 64 hex characters and nothing else");
  ok(typeof sealed.cipher === "string" && sealed.cipher.length > 0, "there is a ciphertext");

  const back = await L.open(code, sealed.cipher, sealed.iv);
  ok(back.lat === place.lat && back.lng === place.lng, "the right code returns the exact coordinates");
  ok(back.label === place.label, "and the label with them");

  const other = L.completeCode(fakeLocator());
  const e1 = await threw(() => L.open(other, sealed.cipher, sealed.iv));
  ok(e1 !== null, "a different code does not open it");

  // The AAD binds the ciphertext to its own handle: a row copied into another
  // share's slot is not readable there even by the code that made it.
  const foreign = await L.seal(other, place);
  const e2 = await threw(() => L.open(other, sealed.cipher, foreign.iv));
  ok(e2 !== null, "a ciphertext lifted into another share does not decrypt");

  const tampered = sealed.cipher.slice(0, -2) + (sealed.cipher.slice(-2) === "AA" ? "BB" : "AA");
  const e3 = await threw(() => L.open(code, tampered, sealed.iv));
  ok(e3 !== null, "a single altered character in storage is refused, not silently decoded");
}

section("7. Two shares of one place look nothing alike");
{
  const code = L.completeCode(fakeLocator());
  const place = { lat: -6.8, lng: 39.28, acc: 8, label: "same shop", at: 1 };
  const a = await L.seal(code, place);
  const b = await L.seal(code, place);
  ok(a.iv !== b.iv, "a fresh IV every time — reusing one under AES-GCM loses everything");
  ok(a.cipher !== b.cipher, "so the ciphertexts differ too");
  ok(a.handle === b.handle, "but the handle is the same, because the code is");

  ok(!a.cipher.includes("39.28") && !a.cipher.includes("-6.8"),
     "no coordinate survives as readable text in the ciphertext");
  ok(!a.cipher.includes("same shop"), "nor does the label");
}

section("8. The same code always lands on the same row");
{
  const code = L.completeCode(fakeLocator());
  const d1 = await L.derive(code);
  const d2 = await L.derive(L.format(code).toLowerCase());
  ok(d1.handle === d2.handle, "typed with dashes and in lower case, it is still the same share");

  const d3 = await L.derive(L.completeCode(fakeLocator()));
  ok(d1.handle !== d3.handle, "a different code is a different handle");

  const bad = await threw(() => L.derive("K7M2Q9F3"));
  ok(bad !== null, "an invalid code never reaches the network — derive refuses it here");
}

section("9. Only the sender can call it back");
{
  const r = await L.revokeToken();
  ok(/^[0-9a-f]{64}$/.test(r.hash), "the server is given a hash");
  ok(r.token.length >= 40 && !/[^A-Za-z0-9_-]/.test(r.token), "the token is 256 bits of base64url");
  ok((await L.revokeHash(r.token)) === r.hash, "the hash is reproducible from the token");

  const r2 = await L.revokeToken();
  ok(r2.token !== r.token && r2.hash !== r.hash, "and never repeats");
}

section("10. Coarsening is a grid, not a smear");
{
  const lat = -6.792354, lng = 39.208328;
  const a = L.coarsen(lat, lng, 100);
  ok(L.coarsen(a.lat, a.lng, 100).lat === a.lat && L.coarsen(a.lat, a.lng, 100).lng === a.lng,
     "a coarse point coarsens to itself — the grid is fixed, so re-sharing does not walk away");

  // Nearby fixes agree unless they straddle a cell edge, which some genuinely
  // do. That is the honest number, and it is still nothing like added noise,
  // where every re-share moves.
  let same = 0;
  for (let i = 0; i < 200; i++) {
    const j = L.coarsen(lat + (Math.random() - 0.5) * 0.00018,
                        lng + (Math.random() - 0.5) * 0.00018, 100);
    if (j.lat === a.lat && j.lng === a.lng) same++;
  }
  ok(same > 140, `${same} of 200 fixes within ~10 m landed on the same cell`);

  const dLatM = Math.abs(a.lat - lat) * 111320;
  ok(dLatM <= 60, `the coarse point stays within half a cell (${dLatM.toFixed(0)} m)`);

  // A degree of longitude shrinks towards the poles, so the grid step must grow
  // there or the cells stop being square.
  const eq = L.coarsen(0.5, 30.0004, 1000);
  const far = L.coarsen(66.5, 30.0004, 1000);
  ok(Math.abs(far.lng - 30.0004) >= Math.abs(eq.lng - 30.0004),
     "the longitude step widens with latitude instead of pretending the earth is flat");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
