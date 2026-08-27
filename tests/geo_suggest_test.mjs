// ============================================================================
// geo_suggest_test.mjs — pawaGeo.suggest(), with LocationIQ stubbed out.
//
// The stubbed responses are REAL: each one was captured from the live
// LocationIQ endpoint with the app's own key before this was written. That
// matters, because the bugs here were not "the geocoder is down" — they were
// "the geocoder answered, and we believed it":
//
//   q="Mwl Nyerere University"            → ONE row, an institute in Tabora,
//                                           800 km from the campus meant. One
//                                           row is not zero rows, so the local
//                                           gazetteer was never consulted.
//   q="Mwalimu Nyerere Memorial Academy"  → {"error":"Unable to geocode"}, then
//                                           two more round trips dropping words,
//                                           then a dead end — for a place whose
//                                           coordinates ship in the page.
//   q="Mikoceni"                          → nothing, for one wrong letter.
//
// So this measures both the ANSWER and the COST: how many times we went to the
// network to produce it.
//
//   usage:  node tests/geo_suggest_test.mjs      (no server, no browser, no network)
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};

const DAR_HOUSE = { lat: -6.78, lng: 39.25 };

// The one real row LocationIQ returns for "Mwl Nyerere University" — verbatim.
const TABORA_ROW = {
  place_id: "331211627284", osm_type: "node", osm_id: "4561854489",
  lat: "-5.019163", lon: "32.80297",
  display_name: "Taasisi ya Mwl. Nyerere, Tabora Urban, Tabora, Tanzania",
  type: "school", class: "amenity",
  address: { name: "Taasisi ya Mwl. Nyerere", county: "Tabora Urban", state: "Tabora", country: "Tanzania" },
};
const MIKOCHENI_ROW = {
  place_id: "1", lat: "-6.7642", lon: "39.2613",
  display_name: "Mikocheni, Kinondoni, Dar es Salaam, Tanzania",
  name: "Mikocheni", type: "suburb", class: "place",
};

// Build a fresh sandbox per case: geo.js caches, so a shared one would hide the
// second call rather than count it.
function load(responder) {
  const calls = [];
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    window: {}, setTimeout, clearTimeout, AbortController, Promise, Date, Math, JSON,
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.APP_CONFIG = { LOCATIONIQ_KEY: "test-key" };
  sandbox.fetch = async (url) => {
    const q = decodeURIComponent((String(url).match(/[?&]q=([^&]*)/) || [])[1] || "");
    calls.push(q);
    const body = responder(q);
    return { ok: body !== null, status: body === null ? 404 : 200, json: async () => body };
  };
  sandbox.window.fetch = sandbox.fetch;
  vm.createContext(sandbox);
  for (const f of ["js/lib/tz-places.js", "js/lib/place-match.js", "js/lib/geo.js"]) {
    vm.runInContext(readFileSync(join(ROOT, f), "utf8"), sandbox);
  }
  return { geo: sandbox.window.pawaGeo, calls };
}

const names = (rows) => rows.map((r) => r.name).join(" | ");

process.stdout.write("\n1. A confidently wrong single row no longer wins\n");
{
  const { geo, calls } = load((q) => (/nyerere/i.test(q) ? [TABORA_ROW] : []));
  const rows = await geo.suggest("Mwl Nyerere University", { near: DAR_HOUSE, limit: 6 });
  ok(rows.length > 0, "something came back", names(rows));
  ok(rows[0].name.includes("Mwalimu Nyerere Memorial Academy"),
     "the Dar campus is first, not the Tabora institute", names(rows));
  ok(rows[0].fuzzy !== true, "…and it is NOT flagged as a guess (it is our own coordinate)");
  ok(rows.some((r) => /Tabora/i.test(r.name) || /Tabora/i.test(r.context || "")),
     "the geocoder's Tabora row is still offered, just not first", names(rows));
}

process.stdout.write("\n2. The place the geocoder cannot geocode, in ONE round trip\n");
{
  // LocationIQ answers this exact string with an error object, not an array.
  const { geo, calls } = load(() => ({ error: "Unable to geocode" }));
  const rows = await geo.suggest("Mwalimu Nyerere Memorial Academy", { near: DAR_HOUSE });
  ok(rows.length > 0 && rows[0].name.includes("Mwalimu Nyerere Memorial Academy"),
     "resolved from the local gazetteer", names(rows));
  ok(calls.length === 1,
     `one network call, not three (was: literal, then two word-dropping retries) — made ${calls.length}`,
     JSON.stringify(calls));
}

process.stdout.write("\n3. One wrong letter\n");
{
  // A misspelled name we DO hold: answered from the gazetteer, and the retry is
  // never paid for, because there is nothing left to rescue.
  const { geo, calls } = load(() => []);
  const rows = await geo.suggest("Mikoceni", { near: DAR_HOUSE });
  ok(rows.some((r) => r.name === "Mikocheni"), "Mikoceni → Mikocheni", names(rows));
  ok(calls.length === 1, `and it cost one call, not three — made ${calls.length}`, JSON.stringify(calls));
}
{
  // A misspelled name inside an address we DON'T hold. Nothing local is strong
  // enough to stand on, so the query is re-asked with the word spelled the way
  // the gazetteer spells it — which is the spelling LocationIQ indexes.
  const { geo, calls } = load((q) =>
    (q.toLowerCase().startsWith("mikocheni") ? [MIKOCHENI_ROW] : []));
  const rows = await geo.suggest("Mikoceni light industrial", { near: DAR_HOUSE });
  ok(rows.some((r) => r.name === "Mikocheni"), "the corrected query found it", names(rows));
  ok(calls.indexOf("Mikoceni light industrial") === 0,
     "the literal query is always tried first", JSON.stringify(calls));
  ok(calls.some((c) => c.startsWith("mikocheni")),
     "…then the corrected spelling, before any word-dropping", JSON.stringify(calls));
  ok(rows.find((r) => r.name === "Mikocheni").approx === true,
     "and the row says it is an approximate match, not the thing asked for");
}

process.stdout.write("\n4. A place we do not know still reaches the geocoder normally\n");
{
  const { geo, calls } = load((q) => (/kisiwani/i.test(q) ? [{
    place_id: "9", lat: "-6.80", lon: "39.26", name: "Kisiwani Street",
    display_name: "Kisiwani Street, Ilala, Dar es Salaam, Tanzania", type: "residential", class: "highway",
  }] : []));
  const rows = await geo.suggest("Kisiwani Street", { near: DAR_HOUSE });
  ok(rows.length === 1 && rows[0].name === "Kisiwani Street",
     "the online result is returned untouched", names(rows));
  ok(!rows.some((r) => r.local), "no local row is invented alongside it", names(rows));
}

process.stdout.write("\n5. A weak local guess is marked as a guess\n");
{
  const { geo } = load(() => []);
  const rows = await geo.suggest("Mbezy Bich", { near: DAR_HOUSE });
  const guess = rows.find((r) => r.local);
  ok(!!guess, "something was offered rather than a dead end", names(rows));
  if (guess) {
    ok(guess.fuzzy === true || guess.score >= 0.82,
       "it is either confident, or flagged fuzzy — never confident-looking and weak",
       `${guess.name} score=${(guess.score || 0).toFixed(2)} fuzzy=${guess.fuzzy}`);
  }
}

process.stdout.write("\n6. Two identical lookups in flight cost one request\n");
{
  const { geo, calls } = load(() => [MIKOCHENI_ROW]);
  const [a, b] = await Promise.all([geo.suggest("Mikocheni"), geo.suggest("Mikocheni")]);
  ok(calls.length === 1, `one request served both callers — made ${calls.length}`, JSON.stringify(calls));
  ok(names(a) === names(b), "and both got the same answer");
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n\n`);
process.exit(fail ? 1 : 0);
