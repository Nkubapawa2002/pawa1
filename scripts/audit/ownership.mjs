// ============================================================================
//  ownership.mjs — who owns what.
//
//  Before moving a single file we need to know, factually:
//    · which page(s) load each script  -> page-specific vs shared library
//    · which scripts each page loads   -> the page's real dependency set
//    · how the SQL and one-off scripts cluster by topic
//
//  This is the evidence the restructure plan is built on. Read-only.
//    node scripts/audit/ownership.mjs
// ============================================================================
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, extname, basename } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

const htmlPages = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isFile() && extname(e.name) === ".html")
  .map((e) => e.name)
  .sort();

// ---- script ownership ------------------------------------------------------

const SCRIPT_SRC = /<script[^>]+src\s*=\s*["']([^"']+)["']/gi;

// Scripts are also injected at runtime, e.g. js/core/config.js does:
//     _ph.src = "js/core/analytics.js";
// A file loaded only that way has no <script src> anywhere and would look
// orphaned if we scanned HTML alone — which is exactly wrong, since deleting
// or moving it breaks the app silently.
const DYNAMIC_SRC = /\.src\s*=\s*["'](js\/[^"']+\.js)["']/g;

const loadersOf = new Map();   // js path -> Set(loaders: pages or js files)
const scriptsOf = new Map();   // page    -> [js paths]

for (const page of htmlPages) {
  const html = readFileSync(join(ROOT, page), "utf8");
  const local = [...html.matchAll(SCRIPT_SRC)]
    .map(([, src]) => src.split("?")[0])
    .filter((src) => !/^(https?:)?\/\//.test(src))
    .map((src) => src.replace(/^\.?\//, ""));

  scriptsOf.set(page, local);
  for (const src of local) {
    if (!loadersOf.has(src)) loadersOf.set(src, new Set());
    loadersOf.get(src).add(page);
  }
}

// Second pass: runtime-injected scripts, credited to the file that injects them.
const dynamicLoads = [];
if (existsSync(join(ROOT, "js"))) {
  for (const name of readdirSync(join(ROOT, "js")).filter((f) => extname(f) === ".js")) {
    const src = readFileSync(join(ROOT, "js", name), "utf8");
    for (const [, target] of src.matchAll(DYNAMIC_SRC)) {
      dynamicLoads.push({ target, injectedBy: `js/${name}` });
      if (!loadersOf.has(target)) loadersOf.set(target, new Set());
      loadersOf.get(target).add(`js/${name} (runtime)`);
    }
  }
}

const jsFiles = existsSync(join(ROOT, "js"))
  ? readdirSync(join(ROOT, "js")).filter((f) => extname(f) === ".js").map((f) => `js/${f}`).sort()
  : [];

const classify = (src) => {
  const pages = loadersOf.get(src);
  if (!pages || pages.size === 0) return "orphan";
  if (pages.size === 1) return "page-specific";
  if (pages.size >= htmlPages.length * 0.6) return "global-shared";
  return "multi-page";
};

const buckets = { "global-shared": [], "multi-page": [], "page-specific": [], orphan: [] };
for (const src of jsFiles) buckets[classify(src)].push(src);

console.log(`=== RUNTIME-INJECTED SCRIPTS (${dynamicLoads.length}) ===`);
for (const { target, injectedBy } of dynamicLoads) {
  const exists = existsSync(join(ROOT, target));
  console.log(`  ${exists ? "ok  " : "GONE"}  ${target}  <- injected by ${injectedBy}`);
}
console.log();

console.log(`=== SCRIPT OWNERSHIP (${jsFiles.length} files in js/, ${htmlPages.length} pages) ===`);
for (const [bucket, list] of Object.entries(buckets)) {
  console.log(`\n--- ${bucket} (${list.length}) ---`);
  for (const src of list) {
    const pages = [...(loadersOf.get(src) || [])].sort();
    const shown = pages.length > 4 ? `${pages.slice(0, 4).join(", ")} +${pages.length - 4}` : pages.join(", ");
    console.log(`  ${basename(src).padEnd(26)} ${String(pages.length).padStart(2)}  ${shown || "(none)"}`);
  }
}

// ---- SQL clustering --------------------------------------------------------

const sqlDir = join(ROOT, "supabase");
const sqlFiles = existsSync(sqlDir)
  ? readdirSync(sqlDir).filter((f) => extname(f) === ".sql").sort()
  : [];

const TOPICS = [
  ["agent",    /^agent|approve_agent/],
  ["house",    /^house|^setup_house/],
  ["truck",    /^truck/],
  ["service",  /^service/],
  ["job",      /^day_job|^job/],
  ["meet",     /^meet|^fix_meet/],
  ["ride",     /^fix_ride|^ride/],
  ["auth",     /^clerk|^security|auth/],
  ["fix",      /^fix_|^cleanup|^db_production/],
  ["schema",   /^schema|^seed|^audit_and_fix|^migrations?/],
];

const topicOf = (name) => TOPICS.find(([, re]) => re.test(name))?.[0] || "other";
const sqlByTopic = {};
for (const f of sqlFiles) (sqlByTopic[topicOf(f)] ||= []).push(f);

console.log(`\n\n=== SQL FILES BY TOPIC (${sqlFiles.length} in supabase/) ===`);
for (const [topic, list] of Object.entries(sqlByTopic).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${topic.padEnd(10)} ${String(list.length).padStart(3)}  ${list.slice(0, 3).join(", ")}${list.length > 3 ? " …" : ""}`);
}

// ---- one-off scripts -------------------------------------------------------

const scriptsDir = join(ROOT, "scripts");
const scriptFiles = existsSync(scriptsDir)
  ? readdirSync(scriptsDir).filter((f) => [".js", ".mjs", ".py", ".ps1"].includes(extname(f))).sort()
  : [];

const SCRIPT_TOPICS = [
  ["upload",    /^upload|photos/],
  ["migration", /^run-migration|^run_sql|^apply-|^verify-migration/],
  ["verify",    /^verify_|^db_audit|^rls_|^db_table|^db_spider/],
  ["build",     /^build_|^make_|^_compress|^resize|^inject|^wire_/],
  ["media",     /^faststart/],
];
const scriptTopicOf = (n) => SCRIPT_TOPICS.find(([, re]) => re.test(n))?.[0] || "other";
const scriptsByTopic = {};
for (const f of scriptFiles) (scriptsByTopic[scriptTopicOf(f)] ||= []).push(f);

console.log(`\n=== ONE-OFF SCRIPTS BY TOPIC (${scriptFiles.length} in scripts/) ===`);
for (const [topic, list] of Object.entries(scriptsByTopic).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${topic.padEnd(10)} ${String(list.length).padStart(3)}  ${list.slice(0, 3).join(", ")}${list.length > 3 ? " …" : ""}`);
}

const outDir = join(ROOT, "audit");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "ownership.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  pages: htmlPages,
  buckets,
  loadersOf: Object.fromEntries([...loadersOf].map(([k, v]) => [k, [...v].sort()])),
  scriptsOf: Object.fromEntries(scriptsOf),
  sqlByTopic,
  scriptsByTopic,
}, null, 2));
console.log(`\nwrote audit/ownership.json`);
