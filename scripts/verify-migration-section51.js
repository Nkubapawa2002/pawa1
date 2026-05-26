// Verify section-51 objects exist in Supabase.
const PROJECT_REF = "kkdpacoiwntrcukgwksh";
const PAT = process.env.SUPABASE_PAT;
if (!PAT) { console.error("Set SUPABASE_PAT"); process.exit(1); }

const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
async function q(sql) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  return { status: r.status, body: await r.json() };
}

(async () => {
  const checks = [
    ["table  bus_layout_pending",
      `select column_name, data_type from information_schema.columns
        where table_schema='public' and table_name='bus_layout_pending'
        order by ordinal_position`],
    ["RLS policies on bus_layout_pending",
      `select polname from pg_policy where polrelid='public.bus_layout_pending'::regclass`],
    ["trigger trg_guard_bus_layout_update",
      `select tgname from pg_trigger
        where tgrelid='public.buses'::regclass and tgname='trg_guard_bus_layout_update'`],
    ["function approve_bus_layout",
      `select proname from pg_proc where proname='approve_bus_layout'`],
    ["function reject_bus_layout",
      `select proname from pg_proc where proname='reject_bus_layout'`],
    ["function guard_bus_layout_update",
      `select proname from pg_proc where proname='guard_bus_layout_update'`],
  ];

  for (const [label, sql] of checks) {
    const { status, body } = await q(sql);
    console.log(`\n=== ${label} (HTTP ${status}) ===`);
    console.log(JSON.stringify(body, null, 2));
  }
})().catch(e => { console.error(e); process.exit(1); });
