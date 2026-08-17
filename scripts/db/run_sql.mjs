// Run a list of .sql files against the Supabase Postgres DB.
// Tries the direct connection first, then the pooler in common AWS regions.
// Reads PG_PASSWORD from env so the secret is never written to disk.

import pg from "pg";
import { readFile } from "node:fs/promises";

const PROJECT_REF = "kkdpacoiwntrcukgwksh";
const PASSWORD = process.env.PG_PASSWORD;
if (!PASSWORD) { console.error("PG_PASSWORD env not set"); process.exit(1); }

const SQL_FILES = process.argv.slice(2);
if (!SQL_FILES.length) { console.error("usage: run_sql.mjs <file>..."); process.exit(1); }

// Candidate connection configs — first one that connects wins.
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
    connectionTimeoutMillis: 8000,
    statement_timeout: 60000
  });
  try {
    await client.connect();
    return client;
  } catch (e) {
    try { await client.end(); } catch {}
    throw e;
  }
}

async function pickClient() {
  for (const c of candidates) {
    process.stdout.write(`→ trying ${c.label} (${c.host})... `);
    try {
      const cli = await tryConnect(c);
      console.log("connected ");
      return cli;
    } catch (e) {
      console.log("fail:", e.code || e.message);
    }
  }
  throw new Error("could not connect via any candidate");
}

const client = await pickClient();

for (const f of SQL_FILES) {
  console.log(`\n=== running ${f} ===`);
  const sql = await readFile(f, "utf8");
  try {
    await client.query(sql);
    console.log(` ${f}`);
  } catch (e) {
    console.error(` ${f}: ${e.message}`);
    if (e.position) console.error(`   at position ${e.position}`);
    await client.end();
    process.exit(1);
  }
}

await client.end();
console.log("\nAll SQL applied successfully.");
