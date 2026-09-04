// Light-theme smoke check: loads key pages with localStorage pawa-theme=light,
// verifies the theme actually flips (light body bg, dark body text, toggle
// present) and the bottom-most text contrast is readable. Screenshots saved.
// Run: node tests/theme_light_check.mjs   (server must be on :8080)
//
// This check used to fail at random, and it failed for three reasons that had
// nothing to do with the theme:
//
//   1. it waited for `networkidle2` on pages that talk to Supabase, jsDelivr,
//      a tile server and a geocoder. The network on these pages never goes
//      quiet, so the wait was really a race against the 30 s default timeout
//   2. it then slept a flat 600 ms and hoped the theme had been applied
//   3. a page that timed out threw out of the loop, so one slow load killed
//      the whole run, left the remaining pages unreported, and never closed
//      the browser
//
// All three are addressed below: every off-localhost request is answered from
// this file, the wait is for the condition under test rather than a clock, and
// a page that fails is one FAIL line instead of a dead run.
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
// agent.html and p-message.html define their own palette ON THE BODY, which
// beats theme-light.css on :root — the trap that has already shipped an
// unreadable light screen once (dark-theme ink on a cream ground). They are on
// this list because that mistake is invisible until somebody with a light
// phone opens the page.
// frame.html earns its place for the same reason: it carries a whole dark
// palette on body[data-page="frame"], and its two primary controls are painted
// by premium.css and neon-pro.css with !important, one of which only misbehaves
// in light mode. That is invisible until somebody with a light phone opens it.
const PAGES = process.argv[2]
  ? [process.argv[2]]
  : ["index.html", "houses.html", "login.html", "services.html", "chat.html",
     "p-message.html", "frame.html", "agent.html?u=nobody",
     // The three "earn with us" portals. Their dark palette used to be pasted
     // into each page unguarded, so in light mode the auth card kept its dark
     // glass while the page around it went cream. css/agent-portal.css puts
     // that block behind :root:not([data-theme="light"]); these rows are what
     // stops it drifting back. agent-trucks.html is here because it was the
     // last page still redefining the palette on body[data-page], which beats
     // css/theme-light.css on :root and left the whole screen dark.
     "agent-houses.html", "agent-services.html", "agent-trucks.html",
     // The two public detail sheets, for the body ground. What actually broke
     // on them was element-level: a dark re-skin repainted the badge text and
     // the gallery placeholder without guarding either, so in light mode the
     // badges went white on white. This file samples the body and would not
     // have seen it; tests/detail_sheet_i18n_test.mjs does, on a rendered
     // sheet, and is where that assertion lives.
     "service.html", "truck.html"];

// Only ever reached when something is genuinely wrong: the pass path resolves
// as soon as the attribute lands, typically in tens of milliseconds.
const THEME_TIMEOUT_MS = 15000;
const MIN_CONTRAST = 4.5;

function lum(c) {
  const m = c.match(/\d+(\.\d+)?/g);
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
  const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------- the network
// None of this is under test, and every one of them is a load-time dependency
// that can hang. A script tag left unanswered holds up the load event until the
// navigation times out and the page never renders at all, so the map bundles
// and the Supabase client are answered rather than blocked.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

// Enough of a Supabase client to get through page init and draw the shell.
// Every query resolves empty, which is the logged-out, nothing-found state this
// check has always run in.
const SUPABASE_STUB = `(function () {
  function builder() {
    var b = {};
    ["select", "eq", "neq", "gt", "gte", "lt", "lte", "in", "is", "or", "filter",
     "order", "limit", "range", "match"].forEach(function (m) {
      b[m] = function () { return b; };
    });
    b.then = function (res, rej) {
      return Promise.resolve({ data: [], error: null }).then(res, rej);
    };
    return b;
  }
  var noSession = function () { return Promise.resolve({ data: { session: null, user: null }, error: null }); };
  window.supabase = {
    createClient: function () {
      return {
        from: builder,
        rpc: function () { return Promise.resolve({ data: null, error: null }); },
        auth: {
          getSession: noSession, getUser: noSession,
          signInWithPassword: noSession, signUp: noSession,
          signOut: function () { return Promise.resolve({ error: null }); },
          onAuthStateChange: function () {
            return { data: { subscription: { unsubscribe: function () {} } } };
          },
        },
        storage: { from: function () { return {
          getPublicUrl: function () { return { data: { publicUrl: "" } }; },
        }; } },
        channel: function () {
          return { on: function () { return this; }, subscribe: function () { return this; } };
        },
        removeChannel: function () {},
      };
    },
  };
})();`;

// MapLibre and Leaflet swallow whatever the page calls on them. A bare
// `undefined` would surface as a pageerror; this also coerces like a number,
// because the pages do arithmetic on getZoom() and friends.
const chainStub = (globalName) => `(function () {
  function chain() {
    return new Proxy(function () {}, {
      get: function (t, k) {
        if (k === "then") return undefined;
        if (k === Symbol.toPrimitive) return function (hint) { return hint === "string" ? "" : 0; };
        if (k === "valueOf") return function () { return 0; };
        if (k === "toString") return function () { return ""; };
        if (k === Symbol.iterator) return function () { return [][Symbol.iterator](); };
        return chain();
      },
      set: function () { return true; },
      apply: function () { return chain(); },
      construct: function () { return chain(); },
    });
  }
  window.${globalName} = chain();
})();`;

async function stubNetwork(page) {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "*",
      }});
    }
    // Anything the dev server serves is the thing under test.
    if (url.startsWith(BASE)) return req.continue();

    if (/cdn\.jsdelivr\.net.*supabase/.test(url)) {
      return req.respond({
        status: 200,
        headers: { "content-type": "application/javascript" },
        body: SUPABASE_STUB,
      });
    }
    // Stylesheets, the webfonts included. They change the type, never the
    // colours this file measures.
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url) ||
        /cdn\.jsdelivr\.net.*(maplibre|leaflet).*\.css/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    if (/cdn\.jsdelivr\.net.*(maplibre|leaflet)/.test(url)) {
      return req.respond({
        status: 200,
        headers: { "content-type": "application/javascript" },
        body: chainStub(/leaflet/.test(url) ? "L" : "maplibregl"),
      });
    }
    if (/arcgisonline|basemaps\.cartocdn|api\.mapbox|tile\.openstreetmap|unsplash|supabase\.co\/storage/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
    }
    if (/supabase\.co|locationiq|router\.project-osrm|nominatim|overpass/.test(url)) {
      return req.respond({
        status: 200,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: "[]",
      });
    }
    // Some other host nobody has accounted for. Refuse it rather than let it
    // hang: an unanswered request is the failure this whole block exists to
    // remove, and a refused one is visible in the page's own error handling.
    return req.abort();
  });
}

// ------------------------------------------------------------------ the check
async function measure(page, path) {
  await page.setViewport({ width: 390, height: 844 });
  await stubNetwork(page);
  // Seed the theme choice before any app script runs.
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem("pawa-theme", "light"); } catch (_) {}
  });
  // domcontentloaded, not networkidle2: these pages keep talking long after
  // they are readable, and the theme is applied from localStorage well before
  // any of that settles.
  await page.goto(`${BASE}/${path}`, { waitUntil: "domcontentloaded" });
  // Wait for what is being tested rather than for a fixed number of
  // milliseconds. If it never arrives, that IS the failure, and it is reported
  // against this page rather than ending the run.
  await page.waitForFunction(
    () => !!document.body &&
          !!document.documentElement.getAttribute("data-theme") &&
          !!document.getElementById("pawa-theme-toggle"),
    { timeout: THEME_TIMEOUT_MS });

  return page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      bodyBg: cs.backgroundColor,
      bodyColor: cs.color,
      hasToggle: !!document.getElementById("pawa-theme-toggle"),
    };
  });
}

const browser = await puppeteer.launch({ headless: "new" });
let fail = 0;

try {
  for (const path of PAGES) {
    const page = await browser.newPage();
    let info = null, why = null;
    try {
      info = await measure(page, path);
    } catch (e) {
      why = String(e && e.message ? e.message : e).split("\n")[0];
    }

    if (!info) {
      fail++;
      console.log(`FAIL  ${path.padEnd(14)} no theme within ` +
                  `${THEME_TIMEOUT_MS / 1000}s — ${why}`);
    } else {
      const cr = ratio(info.bodyColor, "rgb(250,249,245)");
      const bgL = lum(info.bodyBg);
      const ok = info.theme === "light" && info.hasToggle && cr && cr >= MIN_CONTRAST;
      if (!ok) fail++;
      console.log(
        `${ok ? "PASS" : "FAIL"}  ${path.padEnd(14)} theme=${info.theme} ` +
        `toggle=${info.hasToggle} bodyBgLum=${bgL == null ? "?" : bgL.toFixed(2)} ` +
        `textContrast=${cr ? cr.toFixed(1) : "?"}  bg=${info.bodyBg} text=${info.bodyColor}`
      );
    }

    // A page can now be listed with a query string, and "?" is not a filename
    // on Windows — the run died on the write, not on the check.
    const shot = path.replace(".html", "").replace(/[?=&]/g, "_");
    try {
      await page.screenshot({ path: `tests/_light_${shot}.png` });
    } catch (_) {
      // A page that never rendered has nothing to photograph. The FAIL line
      // above is the report; losing the screenshot too must not mask it.
    }
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(fail ? `\n${fail} page(s) FAILED` : "\nAll pages flipped to a readable light theme ✔");
process.exit(fail ? 1 : 0);
