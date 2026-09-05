// ============================================================================
//  tests/home_bands_test.mjs
//  The bands under the helper cards on index.html.
//
//  Two things are worth asserting here.
//
//  The trust strip cannot state a figure it did not count: the markup ships no
//  numbers, a stat that comes back zero is removed rather than rendered as a
//  "0", and the figures track whatever the data says.
//
//  And the page holds still. index.html used to carry two self-advancing
//  bands, the Frame and the Earn pitch, each rotating a line of copy every six
//  seconds behind a progress bar; this file used to spend three sections
//  proving they did not steal the reader. Both are plain cards now, so the
//  sections that timed them are replaced by one that checks nothing is left
//  moving, and by the area door, which is the one thing on this page that
//  still opens: it answers in place instead of costing a page load before you
//  can type a letter.
//
//  Supabase REST is stubbed (including the CORS preflight) so the counts are
//  deterministic and the run never touches the real project.
//
//  Run:  node server.js   then   node tests/home_bands_test.mjs
// ============================================================================

import puppeteer from "puppeteer";
import { readFileSync } from "node:fs";

const fails = [];
let pass = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log("  PASS  " + label); }
  else { fails.push(label + (detail ? "\n        " + detail : "")); console.log("  FAIL  " + label); }
};
const section = (s) => console.log("\n" + s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The rows the stub serves. Two distinct verified providers across three
// tables, plus one unverified row that must NOT be counted.
const HOUSES = [
  { id: "h1", title: "Room", verified: true,  owner_user_id: "user-a", region: "Dar es Salaam", created_at: new Date().toISOString() },
  { id: "h2", title: "Room", verified: false, owner_user_id: "user-c", region: "Dar es Salaam", created_at: new Date().toISOString() },
];
const SERVICES = [
  { id: "s1", title: "Fundi", category: "plumbing", verified: true, owner_user_id: "user-a" },
];
const TRUCKS = [
  { id: "t1", title: "Lori", verified: true, owner: "Mama Zawadi" },
];
// All 31 regions of the United Republic. The strip says "mainland", so it has
// to report 26 of them.
const REGIONS = [
  "Arusha", "Dar es Salaam", "Dodoma", "Geita", "Iringa", "Kagera",
  "Kaskazini Pemba", "Kaskazini Unguja", "Katavi", "Kigoma", "Kilimanjaro",
  "Kusini Pemba", "Kusini Unguja", "Lindi", "Manyara", "Mara", "Mbeya",
  "Mjini Magharibi", "Morogoro", "Mtwara", "Mwanza", "Njombe", "Pwani",
  "Rukwa", "Ruvuma", "Shinyanga", "Simiyu", "Singida", "Songwe", "Tabora",
  "Tanga",
].map((name) => ({ name }));

// Read once. See the interception below for why it is served from here.
const SUPABASE_UMD = readFileSync(
  new URL("../node_modules/@supabase/supabase-js/dist/umd/supabase.js", import.meta.url), "utf8");

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

// WCAG contrast, the same arithmetic tests/theme_light_check.mjs uses. That
// file samples `body` and cannot see a panel that is not on screen until
// somebody taps a card, which is exactly what the area panel is.
function lum(c) {
  const m = String(c).match(/\d+(\.\d+)?/g);
  if (!m) return null;
  const [r, g, b] = m.map(Number).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const L1 = lum(a), L2 = lum(b);
  if (L1 == null || L2 == null) return null;
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}

// Each case gets its OWN BROWSER, not just its own context. Two reasons.
//
// DataStore caches every catalogue in web storage, so two pages sharing a
// profile would share the cached rows and the second scenario would silently
// assert against the first one's data. A context would be enough for that.
//
// The browser is for this host. Seven contexts under one browser fails here
// every run, at a different case each time: a protocol call to the fourth or
// fifth page simply never comes back and the whole file dies mid-section with
// a Runtime.callFunctionOn timeout. Nothing about the page changes between
// cases, so the shared browser is the variable. tests/agent_profile_sheet_test.mjs
// carries the same note for the same reason.
async function launch() {
  try {
    return await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });
  } catch (_) {
    // On Windows the profile lock rewrites every launch failure as "browser is
    // already running". Retrying is the documented fix; debugging the profile is not.
    await wait(1500);
    return puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });
  }
}

async function attempt({ reducedMotion = false, trucks = TRUCKS, regions = REGIONS, theme = null } = {}) {
  const browser = await launch();
  const p = await browser.newPage();
  await p.setViewport({ width: 390, height: 900, deviceScaleFactor: 2, isMobile: true });
  if (reducedMotion) await p.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  // Seeded before a single app script runs, which is how a phone set to light
  // actually arrives: the theme is already chosen when the first rule matches.
  if (theme) await p.evaluateOnNewDocument((v) => {
    try { localStorage.setItem("pawa-theme", v); } catch (_) {}
  }, theme);

  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));

  await p.setRequestInterception(true);
  p.on("request", (r) => {
    const u = r.url();
    // The preflight has to be answered explicitly or supabase-js hangs and the
    // page never resolves its first read.
    if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: CORS, body: "" });

    const json = (body) => r.respond({
      status: 200,
      headers: { ...CORS, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (/\/rest\/v1\/regions/.test(u))  return json(regions);
    if (/\/rest\/v1\/houses/.test(u))   return json(HOUSES);
    if (/\/rest\/v1\/services/.test(u)) return json(SERVICES);
    if (/\/rest\/v1\/trucks/.test(u))   return json(trucks);
    if (/\/rest\/v1\//.test(u))         return json([]);

    // supabase-js off the DISK, not off jsDelivr. jsDelivr is not reachable
    // from this machine: letting the request out meant a 30s script timeout on
    // a bad run, which is a navigation failure, not a slow one, and it took
    // whole sections down with it. The local copy is the same major version
    // the page asks for and makes the run deterministic.
    if (/cdn\.jsdelivr\.net\/npm\/@supabase/.test(u)) {
      return r.respond({ status: 200, headers: { ...CORS, "content-type": "application/javascript" }, body: SUPABASE_UMD });
    }
    if (/fonts\.(googleapis|gstatic)/.test(u))
      return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    if (/^http:\/\/localhost:8080\//.test(u)) return r.continue();
    return r.abort();
  });

  try {
    // 90s, not the 30s default. index.html pulls ~60 subresources and every one
    // of them is answered through the interception hook above, which costs a
    // CDP round trip each. Measured on this host, DOMContentLoaded lands
    // anywhere between 4s and 25s depending on what else is running; the
    // default timeout was inside that spread, so a slow machine failed the
    // navigation outright and took whole sections with it.
    await p.goto("http://localhost:8080/index.html", { waitUntil: "domcontentloaded", timeout: 90000 });
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
  return { browser, p, errs };
}

// The same, retried. Navigation on this host drops for no reason several times
// an hour ("Navigating frame was detached", or a flat 30s timeout on a server
// that answers curl instantly), and a browser that has done it once does not
// recover: retrying the goto on the same page times out again every time. So a
// retry throws the whole browser away and starts over, which does recover.
async function open(opts) {
  let last = null;
  for (let i = 0; i < 3; i++) {
    try { return await attempt(opts); } catch (e) { last = e; }
  }
  throw new Error("could not open index.html after 3 tries: " +
                  String((last && last.message) || last).split("\n")[0]);
}

// Everything below the doors arrives from the network: the featured rail, the
// owner rail, the feed. Until they land the page is a third of its final
// height, so an element scrolled into view at that moment is somewhere else a
// second later. Every interaction here waits for the rails first, and anything
// that has to be ON SCREEN is scrolled to after that, not before.
//
// window.DataStore is waited for in the same breath. Every case below reads it
// or the figures it feeds, and `waitUntil: "domcontentloaded"` returns while
// the tail of the script list is still arriving, so a case that started
// measuring here used to die on `Cannot read properties of undefined`.
async function settle(p) {
  await p.waitForFunction(
    () => !!window.DataStore && ["haFeed", "haFeatured"].every((id) => {
      const el = document.getElementById(id);
      return !el || el.getAttribute("aria-busy") === "false";
    }),
    { timeout: 45000 },
  ).catch(() => {});
  await wait(400);
}

// scrollIntoView, then confirm it is actually in the viewport, because a rail
// finishing late can push the target straight back out of it.
//
// NOTE the strip is scrolled to by its MARKER, .ha-trust-mark, never by
// .ha-trust itself. The strip ships `hidden` and is display:none until it has
// a figure to show, and a box that is not laid out cannot be scrolled to:
// scrollIntoView does nothing and getBoundingClientRect() answers all zeros,
// which reads here as "already in view" and returns without moving the page.
// The marker is the 1px element immediately above it that is always in flow,
// and it is what home-bands.js watches for the same reason.
async function bring(p, sel) {
  for (let i = 0; i < 12; i++) {
    const top = await p.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight ? -1 : r.top;
    }, sel);
    if (top === -1 || top === null) return;
    await wait(250);
  }
}

// countUp() writes the final figure into data-shown the moment it starts and
// then animates textContent up to it, so "the strip has finished counting" is
// exactly textContent === data-shown on every tile still in the row. Reading on
// a timer instead caught the animation mid-flight once and read a 1 for a 2.
//
// The budget is 60s and the timeout is ANNOUNCED rather than swallowed. Both
// matter. The strip is painted from four DataStore reads that only start once
// the page is interactive, which on a loaded machine is 25s after navigation
// began, so 12s used to expire before the app had done anything wrong. And
// because the expiry was silent, that arrived as four separate assertion
// failures about wrong figures rather than as the one true fact: nobody had
// waited long enough. A timeout here is a fact about the host, so it says so.
async function stripSettled(p) {
  let settled = true;
  await p.waitForFunction(() => {
    const strip = document.querySelector(".ha-trust");
    if (!strip || strip.hidden) return false;
    return [...strip.querySelectorAll("[data-stat]")].every((tile) => {
      if (tile.hidden) return true;
      const num = tile.querySelector(".ha-stat-num");
      return num && num.dataset.shown && num.textContent.trim() === num.dataset.shown;
    });
  }, { timeout: 60000, polling: 200 }).catch(() => { settled = false; });
  if (!settled) console.log("  ....  the strip never settled in 60s; the figures below are mid-flight");
  return settled;
}

const readStrip = (p) => p.evaluate(() => {
  const strip = document.querySelector(".ha-trust");
  return {
    hidden: strip.hidden,
    tiles: [...strip.querySelectorAll("[data-stat]")].map((t) => ({
      stat: t.dataset.stat,
      hidden: t.hidden,
      value: t.querySelector(".ha-stat-num").textContent.trim(),
    })),
  };
});

// ---------------------------------------------------------------------------
section("1. The trust strip states only what it counted");

const { browser: b1, p, errs } = await open();

const shipped = await p.evaluate(() =>
  [...document.querySelectorAll(".ha-trust .ha-stat-num")].map((n) => n.textContent.trim()).join(""));
ok(shipped === "", "the markup ships no figure at all",
   "found " + JSON.stringify(shipped));

await settle(p);
await bring(p, ".ha-trust-mark");
await stripSettled(p);

const strip = await readStrip(p);
ok(!strip.hidden, "the strip appears once the first read lands");

const byStat = Object.fromEntries(strip.tiles.map((t) => [t.stat, t]));
ok(byStat.categories.value === "15",
   "service categories is the size of the catalogue the app ships (15)",
   "got " + byStat.categories.value);
ok(byStat.regions.value === "26",
   "mainland regions drops the five Zanzibar rows (31 -> 26)",
   "got " + byStat.regions.value);
ok(byStat.providers.value === "2",
   "verified providers counts distinct listers, once each, verified only (2)",
   "got " + byStat.providers.value);
// Closed here rather than at the end: `errs` is a plain array and outlives the
// browser that filled it, and one browser at a time is the whole point.
await b1.close();

// ---------------------------------------------------------------------------
section("2. A figure it cannot claim is removed, not shown as a zero");

const { browser: b2, p: p2 } = await open({ trucks: [] });
await settle(p2);
await bring(p2, ".ha-trust-mark");
await stripSettled(p2);
const strip2 = await readStrip(p2);
const providers2 = strip2.tiles.find((t) => t.stat === "providers");
ok(providers2.value === "1", "the provider count follows the data down",
   "got " + providers2.value);
await b2.close();

const { browser: b3, p: p3 } = await open({ trucks: [] });
await settle(p3);
await p3.evaluate(() => {
  // Every listing unverified: nobody is a verified provider.
  const DS = window.DataStore;
  const strip = (rows) => rows.map((r) => ({ ...r, verified: false }));
  const wrap = (fn) => async (...a) => strip(await fn.apply(DS, a));
  DS.getHouses = wrap(DS.getHouses);
  DS.getServices = wrap(DS.getServices);
  DS.getTrucks = wrap(DS.getTrucks);
});
await bring(p3, ".ha-trust-mark");
await stripSettled(p3);
const strip3 = await readStrip(p3);
const providers3 = strip3.tiles.find((t) => t.stat === "providers");
ok(providers3.hidden, "a zero stat is dropped from the strip entirely");
ok(strip3.tiles.filter((t) => !t.hidden).length === 2,
   "and the other two tiles carry the row on their own");
await b3.close();

// ---------------------------------------------------------------------------
section("3. Nothing on the page is moving any more");

// The rotators are gone, and the point of this section is that they cannot
// come back by accident: no tab list, no progress bar, no rotating paragraph.
// Their copy is now four named lenses sitting still on one card.
const { browser: bf, p: pf } = await open();
const leftovers = await pf.evaluate(() => ({
  lensTabs: document.querySelectorAll("[data-lens]").length,
  frameCopy: !!document.getElementById("haFrameCopy"),
  earnProof: !!document.getElementById("haEarnProof"),
  bars: document.querySelectorAll(".ha-frame-bar, .ha-earn-bar").length,
}));
ok(leftovers.lensTabs === 0 && !leftovers.frameCopy && !leftovers.earnProof,
   "no rotating band survives on the page", JSON.stringify(leftovers));
ok(leftovers.bars === 0, "and no progress clock is left to run against nothing");

const frameCard = () => pf.evaluate(() => {
  const a = document.querySelector('.ha-find-card[href="frame.html"]');
  return a ? a.querySelector(".ha-find-d").textContent.replace(/\s+/g, " ").trim() : null;
});
const earnCards = () => pf.evaluate(() =>
  [...document.querySelectorAll("#haEarn .ha-find-card")]
    .map((a) => a.querySelector(".ha-find-d").textContent.trim()));

const frame0 = await frameCard();
const earn0 = await earnCards();
const lensKeys = await pf.evaluate(() =>
  [...document.querySelectorAll('.ha-find-card[href="frame.html"] [data-i18n]')]
    .map((el) => el.dataset.i18n).filter((k) => /^home_frame_p\d$/.test(k)));
ok(lensKeys.length === 4, "the Frame card names all four lenses at once",
   "reads: " + frame0 + "  keys: " + JSON.stringify(lensKeys));
ok(earn0.length === 2 && earn0.every((s) => s.length > 10),
   "and both ways to earn are peers, each with its own line", JSON.stringify(earn0));

await wait(7000);
ok((await frameCard()) === frame0 && JSON.stringify(await earnCards()) === JSON.stringify(earn0),
   "seven seconds later every one of those lines still says the same thing");
await bf.close();

// ---------------------------------------------------------------------------
section("4. The area door answers in place");

const { browser: b4, p: p4 } = await open();
const cardSel = "a.ha-door--area";
await settle(p4);
await bring(p4, cardSel);
await p4.click(cardSel);
// Wait for the chips, not for a stopwatch. The panel deliberately paints its
// fallback line FIRST and swaps the regions in when the network answers (see
// wireArea in js/pages/home-live.js), so "700ms after the click" was reliably
// the one state this section is not about: the empty one. A fixed wait here
// asserted against the placeholder and failed three times over.
await p4.waitForFunction(
  () => document.querySelectorAll(".ha-area-chip").length > 0,
  { timeout: 45000, polling: 150 },
).catch(() => {});
await wait(250);

const opened = await p4.evaluate((sel) => {
  const card = document.querySelector(sel);
  const wrap = document.getElementById("haAreaOpen");
  return {
    url: location.pathname,
    panel: wrap.classList.contains("is-open"),
    height: wrap.getBoundingClientRect().height,
    cardOpen: card.classList.contains("is-open"),
    expanded: card.getAttribute("aria-expanded"),
    label: document.getElementById("haAreaLbl").textContent.trim(),
    labelHidden: document.getElementById("haAreaLbl").hidden,
    chips: [...document.querySelectorAll(".ha-area-chip")].map((b) => b.textContent),
  };
}, cardSel);

ok(opened.url === "/index.html", "the card does not spend a page load to ask the question",
   "went to " + opened.url);
ok(opened.panel && opened.height > 60, "the panel opens under it",
   "height " + Math.round(opened.height));
ok(opened.cardOpen && opened.expanded === "true",
   "the card squares off and says it is expanded, so the two read as one object",
   JSON.stringify({ cardOpen: opened.cardOpen, expanded: opened.expanded }));
ok(!opened.labelHidden && opened.chips.length === 8 && opened.chips[0] === "Arusha",
   "with the first regions under a heading that has something beneath it",
   JSON.stringify(opened.chips));

// Typing narrows the same list, and a place the regions table never had is
// still offered, because area.html resolves wards and villages too.
await p4.type(".ha-area-in", "dar");
await wait(400);
const typed = await p4.evaluate(() =>
  [...document.querySelectorAll(".ha-area-chip")].map((b) => b.textContent));
ok(typed.length === 1 && typed[0] === "Dar es Salaam", "typing filters the regions",
   JSON.stringify(typed));

await p4.evaluate(() => { document.querySelector(".ha-area-in").value = ""; });
await p4.type(".ha-area-in", "Mikocheni");
await wait(400);
const unlisted = await p4.evaluate(() =>
  [...document.querySelectorAll(".ha-area-chip")].map((b) => b.textContent));
ok(unlisted.length === 1 && unlisted[0] === "Mikocheni",
   "and a ward no region list carries is offered as typed", JSON.stringify(unlisted));

await Promise.all([
  p4.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}),
  p4.keyboard.press("Enter"),
]);
await wait(300);
const went = await p4.evaluate(() => location.pathname + location.search);
ok(went === "/area.html?q=Mikocheni", "enter carries it to area.html", "went to " + went);
await b4.close();

// ---------------------------------------------------------------------------
section("5. A region list that fails leaves no bare heading");

const { browser: b5, p: p5 } = await open({ regions: [] });
await settle(p5);
await bring(p5, "a.ha-door--area");
await p5.click("a.ha-door--area");
await wait(900);
const empty = await p5.evaluate(() => ({
  labelHidden: document.getElementById("haAreaLbl").hidden,
  chips: document.querySelectorAll(".ha-area-chip").length,
  note: (document.querySelector(".ha-area-note") || {}).textContent || "",
  field: !!document.querySelector(".ha-area-in"),
}));
ok(empty.labelHidden && empty.chips === 0,
   "the heading goes with the chips it had nothing to head");
ok(empty.note.length > 5, "a line says what to do instead", JSON.stringify(empty.note));
ok(empty.field, "and the field, which works on its own, is still there");
await b5.close();

// ---------------------------------------------------------------------------
section("6. prefers-reduced-motion: the cards arrive already shown");

// reveal() marks everything shown outright under reduced motion. If it ever
// stopped doing that, .will-reveal would leave every card on the page at
// opacity 0 with no observer coming to fix it.
const { browser: b6, p: p6 } = await open({ reducedMotion: true });
// The cards are static markup, but the class that un-hides them is applied by
// home-live.js on DOMContentLoaded, which is where the script list is still
// arriving. Wait for the row rather than for a stopwatch.
await p6.waitForFunction(
  () => document.querySelectorAll(".ha-find-card").length >= 5,
  { timeout: 45000, polling: 150 },
).catch(() => {});
await wait(600);
const shownState = await p6.evaluate(() => {
  const cards = [...document.querySelectorAll(".ha-find-card")];
  return {
    count: cards.length,
    shown: cards.filter((c) => c.classList.contains("is-shown")).length,
    faded: cards.filter((c) => Number(getComputedStyle(c).opacity) < 0.9).length,
  };
});
ok(shownState.count >= 5, "the page still has its card row", JSON.stringify(shownState));
ok(shownState.shown === shownState.count && shownState.faded === 0,
   "every card is visible, none waiting on an animation that never runs",
   JSON.stringify(shownState));
await b6.close();

// ---------------------------------------------------------------------------
section("7. The area panel is readable on a light phone");

// The panel is drawn to look like a continuation of the card above it, so in
// light mode it has to be white with dark ink rather than the dark card's own
// paint. Nothing else can catch this: theme_light_check.mjs samples `body`,
// and the panel does not exist on screen until somebody taps the door.
const { browser: b7, p: p7 } = await open({ theme: "light" });
await settle(p7);
await bring(p7, "a.ha-door--area");
await p7.click("a.ha-door--area");
// A chip has to exist before its colour can be read: this section measures one
// against the panel behind it, and on a slow host 900ms of stopwatch handed
// back the placeholder, a null chip, and a contrast ratio computed from it.
await p7.waitForFunction(
  () => document.querySelectorAll(".ha-area-chip").length > 0,
  { timeout: 45000, polling: 150 },
).catch(() => {});
await wait(250);
const light = await p7.evaluate(() => {
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const box = cs(document.querySelector(".ha-area-box"));
  const lbl = cs(document.getElementById("haAreaLbl"));
  const chip = cs(document.querySelector(".ha-area-chip"));
  const input = cs(document.querySelector(".ha-area-in"));
  return {
    theme: document.documentElement.getAttribute("data-theme"),
    boxBg: box && box.backgroundColor,
    lblColor: lbl && lbl.color,
    chipColor: chip && chip.color,
    chipBg: chip && chip.backgroundColor,
    inputColor: input && input.color,
    inputBg: input && input.backgroundColor,
  };
});
ok(light.theme === "light", "the page is in light mode", "theme=" + light.theme);
const r = (fg, bg) => ratio(fg, bg);
ok(r(light.lblColor, light.boxBg) >= 4.5,
   "the panel heading reads against the panel",
   JSON.stringify({ fg: light.lblColor, bg: light.boxBg, ratio: r(light.lblColor, light.boxBg) }));
ok(r(light.chipColor, light.boxBg) >= 4.5,
   "so does a region chip",
   JSON.stringify({ fg: light.chipColor, bg: light.boxBg, ratio: r(light.chipColor, light.boxBg) }));
ok(r(light.inputColor, light.inputBg) >= 4.5,
   "and what you type into the field",
   JSON.stringify({ fg: light.inputColor, bg: light.inputBg, ratio: r(light.inputColor, light.inputBg) }));
await b7.close();

// ---------------------------------------------------------------------------
section("8. No errors");
ok(errs.length === 0, "the page threw nothing", errs.join("\n        "));

console.log("");
fails.forEach((f) => console.log("  FAIL  " + f));
console.log("\n" + pass + " passed, " + fails.length + " failed\n");
process.exit(fails.length ? 1 : 0);
