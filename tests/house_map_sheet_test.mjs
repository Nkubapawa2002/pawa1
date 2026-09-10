// ============================================================================
//  house_map_sheet_test.mjs — what a pin on the map opens.
//
//  The old popup held a photo, a price, "2 bed · 1 bath · 45 m²" and two phone
//  buttons. Every assertion here is about a fact that was ALREADY IN THE ROW
//  and was not on the map, so the only way to learn it was to ring the agent:
//
//    · where the bathroom is, which settles a viewing before anybody travels
//    · what "medium" means, in words rather than a number nobody measured
//    · the rules, in the agent's own words
//    · what is owed on top of the rent, with "included" and "free" said as the
//      facts they are rather than collapsed into "ask"
//    · how to get there, with the boxes already filled
//
//  And two it must refuse to guess: a bathroom nobody recorded, and a cost
//  nobody priced.
//
//  Run: node tests/house_map_sheet_test.mjs   (needs `node server.js` up)
// ============================================================================
import puppeteer from "puppeteer";

const BASE = process.env.PAWA_BASE || "http://localhost:8080";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const MAPLIBRE_STUB = `(function () {
  var noop = function () {};
  function make() {
    return new Proxy(noop, {
      get: function (t, k) {
        if (k === "then") return undefined;
        if (typeof k === "symbol") return undefined;
        if (k === "toString" || k === "valueOf") return function () { return ""; };
        return make();
      },
      apply: function () { return make(); },
      construct: function () { return make(); }
    });
  }
  window.maplibregl = make();
  window.L = make();
})();`;

let pass = 0;
const fails = [];
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); return; }
  fails.push(detail ? msg + "\n        " + detail : msg);
  console.log("  FAIL  " + msg + (detail ? "\n        " + detail : ""));
};

// One listing carrying every shape the sheet has an opinion about: a room with
// the bathroom inside, a room with it outside, a room that never said, a cost
// that is included, one that is metered, one that is free, one nobody priced,
// and rules in the agent's own words.
const HOUSE = {
  id: "fixture", title: "Nyumba ya Tabata", type: "house",
  listing: "rent", price_tzs: 60000, period: "month",
  region: "Dar es Salaam", area: "Tabata", lat: -6.7924, lng: 39.2083,
  verified: true, photos: ["a.jpg", "b.jpg"],
  agent: { name: "Neema", phone: "+255700000003" },
  extra_costs: [
    { label: "Water", amount: 0, billing: "month" },
    { label: "LUKU", amount: null, billing: "metered" },
    { label: "Security", amount: 5000, billing: "month" },
    { label: "Rubbish", amount: null, billing: "month" },
    { label: "Key deposit", amount: 20000, billing: "oneoff" },
  ],
  details: {
    v: 1,
    rooms: [
      { kind: "single", price: 60000, period: "month", count: 3, vacant: 2,
        sizeBand: "small", features: ["bath_shared", "tiles"] },
      { kind: "master", price: 150000, period: "month", count: 1, vacant: 0,
        sizeBand: "large", features: ["bath_inside", "own_meter"] },
      { kind: "bedsitter", price: 90000, period: "month", count: 1, vacant: 1,
        sizeBand: "medium", features: ["tiles"] },
    ],
    groups: [{
      key: "rules", title: "Rules & regulations",
      items: [
        { label: "Deposit", value: "Two months up front", note: "" },
        { label: "Visitors", value: "No overnight visitors without telling the landlord", note: "" },
        { label: "Gate", value: "Locked at 10pm", note: "" },
      ],
    }],
  },
};

const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
});

async function open({ lang = "en", fix = null } = {}) {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  // "Failed to load resource: 404" on its own names nothing and is unfixable.
  // The URL is the whole of the information, so it is captured here and the
  // bare console line is dropped as the duplicate it is.
  page.on("response", (r) => {
    if (r.status() >= 400) errs.push(r.status() + " " + r.url());
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/Failed to load resource/i.test(m.text())) return;
    errs.push(m.text().slice(0, 160));
  });
  await page.setViewport({ width: 412, height: 915 });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const u = req.url();
    if (req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*",
        "access-control-allow-methods": "*" } });
    }
    if (!u.startsWith(BASE) && !/^(data|blob|about):/i.test(u)) {
      const kind = req.resourceType();
      if (kind === "image") return req.respond({ status: 200, headers: {
        "content-type": "image/png", "access-control-allow-origin": "*" }, body: PIXEL });
      if (kind === "script") return req.respond({ status: 200, headers: {
        "content-type": "application/javascript", "access-control-allow-origin": "*" },
        body: /maplibre|leaflet/i.test(u) ? MAPLIBRE_STUB : "" });
      if (kind === "stylesheet") return req.respond({ status: 200, headers: {
        "content-type": "text/css", "access-control-allow-origin": "*" }, body: "" });
      return req.respond({ status: 200, headers: {
        "content-type": "application/json", "access-control-allow-origin": "*" }, body: "[]" });
    }
    req.continue();
  });

  await page.evaluateOnNewDocument((lg, fx) => {
    try {
      localStorage.clear();
      localStorage.setItem("lang", lg);
      if (fx) localStorage.setItem("pawa_last_pos",
        JSON.stringify({ lat: fx.lat, lng: fx.lng, accuracy: 20, at: Date.now() }));
    } catch (_) {}
  }, lang, fix);

  let navErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(`${BASE}/houses.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
      navErr = null; break;
    } catch (e) { navErr = e; }
  }
  if (navErr) throw new Error("navigation failed: " + navErr.message);

  // The renderer is pure, so it is driven directly rather than through a map
  // this environment cannot draw. That is the point of it being a library: the
  // sheet is the same object however the pin got tapped.
  await page.waitForFunction(() => !!window.HouseMapSheet, { timeout: 20000 });
  return { page, errs };
}

const sheetText = (page) => page.evaluate(() => document.getElementById("hmsBody").innerText);

// ---------------------------------------------------------------------------
console.log("\n1. The sheet opens and holds the listing");
{
  const { page, errs } = await open({ fix: { lat: -6.8100, lng: 39.2800 } });
  await page.evaluate((h) => window.HouseMapSheet.open(h), HOUSE);
  ok(await page.evaluate(() => window.HouseMapSheet.isOpen()), "it is open");
  const txt = await sheetText(page);
  ok(txt.includes("Nyumba ya Tabata"), "with the title");
  ok(txt.includes("Tabata"), "and where it is");
  ok(/60,000/.test(txt), "and the price");
  // The label is uppercased by CSS, and innerText reports what is on screen.
  ok(/\bfrom\b/i.test(txt),
     "said as a FROM price, because three rooms have three prices", txt.slice(0, 200));
  ok(!/\[object/.test(txt), "and nothing anywhere rendered as [object Object]", txt.slice(0, 300));
  ok(errs.length === 0, "no page errors", errs.slice(0, 3).join(" | "));
  await page.close();
}

console.log("\n2. Where the bathroom is, on its own line, for every room");
{
  const { page } = await open();
  await page.evaluate((h) => window.HouseMapSheet.open(h), HOUSE);
  const facts = await page.$$eval(".hms-room", (rooms) => rooms.map((r) => ({
    name: r.querySelector(".hms-room-h b").textContent.trim(),
    lines: [...r.querySelectorAll(".hms-fact b")].map((b) => b.textContent.trim()),
    unsaid: !!r.querySelector(".hms-fact.is-unsaid"),
  })));
  ok(facts.length === 3, "all three spaces are drawn", JSON.stringify(facts.map((f) => f.name)));
  ok(facts[0].lines.some((l) => /shared/i.test(l)),
     "the single says the bathroom is shared", JSON.stringify(facts[0]));
  ok(facts[1].lines.some((l) => /inside/i.test(l)),
     "the master says it is inside the room", JSON.stringify(facts[1]));
  // THE ONE IT MUST NOT GUESS.
  ok(facts[2].unsaid, "the bedsitter, whose agent never said, is marked as not said");
  ok(facts[2].lines.some((l) => /has not said/i.test(l)),
     "in words, rather than defaulting to the cheaper-sounding answer",
     JSON.stringify(facts[2]));
  await page.close();
}

console.log("\n3. Size is a word with a sentence, not a number nobody measured");
{
  const { page } = await open();
  await page.evaluate((h) => window.HouseMapSheet.open(h), HOUSE);
  const txt = await sheetText(page);
  ok(/Small/.test(txt) && /Medium/.test(txt) && /Large/.test(txt),
     "all three bands appear as the three words a person already owns");
  ok(/bed and a little space/i.test(txt),
     "small carries its clarification", txt.slice(0, 400));
  ok(/wardrobe/i.test(txt), "and so does medium");
  ok(/family/i.test(txt), "and large");
  ok(/photos are the real measure/i.test(txt),
     "with the honest caveat that a band is a bracket, not a survey");
  ok(!/m²/.test(txt), "and no square metres, which is the number that was never measured");
  await page.close();
}

console.log("\n4. What is owed on top of the rent, itemised");
{
  const { page } = await open();
  await page.evaluate((h) => window.HouseMapSheet.open(h), HOUSE);
  const costs = await page.$$eval(".hms-costs li", (els) => els.map((e) => e.innerText.replace(/\n/g, " ")));
  ok(costs.length === 5, "every cost is listed", JSON.stringify(costs));
  ok(costs.some((c) => /Water/.test(c) && /Free/i.test(c)),
     "a cost of ZERO says Free, because that is a fact and one of the best a listing carries",
     JSON.stringify(costs));
  ok(costs.some((c) => /LUKU/.test(c) && /as you use/i.test(c)), "metered says so");
  ok(costs.some((c) => /Security/.test(c) && /5,000/.test(c)), "a priced cost shows its figure");
  ok(costs.some((c) => /Rubbish/.test(c) && /Ask the agent/i.test(c)),
     "and one nobody priced says ask, rather than pretending to be free");
  ok(costs.some((c) => /Key deposit/.test(c) && /once/i.test(c)),
     "a one-off is marked as a one-off, not as a monthly bill");
  await page.close();
}

console.log("\n5. The rules, in the agent's own words, all of them");
{
  const { page } = await open();
  await page.evaluate((h) => window.HouseMapSheet.open(h), HOUSE);
  const rules = await page.$$eval(".hms-rules li", (els) => els.map((e) => e.innerText.replace(/\n/g, " ")));
  ok(rules.length === 3, "all three rules are visible at once, not folded into an accordion",
     JSON.stringify(rules));
  ok(rules.some((r) => /Two months up front/.test(r)), "the deposit, exactly as typed");
  ok(rules.some((r) => /overnight visitors/i.test(r)), "the visitor rule");
  ok(rules.some((r) => /10pm/.test(r)), "and the gate");
}

console.log("\n6. Getting there, with the boxes already filled");
{
  const { page } = await open({ fix: { lat: -6.8100, lng: 39.2800 } });
  await page.evaluate((h) => window.HouseMapSheet.open(h), HOUSE);
  const href = await page.$eval("#hmsDir", (a) => a.getAttribute("href"));
  const q = (k) => new URL(href).searchParams.get(k);
  ok(href.startsWith("https://www.google.com/maps/dir/?api=1"), "a real directions link", href);
  ok(q("destination") === "-6.792400,39.208300", "to the house");
  ok(q("origin") === "-6.810000,39.280000", "from where the app knows you are");
  ok(q("travelmode") === "driving", "with the travel mode set");
  const acts = await page.$$eval(".hms-b", (els) => els.map((e) => e.textContent.trim()));
  ok(acts.some((a) => /full listing/i.test(a)), "the full listing is one tap away", JSON.stringify(acts));
  ok(acts.some((a) => /Call/i.test(a)) && acts.some((a) => /WhatsApp/i.test(a)),
     "and the two the popup already had are still here");
  await page.close();
}

console.log("\n7. It closes, and it speaks Swahili");
{
  const { page, errs } = await open({ lang: "sw" });
  await page.evaluate((h) => window.HouseMapSheet.open(h), HOUSE);
  const txt = await sheetText(page);
  const ENGLISH = ["What you get", "On top of the rent", "Rules and regulations",
                   "Directions in Google Maps", "See the full listing",
                   "The agent has not said", "Ask the agent", "All taken right now"];
  const leaked = ENGLISH.filter((s) => txt.includes(s));
  ok(leaked.length === 0, "no English left in the sheet", leaked.join(" | "));
  ok(/Bafu/.test(txt), "the bathroom fact is in Swahili", txt.slice(0, 300));
  ok(/Kidogo|Wastani|Kubwa/.test(txt), "and so are the size bands");

  await page.evaluate(() => window.HouseMapSheet.close());
  ok(!(await page.evaluate(() => window.HouseMapSheet.isOpen())), "and it closes");
  ok(!(await page.evaluate(() => document.body.classList.contains("hms-open"))),
     "releasing the page behind it, which must be able to scroll again");
  ok(errs.length === 0, "no page errors", errs.slice(0, 3).join(" | "));
  await page.close();
}

console.log("\n8. A listing with no pin gets no directions button, not a broken one");
{
  const { page } = await open();
  await page.evaluate((h) => window.HouseMapSheet.open(Object.assign({}, h, { lat: null, lng: null })), HOUSE);
  ok(await page.$("#hmsDir") === null, "no link at all when there is nowhere to go");
  ok((await sheetText(page)).includes("Nyumba ya Tabata"), "and the rest of the sheet is unaffected");
  await page.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
