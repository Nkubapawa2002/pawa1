// ============================================================================
// admin_access_test.mjs — who can see the console, and who cannot.
//
// The admin panel is gated three times over: the nav link is hidden unless the
// admins TABLE says yes, the page draws a sign-in gate or a "not authorized"
// card instead of the panel, and every table it reads is behind RLS that asks
// the same question again. This proves the first two, because they are the
// ones a person can see, and the ones a redesign can quietly break.
//
// Four visitors, four different screens:
//
//   signed out      the sign-in gate
//   a guest         the sign-in gate, with the reason. A guest session is a
//                   real session with no account behind it, so "you are not
//                   authorized" would name an email it does not have.
//   an account      the forbidden card, naming the address it is signed in as
//   an admin        the console
//
// And in the first three, nothing of the console is in the page: not the
// sections, not the tables, and no request for what is in them.
//
//   usage:  node server.js   then:  node tests/admin_access_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ADMIN_EMAIL = "pawa4761@gmail.com";

function stub(session, { isAdminRow = false } = {}) {
  return `window.supabase={createClient:function(){
var s=${JSON.stringify(session)};
window.__asked=[];
function tbl(name){window.__asked.push(name);var b={};
["select","eq","neq","gt","gte","lt","lte","is","or","order","limit","in","like","maybeSingle","single","update","insert","upsert","delete"].forEach(function(m){b[m]=function(){return b}});
b.then=function(r,j){var d=[];if(name==="admins")d=${JSON.stringify(isAdminRow)}?[{email:"${ADMIN_EMAIL}"}]:[];
return Promise.resolve({data:d,error:null,count:0}).then(r,j)};return b}
return{rpc:function(n){window.__asked.push("rpc:"+n);return Promise.resolve({data:[],error:null})},from:tbl,
auth:{getSession:function(){return Promise.resolve({data:{session:s},error:null})},
getUser:function(){return Promise.resolve({data:{user:s&&s.user||null},error:null})},
signOut:function(){return Promise.resolve({error:null})},
onAuthStateChange:function(){return{data:{subscription:{unsubscribe:function(){}}}}}},
channel:function(){return{on:function(){return this},subscribe:function(){return this}}},removeChannel:function(){},
storage:{from:function(){return{getPublicUrl:function(){return{data:{publicUrl:""}}}}}}}}};`;
}

const OUT     = null;
const GUEST   = { user: { id: "g1", email: null, is_anonymous: true } };
const ACCOUNT = { user: { id: "u1", email: "dalali@example.com", is_anonymous: false } };
const ADMIN   = { user: { id: "a1", email: ADMIN_EMAIL, is_anonymous: false } };

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });
const errors = [];

async function visit(page, session, opts) {
  const p = await browser.newPage();
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.setViewport({ width: 1280, height: 900 });
  await p.evaluateOnNewDocument(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} });
  await p.setRequestInterception(true);
  const body = stub(session, opts);
  p.on("request", (r) => {
    const u = r.url();
    if (/cdn\.jsdelivr\.net.*supabase/.test(u))
      return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body });
    if (/fonts\.googleapis|fonts\.gstatic/.test(u))
      return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    if (/supabase\.co|tile\.|locationiq|openstreetmap|maptiler|mapbox/.test(u))
      return r.respond({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
    r.continue();
  });
  await p.goto("http://localhost:8080/" + page, { waitUntil: "domcontentloaded" });
  await wait(2800);
  return p;
}

const view = (p) => p.evaluate(() => ({
  gate: !document.getElementById("loginGate")?.hidden,
  forbidden: !document.getElementById("forbidden")?.hidden,
  panel: !document.getElementById("adminPanel")?.hidden,
  // Is any of the console's own furniture on screen for somebody who should
  // not have it? Hidden ancestors make offsetParent null, which is the
  // question a person would ask by looking.
  sectionsVisible: [...document.querySelectorAll(".adm-rail .tab-btn")]
    .filter((b) => b.offsetParent !== null).length,
  asked: (window.__asked || []).filter((n) => /agent_billing|agent_messages|account_kinds|owner_posts|tenanc/.test(n)).length,
}));

try {
  section("1. admin.html");
  {
    const p = await visit("admin.html", OUT);
    const v = await view(p);
    ok(v.gate && !v.panel && !v.forbidden, "signed out lands on the sign-in gate", JSON.stringify(v));
    ok(v.sectionsVisible === 0, "and none of the console's sections are on the page", String(v.sectionsVisible));
    ok(v.asked === 0, "and it asks the database for none of the console's tables", String(v.asked));
    await p.close();
  }
  {
    const p = await visit("admin.html", GUEST);
    const v = await view(p);
    ok(v.gate && !v.panel && !v.forbidden,
       "a guest session goes to the gate, not to a card naming an email it has not got", JSON.stringify(v));
    ok(v.sectionsVisible === 0 && v.asked === 0, "with nothing of the console drawn or fetched");
    await p.close();
  }
  {
    const p = await visit("admin.html", ACCOUNT);
    const v = await view(p);
    ok(v.forbidden && !v.panel, "an ordinary account is told plainly that it is not authorized", JSON.stringify(v));
    const who = await p.evaluate(() => document.getElementById("whoami")?.textContent || "");
    ok(who === "dalali@example.com", "naming the address it IS signed in as, so the fix is obvious", who);
    ok(v.sectionsVisible === 0 && v.asked === 0, "and still nothing of the console", JSON.stringify(v));
    await p.close();
  }
  {
    // The allowlist in config.js ships to every browser. It is NOT what
    // decides: the admins table is, and this is the visitor who is on the
    // list and not in the table.
    const p = await visit("admin.html", ADMIN, { isAdminRow: false });
    const v = await view(p);
    ok(v.forbidden && !v.panel,
       "an allowlisted email that the admins TABLE does not know is refused too", JSON.stringify(v));
    await p.close();
  }
  {
    const p = await visit("admin.html", ADMIN, { isAdminRow: true });
    const v = await view(p);
    ok(v.panel && !v.gate && !v.forbidden, "a real admin gets the console", JSON.stringify(v));
    ok(v.sectionsVisible === 6, "with all six sections in the rail", String(v.sectionsVisible));
    const active = await p.evaluate(() =>
      document.querySelector(".adm-rail .tab-btn.active")?.dataset.tab || "");
    ok(active === "allagents", "opening on the agents tracker", active);
    await p.close();
  }

  section("2. super-admin.html");
  {
    const p = await visit("super-admin.html", ACCOUNT);
    const shown = await p.evaluate(() => ({
      gate: !document.getElementById("saLoginGate")?.hidden,
      forbidden: !document.getElementById("saForbidden")?.hidden,
      panel: !document.getElementById("saPanel")?.hidden,
    }));
    ok(!shown.panel, "an ordinary account does not get the platform overview", JSON.stringify(shown));
    await p.close();
  }
  {
    const p = await visit("super-admin.html", OUT);
    const shown = await p.evaluate(() => !document.getElementById("saPanel")?.hidden);
    ok(shown === false, "and neither does a visitor who is not signed in at all");
    await p.close();
  }

  section("3. The way in is not advertised to people who cannot use it");
  {
    const p = await visit("profile.html", ACCOUNT);
    const rows = await p.evaluate(() =>
      [...document.querySelectorAll('a[href="admin.html"], a[href="super-admin.html"]')]
        .filter((a) => a.offsetParent !== null).length);
    ok(rows === 0, "an ordinary account is offered no link to either console", String(rows));
    await p.close();
  }
  {
    const p = await visit("profile.html", ADMIN, { isAdminRow: true });
    const rows = await p.evaluate(() =>
      [...document.querySelectorAll('a[href="admin.html"]')].filter((a) => a.offsetParent !== null).length);
    ok(rows >= 1, "and an admin is", String(rows));
    await p.close();
  }

  section("4. No errors");
  ok(errors.length === 0, "no page threw anything", errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
