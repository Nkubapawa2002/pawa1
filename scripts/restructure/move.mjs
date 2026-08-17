// ============================================================================
//  move.mjs — move files AND fix every reference to them, in one verifiable step.
//
//  Moving a file is the easy half. The half that breaks things is the paths
//  left behind in <script src>, in docs, in code comments, and — the dangerous
//  one — inside user-facing strings like:
//
//      alert("Run supabase/agent_billing_setup.sql in your Supabase editor")
//
//  A plain `git mv` leaves that message pointing at a file that no longer
//  exists. This tool rewrites every occurrence of each old path across all
//  tracked text files, so a move is complete by construction.
//
//  Usage:
//    node scripts/restructure/move.mjs <plan.json>          # dry run
//    node scripts/restructure/move.mjs <plan.json> --apply  # do it
//
//  A plan is { "moves": [ { "from": "...", "to": "..." }, ... ] }.
// ============================================================================
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const APPLY = process.argv.includes("--apply");
const planPath = process.argv[2];

if (!planPath) {
  console.error("usage: node scripts/restructure/move.mjs <plan.json> [--apply]");
  process.exit(1);
}

const git = (...args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });

const plan = JSON.parse(readFileSync(resolve(ROOT, planPath), "utf8"));
const moves = plan.moves.filter((m) => existsSync(join(ROOT, m.from)));
const missing = plan.moves.filter((m) => !existsSync(join(ROOT, m.from)));

// Files whose text may mention a moved path. Binary and vendor trees excluded.
const TEXT_EXT = /\.(js|mjs|ts|html|css|md|json|sql|yaml|yml|py|go|xml|txt)$/i;
const trackedText = git("ls-files")
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s && TEXT_EXT.test(s))
  .filter((s) => !s.startsWith("android/") && !s.startsWith("node_modules/"));

// Longest paths first so "supabase/agent_billing_setup.sql" is rewritten before
// a shorter path that happens to be its prefix.
const ordered = [...moves].sort((a, b) => b.from.length - a.from.length);

const edits = new Map();   // file -> { before, after, hits }
let totalHits = 0;

for (const file of trackedText) {
  const full = join(ROOT, file);
  if (!existsSync(full)) continue;
  const before = readFileSync(full, "utf8");
  let after = before;
  let hits = 0;

  for (const { from, to } of ordered) {
    if (!after.includes(from)) continue;
    hits += after.split(from).length - 1;
    after = after.split(from).join(to);
  }

  if (hits > 0) {
    edits.set(file, { before, after, hits });
    totalHits += hits;
  }
}

console.log(`=== restructure plan: ${planPath} ===`);
console.log(`  moves resolvable   ${moves.length}`);
if (missing.length) {
  console.log(`  moves SKIPPED      ${missing.length} (source missing)`);
  for (const m of missing.slice(0, 10)) console.log(`      ${m.from}`);
}
console.log(`  files referencing  ${edits.size}`);
console.log(`  references to fix  ${totalHits}`);

console.log(`\n--- reference updates ---`);
for (const [file, { hits }] of [...edits].sort((a, b) => b[1].hits - a[1].hits)) {
  console.log(`  ${String(hits).padStart(3)}  ${file}`);
}

if (!APPLY) {
  console.log(`\nDRY RUN — nothing changed. Re-run with --apply to perform the move.`);
  process.exit(0);
}

// 1. Move the files, preserving history.
const renamed = new Map(moves.map(({ from, to }) => [from, to]));
for (const { from, to } of moves) {
  const dest = join(ROOT, to);
  mkdirSync(dirname(dest), { recursive: true });
  git("mv", from, to);
}

// 2. Rewrite every reference. Edits were keyed by pre-move paths, so a file
//    that is BOTH moved and contains references must be written to its new
//    location — writing to the old path would resurrect a stray copy there.
for (const [file, { after }] of edits) {
  writeFileSync(join(ROOT, renamed.get(file) || file), after);
}

console.log(`\napplied: ${moves.length} moves, ${totalHits} references updated in ${edits.size} files.`);
console.log(`Now re-run the audits before committing:`);
console.log(`  node scripts/audit/structure.mjs`);
console.log(`  node scripts/audit/runtime.mjs`);
