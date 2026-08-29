// ============================================================================
//  Service worker — the precache list, and the version that ships it
//
//  Two silent failures live here, and neither shows up in a browser you are
//  looking at:
//
//  1. cache.addAll() rejects the WHOLE batch if ONE url 404s. A single stale
//     path in APP_SHELL means the install fails, nothing is precached, and the
//     app simply has no offline mode. Nothing logs, nothing breaks on a good
//     connection, and you find out from a user on a bus.
//
//  2. The cache name is built from VERSION. Leave VERSION alone after changing
//     a precached file and every existing install keeps serving the copy it
//     took last time — for JS that is stale-while-revalidate, so the new code
//     does not run until the SECOND visit.
//
//  Static checks, no browser: this is about what the file says.
//
//  Usage: node tests/service_worker_test.mjs
// ============================================================================
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

let passed = 0;
const fails = [];
const ok = (cond, what, detail) => {
  if (cond) { passed++; console.log("  PASS  " + what); }
  else { fails.push(what); console.log("  FAIL  " + what); if (detail) console.log("        " + detail); }
};

const sw = readFileSync("service-worker.js", "utf8");
const block = sw.slice(sw.indexOf("const APP_SHELL"), sw.indexOf("];", sw.indexOf("const APP_SHELL")));
const paths = [...block.matchAll(/"\.\/([^"]*)"/g)].map((m) => m[1]).filter(Boolean);

console.log("\n1. Every precached path is a file that exists");
{
  const missing = paths.filter((p) => !existsSync(p));
  ok(paths.length > 20, `the list is populated (${paths.length} entries)`);
  ok(missing.length === 0,
     "and addAll() will not reject the batch on a path that moved", missing.join(", "));
  const dupes = [...new Set(paths.filter((p, i) => paths.indexOf(p) !== i))];
  ok(dupes.length === 0, "with nothing listed twice", dupes.join(", "));
}

console.log("\n2. The version moves when a precached file does");
{
  const version = (sw.match(/const VERSION = "([^"]+)"/) || [])[1] || "";
  ok(!!version, "VERSION is set", version);

  // Which precached files changed since the commit that last touched VERSION?
  // If any did and VERSION did not move with them, existing installs are
  // serving the old copies.
  let stale = [];
  try {
    // -G, not -S. -S counts how many times a string appears, and "const
    // VERSION" appears exactly once in every revision, so it finds the commit
    // that INTRODUCED the line rather than the last one to change its value.
    const lastBump = execSync(
      'git log -1 --format=%H -G"^const VERSION" -- service-worker.js',
      { encoding: "utf8" }).trim();
    if (lastBump) {
      const changed = execSync(`git diff --name-only ${lastBump} HEAD`, { encoding: "utf8" })
        .split("\n").map((s) => s.trim()).filter(Boolean)
        .map((s) => s.replace(/\\/g, "/"));
      const precached = new Set(paths);
      stale = changed.filter((f) => precached.has(f));
    }
  } catch (e) {
    console.log("        (no git history available; skipping the staleness check)");
  }
  ok(stale.length === 0,
     "no precached file has changed since VERSION was last bumped",
     stale.length ? stale.join(", ") + "  <- bump VERSION" : "");
}

console.log("\n3. What the pages load is what the worker keeps");
{
  // index.html is the page most likely to be opened with no signal, so the
  // scripts it names should be the scripts that survive offline.
  const idx = readFileSync("index.html", "utf8");
  const scripts = [...idx.matchAll(/<script src="(js\/[^"]+)"/g)].map((m) => m[1]);
  const precached = new Set(paths);
  const absent = scripts.filter((s) => !precached.has(s));
  ok(scripts.length > 5, `the homepage names its scripts (${scripts.length})`);
  // Not a hard failure: some are page-specific and deliberately left out. This
  // names them so the choice stays deliberate rather than forgotten.
  if (absent.length) console.log("        not precached: " + absent.join(", "));
  ok(precached.has("js/core/notify.js") && precached.has("js/lib/home-search.js"),
     "the notification and search code is among them");
}

console.log("\n" + passed + " passed, " + fails.length + " failed");
process.exit(fails.length ? 1 : 0);
