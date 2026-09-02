// ============================================================================
// p_message_purge_test.mjs — deleting a whole conversation, against the REAL
// database with RLS on.
//
// supabase/features/message/p_message_purge.sql opened one door that had been
// deliberately shut: a direct thread can now be deleted from one side. The
// rules that keep that door narrow are the entire feature, so this test is
// mostly about what pm_direct_delete REFUSES:
//
//   · a guest cannot delete a conversation, ever. It is also the agent's.
//   · one account cannot delete a conversation with another account.
//   · somebody who is not in a thread cannot delete it.
//   · a room does not go through this door; it has its own.
//
// and then the two cases it exists for:
//
//   · an account CAN delete a conversation with a guest;
//   · and one with somebody who has already gone, which is what a thread looks
//     like after pm_guest_forget.
//
// Messages are inserted directly rather than sealed and sent: what is being
// proved here is the cascade and the rules, and the sealing has its own test
// in p_crypto_test.mjs and p_message_db_test.mjs.
//
// It writes to production, so every row it creates is prefixed `pmtest_` and
// deleted at both ends of the run.
//
//   usage:  node tests/p_message_purge_test.mjs
// ============================================================================
import { webcrypto } from "node:crypto";
import { runSql, literal } from "../scripts/db/sql.mjs";

// pm_publish_key checks the shape of what it is given (p_message_security.sql),
// so the keys here are real P-256 ones rather than a string that looks like a
// key. Nothing in this test opens anything with them.
async function realKey() {
  const kp = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const spki = Buffer.from(await webcrypto.subtle.exportKey("spki", kp.publicKey));
  return spki.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// The is_anonymous claim is the only thing that separates a guest from an
// account, so it is the only thing these two helpers differ by.
function claimed(sub, anon, sql) {
  const claims = JSON.stringify({ sub, role: "authenticated", is_anonymous: anon });
  return runSql(
    `begin;
     do $c$ begin perform set_config('request.jwt.claims', ${literal(claims)}, true); end $c$;
     set local role authenticated;
     ${sql}
     commit;`);
}
const asGuest = (sub, sql) => claimed(sub, true, sql);
const asMember = (sub, sql) => claimed(sub, false, sql);

const AGENT = "pmtest_agent", GUEST = "pmtest_guest", GUEST2 = "pmtest_guest2";
const BUYER = "pmtest_buyer", MOLE = "pmtest_mole";

async function cleanup() {
  await runSql(`
    delete from public.pm_message_keys where user_id like 'pmtest_%';
    delete from public.pm_messages where sender_id like 'pmtest_%'
       or thread_id in (select id from public.pm_threads where created_by like 'pmtest_%');
    delete from public.pm_members where user_id like 'pmtest_%'
       or thread_id in (select id from public.pm_threads where created_by like 'pmtest_%');
    delete from public.pm_threads where created_by like 'pmtest_%';
    delete from public.pm_keys where user_id like 'pmtest_%';
    delete from public.agent_profiles where user_id like 'pmtest_%';
    select 1 as done;`);
}

const threadOf = (rows) => rows[0].id;
const alive = async (id) =>
  (await runSql(`select count(*)::int as n from public.pm_threads where id = ${literal(id)}::uuid;`))[0].n === 1;

// A message in a thread, so the cascade has something to carry away. The
// ciphertext is not real; nothing here tries to read it.
const putMessage = (thread, sender) => runSql(
  `insert into public.pm_messages (thread_id, sender_id, iv, ciphertext)
   values (${literal(thread)}::uuid, ${literal(sender)}, 'iv', 'pmtest-ciphertext');
   select 1 as done;`);

try {
  await cleanup();

  section("0. Three identities and two conversations");
  // An agent is an agent because agent_profiles says so: that is what
  // pm_publish_key reads, and what a guest is allowed to write to.
  await runSql(`insert into public.agent_profiles (user_id, name, region)
                values (${literal(AGENT)}, 'Test Agent', 'Mwanza');
                select 1 as done;`);
  for (const [id, anon] of [[AGENT, false], [BUYER, false], [MOLE, false], [GUEST, true], [GUEST2, true]]) {
    await claimed(id, anon,
      `select public.pm_publish_key(${literal(await realKey())}, '123456789012', ${literal(id)}, 'Mwanza');`);
  }
  const flags = await runSql(
    `select user_id, is_guest, is_agent from public.pm_keys where user_id like 'pmtest_%' order by user_id;`);
  ok(flags.length === 5, "five identities published a key", JSON.stringify(flags));
  ok(flags.find((f) => f.user_id === GUEST).is_guest === true, "the guest is recorded as a guest");
  ok(flags.find((f) => f.user_id === AGENT).is_agent === true, "the agent is recorded as an agent");

  const guestThread = threadOf(await asGuest(GUEST, `select public.pm_start_direct(${literal(AGENT)}) as id;`));
  const acctThread = threadOf(await asMember(BUYER, `select public.pm_start_direct(${literal(AGENT)}) as id;`));
  await putMessage(guestThread, GUEST);
  await putMessage(acctThread, BUYER);
  ok(!!guestThread && !!acctThread, "a guest wrote to the agent, and so did an account");

  section("1. What pm_direct_delete refuses");

  const byGuest = await threw(() => asGuest(GUEST,
    `select public.pm_direct_delete(${literal(guestThread)}::uuid);`));
  ok(!!byGuest && await alive(guestThread),
     "a guest CANNOT delete the conversation — it is also the agent's record of it",
     byGuest ? byGuest.message.slice(0, 90) : "the call succeeded!");

  const twoAccounts = await threw(() => asMember(AGENT,
    `select public.pm_direct_delete(${literal(acctThread)}::uuid);`));
  ok(!!twoAccounts && await alive(acctThread),
     "one account CANNOT delete a conversation with another account",
     twoAccounts ? twoAccounts.message.slice(0, 90) : "the call succeeded!");

  const outsider = await threw(() => asMember(MOLE,
    `select public.pm_direct_delete(${literal(guestThread)}::uuid);`));
  ok(!!outsider && await alive(guestThread),
     "somebody who is not in the thread cannot delete it",
     outsider ? outsider.message.slice(0, 90) : "the call succeeded!");

  const room = threadOf(await runSql(
    `insert into public.pm_threads (kind, title, created_by)
     values ('group', 'pmtest room', ${literal(AGENT)}) returning id;`));
  await runSql(`insert into public.pm_members (thread_id, user_id, role)
                values (${literal(room)}::uuid, ${literal(AGENT)}, 'owner');
                select 1 as done;`);
  const roomHere = await threw(() => asMember(AGENT,
    `select public.pm_direct_delete(${literal(room)}::uuid);`));
  ok(!!roomHere && await alive(room),
     "a room does not go through this door — pm_group_delete asks a different person",
     roomHere ? roomHere.message.slice(0, 90) : "the call succeeded!");

  section("2. What it is for");

  const del = await asMember(AGENT, `select public.pm_direct_delete(${literal(guestThread)}::uuid) as r;`);
  ok(del[0].r.deleted === true && del[0].r.guest === true,
     "the agent CAN delete the conversation with a guest", JSON.stringify(del[0].r));
  ok(!(await alive(guestThread)), "and the thread is gone");
  const leftovers = await runSql(`
    select (select count(*)::int from public.pm_messages where thread_id = ${literal(guestThread)}::uuid) as msgs,
           (select count(*)::int from public.pm_members  where thread_id = ${literal(guestThread)}::uuid) as mem;`);
  ok(leftovers[0].msgs === 0 && leftovers[0].mem === 0,
     "with every message and every membership carried away by the cascade", JSON.stringify(leftovers[0]));

  const twice = await asMember(AGENT, `select public.pm_direct_delete(${literal(guestThread)}::uuid) as r;`);
  ok(twice[0].r.deleted === false,
     "deleting it a second time says nothing was deleted rather than raising", JSON.stringify(twice[0].r));

  // What a thread looks like after p_message_guest_end.sql has run: the guest's
  // key and memberships are gone and the thread is left standing with nobody on
  // the other side of it.
  const orphan = threadOf(await asGuest(GUEST2, `select public.pm_start_direct(${literal(AGENT)}) as id;`));
  await putMessage(orphan, GUEST2);
  await runSql(`delete from public.pm_members where thread_id = ${literal(orphan)}::uuid and user_id = ${literal(GUEST2)};
                delete from public.pm_keys where user_id = ${literal(GUEST2)};
                select 1 as done;`);
  const gone = await asMember(AGENT, `select public.pm_direct_delete(${literal(orphan)}::uuid) as r;`);
  ok(gone[0].r.deleted === true && gone[0].r.orphan === true,
     "a conversation whose other side has already gone can be cleared away", JSON.stringify(gone[0].r));
  ok(!(await alive(orphan)), "and it is gone too");

  section("3. The inbox says what you are in a thread");
  const inbox = await asMember(AGENT, `select thread_id, kind, my_role, other_guest from public.pm_inbox();`);
  const roomRow = inbox.find((r) => r.thread_id === room);
  ok(!!roomRow && roomRow.my_role === "owner",
     "my_role comes down with the row, so the list can offer Delete to the owner and nobody else",
     JSON.stringify(roomRow));
  const acctRow = inbox.find((r) => r.thread_id === acctThread);
  ok(!!acctRow && acctRow.other_guest === false,
     "and other_guest still says who is on the other side", JSON.stringify(acctRow));
  ok(!inbox.some((r) => r.thread_id === guestThread),
     "the deleted conversation is out of the inbox");
} finally {
  await cleanup();
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
