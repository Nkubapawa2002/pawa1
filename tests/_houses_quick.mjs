import puppeteer from "puppeteer";
const browser = await puppeteer.launch({ headless:"new", args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"] });
const page = await browser.newPage();
await page.setViewport({ width:1280, height:900 });
const errs=[];
page.on("pageerror", e=>errs.push("PAGEERROR: "+e.message));
page.on("console", m=>{ if(m.type()==="error") errs.push("CONSOLE: "+m.text()); });
await page.goto("http://localhost:8080/houses.html", { waitUntil:"domcontentloaded", timeout:20000 }).catch(e=>errs.push("GOTO:"+e.message));
await new Promise(r=>setTimeout(r,3000));
const info = await page.evaluate(()=>{
  const out={};
  out.hasMaplibre = typeof window.maplibregl!=="undefined";
  out.hasGlStyle = typeof window.pawaGlHybridStyle==="function";
  const el=document.getElementById("housesMap");
  out.hasContainer=!!el;
  out.canvas = el? el.querySelectorAll("canvas").length : -1;
  const r=el?.getBoundingClientRect();
  out.size = r? {w:Math.round(r.width),h:Math.round(r.height)} : null;
  // try to read maplibre error events if a global map exists
  return out;
});
console.log("info:", JSON.stringify(info));
console.log("errors:", errs.slice(0,8).join("\n  ")||"(none)");
await browser.close();
