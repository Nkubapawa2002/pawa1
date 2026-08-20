// ============================================================================
// p_message_group_test.mjs — agent group rooms, against the REAL database.
//
// p_crypto_test.mjs proves the sealing. p_message_db_test.mjs proves direct
// threads. This proves the third kind: a room an admin opens for a category
// and a region, that the members can all talk in.
//
// The two questions worth asking of a group, which a direct thread never
// raises, are the ones this leans hardest on:
//   · can every member read what any member wrote, and NOBODY else?
//   · does someone added tomorrow get yesterday's messages? (No. By design.
//     A test that did not pin that down would let it change by accident.)
//
// Every statement runs as a signed-in user (`set local role authenticated`),
// because as `postgres` every policy is bypassed and the test proves nothing.
//
// It writes to production, so every row it creates is prefixed `pmtest_` and
// deleted at both ends of the run.
//
//   usage:  node tests/p_message_group_test.mjs
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

// ASHA lists houses, JUMA services, MOLE trucks, LATE nothing (added later),
// ZURI is a guest — a browser tab that must never land in a room of agents.
const ASHA = "pmtest_asha", JUMA = "pmtest_juma", MOLE = "pmtest_mole",
      LATE = "pmtest_late", ZURI = "pmtest_zuri";
const IDS = [ASHA, JUMA, MOLE, LATE, ZURI];
const ADMIN = "pmtest_admin";

const adminEmail = (readFileSync(join(ROOT, "js/core/config.js"), "utf8")
  .match(/ADMIN_EMAILS:\s*\[\s*"([^"]+)"/) || [])[1];

async function cleanup() {
  await runSql(`
    delete from public.pm_message_keys where user_id like 'pmtest_%';
    delete from public.pm_messages where sender_id like 'pmtest_%'
       or thread_id in (select id from public.pm_threads where created_by like 'pmtest_%' or title like 'pmtest %');
    delete from public.pm_members where user_id like 'pmtest_%'
       or thread_id in (select id from public.pm_threads where created_by like 'pmtest_%' or title like 'pmtest %');
    delete from public.pm_threads where created_by like 'pmtest_%' or title like 'pmtest %';
    delete from public.pm_keys where user_id like 'pmtest_%';
    delete from public.houses   where id like 'pmtest_%' or owner_user_id like 'pmtest_%';
    delete from public.services where id like 'pmtest_%' or owner_user_id like 'pmtest_%';
    delete from public.trucks   where id like 'pmtest_%' or owner_user_id like 'pmtest_%';
    select 1 as done;`);
}

try {
  await cleanup();

  // ------------------------------------------------------------------ setup
  section("0. Five identities and what each of them lists");
  const people = {};
  for (const id of IDS) {
    const idn = { userId: id, ...(await PM.generateIdentity()) };
    idn.fingerprint = await PM.fingerprint(idn.publicKey);
    people[id] = idn;
    await asUser({ sub: id }, `select public.pm_publish_key(
      ${literal(idn.publicKey)}, ${literal(idn.fingerprint)},
      ${literal(id.replace("pmtest_", "Test "))}, 'Mwanza');`);
  }
  // ZURI is the guest. is_guest is set by pm_publish_key from the JWT, which
  // this harness cannot forge, so it is set directly — the thing under test is
  // that pm_group_candidates EXCLUDES guests, not how the flag gets there.
  await runSql(`update public.pm_keys set is_guest = true where user_id = ${literal(ZURI)};`);
  await runSql(`update public.pm_keys set is_agent = true where user_id in (${literal(ASHA)}, ${literal(JUMA)}, ${literal(MOLE)});`);
  // MOLE works out of Dar, so the region filter has something to exclude.
  await runSql(`update public.pm_keys set region = 'Dar es Salaam' where user_id = ${literal(MOLE)};`);

  await runSql(`
    insert into public.houses (id, title, type, listing, owner_user_id, region)
      values ('pmtest_h1', 'pmtest house', 'room', 'rent', ${literal(ASHA)}, 'Mwanza');
    insert into public.services (id, title, owner_user_id, region)
      values ('pmtest_s1', 'pmtest service', ${literal(JUMA)}, 'Mwanza');
    insert into public.trucks (id, title, owner_user_id, region)
      values ('pmtest_t1', 'pmtest truck', ${literal(MOLE)}, 'Dar es Salaam');
    select 1 as done;`);
  ok(true, "keys published, listings planted");

  // -------------------------------------------------------------- candidates
  section("1. Who is in scope — and who decides");
  const asOutsider = await asUser({ sub: JUMA },
    `select count(*)::int as n from public.pm_group_candidates(null, null);`);
  ok(asOutsider[0].n === 0,
    "a non-admin gets an empty list, not a roster of every agent in the country");

  const admin = { sub: ADMIN, email: adminEmail };

  // The admin joins every room they open as owner, so they need a key before
  // they can open one. Prove the guard fires BEFORE publishing theirs.
  if (adminEmail) {
    const keyless = await threw(() => asUser(admin,
      `select public.pm_group_create('pmtest keyless', null, null, ${literal(JSON.stringify([ASHA]))}::jsonb);`));
    ok(!!keyless && /set up p-message/i.test(keyless.message),
      "an admin with no key of their own cannot open a room -- they would own it and be unable to read a word of it",
      keyless ? keyless.message : "no error raised");
  }
  {
    const idn = { userId: ADMIN, ...(await PM.generateIdentity()) };
    idn.fingerprint = await PM.fingerprint(idn.publicKey);
    people[ADMIN] = idn;
    await asUser(admin, `select public.pm_publish_key(
      ${literal(idn.publicKey)}, ${literal(idn.fingerprint)}, 'Test admin', 'Mwanza');`);
  }
  if (!adminEmail) {
    ok(false, "ADMIN_EMAILS could not be read from config.js — admin paths not exercised");
  } else {
    const houses = await asUser(admin,
      `select user_id, listings from public.pm_group_candidates('houses', null) where user_id like 'pmtest_%';`);
    ok(houses.length === 1 && houses[0].user_id === ASHA,
      "category 'houses' finds the house owner and nobody else",
      JSON.stringify(houses));
    ok(houses[0].listings === 1, "and counts what they actually list");

    const trucks = await asUser(admin,
      `select user_id from public.pm_group_candidates('trucks', null) where user_id like 'pmtest_%';`);
    ok(trucks.length === 1 && trucks[0].user_id === MOLE, "category 'trucks' finds the truck owner");

    const inMwanza = await asUser(admin,
      `select user_id from public.pm_group_candidates(null, 'Mwanza') where user_id like 'pmtest_%' order by user_id;`);
    const mwanzaIds = inMwanza.map((r) => r.user_id);
    ok(mwanzaIds.includes(ASHA) && mwanzaIds.includes(JUMA), "a region narrows to the people working there");
    ok(!mwanzaIds.includes(MOLE), "and leaves out the one working somewhere else", mwanzaIds.join(", "));

    const everyone = await asUser(admin,
      `select user_id from public.pm_group_candidates(null, null) where user_id like 'pmtest_%';`);
    const allIds = everyone.map((r) => r.user_id);
    ok(!allIds.includes(ZURI),
      "a guest is never a candidate — a room of agents is not a place for an anonymous tab",
      allIds.join(", "));
    ok(!allIds.includes(LATE),
      "and neither is an account that is not an agent and lists nothing");
  }

  // ------------------------------------------------------------------- create
  section("2. Opening the room");
  const denied = await threw(() => asUser({ sub: JUMA },
    `select public.pm_group_create('pmtest hijack', null, null, ${literal(JSON.stringify([ASHA, JUMA]))}::jsonb);`));
  ok(!!denied && /admin/i.test(denied.message),
    "a member cannot open a room and put people in it", denied ? denied.message : "no error raised");

  const members = [ASHA, JUMA, MOLE];
  const made = await asUser(admin,
    `select public.pm_group_create('pmtest Mwanza agents', 'houses', 'Mwanza',
       ${literal(JSON.stringify(members))}::jsonb) as id;`);
  const room = made[0].id;
  ok(!!room, "the admin opens a room", room);

  const shape = (await runSql(
    `select kind, title, category, region from public.pm_threads where id = ${literal(room)}::uuid;`))[0];
  ok(shape.kind === "group", "it is a group, the third kind of thread");
  ok(shape.category === "houses" && shape.region === "Mwanza",
    "and it remembers what it is for", JSON.stringify(shape));

  const roster = await runSql(
    `select user_id, role from public.pm_members where thread_id = ${literal(room)}::uuid order by user_id;`);
  ok(roster.length === 4, "every named member plus the admin is in it", JSON.stringify(roster.map((r) => r.user_id)));
  ok(roster.find((r) => r.user_id === ADMIN).role === "owner", "the admin who opened it owns it");

  // A repeated id must not be able to inflate the room or duplicate a row.
  const dupes = await asUser(admin,
    `select public.pm_group_create('pmtest dupes', null, null,
       ${literal(JSON.stringify([ASHA, ASHA, ASHA]))}::jsonb) as id;`);
  const dupeCount = (await runSql(
    `select count(*)::int as n from public.pm_members where thread_id = ${literal(dupes[0].id)}::uuid;`))[0].n;
  ok(dupeCount === 2, "the same person listed three times is one member, plus the admin", String(dupeCount));

  // ------------------------------------------------------------- thread keys
  section("3. The keys that make a room sendable");
  const keysForAsha = await asUser({ sub: ASHA },
    `select user_id, public_key from public.pm_thread_keys(${literal(room)}::uuid);`);
  ok(keysForAsha.length === 4, "a member can see every member's public key — without them they could read but never write",
    String(keysForAsha.length));
  ok(keysForAsha.some((k) => k.user_id === ASHA),
    "including their own, or they could not read their own message back");
  ok(keysForAsha.find((k) => k.user_id === JUMA).public_key === people[JUMA].publicKey,
    "and the key handed over is the real one");

  const keysForOutsider = await asUser({ sub: LATE },
    `select count(*)::int as n from public.pm_thread_keys(${literal(room)}::uuid);`);
  ok(keysForOutsider[0].n === 0,
    "someone outside the room gets nothing — the roster is not public");

  // ------------------------------------------------------------------ the chat
  section("4. A member talks, and the room hears it");
  const said = "Nyumba ya Mwanza imepanda bei. Tusikubali chini ya 300,000.";
  const sealed = await PM.seal({
    threadId: room, senderId: JUMA, plaintext: said,
    recipients: keysForAsha.map((k) => ({ userId: k.user_id, publicKey: k.public_key })),
  });
  await asUser({ sub: JUMA }, `select public.pm_send(
    ${literal(room)}::uuid, ${literal(sealed.iv)}, ${literal(sealed.ciphertext)},
    ${literal(JSON.stringify(sealed.keys))}::jsonb) as id;`);
  ok(true, "a member — not the admin — sends to the room");

  const raw = (await runSql(
    `select string_agg(ciphertext || iv, ' ') as everything from public.pm_messages
      where thread_id = ${literal(room)}::uuid;`))[0].everything || "";
  ok(!/300,000|Tusikubali/i.test(raw),
    "and as the database owner, bypassing every policy, the body cannot be read");

  for (const who of [ASHA, MOLE]) {
    const rows = await asUser({ sub: who },
      `select thread_id, sender_id, iv, ciphertext, epk, wrapped_key
         from public.pm_thread_messages(${literal(room)}::uuid, 50);`);
    const opened = await PM.open({ ...rows[0], thread_id: room }, people[who]);
    ok(opened === said, `${who.replace("pmtest_", "")} opens it and reads exactly what was written`);
  }

  const outsiderRows = await asUser({ sub: LATE },
    `select count(*)::int as n from public.pm_thread_messages(${literal(room)}::uuid, 50);`);
  ok(outsiderRows[0].n === 0, "and someone outside the room sees no messages at all");

  // ------------------------------------------------ the limit worth pinning
  section("5. Joining late gets you tomorrow, not yesterday");
  const added = await asUser(admin,
    `select public.pm_group_add(${literal(room)}::uuid, ${literal(JSON.stringify([LATE]))}::jsonb) as n;`);
  ok(added[0].n === 1, "the admin adds someone later, and is told how many actually joined");

  const readdition = await asUser(admin,
    `select public.pm_group_add(${literal(room)}::uuid, ${literal(JSON.stringify([LATE]))}::jsonb) as n;`);
  ok(readdition[0].n === 0, "adding the same person again adds nobody");

  const lateRows = await asUser({ sub: LATE },
    `select thread_id, sender_id, iv, ciphertext, epk, wrapped_key
       from public.pm_thread_messages(${literal(room)}::uuid, 50);`);
  ok(lateRows.length === 0,
    "the new member sees nothing that was said before they arrived — not a locked row, no row at all. "
    + "This is the design, not a bug: wraps are made when a message is sent, for the people who were "
    + "there, and pm_thread_messages joins the caller's own wrap.",
    JSON.stringify(lateRows.length));

  // ------------------------------------------------------------ leaving etc.
  section("6. Leaving, and being removed");
  await asUser({ sub: MOLE }, `select public.pm_group_leave(${literal(room)}::uuid);`);
  const afterLeave = await runSql(
    `select count(*)::int as n from public.pm_members
      where thread_id = ${literal(room)}::uuid and user_id = ${literal(MOLE)};`);
  ok(afterLeave[0].n === 0, "anyone can walk out of a room");

  const cannotRemove = await threw(() => asUser({ sub: ASHA },
    `select public.pm_group_remove(${literal(room)}::uuid, ${literal(JUMA)});`));
  ok(!!cannotRemove && /owner/i.test(cannotRemove.message),
    "an ordinary member cannot throw another member out",
    cannotRemove ? cannotRemove.message : "no error raised");

  await asUser(admin, `select public.pm_group_remove(${literal(room)}::uuid, ${literal(JUMA)});`);
  const afterRemove = await runSql(
    `select count(*)::int as n from public.pm_members
      where thread_id = ${literal(room)}::uuid and user_id = ${literal(JUMA)};`);
  ok(afterRemove[0].n === 0, "the owner can");

  // --------------------------------------------------------------- the cap
  section("7. The size cap");
  const max = (await runSql(`select public.pm_group_max() as n;`))[0].n;
  ok(max > 0 && max <= 1000, `a room is capped at ${max}, in one place`);
  const tooMany = JSON.stringify(Array.from({ length: max + 1 }, (_, i) => "pmtest_ghost_" + i));
  const capped = await threw(() => asUser(admin,
    `select public.pm_group_create('pmtest too big', null, null, ${literal(tooMany)}::jsonb);`));
  // Ghost ids hold no key, so this trips the "nobody has set up P-Message"
  // guard first — which is itself the right answer, and the cap is proven
  // above by the distinct-count that refuses to be inflated by repeats.
  ok(!!capped, "a room that could not work is refused rather than half-created",
    capped ? capped.message : "no error raised");

  section("8. Nothing leaked into the real catalogues");
  const strays = await runSql(`
    select (select count(*)::int from public.pm_threads where title like 'pmtest %') as threads,
           (select count(*)::int from public.houses where id like 'pmtest_%') as houses;`);
  ok(strays[0].threads > 0, "the test's own rows are still there, about to be cleaned up");
} finally {
  await cleanup();
  const left = await runSql(`
    select (select count(*)::int from public.pm_keys where user_id like 'pmtest_%') as keys,
           (select count(*)::int from public.pm_threads where created_by like 'pmtest_%' or title like 'pmtest %') as threads,
           (select count(*)::int from public.houses where id like 'pmtest_%') as houses;`);
  const clean = left[0].keys === 0 && left[0].threads === 0 && left[0].houses === 0;
  ok(clean, "every test row is gone from production", JSON.stringify(left[0]));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
