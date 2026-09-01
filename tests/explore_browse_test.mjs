// ============================================================================
//  tests/explore_browse_test.mjs
//  Explore, reorganised: a browse is grouped, a search is ranked, and a result
//  can be acted on.
//
//  What is worth asserting here is not "does it look nicer". It is the three
//  claims the reorganisation makes, each of which is easy to regress silently:
//
//   1. A BROWSE IS NOT A SEARCH. With nothing typed there is no question, so
//      twenty-one listings of four kinds are sectioned by kind with their
//      counts on the headings. The moment a query, a scope or a sort says what
//      the reader actually wants, it collapses back to one ranked column,
//      because then the best answer belongs at the top whatever kind it is.
//
//   2. THE CARD CAN BE ACTED ON. Explore listed things and offered no way to
//      reach anybody; the owner id was on every indexed item and unused. The
//      card is an <article> with a stretched link now rather than one big <a>,
//      which is the only way it can hold a second destination. Both
//      destinations must work, and that is the assertion — a stretched link
//      that swallows its own button is the exact failure this shape invites.
//
//   3. NOTHING IS INVENTED. A section heading counts what is under it, an
//      empty kind gets no heading at all, and "See all 9" moves the scope chip
//      rather than being a second, separate filter that can disagree with it.
//
//  Supabase REST is stubbed, including the CORS preflight, and supabase-js is
//  served from node_modules rather than the CDN, so a run never depends on
//  jsdelivr being reachable.
//
//  Run:  node server.js   then   node tests/explore_browse_test.mjs
// ============================================================================

import puppeteer from "puppeteer";
import { readFileSync } from "node:fs";

const SBJS = readFileSync("node_modules/@supabase/supabase-js/dist/umd/supabase.js", "utf8");

const fails = [];
let pass = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log("  PASS  " + label); }
  else { fails.push(label + (detail ? "\n        " + detail : "")); console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

const now = new Date().toISOString();
// Deliberately lopsided: 5 rooms, 2 trucks, 3 services and NO day jobs, so the
// counts are all different and the empty kind can be checked for silence.
const HOUSES = Array.from({ length: 5 }, (_, i) => ({
  id: "h" + i, title: "Room number " + i, region: "Dar es Salaam", area: "Tabata",
  price_tzs: 100000 + i * 10000, room_kind: "single", verified: i === 0,
  lat: -6.79 + i * 0.01, lng: 39.21 + i * 0.01, created_at: now,
  owner_user_id: "u-agent-" + i,
}));
const TRUCKS = Array.from({ length: 2 }, (_, i) => ({
  id: "t" + i, title: "Lori number " + i, region: "Dar es Salaam", price_tzs: 80000,
  lat: -6.8, lng: 39.25, created_at: now, owner_user_id: "u-driver-" + i,
}));
const SERVICES = Array.from({ length: 3 }, (_, i) => ({
  id: "s" + i, title: "Fundi number " + i, category: "plumbing", region: "Dar es Salaam",
  price_tzs: 25000, lat: -6.78, lng: 39.19, created_at: now,
  // The last one has NO owner recorded, which must produce no button at all
  // rather than a dead one.
  owner_user_id: i === 2 ? null : "u-fundi-" + i,
}));

async function open(browser) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 390, height: 900, deviceScaleFactor: 2, isMobile: true });
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
  await p.setRequestInterception(true);
  p.on("request", (r) => {
    const u = r.url();
    if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: CORS, body: "" });
    const json = (v) => r.respond({
      status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(v),
    });
    if (/^http:\/\/localhost:8080\//.test(u)) return r.continue();
    // The client comes from node_modules: jsdelivr is the flakiest thing in
    // this fixture, and without a client there is no catalogue and every
    // assertion below would pass vacuously against an empty page.
    if (/supabase-js/.test(u)) {
      return r.respond({ status: 200, headers: { ...CORS, "content-type": "application/javascript" }, body: SBJS });
    }
    if (/cdn\.jsdelivr|unpkg|fonts\./.test(u)) {
      return r.respond({ status: 200, headers: { ...CORS, "content-type": "text/css" }, body: "" });
    }
    if (/\/rest\/v1\/regions/.test(u)) return json([{ name: "Dar es Salaam" }, { name: "Mwanza" }]);
    if (/\/rest\/v1\/houses/.test(u)) return json(HOUSES);
    if (/\/rest\/v1\/trucks/.test(u)) return json(TRUCKS);
    if (/\/rest\/v1\/services/.test(u)) return json(SERVICES);
    if (/\/rest\/v1\//.test(u)) return json([]);
    if (/\/auth\/v1\//.test(u)) return json({});
    return r.respond({ status: 200, headers: CORS, body: "" });
  });
  await p.goto("http://localhost:8080/explore.html", { waitUntil: "domcontentloaded", timeout: 40000 });
  await wait(3000);
  p.__errs = errs;
  return { p, ctx };
}

const shape = (p) => p.evaluate(() => ({
  groups: [...document.querySelectorAll(".xp-group")].map((g) => ({
    kind: g.dataset.k,
    head: g.querySelector(".xp-group-t").textContent.trim(),
    count: Number(g.querySelector(".xp-group-n").textContent.trim()),
    cards: g.querySelectorAll(".xp-card").length,
    seeAll: !!g.querySelector("[data-seeall]"),
  })),
  looseCards: document.querySelectorAll("#xpResults > .xp-card").length,
  totalCards: document.querySelectorAll(".xp-card").length,
  subHidden: (document.getElementById("xpSub") || {}).hidden,
}));

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });

try {
  const { p, ctx } = await open(browser);

  // =========================================================================
  section("1. Browsing is grouped, and the groups count what they hold");
  // =========================================================================
  {
    const s = await shape(p);
    ok(s.groups.length === 3, "three kinds have listings, so three sections", JSON.stringify(s.groups.map((g) => g.kind)));
    ok(!s.groups.some((g) => g.kind === "job"),
       "the kind with nothing in it gets no heading, rather than a heading over a zero");
    ok(s.groups[0] && s.groups[0].kind === "room",
       "rooms lead, because that is what this marketplace is mostly for", s.groups[0] && s.groups[0].kind);

    const room = s.groups.find((g) => g.kind === "room");
    const truck = s.groups.find((g) => g.kind === "truck");
    ok(room && room.count === 5, "the rooms heading counts the rooms", room && String(room.count));
    ok(truck && truck.count === 2, "and the trucks heading counts the trucks", truck && String(truck.count));
    ok(room && room.cards === 4, "a section previews four and no more", room && String(room.cards));
    ok(room && room.seeAll, "so the rooms section offers the rest");
    ok(truck && !truck.seeAll,
       "while a section that already shows everything offers nothing further");
    ok(s.looseCards === 0, "no card is left loose outside a section");
  }

  // =========================================================================
  section("2. A card has two destinations, and both of them work");
  // =========================================================================
  {
    const card = await p.evaluate(() => {
      const c = document.querySelector(".xp-card");
      const hit = c.querySelector(".xp-card-hit");
      const reach = c.querySelector(".xp-reach");
      const view = c.querySelector(".xp-open");
      return {
        tag: c.tagName,
        nestedAnchor: !!c.querySelector("a a"),
        hitHref: hit ? hit.getAttribute("href") : null,
        reachHref: reach ? reach.getAttribute("href") : null,
        hitHidden: hit ? hit.getAttribute("aria-hidden") : null,
        hitTab: hit ? hit.getAttribute("tabindex") : null,
        viewHref: view ? view.getAttribute("href") : null,
        viewText: view ? view.textContent.trim() : null,
        viewTab: view ? view.getAttribute("tabindex") : null,
        // Everything on this card a keyboard can actually land on.
        focusable: [...c.querySelectorAll("a[href], button")]
          .filter((n) => n.getAttribute("tabindex") !== "-1")
          .map((n) => n.className),
      };
    });
    ok(card.tag === "ARTICLE", "the card is no longer one big anchor", card.tag);
    ok(!card.nestedAnchor, "so there is no anchor inside an anchor for a browser to un-nest");
    ok(/^house\.html\?id=/.test(card.hitHref || ""), "the card face still opens the listing", card.hitHref);
    ok(/^p-message\.html\?to=/.test(card.reachHref || ""), "and the button opens an encrypted thread", card.reachHref);
    ok(card.hitHidden === "true" && card.hitTab === "-1",
       "the stretched link is hidden from screen readers and out of the tab order");

    // ...which is correct for a decorative overlay, and is exactly why there
    // has to be a real one as well. Until "See the rooms" was added, the ONLY
    // thing on this card a keyboard or a screen reader could reach was
    // "Message" — the card offered to write to a stranger about a room it
    // gave no way to open.
    ok(/^house\.html\?id=/.test(card.viewHref || ""),
       "a real, visible link opens the listing", card.viewHref);
    ok(card.viewTab !== "-1", "and it is in the tab order, unlike the overlay");
    ok(card.focusable.some((c) => /xp-open/.test(c)) && card.focusable.some((c) => /xp-reach/.test(c)),
       "so both destinations are reachable without a mouse",
       JSON.stringify(card.focusable));
    // A bare verb says what the tap does mechanically and nothing about what
    // is on the other side of it.
    ok(/room/i.test(card.viewText || ""),
       "and it names what is behind it rather than saying 'View'", card.viewText);

    // The failure this shape invites: an overlay that eats its own button.
    const hitTest = await p.evaluate(() => {
      const r = document.querySelector(".xp-reach").getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el ? (el.closest(".xp-reach") ? "reach" : el.className || el.tagName) : "nothing";
    });
    ok(hitTest === "reach", "a tap in the middle of the button lands on the button", String(hitTest));

    // And the reverse: the card face must not have been made inert by the row.
    const faceTest = await p.evaluate(() => {
      const c = document.querySelector(".xp-card");
      const t = c.querySelector(".xp-name").getBoundingClientRect();
      const el = document.elementFromPoint(t.left + 4, t.top + t.height / 2);
      return !!(el && el.closest(".xp-card"));
    });
    ok(faceTest, "and a tap on the title still lands inside the card");

    // A listing with nobody recorded gets no button, not a dead one.
    const noOwner = await p.evaluate(() => {
      const cards = [...document.querySelectorAll(".xp-card")];
      const hit = cards.find((c) => /Fundi number 2/.test(c.textContent));
      return hit ? !!hit.querySelector(".xp-reach") : "card not rendered";
    });
    ok(noOwner === false, "a listing with no owner recorded offers no button at all", String(noOwner));
  }

  // =========================================================================
  section("3. Asking a question collapses it back to one ranked column");
  // =========================================================================
  {
    await p.evaluate(() => {
      const q = document.getElementById("xpQ");
      q.value = "room";
      q.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await wait(900);
    const s = await shape(p);
    ok(s.groups.length === 0, "a typed query removes the sections", JSON.stringify(s.groups.length));
    ok(s.looseCards > 0, "and ranks everything into one column instead", String(s.looseCards));
    ok(s.subHidden === true, "the introduction stands down once there is a search");

    // Back to browsing.
    await p.evaluate(() => {
      const q = document.getElementById("xpQ");
      q.value = "";
      q.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await wait(900);
    const back = await shape(p);
    ok(back.groups.length === 3, "clearing it brings the sections back", String(back.groups.length));
    ok(back.subHidden === false, "and the introduction with them");
  }

  // =========================================================================
  section("4. 'See all' moves the scope chip rather than being a rival filter");
  // =========================================================================
  {
    await p.evaluate(() => {
      const b = document.querySelector('[data-seeall="room"]');
      b.click();
    });
    await wait(900);
    const after = await p.evaluate(() => ({
      activeChip: (document.querySelector(".xp-scope.active") || {}).dataset?.k,
      groups: document.querySelectorAll(".xp-group").length,
      cards: document.querySelectorAll(".xp-card").length,
      kinds: [...new Set([...document.querySelectorAll(".xp-kind")].map((n) => n.dataset.k))],
    }));
    ok(after.activeChip === "room",
       "the chip that was already on the page is the thing that moved", String(after.activeChip));
    ok(after.groups === 0, "a chosen kind is one list, not one section");
    ok(after.cards === 5, "and it shows all five rooms, which is what was offered", String(after.cards));
    ok(after.kinds.length === 1 && after.kinds[0] === "room",
       "with nothing of another kind mixed in", JSON.stringify(after.kinds));
  }

  // =========================================================================
  section("5. No errors");
  // =========================================================================
  ok(p.__errs.length === 0, "the page threw nothing", p.__errs.join(" | "));

  await ctx.close();
} finally {
  await browser.close();
}

console.log("\n" + pass + " passed, " + fails.length + " failed");
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
