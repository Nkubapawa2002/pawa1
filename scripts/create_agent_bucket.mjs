import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE;
const BUCKET = "agent-photos";

if (!URL || !KEY) { console.error("Missing env"); process.exit(1); }

const sb = createClient(URL, KEY, { auth: { persistSession: false } });

const { data: buckets } = await sb.storage.listBuckets();
if (buckets.find(b => b.name === BUCKET)) {
  await sb.storage.updateBucket(BUCKET, { public: true });
  console.log(`✓ ensured "${BUCKET}" exists & public`);
} else {
  const { error } = await sb.storage.createBucket(BUCKET, { public: true });
  if (error) { console.error(error.message); process.exit(1); }
  console.log(`✓ created public bucket "${BUCKET}"`);
}
