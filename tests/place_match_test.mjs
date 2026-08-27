// ============================================================================
// place_match_test.mjs — the typo-tolerant place matcher, driven directly.
//
// Every case here is A THING THE OLD PATH GOT WRONG, verified against the live
// LocationIQ geocoder before this matcher existed:
//
//   · "Mwalimu Nyerere Memorial Academy" → {"error":"Unable to geocode"}
//   · "Mwl Nyerere University"           → one row, Tabora, 800 km off
//   · "Mikoceni"                         → nothing, for one wrong letter
//   · anything at all                    → 1-3 sequential network round trips
//
// So the claims below are: we answer those locally, we answer them with the
// RIGHT place, and we refuse to answer when we genuinely do not know.
//
//   usage:  node tests/place_match_test.mjs      (no server, no browser, no network)
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Both libs are browser IIFEs that hang themselves on the global.
const sandbox = { console, window: {} };
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
for (const f of ["js/lib/tz-places.js", "js/lib/place-match.js"]) {
  vm.runInContext(readFileSync(join(ROOT, f), "utf8"), sandbox);
}
const M = sandbox.window.pawaPlaceMatch;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};

const DAR = { lat: -6.8161, lng: 39.2803 };          // a listing in Dar es Salaam
const top = (q, opts) => (M.search(q, opts)[0] || { name: "(nothing)", score: 0 });
const shows = (q, name, opts) =>
  M.search(q, Object.assign({ limit: 8 }, opts || {})).some((r) => r.name.includes(name));

process.stdout.write("\n1. The place the geocoder cannot geocode\n");
{
  // LocationIQ answers "Unable to geocode" for this exact string. We must not.
  const r = top("Mwalimu Nyerere Memorial Academy");
  ok(r.name.includes("Mwalimu Nyerere Memorial Academy"), "full legal name resolves locally", r.name);
  ok(r.score >= M.STRONG, "…and strongly enough to act on unattended", "score " + r.score.toFixed(2));
}

process.stdout.write("\n2. How people actually type it\n");
{
  for (const q of ["Mwl Nyerere University", "mwalimu nyerere university",
                   "chuo cha mwalimu nyerere", "MNMA", "nyerere academy kigamboni"]) {
    const r = top(q, { near: DAR });
    ok(r.name.includes("Mwalimu Nyerere Memorial Academy"), `"${q}" → the Kigamboni academy`, r.name);
  }
}

process.stdout.write("\n3. Misspelled, and still found\n");
{
  const cases = [
    ["mwl nyerere unuversity", "Mwalimu Nyerere Memorial Academy"],
    ["Mikoceni", "Mikocheni"],
    ["mlimani city", "Mlimani City"],
    ["Muhimbil hospital", "Muhimbili"],
    ["kariako", "Kariakoo"],
    ["universty of dar es salaam", "University of Dar es Salaam"],
    ["Mikocehni", "Mikocheni"],            // transposition, not substitution
  ];
  for (const [q, want] of cases) {
    const r = top(q, { near: DAR });
    ok(r.name.includes(want), `"${q}" → ${want}`, "got " + r.name + " @" + r.score.toFixed(2));
  }
}

process.stdout.write("\n4. A short word may not mutate into a different place\n");
{
  // Sinza / Simiyu are 2 edits apart. If short words got a 2-edit budget, a
  // Dar suburb and a lake-zone region would be the same query.
  const r = top("Sinza", { near: DAR });
  ok(r.name === "Sinza", "\"Sinza\" is Sinza, not Simiyu", r.name);
  ok(!shows("Sinza", "Simiyu", { near: DAR }), "…and Simiyu is not even offered");
}

process.stdout.write("\n5. Nearness breaks ties, it does not win arguments\n");
{
  // Two real universities are named after Nyerere. For a Dar listing the Dar
  // one leads; the Mara one must still be reachable by its own name.
  const r = top("nyerere university", { near: DAR });
  ok(r.name.includes("Kigamboni"), "a Dar listing gets the Dar campus first", r.name);
  ok(shows("nyerere university", "MJNUAT", { near: DAR }), "…and the Mara one is still offered");
  const mara = top("MJNUAT", { near: DAR });
  ok(mara.name.includes("MJNUAT"), "its own abbreviation beats the near-bonus", mara.name);

  // The bonus is capped at 0.06, so it can never flip a real name difference.
  const far = top("Mbeya", { near: DAR });
  ok(far.name === "Mbeya", "proximity to Dar does not turn \"Mbeya\" into a Dar place", far.name);
}

process.stdout.write("\n6. Filler, Swahili and English all reach the same place\n");
{
  const cases = [
    ["my office near Mlimani City", "Mlimani City"],
    ["kwa Kariakoo", "Kariakoo"],
    ["uwanja wa ndege dar", "Julius Nyerere International Airport"],
    ["soko la Kariakoo", "Kariakoo"],
    ["chuo kikuu cha dar es salaam", "University of Dar es Salaam"],
    ["hospitali ya Muhimbili", "Muhimbili"],
  ];
  for (const [q, want] of cases) {
    const r = top(q, { near: DAR });
    ok(r.name.includes(want), `"${q}" → ${want}`, "got " + r.name + " @" + r.score.toFixed(2));
  }
}

process.stdout.write("\n7. It refuses to answer when it does not know\n");
{
  // A street the gazetteer has never heard of must fall through to the online
  // geocoder, not be rounded up to whichever landmark shares two letters.
  for (const q of ["Kisiwani Street plot 44", "zzzqqq", "Ubungo Riverside Apartments block C"]) {
    const r = top(q, { near: DAR });
    ok(r.score < M.STRONG, `"${q}" is not claimed as a confident hit`, r.name + " @" + r.score.toFixed(2));
  }
  ok(M.search("x").length === 0, "a 1-character query returns nothing");
}

process.stdout.write("\n8. Spelling correction for the ONLINE query\n");
{
  // This is what gets re-sent to LocationIQ after the literal query found
  // nothing — the reason "Mikoceni" can still resolve to the real ward.
  ok(M.correct("Mikoceni").query.includes("mikocheni"), "Mikoceni → mikocheni",
     JSON.stringify(M.correct("Mikoceni")));
  ok(M.correct("mwl nyerere unuversity").query.includes("university"),
     "unuversity → university", JSON.stringify(M.correct("mwl nyerere unuversity")));
  // Words the gazetteer already knows are never "corrected" into something else.
  ok(!M.correct("Mikocheni").corrected, "a correctly spelled name is left alone");
  ok(!M.correct("Sinza Mori").corrected, "an unknown word with no close match is left alone",
     JSON.stringify(M.correct("Sinza Mori")));
}

process.stdout.write("\n9. Edit distance counts a transposition as one mistake\n");
{
  ok(M.osaDistance("mikoecni", "mikoceni", 2) === 1, "a swapped pair of letters costs one edit, not two");
  ok(M.osaDistance("teh", "the", 2) === 1, "teh → the is one edit, not two");
  ok(M.osaDistance("abc", "xyz", 1) === 2, "the bound is honoured (returns max+1)");
}

process.stdout.write("\n10. It is fast enough to run on every keystroke\n");
{
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) M.search("mwl nyerere unuversity", { near: DAR });
  const ms = (Date.now() - t0) / 200;
  ok(ms < 8, `200 searches averaged ${ms.toFixed(2)} ms each (budget 8 ms)`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n\n`);
process.exit(fail ? 1 : 0);
