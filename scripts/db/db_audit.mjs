// Read-only audit of the live Postgres DB.
// Lists every public table with: RLS enabled?, # policies, approx row count.
// Flags the dangerous combos. Connects like run_sql.mjs (PG_PASSWORD env).

import pg from "pg";

const PROJECT_REF = "kkdpacoiwntrcukgwksh";
const PASSWORD = process.env.PG_PASSWORD;
if (!PASSWORD) { console.error("PG_PASSWORD env not set"); process.exit(1); }

const candidates = [
  { label: "direct", host: `db.${PROJECT_REF}.supabase.co`, port: 5432, user: "postgres" },
  { label: "pooler us-east-1", host: "aws-0-us-east-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler eu-central-1", host: "aws-0-eu-central-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler eu-west-1", host: "aws-0-eu-west-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler eu-west-2", host: "aws-0-eu-west-2.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
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

// 1. Every base table in public, with RLS flag + policy count + row estimate.
const q = `
  select
    c.relname                              as table_name,
    c.relrowsecurity                       as rls_enabled,
    c.relforcerowsecurity                  as rls_forced,
    coalesce(p.cnt, 0)                     as policy_count,
    coalesce(c.reltuples, 0)::bigint       as est_rows
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join (
    select polrelid, count(*) cnt from pg_policy group by polrelid
  ) p on p.polrelid = c.oid
  where n.nspname = 'public' and c.relkind = 'r'
  order by c.relname;
`;
const { rows } = await client.query(q);

console.log("\n=== public tables ===");
console.log("table".padEnd(34), "RLS".padEnd(5), "forced".padEnd(7), "policies".padEnd(9), "~rows");
const issues = [];
for (const r of rows) {
  console.log(
    r.table_name.padEnd(34),
    String(r.rls_enabled).padEnd(5),
    String(r.rls_forced).padEnd(7),
    String(r.policy_count).padEnd(9),
    String(r.est_rows)
  );
  if (!r.rls_enabled) issues.push(` RLS DISABLED: ${r.table_name} (exposed to anon if anon has grants)`);
  else if (Number(r.policy_count) === 0) issues.push(` RLS ON but NO POLICIES: ${r.table_name} (locked out — no one can read/write)`);
}

console.log("\n=== security flags ===");
if (!issues.length) console.log("none — every table has RLS + at least one policy.");
else issues.forEach(i => console.log(i));

// 2. anon/authenticated grants on tables that have RLS disabled (real exposure).
const { rows: grants } = await client.query(`
  select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon','authenticated')
  group by table_name, grantee
  order by table_name, grantee;
`);
console.log("\n=== anon / authenticated grants ===");
let lastT = "";
for (const g of grants) {
  if (g.table_name !== lastT) { console.log(g.table_name); lastT = g.table_name; }
  console.log(`   ${g.grantee.padEnd(15)} ${g.privs}`);
}

await client.end();
console.log("\nAudit complete (read-only — nothing changed).");
