// ============================================================================
// apply_sql.mjs — run a .sql file (or a one-liner) against the project.
//
// Thin CLI over scripts/db/sql.mjs, which explains the credential and why this
// route exists at all (port 5432 is unreachable from this machine).
//
//   usage:  node scripts/db/apply_sql.mjs supabase/features/message/p_message.sql
//           node scripts/db/apply_sql.mjs --sql "select 1"
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { runSql } from "./sql.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const args = process.argv.slice(2);
const inlineAt = args.indexOf("--sql");
let sql, label;
try {
  sql = inlineAt >= 0 ? args[inlineAt + 1] : readFileSync(join(ROOT, args[0] || ""), "utf8");
  label = inlineAt >= 0 ? "inline SQL" : relative(ROOT, join(ROOT, args[0]));
} catch (err) {
  console.error(`Could not read ${args[0]}: ${err.message}`);
  process.exit(2);
}

if (!sql || !sql.trim()) {
  console.error("Nothing to run. Pass a .sql path or --sql \"…\".");
  process.exit(2);
}

try {
  const rows = await runSql(sql);
  console.log(`OK  ${label}`);
  // Kept short: a migration that returns a thousand rows is not something to
  // page through in a terminal.
  if (rows.length) console.log(JSON.stringify(rows.slice(0, 20), null, 1));
} catch (err) {
  console.error(`FAILED  ${label}`);
  console.error(`        ${err.message}`);
  process.exit(1);
}
