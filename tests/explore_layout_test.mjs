// ============================================================================
//  explore_layout_test.mjs — the rearranged Explore controls.
//
//  Explore used to stack six full-width controls before a single result, three
//  of which asked "where" in three different vocabularies:
//
//      place input    "Anywhere in Tanzania"
//      region select  "All of Tanzania"
//      radius select  "Anywhere"
//
//  They are one WHERE bar and one sheet now. Collapsing controls is only an
//  improvement if the page still SAYS what it is doing, so most of this file
//  is about the summary sentence telling the truth rather than about layout.
//
//  Run: node server.js   then:  node tests/explore_layout_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); return; }
  fails.push(detail ? msg + "\n        got: " + detail : msg);
};
const section = (s) => console.log("\n" + s);

const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });
const p = await b.newPage();
await p.setViewport({ width: 390, height: 900, deviceScaleFactor: 2, isMobile: true });

const errs = [];
p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
await p.setRequestInterception(true);
p.on("request", (r) => {
  const u = r.url();
  if (/cdn\.jsdelivr\.net|fonts\./.test(u))
    return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
  if (/^http:\/\/localhost:8080\//.test(u)) return r.continue();
  return r.abort();   // no third-party network in a layout test
});
await p.goto("http://localhost:8080/explore.html", { waitUntil: "domcontentloaded" });
await wait(2500);

// ---------------------------------------------------------------------------
section("1. The chrome is two rows, not six");
const shape = await p.evaluate(() => ({
  sheetHidden: document.getElementById("xpWhereSheet").hidden,
  expanded: document.getElementById("xpWhereBtn").getAttribute("aria-expanded"),
  sameRow: (() => {
    const a = document.querySelector(".xp-where-sum"), n = document.getElementById("xpNear");
    return Math.abs(a.getBoundingClientRect().top - n.getBoundingClientRect().top) < 4;
  })(),
  sortInBar: !!document.querySelector(".xp-status-r #xpSort"),
  // The three "where" controls exist but are inside the sheet, not loose.
  inSheet: ["xpPlace", "xpRegion", "xpRadius"]
    .every((id) => document.getElementById("xpWhereSheet").contains(document.getElementById(id))),
  oldRows: !!document.querySelector(".xp-controls, .xp-row2"),
}));
ok(shape.sheetHidden && shape.expanded === "false", "the WHERE sheet starts closed, and says so");
ok(shape.sameRow, "WHERE and Near me share one row at 390px");
ok(shape.inSheet, "place, region and radius all live inside the sheet");
ok(shape.sortInBar, "sort moved to the results bar, beside the count it reorders");
ok(!shape.oldRows, "the old two-row control block is gone");

// ---------------------------------------------------------------------------
section("2. The summary says what the page is actually doing");
const read = () => p.evaluate(() => document.getElementById("xpWhereVal").textContent.trim());
ok((await read()) === "Anywhere in Tanzania", "with nothing set it says so plainly", await read());

await p.evaluate(() => document.getElementById("xpWhereBtn").click());
await wait(300);
ok(await p.evaluate(() => !document.getElementById("xpWhereSheet").hidden),
   "tapping WHERE opens the sheet");

// A region alone. Radius is still 0, so the sentence must NOT invent one.
await p.evaluate(() => {
  const r = document.getElementById("xpRegion");
  r.value = [...r.options].map((o) => o.value).find(Boolean);
  r.dispatchEvent(new Event("change", { bubbles: true }));
});
await wait(900);
const withRegion = await read();
ok(withRegion && withRegion !== "Anywhere in Tanzania", "picking a region rewrites it", withRegion);
ok(!/\bkm\b/.test(withRegion), "and with no radius set it does not invent one", withRegion);

// Now a radius on top of it.
await p.evaluate(() => {
  const r = document.getElementById("xpRadius");
  r.value = "25";
  r.dispatchEvent(new Event("change", { bubbles: true }));
});
await wait(900);
const withRadius = await read();
ok(/25 km/.test(withRadius), "adding a radius qualifies the place rather than replacing it", withRadius);
ok(withRadius.startsWith(withRegion.split(",")[0]), "the place stays first in the sentence", withRadius);

await p.evaluate(() => document.getElementById("xpWhereDone").click());
await wait(250);
ok(await p.evaluate(() => document.getElementById("xpWhereSheet").hidden),
   "Done closes the sheet, and the summary survives it");
ok(/25 km/.test(await read()), "the sentence is still there once the controls are hidden", await read());

// ---------------------------------------------------------------------------
section("3. The empty state does not blame a search nobody made");
// Nothing was typed and no listing loaded (this test blocks the network), so
// "try fewer words" would be advice about words that do not exist.
await p.goto("http://localhost:8080/explore.html", { waitUntil: "domcontentloaded" });
await wait(2500);
const empty = await p.evaluate(() => ({
  t: (document.getElementById("xpEmptyT") || {}).textContent,
  pp: (document.getElementById("xpEmptyP") || {}).textContent,
  widen: (document.getElementById("xpWiden") || {}).hidden,
}));
ok(!/fewer words/i.test(empty.pp || ""), "it does not tell you to type fewer words", empty.pp);
ok(/nothing to show|hakuna cha kuonyesha/i.test(empty.t || ""), "it says nothing has loaded", empty.t);
ok(empty.widen === true, "and hides a widen button that would search the same nothing");

ok(errs.length === 0, "no page errors", errs.slice(0, 3).join(" | "));

// ---------------------------------------------------------------------------
console.log("");
fails.forEach((f) => console.log("  FAIL  " + f));
console.log("\n" + pass + " passed, " + fails.length + " failed\n");
await b.close();
process.exit(fails.length ? 1 : 0);
