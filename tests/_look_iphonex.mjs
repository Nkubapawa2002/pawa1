// One-off eye check at iPhone X, in BOTH the "app pretends the notch isn't
// there" full 812 viewport and Safari's real visible 635. Not a gate.
// Usage: node tests/_look_iphonex.mjs index.html dark
import puppeteer from "puppeteer";
const file = process.argv[2] || "index.html";
const theme = process.argv[3] || "dark";
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });
async function shot(w, h, tag) {
  const p = await b.newPage();
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await p.setRequestInterception(true);
  p.on("request", (r) => {
    const u = r.url();
    if (/service-worker\.js/.test(u)) return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: "" });
    if (/cdn\.jsdelivr\.net.*\.css|fonts\.googleapis|fonts\.gstatic/.test(u)) return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    if (/cdn\.jsdelivr\.net/.test(u)) return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: STUB });
    if (/arcgisonline|basemaps|mapbox|maptiler|openstreetmap|supabase\.co\/storage|\.mp4$/.test(u))
      return r.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
    if (/supabase\.co|locationiq|nominatim|osrm/.test(u)) return r.respond({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "content-type": "application/json" }, body: "[]" });
    if (/^https?:\/\/(?!localhost)/.test(u)) return r.abort();
    r.continue();
  });
  await p.evaluateOnNewDocument((t) => { try { localStorage.setItem("pawa-theme", t); } catch (e) {} }, theme);
  await p.goto("http://localhost:8080/" + file, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 2500));
  const out = `tests/_x_${file.replace(/\W+/g, "_")}_${theme}_${tag}.png`;
  await p.screenshot({ path: out });
  const m = await p.evaluate(() => ({
    docW: document.documentElement.scrollWidth, winW: innerWidth,
    docH: document.documentElement.scrollHeight, winH: innerHeight,
    wide: [...document.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > innerWidth + 2)
      .slice(0, 6).map((e) => e.tagName.toLowerCase() + "." + ((e.className && e.className.baseVal) || e.className || "").toString().split(" ")[0] + " →" + Math.round(e.getBoundingClientRect().right)),
  }));
  console.log(tag, JSON.stringify(m));
  await p.close();
  return out;
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const STUB = `(function(){function C(){return new Proxy(function(){},{get:(t,k)=>k===Symbol.toPrimitive||k==="valueOf"||k==="toString"?()=>0:C(),apply:()=>C(),construct:()=>C()})}
window.maplibregl=C();window.L=C();
function q(){const p=Promise.resolve({data:[],error:null});const h=new Proxy(function(){},{get:(t,k)=>k==="then"?p.then.bind(p):k==="catch"?p.catch.bind(p):q(),apply:()=>q()});return h}
window.supabase={createClient:()=>({from:()=>q(),rpc:()=>q(),channel:()=>C(),removeChannel:()=>{},storage:{from:()=>q()},functions:{invoke:()=>Promise.resolve({data:null,error:null})},auth:{getSession:()=>Promise.resolve({data:{session:null}}),getUser:()=>Promise.resolve({data:{user:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:()=>Promise.resolve({})}})};})();`;
await shot(375, 812, "full812");
await shot(375, 635, "safari635");
await b.close();
