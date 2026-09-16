// ============================================================================
// rpc_exists_test.mjs — every function the app calls exists, and the app's own
// role is allowed to call it.
//
// WHY THIS EXISTS.
//
// Profile offered "Delete my account", said it "removes your account for good",
// and did nothing. Two halves of one path were missing at once: the Edge
// Function was not deployed, and the RPC it falls back to —
// public.account_erase — had never been applied to the database. The SQL was
// written, reviewed and committed; it was simply never run. Nothing in the
// repo could tell, because the call site is `sb.rpc("account_erase", …)`, a
// string, and a string is not a dependency any linter follows.
//
// PostgREST answers a missing function with 404 and a message about its schema
// cache, which reaches the user as an error at the worst possible moment: after
// they typed their own email to confirm. So the failure mode is not "a feature
// is missing", it is "a feature lies, and only when somebody commits to it".
//
// Two ways this goes wrong and both are checked:
//
//   MISSING    the app calls a name the database does not have.
//   UNGRANTED  the function exists but `authenticated` cannot EXECUTE it, so
//              every call comes back "permission denied for function". This
//              repo has shipped that too — a notices function granted to
//              nobody, called on every page load.
//
// It reads the call sites out of js/ rather than keeping a list, because a
// list is a second thing to forget to update.
//
//   usage:  node tests/rpc_exists_test.mjs
//           (needs PERSONAL_ACCESS_TOKEN in .env — this one talks to PROD,
//            read-only: it asks pg_proc what exists and nothing else.)
// ============================================================================
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { runSql } from "../scripts/db/sql.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};
const section = (s) => process.stdout.write("\n" + s + "\n");

// ---- what the app calls ----------------------------------------------------
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

// .rpc("name" | 'name' | `name`. A name built at runtime cannot be seen here
// and is not pretended about.
const RPC = /\.rpc\(\s*["'`]([a-z_][a-z0-9_]*)["'`]/g;
const calls = new Map();            // name -> [where]

for (const file of walk(join(ROOT, "js"))) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    RPC.lastIndex = 0;
    let m;
    while ((m = RPC.exec(line)) !== null) {
      const where = `${relative(ROOT, file).replace(/\\/g, "/")}:${i + 1}`;
      if (!calls.has(m[1])) calls.set(m[1], []);
      calls.get(m[1]).push(where);
    }
  });
}

section("1. The scan found the call sites");
{
  ok(calls.size > 10, `distinct functions called from js/ (${calls.size})`);
}

// ---- what the database has -------------------------------------------------
const names = [...calls.keys()].sort();
const list = names.map((n) => `('${n}')`).join(",");
const rows = await runSql(`
  with called(name) as (values ${list})
  select c.name,
         (select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = c.name) as overloads,
         (select bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = c.name) as auth_can
  from called c order by 1;`);

const byName = new Map(rows.map((r) => [r.name, r]));

section("2. Every function the app calls exists in the database");
{
  const missing = names.filter((n) => Number(byName.get(n)?.overloads || 0) === 0);
  // Point at the fix, not just the fault. Every one of these has SQL in
  // supabase/features/ that was written and never applied, which is the whole
  // failure mode this file exists for.
  const where = (n) => {
    const hits = [];
    for (const dir of ["account", "message", "house", "agent"]) {
      try {
        for (const f of readdirSync(join(ROOT, "supabase/features", dir))) {
          if (readFileSync(join(ROOT, "supabase/features", dir, f), "utf8")
                .includes(`function public.${n}(`)) hits.push(`supabase/features/${dir}/${f}`);
        }
      } catch (_) { /* that folder may not exist */ }
    }
    return hits[0] ? `  — apply ${hits[0]}` : "";
  };
  ok(missing.length === 0,
     "no call site names a function the database does not have",
     missing.map((n) =>
       `${n}()  called at ${calls.get(n).slice(0, 2).join(", ")}${where(n)}`).join("\n        "));
}

section("3. And the app's own role is allowed to call it");
{
  const present = names.filter((n) => Number(byName.get(n)?.overloads || 0) > 0);
  const denied = present.filter((n) => byName.get(n).auth_can !== true);
  ok(denied.length === 0,
     "authenticated can EXECUTE every one of them",
     denied.map((n) => `${n}()  called at ${calls.get(n)[0]}`).join("\n        "));
}

section("4. No name is ambiguous to PostgREST");
{
  // `create or replace` does not replace a function whose argument list
  // changed, it adds a SECOND overload, and PostgREST then refuses to choose
  // between them — the call fails at runtime with nothing wrong in the code.
  const doubled = names.filter((n) => Number(byName.get(n)?.overloads || 0) > 1);
  ok(doubled.length === 0,
     "no called function has more than one overload",
     doubled.map((n) => `${n}() has ${byName.get(n).overloads} overloads, called at ${calls.get(n)[0]}`).join("\n        "));
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
// exitCode, not process.exit(). The SQL client still has a socket in flight,
// and exiting out from under it trips a libuv assertion on Windows
// ("!(handle->flags & UV_HANDLE_CLOSING)") which reports as 127 — a crash
// where there was only a test failure. Setting the code lets Node close its
// own handles and leave with the right answer.
process.exitCode = fail === 0 ? 0 : 1;
