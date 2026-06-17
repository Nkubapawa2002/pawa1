// Rasterize icons/icon-maskable.svg into the PNG set a PWA + Android app
// needs, and capture manifest screenshots from the local dev server.
//   node scripts/make_icons.mjs            (server must be running on :8080)
import puppeteer from "puppeteer";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ICONS = join(__dir, "..", "icons");

const browser = await puppeteer.launch();
const page = await browser.newPage();
const svg = await readFile(join(ICONS, "icon-maskable.svg"), "utf8");

// purpose:any icons get the same art but on a rounded-square so they don't
// look like a flat slab in launchers that don't mask; maskable stays full-bleed.
async function renderIcon(file, size, { rounded = false, padPct = 0 } = {}) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  const pad = Math.round(size * padPct);
  const inner = size - pad * 2;
  const radius = rounded ? Math.round(size * 0.18) : 0;
  await page.setContent(`<!doctype html><html><body style="margin:0">
    <div style="width:${size}px;height:${size}px;background:transparent;display:flex;align-items:center;justify-content:center">
      <div style="width:${inner}px;height:${inner}px;border-radius:${radius}px;overflow:hidden">${svg.replace('width="512" height="512"', `width="${inner}" height="${inner}"`)}</div>
    </div></body></html>`);
  await page.screenshot({ path: join(ICONS, file), omitBackground: !rounded && padPct > 0 });
  console.log("icon", file, size + "px");
}

await renderIcon("icon-192.png", 192, { rounded: true });
await renderIcon("icon-512.png", 512, { rounded: true });
await renderIcon("icon-maskable-192.png", 192);
await renderIcon("icon-maskable-512.png", 512);
await renderIcon("apple-touch-icon.png", 180);

// Manifest screenshots (richer Android/desktop install sheet).
const shots = [
  { file: "screenshot-wide.png", w: 1280, h: 720, form: "wide" },
  { file: "screenshot-narrow.png", w: 414, h: 896, form: "narrow" },
];
for (const s of shots) {
  await page.setViewport({ width: s.w, height: s.h, deviceScaleFactor: 1 });
  await page.goto("http://localhost:8080/index.html", { waitUntil: "networkidle2", timeout: 45000 });
  await new Promise((r) => setTimeout(r, 2200));
  await page.screenshot({ path: join(ICONS, s.file) });
  console.log("screenshot", s.file, `${s.w}x${s.h}`);
}

await browser.close();
console.log("done");
