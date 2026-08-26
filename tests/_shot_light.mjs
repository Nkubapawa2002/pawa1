// Look at any page, in either theme, at any width — a one-off eye check, not a
// gate. The gate is mobile_audit.mjs; this exists for "show me what it looks
// like now". Third-party CSS, map tiles, video and Supabase are stubbed so the
// shot never waits on the network. Writes tests/_look_<page>_<theme>.png.
//
// Usage: node server.js   then, in another shell:
//        node tests/_shot_light.mjs index.html            (light, 390px)
//        node tests/_shot_light.mjs explore.html dark 412
import puppeteer from "puppeteer";
const [file, theme, w] = [process.argv[2], process.argv[3] || "light", Number(process.argv[4] || 390)];
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });
const p = await b.newPage();
await p.setViewport({ width: w, height: 900, deviceScaleFactor: 2, isMobile: true });
await p.setRequestInterception(true);
p.on("request", (r) => {
  const u = r.url();
  if (/cdn\.jsdelivr\.net|fonts\.googleapis|fonts\.gstatic/.test(u)) return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
  if (/arcgisonline|basemaps|mapbox|openstreetmap|supabase\.co\/storage|\.mp4$/.test(u))
    return r.respond({ status: 200, headers: { "content-type": "image/png" }, body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") });
  if (/supabase\.co/.test(u)) return r.respond({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
  r.continue();
});
await p.evaluateOnNewDocument((t) => { try { localStorage.setItem("pawa-theme", t); } catch (e) {} }, theme);
await p.goto("http://localhost:8080/" + file, { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 2200));
await p.screenshot({ path: `tests/_look_${file.replace(".html", "")}_${theme}.png` });
console.log("shot", file, theme, w);
await b.close();
