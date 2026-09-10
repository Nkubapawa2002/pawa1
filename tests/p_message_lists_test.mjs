// ============================================================================
// p_message_lists_test.mjs — a set of people you can name and use again.
// Runs against the REAL database with RLS on.
//
// The assertion that carries the design is section 4. A list is a PLAN, not a
// permission: it will happily hold somebody you may not reach, because
// refusing to save them would leak at save time whether they have blocked you,
// and because a permission recorded when the list was made is a stale
// permission by the time it is used. So the reach test runs at the moment the
// list is used, every time, and pm_list_people() reports the answer per row so
// the picker can grey them.
//
// Every row is prefixed pmtest_ and every case runs inside a rolled-back
// transaction, so production data is untouched.
//
//   usage:  node tests/p_message_lists_test.mjs
// ============================================================================
import { runSql, literal } from "../scripts/db/sql.mjs";

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  if (c) { pass++; console.log("  PASS  " + m); }
  else { fail++; console.log("  FAIL  " + m + (d ? "\n        " + d : "")); }
};
const section = (s) => console.log("\n" + s);

const A = "pmtest_la";       // me
const B = "pmtest_lb";       // a shopfront: an agent
const C = "pmtest_lc";       // an ordinary account that published nothing
const G = "pmtest_lguest";
const OTHER = "pmtest_lother";

const keys = `
  insert into public.pm_keys (user_id, public_key, fingerprint, display_name, is_agent, is_guest) values
    (${literal(A)},     'pk-a', 'fp-a', 'pmtest LA', false, false),
    (${literal(B)},     'pk-b', 'fp-b', 'pmtest LB', true,  false),
    (${literal(C)},     'pk-c', 'fp-c', 'pmtest LC', false, false),
    (${literal(OTHER)}, 'pk-o', 'fp-o', 'pmtest LO', false, false),
    (${literal(G)},     'pk-g', 'fp-g', 'pmtest LG', false, true);
`;

const asUid = (uid, sql, opts = {}) => {
  const claims = { sub: uid };
  if (opts.email) claims.email = opts.email;
  if (opts.guest) claims.is_anonymous = true;
  return `
  set local role authenticated;
  set local request.jwt.claims = ${literal(JSON.stringify(claims))};
  ${sql}
  reset role;
`;
};

// pm_lists is revoked from `authenticated` — that IS the containment, and it
// means a test cannot look the id up in the table the way it looks up a
// thread. So the id is stashed in a transaction-local setting by the OWNER of
// the table, between the role blocks, and every role block below names the
// list without ever being able to read it.
const GRAB = `
  do $g$ begin
    perform set_config('pmtest.lid', (select id::text from public.pm_lists limit 1), true);
  end $g$;
`;
const LID = "current_setting('pmtest.lid')::uuid";

/** Make a list as A, and leave its id where the next role block can name it. */
const mk = (name, members) =>
  asUid(A, `select public.pm_list_create(${literal(name)},
    ${literal(JSON.stringify(members || []))});`) + GRAB;

async function tx(body) { return await runSql(`begin;\n${body}\nrollback;`); }
const last = (rows) => rows[rows.length - 1];
const threw = async (body, re) => {
  try { await tx(body); return false; }
  catch (e) { return re.test(e.message); }
};

try {
  section("1. Making one, and using it again");
  {
    const r = await tx(keys + asUid(A, `
      select public.pm_list_create('Mwanza trucks', ${literal(JSON.stringify([B, C]))});
      select name || '/' || n_members::text as r from public.pm_lists_mine();`));
    ok(last(r).r === "Mwanza trucks/2", "a name and the people in it", JSON.stringify(last(r)));
  }
  {
    const r = await tx(keys + mk("Mwanza trucks", [B, C]) + asUid(A, `
      select string_agg(user_id, ',' order by user_id) as r
        from public.pm_list_people(${LID});`));
    ok(last(r).r === "pmtest_lb,pmtest_lc", "and reading it back gives the same two",
       JSON.stringify(last(r)));
  }
  {
    // set REPLACES rather than appends: the picker hands over a set, not a
    // diff, and "save what is on screen" is the only gesture there is.
    const r = await tx(keys + mk("Mwanza trucks", [B, C]) + asUid(A, `
      select public.pm_list_set(${LID}, ${literal(JSON.stringify([B]))});`) + `
      select count(*)::int as r from public.pm_list_members;`);
    ok(Number(last(r).r) === 1, "saving again replaces the membership rather than adding to it");
  }
  {
    const r = await tx(keys + mk("Old name", [B]) + asUid(A, `
      select public.pm_list_rename(${LID}, 'New name');
      select name as r from public.pm_lists_mine();`));
    ok(last(r).r === "New name", "renaming works");
  }
  {
    const r = await tx(keys + mk("Gone soon", [B, C]) + asUid(A, `
      select public.pm_list_delete(${LID});`) + `
      select (select count(*)::int from public.pm_lists) || '/' ||
             (select count(*)::int from public.pm_list_members) as r;`);
    ok(last(r).r === "0/0", "and deleting one takes its members with it", JSON.stringify(last(r)));
  }

  section("2. A list is yours and nobody else's");
  {
    const r = await tx(keys + mk("Mine", [B]) +
      asUid(OTHER, `select count(*)::int as r from public.pm_lists_mine();`));
    ok(Number(last(r).r) === 0, "another account does not see it");
  }
  {
    ok(await threw(keys + mk("Mine", [B]) +
      asUid(OTHER, `select public.pm_list_rename(${LID}, 'Theirs');`), /not your list/),
      "cannot rename it");
  }
  {
    ok(await threw(keys + mk("Mine", [B]) +
      asUid(OTHER, `select public.pm_list_set(${LID}, ${literal(JSON.stringify([C]))});`),
      /not your list/), "cannot change who is in it");
  }
  {
    ok(await threw(keys + mk("Mine", [B]) +
      asUid(OTHER, `select public.pm_list_delete(${LID});`), /not your list/),
      "and cannot delete it");
  }
  {
    const r = await tx(keys + mk("Mine", [B]) +
      asUid(OTHER, `select count(*)::int as r from public.pm_list_people(${LID});`));
    ok(Number(last(r).r) === 0,
       "nor read the people in it: pm_list_people asks pm_list_own before it returns a row");
  }

  section("3. The limits, and who may keep one at all");
  {
    ok(await threw(keys + asUid(A, `
        select public.pm_list_create('Same', ${literal(JSON.stringify([B]))});
        select public.pm_list_create('same', ${literal(JSON.stringify([C]))});`),
       /already have a list called that/),
       "two lists with the same name, in any case, is somebody losing track of their own lists");
  }
  {
    ok(await threw(keys + asUid(A, `select public.pm_list_create('   ');`), /Give the list a name/),
       "a list with no name is refused, rather than saved as an empty label");
  }
  {
    ok(await threw(keys + asUid(G, `
        select public.pm_list_create('Guest list', ${literal(JSON.stringify([B]))});`, { guest: true }),
       /guest session cannot keep a list/),
       "and a guest session cannot keep one, because it cannot keep anything");
  }
  {
    // A guest cannot be IN one either. They are a browser tab; a list that
    // names one is a list with a dead row in it by tomorrow.
    const r = await tx(keys + asUid(A, `
      select public.pm_list_create('With a guest', ${literal(JSON.stringify([B, G]))});`) + `
      select count(*)::int as r from public.pm_list_members;`);
    ok(Number(last(r).r) === 1, "and a guest named in one is simply not stored");
  }

  section("4. A list is a plan, not a permission");
  {
    // C has published nothing and A has never written to them, so A may not
    // announce to C and may not gather C into a room. The list holds them
    // anyway, on purpose: refusing would leak, at save time, who has blocked
    // you, and a permission recorded then would be stale by the time it is used.
    const r = await tx(keys + mk("Mixed", [B, C]) + asUid(A, `
      select string_agg(user_id || ':' || may_cast::text || ':' || may_room::text, ',' order by user_id) as r
        from public.pm_list_people(${LID});`));
    ok(last(r).r === "pmtest_lb:false:true,pmtest_lc:false:false",
       "it holds both, and says per row what may actually be done with each",
       JSON.stringify(last(r)));
  }
  {
    // And the act is fenced when it happens, not when the list was saved.
    const r = await tx(keys + mk("Mixed", [B, C]) + asUid(A, `
      select public.pm_group_create('pmtest from list', null, null,
        (select jsonb_agg(user_id) from public.pm_list_people(${LID})),
        'cccccccc-0000-4000-8000-000000000001'::uuid);`) + `
      select string_agg(user_id, ',' order by user_id) as r from public.pm_members
       where thread_id = 'cccccccc-0000-4000-8000-000000000001'::uuid;`);
    ok(last(r).r === "pmtest_la,pmtest_lb",
       "opening a room from that list takes the shopfront and drops the one it may not gather",
       JSON.stringify(last(r)));
  }
  {
    // The case the design exists for: a block landing AFTER the list was made.
    const r = await tx(keys + mk("Mixed", [B]) + `
      insert into public.pm_blocks (blocker_id, blocked_id)
      values (${literal(B)}, ${literal(A)});` + asUid(A, `
      select string_agg(user_id || ':' || may_room::text, ',') as r
        from public.pm_list_people(${LID});`));
    ok(last(r).r === "pmtest_lb:false",
       "a block that lands after the list was saved is caught when the list is read, not ignored",
       JSON.stringify(last(r)));
  }

  section("5. Where the lists live");
  {
    const r = await runSql(`
      select
        (select count(*)::int from pg_policies
          where schemaname='public' and tablename in ('pm_lists','pm_list_members')) as pol,
        (select bool_and(relrowsecurity) from pg_class
          where relname in ('pm_lists','pm_list_members') and relnamespace='public'::regnamespace) as rls,
        has_table_privilege('authenticated','public.pm_lists','SELECT') as sel,
        (select count(*)::int from pg_policies
          where schemaname='public' and tablename like 'pm%' and cmd <> 'SELECT') as writes;`);
    const row = last(r);
    ok(Number(row.pol) === 0 && String(row.rls) === "true",
       "RLS on and not one policy: every read goes through a function that checks the owner",
       JSON.stringify(row));
    ok(String(row.sel) === "false", "and authenticated cannot read the tables at all");
    ok(Number(row.writes) === 0,
       "still no write policy on any pm_ table, with two more tables in the family");
  }
} catch (e) {
  fail++;
  console.log("\n  FAIL  the suite threw\n        " + (e && e.message));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
