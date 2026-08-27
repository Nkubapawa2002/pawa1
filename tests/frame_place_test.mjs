// ============================================================================
// frame_place_test.mjs — the Frame reads the area you actually typed.
//
// The Frame's whole job is to read ONE bounded area. If the pin lands in the
// wrong region, every layer under it — magnets, roads, population, the gap —
// is a confident, detailed description of somewhere else. That is worse than
// an error, because it looks like an answer.
//
// Two faults shipped together and hid each other:
//
//   1. frame.html loaded neither js/lib/tz-places.js nor js/lib/place-match.js,
//      the two files every other place-resolving page in the app loads. Search
//      fell through to raw LocationIQ, which answers "Mwenge" with a place in
//      Tabora Region — 800 km from the Dar node everyone means.
//
//   2. frame.js gated its gazetteer branch on `window.pawaResolvePlace`, a
//      global that is defined nowhere in this codebase. The real export is
//      `window.resolveTzPlace`. So the branch had never run once, and fault 1
//      was invisible: adding the scripts alone would not have fixed it.
//
// This asserts both halves — that the page carries the gazetteer, and that the
// branch reading it is actually wired to the name the gazetteer exports.
//
//   usage:  node server.js     then, in another shell:
//           node tests/frame_place_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";

// Dar es Salaam. Any resolution outside this box is a different city.
const DAR = { latMin: -7.2, latMax: -6.4, lngMin: 38.9, lngMax: 39.6 };
const inDar = (p) => !!p && p.lat > DAR.latMin && p.lat < DAR.latMax &&
                     p.lng > DAR.lngMin && p.lng < DAR.lngMax;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};

const browser = await puppeteer.launch({ headless: "new" });
try {
  const page = await browser.newPage();

  // The page is only allowed to talk to the dev server. If any of the reads
  // below still succeed, they were answered locally — which is the point: a
  // place this app already knows must never cost a network round trip, and
  // must never be at the mercy of a geocoder's opinion.
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.url().startsWith(BASE)) return req.continue();
    return req.abort();
  });

  await page.goto(`${BASE}/frame.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => !!document.getElementById("frSearch"), { timeout: 20000 });

  process.stdout.write("\n1. The page carries the gazetteer it claims to use\n");
  const globals = await page.evaluate(() => ({
    resolve: typeof window.resolveTzPlace,
    placeMatch: !!window.pawaPlaceMatch,
    landmarks: Array.isArray(window.TZ_LANDMARKS) ? window.TZ_LANDMARKS.length : 0,
    universities: Array.isArray(window.TZ_UNIVERSITIES) ? window.TZ_UNIVERSITIES.length : 0,
  }));
  ok(globals.resolve === "function",
     "tz-places.js is loaded, so resolveTzPlace exists", JSON.stringify(globals));
  ok(globals.placeMatch,
     "place-match.js is loaded, so the local matcher exists", JSON.stringify(globals));
  ok(globals.landmarks > 0 && globals.universities > 0,
     "the gazetteer has rows to match against", JSON.stringify(globals));

  process.stdout.write("\n2. frame.js reads the global the gazetteer actually exports\n");
  // The dead branch was gated on a name that does not exist, so the guard here
  // is the source itself: nothing may reach for `pawaResolvePlace` again.
  const src = await (await fetch(`${BASE}/js/pages/frame.js`)).text();
  ok(!/window\.pawaResolvePlace/.test(src),
     "frame.js no longer gates on the global that never existed");
  ok(/window\.resolveTzPlace/.test(src),
     "and reaches for resolveTzPlace, which tz-places.js defines");

  process.stdout.write("\n3. A place the app knows resolves to the right city, offline\n");
  for (const [q, expect] of [["Mwenge", "Dar"], ["Mikocheni", "Dar"], ["Kariakoo", "Dar"]]) {
    const hit = await page.evaluate((query) => {
      const r = window.resolveTzPlace ? window.resolveTzPlace(query) : null;
      return r ? { name: r.name, lat: r.lat, lng: r.lng } : null;
    }, q);
    ok(inDar(hit), `"${q}" lands in ${expect} es Salaam, with the network cut`,
       JSON.stringify(hit));
  }

  process.stdout.write("\n4. The one that used to go 800 km wrong\n");
  // "Mwenge" is the regression: an exact alias on a Dar area, competing with
  // "Mwenge Catholic University" in Moshi, which merely contains the word.
  // Guarded, because the fault this test exists for is the gazetteer being
  // absent entirely — and a test that throws instead of reporting FAIL tells
  // you nothing about the other assertions behind it.
  const mwenge = await page.evaluate(() => {
    const r = window.resolveTzPlace ? window.resolveTzPlace("Mwenge") : null;
    const pm = window.pawaPlaceMatch
      ? window.pawaPlaceMatch.search("Mwenge", { limit: 3 }).map((h) => h.name)
      : [];
    return { resolved: r && r.name, lat: r && r.lat, ranked: pm };
  });
  ok(mwenge.resolved === "Mwenge",
     "the exact-alias area wins, not the university whose name contains it",
     JSON.stringify(mwenge));
  // `resolved` must be truthy first: "null is not a place in another region"
  // is true and worthless, and would have let this assertion pass on the very
  // build it exists to catch.
  ok(!!mwenge.resolved && !/Tabora|Moshi|Kilimanjaro/i.test(String(mwenge.resolved)),
     "and the answer is not a place in another region", JSON.stringify(mwenge));

  await page.close();
} finally {
  await browser.close();
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
