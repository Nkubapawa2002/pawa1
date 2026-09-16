// ============================================================================
// money_range_test.mjs — a typed budget means the same thing everywhere.
//
// Two parsers used to exist: js/lib/explore-query.js had a correct one and
// js/pages/houses.js had an older copy. The copy got two things wrong, and
// both produced WRONG answers rather than missing ones:
//
//   · "chini ya 500k" matched nothing, so the budget was dropped and every
//     price was shown. English-only parsing on a bilingual app's main
//     catalogue.
//   · "between 200k and 400k" silently became "under 200k", because the copy
//     did not accept "and" as a separator and the bare-figure rule then took
//     the first number as a ceiling.
//
// Both callers now use js/lib/money-range.js, and this pins the behaviour that
// made the shared version worth having.
//
//   usage:  node tests/money_range_test.mjs    (no server, no browser)
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { console, window: {} };
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, "js/lib/money-range.js"), "utf8"), sandbox);
const MR = sandbox.window.MoneyRange;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};
const section = (s) => process.stdout.write("\n" + s + "\n");
const shows = (r) => `min=${r.priceMin} max=${r.priceMax}`;

section("1. The module loads and answers");
{
  ok(!!MR && typeof MR.parse === "function", "window.MoneyRange.parse exists");
  const empty = MR.parse("");
  ok(empty.priceMin === null && empty.priceMax === null,
     "nothing typed means no budget, not a budget of zero", shows(empty));
  ok(MR.parse(null).priceMax === null, "and null is the same as nothing");
}

section("2. A ceiling, in both languages");
{
  for (const [q, want] of [
    ["under 2m", 2000000],
    ["below 900k", 900000],
    ["up to 750000", 750000],
    ["budget of 1.5m", 1500000],
    // The half that used to be missing on houses.html.
    ["chini ya 500k", 500000],
    ["hadi 300k", 300000],
    ["isiyozidi 1m", 1000000],
    // "elfu" is Swahili for thousand. It was in the Explore parser and not in
    // the houses one, which is the drift this module ends.
    ["chini ya 800 elfu", 800000],
  ]) {
    const r = MR.parse(q);
    ok(r.priceMax === want, `"${q}" is a ceiling of ${want.toLocaleString()}`, shows(r));
  }
}

section("3. A floor, in both languages");
{
  for (const [q, want] of [
    ["over 500k", 500000],
    ["at least 1m", 1000000],
    ["zaidi ya 250k", 250000],
    ["kuanzia 400k", 400000],
  ]) {
    const r = MR.parse(q);
    ok(r.priceMin === want, `"${q}" is a floor of ${want.toLocaleString()}`, shows(r));
  }
}

section("4. A range, including the one that used to be read backwards");
{
  for (const [q, lo, hi] of [
    ["500k - 1.5m", 500000, 1500000],
    ["200k to 400k", 200000, 400000],
    ["300k hadi 600k", 300000, 600000],
    // THE BUG. On houses.js this returned max=200000 and no floor: the range
    // never matched, and the bare-figure rule took the first number as a
    // ceiling. Somebody asking for 200k-400k was shown only what was under
    // 200k, with nothing on screen to say so.
    ["between 200k and 400k", 200000, 400000],
    ["kati ya 200k na 400k", 200000, 400000],
  ]) {
    const r = MR.parse(q);
    ok(r.priceMin === lo && r.priceMax === hi,
       `"${q}" is ${lo.toLocaleString()} to ${hi.toLocaleString()}`, shows(r));
  }
  const rev = MR.parse("400k - 200k");
  ok(rev.priceMin === 200000 && rev.priceMax === 400000,
     "a range written backwards is still the same range", shows(rev));
}

section("5. \"and\" is not always a range, which is why both sides must be money");
{
  // The trap that shapes the parser. Accepting "and" is what makes "between
  // 200k and 400k" work; believing it unconditionally is what would turn a
  // room search into a price filter of 2 to 3 shillings.
  const beds = MR.parse("3 bedroom and 2 bathroom");
  ok(beds.priceMin === null && beds.priceMax === null,
     '"3 bedroom and 2 bathroom" is not the price range 2 to 3', shows(beds));

  const mixed = MR.parse("2 bedroom house under 600k");
  ok(mixed.priceMax === 600000 && mixed.priceMin === null,
     "a room count next to a real budget does not confuse the budget", shows(mixed));

  const bare = MR.parse("3");
  ok(bare.priceMax === null, '"3" alone is a room count, not a ceiling of three shillings', shows(bare));

  const big = MR.parse("450000");
  ok(big.priceMax === 450000, "a bare figure over 50,000 is a ceiling", shows(big));
}

section("6. Suffixes, and the letters that are not suffixes");
{
  ok(MR.parseMoney("1.5", "m") === 1500000, "1.5m is a million and a half");
  ok(MR.parseMoney("900", "k") === 900000, "900k");
  ok(MR.parseMoney("2", "bn") === 2000000000, "2bn");
  ok(MR.parseMoney("1,200,000", null) === 1200000, "commas are not decimal points");
  // The guard that stops "bedroom" reading as billions and "modern" as millions.
  const bed = MR.parse("3 bedroom");
  ok(bed.priceMax === null, '"3 bedroom" does not read the b as billions', shows(bed));
  const mod = MR.parse("modern 2 bedroom");
  ok(mod.priceMax === null, '"modern" does not read the m as millions', shows(mod));
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
