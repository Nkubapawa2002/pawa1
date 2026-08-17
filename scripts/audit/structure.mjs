// ============================================================================
//  structure.mjs — static structural audit of the repo.
//
//  Answers, without a browser or a network connection:
//    · which local assets referenced by HTML do not exist on disk
//    · which JS files no page ever loads (dead-code candidates)
//    · which globals are defined in more than one file (collision risk)
//    · which third-party CDN hosts every page depends on
//    · which files exceed the 800-line ceiling in the coding rules
//
//  Read-only. Prints a report and writes audit/structure.json.
//    node scripts/audit/structure.mjs
// ============================================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join, relative, dirname, resolve, extname } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const MAX_LINES = 800; // coding-style.md ceiling
const SKIP_DIRS = new Set([
  "node_modules", ".git", "android", ".mapbuild", "www", "__pycache__", ".temp",
]);

// ---- file walking ----------------------------------------------------------

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
};

const rel = (p) => relative(ROOT, p).replaceAll("\\", "/");
const lineCount = (p) => readFileSync(p, "utf8").split("\n").length;

// ---- reference extraction --------------------------------------------------

const REF_PATTERN = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;

/** In-page anchors and inert schemes reference no file at all — ignore them. */
const isIgnorable = (url) =>
  url.startsWith("#") ||
  url.startsWith("data:") ||
  url.startsWith("mailto:") ||
  url.startsWith("tel:") ||
  url.startsWith("javascript:") ||
  url.trim() === "";

const isExternal = (url) => /^(https?:)?\/\//i.test(url);

/** Every src/href in an HTML file, split into local paths and external URLs. */
const extractRefs = (htmlPath) => {
  const html = readFileSync(htmlPath, "utf8");
  const local = [];
  const external = [];
  for (const [, url] of html.matchAll(REF_PATTERN)) {
    if (isIgnorable(url)) continue;
    if (isExternal(url)) external.push(url);
    else local.push(url.split("?")[0].split("#")[0]);
  }
  return { local, external };
};

const resolveLocal = (htmlPath, url) =>
  url.startsWith("/")
    ? join(ROOT, url.slice(1))
    : join(dirname(htmlPath), url);

// ---- global definition extraction ------------------------------------------

const GLOBAL_PATTERN = /^\s*window\.([A-Za-z_$][\w$]*)\s*=\s*(.*)$/gm;

// Two globals are defined in more than one file ON PURPOSE. Reporting them as
// collisions trains the reader to ignore this check, so they are named here
// with the reason instead.
const INTENTIONAL_DUPLICATES = {
  Auth: "js/core/auth-clerk.js deliberately replaces the Supabase implementation " +
        "in js/core/auth.js with a Clerk-backed one that mirrors its interface. " +
        "It is loaded only when CLERK_ENABLED, so the two never coexist.",
};

const extractGlobals = (jsPath) => {
  const src = readFileSync(jsPath, "utf8");
  return [...src.matchAll(GLOBAL_PATTERN)]
    // `window.X = window.X || …` is a guarded fallback that cannot clobber an
    // existing value — the null-object pattern, not a competing definition.
    .filter(([, name, rhs]) => !new RegExp(`^window\\.${name}\\s*\\|\\|`).test(rhs.trim()))
    .map(([, name]) => name);
};

// ---- checks ----------------------------------------------------------------

const files = walk(ROOT).filter((f) => existsSync(f));
const htmlFiles = files.filter((f) => extname(f) === ".html");
const jsFiles = files.filter((f) => [".js", ".mjs"].includes(extname(f)));

const brokenRefs = [];
const externalHosts = new Map();
const referencedScripts = new Set();

for (const html of htmlFiles) {
  const { local, external } = extractRefs(html);

  for (const url of local) {
    const target = resolveLocal(html, url);
    if (!existsSync(target)) {
      brokenRefs.push({ page: rel(html), ref: url });
    } else if ([".js", ".mjs"].includes(extname(target))) {
      referencedScripts.add(rel(target));
    }
  }

  for (const url of external) {
    const host = url.replace(/^(https?:)?\/\//, "").split("/")[0];
    if (!host) continue;
    if (!externalHosts.has(host)) externalHosts.set(host, new Set());
    externalHosts.get(host).add(rel(html));
  }
}

// Scripts can also be injected at runtime by other scripts, e.g. js/core/config.js
// sets `_ph.src = "js/core/analytics.js"`. Those files appear in no <script src>
// and would be misreported as dead code if we scanned HTML alone.
const DYNAMIC_SRC = /\.src\s*=\s*["'](js\/[^"']+\.js)["']/g;
for (const js of jsFiles) {
  for (const [, target] of readFileSync(js, "utf8").matchAll(DYNAMIC_SRC)) {
    referencedScripts.add(target);
  }
}

// Orphans: page scripts under js/ that nothing loads, statically or dynamically.
// Build/CLI scripts under scripts/ and supabase/ are standalone by design.
const orphanScripts = jsFiles
  .map(rel)
  .filter((p) => p.startsWith("js/"))
  .filter((p) => !referencedScripts.has(p))
  .sort();

// Duplicate globals: the same window.X assigned in more than one file.
const globalOwners = new Map();
for (const js of jsFiles) {
  for (const name of extractGlobals(js)) {
    if (!globalOwners.has(name)) globalOwners.set(name, new Set());
    globalOwners.get(name).add(rel(js));
  }
}
const allDuplicates = [...globalOwners.entries()]
  .filter(([, owners]) => owners.size > 1)
  .map(([name, owners]) => ({ name, files: [...owners].sort() }))
  .sort((a, b) => b.files.length - a.files.length);

const duplicateGlobals = allDuplicates.filter((d) => !INTENTIONAL_DUPLICATES[d.name]);
const acceptedDuplicates = allDuplicates
  .filter((d) => INTENTIONAL_DUPLICATES[d.name])
  .map((d) => ({ ...d, reason: INTENTIONAL_DUPLICATES[d.name] }));

// Oversized files, per the 800-line rule.
const oversized = files
  .filter((f) => [".js", ".mjs", ".html", ".css"].includes(extname(f)))
  .map((f) => ({ file: rel(f), lines: lineCount(f) }))
  .filter((f) => f.lines > MAX_LINES)
  .sort((a, b) => b.lines - a.lines);

// ---- report ----------------------------------------------------------------

const section = (title, rows) => {
  console.log(`\n=== ${title} (${rows.length}) ===`);
  if (!rows.length) console.log("  none");
};

section("BROKEN LOCAL REFERENCES", brokenRefs);
for (const { page, ref } of brokenRefs) console.log(`  ${page}  ->  ${ref}`);

section("ORPHAN PAGE SCRIPTS (in js/, loaded by no page)", orphanScripts);
for (const p of orphanScripts) console.log(`  ${p}`);

section("DUPLICATE GLOBALS", duplicateGlobals);
for (const { name, files: owners } of duplicateGlobals) {
  console.log(`  window.${name}`);
  for (const o of owners) console.log(`      ${o}`);
}

if (acceptedDuplicates.length) {
  console.log(`\n=== INTENTIONAL DUPLICATES, not defects (${acceptedDuplicates.length}) ===`);
  for (const { name, files: owners, reason } of acceptedDuplicates) {
    console.log(`  window.${name}  — ${owners.join(", ")}`);
    console.log(`      ${reason}`);
  }
}

section(`FILES OVER ${MAX_LINES} LINES`, oversized);
for (const { file, lines } of oversized) {
  console.log(`  ${String(lines).padStart(5)}  ${file}`);
}

section("EXTERNAL CDN HOSTS", [...externalHosts]);
for (const [host, pages] of [...externalHosts].sort((a, b) => b[1].size - a[1].size)) {
  console.log(`  ${host}  (${pages.size} page${pages.size === 1 ? "" : "s"})`);
}

console.log(`\n--- totals ---`);
console.log(`  html pages          ${htmlFiles.length}`);
console.log(`  js files            ${jsFiles.length}`);
console.log(`  broken refs         ${brokenRefs.length}`);
console.log(`  orphan scripts      ${orphanScripts.length}`);
console.log(`  duplicate globals   ${duplicateGlobals.length}`);
console.log(`  oversized files     ${oversized.length}`);
console.log(`  external cdn hosts  ${externalHosts.size}`);

const outDir = join(ROOT, "audit");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "structure.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      totals: {
        htmlPages: htmlFiles.length,
        jsFiles: jsFiles.length,
        brokenRefs: brokenRefs.length,
        orphanScripts: orphanScripts.length,
        duplicateGlobals: duplicateGlobals.length,
        oversized: oversized.length,
        externalHosts: externalHosts.size,
      },
      brokenRefs,
      orphanScripts,
      duplicateGlobals,
      oversized,
      externalHosts: Object.fromEntries(
        [...externalHosts].map(([h, pages]) => [h, [...pages].sort()])
      ),
    },
    null,
    2
  )
);
console.log(`\nwrote audit/structure.json`);
