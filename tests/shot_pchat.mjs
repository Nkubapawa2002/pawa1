// ============================================================================
// shot_pchat.mjs — screenshots for the P-Chat tab work.
//
// Two jobs:
//   1. p-chat.html itself, at phone width.
//   2. index.html, as the PROOF that extracting the shared action-card CSS out
//      of its <style> block changed nothing. Shoot it before the change, shoot
//      it after, compare the two files byte for byte.
//
// The CDN (supabase-js) and Google Fonts are unreachable from this machine, so
// both are stubbed — otherwise the page sits on a script timeout and paints
// with a different font. See the memory note "pawa2-browser-test-recipe".
//
//   usage:  node server.js      then, in another shell:
//           node tests/shot_pchat.mjs <suffix>       e.g. "before" / "after"
// ============================================================================
import puppeteer from "puppeteer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:8080";
const TAG = process.argv[2] || "now";
const PAGES = [["index.html", "index"], ["p-chat.html", "pchat"]];
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
const SUPABASE_STUB = `window.supabase = { createClient: function () {
  var noSession = function () { return Promise.resolve({ data: { session: null, user: null }, error: null }); };
  function builder() { var b = {};
    ["select","eq","neq","gt","gte","lt","lte","in","is","or","filter","order","limit","range","match"]
      .forEach(function (m) { b[m] = function () { return b; }; });
    b.then = function (r, j) { return Promise.resolve({ data: [], error: null }).then(r, j); };
    return b; }
  return { from: builder, rpc: function () { return Promise.resolve({ data: null, error: null }); },
    auth: { getSession: noSession, getUser: noSession, signOut: noSession,
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; } },
    storage: { from: function () { return { getPublicUrl: function () { return { data: { publicUrl: "" } }; } }; } },
    channel: function () { return { on: function () { return this; }, subscribe: function () { return this; } }; },
    removeChannel: function () {} };
} };`;

const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
});
try {
  for (const [path, name] of PAGES) {
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 1 });
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = req.url();
      if (req.method() === "OPTIONS") {
        return req.respond({ status: 204, headers: {
          "access-control-allow-origin": "*", "access-control-allow-headers": "*",
          "access-control-allow-methods": "*" } });
      }
      if (/cdn\.jsdelivr\.net.*supabase/.test(url)) {
        return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: SUPABASE_STUB });
      }
      if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)) {
        return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
      }
      if (/arcgisonline|basemaps\.cartocdn|api\.mapbox|tile\.openstreetmap|supabase\.co\/storage|\.mp4$/.test(url)) {
        return req.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
      }
      if (/supabase\.co|router\.project-osrm|nominatim/.test(url)) {
        return req.respond({ status: 200, headers: {
          "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
      }
      req.continue();
    });
    await page.goto(`${BASE}/${path}`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    const file = `tests/shot_${name}_${TAG}.png`;
    await page.screenshot({ path: file, fullPage: true });
    const sum = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
    process.stdout.write(`${file}  sha256:${sum}  errors:${errs.length}` +
      (errs.length ? "\n   " + errs.slice(0, 3).join("\n   ") : "") + "\n");
    await page.close();
  }
} finally {
  await browser.close();
}
