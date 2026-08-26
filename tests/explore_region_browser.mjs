// ============================================================================
// explore_region_browser.mjs — the Explore region picker, in a real browser.
//
// explore_engine_test.mjs proves the RANKING obeys a region. This proves the
// PAGE does: that picking a region scopes the cards, moves the anchor so the
// distances are measured from the region being browsed, writes ?region= into
// the URL, and says which place came up empty when it comes up empty.
//
// Supabase and the map tiles are stubbed (see the OPTIONS preflight below —
// without it the browser blocks every GET before the interceptor sees it).
//
//   usage:  node server.js     then, in another shell:
//           node tests/explore_region_browser.mjs
// ============================================================================
import puppeteer from "puppeteer";

const URL = "http://localhost:8080/explore.html";
const now = new Date().toISOString();
const soon = new Date(Date.now() + 5 * 864e5).toISOString();

const MBEZI = { lat: -6.728, lng: 39.21 };
const KARIA = { lat: -6.818, lng: 39.27 };
const MWANZA = { lat: -2.5164, lng: 32.9175 };

const FIXTURES = {
  houses: [
    { id: "h1", title: "Single room Mbezi Beach", type: "room", listing: "rent",
      price_tzs: 250000, period: "month", bedrooms: 1, region: "Dar es Salaam",
      area: "Mbezi Beach", lat: MBEZI.lat, lng: MBEZI.lng, created_at: now, owner_user_id: "o1" },
    { id: "h2", title: "2 bedroom apartment Kariakoo", type: "apartment", listing: "rent",
      price_tzs: 800000, period: "month", bedrooms: 2, region: "Dar es Salaam",
      area: "Kariakoo", lat: KARIA.lat, lng: KARIA.lng, created_at: now, owner_user_id: "o2" },
    { id: "h3", title: "House for sale Mwanza", type: "house", listing: "sale",
      price_tzs: 90000000, period: "total", bedrooms: 4, region: "Mwanza",
      area: "Nyamagana", lat: MWANZA.lat, lng: MWANZA.lng, created_at: now, owner_user_id: "o3" },
    // No region recorded, but the pin is in Mwanza — the 25 km edge rule.
    { id: "h4", title: "Room with no region recorded", type: "room", listing: "rent",
      price_tzs: 200000, period: "month", bedrooms: 1, region: "", area: "Nyamagana",
      lat: MWANZA.lat + 0.01, lng: MWANZA.lng + 0.01, created_at: now, owner_user_id: "o4" },
  ],
  trucks: [
    { id: "t1", title: "Canter for hire Mbezi", truck_type: "canter", capacity_tonnes: 3,
      price_tzs: 60000, period: "trip", region: "Dar es Salaam", area: "Mbezi",
      lat: MBEZI.lat + 0.01, lng: MBEZI.lng, created_at: now, owner_user_id: "o5" },
    { id: "t2", title: "10 tonne lorry Mwanza", truck_type: "lorry", capacity_tonnes: 10,
      price_tzs: 300000, period: "trip", region: "Mwanza", area: "Nyamagana",
      lat: MWANZA.lat, lng: MWANZA.lng, created_at: now, owner_user_id: "o6" },
  ],
  services: [
    { id: "s1", title: "Electrician - wiring and repairs", category: "electrical",
      price_tzs: 40000, rate_type: "per_job", region: "Dar es Salaam", area: "Mbezi",
      lat: MBEZI.lat, lng: MBEZI.lng, created_at: now, owner_user_id: "o7" },
  ],
  day_jobs: [
    { id: 1, title: "Loading workers needed", company_name: "Dar Movers",
      company_phone: "+255700000000", region: "Dar es Salaam", area: "Mbezi",
      lat: MBEZI.lat, lng: MBEZI.lng, workers_needed: 10, claimed_count: 2,
      pay_tzs: 15000, work_date: "2026-08-20", status: "open",
      created_at: now, expires_at: soon },
  ],
};

const MWANZA_IDS = ["h3", "h4", "t2"];

// supabase-js is loaded from jsDelivr, which is not reachable from this
// machine — the page would sit on a 30 s script timeout and then fall back to
// data/*.json, testing the seed data instead of the fixtures. So the CDN
// script itself is answered with a client stub that serves FIXTURES.
const SUPABASE_STUB = `(function () {
  var FIX = ${JSON.stringify(FIXTURES)};
  function builder(table) {
    var b = {};
    ["select", "eq", "neq", "gt", "gte", "lt", "lte", "in", "is", "or", "filter",
     "order", "limit", "range", "match"].forEach(function (m) {
      b[m] = function () { return b; };
    });
    b.then = function (res, rej) {
      return Promise.resolve({ data: FIX[table] || [], error: null }).then(res, rej);
    };
    return b;
  }
  var noSession = function () { return Promise.resolve({ data: { session: null, user: null }, error: null }); };
  window.supabase = {
    createClient: function () {
      return {
        from: builder,
        rpc: function () { return Promise.resolve({ data: null, error: null }); },
        auth: {
          getSession: noSession, getUser: noSession,
          signInWithPassword: noSession, signUp: noSession,
          signOut: function () { return Promise.resolve({ error: null }); },
          onAuthStateChange: function () {
            return { data: { subscription: { unsubscribe: function () {} } } };
          },
        },
        storage: { from: function () { return {
          getPublicUrl: function () { return { data: { publicUrl: "" } }; },
        }; } },
        channel: function () {
          return { on: function () { return this; }, subscribe: function () { return this; } };
        },
        removeChannel: function () {},
      };
    },
  };
})();`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  protocolTimeout: 120000,
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 1 });

  const errs = [];
  const oneLine = (s) => String(s).split(/\r?\n/).slice(0, 3).join(" | ");
  page.on("pageerror", (e) => errs.push(oneLine((e && e.stack) || e)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    // supabase-js sends apikey + authorization, so every call is preflighted.
    // Answer the OPTIONS or the GET never reaches the handler below.
    if (req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "*",
      }});
    }
    if (/cdn\.jsdelivr\.net.*supabase/.test(url)) {
      return req.respond({
        status: 200,
        headers: { "content-type": "application/javascript" },
        body: SUPABASE_STUB,
      });
    }
    // Web fonts are unreachable here too, and a blocked stylesheet holds up
    // domcontentloaded exactly the way the CDN script does.
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    const rest = url.match(/supabase\.co\/rest\/v1\/([a-z_]+)/);
    if (rest) {
      return req.respond({
        status: 200,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: JSON.stringify(FIXTURES[rest[1]] || []),
      });
    }
    // Tiles and remote images stall the run for minutes if left to the network.
    if (/arcgisonline|basemaps\.cartocdn|api\.mapbox|tile\.openstreetmap|supabase\.co\/storage/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
    }
    if (/supabase\.co|router\.project-osrm|nominatim/.test(url)) {
      return req.respond({
        status: 200,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: "{}",
      });
    }
    req.continue();
  });

  const cardIds = () => page.$$eval(".xp-card", (n) => n.map((c) => c.dataset.id));
  const chips = () => page.$$eval(".xp-tag", (n) => n.map((c) => c.textContent.trim()));
  /**
   * Poll a predicate in the page, and on failure say what the page actually
   * looked like.
   *
   * Polled rather than page.waitForFunction() for two reasons found the hard
   * way: an injected predicate can wedge when the page throws elsewhere, so a
   * perfectly rendered page reports a bare "waiting failed"; and that message
   * alone tells you nothing about which half of the render is missing.
   */
  const until = async (label, fn, ms = 15000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await page.evaluate(fn).catch(() => false)) return;
      if (Date.now() > deadline) {
        const state = await page.evaluate(() => ({
          cards: document.querySelectorAll(".xp-card").length,
          emptyHidden: (document.getElementById("xpEmpty") || {}).hidden,
          emptyTitle: (document.getElementById("xpEmptyT") || {}).textContent,
          region: (document.getElementById("xpRegion") || {}).value,
          count: (document.getElementById("xpCount") || {}).textContent,
          url: location.search,
        })).catch((e) => ({ unreadable: String(e) }));
        process.stdout.write("  gave up waiting for " + label + ". state=" +
          JSON.stringify(state) + "\n  errors=" + JSON.stringify(errs.slice(0, 5)) + "\n");
        throw new Error("timed out waiting for " + label);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  // Either half of a finished render counts: results, or the empty state.
  const settle = () => until("a rendered result set", () => {
    const empty = document.getElementById("xpEmpty");
    return document.querySelectorAll(".xp-card").length > 0 || !!(empty && !empty.hidden);
  });
  const emptyShown = () => until("the empty state", () => {
    const empty = document.getElementById("xpEmpty");
    return !!(empty && !empty.hidden);
  });
  const pickRegion = async (name) => {
    await page.select("#xpRegion", name);
    await new Promise((r) => setTimeout(r, 900));
  };

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await settle();

  process.stdout.write("\n1. The whole country\n");
  const all = await cardIds();
  ok(all.length >= 6, "every catalogue loads (" + all.length + " cards)", all.join(","));
  ok(MWANZA_IDS.every((id) => all.includes(id)) && all.includes("h1"),
     "Dar and Mwanza listings sit in one national result set", all.join(","));

  process.stdout.write("\n2. Browsing Mwanza from a phone in Dar\n");
  await pickRegion("Mwanza");
  await settle();
  const mw = await cardIds();
  ok(mw.length > 0 && mw.every((id) => MWANZA_IDS.includes(id)),
     "only Mwanza listings survive the region scope", mw.join(","));
  ok(mw.includes("h4"), "a blank region field is rescued by the pin (25 km edge)", mw.join(","));
  ok((await chips()).some((c) => c.includes("Mwanza")), "a region chip says where you are looking");

  // The anchor must have moved with the region: distances are the tell.
  // Measured from Dar, every one of these would read about 1,100 km.
  const dists = await page.$$eval(".xp-dist", (n) => n.map((d) => d.textContent.trim()));
  ok(dists.length > 0 && !dists.some((d) => /1[,.]?[01]\d\d\s*km/.test(d)),
     "distances are measured from Mwanza, not from the visitor's own city",
     dists.join(" | "));

  ok(page.url().includes("region=Mwanza"), "the region is in the URL, so the search is shareable", page.url());

  process.stdout.write("\n3. A region with nothing in it\n");
  await pickRegion("Arusha");
  await emptyShown();
  const emptyT = await page.$eval("#xpEmptyT", (n) => n.textContent);
  const emptyP = await page.$eval("#xpEmptyP", (n) => n.textContent);
  const widen = await page.$eval("#xpWiden", (n) => n.textContent);
  ok(/Arusha/.test(emptyT), "the empty state names the region that came up empty", emptyT);
  ok(/\d/.test(emptyP), "it counts what dropping the region would find", emptyP);
  ok(/instead/i.test(widen), "the widen button offers the whole country", widen);

  process.stdout.write("\n4. Taking the offer\n");
  await page.click("#xpWiden");
  await settle();
  ok((await page.$eval("#xpRegion", (n) => n.value)) === "",
     "widening actually clears the region rather than only the radius");
  ok((await cardIds()).length >= 6, "the national result set comes back");
  ok(!page.url().includes("region="), "and the URL forgets the region too", page.url());

  process.stdout.write("\n5. No stale region message left behind\n");
  // A budget, not gibberish: unmatched WORDS never empty the page (text is a
  // ranking signal here, see docs/EXPLORE.md "hard filters"), whereas a budget
  // nothing meets is one of the few things that genuinely can.
  await page.click("#xpQ");
  await page.type("#xpQ", "chumba under 5000");
  await emptyShown();
  const emptyT2 = await page.$eval("#xpEmptyT", (n) => n.textContent);
  ok(!/Arusha/.test(emptyT2),
     "an empty search with no region does not still blame Arusha", emptyT2);

  // --------------------------------------------------------------------------
  // 6. A pin somebody was sent in P-Message.
  //
  // "Open on the map tab" in a chat hands Explore an exact position rather
  // than a place name (js/pages/p-message.js, drawSheetActs). Three things
  // have to move together or the page lies about where it is looking: the
  // anchor every distance is measured from, the region that scopes the cards,
  // and the radius — "near this gate" is the question a pin asks.
  //
  // The URL round-trip is the other half. Explore rewrites its own URL after
  // every search; if it wrote the pin back as ?place=<label> then reloading a
  // link would send whatever a person typed in a chat ("the gate is the blue
  // one") through the geocoder, and the exact spot would become a guess.
  process.stdout.write("\n6. A pin received in a conversation\n");
  await page.goto(
    URL + "?view=map&at=" + encodeURIComponent(MWANZA.lat + "," + MWANZA.lng) +
    "&label=" + encodeURIComponent("Blue gate"),
    { waitUntil: "domcontentloaded", timeout: 30000 });
  await settle();

  const pinState = await page.evaluate(() => ({
    region: (document.getElementById("xpRegion") || {}).value,
    place: (document.getElementById("xpPlace") || {}).value,
    radius: (document.getElementById("xpRadius") || {}).value,
  }));
  ok(pinState.region === "Mwanza",
     "the region follows the pin, so the cards are scoped to where it is",
     JSON.stringify(pinState));
  ok(pinState.place === "Blue gate",
     "the box reads back the words the sender typed, not a coordinate",
     JSON.stringify(pinState));
  ok(String(pinState.radius) === "5",
     "the radius tightens to the neighbourhood the pin is in",
     JSON.stringify(pinState));

  const pinIds = await cardIds();
  ok(pinIds.length > 0 && pinIds.every((id) => MWANZA_IDS.includes(id)),
     "only what is near the pin comes back", pinIds.join(","));

  const pinUrl = page.url();
  ok(/[?&]at=/.test(pinUrl) && !/[?&]place=/.test(pinUrl),
     "the rewritten URL keeps the exact pin instead of downgrading it to a name",
     pinUrl);

  ok(errs.length === 0, "no page errors", errs.slice(0, 5).join("\n        "));
  process.stdout.write("\n" + pass + " passed, " + fail + " failed\n");
} finally {
  await browser.close();
}
process.exit(fail === 0 ? 0 : 1);
