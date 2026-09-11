// ============================================================================
//  truck_move_flow_test.mjs — pressing one button on a listing finds a lorry.
//
//  WHAT IT WALKS
//  The join this feature exists for, end to end, in a real browser:
//
//    1. house.html draws a "Moving your things here" section, and one press
//       ranks the trucks with the reader's own position in the ranking.
//    2. The cards say WHY: how far the lorry is, whether it fits the load,
//       whether the trip is inside what the owner offers.
//    3. The Google Maps link on a card is COMPLETE. This is the assertion
//       worth having: the feature's whole promise is that nobody types an
//       address twice, and the failure mode is a link that opens Google Maps
//       asking where you are starting from. So it is checked parameter by
//       parameter: an origin, a waypoint and a destination, all three.
//    4. "See every truck" carries the plan to trucks.html in the query string,
//       and that page opens with the plan already answered and ranked.
//
//  WHY A BROWSER AND NOT THE vm HARNESS
//  tests/truck_match_test.mjs already covers the ranking itself, which is pure
//  arithmetic. What cannot be checked there is whether the two pages actually
//  hand the plan to each other, and that is exactly the seam a feature spread
//  over two screens breaks at.
//
//  Run: node tests/truck_move_flow_test.mjs   (needs `node server.js` up)
// ============================================================================
import puppeteer from "puppeteer";

const BASE = process.env.PAWA_BASE || "http://localhost:8080";

// Mikocheni, Dar es Salaam. The reader is standing here.
const ME = { lat: -6.7724, lng: 39.2083 };

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

// house.html builds a maplibre map with no guard that the library loaded, so
// with the CDN unreachable the sheet throws before it finishes. Same stub as
// tests/detail_sheet_i18n_test.mjs: answer any property, call or construction
// with another stub so the map code runs to completion drawing nothing.
const MAPLIBRE_STUB = `(function () {
  var noop = function () {};
  function make() {
    return new Proxy(noop, {
      get: function (t, k) {
        if (k === "then") return undefined;
        if (typeof k === "symbol") return undefined;
        if (k === "toString" || k === "valueOf") return function () { return ""; };
        return make();
      },
      apply: function () { return make(); },
      construct: function () { return make(); },
      set: function () { return true; },
    });
  }
  window.maplibregl = make();
})();`;

// The new home: Kibaha, about 32 km out and in the next region.
const HOUSE = {
  id: "fixture", title: "Nyumba ya Kibaha", type: "house", listing: "rent",
  price_tzs: 350000, period: "month", bedrooms: 2, bathrooms: 1,
  region: "Pwani", area: "Kibaha", lat: -6.7700, lng: 38.9200,
  agent: { name: "Neema", phone: "+255700000003" },
};

const TRUCKS = [
  { id: "t-small", title: "Pickup ya Mikocheni", truck_type: "pickup",
    capacity_tonnes: 1, price_tzs: 40000, currency: "TZS", period: "trip",
    negotiable: true, driver_included: true, loaders_included: false,
    service_area: "within_city", region: "Dar es Salaam", area: "Mikocheni",
    lat: -6.78, lng: 39.22, photos: [], owner: { name: "Juma", phone: "+255700000011" },
    details: { v: 1, kit: ["closed_body", "straps"] } },
  { id: "t-canter", title: "Kanta ya Mwanga", truck_type: "canter",
    capacity_tonnes: 3, price_tzs: 90000, currency: "TZS", period: "trip",
    negotiable: true, driver_included: true, loaders_included: true, verified: true,
    service_area: "cross_region", region: "Dar es Salaam", area: "Mikocheni",
    lat: -6.79, lng: 39.23, photos: [], owner: { name: "Mwanga Movers", phone: "+255700000012" },
    details: { v: 1, kit: ["driver", "loaders", "tarpaulin", "Tairi mbili za akiba safari ndefu"] } },
  { id: "t-big", title: "Lori kubwa la Temeke", truck_type: "10ton_plus",
    capacity_tonnes: 12, price_tzs: 450000, currency: "TZS", period: "trip",
    negotiable: false, driver_included: true, loaders_included: true,
    service_area: "cross_region", region: "Dar es Salaam", area: "Temeke",
    lat: -6.90, lng: 39.30, photos: [], owner: { name: "Temeke Haulage", phone: "+255700000013" },
    details: { v: 1, kit: ["flatbed", "tail_lift"] } },
];

let pass = 0;
const fails = [];
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); return; }
  fails.push(detail ? msg + "\n        " + detail : msg);
  console.log("  FAIL  " + msg + (detail ? "\n        " + detail : ""));
};

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });

/** A page with the fixtures in it, the network stubbed, and a GPS fix planted. */
async function open(path, opts = {}) {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
  await page.setViewport({ width: 412, height: 915 });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const u = req.url();
    if (req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*",
        "access-control-allow-methods": "*" } });
    }
    if (!u.startsWith(BASE) && !/^(data|blob|about):/i.test(u)) {
      const kind = req.resourceType();
      if (kind === "image") {
        return req.respond({ status: 200, headers: {
          "content-type": "image/png", "access-control-allow-origin": "*" }, body: PIXEL });
      }
      if (kind === "script") {
        if (/maplibre/i.test(u)) {
          return req.respond({ status: 200, headers: {
            "content-type": "application/javascript", "access-control-allow-origin": "*" }, body: MAPLIBRE_STUB });
        }
        return req.respond({ status: 200, headers: {
          "content-type": "application/javascript", "access-control-allow-origin": "*" }, body: "" });
      }
      if (kind === "stylesheet") {
        return req.respond({ status: 200, headers: {
          "content-type": "text/css", "access-control-allow-origin": "*" }, body: "" });
      }
      return req.respond({ status: 200, headers: {
        "content-type": "application/json", "access-control-allow-origin": "*" }, body: "[]" });
    }
    req.continue();
  });

  await page.evaluateOnNewDocument((house, trucks, fix) => {
    try {
      localStorage.clear();
      localStorage.setItem("lang", "en");
      // A remembered fix, so nothing here waits on a permission prompt that a
      // headless browser will never answer. pawaLocate.lastKnown() reads this
      // key; best() is overridden below for the same reason.
      localStorage.setItem("pawa_last_pos", JSON.stringify({ ...fix, at: Date.now() }));
    } catch (_) {}

    // Catch DataStore the instant the page assigns it rather than polling for
    // it: a poll loses the race to the page's own init() often enough on this
    // host to make the suite flaky.
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

    // Same trick for the locator. The real one opens a six-second watch and
    // then rejects, which is a slow way to test nothing.
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

    // No routing engine is reachable here. Returning null is the HONEST answer
    // this library is built to survive, and testing that path is the point:
    // a road we could not measure must never become a straight line wearing a
    // "by road" label.
    window.__routeCalls = 0;
    Object.defineProperty(window, "pawaRoute", {
      configurable: true,
      writable: true,
      value: {
        table: async (o, pts) => { window.__routeCalls++; return pts.map(() => null); },
        route: async () => null,
      },
    });
  }, HOUSE, TRUCKS, ME);

  let navErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(`${BASE}/${path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      navErr = null;
      break;
    } catch (e) { navErr = e; }
  }
  if (navErr) throw navErr;
  await new Promise((r) => setTimeout(r, opts.wait || 2200));
  return { page, errs };
}

/** Wait for a condition in the page rather than for a clock. */
async function until(page, fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// ---------------------------------------------------------------------------
console.log("\n1. house.html offers the move, and one press answers it\n");
{
  const { page, errs } = await open("house.html?id=fixture");

  ok(await page.$("#sec-move") !== null, "the property sheet has a 'moving in' section");
  ok(await page.$("#hdMovePanel .tm-load") !== null, "with a load-size picker on it");

  // The load size is guessed from the listing's own bedroom count, so the
  // reader starts from a sensible answer rather than an empty picker.
  const preset = await page.evaluate(() =>
    document.querySelector('#hdMovePanel [data-tm-load][aria-pressed="true"]')?.dataset.tmLoad);
  ok(preset === "two_bed", "a two-bedroom listing preselects a two-bedroom load", String(preset));

  // Nothing should be on screen before the press: no list, and no empty pill
  // where the trip readout will go.
  const cardsBefore = await page.evaluate(() => document.querySelectorAll("#hdMovePanel .tm-card").length);
  ok(cardsBefore === 0, "and no trucks until it is asked for", String(cardsBefore));
  const pillShown = await page.evaluate(() => {
    const el = document.querySelector("#hdMovePanel [data-tm-trip]");
    return el ? getComputedStyle(el).display !== "none" : false;
  });
  ok(!pillShown, "the trip readout stays hidden until there is a trip to report");

  await page.click("#hdMovePanel [data-tm-go]");
  const drew = await until(page, () => document.querySelectorAll("#hdMovePanel .tm-card").length > 0);
  ok(drew, "pressing it draws the matches");

  const cards = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#hdMovePanel .tm-card")).map((c) => ({
      title: c.querySelector(".tm-card__title")?.textContent.trim(),
      best: c.classList.contains("is-best"),
      chips: Array.from(c.querySelectorAll(".tm-fit")).map((x) => x.textContent.trim()),
      maps: c.querySelector(".tm-act--map")?.getAttribute("href") || "",
    })));

  ok(cards.length > 0, "there are cards", JSON.stringify(cards).slice(0, 200));
  ok(cards[0].best, "the first one is marked as the recommendation");
  ok(cards[0].title === "Kanta ya Mwanga",
     "and it is the right-sized canter, not the twelve-tonne lorry",
     cards.map((c) => c.title).join(" | "));

  const chips = cards[0].chips.join(" | ");
  ok(/Fits Two-bedroom home/.test(chips), "a chip says it fits the load", chips);
  ok(/Covers this trip/.test(chips), "and that the owner covers this trip", chips);
  ok(/Driver included/.test(chips) && /Loaders included/.test(chips),
     "and who comes with it", chips);

  // The honesty rule, checked where it actually bites: no routing engine
  // answered, so nothing may claim a road distance.
  ok(!/\d+(\.\d+)?\s*km away/.test(chips) && !/\d+\s*m away/.test(chips),
     "with no routing engine, no card claims a road distance it does not have", chips);

  // The whole point of the feature.
  const maps = cards[0].maps;
  ok(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1/.test(maps),
     "the card's route link is a Google Maps directions link", maps);
  const q = new URL(maps).searchParams;
  ok(!!q.get("origin"), "it carries an origin, so nobody is asked where they are starting from", maps);
  ok(!!q.get("waypoints"), "it stops at the pickup on the way", maps);
  const dest = (q.get("destination") || "").split(",").map(Number);
  ok(Math.abs(dest[0] - HOUSE.lat) < 1e-4 && Math.abs(dest[1] - HOUSE.lng) < 1e-4,
     "and its destination is this property", maps);
  const via = (q.get("waypoints") || "").split(",").map(Number);
  ok(Math.abs(via[0] - ME.lat) < 1e-4 && Math.abs(via[1] - ME.lng) < 1e-4,
     "the stop on the way is where the reader is standing", maps);

  // The hand-off to the directory.
  const all = await page.evaluate(() =>
    document.querySelector("#hdMovePanel [data-tm-all]")?.getAttribute("href") || "");
  ok(/^trucks\.html\?/.test(all), "there is a link to every truck for this move", all);
  const aq = new URLSearchParams(all.split("?")[1] || "");
  ok(aq.get("load") === "two_bed" && aq.get("house") === "fixture" && !!aq.get("to") && !!aq.get("from"),
     "and it carries the whole plan, so the next page asks nothing twice", all);

  ok(errs.length === 0, "no console errors on the property sheet", errs.slice(0, 3).join(" | "));

  await page.screenshot({ path: "shots/house_move_panel.png", fullPage: false });
  await page.close();
  var CARRIED = all;
}

// ---------------------------------------------------------------------------
console.log("\n2. trucks.html opens with the plan already answered\n");
{
  const { page, errs } = await open(CARRIED);

  const legs = await page.evaluate(() => ({
    from: document.querySelector("#tkFromValue")?.textContent.trim(),
    to: document.querySelector("#tkToValue")?.textContent.trim(),
    load: document.querySelector('#tkLoads [data-tm-load][aria-pressed="true"]')?.dataset.tmLoad,
  }));
  ok(legs.load === "two_bed", "the load size came across", JSON.stringify(legs));
  ok(legs.from === "Where you are now", "so did the pickup", JSON.stringify(legs));
  // The NAME, not the fallback. encode() carries `toName`, so the directory can
  // say "Kibaha, Pwani" rather than "the place you picked" — which is the
  // difference between a plan the reader recognises and a plan they have to
  // take on trust.
  ok(legs.to === "Kibaha, Pwani", "and the destination, by name", JSON.stringify(legs));

  const listed = await until(page, () => document.querySelectorAll("#trucksList .tm-card").length > 0);
  ok(listed, "the ranked list is already on screen, with nothing pressed");

  const order = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#trucksList .tm-card__title")).map((x) => x.textContent.trim()));
  ok(order[0] === "Kanta ya Mwanga", "ranked the same way as on the property sheet", order.join(" | "));

  // The filters are the other half of "lots of options", and they have to be
  // built from the same vocabulary the listing form writes.
  const specChips = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-tk-spec]")).map((b) => b.textContent.trim()));
  ok(specChips.includes("Tarpaulin over the load") && specChips.includes("Tail lift"),
     "the spec filters are built from the listing form's own catalogue",
     specChips.slice(0, 6).join(" | "));

  // Filtering on a characteristic must actually narrow the list.
  await page.evaluate(() => document.querySelector('[data-tk-spec="tarpaulin"]').click());
  await new Promise((r) => setTimeout(r, 400));
  const afterFilter = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#trucksList .tm-card__title")).map((x) => x.textContent.trim()));
  ok(afterFilter.length === 1 && afterFilter[0] === "Kanta ya Mwanga",
     "and ticking one leaves only the trucks that have it", afterFilter.join(" | "));

  await page.evaluate(() => document.querySelector('[data-tk-spec="tarpaulin"]').click());
  await new Promise((r) => setTimeout(r, 400));
  const restored = await page.evaluate(() => document.querySelectorAll("#trucksList .tm-card").length);
  ok(restored === 3, "un-ticking it brings them back", String(restored));

  // Sort, which is the other thing a directory owes a reader.
  await page.select("#truckSort", "cheapest");
  await new Promise((r) => setTimeout(r, 400));
  const cheapestFirst = await page.evaluate(() =>
    document.querySelector("#trucksList .tm-card__title")?.textContent.trim());
  ok(cheapestFirst === "Pickup ya Mikocheni", "sorting by price puts the cheapest first", String(cheapestFirst));

  ok(errs.length === 0, "no console errors on the directory", errs.slice(0, 3).join(" | "));

  await page.screenshot({ path: "shots/trucks_planned.png", fullPage: false });
  await page.close();
}

// ---------------------------------------------------------------------------
console.log("\n3. truck.html measures one lorry against the same plan\n");
{
  const q = CARRIED.split("?")[1];
  const { page, errs } = await open(`truck.html?id=t-canter&${q}`);

  ok(await page.$("#tdMovePanel") !== null, "the detail sheet has a 'your move' panel");
  const chips = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#tdMoveBody .tm-fit")).map((x) => x.textContent.trim()));
  ok(chips.some((c) => /Fits Two-bedroom home/.test(c)),
     "and it already answers, because the plan arrived with the reader", chips.join(" | "));

  // The kit list is grouped now, and the owner's own sentence survives it.
  const groups = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".td-kit-group h4")).map((h) => h.textContent.trim()));
  ok(groups.length >= 2, "what comes with it is grouped, not one flat wall", groups.join(" | "));
  ok(groups.includes("In their own words"),
     "including a group for what the owner typed themselves", groups.join(" | "));
  const own = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".of-list li")).map((li) => li.textContent.trim()));
  ok(own.includes("Tairi mbili za akiba safari ndefu"),
     "and that sentence comes back exactly as typed", own.join(" | "));

  // The back button must not drop the plan on the floor.
  const back = await page.evaluate(() => document.getElementById("tdBack")?.getAttribute("href") || "");
  ok(/^trucks\.html\?/.test(back) && /load=two_bed/.test(back),
     "going back carries the move with it", back);

  ok(errs.length === 0, "no console errors on the detail sheet", errs.slice(0, 3).join(" | "));
  await page.close();
}

await browser.close();
console.log("");
fails.forEach((f) => console.log("  FAIL  " + f));
console.log("\n" + pass + " passed, " + fails.length + " failed\n");
process.exit(fails.length ? 1 : 0);
