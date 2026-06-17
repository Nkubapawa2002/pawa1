// Read-only report of files in Supabase Storage. Lists each bucket with object
// count and total size, plus a per-bucket breakdown. Connects like run_sql.mjs.
import pg from "pg";

const PROJECT_REF = "kkdpacoiwntrcukgwksh";
const PASSWORD = process.env.PG_PASSWORD;
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

const { rows: buckets } = await client.query(
  `select id, public, file_size_limit from storage.buckets order by id;`);

const { rows: stats } = await client.query(`
  select bucket_id,
         count(*)                                            as files,
         pg_size_pretty(coalesce(sum((metadata->>'size')::bigint),0)) as total_size,
         max(created_at)                                     as last_upload
  from storage.objects
  group by bucket_id
  order by bucket_id;
`);
const byBucket = Object.fromEntries(stats.map(s => [s.bucket_id, s]));

console.log("\n=== Storage buckets ===");
console.log("bucket".padEnd(22), "public".padEnd(8), "files".padEnd(7), "size".padEnd(10), "last upload");
console.log("-".repeat(78));
for (const b of buckets) {
  const s = byBucket[b.id] || { files: 0, total_size: "0 bytes", last_upload: null };
  console.log(
    b.id.padEnd(22),
    String(b.public).padEnd(8),
    String(s.files).padEnd(7),
    String(s.total_size).padEnd(10),
    s.last_upload ? new Date(s.last_upload).toISOString().slice(0,10) : "—"
  );
}

// Orphan check: buckets with objects but not declared (shouldn't happen, but show)
const undeclared = stats.filter(s => !buckets.find(b => b.id === s.bucket_id));
if (undeclared.length) {
  console.log("\n(objects in undeclared buckets:)");
  undeclared.forEach(s => console.log(`   ${s.bucket_id}: ${s.files} files, ${s.total_size}`));
}

await client.end();
console.log("\nRead-only — nothing changed.");
