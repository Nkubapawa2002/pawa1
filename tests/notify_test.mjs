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

// The reader is an agent who works Kinondoni, in Dar es Salaam. Without this
// row there is no region, and js/core/notify.js is right to ask the server
// nothing: a reader who is not an agent has no customers waiting for them.
const AGENT_PROFILE = {
  user_id: "me", name: "Neema", region: "Dar es Salaam", district: "Kinondoni",
  area_of_operations: "Mwenge", area_kind: "ward", ward: "Mwenge",
};

// Nine open requests routed to that agent. Nine, not three, because the panel
// draws three and has to say what it is not showing: the count, the "+6 more"
// line and the door are the three things section 9 exists to pin.
const DEMAND = Array.from({ length: 9 }, (_, i) => ({
  id: "d" + i,
  name: "Seeker " + i,
  phone: i === 0 ? "0712000111" : "255713" + String(100000 + i),
  area: i % 2 ? "Sinza" : "Mwenge",
  match_level: i < 4 ? "district" : "region",
  listing: "rent",
  type: "house",
  max_budget_tzs: 400000,
  // The first one moves this week; the rest are further out. urgentCount()
  // reads this, and so does the sort.
  needed_by: new Date(now + (i === 0 ? 2 : 40 + i) * 86400000).toISOString().slice(0, 10),
}));

const stub = `window.supabase={createClient:function(){
var M={houses:${JSON.stringify(HOUSES)},services:${JSON.stringify(SERVICES)},trucks:${JSON.stringify(TRUCKS)},day_jobs:${JSON.stringify(JOBS)},agent_profiles:[${JSON.stringify(AGENT_PROFILE)}]};
function q(tbl){var b={_t:tbl};["select","eq","neq","gt","gte","lt","lte","is","or","order","limit","in"].forEach(function(m){b[m]=function(){return b}});
b.then=function(r,j){return Promise.resolve({data:M[b._t]||[],error:null}).then(r,j)};
// AgentProfile.get() ends in .maybeSingle(). A stub without it throws inside
// that function's own try/catch, which returns null, which looks exactly like
// "this reader is not an agent" and hides the whole requests section.
b.maybeSingle=function(){var row=(M[b._t]||[])[0]||null;
if(b._t==="agent_profiles"&&!isAgent)row=null;
return Promise.resolve({data:row,error:null})};
b.single=b.maybeSingle;return b}
var s={user:{id:"me",email:"a@b.c",is_anonymous:false}};
// Section 9 opens one page as somebody who is not an agent. Everything the
// requests section needs comes from these two answers, so withholding both is
// exactly what the server would do for a reader with no agent_profiles row.
var isAgent=!window.__NOT_AN_AGENT;
return{rpc:function(n){if(n==="pm_inbox")return Promise.resolve({data:${JSON.stringify(INBOX)},error:null});
if(n==="house_demand_for_agent")return Promise.resolve({data:isAgent?${JSON.stringify(DEMAND)}:[],error:null});
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
async function open({ firstRun = false, alerts = null, trust = null, agent = true } = {}) {
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
  await page.evaluateOnNewDocument((since, fresh, al, tr, notAgent) => {
    try {
      if (notAgent) window.__NOT_AN_AGENT = true;
      localStorage.setItem("pawa-theme", "dark");
      if (!fresh) {
        localStorage.setItem("pawa_notify_seen", JSON.stringify({
          houses: since, services: since, trucks: since, jobs: since, threads: [], seededAt: since,
        }));
      }
      if (al) localStorage.setItem("pawa_house_geo_alerts", JSON.stringify(al));
      if (tr) localStorage.setItem("pm-trust-v1", JSON.stringify(tr));
    } catch (e) {}
  }, AN_HOUR_AGO, firstRun, alerts, trust, !agent);
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
    return { total: s.total, news: s.news, by,
             badge: document.querySelector(".pawa-notify-badge").textContent };
  });
  ok(st.by.houses === 3, "three rooms, and the one older than the mark is not news", JSON.stringify(st.by));
  ok(st.by.services === 1, "one service");
  ok(st.by.trucks === 0, "no trucks, so no row for them");
  ok(st.by.jobs === 2, "two day jobs");
  ok(st.by.messages === 5, "five unread messages across the inbox", String(st.by.messages));
  ok(st.by.groups === 1, "one group nobody on this device had seen", String(st.by.groups));
  ok(st.by.demand === 9, "nine people are waiting for a place in this agent's area",
     String(st.by.demand));
  // The badge counts what is ADDRESSED to this reader and nothing else: five
  // unread messages, one group somebody added them to, and nine customers
  // waiting for a call. The six catalogue items still light the bell, but as
  // `news`, because "12" because twelve rooms were posted is a number nobody
  // can act on and it buries the one person waiting for a call.
  ok(st.total === 15, "the badge counts what is addressed to this reader", String(st.total));
  ok(st.news === 6, "and the catalogue is counted apart from it", String(st.news));
  ok(st.badge === "9+", "which is the number on the pill, capped", st.badge);
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
  // Messages and waiting customers are live state, not history, so they still
  // count on day one. Seeding the mark to now silences the CATALOGUE, which is
  // the only part of the bell a first-time reader has no history for.
  ok(st.total === 14, "and only what is addressed to them counts, not the whole catalogue",
     String(st.total));
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
  // Nor do the customers. Somebody does not stop needing a place because an
  // agent glanced at a panel, and a badge that can be tapped away is a badge
  // that lets somebody dismiss the call that was going to pay for their week.
  ok(after.by.demand === 9, "and neither do the people waiting for a call", String(after.by.demand));
  ok(after.total === 14, "so the badge keeps exactly what is still true", String(after.total));

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
console.log("\n6. The two floating controls do not overlap each other");
{
  // This used to assert that the bell sat one gap BELOW the theme toggle on a
  // shared right edge. index.html has not been laid out that way for some time:
  // it sends the toggle to the left corner and pins the bell at the top of the
  // right one, so the two never meet. The assertion outlived the layout and had
  // been failing quietly; what it was protecting is that these two never sit on
  // top of each other, and that is what it checks now.
  const t = await open();
  await sleep(700);
  const both = await t.page.evaluate(() => {
    const b = document.getElementById("pawa-notify-bell").getBoundingClientRect();
    const g = document.getElementById("pawa-theme-toggle").getBoundingClientRect();
    return {
      overlap: b.left < g.right && b.right > g.left && b.top < g.bottom && b.bottom > g.top,
      apart: Math.round(Math.abs(b.right - g.right)),
      bellTop: Math.round(b.top),
    };
  });
  ok(!both.overlap, "the bell and the day and night button never cover each other");
  ok(both.apart > 100, "they hold opposite corners", String(both.apart));
  ok(both.bellTop < 60, "and the bell is where a floating control belongs", String(both.bellTop));

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
  await t.page.waitForSelector(".nt-alarm", { timeout: 10000 });
  // An alarm is no longer a row in the list. It is the rail above every
  // section, which is the same claim the old assertion made ("first, above
  // every kind of news") in the shape the panel has now.
  const p = await t.page.evaluate(() => {
    const body = document.querySelector(".nt-body");
    const el = body.querySelector('.nt-alarm[data-key="trust"]');
    const g = window.Notify.state().groups.find((x) => x.key === "trust");
    return {
      first: body.firstElementChild === el,
      aboveSections: !!el && (!body.querySelector(".nt-sec") ||
        (el.compareDocumentPosition(body.querySelector(".nt-sec")) & Node.DOCUMENT_POSITION_FOLLOWING) > 0),
      count: g ? g.count : -1,
      names: ((g && g.items) || []).map((i) => i.title),
      h: el?.querySelector(".nt-alarm-h")?.textContent,
      d: el?.querySelector(".nt-alarm-d")?.textContent,
      href: el?.getAttribute("href"),
      icon: !!el?.querySelector("svg"),
      counted: !!el?.querySelector(".nt-row-n"),
    };
  });
  // Only the peer whose key changed. Somebody merely seen is not an alarm.
  ok(p.count === 1, "one peer, not everyone on file", String(p.count));
  ok(p.names.join() === "Juma", "and it names them", p.names.join());
  ok(p.first, "the alarm is the first thing in the panel");
  ok(p.aboveSections, "above every section, not inside one");
  ok(p.h === "1 safety number changed", "worded as something wrong, not something posted", p.h);
  ok(/blocked until you do/.test(p.d || ""), "and says what it costs to ignore", p.d);
  ok(p.href === "p-message.html", "a door to the place it can be dealt with", p.href);
  ok(p.icon, "a stroke icon, never an emoji");
  ok(!p.counted, "and never a count: \"1\" beside it reads as one more thing to get through");

  // The whole point of a sticky alarm is that doing nothing cannot clear it.
  const after = await t.page.evaluate(() => {
    window.Notify.markAllSeen();
    window.Notify.markSeen("trust");                 // and a tap on the row itself
    const g = window.Notify.state().groups.find((x) => x.key === "trust");
    return {
      count: g.count,
      stillDrawn: !!document.querySelector('.nt-alarm[data-key="trust"]'),
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

// ---------------------------------------------------------------------------
// This section exists because the feature it describes shipped counting nothing
// and nobody noticed. js/core/notify.js read .region off AgentProfile.get()
// without awaiting it, so every reader on every page got undefined, the section
// was skipped, and every other assertion in this file still passed. A count is
// not a feature. What follows checks that a row is DRAWN, that it says how many
// were left out, and that there is a way to reach the rest.
console.log("\n9. Somebody wanting a place reaches the bell, not just the dashboard");
{
  const t = await open();
  await t.page.waitForFunction(
    () => (window.Notify.state().groups.find((g) => g.key === "demand") || {}).count > 0,
    { timeout: 20000 });
  await t.page.click("#pawa-notify-bell");
  await t.page.waitForSelector('.nt-sec[data-sec="wants"]', { timeout: 10000 });

  const w = await t.page.evaluate(() => {
    const sec = document.querySelector('.nt-sec[data-sec="wants"]');
    const rows = [...sec.querySelectorAll(".dm-row")];
    const more = sec.querySelector("a.dm-more");
    const first = rows[0];
    return {
      headCount: sec.querySelector(".nt-sec-n")?.textContent || "",
      rows: rows.length,
      tags: rows.map((r) => !!r.querySelector(".dm-tag")),
      moreText: more ? more.textContent : (sec.querySelector(".dm-more")?.textContent || null),
      moreIsLink: !!more,
      moreHref: more ? more.getAttribute("href") : null,
      call: !!first.querySelector('.dm-btn--call[href^="tel:"]'),
      wa: (first.querySelector(".dm-btn--wa") || {}).href || "",
      urgent: !!sec.querySelector(".dm-by.is-urgent"),
      emoji: /\p{Extended_Pictographic}/u.test(sec.textContent),
    };
  });

  ok(w.rows === 3, "the panel is a summary: three rows, not all nine", String(w.rows));
  ok(w.headCount === "9", "and the heading counts everyone, not the three it drew", w.headCount);
  // The bug this pins: the overflow used to be measured against the six rows
  // that travelled rather than the nine that exist, so a heading reading 9 sat
  // above a line reading "+3 more".
  ok(/6/.test(w.moreText || ""), "the line underneath says how many are NOT shown", w.moreText);
  ok(w.moreIsLink && w.moreHref === "agent-houses.html",
     "and that line is the way through to them", String(w.moreHref));
  // Own district first: it is where an agent can actually help, and DEMAND is
  // built with the district matches spread through the list rather than at the
  // top, so this fails if the shared sort is skipped.
  ok(w.tags[0] && w.tags[1] && w.tags[2], "the agent's own district sorts first",
     JSON.stringify(w.tags));
  ok(w.call, "a row carries the phone number as something to press");
  ok(/wa\.me\/255712000111/.test(w.wa),
     "and a WhatsApp link with the leading zero replaced", w.wa);
  ok(w.urgent, "somebody who moves this week is marked as moving this week");
  ok(!w.emoji, "no emoji anywhere in the section");
  ok(t.errs.length === 0, "no page errors while drawing requests", t.errs.slice(0, 2).join(" | "));
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n10. A reader who is not an agent is never shown an empty version of it");
{
  const t = await open({ agent: false });
  await t.page.waitForFunction(() => window.Notify.state().total > 0, { timeout: 20000 });
  await t.page.click("#pawa-notify-bell");
  await t.page.waitForSelector(".nt-row", { timeout: 10000 });
  const w = await t.page.evaluate(() => ({
    count: (window.Notify.state().groups.find((g) => g.key === "demand") || {}).count,
    section: !!document.querySelector('.nt-sec[data-sec="wants"]'),
    rows: document.querySelectorAll(".dm-row").length,
    total: window.Notify.state().total,
  }));
  ok(w.count === 0, "nothing is counted for somebody with no agent profile", String(w.count));
  ok(!w.section, "and no heading is drawn over nothing", String(w.section));
  ok(w.rows === 0, "no rows either");
  // Six, not fifteen: five unread messages and one group. The rest of the bell
  // is untouched for a reader this feature is not for.
  ok(w.total === 6, "the rest of the bell is exactly what it was", String(w.total));
  ok(t.errs.length === 0, "no page errors", t.errs.slice(0, 2).join(" | "));
  await t.close();
}

console.log("\n" + passed + " passed, " + fails.length + " failed");
await browser.close();
process.exit(fails.length ? 1 : 0);
