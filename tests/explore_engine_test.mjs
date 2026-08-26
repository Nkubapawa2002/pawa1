// ============================================================================
// explore_engine_test.mjs — the Explore search engine, exercised end to end.
//
// The four libs under js/lib/explore-*.js are plain browser IIFEs that attach
// themselves to `window`. There is no build step and no module system on this
// site, so the test rig here is the honest one: give them a `window`, eval
// them in order, and drive the exact globals the page drives.
//
// What is actually being checked is behaviour a user would notice:
//   · "lori Mwanza" finds trucks, not rooms
//   · "fundi umeme" finds an electrician, in either language
//   · a budget keeps the results inside it
//   · the nearest listing wins when everything else is equal
//   · a room offers the trucks near IT, not near the search box
//
//   usage:  node tests/explore_engine_test.mjs
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- Rig --------------------------------------------------------------------
const win = { console };
win.window = win;
// The gazetteer is a real dependency of query parsing (it is what turns
// "Mwanza" into coordinates), so it is loaded rather than stubbed.
const ctx = vm.createContext(win);
for (const f of [
  "js/lib/tz-places.js",
  "js/lib/explore-index.js",
  "js/lib/explore-query.js",
  "js/lib/explore-rank.js",
  "js/lib/explore-match.js",
  "js/lib/explore-roads.js",
]) {
  vm.runInContext(readFileSync(join(ROOT, f), "utf8"), ctx, { filename: f });
}
const { ExploreIndex, ExploreQuery, ExploreRank, ExploreMatch, ExploreRoads } = win;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);

// ---- Fixtures ---------------------------------------------------------------
// Coordinates are real: Mbezi Beach and Kariakoo are ~14 km apart in Dar,
// Mwanza is ~1,100 km away. That spread is what makes the geo assertions mean
// something rather than pass by accident.
const MBEZI  = { lat: -6.7280, lng: 39.2100 };
const KARIA  = { lat: -6.8180, lng: 39.2700 };
const MWANZA = { lat: -2.5164, lng: 32.9175 };
const now = new Date().toISOString();

const houses = [
  { id: "h1", title: "Single room Mbezi Beach", type: "room", listing: "rent",
    price_tzs: 250000, period: "month", bedrooms: 1, room_kind: "single",
    region: "Dar es Salaam", area: "Mbezi Beach", lat: MBEZI.lat, lng: MBEZI.lng,
    photo: "x.jpg", verified: true, created_at: now, owner_user_id: "o1",
    description: "Clean single room, water and electricity included." },
  { id: "h2", title: "2 bedroom apartment Kariakoo", type: "apartment", listing: "rent",
    price_tzs: 800000, period: "month", bedrooms: 2, region: "Dar es Salaam",
    area: "Kariakoo", lat: KARIA.lat, lng: KARIA.lng, created_at: now, owner_user_id: "o2" },
  { id: "h3", title: "House for sale Mwanza", type: "house", listing: "sale",
    price_tzs: 90000000, period: "total", bedrooms: 4, region: "Mwanza",
    area: "Nyamagana", lat: MWANZA.lat, lng: MWANZA.lng, created_at: now, owner_user_id: "o3" },
  { id: "h4", title: "Cheap room Mbezi", type: "room", listing: "rent",
    price_tzs: 180000, period: "month", bedrooms: 1, region: "Dar es Salaam",
    area: "Mbezi Beach", lat: MBEZI.lat + 0.004, lng: MBEZI.lng, created_at: now, owner_user_id: "o1" },
];
const trucks = [
  { id: "t1", title: "Canter for hire Mbezi", truck_type: "canter", capacity_tonnes: 3,
    price_tzs: 60000, period: "trip", region: "Dar es Salaam", area: "Mbezi",
    lat: MBEZI.lat + 0.01, lng: MBEZI.lng + 0.01, created_at: now, owner_user_id: "o4",
    loaders_included: true },
  { id: "t2", title: "10 tonne lorry Mwanza", truck_type: "lorry", capacity_tonnes: 10,
    price_tzs: 300000, period: "trip", region: "Mwanza", area: "Nyamagana",
    lat: MWANZA.lat, lng: MWANZA.lng, created_at: now, owner_user_id: "o5" },
];
const services = [
  { id: "s1", title: "Electrician - wiring and repairs", category: "electrical",
    price_tzs: 40000, rate_type: "per_job", region: "Dar es Salaam", area: "Mbezi",
    lat: MBEZI.lat + 0.005, lng: MBEZI.lng, created_at: now, owner_user_id: "o6",
    experience_years: 8 },
  { id: "s2", title: "House cleaning service", category: "cleaning",
    price_tzs: 25000, rate_type: "per_job", region: "Dar es Salaam", area: "Mbezi Beach",
    lat: MBEZI.lat, lng: MBEZI.lng + 0.006, created_at: now, owner_user_id: "o7" },
];
const jobs = [
  { id: 1, title: "Loading workers needed", company_name: "Dar Movers",
    company_phone: "+255700000000", region: "Dar es Salaam", area: "Mbezi",
    lat: MBEZI.lat, lng: MBEZI.lng, workers_needed: 10, claimed_count: 2,
    pay_tzs: 15000, work_date: "2026-08-20", status: "open", created_at: now },
  { id: 2, title: "Full crew already hired", company_name: "X", company_phone: "+255700000001",
    region: "Dar es Salaam", area: "Mbezi", lat: MBEZI.lat, lng: MBEZI.lng,
    workers_needed: 3, claimed_count: 3, pay_tzs: 12000, status: "open", created_at: now },
];

const items = [
  ...houses.map(ExploreIndex.fromHouse),
  ...trucks.map(ExploreIndex.fromTruck),
  ...services.map(ExploreIndex.fromService),
  ...jobs.map(ExploreIndex.fromJob),
];

const search = (q, opts = {}) => {
  const intent = ExploreQuery.parse(q, { scope: opts.scope });
  return { intent, out: ExploreRank.rank(items, intent, opts) };
};
const ids = (out) => out.results.map((r) => r.item.id);

// ---- 1. Normalisation -------------------------------------------------------
section("1. Normalisation — four tables, one shape");
{
  ok(items.length === houses.length + trucks.length + services.length + jobs.length,
     `all ${items.length} rows normalised`);
  const shapes = new Set(items.map((i) => Object.keys(i).sort().join(",")));
  ok(shapes.size === 1, "every item has an identical key set",
     shapes.size > 1 ? `${shapes.size} different shapes` : "");
  const job = items.find((i) => i.kind === "job");
  ok(job.facets.spotsLeft === 8, "job spotsLeft derived from workers_needed - claimed",
     `got ${job.facets.spotsLeft}`);
  const room = items.find((i) => i.id === "h1");
  ok(room.text.includes("mbezi") && room.text.includes("kupanga"),
     "search blob folds in area + bilingual intent words");
}

// ---- 2. Domain routing ------------------------------------------------------
section("2. Domain routing — which catalogue did they mean?");
{
  const cases = [
    ["chumba Mbezi", "room"],
    ["room for rent", "room"],
    ["lori Mwanza", "truck"],
    ["canter 3 tonne", "truck"],
    ["fundi umeme", "service"],
    ["electrician", "service"],
    ["kazi za siku", "job"],
    ["day jobs Dodoma", "job"],
  ];
  for (const [q, want] of cases) {
    const { intent } = search(q);
    ok(intent.kinds[0] === want || (intent.kinds.includes(want) && intent.kinds.length <= 2),
       `"${q}" → ${want}`, `got [${intent.kinds}]`);
  }
  // The rule that makes this a global view rather than four search boxes.
  const empty = ExploreQuery.parse("");
  ok(empty.kinds.length === 4, "an empty query searches ALL four verticals",
     `got [${empty.kinds}]`);
  // Genuinely ambiguous input must stay ambiguous rather than pick a side.
  const both = ExploreQuery.parse("cleaning");
  ok(both.kinds.includes("service"), "\"cleaning\" keeps the service reading");
}

// ---- 3. Money ---------------------------------------------------------------
section("3. Budget parsing");
{
  const cases = [
    ["under 300k", { priceMax: 300000 }],
    ["chini ya 500k", { priceMax: 500000 }],
    ["2 million", { priceMax: 2000000 }],
    ["elfu 800", null],                      // "elfu 800" is 800k in speech order
    ["between 200k and 400k", { priceMin: 200000, priceMax: 400000 }],
    ["zaidi ya 1m", { priceMin: 1000000 }],
  ];
  for (const [q, want] of cases) {
    if (!want) continue;
    const got = ExploreQuery.parsePrice(q);
    const okMax = want.priceMax == null || got.priceMax === want.priceMax;
    const okMin = want.priceMin == null || got.priceMin === want.priceMin;
    ok(okMax && okMin, `"${q}" → ${JSON.stringify(want)}`, `got ${JSON.stringify(got)}`);
  }
  // The guard that stops a bedroom count becoming a price.
  const beds = ExploreQuery.parse("3 bedroom house");
  ok(beds.priceMax == null, "\"3 bedroom\" does not parse 3 as a budget",
     `got priceMax=${beds.priceMax}`);
  ok(beds.facets.bedrooms === 3, "\"3 bedroom\" parses as bedrooms");

  // "and" is a valid range separator, which makes it a trap: this must not
  // read "3 bedroom and 2 bathroom" as the price range 2–3.
  const trap = ExploreQuery.parsePrice("3 bedroom and 2 bathroom");
  ok(trap.priceMin == null && trap.priceMax == null,
     "\"3 bedroom and 2 bathroom\" is not a price range",
     `got ${JSON.stringify(trap)}`);
}

// ---- 4. Hard filters --------------------------------------------------------
section("4. Hard filters");
{
  const { out } = search("room for rent under 300k");
  ok(!ids(out).includes("h2"), "800k room excluded by a 300k budget");
  ok(!ids(out).includes("h3"), "a for-sale house is excluded from a rent search");
  ok(ids(out).includes("h1") && ids(out).includes("h4"), "both in-budget rooms survive",
     `got [${ids(out)}]`);

  const full = search("day jobs", { scope: "job" });
  ok(!ids(full.out).includes("job-2"), "a job with no spots left is never shown");
}

// ---- 5. Geo -----------------------------------------------------------------
section("5. Distance");
{
  // Same query, anchored in Mbezi: the Mbezi rooms must beat the Kariakoo one
  // even though Kariakoo is a perfectly good match on words and price.
  const { out } = search("room for rent", { anchor: MBEZI });
  const top = out.results[0].item;
  ok(top.area.startsWith("Mbezi"), "nearest-area room ranks first when anchored in Mbezi",
     `got "${top.title}"`);
  const d = out.results[0].distKm;
  ok(d != null && d < 1, "distance computed for the anchored result", `got ${d} km`);

  const far = search("room for rent", { anchor: MWANZA, radiusKm: 50 });
  ok(!ids(far.out).includes("h1"), "a 25 km radius in Mwanza excludes Dar listings");

  // A radius must not silently delete listings that simply have no map pin.
  const noPin = ExploreIndex.fromHouse({ ...houses[0], id: "h9", lat: null, lng: null });
  const withNoPin = ExploreRank.rank([...items, noPin],
    ExploreQuery.parse("room for rent"), { anchor: MBEZI, radiusKm: 5 });
  ok(withNoPin.results.some((r) => r.item.id === "h9"),
     "an unpinned listing survives a radius filter rather than vanishing");
}

// ---- 6. Text ----------------------------------------------------------------
section("6. Text relevance");
{
  const { out } = search("electrician wiring");
  ok(out.results[0].item.id === "s1", "exact trade term finds the electrician",
     `got ${out.results[0]?.item.id}`);

  // The Swahili route to the same listing, via the synonym fold in the index.
  const sw = search("fundi umeme");
  ok(ids(sw.out).includes("s1"), "\"fundi umeme\" finds the same electrician");

  // IDF: a rare word must outweigh a common one.
  const idf = ExploreRank.buildIdf(items, ["room", "kariakoo"]);
  ok(idf.kariakoo > idf.room, "rare term outweighs common term (IDF)",
     `room=${idf.room.toFixed(2)} kariakoo=${idf.kariakoo.toFixed(2)}`);

  ok(ExploreRank.withinOneEdit("mbezi", "mbezy"), "one-edit typo tolerance");
  ok(!ExploreRank.withinOneEdit("mbezi", "kariakoo"), "unrelated words are not 'one edit'");
}

// ---- 7. Diversity -----------------------------------------------------------
section("7. Diversity re-rank");
{
  // Twelve listings from one owner: without the re-rank they take the whole
  // first page, which is exactly what makes a directory feel spammy.
  const flood = [];
  for (let i = 0; i < 12; i++) {
    flood.push(ExploreIndex.fromHouse({
      ...houses[0], id: "f" + i, title: "Room Mbezi " + i, owner_user_id: "spam",
    }));
  }
  const mixed = [...flood, ...items];
  const out = ExploreRank.rank(mixed, ExploreQuery.parse("room for rent"), { anchor: MBEZI });
  const firstSix = out.results.slice(0, 6).map((r) => r.item.ownerId);
  const spamInTop6 = firstSix.filter((o) => o === "spam").length;
  ok(spamInTop6 < 6, "one owner cannot fill the whole first page",
     `${spamInTop6}/6 from the flooding owner`);

  const noDiv = ExploreRank.rank(mixed, ExploreQuery.parse("room for rent"),
    { anchor: MBEZI, diversity: false });
  const spamNoDiv = noDiv.results.slice(0, 6).filter((r) => r.item.ownerId === "spam").length;
  ok(spamNoDiv >= spamInTop6, "diversity:false really does disable the re-rank",
     `with=${spamInTop6} without=${spamNoDiv}`);
}

// ---- 8. Sorting -------------------------------------------------------------
section("8. Explicit sorts");
{
  const cheap = ExploreRank.rank(items, ExploreQuery.parse("room for rent"), { sort: "cheap" });
  const prices = cheap.results.map((r) => r.item.price);
  ok(prices.every((p, i) => i === 0 || prices[i - 1] <= p), "cheapest-first is monotonic",
     `got [${prices}]`);

  const near = ExploreRank.rank(items, ExploreQuery.parse("room for rent"),
    { anchor: MBEZI, sort: "near" });
  const ds = near.results.map((r) => r.distKm).filter((d) => d != null);
  ok(ds.every((d, i) => i === 0 || ds[i - 1] <= d), "nearest-first is monotonic");
}

// ---- 9. Cross-vertical match — the headline --------------------------------
section("9. Cross-vertical match");
{
  const room = items.find((i) => i.id === "h1");
  const groups = ExploreMatch.companionsFor(room, items);
  ok(groups.length > 0, "a room offers companions at all");

  const truckGroup = groups.find((g) => g.kind === "truck");
  ok(!!truckGroup, "a room offers TRUCKS — the thing the whole page exists for");
  ok(truckGroup && truckGroup.items[0].item.id === "t1",
     "the truck offered is the one near this room, not the one in Mwanza",
     truckGroup ? `got ${truckGroup.items.map((i) => i.item.id)}` : "");
  ok(truckGroup && truckGroup.items.every((i) => i.distKm <= 25),
     "every companion is genuinely within the rule's radius");

  const svcGroup = groups.find((g) => g.kind === "service");
  ok(!!svcGroup, "a room also offers move-in services");
  ok(svcGroup && svcGroup.items.every((i) =>
       ["cleaning", "plumbing", "electrical", "carpentry", "painting",
        "moving_help", "appliance_repair"].includes(i.item.facets.category)),
     "only move-in trades are offered, not every service nearby");

  // The honesty rule: nothing near → nothing offered, no auto-widening.
  const mwanzaHouse = items.find((i) => i.id === "h3");
  const far = ExploreMatch.companionsFor(mwanzaHouse, items);
  const farTrucks = far.find((g) => g.kind === "truck");
  ok(!farTrucks || farTrucks.items.every((i) => i.distKm <= 25),
     "a far-away listing is never dressed up as 'nearby'");

  // A job pairs with rooms a day-labourer could actually afford.
  const job = items.find((i) => i.id === "job-1");
  const jobGroups = ExploreMatch.companionsFor(job, items);
  const rooms = jobGroups.find((g) => g.kind === "room");
  ok(!!rooms, "a day job offers somewhere to stay");
  ok(rooms && rooms.items.every((r) => r.item.price <= job.price * 30),
     "the rooms offered are within reach of the job's pay",
     rooms ? `pay=${job.price} rooms=[${rooms.items.map((r) => r.item.price)}]` : "");

  // No pin, no claim.
  const unpinned = ExploreIndex.fromHouse({ ...houses[0], id: "hx", lat: null, lng: null });
  ok(ExploreMatch.companionsFor(unpinned, items).length === 0,
     "a listing with no coordinates offers no 'nearby' anything");
}

// ---- 10. Scope --------------------------------------------------------------
section("10. Scope pinning");
{
  const { out } = search("Mbezi", { scope: "truck" });
  ok(out.results.every((r) => r.item.kind === "truck"),
     "a pinned scope overrides whatever the words suggested",
     `got [${out.results.map((r) => r.item.kind)}]`);
}

// ---- 11. Road distance ------------------------------------------------------
section("11. Road distance");
{
  // pawaRoute lives in js/lib/geo.js and talks to OSRM. Stubbing it here keeps
  // the test offline and — more usefully — lets the road answer DISAGREE with
  // the straight line on purpose, which is the only case that matters.
  const calls = [];
  const roadFor = new Map();          // "lat,lng" → km the stub will report
  const key = (p) => `${(+p.lat).toFixed(4)},${(+p.lng).toFixed(4)}`;
  win.pawaRoute = {
    table: async (origin, dests) => {
      calls.push({ origin, n: dests.length });
      return dests.map((d) => (roadFor.has(key(d)) ? roadFor.get(key(d)) : null));
    },
  };

  const rowsFor = (q, opts) => ExploreRank.rank(items, ExploreQuery.parse(q), opts).results;

  // h1 (Mbezi) is nearest as the crow flies; give it a long drive.
  roadFor.set(key({ lat: MBEZI.lat, lng: MBEZI.lng }), 26);
  roadFor.set(key({ lat: MBEZI.lat + 0.004, lng: MBEZI.lng }), 1.4);

  ExploreRoads.reset();
  let rows = rowsFor("room for rent", { anchor: MBEZI });
  const straightFirst = rows[0].item.id;
  ok(straightFirst === "h1", "straight line puts h1 first", `got ${straightFirst}`);

  let res = await ExploreRoads.enrich(MBEZI, rows);
  ok(res.changed === 2, "enrich records the measured road distances", `changed=${res.changed}`);
  ok(ExploreRoads.map().get("h1") === 26, "h1 stored as a 26 km drive");
  ok(calls.length === 1, "one matrix request for the whole page, not one per listing",
     `got ${calls.length}`);

  // The payoff: the same query, re-ranked, no longer leads with the listing
  // that is 900 m away and a 26 km drive.
  rows = rowsFor("room for rent", { anchor: MBEZI, roadKm: ExploreRoads.map() });
  ok(rows[0].item.id !== "h1", "road distance demotes the across-the-creek listing",
     `still first: ${rows[0].item.id}`);
  ok(rows.find((r) => r.item.id === "h1")?.item._roadKm === true,
     "the demoted listing is flagged as road-measured (drives the 'by road' label)");

  // A radius is a promise about travel, so it has to mean the road.
  const tight = rowsFor("room for rent", { anchor: MBEZI, radiusKm: 25, roadKm: ExploreRoads.map() });
  ok(!tight.some((r) => r.item.id === "h1"), "a 26 km drive falls outside a 25 km radius");

  // Guard: a road cannot be meaningfully shorter than the straight line. A
  // matrix that says so has snapped to the wrong road, and a confident wrong
  // number is worse than an honest approximate one.
  ExploreRoads.reset();
  roadFor.clear();
  roadFor.set(key({ lat: MWANZA.lat, lng: MWANZA.lng }), 0.5);   // ~1,100 km away
  const far = rowsFor("house for sale", { anchor: MBEZI });
  await ExploreRoads.enrich(MBEZI, far);
  ok(!ExploreRoads.map().has("h3"), "an implausibly short road answer is discarded");

  // Origin-relative data must not survive an origin change.
  ExploreRoads.reset();
  roadFor.clear();
  roadFor.set(key({ lat: MBEZI.lat, lng: MBEZI.lng }), 26);
  await ExploreRoads.enrich(MBEZI, rowsFor("room for rent", { anchor: MBEZI }));
  ok(ExploreRoads.map().size > 0, "measurements exist for the first anchor");
  ExploreRoads.syncAnchor(MWANZA);
  ok(ExploreRoads.map().size === 0,
     "moving the anchor drops distances measured from the old one");

  // No anchor, nothing to measure from.
  ExploreRoads.reset();
  const none = await ExploreRoads.enrich(null, rowsFor("room for rent", {}));
  ok(none.changed === 0, "no anchor means no routing request");

  // A routing service that is down must cost nothing but precision.
  ExploreRoads.reset();
  win.pawaRoute.table = async () => { throw new Error("osrm down"); };
  const broke = await ExploreRoads.enrich(MBEZI, rowsFor("room for rent", { anchor: MBEZI }));
  ok(broke.changed === 0 && broke.stale === false,
     "a failed routing call degrades quietly instead of throwing");
}

// ---- Region browsing --------------------------------------------------------
// Explore lets someone in Dar browse Mwanza as though they lived there. The
// scope has to be a real filter (or the picker does nothing visible) while
// still surviving the region field being blank or spelled another way.
{
  const MWANZA_C = { lat: MWANZA.lat, lng: MWANZA.lng, name: "Mwanza" };

  const inMwanza = search("", { region: "Mwanza", anchor: MWANZA_C });
  ok(inMwanza.out.results.length > 0, "browsing Mwanza returns Mwanza listings");
  ok(ids(inMwanza.out).every((id) => ["h3", "t2"].includes(id)),
     "browsing Mwanza excludes every Dar listing", ids(inMwanza.out).join(","));

  const inDar = search("", { region: "Dar es Salaam", anchor: MBEZI });
  ok(!ids(inDar.out).includes("h3") && !ids(inDar.out).includes("t2"),
     "browsing Dar excludes the Mwanza listings");
  ok(ids(inDar.out).includes("h1"), "browsing Dar keeps the Dar room");

  const everywhere = search("", {});
  ok(everywhere.out.results.length > inMwanza.out.results.length,
     "no region set searches the whole country");

  // Spelling. The region field is typed by hand by hundreds of agents.
  ok(ExploreRank.normRegion("Mkoa wa Dar es Salaam") === ExploreRank.normRegion("DAR ES SALAAM"),
     "'Mkoa wa X' and 'X' normalise to the same region");
  ok(ExploreRank.normRegion("Dar-es-Salaam") === ExploreRank.normRegion("Dar es Salaam"),
     "punctuation does not create a second region");

  // The distance safety net, in both directions of failure.
  const blankRegion = ExploreIndex.fromHouse({
    id: "hx", title: "Room with no region recorded", type: "room", listing: "rent",
    price_tzs: 200000, period: "month", region: "", area: "Nyamagana",
    lat: MWANZA.lat + 0.01, lng: MWANZA.lng + 0.01, created_at: now, owner_user_id: "oX",
  });
  const misspelled = ExploreIndex.fromHouse({
    id: "hy", title: "Room in Mwanzaa", type: "room", listing: "rent",
    price_tzs: 210000, period: "month", region: "Mwanzaa", area: "Nyamagana",
    lat: MWANZA.lat + 0.01, lng: MWANZA.lng + 0.01, created_at: now, owner_user_id: "oY",
  });
  const rescued = ExploreRank.rank([...items, blankRegion, misspelled],
    ExploreQuery.parse(""), { region: "Mwanza", anchor: MWANZA_C });
  ok(ids(rescued).includes("hx"),
     "a listing with no region is kept when its pin puts it inside the region");
  ok(ids(rescued).includes("hy"),
     "a misspelled region is kept when the pin puts it inside the region");

  // ...but the net does not stretch across the country.
  const farBlank = ExploreIndex.fromHouse({
    id: "hz", title: "Room far away, no region", type: "room", listing: "rent",
    price_tzs: 200000, period: "month", region: "", area: "Somewhere",
    lat: MBEZI.lat, lng: MBEZI.lng, created_at: now, owner_user_id: "oZ",
  });
  const notRescued = ExploreRank.rank([...items, farBlank],
    ExploreQuery.parse(""), { region: "Mwanza", anchor: MWANZA_C });
  ok(!ids(notRescued).includes("hz"),
     "a blank region 1,100 km away is NOT rescued into the region");

  // The scope must survive a query, not just an empty search.
  const typed = search("chumba", { region: "Mwanza", anchor: MWANZA_C });
  ok(ids(typed.out).every((id) => ["h3", "t2"].includes(id)),
     "the region scope still applies when words are typed too");
}

// ---- Verdict ----------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
