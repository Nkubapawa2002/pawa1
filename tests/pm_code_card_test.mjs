// ============================================================================
// pm_code_card_test.mjs — a place sent as a sealed nine-character code.
//
// WHY THIS FILE IS DIFFERENT FROM ITS TWO SIBLINGS
// pm_invite_card_test.mjs and pm_listing_card_test.mjs are both, mostly, one
// attack written eleven ways: a URL that LOOKS like ours. Their whole fence is
// isOurs(), so that is what they hammer.
//
// This card recognises no URL at all, and that is the point of it. What
// share-location.html used to hand to navigator.share was
//
//     https://www.google.com/maps/search/?api=1&query=-6.812345,39.279876
//
// and there is nothing in that string to check. It is a perfectly valid link
// whichever coordinates it carries, so a middleman who edits two digits sends
// somebody to a different house and the person reading cannot tell. No
// same-origin rule helps: the domain was never the lie.
//
// A code has something to check. So the questions here are the other ones:
//
//   · does a tampered code FAIL, rather than resolving somewhere else?
//   · is a nine-character word in an ordinary sentence left alone?
//   · does the sentence a person wrote survive the code being taken out?
//   · and does the card stay a button that can only reach LocShare.open()?
//
// The parity character is the load-bearing part of the first question, and it
// is real: js/lib/loc-code.js is loaded here, not stubbed, so the check symbol
// is computed by the same GF(2^5) code the browser runs.
//
//   usage:  node tests/pm_code_card_test.mjs   (no server, no browser)
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// loc-code.js reaches for crypto.subtle at call time (for seal/derive, which
// nothing here uses) and for the alphabet tables at parse time. A real
// webcrypto keeps it honest either way.
const sandbox = { console, URL, URLSearchParams, crypto: webcrypto, TextEncoder, TextDecoder };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, "js/lib/loc-code.js"), "utf8"), sandbox);
vm.runInContext(readFileSync(join(ROOT, "js/lib/pm-code-card.js"), "utf8"), sandbox);
const LC = sandbox.LocCode;
const C = sandbox.PMCodeCard;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};
const section = (s) => process.stdout.write("\n" + s + "\n");

if (!LC) { process.stdout.write("LocCode did not load\n"); process.exit(1); }
if (!C) { process.stdout.write("PMCodeCard did not load\n"); process.exit(1); }

// ---- a real, valid code ----------------------------------------------------
// Built the way loc-code.js builds one: eight characters, then the check
// symbol it computes for them. Never hand-typed, or the test would be asserting
// against a code the library disagrees with.
function validCode(eight) {
  const c = LC.normalize(eight).slice(0, 8);
  // checkSymbol returns a SYMBOL INDEX over GF(2^5), not a character;
  // completeCode() in loc-code.js indexes the alphabet with it exactly so.
  return c + LC.ALPHABET[LC.checkSymbol(LC.toSymbols(c))];
}
const CODE = validCode("K7M2Q9F3");
const PRETTY = LC.format(CODE);

section("0. The fixture is a code the library itself accepts");
ok(CODE.length === 9, "nine characters", CODE);
ok(LC.problem(CODE) === null, "and loc-code.js raises no problem with it", String(LC.problem(CODE)));
ok(PRETTY.includes("-"), "the display form is grouped in threes", PRETTY);

section("1. Composing and reading it back");
{
  const body = C.compose({ code: CODE }, "The blue gate, not the green one");
  ok(body.split("\n")[0] === "The blue gate, not the green one",
     "the sentence a person wrote comes FIRST, above the code", JSON.stringify(body));
  ok(body.includes(PRETTY), "and the code is in the body as plain, sayable text", body);

  const got = C.read(body);
  ok(!!got, "read() finds it");
  ok(got && got.code === CODE, "normalised back to the nine characters", got && got.code);
  ok(got && got.pretty === PRETTY, "with the grouped form for drawing");
  ok(got && got.note === "The blue gate, not the green one",
     "and the note is the words with the code taken out", got && got.note);
  ok(C.has(body), "has() agrees");
  ok(C.stripped(body) === "The blue gate, not the green one",
     "stripped() leaves the sentence so the card is not printed twice under itself",
     C.stripped(body));
}

section("2. A message that is nothing but a code");
{
  const body = C.compose({ code: CODE }, "");
  const got = C.read(body);
  ok(!!got && got.code === CODE, "still reads");
  ok(body.split("\n").length === 2,
     "compose writes a default sentence rather than a bare code, so the bubble is never one opaque line",
     JSON.stringify(body));
}

section("3. A TAMPERED CODE FAILS. This is the whole feature.");
{
  // Every single-character change to a valid code, tried exhaustively over the
  // real alphabet. Not one of them may read as a DIFFERENT valid code: that is
  // the property a maps URL never had.
  let read = 0, tried = 0;
  for (let i = 0; i < CODE.length; i++) {
    for (const ch of LC.ALPHABET) {
      if (ch === CODE[i]) continue;
      tried++;
      const bad = CODE.slice(0, i) + ch + CODE.slice(i + 1);
      const got = C.read(LC.format(bad));
      if (got) read++;
    }
  }
  ok(tried === CODE.length * (LC.ALPHABET.length - 1),
     "every one-character edit was tried", String(tried));
  ok(read === 0,
     "and NOT ONE of them reads as a code. A wrong character fails closed; it never resolves to a different place",
     read + " of " + tried + " were accepted");
}
{
  // Two-character edits are a different claim and a weaker one: parity over
  // GF(2^5) catches every single error and most, but provably not all, double
  // errors. Pinning the real number down stops somebody "improving" the check
  // into something that catches fewer.
  let read = 0, tried = 0;
  for (let i = 0; i < CODE.length - 1; i++) {
    for (let j = i + 1; j < CODE.length; j++) {
      for (const a of LC.ALPHABET) {
        if (a === CODE[i]) continue;
        for (const b of LC.ALPHABET) {
          if (b === CODE[j]) continue;
          tried++;
          const bad = CODE.split("");
          bad[i] = a; bad[j] = b;
          if (C.read(LC.format(bad.join("")))) read++;
        }
      }
    }
  }
  ok(tried > 20000, "every two-character edit was tried", String(tried));
  ok(read / tried < 0.05,
     "and under 5% of DOUBLE edits survive parity, which is what a single check symbol buys. " +
     "The server's handle lookup is the second fence behind this one, not this one's job",
     (100 * read / tried).toFixed(2) + "% of " + tried);
}

section("4. Ordinary text is left alone");
{
  const notCodes = [
    "See you at 9",
    "The rent is 350000 a month",
    "My number is 0712345678 if you need it",
    "Order reference ABCDEFGHJ",          // nine chars, but parity will not hold
    "meet me at the junction",
  ];
  let drawn = [];
  for (const line of notCodes) if (C.read(line)) drawn.push(line);
  ok(drawn.length === 0,
     "none of five ordinary sentences is mistaken for a code",
     drawn.join(" | "));
}
{
  // The word-boundary rule, which carries as much weight as parity: one in
  // thirty-two random strings passes the check symbol, so a code glued inside
  // a longer token must not be dug out of it.
  ok(!C.read("REF" + PRETTY + "X"), "a code glued into a longer token is not extracted");
  ok(!C.read("abc" + CODE), "nor one with letters run up against it");
  ok(!!C.read("open " + PRETTY + "."), "but one at the end of a sentence is found");
  ok(!!C.read("(" + PRETTY + ")"), "and one in brackets");
}

section("5. O/0 and I/L, the way a person writes them down");
{
  // Crockford's alphabet has no O, I or L precisely because people confuse
  // them with 0 and 1. loc-code.js folds them on input, and a code READ OUT on
  // a phone and typed back into a message is exactly where that happens.
  const withLetters = PRETTY.replace(/0/g, "O").replace(/1/g, "I");
  const got = C.read(withLetters);
  if (withLetters === PRETTY) {
    ok(true, "this fixture has no 0 or 1 to fold, so there is nothing to prove here");
  } else {
    ok(!!got && got.code === CODE,
       "a code written with O for zero and I for one still reads as the same code",
       withLetters + " -> " + (got && got.code));
  }
}

section("6. The card");
{
  const got = C.read(C.compose({ code: CODE }, "here"));
  const mine = C.card(got, { mine: true });
  const theirs = C.card(got, { mine: false });

  ok(mine.includes(PRETTY) && theirs.includes(PRETTY),
     "the code is PRINTED on the card in both directions: it is the fallback that works when the button does not");
  ok(theirs.includes('data-code-open="' + CODE + '"'),
     "the button carries the code itself, not an index into a log that is redrawn on every message");
  ok(mine !== theirs, "and the two sides are told different, true things");
  ok(/<svg/.test(theirs), "it carries a stroke SVG");
  // eslint-disable-next-line no-misleading-character-class
  ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(theirs), "and no emoji");
  ok(!/https?:\/\//.test(theirs) && !/<a /.test(theirs),
     "NOTHING on this card is a link. There is no URL to misread and no anchor to follow: the only thing the button can do is hand nine characters to LocShare.open()");
}
{
  // The card is built from read()'s own output, but a body is attacker-supplied
  // and the escaping has to hold anyway.
  const hostile = { code: '"><script>x()</script>', pretty: '"><img onerror=x>' };
  const html = C.card(hostile, {});
  ok(!html.includes("<script>"), "markup in a code is escaped, not executed", html.slice(0, 120));
  ok(!html.includes("<img onerror"), "and cannot break out of its own attribute");
}

process.stdout.write("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
