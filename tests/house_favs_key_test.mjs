// ============================================================================
// house_favs_key_test.mjs — the heart button and the pages that count it
// must name the same localStorage key.
//
// WHY THIS TEST EXISTS, AND WHY IT IS A SCAN RATHER THAN A BROWSER RUN.
//
// Saved houses live in localStorage under one key. Five files touch it and
// NONE of them owned it: each carried its own copy of the string, which is a
// shape that survives right up until somebody types one of them differently.
// Somebody did. js/pages/houses.js read "pawa.houseFavs" — dots, camelCase —
// a key nothing in this repo has ever written. So the count it read was
// always 0, and the rule right below it ("each tile hides itself at zero
// rather than rendering a 0") then hid the Saved tile permanently. Save
// twenty houses and that page would never say so.
//
// Nothing caught it, because nothing could: the page renders, throws nothing,
// and a tile that is missing on purpose looks exactly like a tile that is
// missing by accident. A browser test would not have caught it either without
// seeding storage and knowing which tile to look for.
//
// What actually went wrong is that the key was written down five times. So
// this asserts the property directly, over the source: every favourites key
// in js/ is one of the two real ones. A sixth copy is fine; a sixth SPELLING
// fails here, by name, in milliseconds.
//
//   usage:  node tests/house_favs_key_test.mjs   (no server, no browser)
// ============================================================================
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JS = join(ROOT, "js");

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};
const section = (s) => process.stdout.write("\n" + s + "\n");

// The two real keys. The set of saved house ids, and the order they were
// saved in so the list can show the most recent first.
const SAVED = "pawa_house_favs";
const ORDER = "pawa_house_fav_order";
const ALLOWED = new Set([SAVED, ORDER]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

// Every localStorage access with a literal key, paired with the file and line
// it sits on, so a failure can name the line rather than the string.
const ACCESS = /localStorage\s*\.\s*(getItem|setItem|removeItem)\s*\(\s*["'`]([^"'`]+)["'`]/g;
const hits = [];
for (const file of walk(JS)) {
  const src = readFileSync(file, "utf8");
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    ACCESS.lastIndex = 0;
    let m;
    while ((m = ACCESS.exec(lines[i])) !== null) {
      hits.push({ file: relative(ROOT, file).replace(/\\/g, "/"), line: i + 1, op: m[1], key: m[2] });
    }
  }
}

section("1. The scan found something to check");
{
  ok(hits.length > 0, `localStorage keys read across js/ (${hits.length})`);
  const favish = hits.filter((h) => /fav/i.test(h.key));
  ok(favish.length > 0, `and some of them are about favourites (${favish.length})`);
}

section("2. Every favourites key is one of the two real ones");
{
  // "About favourites" is decided by the key text, not by a list of files, so
  // a new page inventing "myFavs" is caught the same as a misspelling of an
  // existing one.
  const favish = hits.filter((h) => /fav/i.test(h.key));
  const strays = favish.filter((h) => !ALLOWED.has(h.key));
  ok(strays.length === 0,
     "no file spells the favourites key its own way",
     strays.map((s) => `${s.file}:${s.line}  ${s.op}("${s.key}")`).join("\n        "));

  // The specific shape that caused this: a dot or a capital letter in a key
  // whose siblings are all snake_case. Worth calling out separately, because
  // the message is the fix.
  const dotted = favish.filter((h) => /[.A-Z]/.test(h.key));
  ok(dotted.length === 0,
     `the key is snake_case, not dotted or camelCase (${SAVED}, not pawa.houseFavs)`,
     dotted.map((s) => `${s.file}:${s.line}  "${s.key}"`).join("\n        "));
}

section("3. What is read is also written, and the other way round");
{
  const favish = hits.filter((h) => ALLOWED.has(h.key));
  for (const key of [SAVED, ORDER]) {
    const mine = favish.filter((h) => h.key === key);
    const readers = mine.filter((h) => h.op === "getItem");
    const writers = mine.filter((h) => h.op === "setItem");
    // A key with readers and no writers is exactly the bug this file is
    // named after: the read succeeds, returns nothing, and the feature
    // quietly reports empty forever.
    ok(writers.length > 0,
       `"${key}" is written by something (${writers.length})`,
       readers.map((r) => `only read, at ${r.file}:${r.line}`).join("\n        "));
    ok(readers.length > 0, `"${key}" is read by something (${readers.length})`);
  }
}

section("4. The page that counts saved houses reads the right key");
{
  // The regression itself, pinned to the file it happened in, so the fix
  // cannot be reverted quietly.
  const houses = hits.filter((h) => h.file === "js/pages/houses.js" && /fav/i.test(h.key));
  ok(houses.length > 0, "js/pages/houses.js still reads a favourites key",
     "if this row moved, the Saved tile may have been dropped rather than fixed");
  ok(houses.every((h) => h.key === SAVED),
     `and it is "${SAVED}"`,
     houses.map((h) => `${h.file}:${h.line}  "${h.key}"`).join("\n        "));
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
