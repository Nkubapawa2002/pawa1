// Reproduce the mobile_audit viewport exactly (isMobile + hasTouch, which is
// what makes Chrome widen the layout viewport instead of clipping), then name
// every element wider than the screen.
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
const page_path = process.argv[2] || "share-location.html";
const W = parseInt(process.argv[3] || "320", 10);

const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.setRequestInterception(true);
page.on("request", (req) => {
  if (req.method() === "OPTIONS") {
    return req.respond({ status: 204, headers: {
      "access-control-allow-origin": "*", "access-control-allow-headers": "*",
      "access-control-allow-methods": "*" } });
  }
  const u = req.url();
  if (/supabase\.co|tile|locationiq|openstreetmap|fonts\.g/.test(u)) {
    return req.respond({ status: 200, headers: { "content-type": "application/json" }, body: "{}" });
  }
  req.continue();
});
await page.goto(`${BASE}/${page_path}`, { waitUntil: "domcontentloaded", timeout: 45000 });
await new Promise((r) => setTimeout(r, 2500));

const out = await page.evaluate((screenW) => {
  const res = {
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScroll: document.body.scrollWidth,
    screenW,
    offenders: [],
  };
  const name = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    if (el.className && typeof el.className === "string") {
      s += "." + el.className.trim().split(/\s+/).slice(0, 3).join(".");
    }
    return s;
  };
  document.querySelectorAll("*").forEach((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // What actually forces a wider layout: a box that is wider than the screen,
    // or a min-width that cannot shrink below it.
    const minW = parseFloat(cs.minWidth) || 0;
    if (r.width > screenW + 1 || minW > screenW + 1 || r.right > screenW + 1 || el.scrollWidth > el.clientWidth + 1) {
      res.offenders.push({
        el: name(el),
        w: Math.round(r.width),
        right: Math.round(r.right),
        minWidth: cs.minWidth,
        width: cs.width,
        ws: cs.whiteSpace, scrollW: el.scrollWidth, clientW: el.clientWidth, left: Math.round(r.left),
        display: cs.display,
      });
    }
  });
  return res;
}, W);

console.log(`${page_path} at ${W}px`);
console.log(`  innerWidth=${out.innerWidth}  scrollWidth=${out.scrollWidth}  bodyScroll=${out.bodyScroll}`);
console.log(`  offenders (${out.offenders.length}):`);
// Deepest/narrowest first is noise; show the widest, which is usually the cause.
out.offenders.sort((a, b) => b.w - a.w).slice(0, 15).forEach((o) => {
  console.log(`    ${o.el}`);
  console.log(`        left=${o.left} w=${o.w} right=${o.right} scrollW=${o.scrollW} clientW=${o.clientW} min-width=${o.minWidth} ws=${o.ws} display=${o.display}`);
});

await browser.close();
