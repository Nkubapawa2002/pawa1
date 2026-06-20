// Scale benchmark for the region+district demand→agent match.
// Seeds 1,000,000 synthetic demand rows into a SESSION-TEMP table (auto-dropped,
// touches NO production data), indexes it like house_demand_pins, then times the
// exact match query the RPC runs. Proves the approach holds at millions of rows.
//
//   PG_PASSWORD=... node scripts/bench_demand_match.mjs [rowCount]
import pg from "pg";

const PASSWORD = process.env.PG_PASSWORD;
if (!PASSWORD) { console.error("PG_PASSWORD not set"); process.exit(1); }
const N = Number(process.argv[2] || 1_000_000);

const c = new pg.Client({
  host: "aws-0-eu-west-1.pooler.supabase.com", port: 5432,
  user: "postgres.kkdpacoiwntrcukgwksh", password: PASSWORD, database: "postgres",
  ssl: { rejectUnauthorized: false }, statement_timeout: 300000,
});

const REGIONS = ["Dar es Salaam","Mwanza","Arusha","Dodoma","Mbeya","Tanga","Morogoro","Kilimanjaro",
  "Tabora","Kigoma","Kagera","Mara","Geita","Shinyanga","Singida","Iringa","Ruvuma","Mtwara","Lindi",
  "Pwani","Manyara","Njombe","Katavi","Rukwa","Simiyu","Songwe","Zanzibar Urban","Zanzibar North",
  "Zanzibar South","Pemba North","Pemba South"];        // 31 regions
const DISTRICTS = ["Kinondoni","Ilala","Temeke","Ubungo","Kigamboni","Kibaha","Bagamoyo","Mji Mkongwe"]; // 8

async function main() {
  await c.connect();
  // Size the session temp buffer so the 1M-row temp indexes stay resident — on a
  // REAL persistent table this is shared_buffers (hundreds of MB+), hot across
  // every backend; without this the temp table thrashes and hides true CPU cost.
  await c.query("set temp_buffers = '512MB'");
  console.log(`Seeding ${N.toLocaleString()} synthetic demand rows into a TEMP table…`);

  // Session-temp: auto-dropped when this connection closes (no on-commit-drop,
  // since the driver autocommits each statement in its own txn).
  await c.query(`create temp table demand_bench (
    id text, region text, district text, lat double precision, lng double precision,
    listing text, type text, needed_by date, active boolean, created_at timestamptz
  )`);

  let t = Date.now();
  await c.query(`
    insert into demand_bench (id, region, district, lat, lng, listing, type, needed_by, active, created_at)
    select
      'dp-'||g,
      ($1::text[])[1 + floor(random()*array_length($1::text[],1))::int],
      ($2::text[])[1 + floor(random()*array_length($2::text[],1))::int],
      -6.8 + random()*0.4, 39.1 + random()*0.4,
      case when random() < 0.85 then 'rent' else 'sale' end,
      (array['single room','self-contained','apartment','frame','godown','hostel','shop','office'])[1+floor(random()*8)::int],
      case when random() < 0.6 then current_date + (floor(random()*120))::int else null end,
      random() < 0.97,
      now() - make_interval(days => (random()*200)::int)
    from generate_series(1,$3) g
  `, [REGIONS, DISTRICTS, N]);
  console.log(`  seeded in ${((Date.now()-t)/1000).toFixed(1)}s`);

  // Index exactly like the real table (two partial indexes, infinity-coalesced).
  await c.query(`create index demand_bench_d_idx on demand_bench (lower(region), lower(district), (coalesce(needed_by,'infinity'::date)), created_at desc) where active`);
  await c.query(`create index demand_bench_r_idx on demand_bench (lower(region), (coalesce(needed_by,'infinity'::date)), created_at desc) where active`);
  await c.query(`analyze demand_bench`);

  const total = (await c.query(`select count(*)::int n from demand_bench`)).rows[0].n;
  console.log(`  rows: ${total.toLocaleString()}`);

  // The exact two-slice match the RPC runs: district slice first, region next,
  // each fetched in index order + limited (no post-scan sort), then merged.
  const MATCH = `
    with district_slice as (
      select id, needed_by, created_at, 0 ord, 'district' ml from demand_bench
      where active and lower(region)=lower($1) and lower(district)=lower($2)
        and coalesce(needed_by,'infinity'::date) >= current_date
      order by coalesce(needed_by,'infinity'::date) asc, created_at desc limit 200),
    region_slice as (
      select id, needed_by, created_at, 1 ord, 'region' ml from demand_bench
      where active and lower(region)=lower($1) and lower(district) <> lower($2)
        and coalesce(needed_by,'infinity'::date) >= current_date
      order by coalesce(needed_by,'infinity'::date) asc, created_at desc limit 200)
    select id, ml from (select * from district_slice union all select * from region_slice) x
    order by ord, coalesce(needed_by,'infinity'::date) asc, created_at desc limit 200`;

  // Warm this combo's pages, then measure execution time via EXPLAIN ANALYZE.
  await c.query(MATCH, ["Dar es Salaam", "Kinondoni"]);
  const ex = await c.query(`explain (analyze, buffers, format json) ${MATCH}`, ["Dar es Salaam", "Kinondoni"]);
  const plan = ex.rows[0]["QUERY PLAN"][0];
  console.log(`\nMatch query (Dar es Salaam / Kinondoni), top 200 of ${total.toLocaleString()} rows (warm):`);
  console.log(`  planning time : ${plan["Planning Time"].toFixed(2)} ms`);
  console.log(`  execution time: ${plan["Execution Time"].toFixed(2)} ms`);
  const planStr = JSON.stringify(plan.Plan);
  console.log(`  indexes used  : ${planStr.includes("demand_bench_d_idx") || planStr.includes("demand_bench_r_idx") ? "YES (partial match indexes)" : "no — seq scan"}`);
  console.log(`  seq scan?     : ${planStr.includes('"Node Type":"Seq Scan"') ? "YES (bad)" : "no"}`);
  if (process.env.PLAN) {
    const txt = await c.query(`explain (analyze, buffers) ${MATCH}`, ["Dar es Salaam", "Kinondoni"]);
    console.log("\n  --- plan ---\n" + txt.rows.map((r) => "  " + r["QUERY PLAN"]).join("\n"));
  }

  // Warm the index pages first — a real persistent table keeps hot index pages
  // in shared_buffers across all connections, so steady-state (not the cold
  // first-touch of a brand-new temp table) is what users actually experience.
  for (const reg of REGIONS) for (const d of DISTRICTS) await c.query(MATCH, [reg, d]);

  // DB-side cost across many regions/districts (EXPLAIN ANALYZE reports the
  // database's own execution time, excluding network round-trip latency).
  const ROUNDS = 30;
  let sum = 0, max = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const reg = REGIONS[i % REGIONS.length], dist = DISTRICTS[i % DISTRICTS.length];
    const r = await c.query(`explain (analyze, format json) ${MATCH}`, [reg, dist]);
    const et = r.rows[0]["QUERY PLAN"][0]["Execution Time"];
    sum += et; max = Math.max(max, et);
  }
  console.log(`\n${ROUNDS} matches across different regions/districts (DB execution time):`);
  console.log(`  average: ${(sum/ROUNDS).toFixed(1)} ms   worst: ${max.toFixed(1)} ms`);
  console.log(`  → one Postgres core sustains ~${Math.round(1000/(sum/ROUNDS))} matches/sec; Supabase pools many connections on top.`);

  await c.end();
  console.log("\nTemp table auto-dropped. No production data touched.");
}
main().catch((e) => { console.error(e.message); process.exit(1); });
