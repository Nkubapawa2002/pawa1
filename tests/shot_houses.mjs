// Screenshot houses.html at a phone width to review the mobile redesign.
import puppeteer from "puppeteer";

const URL = "http://localhost:8080/houses.html";
const W = Number(process.argv[2] || 375);
const H = Number(process.argv[3] || 812);
const TAG = process.argv[4] || "iphone-se";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  protocolTimeout: 120000,
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `tests/shot-${TAG}-collapsed.png`, fullPage: true });
  const opened = await page.evaluate(() => {
    const t = document.querySelector(".hp-fb-toggle");
    if (t) { t.click(); return true; } return false;
  });
  await new Promise((r) => setTimeout(r, 600));
  if (opened) await page.screenshot({ path: `tests/shot-${TAG}-filters.png`, fullPage: true });
  console.log(`${TAG} ${W}x${H}: done; filters=${opened}; errors=${errs.length}`);
  if (errs.length) console.log("  " + errs.slice(0, 6).join("\n  "));
} finally {
  await browser.close();
}
