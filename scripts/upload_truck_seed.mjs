// One-off: upload the trucks hero + seed truck photos to Supabase Storage.
//   - site-photos/trucks-hero.jpg        (page hero + homepage tile)
//   - truck-photos/seed/{canter,pickup,lorry}.jpg  (data/trucks.json fallback)
// Creates the truck-photos bucket if it doesn't exist yet.
//   SUPABASE_SERVICE_ROLE=<key> node scripts/upload_truck_seed.mjs

import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const TMP = join(__dir, "..", ".tmp_trucks");
const SUPABASE_URL = "https://kkdpacoiwntrcukgwksh.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE;
if (!KEY) { console.error("Set SUPABASE_SERVICE_ROLE"); process.exit(1); }

const sb = createClient(SUPABASE_URL, KEY, { auth: { persistSession: false } });

async function ensureBucket(id) {
  const { data } = await sb.storage.listBuckets();
  if (data?.find((b) => b.name === id)) { console.log(`bucket ${id} exists`); return; }
  const { error } = await sb.storage.createBucket(id, {
    public: true, fileSizeLimit: 20971520,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  });
  if (error) throw error;
  console.log(`created bucket ${id}`);
}

const JOBS = [
  { bucket: "site-photos",  key: "trucks-hero.jpg", file: "hero.jpg" },
  { bucket: "truck-photos", key: "seed/canter.jpg", file: "t1.jpg" },
  { bucket: "truck-photos", key: "seed/pickup.jpg", file: "pickup.jpg" },
  { bucket: "truck-photos", key: "seed/lorry.jpg",  file: "t2.jpg" },
];

await ensureBucket("site-photos");
await ensureBucket("truck-photos");

for (const j of JOBS) {
  const buf = await readFile(join(TMP, j.file));
  const { error } = await sb.storage.from(j.bucket).upload(j.key, buf, {
    contentType: "image/jpeg", upsert: true,
  });
  if (error) console.error(`✗ ${j.bucket}/${j.key}: ${error.message}`);
  else console.log(`✓ ${j.bucket}/${j.key}`);
}
console.log("Done.");
