// ============================================================================
//  apply_tokens.mjs — replace the literals check_tokens.mjs found, in ONE file,
//  using the checker's own line-and-literal output as the instruction list.
//
//  WHY IT IS DRIVEN BY THE CHECKER RATHER THAN BY SEARCH-AND-REPLACE.
//
//  Most of these literals are not raw hexes sitting alone. They are FALLBACKS:
//  `var(--n-surface,<hex>)`, a namespaced variable with a hardcoded default
//  behind it. And the same variable appears with DIFFERENT fallbacks in
//  different rules -- --n-border-strong is used with .12, .14 and .18, and
//  only .12 matches a brand token. A blanket replace would flatten three
//  distinct borders into one and change how the page looks.
//
//  So the only safe instruction is the checker's: this literal, on this line.
//  Everything else is left exactly as it is.
//
//  The replacement keeps the namespaced variable and swaps the literal for the
//  design token, so `var(--n-surface,<hex>)` becomes
//  `var(--n-surface,var(--surface))`. Nested var() fallbacks are valid CSS, the
//  page still prefers its own --n-* value where one is set, and a design-system
//  change now reaches the default.
//
//  BEFORE RUNNING IT ON A FILE, check that every page loading that file also
//  loads css/design-system.css. An undefined token does not fall back -- it
//  kills the whole declaration.
//
//    usage:  node scripts/design/apply_tokens.mjs js/lib/agent-profile.js
//            node scripts/design/apply_tokens.mjs js/lib/agent-profile.js --dry
// ============================================================================
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const target = process.argv[2];
const DRY = process.argv.includes("--dry");

if (!target) {
  console.error("usage: node scripts/design/apply_tokens.mjs <file> [--dry]");
  process.exit(2);
}

// Ask the checker, rather than re-implementing its matching.
const report = execFileSync(process.execPath,
  [join(ROOT, "scripts/design/check_tokens.mjs")],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

// The report is "  <file>  (n)" then indented "  <line>  <found>  ->  <suggest>".
const want = target.replace(/\//g, "\\");
const lines = report.split(/\r?\n/);
let inFile = false;
const jobs = [];
for (const line of lines) {
  const head = line.match(/^ {2}(\S.*?)\s+\(\d+\)\s*$/);
  if (head) { inFile = head[1] === want || head[1] === target; continue; }
  if (!inFile) continue;
  const hit = line.match(/^\s+(\d+)\s+(\S.*?)\s+->\s+(var\(--[a-z0-9-]+\))/);
  if (hit) jobs.push({ line: +hit[1], found: hit[2].trim(), suggest: hit[3] });
}

if (!jobs.length) {
  console.log(`No findings for ${target}. Nothing to do.`);
  process.exit(0);
}

const path = join(ROOT, target);
const src = readFileSync(path, "utf8");
const eol = src.includes("\r\n") ? "\r\n" : "\n";
const body = src.split(/\r?\n/);

// CSS HAS NO // COMMENT, and pretending it does is not harmless: `https://`
// inside a url() would swallow the rest of the line, and every declaration
// after it would look like prose. So the line-comment rule is only applied to
// the languages that have one.
function commentRanges(text, lineComments) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out.push([i, stop]);
      i = stop - 1;
    } else if (lineComments && text[i] === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      const stop = nl === -1 ? text.length : nl;
      out.push([i, stop]);
      i = stop - 1;
    }
  }
  return out;
}

// Is the match at this offset inside a comment?
//
// Ranges over the whole file rather than a per-line guess, and that is the
// whole reason it exists. The line that CLOSES a block comment still has prose
// on it BEFORE the closing marker, and css/theme-light.css has exactly that:
// a sentence quoting the colour it is about, with the marker at the end of the
// same line. A per-line test meets the closer, concludes it is looking at code,
// and rewrites the sentence into something that is not English.
function insideComment(ranges, offset) {
  return ranges.some(([a, b]) => offset >= a && offset < b);
}

// Computed once over the joined source, with \n separators matching the
// offset arithmetic below.
// The file as it was before any edit. Both the comment ranges and every
// offset are measured against this, so they stay true while `body` changes.
const original = body.slice();
const ranges = commentRanges(original.join("\n"), /\.(js|mjs|jsx)$/.test(target));

let done = 0;
const skipped = [];
for (const job of jobs) {
  const i = job.line - 1;
  if (i < 0 || i >= body.length) { skipped.push(`${job.line}: out of range`); continue; }
  if (!body[i].includes(job.found)) {
    // Lines shift only if something else edited the file mid-run; say so
    // rather than guessing at a nearby line.
    skipped.push(`${job.line}: "${job.found}" not on that line any more`);
    continue;
  }
  // NEVER REWRITE PROSE. The checker matches a colour wherever it appears,
  // including inside a comment, and css/theme-light.css explains its own
  // choices in sentences that quote the colours they are about. Five of its
  // nine findings are prose, not declarations, and rewriting those would
  // destroy the reasoning a future reader needs while changing nothing that
  // renders.
  //
  // Offsets come FROM THE SNAPSHOT, not from `body`. The loop rewrites `body`
  // as it goes and every replacement is longer than what it replaced, so an
  // offset measured against the live array drifts further with each edit. The
  // last job in theme-light.css was landing fifteen characters downstream of
  // itself, inside the following comment, and being skipped as prose when it
  // is a declaration.
  const before = original.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
  const col = original[i].indexOf(job.found);
  if (insideComment(ranges, before + col)) {
    skipped.push(`${job.line}: inside a comment, left alone`);
    continue;
  }
  body[i] = body[i].split(job.found).join(job.suggest);
  done++;
}

if (!DRY) writeFileSync(path, body.join(eol), "utf8");
console.log(`${DRY ? "[dry] " : ""}${target}: replaced ${done} of ${jobs.length}`);
skipped.forEach((s) => console.log("  skipped " + s));
