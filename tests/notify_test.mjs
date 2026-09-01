// ============================================================================
//  Notifications — the badge, the panel, and the theme toggle's auto-hide
//
//  Six things can be news: a new room, service, truck or day job, a message
//  nobody has read, and a group somebody added you to. js/core/notify.js counts
//  them against a mark this device keeps; js/lib/notify-ui.js draws them.
//
//  A seventh row is not news at all. A peer's safety number changing is the
//  most serious thing this app can notice, and until sections 7 and 8 below it
//  could only be found by opening the conversation. Those two sections pin the
//  pair of claims that make the bell worth reading rather than worth ignoring:
//  the rooms row answers the alert this device actually saved, and the alarm
//  cannot be tapped away.
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

// Rooms carry a point and a price because the area alert in section 7 tests
// both. Mwenge and Sinza are about 1.7 km apart, which is the whole point: a
// 1 km watch around Mwenge has to leave Sinza out.
const MWENGE = { lat: -6.7710, lng: 39.2390 };
const SINZA  = { lat: -6.7830, lng: 39.2290 };
const HOUSES = [
  { id: "r1", title: "Mwenge single, water tank", created_at: iso(60000), available: true,
    ...MWENGE, price_tzs: 300000, listing: "rent", type: "house", bedrooms: 1 },
  { id: "r2", title: "Sinza bedsitter", created_at: iso(120000), available: true,
    ...SINZA, price_tzs: 250000, listing: "rent", type: "house", bedrooms: 1 },
  // In the watched circle, over the budget somebody typed into it. A person
  // who asked for under 500,000 and gets pinged about 900,000 learns to ignore
  // the ping, and then the one that mattered arrives and is ignored too.
  { id: "r3", title: "Mwenge two-bedroom, new", created_at: iso(45000), available: true,
    ...MWENGE, price_tzs: 900000, listing: "rent", type: "house", bedrooms: 2 },
  // Older than the mark: already seen, must not be counted.
  { id: "r0", title: "Ancient listing", created_at: iso(7200000), available: true, ...MWENGE },
];

// What somebody typed into the "Set up an area alert" sheet on houses.html:
// this pin, one kilometre, for rent, under 500,000. Same storage key the page
// writes, because the point of js/lib/house-alerts.js is that there is one.
const ALERT = [{
  id: "a1", name: "Mwenge", lat: MWENGE.lat, lng: MWENGE.lng, radius_m: 1000,
  listing: "rent", price_max: 500000,
}];

// One peer whose key is not the one this device wrote down. Written in
// pm-trust.js's own storage shape, scoped by my user id, because that is where
// the alarm lives and the bell only reads it.
const TRUST_BOOK = {
  me: {
    peer9: { key: "NEWKEY", name: "Juma", state: "changed",
             firstSeen: iso(86400000), changedAt: iso(300000), previousKey: "OLDKEY",
             wasVerified: true },
    peer8: { key: "SAMEKEY", name: "Asha", state: "seen", firstSeen: iso(86400000) },
  },
};
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

/**
 * A page whose device has looked before, unless `firstRun` says otherwise.
 *
 * `alerts` and `trust` seed the two stores the bell reads and never writes:
 * the area alerts houses.html saves, and pm-trust.js's book of keys.
 */
async function open({ firstRun = false, alerts = null, trust = null } = {}) {
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
  await page.evaluateOnNewDocument((since, fresh, al, tr) => {
    try {
      localStorage.setItem("pawa-theme", "dark");
      if (!fresh) {
        localStorage.setItem("pawa_notify_seen", JSON.stringify({
          houses: since, services: since, trucks: since, jobs: since, threads: [], seededAt: since,
        }));
      }
      if (al) localStorage.setItem("pawa_house_geo_alerts", JSON.stringify(al));
      if (tr) localStorage.setItem("pm-trust-v1", JSON.stringify(tr));
    } catch (e) {}
  }, AN_HOUR_AGO, firstRun, alerts, trust);
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
  ok(st.by.houses === 3, "three rooms, and the one older than the mark is not news", JSON.stringify(st.by));
  ok(st.by.services === 1, "one service");
  ok(st.by.trucks === 0, "no trucks, so no row for them");
  ok(st.by.jobs === 2, "two day jobs");
  ok(st.by.messages === 5, "five unread messages across the inbox", String(st.by.messages));
  ok(st.by.groups === 1, "one group nobody on this device had seen", String(st.by.groups));
  ok(st.total === 12, "and the badge adds them up", String(st.total));
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
  ok(p.rows.some((r) => r.h === "3 new rooms"), "counts read as sentences", p.rows.map((r) => r.h).join(" | "));
  // With nothing saved the row must NOT claim an alert is behind it.
  ok(!p.rows.some((r) => /in your areas/.test(r.h || "")),
     "and a device watching nothing is not told it is watching");
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

// ---------------------------------------------------------------------------
console.log("\n7. The rooms row answers the alert this device actually saved");
{
  // Before js/lib/house-alerts.js the bell counted every new room in the
  // country, so the one that matched somebody's pin was indistinguishable from
  // the two that did not. A count of everything is not a notification.
  const t = await open({ alerts: ALERT });
  await t.page.waitForFunction(() => window.Notify.state().total > 0, { timeout: 20000 });
  const st = await t.page.evaluate(() => {
    const g = window.Notify.state().groups.find((x) => x.key === "houses");
    return { count: g.count, watched: !!g.watched, ids: (g.items || []).map((i) => i.id) };
  });
  ok(st.count === 1, "only the room inside the watched circle and under the budget",
     JSON.stringify(st.ids));
  ok(st.ids[0] === "r1", "and it is the right one", JSON.stringify(st.ids));
  ok(st.watched, "the row knows it was narrowed");

  await t.page.click("#pawa-notify-bell");
  await t.page.waitForSelector(".nt-row", { timeout: 10000 });
  const row = await t.page.evaluate(() => {
    const el = [...document.querySelectorAll(".nt-row")].find((r) => r.dataset.key === "houses");
    return { h: el?.querySelector(".nt-row-h")?.textContent, d: el?.querySelector(".nt-row-d")?.textContent };
  });
  // "1 new room" and "1 new room in your areas" are different claims, and a
  // reader who cannot tell which one they are looking at cannot tell whether
  // the alert they saved is doing anything.
  ok(row.h === "1 new room in your areas", "and says so, instead of claiming the catalogue", row.h);
  ok(/areas and the budget/.test(row.d || ""), "with the reason under it", row.d);

  // The page and the badge must never be able to describe different rooms:
  // one rule, two callers. This is the rule, asked directly.
  const A = { lat: -6.7710, lng: 39.2390, radius_m: 1000, listing: "rent", price_max: 500000 };
  const shared = await t.page.evaluate((a) => ({
    any: window.HouseAlerts.any(),
    near: window.HouseAlerts.matches({ lat: -6.7710, lng: 39.2390, price_tzs: 300000, listing: "rent" }, a),
    dear: window.HouseAlerts.matches({ lat: -6.7710, lng: 39.2390, price_tzs: 900000, listing: "rent" }, a),
    far:  window.HouseAlerts.matches({ lat: -6.7830, lng: 39.2290, price_tzs: 250000, listing: "rent" }, a),
  }), A);
  ok(shared.any && shared.near && !shared.dear && !shared.far,
     "and it is the same shared rule houses.html asks", JSON.stringify(shared));
  ok(t.errs.length === 0, "no page errors while narrowing", t.errs.slice(0, 2).join(" | "));
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n8. A changed safety number is an alarm, and it cannot be tapped away");
{
  const t = await open({ trust: TRUST_BOOK });
  await t.page.waitForFunction(() => window.Notify.state().total > 0, { timeout: 20000 });
  await t.page.click("#pawa-notify-bell");
  await t.page.waitForSelector(".nt-row", { timeout: 10000 });
  const p = await t.page.evaluate(() => {
    const rows = [...document.querySelectorAll(".nt-row")];
    const el = rows.find((r) => r.dataset.key === "trust");
    const g = window.Notify.state().groups.find((x) => x.key === "trust");
    return {
      first: rows[0]?.dataset.key,
      count: g ? g.count : -1,
      names: ((g && g.items) || []).map((i) => i.title),
      h: el?.querySelector(".nt-row-h")?.textContent,
      d: el?.querySelector(".nt-row-d")?.textContent,
      href: el?.getAttribute("href"),
      alarm: !!el?.classList.contains("is-alarm"),
      icon: !!el?.querySelector(".nt-row-ic svg"),
    };
  });
  // Only the peer whose key changed. Somebody merely seen is not an alarm.
  ok(p.count === 1, "one peer, not everyone on file", String(p.count));
  ok(p.names.join() === "Juma", "and it names them", p.names.join());
  ok(p.first === "trust", "the alarm is the first row, above every kind of news", p.first);
  ok(p.h === "1 safety number changed", "worded as something wrong, not something posted", p.h);
  ok(/blocked until you do/.test(p.d || ""), "and says what it costs to ignore", p.d);
  ok(p.href === "p-message.html", "a door to the place it can be dealt with", p.href);
  ok(p.alarm, "painted as an alarm rather than in the brand green");
  ok(p.icon, "a stroke icon, never an emoji");

  // The whole point of a sticky alarm is that doing nothing cannot clear it.
  const after = await t.page.evaluate(() => {
    window.Notify.markAllSeen();
    window.Notify.markSeen("trust");                 // and a tap on the row itself
    const g = window.Notify.state().groups.find((x) => x.key === "trust");
    return {
      count: g.count,
      stillDrawn: !!document.querySelector('.nt-row[data-key="trust"]'),
      clearHidden: document.querySelector(".nt-clear").hidden,
      dismissible: window.Notify.isDismissible("trust"),
    };
  });
  ok(after.count === 1, 'the "mark all as read" button does not touch it', String(after.count));
  ok(after.stillDrawn, "and neither does tapping the row on the way to the thread");
  ok(!after.dismissible, "the engine says so out loud, so the UI need not guess");
  // Nothing left that the button could clear, so offering it would be a lie.
  ok(after.clearHidden, "and the button that cannot clear it stops offering to");
  ok(t.errs.length === 0, "no page errors across the alarm run", t.errs.slice(0, 2).join(" | "));
  await t.close();
}

console.log("\n" + passed + " passed, " + fails.length + " failed");
await browser.close();
process.exit(fails.length ? 1 : 0);
