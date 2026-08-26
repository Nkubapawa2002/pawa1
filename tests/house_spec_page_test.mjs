// ============================================================================
// house_spec_page_test.mjs — the spec sheet, on the page a client actually
// opens.
//
// agent-houses.js has been writing houses.details for a while: the room-by-
// room price table, and the titled fact groups (rules, the area, services,
// paperwork, and whatever else the agent named). Every one of those facts was
// stored and none of it was ever drawn — house.js did not mention HouseSpec.
// This proves the other half exists now, and it is written to fail loudly if
// the read side ever silently drops away again.
//
// What it checks, in the order the page answers them:
//   1. a plot that rents room by room says "From" and then lists the rooms
//   2. the cheapest room is marked, because that is what "from" points at
//   3. a full room is dimmed and struck rather than hidden
//   4. a room with no price says so instead of showing zero
//   5. the agent's fact groups render, including one they named themselves
//   6. a listing with no spec sheet grows no empty cards
//   7. the directory card says the same two things one screen earlier
//   8. the room and budget filters read the sheet, so a master room on a
//      plot whose CHEAPEST room is a single stops being invisible — and
//      stops matching a budget that only its single room fits
//
//   usage:  node server.js     then, in another shell:
//           node tests/house_spec_page_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080/house.html";
const now = new Date().toISOString();
const MBEZI = { lat: -6.728, lng: 39.21 };

const FIXTURES = {
  houses: [
    // The listing this whole feature exists for: one plot, four kinds of
    // space, four different prices, and a page full of facts that used to
    // have nowhere to go but the description.
    {
      id: "h-spec", title: "Plot with four kinds of space, Mbezi",
      type: "house", listing: "rent", price_tzs: 60000, period: "month",
      currency: "TZS", region: "Dar es Salaam", area: "Mbezi Beach",
      lat: MBEZI.lat, lng: MBEZI.lng, created_at: now, owner_user_id: "o1",
      amenities: [], photos: [], videos: [], min_months: 1,
      agent: { name: "Asha Mmbaga", phone: "+255700000001" },
      details: {
        v: 1,
        rooms: [
          { kind: "single", price: 60000, period: "month", count: 3, vacant: 1,
            ensuite: false, size: null, note: "" },
          { kind: "master", price: 150000, period: "month", count: 1, vacant: 0,
            ensuite: true, size: 18, note: "Upstairs, own entrance" },
          { kind: "godown", price: null, period: "month", count: 1, vacant: null,
            ensuite: false, size: null, note: "" },
        ],
        groups: [
          { key: "rules", title: "Rules & regulations", items: [
            { label: "Deposit", value: "2 months, refundable", note: "" },
            { label: "Gate closes", value: "22:00", note: "Call the guard after that" },
          ]},
          // A category the agent invented. Nothing in the catalogue offers it,
          // and it has to survive the round trip exactly as typed.
          { key: "custom", title: "Fishing and the beach", items: [
            { label: "Boat", value: "Beached 200 m away" },
          ]},
        ],
      },
    },
    // The control. Same shape, no spec sheet at all — the page must not grow
    // an empty "Rooms & what each one costs" card for it.
    {
      id: "h-plain", title: "Two bedroom apartment, Kariakoo",
      type: "apartment", listing: "rent", price_tzs: 800000, period: "month",
      currency: "TZS", region: "Dar es Salaam", area: "Kariakoo",
      lat: -6.818, lng: 39.27, created_at: now, owner_user_id: "o2",
      bedrooms: 2, bathrooms: 1, amenities: [], photos: [], videos: [],
      min_months: 1, details: {},
      agent: { name: "Juma Said", phone: "+255700000002" },
    },
  ],
};

// Same stub shape as tests/explore_region_browser.mjs: jsDelivr is not
// reachable here, so the CDN script itself is answered with a client that
// serves FIXTURES. Without it the page waits out a 30 s script timeout and
// then tests data/*.json instead of anything written here.
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

// MapLibre and Leaflet are the other jsDelivr scripts on these pages, and an
// un-answered request for one holds up domcontentloaded until the navigation
// times out — the page never renders at all. Neither map is what is under
// test here (the spec sheet is drawn before either is constructed), so both
// are answered with a stub that swallows every call chain the pages make: a
// bare `undefined` would surface as a pageerror and fail the last assertion
// for a reason that has nothing to do with the feature.
const chainStub = (globalName) => `(function () {
  function chain() {
    return new Proxy(function () {}, {
      get: function (t, k) {
        if (k === "then") return undefined;
        // The real map returns numbers from getZoom(), getBearing() and
        // friends, and the page does arithmetic on them (Math.max(13,
        // map.getZoom())). A bare proxy throws "cannot convert object to
        // primitive" there and the page reports a TypeError that has nothing
        // to do with what is being tested — so the stub coerces like a number.
        if (k === Symbol.toPrimitive) return function (hint) { return hint === "string" ? "" : 0; };
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
  window.${globalName} = chain();
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
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url) ||
        /cdn\.jsdelivr\.net.*(maplibre|leaflet).*\.css/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    if (/cdn\.jsdelivr\.net.*(maplibre|leaflet)/.test(url)) {
      return req.respond({
        status: 200,
        headers: { "content-type": "application/javascript" },
        body: chainStub(/leaflet/.test(url) ? "L" : "maplibregl"),
      });
    }
    const rest = url.match(/supabase\.co\/rest\/v1\/([a-z_]+)/);
    if (rest) {
      return req.respond({
        status: 200,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: JSON.stringify(FIXTURES[rest[1]] || []),
      });
    }
    if (/arcgisonline|basemaps\.cartocdn|api\.mapbox|tile\.openstreetmap|unsplash|supabase\.co\/storage/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
    }
    if (/supabase\.co|router\.project-osrm|nominatim|overpass/.test(url)) {
      return req.respond({
        status: 200,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: "{}",
      });
    }
    req.continue();
  });

  const until = async (label, fn, ms = 20000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await page.evaluate(fn).catch(() => false)) return;
      if (Date.now() > deadline) {
        const state = await page.evaluate(() => ({
          title: (document.querySelector(".hd-title") || {}).textContent,
          cards: document.querySelectorAll(".hd-card h3").length,
          headings: [...document.querySelectorAll(".hd-card h3")].map((n) => n.textContent.trim()),
          hasSpec: !!window.HouseSpec,
        })).catch((e) => ({ unreadable: String(e) }));
        process.stdout.write("  gave up waiting for " + label + ". state=" +
          JSON.stringify(state) + "\n  errors=" + JSON.stringify(errs.slice(0, 5)) + "\n");
        throw new Error("timed out waiting for " + label);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const rendered = () => until("the listing to render",
    () => !!document.querySelector(".hd-title"));

  // --------------------------------------------------------------------------
  process.stdout.write("\n1. The library reaches the page at all\n");
  await page.goto(BASE + "?id=h-spec", { waitUntil: "domcontentloaded", timeout: 30000 });
  await rendered();
  ok(await page.evaluate(() => !!window.HouseSpec),
     "house.html loads js/lib/house-spec.js");

  process.stdout.write("\n2. A plot that rents room by room\n");
  const rooms = await page.$$eval(".hd-room", (n) => n.map((r) => ({
    kind: (r.querySelector(".hd-room-k") || {}).textContent.trim(),
    facts: ((r.querySelector(".hd-room-f") || {}).textContent || "").trim(),
    note: ((r.querySelector(".hd-room-n") || {}).textContent || "").trim(),
    price: (r.querySelector(".hd-room-p") || {}).textContent.trim(),
    taken: r.classList.contains("is-taken"),
    tagged: !!r.querySelector(".hd-room-tag"),
  })));
  ok(rooms.length === 3, "every room type in the sheet gets a row (" + rooms.length + ")",
     JSON.stringify(rooms));

  const single = rooms.find((r) => /Single/i.test(r.kind));
  const master = rooms.find((r) => /Master/i.test(r.kind));
  const godown = rooms.find((r) => /Godown/i.test(r.kind));

  ok(single && /60,000/.test(single.price), "the single room shows its own price",
     JSON.stringify(single));
  ok(master && /150,000/.test(master.price), "the master room shows a different one",
     JSON.stringify(master));
  ok(single && /1 of 3 free now/.test(single.facts),
     "how many there are, and how many are free, is stated", JSON.stringify(single));
  ok(master && /Own bathroom/.test(master.facts) && /18 m²/.test(master.facts),
     "a self-contained room says so, with its size", JSON.stringify(master));
  ok(master && /Upstairs, own entrance/.test(master.note),
     "the sentence the agent wrote about that one room survives", JSON.stringify(master));

  process.stdout.write("\n3. What \"from\" is pointing at\n");
  const priceHead = await page.$eval(".hd-price", (n) => n.textContent.replace(/\s+/g, " ").trim());
  ok(/^From/i.test(priceHead),
     "the headline says From, so 60,000 is not mistaken for the price of the plot",
     priceHead);
  ok(single && single.tagged && !(master && master.tagged),
     "and the cheapest room — only the cheapest — is marked as such",
     JSON.stringify(rooms.map((r) => [r.kind, r.tagged])));

  process.stdout.write("\n4. Rooms that cannot be rented, and rooms with no price\n");
  ok(master && master.taken,
     "a room with nothing free is dimmed rather than deleted", JSON.stringify(master));
  ok(single && !single.taken, "one with a vacancy is not", JSON.stringify(single));
  ok(godown && /Ask the agent/i.test(godown.price),
     "a room with no price asks, instead of printing TZS 0", JSON.stringify(godown));

  process.stdout.write("\n5. Everything that is not money\n");
  const groups = await page.$$eval(".hd-group-card", (n) => n.map((c) => ({
    title: (c.querySelector("h3") || {}).textContent.trim(),
    icon: !!c.querySelector(".hd-group-i"),
    lines: [...c.querySelectorAll(".hd-facts li")].map((li) => [
      (li.querySelector(".hd-fact-l") || {}).textContent.trim(),
      (li.querySelector(".hd-fact-v") || {}).textContent.trim(),
    ]),
  })));
  ok(groups.length === 2, "both fact groups render (" + groups.length + ")",
     JSON.stringify(groups));
  const rules = groups.find((g) => /Rules/i.test(g.title));
  ok(rules && rules.lines.length === 2, "every line inside a group renders",
     JSON.stringify(rules));
  ok(rules && rules.lines.some(([l, v]) => l === "Deposit" && /2 months, refundable/.test(v)),
     "a label and its answer stay together", JSON.stringify(rules));
  ok(rules && rules.lines.some(([, v]) => /Call the guard after that/.test(v)),
     "the note under an answer is shown too", JSON.stringify(rules));
  ok(groups.some((g) => /Fishing and the beach/.test(g.title)),
     "a category the agent invented survives with its own name",
     JSON.stringify(groups.map((g) => g.title)));
  ok(rules && rules.icon, "a preset group keeps its icon");

  // --shot writes what it looks like. house.html repaints the whole palette
  // on body[data-page="house"], which beats css/theme-light.css on :root — so
  // this page is always dark, and a card built with literal whites would be a
  // white slab under pale ink. The assertions above cannot see that.
  if (process.argv.includes("--shot")) {
    await page.screenshot({ path: "tests/shot_house_spec.png", fullPage: true });
    process.stdout.write("  wrote tests/shot_house_spec.png\n");
  }

  process.stdout.write("\n6. A listing with no spec sheet\n");
  await page.goto(BASE + "?id=h-plain", { waitUntil: "domcontentloaded", timeout: 30000 });
  await rendered();
  const plain = await page.evaluate(() => ({
    rooms: document.querySelectorAll(".hd-room").length,
    roomCards: document.querySelectorAll(".hd-rooms-card").length,
    groups: document.querySelectorAll(".hd-group-card").length,
    price: (document.querySelector(".hd-price") || {}).textContent.replace(/\s+/g, " ").trim(),
  }));
  ok(plain.roomCards === 0 && plain.rooms === 0,
     "no empty room table appears where there is nothing to put in it",
     JSON.stringify(plain));
  ok(plain.groups === 0, "and no empty fact cards either", JSON.stringify(plain));
  ok(!/^From/i.test(plain.price),
     "a whole flat at one price does not claim to start from it", plain.price);

  // --------------------------------------------------------------------------
  // 7. The same two facts, one screen earlier.
  //
  // The directory card is where the from-price actually matters: somebody is
  // scrolling past twenty of them, and a bare "TZS 60,000" on a plot whose
  // master room is 150,000 is the number they will remember and turn up
  // expecting. The card has room for one figure, so it gets one word in front
  // of it and a count beside it.
  process.stdout.write("\n7. The card in the directory\n");
  await page.goto("http://localhost:8080/houses.html",
                  { waitUntil: "domcontentloaded", timeout: 30000 });
  await until("the house cards to render",
    () => document.querySelectorAll(".house-card").length > 0);

  const cards = await page.$$eval(".house-card", (n) => n.map((c) => ({
    id: c.dataset.id,
    from: !!c.querySelector(".house-card-from"),
    price: (c.querySelector(".house-card-price") || {}).textContent.replace(/\s+/g, " ").trim(),
    types: ((c.querySelector(".house-card-roomtypes") || {}).textContent || "").trim(),
    aria: c.getAttribute("aria-label") || "",
  })));
  const specCard = cards.find((c) => c.id === "h-spec");
  const plainCard = cards.find((c) => c.id === "h-plain");

  ok(await page.evaluate(() => !!window.HouseSpec),
     "houses.html loads js/lib/house-spec.js");
  ok(specCard && specCard.from,
     "the room-by-room listing's card says From in front of its price",
     JSON.stringify(specCard));
  ok(specCard && /3 kinds of space/.test(specCard.types),
     "and says how many kinds of space are behind that one number",
     JSON.stringify(specCard));
  ok(specCard && /from/i.test(specCard.aria),
     "a screen reader is told the same thing, not just a sighted reader",
     specCard && specCard.aria);
  ok(plainCard && !plainCard.from && !plainCard.types,
     "the whole flat at one price gets neither", JSON.stringify(plainCard));

  if (process.argv.includes("--shot")) {
    const el = await page.$('.house-card[data-id="h-spec"]');
    if (el) await el.screenshot({ path: "tests/shot_house_card_from.png" });
    process.stdout.write("  wrote tests/shot_house_card_from.png\n");
  }

  // --------------------------------------------------------------------------
  // 8. Filtering, which is where the one-room columns actually did damage.
  //
  // `room_kind` holds the CHEAPEST room's category and `price_tzs` holds its
  // price, because a column can hold one of each and a listing can hold
  // twenty-four. Two bugs came out of that, and they point in opposite
  // directions:
  //
  //   MISSING  h-spec has a master room standing empty, and its column says
  //            "single". Every search for a master room hid it.
  //   PHANTOM  asking for a master under 100,000 matched it anyway, because
  //            it has a master (150,000) and it has something under 100,000
  //            (the single at 60,000) — two different rooms.
  //
  // Both are the same mistake: the two filters have to be satisfied by ONE
  // room, not by the listing as a whole.
  process.stdout.write("\n8. Filtering a listing that holds four kinds of space\n");
  await page.goto("http://localhost:8080/houses.html",
                  { waitUntil: "domcontentloaded", timeout: 30000 });
  await until("the house cards to render",
    () => document.querySelectorAll(".house-card").length > 0);

  // Drive the real controls, then read the real list.
  const filterBy = async (roomValue, priceText) => {
    await page.evaluate((room, price) => {
      const r = document.getElementById("filterRoom");
      const p = document.getElementById("filterPrice");
      if (r) { r.value = room; r.dispatchEvent(new Event("change", { bubbles: true })); }
      if (p) { p.value = price; p.dispatchEvent(new Event("input", { bubbles: true })); }
    }, roomValue, priceText);
    await new Promise((r) => setTimeout(r, 900));
    return page.$$eval(".house-card", (n) => n.map((c) => c.dataset.id));
  };

  const masterOnly = await filterBy("master", "");
  ok(masterOnly.includes("h-spec"),
     "a plot whose cheapest room is a single is found when you ask for a master",
     masterOnly.join(",") || "(none)");

  const singleOnly = await filterBy("single", "");
  ok(singleOnly.includes("h-spec"),
     "and is still found when you ask for a single", singleOnly.join(",") || "(none)");

  const masterCheap = await filterBy("master", "under 100000");
  ok(!masterCheap.includes("h-spec"),
     "but a master under 100,000 does not match it — its master is 150,000, and the 60,000 belongs to a different room",
     masterCheap.join(",") || "(none)");

  const masterAfford = await filterBy("master", "under 200000");
  ok(masterAfford.includes("h-spec"),
     "raise the budget past the master's own price and it comes back",
     masterAfford.join(",") || "(none)");

  const wholeOnly = await filterBy("whole", "");
  ok(!wholeOnly.includes("h-spec"),
     "a room-by-room plot is not a whole unit", wholeOnly.join(",") || "(none)");
  ok(wholeOnly.includes("h-plain"),
     "and a two-bedroom flat with no spec sheet still is", wholeOnly.join(",") || "(none)");

  ok(errs.length === 0, "no page errors", errs.slice(0, 6).join("\n        "));
  process.stdout.write("\n" + pass + " passed, " + fail + " failed\n");
} finally {
  await browser.close();
}
process.exit(fail === 0 ? 0 : 1);
