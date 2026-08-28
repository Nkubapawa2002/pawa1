// ============================================================================
//  tests/home_bands_test.mjs
//  The three self-advancing bands on index.html (js/pages/home-bands.js).
//
//  What is actually worth asserting here is not "does it move". It is that the
//  trust strip cannot state a figure it did not count: the markup ships no
//  numbers, a stat that comes back zero is removed rather than rendered as a
//  "0", and the figures track whatever the data says. The rotation assertions
//  are about not stealing the reader: a tap pins a lens for good, and
//  prefers-reduced-motion means nothing starts at all.
//
//  Supabase REST is stubbed (including the CORS preflight) so the counts are
//  deterministic and the run never touches the real project.
//
//  Run:  node server.js   then   node tests/home_bands_test.mjs
// ============================================================================

import puppeteer from "puppeteer";

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

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

// Each page gets its OWN browser context. DataStore caches every catalogue in
// web storage, so two pages sharing a profile would share the cached rows and
// the second scenario would silently assert against the first one's data.
async function open(browser, { reducedMotion = false, trucks = TRUCKS } = {}) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 390, height: 900, deviceScaleFactor: 2, isMobile: true });
  if (reducedMotion) await p.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);

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

    if (/\/rest\/v1\/regions/.test(u))  return json(REGIONS);
    if (/\/rest\/v1\/houses/.test(u))   return json(HOUSES);
    if (/\/rest\/v1\/services/.test(u)) return json(SERVICES);
    if (/\/rest\/v1\/trucks/.test(u))   return json(trucks);
    if (/\/rest\/v1\//.test(u))         return json([]);

    if (/cdn\.jsdelivr\.net\/npm\/@supabase/.test(u)) return r.continue();
    if (/fonts\.(googleapis|gstatic)/.test(u))
      return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    if (/^http:\/\/localhost:8080\//.test(u)) return r.continue();
    return r.abort();
  });

  await p.goto("http://localhost:8080/index.html", { waitUntil: "domcontentloaded" });
  return { p, errs, ctx };
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

const readFrame = (p) => p.evaluate(() => {
  const on = document.querySelector(".ha-frame-pt.is-on");
  const copy = document.getElementById("haFrameCopy");
  return {
    lens: on ? Number(on.dataset.lens) : -1,
    selected: [...document.querySelectorAll(".ha-frame-pt")].map((b) => b.getAttribute("aria-selected")),
    copyKey: copy.dataset.i18n,
    copyText: copy.textContent.trim(),
    barHidden: document.querySelector(".ha-frame-bar").hidden,
  };
});

// ---------------------------------------------------------------------------

let browser;
try {
  browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });
} catch (e) {
  // On Windows the profile lock rewrites every launch failure as "browser is
  // already running". Retrying is the documented fix; debugging the profile is not.
  await wait(1500);
  browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });
}

// ---------------------------------------------------------------------------
section("1. The trust strip states only what it counted");

const { p, errs } = await open(browser);

const shipped = await p.evaluate(() =>
  [...document.querySelectorAll(".ha-trust .ha-stat-num")].map((n) => n.textContent.trim()).join(""));
ok(shipped === "", "the markup ships no figure at all",
   "found " + JSON.stringify(shipped));

await p.evaluate(() => document.querySelector(".ha-trust").scrollIntoView());
await wait(2600);

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

// ---------------------------------------------------------------------------
section("2. A figure it cannot claim is removed, not shown as a zero");

const { p: p2 } = await open(browser, { trucks: [] });
await p2.evaluate(() => document.querySelector(".ha-trust").scrollIntoView());
await wait(2600);
const strip2 = await readStrip(p2);
const providers2 = strip2.tiles.find((t) => t.stat === "providers");
ok(providers2.value === "1", "the provider count follows the data down",
   "got " + providers2.value);

const { p: p3 } = await open(browser, { trucks: [] });
await p3.evaluate(() => {
  // Every listing unverified: nobody is a verified provider.
  const DS = window.DataStore;
  const strip = (rows) => rows.map((r) => ({ ...r, verified: false }));
  const wrap = (fn) => async (...a) => strip(await fn.apply(DS, a));
  DS.getHouses = wrap(DS.getHouses);
  DS.getServices = wrap(DS.getServices);
  DS.getTrucks = wrap(DS.getTrucks);
  document.querySelector(".ha-trust").scrollIntoView();
});
await wait(2600);
const strip3 = await readStrip(p3);
const providers3 = strip3.tiles.find((t) => t.stat === "providers");
ok(providers3.hidden, "a zero stat is dropped from the strip entirely");
ok(strip3.tiles.filter((t) => !t.hidden).length === 2,
   "and the other two tiles carry the row on their own");
await p3.close();
await p2.close();

// ---------------------------------------------------------------------------
section("3. The Frame advances itself, and stops when told");

// A fresh page. The band rotates every six seconds, so the page used above has
// long since moved on and "it opens on the first lens" could not be read there.
const { p: pf } = await open(browser);
const f0 = await readFrame(pf);
ok(f0.lens === 0 && f0.selected[0] === "true",
   "it opens on the first lens, and says so to a screen reader");
ok(f0.copyKey === "home_frame_p1_d" && f0.copyText.length > 20,
   "the first lens brings its own line of copy");

await wait(7000);
const f1 = await readFrame(pf);
ok(f1.lens === 1, "it moves to the second lens on its own",
   "lens is " + f1.lens);
ok(f1.copyKey === "home_frame_p2_d" && f1.copyText !== f0.copyText,
   "and the copy underneath moves with it");

await pf.click('.ha-frame-pt[data-lens="3"]');
const pinnedAt = await readFrame(pf);
ok(pinnedAt.lens === 3, "tapping a lens selects it");
await wait(7000);
const stillPinned = await readFrame(pf);
ok(stillPinned.lens === 3,
   "and pins it: a chosen lens is never rotated away from",
   "moved to " + stillPinned.lens);
ok(stillPinned.barHidden, "the clock disappears once there is nothing left to time");
await pf.close();

// ---------------------------------------------------------------------------
section("4. The earn band rotates its proof line");

const { p: p4 } = await open(browser);
const proof0 = await p4.evaluate(() => document.getElementById("haEarnProof").dataset.i18n);
await wait(7000);
const proof1 = await p4.evaluate(() => document.getElementById("haEarnProof").dataset.i18n);
ok(proof0 === "home_earn_pf1", "it opens on the first proof line", "got " + proof0);
ok(proof1 === "home_earn_pf2", "and advances to the second", "got " + proof1);
// data-i18n moves with the text, so a language switch re-reads the line that
// is actually showing rather than snapping back to the first.
const proofText = await p4.evaluate(() => {
  window.applyTranslations();
  return document.getElementById("haEarnProof").textContent.trim();
});
ok(proofText === "Posted from your phone in minutes. No visit, no paperwork.",
   "and applyTranslations() re-reads the line that is showing", "got " + proofText);
await p4.close();

// ---------------------------------------------------------------------------
section("5. prefers-reduced-motion: nothing starts");

const { p: p5 } = await open(browser, { reducedMotion: true });
const r0 = await readFrame(p5);
await wait(7000);
const r1 = await readFrame(p5);
ok(r0.lens === 0 && r1.lens === 0, "the Frame stays on its first lens",
   "moved to " + r1.lens);
ok(r1.barHidden, "and the progress clock is not rendered at all");
const rProof = await p5.evaluate(() => document.getElementById("haEarnProof").dataset.i18n);
ok(rProof === "home_earn_pf1", "the earn proof line stays put too", "got " + rProof);
// Still usable: the lenses are buttons, not a carousel you can only watch.
await p5.click('.ha-frame-pt[data-lens="2"]');
const rClick = await readFrame(p5);
ok(rClick.lens === 2, "but the lenses still work when tapped");
await p5.close();

// ---------------------------------------------------------------------------
section("6. No errors");
ok(errs.length === 0, "the page threw nothing", errs.join("\n        "));

await p.close();
await browser.close();

console.log("");
fails.forEach((f) => console.log("  FAIL  " + f));
console.log("\n" + pass + " passed, " + fails.length + " failed\n");
process.exit(fails.length ? 1 : 0);
