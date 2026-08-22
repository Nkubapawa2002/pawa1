// ============================================================================
// sql.mjs — run SQL against the project over HTTPS (Supabase Management API).
//
// Port 5432 is unreachable from the machine this project is developed on, so
// node-postgres can never connect. The Management API can: it takes SQL over
// 443 and runs it as `postgres`, DDL included. The service_role key is not an
// alternative — PostgREST does not execute DDL.
//
// The credential is a Supabase Personal Access Token, read from .env as
// PERSONAL_ACCESS_TOKEN (not SUPABASE_ACCESS_TOKEN — the name matters). .env
// is gitignored. A PAT is account-level, so revoke it at
// supabase.com/dashboard/account/tokens when a batch of work is done.
//
// Used by scripts/db/apply_sql.mjs and by tests that need to act as a specific
// signed-in user (see asUser below).
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PROJECT_REF = "kkdpacoiwntrcukgwksh";

let cached = null;
export function token() {
  if (cached) return cached;
  const fromEnv = process.env.PERSONAL_ACCESS_TOKEN || process.env.SUPABASE_PAT;
  if (fromEnv) return (cached = fromEnv.trim());
  let raw = "";
  try { raw = readFileSync(join(ROOT, ".env"), "utf8"); } catch (_) { /* fall through */ }
  const hit = raw.match(/^\s*(?:PERSONAL_ACCESS_TOKEN|SUPABASE_PAT)\s*=\s*(.+)\s*$/m);
  if (!hit) throw new Error("No PERSONAL_ACCESS_TOKEN in .env (or the environment).");
  return (cached = hit[1].trim().replace(/^["']|["']$/g, ""));
}

/**
 * Run SQL. Returns the rows of the LAST statement, as the API does.
 *
 * Retries on a dropped connection: this network drops them often enough that a
 * single transient failure would otherwise read as "the migration is broken".
 */
export async function runSql(sql, { retries = 6 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: sql }),
      });
    } catch (err) {
      // Six tries, not three: this link drops connections in bursts rather
      // than one at a time, and a test that dies halfway through leaves rows
      // behind in production for the next run to trip over.
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1200 * attempt));
      continue;
    }
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch (_) { body = text; }
    if (!res.ok) {
      const msg = typeof body === "string" ? body : (body && (body.message || body.error)) || text;
      const err = new Error(`HTTP ${res.status}: ${String(msg).slice(0, 400)}`);
      err.status = res.status;
      throw err;                    // a SQL error is not worth retrying
    }
    return Array.isArray(body) ? body : [];
  }
  throw new Error(`Could not reach api.supabase.com after ${retries} tries: ${lastErr && lastErr.message}`);
}

/**
 * Run SQL as a signed-in user, with RLS actually applied.
 *
 * Two things are needed and both are easy to forget:
 *   · `set local role authenticated` — as `postgres` every policy is bypassed,
 *     so a test that skips this proves nothing at all;
 *   · request.jwt.claims — what app_uid() and is_admin() read.
 *
 * Everything is one transaction so `set local` holds for the whole blob.
 */
export function asUser({ sub, email }, sql) {
  const claims = JSON.stringify({ sub, email: email || null, role: "authenticated" });
  // The claims are set inside a DO block on purpose. `select set_config(...)`
  // returns a row, and the API hands back the last result set that HAD rows —
  // so a query that correctly returns nothing would come back looking like it
  // returned the set_config row instead. That reads as "the outsider could see
  // the message", which is the exact opposite of the truth. DO returns nothing,
  // so an empty result stays empty.
  return runSql(
    `begin;
     do $claims$ begin perform set_config('request.jwt.claims', ${literal(claims)}, true); end $claims$;
     set local role authenticated;
     ${sql}
     commit;`
  );
}

/** Single-quote a SQL string literal. */
export function literal(v) {
  if (v === null || v === undefined) return "null";
  return "'" + String(v).replace(/'/g, "''") + "'";
}
