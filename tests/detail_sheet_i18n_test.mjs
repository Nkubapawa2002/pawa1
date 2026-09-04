// ============================================================================
//  detail_sheet_i18n_test.mjs — the two public detail sheets, rendered.
//
//  WHY THIS EXISTS SEPARATELY FROM i18n_coverage.mjs
//  That scan loads a page and reports English text a person can see. On
//  service.html and truck.html a person can see almost nothing: without a
//  ?id= that resolves to a real listing, both pages render three words of
//  "not found" and the scan reports them clean. Everything the sheets are
//  actually made of — "Category", "Rate", "Driver", "Loaders", "About this
//  service", "Contact the owner" — only exists once a listing is on screen.
//
//  That is exactly how both files stayed English from top to bottom while the
//  rest of the app was bilingual: no test could reach them.
//
//  So this one hands each page a fixture through DataStore, switches the app
//  to Swahili, and reads the rendered sheet back. It asserts three things:
//
//    1. the labels are Swahili, not English
//    2. the catalogue half of the characteristics list is translated
//    3. the provider's OWN words come back exactly as typed, untranslated,
//       which is the whole promise of the free-text box on the listing form
//
//  It also checks the LIGHT theme on the same rendered sheet, for the same
//  reason. Both pages carry a dark re-skin written on body[data-page="…"], and
//  two of its rules repaint things the light palette cannot reach back into:
//  the badge text colour and the gallery placeholder. Unguarded, that made the
//  badges white on white in light mode. tests/theme_light_check.mjs samples the
//  body and would never see it, because the body ground was fine.
//
//  Run: node tests/detail_sheet_i18n_test.mjs   (needs `node server.js` up)
// ============================================================================
import puppeteer from "puppeteer";

const BASE = process.env.PAWA_BASE || "http://localhost:8080";

let pass = 0;
const fails = [];
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); return; }
  fails.push(detail ? msg + "\n        " + detail : msg);
};

// The English that must NOT survive a switch to Swahili. Each of these was on
// the sheet before this pass, and each is a phrase rather than a word so a
// Swahili sentence cannot trip it by accident.
const ENGLISH = [
  "Service details", "About this service", "Contact the provider",
  "Truck details", "About this truck", "Contact the owner",
  "Category", "Experience", "Based in", "Truck type", "Capacity",
  "Not included", "On request", "Share live location",
  "What you get", "What comes with it",
];

const SERVICE = {
  id: "fixture", title: "Usafi wa kina", category: "cleaning",
  price_tzs: 25000, rate_type: "per_job", negotiable: true,
  experience_years: 6, availability: "Jumatatu hadi Jumamosi",
  service_area: "region_wide", region: "Dar es Salaam", area: "Mikocheni",
  description: "Tunasafisha nyumba na ofisi.", verified: true,
  owner: { name: "Neema", phone: "+255700000001" },
  details: { v: 1, includes: ["own_tools", "receipt", "Napanda kiunzi changu mwenyewe"] },
};

const TRUCK = {
  id: "fixture", title: "Kanta ya Mwanga", truck_type: "canter",
  capacity_tonnes: 3, price_tzs: 80000, negotiable: true,
  driver_included: true, loaders_included: false,
  service_area: "region_wide", region: "Dar es Salaam", area: "Mikocheni",
  description: "Tunahamisha nyumba na maduka.", verified: true,
  owner: { name: "Mwanga Movers", phone: "+255700000002" },
  details: { v: 1, kit: ["driver", "tarpaulin", "Tairi mbili za akiba safari ndefu"] },
};

const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
});

/**
 * One sheet, rendered in Swahili with a fixture behind it.
 *
 * The fixture is installed by overriding the single DataStore method the page
 * calls, which is the smallest possible lie: everything else on the page runs
 * exactly as it does in production, including listing-kinds.js and
 * offer-spec.js doing the translating.
 */
async function render(path, loader, row, theme) {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
  await page.setViewport({ width: 412, height: 915 });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const u = req.url();
    if (req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*",
        "access-control-allow-methods": "*" } });
    }
    if (/supabase\.co|locationiq|maptiler|mapbox|tile|openstreetmap|arcgisonline|cartocdn|fonts\.(googleapis|gstatic)/i.test(u)) {
      return req.respond({ status: 200, headers: {
        "content-type": "application/json", "access-control-allow-origin": "*" }, body: "[]" });
    }
    req.continue();
  });

  // Swahili, and the fixture, both before the page script runs.
  await page.evaluateOnNewDocument((fn, r, lang) => {
    try { localStorage.clear(); localStorage.setItem("lang", lang); } catch (_) {}
    // Catch DataStore the instant the page assigns it, rather than polling for
    // it: a poll loses the race to the page's own init() often enough on this
    // host to make the suite flaky, and a flaky test is a test nobody trusts.
    let ds;
    Object.defineProperty(window, "DataStore", {
      configurable: true,
      get() { return ds; },
      set(v) { ds = v; if (v) v[fn] = async () => [r]; },
    });
  }, loader, row, "sw");

  await page.goto(`${BASE}/${path}?id=fixture`, { waitUntil: "domcontentloaded", timeout: 30000 });
  if (theme) await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  await new Promise((r) => setTimeout(r, 2500));

  const out = await page.evaluate(() => {
    // Relative luminance, so "is this readable" is a number rather than an
    // opinion. Both colours here are computed styles, so both are opaque rgb().
    const lum = (c) => {
      const m = String(c).match(/\d+(\.\d+)?/g);
      if (!m) return null;
      const [r, g, b] = m.slice(0, 3).map(Number).map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    // The nearest ancestor that actually paints, because a transparent
    // background is not a background.
    const groundOf = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const bg = getComputedStyle(n).backgroundColor;
        const a = String(bg).match(/rgba?\([^)]*?,\s*([\d.]+)\)$/);
        if (bg && bg !== "transparent" && (!a || Number(a[1]) > 0.5)) return bg;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const contrast = (a, b) => {
      const L1 = lum(a), L2 = lum(b);
      if (L1 == null || L2 == null) return null;
      return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    };

    const badges = Array.from(document.querySelectorAll(".sd-badge, .td-badge"))
      .filter((b) => !b.classList.contains("verified"))
      .map((b) => ({
        text: b.textContent.trim(),
        ratio: contrast(getComputedStyle(b).color, groundOf(b)),
      }));

    const gallery = document.querySelector(".sd-gallery-main, .td-gallery-main");

    return {
      text: (document.body.innerText || "").replace(/\s+/g, " "),
      rendered: !!document.querySelector(".sd-specs, .td-specs"),
      offered: Array.from(document.querySelectorAll(".of-list li")).map((li) => li.textContent.trim()),
      badges,
      galleryLum: gallery ? lum(getComputedStyle(gallery).backgroundColor) : null,
    };
  });
  await page.close();
  return { ...out, errs };
}

console.log("\nThe two public detail sheets, rendered in Swahili\n");

for (const [path, loader, row, own, catalogue] of [
  ["service.html", "getServices", SERVICE,
   "Napanda kiunzi changu mwenyewe", ["Naja na vifaa vyangu", "Natoa risiti"]],
  ["truck.html", "getTrucks", TRUCK,
   "Tairi mbili za akiba safari ndefu", ["Dereva amejumuishwa", "Turubai juu ya mzigo"]],
]) {
  // Puppeteer drops a navigation on this host often enough that one retry is
  // the difference between a flaky suite and a useful one.
  let r = await render(path, loader, row, "dark");
  if (!r.rendered) r = await render(path, loader, row, "dark");

  console.log(path);
  ok(r.rendered, "the sheet rendered with the fixture on it",
     r.rendered ? "" : "body was: " + r.text.slice(0, 160));
  ok(r.errs.length === 0, "no console errors", r.errs.slice(0, 3).join(" | "));

  const leaks = ENGLISH.filter((e) => r.text.includes(e));
  ok(leaks.length === 0, "no English label survived the switch to Swahili",
     leaks.join(", "));

  ok(catalogue.every((w) => r.offered.includes(w)),
     "the catalogue characteristics are in Swahili",
     "wanted " + JSON.stringify(catalogue) + ", got " + JSON.stringify(r.offered));

  // The point of the free-text box: an invented characteristic is the
  // provider's own sentence and must never be translated, normalised or
  // dropped on its way to the reader.
  ok(r.offered.includes(own),
     "the provider's own words come back exactly as typed",
     "wanted " + JSON.stringify(own) + ", got " + JSON.stringify(r.offered));

  // ---- the same sheet in the light theme --------------------------------
  // The dark re-skin on these pages repaints the badge text and the gallery
  // placeholder. Both rules are guarded behind :root:not([data-theme="light"])
  // now; unguarded, the badges were white on white and the empty gallery was a
  // solid black block on a cream page.
  let lite = await render(path, loader, row, "light");
  if (!lite.rendered) lite = await render(path, loader, row, "light");

  ok(lite.rendered, "and it renders in the light theme too");
  const dim = lite.badges.filter((b) => !b.ratio || b.ratio < 3);
  ok(lite.badges.length > 0 && dim.length === 0,
     "every badge stays readable in the light theme",
     lite.badges.length === 0 ? "no badges rendered at all"
       : dim.map((b) => `"${b.text}" at ${b.ratio ? b.ratio.toFixed(2) : "?"}:1`).join(", "));
  ok(lite.galleryLum == null || lite.galleryLum > 0.4,
     "the empty gallery is a light placeholder, not a black block",
     "luminance " + (lite.galleryLum == null ? "?" : lite.galleryLum.toFixed(2)));
  console.log("");
}

await browser.close();

fails.forEach((f) => console.log("  FAIL  " + f));
console.log("\n" + pass + " passed, " + fails.length + " failed\n");
process.exit(fails.length ? 1 : 0);
