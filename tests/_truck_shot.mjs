// One-off: screenshot truck.html with a real listing and a carried-in plan.
import puppeteer from "puppeteer";
const BASE = "http://localhost:8080";
const ME = { lat: -6.7724, lng: 39.2083 };
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const TRUCK = {
  id: "t-canter", title: "Kanta ya Mwanga", truck_type: "canter",
  capacity_tonnes: 3, price_tzs: 90000, currency: "TZS", period: "trip",
  negotiable: true, driver_included: true, loaders_included: true, verified: true,
  service_area: "cross_region", region: "Dar es Salaam", area: "Mikocheni",
  lat: -6.79, lng: 39.23, photos: [],
  description: "Tunahamisha nyumba na maduka Dar na mikoani.",
  owner: { name: "Mwanga Movers", phone: "+255700000012" },
  details: { v: 1, kit: ["driver", "loaders", "tarpaulin", "straps", "insured", "receipt", "Tairi mbili za akiba safari ndefu"] },
};
const theme = process.argv[2] || "dark";
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 412, height: 1600 });
await page.setRequestInterception(true);
page.on("request", (req) => {
  const u = req.url();
  if (req.method() === "OPTIONS") return req.respond({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
  if (!u.startsWith(BASE) && !/^(data|blob|about):/i.test(u)) {
    const k = req.resourceType();
    if (k === "image") return req.respond({ status: 200, headers: { "content-type": "image/png", "access-control-allow-origin": "*" }, body: PIXEL });
    if (k === "script") return req.respond({ status: 200, headers: { "content-type": "application/javascript", "access-control-allow-origin": "*" }, body: "" });
    if (k === "stylesheet") return req.respond({ status: 200, headers: { "content-type": "text/css", "access-control-allow-origin": "*" }, body: "" });
    return req.respond({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: "[]" });
  }
  req.continue();
});
await page.evaluateOnNewDocument((t, fix, th) => {
  // js/core/theme.js reads "pawa-theme" before first paint. Setting the
  // attribute here instead would be overwritten by it, and doing so before the
  // stubs below threw on a documentElement that does not exist yet, which
  // silently skipped the fixture and rendered "Truck not found".
  try {
    localStorage.clear();
    localStorage.setItem("lang", "en");
    localStorage.setItem("pawa-theme", th);
    localStorage.setItem("pawa_last_pos", JSON.stringify({ ...fix, at: Date.now() }));
  } catch (_) {}
  let ds; Object.defineProperty(window, "DataStore", { configurable: true, get() { return ds; }, set(v) { ds = v; if (v) v.getTrucks = async () => [t]; } });
  let lo; Object.defineProperty(window, "pawaLocate", { configurable: true, get() { return lo; }, set(v) { lo = v; if (v) { v.best = async () => ({ ...fix, at: Date.now() }); v.bestOrApprox = async () => ({ ...fix, at: Date.now() }); v.lastKnown = () => ({ ...fix, at: Date.now() }); } } });
}, TRUCK, ME, theme);
await page.goto(`${BASE}/truck.html?id=t-canter&to=-6.770000,38.920000&from=-6.772400,39.208300&load=two_bed&toName=Kibaha%2C%20Pwani&toRegion=Pwani`, { waitUntil: "domcontentloaded", timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: `shots/truck_detail_${theme}.png`, fullPage: true });
console.log("shot shots/truck_detail_" + theme + ".png");
await browser.close();
