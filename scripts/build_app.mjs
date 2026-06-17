// Stage the static site into www/ for Capacitor (native Android/iOS builds).
// The repo root IS the website (GitHub Pages), so we copy only what the app
// needs and skip dev/server-side folders. Run before `npx cap sync`:
//   node scripts/build_app.mjs && npx cap sync android
import { cp, rm, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const WWW = join(ROOT, "www");

// Top-level entries to copy. Everything else (node_modules, android, supabase,
// scripts, services, docs, tests, n8n, server files, dotfiles) stays out.
const INCLUDE_DIRS = ["css", "js", "icons", "voice"];
const DATA_DIR = "data"; // copied selectively below (skip _originals backups)

await rm(WWW, { recursive: true, force: true });
await mkdir(WWW, { recursive: true });

// All root HTML pages + manifest + service worker.
const rootEntries = await readdir(ROOT, { withFileTypes: true });
let htmlCount = 0;
for (const e of rootEntries) {
  if (e.isFile() && (/\.html$/i.test(e.name) || ["manifest.json", "service-worker.js"].includes(e.name))) {
    await cp(join(ROOT, e.name), join(WWW, e.name));
    if (/\.html$/i.test(e.name)) htmlCount++;
  }
}

for (const d of INCLUDE_DIRS) {
  await cp(join(ROOT, d), join(WWW, d), { recursive: true });
}

// data/ without the _originals backups.
await mkdir(join(WWW, DATA_DIR), { recursive: true });
for (const e of await readdir(join(ROOT, DATA_DIR), { withFileTypes: true })) {
  if (e.isFile()) await cp(join(ROOT, DATA_DIR, e.name), join(WWW, DATA_DIR, e.name));
}

console.log(`Staged ${htmlCount} pages + ${INCLUDE_DIRS.join(", ")}, ${DATA_DIR}/ into www/`);
