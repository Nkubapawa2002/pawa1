// ============================================================================
// request_map_test.mjs — the map inside "Tell us what you want".
//
// The modal used to resolve a point invisibly: typed area → geocoder → GPS →
// the centroid of a whole region, with a 3 km radius nobody chose. Every one of
// those outcomes printed the same "Request sent". The map exists to end that,
// so what this file checks is not "is there a map" but the three promises the
// map makes:
//
//   1. it shows the point the request will be SENT on — not a decorative one;
//   2. the caption names WHICH rule chose that point, so the centroid of a
//      region is never dressed up as somebody's street;
//   3. the pin and the radius the seeker sets are the pin and the radius that
//      reach the database.
//
// …and the fourth, quieter promise: when the map cannot load at all, the modal
// still sends, and says so rather than showing an empty grey box.
//
// Leaflet is stubbed, not fetched. The point is the wiring — which calls this
// file makes and with what — and a real tile server in a test only adds a way
// to fail that has nothing to do with the code under test.
//
//   usage:  node server.js      then, in another shell:
//           node tests/request_map_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

// Supabase stub that REMEMBERS the rpc payload — the whole question this file
// asks is whether the map's pin and radius are what got sent.
const SUPABASE_STUB = `window.__rpc = [];
window.supabase = { createClient: function () {
  var noSession = function () { return Promise.resolve({ data: { session: null, user: null }, error: null }); };
  function builder() { var b = {};
    ["select","eq","neq","gt","gte","lt","lte","in","is","or","filter","order","limit","range","match","insert","delete","update","upsert"]
      .forEach(function (m) { b[m] = function () { return b; }; });
    b.then = function (r, j) { return Promise.resolve({ data: [], error: null }).then(r, j); };
    return b; }
  return { from: builder,
    rpc: function (name, args) { window.__rpc.push({ name: name, args: args });
      return Promise.resolve({ data: null, error: null }); },
    auth: { getSession: noSession, getUser: noSession, signOut: noSession,
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; } },
    storage: { from: function () { return { getPublicUrl: function () { return { data: { publicUrl: "" } }; } }; } },
    channel: function () { return { on: function () { return this; }, subscribe: function () { return this; } }; },
    removeChannel: function () {} };
} };`;

// A Leaflet stand-in with the surface request-place.js actually uses, and a
// window.__map record of every call, so the assertions can read what was drawn
// instead of guessing from pixels.
const LEAFLET_STUB = `(function () {
  window.__map = { center: null, zoom: null, marker: null, circle: null, clicks: [], removed: 0 };
  function handlers() { var h = {}; return {
    on: function (ev, fn) { (h[ev] = h[ev] || []).push(fn); return this; },
    off: function () { return this; },
    fire: function (ev, arg) { (h[ev] || []).forEach(function (fn) { fn(arg); }); },
  }; }
  function Layer() { var o = handlers(); o.addTo = function () { return o; }; return o; }
  var L = {
    map: function () {
      var m = handlers();
      m.setView = function (ll, z) { window.__map.center = ll; window.__map.zoom = z; return m; };
      // The real map frames the CIRCLE, so the stub records what that framing
      // resolved to: the centre it would land on and the zoom ceiling it was
      // given. Those are the two things the assertions care about.
      m.fitBounds = function (b, opts) {
        window.__map.center = [b.lat, b.lng];
        window.__map.zoom = (opts && opts.maxZoom) || null;
        window.__map.fitRadius = b.radius;
        return m;
      };
      m.invalidateSize = function () { return m; };
      m.whenReady = function (fn) { fn(); return m; };
      m.remove = function () { window.__map.removed++; return m; };
      m.hasLayer = function () { return false; };
      m.removeLayer = function () { return m; };
      m.addLayer = function () { return m; };
      window.__map.api = m;
      return m;
    },
    tileLayer: function () { return Layer(); },
    layerGroup: function () { return Layer(); },
    marker: function (ll) {
      var o = handlers(); var pos = ll;
      o.addTo = function () { window.__map.marker = o; return o; };
      o.setLatLng = function (v) { pos = v; o.pos = v; return o; };
      o.getLatLng = function () { return { lat: pos[0], lng: pos[1] }; };
      o.pos = ll; o.draggable = true;
      return o;
    },
    circle: function (ll, opts) {
      var o = handlers();
      o.addTo = function () { window.__map.circle = o; return o; };
      o.setLatLng = function (v) { o.pos = v; return o; };
      o.setRadius = function (r) { o.radius = r; return o; };
      o.pos = ll; o.radius = (opts && opts.radius) || 0;
      o.getBounds = function () { return { lat: o.pos[0], lng: o.pos[1], radius: o.radius }; };
      return o;
    },
    control: { zoom: function () { return { addTo: function () {} }; },
               layers: function () { return { addTo: function () {} }; } },
  };
  window.L = L;
})();`;

const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
});

// `leaflet: false` makes the CDN answer 500 for the map library only — the way
// a request behaves on a connection that drops one file, which is exactly the
// case the "the map didn't load" line exists for.
async function open(path, { leaflet = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => {
    const txt = m.text();
    // In the no-map run the failed Leaflet fetch IS the scenario — counting the
    // browser's note about it would mean the case could never pass.
    const expectedMiss = !leaflet && /leaflet|failed to load resource/i.test(txt);
    if (m.type() === "error" && !/^\[[a-z-]+\]/i.test(txt) && !/favicon/i.test(txt) && !expectedMiss) {
      errs.push("console: " + txt.slice(0, 160));
    }
  });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*",
        "access-control-allow-methods": "*" } });
    }
    if (/leaflet.*\.js$/.test(url)) {
      if (!leaflet) return req.respond({ status: 500, body: "" });
      return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: LEAFLET_STUB });
    }
    if (/leaflet.*\.css$/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    if (/cdn\.jsdelivr\.net.*supabase/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: SUPABASE_STUB });
    }
    if (/cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    if (/arcgisonline|basemaps\.cartocdn|api\.mapbox|tile\.openstreetmap|supabase\.co\/storage/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
    }
    // `locationiq` is the one that matters and the one that was missing: geo.js
    // talks to us1.locationiq.com, not to Nominatim, so without it every typed
    // character in the area box went to the live shared-quota geocoder. It
    // answered 429 often enough to fail "no page errors" at random.
    if (/supabase\.co|locationiq|nominatim|router\.project-osrm/.test(url)) {
      return req.respond({ status: 200, headers: {
        "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
    }
    req.continue();
  });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem("lang", "en"); } catch (_) {} });
  await page.goto(`${BASE}/${path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1400));
  return { page, errs };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Sending reverse-geocodes the final point for the district the agent board
// routes on, and that call is allowed up to 3 s before the modal gives up on
// it. Poll for the confirmation instead of guessing a number: a fixed sleep
// here is a test that fails on a slow machine and tells you nothing true.
async function waitForSent(page, ms = 12000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const done = await page.evaluate(() =>
      !!document.querySelector(".rp-done") ||
      !!(document.getElementById("rpMsg") || {}).textContent);
    if (done) return;
    await wait(200);
  }
}

// Fill the fields the modal refuses to send without, so every assertion below
// is about the map rather than about validation.
async function fillRequired(page, region = "Mwanza") {
  await page.evaluate((reg) => {
    const r = document.getElementById("rpRegion");
    r.value = reg;
    r.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("rpPhone").value = "0712345678";
  }, region);
  await wait(700);
}

try {
  // ==========================================================================
  process.stdout.write("\n1. The map is there, and it is about the area\n");
  // ==========================================================================
  const { page, errs } = await open("p-chat.html");
  await page.click("#pcRequestBtn");
  await wait(1200);

  ok((await page.$("#rpMap")) !== null, "the request modal carries a map");
  ok((await page.$("#rpRadius")) !== null, "…and a radius control");

  // The map must sit with the location fields, not after the price or the
  // phone: it explains the answer to "where", and it belongs beside the
  // question it answers.
  const order = await page.evaluate(() => {
    const ids = ["rpRegion", "rpWhere", "rpMap", "rpRadius", "rpListing", "rpPhone"];
    return ids.map((id) => {
      const el = document.getElementById(id);
      return { id, top: el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : -1 };
    });
  });
  const at = (id) => (order.find((o) => o.id === id) || {}).top;
  ok(at("rpWhere") < at("rpMap") && at("rpMap") < at("rpListing"),
     "it sits under the area field and above the rest of the form",
     JSON.stringify(order));

  ok(await page.evaluate(() => {
    const el = document.getElementById("rpMap");
    const b = el.getBoundingClientRect();
    return b.width > 200 && b.height > 120;
  }), "it is actually visible — a real box, not a collapsed div");

  // ==========================================================================
  process.stdout.write("\n2. It says WHICH rule chose the point\n");
  // ==========================================================================
  const noRegion = await page.evaluate(() => document.getElementById("rpMapCap").textContent.trim());
  ok(/choose a region|use your location/i.test(noRegion),
     "with nothing filled in it asks for something rather than inventing a point",
     JSON.stringify(noRegion));

  await fillRequired(page, "Mwanza");
  const regionCap = await page.evaluate(() => ({
    cap: document.getElementById("rpMapCap").textContent.trim(),
    soft: document.getElementById("rpMapCap").classList.contains("rp-cap-soft"),
    centre: window.__map && window.__map.center,
    zoom: window.__map && window.__map.zoom,
    fitRadius: window.__map && window.__map.fitRadius,
  }));
  ok(/middle of/i.test(regionCap.cap) && /mwanza/i.test(regionCap.cap),
     "a region alone is captioned as the MIDDLE of that region, by name",
     JSON.stringify(regionCap.cap));
  ok(regionCap.soft, "…and is styled as the approximation it is");
  ok(Array.isArray(regionCap.centre) && Math.abs(regionCap.centre[0] + 2.52) < 1.2 &&
     Math.abs(regionCap.centre[1] - 32.9) < 1.2,
     "the map moved to Mwanza, not to a hardcoded corner of Dar",
     JSON.stringify(regionCap.centre));
  ok(regionCap.fitRadius === 3000,
     "the view is framed on the CIRCLE, so the area being searched is visible rather than a dot behind the pin",
     "fitRadius=" + regionCap.fitRadius);
  ok(regionCap.zoom <= 12,
     "…and a region centroid is held to a looser zoom ceiling than a real pin, so it never reads as a street address",
     String(regionCap.zoom));

  // ==========================================================================
  process.stdout.write("\n3. The pin the seeker places wins, and stays\n");
  // ==========================================================================
  await page.evaluate(() => {
    window.__map.api.fire("click", { latlng: { lat: -6.81, lng: 39.28 } });
  });
  await wait(500);
  const pinned = await page.evaluate(() => ({
    cap: document.getElementById("rpMapCap").textContent.trim(),
    firm: document.getElementById("rpMapCap").classList.contains("rp-cap-firm"),
    marker: window.__map.marker && window.__map.marker.pos,
    circle: window.__map.circle && window.__map.circle.pos,
  }));
  ok(/your pin/i.test(pinned.cap), "tapping the map is captioned as the seeker's own pin",
     JSON.stringify(pinned.cap));
  ok(pinned.firm, "…and no longer hedged");
  ok(pinned.marker && Math.abs(pinned.marker[0] + 6.81) < 1e-6,
     "the marker moved to the tap", JSON.stringify(pinned.marker));
  ok(pinned.circle && Math.abs(pinned.circle[0] + 6.81) < 1e-6,
     "and the circle followed it", JSON.stringify(pinned.circle));

  // Typing an area afterwards must not yank the pin away. People drop the pin
  // and then name it; moving it out from under them is the one unforgivable
  // behaviour for a control like this.
  await page.evaluate(() => {
    const w = document.getElementById("rpWhere");
    w.value = "Mikocheni";
    w.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await wait(1400);
  const afterTyping = await page.evaluate(() => ({
    cap: document.getElementById("rpMapCap").textContent.trim(),
    marker: window.__map.marker && window.__map.marker.pos,
  }));
  ok(/your pin/i.test(afterTyping.cap) && Math.abs(afterTyping.marker[0] + 6.81) < 1e-6,
     "typing an area name afterwards does NOT move the pin the seeker placed",
     JSON.stringify(afterTyping));

  // ==========================================================================
  process.stdout.write("\n4. The radius is a real number the seeker sets\n");
  // ==========================================================================
  const radius = await page.evaluate(async () => {
    const el = document.getElementById("rpRadius");
    el.value = "12";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    return {
      out: document.getElementById("rpRadiusOut").textContent.trim(),
      help: document.getElementById("rpRadiusHelp").textContent.trim(),
      drawn: window.__map.circle && window.__map.circle.radius,
      min: el.min, max: el.max,
      tap: Math.round(el.getBoundingClientRect().height),
    };
  });
  ok(/12/.test(radius.out), "the readout follows the slider", JSON.stringify(radius.out));
  ok(radius.drawn === 12000, "the circle is redrawn in metres to match", String(radius.drawn));
  ok(/12 km/.test(radius.help) && /agent/i.test(radius.help),
     "the help line says what a wider radius costs and buys", JSON.stringify(radius.help));
  ok(radius.tap >= 40, "the slider is a 40px row a thumb can find", String(radius.tap) + "px");

  // ==========================================================================
  process.stdout.write("\n5. What the map shows is what gets sent\n");
  // ==========================================================================
  await page.evaluate(() => document.getElementById("rpGo").click());
  await waitForSent(page);
  const sent = await page.evaluate(() => {
    const call = (window.__rpc || []).find((c) => c.name === "house_demand_create");
    return { call: call ? call.args : null, done: !!document.querySelector(".rp-done") };
  });
  ok(sent.done, "the request sends");
  ok(sent.call && Math.abs(sent.call.p_lat + 6.81) < 1e-6 && Math.abs(sent.call.p_lng - 39.28) < 1e-6,
     "the point in the payload is the point the map was showing",
     JSON.stringify(sent.call && { lat: sent.call.p_lat, lng: sent.call.p_lng }));
  ok(sent.call && sent.call.p_radius_m === 12000,
     "the radius in the payload is the radius the seeker chose — not the old hardcoded 3000",
     String(sent.call && sent.call.p_radius_m));

  // ==========================================================================
  process.stdout.write("\n6. Closing it takes the map with it\n");
  // ==========================================================================
  await page.evaluate(() => { const b = document.querySelector(".rp-back"); if (b) b.remove(); });
  await page.click("#pcRequestBtn");
  await wait(1200);
  await page.keyboard.press("Escape");
  await wait(500);
  ok(await page.evaluate(() => window.__map.removed >= 1),
     "Leaflet is torn down on close, so repeated opens don't stack live maps",
     "removed=" + (await page.evaluate(() => window.__map.removed)));

  ok(errs.length === 0, "no page errors along the way", errs.slice(0, 4).join(" | "));

  // ==========================================================================
  process.stdout.write("\n7. When the map cannot load at all\n");
  // ==========================================================================
  const { page: p2, errs: e2 } = await open("p-chat.html", { leaflet: false });
  await p2.click("#pcRequestBtn");
  await wait(2000);
  const dead = await p2.evaluate(() => ({
    veil: (document.getElementById("rpMapVeil").textContent || "").trim(),
    veilShown: !document.getElementById("rpMapVeil").hidden,
    cap: document.getElementById("rpMapCap").textContent.trim(),
    sendable: !document.getElementById("rpGo").disabled,
  }));
  ok(dead.veilShown && /didn'?t load/i.test(dead.veil),
     "it says the map didn't load instead of showing an empty grey box",
     JSON.stringify(dead.veil));
  ok(dead.sendable, "…and the request can still be sent");

  await fillRequired(p2, "Dodoma");
  const capBeforeSend = await p2.evaluate(() =>
    document.getElementById("rpMapCap").textContent.trim());
  await p2.evaluate(() => document.getElementById("rpGo").click());
  await waitForSent(p2);
  const deadSend = await p2.evaluate((cap) => {
    const call = (window.__rpc || []).find((c) => c.name === "house_demand_create");
    return { cap, call: call ? { lat: call.args.p_lat, lng: call.args.p_lng, r: call.args.p_radius_m } : null };
  }, capBeforeSend);
  ok(/middle of/i.test(deadSend.cap) && /dodoma/i.test(deadSend.cap),
     "the caption still tells the truth about the point with no map to draw it on",
     JSON.stringify(deadSend.cap));
  ok(deadSend.call && Number.isFinite(deadSend.call.lat),
     "and the request still carries coordinates", JSON.stringify(deadSend.call));
  ok(e2.length === 0, "no page errors in the no-map case", e2.slice(0, 4).join(" | "));

  // ==========================================================================
  process.stdout.write("\n8. The region already on the form disambiguates the name\n");
  // ==========================================================================
  // Tanzania reuses place names: there is a Mikocheni in Dar and a Mikocheni in
  // Arusha, 600 km apart, and the geocoder returns them in its own order. The
  // seeker has already told us the region — a modal that then drops the pin in
  // the wrong one is worse than the old no-map version, because now it shows
  // them a confident picture of the wrong place.
  const { page: p3, errs: e3 } = await open("p-chat.html");
  await p3.evaluate(() => {
    const dar = { name: "Mikocheni", context: "Kinondoni, Dar es-Salaam",
      full: "Mikocheni, Kinondoni, Dar es-Salaam", lat: -6.76, lng: 39.25 };
    const arusha = { name: "Mikocheni", context: "Karatu, Arusha",
      full: "Mikocheni, Karatu, Arusha", lat: -3.33, lng: 35.75 };
    // Arusha first, the way the geocoder actually returned it.
    window.pawaGeo.suggest = () => Promise.resolve([arusha, dar]);
    window.pawaGeo.reverse = () => Promise.resolve({ address: {
      ward: "Hananasif", city: "Dar es-Salaam", county: "Kinondoni", state: "Dar es Salaam" } });
  });
  await p3.click("#pcRequestBtn");
  await wait(1200);
  await fillRequired(p3, "Dar es Salaam");
  await p3.evaluate(() => {
    const w = document.getElementById("rpWhere");
    w.value = "Mikocheni";
    w.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await wait(1600);
  const disamb = await p3.evaluate(() => ({
    firstRow: (document.querySelector("#rpSug button b") || {}).textContent || "",
    firstCtx: (document.querySelector("#rpSug button span") || {}).textContent || "",
    marker: window.__map.marker && window.__map.marker.pos,
    cap: document.getElementById("rpMapCap").textContent.trim(),
  }));
  ok(/dar es/i.test(disamb.firstCtx),
     "the suggestion in the chosen region is offered first, not the one 600 km away",
     JSON.stringify(disamb.firstCtx));
  ok(disamb.marker && Math.abs(disamb.marker[0] + 6.76) < 1e-6,
     "and the pin goes to that one too, so the list and the map agree",
     JSON.stringify(disamb.marker));
  ok(/closest match/i.test(disamb.cap),
     "a geocoded guess is captioned as a guess, with an invitation to correct it",
     JSON.stringify(disamb.cap));

  // A pin dropped on a blank patch of map should still reach the agent with a
  // name on it: `ward` is how Tanzanian addresses are actually given, and it is
  // what Nominatim returns where suburb and neighbourhood are both absent.
  await p3.evaluate(() => {
    document.getElementById("rpWhere").value = "";
    window.__map.api.fire("click", { latlng: { lat: -6.7924, lng: 39.2789 } });
  });
  await wait(1500);
  const named = await p3.evaluate(() => document.getElementById("rpWhere").value);
  ok(/hananasif/i.test(named),
     "dropping a pin names the spot from its ward, rather than leaving the area blank",
     JSON.stringify(named));
  ok(e3.length === 0, "no page errors", e3.slice(0, 4).join(" | "));

} finally {
  await browser.close();
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
