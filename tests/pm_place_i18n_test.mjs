// ============================================================================
//  pm_place_i18n_test.mjs — the location flow speaks Swahili, and keeps doing so.
//
//  WHY THIS EXISTS
//  On 2026-09-05 the whole "send a place" flow in P-Message was English. Not
//  partly: the picker heading, all four tab labels, every button, every error
//  reason, the card a reader sees. 76 pmp_* keys were called in the code and
//  23 of them existed in js/core/i18n.js. The other 53 fell through to their
//  English fallback on every screen, in both languages, for as long as the
//  feature had existed.
//
//  Nothing caught it, and nothing could have. tests/i18n_coverage.mjs loads a
//  page and reports English a person can see, but this flow is behind a modal
//  that opens only after you tap the pin, inside a thread, signed in, with a
//  key on the device. The scan never reaches it, so the page it measured was
//  clean and the page a person used was not. Exactly the blind spot
//  tests/detail_sheet_i18n_test.mjs was written for, one screen further in.
//
//  A fixture test could open the sheet, and for the rendered card below one
//  does. But the durable guard is cheaper and stricter than a browser: the
//  keys are read out of the SOURCE, so a key added tomorrow in a branch nobody
//  can reach still has to exist in both languages today.
//
//  WHAT IT CHECKS
//    1. Every t("key", "English") in the location flow is defined in en AND sw.
//    2. The English fallback in the code matches the English in i18n.js.
//       Two sources of truth for one sentence is how they come to disagree,
//       and the fallback is the one nobody ever sees while it is wrong.
//    3. No Swahili sentence is a copy of the English one.
//    4. The placeholders inside a string survive translation: "{n}" missing
//       from the Swahili is a visible "{n}" on somebody's phone.
//
//  Run: node tests/pm_place_i18n_test.mjs        (no server, no browser)
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const fails = [];
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log("  PASS  " + label); return; }
  fails.push(label + (detail ? "\n        " + detail : ""));
  console.log("  FAIL  " + label + (detail ? "\n        " + detail : ""));
};
const section = (s) => console.log("\n" + s);

// The files that draw the location flow. place-doors.js and pm-places.js use
// the ah_* prefix rather than pmp_*, which is a namespace artefact from the
// listing form these doors were born on, so both prefixes are collected.
const SOURCES = [
  "js/pages/p-message.js",
  "js/lib/pm-place.js",
  "js/lib/pm-places.js",
  "js/lib/place-doors.js",
];

// ---------------------------------------------------------------------------
// i18n.js, split into its two language blocks.
//
// Read by line rather than by evaluating the file: it is a browser script that
// assigns to window, and importing it into node would need a DOM. The shape is
// four-space-indented `key: "value",` inside `en: {` then `sw: {`, which is
// the same shape tests/copy_rules_test.mjs reads.
// ---------------------------------------------------------------------------
const i18nSrc = fs.readFileSync(path.join(ROOT, "js/core/i18n.js"), "utf8");
const i18nLines = i18nSrc.split("\n");

const en = new Map(), sw = new Map();
let block = null;
for (const line of i18nLines) {
  const head = line.match(/^\s{2}(en|sw)\s*:\s*\{/);
  if (head) { block = head[1] === "en" ? en : sw; continue; }
  if (!block) continue;
  const m = line.match(/^ {4}([a-z0-9_]+):\s*"(.*)",?\s*$/);
  if (m) block.set(m[1], m[2]);
}

section("0. The file parsed at all");
ok(en.size > 500, "the English block was found and read", "got " + en.size + " keys");
ok(sw.size > 500, "the Swahili block was found and read", "got " + sw.size + " keys");

// ---------------------------------------------------------------------------
// Every t("key", "English fallback") call in the flow.
//
// Only the two-argument form is collected. A t("key") with no fallback carries
// no English to compare against, and there is nothing to check but existence,
// which rule 1 covers anyway.
// ---------------------------------------------------------------------------
const used = new Map();   // key -> { fallback, where }
for (const rel of SOURCES) {
  const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const re = /\bt\(\s*"((?:pmp|pm|ah)_[a-z0-9_]+)"\s*,\s*("(?:[^"\\]|\\.)*")/g;
  for (const m of text.matchAll(re)) {
    if (used.has(m[1])) continue;
    used.set(m[1], { fallback: JSON.parse(m[2]), where: rel });
  }
}

section("1. Every string in the location flow exists in both languages");
console.log("  ....  " + used.size + " keys called across " + SOURCES.length + " files");

const missingEn = [...used.keys()].filter((k) => !en.has(k));
const missingSw = [...used.keys()].filter((k) => !sw.has(k));
ok(missingEn.length === 0, "every key the flow calls is defined in English",
   missingEn.slice(0, 12).join(", ") +
   (missingEn.length > 12 ? " …and " + (missingEn.length - 12) + " more" : ""));
ok(missingSw.length === 0, "and in Swahili",
   missingSw.slice(0, 12).join(", ") +
   (missingSw.length > 12 ? " …and " + (missingSw.length - 12) + " more" : ""));

// ---------------------------------------------------------------------------
section("2. The fallback in the code says the same thing as i18n.js");

// The fallback is what renders when a key is missing, so a fallback that has
// drifted from the entry is a sentence nobody proofreads until the day it is
// the only one showing.
const drift = [];
for (const [k, v] of used) {
  if (!en.has(k)) continue;
  // i18n.js values are raw source between quotes, so an escaped quote or
  // backslash is still escaped. Put it through the same parser as the code
  // fallback so the two are compared as the strings a person would read.
  let entry;
  try { entry = JSON.parse('"' + en.get(k) + '"'); } catch (_) { entry = en.get(k); }
  if (entry !== v.fallback) {
    drift.push(k + "\n            code:  " + JSON.stringify(v.fallback) +
                   "\n            i18n:  " + JSON.stringify(entry));
  }
}
ok(drift.length === 0, "no English fallback disagrees with its i18n entry",
   drift.slice(0, 4).join("\n        ") +
   (drift.length > 4 ? "\n        …and " + (drift.length - 4) + " more" : ""));

// ---------------------------------------------------------------------------
section("3. The Swahili is Swahili");

// A sentence copied across untranslated is the failure this whole file exists
// to stop, and it passes rule 1 while doing it. Short strings are exempt:
// "GPS", a bare number, or a word the two languages genuinely share is not
// evidence of anything.
const untranslated = [];
for (const k of used.keys()) {
  if (!en.has(k) || !sw.has(k)) continue;
  const e = en.get(k), s = sw.get(k);
  if (e.length >= 25 && e === s) untranslated.push(k + "  " + JSON.stringify(e.slice(0, 60)));
}
ok(untranslated.length === 0, "no Swahili sentence is a copy of the English one",
   untranslated.slice(0, 8).join("\n        "));

// ---------------------------------------------------------------------------
section("4. Placeholders survive the crossing");

// "{n}", "{room}", "{name}" are substituted at render. One dropped in
// translation is not a missing word, it is a number that never appears; one
// invented is a literal "{n}" on the screen.
const holes = [];
for (const k of used.keys()) {
  if (!en.has(k) || !sw.has(k)) continue;
  const grab = (s) => (s.match(/\{[a-z0-9_]+\}/gi) || []).slice().sort().join(",");
  const a = grab(en.get(k)), b = grab(sw.get(k));
  if (a !== b) holes.push(k + "  en[" + (a || "none") + "]  sw[" + (b || "none") + "]");
}
ok(holes.length === 0, "every placeholder in an English string is in the Swahili one",
   holes.slice(0, 8).join("\n        "));

// ---------------------------------------------------------------------------
console.log("");
fails.forEach((f) => console.log("  FAIL  " + f));
console.log("\n" + pass + " passed, " + fails.length + " failed\n");
process.exit(fails.length ? 1 : 0);
