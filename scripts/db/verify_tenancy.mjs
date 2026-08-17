// One-off check: insert a dummy house_tenancies row in a transaction, read the
// DB-computed end_date, then ROLL BACK (nothing persists). Verifies the
// generated column. Connects like run_sql.mjs.
import pg from "pg";
const PROJECT_REF = "kkdpacoiwntrcukgwksh";
const PASSWORD = process.env.PG_PASSWORD;
if (!PASSWORD) { console.error("PG_PASSWORD env not set"); process.exit(1); }
const candidates = [
  { host: `db.${PROJECT_REF}.supabase.co`, port: 5432, user: "postgres" },
  { host: "aws-0-eu-west-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { host: "aws-0-eu-central-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { host: "aws-0-us-east-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
];
let client;
for (const c of candidates) {
  client = new pg.Client({ ...c, password: PASSWORD, database: "postgres", ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
  try { await client.connect(); break; } catch { try { await client.end(); } catch {} client = null; }
}
if (!client) { console.error("could not connect"); process.exit(1); }
await client.query("begin");
await client.query(`insert into public.house_tenancies (id, customer_name, customer_phone, start_date, months)
  values ('ht-verify-tmp', 'TEST', '+255700000000', date '2026-06-09', 6)`);
const { rows } = await client.query(`select start_date, months, end_date, status, contacted from public.house_tenancies where id='ht-verify-tmp'`);
console.log("inserted row →", rows[0]);
console.log(rows[0].end_date.toISOString().slice(0,10) === "2026-12-09" ? " end_date = start + months (correct)" : " end_date mismatch");
await client.query("rollback");
await client.end();
console.log("rolled back — nothing persisted.");
