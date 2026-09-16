// ============================================================================
// i18n_keys_test.mjs — every key the app asks for is a key that exists.
//
// WHY THIS IS A DIFFERENT TEST FROM i18n_coverage.mjs.
//
// That one loads pages in a browser and looks for ENGLISH ON SCREEN: a string
// nobody wired up. This one never opens a browser and looks for the opposite
// failure, which is worse and quieter:
//
//     window.t("xp_scopes_aria")   ->  "xp_scopes_aria"
//
// window.t takes a key and nothing else, and it RETURNS THE KEY ITSELF when
// the string is missing. So a typo, or a key deleted while a caller still asks
// for it, does not throw and does not fall back to English. It prints the
// identifier on the screen, in both languages, forever. The same is true of
// data-i18n in markup: the English sitting in the HTML is dead text that is
// overwritten on boot, so a missing key replaces real copy with a slug.
//
// The scan reads js/core/i18n.js for what is DEFINED, then every page and
// script for what is ASKED FOR, and reports keys asked for and never defined.
//
// It also reports keys defined in only ONE language, which renders correctly
// for half the users and as a slug for the other half.
//
//   usage:  node tests/i18n_keys_test.mjs           (no server, no browser)
//           node tests/i18n_keys_test.mjs --unused  (also list dead keys)
// ============================================================================
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOW_UNUSED = process.argv.includes("--unused");

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};
const section = (s) => process.stdout.write("\n" + s + "\n");

// ---- what is DEFINED --------------------------------------------------------
// i18n.js is one object literal per language. Rather than parse it, read the
// two language blocks by their markers and collect `key:` at the top level of
// each. The file is machine-written enough for this to be exact, and
// copy_rules_test already asserts every key is defined exactly twice.
const src = readFileSync(join(ROOT, "js/core/i18n.js"), "utf8");

// NOT anchored to the start of a line. i18n.js puts several short strings on
// one line -- `xp_f_rent: "for rent", xp_f_sale: "for sale",` -- and a
// line-anchored pattern reads the first and silently loses the rest, which
// made this test report four keys as missing that were sitting right there.
// A key is a name followed by a colon and the start of a STRING, which is what
// every entry in this file is.
const KEY_ANY = /(?:^|[,{])\s*([a-z][a-z0-9_]*)\s*:\s*["'`]/gm;

function keysBetween(from, to) {
  const slice = src.slice(from, to < 0 ? undefined : to);
  const out = new Set();
  const re = new RegExp(KEY_ANY.source, "gm");
  let m;
  while ((m = re.exec(slice)) !== null) out.add(m[1]);
  return out;
}

// The two blocks. `sw:` opens the Swahili half.
const swAt = src.search(/^\s{2}sw:\s*\{/m);
const enKeys = keysBetween(0, swAt);
const swKeys = keysBetween(swAt, -1);

// THE SECOND CATALOGUE. The house detail sheet does not use i18n.js:
// js/lib/house-spec.js carries its own table, one entry per key holding both
// languages at once (`cost_total: { en: "Total priced", sw: "Jumla yenye bei" }`),
// and js/lib/house-rooms.js and house-cost-chart.js read it through
// HouseSpec.t(). A scan that knows only about i18n.js reports all 37 of those
// as missing, which is how this test spent its first run accusing perfectly
// translated code.
const specSrc = readFileSync(join(ROOT, "js/lib/house-spec.js"), "utf8");
const SPEC_KEY = /(?:^|[,{])\s*([a-z][a-z0-9_]*)\s*:\s*\{\s*en\s*:/gm;
const specKeys = new Set();
{
  let m;
  while ((m = SPEC_KEY.exec(specSrc)) !== null) specKeys.add(m[1]);
}

const defined = new Set([...enKeys, ...swKeys, ...specKeys]);

section("1. The definitions were read");
{
  ok(swAt > 0, "the Swahili block was found in js/core/i18n.js");
  ok(enKeys.size > 500, `English keys found (${enKeys.size})`);
  ok(swKeys.size > 500, `Swahili keys found (${swKeys.size})`);
}

// ---- what is ASKED FOR ------------------------------------------------------
function walk(dir, hit) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "www", "android", "docs", "shots", "data"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, hit);
    else if (/\.(js|html)$/.test(name)) hit.push(p);
  }
}
const files = [];
walk(ROOT, files);

const asked = new Map();               // key -> [where]
const note = (key, file, line) => {
  if (!asked.has(key)) asked.set(key, []);
  asked.get(key).push(`${relative(ROOT, file).replace(/\\/g, "/")}:${line}`);
};

// t("key"), window.t("key"), t("key", "fallback") and the aria/attr variants.
const CALL = /\bt\(\s*["'`]([a-z][a-z0-9_]*)["'`]/g;
const ATTR = /data-i18n(?:-[a-z-]+)?\s*=\s*["']([a-z][a-z0-9_]*)["']/g;

for (const file of files) {
  if (file.endsWith(join("js", "core", "i18n.js"))) continue;
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const re of [CALL, ATTR]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i])) !== null) note(m[1], file, i + 1);
    }
  }
}

section("2. Every key the app asks for is defined");
{
  ok(asked.size > 200, `keys referenced across ${files.length} files (${asked.size})`);
  // A key built at runtime cannot be seen by a scan. The giveaway is the
  // shape: `t("xp_k_" + kind)` leaves the literal "xp_k_" with a trailing
  // underscore, which is never a whole key. One-character literals are not
  // keys either.
  const isFragment = (k) => k.endsWith("_") || k.length < 3;
  const missing = [...asked.entries()].filter(([k]) => !defined.has(k) && !isFragment(k));
  // Every one of them, grouped by the file that asks. A slice would hide the
  // shape of the problem, which is usually one screen missing a whole family.
  const byFile = new Map();
  for (const [k, where] of missing) {
    const f = where[0].split(":")[0];
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(k);
  }
  ok(missing.length === 0,
     "no page asks for a string that does not exist",
     [...byFile.entries()].sort()
       .map(([f, ks]) => `${f}  (${ks.length})\n            ${ks.join(", ")}`)
       .join("\n        "));
}

section("3. Nothing is defined in only one language");
{
  // A key in en and not sw renders correctly for half the users and as its own
  // slug for the other half -- which is the failure nobody reviewing in
  // English will ever see.
  const enOnly = [...enKeys].filter((k) => !swKeys.has(k));
  const swOnly = [...swKeys].filter((k) => !enKeys.has(k));
  ok(enOnly.length === 0, "no key is English only",
     enOnly.slice(0, 12).join(", "));
  ok(swOnly.length === 0, "no key is Swahili only",
     swOnly.slice(0, 12).join(", "));
}

if (SHOW_UNUSED) {
  section("4. Defined and never asked for (report only)");
  const unused = [...defined].filter((k) => !asked.has(k)).sort();
  process.stdout.write(`  ${unused.length} keys are defined and referenced by no file.\n`);
  process.stdout.write("  Many are built at runtime and perfectly alive; this is a list to read,\n");
  process.stdout.write("  not a list to delete.\n");
  unused.forEach((k) => process.stdout.write(`    ${k}\n`));
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
