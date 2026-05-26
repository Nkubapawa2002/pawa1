// Run the section-51 migration (bus_layout_pending + trigger + RPCs) via
// the Supabase Management API. One-off — delete after applying.
//
// Usage:
//   SUPABASE_PAT=sbp_... node scripts/run-migration-section51.js

const fs = require("node:fs");
const path = require("node:path");

const PROJECT_REF = "kkdpacoiwntrcukgwksh";
const PAT = process.env.SUPABASE_PAT;
if (!PAT) {
  console.error("Set SUPABASE_PAT in the environment.");
  process.exit(1);
}

const sqlPath = path.join(
  __dirname, "..", "supabase", "_migration_section51.sql"
);
const sql = fs.readFileSync(sqlPath, "utf8");

(async () => {
  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${PAT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  console.log("HTTP", res.status, res.statusText);
  console.log(text);
  if (!res.ok) process.exit(1);
})().catch(err => { console.error(err); process.exit(1); });
