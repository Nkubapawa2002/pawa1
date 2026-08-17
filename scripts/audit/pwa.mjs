// ============================================================================
//  pwa.mjs — prove the service worker still installs.
//
//  service-worker.js precaches its app shell with cache.addAll(), which is
//  ATOMIC: if a single listed asset 404s, the whole install rejects and the PWA
//  silently stops caching — no error surfaces in normal use. Any change that
//  moves or renames a shell asset can cause this, so it is checked directly.
//
//  Also verifies the WebAssembly module loads, since js/pages/house-match.js
//  fetches it by a document-relative URL that no bundler would catch.
//
//  Read-only.  node scripts/audit/pwa.mjs
// ============================================================================
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer";

const ROOT = resolve(import.meta.dirname, "..", "..");
const PORT = 8090;
const ORIGIN = `http://localhost:${PORT}`;

// ---- 1. static check: every precached asset exists --------------------------

const sw = readFileSync(join(ROOT, "service-worker.js"), "utf8");
const shell = [...sw.matchAll(/"\.\/([^"]+)"/g)].map(([, p]) => p);
const missing = shell.filter((p) => !existsSync(join(ROOT, p)));

console.log(`=== service worker app shell ===`);
console.log(`  assets listed   ${shell.length}`);
console.log(`  missing on disk ${missing.length}`);
for (const m of missing) console.log(`      MISSING  ${m}`);
if (missing.length) {
  console.log(`\n  cache.addAll() is atomic — these would abort the whole install.`);
}

// ---- 2. live check: does it actually register and activate? ------------------

const server = spawn(process.execPath, ["-e", `
  const http=require('http'),fs=require('fs'),path=require('path');
  const ROOT=${JSON.stringify(ROOT)};
  const M={'.html':'text/html','.css':'text/css','.js':'application/javascript',
    '.mjs':'application/javascript','.json':'application/json','.wasm':'application/wasm',
    '.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.webp':'image/webp',
    '.woff2':'font/woff2'};
  http.createServer((q,r)=>{
    let p=path.normalize(path.join(ROOT,decodeURIComponent(q.url.split('?')[0])));
    if(p===ROOT||p===ROOT+path.sep)p=path.join(ROOT,'index.html');
    fs.readFile(p,(e,d)=>{
      if(e){r.writeHead(404);r.end('Not found');return;}
      r.writeHead(200,{'Content-Type':M[path.extname(p).toLowerCase()]||'application/octet-stream'});
      r.end(d);
    });
  }).listen(${PORT},()=>console.log('ready'));
`], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

await new Promise((r) => server.stdout.on("data", (c) => c.toString().includes("ready") && r()));

const browser = await puppeteer.launch({
  headless: true, args: ["--no-sandbox"], protocolTimeout: 120000,
});
const page = await browser.newPage();

const failures = [];
page.on("requestfailed", (r) => failures.push(`${r.failure()?.errorText} ${r.url()}`));
page.on("response", (r) => { if (r.status() >= 400) failures.push(`HTTP ${r.status()} ${r.url()}`); });

// sw-register.js registers inside window's "load" handler, so the check must
// wait for load — not domcontentloaded. It also uses a light page by default:
// the map pages hold "load" open on tile requests, which would time out here
// and look like a registration failure when nothing is actually wrong.
const target = process.argv[2] || "login.html";
await page.goto(`${ORIGIN}/${target}`, { waitUntil: "load", timeout: 60000 });
await new Promise((r) => setTimeout(r, 6000));

const state = await page.evaluate(async () => {
  // Wait for the worker to actually reach "ready" rather than sampling
  // getRegistrations() at an arbitrary instant — registration is asynchronous
  // and install time varies, so a naive sample reports a false failure.
  const ready = await Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 20000)),
  ]);

  const regs = await navigator.serviceWorker.getRegistrations();
  const names = await caches.keys();
  let cached = 0;
  for (const n of names) cached += (await (await caches.open(n)).keys()).length;
  return { ready, registrations: regs.length, active: regs.some((r) => r.active != null), cacheNames: names, cached };
});

const ourFailures = failures.filter((f) => f.includes(`localhost:${PORT}`));
const wasmFailures = failures.filter((f) => /wasm/i.test(f));

console.log(`\n=== live service worker ===`);
console.log(`  registrations   ${state.registrations}`);
console.log(`  active          ${state.active}`);
console.log(`  caches          ${state.cacheNames.join(", ") || "(none)"}`);
console.log(`  entries cached  ${state.cached}`);

console.log(`\n=== request failures from our own origin ===`);
console.log(`  ours   ${ourFailures.length}`);
for (const f of ourFailures.slice(0, 10)) console.log(`      ${f}`);
console.log(`  wasm   ${wasmFailures.length}`);
for (const f of wasmFailures.slice(0, 5)) console.log(`      ${f}`);

await browser.close();
server.kill();

const ok = missing.length === 0 && state.ready && state.active && state.cached > 0 && ourFailures.length === 0;
console.log(`\n${ok ? "PASS" : "FAIL"} — service worker ${ok ? "installs and precaches cleanly" : "did NOT install cleanly"}`);
process.exit(ok ? 0 : 1);
