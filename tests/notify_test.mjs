// ============================================================================
//  Notifications — the badge, the panel, and the theme toggle's auto-hide
//
//  Six things can be news: a new room, service, truck or day job, a message
//  nobody has read, and a group somebody added you to. js/core/notify.js counts
//  them against a mark this device keeps; js/lib/notify-ui.js draws them.
//
//  Everything external is answered locally, so this spends no quota and does
//  not need Supabase to be reachable. See the browser-test recipe.
//
//  Usage: node server.js   then:  node tests/notify_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const AN_HOUR_AGO = new Date(now - 3600000).toISOString();

const HOUSES = [
  { id: "r1", title: "Mwenge single, water tank", created_at: iso(60000), available: true },
  { id: "r2", title: "Sinza bedsitter", created_at: iso(120000), available: true },
  // Older than the mark: already seen, must not be counted.
  { id: "r0", title: "Ancient listing", created_at: iso(7200000), available: true },
];
const SERVICES = [{ id: "s1", title: "Fundi umeme, Kinondoni", created_at: iso(90000) }];
const TRUCKS = [];
const JOBS = [
  { id: "j1", title: "Offloading cement", created_at: iso(30000), status: "open" },
  { id: "j2", title: "Kupalilia shamba", created_at: iso(80000), status: "open" },
];
const INBOX = [
  { thread_id: "g1", kind: "group", title: "Mwanza house agents", unread: 2, last_at: iso(10000) },
  { thread_id: "t2", kind: "direct", other_name: "Juma", unread: 3, last_at: iso(20000) },
];

const stub = `window.supabase={createClient:function(){
var M={houses:${JSON.stringify(HOUSES)},services:${JSON.stringify(SERVICES)},trucks:${JSON.stringify(TRUCKS)},day_jobs:${JSON.stringify(JOBS)}};
function q(tbl){var b={_t:tbl};["select","eq","neq","gt","gte","lt","lte","is","or","order","limit","in"].forEach(function(m){b[m]=function(){return b}});
b.then=function(r,j){return Promise.resolve({data:M[b._t]||[],error:null}).then(r,j)};return b}
var s={user:{id:"me",email:"a@b.c",is_anonymous:false}};
return{rpc:function(n){if(n==="pm_inbox")return Promise.resolve({data:${JSON.stringify(INBOX)},error:null});
return Promise.resolve({data:[],error:null})},from:q,
auth:{getSession:function(){return Promise.resolve({data:{session:s},error:null})},
getUser:function(){return Promise.resolve({data:{user:s.user},error:null})},
onAuthStateChange:function(){return{data:{subscription:{unsubscribe:function(){}}}}}},
channel:function(){return{on:function(){return this},subscribe:function(){return this}}},removeChannel:function(){},
storage:{from:function(){return{getPublicUrl:function(){return{data:{publicUrl:""}}}}}}}}};`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

let passed = 0;
const fails = [];
const ok = (cond, what, detail) => {
  if (cond) { passed++; console.log("  PASS  " + what); }
  else { fails.push(what); console.log("  FAIL  " + what); if (detail) console.log("        " + detail); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });

/** A page whose device has looked before, unless `firstRun` says otherwise. */
async function open({ firstRun = false } = {}) {
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
  await page.evaluateOnNewDocument((since, fresh) => {
    try {
      localStorage.setItem("pawa-theme", "dark");
      if (!fresh) {
        localStorage.setItem("pawa_notify_seen", JSON.stringify({
          houses: since, services: since, trucks: since, jobs: since, threads: [], seededAt: since,
        }));
      }
    } catch (e) {}
  }, AN_HOUR_AGO, firstRun);
  await page.goto(BASE + "/index.html", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => !!window.Notify && !!document.getElementById("pawa-notify-bell"), { timeout: 30000 });
  return { page, errs, close: () => ctx.close() };
}

// ---------------------------------------------------------------------------
console.log("\n1. It counts what arrived since this device last looked");
{
  const t = await open();
  await t.page.waitForFunction(() => window.Notify.state().total > 0, { timeout: 20000 });
  const st = await t.page.evaluate(() => {
    const s = window.Notify.state();
    const by = {};
    s.groups.forEach((g) => { by[g.key] = g.count; });
    return { total: s.total, by, badge: document.querySelector(".pawa-notify-badge").textContent };
  });
  ok(st.by.houses === 2, "two rooms, and the one older than the mark is not news", JSON.stringify(st.by));
  ok(st.by.services === 1, "one service");
  ok(st.by.trucks === 0, "no trucks, so no row for them");
  ok(st.by.jobs === 2, "two day jobs");
  ok(st.by.messages === 5, "five unread messages across the inbox", String(st.by.messages));
  ok(st.by.groups === 1, "one group nobody on this device had seen", String(st.by.groups));
  ok(st.total === 11, "and the badge adds them up", String(st.total));
  ok(st.badge === "9+", "capped at 9+ so the pill never outgrows the button", st.badge);
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n2. A first run is not told the catalogue is news");
{
  // Somebody opening the app for the first time has no unread history, they
  // have a catalogue. "47 new rooms" would be true and useless, and it teaches
  // them to ignore the badge before it ever means anything.
  const t = await open({ firstRun: true });
  await sleep(2500);
  const st = await t.page.evaluate(() => ({
    total: window.Notify.state().total,
    seeded: !!JSON.parse(localStorage.getItem("pawa_notify_seen") || "{}").seededAt,
    badgeHidden: document.querySelector(".pawa-notify-badge").hidden,
  }));
  ok(st.seeded, "the mark is seeded on the first run");
  // Messages are live state, not history, so they still count on day one.
  ok(st.total === 5, "and only the unread messages count, not the whole catalogue", String(st.total));
  ok(!st.badgeHidden, "the badge still shows them");
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n3. The panel says what changed, with examples");
{
  const t = await open();
  await t.page.waitForFunction(() => window.Notify.state().total > 0, { timeout: 20000 });
  await t.page.click("#pawa-notify-bell");
  await t.page.waitForSelector(".nt-row", { timeout: 10000 });
  const p = await t.page.evaluate(() => ({
    rows: [...document.querySelectorAll(".nt-row")].map((el) => ({
      h: el.querySelector(".nt-row-h")?.textContent,
      eg: el.querySelector(".nt-row-eg")?.textContent || null,
      href: el.getAttribute("href"),
    })),
    icons: document.querySelectorAll(".nt-row-ic svg").length,
    title: document.querySelector(".nt-head b")?.textContent,
  }));
  ok(p.rows.length === 5, "one row per kind of news, and none for the empty one", String(p.rows.length));
  ok(p.rows.some((r) => r.h === "2 new rooms"), "counts read as sentences", p.rows.map((r) => r.h).join(" | "));
  ok(p.rows.some((r) => r.h === "1 new service"), "and singular is singular");
  // A number is not news. "Mwenge single, water tank" is a reason to tap.
  ok(/Mwenge single/.test(p.rows.find((r) => /rooms/.test(r.h))?.eg || ""),
     "each row names what actually arrived");
  ok(p.rows.every((r) => r.href), "every row is a door to the page it happened on");
  ok(p.icons === p.rows.length, "every row carries a stroke icon, never an emoji");
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n4. Reading it clears it, except the part that is not ours to clear");
{
  const t = await open();
  await t.page.waitForFunction(() => window.Notify.state().total > 0, { timeout: 20000 });
  const after = await t.page.evaluate(() => {
    window.Notify.markAllSeen();
    const s = window.Notify.state();
    const by = {};
    s.groups.forEach((g) => { by[g.key] = g.count; });
    return { total: s.total, by };
  });
  ok(after.by.houses === 0 && after.by.jobs === 0 && after.by.services === 0,
     "the catalogue rows go quiet", JSON.stringify(after.by));
  ok(after.by.groups === 0, "so does the group nobody had seen");
  // An unread count belongs to the conversation. Clearing it from a panel the
  // sender cannot see would be the app lying to its reader about what they read.
  ok(after.by.messages === 5, "unread messages do NOT, because only opening them can", String(after.by.messages));
  ok(after.total === 5, "so the badge keeps exactly what is still true", String(after.total));

  const persisted = await t.page.evaluate(() => JSON.parse(localStorage.getItem("pawa_notify_seen")));
  ok(persisted.threads.includes("g1"), "and the mark is written down, so a reload agrees");
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n5. The theme toggle shows itself, then gets out of the way");
{
  const t = await open();
  await sleep(700);
  const early = await t.page.evaluate(() => document.getElementById("pawa-theme-toggle").classList.contains("is-idle"));
  ok(!early, "it is up when the page opens");

  await sleep(5400);
  const idle = await t.page.evaluate(() => ({
    idle: document.getElementById("pawa-theme-toggle").classList.contains("is-idle"),
    pointer: getComputedStyle(document.getElementById("pawa-theme-toggle")).pointerEvents,
  }));
  ok(idle.idle, "and gone about five seconds later");
  // A control you cannot see must not be one you can press by accident.
  ok(idle.pointer === "none", "with nothing left to tap by accident", idle.pointer);

  await t.page.evaluate(() => window.dispatchEvent(new Event("touchstart")));
  await sleep(250);
  const woke = await t.page.evaluate(() => document.getElementById("pawa-theme-toggle").classList.contains("is-idle"));
  ok(!woke, "touching the screen brings it straight back");
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n6. The two controls share one corner without fighting over it");
{
  const t = await open();
  await sleep(700);
  const both = await t.page.evaluate(() => {
    const b = document.getElementById("pawa-notify-bell").getBoundingClientRect();
    const g = document.getElementById("pawa-theme-toggle").getBoundingClientRect();
    return { below: b.top > g.top, sameRight: Math.abs(b.right - g.right) < 2, gap: Math.round(b.top - g.bottom) };
  });
  ok(both.below, "the bell sits below the day and night button");
  ok(both.sameRight, "on the same right edge", "gap " + both.gap);
  ok(both.gap >= 0 && both.gap < 20, "one gap apart, not stacked on top of it", String(both.gap));

  // index.html's search button lives in that corner too. Two floating controls
  // do not fit above it, so when the toggle fades the bell takes its slot.
  await sleep(5400);
  const rest = await t.page.evaluate(() => {
    const b = document.getElementById("pawa-notify-bell").getBoundingClientRect();
    const s = document.getElementById("haSearchBtn");
    const sr = s ? s.getBoundingClientRect() : null;
    return {
      lifted: document.documentElement.classList.contains("pawa-toggle-idle"),
      top: Math.round(b.top),
      hitsSearch: !!(sr && b.left < sr.right && b.right > sr.left && b.top < sr.bottom && b.bottom > sr.top),
    };
  });
  ok(rest.lifted, "the idle state is published for anything stacked underneath");
  ok(rest.top < 20, "so the bell rides up into the empty slot", String(rest.top));
  ok(!rest.hitsSearch, "and stops covering the page's own search button");
  ok(t.errs.length === 0, "no page errors across the whole run", t.errs.slice(0, 2).join(" | "));
  await t.close();
}

console.log("\n" + passed + " passed, " + fails.length + " failed");
await browser.close();
process.exit(fails.length ? 1 : 0);
