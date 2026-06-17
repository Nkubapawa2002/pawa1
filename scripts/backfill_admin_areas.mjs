// One-off backfill: fill region/district/ward on existing houses & trucks that
// have a pin (lat/lng) but no district yet, by reverse-geocoding via LocationIQ.
// New listings populate automatically at registration; this catches old rows.
//
// Needs:  PG_PASSWORD  (DB)  +  LOCATIONIQ_KEY  (an UNrestricted LocationIQ key —
// the client key in js/config.js is domain-locked and will be rejected server-side).
//
//   PG_PASSWORD=… LOCATIONIQ_KEY=… node scripts/backfill_admin_areas.mjs
import pg from "pg";

const PROJECT_REF = "kkdpacoiwntrcukgwksh";
const PASSWORD = process.env.PG_PASSWORD;
const LIQ = process.env.LOCATIONIQ_KEY;
if (!PASSWORD) { console.error("PG_PASSWORD not set"); process.exit(1); }
if (!LIQ)      { console.error("LOCATIONIQ_KEY not set (use an unrestricted key)"); process.exit(1); }

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mapAdmin(a = {}) {
  return {
    region:   a.state || a.region || null,
    district: a.county || a.state_district || a.city_district || a.municipality || a.city || a.town || null,
    ward:     a.suburb || a.quarter || a.neighbourhood || a.ward || a.village || null,
  };
}

async function backfill(table) {
  const { rows } = await client.query(
    `select id, lat, lng from public.${table} where district is null and lat is not null and lng is not null`);
  console.log(`\n${table}: ${rows.length} rows to backfill`);
  let done = 0, failed = 0;
  for (const r of rows) {
    try {
      const url = `https://us1.locationiq.com/v1/reverse?format=json&lat=${r.lat}&lon=${r.lng}&zoom=18&addressdetails=1&key=${encodeURIComponent(LIQ)}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) { failed++; await sleep(700); continue; }
      const j = await res.json();
      const m = mapAdmin(j.address || {});
      await client.query(
        `update public.${table} set district=$2, ward=$3, region=coalesce(region,$4) where id=$1`,
        [r.id, m.district, m.ward, m.region]);
      done++;
      if (done % 10 === 0) process.stdout.write(`  ${done}/${rows.length}\r`);
    } catch (e) { failed++; }
    await sleep(600);   // stay under LocationIQ's free 2 req/s
  }
  console.log(`  ${table}: updated ${done}, failed ${failed}`);
}

await backfill("houses");
await backfill("trucks");
await client.end();
console.log("\nBackfill complete.");
