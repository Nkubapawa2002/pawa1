// ============================================================================
// pm_pin_seal_test.mjs — a pin sent in a conversation, used exactly.
//
// Two things are proved here, and they are the two halves of one promise.
//
//   1. A pin somebody sent inside an encrypted P-Message thread reaches the
//      listing form WITHOUT passing through a human being. No copying, no
//      retyping, no reading six decimal places down a phone. The agent taps a
//      row and the marker is standing on the sender's coordinates.
//
//   2. It stays exactly there, or the listing stops claiming it did. Move the
//      pin off what somebody sent and the form withdraws the claim in words,
//      offers the way back, and — if the agent saves anyway — records the pin
//      as their own rather than theirs.
//
// It also proves the negative that matters: a pin the AGENT sent is not
// offered back to them as evidence. Evidence that travels in a circle is not
// evidence.
//
//   usage:  node server.js     then, in another shell:
//           node tests/pm_pin_seal_test.mjs [--shot]
// ============================================================================
import puppeteer from "puppeteer";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://localhost:8080";
const ME = "user_agent_0001";
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// The pins, and the coordinates that must survive the whole journey unchanged.
const AMINA = { lat: -6.7924, lng: 39.2083, acc: 25 };
const JUMA = { lat: -6.8015, lng: 39.271, acc: 40 };
const MINE = { lat: -6.7, lng: 39.1 };

// A place message is ordinary text — see js/lib/pm-place.js on why that is the
// design and not a shortcut. Composing the fixtures by hand rather than
// calling compose() is deliberate: the test should fail if the wire format
// changes, not quietly follow it.
const placeBody = (label, p) =>
  (label ? label + "\n" : "") +
  p.lat.toFixed(6) + ", " + p.lng.toFixed(6) +
  (p.acc ? "  (~" + p.acc + " m)" : "") + "\n" +
  "https://www.google.com/maps?q=" + p.lat.toFixed(6) + "," + p.lng.toFixed(6);

const INBOX = [
  { thread_id: "t-direct", kind: "direct", title: null, region: null,
    other_id: "u-amina", other_name: "Amina Mushi", other_region: "Dar es Salaam",
    other_area: "Mbezi", other_guest: false, last_at: iso(now - 36e5), unread: 0 },
  { thread_id: "t-room", kind: "group", title: "Tungi agents", region: "Dar es Salaam",
    other_id: null, other_name: null, other_region: null, other_area: null,
    other_guest: false, last_at: iso(now - 3 * 864e5), unread: 0 },
];

const MSGS = {
  "t-direct": [
    { id: "m1", sent_at: iso(now - 40e5), sender_id: "u-amina", sender_name: "Amina Mushi",
      sender_guest: false, reply_to: null,
      body_plain: "Habari, nimefika kwenye nyumba." },
    { id: "m2", sent_at: iso(now - 36e5), sender_id: "u-amina", sender_name: "Amina Mushi",
      sender_guest: false, reply_to: null,
      body_plain: placeBody("Blue gate, second house from the corner", AMINA) },
    // Sent BY the agent. It must never appear in the list: a pin of the
    // agent's own coming back to them is not somebody standing at a gate.
    { id: "m3", sent_at: iso(now - 30e5), sender_id: ME, sender_name: "Agent",
      sender_guest: false, reply_to: null,
      body_plain: placeBody("Is this the right plot?", MINE) },
  ],
  "t-room": [
    { id: "m4", sent_at: iso(now - 3 * 864e5), sender_id: "u-juma", sender_name: "Juma",
      sender_guest: true, reply_to: null,
      body_plain: placeBody("Kwa Mzee Salum, mlango wa bati", JUMA) },
  ],
};

// Two saved listings, identical except for the one thing this whole feature
// is about: whether the pin is still standing where somebody put it.
const HOUSE_BASE = {
  type: "room", listing: "rent", price_tzs: 250000, period: "month", currency: "TZS",
  region: "Dar es Salaam", area: "Mbezi", lat: AMINA.lat, lng: AMINA.lng,
  created_at: iso(now), owner_user_id: ME, amenities: [], photos: [], videos: [],
  min_months: 1, details: {}, agent: { name: "Agent", phone: "+255700000001" },
};

const FIXTURES = {
  houses: [
    { ...HOUSE_BASE, id: "h-exact", title: "Rooms behind the blue gate",
      pin: { v: 1, via: "p-message", exact: true, acc: 25, at: iso(now - 36e5),
             from_name: "Amina Mushi", from_user: "u-amina", from_guest: false,
             origin: { lat: AMINA.lat, lng: AMINA.lng }, off_m: 0 } },
    // The agent moved it. The listing is perfectly fine; it just may not claim
    // her pin any more.
    { ...HOUSE_BASE, id: "h-moved", title: "Rooms the agent re-pinned",
      pin: { v: 1, via: "p-message", exact: false, acc: 25, at: iso(now - 36e5),
             from_name: "Amina Mushi", from_user: "u-amina", from_guest: false,
             origin: { lat: AMINA.lat, lng: AMINA.lng }, off_m: 96 } },
    // Everything listed before this feature existed.
    { ...HOUSE_BASE, id: "h-old", title: "Rooms listed before any of this" },
  ],
  regions: [{ name: "Dar es Salaam" }, { name: "Mwanza" }],
  agent_profiles: [{ user_id: ME, name: "Agent", region: "Dar es Salaam",
                     area_of_operations: "Mbezi", phone: "+255700000001" }],
  admins: [],
};

const SUPABASE_STUB = `(function () {
  var FIX = ${JSON.stringify(FIXTURES)};
  var INBOX = ${JSON.stringify(INBOX)};
  var MSGS = ${JSON.stringify(MSGS)};
  var ME = ${JSON.stringify(ME)};
  window.__inserts = [];
  window.__updates = [];
  window.__noPinColumn = false;
  var REJECT_PIN = { code: "PGRST204",
    message: "Could not find the 'pin' column of 'houses' in the schema cache" };

  function builder(table) {
    // What was written, if anything — so .insert(row).select() resolves with
    // the row that was actually sent rather than a fixture. The page checks
    // owner_user_id on what comes back, and a fixture would pass that check
    // while hiding the payload this test exists to read.
    var pending = null;
    // maybeSingle()/single() resolve with ONE row, not a list. Getting this
    // wrong is not a small thing: AgentProfile.ensure() reads the profile that
    // way, decides an array is an incomplete profile, and opens a blocking
    // modal that the page then waits on forever.
    var one = false;
    var rejectWith = null;
    var b = {};
    ["select", "eq", "neq", "gt", "gte", "lt", "lte", "in", "is", "or", "filter",
     "order", "limit", "range", "match"].forEach(function (m) {
      b[m] = function () { return b; };
    });
    b.maybeSingle = b.single = function () { one = true; return b; };
    b.insert = function (p) {
      pending = p; window.__inserts.push(p);
      // A database that has not had supabase/features/house/houses_pin.sql run
      // against it answers exactly like this — PostgREST's PGRST204, not
      // Postgres's own wording. The listing still has to save.
      if (window.__noPinColumn && p && "pin" in p) { rejectWith = REJECT_PIN; }
      return b;
    };
    b.update = function (p) { pending = p; window.__updates.push(p); return b; };
    b.upsert = function (p) { pending = p; return b; };
    b.delete = function () { return b; };
    b.then = function (res, rej) {
      if (rejectWith) {
        var err = rejectWith; rejectWith = null; pending = null;
        return Promise.resolve({ data: null, error: err }).then(res, rej);
      }
      var rows = pending ? [pending] : (FIX[table] || []);
      var data = one ? (rows[0] || null) : rows;
      return Promise.resolve({ data: data, error: null }).then(res, rej);
    };
    return b;
  }

  var session = { user: { id: ME, email: "agent@example.com", is_anonymous: false,
                          user_metadata: { name: "Agent" } } };
  var withSession = function () {
    return Promise.resolve({ data: { session: session, user: session.user }, error: null });
  };

  window.supabase = {
    createClient: function () {
      return {
        from: builder,
        rpc: function (name, args) {
          if (name === "pm_inbox") return Promise.resolve({ data: INBOX, error: null });
          if (name === "pm_thread_messages") {
            return Promise.resolve({ data: MSGS[(args || {}).p_thread] || [], error: null });
          }
          if (name === "pm_sender_keys_for") return Promise.resolve({ data: [], error: null });
          return Promise.resolve({ data: null, error: null });
        },
        auth: {
          getSession: withSession, getUser: withSession,
          signInWithPassword: withSession, signUp: withSession,
          signOut: function () { return Promise.resolve({ error: null }); },
          onAuthStateChange: function () {
            return { data: { subscription: { unsubscribe: function () {} } } };
          },
        },
        storage: { from: function () { return {
          upload: function () { return Promise.resolve({ data: {}, error: null }); },
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

// The real p-crypto opens sealed bytes with a key held in this browser. There
// are no sealed bytes in a fixture, and generating some would be testing
// WebCrypto rather than the page. So the ciphertext is the plaintext and open()
// hands it straight back — every line above the crypto is exercised unchanged.
const CRYPTO_STUB = `(function () {
  window.PMCrypto = {
    available: function () { return true; },
    load: function () { return { publicKey: "pk-test", privateKey: "sk-test" }; },
    save: function () { return true; },
    forget: function () {},
    useForSession: function () {},
    generateIdentity: function () {
      return Promise.resolve({ publicKey: "pk-test", privateKey: "sk-test" });
    },
    fingerprint: function () { return Promise.resolve("ff".repeat(16)); },
    seal: function () { return Promise.resolve({}); },
    open: function (row) { return Promise.resolve(row && row.body_plain); },
    openWithSenderKey: function (row) { return Promise.resolve(row && row.body_plain); },
    openSenderKey: function () { return Promise.resolve(null); },
    newSenderKey: function () { return Promise.resolve({}); },
    nextGeneration: function () { return 1; },
    distributeSenderKey: function () { return Promise.resolve([]); },
  };
})();`;

const chainStub = (globalName) => `(function () {
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

// A private profile per run. Puppeteer's default userDataDir is one fixed
// path, so two of these tests running at once — two shells, two sessions, a
// watch loop — kill each other with "browser is already running", which reads
// exactly like a test failure and is not one.
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  protocolTimeout: 120000,
  userDataDir: mkdtempSync(join(tmpdir(), "pawa-pin-seal-")),
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 460, height: 1000, deviceScaleFactor: 1 });
  const light = process.argv.includes("--light");
  if (light) {
    // Before the first paint, the way js/core/theme.js expects to find it.
    await page.evaluateOnNewDocument(() => {
      try { localStorage.setItem("pawa-theme", "light"); } catch (_) {}
    });
  }

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
    if (/\/js\/lib\/p-crypto\.js/.test(url)) {
      return req.respond({ status: 200,
        headers: { "content-type": "application/javascript" }, body: CRYPTO_STUB });
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
    if (/supabase\.co|router\.project-osrm|nominatim|locationiq|overpass/.test(url)) {
      return req.respond({ status: 200,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: "{}" });
    }
    req.continue();
  });

  const until = async (label, fn, ms = 25000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await page.evaluate(fn).catch(() => false)) return;
      if (Date.now() > deadline) {
        const state = await page.evaluate(() => ({
          url: location.href,
          avail: window.PMPlaces ? (window.PMPlaces.available() || "ready") : "no-lib",
          cached: window.PMPlaces && JSON.stringify(window.PMPlaces.cached()),
          key: !!(window.PMCrypto && window.PMCrypto.load()),
          formHidden: (document.getElementById("ahFormSection") || {}).hidden,
          authHidden: (document.getElementById("ahAuthCard") || {}).hidden,
          dashHidden: (document.getElementById("ahDashboard") || {}).hidden,
          warn: ((document.getElementById("ahWarn") || {}).textContent || "").slice(0, 200),
          ds: !!(window.DataStore && window.DataStore.sb),
          pmList: (document.getElementById("ahPmList") || {}).innerHTML ? "filled" : "empty",
          pmMsg: (document.getElementById("ahPmMsg") || {}).textContent || "",
          seal: (document.getElementById("ahPinSeal") || {}).className,
          coords: (document.getElementById("ahPinCoords") || {}).textContent || "",
          body: (document.body.textContent || "").replace(/\s+/g, " ").slice(0, 160),
        })).catch((e) => ({ unreadable: String(e) }));
        process.stdout.write("  gave up waiting for " + label + ". state=" +
          JSON.stringify(state) + "\n  errors=" + JSON.stringify(errs.slice(0, 5)) + "\n");
        throw new Error("timed out waiting for " + label);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  // Screenshots have to be taken WHERE they happen. One at the end of the run
  // photographs whatever page the last assertion left open, which is how a
  // suite ends up with a picture of something it never tested.
  const shooting = process.argv.includes("--shot");
  const shot = async (name, selector) => {
    if (!shooting) return;
    if (selector) {
      // Twice, with a pause between. The nearby-places panel below the seal
      // fills in a moment after the pin moves and pushes everything up, so a
      // single scroll photographs whatever slid into frame afterwards.
      const scroll = () => page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.scrollIntoView({ block: "center" });
      }, selector);
      await scroll();
      await new Promise((r) => setTimeout(r, 700));
      await scroll();
      await new Promise((r) => setTimeout(r, 300));
    }
    const file = "tests/shot_pm_" + name + (light ? "_light" : "") + ".png";
    await page.screenshot({ path: file });
    process.stdout.write("        wrote " + file + "\n");
  };

  const rows = () => page.evaluate(() => {
    const list = document.getElementById("ahPmList");
    if (!list) return [];
    return Array.from(list.querySelectorAll(".ah-place-row")).map((b) => ({
      title: (b.querySelector(".ah-place-t") || {}).textContent || "",
      detail: ((b.querySelector(".ah-place-d") || {}).textContent || "").replace(/\s+/g, " ").trim(),
      guest: !!b.querySelector(".ah-place-guest"),
    }));
  });

  const seal = () => page.evaluate(() => {
    const s = document.getElementById("ahPinSeal");
    if (!s || s.hidden) return null;
    return {
      cls: s.className,
      text: (s.textContent || "").replace(/\s+/g, " ").trim(),
      putBack: !!document.getElementById("ahPinPutBack"),
    };
  });

  const readout = () => page.evaluate(() =>
    ((document.getElementById("ahPinCoords") || {}).textContent || "").replace(/\s+/g, " ").trim());

  // ---- open the form ------------------------------------------------------
  process.stdout.write("\nthe pins people sent\n");
  await page.goto(BASE + "/agent-houses.html", { waitUntil: "domcontentloaded", timeout: 30000 });
  await until("the dashboard", () => {
    const d = document.getElementById("ahDashboard");
    return !!d && !d.hidden;
  });
  await page.evaluate(() => document.getElementById("ahNewBtn").click());
  await until("the listing form to open",
    () => !document.getElementById("ahFormSection").hidden);
  await until("the P-Message pins to be read out of the threads",
    () => !!document.querySelector("#ahPmList .ah-place-row"));

  const list = await rows();
  ok(list.length === 2,
     "both pins people sent are offered — one from a conversation, one from a room",
     JSON.stringify(list));
  ok(list.some((r) => /Blue gate/.test(r.title) && /Amina Mushi/.test(r.detail)),
     "the pin from the direct thread is named with who sent it",
     JSON.stringify(list));
  ok(list.some((r) => /Mzee Salum/.test(r.title) && /Tungi agents/.test(r.detail)),
     "the pin from the room says which room it was said in",
     JSON.stringify(list));
  ok(list.some((r) => /Juma/.test(r.detail) && r.guest),
     "and marks the person in the room who never proved who they are",
     JSON.stringify(list));
  ok(!list.some((r) => /right plot/.test(r.title)),
     "a pin the agent sent themselves is not offered back to them as evidence",
     JSON.stringify(list));

  // ---- use one, exactly ---------------------------------------------------
  process.stdout.write("\nusing it exactly\n");
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("#ahPmList .ah-place-row"))
      .find((x) => /Blue gate/.test(x.textContent));
    b.click();
  });
  await until("the pin to move", () => {
    const t = (document.getElementById("ahPinCoords") || {}).textContent || "";
    return /-6\.79240/.test(t);
  });

  const at = await readout();
  ok(/-6\.79240/.test(at) && /39\.20830/.test(at),
     "the marker stands on the coordinates she sent, to the digit — nothing retyped", at);

  let s = await seal();
  ok(s && /is-held/.test(s.cls), "the form says the pin is hers", JSON.stringify(s));
  ok(s && /Amina Mushi/.test(s.text) && /P-Message/i.test(s.text),
     "by name, and by where it came from", s && s.text);
  ok(s && /within 25 m/.test(s.text),
     "carrying the accuracy she reported, not one we invented", s && s.text);
  ok(s && /public listing/i.test(s.text),
     "and warns that her name goes on the public listing, beside the name itself",
     s && s.text);
  ok(s && !s.putBack, "with nothing to put back, because nothing has moved", JSON.stringify(s));
  await shot("pin_sealed", "#ahPinSeal");

  // ---- move it, and watch the claim be withdrawn --------------------------
  process.stdout.write("\nmoving it off her pin\n");
  await page.evaluate(() => {
    const box = document.getElementById("ahLocPaste");
    box.value = "-6.795000, 39.212000";
    document.getElementById("ahLocPasteGo").click();
  });
  await until("the seal to break", () => {
    const el = document.getElementById("ahPinSeal");
    return !!el && /is-moved/.test(el.className);
  });

  s = await seal();
  ok(s && /is-moved/.test(s.cls) && /Amina Mushi/.test(s.text),
     "the claim is withdrawn and says whose pin was left behind", s && s.text);
  ok(s && /\d{2,} m/.test(s.text), "and how far off it now is, as a number", s && s.text);
  ok(s && /own pin, not theirs/i.test(s.text),
     "and what will be saved if the agent leaves it there", s && s.text);
  ok(s && s.putBack, "the way back is one tap", JSON.stringify(s));
  await shot("pin_moved", "#ahPinSeal");

  await page.click("#ahPinPutBack");
  await until("the pin to go back", () => {
    const t = (document.getElementById("ahPinCoords") || {}).textContent || "";
    return /-6\.79240/.test(t);
  });
  s = await seal();
  ok(s && /is-held/.test(s.cls), "putting it back restores the claim", JSON.stringify(s));
  const back = await readout();
  ok(/-6\.79240/.test(back) && /39\.20830/.test(back),
     "on exactly the coordinates she sent, not near them", back);

  // ---- what the listing records ------------------------------------------
  process.stdout.write("\nwhat gets saved\n");
  await page.evaluate(() => {
    document.getElementById("ahTitle").value = "Two rooms behind the blue gate";
    document.getElementById("ahPrice").value = "250000";
    document.getElementById("ahForm").dispatchEvent(new Event("submit", { cancelable: true }));
  });
  await until("the listing to be written", () => (window.__inserts || []).length > 0);
  const wrote = await page.evaluate(() => window.__inserts[0]);

  ok(wrote && wrote.pin && wrote.pin.exact === true,
     "the row records that the pin is exactly where it was sent",
     JSON.stringify(wrote && wrote.pin));
  ok(wrote && wrote.pin && wrote.pin.via === "p-message",
     "and which door it came through", JSON.stringify(wrote && wrote.pin));
  ok(wrote && wrote.pin && wrote.pin.from_name === "Amina Mushi" &&
     wrote.pin.from_user === "u-amina",
     "and who sent it, by name and by account", JSON.stringify(wrote && wrote.pin));
  ok(wrote && wrote.pin && wrote.pin.acc === 25 && wrote.pin.off_m === 0,
     "with her accuracy and a zero drift", JSON.stringify(wrote && wrote.pin));
  ok(wrote && wrote.pin && wrote.pin.origin &&
     Math.abs(wrote.pin.origin.lat - (-6.7924)) < 1e-9 &&
     Math.abs(wrote.pin.origin.lng - 39.2083) < 1e-9,
     "and the coordinates as sent, kept so a later edit cannot lose them",
     JSON.stringify(wrote && wrote.pin));
  ok(wrote && Math.abs(wrote.lat - (-6.7924)) < 1e-9 && Math.abs(wrote.lng - 39.2083) < 1e-9,
     "and the listing itself is at that spot, unrounded",
     JSON.stringify(wrote && { lat: wrote.lat, lng: wrote.lng }));
  ok(wrote && wrote.pin && !("from_thread" in wrote.pin) && !("threadId" in wrote.pin),
     "the conversation it was said in stays on the device",
     JSON.stringify(wrote && wrote.pin));

  // ---- a database that has not run the SQL yet ---------------------------
  // The column is new. Every agent whose database predates it must still be
  // able to save a listing — losing the provenance, which is a shame, and not
  // the listing, which would be a fault.
  process.stdout.write("\nbefore the column exists\n");
  // A successful save closes the form itself, and it does so a tick or two
  // after the row lands. Reopening before that finishes gets the new form shut
  // again by the tail of the old save.
  await until("the form to close itself after saving",
    () => document.getElementById("ahFormSection").hidden);
  await page.evaluate(() => {
    window.__noPinColumn = true;
    window.__inserts.length = 0;
    document.getElementById("ahNewBtn").click();
  });
  await until("the form again", () => !document.getElementById("ahFormSection").hidden);
  await until("the pins again", () => !!document.querySelector("#ahPmList .ah-place-row"));
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("#ahPmList .ah-place-row"))
      .find((x) => /Blue gate/.test(x.textContent));
    b.click();
  });
  await until("the pin to move again", () =>
    /-6\.79240/.test((document.getElementById("ahPinCoords") || {}).textContent || ""));
  await page.evaluate(() => {
    document.getElementById("ahTitle").value = "Same rooms, older database";
    document.getElementById("ahPrice").value = "250000";
    document.getElementById("ahForm").dispatchEvent(new Event("submit", { cancelable: true }));
  });
  await until("the retry without the column", () => (window.__inserts || []).length >= 2);
  const retried = await page.evaluate(() => window.__inserts[window.__inserts.length - 1]);
  ok(retried && !("pin" in retried) && retried.title === "Same rooms, older database",
     "the listing saves without the column rather than failing",
     JSON.stringify(retried && Object.keys(retried)));
  ok(retried && Math.abs(retried.lat - (-6.7924)) < 1e-9,
     "and still at exactly the spot she sent, which is the part that cannot wait for a migration",
     JSON.stringify(retried && { lat: retried.lat, lng: retried.lng }));
  const setupCard = await page.evaluate(() =>
    /SQL|setup/i.test((document.getElementById("ahList") || {}).textContent || ""));
  ok(!setupCard,
     "and the agent is not thrown back to a wall of SQL half way through a listing");

  // ---- what a seeker is told ---------------------------------------------
  process.stdout.write("\nwhat the seeker sees\n");
  const provenance = async (id) => {
    await page.goto(BASE + "/house.html?id=" + id, { waitUntil: "domcontentloaded", timeout: 30000 });
    await until("house " + id, () => /Where it is/.test(document.body.textContent || ""));
    return page.evaluate(() => {
      const el = document.querySelector(".hd-pin-prov");
      return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : null;
    });
  };

  const exact = await provenance("h-exact");
  ok(exact && /Pinned exactly where/.test(exact),
     "a listing pinned by the person who was there says so", exact);
  ok(exact && /Amina Mushi/.test(exact), "and names her", exact);
  ok(exact && /sent from there in an encrypted message/.test(exact),
     "and says the pin came down an encrypted message, not a phone call", exact);
  ok(exact && /25 m/.test(exact), "with her accuracy", exact);
  await page.goto(BASE + "/house.html?id=h-exact", { waitUntil: "domcontentloaded", timeout: 30000 });
  await until("house h-exact again", () => !!document.querySelector(".hd-pin-prov"));
  await shot("pin_public", ".hd-pin-prov");

  const moved = await provenance("h-moved");
  ok(moved === null,
     "a listing the agent moved off her pin says nothing — silence, not a weaker claim",
     String(moved));

  const old = await provenance("h-old");
  ok(old === null, "and a listing from before any of this is unchanged", String(old));

  ok(errs.length === 0, "no page errors", errs.slice(0, 6).join("\n        "));
  process.stdout.write("\n" + pass + " passed, " + fail + " failed\n");
} finally {
  await browser.close();
}
process.exit(fail === 0 ? 0 : 1);
