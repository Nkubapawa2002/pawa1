// ============================================================================
//  plan-phase2.mjs — generate the Phase 2 move plan (supabase/ and scripts/).
//
//  Phase 2 groups files of the same kind together. The rules live here rather
//  than in a hand-written list so the grouping is reviewable and re-runnable.
//
//    node scripts/restructure/plan-phase2.mjs           # print + write plan
//    node scripts/restructure/move.mjs scripts/restructure/phase2.plan.json
// ============================================================================
import { readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

/** First matching rule wins, so order is significant. */
const SQL_RULES = [
  [/^(schema_master|seed|audit_and_fix)\.sql$/,           "schema"],
  [/^(agent_|fix_approve_agent|remove_demo_agents)/,      "features/agent"],
  [/^(house_|houses_|setup_house)/,                       "features/house"],
  [/^trucks/,                                             "features/truck"],
  [/^services\.sql$/,                                     "features/service"],
  [/^day_jobs\.sql$/,                                     "features/job"],
  [/^(meet_secure|fix_meet_rooms)/,                       "features/meet"],
  [/^fix_ride_realtime\.sql$/,                            "features/ride"],
  [/^(clerk_|security_hardening)/,                        "auth"],
  [/^tenants_helpers/,                                    "tenancy"],
  [/^(admin_areas|regions_seed|gc_orphan_media|reactivate_|remove_legacy|add_extra_costs)/, "ops"],
  [/^(fix_|cleanup_|db_production)/,                      "fixes"],
];

const SCRIPT_RULES = [
  [/^(build_app|make_icons|inject_theme|_compress_new|resize_hero_images|wire_mobile_into_pages|strip_emojis|setup_android_sdk|apply-claude-design)/, "build"],
  [/^(upload_|db_photos|create_agent_bucket)/,            "upload"],
  [/^(db_audit|db_spider|db_table_usage|run_sql|rls_anon_probe|verify_area|verify_registration|verify_tenancy|backfill_admin_areas|bench_demand_match)/, "db"],
  [/^faststart/,                                          "media"],
  [/^(deploy-create-payment|apply-rides-schema)/,         "deploy"],
  [/^(run-migration-section|verify-migration-section)/,    "archive"],
];

const bucketFor = (name, rules) => rules.find(([re]) => re.test(name))?.[1] || null;

const filesIn = (dir, exts) =>
  existsSync(join(ROOT, dir))
    ? readdirSync(join(ROOT, dir), { withFileTypes: true })
        .filter((e) => e.isFile() && exts.includes(extname(e.name)))
        .map((e) => e.name)
        .sort()
    : [];

const moves = [];
const unassigned = [];

for (const name of filesIn("supabase", [".sql"])) {
  const bucket = bucketFor(name, SQL_RULES);
  if (bucket) moves.push({ from: `supabase/${name}`, to: `supabase/${bucket}/${name}` });
  else unassigned.push(`supabase/${name}`);
}

for (const name of filesIn("scripts", [".js", ".mjs", ".py", ".ps1"])) {
  const bucket = bucketFor(name, SCRIPT_RULES);
  if (bucket) moves.push({ from: `scripts/${name}`, to: `scripts/${bucket}/${name}` });
  else unassigned.push(`scripts/${name}`);
}

const byTarget = {};
for (const m of moves) {
  const dir = m.to.split("/").slice(0, -1).join("/");
  (byTarget[dir] ||= []).push(m.from.split("/").pop());
}

console.log("=== Phase 2 plan ===\n");
for (const [dir, list] of Object.entries(byTarget).sort()) {
  console.log(`  ${dir.padEnd(28)} ${String(list.length).padStart(3)}  ${list.slice(0, 3).join(", ")}${list.length > 3 ? " …" : ""}`);
}
console.log(`\n  total moves: ${moves.length}`);
if (unassigned.length) {
  console.log(`\n  LEFT IN PLACE (no rule matched) — ${unassigned.length}:`);
  for (const f of unassigned) console.log(`      ${f}`);
}

const out = join(ROOT, "scripts", "restructure", "phase2.plan.json");
writeFileSync(out, JSON.stringify({ moves }, null, 2));
console.log(`\nwrote ${out.replace(ROOT, "").replace(/\\/g, "/").slice(1)}`);
