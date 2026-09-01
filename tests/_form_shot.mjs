// Look at the FORM half of a portal page, which normally sits behind the auth
// gate. Stubs the network the way tests/_look_iphonex.mjs does, then just
// unhides the form section and hides the gate.
// Usage: node form_shot.mjs agent-houses.html dark 375 812
import puppeteer from "puppeteer";
const file  = process.argv[2] || "agent-houses.html";
const theme = process.argv[3] || "dark";
const W = Number(process.argv[4] || 375);
const H = Number(process.argv[5] || 812);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const STUB = `(function(){function C(){return new Proxy(function(){},{get:(t,k)=>k===Symbol.toPrimitive||k==="valueOf"||k==="toString"?()=>0:C(),apply:()=>C(),construct:()=>C()})}
window.maplibregl=C();window.L=C();
function q(){const p=Promise.resolve({data:[],error:null});const h=new Proxy(function(){},{get:(t,k)=>k==="then"?p.then.bind(p):k==="catch"?p.catch.bind(p):q(),apply:()=>q()});return h}
window.supabase={createClient:()=>({from:()=>q(),rpc:()=>q(),channel:()=>C(),removeChannel:()=>{},storage:{from:()=>q()},functions:{invoke:()=>Promise.resolve({data:null,error:null})},auth:{getSession:()=>Promise.resolve({data:{session:null}}),getUser:()=>Promise.resolve({data:{user:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:()=>Promise.resolve({})}})};})();`;

const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });
const p = await b.newPage();
await p.setViewport({ width: W, height: H, deviceScaleFactor: 2, isMobile: W < 700, hasTouch: W < 700 });
await p.setRequestInterception(true);
p.on("request", (r) => {
  const u = r.url();
  if (/service-worker\.js/.test(u)) return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: "" });
  if (/cdn\.jsdelivr\.net.*\.css|fonts\.googleapis|fonts\.gstatic/.test(u)) return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
  if (/cdn\.jsdelivr\.net/.test(u)) return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: STUB });
  if (/arcgisonline|basemaps|mapbox|maptiler|openstreetmap|supabase\.co\/storage|\.mp4$/.test(u))
    return r.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
  if (/supabase\.co|locationiq|nominatim|osrm|overpass/.test(u)) return r.respond({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "content-type": "application/json" }, body: "[]" });
  if (/^https?:\/\/(?!localhost)/.test(u)) return r.abort();
  r.continue();
});
const errs = [];
p.on("pageerror", (e) => errs.push("PAGEERROR " + e.message));
p.on("console", (m) => { if (m.type() === "error") errs.push("CONSOLE " + m.text().slice(0, 200)); });
await p.evaluateOnNewDocument((t) => { try { localStorage.setItem("pawa-theme", t); } catch (e) {} }, theme);
await p.goto("http://localhost:8080/" + file, { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 2200));

const prefix = file.startsWith("agent-houses") ? "ah" : "as";
await p.evaluate((pre) => {
  document.getElementById(pre + "AuthCard").hidden = true;
  document.getElementById(pre + "Dashboard").hidden = true;
  const fs = document.getElementById(pre + "FormSection");
  fs.hidden = false;
  // Mount the rail by hand: openForm() is what normally does it, and it needs
  // a signed-in session we do not have here.
  window.AgentPortalRail?.mount({ rail: "#" + pre + "Rail", form: "#" + pre + "Form" });
}, prefix);
await new Promise((r) => setTimeout(r, 900));

// A nine-section form is taller than Chrome's max screenshot texture, so it
// is captured a viewport at a time rather than as one fullPage image.
const base = `tests/_form_${file.replace(/\W+/g, "_")}_${theme}_${W}`;
const total = await p.evaluate(() => document.documentElement.scrollHeight);
const shots = Math.min(8, Math.ceil(total / H));
for (let i = 0; i < shots; i++) {
  await p.evaluate((y) => window.scrollTo(0, y), i * H);
  await new Promise((r) => setTimeout(r, 350));
  await p.screenshot({ path: `${base}_${i}.png` });
}
await p.evaluate(() => window.scrollTo(0, 0));
const out = `${base}_0..${shots - 1}.png (docH ${total})`;
const m = await p.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const over = [...document.querySelectorAll("body *")]
    .map((e) => ({ e, r: e.getBoundingClientRect() }))
    .filter((x) => x.r.width > 0 && (x.r.right > vw + 2 || x.r.left < -2))
    .map((x) => {
      const cls = ((x.e.className && x.e.className.baseVal) || x.e.className || "").toString().trim().split(/\s+/)[0];
      return x.e.tagName.toLowerCase() + (cls ? "." + cls : "") + (x.e.id ? "#" + x.e.id : "") +
             " [" + Math.round(x.r.left) + ".." + Math.round(x.r.right) + "]";
    });
  return { docW: document.documentElement.scrollWidth, vw, innerW: innerWidth, over: over.slice(0, 12) };
});
console.log(out, JSON.stringify(m));
if (errs.length) console.log("ERRORS:\n" + [...new Set(errs)].join("\n"));
else console.log("no page errors");
await b.close();
