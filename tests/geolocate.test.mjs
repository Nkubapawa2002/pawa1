// ============================================================================
//  geolocate.test.mjs — behavioural tests for js/geolocate.js
//
//  Runs the real helper in a real browser against a FAKE navigator.geolocation
//  so we can reproduce the phone conditions that were breaking "use my
//  location" — a slow cold GPS lock, a coarse-then-precise sequence, and an
//  outright denial — without needing a phone.
//
//    node tests/geolocate.test.mjs
// ============================================================================
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer";

const ROOT = resolve(import.meta.dirname, "..");
// GEO_SRC lets the suite be pointed at another copy of the helper — used to
// verify these tests actually fail against the pre-fix version.
const SOURCE = readFileSync(process.env.GEO_SRC || join(ROOT, "js", "geolocate.js"), "utf8");

const results = [];
const record = (name, passed, detail = "") => {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/**
 * Installs a fake geolocation whose fixes arrive on a script, then runs the
 * helper against it. `script` entries are { afterMs, accuracy } or
 * { afterMs, errorCode }.
 */
const runScenario = async (page, { script, options = {}, virtualTimeout = 40000 }) => {
  return page.evaluate(
    async (source, script, options, virtualTimeout) => {
      // --- fake geolocation ------------------------------------------------
      // Models a real device: `script` is a TIMELINE of events measured from
      // the moment the helper starts. Each event is delivered to whichever
      // listener is registered when it fires — the one-shot, the watch, or
      // both. This matters because a fix that lands after getCurrentPosition
      // has already timed out must still reach the watch, which is exactly the
      // cold-GPS-lock case that was breaking on phones.
      const timers = [];
      let oneShot = null;   // { cb, errCb } while getCurrentPosition is pending
      let watcher = null;   // { cb, errCb } while a watch is active

      const makePosition = (accuracy) => ({
        coords: { latitude: -6.79, longitude: 39.28, accuracy,
                  heading: null, speed: null },
        timestamp: Date.now(),
      });

      for (const entry of script) {
        timers.push(setTimeout(() => {
          if (entry.errorCode) {
            // Device-level errors go to whoever is listening.
            if (oneShot) { const l = oneShot; oneShot = null; l.errCb?.({ code: entry.errorCode, message: "fake" }); }
            else watcher?.errCb?.({ code: entry.errorCode, message: "fake" });
            return;
          }
          const pos = makePosition(entry.accuracy);
          if (oneShot) { const l = oneShot; oneShot = null; l.cb?.(pos); }
          watcher?.cb?.(pos);
        }, entry.afterMs));
      }

      let nextWatchId = 1;
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: {
          getCurrentPosition(cb, errCb, opts) {
            oneShot = { cb, errCb };
            const limit = opts?.timeout;
            if (limit != null && isFinite(limit)) {
              timers.push(setTimeout(() => {
                if (!oneShot) return;             // already satisfied
                const l = oneShot; oneShot = null;
                l.errCb?.({ code: 3, message: "timeout" });
              }, limit));
            }
          },
          watchPosition(cb, errCb) {
            watcher = { cb, errCb };
            return nextWatchId++;
          },
          clearWatch() { watcher = null; for (const t of timers) clearTimeout(t); },
        },
      });

      // permissions.query must not short-circuit the denied path in tests
      Object.defineProperty(navigator, "permissions", {
        configurable: true,
        value: { query: async () => ({ state: "prompt" }) },
      });

      // --- load the helper fresh -------------------------------------------
      delete window.pawaLocate;
      // eslint-disable-next-line no-eval
      (0, eval)(source);

      const started = Date.now();
      try {
        const fix = await Promise.race([
          window.pawaLocate.best(options),
          new Promise((_, rej) => setTimeout(() => rej(new Error("harness timeout")), virtualTimeout)),
        ]);
        return { ok: true, fix, elapsed: Date.now() - started };
      } catch (e) {
        return { ok: false, error: { code: e?.code, message: e?.message }, elapsed: Date.now() - started };
      }
    },
    SOURCE, script, options, virtualTimeout
  );
};

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.goto("about:blank");

console.log("\n=== geolocate.js behaviour ===\n");

// 1. THE PHONE BUG: cold GPS lock takes 12s. Deliberately uses the DEFAULT
//    maxWaitMs — the old 8s default was the bug, so overriding it here would
//    hide the very regression this test exists to catch.
{
  const r = await runScenario(page, {
    script: [{ afterMs: 12000, accuracy: 20 }],
    options: {},
  });
  record(
    "slow cold GPS lock (12s) resolves instead of timing out",
    r.ok && r.fix?.accuracy === 20,
    r.ok ? `got ${r.fix.accuracy}m in ~${Math.round(r.elapsed / 1000)}s` : `error ${r.error?.code}`
  );
}

// 2. A cached coarse fix must arrive fast, then be tightened by the watch.
{
  const r = await runScenario(page, {
    script: [
      { afterMs: 200, accuracy: 1200 },   // cached, coarse
      { afterMs: 3000, accuracy: 18 },    // GPS locks on
    ],
    options: { maxWaitMs: 25000, targetAccuracy: 25 },
  });
  record(
    "coarse cached fix is tightened to precise GPS",
    r.ok && r.fix?.accuracy === 18,
    r.ok ? `settled at ${r.fix.accuracy}m` : `error ${r.error?.code}`
  );
}

// 3. A first-shot TIMEOUT must not be fatal — the watch should still deliver.
{
  const r = await runScenario(page, {
    script: [
      { afterMs: 100, errorCode: 3 },     // first shot times out
      { afterMs: 2500, accuracy: 15 },    // watch succeeds shortly after
    ],
    options: { maxWaitMs: 20000 },
  });
  record(
    "first-shot timeout still recovers via the watch",
    r.ok && r.fix?.accuracy === 15,
    r.ok ? `recovered at ${r.fix.accuracy}m` : `error ${r.error?.code}`
  );
}

// 4. A DENIAL must fail fast — waiting cannot help.
{
  const r = await runScenario(page, {
    script: [{ afterMs: 50, errorCode: 1 }],
    options: { maxWaitMs: 25000 },
  });
  record(
    "permission denial fails fast (does not wait out the cap)",
    !r.ok && r.error?.code === "denied" && r.elapsed < 3000,
    `code=${r.error?.code} in ${r.elapsed}ms`
  );
}

// 5. Nothing ever arrives -> a timeout error, bounded by maxWaitMs.
{
  const r = await runScenario(page, {
    script: [{ afterMs: 999999, accuracy: 10 }],
    options: { maxWaitMs: 3000 },
  });
  record(
    "no fix at all times out at the cap",
    !r.ok && r.error?.code === "timeout",
    `code=${r.error?.code} in ${r.elapsed}ms`
  );
}

await browser.close();

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("\nFAILED:");
  for (const f of failed) console.log(`  · ${f.name} — ${f.detail}`);
  process.exit(1);
}
