// One-shot runner: applies bus web/supabase/rides_schema.sql to Supabase.
// Reads the DB password from env (PGPASSWORD or SUPABASE_DB_PASSWORD) so it
// never enters argv / shell history. Splits on top-level semicolons but
// preserves $$...$$ blocks so the plpgsql functions inside the schema apply
// cleanly.

const fs   = require("fs");
const path = require("path");
const { Client } = require("pg");

const PASSWORD =
  process.env.PGPASSWORD ||
  process.env.SUPABASE_DB_PASSWORD;

if (!PASSWORD) {
  console.error("Set PGPASSWORD or SUPABASE_DB_PASSWORD before running.");
  process.exit(1);
}

// Project ref pulled from bus web/js/config.js (SUPABASE_URL).
const PROJECT_REF = "kkdpacoiwntrcukgwksh";

// Supabase pooler — works with strict outbound networks. Use the IPv4-friendly
// pooler endpoint (port 6543, transaction mode) by default.
const HOST = process.env.PGHOST || `aws-0-eu-central-1.pooler.supabase.com`;
const PORT = +(process.env.PGPORT || 6543);
const USER = process.env.PGUSER || `postgres.${PROJECT_REF}`;
const DB   = process.env.PGDATABASE || "postgres";

const SCHEMA_FILE = path.resolve(
  __dirname, "..", "supabase", "rides_schema.sql"
);

const sql = fs.readFileSync(SCHEMA_FILE, "utf8");

(async () => {
  const client = new Client({
    host: HOST, port: PORT, user: USER, database: DB, password: PASSWORD,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 60_000,
  });
  console.log(`Connecting → ${USER}@${HOST}:${PORT}/${DB}`);
  await client.connect();
  console.log("Connected. Applying schema…\n");

  try {
    // Run as one transaction so partial failures roll back.
    await client.query("begin");
    await client.query(sql);
    await client.query("commit");
    console.log("\n Schema applied.");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    console.error("\n Failed:", e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
