// ============================================================================
// notices_ui_test.mjs — the bell, and the Profile tab, carrying what the admin
// said and how long the subscription has left.
//
// agent_notices_test.mjs proves the database side. This proves the two places
// a person actually meets it:
//
//   the bell        rides on the home page, the directory, the Profile tab and
//                   all three agent dashboards. It has to name the state, not
//                   just count it: "ends in 5 days" and "paused" are different
//                   sentences with different colours.
//   Profile         the list the bell links to (#notices). Opening a notice
//                   marks it read, and the row goes with it.
//
// And the one that matters most: a signed-out visitor and a guest see none of
// it, because neither has an account for an admin to write to.
//
//   usage:  node server.js   then:  node tests/notices_ui_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const NOTICES = [
  { id: "11111111-1111-4111-8111-111111111111", title: "Your listings have been paused",
    body: "Owes for March. Contact the admin to sort it out.", kind: "billing",
    // Aged on purpose, and by different amounts. A panel that shows no time at
    // all is why a notice from this morning and one from five weeks ago used to
    // look identical, so the fixture has to be able to tell them apart.
    severity: "urgent", created_at: new Date(Date.now() - 2 * 86400000).toISOString() },
  { id: "22222222-2222-4222-8222-222222222222", title: "A word from the admin",
    body: "Come and see me about the Mwanza listings.", kind: "individual",
    severity: "info", created_at: new Date(Date.now() - 3 * 3600000).toISOString() },
];

function stub(opts = {}) {
  const session = opts.session === undefined ? null : opts.session;
  const payload = opts.notices === undefined
    ? { unread: NOTICES.length, notices: NOTICES,
        billing: { reason: "active", active: true, status: "paid",
                   paid_until: "2027-01-20", days_left: 5, deadline: null } }
    : opts.notices;
  return `window.supabase={createClient:function(){
var s=${JSON.stringify(session)};
window.__marked=[];
function tbl(){var b={};["select","eq","neq","gt","gte","lt","lte","is","or","order","limit","in","maybeSingle","single","update","insert"].forEach(function(m){b[m]=function(){return b}});
b.then=function(r,j){return Promise.resolve({data:[],error:null}).then(r,j)};return b}
return{rpc:function(n,a){
 if(n==="my_notices")return Promise.resolve({data:${JSON.stringify(payload)},error:null});
 if(n==="notice_mark_read"){window.__marked.push(a&&a.p_id);return Promise.resolve({data:true,error:null})}
 if(n==="notices_mark_all_read")return Promise.resolve({data:2,error:null});
 if(n==="pm_inbox")return Promise.resolve({data:[],error:null});
 if(n==="my_agent_subscription")return Promise.resolve({data:[],error:null});
 return Promise.resolve({data:[],error:null})},
from:tbl,
auth:{getSession:function(){return Promise.resolve({data:{session:s},error:null})},
getUser:function(){return Promise.resolve({data:{user:s&&s.user||null},error:null})},
signOut:function(){return Promise.resolve({error:null})},
onAuthStateChange:function(){return{data:{subscription:{unsubscribe:function(){}}}}}},
channel:function(){return{on:function(){return this},subscribe:function(){return this}}},removeChannel:function(){},
storage:{from:function(){return{getPublicUrl:function(){return{data:{publicUrl:""}}}}}}}}};`;
}

const ACCOUNT = { user: { id: "agent-1", email: "dalali@example.com", is_anonymous: false } };
const GUEST   = { user: { id: "guest-1", email: null, is_anonymous: true } };

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });
const errors = [];

// A context per page, not just a page. Sharing the default context shares the
// SERVICE WORKER: section 1 registers it, it activates while section 2 is
// loading, sw-register.js reloads the page on controllerchange, and the goto
// that was waiting for domcontentloaded never settles. It only bites when the
// 76-file precache happens to finish inside section 1's wait, so it looks like
// flakiness on a busy machine and passes on an idle one. An isolated context
// starts with no worker and cannot race.
async function open(body) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.setViewport({ width: 390, height: 900, deviceScaleFactor: 1, isMobile: true });
  await p.evaluateOnNewDocument(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} });
  await p.setRequestInterception(true);
  p.on("request", (r) => {
    const u = r.url();
    if (/cdn\.jsdelivr\.net.*supabase/.test(u))
      return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body });
    if (/fonts\.googleapis|fonts\.gstatic/.test(u))
      return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    if (/supabase\.co|tile\.|locationiq|openstreetmap|maptiler|mapbox|overpass/.test(u))
      return r.respond({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
    r.continue();
  });
  return p;
}

const panelText = (p) => p.evaluate(() => {
  const el = document.querySelector(".nt-panel");
  return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
});

try {
  // -------------------------------------------------------------------------
  section("1. The bell says which state, not just how many");
  {
    const p = await open(stub({ session: ACCOUNT }));
    await p.goto("http://localhost:8080/index.html", { waitUntil: "domcontentloaded" });
    await wait(3000);
    const badge = await p.evaluate(() => {
      const b = document.querySelector(".pawa-notify-badge");
      return b && !b.hidden ? b.textContent.trim() : "";
    });
    ok(badge !== "", "the bell carries a badge when there is account news", badge);

    await p.evaluate(() => document.getElementById("pawa-notify-bell")?.click());
    await wait(600);
    const txt = await panelText(p);
    ok(/ends in 5 days/i.test(txt),
       "the subscription row names the days left rather than counting rows", txt.slice(0, 160));
    // It used to be enough that the panel said "2 messages about your account".
    // That was the complaint: the notice was fetched, counted, and its own words
    // thrown away. Each one is its own row now, and the row says what it says.
    ok(/Your listings have been paused/.test(txt),
       "each admin notice says what the admin actually wrote", txt.slice(0, 260));
    ok(/A word from the admin/.test(txt),
       "and every one of them, not the first", txt.slice(0, 260));
    ok(/pay the admin/i.test(txt),
       "with the one thing to do about it, which is not a button in this app");

    // A state is not a tally: "1" beside "ends in 5 days" reads as one more
    // thing to get through rather than the one thing to act on.
    const counts = await p.evaluate(() => {
      const row = [...document.querySelectorAll(".nt-row")].find((r) => r.dataset.key === "renew");
      return row ? !!row.querySelector(".nt-row-n") : null;
    });
    ok(counts === false, "and the subscription row carries no count chip", String(counts));

    const admin = await p.evaluate(() => {
      const rows = [...document.querySelectorAll('.nt-item[data-key="admin"]')];
      return {
        n: rows.length,
        href: rows[0] ? rows[0].getAttribute("href") : "",
        when: rows.map((r) => (r.querySelector(".nt-item-when") || {}).textContent || ""),
        ids: rows.map((r) => r.dataset.id).filter(Boolean).length,
      };
    });
    ok(admin.n === 2, "one row per notice, not one row for all of them", String(admin.n));
    ok(/profile\.html#notices/.test(admin.href),
       "and each leads to where it can be read and marked", admin.href);
    // A notice with no time on it is why one from this morning and one from
    // five weeks ago used to look identical.
    ok(admin.when.every((w) => w.trim() !== ""), "each carries when it arrived", admin.when.join(" | "));
    ok(admin.when[0] !== admin.when[1],
       "and two notices of different ages do not read the same", admin.when.join(" | "));
    ok(admin.ids === 2, "and the id of the notice it stands for", String(admin.ids));

    const sections = await p.evaluate(() =>
      [...document.querySelectorAll(".nt-sec")].map((x) => x.dataset.sec));
    ok(sections.indexOf("account") >= 0, "the account section exists", sections.join(","));
    ok(sections.indexOf("nearby") < 0 || sections.indexOf("account") < sections.indexOf("nearby"),
       "and what the admin said comes before what is merely new", sections.join(","));
    await p.close();
  }

  // -------------------------------------------------------------------------
  section("2. Nobody else is shown any of it");
  {
    const p = await open(stub({ session: null, notices: { unread: 0, notices: [], billing: null } }));
    await p.goto("http://localhost:8080/index.html", { waitUntil: "domcontentloaded" });
    await wait(2600);
    await p.evaluate(() => document.getElementById("pawa-notify-bell")?.click());
    await wait(500);
    const txt = await panelText(p);
    ok(!/subscription|about your account/i.test(txt),
       "a signed-out visitor gets no account rows", txt.slice(0, 120));
    await p.close();
  }
  {
    const p = await open(stub({ session: GUEST }));
    await p.goto("http://localhost:8080/profile.html", { waitUntil: "domcontentloaded" });
    await wait(3000);
    ok(await p.evaluate(() => !document.getElementById("notices")),
       "and a guest has no notices section: no account for an admin to write to");
    await p.close();
  }

  // -------------------------------------------------------------------------
  section("3. The Profile tab, which is where the bell points");
  {
    const p = await open(stub({ session: ACCOUNT }));
    await p.goto("http://localhost:8080/profile.html", { waitUntil: "domcontentloaded" });
    await wait(3200);
    ok(await p.evaluate(() => !!document.getElementById("notices")),
       "the section the bell links to exists");
    const txt = await p.evaluate(() => {
      const el = document.getElementById("notices");
      return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
    });
    ok(/paused/i.test(txt) && /word from the admin/i.test(txt),
       "with both notices in it", txt.slice(0, 200));
    ok(/subscription/i.test(txt), "and the subscription, because five days is worth saying", txt.slice(0, 200));

    // Opening one reads it. There is no second "mark as read" to forget.
    await p.evaluate(() => {
      const btn = [...document.querySelectorAll("#notices [data-act]")]
        .find((b) => b.dataset.act.indexOf("notice:") === 0);
      btn && btn.click();
    });
    await wait(700);
    const dialog = await p.evaluate(() => {
      const el = document.getElementById("pfModal");
      return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
    });
    ok(/Owes for March|Mwanza listings/.test(dialog),
       "tapping one opens it in full", dialog.slice(0, 140));
    const marked = await p.evaluate(() => (window.__marked || []).length);
    ok(marked === 1, "and marks exactly that one read", String(marked));
    await wait(500);
    const left = await p.evaluate(() =>
      document.querySelectorAll("#notices [data-act^='notice:']").length);
    ok(left === 1, "so the row it came from is gone", String(left));
    await p.close();
  }

  section("4. No errors");
  ok(errors.length === 0, "no page threw anything", errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
