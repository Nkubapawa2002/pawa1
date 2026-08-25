// ============================================================================
// theme_light_sweep.mjs — every page, both themes, every visible line of text,
// measured against the PIXELS behind it.
//
// theme_light_check.mjs asks one question per page ("did <body> flip?"), which
// a page can pass while the text inside it is unreadable. contrast_check.mjs
// walks the DOM for the first non-transparent ancestor background, which
// guesses wrong over gradients and photos (see its header). This one hides the
// ink, screenshots the page, and takes the median pixel under each text
// element's box — so a gradient, a hero photo and a translucent card all
// report the colour that is actually on screen.
//
// It exists for one specific structural bug: pages carry an inline
// "Twilight dark re-skin" block that sets the whole --c-* palette on
// body[data-page="X"] unconditionally. Custom properties resolve to the
// NEAREST ancestor that defines them, so a value on <body> beats
// css/theme-light.css on :root — light mode keeps the dark palette. The
// travelling companion bug is a card hardcoded to #fff while the block paints
// the ink near-white, which fails in DARK mode instead. One sweep catches
// both, so every page is loaded twice.
//
// Scope, stated rather than assumed: only text inside the first viewport is
// measured (a full-page screenshot reflows sticky headers, which would move
// the very boxes being sampled). Off-screen text is counted and reported, not
// checked. Maps are stubbed, so map controls are excluded too.
//
//   usage:  node server.js     then, in another shell:
//           node tests/theme_light_sweep.mjs                 # every page
//           node tests/theme_light_sweep.mjs trucks.html …   # named pages
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";

const ALL_PAGES = [
  "index.html", "explore.html", "houses.html", "house.html?id=x",
  "houses-compact.html", "trucks.html", "truck.html?id=x", "services.html",
  "service.html?id=x", "jobs.html", "area.html", "near-me.html", "frame.html",
  "meet.html", "favorites.html", "chat.html", "p-chat.html", "p-message.html",
  "profile.html", "login.html", "agent.html?u=nobody", "agent-houses.html",
  "agent-services.html", "agent-trucks.html", "admin.html", "super-admin.html",
  "share-location.html",
];

const PAGES = process.argv.slice(2).length ? process.argv.slice(2) : ALL_PAGES;

// Below this ratio the text is genuinely hard to read, not merely off-spec.
// WCAG AA is 4.5; this sweep's job is finding invisible text, so it fails at 3
// and only mentions the 3–4.5 band.
const FAIL_AT = 3.0;
const WARN_AT = 4.5;
const MAX_REPORT = 8; // per page per theme — the rest are counted

// ── stubs ───────────────────────────────────────────────────────────────────
// Nothing off this machine is reachable (jsDelivr, Google Fonts). A blocked
// script holds up DOMContentLoaded for 30 s, so every one is answered here.
const SUPABASE_STUB = `(function () {
  function builder() {
    var b = {};
    ["select","eq","neq","gt","gte","lt","lte","in","is","or","filter","order",
     "limit","range","match","single","maybeSingle","insert","update","upsert",
     "delete","contains","overlaps","not"].forEach(function (m) {
      b[m] = function () { return b; };
    });
    b.then = function (res, rej) {
      return Promise.resolve({ data: [], error: null }).then(res, rej);
    };
    return b;
  }
  var noSession = function () {
    return Promise.resolve({ data: { session: null, user: null }, error: null });
  };
  window.supabase = { createClient: function () { return {
    from: builder,
    rpc: function () { return Promise.resolve({ data: null, error: null }); },
    auth: {
      getSession: noSession, getUser: noSession, signInWithPassword: noSession,
      signUp: noSession, signInAnonymously: noSession,
      signOut: function () { return Promise.resolve({ error: null }); },
      onAuthStateChange: function () {
        return { data: { subscription: { unsubscribe: function () {} } } };
      },
    },
    storage: { from: function () { return {
      getPublicUrl: function () { return { data: { publicUrl: "" } }; },
      upload: function () { return Promise.resolve({ data: null, error: null }); },
    }; } },
    channel: function () {
      return { on: function () { return this; }, subscribe: function () { return this; },
               send: function () { return Promise.resolve(); } };
    },
    removeChannel: function () {},
  }; } };
})();`;

// house.html / houses.html call `new maplibregl.Map(...)` unguarded, so an
// empty stub throws a TypeError before the page has painted. A proxy that
// answers any call chain — including the primitive coercions Math.max() does
// on getZoom() — lets the page finish rendering.
const MAP_STUB = `(function () {
  function chain() {
    var f = function () { return chain(); };
    return new Proxy(f, {
      get: function (t, k) {
        if (k === Symbol.toPrimitive) return function () { return 0; };
        if (k === "valueOf") return function () { return 0; };
        if (k === "toString") return function () { return "0"; };
        if (k === "then") return undefined;
        return chain();
      },
      apply: function () { return chain(); },
      construct: function () { return chain(); },
    });
  }
  window.maplibregl = chain();
  window.L = chain();
})();`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

async function stub(page) {
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
    if (/cdn\.jsdelivr\.net.*supabase/.test(url)) {
      return req.respond({ status: 200,
        headers: { "content-type": "application/javascript" }, body: SUPABASE_STUB });
    }
    if (/maplibre|leaflet/i.test(url) && /\.js/.test(url)) {
      return req.respond({ status: 200,
        headers: { "content-type": "application/javascript" }, body: MAP_STUB });
    }
    if (!url.startsWith(BASE) && /fonts\.googleapis\.com|fonts\.gstatic\.com|\.css(\?|$)/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    if (/cdn\.jsdelivr\.net|unpkg\.com/.test(url)) {
      return req.respond({ status: 200,
        headers: { "content-type": "application/javascript" }, body: "" });
    }
    if (/arcgisonline|basemaps\.cartocdn|api\.mapbox|tile\.openstreetmap|supabase\.co\/storage/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
    }
    if (/supabase\.co|locationiq|nominatim|router\.project-osrm/.test(url)) {
      return req.respond({ status: 200,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: "[]" });
    }
    if (!url.startsWith(BASE) && !url.startsWith("data:") && !url.startsWith("blob:")) {
      return req.respond({ status: 204, body: "" });
    }
    req.continue();
  });
}

// ── step 1: which boxes hold text, and what colour is the ink ───────────────
function collectInPage() {
  const SKIP = /^(script|style|title|meta|link|noscript|svg|path|head|option)$/i;
  const out = [];
  let offscreen = 0;
  const vw = window.innerWidth, vh = window.innerHeight;

  const label = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    if (el.className && typeof el.className === "string") {
      const c = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (c.length) s += "." + c.join(".");
    }
    return s;
  };

  for (const el of document.querySelectorAll("body *")) {
    if (SKIP.test(el.tagName)) continue;
    if (el.closest(".maplibregl-map, .leaflet-container, [hidden]")) continue;
    let own = "";
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.nodeValue.trim().length > 1) own += n.nodeValue.trim() + " ";
    }
    if (!own) continue;

    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    if (parseFloat(cs.opacity) < 0.1) continue;
    // Gradient-filled glyphs paint from the background; contrast is not the
    // right question for them.
    if (/text/.test(cs.webkitBackgroundClip || cs.backgroundClip || "")) continue;

    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 6) continue;
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) { offscreen++; continue; }

    out.push({
      sel: label(el),
      text: own.replace(/\s+/g, " ").slice(0, 44),
      color: cs.color,
      fontPx: Math.round(parseFloat(cs.fontSize) || 0),
      rect: {
        x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)),
        w: Math.round(Math.min(r.right, vw) - Math.max(0, r.left)),
        h: Math.round(Math.min(r.bottom, vh) - Math.max(0, r.top)),
      },
    });
  }
  return {
    items: out, offscreen,
    theme: document.documentElement.getAttribute("data-theme") || "(none)",
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
}

// ── step 3: read the median pixel under each box, from the ink-less shot ────
function sampleInPage(shotB64, items, failAt, warnAt) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);

      const parse = (c) => {
        const m = String(c).match(/-?\d+(\.\d+)?/g);
        if (!m) return null;
        return { r: +m[0], g: +m[1], b: +m[2], a: m.length > 3 ? +m[3] : 1 };
      };
      const over = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
      });
      const lum = (c) => {
        const f = (v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const ratio = (a, b) => {
        const l1 = lum(a), l2 = lum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      const median = (arr) => arr.sort((a, b) => a - b)[arr.length >> 1];

      const findings = [];
      let checked = 0;
      for (const it of items) {
        const { x, y, w, h } = it.rect;
        if (w < 4 || h < 4) continue;
        let data;
        try { data = ctx.getImageData(x, y, w, h).data; } catch (_) { continue; }
        const R = [], G = [], B = [];
        // Every 3rd pixel in each direction — a median over ~1/9 of the box is
        // the same colour and a fraction of the work.
        for (let py = 0; py < h; py += 3) {
          for (let px = 0; px < w; px += 3) {
            const i = (py * w + px) * 4;
            R.push(data[i]); G.push(data[i + 1]); B.push(data[i + 2]);
          }
        }
        if (!R.length) continue;
        const bg = { r: median(R), g: median(G), b: median(B) };
        const fg = parse(it.color);
        if (!fg || fg.a === 0) continue;
        checked++;
        const ink = fg.a >= 0.999 ? fg : over(fg, bg);
        const cr = Math.round(ratio(ink, bg) * 100) / 100;
        if (cr < warnAt) {
          findings.push({
            sel: it.sel, text: it.text, ratio: cr, color: it.color,
            bg: `rgb(${bg.r}, ${bg.g}, ${bg.b})`, bad: cr < failAt,
          });
        }
      }
      findings.sort((a, b) => a.ratio - b.ratio);
      resolve({ checked, findings });
    };
    img.onerror = () => resolve({ checked: 0, findings: [], error: "shot decode failed" });
    img.src = "data:image/png;base64," + shotB64;
  });
}

// ── driver ──────────────────────────────────────────────────────────────────
const HIDE_INK = `*, *::before, *::after {
  color: transparent !important;
  text-shadow: none !important;
  -webkit-text-fill-color: transparent !important;
  caret-color: transparent !important;
}`;

async function runPage(browser, path, theme) {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 1 });
  // Pages share one browser, so a stylesheet edited between runs would
  // otherwise be served from cache and the sweep would report the previous
  // build — which it did once, failing agent-trucks.html on a fix that had
  // already landed and that admin.html had just passed with.
  await page.setCacheEnabled(false);
  await stub(page);
  await page.evaluateOnNewDocument((t) => {
    try { localStorage.setItem("pawa-theme", t); } catch (_) {}
  }, theme);
  try {
    await page.goto(`${BASE}/${path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 900));
    const collected = await page.evaluate(collectInPage);
    await page.evaluate((css) => {
      const s = document.createElement("style");
      s.id = "__sweep_hide_ink";
      s.textContent = css;
      document.head.appendChild(s);
    }, HIDE_INK);
    const shot = await page.screenshot({ encoding: "base64" });
    await page.evaluate(() => {
      const s = document.getElementById("__sweep_hide_ink");
      if (s) s.remove();
    });
    const measured = await page.evaluate(sampleInPage, shot, collected.items, FAIL_AT, WARN_AT);
    return { ...collected, ...measured };
  } catch (e) {
    return { error: String(e).split("\n")[0], findings: [] };
  } finally {
    await page.close();
  }
}

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  protocolTimeout: 120000,
});
const out = (s) => process.stdout.write(s + "\n");
let failedPages = 0;
const summary = [];

for (const path of PAGES) {
  const light = await runPage(browser, path, "light");
  const dark = await runPage(browser, path, "dark");
  const bad = (r) => (r.findings || []).filter((f) => f.bad);
  const lb = bad(light), db = bad(dark);
  const broke = lb.length || db.length || light.error || dark.error;
  if (broke) failedPages++;
  out(`${broke ? "FAIL" : "PASS"}  ${path}`);
  for (const [name, r] of [["light", light], ["dark", dark]]) {
    if (r.error) { out(`      ${name}: ERROR ${r.error}`); continue; }
    const b = bad(r);
    out(`      ${name}: theme=${r.theme} bodyBg=${r.bodyBg} measured=${r.checked}` +
        ` under${FAIL_AT}=${b.length} under${WARN_AT}=${r.findings.length}` +
        (r.offscreen ? ` offscreen(not checked)=${r.offscreen}` : ""));
    for (const f of b.slice(0, MAX_REPORT)) {
      out(`        ${String(f.ratio).padStart(5)}:1  ${f.sel}  "${f.text}"  ${f.color} on ${f.bg}`);
    }
    if (b.length > MAX_REPORT) out(`        …and ${b.length - MAX_REPORT} more`);
  }
  summary.push({ path, light: lb.length, dark: db.length });
}

await browser.close();
out("");
out("page                      light  dark");
for (const s of summary) {
  out(`${s.path.padEnd(24)}  ${String(s.light).padStart(5)}  ${String(s.dark).padStart(4)}`);
}
out(failedPages ? `\n${failedPages} page(s) have text under ${FAIL_AT}:1`
                : `\nEvery page reads in both themes ✔`);
process.exit(failedPages ? 1 : 0);
