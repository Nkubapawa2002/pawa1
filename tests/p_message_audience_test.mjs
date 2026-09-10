// ============================================================================
// p_message_audience_test.mjs — who you may gather, who you may advertise to,
// and the block that overrules both. Runs against the REAL database, RLS on.
//
// Rooms and announcements are being opened to every account. The two
// `if not is_admin()` lines that used to guard them were, badly, keeping
// strangers out of each other's inboxes; p_message_audience.sql is the
// replacement. So this suite is written as the attacks that replacement has
// to survive, not as a tour of the happy path.
//
// The one worth reading twice is section 4. If being in a room together
// counted as dealing with somebody, an advertiser could open one silent room
// holding five hundred strangers and then announce to all of them: the fence
// would hold for exactly one step. That is why pm_deals_with looks only at
// direct threads, and it is the assumption most likely to be "tidied" back
// into a hole.
//
// Every row is prefixed pmtest_ and every case runs inside a rolled-back
// transaction, so production data is untouched.
//
//   usage:  node tests/p_message_audience_test.mjs
// ============================================================================
import { runSql, literal } from "../scripts/db/sql.mjs";

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  if (c) { pass++; console.log("  PASS  " + m); }
  else { fail++; console.log("  FAIL  " + m + (d ? "\n        " + d : "")); }
};
const section = (s) => console.log("\n" + s);

const A = "pmtest_a";        // me
const B = "pmtest_b";        // somebody I have actually dealt with
const C = "pmtest_c";        // a stranger with an account and no listings
const D = "pmtest_d";        // a stranger who has published a shopfront
const G = "pmtest_guest";    // a guest session
const ADMIN_EMAIL = "pawa4761@gmail.com";

const T1 = "aaaaaaaa-0000-4000-8000-000000000001";   // direct A <-> B
const T2 = "aaaaaaaa-0000-4000-8000-000000000002";   // direct A <-> C, one sided
const T3 = "aaaaaaaa-0000-4000-8000-000000000003";   // a room holding A and C

/** Five identities. Region stays null: pm_keys.region is an FK onto regions. */
const keys = `
  insert into public.pm_keys (user_id, public_key, fingerprint, display_name, is_agent, is_guest) values
    (${literal(A)}, 'pk-a', 'fp-a', 'pmtest A', false, false),
    (${literal(B)}, 'pk-b', 'fp-b', 'pmtest B', false, false),
    (${literal(C)}, 'pk-c', 'fp-c', 'pmtest C', false, false),
    (${literal(D)}, 'pk-d', 'fp-d', 'pmtest D', true,  false),
    (${literal(G)}, 'pk-g', 'fp-g', 'pmtest G', false, true);
`;

const msg = (thread, sender, n) => `
  insert into public.pm_messages (thread_id, sender_id, iv, ciphertext)
  values (${literal(thread)}, ${literal(sender)}, 'iv${n}', 'ct${n}');
`;

/** A <-> B, both of them having written: the only shape that counts. */
const dealt = `
  insert into public.pm_threads (id, kind, created_by)
  values (${literal(T1)}, 'direct', ${literal(A)});
  insert into public.pm_members (thread_id, user_id, role) values
    (${literal(T1)}, ${literal(A)}, 'owner'),
    (${literal(T1)}, ${literal(B)}, 'member');
  ${msg(T1, A, 1)}
  ${msg(T1, B, 2)}
`;

/** A <-> C, opened unilaterally by A, who alone has written. */
const oneSided = `
  insert into public.pm_threads (id, kind, created_by)
  values (${literal(T2)}, 'direct', ${literal(A)});
  insert into public.pm_members (thread_id, user_id, role) values
    (${literal(T2)}, ${literal(A)}, 'owner'),
    (${literal(T2)}, ${literal(C)}, 'member');
  ${msg(T2, A, 3)}
`;

/** A room holding A and C, with both of them talking in it. */
const sharedRoom = `
  insert into public.pm_threads (id, kind, title, created_by)
  values (${literal(T3)}, 'group', 'pmtest room', ${literal(A)});
  insert into public.pm_members (thread_id, user_id, role) values
    (${literal(T3)}, ${literal(A)}, 'owner'),
    (${literal(T3)}, ${literal(C)}, 'member');
  ${msg(T3, A, 4)}
  ${msg(T3, C, 5)}
`;

const blocks = (blocker, blocked) => `
  insert into public.pm_blocks (blocker_id, blocked_id)
  values (${literal(blocker)}, ${literal(blocked)});
`;

/**
 * Impersonate. `email` is what is_admin() reads; `guest` is what
 * app_is_guest() reads, and leaving it out is how a guest fence silently
 * reads as "not a guest" and half a suite tests nothing.
 */
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

async function tx(body) {
  return await runSql(`begin;\n${body}\nrollback;`);
}
const last = (rows) => rows[rows.length - 1];

/** Ask one boolean and get it back as a string, whatever the driver does. */
const ask = (expr) => `select (${expr})::text as r;`;

try {
  section("1. pm_deals_with — a conversation is two people writing");
  {
    const r = await tx(keys + asUid(A, ask(`public.pm_deals_with(${literal(B)})`)));
    ok(last(r).r === "false",
       "two accounts that have never spoken have not dealt with each other", JSON.stringify(last(r)));
  }
  {
    const r = await tx(keys + dealt + asUid(A, ask(`public.pm_deals_with(${literal(B)})`)));
    ok(last(r).r === "true", "both of them wrote in the same direct thread, so they have");
  }
  {
    const r = await tx(keys + oneSided + asUid(A, ask(`public.pm_deals_with(${literal(C)})`)));
    ok(last(r).r === "false",
       "a thread I opened and talked into alone is not a relationship: pm_start_direct is unilateral, so counting it would cost an attacker one extra call per victim",
       JSON.stringify(last(r)));
  }
  {
    const r = await tx(keys + `
      insert into public.pm_invites (token_hash, agent_id, accepted_by, accepted_at)
      values ('pmtest_hash_1', ${literal(A)}, ${literal(C)}, now());
    ` + asUid(A, ask(`public.pm_deals_with(${literal(C)})`)));
    ok(last(r).r === "true",
       "an accepted invite counts with no messages at all, because accepting IS the other person's deliberate act");
  }

  section("2. pm_may_cast_to — an advert reaches people you deal with");
  {
    const r = await tx(keys + dealt + asUid(A, ask(`public.pm_may_cast_to(${literal(B)})`)));
    ok(last(r).r === "true", "a contact may be advertised to");
  }
  {
    const r = await tx(keys + asUid(A, ask(`public.pm_may_cast_to(${literal(D)})`)));
    ok(last(r).r === "false",
       "a listed agent I have never written to may NOT: publishing a shopfront is not subscribing to adverts",
       JSON.stringify(last(r)));
  }
  {
    const r = await tx(keys + dealt + asUid(A, ask(`public.pm_may_cast_to(${literal(A)})`)));
    ok(last(r).r === "false", "and never to myself");
  }
  {
    const r = await tx(keys + asUid(G, ask(`public.pm_may_cast_to(${literal(D)})`), { guest: true }));
    ok(last(r).r === "false", "a guest session advertises to nobody");
  }
  {
    const r = await tx(keys + `
      insert into public.pm_threads (id, kind, created_by)
      values (${literal(T1)}, 'direct', ${literal(A)});
      insert into public.pm_members (thread_id, user_id, role) values
        (${literal(T1)}, ${literal(A)}, 'owner'),
        (${literal(T1)}, ${literal(G)}, 'member');
      ${msg(T1, A, 6)}
      ${msg(T1, G, 7)}
    ` + asUid(A, ask(`public.pm_may_cast_to(${literal(G)})`)));
    ok(last(r).r === "false",
       "nor to a guest, even one I really have talked with: a guest is a browser tab and the advert would outlive it",
       JSON.stringify(last(r)));
  }

  section("3. pm_may_room_with — a room is wider, because it is two-way");
  {
    const r = await tx(keys + asUid(A, ask(`public.pm_may_room_with(${literal(D)})`)));
    ok(last(r).r === "true",
       "a stranger who published a shopfront may be gathered into a room they can answer in and leave");
  }
  {
    const r = await tx(keys + asUid(A, ask(`public.pm_may_room_with(${literal(C)})`)));
    ok(last(r).r === "false",
       "an ordinary account that published nothing may not: they are not a shopfront",
       JSON.stringify(last(r)));
  }
  {
    const r = await tx(keys + dealt + asUid(A, ask(`public.pm_may_room_with(${literal(B)})`)));
    ok(last(r).r === "true", "somebody I deal with may, listed or not");
  }

  section("4. A room is not a relationship (the laundering attack)");
  {
    const r = await tx(keys + sharedRoom + asUid(A, ask(`public.pm_deals_with(${literal(C)})`)));
    ok(last(r).r === "false",
       "sharing a room, and both talking in it, still does not make C a contact",
       JSON.stringify(last(r)));
  }
  {
    const r = await tx(keys + sharedRoom + asUid(A, ask(`public.pm_may_cast_to(${literal(C)})`)));
    ok(last(r).r === "false",
       "so the two-step path is closed: gather strangers into a room, and they are still not advertisable",
       JSON.stringify(last(r)));
  }

  section("5. The block overrules everything");
  {
    const r = await tx(keys + dealt + blocks(B, A) +
      asUid(A, ask(`public.pm_may_cast_to(${literal(B)})`)));
    ok(last(r).r === "false", "blocked by them: no advert");
  }
  {
    const r = await tx(keys + dealt + blocks(A, B) +
      asUid(A, ask(`public.pm_may_cast_to(${literal(B)})`)));
    ok(last(r).r === "false",
       "and blocking them stops me too. Symmetric on purpose: which of the two pressed it is not a fact either side needs");
  }
  {
    const r = await tx(keys + blocks(D, A) +
      asUid(A, ask(`public.pm_may_room_with(${literal(D)})`)));
    ok(last(r).r === "false", "a shopfront that blocked me is not gatherable either");
  }
  {
    const r = await tx(keys + blocks(D, A) +
      asUid(A, ask(`public.pm_may_room_with(${literal(D)})`), { email: ADMIN_EMAIL }));
    ok(last(r).r === "false",
       "AND THE ADMIN IS NOT EXEMPT. A block an admin could step over is a promise with an asterisk on it",
       JSON.stringify(last(r)));
  }
  {
    const r = await tx(keys + asUid(A, ask(`public.pm_may_cast_to(${literal(C)})`), { email: ADMIN_EMAIL }));
    ok(last(r).r === "true",
       "the admin IS exempt from the reach fence, which is the national announcement still working");
  }

  section("6. pm_audience_check — one round trip for a screen of rows");
  {
    const r = await tx(keys + dealt + asUid(A, `
      select string_agg(user_id || ':' || may_cast::text || ':' || may_room::text, ',' order by user_id) as r
      from public.pm_audience_check(${literal(JSON.stringify([B, C, D]))});`));
    ok(last(r).r === "pmtest_b:true:true,pmtest_c:false:false,pmtest_d:false:true",
       "a contact, a stranger and a shopfront, each with the two answers the picker draws",
       JSON.stringify(last(r)));
  }
  {
    const r = await tx(keys + asUid(A, `
      select count(*)::int as r from public.pm_audience_check('[]'::jsonb);`));
    ok(Number(last(r).r) === 0, "an empty list asks nothing");
  }

  section("7. pm_my_people — the contacts, drawn like everybody else");
  {
    const r = await tx(keys + dealt + oneSided + sharedRoom + asUid(A, `
      select string_agg(user_id || ':' || how, ',' order by user_id) as r from public.pm_my_people();`));
    ok(last(r).r === "pmtest_b:thread",
       "only B. Not C, who shares a room and a one-sided thread with me and neither counts",
       JSON.stringify(last(r)));
  }
  {
    const r = await tx(keys + dealt + blocks(B, A) + asUid(A, `
      select count(*)::int as r from public.pm_my_people();`));
    ok(Number(last(r).r) === 0, "somebody who blocked me is simply not there");
  }
  {
    const r = await tx(keys + dealt + asUid(A, `
      select count(*)::int as r from public.pm_my_people('nothing matches this');`));
    ok(Number(last(r).r) === 0, "and the search box narrows it, the same way the directory's does");
  }

  section("8. Blocking, from the outside");
  {
    const r = await tx(keys + asUid(A, `
      select public.pm_block(${literal(B)});
      select string_agg(user_id || '/' || display_name, ',') as r from public.pm_blocks_mine();`));
    ok(last(r).r === "pmtest_b/pmtest B", "block, then read it back", JSON.stringify(last(r)));
  }
  {
    const r = await tx(keys + blocks(A, B) + asUid(A, `
      select public.pm_unblock(${literal(B)});
      select count(*)::int as r from public.pm_blocks_mine();`));
    ok(Number(last(r).r) === 0, "unblock removes it");
  }
  {
    const r = await tx(keys + blocks(B, A) + asUid(A, `
      select count(*)::int as r from public.pm_blocks_mine();`));
    ok(Number(last(r).r) === 0,
       "and I cannot see who blocked ME. That oracle is the one thing a block exists in order not to answer");
  }
  {
    let raised = false;
    try {
      await tx(keys + asUid(G, `select public.pm_block(${literal(B)});`, { guest: true }));
    } catch (e) { raised = /guest/i.test(e.message); }
    ok(raised, "a guest session cannot keep a block, because it cannot keep anything");
  }
  {
    let raised = false;
    try { await tx(keys + asUid(A, `select public.pm_block(${literal(A)});`)); }
    catch (e) { raised = /someone else/i.test(e.message); }
    ok(raised, "and nobody blocks themselves");
  }

  section("9. Where the blocks live");
  {
    const r = await runSql(`
      select
        (select count(*)::int from pg_policies
          where schemaname='public' and tablename='pm_blocks') as pol,
        (select relrowsecurity from pg_class
          where relname='pm_blocks' and relnamespace='public'::regnamespace) as rls,
        has_table_privilege('authenticated','public.pm_blocks','SELECT') as sel,
        (select count(*)::int from pg_policies
          where schemaname='public' and tablename like 'pm%' and cmd <> 'SELECT') as writes;`);
    const row = last(r);
    ok(Number(row.pol) === 0 && String(row.rls) === "true",
       "pm_blocks has RLS on and not one policy: the containment is the absence",
       JSON.stringify(row));
    ok(String(row.sel) === "false",
       "and authenticated cannot read the table at all, which is what the missing policy is worth");
    ok(Number(row.writes) === 0,
       "still no write policy on any pm_ table: every write goes through a function that checks something");
  }
  // ==========================================================================
  //  From here on: the four functions that used to say "Admins only".
  // ==========================================================================

  const R1 = "bbbbbbbb-0000-4000-8000-000000000001";
  const members = (thread) => `
    select string_agg(user_id, ',' order by user_id) as r
      from public.pm_members where thread_id = ${literal(thread)};`;

  /** What pm_broadcast is handed: one wrap per recipient. */
  const wraps = (ids) =>
    literal(JSON.stringify(ids.map((u) => ({ user_id: u, epk: "epk", wrapped_key: "wk" }))));

  const threw = async (body, re) => {
    try { await tx(body); return false; }
    catch (e) { return re.test(e.message); }
  };

  section("10. Opening a room, as somebody who is not an admin");
  {
    const r = await tx(keys + asUid(A, `
      select public.pm_group_create('pmtest room', null, null,
        ${literal(JSON.stringify([D]))}, ${literal(R1)});
      ${members(R1)}`));
    ok(last(r).r === "pmtest_a,pmtest_d",
       "a shopfront stranger and me. The line that used to raise 'Admins only' is gone",
       JSON.stringify(last(r)));
  }
  {
    ok(await threw(keys + asUid(A, `
        select public.pm_group_create('pmtest room', null, null,
          ${literal(JSON.stringify([C]))}, ${literal(R1)});`),
       /already deal with/),
       "an ordinary account that published nothing is refused, with a sentence that says what to do");
  }
  {
    const r = await tx(keys + dealt + asUid(A, `
      select public.pm_group_create('pmtest room', null, null,
        ${literal(JSON.stringify([B, C, D]))}, ${literal(R1)});
      ${members(R1)}`));
    ok(last(r).r === "pmtest_a,pmtest_b,pmtest_d",
       "and a mixed list keeps the two it may and drops C silently: naming who was refused is a 'they blocked you' oracle",
       JSON.stringify(last(r)));
  }
  {
    ok(await threw(keys + asUid(G, `
        select public.pm_group_create('pmtest room', null, null,
          ${literal(JSON.stringify([D]))}, ${literal(R1)});`, { guest: true }),
       /guest session cannot open a room/),
       "a guest opens nothing");
  }
  {
    ok(await threw(keys + blocks(D, A) + asUid(A, `
        select public.pm_group_create('pmtest room', null, null,
          ${literal(JSON.stringify([D]))}, ${literal(R1)});`),
       /already deal with/),
       "a shopfront that blocked me cannot be gathered, however public they are");
  }

  section("11. Announcing, as somebody who is not an admin");
  {
    const r = await tx(keys + dealt + asUid(A, `
      select public.pm_broadcast('pmtest cast', null, 'iv', 'ct',
        ${wraps([B, C, D])}, ${literal(R1)});
      ${members(R1)}`));
    ok(last(r).r === "pmtest_a,pmtest_b",
       "only the contact. The stranger and the shopfront are both dropped, because an advert is one-way",
       JSON.stringify(last(r)));
  }
  {
    // The count is read back OUTSIDE the role block, as the owner. Asked as
    // pmtest_a it would always be empty: pm_message_keys lets you fetch your
    // own wrap and nobody else's, and the sender never has one.
    const r = await tx(keys + dealt + asUid(A, `
      select public.pm_broadcast('pmtest cast', null, 'iv', 'ct',
        ${wraps([B, C, D])}, ${literal(R1)});`) + `
      select string_agg(mk.user_id, ',' order by mk.user_id) as r
        from public.pm_message_keys mk
        join public.pm_messages m on m.id = mk.message_id
       where m.thread_id = ${literal(R1)};`);
    ok(last(r).r === "pmtest_b",
       "and the wrapped keys follow the membership, so a dropped person's sealed copy never lands either",
       JSON.stringify(last(r)));
  }
  {
    ok(await threw(keys + asUid(A, `
        select public.pm_broadcast('pmtest cast', null, 'iv', 'ct',
          ${wraps([C, D])}, ${literal(R1)});`),
       /Nobody you already deal with/),
       "an advert aimed only at strangers is refused outright");
  }
  {
    ok(await threw(keys + asUid(G, `
        select public.pm_broadcast('pmtest cast', null, 'iv', 'ct',
          ${wraps([D])}, ${literal(R1)});`, { guest: true }),
       /guest session cannot send an announcement/),
       "a guest announces nothing");
  }
  {
    const r = await tx(keys + `
      insert into public.pm_threads (id, kind, created_by)
      values (${literal(T1)}, 'direct', ${literal(A)});
      insert into public.pm_members (thread_id, user_id, role) values
        (${literal(T1)}, ${literal(A)}, 'owner'),
        (${literal(T1)}, ${literal(G)}, 'member');
      ${msg(T1, A, 8)} ${msg(T1, G, 9)}
    ` + dealt.replace(new RegExp(T1, "g"), T2) + asUid(A, `
      select public.pm_broadcast('pmtest cast', null, 'iv', 'ct',
        ${wraps([B, G])}, ${literal(R1)});
      ${members(R1)}`));
    ok(last(r).r === "pmtest_a,pmtest_b",
       "a guest RECIPIENT is dropped too. pm_broadcast never checked this before: guests were kept out only because the client happened to call a function that filtered them",
       JSON.stringify(last(r)));
  }

  section("12. The laundering attack, end to end");
  {
    // The two messages are inserted between the role blocks: pm_messages has
    // no insert policy at all, so a direct write as `authenticated` is refused
    // — which is itself the invariant p_message_security.sql exists for.
    const r = await tx(keys + asUid(A, `
      select public.pm_group_create('pmtest room', null, null,
        ${literal(JSON.stringify([D]))}, ${literal(R1)});`) +
      msg(R1, A, 10) + msg(R1, D, 11) +
      asUid(A, `select (public.pm_may_cast_to(${literal(D)}))::text as r;`));
    ok(last(r).r === "false",
       "gather a shopfront into a room, both of you talk in it, and they are STILL not advertisable. This is the assertion that fails if the fence is ever simplified back to announcements only",
       JSON.stringify(last(r)));
  }

  section("13. Growing a room is fenced like opening one");
  {
    const r = await tx(keys + `
      insert into public.pm_threads (id, kind, title, created_by)
      values (${literal(R1)}, 'group', 'pmtest room', ${literal(A)});
      insert into public.pm_members (thread_id, user_id, role)
      values (${literal(R1)}, ${literal(A)}, 'owner');
    ` + asUid(A, `
      select public.pm_group_add(${literal(R1)}, ${literal(JSON.stringify([C, D]))});
      ${members(R1)}`));
    ok(last(r).r === "pmtest_a,pmtest_d",
       "an owner cannot open a room of one and then add anybody at all: the same test runs here",
       JSON.stringify(last(r)));
  }
  {
    const r = await tx(keys + blocks(D, A) + `
      insert into public.pm_threads (id, kind, title, created_by)
      values (${literal(R1)}, 'group', 'pmtest room', ${literal(A)});
      insert into public.pm_members (thread_id, user_id, role)
      values (${literal(R1)}, ${literal(A)}, 'owner');
    ` + asUid(A, `
      select public.pm_group_add(${literal(R1)}, ${literal(JSON.stringify([D]))});
      ${members(R1)}`));
    ok(last(r).r === "pmtest_a",
       "and a blocked person cannot be added back");
  }

  section("14. A block stops a NEW conversation, not an old one");
  {
    ok(await threw(keys + blocks(C, A) +
        asUid(A, `select public.pm_start_direct(${literal(C)});`),
       /cannot start a conversation/),
       "blocked, so no first message");
  }
  {
    const r = await tx(keys + dealt + blocks(B, A) +
      asUid(A, `select (public.pm_start_direct(${literal(B)}) = ${literal(T1)})::text as r;`));
    ok(last(r).r === "true",
       "but a conversation that predates the block still opens: taking away a thread somebody already has is a different act, with a different button",
       JSON.stringify(last(r)));
  }

  section("14b. And it silences the conversation you already have");
  {
    // The gap this closes is not an edge. Everybody an advertiser can reach is
    // by definition somebody they have already written to, so the thread
    // always exists and pm_start_direct hands it straight back. A block that
    // stopped everything except the channel actually in use would be a
    // promise that does almost nothing.
    const r = await tx(keys + dealt + blocks(B, A) +
      asUid(A, ask(`public.pm_can_speak(${literal(T1)})`)));
    ok(last(r).r === "false", "a blocked person cannot write in the thread they already had");
  }
  {
    ok(await threw(keys + dealt + blocks(B, A) + asUid(A, `
        select public.pm_send(${literal(T1)}, 'iv', 'ct',
          '[{"user_id":"pmtest_b","epk":"e","wrapped_key":"w"}]'::jsonb);`),
       /cannot send messages in this conversation/),
       "and pm_send says so without naming who blocked whom, or when");
  }
  {
    const r = await tx(keys + dealt + asUid(A, ask(`public.pm_can_speak(${literal(T1)})`)));
    ok(last(r).r === "true", "with no block it is the same conversation it always was");
  }
  {
    // A room must NOT be silenced by one member blocking another, or a single
    // person could switch off a room they merely dislike. Leaving is the act
    // that exists for that.
    const r = await tx(keys + sharedRoom + blocks(C, A) +
      asUid(A, ask(`public.pm_can_speak(${literal(T3)})`)));
    ok(last(r).r === "true",
       "a room is not silenced by it: one member must not be able to switch a room off for everybody",
       JSON.stringify(last(r)));
  }

  section("15. The ceilings, and the day");
  {
    const three = [0, 1, 2].map((i) => `
      insert into public.pm_threads (id, kind, title, created_by)
      values (gen_random_uuid(), 'group', 'pmtest room ${i}', ${literal(A)});`).join("");
    ok(await threw(keys + three + asUid(A, `
        select public.pm_group_create('pmtest room', null, null,
          ${literal(JSON.stringify([D]))}, ${literal(R1)});`),
       /rooms a day/),
       "three rooms in a day is enough for a person and too few for a machine");
  }
  {
    const three = [0, 1, 2].map((i) => `
      insert into public.pm_threads (id, kind, title, created_by)
      values (gen_random_uuid(), 'broadcast', 'pmtest cast ${i}', ${literal(A)});`).join("");
    ok(await threw(keys + dealt + three + asUid(A, `
        select public.pm_broadcast('pmtest cast', null, 'iv', 'ct',
          ${wraps([B])}, ${literal(R1)});`),
       /announcements a day/),
       "and three announcements. Per day, not per hour: per hour is seventy-two a day");
  }
  {
    const r = await tx(keys + `
      insert into public.pm_threads (id, kind, title, created_by)
      values (${literal(R1)}, 'group', 'pmtest room', ${literal(A)});
      insert into public.pm_members (thread_id, user_id, role)
      values (${literal(R1)}, ${literal(A)}, 'owner');
    ` + asUid(A, `select (public.pm_group_max_open() < public.pm_group_max())::text as r;`));
    ok(last(r).r === "true",
       "a room somebody opens is smaller than a room the platform opens, and both numbers are one statement away from changing");
  }

  section("16. The admin keeps everything they had");
  {
    const r = await tx(keys + asUid(A, `
      select public.pm_group_create('pmtest room', null, null,
        ${literal(JSON.stringify([B, C, D]))}, ${literal(R1)});
      ${members(R1)}`, { email: ADMIN_EMAIL }));
    ok(last(r).r === "pmtest_a,pmtest_b,pmtest_c,pmtest_d",
       "an admin still gathers anybody, which is what the national room is",
       JSON.stringify(last(r)));
  }
  {
    const r = await tx(keys + asUid(A, `
      select public.pm_broadcast('pmtest cast', null, 'iv', 'ct',
        ${wraps([B, C, D])}, ${literal(R1)});
      ${members(R1)}`, { email: ADMIN_EMAIL }));
    ok(last(r).r === "pmtest_a,pmtest_b,pmtest_c,pmtest_d",
       "and still announces to a whole region without previously writing to it");
  }
  {
    const r = await tx(keys + blocks(C, A) + asUid(A, `
      select public.pm_broadcast('pmtest cast', null, 'iv', 'ct',
        ${wraps([B, C, D])}, ${literal(R1)});
      ${members(R1)}`, { email: ADMIN_EMAIL }));
    ok(last(r).r === "pmtest_a,pmtest_b,pmtest_d",
       "except past a block, which even the national announcement does not cross",
       JSON.stringify(last(r)));
  }
} catch (e) {
  fail++;
  console.log("\n  FAIL  the suite threw\n        " + (e && e.message));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
