// ============================================================================
// commute_score_test.mjs — the "match to my life" ranking maths, driven directly.
//
// This is the part of the feature that decides which home a person sees first,
// and it is invisible: a wrong weight or a swallowed unknown does not throw, it
// just quietly puts the wrong house at the top. So every test here is written
// as a CLAIM THE OLD MATHS GOT WRONG, and would fail against it:
//
//   · a workplace and a café counted the same
//   · 5+55 ranked level with 30+30
//   · a 700 m daladala ride cost 2.6 minutes
//   · a leg still measuring, or one no router could solve, cost NOTHING —
//     so the home we knew least about floated to the top
//
//   usage:  node tests/commute_score_test.mjs      (no server, no browser)
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The lib is a browser IIFE that hangs itself on the global.
const sandbox = { console, window: {} };
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, "js/lib/commute-score.js"), "utf8"), sandbox);
const C = sandbox.window.pawaCommute;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;

// A leg the scorer will accept. `km` is REAL road km — the only kind it scores.
const leg = (km, mode, extra = {}) => ({
  state: "road", km, place: { mode, kind: "custom", ...extra },
});

process.stdout.write("\n1. A trip costs more than distance / speed\n");
{
  // 700 m by daladala. Pure km/h says 2.6 min. You wait for the daladala.
  const m = C.travelMin(0.7, "daladala");
  ok(m > 8, `a 700 m daladala ride is not 2.6 minutes (${m.toFixed(1)} min)`);
  ok(near(m, 8 + (0.7 / 16) * 60), "it is the wait plus the moving part");

  // and that is what lets walking win at short range, as it should
  ok(C.travelMin(0.7, "walk") < C.travelMin(0.7, "daladala"),
     "walking beats waiting for a daladala over 700 m");
  ok(C.travelMin(8, "daladala") < C.travelMin(8, "walk"),
     "and the daladala wins again over 8 km");
  ok(C.travelMin(-1, "car") === null && C.travelMin(NaN, "car") === null,
     "a nonsense distance scores nothing rather than something");
}

process.stdout.write("\n2. How often you go is the point\n");
{
  // Same two journeys, opposite lives. Home A is close to the workplace and far
  // from the café; home B is the other way round. The old sum called these
  // identical. A person going to work five times a week does not.
  const near5  = C.score([leg(4, "car", { kind: "work" }), leg(20, "car", { kind: "fav" })]);
  const far5   = C.score([leg(20, "car", { kind: "work" }), leg(4, "car", { kind: "fav" })]);
  ok(near5.score < far5.score,
     "being close to the place you go 5x a week beats being close to the one you go once",
     `near-work ${near5.score.toFixed(1)} vs far-work ${far5.score.toFixed(1)}`);

  const sum = (l) => l.reduce((s, x) => s + C.travelMin(x.km, x.place.mode), 0);
  ok(near(sum([leg(4, "car"), leg(20, "car")]), sum([leg(20, "car"), leg(4, "car")])),
     "…and the plain sum genuinely cannot tell them apart, which is why this matters");

  ok(C.tripsFor({ kind: "work" }) > C.tripsFor({ kind: "fav" }),
     "a workplace outweighs a favourite spot by default");
  ok(C.tripsFor({ kind: "fav", perWeek: 6 }) === 6,
     "and the person can overrule the default");
  ok(C.tripsFor({ kind: "work", perWeek: 0 }) >= 1 && C.tripsFor({ kind: "work", perWeek: 999 }) <= 21,
     "a nonsense frequency is clamped, never allowed to delete or dominate a place");
  ok(C.tripsFor({ kind: "nonsense-kind" }) >= 1,
     "an unknown kind still gets a usable weight");
}

process.stdout.write("\n3. One brutal trip is not averaged away\n");
{
  const balanced = C.score([leg(10, "car", { perWeek: 3 }), leg(10, "car", { perWeek: 3 })]);
  const lopsided = C.score([leg(1.5, "car", { perWeek: 3 }), leg(18.5, "car", { perWeek: 3 })]);
  ok(near(balanced.weekMin, lopsided.weekMin, 1.0),
     "two homes with the same total time on the road each week",
     `${balanced.weekMin.toFixed(1)} vs ${lopsided.weekMin.toFixed(1)}`);
  ok(balanced.score < lopsided.score,
     "the balanced one ranks first — the old sum called them equal",
     `balanced ${balanced.score.toFixed(1)} vs lopsided ${lopsided.score.toFixed(1)}`);
  ok(lopsided.worstMin > balanced.worstMin, "and the worst single trip is what separates them");
}

process.stdout.write("\n4. Nothing unknown is priced at zero\n");
{
  const known   = C.score([leg(6, "car"), leg(6, "car")]);
  const partial = C.score([leg(2, "car"), { state: "measuring", place: { mode: "car", kind: "work" } }]);
  const noroute = C.score([leg(2, "car"), { state: "noroad",    place: { mode: "car", kind: "work" } }]);

  ok(partial.tier > known.tier,
     "a home still measuring ranks below one fully measured, however good its known leg looks");
  ok(noroute.tier > partial.tier,
     "and a leg no router could solve ranks below one still being measured");
  ok(C.compare(known, partial) < 0 && C.compare(partial, noroute) < 0,
     "the comparator orders them that way too");

  // The specific old bug: a partial sum beating a complete one.
  ok(C.compare(known, partial) < 0,
     "a 2 km measured leg does NOT outrank two measured 6 km legs by being incomplete",
     `known score ${known.score.toFixed(1)} tier ${known.tier} · partial score ${partial.score.toFixed(1)} tier ${partial.tier}`);

  const nothing = C.score([]);
  ok(nothing.score === Infinity && nothing.tier === C.TIER.UNSCORED,
     "a home with no legs at all is unscored, not perfect");
  ok(C.score([{ state: "measuring", place: { mode: "car" } }]).tier === C.TIER.MEASURING,
     "a home with only unmeasured legs is 'measuring', not zero minutes");
}

process.stdout.write("\n5. The max-time gate\n");
{
  const under = C.score([leg(5, "car", { maxMin: 60 })]);
  const over  = C.score([leg(60, "car", { maxMin: 30 })]);
  ok(under.pass === true, "a trip inside the limit passes");
  ok(over.pass === false, "a trip past it does not");
  ok(C.score([{ state: "noroad", place: { mode: "car", maxMin: 5 } }]).pass === true,
     "but a leg we could not route is never failed on a number we do not have");
}

process.stdout.write("\n6. The number shown to a person\n");
{
  // 5 visits a week to a 24-minute-away workplace = 5 x 2 x 24 = 240 min.
  const s = C.score([{ state: "road", km: 8.23, place: { mode: "car", kind: "work", perWeek: 5 } }]);
  const oneWay = C.travelMin(8.23, "car");
  ok(near(s.weekMin, oneWay * 5 * 2, 0.1),
     "a week counts both directions, every visit", `${s.weekMin.toFixed(1)} min`);
  ok(near(s.meanMin, oneWay), "a single place's typical trip is just that trip");
  ok(s.weekMin > s.score, "the weekly figure is the human one; the score is the ranking one");
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
