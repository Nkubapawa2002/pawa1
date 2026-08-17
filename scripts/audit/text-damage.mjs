// ============================================================================
//  text-damage.mjs — find user-visible text corrupted by the emoji/dash strip.
//
//  The uncommitted working tree mixes an intentional rebrand with a find/replace
//  that removed em-dashes and emoji WITHOUT leaving the surrounding space. That
//  fuses neighbouring words ("the place — a region" -> "the placea region") and
//  silently drops words.
//
//  Correctness note: lines cannot be compared by index, because deletions shift
//  every line number after them. This walks real `git diff -U0` hunks and pairs
//  removed lines with added lines INSIDE each hunk, then compares only the
//  visible prose — tags, attributes and CSS are ignored, since a rename there is
//  intentional refactoring rather than damage.
//
//  Read-only.  node scripts/audit/text-damage.mjs
// ============================================================================
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

const git = (...args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });

/** Visible prose only: drop tags, entities, CSS blocks, and code-ish tokens. */
const visibleText = (line) => {
  const withoutTags = line
    .replace(/<[^>]*>/g, " ")          // html tags and their attributes
    .replace(/&[a-z]+;/gi, " ")        // entities
    .replace(/\{[^}]*\}/g, " ")        // css declaration blocks
    .replace(/[.#][\w-]+\s*\{?/g, " ") // css selectors
    .replace(/[\w-]+\s*:\s*[^;]+;/g, " "); // css declarations
  return withoutTags.replace(/\s+/g, " ").trim();
};

/** Words of two or more letters, ignoring code identifiers. */
const wordsOf = (text) =>
  (text.match(/[A-Za-zÀ-ɏ]{2,}/g) || []).filter((w) => !/^[a-z]+[A-Z]/.test(w));

const parseHunks = (diff) => {
  const hunks = [];
  let current = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      const m = /\+(\d+)/.exec(line);
      current = { newStart: m ? Number(m[1]) : 0, removed: [], added: [] };
      hunks.push(current);
    } else if (current && line.startsWith("-") && !line.startsWith("---")) {
      current.removed.push(line.slice(1));
    } else if (current && line.startsWith("+") && !line.startsWith("+++")) {
      current.added.push(line.slice(1));
    }
  }
  return hunks;
};

const files = git("diff", "--name-only", "--diff-filter=M")
  .split("\n").map((s) => s.trim())
  .filter((s) => s && /\.(html|js|md)$/.test(s));

const findings = [];

for (const file of files) {
  const diff = git("diff", "-U0", "--", file);
  for (const hunk of parseHunks(diff)) {
    // Only 1:1 replacements are safely comparable; anything else is a real
    // insertion or deletion, not a corrupted line.
    if (hunk.removed.length !== hunk.added.length) continue;

    for (let i = 0; i < hunk.removed.length; i++) {
      const before = visibleText(hunk.removed[i]);
      const after = visibleText(hunk.added[i]);
      if (!before || before === after) continue;

      const oldWords = wordsOf(before);
      const newWords = wordsOf(after);
      if (!oldWords.length) continue;

      const oldSet = new Set(oldWords.map((w) => w.toLowerCase()));
      const newSet = new Set(newWords.map((w) => w.toLowerCase()));
      const line = hunk.newStart + i;

      // FUSED: a new word that splits cleanly into two old words.
      let fused = false;
      for (const w of newWords) {
        const lw = w.toLowerCase();
        if (oldSet.has(lw)) continue;
        for (let cut = 2; cut < lw.length - 1; cut++) {
          if (oldSet.has(lw.slice(0, cut)) && oldSet.has(lw.slice(cut))) {
            findings.push({ kind: "FUSED", file, line,
              detail: `"${lw.slice(0, cut)} ${lw.slice(cut)}" became "${w}"` });
            fused = true;
            break;
          }
        }
        if (fused) break;
      }
      if (fused) continue;

      // DROPPED: visible words that vanished, excluding the deliberate rebrand.
      const REBRAND = /^(maisha|na|lifeza|pawa|pnzaki|bus|shipment|shipments)$/i;
      const gone = oldWords.filter((w) => !newSet.has(w.toLowerCase()) && !REBRAND.test(w));
      if (gone.length) {
        findings.push({ kind: "DROPPED", file, line, detail: `lost: ${gone.slice(0, 5).join(", ")}` });
      }
    }
  }
}

const byKind = {};
for (const f of findings) (byKind[f.kind] ||= []).push(f);

console.log(`=== VISIBLE-TEXT DAMAGE vs git HEAD (${files.length} modified files) ===\n`);
for (const kind of ["FUSED", "DROPPED"]) {
  const list = byKind[kind] || [];
  console.log(`--- ${kind} (${list.length}) ---`);
  for (const f of list.slice(0, 25)) console.log(`  ${f.file}:${f.line}  ${f.detail}`);
  if (list.length > 25) console.log(`  … and ${list.length - 25} more`);
  console.log();
}
console.log(`total: ${findings.length} across ${new Set(findings.map((f) => f.file)).size} file(s)`);
