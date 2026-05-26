// One-shot script: create bus-photos bucket (public) and upload all 10 jpgs.
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE from env vars so the secret
// never gets committed.

import { createClient } from "@supabase/supabase-js";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, basename } from "node:path";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE;
const BUCKET = process.env.BUS_PHOTOS_BUCKET || "bus-photos";
const SRC_DIR = process.env.SRC_DIR;

if (!URL || !KEY || !SRC_DIR) {
  console.error("Missing env vars (SUPABASE_URL, SUPABASE_SERVICE_ROLE, SRC_DIR).");
  process.exit(1);
}

const sb = createClient(URL, KEY, { auth: { persistSession: false } });

async function ensureBucket() {
  const { data: buckets, error } = await sb.storage.listBuckets();
  if (error) throw error;
  if (buckets.find(b => b.name === BUCKET)) {
    console.log(`✓ bucket "${BUCKET}" already exists`);
    // Make sure it's public
    const { error: upErr } = await sb.storage.updateBucket(BUCKET, { public: true });
    if (upErr) console.warn("could not update bucket:", upErr.message);
    return;
  }
  const { error: cErr } = await sb.storage.createBucket(BUCKET, { public: true });
  if (cErr) throw cErr;
  console.log(`✓ created public bucket "${BUCKET}"`);
}

async function uploadAll() {
  const files = (await readdir(SRC_DIR)).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
  if (!files.length) { console.log("No image files found in", SRC_DIR); return; }

  for (const f of files) {
    const buf = await readFile(join(SRC_DIR, f));
    const ext = extname(f).slice(1).toLowerCase();
    const contentType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    const { error } = await sb.storage.from(BUCKET).upload(f, buf, {
      contentType, upsert: true
    });
    if (error) {
      console.error(`✗ ${f}: ${error.message}`);
    } else {
      const { data } = sb.storage.from(BUCKET).getPublicUrl(f);
      console.log(`✓ ${f} → ${data.publicUrl}`);
    }
  }
}

await ensureBucket();
await uploadAll();
console.log("Done.");
