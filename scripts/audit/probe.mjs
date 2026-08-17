// ============================================================================
//  probe.mjs — sanity-check that the runtime audit is measuring a REAL page.
//
//  A clean runtime report is only trustworthy if the page genuinely booted:
//  third-party libraries resolved, our own globals attached, and the DOM has
//  content. If the CDN silently failed, every page would look "clean" simply
//  because nothing ever ran. This probe proves which it is.
//
//    node scripts/audit/probe.mjs houses.html
// ============================================================================
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer";

const ROOT = resolve(import.meta.dirname, "..", "..");
const PORT = 8082;
const ORIGIN = `http://localhost:${PORT}`;
const pageName = process.argv[2] || "houses.html";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ["-e", `
  const http=require('http'),fs=require('fs'),path=require('path');
  const ROOT=${JSON.stringify(ROOT)};
  const MIME={'.html':'text/html','.css':'text/css','.js':'application/javascript',
    '.mjs':'application/javascript','.json':'application/json','.png':'image/png',
    '.jpg':'image/jpeg','.svg':'image/svg+xml','.wasm':'application/wasm'};
  http.createServer((req,res)=>{
    let p=path.normalize(path.join(ROOT,decodeURIComponent(req.url.split('?')[0])));
    if(p===ROOT||p===ROOT+path.sep)p=path.join(ROOT,'index.html');
    fs.readFile(p,(e,d)=>{
      if(e){res.writeHead(404);res.end('x');return;}
      res.writeHead(200,{'Content-Type':MIME[path.extname(p).toLowerCase()]||'application/octet-stream'});
      res.end(d);
    });
  }).listen(${PORT},()=>console.log('ready'));
`], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

await new Promise((r) => server.stdout.on("data", (c) => c.toString().includes("ready") && r()));

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();

const loaded = [];
const failed = [];
page.on("response", (res) => {
  const u = res.url();
  if (!u.startsWith(ORIGIN) && res.status() < 400) loaded.push(u);
});
page.on("requestfailed", (req) => failed.push(`${req.failure()?.errorText} ${req.url()}`));

await page.goto(`${ORIGIN}/${pageName}`, { waitUntil: "domcontentloaded", timeout: 30000 });
await sleep(6000);

const state = await page.evaluate(() => ({
  maplibre: typeof window.maplibregl,
  leaflet: typeof window.L,
  supabase: typeof window.supabase,
  appConfig: typeof window.APP_CONFIG,
  i18n: typeof window.I18N ?? typeof window.i18n,
  bodyChars: document.body.innerText.trim().length,
  domNodes: document.querySelectorAll("*").length,
  canvases: document.querySelectorAll("canvas").length,
}));

console.log(`\n=== probe: ${pageName} ===`);
console.log("globals:", state);
console.log(`\nexternal resources loaded OK: ${loaded.length}`);
for (const u of [...new Set(loaded.map((u) => u.split("/").slice(0, 3).join("/")))]) console.log("  " + u);
console.log(`\nfailed requests: ${failed.length}`);
for (const f of failed.slice(0, 10)) console.log("  " + f);

await browser.close();
server.kill();
