// Run SQL against the project via the Supabase Management API.
// Usage: SBP_TOKEN=... node tests/_db_sql.mjs "SELECT ...;"
const TOKEN = process.env.SBP_TOKEN;
const REF = "kkdpacoiwntrcukgwksh";
const sql = process.argv[2];
const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: "POST",
  headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
  body: JSON.stringify({ query: sql }),
});
const text = await res.text();
console.log("status", res.status);
try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
