// ============================================================================
// frame_overpass_test.mjs — a frame that was not measured must not be reported
// as a frame that is empty.
//
// The Frame reads its magnets and shared services from Overpass (OpenStreetMap)
// and its roads from the same place via pawaRoads. Both are free, shared,
// heavily rate-limited endpoints. Measured from this app in one sitting: two
// clean 200s of 536 elements each, then a 429 with nothing.
//
// On that 429 the page used to carry on and state, as facts: a frame NAME
// ("Quiet residential frame"), a FRAME SCORE computed from the zeros, "No
// notable magnets mapped here yet", a population type, and a verdict. The only
// thing distinguishing it from a genuinely quiet ward was a grey hint line
// above the panel. Two reads of the same spot minutes apart gave 60 and 22.
//
// Overpass also has a quieter failure: a query that runs out of time answers
// 200, with valid JSON, a `remark`, and only the elements it managed to gather.
// Nothing read `remark`, so a truncated answer counted as a complete one.
//
// What is asserted here is the discipline, not the wording: when the data did
// not arrive, the page says so and withholds every conclusion built on it,
// while still showing what it does know.
//
//   usage:  node server.js     then, in another shell:
//           node tests/frame_overpass_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
const OVERPASS = /overpass/i;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};

// A small but complete-looking Overpass answer: a university, a market, a bank
// and a bus station, so a healthy read has something to name the frame after.
const ELEMENTS = [
  { type: "node", id: 1, lat: -6.7686, lon: 39.2249, tags: { amenity: "university", name: "Test University" } },
  { type: "node", id: 2, lat: -6.7690, lon: 39.2255, tags: { amenity: "marketplace", name: "Test Soko" } },
  { type: "node", id: 3, lat: -6.7680, lon: 39.2240, tags: { amenity: "bank", name: "Test Bank" } },
  { type: "node", id: 4, lat: -6.7695, lon: 39.2260, tags: { amenity: "bus_station", name: "Test Stendi" } },
  { type: "node", id: 5, lat: -6.7688, lon: 39.2252, tags: { amenity: "restaurant", name: "Test Migahawa" } },
];

/** Drive one read of "Mwenge" with Overpass answering in a given way. */
async function readFrame(browser, overpassReply) {
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 932 });
  let overpassCalls = 0;

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const u = req.url();
    if (req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*",
        "access-control-allow-methods": "*" } });
    }
    if (u.startsWith(BASE)) return req.continue();
    if (OVERPASS.test(u)) { overpassCalls++; return overpassReply(req); }
    // Everything else off-localhost is refused: the place itself resolves from
    // the bundled gazetteer, so the read must not need the network for that.
    return req.abort();
  });

  await page.goto(`${BASE}/frame.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => !!document.getElementById("frSearch"), { timeout: 20000 });
  await page.type("#frSearch", "Mwenge");
  await page.click("#frSearchBtn");

  // Done when the header card has rendered, whatever it says.
  try {
    await page.waitForFunction(
      () => !!document.querySelector(".fr-frame-name"), { timeout: 60000 });
  } catch (_) { /* reported by the assertions */ }
  await new Promise((r) => setTimeout(r, 800));

  const out = await page.evaluate(() => {
    const t = (s) => (document.querySelector(s)?.textContent || "").replace(/\s+/g, " ").trim();
    return {
      name: t(".fr-frame-name"),
      score: t(".fr-score"),
      unscored: !!document.querySelector(".fr-score--none"),
      hint: (document.getElementById("frHint")?.textContent || "").replace(/\s+/g, " ").trim(),
      panel: (document.getElementById("frPanel")?.innerText || "").replace(/\s+/g, " ").trim(),
    };
  });
  out.overpassCalls = overpassCalls;
  await page.close();
  return out;
}

const json = (body) => ({ status: 200,
  headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
  body: JSON.stringify(body) });

const browser = await puppeteer.launch({ headless: "new" });
try {
  // ---------------------------------------------------------------- 429 -----
  process.stdout.write("\n1. Rate-limited (HTTP 429) — the common case\n");
  const limited = await readFrame(browser, (req) =>
    req.respond({ status: 429, headers: { "access-control-allow-origin": "*" }, body: "rate limited" }));

  ok(!/Quiet residential frame/i.test(limited.name),
     "the frame is not named from magnets that were never counted", limited.name);
  ok(limited.unscored,
     "no frame score is shown for an unmeasured frame", limited.score);
  ok(!/^\s*\d+\s*$/.test(limited.score.replace(/not scored/i, "").trim()),
     "and the badge carries no number to compare against a real score", limited.score);
  ok(/not counted|did not answer|rate-limit/i.test(limited.hint),
     "the hint says the data did not arrive", limited.hint);
  ok(/rate-limit/i.test(limited.hint),
     "and names rate-limiting specifically, which is fixed by waiting", limited.hint);
  ok(!/No notable magnets mapped here yet/i.test(limited.panel),
     "the panel never claims there are no magnets here", limited.panel.slice(0, 200));
  ok(/not the same as none|Not counted/i.test(limited.panel),
     "it says absence of data is not absence of magnets", limited.panel.slice(0, 300));
  ok(/Not estimated/i.test(limited.panel),
     "the population estimate is withheld, not guessed from zeros", limited.panel.slice(0, 300));

  // Everything below is built from the same pins, and each one was still
  // asserting after the first pass at this fix. A sweep, not a spot-check:
  // any sentence that describes the area is a sentence that needed the data.
  ok(!/A quiet spot|few services drive a daily crowd/i.test(limited.panel),
     "the daily-life card does not call an unmeasured area quiet", limited.panel);
  ok(!/no strong daily pull point|No major destinations/i.test(limited.panel),
     "it does not claim there are no destinations here", limited.panel);
  ok(!/Mostly residential — the engine is people living here/i.test(limited.panel),
     "it does not infer the economic engine from counts it never had", limited.panel);
  ok(!/WATCH — building|OPEN —|GAP —|PROVEN —/i.test(limited.panel),
     "and gives no demand-vs-supply verdict", limited.panel);
  ok(/No verdict/i.test(limited.panel),
     "saying instead that the verdict needs the missing read", limited.panel);
  // What Pawa knows from its own tables is real and must survive.
  ok(/Pawa listings here/i.test(limited.panel),
     "Pawa's own listing counts are still shown", limited.panel);
  ok(/Revealed demand/i.test(limited.panel),
     "and so is its own revealed demand", limited.panel);

  // ------------------------------------------------- 200 + remark (partial) --
  process.stdout.write("\n2. Part-answered (HTTP 200 with a remark)\n");
  const partial = await readFrame(browser, (req) => req.respond(json({
    version: 0.6,
    remark: "runtime error: Query timed out in 'query' at line 3 after 25 seconds.",
    elements: ELEMENTS.slice(0, 2),
  })));
  ok(partial.unscored,
     "a truncated answer is not scored as though it were complete", partial.score);
  ok(!/Quiet residential|Learning frame|Market frame/i.test(partial.name),
     "and is not named from the fragment that did arrive", partial.name);
  ok(/part-answer|not counted|not shown/i.test(partial.hint),
     "the hint says the answer was partial", partial.hint);

  // ------------------------------------------------------------ healthy -----
  process.stdout.write("\n3. A complete answer still reads normally\n");
  const good = await readFrame(browser, (req) => req.respond(json({ version: 0.6, elements: ELEMENTS })));
  ok(!good.unscored, "a measured frame gets a real score", good.score);
  ok(/\d/.test(good.score), "and the score is a number", good.score);
  ok(!/not counted|did not answer/i.test(good.hint),
     "no failure notice on a clean read", good.hint);
  ok(/Frame read/i.test(good.hint), "the hint says the frame was read", good.hint);
  // The gating above withholds five cards on failure. This is the other half of
  // that bargain: on a clean read every one of them must still be there.
  ok(/DAILY LIFE OF THIS FRAME/i.test(good.panel), "the daily-life card is back", good.panel.slice(0, 200));
  ok(/THE FOUR LAYERS/i.test(good.panel), "the four layers are back", good.panel.slice(0, 200));
  ok(/DEMAND VS SUPPLY/i.test(good.panel), "the gap panel is back", good.panel.slice(0, 200));
  ok(/OPEN —|GAP —|PROVEN —|WATCH —/i.test(good.panel), "with a real verdict", good.panel.slice(0, 400));
  ok(!/Not counted|Not estimated|Not inferred|No verdict/i.test(good.panel),
     "and nothing is marked unmeasured", good.panel.slice(0, 400));
  ok(/university|market|bank|stendi|learning/i.test(good.panel),
     "the magnets that were returned are actually reported", good.panel.slice(0, 400));

  // -------------------------------------------------------------- cache -----
  process.stdout.write("\n4. Magnets are cached, because they barely move\n");
  ok(good.overpassCalls >= 1,
     "the first read of a spot does call Overpass (" + good.overpassCalls + ")");
  // Re-reading the SAME spot in the same session must not pay for it twice —
  // repeat lookups are the easiest 429 to stop causing.
  const cached = await readFrame(browser, (req) => req.respond(json({ version: 0.6, elements: ELEMENTS })));
  ok(cached.overpassCalls >= 1, "a fresh page still reads (cache is per session)");
} finally {
  await browser.close();
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
