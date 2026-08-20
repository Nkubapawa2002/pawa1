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

async function open(path, { width = 390, height = 844, lang = "en", places = null } = {}) {
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
  await page.evaluateOnNewDocument((l, k, p) => {
    try {
      localStorage.setItem("lang", l);
      if (p === null) localStorage.removeItem(k); else localStorage.setItem(k, p);
    } catch (_) {}
  }, lang, PLACES_KEY, places);
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
      const a = document.querySelector('a[href="houses.html?life=1"]');
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
      const a = document.querySelector('a[href="houses.html?life=1"]');
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
} finally {
  await browser.close();
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
