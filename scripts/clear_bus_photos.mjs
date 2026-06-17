// Clear the legacy `bus-photos` storage bucket (keeps the bucket, empties it).
//
// Step 1 (always): connect via PG_PASSWORD, dump an exact manifest of every
//   object (path + public URL + size) to scripts/bus-photos-manifest.txt so
//   there is a record of what was removed.
// Step 2 (only if SUPABASE_SERVICE_ROLE is set): delete those objects via the
//   Storage API, which removes BOTH the metadata row and the physical S3 file.
//   (Deleting storage.objects rows over SQL would orphan the S3 files.)
//
// Usage:
//   PG_PASSWORD=... node scripts/clear_bus_photos.mjs            # manifest only (dry run)
//   PG_PASSWORD=... SUPABASE_SERVICE_ROLE=... node scripts/clear_bus_photos.mjs   # delete
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { writeFile } from "node:fs/promises";

const PROJECT_REF = "kkdpacoiwntrcukgwksh";
const BUCKET = "bus-photos";
const PASSWORD = process.env.PG_PASSWORD;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE;
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
if (!PASSWORD) { console.error("PG_PASSWORD env not set"); process.exit(1); }

const candidates = [
  { label: "direct", host: `db.${PROJECT_REF}.supabase.co`, port: 5432, user: "postgres" },
  { label: "pooler eu-west-1", host: "aws-0-eu-west-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler eu-central-1", host: "aws-0-eu-central-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler us-east-1", host: "aws-0-us-east-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
];
async function pickClient() {
  for (const c of candidates) {
    process.stdout.write(`→ ${c.label}... `);
    const client = new pg.Client({ host: c.host, port: c.port, user: c.user, password: PASSWORD,
      database: "postgres", ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000, statement_timeout: 60000 });
    try { await client.connect(); console.log("connected "); return client; }
    catch (e) { console.log("fail:", e.code || e.message); try { await client.end(); } catch {} }
  }
  throw new Error("could not connect");
}

const client = await pickClient();
const { rows } = await client.query(
  `select name, coalesce((metadata->>'size')::bigint,0) as size, created_at
   from storage.objects where bucket_id = $1 order by name;`, [BUCKET]);
await client.end();

if (!rows.length) { console.log(`\nbucket "${BUCKET}" is already empty — nothing to do.`); process.exit(0); }

// Manifest (record of what is/was there).
const manifestLines = rows.map(r =>
  `${r.name}\t${r.size}\t${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${r.name}`);
const manifestPath = "scripts/bus-photos-manifest.txt";
await writeFile(manifestPath,
  `# ${BUCKET} manifest — ${new Date().toISOString()}\n# path\tsize_bytes\tpublic_url\n` + manifestLines.join("\n") + "\n");
const totalMB = (rows.reduce((a, r) => a + Number(r.size), 0) / 1048576).toFixed(1);
console.log(`\n${rows.length} objects (${totalMB} MB). Manifest written → ${manifestPath}`);

if (!SERVICE) {
  console.log("\nDRY RUN — SUPABASE_SERVICE_ROLE not set, so NOTHING was deleted.");
  console.log("Re-run with the service_role key to actually delete:");
  console.log("  PG_PASSWORD=... SUPABASE_SERVICE_ROLE=... node scripts/clear_bus_photos.mjs");
  process.exit(0);
}

// Delete in batches via the Storage API (removes physical files too).
const sb = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
const paths = rows.map(r => r.name);
let removed = 0;
for (let i = 0; i < paths.length; i += 100) {
  const batch = paths.slice(i, i + 100);
  const { data, error } = await sb.storage.from(BUCKET).remove(batch);
  if (error) { console.error(" delete failed:", error.message); process.exit(1); }
  removed += (data?.length ?? batch.length);
  console.log(`  removed ${removed}/${paths.length}`);
}
console.log(`\n Cleared ${removed} files from "${BUCKET}". Bucket kept (now empty).`);
