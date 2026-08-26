// Screenshot the "Set up an area alert" modal at phone + desktop widths.
import puppeteer from "puppeteer";
const URL = "http://localhost:8080/houses.html";
const W = Number(process.argv[2] || 375);
const H = Number(process.argv[3] || 812);
const TAG = process.argv[4] || "phone";

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000 });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 2, isMobile: W < 700, hasTouch: W < 700 });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const u = req.url();
    if (req.method() === "OPTIONS") return req.respond({ status: 204, headers: cors(), body: "" });
    if (u.includes("supabase.co")) {
      return req.respond({ status: 200, headers: { ...cors(), "content-type": "application/json" }, body: "[]" });
    }
    req.continue();
  });
  function cors() { return { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }; }
  await page.goto(URL + "?alert=1", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 7000));
  const state = await page.evaluate(() => {
    const bd = document.getElementById("alertModalBackdrop");
    const m  = document.getElementById("alertModalMap");
    const modal = document.querySelector("#alertModalBackdrop .alert-modal");
    const body = document.querySelector("#alertModalBackdrop .am-body");
    const r = (el) => el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null;
    return { open: bd && !bd.hidden, modal: r(modal), body: r(body), map: r(m),
      bodyScrollH: body ? body.scrollHeight : 0,
      tiles: m ? m.querySelectorAll("img.leaflet-tile").length : 0 };
  });
  console.log(TAG, JSON.stringify(state));
  await page.screenshot({ path: `tests/shot-alert-${TAG}-top.png` });
  await page.evaluate(() => { const b = document.querySelector("#alertModalBackdrop .am-body"); if (b) b.scrollTop = b.scrollHeight; });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `tests/shot-alert-${TAG}-bottom.png` });
  if (errs.length) console.log("errors:\n  " + errs.slice(0, 10).join("\n  "));
} finally { await browser.close(); }
