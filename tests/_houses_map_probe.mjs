import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const errors = [];
const tiles = { ok: 0, fail: 0 };
page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("requestfailed", (r) => { if (/arcgisonline|cartocdn|tile/.test(r.url())) tiles.fail++; });
page.on("response", (r) => { if (/arcgisonline|cartocdn/.test(r.url())) (r.ok() ? tiles.ok++ : tiles.fail++); });

await page.goto("http://localhost:8080/houses.html", { waitUntil: "networkidle2", timeout: 30000 }).catch((e) => errors.push("GOTO: " + e.message));
await new Promise((r) => setTimeout(r, 1500));

// scroll the stage into view
await page.evaluate(() => document.getElementById("housesStage")?.scrollIntoView({ block: "center" }));
await new Promise((r) => setTimeout(r, 4000));

const info = await page.evaluate(() => {
  const stage = document.getElementById("housesStage");
  const wrap = document.querySelector(".houses-map-wrap");
  const el = document.getElementById("housesMap");
  const cv = el?.querySelector("canvas");
  const cs = el ? getComputedStyle(el) : null;
  const wcs = wrap ? getComputedStyle(wrap) : null;
  const rect = el?.getBoundingClientRect();
  const crect = cv?.getBoundingClientRect();
  return {
    hasMaplibre: typeof window.maplibregl !== "undefined",
    stageView: stage?.getAttribute("data-view"),
    stageClasses: stage?.className,
    wrapDisplay: wcs?.display,
    mapW: rect ? Math.round(rect.width) : null,
    mapH: rect ? Math.round(rect.height) : null,
    mapDisplay: cs?.display,
    canvas: el ? el.querySelectorAll("canvas").length : "no-el",
    canvasW: crect ? Math.round(crect.width) : null,
    canvasH: crect ? Math.round(crect.height) : null,
  };
});
console.log("info:", JSON.stringify(info, null, 2));
console.log("tiles:", JSON.stringify(tiles));
console.log("errors:", errors.slice(0, 10).join("\n        ") || "(none)");
await page.screenshot({ path: "tests/_shot_houses2.png" });
await browser.close();
