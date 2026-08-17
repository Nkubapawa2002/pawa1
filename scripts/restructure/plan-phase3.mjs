// ============================================================================
//  plan-phase3.mjs — generate the Phase 3 move plan for js/.
//
//  Buckets come from scripts/audit/ownership.mjs, which measures how many pages
//  actually load each file — including scripts injected at runtime by other
//  scripts, not just <script src> in HTML.
//
//    core/         loaded by nearly every page, or injected by something that is
//    lib/          shared by several pages but not universal
//    pages/        exactly one page's controller
//    _quarantine/  loaded by nothing at all; Phase 4 decides delete or restore
//
//    node scripts/restructure/plan-phase3.mjs
//    node scripts/restructure/move.mjs scripts/restructure/phase3.plan.json
// ============================================================================
import { readdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, extname } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

const CORE = new Set([
  "app-shell.js", "auth.js", "config.js", "data.js", "i18n.js",
  "nav.js", "premium.js", "sw-register.js", "theme.js",
  // Injected at runtime by config.js, so they travel with it.
  "analytics.js", "auth-clerk.js",
]);

const LIB = new Set([
  "agent-demand-board.js", "agent-profile.js", "ai-search.js", "ai.js",
  "area-boundary.js", "auth-ui.js", "find-mode.js", "fx.js",
  "geo-poly.js", "geo.js", "geolocate.js", "map-expand.js",
  "request-place.js", "tz-places.js",
]);

const QUARANTINE = new Set(["fab.js", "mobile-nav.js"]);

// house-match.js fetches this by a document-relative URL, so it must travel
// with its loader or the string in that file stops resolving.
const COMPANIONS = { "house-match.js": "house-match.wasm" };

const tracked = new Set(
  execFileSync("git", ["ls-files", "js"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").map((s) => s.trim()).filter(Boolean)
);

const bucketFor = (name) => {
  if (CORE.has(name)) return "core";
  if (LIB.has(name)) return "lib";
  if (QUARANTINE.has(name)) return "_quarantine";
  return "pages";
};

const moves = [];
const skipped = [];

for (const name of readdirSync(join(ROOT, "js")).sort()) {
  if (extname(name) !== ".js") continue;
  const from = `js/${name}`;

  // Untracked files (js/config.local.js is gitignored) cannot be git mv'd, and
  // moving them would break the page that loads them with no way to verify.
  if (!tracked.has(from)) { skipped.push(`${from}  (untracked / gitignored)`); continue; }

  const bucket = bucketFor(name);
  moves.push({ from, to: `js/${bucket}/${name}` });

  const companion = COMPANIONS[name];
  if (companion && existsSync(join(ROOT, "js", companion))) {
    moves.push({ from: `js/${companion}`, to: `js/${bucket}/${companion}` });
  }
}

const byTarget = {};
for (const m of moves) {
  const dir = m.to.split("/").slice(0, -1).join("/");
  (byTarget[dir] ||= []).push(m.from.split("/").pop());
}

console.log("=== Phase 3 plan (js/) ===\n");
for (const [dir, list] of Object.entries(byTarget).sort()) {
  console.log(`  ${dir.padEnd(18)} ${String(list.length).padStart(3)}`);
  console.log(`      ${list.join(", ")}\n`);
}
console.log(`  total moves: ${moves.length}`);
if (skipped.length) {
  console.log(`\n  LEFT IN PLACE — ${skipped.length}:`);
  for (const s of skipped) console.log(`      ${s}`);
}

const out = join(ROOT, "scripts", "restructure", "phase3.plan.json");
writeFileSync(out, JSON.stringify({ moves }, null, 2));
console.log(`\nwrote scripts/restructure/phase3.plan.json`);
