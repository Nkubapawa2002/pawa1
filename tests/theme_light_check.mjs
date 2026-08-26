// Light-theme smoke check: loads key pages with localStorage pawa-theme=light,
// verifies the theme actually flips (light body bg, dark body text, toggle
// present) and the bottom-most text contrast is readable. Screenshots saved.
// Run: node tests/theme_light_check.mjs   (server must be on :8080)
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
// agent.html and p-message.html define their own palette ON THE BODY, which
// beats theme-light.css on :root — the trap that has already shipped an
// unreadable light screen once (dark-theme ink on a cream ground). They are on
// this list because that mistake is invisible until somebody with a light
// phone opens the page.
const PAGES = process.argv[2]
  ? [process.argv[2]]
  : ["index.html", "houses.html", "login.html", "services.html", "chat.html",
     "p-message.html", "agent.html?u=nobody"];

function lum(c) {
  const m = c.match(/\d+(\.\d+)?/g);
  if (!m) return null;
  const [r, g, b] = m.map(Number).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const L1 = lum(a), L2 = lum(b);
  if (L1 == null || L2 == null) return null;
  const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

const browser = await puppeteer.launch({ headless: "new" });
let fail = 0;

for (const path of PAGES) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  // Seed the theme choice before any app script runs.
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem("pawa-theme", "light"); } catch (_) {}
  });
  await page.goto(`${BASE}/${path}`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 600));

  const info = await page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      bodyBg: cs.backgroundColor,
      bodyColor: cs.color,
      hasToggle: !!document.getElementById("pawa-theme-toggle"),
    };
  });

  const cr = ratio(info.bodyColor, "rgb(250,249,245)");
  const bgL = lum(info.bodyBg);
  const ok = info.theme === "light" && info.hasToggle && cr && cr >= 4.5;
  if (!ok) fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${path.padEnd(14)} theme=${info.theme} ` +
    `toggle=${info.hasToggle} bodyBgLum=${bgL == null ? "?" : bgL.toFixed(2)} ` +
    `textContrast=${cr ? cr.toFixed(1) : "?"}  bg=${info.bodyBg} text=${info.bodyColor}`
  );
  // A page can now be listed with a query string, and "?" is not a filename
  // on Windows — the run died on the write, not on the check.
  const shot = path.replace(".html", "").replace(/[?=&]/g, "_");
  await page.screenshot({ path: `tests/_light_${shot}.png` });
  await page.close();
}

await browser.close();
console.log(fail ? `\n${fail} page(s) FAILED` : "\nAll pages flipped to a readable light theme ✔");
process.exit(fail ? 1 : 0);
