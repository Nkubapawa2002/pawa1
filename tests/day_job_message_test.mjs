// ============================================================================
// day_job_message_test.mjs — messaging the person who posted a day job.
//
// Two pages and the seam between them:
//
//   jobs.html      draws a Message link only for jobs whose poster can
//                  actually receive an encrypted message, and only for a
//                  signed-in visitor.
//   p-message.html ?to=<user id> opens that conversation, taking the NAME from
//                  pm_peer rather than from the URL.
//
// The claims worth pinning are the negative ones. A day job posted before the
// board had owners belongs to a phone number and nobody else; drawing a button
// for it would be a dead end wearing a feature's clothes. And a link that
// could name the person it opens would let a doctored URL put a borrowed name
// on the one screen whose whole job is telling you who you are talking to.
//
// No database: every RPC is stubbed, so this runs anywhere the dev server does.
//
//   usage:  node server.js   then:  node tests/day_job_message_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); }
  else { fail++; process.stdout.write(`  FAIL  ${m}\n${extra ? "        " + extra + "\n" : ""}`); }
};
const section = (s) => process.stdout.write(`\n${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Two jobs. Only the first has a poster who is on P-Message; the second is a
// legacy post owned by a phone number, which is the majority of the board and
// the case the button must stay away from.
const JOBS = [
  { id: 101, title: "Kupakia mahindi", description: "Loading maize", requirements: null,
    company_name: "Kilimo Contractors", company_phone: "+255700000001",
    region: "Mwanza", area: "Nyamagana", lat: -2.516, lng: 32.917,
    workers_needed: 6, claimed_count: 1, pay_tzs: 15000, pay_note: "per day",
    work_date: null, time_note: "07:00 - 16:00", status: "open",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 6 * 86400000).toISOString() },
  { id: 102, title: "Kusafisha ghala", description: "Warehouse clean", requirements: null,
    company_name: "Bandari Loading Co", company_phone: "+255700000002",
    region: "Mwanza", area: "Ilemela", lat: -2.50, lng: 32.90,
    workers_needed: 3, claimed_count: 0, pay_tzs: 10000, pay_note: "per day",
    work_date: null, time_note: null, status: "open",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 6 * 86400000).toISOString() },
];

// The stub records every RPC name so the test can assert on what was NOT asked
// as well as what came back — "no button" and "never even looked" are
// different bugs with the same appearance.
function stub(signedIn) {
  return `window.__RPC=[];window.supabase={createClient:function(){
var JOBS=${JSON.stringify(JOBS)};
var session=${signedIn ? '{user:{id:"me",email:"pawa4761@gmail.com",is_anonymous:false}}' : "null"};
function chain(rows){var b={};["select","in","eq","neq","gt","gte","lt","lte","is","or","order","limit"]
  .forEach(function(m){b[m]=function(){return b}});
 b.then=function(r,j){return Promise.resolve({data:rows,error:null}).then(r,j)};return b}
return{
 from:function(t){return chain(t==="day_jobs"?JOBS:[])},
 rpc:function(n,a){
   window.__RPC.push({name:n,args:a});
   // Job 101 has a poster with a key. Job 102 is deliberately absent from the
   // answer even though it was asked about — that is what "no owner" looks
   // like coming back from day_job_posters().
   if(n==="day_job_posters")return Promise.resolve({data:[
     {job_id:101,user_id:"co_kilimo",display_name:"Kilimo Contractors",region:"Mwanza",area:"Nyamagana"}
   ],error:null});
   return Promise.resolve({data:[],error:null})},
 auth:{
  getSession:function(){return Promise.resolve({data:{session:session},error:null})},
  getUser:function(){return Promise.resolve({data:{user:session&&session.user},error:null})},
  signOut:function(){return Promise.resolve({error:null})},
  onAuthStateChange:function(){return{data:{subscription:{unsubscribe:function(){}}}}}},
 channel:function(){return{on:function(){return this},subscribe:function(){return this}}},
 removeChannel:function(){},
 storage:{from:function(){return{getPublicUrl:function(){return{data:{publicUrl:""}}}}}}}}};`;
}

const browser = await puppeteer.launch({
  headless: "new", protocolTimeout: 120000,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function openJobs(signedIn) {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900 });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error" && !/net::|ERR_/.test(m.text())) errs.push("console: " + m.text()); });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*",
        "access-control-allow-methods": "*" } });
    }
    if (/cdn\.jsdelivr\.net.*supabase/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: stub(signedIn) });
    }
    // The map libraries and their tiles are not what is under test, and a real
    // tile fetch is what makes these runs hang.
    if (/maplibre-gl|leaflet/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: "" });
    }
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    if (/arcgisonline|basemaps\.cartocdn|tile\./.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "image/png" }, body: "" });
    }
    if (/supabase\.co/.test(url)) {
      return req.respond({ status: 200, headers: {
        "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
    }
    req.continue();
  });
  await page.goto(`${BASE}/jobs.html`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(2600);
  return { page, errs };
}

const cards = (page) => page.$$eval(".job-card", (ns) => ns.map((c) => ({
  id: c.dataset.id,
  msgHref: (c.querySelector(".job-msg-btn") || {}).getAttribute
    ? c.querySelector(".job-msg-btn").getAttribute("href") : null,
  msgText: (c.querySelector(".job-msg-btn") || {}).textContent || "",
  // The order of the action row, so "after Call" is a claim and not a hope.
  acts: Array.from(c.querySelectorAll(".job-actions > *")).map((b) =>
    b.classList.contains("job-msg-btn") ? "message"
      : /tel:/.test(b.getAttribute("href") || "") ? "call"
      : /google\.com\/maps/.test(b.getAttribute("href") || "") ? "navigate"
      : b.classList.contains("job-claim-btn") ? "claim" : "other"),
})));

// ---------------------------------------------------------------------------
section("A signed-in worker is offered the poster, where there is one");
{
  const { page, errs } = await openJobs(true);
  const rows = await cards(page);
  ok(rows.length === 2, "both jobs are on the board", JSON.stringify(rows.map((r) => r.id)));

  const withOwner = rows.find((r) => r.id === "101");
  const legacy = rows.find((r) => r.id === "102");

  ok(!!withOwner && !!withOwner.msgHref, "the job with a poster gets a Message link");
  ok(withOwner && withOwner.msgHref === "p-message.html?to=co_kilimo",
     "pointing at P-Message with the poster's id and nothing else", withOwner && withOwner.msgHref);
  ok(withOwner && !/co_kilimo/.test(withOwner.msgText) && withOwner.msgText.trim().length > 0,
     "labelled for a person to read, not with an id", withOwner && withOwner.msgText.trim());

  ok(legacy && !legacy.msgHref,
     "a job posted before the board had owners gets NO button — there is nobody to write to",
     JSON.stringify(legacy));
  ok(legacy && legacy.acts.includes("call"),
     "and still offers the phone number it does have", JSON.stringify(legacy && legacy.acts));

  const order = (withOwner && withOwner.acts) || [];
  ok(order.indexOf("message") > order.indexOf("call"),
     "Message sits after Call — the two ways of reaching a person, together",
     JSON.stringify(order));
  ok(order.indexOf("message") < order.indexOf("navigate"),
     "and before Navigate, which answers a different question",
     JSON.stringify(order));

  const asked = await page.evaluate(() => window.__RPC.filter((c) => c.name === "day_job_posters"));
  ok(asked.length === 1, "one lookup for the whole board, not one per card", String(asked.length));
  ok(asked[0] && Array.isArray(asked[0].args.p_job_ids) && asked[0].args.p_job_ids.length === 2,
     "asking about exactly the jobs on screen", JSON.stringify(asked[0] && asked[0].args));

  ok(errs.length === 0, "no page errors", errs.slice(0, 2).join(" | "));
  await page.close();
}

// ---------------------------------------------------------------------------
section("A signed-out visitor is not asked to guess");
{
  const { page, errs } = await openJobs(false);
  const rows = await cards(page);
  ok(rows.length === 2, "the board still works signed out", String(rows.length));
  ok(rows.every((r) => !r.msgHref),
     "with no Message buttons at all", JSON.stringify(rows.map((r) => r.msgHref)));
  // The database refuses anon anyway; not making the call is about not asking
  // a question whose answer is already known.
  const asked = await page.evaluate(() => window.__RPC.filter((c) => c.name === "day_job_posters"));
  ok(asked.length === 0, "and the lookup is never even sent", JSON.stringify(asked));
  ok(rows.every((r) => r.acts.includes("call")), "Call is still there for everybody");
  ok(errs.length === 0, "no page errors", errs.slice(0, 2).join(" | "));
  await page.close();
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
