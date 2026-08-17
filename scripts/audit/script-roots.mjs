// ============================================================================
//  script-roots.mjs — catch scripts that can no longer find the repo root.
//
//  Node scripts locate the repo root by walking up from their own directory:
//
//      const ROOT = join(__dir, "..");                    // scripts/x.mjs
//      const ROOT = resolve(import.meta.dirname, "..", ".."); // scripts/a/x.mjs
//
//  The number of ".." segments is therefore tied to how deep the file sits.
//  Moving a script one directory deeper silently invalidates it: the path still
//  resolves, just to the wrong place, so the script fails at runtime with a
//  confusing "file not found" rather than anything pointing at the real cause.
//
//  Phase 2 of the restructure did exactly this to 13 scripts. This check exists
//  so it cannot happen again unnoticed.
//
//  Read-only.  node scripts/audit/script-roots.mjs
// ============================================================================
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

// A line that derives a base directory from the script's own location.
// Captures the ".." run so its length can be compared with the file's depth.
const ROOT_ASSIGN =
  /(?:__dir|__dirname|import\.meta\.dirname)\s*,\s*((?:["']\.\.["']\s*,?\s*)+)/g;

const files = execFileSync("git", ["ls-files", "scripts"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").map((s) => s.trim())
  .filter((s) => s && /\.(mjs|js)$/.test(s));

const findings = [];

for (const file of files) {
  const full = join(ROOT, file);
  if (!existsSync(full)) continue;

  // Depth of the file's directory below the repo root: scripts/x.mjs -> 1,
  // scripts/build/x.mjs -> 2.
  const depth = dirname(file).split("/").filter(Boolean).length;
  const src = readFileSync(full, "utf8");

  for (const match of src.matchAll(ROOT_ASSIGN)) {
    const dots = (match[1].match(/\.\./g) || []).length;
    // Fewer ".." than the file is deep means it lands inside scripts/ rather
    // than at the repo root. More would overshoot above the repo.
    if (dots !== depth) {
      const line = src.slice(0, match.index).split("\n").length;
      findings.push({ file, line, dots, depth, snippet: match[0].replace(/\s+/g, " ") });
    }
  }
}

console.log(`=== SCRIPT ROOT RESOLUTION (${files.length} scripts) ===\n`);
if (!findings.length) {
  console.log("  all scripts resolve the repo root correctly");
} else {
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}`);
    console.log(`      uses ${f.dots} x ".." but sits ${f.depth} level(s) deep -> resolves too ${f.dots < f.depth ? "shallow" : "high"}`);
    console.log(`      ${f.snippet}`);
  }
}
console.log(`\n  mismatches: ${findings.length}`);
process.exit(findings.length ? 1 : 0);
