// One-shot: apply the section-52 migration (trip-reminder calls).
const fs = require("node:fs");
const path = require("node:path");
const PAT = process.env.SUPABASE_PAT;
if (!PAT) { console.error("SUPABASE_PAT not set"); process.exit(1); }
const sql = fs.readFileSync(path.join(__dirname, "..", "supabase", "_migration_section52.sql"), "utf8");
(async () => {
  const r = await fetch("https://api.supabase.com/v1/projects/kkdpacoiwntrcukgwksh/database/query", {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  console.log("HTTP", r.status);
  console.log(await r.text());
})();
