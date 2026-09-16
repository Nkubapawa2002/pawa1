// ============================================================================
// run.mjs — run the suites, and tell the truth about which ones failed.
//
// WHY THIS EXISTS.
//
// `npm test` printed "Error: no test specified" while 100+ suites sat in this
// folder, so the only way to run them was to remember their names. That is
// survivable by hand and not survivable unattended.
//
// The harder problem is that puppeteer flakes on this host. Not rarely: three
// suites in one sweep of twenty-three died with "Navigation timeout of 30000ms
// exceeded" on pages that load in 50ms, at DIFFERENT lines each run, and all
// three passed on a straight retry. The skill file already says to retry
// rather than debug the profile. But a sweep that reports three failures when
// the code is fine is worse than no sweep: it trains you to ignore red, and
// the one real failure in the next run goes with it.
//
// So this runner draws the line that matters:
//
//   CRASHED   the process died without printing a summary line. That is the
//             harness, not the code. Retried, up to RETRIES times.
//   FAILED    it printed "N passed, M failed" with M > 0. That is the code
//             talking. Never retried -- a real failure that passes on the
//             second roll is a flaky TEST, and hiding it is how it stays.
//
// A suite that only passes on retry is reported as FLAKY so it stays visible
// rather than being laundered into a green tick.
//
// A SWEEP IS HARSHER THAN A SINGLE RUN, and the browser-heavy suites feel it.
// Running all 76 in a row leaves the browser and this host under enough
// pressure that puppeteer starts losing its own intercepted requests --
// house_commute_place_test says so out loud, "STARVED geocoder call:
// net::ERR_ABORTED".
//
// SIX SUITES ARE KNOWN TO DO THIS, and all six are green on their own:
//
//   pchat_life_test           53/53 alone
//   house_commute_place_test  16/16 alone
//   basemap_chain_test        26/26 alone, crashed on all 3 attempts in a sweep
//   login_page_test           90/90 alone, four runs, one of them with three
//                             other map suites running concurrently
//   owner_pages_test          ten navigations in one browser; seen fail 4 times
//                             in a row and then pass 2 of 3 on a quiet machine,
//                             which is what finally identified it. Navigation
//                             timeouts at a DIFFERENT line each time
//   jobs_page_test            59/59 alone, 23 of 59 in a sweep. All 23 cascade
//                             from ONE: the pay field is empty at submit, so
//                             nothing posts and everything after it follows.
//                             GPS and reverse-geocode heavy, same family
//
// If one of these is red in a sweep, RUN IT ALONE BEFORE BELIEVING IT -- and
// RUN IT MORE THAN ONCE. That is not a shrug: two of them were carried as
// "genuinely failing" for a while, and owner_pages_test failed four consecutive
// runs while a change was in the tree, passed twice with that change stashed,
// and then passed 2 of 3 with the change back in place. Four reds in a row is
// not proof of causation on this host. The tell is that the timeout lands on a
// DIFFERENT navigation each run, and that reverting the only file the failing
// page even loads changes nothing.
//
// A suite that printed a tally is reported as FAILED and never retried, and
// that is deliberate: a tally is the code speaking, and rolling again until it
// says something nicer is how a real failure hides. A CRASH is the host
// speaking, so that is retried -- after a backoff, for the reason given at the
// retry loop itself.
//
//   usage:  node server.js     then, in another shell:
//           node tests/run.mjs                 every offline suite
//           node tests/run.mjs pm_ p_message   only suites matching these
//           node tests/run.mjs --db            include the 16 that hit PROD
//           node tests/run.mjs --list          names only, run nothing
//           node tests/run.mjs --retries=0     no retries, for diagnosing
// ============================================================================
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const LIST = flag("--list");
const WITH_DB = flag("--db");
const RETRIES = (() => {
  const a = argv.find((x) => x.startsWith("--retries="));
  return a ? Math.max(0, parseInt(a.split("=")[1], 10) || 0) : 2;
})();
const filters = argv.filter((a) => !a.startsWith("--"));

// The gates that are not named *_test.mjs. Everything else in this folder that
// does not end _test.mjs is a screenshot helper or a one-off probe, and an
// underscore prefix marks those anyway.
const EXTRA = ["i18n_coverage.mjs", "theme_light_check.mjs"];

// Suites that talk to the PRODUCTION database. They prefix every row pmtest_
// and roll back, but they need PERSONAL_ACCESS_TOKEN and they are not offline,
// so they are opt-in rather than part of a default sweep.
function hitsProd(file) {
  try {
    return /scripts\/db\/sql\.mjs|scripts\/db/.test(readFileSync(join(HERE, file), "utf8"));
  } catch (_) { return false; }
}

const all = readdirSync(HERE)
  .filter((f) => f.endsWith(".mjs"))
  .filter((f) => !f.startsWith("_"))
  .filter((f) => f.endsWith("_test.mjs") || EXTRA.includes(f))
  .sort();

const chosen = all
  .filter((f) => (WITH_DB ? true : !hitsProd(f)))
  .filter((f) => !filters.length || filters.some((q) => f.includes(q)));

if (!chosen.length) {
  process.stdout.write(`No suite matches ${JSON.stringify(filters)}.\n`);
  process.exit(2);
}
if (LIST) {
  chosen.forEach((f) => process.stdout.write(`  ${f}${hitsProd(f) ? "   [prod db]" : ""}\n`));
  process.stdout.write(`\n${chosen.length} suites\n`);
  process.exit(0);
}

const SUMMARY = /(\d+) passed, (\d+) failed/;

function runOnce(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, file)], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => {
      // The LAST summary line: a suite that prints a per-section tally would
      // otherwise be read by its first one.
      const lines = out.split(/\r?\n/).filter((l) => SUMMARY.test(l));
      const m = lines.length ? lines[lines.length - 1].match(SUMMARY) : null;
      resolve({
        code,
        out,
        passed: m ? +m[1] : 0,
        failed: m ? +m[2] : 0,
        summarised: !!m,
      });
    });
    child.on("error", () => resolve({ code: -1, out, passed: 0, failed: 0, summarised: false }));
  });
}

// Between suites, and multiplied for a retry. Small enough that 76 suites pay
// under twenty seconds for it in total, long enough that the sockets from the
// browser that just exited are on their way out before the next one launches.
const COOLDOWN_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t0 = Date.now();
process.stdout.write(`\nRunning ${chosen.length} suites` +
  (WITH_DB ? " (including the ones that hit production)" : "") +
  (RETRIES ? `, retrying a crash up to ${RETRIES}×` : ", no retries") + "\n\n");

const results = [];
for (const file of chosen) {
  const name = file.replace(/\.mjs$/, "");
  process.stdout.write(`  ${name.padEnd(34)} `);
  if (results.length) await sleep(COOLDOWN_MS);
  let r = await runOnce(file);
  let attempts = 1;

  // NOT EVERY SUITE PRINTS A TALLY. theme_light_check ends "All pages flipped
  // to a readable light theme ✔", truck_match_test ends "all good", and
  // i18n_coverage ends with its own PASS line against a baseline. Treating a
  // missing summary as a crash reported three passing suites as CRASHED and
  // retried each of them twice for nothing -- and, far worse, it meant the
  // exit code was being ignored, so a suite that died silently with code 0
  // would have looked the same as one that failed loudly.
  //
  // So the EXIT CODE is the authority and the tally is extra detail. A crash
  // is a non-zero exit with no tally to explain it.
  const crashed = (x) => !x.summarised && x.code !== 0;

  // Retry ONLY a crash. A suite that printed a tally has spoken, and rolling
  // the dice again until it says something nicer is how a real failure gets
  // laundered into a green tick.
  //
  // WITH A BACKOFF, and that is the point of it rather than politeness.
  // A crash here is the HOST, not the code, and the host is exhausted in a way
  // that takes seconds to drain: puppeteer starves its own intercepted
  // requests, and Windows is sitting on a few thousand localhost sockets in
  // TIME_WAIT from the browser launches so far. Retrying 200ms later asks the
  // same exhausted machine the same question and gets the same answer.
  //
  // Measured, not assumed: basemap_chain_test crashed on all three attempts
  // inside a sweep and passes 26/26 on its own, and login_page_test does the
  // same at 90/90. Neither leaks a browser -- there are zero chrome processes
  // between suites -- so there is nothing to reap, only time to give back.
  while (crashed(r) && attempts <= RETRIES) {
    const backoff = COOLDOWN_MS * attempts * 4;
    process.stdout.write(`crash, waiting ${(backoff / 1000).toFixed(0)}s… `);
    await sleep(backoff);
    r = await runOnce(file);
    attempts++;
  }

  const status = crashed(r) ? "CRASHED"
    : r.failed > 0 ? "FAILED"
    : r.code !== 0 ? "FAILED"
    : attempts > 1 ? "FLAKY"
    : "ok";
  results.push({ name, file, status, attempts, ...r });

  // A suite that reports in its own words has no count to show, so say so
  // rather than printing a confident "ok 0".
  if (status === "ok")      process.stdout.write(r.summarised ? `ok    ${r.passed}\n` : "ok    (no tally)\n");
  else if (status === "FLAKY")  process.stdout.write(`FLAKY ${r.passed} (passed on attempt ${attempts})\n`);
  else if (status === "FAILED") process.stdout.write(
    r.summarised ? `FAIL  ${r.failed} of ${r.passed + r.failed}\n` : `FAIL  (exit ${r.code})\n`);
  else                          process.stdout.write(`CRASH after ${attempts} attempt(s)\n`);
}

const failed = results.filter((r) => r.status === "FAILED");
const crashed = results.filter((r) => r.status === "CRASHED");
const flaky = results.filter((r) => r.status === "FLAKY");
const secs = ((Date.now() - t0) / 1000).toFixed(0);

process.stdout.write(`\n${"-".repeat(64)}\n`);
process.stdout.write(
  `${results.length - failed.length - crashed.length} of ${results.length} suites green ` +
  `· ${results.reduce((n, r) => n + r.passed, 0)} assertions · ${secs}s\n`);

if (flaky.length) {
  process.stdout.write(`\nFLAKY (passed, but only after a crash and a retry):\n`);
  flaky.forEach((r) => process.stdout.write(`  ${r.name}\n`));
}

for (const r of failed.concat(crashed)) {
  process.stdout.write(`\n${"=".repeat(64)}\n${r.status}  ${r.name}\n${"=".repeat(64)}\n`);
  const lines = r.out.split(/\r?\n/);
  // For a failure, the FAIL lines and what they printed underneath. For a
  // crash, the tail, which is where the stack is.
  const shown = r.status === "FAILED"
    ? lines.filter((l, i) => /^\s+FAIL/.test(l) || /^\s{8}\S/.test(l) && /^\s+FAIL/.test(lines[i - 1] || ""))
    : lines.slice(-14);
  process.stdout.write(shown.join("\n").trim() + "\n");
}

process.stdout.write("\n");
process.exit(failed.length || crashed.length ? 1 : 0);
