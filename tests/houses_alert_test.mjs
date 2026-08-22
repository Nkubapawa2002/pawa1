// ============================================================================
// houses_alert_test.mjs — the "Set up an area alert" sheet on houses.html.
//
// Everything here is a regression. Each section pins one thing that was broken
// on a real phone and looked perfectly fine in a desktop browser:
//
//   1. The sheet was painted UNDER the bottom tab bar, so a tap on "Save
//      alert" hit a nav link and left the page. z-index 2000 could never have
//      fixed it — the number was in the wrong contest.
//   2. Two date inputs refused to shrink below their own "mm/dd/yyyy", held
//      the two grid columns open at 366px inside a 335px sheet, and the whole
//      body scrolled sideways with the right column cut off.
//   3. Half the form rendered as white boxes on the dark sheet, because
//      premium.css and neon-pro.css both force a background with !important
//      and which one won depended on whether the selector named an input TYPE.
//   4. The map took 408 of the 601px body: you set a radius you could not see.
//   5. A misspelt place name dead-ended on "No matches in Tanzania" — the
//      wrong answer on a screen whose entire purpose is to pick somewhere.
//   6. …and the fix for 5 lives in a SHARED library, so it also reached four
//      callers that act on hits[0] with nobody watching. A spelling guess is
//      offered to a person; it is never acted on behind their back.
//
// WHAT THIS DOES NOT COVER, AND WHY.
// Leaflet is a CDN <script> and cdn.jsdelivr.net is unreachable from this
// machine, so no map is ever built here — the sheet takes its own documented
// "map library didn't load" path instead. That is enough for every claim above
// (all of them are CSS, DOM or plain JS), but it means the map's OWN new
// behaviour — the Tanzania bounds, minZoom 5, the Sat/Map segment, the "All
// Tanzania" button — is asserted here only as far as the markup and the
// strings go. Those need a machine that can fetch Leaflet.
//
// Supabase, Nominatim, the tile servers and the CDN scripts are all stubbed.
// Nominatim is stubbed EMPTY on purpose: that is the path section 5 is about.
//
//   usage:  node server.js   then:  node tests/houses_alert_test.mjs
// ============================================================================
import puppeteer from "puppeteer";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:8080";
const W = 375, H = 812;          // a phone, because every bug above needed one

let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); }
  else { fail++; process.stdout.write(`  FAIL  ${m}\n${extra ? "        " + extra + "\n" : ""}`); }
};
const section = (s) => process.stdout.write(`\n${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
};

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  protocolTimeout: 120000,
});
const errs = [];

const page = await browser.newPage();
await page.setViewport({ width: W, height: H, isMobile: true, hasTouch: true });
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });

await page.setRequestInterception(true);
page.on("request", (req) => {
  const u = req.url();
  if (req.method() === "OPTIONS") return req.respond({ status: 204, headers: CORS, body: "" });
  // locationiq is the geocoder geo.js actually calls; nominatim is kept because
  // a couple of older code paths still name it. Missing the first one means the
  // "empty" below never happened — the query went to the live shared quota
  // instead, and section 6 passed for the wrong reason on a good day.
  if (u.includes("supabase.co") || u.includes("locationiq") || u.includes("nominatim")) {
    return req.respond({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: "[]" });
  }
  // Answered empty rather than left to hang. Every one of these is a host this
  // machine cannot reach, and a pending <script> in <body> holds up
  // DOMContentLoaded forever — the navigation times out and the run dies
  // before it has looked at anything.
  if (/cdn\.jsdelivr\.net|unpkg\.com|fonts\.googleapis|fonts\.gstatic/.test(u)) {
    const css = /\.css|fonts\.googleapis/.test(u);
    return req.respond({ status: 200,
      headers: { "content-type": css ? "text/css" : "application/javascript" }, body: "" });
  }
  req.continue();
});

// Loaded once plain, only to read where the sheet lives in the markup before
// anything moves it.
await page.goto(`${BASE}/houses.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForSelector("#alertModalBackdrop", { timeout: 20000 });
const homeParent = await page.$eval("#alertModalBackdrop",
  (n) => n.parentElement.id || n.parentElement.tagName);

// Opened by the deep link rather than by tapping the toolbar button. The
// button binds its listener inside setupGeoAlerts(), well after it appears in
// the DOM, so a click sent on sight lands on nothing — and reaching it on a
// phone viewport means scrolling a toolbar this test is not about. `?alert=1`
// is the page's own documented entry point and opens on the same next tick.
await page.goto(`${BASE}/houses.html?alert=1`, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => {
  const b = document.getElementById("alertModalBackdrop");
  return b && !b.hidden;
}, { timeout: 20000 });
// initAlertMap retries for ~6s before it gives up on Leaflet. Wait it out, so
// the layout being measured is the one that settles, not one mid-retry.
await sleep(7500);

// ---------------------------------------------------------------------------
section("1. The sheet is in front of the page, not inside it");
{
  const where = await page.$eval("#alertModalBackdrop", (n) => n.parentElement.tagName);
  ok(where === "BODY",
     "while it is open the sheet is a child of <body>", "parent=" + where);

  // The bug, exactly: z-index 2000 inside main#housesMain (z-index 1) never
  // competed with the tab bar (z-index 900, a body child) — main did, at 1. So
  // ask the only question that matters: at the centre of the Save button, what
  // would a thumb actually hit?
  const hit = await page.evaluate(() => {
    const save = document.getElementById("alertSaveBtn");
    if (!save) return null;
    const r = save.getBoundingClientRect();
    const el = document.elementFromPoint(
      Math.round(r.left + r.width / 2),
      Math.round(Math.min(r.top + r.height / 2, window.innerHeight - 1)));
    const sheet = document.getElementById("alertModalBackdrop");
    return {
      isSave: !!(el && (el === save || save.contains(el))),
      inSheet: !!(el && sheet.contains(el)),
      what: el ? String(el.id || el.className || el.tagName).slice(0, 60) : null,
      bottomOverflow: Math.round(r.bottom) - window.innerHeight,
      height: Math.round(r.height),
    };
  });
  ok(hit && hit.isSave, "a tap at Save's centre lands on Save", hit && hit.what);
  ok(hit && hit.inSheet, "and not on anything belonging to the page behind it", hit && hit.what);
  ok(hit && hit.bottomOverflow <= 0,
     "Save is inside the viewport, not under the home indicator", hit && String(hit.bottomOverflow));
  ok(hit && hit.height >= 34, "and is a real target, not a sliver", hit && String(hit.height));
}

// ---------------------------------------------------------------------------
section("2. Nothing in the sheet scrolls sideways");
{
  const box = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const body = q("#alertModalBackdrop .am-body");
    const grid = q("#alertModalBackdrop .am-filter-grid");
    const bodyRight = body.getBoundingClientRect().right;
    const over = [...document.querySelectorAll("#alertModalBackdrop .am-filter-grid > label")]
      .map((l) => {
        const i = l.querySelector("select,input");
        return {
          txt: l.textContent.trim().split("\n")[0].slice(0, 14),
          past: i ? Math.round(i.getBoundingClientRect().right - bodyRight) : 0,
        };
      })
      .filter((x) => x.past > 1);
    return {
      bodyOver: body.scrollWidth - body.clientWidth,
      gridOver: grid.scrollWidth - grid.clientWidth,
      docOver: document.documentElement.scrollWidth - window.innerWidth,
      over,
    };
  });
  ok(box.bodyOver <= 1, "the sheet body has nothing to scroll to sideways", "overflow " + box.bodyOver + "px");
  ok(box.gridOver <= 1, "and neither does the filter grid", "overflow " + box.gridOver + "px");
  ok(box.docOver <= 1, "nor the page underneath it", "overflow " + box.docOver + "px");
  // The specific failure: min-width:auto on a grid item, held open by a date
  // input's "mm/dd/yyyy" plus premium.css's forced 14px of side padding.
  ok(box.over.length === 0,
     "every control stays inside the sheet's right edge", JSON.stringify(box.over));
}

// ---------------------------------------------------------------------------
section("3. One palette for every control in the sheet");
{
  const controls = await page.evaluate(() => {
    const parse = (c) => {
      const m = String(c).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(",").map((n) => parseFloat(n));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    // What the eye sees, not what the declaration says. These backgrounds are
    // white at 5% ALPHA over a dark sheet — a plain luminance of the declared
    // colour reads that as pure white and calls the fix a failure.
    const behind = (el) => {
      let n = el.parentElement;
      while (n) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a === 1) return c;
        n = n.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const lum = (el) => {
      const fg = parse(getComputedStyle(el).backgroundColor);
      if (!fg) return null;
      const bg = behind(el);
      const mix = (f, b) => fg.a * f + (1 - fg.a) * b;
      return (0.2126 * mix(fg.r, bg.r) + 0.7152 * mix(fg.g, bg.g) + 0.0722 * mix(fg.b, bg.b)) / 255;
    };
    return [...document.querySelectorAll(
      "#alertModalBackdrop input, #alertModalBackdrop select, #alertModalBackdrop textarea")]
      .filter((el) => el.type !== "range" && el.offsetParent !== null)
      .map((el) => {
        const cs = getComputedStyle(el);
        return { id: el.id || el.tagName, type: el.type || "",
                 bg: cs.backgroundColor, lum: lum(el) };
      });
  });
  ok(controls.length >= 6, "the form has controls to check", String(controls.length));

  // Both halves were wrong on a dark sheet, but the SPLIT is the signature —
  // so assert it directly, not only the colour.
  const light = controls.filter((c) => c.lum !== null && c.lum > 0.5);
  ok(light.length === 0,
     "no control is painted white on the dark sheet",
     JSON.stringify(light.map((c) => c.id + "=" + c.bg + " lum=" + c.lum.toFixed(2))));
  const shades = new Set(controls.map((c) => c.bg));
  ok(shades.size === 1,
     "and they all share one background, rather than splitting by input type",
     JSON.stringify([...shades]));

  // The range slider is not a box; the rule above would draw a grey plate
  // behind its track.
  const slider = await page.evaluate(() => {
    const el = document.getElementById("alertRadius");
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, border: cs.borderTopWidth };
  });
  ok(/rgba\(0, 0, 0, 0\)|transparent/.test(slider.bg) && slider.border === "0px",
     "and the radius slider is left alone", JSON.stringify(slider));
}

// ---------------------------------------------------------------------------
section("4. The map leaves room for what is under it");
{
  const geom = await page.evaluate(() => {
    const R = (s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
    };
    return { map: R("#alertModalMap"), body: R("#alertModalBackdrop .am-body"),
             status: R("#alertModalBackdrop .am-status"), foot: R("#alertModalBackdrop .am-foot"),
             vh: window.innerHeight };
  });
  ok(geom.map.h >= 200, "the map is still big enough to judge an area by", geom.map.h + "px");
  ok(geom.map.h <= Math.round(geom.vh * 0.42),
     "but no longer eats the sheet it lives in", geom.map.h + "px of " + geom.vh);
  // The point of shrinking it: the controls that depend on the pin are visible
  // at the same time as the pin.
  ok(geom.status && geom.status.bottom <= geom.body.bottom,
     "the pin readout is on screen with the map, not a scroll away",
     JSON.stringify(geom.status));
  ok(geom.foot.bottom <= geom.vh, "and the footer is on screen too", JSON.stringify(geom.foot));
}

// ---------------------------------------------------------------------------
section("5. The sheet carries its own map tools, in both languages");
{
  // Leaflet's switcher is a 70x135 white panel in the top-right corner of a map
  // this small — i.e. on top of the place you were trying to tap. The markup
  // replaces it. Whether the segment WORKS needs a machine that can fetch
  // Leaflet; that it exists, is labelled and is translated is checkable here,
  // and the strings were the part actually missing.
  const tools = await page.evaluate(() => {
    const seg = document.getElementById("alertBaseSeg");
    const btns = [...document.querySelectorAll("#alertBaseSeg button[data-base]")];
    const out = document.getElementById("alertZoomOutAll");
    return {
      seg: !!seg, bases: btns.map((b) => b.dataset.base),
      pressed: btns.map((b) => b.getAttribute("aria-pressed")),
      segLabelKey: seg && seg.getAttribute("data-i18n-aria-label"),
      keys: btns.map((b) => b.getAttribute("data-i18n")),
      outKeys: out ? [out.getAttribute("data-i18n-title"),
                      out.querySelector("[data-i18n]").getAttribute("data-i18n")] : null,
      leafletPanel: !!document.querySelector("#alertModalMap .leaflet-control-layers"),
    };
  });
  ok(tools.seg && JSON.stringify(tools.bases) === JSON.stringify(["sat", "map"]),
     "a two-button Sat/Map segment is in the sheet", JSON.stringify(tools.bases));
  ok(JSON.stringify(tools.pressed) === JSON.stringify(["true", "false"]),
     "opening on satellite, and saying so to a screen reader", JSON.stringify(tools.pressed));
  ok(!!tools.outKeys, "with a one-tap way back out to the whole country");
  ok(!tools.leafletPanel, "and Leaflet's own layer panel is not on this map");

  // The gap this run closed: five keys were being used by the markup and were
  // in neither dictionary, so both languages showed the raw English fallback.
  const wanted = ["hal_base_label", "hal_base_sat", "hal_base_map",
                  "hal_zoom_out_all", "hal_whole_country"];
  const dict = await page.evaluate((keys) => {
    const miss = { en: [], sw: [] };
    for (const k of keys) {
      if (!window.I18N.en[k]) miss.en.push(k);
      if (!window.I18N.sw[k]) miss.sw.push(k);
    }
    return { miss, sameAsEnglish: keys.filter((k) => window.I18N.en[k] === window.I18N.sw[k]) };
  }, wanted);
  ok(dict.miss.en.length === 0, "every map-tool string has an English entry", JSON.stringify(dict.miss.en));
  ok(dict.miss.sw.length === 0, "and a Swahili one", JSON.stringify(dict.miss.sw));
  // "Ramani" and "Map" are different words; a key that is identical in both
  // dictionaries is usually one that was copied rather than translated.
  ok(dict.sameAsEnglish.length === 0,
     "and the Swahili is Swahili, not a copy of the English", JSON.stringify(dict.sameAsEnglish));
}

// ---------------------------------------------------------------------------
section("6. A search that finds nothing still offers somewhere to go");
{
  // The gazetteer's own answer first. resolveTzPlace only replies when a token
  // actually APPEARS in the query, so one wrong letter answered nothing at all
  // — which is how the dead end happened.
  const fuzzy = await page.evaluate(() => ({
    exactMiss: !!window.resolveTzPlace("Mikoceni"),
    near: (window.closestTzPlaces("Mikoceni", 5) || []).map((p) => p.name),
    ranked: (window.closestTzPlaces("Mikoceni", 5) || []).map((p) => p.score),
    junk: (window.closestTzPlaces("zqxjkvwp", 5) || []).length,
    tooShort: (window.closestTzPlaces("mi", 5) || []).length,
  }));
  ok(!fuzzy.exactMiss, "a misspelling gets nothing from the exact matcher");
  ok(/Mikocheni/i.test(fuzzy.near[0] || ""), "but the nearest place is offered", JSON.stringify(fuzzy.near));
  ok(fuzzy.ranked.length > 0 && fuzzy.ranked.every((s, i) => i === 0 || s <= fuzzy.ranked[i - 1]),
     "best first", JSON.stringify(fuzzy.ranked));
  // A "did you mean" that means anything has to be able to say "no".
  ok(fuzzy.junk === 0, "nonsense still matches nothing", String(fuzzy.junk));
  ok(fuzzy.tooShort === 0, "and two letters is not a query", String(fuzzy.tooShort));

  // Now the same thing through the sheet, with the geocoder answering empty.
  await page.click("#alertSearchInput");
  await page.type("#alertSearchInput", "Mikoceni", { delay: 20 });
  await page.waitForFunction(
    () => {
      const el = document.getElementById("alertSearchResults");
      return el && !el.hidden && !/Searching/.test(el.textContent);
    }, { timeout: 25000 });
  const res = await page.evaluate(() => {
    const el = document.getElementById("alertSearchResults");
    return { text: el.textContent.replace(/\s+/g, " ").trim().slice(0, 220),
             note: (el.querySelector(".am-search-note") || {}).textContent || "",
             hits: el.querySelectorAll(".am-search-result[data-i]").length };
  });
  ok(res.hits > 0, "the sheet offers places for a query with no exact match", res.text);
  ok(/closest places/i.test(res.note),
     "saying they are the closest, not pretending they are what was asked for", res.note);
  ok(!/No matches in Tanzania/i.test(res.text), "and never dead-ends", res.text);
  ok(/Mikocheni/i.test(res.text), "with the place actually meant among them", res.text);
}

// ---------------------------------------------------------------------------
section("7. Closing puts the sheet back where it came from");
{
  await page.click("#alertCancelBtn");
  await sleep(600);
  const closed = await page.evaluate(() => {
    const b = document.getElementById("alertModalBackdrop");
    return { hidden: !!b.hidden, parent: b.parentElement.id || b.parentElement.tagName,
             bodyOverflow: document.body.style.overflow };
  });
  ok(closed.hidden, "the sheet is hidden");
  ok(closed.parent === homeParent,
     "and back in the markup it came from, so re-opening finds it there",
     closed.parent + " (was " + homeParent + ")");
  ok(closed.bodyOverflow !== "hidden", "the page can scroll again", closed.bodyOverflow);

  // Re-open: a save-and-restore usually breaks on the second run.
  await page.evaluate(() => document.getElementById("houseAlertBtn").click());
  await page.waitForFunction(() => {
    const b = document.getElementById("alertModalBackdrop");
    return b && !b.hidden;
  }, { timeout: 20000 });
  await sleep(900);
  const again = await page.evaluate(() => {
    const save = document.getElementById("alertSaveBtn");
    const r = save.getBoundingClientRect();
    const el = document.elementFromPoint(
      Math.round(r.left + r.width / 2),
      Math.round(Math.min(r.top + r.height / 2, window.innerHeight - 1)));
    return { parent: document.getElementById("alertModalBackdrop").parentElement.tagName,
             isSave: !!(el && (el === save || save.contains(el))) };
  });
  ok(again.parent === "BODY" && again.isSave,
     "and it opens in front a second time", JSON.stringify(again));
}

// ---------------------------------------------------------------------------
section("8. A spelling guess is offered, never acted on");
{
  // pawaGeo.suggest() is shared by a dozen screens. Most hand their list to a
  // person who taps one; four act on hits[0] alone. Those four must be able to
  // tell a guess from an answer, so every gazetteer fallback hit carries the
  // flag that lets them.
  const flagged = await page.evaluate(async () => {
    const hits = await window.pawaGeo.suggest("Mikoceni", { limit: 5 });
    return { n: hits.length,
             allFuzzy: hits.every((h) => h.fuzzy === true),
             allApprox: hits.every((h) => h.approx === true),
             tagged: hits.every((h) => /closest/i.test(h.tag || "")) };
  });
  ok(flagged.n > 0, "the geocoder falls back to the gazetteer", String(flagged.n));
  ok(flagged.allFuzzy, "and marks every guess `fuzzy`, so a caller can refuse it");
  ok(flagged.allApprox, "and `approx`, so a caller that shows it can caption it");
  ok(flagged.tagged, "with a tag a person can read");

  // The four callers, checked in their source: each acts on the top hit with
  // no confirmation, so each has to drop the guesses first. Read rather than
  // driven because three of the four are on other pages, and the claim is
  // about the line of code, not about the page around it.
  const CALLERS = [
    ["js/pages/houses.js",  "geocodeAreaFilter — a circle that silently filters the list"],
    ["js/pages/near-me.js", "near-me — the anchor the whole page is measured from"],
    ["js/pages/frame.js",   "frame — setCenter() moves the map with no prompt"],
    ["js/lib/ai.js",        "AI locate() — an answer with a place name attached"],
  ];
  for (const [file, what] of CALLERS) {
    const src = readFileSync(new URL("../" + file, import.meta.url), "utf8");
    // The call and its guard, within a few lines of each other.
    const near = /suggest\([\s\S]{0,600}?!\w+\.fuzzy/.test(src);
    ok(near, `${what} drops the guesses`, file);
  }
}

// A page error is a page error — except for the three libraries this machine
// cannot download. Those are named, so a real one can never hide behind them.
const CDN_ABSENT = /\bL is not defined\b|maplibregl is not defined|supabase is not defined|Failed to load resource/i;
const real = errs.filter((e) => !CDN_ABSENT.test(e));
ok(real.length === 0, "no page errors anywhere in the run", real.slice(0, 4).join("\n        "));

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (errs.length !== real.length) {
  process.stdout.write(
    `(${errs.length - real.length} error(s) ignored: Leaflet / MapLibre / supabase-js are CDN scripts\n` +
    ` this machine cannot reach, so the map itself is not exercised here.)\n`);
}
await browser.close();
process.exit(fail === 0 ? 0 : 1);
