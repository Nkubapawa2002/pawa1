// Throwaway viewer: opens the Frame, reads one real area, and photographs
// both the panel and the map so the current design can be judged.
// Run: node tests/_frame_shot.mjs "Mwenge"
//
// Fonts and map tiles are refused and Supabase is answered empty, because those
// are what stall the page load. Overpass and the map libraries are let through
// on purpose — the magnets they return are the thing being looked at.
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
const PLACE = process.argv[2] || "Mwenge";

const browser = await puppeteer.launch({ headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2 });

await page.setRequestInterception(true);
page.on("request", (req) => {
  const u = req.url();
  if (req.method() === "OPTIONS") {
    return req.respond({ status: 204, headers: {
      "access-control-allow-origin": "*", "access-control-allow-headers": "*",
      "access-control-allow-methods": "*" } });
  }
  if (u.startsWith(BASE)) return req.continue();
  if (/fonts\.googleapis|fonts\.gstatic/.test(u)) {
    return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
  }
  if (/arcgisonline|basemaps\.cartocdn|api\.mapbox|tile\.openstreetmap|\.png$|\.jpg$/.test(u)) {
    return req.abort();
  }
  if (/supabase\.co/.test(u)) {
    return req.respond({ status: 200,
      headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
      body: "[]" });
  }
  return req.continue(); // jsDelivr (leaflet/maplibre), Overpass, LocationIQ
});

const errs = [];
page.on("pageerror", (e) => errs.push(String(e.message).split("\n")[0]));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 140)); });

await page.goto(`${BASE}/frame.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => !!document.getElementById("frSearch"), { timeout: 20000 });

await page.type("#frSearch", PLACE);
await page.click("#frSearchBtn");

try {
  await page.waitForFunction(
    () => /\d/.test(document.querySelector(".fr-score-num")?.textContent || ""),
    { timeout: 90000 });
} catch (_) {
  console.log("!! no score rendered within 90s");
}
await new Promise((r) => setTimeout(r, 3000));

const readout = await page.evaluate(() => {
  const t = (s) => (document.querySelector(s)?.textContent || "").replace(/\s+/g, " ").trim();
  return {
    frameName: t(".fr-frame-name"),
    area: t(".fr-frame-area"),
    score: t(".fr-score-num"),
    why: t(".fr-why"),
    cards: [...document.querySelectorAll(".fr-card h3, .fr-layer h3")].map((h) => h.textContent.trim()),
    panelText: (document.getElementById("frPanel")?.innerText || "").slice(0, 1200),
  };
});
console.log(JSON.stringify(readout, null, 2));
console.log("\nERRORS:", errs.slice(0, 6));

await page.screenshot({ path: "tests/_frame_panel.png", fullPage: true });
await page.evaluate(() => document.getElementById("frTabMap")?.click());
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: "tests/_frame_map.png" });

await browser.close();
