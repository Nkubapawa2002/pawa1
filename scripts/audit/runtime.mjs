// ============================================================================
//  runtime.mjs — load every page in a real browser and record what breaks.
//
//  The static audit proves the files parse and resolve. This one proves the
//  app actually RUNS. It opens each HTML page in headless Chrome and captures:
//    · uncaught exceptions          (pageerror)
//    · console.error / console.warn (console)
//    · failed network requests      (requestfailed)
//    · HTTP 4xx / 5xx responses     (response)
//
//  The point is not the raw count — it is the DEDUPED count. Hundreds of log
//  lines usually come from a handful of root causes repeated across pages, so
//  every finding is fingerprinted and grouped. Fix a fingerprint, kill a bar.
//
//  Findings are classified by blame:
//    ours      — the failure came from our own code or files
//    external  — a third-party CDN/API we do not control
//
//  Read-only. Writes audit/runtime.json.
//    node scripts/audit/runtime.mjs            # all pages
//    node scripts/audit/runtime.mjs houses.html index.html
// ============================================================================
import { readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer";

const ROOT = resolve(import.meta.dirname, "..", "..");
const PORT = 8081;                 // not 8080, so a dev server can stay running
const ORIGIN = `http://localhost:${PORT}`;
const PAGE_TIMEOUT_MS = 20000;
const SETTLE_MS = 2500;            // let deferred/async page code run and throw

// ---- helpers ---------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isOurs = (url = "") => !url || url.startsWith(ORIGIN) || url.startsWith("/");

/** Collapse volatile bits so the same bug reads as one fingerprint. */
const fingerprint = (text = "") =>
  text
    .replace(/https?:\/\/[^\s)"']+/g, "<url>")
    .replace(/\b\d{3,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);

const listPages = () =>
  readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && extname(e.name) === ".html")
    .map((e) => e.name)
    .sort();

// ---- static server ---------------------------------------------------------

const startServer = async () => {
  const server = spawn(process.execPath, ["-e", `
    const http=require('http'),fs=require('fs'),path=require('path');
    const ROOT=${JSON.stringify(ROOT)};
    const MIME={'.html':'text/html','.css':'text/css','.js':'application/javascript',
      '.mjs':'application/javascript','.json':'application/json','.png':'image/png',
      '.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon',
      '.webp':'image/webp','.woff2':'font/woff2','.woff':'font/woff','.wasm':'application/wasm'};
    http.createServer((req,res)=>{
      let p=path.normalize(path.join(ROOT,decodeURIComponent(req.url.split('?')[0])));
      if(p!==ROOT&&!p.startsWith(ROOT+path.sep)){res.writeHead(403);res.end();return;}
      if(p===ROOT||p===ROOT+path.sep)p=path.join(ROOT,'index.html');
      fs.readFile(p,(e,d)=>{
        if(e){res.writeHead(404);res.end('Not found');return;}
        res.writeHead(200,{'Content-Type':MIME[path.extname(p).toLowerCase()]||'application/octet-stream','Cache-Control':'no-cache'});
        res.end(d);
      });
    }).listen(${PORT},()=>console.log('ready'));
  `], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("server did not start")), 10000);
    server.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("ready")) { clearTimeout(timer); resolveReady(); }
    });
    server.on("error", rejectReady);
  });

  return server;
};

// ---- per-page audit --------------------------------------------------------

const auditPage = async (browser, pageName) => {
  const findings = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true });

  const add = (kind, text, source) =>
    findings.push({ kind, text: String(text).slice(0, 500), source: source || "", blame: isOurs(source) ? "ours" : "external" });

  page.on("pageerror", (err) => add("exception", err?.message || String(err), `${ORIGIN}/${pageName}`));

  page.on("console", (msg) => {
    const type = msg.type();
    if (type !== "error" && type !== "warning") return;
    add(type === "error" ? "console.error" : "console.warn", msg.text(), msg.location()?.url);
  });

  page.on("requestfailed", (req) => {
    const reason = req.failure()?.errorText || "failed";
    add("request.failed", `${reason} ${req.url()}`, req.url());
  });

  page.on("response", (res) => {
    if (res.status() >= 400) add("http.error", `HTTP ${res.status()} ${res.url()}`, res.url());
  });

  try {
    await page.goto(`${ORIGIN}/${pageName}`, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    await sleep(SETTLE_MS);
  } catch (err) {
    add("navigation", err?.message || String(err), `${ORIGIN}/${pageName}`);
  }

  await page.close();
  return findings;
};

// ---- main ------------------------------------------------------------------

const requested = process.argv.slice(2);
const pages = requested.length ? requested : listPages();

const server = await startServer();
// protocolTimeout is raised because loading 22 map-heavy pages back to back can
// stall the default 30s CDP budget on a busy machine, which fails the run for
// reasons that have nothing to do with the app.
const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  protocolTimeout: 180000,
});

const byPage = {};
let total = 0;

for (const pageName of pages) {
  const findings = await auditPage(browser, pageName);
  byPage[pageName] = findings;
  total += findings.length;
  const ours = findings.filter((f) => f.blame === "ours").length;
  console.log(`  ${pageName.padEnd(24)} ${String(findings.length).padStart(4)} findings  (${ours} ours)`);
}

await browser.close();
server.kill();

// ---- grouping --------------------------------------------------------------

const groups = new Map();
for (const [pageName, findings] of Object.entries(byPage)) {
  for (const f of findings) {
    const key = `${f.kind}|${fingerprint(f.text)}`;
    if (!groups.has(key)) {
      groups.set(key, { kind: f.kind, blame: f.blame, sample: f.text, pages: new Set(), count: 0 });
    }
    const g = groups.get(key);
    g.pages.add(pageName);
    g.count += 1;
  }
}

const ranked = [...groups.values()]
  .map((g) => ({ ...g, pages: [...g.pages].sort() }))
  .sort((a, b) => b.pages.length - a.pages.length || b.count - a.count);

const oursGroups = ranked.filter((g) => g.blame === "ours");
const externalGroups = ranked.filter((g) => g.blame === "external");

const printGroups = (title, list) => {
  console.log(`\n=== ${title} (${list.length} distinct) ===`);
  for (const g of list.slice(0, 40)) {
    console.log(`\n  [${g.kind}] x${g.count} across ${g.pages.length} page(s)`);
    console.log(`    ${g.sample.slice(0, 200)}`);
    console.log(`    pages: ${g.pages.slice(0, 8).join(", ")}${g.pages.length > 8 ? ", …" : ""}`);
  }
};

console.log(`\n--- totals ---`);
console.log(`  pages audited      ${pages.length}`);
console.log(`  raw findings       ${total}`);
console.log(`  distinct causes    ${ranked.length}`);
console.log(`    ours             ${oursGroups.length}`);
console.log(`    external         ${externalGroups.length}`);

printGroups("OURS — distinct root causes", oursGroups);
printGroups("EXTERNAL — third party / network", externalGroups);

const outDir = join(ROOT, "audit");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "runtime.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      totals: { pages: pages.length, rawFindings: total, distinctCauses: ranked.length,
                ours: oursGroups.length, external: externalGroups.length },
      groups: ranked,
      byPage,
    },
    null,
    2
  )
);
console.log(`\nwrote audit/runtime.json`);
