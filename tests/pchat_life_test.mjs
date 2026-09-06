// ============================================================================
// pchat_life_test.mjs — "Match homes to my life", from P-Chat's row through to
// a re-ranked directory.
//
// The row is a DOOR, not a feature: the places, the commute legs and the
// ranking all live in js/pages/houses.js and stay there. So what has to be
// proved is different from the usual "does the button exist" —
//
//   · the door opens ONTO the thing (?life=1 lands with the modal already up,
//     which is the entire reason the row is not just a link to houses.html)
//   · the modal is a real dialog: Escape, focus in and back, no scroll behind,
//     one dialog however many times you ask
//   · a place can actually be named, found and kept
//   · applying it survives the trip back — the whole promise is that the
//     directory is now ranked around your week
//   · and it says all of this in Swahili too
//
//   usage:  node server.js      then, in another shell:
//           node tests/pchat_life_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
const MIN_TAP = 40;
const PLACES_KEY = "pawa_house_my_places";

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const SUPABASE_STUB = `window.supabase = { createClient: function () {
  var noSession = function () { return Promise.resolve({ data: { session: null, user: null }, error: null }); };
  function builder() { var b = {};
    ["select","eq","neq","gt","gte","lt","lte","in","is","or","filter","order","limit","range","match","insert","delete","update","upsert"]
      .forEach(function (m) { b[m] = function () { return b; }; });
    b.then = function (r, j) { return Promise.resolve({ data: [], error: null }).then(r, j); };
    return b; }
  return { from: builder, rpc: function () { return Promise.resolve({ data: [], error: null }); },
    auth: { getSession: noSession, getUser: noSession, signOut: noSession,
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; } },
    storage: { from: function () { return { getPublicUrl: function () { return { data: { publicUrl: "" } }; } }; } },
    channel: function () { return { on: function () { return this; }, subscribe: function () { return this; } }; },
    removeChannel: function () {} };
} };`;

// Nominatim answers in jsonv2. The flows test stubs this to [] because none of
// its seven doors search; this one does, so it needs a real-shaped answer or
// "add a place" can never be exercised at all.
const GEO_HITS = JSON.stringify([
  { place_id: 1, lat: "-6.7724", lon: "39.2083", name: "Mlimani City",
    display_name: "Mlimani City, Ubungo, Dar es Salaam, Tanzania",
    type: "mall", category: "shop", addresstype: "mall" },
  { place_id: 2, lat: "-6.8000", lon: "39.2200", name: "Mlimani Primary School",
    display_name: "Mlimani Primary School, Ubungo, Dar es Salaam, Tanzania",
    type: "school", category: "amenity", addresstype: "school" },
]);

const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
});

async function open(path, { width = 390, height = 844, lang = "en", places = null, theme = null } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => {
    const txt = m.text();
    if (m.type() === "error" && !/^\[[a-z-]+\]/i.test(txt) && !/favicon/i.test(txt)) {
      errs.push("console: " + txt.slice(0, 160));
    }
  });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    // The service worker is stubbed away, exactly as tests/_dash_shot.mjs does
    // it. Left alone it installs on the first page, then CONTROLS every
    // navigation after that, and a controlled navigation whose fetches also
    // pass back through request interception never resolves: the second page
    // in a run would sit at domcontentloaded until the timeout, no matter
    // which URL it was. That is a puppeteer-plus-interception deadlock and not
    // something a person with a browser can hit, so it is removed here rather
    // than worked around. Caching is proved by tests/service_worker_test.mjs.
    if (/sw-register\.js|service-worker\.js/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: "" });
    }
    if (req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*",
        "access-control-allow-methods": "*" } });
    }
    if (/cdn\.jsdelivr\.net.*supabase/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: SUPABASE_STUB });
    }
    if (/cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    if (/arcgisonline|basemaps\.cartocdn|api\.mapbox|tile\.openstreetmap|supabase\.co\/storage|\.mp4$/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
    }
    // Place search — the one network call this flow genuinely depends on.
    if (/nominatim|locationiq|\/search\?/.test(url)) {
      return req.respond({ status: 200, headers: {
        "access-control-allow-origin": "*", "content-type": "application/json" }, body: GEO_HITS });
    }
    if (/supabase\.co|router\.project-osrm/.test(url)) {
      return req.respond({ status: 200, headers: {
        "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
    }
    req.continue();
  });
  await page.evaluateOnNewDocument((l, k, p, th) => {
    try {
      localStorage.setItem("lang", l);
      // Seeded before a single app script runs, which is how a phone set to
      // light actually arrives: the theme is chosen when the first rule matches.
      if (th) localStorage.setItem("pawa-theme", th);
      if (p === null) localStorage.removeItem(k); else localStorage.setItem(k, p);
    } catch (_) {}
  }, lang, PLACES_KEY, places, theme);
  await page.goto(`${BASE}/${path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1800));
  return { page, errs };
}

const visible = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  if (el.hasAttribute("hidden")) return false;
  const cs = getComputedStyle(el);
  return cs.display !== "none" && cs.visibility !== "hidden" && el.getBoundingClientRect().height > 0;
}, sel);

try {
  // ---- 1. The door -------------------------------------------------------
  process.stdout.write("\n1. P-Chat offers the row, and it points at the engine\n");
  {
    const { page, errs } = await open("p-chat.html");
    const row = await page.evaluate(() => {
      const a = document.querySelector('a[href^="houses.html?life=1"]');
      if (!a) return null;
      const box = a.getBoundingClientRect();
      return {
        title: a.querySelector(".ha-find-t")?.textContent.trim(),
        desc: a.querySelector(".ha-find-d")?.textContent.trim(),
        h: Math.round(box.height), w: Math.round(box.width),
        group: a.closest("section")?.querySelector(".pc-group-h")?.textContent.trim(),
      };
    });
    ok(!!row, "the row exists and points at houses.html?life=1");
    ok(row && row.title === "Match homes to my life", "it is titled for the person, not the mechanism", row && row.title);
    ok(row && row.desc && row.desc.length > 30, "and it says what it will do for them", row && row.desc);
    ok(row && row.group === "Pull it to you",
       "it sits with the other two ways to bend the catalogue toward you", row && row.group);
    ok(row && Math.min(row.w, row.h) >= MIN_TAP, `the row is a thumb-sized target (${row && row.h}px)`);
    ok(errs.length === 0, "no page errors on P-Chat", errs.join(" | "));
    await page.close();
  }

  // ---- 2. It opens ONTO the thing ---------------------------------------
  process.stdout.write("\n2. ?life=1 arrives with the modal already open\n");
  {
    const { page, errs } = await open("houses.html?life=1");
    ok(await visible(page, "#placesModalBackdrop"),
       "the places modal is up on arrival — the row is a door, not a signpost");
    const hasRow = await page.evaluate(() => !!document.querySelector("#mpList .mp-row, #mpList > *"));
    ok(hasRow, "it starts with one blank place ready to fill, not an empty box");
    ok(errs.length === 0, "no page errors", errs.join(" | "));

    // plain houses.html must NOT open it — the modal is the door's doing
    const { page: p2 } = await open("houses.html");
    ok(!(await visible(p2, "#placesModalBackdrop")),
       "and plain houses.html still opens quietly");
    await p2.close();
    await page.close();
  }

  // ---- 3. A real dialog --------------------------------------------------
  process.stdout.write("\n3. It behaves like a dialog\n");
  {
    const { page } = await open("houses.html?life=1");
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.scrollTo(0, 400));
    const scrolled = await page.evaluate(() => window.scrollY);
    ok(scrolled === scrollBefore || scrolled === 0,
       "the directory behind it does not scroll away underneath", `scrollY ${scrolled}`);

    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 400));
    ok(!(await visible(page, "#placesModalBackdrop")), "Escape closes it");

    // re-open twice: one dialog, not two
    await page.evaluate(() => document.getElementById("houseCommuteBtn")?.click());
    await page.evaluate(() => document.getElementById("houseCommuteBtn")?.click());
    await new Promise((r) => setTimeout(r, 400));
    const count = await page.evaluate(() =>
      document.querySelectorAll("#placesModalBackdrop:not([hidden])").length);
    ok(count === 1, "pressing the button twice leaves one dialog", String(count));

    const smalls = await page.evaluate((min) => {
      const root = document.querySelector("#placesModalBackdrop");
      if (!root) return [];
      return [...root.querySelectorAll("button,select,textarea,a[href],input:not([type=hidden])")]
        .map((el) => {
          const lab = el.closest("label");
          const box = (lab || el).getBoundingClientRect();
          return { id: el.id || el.type || el.tagName, w: Math.round(box.width), h: Math.round(box.height) };
        })
        .filter((x) => x.h > 0 && Math.min(x.w, x.h) < min);
    }, MIN_TAP);
    ok(smalls.length === 0, "every control in it is a thumb-sized target",
       smalls.map((s) => `${s.id} ${s.w}x${s.h}`).join(", "));
    await page.close();
  }

  // ---- 4. Naming a place actually works ---------------------------------
  process.stdout.write("\n4. A place can be named, found and kept\n");
  {
    const { page, errs } = await open("houses.html?life=1");
    // Set + dispatch rather than page.type(): the real keystroke path needs the
    // field focused, and this sheet takes focus itself a frame after opening,
    // so the two race and the typing lands nowhere.
    await page.evaluate(() => {
      const i = document.getElementById("mpSearchInput");
      i.value = "Mlimani";
      i.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 1800));
    const results = await page.evaluate(() =>
      [...document.querySelectorAll("#mpSearchResults *")]
        .map((n) => n.textContent.trim()).filter(Boolean).slice(0, 4));
    ok(results.length > 0, "typing a place name returns somewhere to pick", results.join(" | "));

    const applyDisabledBefore = await page.evaluate(() =>
      document.getElementById("mpSaveBtn")?.disabled);
    ok(applyDisabledBefore === true,
       "Apply stays disabled until a place is actually pinned");

    // pick the first result
    await page.evaluate(() => {
      const r = document.querySelector("#mpSearchResults [data-lat], #mpSearchResults button, #mpSearchResults li, #mpSearchResults > *");
      if (r) r.click();
    });
    await new Promise((r) => setTimeout(r, 900));
    const afterPick = await page.evaluate(() => ({
      coords: document.getElementById("mpCoords")?.textContent.trim(),
      applyOff: document.getElementById("mpSaveBtn")?.disabled,
    }));
    ok(afterPick.applyOff === false, "picking one enables Apply", JSON.stringify(afterPick));
    ok(afterPick.coords && !/^Pick a place/i.test(afterPick.coords),
       "and the modal says where it landed", afterPick.coords);

    await page.evaluate(() => document.getElementById("mpSaveBtn")?.click());
    await new Promise((r) => setTimeout(r, 900));
    const saved = await page.evaluate((k) => {
      try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch (_) { return "unparseable"; }
    }, PLACES_KEY);
    ok(Array.isArray(saved) && saved.length === 1, "Apply keeps the place", JSON.stringify(saved).slice(0, 160));
    ok(Array.isArray(saved) && Number.isFinite(saved[0]?.lat) && Number.isFinite(saved[0]?.lng),
       "with real coordinates on it", JSON.stringify(saved[0] || {}).slice(0, 160));
    ok(!(await visible(page, "#placesModalBackdrop")), "and it closes on Apply");
    ok(errs.length === 0, "no page errors through the whole flow", errs.join(" | "));
    await page.close();
  }

  // ---- 5. It survives the trip back -------------------------------------
  process.stdout.write("\n5. The directory comes back ranked around it\n");
  {
    const seeded = JSON.stringify([{
      id: "p1", label: "Work", kind: "work", name: "Mlimani City",
      lat: -6.7724, lng: 39.2083, mode: "daladala", maxMin: 60,
    }]);
    const { page, errs } = await open("houses.html", { places: seeded });
    ok(await visible(page, "#housesPlacesChips"),
       "a saved place shows as a chip on the directory, so it is never a silent filter");
    const chip = await page.evaluate(() =>
      document.getElementById("housesPlacesChips")?.textContent.trim().slice(0, 80));
    ok(chip && /Work/.test(chip), "the chip carries the person's own label", chip);
    ok(chip && /Mlimani City/i.test(chip),
       "and names the actual place, on screen rather than in a hover tooltip", chip);
    const editIsButton = await page.evaluate(() => {
      const e = document.getElementById("mpEditChip");
      if (!e) return null;
      const box = e.getBoundingClientRect();
      return { tag: e.tagName, h: Math.round(box.height) };
    });
    ok(editIsButton && editIsButton.tag === "BUTTON",
       "Edit is a real button, so a keyboard can reach the sheet that owns the places",
       JSON.stringify(editIsButton));
    ok(editIsButton && editIsButton.h >= MIN_TAP,
       `and it is a thumb-sized target (${editIsButton && editIsButton.h}px)`);
    ok(errs.length === 0, "no page errors with a saved place", errs.join(" | "));
    await page.close();
  }

  // ---- 6. Swahili --------------------------------------------------------
  process.stdout.write("\n6. Swahili\n");
  {
    const { page, errs } = await open("p-chat.html", { lang: "sw" });
    const row = await page.evaluate(() => {
      const a = document.querySelector('a[href^="houses.html?life=1"]');
      return a ? { t: a.querySelector(".ha-find-t")?.textContent.trim(),
                   d: a.querySelector(".ha-find-d")?.textContent.trim() } : null;
    });
    ok(row && row.t && !/^pc_/.test(row.t) && row.t !== "Match homes to my life",
       "the row is translated, not just present", row && row.t);
    ok(row && row.d && !/^pc_/.test(row.d) && row.d !== "Add your workplace, school or the places your week runs through — homes get ranked by how close they really are.",
       "and so is its description", row && row.d);
    ok(errs.length === 0, "no page errors in Swahili", errs.join(" | "));
    await page.close();
  }

  // ---- 7. The sheet is readable, and it is in Swahili too ----------------
  // The whole .mp-* stylesheet was written light (#fafafa cards, #e5e7eb
  // borders) and dropped inside a dark sheet, while further down houses.html
  // forces every control in .alert-modal to rgba(255,255,255,.05) on #E9F3EE
  // with !important. White on white: five controls in the row and not one of
  // them legible. Nothing else on this page could catch it, because the row
  // is built by JS and only exists while the sheet is open, so it is measured
  // here, in both languages, the same WCAG arithmetic theme_light_check uses.
  process.stdout.write("\n7. Every control in the row can actually be read\n");
  {
    const lum = (c) => {
      const m = String(c).match(/\d+(\.\d+)?/g);
      if (!m) return null;
      const [r, g, b] = m.slice(0, 3).map(Number).map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => {
      const L1 = lum(a), L2 = lum(b);
      if (L1 == null || L2 == null) return null;
      return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    };

    // Both themes. The forced-dark control rule in houses.html is not
    // theme-scoped, while the sheet's surfaces are, so fixing one theme is
    // exactly how the other one breaks: --surface-app resolves to #ffffff
    // under theme-light.css, and near-white ink on it is the same bug again.
    for (const theme of ["dark", "light"]) {
    const { page, errs } = await open("houses.html?life=1", { lang: "sw", theme });
    const seen = await page.evaluate(() => {
      const cs = (s) => { const el = document.querySelector(s); return el ? getComputedStyle(el) : null; };
      const row = cs(".mp-row");
      const sel = cs(".mp-row-bottom select");
      const lbl = cs(".mp-field-l");
      const status = cs(".mp-status");
      return {
        rowBg: row && row.backgroundColor,
        selBg: sel && sel.backgroundColor,
        selFg: sel && sel.color,
        lblFg: lbl && lbl.color,
        statusFg: status && status.color,
        // Every word the row shows, so an untranslated one is visible here.
        kinds: [...document.querySelectorAll(".mp-kind option")].map((o) => o.textContent.trim()),
        modes: [...document.querySelectorAll(".mp-mode option")].map((o) => o.textContent.trim()),
        fields: [...document.querySelectorAll(".mp-field-l")].map((o) => o.textContent.trim()),
        status2: (document.querySelector(".mp-status") || {}).textContent,
        placeholder: (document.querySelector(".mp-label") || {}).placeholder,
        // The remove control was a &times; character; it is a drawn cross now.
        removeSvg: !!document.querySelector(".mp-remove svg"),
      };
    });

    // A select painted rgba(...,.05) over its parent is transparent, so the
    // colour it is really read against is the ROW, not the select's own
    // background. That is exactly the trap that made this unreadable.
    const bg = /rgba\(.*0\.0?5\)/.test(seen.selBg || "") ? seen.rowBg : seen.selBg;
    ok(ratio(seen.selFg, bg) >= 4.5,
       theme + ": the dropdown text reads against the row behind it",
       JSON.stringify({ fg: seen.selFg, bg, ratio: ratio(seen.selFg, bg) }));
    ok(ratio(seen.lblFg, seen.rowBg) >= 3,
       theme + ": so does the label above it",
       JSON.stringify({ fg: seen.lblFg, bg: seen.rowBg, ratio: ratio(seen.lblFg, seen.rowBg) }));
    ok(ratio(seen.statusFg, seen.rowBg) >= 3,
       theme + ": and the line saying whether the place is pinned yet",
       JSON.stringify({ fg: seen.statusFg, bg: seen.rowBg, ratio: ratio(seen.statusFg, seen.rowBg) }));

    const ENGLISH = ["Workplace", "School", "Favourite spot", "Walk", "Car",
                     "By", "Longest", "Go", "Name it", "Tap the map or search"];
    const words = [...seen.kinds, ...seen.modes, ...seen.fields,
                   seen.status2 || "", seen.placeholder || ""].join(" | ");
    const leaked = ENGLISH.filter((w) => words.includes(w));
    ok(leaked.length === 0, theme + ": no English survives the switch to Swahili", words);
    ok(!/\bmp_[a-z_]+/.test(words), theme + ": and no key leaked through as its own name", words);
    ok(seen.removeSvg, theme + ": the remove control is a drawn mark, not a character");
    ok(errs.length === 0, theme + ": no page errors", errs.join(" | "));
    await page.close();
    }
  }

  // ---- 8. Measuring from where you are standing --------------------------
  // The other direction. Everything above measures the DIRECTORY against the
  // places; this measures the person against them, which is the figure they
  // can check against their own experience, and therefore the one that makes
  // the rest believable. Real road distance only, from the same matrix the
  // ranking uses, so the OSRM table is answered here rather than stubbed out
  // in the page: this has to exercise geo.js, not step over it.
  process.stdout.write("\n8. From where you are now\n");
  {
    const SAVED = JSON.stringify([{
      id: "p1", kind: "work", label: "Kazini", name: "Mlimani City",
      lat: -6.7724, lng: 39.2083, mode: "daladala", maxMin: null,
    }]);
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
    await browser.defaultBrowserContext().overridePermissions(BASE, ["geolocation"]);
    await page.setGeolocation({ latitude: -6.8100, longitude: 39.2800, accuracy: 20 });
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = req.url();
      // Same reason as in open(): this handler is a second copy, and a
      // localhost URL falls through to continue() below, which would let the
      // real worker install and hang this page too.
      if (/sw-register\.js|service-worker\.js/.test(url)) {
        return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: "" });
      }
      if (req.method() === "OPTIONS") {
        return req.respond({ status: 204, headers: {
          "access-control-allow-origin": "*", "access-control-allow-headers": "*",
          "access-control-allow-methods": "*" } });
      }
      if (/cdn\.jsdelivr\.net.*supabase/.test(url)) {
        return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: SUPABASE_STUB });
      }
      if (/cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)) {
        return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
      }
      if (/arcgisonline|basemaps\.cartocdn|api\.mapbox|tile\.openstreetmap|supabase\.co\/storage|\.mp4$/.test(url)) {
        return req.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
      }
      // OSRM's table service, in its own shape: metres, row 0 is the origin,
      // index 0 of that row is origin to origin. 7.4 km to the one place.
      if (/\/table\/v1\//.test(url)) {
        return req.respond({ status: 200, headers: {
          "access-control-allow-origin": "*", "content-type": "application/json" },
          body: JSON.stringify({ code: "Ok", distances: [[0, 7400]] }) });
      }
      if (/nominatim|locationiq|\/reverse\?|\/search\?/.test(url)) {
        return req.respond({ status: 200, headers: {
          "access-control-allow-origin": "*", "content-type": "application/json" },
          body: JSON.stringify({ display_name: "Kigamboni, Dar es Salaam",
            address: { ward: "Kigamboni", city: "Dar es Salaam" } }) });
      }
      if (/supabase\.co|osrm|valhalla/.test(url)) {
        return req.respond({ status: 200, headers: {
          "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
      }
      if (/^http:\/\/localhost:8080\//.test(url)) return req.continue();
      // Everything else is refused rather than let out. reverseName() also
      // asks for the nearest landmark, which is an Overpass call; letting that
      // reach a real network held the whole reverse-geocode open for its
      // timeout, and the area name arrived long after this test had given up.
      req.abort();
    });
    await page.evaluateOnNewDocument((k, p) => {
      try { localStorage.setItem("lang", "en"); localStorage.setItem(k, p); } catch (_) {}
    }, PLACES_KEY, SAVED);
    await page.goto(`${BASE}/houses.html?life=1`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => {
      const el = document.getElementById("placesModalBackdrop");
      return el && !el.hidden && document.querySelector(".mp-row");
    }, { timeout: 30000 });

    ok(await visible(page, "#mpHere"), "the sheet offers to measure from where you are");
    const before = await page.evaluate(() =>
      !!document.querySelector(".mp-here-leg:not([hidden])"));
    ok(!before, "and says nothing until it has been asked");

    await page.click("#mpHereBtn");
    // Wait for the answer, never for a duration: a fix plus a routing call is
    // two round trips and the second one is the whole point of the assertion.
    await page.waitForFunction(() =>
      !!document.querySelector(".mp-here-leg:not([hidden])"), { timeout: 30000 })
      .catch(() => {});
    // The area name arrives on a second round trip, after the figures. Wait
    // for it separately rather than assuming one wait covers both.
    await page.waitForFunction(() =>
      /Kigamboni/.test((document.getElementById("mpHereMsg") || {}).textContent || ""),
      { timeout: 30000 }).catch(() => {});

    const after = await page.evaluate(() => ({
      leg: (document.querySelector(".mp-here-leg") || {}).textContent || "",
      msg: (document.getElementById("mpHereMsg") || {}).textContent || "",
      btn: (document.getElementById("mpHereBtn") || {}).textContent || "",
    }));
    ok(/7\.4/.test(after.leg),
       "it reports the real road distance, not a straight line (7.4 km)", after.leg);
    ok(/\d+\s*min|\dh/.test(after.leg),
       "with the time that distance takes by the mode chosen for that place", after.leg);
    ok(/Kigamboni/.test(after.msg), "and names where it found you", after.msg);
    ok(/again/i.test(after.btn), "the button then offers to measure again", after.btn);

    // Changing a dropdown rebuilds every row. The measurement has to survive
    // that, or it vanishes the moment somebody switches Daladala to Walk.
    await page.select(".mp-mode", "walk");
    await new Promise((r) => setTimeout(r, 300));
    const survived = await page.evaluate(() =>
      (document.querySelector(".mp-here-leg") || {}).textContent || "");
    ok(/7\.4/.test(survived),
       "and it survives a change of dropdown, which rebuilds the row", survived);

    ok(errs.length === 0, "no page errors", errs.join(" | "));
    await page.close();
  }
} finally {
  await browser.close();
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
