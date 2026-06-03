// Upload every photo in data/ to the Supabase "site-photos" bucket so the
// frontend can serve them from the database instead of the repo.
//
// Keys are the original filenames, so each becomes:
//   https://<project>.supabase.co/storage/v1/object/public/site-photos/<filename>
//
// Usage (PowerShell):
//   $env:SUPABASE_SERVICE_ROLE="<service_role_key>"; node scripts/upload_data_photos.mjs
// Usage (bash):
//   SUPABASE_SERVICE_ROLE=<service_role_key> node scripts/upload_data_photos.mjs

import { createClient } from "@supabase/supabase-js";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA  = join(__dir, "..", "data");

const SUPABASE_URL = "https://kkdpacoiwntrcukgwksh.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE;
const BUCKET       = "site-photos";

const MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png",  ".webp": "image/webp",
};

if (!SERVICE_KEY) {
  console.error("Set SUPABASE_SERVICE_ROLE env var first.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function ensureBucket() {
  const { data: buckets } = await sb.storage.listBuckets();
  if (buckets?.find((b) => b.name === BUCKET)) {
    console.log(`bucket "${BUCKET}" already exists`);
    return;
  }
  const { error } = await sb.storage.createBucket(BUCKET, { public: true, fileSizeLimit: 20971520 });
  if (error) throw error;
  console.log(`created public bucket "${BUCKET}"`);
}

await ensureBucket();

// Every image directly in data/ (skip _originals/ and non-images).
const entries = await readdir(DATA, { withFileTypes: true });
const files = entries
  .filter((e) => e.isFile() && MIME[extname(e.name).toLowerCase()])
  .map((e) => e.name)
  .sort();

console.log(`Uploading ${files.length} image(s) to "${BUCKET}"…\n`);

let ok = 0, fail = 0;
for (const file of files) {
  const buf = await readFile(join(DATA, file));
  const { error } = await sb.storage.from(BUCKET).upload(file, buf, {
    contentType: MIME[extname(file).toLowerCase()],
    upsert: true,
  });
  if (error) {
    console.error(`✗ ${file}: ${error.message}`);
    fail++;
  } else {
    console.log(`✓ ${file}`);
    ok++;
  }
}

console.log(`\nDone — ${ok} uploaded, ${fail} failed.`);
console.log(`Public URL pattern: ${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/<filename>`);
if (fail) process.exit(1);
