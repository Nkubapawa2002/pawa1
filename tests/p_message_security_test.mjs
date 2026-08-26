// ============================================================================
// p_message_security_test.mjs — the four table-level holes, written as the
// requests that walked through them.
// ============================================================================
// p_message_db_test.mjs proves the RPCs behave. This proves the thing that
// made those proofs insufficient: PostgREST publishes every table in `public`,
// Supabase grants anon and authenticated all four DML privileges on them, and
// P-Message's row policies — not its functions — were the only thing in the
// way. Three of the four write policies were wrong.
//
// Every attack here is written as the HTTP request it would be in a browser
// console, run through `set local role authenticated` with real JWT claims,
// because as `postgres` every policy is bypassed and the test would prove
// nothing whatsoever.
//
// Both halves are asserted for each one: the attack fails, AND the legitimate
// path it shadowed still works. A test that only checks the first can be
// passed by breaking the feature.
//
// It writes to production. Every row is prefixed `pmsec_` and deleted at both
// ends of the run.
//
//   usage:  node tests/p_message_security_test.mjs
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { runSql, asUser, literal } from "../scripts/db/sql.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- the real crypto lib, in a Node sandbox --------------------------------
const store = new Map();
const sandbox = {
  console, crypto: webcrypto, TextEncoder, TextDecoder, Buffer,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};
sandbox.globalThis = sandbox; sandbox.window = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, "js/lib/p-crypto.js"), "utf8"), ctx, { filename: "p-crypto.js" });
const PM = sandbox.PMCrypto;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

/**
 * A guest session. `asUser` sets only sub and email, and every app_is_guest()
 * fence reads the `is_anonymous` claim — without it a guest test silently runs
 * as an ordinary account and proves the opposite of what it says.
 */
function asGuest({ sub }, sql) {
  const claims = JSON.stringify({ sub, role: "authenticated", is_anonymous: true });
  return runSql(
    `begin;
     do $claims$ begin perform set_config('request.jwt.claims', ${literal(claims)}, true); end $claims$;
     set local role authenticated;
     ${sql}
     commit;`
  );
}

/** Nobody at all: the public anon key, which anyone can read out of the page. */
function asAnon(sql) {
  return runSql(
    `begin;
     do $claims$ begin perform set_config('request.jwt.claims', '{"role":"anon"}', true); end $claims$;
     set local role anon;
     ${sql}
     commit;`
  );
}

const ADMIN = "pmsec_admin", AMINA = "pmsec_amina", JOHN = "pmsec_john", MOLE = "pmsec_mole";
const GUEST = "pmsec_guest";
const IDS = [ADMIN, AMINA, JOHN, MOLE, GUEST];

const adminEmail = (readFileSync(join(ROOT, "js/core/config.js"), "utf8")
  .match(/ADMIN_EMAILS:\s*\[\s*"([^"]+)"/) || [])[1];

async function cleanup() {
  await runSql(`
    delete from public.pm_sender_keys where sender_id like 'pmsec_%' or recipient_id like 'pmsec_%'
       or thread_id in (select id from public.pm_threads where created_by like 'pmsec_%' or title like 'pmsec %');
    delete from public.pm_message_keys where user_id like 'pmsec_%'
       or message_id in (select id from public.pm_messages where sender_id like 'pmsec_%');
    delete from public.pm_messages where sender_id like 'pmsec_%'
       or thread_id in (select id from public.pm_threads where created_by like 'pmsec_%' or title like 'pmsec %');
    delete from public.pm_invites where agent_id like 'pmsec_%' or accepted_by like 'pmsec_%';
    delete from public.pm_members where user_id like 'pmsec_%'
       or thread_id in (select id from public.pm_threads where created_by like 'pmsec_%' or title like 'pmsec %');
    delete from public.pm_threads where created_by like 'pmsec_%' or title like 'pmsec %';
    delete from public.pm_keys where user_id like 'pmsec_%';
    select 1 as done;`);
}

/** Did a write attempt fail — by raising, or by touching nothing? */
function blocked(err, before, after) {
  return err !== null || JSON.stringify(before) === JSON.stringify(after);
}

try {
  await cleanup();

  const people = {};
  for (const id of IDS) {
    const idn = { userId: id, ...(await PM.generateIdentity()) };
    idn.fingerprint = await PM.fingerprint(idn.publicKey);
    people[id] = idn;
  }

  // Amina is a real agent; everyone else is a plain account. The agent profile
  // is what pm_publish_key reads to decide is_agent, and the whole first
  // section is about somebody who has no such row claiming the flag anyway.
  await runSql(`
    insert into public.agent_profiles (user_id, name, phone, region, area_of_operations, district, ward)
    values (${literal(AMINA)}, 'pmsec Amina', '+255700000001', 'Mwanza', 'Nyamagana', 'Nyamagana', 'Mirongo')
    on conflict (user_id) do update set area_of_operations = excluded.area_of_operations;`);

  for (const id of [ADMIN, AMINA, JOHN, MOLE]) {
    await asUser({ sub: id, email: id === ADMIN ? adminEmail : null },
      `select public.pm_publish_key(${literal(people[id].publicKey)},
         ${literal(people[id].fingerprint)}, ${literal("pmsec " + id.slice(6))}, 'Mwanza');`);
  }
  await asGuest({ sub: GUEST },
    `select public.pm_publish_key(${literal(people[GUEST].publicKey)},
       ${literal(people[GUEST].fingerprint)}, 'pmsec visitor', 'Mwanza');`);

  // ==========================================================================
  section("1. Identity forgery — pm_keys was writable column by column");
  // ==========================================================================
  // PATCH /rest/v1/pm_keys?user_id=eq.<me> {"is_agent":true,"is_guest":false}
  const forge = await threw(() => asGuest({ sub: GUEST },
    `update public.pm_keys set is_agent = true, is_guest = false,
       display_name = 'Maisha Support' where user_id = ${literal(GUEST)};`));
  const guestRow = (await runSql(
    `select is_agent, is_guest, display_name from public.pm_keys where user_id = ${literal(GUEST)};`))[0];

  ok(forge !== null || guestRow.is_agent === false,
     "a guest cannot promote themselves to Agent by writing the column",
     JSON.stringify(guestRow));
  ok(guestRow.is_guest === true,
     "nor drop the guest flag that every fence in p_message_guests.sql reads");
  ok(guestRow.display_name === "pmsec visitor",
     "nor rename themselves 'Maisha Support' in everybody's thread list");

  // The same attack by INSERT, for anyone who has no row yet.
  const forgeIns = await threw(() => asUser({ sub: "pmsec_ghost" },
    `insert into public.pm_keys (user_id, public_key, fingerprint, display_name, is_agent)
     values ('pmsec_ghost', ${literal(people[MOLE].publicKey)}, '00000 00000 00000 00000 00000 00000',
             'Maisha Support', true);`));
  const ghost = await runSql(`select count(*)::int as n from public.pm_keys where user_id = 'pmsec_ghost';`);
  ok(forgeIns !== null || ghost[0].n === 0,
     "and cannot be done by inserting the row from scratch either",
     forgeIns && forgeIns.message);

  // The legitimate path still sets the flag it is supposed to set.
  const aminaRow = (await runSql(
    `select is_agent, is_guest, region from public.pm_keys where user_id = ${literal(AMINA)};`))[0];
  ok(aminaRow.is_agent === true,
     "while a real agent_profiles row still makes somebody an Agent, via pm_publish_key");
  ok(aminaRow.region === "Mwanza", "with the region their profile actually says");

  // And the guest fence it protects is therefore still standing.
  const guestToGuest = await threw(() => asGuest({ sub: GUEST },
    `select public.pm_start_direct(${literal(JOHN)});`));
  ok(guestToGuest !== null && /only message agents/i.test(guestToGuest.message),
     "so 'guests can only message agents' still means something",
     guestToGuest && guestToGuest.message);

  const guestToAgent = await asGuest({ sub: GUEST },
    `select public.pm_start_direct(${literal(AMINA)}) as id;`);
  ok(!!guestToAgent[0].id, "and a guest can still open a thread with a real agent");

  // ==========================================================================
  section("2. Room takeover — pm_members.role was the member's to write");
  // ==========================================================================
  const room = (await asUser({ sub: ADMIN, email: adminEmail },
    `select public.pm_group_create('pmsec room', null, 'Mwanza',
       ${literal(JSON.stringify([AMINA, JOHN, MOLE]))}::jsonb) as id;`))[0].id;
  ok(!!room, "an admin opens a room", room);

  const before = await runSql(
    `select user_id, role from public.pm_members where thread_id = ${literal(room)}::uuid order by user_id;`);

  // PATCH /rest/v1/pm_members?thread_id=eq.<room>&user_id=eq.<me> {"role":"owner"}
  const promote = await threw(() => asUser({ sub: MOLE },
    `update public.pm_members set role = 'owner'
      where thread_id = ${literal(room)}::uuid and user_id = ${literal(MOLE)};`));
  const after = await runSql(
    `select user_id, role from public.pm_members where thread_id = ${literal(room)}::uuid order by user_id;`);

  ok(blocked(promote, before, after),
     "a member cannot promote themselves to owner of the room they are in",
     JSON.stringify(after));

  const stillMember = after.find((r) => r.user_id === MOLE);
  ok(stillMember && stillMember.role === "member", "the role stays 'member'");

  // Which is what the two room powers are authorised on.
  const sneakIn = await threw(() => asUser({ sub: MOLE },
    `select public.pm_group_add(${literal(room)}::uuid, ${literal(JSON.stringify([GUEST]))}::jsonb);`));
  ok(sneakIn !== null && /only the room owner/i.test(sneakIn.message),
     "so they cannot add anyone to an encrypted room they do not own",
     sneakIn && sneakIn.message);

  const sneakOut = await threw(() => asUser({ sub: MOLE },
    `select public.pm_group_remove(${literal(room)}::uuid, ${literal(JOHN)});`));
  ok(sneakOut !== null && /only the room owner/i.test(sneakOut.message),
     "nor empty it of everybody else");

  // And the admin who opened it still can.
  const added = await asUser({ sub: ADMIN, email: adminEmail },
    `select public.pm_group_add(${literal(room)}::uuid, ${literal(JSON.stringify([ADMIN]))}::jsonb) as n;`);
  ok(typeof added[0].n === "number", "the admin who opened the room still runs it");

  const leftOk = await threw(() => asUser({ sub: MOLE },
    `select public.pm_group_leave(${literal(room)}::uuid);`));
  const goneRows = await runSql(
    `select count(*)::int as n from public.pm_members
      where thread_id = ${literal(room)}::uuid and user_id = ${literal(MOLE)};`);
  ok(leftOk === null && goneRows[0].n === 0, "and anybody can still walk out of a room themselves");

  // ==========================================================================
  section("3. Rotation — a generation from the future outlived every change");
  // ==========================================================================
  const skRoom = (await asUser({ sub: ADMIN, email: adminEmail },
    `select public.pm_group_create('pmsec sk room', null, 'Mwanza',
       ${literal(JSON.stringify([AMINA, JOHN, MOLE]))}::jsonb) as id;`))[0].id;

  const wraps = await PM.distributeSenderKey({
    threadId: skRoom, senderId: AMINA, generation: 2147483647,
    senderKey: PM.newSenderKey(0).raw,
    recipients: [{ userId: AMINA, publicKey: people[AMINA].publicKey },
                 { userId: JOHN, publicKey: people[JOHN].publicKey }],
  });
  const future = await threw(() => asUser({ sub: AMINA },
    `select public.pm_sender_key_put(${literal(skRoom)}::uuid, 2147483647,
       ${literal(JSON.stringify(wraps))}::jsonb);`));
  ok(future !== null && /has not reached generation/i.test(future.message),
     "a sender key cannot be handed out at a generation the room has not reached",
     future && future.message);

  const futureSend = await threw(() => asUser({ sub: AMINA },
    `select public.pm_send_sk(${literal(skRoom)}::uuid, 2147483647, 0, 'aXY', 'Y2lwaGVy');`));
  ok(futureSend !== null && /has not reached generation/i.test(futureSend.message),
     "and a message cannot be sent under one, which is what made rotation a no-op",
     futureSend && futureSend.message);

  // The honest path: distribute at the CURRENT generation, then send.
  const now0 = await PM.distributeSenderKey({
    threadId: skRoom, senderId: AMINA, generation: 0,
    senderKey: PM.newSenderKey(0).raw,
    recipients: [{ userId: AMINA, publicKey: people[AMINA].publicKey },
                 { userId: JOHN, publicKey: people[JOHN].publicKey }],
  });
  const putOk = await threw(() => asUser({ sub: AMINA },
    `select public.pm_sender_key_put(${literal(skRoom)}::uuid, 0,
       ${literal(JSON.stringify(now0))}::jsonb);`));
  ok(putOk === null, "at the room's own generation it goes through", putOk && putOk.message);

  const sendOk = await threw(() => asUser({ sub: AMINA },
    `select public.pm_send_sk(${literal(skRoom)}::uuid, 0, 0, 'aXY', 'Y2lwaGVy');`));
  ok(sendOk === null, "and so does the message", sendOk && sendOk.message);

  // Now remove somebody, and the old generation must stop working.
  await asUser({ sub: ADMIN, email: adminEmail },
    `select public.pm_group_remove(${literal(skRoom)}::uuid, ${literal(MOLE)});`);
  const gen = (await runSql(
    `select key_generation from public.pm_threads where id = ${literal(skRoom)}::uuid;`))[0];
  ok(gen.key_generation === 1, "removing a member bumps the room's generation", JSON.stringify(gen));

  const stale = await threw(() => asUser({ sub: AMINA },
    `select public.pm_send_sk(${literal(skRoom)}::uuid, 0, 1, 'aXY', 'Y2lwaGVy');`));
  ok(stale !== null && /rotate your key to generation 1/i.test(stale.message),
     "and the key the removed member holds stops being accepted",
     stale && stale.message);

  // ==========================================================================
  section("4. Invites — the columns that ARE the single-use rule");
  // ==========================================================================
  const hash = "a".repeat(64);
  await asUser({ sub: AMINA }, `select public.pm_invite_create(${literal(hash)}, 'pmsec link', 14);`);
  await runSql(`update public.pm_invites set accepted_at = now(), accepted_by = ${literal(JOHN)}
                 where token_hash = ${literal(hash)};`);

  const invBefore = (await runSql(
    `select accepted_at, expires_at from public.pm_invites where token_hash = ${literal(hash)};`))[0];
  const reuse = await threw(() => asUser({ sub: AMINA },
    `update public.pm_invites set accepted_at = null, expires_at = now() + interval '9 years'
      where token_hash = ${literal(hash)};`));
  const invAfter = (await runSql(
    `select accepted_at, expires_at from public.pm_invites where token_hash = ${literal(hash)};`))[0];

  ok(blocked(reuse, invBefore, invAfter),
     "an agent cannot un-use their own spent invite link", JSON.stringify(invAfter));
  ok(invAfter.accepted_at !== null, "it stays used");

  const revoked = await threw(() => asUser({ sub: AMINA },
    `select public.pm_invite_revoke(${literal(hash)});`));
  ok(revoked === null, "withdrawing one through the RPC still works");

  // ==========================================================================
  section("5. Thread rows, and the directory the anon key could read");
  // ==========================================================================
  const junk = await threw(() => asUser({ sub: MOLE },
    `insert into public.pm_threads (kind, title, created_by) values ('group', 'pmsec junk', ${literal(MOLE)});`));
  const junkRows = await runSql(`select count(*)::int as n from public.pm_threads where title = 'pmsec junk';`);
  ok(junk !== null || junkRows[0].n === 0,
     "nobody inserts thread rows by hand — every real one comes from a function that checks something",
     junk && junk.message);

  const anonKeys = await asAnon(`select count(*)::int as n from public.pm_keys;`);
  ok(anonKeys.length === 0 || anonKeys[0].n === 0,
     "the bare anon key can no longer dump the directory of everyone who uses the site",
     JSON.stringify(anonKeys));

  const signedIn = await asUser({ sub: JOHN }, `select count(*)::int as n from public.pm_keys;`);
  ok(signedIn[0].n > 0, "while any signed-in caller still reads it, because that is what a directory is for");

  // ==========================================================================
  section("6. Size, rate and shape");
  // ==========================================================================
  const pair = (await asUser({ sub: AMINA }, `select public.pm_start_direct(${literal(JOHN)}) as id;`))[0].id;
  const oneWrap = JSON.stringify([{ user_id: AMINA, epk: "e", wrapped_key: "w" }]);

  const huge = await threw(() => asUser({ sub: AMINA },
    `select public.pm_send(${literal(pair)}::uuid, 'aXY', repeat('A', 70000), ${literal(oneWrap)}::jsonb);`));
  ok(huge !== null && /too long/i.test(huge.message),
     "a message has a ceiling, so pm_send is not free unbounded storage",
     huge && huge.message);

  const fine = await threw(() => asUser({ sub: AMINA },
    `select public.pm_send(${literal(pair)}::uuid, 'aXY', 'Y2lwaGVydGV4dA', ${literal(oneWrap)}::jsonb);`));
  ok(fine === null, "an ordinary message is nowhere near it", fine && fine.message);

  const badKey = await threw(() => asUser({ sub: JOHN },
    `select public.pm_publish_key('<script>alert(1)</script>', '00000 00000 00000 00000 00000 00000');`));
  ok(badKey !== null && /not a P-256 public key/i.test(badKey.message),
     "and a public key is checked for being one — junk there makes its owner permanently unwritable-to",
     badKey && badKey.message);

  const badFp = await threw(() => asUser({ sub: JOHN },
    `select public.pm_publish_key(${literal(people[JOHN].publicKey)}, '<b>hi</b>');`));
  ok(badFp !== null && /malformed safety number/i.test(badFp.message),
     "the safety-number column takes digits and spaces, and nothing else");

  // ==========================================================================
  section("7. Reading a long conversation returns the NEWEST page");
  // ==========================================================================
  // Ascending order plus a limit returns the OLDEST n, forever: past the limit
  // a conversation freezes at its own beginning and every later message is
  // stored, delivered, decryptable and invisible.
  await runSql(`
    insert into public.pm_messages (thread_id, sender_id, iv, ciphertext, sent_at)
    select ${literal(pair)}::uuid, ${literal(AMINA)}, 'aXY', 'ct' || g,
           now() - ((60 - g) || ' minutes')::interval
      from generate_series(1, 12) g;
    insert into public.pm_message_keys (message_id, user_id, epk, wrapped_key)
    select id, ${literal(JOHN)}, 'e', 'w' from public.pm_messages
     where thread_id = ${literal(pair)}::uuid and ciphertext like 'ct%';
    select 1 as done;`);

  const page = await asUser({ sub: JOHN },
    `select ciphertext from public.pm_thread_messages(${literal(pair)}::uuid, 5);`);
  ok(page.length === 5, "a page is the size asked for", String(page.length));
  ok(page[page.length - 1].ciphertext === "ct12",
     "and it ends at the most recent message, not at the twelfth-oldest",
     JSON.stringify(page.map((r) => r.ciphertext)));
  ok(page[0].ciphertext === "ct8", "reading in order, oldest of the page first");

  // ==========================================================================
  section("8. Where people work, wherever they are shown");
  // ==========================================================================
  const peer = await asUser({ sub: GUEST },
    `select display_name, area, district, ward, region, is_agent
       from public.pm_peer(${literal(AMINA)});`);
  ok(peer.length === 1 && peer[0].area === "Nyamagana",
     "the person on the other side of a thread comes with their area of operation",
     JSON.stringify(peer[0]));
  ok(peer[0].ward === "Mirongo", "and the ward behind it, kept separate");

  const roster = await asUser({ sub: AMINA },
    `select user_id, display_name, area, is_agent, is_guest, role
       from public.pm_thread_keys(${literal(room)}::uuid) order by user_id;`);
  ok(roster.length >= 2, "a room member can list the room", String(roster.length));
  const rAmina = roster.find((r) => r.user_id === AMINA);
  ok(rAmina && rAmina.area === "Nyamagana",
     "with where each member works, which is the only reason to pick one over another");

  const outsiderRoster = await asUser({ sub: "pmsec_outsider" },
    `select count(*)::int as n from public.pm_thread_keys(${literal(room)}::uuid);`);
  ok(outsiderRoster[0].n === 0, "and somebody outside the room learns nothing about who is in it");

  const cands = await asUser({ sub: ADMIN, email: adminEmail },
    `select user_id, display_name, area, n_houses, n_services, n_trucks
       from public.pm_group_candidates(null, 'Mwanza');`);
  ok(cands.length > 0, "the admin's room roster preview returns candidates", String(cands.length));
  ok(cands.every((c) => "area" in c && "n_trucks" in c),
     "each one carrying where they work and what they deal in, so the admin can pick rather than take all");

  const notAdminCands = await asUser({ sub: MOLE },
    `select count(*)::int as n from public.pm_group_candidates(null, 'Mwanza');`);
  ok(notAdminCands[0].n === 0, "and a non-admin gets nobody at all");

  // ==========================================================================
  section("9. The promise itself, unchanged");
  // ==========================================================================
  const secret = "pmsec: bei ya mwisho ni 240,000 kwa mwezi";
  const sealed = await PM.seal({
    threadId: pair, senderId: AMINA, plaintext: secret,
    recipients: [{ userId: AMINA, publicKey: people[AMINA].publicKey },
                 { userId: JOHN, publicKey: people[JOHN].publicKey }],
  });
  await asUser({ sub: AMINA }, `select public.pm_send(${literal(pair)}::uuid,
    ${literal(sealed.iv)}, ${literal(sealed.ciphertext)}, ${literal(JSON.stringify(sealed.keys))}::jsonb);`);

  const asOwner = await runSql(
    `select string_agg(ciphertext, ' ') as everything from public.pm_messages
      where thread_id = ${literal(pair)}::uuid;`);
  ok(!/240,000/.test(asOwner[0].everything || ""),
     "the body is still unreadable to the database owner — none of this touched the crypto");

  const mine = await asUser({ sub: JOHN },
    `select thread_id, sender_id, iv, ciphertext, epk, wrapped_key
       from public.pm_thread_messages(${literal(pair)}::uuid, 200)
      where wrapped_key <> 'w' order by sent_at desc limit 1;`);
  ok(mine.length === 1 && await PM.open(mine[0], people[JOHN]) === secret,
     "and the person it was sealed for still opens it");

  const admins = (await runSql(
    `select count(*)::int as n from pg_policies where schemaname = 'public'
      and tablename like 'pm%' and cmd <> 'SELECT';`))[0];
  ok(admins.n === 0,
     "with no write policy left on any pm_ table: every write goes through a function that checks something",
     JSON.stringify(admins));
} catch (err) {
  fail++;
  console.log("\n  THREW  " + (err && err.message ? err.message : String(err)));
  if (err && err.stack) console.log(String(err.stack).split("\n").slice(1, 4).join("\n"));
} finally {
  await cleanup();
  await runSql(`delete from public.agent_profiles where user_id like 'pmsec_%'; select 1 as done;`);
  console.log("\n  (test rows removed)");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
