// ============================================================================
// owner_pages_test.mjs — the owner account on screen, in a real browser.
//
// house_owner_test.mjs proves the rules in the database. This proves the four
// screens that depend on them, against a stubbed Supabase so the run is fast
// and does not touch production:
//
//   index.html          the "straight from the owner" rail, and the badge on a
//                       card. The rail is HIDDEN when no owner has listed.
//   houses.html         the badge in the directory, and ?owner=1
//   house.html          "Listed by the owner", the no-agent-fee note, and a
//                       move-in total with no invented commission
//   agent-houses.html   the allowance panel, and New listing locked at the
//                       ceiling
//
// The last of those is the one worth having a test for: the money card assumes
// the market's one month commission when a listing does not state one, so an
// owner's listing at 180,000 used to show a 360,000 move-in total directly
// under a card saying there is no agent fee.
//
//   usage:  node server.js   then:  node tests/owner_pages_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const HOUSE_OWNER = {
  id: "h1", title: "Self contained room, Mikocheni", area: "Mikocheni", region: "Dar es Salaam",
  price_tzs: 180000, period: "month", listing: "rent", photos: [], photo: null, verified: true,
  posted_by_owner: true, bedrooms: 1, bathrooms: 1, available: true, type: "room", room_kind: "single",
  agent_fee_tzs: 0, agent: { name: "Amina Kileo", phone: "+255700000001" },
  lat: -6.78, lng: 39.25, amenities: [], videos: [], details: {}, pin: {},
  created_at: new Date().toISOString(),
};
const HOUSE_AGENT = {
  id: "h3", title: "Master room, Sinza", area: "Sinza", region: "Dar es Salaam",
  price_tzs: 260000, period: "month", listing: "rent", photos: [], photo: null, verified: true,
  posted_by_owner: false, bedrooms: 1, bathrooms: 1, available: true, type: "room", room_kind: "master",
  agent_fee_tzs: 260000, agent: { name: "Juma Mwanga", phone: "+255700000002" },
  lat: -6.79, lng: 39.24, amenities: [], videos: [], details: {}, pin: {},
  created_at: new Date().toISOString(),
};

function stubFor(houses, opts = {}) {
  const session = opts.session === undefined ? null : opts.session;
  const quota = opts.quota || null;
  return `window.supabase={createClient:function(){
var H=${JSON.stringify(houses)};
var s=${JSON.stringify(session)};
function tbl(name){var b={};["select","eq","neq","gt","gte","lt","lte","is","or","order","limit","in","contains","maybeSingle","single"].forEach(function(m){b[m]=function(){return b}});
b.then=function(r,j){return Promise.resolve({data:name==="houses"?H:[],error:null}).then(r,j)};return b}
return{rpc:function(n){
 if(n==="owner_post_quota")return Promise.resolve({data:${JSON.stringify(quota)},error:null});
 if(n==="account_kind_claim")return Promise.resolve({data:"owner",error:null});
 return Promise.resolve({data:[],error:null})},
from:tbl,
auth:{getSession:function(){return Promise.resolve({data:{session:s},error:null})},
getUser:function(){return Promise.resolve({data:{user:s&&s.user||null},error:null})},
signOut:function(){return Promise.resolve({error:null})},
onAuthStateChange:function(){return{data:{subscription:{unsubscribe:function(){}}}}}},
channel:function(){return{on:function(){return this},subscribe:function(){return this}}},removeChannel:function(){},
storage:{from:function(){return{getPublicUrl:function(){return{data:{publicUrl:""}}}}}}}}};`;
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });
const errors = [];

async function open(stub) {
  const p = await browser.newPage();
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.setViewport({ width: 390, height: 900, deviceScaleFactor: 1, isMobile: true });
  // js/core/data.js caches the catalogue in this origin's storage, and every
  // page in this run shares one browser profile. Without a clear per page, a
  // section is drawn from whatever the PREVIOUS section's stub returned, which
  // fails in the most confusing possible way: the right code against the wrong
  // listings.
  await p.evaluateOnNewDocument(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} });
  await p.setRequestInterception(true);
  p.on("request", (r) => {
    const u = r.url();
    if (/cdn\.jsdelivr\.net.*supabase/.test(u))
      return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: stub });
    if (/fonts\.googleapis|fonts\.gstatic/.test(u))
      return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    // Every network the pages reach for that is not this repo: the map tiles,
    // the geocoder and Supabase itself. Left unstubbed, a run either hangs or
    // is rate limited at random.
    if (/supabase\.co|tile\.|locationiq|openstreetmap|maptiler|mapbox|overpass/.test(u))
      return r.respond({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
    r.continue();
  });
  return p;
}

const text = (p, sel) => p.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
}, sel);

try {
  // -------------------------------------------------------------------------
  section("1. The home page rail");
  {
    const p = await open(stubFor([HOUSE_OWNER, HOUSE_AGENT]));
    await p.goto("http://localhost:8080/index.html", { waitUntil: "domcontentloaded" });
    await wait(2600);
    ok(await p.evaluate(() => document.getElementById("haOwnerWrap")?.hidden === false),
       "the rail is shown when an owner has listed");
    ok(await p.evaluate(() => document.querySelectorAll("#haOwner .ha-feat").length) === 1,
       "and holds only the owner's listing");
    ok((await text(p, "#haOwnerWrap .ha-sec-head h2")).length > 0 &&
       !/own_band/.test(await text(p, "#haOwnerWrap")),
       "with its heading translated, not left as a key",
       await text(p, "#haOwnerWrap .ha-sec-head h2"));
    ok(await p.evaluate(() => document.querySelectorAll("#haFeatured .owner-chip").length) === 1,
       "the badge is on the owner's card in the featured rail, and only that one");

    // Two chips over one photograph. They used to be positioned individually,
    // which put the second one underneath the first.
    const chips = await p.evaluate(() => {
      const row = document.querySelector("#haFeatured .ha-chips");
      if (!row) return null;
      const kids = [...row.children].map((c) => c.getBoundingClientRect());
      return kids.length < 2 ? { n: kids.length } : { n: kids.length, apart: kids[1].left >= kids[0].right - 1 };
    });
    ok(chips && chips.n === 2 && chips.apart,
       "Verified and the owner badge sit beside each other, not on top of each other",
       JSON.stringify(chips));
    await p.close();
  }

  section("1b. And nothing to show is shown as nothing");
  {
    const p = await open(stubFor([HOUSE_AGENT]));
    await p.goto("http://localhost:8080/index.html", { waitUntil: "domcontentloaded" });
    await wait(2600);
    ok(await p.evaluate(() => document.getElementById("haOwnerWrap")?.hidden === true),
       "with no owner listings the whole section is hidden, not left as an empty heading");
    await p.close();
  }

  // -------------------------------------------------------------------------
  section("2. The two corners of the home header");
  {
    const p = await open(stubFor([HOUSE_OWNER]));
    await p.goto("http://localhost:8080/index.html", { waitUntil: "domcontentloaded" });
    await wait(2400);
    const boxes = await p.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
      };
      return {
        toggle: box("#pawa-theme-toggle"), bell: box(".pawa-notify-bell"),
        lang: box("#haLang"), avatar: box("#haAvatar"),
        greet: box(".ha-greet"), loc: box(".ha-loc"),
      };
    });
    const overlaps = (a, b) => !!a && !!b &&
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

    ok(boxes.toggle && boxes.toggle.left < 60, "the theme toggle is in the top LEFT corner here",
       JSON.stringify(boxes.toggle));
    ok(boxes.bell && boxes.bell.left > 300, "and the bell has the top right to itself",
       JSON.stringify(boxes.bell));
    // The bug this fixes: three controls stacked on one corner, two of them
    // drawn on top of the third.
    const pairs = [
      ["toggle", "avatar"], ["toggle", "lang"], ["toggle", "greet"], ["toggle", "loc"],
      ["bell", "avatar"], ["bell", "lang"], ["bell", "greet"], ["bell", "loc"],
      ["avatar", "lang"],
    ];
    const hits = pairs.filter(([a, b]) => overlaps(boxes[a], boxes[b])).map((x) => x.join(" over "));
    ok(hits.length === 0, "and nothing in the header overlaps anything else", hits.join(", "));
    ok(boxes.loc && boxes.loc.height !== 0 && (await text(p, ".ha-loc")).length > 0,
       "the place name is still there, on one line, below the toggle");
    await p.close();
  }

  // -------------------------------------------------------------------------
  section("3. The directory");
  {
    const p = await open(stubFor([HOUSE_OWNER, HOUSE_AGENT]));
    await p.goto("http://localhost:8080/houses.html", { waitUntil: "domcontentloaded" });
    await wait(3200);
    ok(await p.evaluate(() => document.querySelectorAll(".house-card").length) === 2,
       "both listings are in the directory");
    ok(await p.evaluate(() => document.querySelectorAll(".house-card .owner-chip").length) === 1,
       "and one of them carries the badge");

    await p.goto("http://localhost:8080/houses.html?owner=1", { waitUntil: "domcontentloaded" });
    await wait(3200);
    ok(await p.evaluate(() => document.querySelectorAll(".house-card").length) === 1,
       "?owner=1 narrows the directory to owners");
    ok((await text(p, "#hpOwnerChip")).length > 0,
       "and says so on screen, because a filter that arrives from a URL with nothing to show for it is a directory that has quietly lost most of its rooms",
       await text(p, "#hpOwnerChip"));
    await p.evaluate(() => document.getElementById("hpOwnerChipX")?.click());
    await wait(700);
    ok(await p.evaluate(() => document.querySelectorAll(".house-card").length) === 2,
       "and the chip takes it off again");
    await p.close();
  }

  // -------------------------------------------------------------------------
  section("4. The listing itself");
  {
    const p = await open(stubFor([HOUSE_OWNER, HOUSE_AGENT]));
    await p.goto("http://localhost:8080/house.html?id=h1", { waitUntil: "domcontentloaded" });
    await wait(3000);
    ok(/owner/i.test(await text(p, "#sec-agent h3")),
       "the card is headed by the owner, not by a listing agent",
       await text(p, "#sec-agent h3"));
    ok(/no agent fee/i.test(await text(p, "#sec-agent .owner-note")),
       "and says what that means for the reader",
       await text(p, "#sec-agent .owner-note"));

    // The one that matters: house-rooms.js assumes one month's commission when
    // a listing does not state one, which on an owner's listing would invent
    // the largest cost on the page.
    const label = await text(p, ".hx-movein__label");
    const total = await text(p, ".hx-movein__total");
    ok(!/commission/i.test(label),
       "the move-in label does not name a commission that is not in the total", label);
    ok(/180,000/.test(total), "and the total is the rent alone, not the rent plus an invented month", total);

    await p.goto("http://localhost:8080/house.html?id=h3", { waitUntil: "domcontentloaded" });
    await wait(3000);
    ok(/agent/i.test(await text(p, "#sec-agent h3")) && !(await p.evaluate(() => !!document.querySelector("#sec-agent .owner-note"))),
       "an agent's listing is untouched by all of this",
       await text(p, "#sec-agent h3"));
    ok(/commission/i.test(await text(p, ".hx-movein__label")),
       "and still carries its commission", await text(p, ".hx-movein__label"));
    await p.close();
  }

  // -------------------------------------------------------------------------
  section("5. The owner's own account page");
  const session = { user: { id: "me", email: "mwenyenyumba@example.com", is_anonymous: false,
                            user_metadata: { account_type: "owner" } } };
  {
    const p = await open(stubFor([], { session, quota: {
      kind: "owner", is_owner: true, limit: 3, used: 1, left: 2, window_days: 180, next_free_at: null } }));
    await p.goto("http://localhost:8080/agent-houses.html", { waitUntil: "domcontentloaded" });
    await wait(3000);
    const panel = await text(p, "#ahOwnerQuota");
    ok(/2/.test(panel) && /3/.test(panel), "the allowance panel says what is left of what", panel);
    ok(/180/.test(panel), "and over what window, both read from the database rather than written here", panel);
    ok(await p.evaluate(() => document.getElementById("ahNewBtn")?.disabled) === false,
       "New listing is offered while there is an allowance left");
    ok(await p.evaluate(() => !document.getElementById("agentProfileModal")),
       "and an owner is never asked an agent's area of operations, which is what would file them as an agent");
    await p.close();
  }
  {
    const p = await open(stubFor([], { session, quota: {
      kind: "owner", is_owner: true, limit: 3, used: 3, left: 0, window_days: 180,
      next_free_at: "2027-03-04T00:00:00Z" } }));
    await p.goto("http://localhost:8080/agent-houses.html", { waitUntil: "domcontentloaded" });
    await wait(3000);
    ok(await p.evaluate(() => document.getElementById("ahNewBtn")?.disabled) === true,
       "at the ceiling the form is not offered at all");
    ok(/2027/.test(await text(p, "#ahOwnerQuota")),
       "and the screen says when the next post frees up rather than only refusing",
       await text(p, "#ahOwnerQuota"));
    await p.close();
  }
  {
    const p = await open(stubFor([], { session: { user: { id: "me", email: "dalali@example.com", is_anonymous: false } },
      quota: { kind: "agent", is_owner: false, limit: 3, used: 0, left: 3, window_days: 180, next_free_at: null } }));
    await p.goto("http://localhost:8080/agent-houses.html", { waitUntil: "domcontentloaded" });
    await wait(3000);
    ok((await text(p, "#ahOwnerQuota")) === "",
       "an agent account sees no allowance panel, because it is not on one");
    ok(await p.evaluate(() => document.getElementById("ahNewBtn")?.disabled) === false,
       "and is not capped");
    await p.close();
  }

  section("6. No errors");
  ok(errors.length === 0, "no page threw anything", errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
