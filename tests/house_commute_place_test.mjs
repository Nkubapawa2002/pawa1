// ============================================================================
// house_commute_place_test.mjs — "How far is this home from your workplace?",
// on the page a client actually opens.
//
// THE BUG THIS PROVES FIXED
// house.html loaded js/lib/geo.js and NOTHING ELSE about places. It never
// loaded tz-places.js, so on this page — and only on this page — the local
// gazetteer, resolveTzPlace and closestTzPlaces did not exist at all. The
// commute box was therefore 100% LocationIQ, which (verified live, with the
// app's own key, on 2026-08-26):
//
//   · cannot geocode "Mwalimu Nyerere Memorial Academy" — returns
//     {"error":"Unable to geocode"} for a university whose coordinates are in
//     tz-places.js;
//   · answers "Mwl Nyerere University" with ONE row, "Taasisi ya Mwl. Nyerere"
//     in TABORA, 800 km from the campus in Dar — and one row is not zero rows,
//     so nothing downstream ever second-guessed it;
//   · returns nothing for "Mikoceni", one letter off a Dar ward.
//
// Every case below is driven against a LocationIQ stub that reproduces exactly
// those three responses, so what is being tested is our behaviour when the
// geocoder behaves the way it really does.
//
//   usage:  node server.js     then, in another shell:
//           node tests/house_commute_place_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080/house.html";
const now = new Date().toISOString();
// The listing under test sits in Mikocheni, Dar es Salaam. Its own pin is what
// breaks ties between same-named places, so it has to be a real Dar location.
const HOUSE = { lat: -6.7642, lng: 39.2613 };

const FIXTURES = {
  houses: [{
    id: "h-commute", title: "Room in Mikocheni",
    type: "house", listing: "rent", price_tzs: 250000, period: "month",
    currency: "TZS", region: "Dar es Salaam", area: "Mikocheni",
    lat: HOUSE.lat, lng: HOUSE.lng, created_at: now, owner_user_id: "o1",
    amenities: [], photos: [], videos: [], min_months: 1, details: {},
    agent: { name: "Asha Mmbaga", phone: "+255700000001" },
  }],
};

// The real LocationIQ answers, keyed by what the app asks. Anything not listed
// answers with an empty array, which is what the live service does for most of
// what people type.
const TABORA_ROW = {
  place_id: "331211627284", lat: "-5.019163", lon: "32.80297",
  display_name: "Taasisi ya Mwl. Nyerere, Tabora Urban, Tabora, Tanzania",
  name: "Taasisi ya Mwl. Nyerere", type: "school", class: "amenity",
};
function locationiqBody(q) {
  const s = q.toLowerCase();
  if (/nyerere/.test(s) && !/memorial|academy|mwalimu/.test(s)) return [TABORA_ROW];
  return [];   // including "Mwalimu Nyerere Memorial Academy" and "Mikoceni"
}

const SUPABASE_STUB = `(function () {
  var FIX = ${JSON.stringify(FIXTURES)};
  function builder(table) {
    var b = {};
    ["select","eq","neq","gt","gte","lt","lte","in","is","or","filter","order","limit","range","match"]
      .forEach(function (m) { b[m] = function () { return b; }; });
    b.then = function (res, rej) {
      return Promise.resolve({ data: FIX[table] || [], error: null }).then(res, rej);
    };
    return b;
  }
  var noSession = function () { return Promise.resolve({ data: { session: null, user: null }, error: null }); };
  window.supabase = { createClient: function () { return {
    from: builder,
    rpc: function () { return Promise.resolve({ data: null, error: null }); },
    auth: { getSession: noSession, getUser: noSession, signInWithPassword: noSession,
            signUp: noSession, signOut: function () { return Promise.resolve({ error: null }); },
            onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; } },
    storage: { from: function () { return { getPublicUrl: function () { return { data: { publicUrl: "" } }; } }; } },
    channel: function () { return { on: function () { return this; }, subscribe: function () { return this; } }; },
    removeChannel: function () {},
  }; } };
})();`;

// MapLibre is not what is under test — the commute box's search runs before any
// route is drawn — but an unanswered jsDelivr request holds up the whole page.
const MAPLIBRE_STUB = `(function () {
  function chain() {
    return new Proxy(function () {}, {
      get: function (t, k) {
        if (k === "then") return undefined;
        if (k === Symbol.toPrimitive) return function (h) { return h === "string" ? "" : 0; };
        if (k === "valueOf") return function () { return 0; };
        if (k === "toString") return function () { return ""; };
        if (k === Symbol.iterator) return function () { return [][Symbol.iterator](); };
        return chain();
      },
      set: function () { return true; },
      apply: function () { return chain(); },
      construct: function () { return chain(); },
    });
  }
  window.maplibregl = chain();
})();`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};
const section = (s) => process.stdout.write("\n" + s + "\n");

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

  // Every query the page sends to LocationIQ, so the COST of an answer is
  // measurable and not just its correctness.
  const geocodes = [];

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*",
        "access-control-allow-methods": "*" } });
    }
    if (/locationiq\.com/.test(url)) {
      const q = decodeURIComponent((url.match(/[?&]q=([^&]*)/) || [])[1] || "").replace(/\+/g, " ");
      geocodes.push(q);
      return req.respond({
        status: 200,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: JSON.stringify(locationiqBody(q)),
      });
    }
    if (/cdn\.jsdelivr\.net.*supabase/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: SUPABASE_STUB });
    }
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url) ||
        /cdn\.jsdelivr\.net.*maplibre.*\.css/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    if (/cdn\.jsdelivr\.net.*maplibre/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: MAPLIBRE_STUB });
    }
    const rest = url.match(/supabase\.co\/rest\/v1\/([a-z_]+)/);
    if (rest) {
      return req.respond({ status: 200,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: JSON.stringify(FIXTURES[rest[1]] || []) });
    }
    if (/arcgisonline|basemaps\.cartocdn|api\.mapbox|tile\.openstreetmap|unsplash|supabase\.co\/storage/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
    }
    // Everything else that is not this dev server is answered locally. Letting
    // even one request reach the real internet makes the whole run erratic — the
    // second OSRM endpoint (routing.openstreetmap.de, which matches no pattern
    // above) took ~3 s to refuse, and every measurement on the page waited
    // behind it in the interception queue.
    if (!/^http:\/\/localhost:8080\//.test(url)) {
      return req.respond({ status: 200,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: "{}" });
    }
    req.continue();
  });

  await page.goto(BASE + "?id=h-commute", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("#hdCommuteInput", { timeout: 25000 });

  const rows = () => page.$$eval(".hd-commute-result .hd-cr-name", (n) => n.map((e) => e.textContent.trim()))
    .catch(() => []);
  const msg = () => page.$eval("#hdCommuteMsg", (e) => e.textContent.trim()).catch(() => "");
  const typeIn = async (text) => {
    await page.$eval("#hdCommuteInput", (e) => { e.value = ""; });
    await page.click("#hdCommuteInput");
    await page.type("#hdCommuteInput", text, { delay: 12 });
  };
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  // Poll rather than sleep a fixed amount: the local answer lands in a few ms
  // and the geocoder round trip in a few hundred, and a test that waits the
  // worst case for both is a test nobody runs.
  const until = async (fn, ms = 15000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await fn()) return true;
      if (Date.now() > deadline) return false;
      await settle(120);
    }
  };
  const rowsShowing = (re) => until(async () => (await rows()).some((r) => re.test(r)));

  section("1. The page can see the places this app knows at all");
  {
    const has = await page.evaluate(() => ({
      gazetteer: Array.isArray(window.TZ_UNIVERSITIES) && window.TZ_UNIVERSITIES.length > 0,
      matcher: typeof (window.pawaPlaceMatch || {}).search === "function",
      resolve: typeof window.resolveTzPlace === "function",
    }));
    // Before this change all three were false on house.html, and only here.
    ok(has.gazetteer, "tz-places.js is loaded on the house page");
    ok(has.matcher, "and the matcher that reads a typed name");
    ok(has.resolve, "and resolveTzPlace, which every other map page already had");
  }

  section("2. Answers appear while typing, with no network at all");
  {
    const before = geocodes.length;
    await typeIn("Mwl Nyerere University");
    await rowsShowing(/Mwalimu Nyerere Memorial Academy/i);
    const shown = await rows();
    ok(shown.some((r) => /Mwalimu Nyerere Memorial Academy/i.test(r)),
       "the Kigamboni campus is offered before Measure is ever pressed", JSON.stringify(shown));
    ok(geocodes.length === before,
       `and it cost zero geocoder calls — made ${geocodes.length - before}`, JSON.stringify(geocodes.slice(before)));
    ok(/found/i.test(await msg()), "the box says it found something", await msg());
  }

  section("3. The confidently wrong Tabora row no longer leads");
  {
    await page.click("#hdCommuteBtn");
    await until(async () => /by road|couldn|measur/i.test(await msg()));
    const shown = await rows();
    ok(shown.length > 0, "results came back",
       JSON.stringify(shown) + " msg=" + (await msg()) + " asked=" + JSON.stringify(geocodes));
    ok(/Mwalimu Nyerere Memorial Academy/i.test(shown[0] || ""),
       "the Dar campus is first, not the institute 800 km away in Tabora", JSON.stringify(shown));
    ok(shown.some((r) => /Taasisi ya Mwl\. Nyerere/i.test(r)),
       "the geocoder's row is still there to pick, just not first", JSON.stringify(shown));
  }

  section("4. The place LocationIQ cannot geocode at all");
  {
    const before = geocodes.length;
    await typeIn("Mwalimu Nyerere Memorial Academy");
    await rowsShowing(/Mwalimu Nyerere Memorial Academy/i);
    await page.click("#hdCommuteBtn");
    await until(async () => /by road|couldn|measur/i.test(await msg()));
    const shown = await rows();
    ok(/Mwalimu Nyerere Memorial Academy/i.test(shown[0] || ""),
       "resolved anyway, from our own coordinates", JSON.stringify(shown));
    const asked = geocodes.slice(before);
    ok(asked.length <= 1,
       `one geocoder call, not three (literal + two word-dropping retries) — made ${asked.length}`,
       JSON.stringify(asked));
  }

  section("5. A misspelling is offered, and never silently measured");
  {
    await typeIn("Mikoceni");
    await rowsShowing(/Mikocheni/i);
    const shown = await rows();
    ok(shown.some((r) => /Mikocheni/i.test(r)), "Mikoceni offers Mikocheni", JSON.stringify(shown));
    ok(/did you mean/i.test(await msg()),
       "and asks, rather than asserting — it is a guess at a letter nobody typed", await msg());

    await page.click("#hdCommuteBtn");
    await until(async () => /no exact match|closest|by road|couldn/i.test(await msg()));
    const after = await msg();
    ok(/no exact match|closest/i.test(after),
       "pressing Measure still captions it as approximate", after);
    ok(!/by road/i.test(after),
       "and does NOT draw a confident route to a place that was never asked for", after);
  }

  section("6. Nothing broke");
  {
    ok(errs.length === 0, "no page errors", errs.slice(0, 4).join(" || "));
  }
} finally {
  await browser.close();
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n\n`);
process.exit(fail ? 1 : 0);
