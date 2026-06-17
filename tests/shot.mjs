// Screenshots: jobs board, signup form, admin header area (panel forced).
import puppeteer from "puppeteer";
const BASE = "http://localhost:8080";
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });

async function shoot(path, name, prep) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  try {
    await page.goto(`${BASE}/${path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 3000));
    if (prep) await page.evaluate(prep);
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: `tests/shot_${name}.png` });
    console.log(` tests/shot_${name}.png`);
  } catch (e) { console.log(` ${path}: ${e.message}`); }
  await page.close();
}

await shoot("jobs.html", "jobs");
await shoot("signup.html", "signup");
await shoot("admin.html", "admin", () => {
  document.getElementById("loginGate").hidden = true;
  document.getElementById("adminPanel").hidden = false;
  document.getElementById("adminEmail").textContent = "admin@example.com";
  document.getElementById("djSummary").innerHTML =
    `<div class="aa-stat"><div class="num">5</div><div class="lbl">Jobs posted</div></div>`;
});
await browser.close();
