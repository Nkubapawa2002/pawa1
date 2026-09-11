// ============================================================================
//  house_directions_test.mjs — "take me there", on the rendered house sheet.
//
//  The hand-off to Google Maps is the one feature on this page whose failure is
//  completely invisible from the code: the link still opens Google Maps. It
//  just opens it on a screen asking where you are starting from, which is the
//  question the app spent the whole page answering. So every assertion here is
//  about what is IN the URL, read off the real anchor in the real sheet.
//
//  Each is a claim the old sheet got wrong:
//
//    · "Get directions" carried a destination and NOTHING else
//    · so did the other eight Google Maps links in the repo
//    · the workplace saved once on houses.html was never read here, so the
//      commute box asked for it again on every single listing
//    · the three labels under the map were hardcoded English on a bilingual app
//
//  Run: node tests/house_directions_test.mjs   (needs `node server.js` up)
// ============================================================================
import puppeteer from "puppeteer";

const BASE = process.env.PAWA_BASE || "http://localhost:8080";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

// house-place.js constructs a maplibregl.Map unconditionally, so with the CDN
// unreachable the sheet throws before it ever reaches the commute tool. Same
// stub as tests/detail_sheet_i18n_test.mjs: answer every property, call and
// construction with another stub so the map code runs and draws nothing.
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
      construct: function () { return make(); }
    });
  }
  window.maplibregl = make();
})();`;

let pass = 0;
const fails = [];
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); return; }
  fails.push(detail ? msg + "\n        " + detail : msg);
  console.log("  FAIL  " + msg + (detail ? "\n        " + detail : ""));
};

const HOUSE = {
  id: "fixture", title: "Nyumba ya Mikocheni", type: "apartment",
  listing: "rent", price_tzs: 450000, period: "month",
  bedrooms: 2, bathrooms: 1, region: "Dar es Salaam", area: "Mikocheni",
  lat: -6.7724, lng: 39.2083, verified: true,
  agent: { name: "Neema", phone: "+255700000003" },
  details: { v: 1, rooms: [{ kind: "master", price: 450000, period: "month",
    count: 1, vacant: 1, sizeBand: "medium", features: ["bath_inside"] }], groups: [] },
};

// What "Match to my life" on houses.html writes. Same key, same shape.
const MY_PLACES = [
  { id: "mp-a", kind: "fav",  name: "Kariakoo",  lat: -6.8180, lng: 39.2760, mode: "daladala" },
  { id: "mp-b", kind: "work", name: "Muhimbili", lat: -6.8010, lng: 39.2700, mode: "bajaji" },
];

const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
});

async function render({ lang = "en", places = null, fix = null } = {}) {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
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
      if (kind === "image") return req.respond({ status: 200, headers: {
        "content-type": "image/png", "access-control-allow-origin": "*" }, body: PIXEL });
      if (kind === "script") return req.respond({ status: 200, headers: {
        "content-type": "application/javascript", "access-control-allow-origin": "*" },
        body: /maplibre/i.test(u) ? MAPLIBRE_STUB : "" });
      if (kind === "stylesheet") return req.respond({ status: 200, headers: {
        "content-type": "text/css", "access-control-allow-origin": "*" }, body: "" });
      return req.respond({ status: 200, headers: {
        "content-type": "application/json", "access-control-allow-origin": "*" }, body: "[]" });
    }
    req.continue();
  });

  await page.evaluateOnNewDocument((row, lg, pl, fx) => {
    try {
      localStorage.clear();
      localStorage.setItem("lang", lg);
      if (pl) localStorage.setItem("pawa_house_my_places", JSON.stringify(pl));
      // The store js/lib/geolocate.js writes on a granted fix. Stamped now, so
      // it is inside the twenty-minute window PawaMaps will trust.
      if (fx) localStorage.setItem("pawa_last_pos",
        JSON.stringify({ lat: fx.lat, lng: fx.lng, accuracy: 20, at: Date.now() }));
    } catch (_) {}
    let ds;
    Object.defineProperty(window, "DataStore", {
      configurable: true,
      get() { return ds; },
      set(v) { ds = v; if (v) v.getHouses = async () => [row]; },
    });
  }, HOUSE, lang, places, fix);

  let navErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(`${BASE}/house.html?id=fixture`, { waitUntil: "domcontentloaded", timeout: 30000 });
      navErr = null; break;
    } catch (e) { navErr = e; }
  }
  if (navErr) throw new Error("navigation failed: " + navErr.message);

  await page.waitForSelector("#hdDirBtn", { timeout: 20000 }).catch(() => {});
  return { page, errs };
}

const q = (href, k) => { try { return new URL(href).searchParams.get(k); } catch (_) { return null; } };

// ---------------------------------------------------------------------------
console.log("\n1. The main action is a complete Google Maps link");
{
  const { page, errs } = await render();
  const href = await page.$eval("#hdDirBtn", (a) => a.getAttribute("href") || "");
  ok(href.startsWith("https://www.google.com/maps/dir/?api=1"), "it is a directions link", href);
  ok(q(href, "destination") === "-6.772400,39.208300", "the house is the destination", href);
  ok(q(href, "travelmode") === "driving",
     "and the travel mode is set, which no link in this repo used to do", href);
  ok(await page.$eval("#hdDirBtn", (a) => a.target === "_blank" && /noopener/.test(a.rel)),
     "it opens in the maps app without handing it this page");
  ok(errs.length === 0, "no page errors", errs.slice(0, 3).join(" | "));
  await page.close();
}

console.log("\n2. When the app knows where you are, the origin is filled in too");
{
  const { page } = await render({ fix: { lat: -6.8100, lng: 39.2800 } });
  const href = await page.$eval("#hdDirBtn", (a) => a.getAttribute("href") || "");
  ok(q(href, "origin") === "-6.810000,39.280000",
     "the ORIGIN is there, so Google Maps never asks where you are starting from", href);
  ok(q(href, "destination") === "-6.772400,39.208300", "and the destination is still the house");
  await page.close();
}

console.log("\n3. A fix from another day is not used as 'where you are'");
{
  const { page } = await render();
  // Same store, but stale. Written after load so it cannot be picked up early.
  await page.evaluate(() => localStorage.setItem("pawa_last_pos",
    JSON.stringify({ lat: -3.3869, lng: 36.6830, at: Date.now() - 6 * 60 * 60 * 1000 })));
  const stale = await page.evaluate(() => window.PawaMaps.knownOrigin());
  ok(stale === null, "a six-hour-old fix in Arusha is not offered as the start of a Dar journey");
  await page.close();
}

console.log("\n4. The workplace saved on houses.html is on this sheet, with nothing to type");
{
  const { page, errs } = await render({ places: MY_PLACES });
  const rows = await page.$$eval(".hd-saved__row", (els) => els.map((e) => ({
    name: e.querySelector(".hd-saved__n")?.textContent.trim(),
    kind: e.querySelector(".hd-saved__k")?.textContent.trim(),
    href: e.querySelector(".hd-saved__go")?.getAttribute("href") || "",
  })));
  ok(rows.length === 2, `both saved places are drawn (${rows.length})`);
  ok(rows[0] && rows[0].name === "Muhimbili",
     "the WORKPLACE leads, not the café that happened to be saved first",
     JSON.stringify(rows.map((r) => r.name)));
  ok(rows[0] && rows[0].kind === "Workplace", "and it says what kind of place it is");

  const w = rows[0] ? rows[0].href : "";
  ok(q(w, "origin") === "-6.772400,39.208300",
     "the HOUSE is the origin: the question is how far the home is from work", w);
  ok(q(w, "destination") === "-6.801000,39.270000", "and the workplace is the destination", w);
  ok(q(w, "travelmode") === "driving", "a bajaji routes as driving");

  // The other answer to the same question, without leaving the page.
  const inAppKept = await page.$(".hd-saved__here");
  ok(!!inAppKept, "and measuring it on this page is still one tap away");
  ok(errs.length === 0, "no page errors", errs.slice(0, 3).join(" | "));
  await page.close();
}

console.log("\n5. With nothing saved, the box explains itself instead of sitting empty");
{
  const { page } = await render();
  const none = await page.$eval("#hdSaved", (e) => e.textContent.trim());
  ok(none.length > 10 && !none.includes("undefined"),
     "one sentence, so the box makes sense the next time it is full", none);
  ok(await page.$eval("#hdCommuteInput", (i) => !!i),
     "and the typed box is still there for anywhere else");
  await page.close();
}

console.log("\n6. All of it speaks Swahili");
{
  const { page, errs } = await render({ lang: "sw", places: MY_PLACES });
  const txt = await page.$eval("#sec-place", (e) => e.innerText);
  const ENGLISH = [
    "Directions in Google Maps", "See the whole route in Google Maps", "Live meet with agent",
    "How far is this home", "Workplace", "Open in Google Maps", "Draw it on this map",
    "Somewhere else", "Measure", "Where it is",
    // The category chips under the map. They were eleven hardcoded English
    // words until they came out from over the imagery, so they are named here
    // rather than trusted: a chip is the easiest thing on this screen to add
    // without remembering it is read in two languages.
    "Places around this home", "Tap a kind of place", "Schools", "Hospitals",
    "Banks and ATMs", "Mosques and churches", "Post and government",
  ];
  const leaked = ENGLISH.filter((s) => txt.includes(s));
  ok(leaked.length === 0, "no English left in the place section", leaked.join(" | "));
  ok(txt.includes("Google Maps"), "the product name is still the product name");
  ok(txt.includes("Kazini"), "the workplace is labelled in Swahili");
  ok(errs.length === 0, "no page errors", errs.slice(0, 3).join(" | "));
  await page.close();
}

console.log("\n7. A listing with no pin says so, and offers nothing to press");
{
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 915 });
  // Straight at the builder, because a house with no coordinates never reaches
  // the map at all and this is the branch that decides what it says instead.
  await page.goto(`${BASE}/house.html?id=none`, { waitUntil: "domcontentloaded" });
  const built = await page.evaluate(() => {
    if (!window.PawaMaps) return null;
    return window.PawaMaps.directions({ lat: null, lng: null });
  });
  ok(built === "", "no coordinates produces no link at all, rather than a link to nowhere");
  await page.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
