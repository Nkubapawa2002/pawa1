// =====================================================================
// rls_anon_probe.mjs — the definitive privacy test.
// Hits the live project with the PUBLIC anon client (no login) and tries to
// read the sensitive tables. RLS is working iff anon sees ZERO rows (or is
// blocked). Any row count > 0 here means PII/money is leaking to the public.
//   node scripts/rls_anon_probe.mjs
// =====================================================================
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL || "https://kkdpacoiwntrcukgwksh.supabase.co";
const ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_qDfG71jBmWEG-JA_Xdh2MA_m6krC_8o";
const sb = createClient(URL, ANON, { auth: { persistSession: false } });

// Tables that must NOT be readable by an anonymous visitor.
const SENSITIVE = [
  "agent_billing", "agent_payments", "payments", "payment_callbacks",
  "admins", "agent_profiles", "house_tenancies", "call_requests",
  "live_locations", "tenant_users", "tenant_settings", "org_expenses",
  "scheduled_reminders", "message_log",
];
// Tables that SHOULD be publicly readable (the directory). Sanity-check they work.
const PUBLIC_OK = ["houses", "services", "trucks", "day_jobs", "regions"];

let leaks = 0;
async function probe(table, expectPublic) {
  const { data, error, count } = await sb.from(table)
    .select("*", { count: "exact", head: false }).limit(1);
  const n = count ?? (data ? data.length : 0);
  if (error) {
    console.log(`  ${expectPublic ? "?" : "✓"} ${table.padEnd(22)} blocked (${error.code || error.message})`);
    return;
  }
  if (expectPublic) {
    console.log(`  ✓ ${table.padEnd(22)} public read OK (${n} visible)`);
  } else if (n > 0) {
    console.log(`  ✗ ${table.padEnd(22)} LEAK — anon can read ${n}+ row(s)!`);
    leaks++;
  } else {
    console.log(`  ✓ ${table.padEnd(22)} 0 rows to anon (protected)`);
  }
}

console.log("\n=== sensitive tables (anon MUST see 0) ===");
for (const t of SENSITIVE) await probe(t, false);
console.log("\n=== public directory tables (anon SHOULD read) ===");
for (const t of PUBLIC_OK) await probe(t, true);

console.log(`\n${"=".repeat(48)}`);
console.log(leaks ? `RESULT: ${leaks} TABLE(S) LEAKING — fix RLS before production!`
                  : "RESULT: no leaks — anon is blocked from every sensitive table ✓");
process.exit(leaks ? 1 : 0);
