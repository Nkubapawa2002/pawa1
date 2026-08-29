// ============================================================================
//  Home search — the box that now actually searches the app
//
//  It used to say "Search homes, services…" and then send every query to
//  houses.html?q=, so "fundi umeme" and "canter Mbezi" both landed in the rooms
//  directory and found nothing. It now searches all four verticals in place,
//  through the same ExploreIndex / ExploreQuery / ExploreRank the Explore tab
//  uses, so the two cannot disagree about what a query means.
//
//  Everything external is answered locally: no quota, no Supabase needed.
//
//  Usage: node server.js   then:  node tests/home_search_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";

// One of each vertical, so a query has something of every kind to find or miss.
const HOUSES = [
  { id: "h1", title: "Bedsitter, Sinza Madukani", type: "apartment", room_kind: "bedsitter",
    price_tzs: 180000, period: "month", listing: "rent", region: "Dar es Salaam", area: "Sinza",
    lat: -6.77, lng: 39.23, available: true, created_at: "2026-08-20T10:00:00Z" },
  { id: "h2", title: "Master room, Mwenge", type: "house", room_kind: "master",
    price_tzs: 260000, period: "month", listing: "rent", region: "Dar es Salaam", area: "Mwenge",
    lat: -6.77, lng: 39.24, available: true, created_at: "2026-08-21T10:00:00Z" },
];
const SERVICES = [
  { id: "s1", title: "Fundi umeme wa nyumba", category: "electrical", region: "Dar es Salaam",
    area: "Sinza", lat: -6.77, lng: 39.23, created_at: "2026-08-22T10:00:00Z", price_tzs: 30000 },
  { id: "s2", title: "Mama lishe, chakula cha mchana", category: "cooking", region: "Dar es Salaam",
    area: "Kariakoo", lat: -6.81, lng: 39.27, created_at: "2026-08-23T10:00:00Z" },
];
const TRUCKS = [
  { id: "t1", title: "Canter ya kuhamia", truck_type: "canter", region: "Dar es Salaam",
    area: "Mbezi", lat: -6.73, lng: 39.19, price_tzs: 120000, created_at: "2026-08-24T10:00:00Z" },
];
const JOBS = [
  { id: "j1", title: "Kushusha lori la saruji", company_name: "Bonite", region: "Dar es Salaam",
    area: "Ilala", lat: -6.81, lng: 39.28, pay_tzs: 15000, status: "open",
    created_at: "2026-08-25T10:00:00Z", expires_at: "2099-01-01T00:00:00Z" },
];

const stub = `window.supabase={createClient:function(){
var M={houses:${JSON.stringify(HOUSES)},services:${JSON.stringify(SERVICES)},trucks:${JSON.stringify(TRUCKS)},day_jobs:${JSON.stringify(JOBS)}};
function q(tbl){var b={_t:tbl};["select","eq","neq","gt","gte","lt","lte","is","or","order","limit","in"].forEach(function(m){b[m]=function(){return b}});
b.then=function(r,j){return Promise.resolve({data:M[b._t]||[],error:null}).then(r,j)};return b}
return{rpc:function(){return Promise.resolve({data:[],error:null})},from:q,
auth:{getSession:function(){return Promise.resolve({data:{session:null},error:null})},
getUser:function(){return Promise.resolve({data:{user:null},error:null})},
onAuthStateChange:function(){return{data:{subscription:{unsubscribe:function(){}}}}}},
channel:function(){return{on:function(){return this},subscribe:function(){return this}}},removeChannel:function(){},
storage:{from:function(){return{getPublicUrl:function(){return{data:{publicUrl:""}}}}}}}}};`;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let passed = 0;
const fails = [];
const ok = (cond, what, detail) => {
  if (cond) { passed++; console.log("  PASS  " + what); }
  else { fails.push(what); console.log("  FAIL  " + what); if (detail) console.log("        " + detail); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.setViewport({ width: 390, height: 844 });
await page.setRequestInterception(true);
page.on("request", (r) => {
  const u = r.url();
  if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: { "access-control-allow-origin": "*" } });
  if (/cdn\.jsdelivr\.net.*supabase/.test(u)) return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: stub });
  if (/maptiler|mapbox|arcgisonline|cartocdn|tile\.openstreetmap/.test(u))
    return r.respond({ status: 200, headers: { "content-type": "image/png", "access-control-allow-origin": "*" }, body: PNG });
  if (/supabase\.co/.test(u)) return r.respond({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
  if (/fonts\.googleapis|fonts\.gstatic/.test(u)) return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
  r.continue();
});
await page.evaluateOnNewDocument(() => { try { localStorage.setItem("pawa-theme", "dark"); } catch (e) {} });
await page.goto(BASE + "/index.html", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => !!window.HomeSearch && !!window.ExploreIndex, { timeout: 30000 });

const find = (q) => page.evaluate(async (query) => {
  const r = await window.HomeSearch._search(query);
  return r.map((i) => i.kind + ":" + i.title);
}, q);

// ---------------------------------------------------------------------------
console.log("\n1. It searches all four verticals, not just rooms");
{
  ok((await find("bedsitter")).join() === "room:Bedsitter, Sinza Madukani",
     "a room word finds the room", (await find("bedsitter")).join(" | "));
  const svc = await find("fundi umeme");
  ok(svc[0] === "service:Fundi umeme wa nyumba",
     "a Swahili trade finds the service, which the old box could never reach", svc.join(" | "));
  ok((await find("canter"))[0] === "truck:Canter ya kuhamia", "a truck word finds the truck");
  ok((await find("saruji"))[0] === "job:Kushusha lori la saruji", "and a job word finds the day job");
}

// ---------------------------------------------------------------------------
console.log("\n2. A suggestion list is not a directory page");
{
  // rank() ORDERS everything, which is right for Explore and wrong here:
  // typing "saruji" and being offered a bedsitter, a canter and a cook under
  // the one real hit reads as broken, however correctly they are ranked.
  const one = await find("saruji");
  ok(one.length === 1, "an unambiguous query returns only what matched", one.join(" | "));
  const none = await find("zzzznotathing");
  ok(none.length === 0, "and a query nothing matches returns nothing", none.join(" | "));

  // A bare place is the exception: textScore has no terms to compare and gives
  // everything a flat 0.5, because "what is in Sinza" IS the question.
  const place = await find("sinza");
  ok(place.length > 1, "a bare place name still returns everything there", String(place.length));
}

// ---------------------------------------------------------------------------
console.log("\n3. The box shows them before you commit to leaving");
{
  await page.click("#haSearch");
  await page.type("#haSearch", "fundi", { delay: 30 });
  await page.waitForSelector("#haSearchPanel .hs-row", { timeout: 15000 });
  await sleep(300);
  const ui = await page.evaluate(() => ({
    rows: [...document.querySelectorAll("#haSearchPanel .hs-row")].map((el) => ({
      t: el.querySelector(".hs-row-t")?.textContent,
      d: el.querySelector(".hs-row-d")?.textContent || null,
      p: el.querySelector(".hs-row-p")?.textContent || null,
      href: el.getAttribute("href"),
    })),
    expanded: document.getElementById("haSearch").getAttribute("aria-expanded"),
    role: document.getElementById("haSearch").getAttribute("role"),
    clearShown: !document.getElementById("haSearchClear").hidden,
  }));
  ok(ui.rows.length === 3, "two matches and a way to see everything", String(ui.rows.length));
  ok(ui.rows[0].href === "service.html?id=s1", "a row goes straight to the listing", ui.rows[0].href);
  ok(/Sinza/.test(ui.rows[0].d || ""), "and says what kind it is and where", ui.rows[0].d);
  ok(ui.rows[0].p === "TZS 30k", "with its price in mono", ui.rows[0].p);
  ok(/explore\.html\?q=fundi/.test(ui.rows[2].href), "the last row hands the query to Explore", ui.rows[2].href);
  ok(ui.expanded === "true" && ui.role === "combobox", "announced as a combobox to a screen reader");
  ok(ui.clearShown, "and a clear button appears once there is something to clear");
}

// ---------------------------------------------------------------------------
console.log("\n4. Keyboard, because a search box without arrows is a text field");
{
  await page.keyboard.press("ArrowDown");
  let st = await page.evaluate(() => ({
    active: document.querySelector("#haSearchPanel .hs-row.is-active .hs-row-t")?.textContent,
    aria: document.getElementById("haSearch").getAttribute("aria-activedescendant"),
  }));
  ok(st.active === "Fundi umeme wa nyumba", "down arrow highlights the first result", st.active);
  ok(st.aria === "hs-opt-0", "and the highlight is announced, not just painted", String(st.aria));

  await page.keyboard.press("ArrowDown");
  st = await page.evaluate(() => document.querySelector("#haSearchPanel .hs-row.is-active .hs-row-t")?.textContent);
  ok(st === "Mama lishe, chakula cha mchana", "it walks down the list", String(st));

  await page.keyboard.press("Escape");
  const closed = await page.evaluate(() => document.getElementById("haSearchPanel").hidden);
  ok(closed, "escape closes it");
}

// ---------------------------------------------------------------------------
console.log("\n5. The field is reachable wherever you are on the page");
{
  // It sat between a busy header and the category tabs, and scrolled away. To
  // search you had to scroll back to the top, so people used the tabs instead.
  const stick = await page.evaluate(async () => {
    const box = document.getElementById("haSearchBox");
    const before = Math.round(box.getBoundingClientRect().top);
    window.scrollTo(0, 900);
    await new Promise((r) => setTimeout(r, 250));
    const after = Math.round(box.getBoundingClientRect().top);
    window.scrollTo(0, 0);
    return { before, after };
  });
  ok(stick.before > 60, "it starts under the header", String(stick.before));
  ok(stick.after >= 0 && stick.after < 60, "and pins to the top once the feed scrolls past",
     stick.before + " -> " + stick.after);

  // The notification bell floats in the same corner.
  const clash = await page.evaluate(() => {
    const b = document.getElementById("pawa-notify-bell").getBoundingClientRect();
    const s = document.getElementById("haSearchBox").getBoundingClientRect();
    return b.left < s.right && b.right > s.left && b.top < s.bottom && b.bottom > s.top;
  });
  ok(!clash, "without running under the floating bell");
}

// ---------------------------------------------------------------------------
console.log("\n6. Nothing of the old box is left to mislead");
{
  const gone = await page.evaluate(() => ({
    filterBtn: !!document.getElementById("haSearchBtn"),
    placeholder: document.getElementById("haSearch").getAttribute("placeholder"),
  }));
  // The 50px green square carried a FILTER icon and an aria-label of "Search",
  // and navigated to houses.html. It looked like one thing, said another, did
  // a third.
  ok(!gone.filterBtn, "the filter-looking button that said Search is gone");
  ok(/trucks/i.test(gone.placeholder) && /jobs/i.test(gone.placeholder),
     "and the placeholder names what the box can now actually find", gone.placeholder);
  ok(errs.length === 0, "no page errors across the whole run", errs.slice(0, 2).join(" | "));
}

console.log("\n" + passed + " passed, " + fails.length + " failed");
await browser.close();
process.exit(fails.length ? 1 : 0);
