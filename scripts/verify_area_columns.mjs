// One-off: verify the LIVE database has every column the area-labelling code
// writes to (houses / trucks / day_jobs), and add any that are missing.
// Reads PG_PASSWORD from env so the secret never touches disk.
//
//   PG_PASSWORD=... node scripts/verify_area_columns.mjs
//
// Idempotent: ADD COLUMN IF NOT EXISTS — running it when everything is already
// present is a harmless no-op.

import pg from "pg";

const PROJECT_REF = "kkdpacoiwntrcukgwksh";
const PASSWORD = process.env.PG_PASSWORD;
if (!PASSWORD) { console.error("PG_PASSWORD env not set"); process.exit(1); }

// table -> { column: postgres type } the frontend depends on.
const REQUIRED = {
  houses:   { region: "text", area: "text", district: "text", ward: "text", address: "text" },
  trucks:   { region: "text", area: "text", district: "text", ward: "text" },
  day_jobs: { region: "text", area: "text" },
  agent_profiles: { region: "text", area_of_operations: "text", area_kind: "text", district: "text", ward: "text" },
};

const candidates = [
  { label: "direct (IPv4/IPv6)", host: `db.${PROJECT_REF}.supabase.co`, port: 5432, user: "postgres" },
  { label: "pooler us-east-1", host: "aws-0-us-east-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler eu-central-1", host: "aws-0-eu-central-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler eu-west-1", host: "aws-0-eu-west-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler eu-west-2", host: "aws-0-eu-west-2.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler us-west-1", host: "aws-0-us-west-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler ap-southeast-1", host: "aws-0-ap-southeast-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler ap-south-1", host: "aws-0-ap-south-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler ap-southeast-2", host: "aws-0-ap-southeast-2.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
];

async function tryConnect(cfg) {
  const client = new pg.Client({
    host: cfg.host, port: cfg.port, user: cfg.user,
    password: PASSWORD, database: "postgres",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000, statement_timeout: 60000,
  });
  await client.connect();
  return client;
}

async function pickClient() {
  for (const c of candidates) {
    process.stdout.write(`→ trying ${c.label} (${c.host})... `);
    try { const cli = await tryConnect(c); console.log("connected"); return cli; }
    catch (e) { console.log("fail:", e.code || e.message); }
  }
  throw new Error("could not connect via any candidate");
}

const client = await pickClient();
let added = 0, missingTables = [];

for (const [table, cols] of Object.entries(REQUIRED)) {
  const { rows } = await client.query(
    `select column_name, data_type from information_schema.columns
       where table_schema = 'public' and table_name = $1`, [table]);
  if (!rows.length) {
    console.log(`\n  table public.${table} NOT FOUND — skipping (run its schema file first).`);
    missingTables.push(table);
    continue;
  }
  const have = new Map(rows.map(r => [r.column_name, r.data_type]));
  console.log(`\n=== public.${table} ===`);
  for (const [col, type] of Object.entries(cols)) {
    if (have.has(col)) {
      console.log(`  ✓ ${col} (${have.get(col)})`);
    } else {
      process.stdout.write(`  + adding ${col} ${type}... `);
      await client.query(`alter table public.${table} add column if not exists "${col}" ${type};`);
      console.log("done");
      added++;
    }
  }
}

await client.end();
console.log(`\nDone. ${added} column(s) added.` +
  (missingTables.length ? ` Missing tables: ${missingTables.join(", ")}.` : " Schema matches the code."));
