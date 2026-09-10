// ============================================================================
// listing_order_test.mjs — the fair queue, driven directly.
//
// The promise is "no owner is buried forever", and every way of breaking it is
// silent: the list still renders, it just has a permanent bottom again. So the
// assertions here are the PROPERTIES, not the output of one example:
//
//   · over a full cycle, every listing reaches the top exactly once
//   · at any turn, every listing occupies a different position
//   · the queue is first-in-first-out, so a listing that has waited longer is
//     ahead of one that has waited less
//   · the order is total, so two listings posted in the same second cannot
//     swap places between renders and make the list flicker
//   · it is the same for everyone in the same turn, which is what makes the
//     promise checkable by the owner
//   · and it never mutates the array it was handed
//
//   usage:  node tests/listing_order_test.mjs   (no server, no browser)
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { console, window: {}, Date };
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, "js/lib/listing-order.js"), "utf8"), sandbox);
const LO = sandbox.window.ListingOrder;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
// Five listings, A posted first and E last. A has waited longest.
const rows = ["A", "B", "C", "D", "E"].map((id, i) => ({
  id, created_at: new Date(T0 + i * DAY).toISOString(),
}));
const ids = (list) => list.map((r) => r.id).join("");

process.stdout.write("\n1. First in, first out\n");
{
  const q = LO.fairQueue(rows, { turn: 0 });
  ok(ids(q) === "ABCDE",
     "at the first turn the longest-waiting listing leads and the newest is last", ids(q));
  ok(q[0].id === "A", "which is the whole of 'first in, first out'");
}

process.stdout.write("\n2. The head of the queue advances, so there is no permanent bottom\n");
{
  ok(ids(LO.fairQueue(rows, { turn: 1 })) === "BCDEA",
     "one turn on, the second-longest leads and the one that led goes to the back",
     ids(LO.fairQueue(rows, { turn: 1 })));
  ok(ids(LO.fairQueue(rows, { turn: 2 })) === "CDEAB", "and again");
  ok(ids(LO.fairQueue(rows, { turn: 5 })) === "ABCDE",
     "and after a full cycle of five it is back where it started");
  ok(ids(LO.fairQueue(rows, { turn: 12 })) === "CDEAB",
     "the cycle keeps going past one lap");
}

process.stdout.write("\n3. Over a cycle every listing leads exactly once\n");
{
  const led = {};
  for (let t = 0; t < rows.length; t++) {
    const top = LO.fairQueue(rows, { turn: t })[0].id;
    led[top] = (led[top] || 0) + 1;
  }
  ok(Object.keys(led).length === 5, "all five reached the top", JSON.stringify(led));
  ok(Object.values(led).every((n) => n === 1),
     "each of them exactly once, which is the promise stated as arithmetic",
     JSON.stringify(led));

  // And nobody is ever stuck at the bottom either.
  const last = {};
  for (let t = 0; t < rows.length; t++) {
    const bottom = LO.fairQueue(rows, { turn: t }).slice(-1)[0].id;
    last[bottom] = (last[bottom] || 0) + 1;
  }
  ok(Object.values(last).every((n) => n === 1),
     "and each of them is last exactly once, so the bottom is not permanent either",
     JSON.stringify(last));
}

process.stdout.write("\n4. At any one turn, the positions are a permutation\n");
{
  let bad = null;
  for (let t = 0; t < 23; t++) {
    const q = LO.fairQueue(rows, { turn: t });
    const seen = new Set(q.map((r) => r.id));
    if (q.length !== rows.length || seen.size !== rows.length) { bad = t; break; }
  }
  ok(bad === null, "no listing is duplicated or dropped at any turn", "turn " + bad);
}

process.stdout.write("\n5. A total order, so the list cannot flicker\n");
{
  // Two posted in the same second. Without a tie-break the comparator is
  // unstable across engines and the pair can swap between renders.
  const same = [
    { id: "zzz", created_at: new Date(T0).toISOString() },
    { id: "aaa", created_at: new Date(T0).toISOString() },
    { id: "mmm", created_at: new Date(T0).toISOString() },
  ];
  const a = ids(LO.fairQueue(same, { turn: 0 }));
  const b = ids(LO.fairQueue(same.slice().reverse(), { turn: 0 }));
  ok(a === b, "the same set in a different input order comes out the same way", a + " vs " + b);
  ok(a === "aaammmzzz", "broken on id, which is stable and does not depend on the clock", a);
}

process.stdout.write("\n6. It is the same for everyone in the same turn\n");
{
  // Two "devices" ordering the same rows in the same turn. The rotation comes
  // from the clock, never from the viewer, which is what makes an owner able
  // to check the promise instead of taking it on trust.
  const one = ids(LO.fairQueue(rows, { turn: 7 }));
  const two = ids(LO.fairQueue(rows.slice().reverse(), { turn: 7 }));
  ok(one === two, "identical", one + " vs " + two);
}

process.stdout.write("\n7. It leaves the caller's array alone\n");
{
  const mine = rows.slice();
  const before = ids(mine);
  LO.fairQueue(mine, { turn: 3 });
  ok(ids(mine) === before,
     "no in-place sort, because every caller in this repo sorts a live array",
     ids(mine));
}

process.stdout.write("\n8. Degenerate inputs do not throw\n");
{
  ok(LO.fairQueue([], { turn: 4 }).length === 0, "an empty catalogue");
  ok(LO.fairQueue([rows[0]], { turn: 9 })[0].id === "A", "a catalogue of one");
  ok(LO.fairQueue(null, { turn: 1 }).length === 0, "no catalogue at all");
  // A clock before 1970, or a caller doing its own arithmetic. A bare % would
  // produce a negative index here and slice() would silently take from the end.
  ok(ids(LO.fairQueue(rows, { turn: -1 })) === "EABCD",
     "a negative turn rotates backwards rather than producing nonsense",
     ids(LO.fairQueue(rows, { turn: -1 })));
  const undated = [{ id: "x" }, { id: "y" }];
  ok(LO.fairQueue(undated, { turn: 0 }).length === 2,
     "a row with no date is queued, not dropped");
}

process.stdout.write("\n9. An owner can be told something true and specific\n");
{
  const p = LO.placeOf(rows, "C", { turn: 0 });
  ok(p && p.position === 3 && p.of === 5, "where the listing is right now", JSON.stringify(p));
  ok(p.turnsAway === 2, "and how many turns until it leads", JSON.stringify(p));
  ok(p.msAway === 2 * LO.TURN_MS, "expressed in real time, so a screen can say 'in 2 hours'");

  const lead = LO.placeOf(rows, "C", { turn: 2 });
  ok(lead.position === 1 && lead.turnsAway === 0,
     "and two turns later it is at the top, exactly as it was told",
     JSON.stringify(lead));
  ok(LO.placeOf(rows, "nope", { turn: 0 }) === null, "a listing not in the set has no place");
}

process.stdout.write("\n10. A turn is an hour, read from the clock once\n");
{
  ok(LO.TURN_MS === 3600000, "one hour");
  ok(LO.turnAt(Date.parse("2026-09-01T00:30:00Z")) === LO.turnAt(Date.parse("2026-09-01T00:59:59Z")),
     "two moments in the same hour are the same turn");
  ok(LO.turnAt(Date.parse("2026-09-01T01:00:00Z")) === LO.turnAt(Date.parse("2026-09-01T00:00:00Z")) + 1,
     "and the next hour is the next turn");
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
