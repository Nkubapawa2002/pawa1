// ============================================================================
//  guest_fence_test.mjs — a guest session is not an account.
//
//  Supabase anonymous sign-in hands a guest a REAL session. session.user
//  exists, it carries an id, and every gate in this app written as
//  `if (session?.user)` answered yes to it. Five screens were written that way:
//  the three agent dashboards and the two consoles. Typing agent-houses.html
//  into the address bar after tapping "chat as a guest" opened the whole
//  listings dashboard, the new-listing form and the admin inbox. The database
//  refused every write, so nothing could be created, but a panel that opens
//  for somebody who can do nothing in it is a screen telling a stranger what
//  the inside looks like.
//
//  This file drives all five with an anonymous session and asserts that not
//  one of them opens, then drives one of them with a real account and asserts
//  that it still does, because a fence that closes everything is not a fence,
//  it is a wall.
//
//  Nothing here tests permission. Permission is RLS, and RLS is not reachable
//  from a browser test. This tests what the screens DRAW, which is the thing
//  that was wrong.
//
//    usage:  node server.js      then, in another shell:
//            node tests/guest_fence_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";

let passed = 0;
const fails = [];
const ok = (cond, what, detail) => {
  if (cond) { passed++; console.log("  PASS  " + what); }
  else { fails.push(what); console.log("  FAIL  " + what); if (detail) console.log("        " + detail); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the stub --
// One client, two identities. `window.__anon` decides which one getSession
// hands back, so the same page can be opened as a guest and as an account
// without a second stub.
const STUB = `(function () {
  var GUEST   = { user: { id: "g-1", email: null, is_anonymous: true }, access_token: "t" };
  var ACCOUNT = { user: { id: "u-1", email: "juma@example.com", is_anonymous: false }, access_token: "t" };
  function session() { return window.__anon === false ? ACCOUNT : GUEST; }
  function builder() {
    var b = {};
    ["select","eq","neq","gt","gte","lt","lte","in","is","or","not","filter","order","limit",
     "range","match","single","maybeSingle","insert","update","upsert","delete","contains","overlaps"]
      .forEach(function (m) { b[m] = function () { return b; }; });
    b.then = function (res, rej) {
      return Promise.resolve({ data: [], error: null, count: 0 }).then(res, rej);
    };
    return b;
  }
  var channel = {
    on: function () { return channel; },
    subscribe: function () { return channel; },
    unsubscribe: function () { return Promise.resolve(); },
    send: function () { return Promise.resolve(); },
    track: function () { return Promise.resolve(); },
  };
  window.supabase = {
    createClient: function () {
      return {
        from: builder,
        rpc: function () { return Promise.resolve({ data: null, error: null }); },
        channel: function () { return channel; },
        removeChannel: function () {},
        storage: { from: function () { return {
          upload: function () { return Promise.resolve({ data: null, error: null }); },
          getPublicUrl: function () { return { data: { publicUrl: "" } }; },
          remove: function () { return Promise.resolve({ data: null, error: null }); },
        }; } },
        auth: {
          getSession: function () { return Promise.resolve({ data: { session: session() }, error: null }); },
          getUser: function () { return Promise.resolve({ data: { user: session().user }, error: null }); },
          signInWithPassword: function () { return Promise.resolve({ data: { session: ACCOUNT }, error: null }); },
          signInAnonymously: function () { return Promise.resolve({ data: { session: GUEST }, error: null }); },
          signOut: function () { return Promise.resolve({ error: null }); },
          onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
        },
      };
    },
  };
})();`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
});

async function open(file, { anon = true } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewport({ width: 414, height: 900 });
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("cdn.jsdelivr.net/npm/@supabase"))
      return r.respond({ status: 200, contentType: "application/javascript", body: STUB });
    // Everything else off the network is stubbed empty: a map library or a
    // font that fails to load must not be mistaken for a gate that held.
    if (u.startsWith("http") && !u.startsWith(BASE))
      return r.respond({ status: 200, contentType: /\.png|tile/.test(u) ? "image/png" : "text/plain",
                         headers: { "access-control-allow-origin": "*" },
                         body: /\.png|tile/.test(u) ? PNG : "" });
    r.continue();
  });
  await page.evaluateOnNewDocument((a) => {
    try { localStorage.clear(); localStorage.setItem("pawa-theme", "dark"); } catch (_) {}
    window.__anon = a;
  }, anon);
  await page.goto(BASE + "/" + file, { waitUntil: "domcontentloaded", timeout: 40000 });
  await wait(1400);
  return { page, errors, close: () => ctx.close() };
}

const shown = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none";
}, sel);

// ---------------------------------------------------------------------------
//  The three catalogue dashboards.
// ---------------------------------------------------------------------------
const DASHBOARDS = [
  { file: "agent-houses.html",   auth: "#ahAuthCard", panel: "#ahDashboard" },
  { file: "agent-services.html", auth: "#asAuthCard", panel: "#asDashboard" },
  { file: "agent-trucks.html",   auth: "#atAuthCard", panel: "#atDashboard" },
];

console.log("\n1. A guest cannot open a listings dashboard");
for (const d of DASHBOARDS) {
  const t = await open(d.file);
  const panel = await shown(t.page, d.panel);
  const auth = await shown(t.page, d.auth);
  const note = await t.page.$eval(".ag-note", (el) => el.textContent.trim()).catch(() => "");
  ok(!panel, d.file + " keeps the dashboard shut");
  ok(auth, d.file + " shows the sign-in card instead");
  // "Sign in" is confusing advice for somebody who just did. The banner is
  // what turns a dead end into an instruction.
  ok(/guest/i.test(note), d.file + " says why, in words", note.slice(0, 80) || "(no banner)");
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n2. And a real account still opens it");
{
  const t = await open("agent-houses.html", { anon: false });
  ok(await shown(t.page, "#ahDashboard"), "an account reaches the dashboard");
  ok(!(await shown(t.page, "#ahAuthCard")), "and is not asked to sign in again");
  const note = await t.page.$(".ag-note");
  ok(!note, "with no guest banner left behind");
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n3. A guest cannot open either console");
{
  const a = await open("admin.html");
  ok(!(await shown(a.page, "#adminPanel")), "admin.html keeps the panel shut");
  ok(!(await shown(a.page, "#forbidden")),
     "and does not print an empty email back at somebody who never gave one");
  ok(await shown(a.page, "#loginGate"), "it shows the sign-in gate");
  await a.close();

  const s = await open("super-admin.html");
  ok(!(await shown(s.page, "#saPanel")), "super-admin.html keeps the panel shut");
  ok(!(await shown(s.page, "#saForbidden")), "and does not call a guest forbidden either");
  ok(await shown(s.page, "#saLoginGate"), "it shows the sign-in gate");
  await s.close();
}

// ---------------------------------------------------------------------------
console.log("\n4. Profile offers a guest nothing it cannot use");
{
  const t = await open("profile.html");
  const page = await t.page.evaluate(() => ({
    text: (document.getElementById("pfMain") || {}).innerText || "",
    links: [...document.querySelectorAll("#pfMain a")].map((a) => a.getAttribute("href")),
  }));
  ok(!page.links.includes("admin.html") && !page.links.includes("super-admin.html"),
     "no link to either console", page.links.join(" "));
  ok(!page.links.some((h) => /^agent-/.test(h || "")),
     "and none to the three dashboards", page.links.join(" "));
  ok(/guest/i.test(page.text), "it names the state the person is actually in");
  await t.close();
}

// ---------------------------------------------------------------------------
//  The guard itself. If this ever starts answering "account" for an anonymous
//  session, every assertion above becomes theatre, so it is asserted directly.
// ---------------------------------------------------------------------------
console.log("\n5. The guard's own answer");
{
  const t = await open("profile.html");
  const r = await t.page.evaluate(() => {
    const G = window.AuthGuard;
    if (!G) return { missing: true };
    return {
      anon: G.state({ user: { id: "x", is_anonymous: true } }),
      real: G.state({ user: { id: "x", email: "a@b.c", is_anonymous: false } }),
      none: G.state(null),
      empty: G.state({}),
      // is_anonymous absent is an OLD session shape, not a guest. It must read
      // as an account, or every returning user is locked out of their own
      // dashboard the day this ships.
      legacy: G.state({ user: { id: "x", email: "a@b.c" } }),
    };
  });
  ok(!r.missing, "the guard is loaded on the page");
  ok(r.anon === "guest", "an anonymous session is a guest", String(r.anon));
  ok(r.real === "account", "a named one is an account", String(r.real));
  ok(r.none === "out" && r.empty === "out", "no session at all is out",
     String(r.none) + "/" + String(r.empty));
  ok(r.legacy === "account", "a session with no anonymous flag is an account",
     String(r.legacy));
  await t.close();
}

// ---------------------------------------------------------------------------
//  The portal chooser. This is the screen the whole fence was built for and
//  the one page that never adopted the guard: `mine.length ? mine : PORTALS`
//  fell through to the full list for anybody who owned nothing, and a guest
//  owns nothing by construction. What a guest was shown was four portals with
//  System admin at the top of them, under the words "Signed in as".
// ---------------------------------------------------------------------------
console.log("\n6. The portal chooser tells a guest the truth");
{
  const t = await open("login.html");
  const r = await t.page.evaluate(() => ({
    card: !document.getElementById("cardPortal").hidden,
    hrefs: [...document.querySelectorAll("#portalList a")].map((a) => a.getAttribute("href")),
    join: !!document.getElementById("portalJoin"),
    note: (document.getElementById("portalEmpty") || {}).innerText || "",
  }));
  ok(r.card, "a guest session reaches the chooser at all");
  ok(!r.hrefs.includes("admin.html"), "no admin console", r.hrefs.join(" "));
  ok(!r.hrefs.some((h) => /^agent-/.test(h || "")),
     "and not one of the three portals", r.hrefs.join(" "));
  // A warning over a dead end is still a dead end: the sentence says "create
  // an account", so there has to be something to press that does it.
  ok(r.join, "it offers the account the warning talks about");
  ok(/guest/i.test(r.note), "and names the state they are in", r.note.slice(0, 80));
  await t.close();
}

console.log("\n7. And an account still gets its portals");
{
  const t = await open("login.html", { anon: false });
  const hrefs = await t.page.evaluate(() =>
    [...document.querySelectorAll("#portalList a")].map((a) => a.getAttribute("href")));
  // The stub owns nothing either, so this is the `mine` fallback path — the
  // one the guest must not take and an account must. A fence that closes on
  // everybody is a wall.
  ok(hrefs.some((h) => /^agent-/.test(h || "")),
     "an account still sees the portals", hrefs.join(" "));
  ok(!(await t.page.$("#portalJoin")), "and is not asked to create an account",
     "portalJoin should only exist for a guest");
  await t.close();
}

// ---------------------------------------------------------------------------
//  There is deliberately NO section here for js/core/nav.js. Its agent-portal
//  links and its sign-out button carry the same guest bug the chooser did, and
//  they are fixed in that file — but window.renderNav is not called from
//  anywhere in this repo, so the shared dropdown is never drawn and an
//  assertion about it would pass or fail on code that cannot run. If the nav
//  is ever revived, the test to write asserts .nav-agent-link is hidden for a
//  guest and #navSignOut is shown.
// ---------------------------------------------------------------------------

console.log("\n" + passed + " passed, " + fails.length + " failed\n");
await browser.close();
process.exit(fails.length ? 1 : 0);
