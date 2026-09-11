// ============================================================================
//  truck_match_test.mjs — the ranking behind "find me a truck to move here".
//
//  WHY THIS IS A TEST AND NOT A LOOK AT THE SCREEN
//  js/lib/truck-match.js decides whose phone rings. The order it produces is
//  the product, and it is the one part of this feature you cannot check by
//  opening the page: with three fixtures on a dev database every ordering
//  looks plausible, and the mistakes are all of the "this is defensible but
//  wrong" kind. The first run of this file caught exactly that — a twelve-
//  tonne lorry at TZS 450,000 was beating a right-sized canter at 90,000 for
//  a two-bedroom move, because "big enough" scored the same whether the lorry
//  was the right size or four times it. See ROOMY_MULTIPLE in that file.
//
//  It runs the library in a vm with a fake `window`, so there is no browser
//  and no server: node tests/truck_match_test.mjs
//
//  The three promises it holds the ranking to are the ones in the library's
//  own header: a distance is a road or it is nothing, an unknown fact never
//  rules a truck out, and the page's cache is never written to.
// ============================================================================
import fs from "fs";
import vm from "vm";

const win = { getLang: () => "en" };
const ctxVm = vm.createContext({ window: win, console, URLSearchParams, location: { search: "" } });
vm.runInContext(fs.readFileSync("js/lib/truck-match.js", "utf8"), ctxVm);
const TM = win.TruckMove;

const DAR = { lat: -6.7724, lng: 39.2083 };          // Mikocheni
const NEAR = { lat: -6.78, lng: 39.22 };             // ~1.7 km away
const KIBAHA = { lat: -6.7700, lng: 38.9200 };       // ~32 km
const MWANZA = { lat: -2.5164, lng: 32.9175 };       // ~1000 km

const trucks = [
  { id: "a", title: "Small pickup", truck_type: "pickup", capacity_tonnes: 1,
    price_tzs: 40000, service_area: "within_city", region: "Dar es Salaam",
    lat: NEAR.lat, lng: NEAR.lng, driver_included: true, loaders_included: false,
    details: { kit: ["closed_body", "straps"] } },
  { id: "b", title: "Canter, crew", truck_type: "canter", capacity_tonnes: 3,
    price_tzs: 90000, service_area: "region_wide", region: "Dar es Salaam",
    lat: -6.83, lng: 39.26, driver_included: true, loaders_included: true, verified: true,
    details: { kit: ["driver", "loaders", "tarpaulin"] } },
  { id: "c", title: "Ten tonne", truck_type: "10ton_plus", capacity_tonnes: 12,
    price_tzs: 450000, service_area: "cross_region", region: "Dar es Salaam",
    lat: -6.90, lng: 39.30, driver_included: true, loaders_included: true,
    details: { kit: ["flatbed"] } },
  { id: "d", title: "No pin, no size", truck_type: "other",
    price_tzs: 60000, service_area: "within_city", region: "Dar es Salaam" },
];

let fails = 0;
const ok = (c, m, extra) => {
  console.log((c ? "  PASS  " : "  FAIL  ") + m + (c || extra == null ? "" : "   " + extra));
  if (!c) fails++;
};

console.log("\nranking a two-bedroom move inside Dar");
let ctx = { from: DAR, to: KIBAHA, toRegion: "Pwani", load: "two_bed", tripKm: 32 };
let r = TM.rank(trucks, ctx);
ok(r[0].id === "b", "the 3-tonne with a crew wins a two-bedroom move", r.map(x => x.id + ":" + x._score).join(" "));
ok(r.find(x => x.id === "a")._capacity === "small", "the 1-tonne is called too small");
ok(r.find(x => x.id === "d")._capacity === "unknown", "a listing with no tonnage is 'unknown', not 'too small'");
ok(r.find(x => x.id === "a")._coverage === "beyond", "a within-city truck crossing into Pwani is beyond its promise");
ok(r.find(x => x.id === "c")._coverage === "covers", "a cross-region truck covers anything");
ok(r[0]._best === true, "the top row is crowned");

console.log("\nno region known: an unknown must never rule a truck out");
ctx = { from: DAR, to: NEAR, toRegion: null, load: "room", tripKm: 2 };
r = TM.rank(trucks, ctx);
ok(r.every(x => x._coverage !== "beyond"), "a 2 km move is inside every promise",
   r.map(x => x.id + ":" + x._coverage).join(" "));

console.log("\na thousand-kilometre move");
ctx = { from: DAR, to: MWANZA, toRegion: "Mwanza", load: "three_bed", tripKm: 1100 };
r = TM.rank(trucks, ctx);
ok(r[0].id === "c", "only the cross-region lorry can do it", r.map(x => x.id).join(" "));
ok(r.find(x => x.id === "b")._coverage === "ask", "the region-wide one is asked, not refused");

console.log("\nsuperlatives");
ctx = { from: DAR, to: KIBAHA, toRegion: "Pwani", load: "two_bed", tripKm: 32 };
r = TM.rank(trucks, ctx);
ok(r.filter(x => x._cheapest).length === 1, "exactly one cheapest");
ok(r.find(x => x._cheapest).id === "a", "and it is the 40k one");
ok(r.find(x => x._biggest).id === "c", "the 12-tonne is the biggest");
ok(r.find(x => x._closest).id === "a", "the nearest pin is closest");

console.log("\nthe input rows are never touched");
ok(trucks.every(t => t._score === undefined), "no _score leaked onto the page cache");

console.log("\ncarrying a move between pages");
const q = TM.encode({ to: KIBAHA, from: DAR, load: "two_bed", house: "h-1", toRegion: "Pwani", toLabel: "Kibaha" });
const back = TM.decode("?" + q);
ok(Math.abs(back.to.lat - KIBAHA.lat) < 1e-6, "the destination survives the round trip", q);
ok(back.load === "two_bed" && back.house === "h-1" && back.toRegion === "Pwani", "and so does the plan");
ok(TM.decode("?load=nonsense&to=hello").load === null, "an invented load size is dropped");
ok(TM.decode("?to=hello").to === null, "and half a coordinate is not a point");

console.log("\ndistances read as words");
ok(TM.kmText(0.42) === "420 m", "under a kilometre is metres", TM.kmText(0.42));
ok(TM.kmText(4.23) === "4.2 km", "short distances keep one decimal", TM.kmText(4.23));
ok(TM.kmText(137.4) === "137 km", "long ones do not", TM.kmText(137.4));
ok(TM.kmText(null) === "", "and nothing is nothing");

console.log("\n" + (fails ? fails + " FAILED" : "all good") + "\n");
process.exit(fails ? 1 : 0);
