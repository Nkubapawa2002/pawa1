// Upload hero/background photos to Supabase storage (site-photos bucket).
// Usage:
//   SUPABASE_SERVICE_ROLE=<service_role_key> node scripts/upload_hero_photos.mjs

import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA  = join(__dir, "..", "data");

const SUPABASE_URL = "https://kkdpacoiwntrcukgwksh.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE;
const BUCKET       = "site-photos";

if (!SERVICE_KEY) {
  console.error("Set SUPABASE_SERVICE_ROLE env var first.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const PHOTOS = [
  { file: "breno-assis-r3WAWU5Fi5Q-unsplash.jpg",   key: "houses-hero.jpg" },
  { file: "maxim-hopman--16na5rDDRk-unsplash.jpg",  key: "meet-hero.jpg"   },
];

async function ensureBucket() {
  const { data: buckets } = await sb.storage.listBuckets();
  if (buckets?.find(b => b.name === BUCKET)) {
    console.log(`bucket "${BUCKET}" already exists`);
    return;
  }
  const { error } = await sb.storage.createBucket(BUCKET, { public: true, fileSizeLimit: 10485760 });
  if (error) throw error;
  console.log(`created public bucket "${BUCKET}"`);
}

await ensureBucket();

for (const { file, key } of PHOTOS) {
  const buf = await readFile(join(DATA, file));
  const { error } = await sb.storage.from(BUCKET).upload(key, buf, {
    contentType: "image/jpeg",
    upsert: true,
  });
  if (error) {
    console.error(` ${key}: ${error.message}`);
  } else {
    const { data } = sb.storage.from(BUCKET).getPublicUrl(key);
    console.log(` ${key}`);
    console.log(`  → ${data.publicUrl}`);
  }
}

console.log("\nCopy the URLs above into index.html, houses.html, and meet.html.");
