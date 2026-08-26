// ============================================================================
// jobs_page_test.mjs — the day jobs board, end to end, against nothing real.
//
// WHAT CHANGED AND WHY
//
// This test used to post to PRODUCTION. It typed `__pptr test job__` into the
// real form, submitted it to the real post_day_job(), claimed the real slots,
// and never deleted any of it — so every run left a fake job with a fake phone
// number sitting on the live board in front of people looking for a day's pay.
// It also loaded the page with `networkidle2` and no request interception,
// which meant it could only run on a machine with a working connection to
// jsDelivr, Supabase, LocationIQ and a tile server, and hung for 45 seconds
// when any one of them was slow. It was failing that way.
//
// The production flow is already covered, once, by jobs_owner_admin_test.mjs,
// which posts a `__pptr` job deliberately and DELETES IT AT BOTH ENDS. Two
// tests writing to the live board to check the same three RPCs is one too many,
// and the one that cleans up is the one to keep.
//
// What is left here is the part that was never really about the database: the
// PAGE. What renders, what the post modal refuses, what a claim does to the
// quota, when the job locks as FULL, and what "Jobs near me" reorders. All of
// that is deterministic against a stub, and a stub is the only way to assert on
// the second claim filling the last slot — against production that depends on
// what somebody else claimed a moment ago.
//
// Every RPC is stubbed and every external host is answered locally, so this
// runs offline and writes nothing anywhere.
//
//   usage:  node server.js   then:  node tests/jobs_page_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); }
  else { fail++; process.stdout.write(`  FAIL  ${m}\n${extra ? "        " + String(extra).slice(0, 200) + "\n" : ""}`); }
};
const section = (s) => process.stdout.write(`\n${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The emulated fix: Dar es Salaam. One seed job is minutes away from it and one
// is in Mwanza, ~1000 km off, because "sorted nearest-first" is only a claim if
// the two are far enough apart that no rounding can swap them.
const HERE = { latitude: -6.8, longitude: 39.28, accuracy: 25 };

const iso = (d) => new Date(d).toISOString();
const SEED = [
  { id: 501, title: "Kubeba mifuko ya saruji", description: "Offloading cement",
    requirements: "Boots", company_name: "Bonite Traders", company_phone: "+255700000501",
    region: "Mwanza", area: "Nyamagana", lat: -2.516, lng: 32.917,
    workers_needed: 4, claimed_count: 1, pay_tzs: 12000, pay_note: "per day",
    work_date: null, time_note: "07:00 - 15:00", status: "open",
    created_at: iso(Date.now() - 3600e3), updated_at: iso(Date.now() - 3600e3),
    expires_at: iso(Date.now() + 6 * 86400e3) },
  { id: 502, title: "Kupakua lori", description: "Truck unloading",
    requirements: null, company_name: "Kariakoo Freight", company_phone: "+255700000502",
    region: "Dar es Salaam", area: "Ilala", lat: -6.81, lng: 39.29,
    workers_needed: 3, claimed_count: 0, pay_tzs: 15000, pay_note: "per day",
    work_date: null, time_note: null, status: "open",
    created_at: iso(Date.now() - 7200e3), updated_at: iso(Date.now() - 7200e3),
    expires_at: iso(Date.now() + 6 * 86400e3) },
];

/**
 * The fake Supabase client, served in place of the CDN bundle.
 *
 * It keeps STATE, because half of what is under test is what the page does
 * with an answer: a claim has to move the quota, and the claim after the last
 * slot has to be refused. A stub that returned a constant could not tell the
 * difference between the page reflecting the answer and the page inventing it.
 *
 * Signed out on purpose. The Message button and its day_job_posters() lookup
 * have their own test (day_job_message_test.mjs) with its own fixtures; here
 * their absence keeps the action row down to what everybody sees.
 */
function stub(seed) {
  return `
window.__RPC = [];
window.__STATE = { jobs: ${JSON.stringify(seed)}, nextId: 900, workers: {} };
// Deliver a row change the way Postgres would. Used to redraw the board
// without a reload — a reload would restart this stub and lose the state the
// run has built up, which is not a thing the real page does to itself.
window.__RT_EMIT = function (row) {
  if (window.__RT) window.__RT({ eventType: "UPDATE", new: row });
};
window.supabase = { createClient: function () {
  function chain(getRows) {
    var want = null, b = {};
    ["select","eq","neq","gt","gte","lt","lte","is","or","order","limit"]
      .forEach(function (m) { b[m] = function () { return b; }; });
    // Only the id filter is honoured: "My jobs" asks for the ids this device
    // posted, and answering that with the whole table would make the modal
    // look right for the wrong reason.
    b.in = function (col, vals) {
      if (col === "id") want = (vals || []).map(String);
      return b;
    };
    b.then = function (res, rej) {
      var rows = getRows();
      if (want) rows = rows.filter(function (r) { return want.indexOf(String(r.id)) >= 0; });
      return Promise.resolve({ data: rows, error: null }).then(res, rej);
    };
    return b;
  }
  function job(id) {
    return window.__STATE.jobs.filter(function (j) { return String(j.id) === String(id); })[0];
  }
  return {
    from: function (t) {
      return chain(function () { return t === "day_jobs" ? window.__STATE.jobs.slice() : []; });
    },
    rpc: function (name, args) {
      window.__RPC.push({ name: name, args: args });
      if (name === "post_day_job") {
        var p = args.p, id = window.__STATE.nextId++;
        var row = {
          id: id, title: p.title, description: p.description, requirements: p.requirements,
          company_name: p.company_name, company_phone: p.company_phone,
          region: p.region, area: p.area, lat: p.lat, lng: p.lng,
          workers_needed: p.workers_needed, claimed_count: 0,
          pay_tzs: p.pay_tzs, pay_note: p.pay_note, work_date: p.work_date,
          time_note: p.time_note, status: "open",
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 7 * 86400000).toISOString()
        };
        window.__STATE.jobs.unshift(row);
        window.__STATE.workers[id] = [];
        return Promise.resolve({ data: { ok: true, token: "tok_" + id, job: row }, error: null });
      }
      if (name === "claim_day_job") {
        var j = job(args.p_job_id);
        if (!j) return Promise.resolve({ data: { ok: false, reason: "closed" }, error: null });
        if (j.claimed_count >= j.workers_needed || j.status !== "open") {
          return Promise.resolve({ data: { ok: false, reason: "full" }, error: null });
        }
        j.claimed_count += 1;
        var code = "W" + j.id + "-0" + j.claimed_count;
        var full = j.claimed_count >= j.workers_needed;
        if (full) j.status = "full";
        (window.__STATE.workers[j.id] = window.__STATE.workers[j.id] || []).push({
          worker_name: args.p_name, worker_phone: args.p_phone,
          worker_code: code, created_at: new Date().toISOString()
        });
        return Promise.resolve({ data: {
          ok: true, code: code, claimed: j.claimed_count, needed: j.workers_needed, full: full
        }, error: null });
      }
      if (name === "day_job_workers") {
        // The token is checked, because "only my jobs come back" is the whole
        // point of that function and a stub that ignored it would let a broken
        // client pass.
        var want = String(args.p_manage_token || "");
        var mine = want === "tok_" + args.p_job_id ? (window.__STATE.workers[args.p_job_id] || []) : [];
        return Promise.resolve({ data: mine, error: null });
      }
      return Promise.resolve({ data: [], error: null });
    },
    auth: {
      getSession: function () { return Promise.resolve({ data: { session: null }, error: null }); },
      getUser: function () { return Promise.resolve({ data: { user: null }, error: null }); },
      signOut: function () { return Promise.resolve({ error: null }); },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; }
    },
    // Realtime, with a way to fire it. The board's whole promise is that a job
    // changes under you without a reload, and a channel that accepts a
    // subscription and never delivers anything cannot show that it does.
    channel: function () {
      var self = {
        on: function (evt, opts, cb) { window.__RT = cb; return self; },
        subscribe: function () { return self; }
      };
      return self;
    },
    removeChannel: function () {},
    storage: { from: function () { return { getPublicUrl: function () { return { data: { publicUrl: "" } }; } }; } }
  };
} };`;
}

const browser = await puppeteer.launch({
  headless: "new", protocolTimeout: 120000,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = browser.defaultBrowserContext();
await ctx.overridePermissions(BASE, ["geolocation"]);

/**
 * Open jobs.html with every external host answered here.
 *
 * The map libraries are answered with an empty script on purpose, not to save
 * a download. jobs.js has a documented path for "no map library" — the board
 * still lists, and the post modal falls back to the GPS button — and running
 * the whole test down that path means the fallback is covered by every
 * assertion below rather than by a comment.
 */
async function openJobs(seed) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setGeolocation(HERE);
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR: " + String(e).split("\n")[0]));
  page.on("console", (m) => {
    if (m.type() === "error" && !/net::|ERR_|favicon/.test(m.text())) errs.push("console: " + m.text());
  });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*",
        "access-control-allow-methods": "*" } });
    }
    if (url.startsWith(BASE)) return req.continue();
    if (/cdn\.jsdelivr\.net.*supabase/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: stub(seed) });
    }
    if (/\.js(\?|$)/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: "" });
    }
    if (/\.css(\?|$)|fonts\.googleapis/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    // The reverse-geocode inside the submit handler. Answering it is what makes
    // "the card is filed under a ward, not under a pair of coordinates" a
    // testable claim rather than a best-effort nobody checks.
    if (/locationiq|nominatim/.test(url)) {
      return req.respond({ status: 200, headers: {
        "access-control-allow-origin": "*", "content-type": "application/json" },
        body: JSON.stringify({ address: { ward: "Kariakoo", state: "Dar es Salaam" } }) });
    }
    return req.respond({ status: 200, headers: {
      "access-control-allow-origin": "*", "content-type": "application/json" }, body: "{}" });
  });
  await page.goto(`${BASE}/jobs.html`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(2200);
  return { page, errs };
}

const cards = (page) => page.$$eval(".job-card", (ns) => ns.map((c) => ({
  id: c.dataset.id,
  title: (c.querySelector(".job-title") || {}).textContent || "",
  quota: (c.querySelector(".jq-count") || {}).textContent || "",
  fill: (c.querySelector(".job-quota-fill") || {}).style?.width || "",
  full: c.classList.contains("is-full"),
  fullBadge: !!c.querySelector(".job-full-badge"),
  claimable: !!c.querySelector(".job-claim-btn"),
  myCode: (c.querySelector(".job-mycode") || {}).textContent || "",
  dist: (c.querySelector(".job-dist") || {}).textContent || "",
})));

const status = (page, id) => page.$eval("#" + id, (n) => ({ text: n.textContent, cls: n.className }));

// ---------------------------------------------------------------------------
section("1. The board renders what the database gave it");
const { page, errs } = await openJobs(SEED);
{
  const state = await page.evaluate(() => ({
    title: document.title,
    busy: document.getElementById("jobList").getAttribute("aria-busy"),
    count: document.getElementById("jobsCount").textContent,
    empty: !!document.querySelector(".jobs-empty"),
    // jobs.html is an app-shell page: the desktop navbar is deliberately hidden
    // and the tab bar is the way out. The old version of this test looked for
    // `.nav-dropdown a[href="jobs.html"]`, which has not existed on this page
    // since the shell landed — and printed the answer instead of asserting it,
    // so nobody noticed.
    tabbar: !!document.querySelector(".app-tabbar"),
    tabActive: (document.querySelector(".app-tabbar a.active") || {}).textContent || "",
    navbarHidden: !document.querySelector(".navbar"),
    postBtn: !!document.getElementById("jobsPostBtn"),
    nearBtn: !!document.getElementById("jobsNearBtn"),
    mineBtn: !!document.getElementById("jobsMineBtn"),
  }));
  const rows = await cards(page);
  ok(rows.length === 2, "both open jobs are listed", JSON.stringify(rows.map((r) => r.id)));
  ok(state.busy === "false", "and the list stops announcing itself as busy", state.busy);
  ok(!state.empty, "so the empty state stays out of the way");
  ok(state.tabbar && state.navbarHidden, "the app shell's tab bar is the chrome, not the desktop navbar");
  ok(/explore/i.test(state.tabActive), "with Explore lit, because a day job is part of the catalogue", state.tabActive);
  ok(state.postBtn && state.nearBtn && state.mineBtn, "all three board buttons exist");
  ok(/2 jobs/.test(state.count) && /6 open slots/.test(state.count),
     "the count adds up the slots still open, not the jobs", state.count);

  const first = rows.find((r) => r.id === "501");
  ok(first && first.quota === "1 / 4 · 3 slots left", "a partly-filled job says how many are left", first && first.quota);
  ok(first && first.fill === "25%", "and the bar is drawn to the same fraction", first && first.fill);
  ok(rows.every((r) => r.claimable), "both are claimable while slots remain");
  ok(errs.length === 0, "no page errors on load", errs.slice(0, 3).join(" | "));
}

// ---------------------------------------------------------------------------
section("2. The post modal refuses what it cannot honestly post");
{
  await page.click("#jobsPostBtn");
  await sleep(900);
  const modal = await page.evaluate(() => ({
    open: !document.getElementById("jobPostBackdrop").hidden,
    fields: ["jpTitle","jpDesc","jpReq","jpWorkers","jpPay","jpPayNote","jpDate","jpTime","jpCompany","jpPhone"]
      .every((id) => !!document.getElementById(id)),
    coords: document.getElementById("jpCoords").textContent,
    gps: !!document.getElementById("jpGpsBtn"),
  }));
  ok(modal.open, "it opens");
  ok(modal.fields, "with every field the form claims to have");
  // No map library in this run, which is the offline case a phone on a weak
  // connection actually hits. The page must say so and still offer a way out.
  ok(/map|ramani/i.test(modal.coords) && !/Pinned/.test(modal.coords),
     "and says the map is unavailable rather than pretending to have one", modal.coords);
  ok(modal.gps, "leaving GPS as the way to place the pin");

  await page.type("#jpTitle", "Kupanga mizigo ghalani");
  await page.type("#jpDesc", "Sorting stock in the warehouse");
  await page.type("#jpReq", "Own gloves");
  await page.evaluate(() => { document.getElementById("jpWorkers").value = "2"; });
  await page.type("#jpPay", "abc");
  await page.type("#jpPayNote", "per day");
  await page.type("#jpCompany", "Ilala Depot");
  await page.type("#jpPhone", "+255744444444");
  await page.evaluate(() => {
    document.getElementById("jpDate").value = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  });

  await page.click("#jpSubmit");
  await sleep(700);
  let st = await status(page, "jpStatus");
  ok(/pin/i.test(st.text) && /err/.test(st.cls),
     "a job with no pin is refused — workers navigate to the pin", st.text);
  let sent = await page.evaluate(() => window.__RPC.filter((c) => c.name === "post_day_job").length);
  ok(sent === 0, "and nothing was sent", String(sent));

  await page.click("#jpGpsBtn");
  await sleep(2500);
  const coords = await page.$eval("#jpCoords", (n) => n.textContent);
  ok(/Pinned:\s*-6\.80/.test(coords), "the GPS button drops the pin where the phone is", coords);

  await page.click("#jpSubmit");
  await sleep(700);
  st = await status(page, "jpStatus");
  ok(/pay/i.test(st.text) && /err/.test(st.cls),
     "pay that parses to nothing is refused too — an unpaid day job is not a job", st.text);
  sent = await page.evaluate(() => window.__RPC.filter((c) => c.name === "post_day_job").length);
  ok(sent === 0, "still nothing sent", String(sent));
}

// ---------------------------------------------------------------------------
section("3. A complete post goes once, and lands on the board");
{
  await page.evaluate(() => { document.getElementById("jpPay").value = "15k"; });
  await page.click("#jpSubmit");
  await sleep(2500);

  const st = await status(page, "jpStatus");
  ok(/posted/i.test(st.text) && /ok/.test(st.cls), "the form says it worked", st.text);

  const calls = await page.evaluate(() => window.__RPC.filter((c) => c.name === "post_day_job"));
  ok(calls.length === 1, "one post, not one per click", String(calls.length));
  const p = calls[0] && calls[0].args.p;
  ok(p && p.pay_tzs === 15000, "'15k' reaches the database as a number", p && p.pay_tzs);
  ok(p && p.workers_needed === 2, "and the crew size is carried through", p && p.workers_needed);
  ok(p && Math.abs(p.lat + 6.8) < 0.01 && Math.abs(p.lng - 39.28) < 0.01,
     "with the pinned coordinates", p && `${p.lat},${p.lng}`);
  ok(p && p.area === "Kariakoo" && p.region === "Dar es Salaam",
     "filed under the ward the pin reverse-geocodes to, so the card reads as a place",
     p && `${p.area} / ${p.region}`);

  const rows = await cards(page);
  ok(rows.length === 3, "the new job is on the board immediately", String(rows.length));
  ok(rows[0].title === "Kupanga mizigo ghalani", "at the top, because it is the newest", rows[0].title);
  ok(rows[0].quota === "0 / 2 · 2 slots left", "with nobody claimed yet", rows[0].quota);

  // The manage token is the ONLY way this device sees who claimed its slots.
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("pawa_my_posts") || "{}"));
  const ids = Object.keys(kept);
  ok(ids.length === 1 && /^tok_/.test(kept[ids[0]].token),
     "and the ownership token kept on this device, where only this device has it",
     JSON.stringify(ids));
  await sleep(1400);   // the modal closes itself
}

// ---------------------------------------------------------------------------
section("4. Claiming a slot moves the quota");
{
  await page.evaluate(() => document.querySelector(".job-card .job-claim-btn").click());
  await sleep(700);
  await page.evaluate(() => {
    document.getElementById("jcName").value = "";
    document.getElementById("jcPhone").value = "";
  });
  await page.type("#jcName", "Neema Joseph");
  await page.type("#jcPhone", "+255755555555");
  await page.click("#jcSubmit");
  await sleep(1600);

  const st = await status(page, "jcStatus");
  ok(/worker number/i.test(st.text) && /ok/.test(st.cls), "the worker is given a number", st.text);
  ok(/1 of 2/.test(st.text), "and told where the crew stands", st.text);

  const rows = await cards(page);
  ok(rows[0].quota === "1 / 2 · 1 slot left", "the card updates without a reload", rows[0].quota);
  ok(rows[0].fill === "50%", "bar included", rows[0].fill);
  ok(/W\d+-01/.test(rows[0].myCode), "and keeps showing this worker their own number", rows[0].myCode);
  ok(!rows[0].claimable, "the button is gone for someone already in", String(rows[0].claimable));

  const mine = await page.evaluate(() => JSON.parse(localStorage.getItem("pawa_my_claims") || "{}"));
  ok(Object.keys(mine).length === 1, "the claim is remembered on the device", JSON.stringify(mine));
  await sleep(3400);   // the claim modal closes itself
}

// ---------------------------------------------------------------------------
section("5. The last slot locks the job");
{
  // The second worker is a second DEVICE: it has not claimed this job, so it is
  // still offered the button. Forgetting the local claim and letting realtime
  // redraw the card is that device, without a reload — a reload would restart
  // the stub and take the posted job with it.
  await page.evaluate(() => {
    localStorage.setItem("pawa_my_claims", "{}");
    window.__RT_EMIT(window.__STATE.jobs[0]);
  });
  await sleep(600);
  let rows = await cards(page);
  ok(rows[0].claimable && !rows[0].myCode,
     "a device with no claim of its own is offered the last slot", JSON.stringify(rows[0]));
  ok(rows[0].quota === "1 / 2 · 1 slot left",
     "and sees the count the first worker left behind — realtime redrew it", rows[0].quota);

  await page.evaluate(() => document.querySelector(".job-card .job-claim-btn").click());
  await sleep(600);
  await page.evaluate(() => {
    document.getElementById("jcName").value = "";
    document.getElementById("jcPhone").value = "";
  });
  await page.type("#jcName", "Juma Athumani");
  await page.type("#jcPhone", "+255766666666");
  await page.click("#jcSubmit");
  await sleep(1600);

  const st = await status(page, "jcStatus");
  ok(/complete/i.test(st.text) && /ok/.test(st.cls),
     "the worker who takes the last slot is told the team is complete", st.text);

  rows = await cards(page);
  ok(rows[0].full, "the job is drawn as full", JSON.stringify(rows[0]));
  ok(rows[0].fullBadge, "with the badge that says so");
  ok(!rows[0].claimable, "and no way to claim a slot that does not exist");
  ok(rows[0].quota === "2 / 2", "the quota reads full, with no phantom slots left", rows[0].quota);
  ok(rows[0].fill === "100%", "and the bar is finally full", rows[0].fill);

  // A third attempt is refused by the database, not by the missing button — the
  // button is the courtesy, claim_day_job's row lock is the rule.
  const refused = await page.evaluate(async () => {
    const c = window.supabase.createClient();
    const r = await c.rpc("claim_day_job",
      { p_job_id: window.__STATE.jobs[0].id, p_name: "Late Arrival", p_phone: "+255777777777" });
    return r.data;
  });
  ok(refused && refused.ok === false && refused.reason === "full",
     "and a claim that arrives anyway is refused as full", JSON.stringify(refused));
  await sleep(3400);   // the claim modal closes itself
}

// ---------------------------------------------------------------------------
section("6. Jobs near me reorders by distance");
{
  await page.click("#jobsNearBtn");
  await sleep(4000);
  const rows = await cards(page);
  const dar = rows.findIndex((r) => r.id === "502");
  const mwanza = rows.findIndex((r) => r.id === "501");
  ok(dar >= 0 && mwanza >= 0 && dar < mwanza,
     "the job down the road sorts above the one a thousand km away", `dar@${dar} mwanza@${mwanza}`);
  ok(/km/.test(rows[dar].dist), "and every pinned job says how far it is", rows[dar].dist);
  ok(parseFloat(rows[dar].dist.replace(/[^\d.]/g, "")) < 5,
     "the one down the road in single-figure kilometres", rows[dar].dist);
  ok(parseFloat(rows[mwanza].dist.replace(/[^\d.]/g, "")) > 500,
     "and the far one in hundreds", rows[mwanza].dist);
  const banner = await page.$eval("#jobsBanner", (n) => n.textContent);
  ok(/nearest/i.test(banner), "with a word about what just happened", banner);
}

// ---------------------------------------------------------------------------
section("7. My jobs & workers — the poster, and only the poster");
{
  await page.click("#jobsMineBtn");
  await sleep(2000);
  const mine = await page.evaluate(() => ({
    open: !document.getElementById("jobMineBackdrop").hidden,
    html: document.getElementById("jmResults").textContent,
    jobs: document.querySelectorAll(".jm-job").length,
    workers: document.querySelectorAll(".jm-worker").length,
  }));
  ok(mine.open, "the modal opens");
  ok(mine.jobs === 1, "showing the one job this device posted, not the whole board", String(mine.jobs));
  ok(mine.workers === 2, "with both workers who claimed a slot", String(mine.workers));
  ok(/Neema Joseph/.test(mine.html) && /\+255755555555/.test(mine.html),
     "named, with the phone number the poster needs to confirm them", mine.html.slice(0, 160));
  ok(/Juma Athumani/.test(mine.html) && /\+255766666666/.test(mine.html),
     "including the one who claimed from the other device — the token is the owner, not the browser",
     mine.html.slice(0, 160));
  ok(/W\d+-01/.test(mine.html) && /W\d+-02/.test(mine.html),
     "each with the worker number they were given, which is their ID at the work zone");

  const asked = await page.evaluate(() => window.__RPC.filter((c) => c.name === "day_job_workers"));
  ok(asked.length >= 1 && asked.every((c) => /^tok_/.test(String(c.args.p_manage_token || ""))),
     "asked for with the manage token, never with the public phone number",
     JSON.stringify(asked.map((c) => c.args)));
}

// ---------------------------------------------------------------------------
await page.screenshot({ path: "tests/jobs_page.png", fullPage: true });
ok(errs.length === 0, "no page errors across the whole run", errs.slice(0, 4).join(" | "));

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
