// Production-readiness DB audit ("spider"). Read-only — reports issues only.
//   PG_PASSWORD=... node scripts/db_spider.mjs
import pg from "pg";
const PASSWORD = process.env.PG_PASSWORD;
if (!PASSWORD) { console.error("PG_PASSWORD not set"); process.exit(1); }
const c = new pg.Client({ host: "aws-0-eu-west-1.pooler.supabase.com", port: 5432,
  user: "postgres.kkdpacoiwntrcukgwksh", password: PASSWORD, database: "postgres",
  ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });

const q = (s, p) => c.query(s, p).then(r => r.rows);
const H = (t) => console.log("\n" + "=".repeat(72) + "\n" + t + "\n" + "=".repeat(72));

await c.connect();

// 1. Tables + RLS status + policy count + anon/auth grants
H("1. TABLES — RLS + policies + role grants (public schema)");
const tables = await q(`
  select t.relname,
    t.relrowsecurity as rls_on, t.relforcerowsecurity as rls_forced,
    (select count(*) from pg_policies p where p.tablename = t.relname and p.schemaname='public') as policies,
    coalesce((select string_agg(distinct g.privilege_type, ',') from information_schema.role_table_grants g
      where g.table_name = t.relname and g.grantee='anon'),'') as anon_grants
  from pg_class t join pg_namespace n on n.oid=t.relnamespace
  where n.nspname='public' and t.relkind='r'
  order by t.relname`);
for (const t of tables) {
  const flags = [];
  if (!t.rls_on) flags.push("⚠ RLS OFF");
  if (t.rls_on && Number(t.policies) === 0) flags.push("⚠ RLS on but 0 policies (locked)");
  if (/select/i.test(t.anon_grants)) flags.push("anon-SELECT");
  console.log(`  ${t.relname.padEnd(26)} rls=${t.rls_on?"on ":"OFF"} pol=${String(t.policies).padStart(2)} anon=[${t.anon_grants}] ${flags.join("  ")}`);
}

// 2. SECURITY DEFINER functions without a pinned search_path
H("2. FUNCTIONS — SECURITY DEFINER hygiene (search_path)");
const fns = await q(`
  select p.proname, p.prosecdef as sec_definer,
    coalesce(array_to_string(p.proconfig,','),'') as config
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' order by p.proname`);
let secDefNoPath = 0;
for (const f of fns) {
  if (f.sec_definer) {
    const hasPath = /search_path/.test(f.config);
    if (!hasPath) { secDefNoPath++; console.log(`  ⚠ ${f.proname}  SECURITY DEFINER, NO search_path`); }
  }
}
console.log(`  (${fns.length} functions; ${fns.filter(f=>f.sec_definer).length} SECURITY DEFINER; ${secDefNoPath} missing search_path)`);

// 3. Views — security_invoker (a view defaults to its OWNER's rights → can leak past RLS)
H("3. VIEWS — security_invoker (else runs as owner, can bypass RLS)");
const views = await q(`
  select c.relname, coalesce(array_to_string(c.reloptions,','),'') as opts
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='v' order by c.relname`);
if (!views.length) console.log("  (none)");
for (const v of views) {
  const inv = /security_invoker=(true|on)/i.test(v.opts);
  console.log(`  ${inv?"ok ":"⚠ "} ${v.relname.padEnd(26)} ${inv?"security_invoker":"NO security_invoker — runs as owner"}`);
}

// 4. Key columns the frontend writes/reads
H("4. KEY COLUMNS present?");
const need = {
  houses: ["available","is_frame","room_kind","region","district","owner_user_id"],
  house_demand_pins: ["region","district","needed_by","needed_from","type","user_id"],
  agent_profiles: ["region","district","ward","user_id"],
  agent_messages: ["to_user_id","read_at","body"],
};
for (const [tbl, cols] of Object.entries(need)) {
  const have = (await q(`select column_name from information_schema.columns where table_schema='public' and table_name=$1`,[tbl])).map(r=>r.column_name);
  const missing = cols.filter(x=>!have.includes(x));
  console.log(`  ${tbl.padEnd(20)} ${missing.length?("⚠ MISSING: "+missing.join(", ")):"ok"}`);
}

// 5. RPCs the frontend calls
H("5. RPCs the frontend calls — present?");
const wantFns = ["house_demand_near","house_demand_in_region","house_demand_for_agent","house_demand_count_near",
  "my_agent_subscription","record_agent_payment","app_uid","is_admin","is_super_admin","touch_updated_at"];
const haveFns = new Set(fns.map(f=>f.proname));
for (const w of wantFns) console.log(`  ${haveFns.has(w)?"ok ":"⚠ MISSING "} ${w}`);

// 6. anon policies that expose data on sensitive tables
H("6. SENSITIVE TABLES — anon SELECT policies (PII exposure check)");
const sensitive = ["agent_profiles","house_demand_pins","agent_messages","agent_billing","agent_payments","house_tenancies","admins"];
for (const tbl of sensitive) {
  const pol = await q(`select policyname, cmd, roles::text, qual from pg_policies where schemaname='public' and tablename=$1`,[tbl]);
  if (!pol.length) { console.log(`  ${tbl}: (no policies / table absent)`); continue; }
  const anonSel = pol.filter(p=>/select|all/i.test(p.cmd) && (/anon/.test(p.roles)||/public/.test(p.roles)||p.roles==='{public}'));
  console.log(`  ${tbl.padEnd(20)} policies=${pol.length} ${anonSel.length?("⚠ "+anonSel.length+" allow anon/public SELECT"):"ok (no broad anon select)"}`);
}

await c.end();
console.log("\nAudit complete.");
