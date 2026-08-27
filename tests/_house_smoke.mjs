// Scratch smoke run for the rebuilt house detail screen. Not a test — it just
// renders the page against a fixture and dumps what came out, so a wiring
// mistake shows up as a stack trace rather than a silent blank card.
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080/house.html";
const now = new Date().toISOString();

const FIXTURES = {
  houses: [{
    id: "h-mt9zvgaj-2fgu", title: "mpyaa", type: "house", listing: "rent",
    price_tzs: 60000000, currency: "TZS", period: "month",
    bedrooms: 4, bathrooms: 4, size_sqm: 89,
    region: "Dar es Salaam", area: "mwemberadu", address: "near muslim",
    lat: -6.836761, lng: 39.319987, amenities: [], furnished: null,
    photos: [], videos: [], description: "stay hamble", verified: false,
    available_from: "2026-09-22", created_at: now, owner_user_id: "u1",
    agent: { name: "Agent", phone: "0741632744", whatsapp: true },
    min_months: 4, agent_fee_tzs: 0, room_kind: "single",
    extra_costs: [
      { label: "Service charge", amount: 0, billing: "month" },
      { label: "Security", amount: 0, billing: "month" },
      { label: "Water", amount: 0, billing: "month" },
      { label: "Internet", amount: 0, billing: "month" },
    ],
    nearby: {
      schools: { label: "Schools", items: [
        { dist: 297, name: "Kibugumo Primary School" },
        { dist: 493, name: "Tungi Primary School" },
        { dist: 594, name: "Fray Luis Amigo Primary School" },
      ] },
      worship: { label: "Mosques & churches", items: [{ dist: 119, name: "muslim" }] },
      markets: { label: "Markets & shops", items: [{ dist: 792, name: "MK Supermarket" }] },
      services: { label: "Public services", items: [
        { dist: 1285, name: "Afroil" },
        { dist: 1399, name: "Kigamboni Police Station" },
        { dist: 1405, name: null },
      ] },
      food: { label: "Restaurants & cafes", items: [] },
      transport: { label: "Transport", items: [] },
    },
    details: {
      v: 1,
      rooms: [
        { kind: "single", note: "water tank", size: 39, count: 4, price: 60000000, period: "month", vacant: 4, ensuite: true },
        { kind: "mwembe radu", note: "water tank", size: 89, count: 1, price: 70000000, period: "month", vacant: null, ensuite: true },
      ],
      groups: [{ key: "rules", title: "Rules & regulations", items: [
        { label: "Contract", value: "Written, 12 months", note: "" },
        { label: "Deposit", value: "2 months, refundable", note: "" },
        { label: "Repairs", value: "Landlord: the building. Tenant: breakages.", note: "" },
      ] }],
    },
    pin: { v: 1, at: now, acc: 200, via: "p-message", exact: true, off_m: 0,
           from_name: "pawa", from_user: null, from_guest: false },
  }],
};

const SUPABASE_STUB = `(function () {
  var FIX = ${JSON.stringify(FIXTURES)};
  function builder(table) {
    var b = {};
    ["select","eq","neq","gt","gte","lt","lte","in","is","or","filter","order","limit","range","match"]
      .forEach(function (m) { b[m] = function () { return b; }; });
    b.then = function (res, rej) { return Promise.resolve({ data: FIX[table] || [], error: null }).then(res, rej); };
    return b;
  }
  var noSession = function () { return Promise.resolve({ data: { session: null, user: null }, error: null }); };
  window.supabase = { createClient: function () { return {
    from: builder,
    rpc: function () { return Promise.resolve({ data: null, error: null }); },
    auth: { getSession: noSession, getUser: noSession, signInWithPassword: noSession, signUp: noSession,
            signOut: function () { return Promise.resolve({ error: null }); },
            onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; } },
    storage: { from: function () { return { getPublicUrl: function () { return { data: { publicUrl: "" } }; } }; } },
    channel: function () { return { on: function () { return this; }, subscribe: function () { return this; } }; },
    removeChannel: function () {},
  }; } };
})();`;

const chainStub = (g) => `(function () {
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
  window.${g} = chain();
})();`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900 });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String((e && e.stack) || e).split("\n").slice(0, 3).join(" | ")));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (req.method() === "OPTIONS") return req.respond({ status: 204, headers: {
      "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (/cdn\.jsdelivr\.net.*supabase/.test(url))
      return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: SUPABASE_STUB });
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url) || /cdn\.jsdelivr\.net.*(maplibre|leaflet).*\.css/.test(url))
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    if (/cdn\.jsdelivr\.net.*(maplibre|leaflet)/.test(url))
      return req.respond({ status: 200, headers: { "content-type": "application/javascript" },
                           body: chainStub(/leaflet/.test(url) ? "L" : "maplibregl") });
    const rest = url.match(/supabase\.co\/rest\/v1\/([a-z_]+)/);
    if (rest) return req.respond({ status: 200,
      headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
      body: JSON.stringify(FIXTURES[rest[1]] || []) });
    if (/arcgisonline|basemaps\.cartocdn|api\.mapbox|tile\.openstreetmap|unsplash|supabase\.co\/storage/.test(url))
      return req.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
    if (/supabase\.co|router\.project-osrm|nominatim|locationiq|overpass/.test(url))
      return req.respond({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: "{}" });
    req.continue();
  });

  await page.goto(BASE + "?id=h-mt9zvgaj-2fgu", { waitUntil: "domcontentloaded", timeout: 30000 });

  const deadline = Date.now() + 20000;
  for (;;) {
    if (await page.evaluate(() => !!document.querySelector(".hx-hero__title")).catch(() => false)) break;
    if (Date.now() > deadline) { process.stdout.write("TIMED OUT\n"); break; }
    await new Promise((r) => setTimeout(r, 200));
  }

  const dump = await page.evaluate(() => ({
    title: document.querySelector(".hx-hero__title")?.textContent,
    rail: [...document.querySelectorAll(".hx-rail__link")].map(a => a.textContent),
    sections: [...document.querySelectorAll("section[id]")].map(s => s.id),
    headings: [...document.querySelectorAll(".hx-card h3")].map(n => n.textContent.trim()),
    moneyLead: document.querySelector("#sec-money h3")?.textContent,
    price: document.querySelector(".hd-price")?.textContent.replace(/\s+/g, " ").trim(),
    moveInTotal: document.querySelector(".hx-movein__total")?.textContent,
    moveInLines: [...document.querySelectorAll("#hxMoveinBody .hx-lines li")]
      .map(li => li.textContent.replace(/\s+/g, " ").trim()),
    roomTabs: [...document.querySelectorAll(".hx-roomtab")].map(b => b.textContent.replace(/\s+/g, " ").trim()),
    selectedRoom: document.querySelector(".hx-room__name")?.textContent,
    roomPrice: document.querySelector(".hx-room__price")?.textContent.replace(/\s+/g, " ").trim(),
    vacancy: document.querySelector(".hx-vacancy__row")?.textContent.trim(),
    roomTiles: [...document.querySelectorAll(".hx-specs")].map(g =>
      [...g.querySelectorAll(".hx-spec__lbl")].map(l => l.textContent)),
    accordion: [...document.querySelectorAll(".hx-acc__btn")].map(b => b.textContent.replace(/\s+/g, " ").trim()),
    nearby: [...document.querySelectorAll(".hd-nearby-cat")].map(c => c.textContent.replace(/\s+/g, " ").trim()),
    nearbySrc: document.querySelector(".hx-nearby-src")?.textContent,
    pinProv: document.querySelector(".hd-pin-prov")?.textContent.replace(/\s+/g, " ").trim(),
    bills: [...document.querySelectorAll(".hx-bill")].map(b => b.textContent.replace(/\s+/g, " ").trim()),
    stickyHidden: document.getElementById("hdSticky")?.hidden,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    accentResolved: getComputedStyle(document.body).getPropertyValue("--hx-accent").trim(),
    priceFont: document.querySelector(".hd-price") && getComputedStyle(document.querySelector(".hd-price")).fontFamily,
  }));

  process.stdout.write(JSON.stringify(dump, null, 2) + "\n");
  process.stdout.write("\nERRORS: " + JSON.stringify(errs, null, 2) + "\n");
} finally {
  await browser.close();
}
