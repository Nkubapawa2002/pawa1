const fs   = require("node:fs");
const path = require("node:path");
const PAT  = process.env.SUPABASE_PAT;
if (!PAT) { console.error("SUPABASE_PAT not set"); process.exit(1); }

// Extract section 54 from schema_master.sql (between the marker and the Done line).
const full = fs.readFileSync(path.join(__dirname, "..", "supabase", "schema_master.sql"), "utf8");
const start = full.indexOf("-- 54. find_next_available_trip");
const end   = full.indexOf("-- Done — 32 tables, 31");
if (start < 0 || end < 0) { console.error("section markers not found"); process.exit(1); }
const sql = full.slice(start, end);

(async () => {
  const r = await fetch("https://api.supabase.com/v1/projects/kkdpacoiwntrcukgwksh/database/query", {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  console.log("HTTP", r.status);
  console.log(await r.text());
})();
