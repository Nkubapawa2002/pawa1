// ============================================================================
// p_message_announce_test.mjs — an announcement is one voice, and it can be
// closed. Runs against the REAL database with RLS on.
//
// pm_broadcast() was always admin-only to CREATE, and that was the only gate.
// Afterwards pm_send() asked one question, "are you in this conversation", and
// every recipient of a broadcast is. So any one of them could write back INTO
// the announcement and reach everybody it reached. And pm_group_delete refused
// anything that was not a room, so nobody could ever close it.
//
// Every row is prefixed pmtest_ and each case runs in a rolled-back
// transaction, so production data is untouched.
//
//   usage:  node tests/p_message_announce_test.mjs
// ============================================================================
import { runSql, literal } from "../scripts/db/sql.mjs";

let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) { pass++; console.log("  PASS  " + m); }
  else { fail++; console.log("  FAIL  " + m + (d ? "\n        " + d : "")); } };
const section = (s) => console.log("\n" + s);

const OWNER = "pmtest_owner";
const MEMBER = "pmtest_member";

// A broadcast with an owner and one ordinary recipient, exactly the shape
// pm_broadcast() leaves behind.
const setup = (kind) => `
  insert into public.pm_threads (id, kind, title, created_by)
  values ('11111111-1111-1111-1111-111111111111', ${literal(kind)}, 'pmtest announcement', ${literal(OWNER)});
  insert into public.pm_members (thread_id, user_id, role) values
    ('11111111-1111-1111-1111-111111111111', ${literal(OWNER)},  'owner'),
    ('11111111-1111-1111-1111-111111111111', ${literal(MEMBER)}, 'member');
`;

// app_uid() reads the JWT; asUser() is how the other suites impersonate.
const asUid = (uid, sql) => `
  set local role authenticated;
  set local request.jwt.claims = '{"sub":${JSON.stringify(uid)}}';
  ${sql}
  reset role;
`;

async function tx(body) {
  return await runSql(`begin;\n${body}\nrollback;`);
}

const CAN = (uid) => `
  select coalesce(bool_or(x), false)::text as r from (
    select public.pm_can_announce('11111111-1111-1111-1111-111111111111') as x
  ) s;`;

try {
  section("1. Who may add to an announcement");
  {
    const r = await tx(setup("broadcast") + asUid(OWNER, CAN()));
    ok(String(r[r.length - 1].r) === "true",
       "the owner of the announcement may", JSON.stringify(r[r.length - 1]));
  }
  {
    const r = await tx(setup("broadcast") + asUid(MEMBER, CAN()));
    ok(String(r[r.length - 1].r) === "false",
       "a recipient may NOT, which is the whole point: their reply would reach everybody it reached",
       JSON.stringify(r[r.length - 1]));
  }

  section("2. Every other kind of thread is untouched");
  for (const kind of ["direct", "group"]) {
    const r = await tx(setup(kind) + asUid(MEMBER, CAN()));
    ok(String(r[r.length - 1].r) === "true",
       `an ordinary member of a ${kind} thread can still send`, JSON.stringify(r[r.length - 1]));
  }

  section("3. The send path actually refuses it");
  {
    const sql = setup("broadcast") + asUid(MEMBER, `
      select public.pm_send('11111111-1111-1111-1111-111111111111', 'iv', 'ct',
        '[{"user_id":${JSON.stringify(MEMBER)},"epk":"e","wrapped_key":"w"}]'::jsonb);`);
    let threw = null;
    try { await tx(sql); } catch (e) { threw = String(e.message); }
    ok(threw && /only the person who sent this announcement/i.test(threw),
       "pm_send refuses a recipient writing into a broadcast", threw || "no error raised");
  }

  section("4. Closing it");
  {
    const sql = setup("broadcast") + asUid(MEMBER,
      "select public.pm_group_delete('11111111-1111-1111-1111-111111111111');");
    let threw = null;
    try { await tx(sql); } catch (e) { threw = String(e.message); }
    ok(threw && /only the owner/i.test(threw),
       "a recipient cannot delete the announcement", threw || "no error raised");
  }
  {
    const sql = setup("broadcast") + asUid(OWNER, `
      select public.pm_group_delete('11111111-1111-1111-1111-111111111111');
      select count(*)::int as n from public.pm_threads
       where id = '11111111-1111-1111-1111-111111111111';`);
    const r = await tx(sql);
    const n = Number(r[r.length - 1].n);
    ok(n === 0, "the owner can, which was impossible before: a broadcast was permanent for everybody it reached",
       JSON.stringify(r[r.length - 1]));
  }
} finally {
  await runSql("delete from public.pm_threads where title like 'pmtest%';").catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
