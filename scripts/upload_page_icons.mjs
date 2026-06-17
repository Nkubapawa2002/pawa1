// Upload the houses/services hero icons from data/ to the public "site-photos"
// bucket WITHOUT a service-role key. Same auth model as upload_new_site_photos.mjs:
//   1. connect to Postgres with PG_PASSWORD (env only, never on disk)
//   2. create a temporary RLS policy letting the anon role insert ONLY
//      these exact filenames in the site-photos bucket
//   3. upload via the public anon key
//   4. drop the policy in a finally block, then verify rows in storage.objects
//
// Usage (PowerShell):
//   $env:PG_PASSWORD="<db password>"; node scripts/upload_page_icons.mjs

import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, "..", "data");

const PROJECT_REF = "kkdpacoiwntrcukgwksh";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
// Public anon key — same value already shipped to every browser in js/config.js.
const ANON_KEY = "sb_publishable_qDfG71jBmWEG-JA_Xdh2MA_m6krC_8o";
const BUCKET = "site-photos";

const FILES = ["house-icon.png", "service-icon.png"];

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
    const client = new pg.Client({
      host: c.host, port: c.port, user: c.user, password: PASSWORD,
      database: "postgres", ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000, statement_timeout: 60000,
    });
    try { await client.connect(); console.log("connected "); return client; }
    catch (e) { console.log("fail:", e.code || e.message); try { await client.end(); } catch {} }
  }
  throw new Error("could not connect");
}

const fileList = FILES.map((f) => `'${f}'`).join(", ");
const INS = "tmp_page_icons_ins";

const client = await pickClient();
try {
  const { rows } = await client.query(
    "select id, public from storage.buckets where id = $1", [BUCKET]);
  if (!rows.length) throw new Error(`bucket "${BUCKET}" not found`);
  console.log(`bucket "${BUCKET}" exists (public=${rows[0].public})`);

  // Skip files already uploaded (idempotent re-runs).
  const { rows: existing } = await client.query(
    "select name from storage.objects where bucket_id = $1 and name = any($2)",
    [BUCKET, FILES]);
  const done = new Set(existing.map((r) => r.name));
  const todo = FILES.filter((f) => !done.has(f));
  done.forEach((n) => console.log(`• ${n} — already uploaded, skipping`));

  if (todo.length) {
    // Narrow, temporary upload window: only these exact names, insert only
    // (no upsert — the storage upsert path needs broader update/select grants).
    await client.query(`drop policy if exists ${INS} on storage.objects`);
    await client.query(`
      create policy ${INS} on storage.objects for insert to anon, authenticated
        with check (bucket_id = '${BUCKET}' and name in (${fileList}))`);
    console.log("temporary scoped upload policy created\n");

    const sb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    let fail = 0;
    for (const file of todo) {
      const buf = await readFile(join(DATA, file));
      const { error } = await sb.storage.from(BUCKET).upload(file, buf, {
        contentType: "image/png",
        cacheControl: "31536000",
      });
      if (error) { console.error(` ${file}: ${error.message}`); fail++; }
      else console.log(` ${file} (${(buf.length / 1024).toFixed(0)}KB)`);
    }
    if (fail) throw new Error(`${fail} upload(s) failed`);
  } else {
    console.log("nothing to upload");
  }
} finally {
  // Always close the window, even if uploads failed.
  await client.query(`drop policy if exists ${INS} on storage.objects`);
  console.log("\ntemporary policy dropped — anon uploads closed again");

  const { rows: objs } = await client.query(`
    select name, (metadata->>'size')::bigint as bytes
    from storage.objects
    where bucket_id = '${BUCKET}' and name = any($1)
    order by name`, [FILES]);
  console.log(`\nverified in DB: ${objs.length}/${FILES.length} objects`);
  objs.forEach((o) => console.log(`  ${o.name} — ${(o.bytes / 1024).toFixed(0)}KB`));

  await client.end();
}

console.log(`\nPublic URL pattern: ${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/<filename>`);
