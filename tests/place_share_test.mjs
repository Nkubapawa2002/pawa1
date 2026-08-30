// ============================================================================
//  tests/place_share_test.mjs
//  Giving a place to somebody, across the three pages that do it.
//
//  What is worth asserting here is not "does a map appear". It is the three
//  things that were actually broken, each of which failed silently:
//
//   1. share-location.html put TWO elements called slSend in the document once
//      a location was captured: the send panel and the "Send the link" button
//      inside it. getElementById returned the panel, so the share handler was
//      bound to the whole panel and every later tap in it — "Make a code", the
//      dropdowns, the map, "Start again" — opened the share sheet instead of
//      doing its own job. The assertion is on the ids, because that is the
//      cause; a screenshot of it looks perfect.
//
//   2. loc_share_open() answers 'forbidden' to an account it will not meter,
//      and NEITHER page had a sentence for that status, so both fell through
//      to "try again in a moment" — advice about something that could never
//      succeed. Every status the database can return must map to a sentence
//      that is true.
//
//   3. P-Message could open a code but never make one, so a place could only
//      travel to somebody already in the conversation. "Give a code" is the
//      way out of the thread, and the pin has to survive the trip.
//
//  Supabase REST is stubbed, including the CORS preflight, so nothing here
//  touches the real project and the statuses are the ones we choose to test.
//
//  Run:  node server.js   then   node tests/place_share_test.mjs
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

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

// The status loc_share_open should answer with on the next call. Set per test.
let openStatus = "ok";
// A ticket good enough for loc-code.js to finish a code from: five characters
// of the alphabet, then the signature the browser never inspects.
const TICKET = { locator: "K7M2Q", ticket: "K7M2Q.9999999999.deadbeef" };

async function open(browser, url, { reducedMotion = false } = {}) {
  // Its own context per page: LocShare keeps minted codes in localStorage and
  // PlaceBook keeps places there too, so a shared profile would leak the rows
  // of one scenario into the next.
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 390, height: 900, deviceScaleFactor: 2, isMobile: true });
  if (reducedMotion) await p.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);

  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));

  await p.setRequestInterception(true);
  p.on("request", (r) => {
    const u = r.url();
    if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: CORS, body: "" });

    const json = (body) => r.respond({
      status: 200, headers: { ...CORS, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    // Map tiles and geocoders: answered empty so a run never waits on the
    // network or trips a rate limit.
    if (/tile\.|locationiq|nominatim|openstreetmap|arcgisonline|basemaps/.test(u)) {
      return r.respond({ status: 200, headers: CORS, body: "" });
    }
    if (/\/rpc\/loc_share_ticket/.test(u)) return json([TICKET]);
    if (/\/rpc\/loc_share_create/.test(u)) {
      return json([{ expires_at: new Date(Date.now() + 7200e3).toISOString() }]);
    }
    if (/\/rpc\/loc_share_open/.test(u)) {
      return json([{ status: openStatus, cipher: null, iv: null,
                     expires_at: null, opens: 1, max_opens: 1 }]);
    }
    if (/\/rest\/v1\//.test(u)) return json([]);
    if (/\/auth\/v1\//.test(u)) return json({});
    r.continue();
  });

  await p.goto(url, { waitUntil: "networkidle2", timeout: 40000 });
  p.__errs = errs;
  return p;
}

const dupIds = (p) => p.evaluate(() => {
  const seen = {};
  document.querySelectorAll("[id]").forEach((e) => { seen[e.id] = (seen[e.id] || 0) + 1; });
  return Object.entries(seen).filter(([, n]) => n > 1).map(([id]) => id);
});

// Stand in for a GPS fix so no test ever waits on a permission prompt.
// AFTER load, deliberately: js/lib/geolocate.js defines window.pawaLocate when
// it runs, so anything installed with evaluateOnNewDocument is overwritten and
// the page quietly asks the real device for a position instead.
const fakeGps = (p) => p.evaluate(() => {
  window.pawaLocate = {
    supported: () => true,
    best: async () => ({ lat: -6.7924, lng: 39.2083, accuracy: 25 }),
    message: (e) => String((e && e.message) || e),
  };
});

const BASE = "http://localhost:8080";

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });

try {
  // =========================================================================
  section("1. share-location.html: one element, one name");
  // =========================================================================
  {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 390, height: 900, isMobile: true });
    await p.setRequestInterception(true);
    p.on("request", (r) => {
      if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: CORS, body: "" });
      if (/tile\.|locationiq|nominatim|openstreetmap/.test(r.url())) {
        return r.respond({ status: 200, headers: CORS, body: "" });
      }
      r.continue();
    });
    const errs = [];
    p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
    await p.goto(BASE + "/share-location.html", { waitUntil: "networkidle2", timeout: 40000 });

    ok((await dupIds(p)).length === 0, "the page starts with no id used twice");

    // THE BUG THIS SECTION EXISTS FOR, second half.
    //
    // "Make a code" used to be built by renderCaptured(), which runs only
    // after a GPS fix has already succeeded. Refuse the permission, open it on
    // a desktop, or let the 20-second timeout run out, and the screen never
    // mentioned a code at all: every word on it was about a link. Somebody
    // looking for where to generate one concluded the feature did not exist,
    // which is a reasonable thing to conclude from a page that never shows it.
    //
    // So both ways out are markup, present from the first paint and disabled
    // until there is a place. A control you cannot use yet still teaches you
    // the feature is there; a control that is absent teaches the opposite.
    const cold = await p.evaluate(() => {
      const seen = (id) => !!document.getElementById(id);
      const off = (id) => { const el = document.getElementById(id); return el ? el.disabled : null; };
      return {
        make: seen("slMake"), makeOff: off("slMake"),
        link: seen("slSendLink"), linkOff: off("slSendLink"),
        ttl: seen("slTtl"), opens: seen("slOpens"), coarse: seen("slCoarse"),
        text: (document.getElementById("slSend").innerText || "").toLowerCase(),
      };
    });
    ok(cold.make && cold.link,
       "both ways out are on screen before any location is captured",
       "make=" + cold.make + " link=" + cold.link);
    ok(cold.makeOff === true && cold.linkOff === true,
       "and both are disabled, because there is nothing to hand over yet",
       "make=" + cold.makeOff + " link=" + cold.linkOff);
    ok(cold.ttl && cold.opens && cold.coarse,
       "the code's own controls come with it, not after it");
    ok(/code/.test(cold.text),
       "and the send panel says the word “code” without being asked twice");

    await fakeGps(p);
    await p.click("#slBtn");
    await wait(900);

    const after = await dupIds(p);
    ok(after.length === 0,
      "and still none once a place has been captured",
      after.length ? "duplicated: " + after.join(", ") : "");

    const shape = await p.evaluate(() => ({
      panel: (document.getElementById("slSend") || {}).tagName || null,
      button: (document.getElementById("slSendLink") || {}).tagName || null,
      resultShown: !document.getElementById("slResult").hidden,
      hasMake: !!document.getElementById("slMake"),
    }));
    ok(shape.resultShown, "the captured place renders its actions");
    ok(shape.panel === "SECTION", "slSend is the panel, which is what showTab() toggles", String(shape.panel));
    ok(shape.button === "BUTTON", "and the share button answers to a name of its own", String(shape.button));
    ok(shape.hasMake, "the make-a-code box is there to be tapped");

    // The other half of the same rule: capturing a place must SWITCH THEM ON,
    // not build them, or the two halves drift apart again.
    const warm = await p.evaluate(() => ({
      makeOff: document.getElementById("slMake").disabled,
      linkOff: document.getElementById("slSendLink").disabled,
      hintGone: document.getElementById("slWaysHint").hidden,
      again: !document.getElementById("slAgain").hidden,
    }));
    ok(warm.makeOff === false && warm.linkOff === false,
       "a captured place switches both ways out on",
       "make=" + warm.makeOff + " link=" + warm.linkOff);
    ok(warm.hintGone, "and retires the line telling you to capture one first");
    ok(warm.again, "with a way back to a different spot");

    // The bug in one assertion: the share handler must belong to the button,
    // not to an ancestor every other control also sits inside.
    const leaks = await p.evaluate(() => {
      let shared = 0;
      const real = navigator.share;
      navigator.share = () => { shared++; return Promise.reject(new Error("cancelled")); };
      const realClip = navigator.clipboard && navigator.clipboard.writeText;
      try {
        Object.defineProperty(navigator, "clipboard",
          { configurable: true, value: { writeText: () => { shared++; return Promise.resolve(); } } });
      } catch (_) {}
      document.getElementById("slMake").click();      // a tap on a DIFFERENT control
      const afterMake = shared;
      navigator.share = real;
      if (realClip) { try { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: realClip } }); } catch (_) {} }
      return afterMake;
    });
    ok(leaks === 0, "tapping “Make a code” does not fire the share sheet", "share calls: " + leaks);
    ok(errs.length === 0, "the page threw nothing", errs.join(" | "));
    await ctx.close();
  }

  // =========================================================================
  section("2. Every status the database can answer with has a sentence");
  // =========================================================================
  {
    // Read the two reason maps out of the source rather than clicking through
    // eleven failures: the assertion is about coverage, and coverage is a
    // property of the map, not of any one run.
    const { readFileSync } = await import("node:fs");
    const sl = readFileSync("js/pages/share-location.js", "utf8");
    const pm = readFileSync("js/pages/p-message.js", "utf8");

    // Every status loc_share_open() can return, from the SQL.
    const statuses = ["forbidden", "not_found", "rate_limited",
                      "revoked", "expired", "used_up"];
    const slMap = sl.slice(sl.indexOf("function openReason"), sl.indexOf("function openReason") + 1400);
    const pmMap = pm.slice(pm.indexOf("function codeReason"), pm.indexOf("function codeReason") + 1600);

    const slMissing = statuses.filter((s) => {
      const key = { not_found: "not_found", used_up: "used_up" }[s] || s;
      return !new RegExp("\\b" + key + "\\s*:").test(slMap);
    });
    const pmMissing = statuses.filter((s) => !new RegExp("\\b" + s + "\\s*:").test(pmMap));

    ok(slMissing.length === 0,
      "share-location has a sentence for every open status",
      slMissing.join(", "));
    ok(pmMissing.length === 0,
      "and so does P-Message",
      pmMissing.join(", "));
    ok(/forbidden\s*:/.test(slMap) && /forbidden\s*:/.test(pmMap),
      "'forbidden' in particular, which is the one guests were getting");
    ok(!/forbidden[\s\S]{0,120}try again/i.test(slMap),
      "and it does not tell them to try again at something that cannot work");
  }

  // =========================================================================
  section("3. P-Message can give a place to somebody outside the thread");
  // =========================================================================
  {
    const { readFileSync } = await import("node:fs");
    const pm = readFileSync("js/pages/p-message.js", "utf8");
    ok(/id="pmAttachCode"/.test(pm),
      "the attachment strip offers a code as well as a send");
    ok(/function mintPlaceCode/.test(pm),
      "and there is something behind the button");
    ok(/window\.LocShare\.create\(/.test(pm),
      "which mints through js/lib/loc-share.js rather than a second engine");
    ok(!/loc_share_create|loc_share_ticket/.test(pm),
      "P-Message calls no location RPC of its own");
  }

  // =========================================================================
  section("4. P-Chat shows the codes this device gave out");
  // =========================================================================
  {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 390, height: 900, isMobile: true });
    await p.setRequestInterception(true);
    p.on("request", (r) => {
      if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: CORS, body: "" });
      if (/tile\.|locationiq|nominatim|openstreetmap/.test(r.url())) {
        return r.respond({ status: 200, headers: CORS, body: "" });
      }
      if (/\/rest\/v1\//.test(r.url())) {
        return r.respond({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: "[]" });
      }
      r.continue();
    });
    const errs = [];
    p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));

    // No codes yet.
    await p.goto(BASE + "/p-chat.html", { waitUntil: "networkidle2", timeout: 40000 });
    ok(await p.$eval("#pcCodes", (e) => e.hidden),
      "with no codes there is no section, not an empty one");

    // Two codes: one with hours left, one with minutes.
    await p.evaluate(() => {
      localStorage.setItem("loc-shares-v1", JSON.stringify([
        { code: "K7M2Q9F3T", handle: "a", revoke: "r1",
          expiresAt: new Date(Date.now() + 7200e3).toISOString(), maxOpens: 1, label: "", at: Date.now() },
        { code: "B4N8XT2WD", handle: "b", revoke: "r2",
          expiresAt: new Date(Date.now() + 900e3).toISOString(), maxOpens: 3, label: "", at: Date.now() },
      ]));
    });
    await p.reload({ waitUntil: "networkidle2", timeout: 40000 });

    const strip = await p.evaluate(() => {
      const box = document.getElementById("pcCodes");
      return {
        hidden: box.hidden,
        head: document.getElementById("pcCodesH").textContent.trim(),
        codes: [...document.querySelectorAll(".pc-code-c")].map((e) => e.textContent.trim()),
        whens: [...document.querySelectorAll(".pc-code-w")].map((e) => e.textContent.trim()),
        mono: getComputedStyle(document.querySelector(".pc-code-c")).fontFamily,
      };
    });
    ok(!strip.hidden, "two live codes bring the section back");
    ok(/2/.test(strip.head), "the heading counts them", strip.head);
    ok(strip.codes[0] === "K7M-2Q9-F3T",
      "a code is shown in threes, the way it is read out", strip.codes[0]);
    ok(/JetBrains Mono|mono/i.test(strip.mono),
      "and set in the mono face the design system reserves for codes", strip.mono);
    ok(/2/.test(strip.whens[0]) && /15/.test(strip.whens[1]),
      "each row says how long it has left", strip.whens.join(" / "));

    // An expired code is not a code.
    await p.evaluate(() => {
      localStorage.setItem("loc-shares-v1", JSON.stringify([
        { code: "K7M2Q9F3T", handle: "a", revoke: "r1",
          expiresAt: new Date(Date.now() - 60e3).toISOString(), maxOpens: 1, label: "", at: Date.now() },
      ]));
    });
    await p.reload({ waitUntil: "networkidle2", timeout: 40000 });
    ok(await p.$eval("#pcCodes", (e) => e.hidden),
      "an expired code takes the section away with it");

    ok(await p.$("a[href*='recv=1']") !== null,
      "and the receive door is one tap from this tab");
    ok(errs.length === 0, "p-chat threw nothing", errs.join(" | "));
    await ctx.close();
  }

  // =========================================================================
  section("5. The icons follow the theme");
  // =========================================================================
  {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 390, height: 900, isMobile: true });
    await p.setRequestInterception(true);
    p.on("request", (r) => {
      if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: CORS, body: "" });
      if (/\/rest\/v1\//.test(r.url())) {
        return r.respond({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: "[]" });
      }
      r.continue();
    });

    // Theme is remembered under "pawa-theme", not "theme".
    await p.evaluateOnNewDocument(() => localStorage.setItem("pawa-theme", "light"));
    await p.goto(BASE + "/p-chat.html", { waitUntil: "networkidle2", timeout: 40000 });

    const marks = await p.evaluate(() => {
      const out = [];
      document.querySelectorAll(".ha-find-ic svg [stroke]").forEach((n) => {
        out.push(n.getAttribute("stroke"));
      });
      const chip = document.querySelector(".ha-find-ic.ic-emerald");
      return { strokes: [...new Set(out)], chipColor: chip ? getComputedStyle(chip).color : null };
    });
    ok(marks.strokes.every((s) => s === "currentColor" || s === "none"),
      "no icon carries its colour as a literal any more",
      marks.strokes.join(", "));
    // On cream the emerald chip must not still be painting neon mint.
    ok(marks.chipColor && !/46,\s*230,\s*166/.test(marks.chipColor),
      "and on the light theme the mark takes a legible ink", String(marks.chipColor));
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log("\n" + pass + " passed, " + fails.length + " failed");
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
