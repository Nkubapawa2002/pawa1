import puppeteer from "puppeteer";

const SHOTS = [
  { url: "http://localhost:8080/houses.html", id: "housesMap", out: "tests/_shot_houses.png" },
  { url: "http://localhost:8080/near-me.html", id: "nmMap", out: "tests/_shot_nearme.png" },
];

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
for (const s of SHOTS) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const mapErrors = [];
  await page.evaluateOnNewDocument(() => { window.__mapErrors = []; });
  await page.goto(s.url, { waitUntil: "networkidle2", timeout: 25000 }).catch(() => {});
  // hook maplibre errors after libs load
  await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl") || document.createElement("canvas").getContext("experimental-webgl");
    window.__webgl = !!gl;
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 4000));
  const info = await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    return {
      found: true, w: Math.round(r.width), h: Math.round(r.height),
      webgl: window.__webgl,
      canvas: el.querySelectorAll("canvas").length,
      leafletTiles: el.querySelectorAll("img.leaflet-tile").length,
      imgTiles: el.querySelectorAll("img").length,
    };
  }, s.id);
  console.log(s.url, "->", JSON.stringify(info));
  await page.screenshot({ path: s.out });
  await page.close();
}
await browser.close();
