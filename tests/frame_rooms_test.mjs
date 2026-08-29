// ============================================================================
//  The Frame — business rooms
//
//  A Frame is "a room for business", so the page has to show the rooms that
//  ARE one. It used to decide from `type`, `title` and `room_kind` alone, and
//  `room_kind` carries the CHEAPEST room (house-spec.cheapest(), for the
//  "from TZS …" headline), not the nature of the building. So the first test
//  it ran was:
//
//      if (roomKind === "single" || roomKind === "master") return false;
//
//  which threw away every plot that rents rooms AND a duka — which, on a
//  Tanzanian street, is most of them. details.rooms is now what decides.
//
//  Everything external is answered locally, so this spends no quota and does
//  not depend on Overpass being up. See the browser-test recipe.
//
//  Usage: node server.js   then:  node tests/frame_rooms_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
const HERE = { lat: -6.7924, lng: 39.2789 };          // Dar es Salaam

// Five listings that between them cover every way a business room can be
// stored, and one residential building that must stay out.
const HOUSES = [
  // THE CASE THAT WAS BROKEN: cheapest room is a single, so room_kind is
  // "single", but the plot rents two lockups and an office as well.
  { id: "h1", title: "Mwenge plot, Sam Nujoma road", type: "house", room_kind: "single",
    price_tzs: 60000, period: "month", listing: "rent", lat: -6.7890, lng: 39.2810,
    available: true, details: { v: 1, rooms: [
      { kind: "single", price: 60000, period: "month", count: 4, vacant: 2 },
      { kind: "shop_frame", price: 320000, period: "month", count: 2, vacant: 1 },
      { kind: "office_suite", price: 450000, period: "month", count: 1, vacant: 0 },
    ] } },
  { id: "h2", title: "Kariakoo godown", type: "warehouse", room_kind: null,
    price_tzs: 1800000, period: "month", listing: "rent", lat: -6.7960, lng: 39.2830,
    available: true, details: { v: 1, rooms: [
      { kind: "godown", price: 1800000, period: "month", count: 1, vacant: 1 },
    ] } },
  // Qualifies on type, but its agent never filled the rooms table in. It must
  // still get a row, standing for the whole place.
  { id: "h3", title: "Shop with no room breakdown", type: "shop", room_kind: null,
    price_tzs: 250000, period: "month", listing: "rent", lat: -6.8010, lng: 39.2700,
    available: true, details: null },
  // Purely residential. Must NOT appear.
  { id: "h4", title: "Family house, Kinondoni", type: "house", room_kind: "master",
    price_tzs: 400000, period: "month", listing: "rent", lat: -6.7880, lng: 39.2760,
    available: true, details: { v: 1, rooms: [
      { kind: "master", price: 400000, period: "month", count: 3, vacant: 1 },
    ] } },
  // Room kind is free text; production already holds one that is a place name.
  // A Swahili word for a shop has to be caught by the words, not the keys.
  { id: "h5", title: "Mbezi roadside", type: "house", room_kind: "single",
    price_tzs: 80000, period: "month", listing: "rent", lat: -6.7955, lng: 39.2745,
    available: true, details: { v: 1, rooms: [
      { kind: "single", price: 80000, period: "month", count: 2, vacant: 0 },
      { kind: "duka la barabarani", price: 150000, period: "month", count: 1, vacant: 1 },
    ] } },
];

const OVERPASS = { elements: [
  { type: "node", id: 1, lat: -6.7905, lon: 39.2800, tags: { amenity: "marketplace", name: "Mwenge Market" } },
  { type: "node", id: 2, lat: -6.7930, lon: 39.2770, tags: { amenity: "bus_station", name: "Mwenge Bus Stand" } },
  { type: "node", id: 3, lat: -6.7890, lon: 39.2820, tags: { amenity: "bank", name: "CRDB" } },
  { type: "node", id: 4, lat: -6.7940, lon: 39.2810, tags: { amenity: "pharmacy", name: "Duka la Dawa" } },
  { type: "node", id: 5, lat: -6.7910, lon: 39.2760, tags: { amenity: "restaurant", name: "Mama Lishe" } },
  { type: "way", id: 100, tags: { highway: "primary", name: "Sam Nujoma Road" },
    geometry: [{ lat: -6.7860, lon: 39.2700 }, { lat: -6.7900, lon: 39.2780 }, { lat: -6.7940, lon: 39.2850 }] },
  { type: "way", id: 101, tags: { highway: "secondary", name: "Ali Hassan Mwinyi Road" },
    geometry: [{ lat: -6.8000, lon: 39.2680 }, { lat: -6.7960, lon: 39.2760 }, { lat: -6.7920, lon: 39.2840 }] },
] };

const stub = `window.supabase={createClient:function(){
var H=${JSON.stringify(HOUSES)};
function q(tbl){var b={_t:tbl};["select","eq","neq","gt","gte","lt","lte","is","or","order","limit","in"].forEach(function(m){b[m]=function(){return b}});
b.then=function(r,j){return Promise.resolve({data:b._t==="houses"?H:[],error:null}).then(r,j)};return b}
return{rpc:function(){return Promise.resolve({data:[],error:null})},from:q,
auth:{getSession:function(){return Promise.resolve({data:{session:null},error:null})},
getUser:function(){return Promise.resolve({data:{user:null},error:null})},
onAuthStateChange:function(){return{data:{subscription:{unsubscribe:function(){}}}}}},
channel:function(){return{on:function(){return this},subscribe:function(){return this}}},removeChannel:function(){},
storage:{from:function(){return{getPublicUrl:function(){return{data:{publicUrl:""}}}}}}}}};`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

let passed = 0;
const fails = [];
const ok = (cond, what, detail) => {
  if (cond) { passed++; console.log("  PASS  " + what); }
  else { fails.push(what); console.log("  FAIL  " + what); if (detail) console.log("        " + detail); }
};

// Leaflet comes off a CDN on every load. Fetch it once and serve it, so a
// network hiccup reports itself instead of looking like a missing panel.
const LIBS = new Map();
try {
  const url = "https://cdn.jsdelivr.net/npm/leaflet@1.9/dist/leaflet.js";
  const r = await fetch(url);
  if (r.ok) LIBS.set(url, Buffer.from(await r.arrayBuffer()));
} catch (e) { /* fall through to the live CDN */ }

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 180000 });
const ctx = await browser.createBrowserContext();
await ctx.overridePermissions(BASE, ["geolocation"]);
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.setViewport({ width: 390, height: 1000 });
await page.setGeolocation({ latitude: HERE.lat, longitude: HERE.lng, accuracy: 20 });
await page.setRequestInterception(true);
page.on("request", (r) => {
  const u = r.url();
  const json = (o) => r.respond({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify(o) });
  if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } });
  if (LIBS.has(u)) return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: LIBS.get(u) });
  if (/cdn\.jsdelivr\.net.*supabase/.test(u)) return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: stub });
  if (/overpass/.test(u)) return json(OVERPASS);
  if (/locationiq|nominatim/.test(u)) return json({ address: { suburb: "Mwenge", state: "Dar es Salaam" }, display_name: "Mwenge, Dar es Salaam" });
  if (/osrm/.test(u)) return json({ code: "Ok", durations: [[0]], distances: [[0]] });
  if (/maptiler|mapbox|arcgisonline|cartocdn|tile\.openstreetmap/.test(u))
    return r.respond({ status: 200, headers: { "content-type": "image/png", "access-control-allow-origin": "*" }, body: PNG });
  if (/supabase\.co/.test(u)) return json([]);
  if (/fonts\.googleapis|fonts\.gstatic/.test(u)) return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
  r.continue();
});

await page.goto(BASE + "/frame.html", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => !!window.HouseSpec && !!window.initFramePage, { timeout: 30000 });

// ---------------------------------------------------------------------------
console.log("\n1. HouseSpec knows a business room when it sees one");
{
  const r = await page.evaluate(() => {
    const S = window.HouseSpec;
    return {
      keys: ["shop_frame", "kiosk", "office_suite", "godown", "hall", "parking_bay"].every(S.isBusinessKind),
      residential: ["single", "master", "whole_house", "two_bedroom"].some(S.isBusinessKind),
      swahili: S.isBusinessKind("duka la barabarani") && S.isBusinessKind("frem ya biashara") && S.isBusinessKind("ghala kubwa"),
      placeName: S.isBusinessKind("mwembe radu"),
      blank: S.isBusinessKind("") || S.isBusinessKind(null),
    };
  });
  ok(r.keys, "every business room key is one");
  ok(!r.residential, "and no residential kind is");
  ok(r.swahili, "the Swahili words an agent actually types are caught");
  ok(!r.placeName, "a place name typed into the kind box is not");
  ok(!r.blank, "and a blank kind is not a business room");
}

// ---------------------------------------------------------------------------
console.log("\n2. The panel lists rooms, not buildings");
await page.click("#frLocateBtn");
await page.waitForFunction(
  () => document.querySelectorAll(".fr-room-row").length > 0 || document.querySelector(".fr-rooms-none"),
  { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1200));
{
  const r = await page.evaluate(() => ({
    head: document.querySelector(".fr-rooms-head b")?.textContent.trim() || "",
    kinds: [...document.querySelectorAll(".fr-room-kind")].map((e) => e.textContent.trim()),
    places: [...document.querySelectorAll(".fr-room-place")].map((e) => e.textContent.trim()),
    roads: [...document.querySelectorAll(".fr-room-road")].map((e) => e.textContent.trim()),
    prices: [...document.querySelectorAll(".fr-room-price")].map((e) => e.textContent.trim()),
    vacs: [...document.querySelectorAll(".fr-room-vac")].map((e) => e.textContent.trim()),
    icons: document.querySelectorAll(".fr-room-ic svg").length,
    rows: document.querySelectorAll(".fr-room-row").length,
  }));

  ok(r.rows === 5, "five business rooms across four places", `${r.rows} rows: ${r.kinds.join(" | ")}`);
  ok(/5 business rooms in 4 places/.test(r.head), "and the heading says both numbers", r.head);

  // The regression this file exists for.
  ok(r.kinds.includes("Shop / frame"),
     "the shop frame in a plot whose CHEAPEST room is a single is listed", r.kinds.join(" | "));
  ok(r.kinds.includes("Office suite"),
     "and the office suite in that same plot is its own row, not folded into it");
  ok(r.places.filter((p) => /Mwenge plot/.test(p)).length === 2,
     "both rows name the place they are in");

  ok(r.kinds.some((k) => /Duka La Barabarani/i.test(k)),
     "a free-text Swahili room kind is listed too", r.kinds.join(" | "));
  ok(r.kinds.includes("Godown / store"), "a whole-building godown is listed");
  ok(r.kinds.some((k) => /Shop \/ business/.test(k)),
     "so is a listing that qualifies on type but has no room breakdown");
  ok(!r.places.some((p) => /Family house/.test(p)),
     "and the residential house stays out", r.places.join(" | "));

  ok(r.icons === 5, "every row carries a stroke icon, never an emoji", String(r.icons));
  ok(r.roads.every((x) => /\d+\s*(m|km)\s/.test(x)),
     "each room is measured to its nearest road", r.roads.join(" | "));
  const metres = r.roads.map((x) => parseInt(x, 10));
  ok(metres.every((m, i) => i === 0 || m >= metres[i - 1]),
     "closest to a road first, because that ordering is the advice", metres.join(" < "));
  ok(r.prices.every((p) => /^TZS /.test(p)), "every room shows its own price", r.prices.join(" | "));

  // "1 of 1 free" is a fraction nobody needs.
  ok(r.vacs.includes("free") && r.vacs.includes("taken"),
     "a single space says free or taken, without a fraction", r.vacs.join(" | "));
  ok(r.vacs.includes("1 of 2 free"),
     "and a room with several says how many of how many", r.vacs.join(" | "));
}

// ---------------------------------------------------------------------------
console.log("\n3. The frame's own heading is not the size of a list row");
{
  // `.fr-frame-name` was declared twice: once for this heading, then again for
  // the old list rows, which came later and won. The heading rendered at
  // .88rem with an ellipsis for months.
  const px = await page.evaluate(() => {
    const el = document.querySelector(".fr-frame-name");
    return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
  });
  ok(px > 16, "it reads at heading size", px + "px");
}

ok(errs.length === 0, "no page errors across the whole run", errs.slice(0, 2).join(" | "));

console.log("\n" + passed + " passed, " + fails.length + " failed");
await browser.close();
process.exit(fails.length ? 1 : 0);
