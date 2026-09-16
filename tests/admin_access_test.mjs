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
// WHAT CHANGED, AND WHY THE ASSERTIONS INVERTED
// This file used to prove a three-state console: a sign-in gate, a refusal
// that named the address you were signed in as, and the panel. All three are
// gone. A non-admin now gets the same not-found a mistyped URL gets, and the
// console markup is REMOVED from the document rather than carrying `hidden`.
//
// Two reasons, and the second one is the sharper:
//
//   1. Every one of those states confirmed the page exists, and the refusal
//      confirmed the account as well.
//   2. admin.html and super-admin.html each had their own email + password
//      form, and NEITHER loaded js/lib/auth-policy.js -- the escalating
//      lockout that guards login.html. So the two highest-value credential
//      targets in the app were the two with no brute-force resistance at all.
//      Deleting the forms beats copying the throttle: one door, defended.
//
// A trap this file fell into and now guards against: `hidden` is the wrong
// question for an element that has been REMOVED. `!el?.hidden` is `!undefined`
// is `true`, so a deleted node reads as "showing". Check existence first.
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

// PRESENT, not merely visible. The console is REMOVED from the DOM for anybody
// who is not an admin, so `hidden` is the wrong question now -- and asking it
// the old way was actively misleading: `!document.getElementById(gone)?.hidden`
// evaluates to `!undefined`, which is true, so a deleted element read as
// "showing". Every check below tests existence first.
const view = (p) => p.evaluate(() => {
  const panel = document.getElementById("adminPanel");
  const text = (document.body.innerText || "");
  return {
    panelInDom: !!panel,
    panelShown: !!panel && !panel.hidden,
    notHereShown: (() => {
      const n = document.getElementById("notHere") || document.getElementById("saNotHere");
      return !!n && !n.hidden;
    })(),
    // Is any of the console's own furniture on screen for somebody who should
    // not have it? Hidden ancestors make offsetParent null, which is the
    // question a person would ask by looking.
    sectionsVisible: [...document.querySelectorAll(".adm-rail .tab-btn")]
      .filter((b) => b.offsetParent !== null).length,
    asked: (window.__asked || []).filter((n) => /agent_billing|agent_messages|account_kinds|owner_posts|tenanc/.test(n)).length,
    // The page must not SAY anything either. A refusal that reads "not
    // authorized as an admin" confirms the page exists as loudly as a link to
    // it does, and the old one also read the signed-in address back.
    saysAdmin: /\badmin\b|\bforbidden\b|not authorized|restricted/i.test(text),
    saysEmail: /@/.test(text),
  };
});

try {
  section("1. admin.html tells nobody it is admin.html");
  // FOUR DIFFERENT VISITORS, ONE IDENTICAL ANSWER, and that sameness is the
  // property under test. Signed out, browsing as a guest, signed in as
  // somebody ordinary, and signed in as an address that used to be on the
  // shipped allow-list but is not in the `admins` table: none of them may
  // learn anything about this page, including which of the four they are.
  for (const [who, session, opts] of [
    ["signed out", OUT, undefined],
    ["a guest session", GUEST, undefined],
    ["an ordinary account", ACCOUNT, undefined],
    ["an address the admins TABLE does not know", ADMIN, { isAdminRow: false }],
  ]) {
    const p = await visit("admin.html", session, opts);
    const v = await view(p);
    ok(!v.panelInDom,
       `${who}: the console is REMOVED from the page, not hidden on it`,
       JSON.stringify(v));
    ok(v.notHereShown, `${who}: and gets the same not-found a mistyped URL gets`);
    ok(!v.saysAdmin,
       `${who}: the page never says "admin", "forbidden", "not authorized" or "restricted"`,
       JSON.stringify(v));
    ok(!v.saysEmail, `${who}: and never reads an address back`);
    ok(v.sectionsVisible === 0 && v.asked === 0,
       `${who}: nothing of the console is drawn and none of its tables are asked for`,
       JSON.stringify(v));
    await p.close();
  }
  {
    // The one visitor who is entitled to it still gets the whole thing. This
    // is the assertion that stops the section above being satisfied by a page
    // that simply broke.
    const p = await visit("admin.html", ADMIN, { isAdminRow: true });
    const v = await view(p);
    ok(v.panelInDom && v.panelShown, "a real admin gets the console", JSON.stringify(v));
    ok(!v.notHereShown, "and not the not-found");
    ok(v.sectionsVisible === 7, "with all seven sections in the rail", String(v.sectionsVisible));
    const active = await p.evaluate(() =>
      document.querySelector(".adm-rail .tab-btn.active")?.dataset.tab || "");
    ok(active === "allagents", "opening on the agents tracker", active);
    await p.close();
  }
  {
    // There is no password box to hammer. This page had the app's only
    // unthrottled credential form -- login.html runs every attempt through
    // js/lib/auth-policy.js and admin.html never loaded that file -- so the
    // form is deleted rather than throttled, leaving one defended door.
    const p = await visit("admin.html", OUT);
    const forms = await p.evaluate(() => ({
      pw: document.querySelectorAll('input[type="password"]').length,
      forms: document.querySelectorAll("form").length,
    }));
    ok(forms.pw === 0, "and no password field to guess at", JSON.stringify(forms));
    await p.close();
  }

  section("2. super-admin.html, the same");
  for (const [who, session, opts] of [
    ["an ordinary account", ACCOUNT, undefined],
    ["a visitor who is not signed in", OUT, undefined],
  ]) {
    const p = await visit("super-admin.html", session, opts);
    const v = await p.evaluate(() => {
      const panel = document.getElementById("saPanel");
      const nf = document.getElementById("saNotHere");
      const text = document.body.innerText || "";
      return {
        panelInDom: !!panel,
        notHereShown: !!nf && !nf.hidden,
        pw: document.querySelectorAll('input[type="password"]').length,
        saysAdmin: /\badmin\b|\bforbidden\b|not authorized|restricted/i.test(text),
      };
    });
    ok(!v.panelInDom, `${who}: the overview is removed from the page`, JSON.stringify(v));
    ok(v.notHereShown, `${who}: and gets the not-found`);
    ok(!v.saysAdmin, `${who}: with nothing on it naming what it is`);
    ok(v.pw === 0, `${who}: and no password field`);
    await p.close();
  }
  {
    // It used to fail OPEN: `let inAdminsTable = true` followed by a catch that
    // ignored the error, so any throw at all handed over the console.
    const p = await visit("super-admin.html", ADMIN, { isAdminRow: true });
    const shown = await p.evaluate(() => {
      const panel = document.getElementById("saPanel");
      return !!panel && !panel.hidden;
    });
    ok(shown, "a real admin still gets the platform overview");
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
