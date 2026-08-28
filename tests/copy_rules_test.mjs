// ============================================================================
//  copy_rules_test.mjs — the three copy rules, enforced.
//
//    1. No emoji in anything a person sees.
//    2. No spaced dash inside a sentence: "—", "–", " - ".
//    3. Every visible string exists in English AND Swahili.
//
//  Rules 1 and 3 are HARD: any hit fails.
//
//  Rule 2 is a RATCHET, not a wall. There were 350 spaced dashes in i18n.js
//  when the rule was written, spread across every page in the site. Failing on
//  all of them would have meant either a 350-string rewrite in one commit,
//  which nobody can review, or the rule being switched off within a week,
//  which is the same as not having it. So the count is recorded here and may
//  only ever go DOWN: clean the strings on the screen you are already
//  touching, lower the number, and the rule tightens itself.
//
//  Run: node tests/copy_rules_test.mjs
//       node tests/copy_rules_test.mjs --list    (show every remaining hit)
// ============================================================================
import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LIST = process.argv.includes("--list");

// The ratchet. Lower it when you clean strings; never raise it.
const DASH_BASELINE = 314;

// Unicode's own answer to "is this an emoji", rather than a hand-rolled block
// range. Extended_Pictographic draws the line exactly where the rule wants it:
//
//   caught   ✅ ⏳ 🏠 🛠 📍 🗺 🔍 ⚠ ☀     pictures, vendor-drawn, colour of
//                                          their own, a different glyph on
//                                          every phone
//   allowed  ✓ ✕ → ◯ ▦ ✎ ·                typographic marks. They are text:
//                                          they take currentColor, scale with
//                                          the font, and read as punctuation
//
// U+FE0F is the variation selector that forces emoji presentation onto an
// otherwise textual glyph, which is the same problem arriving by another door.
//
// © ® ™ are Extended_Pictographic and are NOT emoji here: every map tile
// provider requires its attribution string rendered verbatim, and "©" is part
// of that string. Removing it would be a licence breach, not a design fix.
const LEGAL = /[©®™]/g;
const EMOJI = /\p{Extended_Pictographic}|️/u;
const hasEmoji = (s) => EMOJI.test(String(s).replace(LEGAL, ""));

// A dash with a space beside it. A hyphen INSIDE a word ("self-contained",
// "PN-Zaki", "near-me.html") is a different character doing a different job
// and is deliberately not matched.
const SPACED_DASH = /(\s[—–-]\s)|(\s[—–]$)|(^[—–]\s)/;

let pass = 0;
const fails = [];
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); return; }
  fails.push(detail ? msg + "\n        " + detail : msg);
};

// ---------------------------------------------------------------------------
//  Read every visible string out of i18n.js.
// ---------------------------------------------------------------------------
const src = fs.readFileSync(path.join(ROOT, "js/core/i18n.js"), "utf8");
const lines = src.split("\n");

const strings = [];   // { key, value, line }
const count = {};     // key -> how many times defined
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^ {4}([a-z0-9_]+):\s*"(.*)",?\s*$/);
  if (!m) continue;
  strings.push({ key: m[1], value: m[2], line: i + 1 });
  count[m[1]] = (count[m[1]] || 0) + 1;
}

console.log("\nRead " + strings.length + " strings from js/core/i18n.js\n");

// ---------------------------------------------------------------------------
//  Rule 3 — both languages, nothing else.
// ---------------------------------------------------------------------------
console.log("3. Every string exists in English and Swahili");
const once = Object.entries(count).filter((e) => e[1] === 1).map((e) => e[0]);
ok(once.length === 0,
   "every key is defined twice, once per language (" + Object.keys(count).length + " keys)",
   once.length ? "defined only once: " + once.slice(0, 12).join(", ") +
     (once.length > 12 ? " …and " + (once.length - 12) + " more" : "") : "");

const thrice = Object.entries(count).filter((e) => e[1] > 2).map((e) => e[0] + "x" + e[1]);
ok(thrice.length === 0, "and none is defined a third time",
   thrice.length ? thrice.slice(0, 8).join(", ") : "");

// ---------------------------------------------------------------------------
//  Rule 1 — no emoji, in i18n or in anything a page renders.
// ---------------------------------------------------------------------------
console.log("\n1. No emoji in anything a person sees");
const emojiStrings = strings.filter((s) => hasEmoji(s.value));
ok(emojiStrings.length === 0, "no emoji in any i18n string",
   emojiStrings.map((s) => "i18n.js:" + s.line + "  " + s.key).join("\n        "));

// Pages and page scripts. Comments are written for developers and are skipped;
// only what ends up on screen is copy.
const UI_FILES = [];
for (const dir of ["", "js/pages", "js/lib", "js/core"]) {
  const abs = path.join(ROOT, dir);
  for (const f of fs.readdirSync(abs)) {
    if (dir === "" && !f.endsWith(".html")) continue;
    if (dir !== "" && !f.endsWith(".js")) continue;
    if (f === "i18n.js") continue;
    UI_FILES.push(dir ? dir + "/" + f : f);
  }
}

const stripComments = (t) =>
  t.replace(/\/\*[\s\S]*?\*\//g, " ")     // block comments, JS and CSS
   .replace(/^\s*\/\/.*$/gm, " ")          // whole-line // comments
   .replace(/(^|[^:"'`\\])\/\/[^"'`\n]*$/gm, "$1")   // trailing // comments
   .replace(/<!--[\s\S]*?-->/g, " ");      // HTML comments

const emojiHits = [];
for (const rel of UI_FILES) {
  const text = stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  text.split("\n").forEach((l, i) => {
    if (hasEmoji(l)) emojiHits.push(rel + ":" + (i + 1) + "  " + l.trim().slice(0, 68));
  });
}
ok(emojiHits.length === 0, "no emoji across " + UI_FILES.length + " pages and scripts",
   emojiHits.slice(0, 14).join("\n        ") +
   (emojiHits.length > 14 ? "\n        …and " + (emojiHits.length - 14) + " more" : ""));

// ---------------------------------------------------------------------------
//  Rule 2 — the ratchet.
// ---------------------------------------------------------------------------
console.log("\n2. No spaced dash inside a sentence");
const dashes = strings.filter((s) => SPACED_DASH.test(s.value));
const n = dashes.length;

if (LIST) dashes.forEach((d) => console.log("   i18n.js:" + d.line + "  " + d.key + ": " + d.value.slice(0, 76)));

if (n > DASH_BASELINE) {
  fails.push("spaced dashes went UP: " + n + ", baseline " + DASH_BASELINE +
    "\n        New ones must not be added.");
} else {
  pass++;
  const moved = DASH_BASELINE - n;
  console.log("  PASS  " + n + " remaining, baseline " + DASH_BASELINE +
    (moved > 0 ? "  (" + moved + " fewer, lower DASH_BASELINE to " + n + " to lock it in)" : ""));
}
console.log("        Run with --list to see them. Clean the ones on the screen you are already touching.");

// ---------------------------------------------------------------------------
console.log("");
fails.forEach((f) => console.log("  FAIL  " + f));
console.log("\n" + pass + " passed, " + fails.length + " failed\n");
process.exit(fails.length ? 1 : 0);
