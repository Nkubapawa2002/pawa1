// ============================================================================
// pm_listing_send_test.mjs — sending a room, a service or a truck into a
// conversation, in a real browser.
//
// tests/pm_listing_card_test.mjs proves the wire format and the origin fence
// without a browser. What only a browser can answer is the other half: that
// the door actually EXISTS on every catalogue, that all three build the same
// link from one builder so they cannot drift, and that the card at the far end
// fills in from the catalogue rather than from anything carried in the
// message.
//
// That last one is the point of the whole feature. Before it, a room went from
// one person to another as a screenshot: no price you can trust, no link, no
// way to tell whether it is still free, and no way to reach whoever posted it.
// So the assertions here are about the card holding the CATALOGUE's answer —
// including "this is not on Pawa any more", which is a real answer and the one
// a screenshot can never give.
//
//   usage:  node server.js     then, in another shell:
//           node tests/pm_listing_send_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
const now = new Date().toISOString();
const OWNER = "user_2abcDEFghiJKLmno";
const DAR = { lat: -6.7924, lng: 39.2083 };

const FIXTURES = {
  houses: [
    { id: "h-send", title: "Master room, Mikocheni", type: "room", listing: "rent",
      price_tzs: 450000, period: "month", currency: "TZS", region: "Dar es Salaam",
      area: "Mikocheni", lat: DAR.lat, lng: DAR.lng, created_at: now,
      owner_user_id: OWNER, posted_by_owner: true, verified: true,
      amenities: [], photos: [], videos: [], min_months: 1, details: {},
      agent: { name: "Asha Mmbaga", phone: "+255700000001" } },
  ],
  trucks: [
    { id: "t-send", title: "Canter for hire", truck_type: "canter", capacity_tonnes: 3,
      price_tzs: 60000, period: "trip", region: "Dar es Salaam", area: "Mbezi",
      lat: DAR.lat, lng: DAR.lng, created_at: now, owner_user_id: OWNER,
      photos: [], owner: { name: "Rashid", phone: "+255700000003" } },
  ],
  services: [
    { id: "s-send", title: "Electrician, wiring and repairs", category: "electrical",
      price_tzs: 40000, rate_type: "per_job", region: "Dar es Salaam", area: "Mbezi",
      lat: DAR.lat, lng: DAR.lng, created_at: now, owner_user_id: OWNER,
      photos: [], owner: { name: "Neema", phone: "+255700000004" } },
  ],
  day_jobs: [],
};

// `mode` is the only difference between the two runs below. "signed-in" has a
// session from the first paint; "guest" has none until signInAnonymously() is
// called, which is exactly the shape that hid the bug this file now guards:
// the deep link is picked up once an identity exists, and a guest does not
// have one when boot() first asks.
const makeStub = (mode) => `(function () {
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
  // A signed-in reader, because the deep link is only picked up once there is
  // an identity to send as. The guest path is the same two calls in the guest
  // gate, and is asserted separately.
  var USER = { id: "user_reader", email: "reader@example.com", user_metadata: {} };
  var live = ${mode === "guest" ? "null" : "USER"};
  var session = function () {
    return Promise.resolve({ data: { session: live ? { user: live } : null, user: live }, error: null });
  };
  var noSession = function () { return Promise.resolve({ data: { session: null, user: null }, error: null }); };
  window.supabase = {
    createClient: function () {
      return {
        from: builder,
        rpc: function () { return Promise.resolve({ data: [], error: null }); },
        auth: {
          getSession: session, getUser: session,
          signInAnonymously: function () {
            live = { id: "guest_reader", email: null, user_metadata: { is_guest: true } };
            return session();
          },
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
const section = (s) => process.stdout.write("\n" + s + "\n");

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  protocolTimeout: 120000,
});
// One tab, one session mode. The guest run needs a tab of its own, because a
// session is not something a page can be talked out of once it has one.
async function openTab(mode) {
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
        headers: { "content-type": "application/javascript" }, body: makeStub(mode) });
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
    if (/arcgisonline|basemaps\.cartocdn|api\.mapbox|maptiler|tile\.openstreetmap|unsplash|locationiq|supabase\.co\/storage/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
    }
    if (/supabase\.co|router\.project-osrm|nominatim|overpass/.test(url)) {
      return req.respond({ status: 200,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: "{}" });
    }
    req.continue();
  });

  // Wait on a CONDITION, never on a clock. A slow machine reporting "the
  // button is missing" because it looked 200ms early is a false alarm that
  // costs an afternoon: see tests/browser_test notes and the slow-host trap.
  const until = async (label, fn, ms = 20000, arg) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await page.evaluate(fn, arg).catch(() => false)) return true;
      if (Date.now() > deadline) {
        const state = await page.evaluate(() => ({
          url: location.href,
          card: !!window.PMListingCard,
          body: (document.body.textContent || "").replace(/\s+/g, " ").slice(0, 200),
        })).catch((e) => ({ unreadable: String(e) }));
        process.stdout.write("  gave up waiting for " + label + ". state=" +
          JSON.stringify(state) + "\n  errors=" + JSON.stringify(errs.slice(0, 5)) + "\n");
        return false;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  return { page, errs, until };
}

try {
  const { page, errs, until } = await openTab("signed-in");

  // ---- 1. the door, on all three catalogues --------------------------------
  section("1. Every catalogue offers to send the listing on");
  const doors = {};
  for (const [kind, path, id, sel] of [
    ["house",   "house.html?id=h-send",     "h-send", "#hdSendBtn"],
    ["service", "service.html?id=s-send",   "s-send", ".sd-cta-send"],
    ["truck",   "truck.html?id=t-send",     "t-send", ".td-cta-send"],
  ]) {
    errs.length = 0;
    await page.goto(`${BASE}/${path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await until(kind + " send door", (s) => {
      const n = document.querySelector(s);
      return !!n && !n.hidden && !!n.getAttribute("href");
    }, 25000, sel);
    const got = await page.evaluate((s) => {
      const n = document.querySelector(s);
      if (!n) return null;
      return { hidden: n.hidden, href: n.getAttribute("href"),
               text: (n.textContent || "").trim(),
               label: n.getAttribute("aria-label") || "" };
    }, sel);
    ok(!!got && !got.hidden && !!got.href, kind + ": the door is on the page", JSON.stringify(got));
    doors[kind] = got;
    ok(errs.length === 0, kind + ": no page errors", errs.slice(0, 3).join(" ~ "));

  }

  section("2. One builder, so the three cannot drift");
  {
    const shapes = Object.entries(doors).map(([kind, d]) =>
      (d && d.href || "").replace(/%3A[^&]*/, "%3A<id>"));
    ok(shapes.every((s) => s.startsWith("p-message.html?listing=")),
       "all three links are p-message.html?listing=<kind>:<id>", JSON.stringify(shapes));
    ok(new Set(shapes.map((s) => s.split("&")[0].replace(/=[a-z]+/, "="))).size === 1,
       "and they are the same shape, not three lookalikes", JSON.stringify(shapes));
    ok(Object.values(doors).every((d) => !/[?&](to|u|i)=/.test(d.href || "")),
       "none of them carries a recipient: who to show a room to is chosen on the messages screen");
    ok((doors.house.href || "").includes("listing=house%3Ah-send"), "the house link names the house",
       doors.house.href);
    ok((doors.truck.href || "").includes("listing=truck%3At-send"), "the truck link names the truck",
       doors.truck.href);
    ok((doors.service.href || "").includes("listing=service%3As-send"), "the service link names the service",
       doors.service.href);
  }

  // ---- 3. the card at the far end -----------------------------------------
  section("3. The card quotes the catalogue, not the message");
  errs.length = 0;
  await page.goto(`${BASE}/p-message.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  ok(await until("PMListingCard", () => !!window.PMListingCard && !!window.DataStore),
     "p-message.html loads the module");

  const drawn = await page.evaluate(async () => {
    const box = document.createElement("div");
    box.id = "lcTest";
    // A real listing, and one that is not there any more. Both are answers.
    box.innerHTML =
      window.PMListingCard.card({ kind: "house", id: "h-send" }, { reach: true }) +
      window.PMListingCard.card({ kind: "house", id: "h-vanished" }, { reach: true });
    document.body.appendChild(box);
    await window.PMListingCard.hydrate(box);
    const nodes = [].slice.call(box.querySelectorAll(".pm-lc"));
    return nodes.map((n) => ({
      pending: n.hasAttribute("data-lc-pending"),
      gone: n.classList.contains("is-gone"),
      text: (n.textContent || "").replace(/\s+/g, " ").trim(),
      go: (n.querySelector(".pm-lc-b.is-go") || {}).getAttribute
        ? n.querySelector(".pm-lc-b.is-go").getAttribute("href") : "",
      reach: (function () {
        const a = n.querySelector(".pm-lc-reach a");
        return a ? a.getAttribute("href") : "";
      })(),
      priceFont: (function () {
        const p = n.querySelector(".pm-lc-p");
        return p ? getComputedStyle(p).fontFamily : "";
      })(),
    }));
  });

  const live = drawn[0] || {};
  const gone = drawn[1] || {};
  ok(!live.pending, "the card stops being pending once it is filled in");
  ok(/Master room, Mikocheni/.test(live.text), "it shows the title the catalogue holds", live.text);
  ok(/450,000 TZS/.test(live.text), "and the price the catalogue holds", live.text);
  ok(/Mikocheni/.test(live.text), "and where it is", live.text);
  ok(/mono|JetBrains/i.test(live.priceFont), "the price is in the mono face money uses everywhere else",
     live.priceFont);
  ok(/house\.html\?id=h-send/.test(live.go || ""), "the card opens the listing's own page", live.go);
  ok(/p-message\.html\?to=/.test(live.reach || ""),
     "and offers the encrypted door to whoever posted it, without leaving the conversation", live.reach);

  ok(!gone.pending && gone.gone, "a listing that is not there stops spinning and says so");
  ok(/not on Pawa any more/i.test(gone.text) || /halipo tena/i.test(gone.text),
     "in words, which is the answer a screenshot can never give", gone.text);
  ok(!/h-vanished/.test(gone.go || "") && !gone.go,
     "and its See-the-listing button is removed rather than left pointing at nothing", gone.go);

  section("4. Arriving holding a listing");
  {
    // Attached through the same function the ?listing= link calls, because the
    // strip is what the SENDER checks before choosing anybody: it has to name
    // the room, and it has to say that a recipient is still missing.
    const strip = await page.evaluate(async () => {
      window.PMPlaceUI.attachListing({ kind: "house", id: "h-send", title: "Master room, Mikocheni" });
      const hint = document.getElementById("pmPlaceHint");
      const at = document.getElementById("pmAttach");
      return {
        hintHidden: !hint || hint.hidden,
        hint: hint ? (hint.textContent || "").replace(/\s+/g, " ").trim() : "",
        atHidden: !at || at.hidden,
        at: at ? (at.textContent || "").replace(/\s+/g, " ").trim() : "",
        holdsPlace: !!window.PMPlaceUI.pending(),
        holdsListing: !!window.PMPlaceUI.pendingListing(),
      };
    });
    ok(strip.holdsListing, "the composer is holding the listing");
    ok(!strip.holdsPlace, "and nothing else: a pin and a listing are never held at the same time");
    ok(/Master room, Mikocheni/.test(strip.hint + " " + strip.at),
       "the strip names the room, so the sender can see which one they picked up",
       JSON.stringify(strip));
    ok(/Choose who|Chagua/i.test(strip.hint),
       "and says a recipient is still missing, because the link never chose one", strip.hint);

    const cleared = await page.evaluate(() => {
      window.PMPlaceUI.clear();
      return { holdsListing: !!window.PMPlaceUI.pendingListing(),
               hidden: (document.getElementById("pmAttach") || {}).hidden !== false };
    });
    ok(!cleared.holdsListing && cleared.hidden, "and putting it down really puts it down");

    const swapped = await page.evaluate(() => {
      window.PMPlaceUI.attachListing({ kind: "house", id: "h-send", title: "Master room" });
      window.PMPlaceUI.attachPlace({ lat: -6.79, lng: 39.2, acc: 20, label: "Gate", source: "link" });
      return { holdsPlace: !!window.PMPlaceUI.pending(),
               holdsListing: !!window.PMPlaceUI.pendingListing() };
    });
    ok(swapped.holdsPlace && !swapped.holdsListing,
       "picking up a pin puts the listing down, rather than trying to send both");
  }

  ok(errs.length === 0, "no page errors", errs.slice(0, 4).join(" ~ "));

  section("5. Following the door from a catalogue page");
  {
    // The whole journey, as a link: house.html builds it, p-message.html reads
    // it. Asserted end to end because the two halves are in different files
    // and a shape agreed in one of them is not agreed at all.
    errs.length = 0;
    const href = doors.house.href;
    await page.goto(`${BASE}/${href}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    const held = await until("the listing to be picked up",
      () => !!(window.PMPlaceUI && window.PMPlaceUI.pendingListing()), 25000);
    ok(held, "arriving on the link leaves the composer holding the listing");
    const what = await page.evaluate(() => {
      const l = window.PMPlaceUI && window.PMPlaceUI.pendingListing();
      return l ? { kind: l.kind, id: l.id, url: l.url } : null;
    });
    ok(what && what.kind === "house" && what.id === "h-send",
       "the right one, read back off the link", JSON.stringify(what));
    ok(await page.evaluate(() => {
      const el = document.getElementById("pmChats");
      return !el || !el.hidden;
    }), "and it lands on the conversations, which is where a recipient is chosen");
    ok(errs.length === 0, "no page errors", errs.slice(0, 4).join(" ~ "));
  }

  section("6. A guest follows the same door");
  {
    // The reader most likely to be sent a room is the one with no account,
    // and they meet the name gate before anything else. boot() picks the link
    // up only once an identity exists, and a guest has none when boot() asks,
    // so the gate used to swallow the listing whole: they typed a name, landed
    // on the agent list, and the room they had followed a link to send was
    // simply gone with nothing said.
    const g = await openTab("guest");
    await g.page.goto(`${BASE}/p-message.html?listing=truck%3At-send&t=Canter`,
                      { waitUntil: "domcontentloaded", timeout: 30000 });
    ok(await g.until("the guest gate", () => !!document.getElementById("pmGuestGo")),
       "a reader with no account is asked for a name first");
    ok(await g.page.evaluate(() => !window.PMPlaceUI.pendingListing()),
       "and is holding nothing yet, because there is nobody to send as");

    await g.page.type("#pmGuestName", "Mwanaidi");
    await g.page.click("#pmGuestGo");
    const kept = await g.until("the listing to survive the gate",
      () => !!(window.PMPlaceUI && window.PMPlaceUI.pendingListing()), 25000);
    ok(kept, "naming yourself does not throw the listing away");
    const what = await g.page.evaluate(() => {
      const l = window.PMPlaceUI && window.PMPlaceUI.pendingListing();
      const people = document.getElementById("pmPeople");
      return { kind: l && l.kind, id: l && l.id, onPeople: !!people && !people.hidden };
    });
    ok(what.kind === "truck" && what.id === "t-send", "and it is still the right one",
       JSON.stringify(what));
    ok(what.onPeople,
       "a guest lands on the agents, which is where the recipient they still have to choose is");
    ok(g.errs.length === 0, "no page errors", g.errs.slice(0, 4).join(" ~ "));
  }
} finally {
  await browser.close();
}

process.stdout.write("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
