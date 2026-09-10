// ============================================================================
// maps_handoff_test.mjs — the Google Maps hand-off, driven directly.
//
// The whole promise of this module is "one tap and nothing to fill in", and
// every way of breaking it is silent: a link still opens Google Maps, it just
// opens it on a screen asking a question the app already knew the answer to.
// So each test here is written as a CLAIM THE OLD LINKS GOT WRONG:
//
//   · nine links in the repo set a destination and never an origin
//   · a missing origin was written as "" or as a place name, not omitted
//   · a stale fix from another town would have been used as "where you are"
//   · the workplace a person saved once on houses.html was never read again
//   · a listing with no pin produced a link to Google's idea of "undefined"
//
//   usage:  node tests/maps_handoff_test.mjs      (no server, no browser)
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// A browser IIFE that hangs itself on the global, plus the two globals it
// reads through when they happen to exist.
const store = new Map();
const sandbox = {
  console,
  window: {},
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  Date,
};
sandbox.window.window = sandbox.window;
sandbox.window.localStorage = sandbox.localStorage;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, "js/lib/maps-handoff.js"), "utf8"), sandbox);
const M = sandbox.window.PawaMaps;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};

const HOUSE = { lat: -6.7924, lng: 39.2083 };
const ME    = { lat: -6.8100, lng: 39.2800 };
const param = (url, k) => new URL(url).searchParams.get(k);

process.stdout.write("\n1. A directions link carries all three facts\n");
{
  const url = M.directions(HOUSE, { from: ME, mode: "car" });
  ok(url.startsWith("https://www.google.com/maps/dir/?api=1"),
     "it is the documented api=1 form, which is the one whose parameters are promised");
  ok(param(url, "destination") === "-6.792400,39.208300", "the destination is the house");
  ok(param(url, "origin") === "-6.810000,39.280000",
     "the ORIGIN is set, which not one of the nine existing links in the repo does");
  ok(param(url, "travelmode") === "driving", "and the travel mode is set");
}

process.stdout.write("\n2. An unknown origin is OMITTED, never invented\n");
{
  const url = M.directions(HOUSE);
  ok(!url.includes("origin="),
     "no origin parameter at all when we do not know where they are");
  ok(param(url, "destination") === "-6.792400,39.208300",
     "the link still works: Google uses the device's own location");
  // "" and "current location" both read to Google as a place name to search
  // for, which is how a directions link lands on a search results page.
  const empty = M.directions(HOUSE, { from: { lat: null, lng: null } });
  ok(!empty.includes("origin="), "a half-null origin is omitted rather than serialised");
  const nan = M.directions(HOUSE, { from: { lat: NaN, lng: 39.2 } });
  ok(!nan.includes("origin="), "and so is a NaN one");
}

process.stdout.write("\n3. A listing with no pin gets no link, not a broken one\n");
{
  ok(M.directions(null) === "", "no destination, no link");
  ok(M.directions({ lat: -6.79 }) === "", "half a destination is not a destination");
  ok(M.directions({ lat: "abc", lng: "def" }) === "", "and neither is text");
}

process.stdout.write("\n4. Tanzanian travel modes map onto Google's four\n");
{
  ok(M.travelMode("walk") === "walking", "walk is walking");
  ok(M.travelMode("daladala") === "transit", "daladala is public transport, not a car");
  ok(M.travelMode("bodaboda") === "driving",
     "a bodaboda follows the roads a car follows, so the ROUTE is the driving one");
  ok(M.travelMode("bajaji") === "driving", "same for a bajaji");
  ok(M.travelMode("car") === "driving", "a car is driving");
  ok(M.travelMode(undefined) === "driving", "and an unset mode does not produce travelmode=undefined");
  ok(M.travelMode("something else") === "driving", "nor does a mode Google has never heard of");
}

process.stdout.write("\n5. A remembered fix is used only while it is still true\n");
{
  const put = (fix) => store.set("pawa_last_pos", JSON.stringify(fix));

  sandbox.window.pawaLocate = { lastKnown: () => JSON.parse(store.get("pawa_last_pos") || "null") };

  put({ lat: ME.lat, lng: ME.lng, at: Date.now() - 60 * 1000 });
  const fresh = M.knownOrigin();
  ok(fresh && fresh.lat === ME.lat, "a one-minute-old fix is where you are");

  put({ lat: -3.3869, lng: 36.6830, at: Date.now() - 6 * 60 * 60 * 1000 });
  ok(M.knownOrigin() === null,
     "a six-hour-old fix is NOT, even though it is a perfectly valid coordinate");

  put({ lat: ME.lat, lng: ME.lng, at: Date.now() + 60 * 60 * 1000 });
  ok(M.knownOrigin() === null, "and neither is one stamped in the future");

  store.delete("pawa_last_pos");
  ok(M.knownOrigin() === null, "nothing remembered means null, never a default city");

  delete sandbox.window.pawaLocate;
  ok(M.knownOrigin() === null, "and no geolocate library at all is not an error");
}

process.stdout.write("\n6. The workplace saved on houses.html is readable here\n");
{
  const places = [
    { id: "mp-1", kind: "fav",  name: "Kariakoo",  lat: -6.82, lng: 39.27, mode: "daladala" },
    { id: "mp-2", kind: "work", name: "Muhimbili", lat: -6.80, lng: 39.27, mode: "bajaji" },
    { id: "mp-3", kind: "work", name: "Second job", lat: -6.7, lng: 39.1, mode: "car" },
    { id: "mp-4", kind: "custom", name: "Broken", lat: null, lng: null },
  ];
  store.set("pawa_house_my_places", JSON.stringify(places));

  ok(M.savedPlaces().length === 3, "the place with no coordinates is dropped, not rendered blank");

  const w = M.workplace();
  ok(w && w.name === "Muhimbili", "the workplace is found without the person typing it again");
  ok(M.modeOf(w) === "bajaji", "and it carries the way they actually travel");

  // house -> work, which is the direction the detail sheet asks about.
  const url = M.directions(w, { from: HOUSE, mode: M.modeOf(w) });
  ok(param(url, "origin") === "-6.792400,39.208300", "the house is the origin");
  ok(param(url, "destination") === "-6.800000,39.270000", "the workplace is the destination");
  ok(param(url, "travelmode") === "driving", "a bajaji routes as driving");

  store.set("pawa_house_my_places", "not json at all");
  ok(M.savedPlaces().length === 0 && M.workplace() === null,
     "a corrupted store is an empty one, never a thrown page");
  store.delete("pawa_house_my_places");
}

process.stdout.write("\n7. A dropped pin is a search, not a route\n");
{
  const url = M.pin(HOUSE);
  ok(url.startsWith("https://www.google.com/maps/search/?api=1"), "search form for a pin");
  ok(param(url, "query") === "-6.792400,39.208300", "the coordinates are the query");
  ok(M.pin(null, "Mlimani City").includes("Mlimani"),
     "with no coordinates it falls back to the name");
  ok(M.pin(null, "  ") === "", "and an empty name is no link at all");
}

process.stdout.write("\n8. Six decimals, and no more\n");
{
  const url = M.directions({ lat: -6.79241234567, lng: 39.20831234567 });
  ok(param(url, "destination") === "-6.792412,39.208312",
     "eleven decimal places of GPS noise do not go into a link a person may read");
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
