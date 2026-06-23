import puppeteer from "puppeteer";

const PAGES = [
  { url: "http://localhost:8080/houses.html", lib: "maplibre" },
  { url: "http://localhost:8080/area.html",   lib: "leaflet"  },
];

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });

for (const p of PAGES) {
  const page = await browser.newPage();
  const errors = [];
  const tiles = { ok: 0, fail: 0, hosts: new Set() };
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (/arcgisonline|cartocdn|tile|mapbox/.test(u)) { tiles.fail++; tiles.hosts.add(new URL(u).host + " FAILED:" + r.failure()?.errorText); }
  });
  page.on("response", (r) => {
    const u = r.url();
    if (/arcgisonline|cartocdn|tile|mapbox/.test(u)) { (r.ok() ? tiles.ok++ : tiles.fail++); tiles.hosts.add(new URL(u).host + ":" + r.status()); }
  });

  await page.goto(p.url, { waitUntil: "networkidle2", timeout: 25000 }).catch((e) => errors.push("GOTO: " + e.message));
  await new Promise((r) => setTimeout(r, 2500));

  const diag = await page.evaluate((lib) => {
    const out = {};
    out.hasL = typeof window.L !== "undefined";
    out.hasMaplibre = typeof window.maplibregl !== "undefined";
    out.hasAddSat = typeof window.addSatelliteHybrid === "function";
    out.hasGlStyle = typeof window.pawaGlHybridStyle === "function";
    const cands = ["map", "arMap"];
    out.containers = {};
    for (const id of cands) {
      const el = document.getElementById(id);
      if (el) {
        const r = el.getBoundingClientRect();
        out.containers[id] = { w: Math.round(r.width), h: Math.round(r.height), hidden: el.hidden, tiles: el.querySelectorAll("img.leaflet-tile, canvas").length };
      }
    }
    return out;
  }, p.lib).catch((e) => ({ evalError: e.message }));

  console.log("\n==== " + p.url + " ====");
  console.log("diag:", JSON.stringify(diag));
  console.log("tiles:", JSON.stringify({ ok: tiles.ok, fail: tiles.fail, hosts: [...tiles.hosts].slice(0, 8) }));
  console.log("errors:", errors.slice(0, 12).join("\n        ") || "(none)");
  await page.close();
}

await browser.close();
