// ============================================================================
// pm_reach_parity_test.mjs — the encrypted door, on every catalogue.
//
// A day job has let a worker message whoever posted it since day_jobs learned
// who its owner is. Houses, trucks and services knew exactly the same fact —
// owner_user_id sits on every row and anyone browsing can read it — and none
// of the three offered the door. So the only way to answer a listing was to
// hand a stranger your phone number, which is the thing people do not do when
// they are comparing nine rooms.
//
// This proves all four now offer it, that they build the SAME link (one
// builder, js/lib/pm-reach.js, so they cannot drift), and that a listing with
// nobody recorded against it grows no dead button.
//
//   usage:  node server.js     then, in another shell:
//           node tests/pm_reach_parity_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
const now = new Date().toISOString();
const soon = new Date(Date.now() + 5 * 864e5).toISOString();
const OWNER = "user_2abcDEFghiJKLmno";
const DAR = { lat: -6.7924, lng: 39.2083 };

const FIXTURES = {
  houses: [
    { id: "h-own", title: "Room with an owner on file", type: "room", listing: "rent",
      price_tzs: 250000, period: "month", currency: "TZS", region: "Dar es Salaam",
      area: "Mbezi", lat: DAR.lat, lng: DAR.lng, created_at: now,
      owner_user_id: OWNER, amenities: [], photos: [], videos: [], min_months: 1,
      details: {}, agent: { name: "Asha Mmbaga", phone: "+255700000001" } },
    // Nobody recorded against it — an old row, or one imported before the
    // column existed. It must not grow a button that goes nowhere.
    { id: "h-none", title: "Room with no owner recorded", type: "room", listing: "rent",
      price_tzs: 200000, period: "month", currency: "TZS", region: "Dar es Salaam",
      area: "Mbezi", lat: DAR.lat, lng: DAR.lng, created_at: now,
      owner_user_id: null, amenities: [], photos: [], videos: [], min_months: 1,
      details: {}, agent: { name: "Juma Said", phone: "+255700000002" } },
    // An owner on file and no number at all. Before the encrypted door this
    // listing had no way to be answered on a phone: the sticky bar only
    // appeared when there was a number to put in it.
    { id: "h-nophone", title: "Room whose agent left no number", type: "room", listing: "rent",
      price_tzs: 180000, period: "month", currency: "TZS", region: "Dar es Salaam",
      area: "Mbezi", lat: DAR.lat, lng: DAR.lng, created_at: now,
      owner_user_id: OWNER, amenities: [], photos: [], videos: [], min_months: 1,
      details: {}, agent: { name: "Neema Kileo", phone: "" } },
  ],
  trucks: [
    { id: "t-own", title: "Canter for hire", truck_type: "canter", capacity_tonnes: 3,
      price_tzs: 60000, period: "trip", region: "Dar es Salaam", area: "Mbezi",
      lat: DAR.lat, lng: DAR.lng, created_at: now, owner_user_id: OWNER,
      photos: [], owner: { name: "Rashid", phone: "+255700000003" } },
  ],
  services: [
    { id: "s-own", title: "Electrician — wiring and repairs", category: "electrical",
      price_tzs: 40000, rate_type: "per_job", region: "Dar es Salaam", area: "Mbezi",
      lat: DAR.lat, lng: DAR.lng, created_at: now, owner_user_id: OWNER,
      photos: [], owner: { name: "Neema", phone: "+255700000004" } },
  ],
  day_jobs: [
    { id: 1, title: "Loading workers needed", company_name: "Dar Movers",
      company_phone: "+255700000005", region: "Dar es Salaam", area: "Mbezi",
      lat: DAR.lat, lng: DAR.lng, workers_needed: 10, claimed_count: 2,
      pay_tzs: 15000, work_date: "2026-08-30", status: "open",
      created_at: now, expires_at: soon },
  ],
};

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
      return req.respond({ status: 200,
        headers: { "content-type": "application/javascript" }, body: SUPABASE_STUB });
    }
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url) ||
        /cdn\.jsdelivr\.net.*(maplibre|leaflet).*\.css/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    if (/cdn\.jsdelivr\.net.*(maplibre|leaflet)/.test(url)) {
      return req.respond({ status: 200,
        headers: { "content-type": "application/javascript" },
        body: chainStub(/leaflet/.test(url) ? "L" : "maplibregl") });
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
    if (/supabase\.co|router\.project-osrm|nominatim|overpass/.test(url)) {
      return req.respond({ status: 200,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: "{}" });
    }
    req.continue();
  });

  const until = async (label, fn, ms = 20000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await page.evaluate(fn).catch(() => false)) return;
      if (Date.now() > deadline) {
        const state = await page.evaluate(() => ({
          url: location.href,
          reach: !!window.PMReach,
          body: (document.body.textContent || "").replace(/\s+/g, " ").slice(0, 220),
        })).catch((e) => ({ unreadable: String(e) }));
        process.stdout.write("  gave up waiting for " + label + ". state=" +
          JSON.stringify(state) + "\n  errors=" + JSON.stringify(errs.slice(0, 5)) + "\n");
        throw new Error("timed out waiting for " + label);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  // Read the message link on whatever page is open: its href, its words, and
  // whether it is inside the same block as the phone buttons.
  const readDoor = () => page.evaluate(() => {
    const a = document.querySelector("[data-pm-to]");
    if (!a) return null;
    return {
      href: a.getAttribute("href"),
      to: a.getAttribute("data-pm-to"),
      label: (a.querySelector("span") || {}).textContent || "",
      sub: (a.querySelector("small") || {}).textContent || "",
      icon: !!a.querySelector("svg"),
      // The phone buttons it has to sit beside — not off in a corner.
      besideCall: !!(a.parentElement &&
        a.parentElement.querySelector('a[href^="tel:"]')),
    };
  });

  const WANT = "p-message.html?to=" + encodeURIComponent("user_2abcDEFghiJKLmno");
  const seen = {};

  for (const [name, url] of [
    ["house",   BASE + "/house.html?id=h-own"],
    ["truck",   BASE + "/truck.html?id=t-own"],
    ["service", BASE + "/service.html?id=s-own"],
  ]) {
    process.stdout.write("\n" + name + "\n");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await until(name + " detail to render", () => !!document.querySelector("[data-pm-to]"));
    const door = await readDoor();
    seen[name] = door;
    ok(door && door.href === WANT,
       "the link opens an encrypted thread with the owner and carries nothing else",
       JSON.stringify(door));
    ok(door && door.besideCall,
       "it sits with the phone buttons, not somewhere else on the page",
       JSON.stringify(door));
    ok(door && /no phone number/i.test(door.sub),
       "it says why somebody would choose it over the green button",
       door && door.sub);
    ok(door && door.icon && door.label.trim().length > 0,
       "it is labelled, in words and with an icon", JSON.stringify(door));

    // All three of these pages repaint the whole palette on their own body
    // selector, which beats the tokens on :root. Nothing above can see a
    // white slab under pale ink; --shot can.
    if (process.argv.includes("--shot")) {
      // The whole CTA block, in place. house.html hides its inline row at
      // phone widths in favour of the sticky bar, so a crop of that row is a
      // zero-height box — the page it lives on is what needs looking at.
      await page.evaluate(() => {
        const a = document.querySelector("[data-pm-to]");
        if (a) a.scrollIntoView({ block: "center" });
      });
      await new Promise((r) => setTimeout(r, 250));
      await page.screenshot({ path: `tests/shot_pm_reach_${name}.png` });
      process.stdout.write(`  wrote tests/shot_pm_reach_${name}.png\n`);
    }
  }

  process.stdout.write("\nday job\n");
  await page.goto(BASE + "/jobs.html", { waitUntil: "domcontentloaded", timeout: 30000 });
  await until("the jobs board to render",
    () => document.querySelectorAll(".job-card, [data-job-id], article").length > 0 ||
          /Loading workers/.test(document.body.textContent || ""));
  ok(await page.evaluate(() => !!window.PMReach),
     "the board builds its link with the same builder as the other three");

  process.stdout.write("\nA listing with nobody recorded against it\n");
  await page.goto(BASE + "/house.html?id=h-none", { waitUntil: "domcontentloaded", timeout: 30000 });
  await until("the ownerless listing to render", () => !!document.querySelector(".hx-hero__title"));
  const none = await page.evaluate(() => ({
    doors: document.querySelectorAll("[data-pm-to]").length,
    call: document.querySelectorAll('a[href^="tel:"]').length,
  }));
  ok(none.doors === 0, "grows no button that would go nowhere", JSON.stringify(none));
  ok(none.call > 0, "and still offers the phone number it does have", JSON.stringify(none));

  // --------------------------------------------------------------------------
  // The house detail page hides its inline contact row below 720px
  // (.hd-cta-row-mobile-hide) and hands the job to the sticky bar. So a door
  // added only to the card exists for desktop visitors and for nobody looking
  // for a room on a phone — which is everybody.
  process.stdout.write("\nOn a phone, where the sticky bar is the contact row\n");
  await page.goto(BASE + "/house.html?id=h-own", { waitUntil: "domcontentloaded", timeout: 30000 });
  await until("the sticky bar to be wired",
    () => { const s = document.getElementById("hdSticky"); return !!s && !s.hidden; });
  const sticky = await page.evaluate(() => {
    const vis = (el) => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
    const inline = document.querySelector(".hd-cta-row");
    const msg = document.getElementById("hdStickyMsg");
    return {
      inlineRowVisible: !!inline && inline.getBoundingClientRect().height > 0,
      msgVisible: vis(msg),
      msgHref: msg && msg.getAttribute("href"),
      msgLabel: msg && (msg.textContent || "").trim(),
      callVisible: vis(document.getElementById("hdStickyCall")),
      tapHeight: msg ? Math.round(msg.getBoundingClientRect().height) : 0,
    };
  });
  ok(!sticky.inlineRowVisible,
     "the inline row really is hidden at this width — so the sticky bar is the only door",
     JSON.stringify(sticky));
  ok(sticky.msgVisible && sticky.msgHref === WANT,
     "and the sticky bar carries the same encrypted link", JSON.stringify(sticky));
  ok(sticky.callVisible, "beside the phone button, not instead of it", JSON.stringify(sticky));
  ok(sticky.tapHeight >= 44,
     "at a real thumb size (" + sticky.tapHeight + "px)", JSON.stringify(sticky));

  process.stdout.write("\nA listing with an owner but no phone number\n");
  await page.evaluate(() => {}); // keep the page; the next goto reloads fixtures
  await page.goto(BASE + "/house.html?id=h-nophone", { waitUntil: "domcontentloaded", timeout: 30000 });
  await until("the phoneless listing to render", () => !!document.querySelector(".hx-hero__title"));
  const noPhone = await page.evaluate(() => {
    const s = document.getElementById("hdSticky");
    const vis = (el) => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
    return {
      barShown: !!s && !s.hidden,
      msg: vis(document.getElementById("hdStickyMsg")),
      call: vis(document.getElementById("hdStickyCall")),
      wa: vis(document.getElementById("hdStickyWa")),
    };
  });
  ok(noPhone.barShown && noPhone.msg,
     "the bar appears for a listing that has no number at all — it used to appear for nobody",
     JSON.stringify(noPhone));
  ok(!noPhone.call && !noPhone.wa,
     "and does not offer a Call button pointing at nothing", JSON.stringify(noPhone));

  process.stdout.write("\nAll four agree\n");
  const hrefs = Object.values(seen).map((d) => d && d.href);
  ok(hrefs.length === 3 && new Set(hrefs).size === 1,
     "house, truck and service produce one identical link, not three lookalikes",
     JSON.stringify(seen, null, 1));

  ok(errs.length === 0, "no page errors", errs.slice(0, 6).join("\n        "));
  process.stdout.write("\n" + pass + " passed, " + fail + " failed\n");
} finally {
  await browser.close();
}
process.exit(fail === 0 ? 0 : 1);
