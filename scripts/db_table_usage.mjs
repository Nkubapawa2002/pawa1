// Read-only usage report of the live Postgres DB.
// For every public base table: disk size, live rows, total scans (seq+idx),
// and write activity. Flags tables that are empty AND never scanned = dead weight.
// Connects like run_sql.mjs (PG_PASSWORD env). Nothing is modified.

import pg from "pg";

const PROJECT_REF = "kkdpacoiwntrcukgwksh";
const PASSWORD = process.env.PG_PASSWORD;
if (!PASSWORD) { console.error("PG_PASSWORD env not set"); process.exit(1); }

const candidates = [
  { label: "direct", host: `db.${PROJECT_REF}.supabase.co`, port: 5432, user: "postgres" },
  { label: "pooler eu-west-1", host: "aws-0-eu-west-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler eu-central-1", host: "aws-0-eu-central-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler us-east-1", host: "aws-0-us-east-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler us-west-1", host: "aws-0-us-west-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler ap-southeast-1", host: "aws-0-ap-southeast-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler ap-south-1", host: "aws-0-ap-south-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler ap-southeast-2", host: "aws-0-ap-southeast-2.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
];

async function pickClient() {
  for (const c of candidates) {
    process.stdout.write(`→ trying ${c.label} (${c.host})... `);
    const client = new pg.Client({
      host: c.host, port: c.port, user: c.user, password: PASSWORD,
      database: "postgres", ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000, statement_timeout: 60000,
    });
    try { await client.connect(); console.log("connected "); return client; }
    catch (e) { console.log("fail:", e.code || e.message); try { await client.end(); } catch {} }
  }
  throw new Error("could not connect via any candidate");
}

const client = await pickClient();

const { rows } = await client.query(`
  select
    s.relname                                   as table_name,
    pg_total_relation_size(c.oid)               as total_bytes,
    pg_size_pretty(pg_total_relation_size(c.oid)) as size,
    s.n_live_tup                                as live_rows,
    coalesce(s.seq_scan,0) + coalesce(s.idx_scan,0) as scans,
    coalesce(s.n_tup_ins,0)                     as inserts,
    coalesce(s.n_tup_upd,0)                     as updates,
    coalesce(s.n_tup_del,0)                     as deletes,
    greatest(coalesce(s.last_autovacuum,'epoch'), coalesce(s.last_vacuum,'epoch')) as last_vac
  from pg_stat_user_tables s
  join pg_class c on c.oid = s.relid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
  order by pg_total_relation_size(c.oid) desc, s.relname;
`);

const pad = (v, n) => String(v).padEnd(n);
console.log("\n=== public table usage (by size) ===");
console.log(pad("table", 30), pad("size", 10), pad("rows", 8), pad("scans", 8), pad("ins", 7), pad("upd", 7), pad("del", 7));
console.log("-".repeat(85));

const dead = [];      // empty AND never scanned AND never written
const emptyButUsed = []; // empty but has been scanned (a real but unused-yet table)
for (const r of rows) {
  console.log(
    pad(r.table_name, 30), pad(r.size, 10), pad(r.live_rows, 8),
    pad(r.scans, 8), pad(r.inserts, 7), pad(r.updates, 7), pad(r.deletes, 7)
  );
  const writes = Number(r.inserts) + Number(r.updates) + Number(r.deletes);
  if (Number(r.live_rows) === 0 && Number(r.scans) === 0 && writes === 0) dead.push(r);
  else if (Number(r.live_rows) === 0) emptyButUsed.push(r);
}

console.log("\n=== DEAD WEIGHT: 0 rows, never scanned, never written ===");
if (!dead.length) console.log("none");
else dead.forEach(r => console.log(`   ${r.table_name.padEnd(30)} ${r.size}`));

console.log("\n=== EMPTY (0 rows) but touched (scanned or written) — unused so far, not dead ===");
if (!emptyButUsed.length) console.log("none");
else emptyButUsed.forEach(r => console.log(`   ${r.table_name.padEnd(30)} ${r.size}  scans=${r.scans} ins=${r.inserts}`));

console.log("\nNote: scan/write counts are since the last stats reset, so a long-lived\nempty+unscanned table is a strong 'safe to drop' signal — but confirm against\nyour app before dropping. Report is read-only; nothing was changed.");
await client.end();
