// ============================================================================
//  _move_shot.mjs — photograph the move planner on a phone.
//
//  Not an assertion suite: tests/truck_move_flow_test.mjs owns the behaviour.
//  This exists because the two things that were wrong with this panel were
//  things you can only see: four buttons overflowing a 390px card, and a
//  measurement that was a number in a pill rather than a picture.
//
//  It runs the panel with a routing engine that ANSWERS (a short synthetic
//  road), because the empty-route path is the one the flow test already walks
//  and the one that draws the least.
//
//  Run: node tests/_move_shot.mjs      (needs `node server.js` up)
//  Writes tests/_move_*.png
// ============================================================================
import puppeteer from "puppeteer";
import fs from "node:fs";

const BASE = process.env.PAWA_BASE || "http://localhost:8080";
const ME = { lat: -6.7724, lng: 39.2083 };

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const HOUSE = {
  id: "fixture", title: "Nyumba ya Kibaha", type: "house", listing: "rent",
  price_tzs: 350000, period: "month", bedrooms: 2, bathrooms: 1,
  region: "Pwani", area: "Kibaha", lat: -6.7700, lng: 38.9200,
  agent: { name: "Neema", phone: "+255700000003" },
};

const TRUCKS = [
  { id: "t-small", title: "Pickup ya Mikocheni", truck_type: "pickup",
    capacity_tonnes: 1, price_tzs: 40000, currency: "TZS", period: "trip",
    driver_included: true, service_area: "within_city",
    region: "Dar es Salaam", area: "Mikocheni", lat: -6.78, lng: 39.22, photos: [],
    owner: { name: "Juma", phone: "+255700000011" } },
  { id: "t-canter", title: "Kanta ya Mwanga", truck_type: "canter",
    capacity_tonnes: 3, price_tzs: 90000, currency: "TZS", period: "trip",
    driver_included: true, loaders_included: true, verified: true,
    service_area: "cross_region", region: "Dar es Salaam", area: "Mikocheni",
    lat: -6.79, lng: 39.23, photos: [], owner: { name: "Mwanga Movers", phone: "+255700000012" } },
  { id: "t-big", title: "Lori kubwa la Temeke", truck_type: "10ton_plus",
    capacity_tonnes: 12, price_tzs: 450000, currency: "TZS", period: "trip",
    driver_included: true, loaders_included: true, service_area: "cross_region",
    region: "Dar es Salaam", area: "Temeke", lat: -6.90, lng: 39.30, photos: [],
    owner: { name: "Temeke Haulage", phone: "+255700000013" } },
];

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
await page.setViewport({ width: 390, height: 900, deviceScaleFactor: 2 });
await page.setRequestInterception(true);
page.on("request", (req) => {
  const u = req.url();
  if (req.method() === "OPTIONS") {
    return req.respond({ status: 204, headers: {
      "access-control-allow-origin": "*", "access-control-allow-headers": "*",
      "access-control-allow-methods": "*" } });
  }
  if (u.startsWith(BASE) || /^(data|blob|about):/i.test(u)) return req.continue();
  // maplibre itself loads for real; everything it then asks for does not.
  if (/cdn\.jsdelivr\.net\/npm\/maplibre-gl/.test(u)) return req.continue();
  const kind = req.resourceType();
  if (kind === "image") {
    return req.respond({ status: 200, headers: {
      "content-type": "image/png", "access-control-allow-origin": "*" }, body: PIXEL });
  }
  if (kind === "script" || kind === "stylesheet") {
    return req.respond({ status: 200, headers: {
      "content-type": kind === "script" ? "application/javascript" : "text/css",
      "access-control-allow-origin": "*" }, body: "" });
  }
  return req.respond({ status: 200, headers: {
    "content-type": "application/json", "access-control-allow-origin": "*" }, body: "[]" });
});

await page.evaluateOnNewDocument((house, trucks, fix) => {
  try {
    localStorage.clear();
    localStorage.setItem("lang", "en");
    localStorage.setItem("pawa_last_pos", JSON.stringify({ ...fix, at: Date.now() }));
    // One saved place, so the picker has something to offer beside the GPS
    // button: the door this whole change is about.
    localStorage.setItem("pawa_house_my_places", JSON.stringify([
      { name: "Kariakoo shop", kind: "work", lat: -6.8161, lng: 39.2803, mode: "car" },
    ]));
  } catch (_) {}

  let ds;
  Object.defineProperty(window, "DataStore", {
    configurable: true,
    get() { return ds; },
    set(v) {
      ds = v;
      if (!v) return;
      v.getHouses = async () => [house];
      v.getTrucks = async () => trucks;
    },
  });

  let loc;
  Object.defineProperty(window, "pawaLocate", {
    configurable: true,
    get() { return loc; },
    set(v) {
      loc = v;
      if (!v) return;
      v.best = async () => ({ ...fix, accuracy: 20, at: Date.now() });
      v.bestOrApprox = async () => ({ ...fix, accuracy: 20, at: Date.now() });
      v.lastKnown = () => ({ ...fix, at: Date.now() });
    },
  });

  // A routing engine that answers. The geometry is a straight interpolation,
  // which is not a road, which is why this file is a camera and not a test.
  // Intercepted on ASSIGNMENT, not planted: geo.js sets window.pawaRoute when
  // it loads and a planted value is simply overwritten by the real one, which
  // then goes to a network this run does not have.
  const fake = {
      table: async (o, pts) => pts.map((p) => {
        const dx = (p.lng - o.lng) * 111 * Math.cos(o.lat * Math.PI / 180);
        const dy = (p.lat - o.lat) * 111;
        return Math.sqrt(dx * dx + dy * dy) * 1.3;
      }),
      route: async (a, b) => {
        const dx = (b.lng - a.lng) * 111 * Math.cos(a.lat * Math.PI / 180);
        const dy = (b.lat - a.lat) * 111;
        const km = Math.sqrt(dx * dx + dy * dy) * 1.3;
        const coords = [];
        for (let i = 0; i <= 12; i++) {
          coords.push([a.lng + (b.lng - a.lng) * (i / 12),
                       a.lat + (b.lat - a.lat) * (i / 12)]);
        }
        return { km, durationMin: km * 2.2, geojson: { type: "LineString", coordinates: coords } };
      },
  };
  Object.defineProperty(window, "pawaRoute", {
    configurable: true,
    get() { return fake; },
    set() { /* geo.js may keep its own copy; this page uses ours */ },
  });
}, HOUSE, TRUCKS, ME);

await page.goto(`${BASE}/house.html?id=fixture`, { waitUntil: "networkidle2" });
await page.waitForSelector("#hdMovePanel .tm-go", { timeout: 20000 });

// Before: the planner as it opens, with the picker shut.
const panel = await page.$("#sec-move");
await panel.screenshot({ path: "tests/_move_1_planner.png" });

// The picker, open. This is the flexibility the panel did not have.
await page.click("#tmFromBtn");
await new Promise((r) => setTimeout(r, 400));
await panel.screenshot({ path: "tests/_move_2_doors.png" });
await page.click("#tmFromBtn");

// The answer: the measurement map, the legend, and the cards.
//
// Clicked IN THE PAGE, not through puppeteer's mouse. The property sheet has a
// fixed call bar across the foot of the screen, so the point puppeteer scrolls
// this button to is covered by it and the click lands on "WhatsApp". An hour
// went into that; elementFromPoint said so in one line.
await page.evaluate(() => document.querySelector("#hdMovePanel [data-tm-go]").click());
await page.waitForFunction(
  () => document.querySelectorAll("#hdMovePanel .tm-card").length > 0,
  { timeout: 20000 });
await page.waitForFunction(
  () => {
    const el = document.querySelector("#hdMovePanel [data-tm-measure]");
    return el && !el.hidden && el.querySelectorAll(".tm-measure__leg").length >= 2;
  },
  { timeout: 20000 });
await new Promise((r) => setTimeout(r, 1800));
await panel.screenshot({ path: "tests/_move_3_answer.png" });

// And the place section at the top, with the reader on the map.
const place = await page.$("#sec-place");
if (place) await place.screenshot({ path: "tests/_move_4_place.png" });

const heights = await page.evaluate(() => {
  const card = document.querySelector("#hdMovePanel .tm-card");
  const wide = [...document.querySelectorAll("#sec-move *")]
    .filter((el) => el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0)
    .map((el) => el.className + " " + el.scrollWidth + ">" + el.clientWidth);
  return { card: card ? Math.round(card.getBoundingClientRect().height) : null, overflow: wide.slice(0, 8) };
});

console.log("card height:", heights.card, "px");
console.log("overflowing:", heights.overflow.length ? heights.overflow : "none");
console.log("console errors:", errs.length ? errs : "none");
console.log("wrote", fs.readdirSync("tests").filter((f) => f.startsWith("_move_")).join(", "));
await browser.close();
