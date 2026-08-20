// ============================================================================
// p_message_sk_db_test.mjs — sender keys against the REAL database.
//
// p_sender_key_test.mjs proves the scheme in isolation. This proves the half
// that only the database can enforce: that a client which FORGETS to rotate is
// refused rather than quietly leaking to someone who was removed.
//
// The centrepiece is section 4, which runs the whole thing end to end — real
// RLS, real crypto — and checks that a removed member cannot read what the
// room says after they are gone.
//
// Writes to production; rows are prefixed `pmtest_` and removed at both ends.
//
//   usage:  node tests/p_message_sk_db_test.mjs
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { runSql, asUser, literal } from "../scripts/db/sql.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

const AMINA = "pmtest_amina", JUMA = "pmtest_juma", MOLE = "pmtest_mole", NOSY = "pmtest_nosy";
const IDS = [AMINA, JUMA, MOLE, NOSY];
const ADMIN = "pmtest_admin";
const adminEmail = (readFileSync(join(ROOT, "js/core/config.js"), "utf8")
  .match(/ADMIN_EMAILS:\s*\[\s*"([^"]+)"/) || [])[1];

async function cleanup() {
  await runSql(`
    delete from public.pm_sender_keys where sender_id like 'pmtest_%' or recipient_id like 'pmtest_%';
    delete from public.pm_message_keys where user_id like 'pmtest_%';
    delete from public.pm_messages where sender_id like 'pmtest_%'
       or thread_id in (select id from public.pm_threads where created_by like 'pmtest_%' or title like 'pmtest %');
    delete from public.pm_members where user_id like 'pmtest_%'
       or thread_id in (select id from public.pm_threads where created_by like 'pmtest_%' or title like 'pmtest %');
    delete from public.pm_threads where created_by like 'pmtest_%' or title like 'pmtest %';
    delete from public.pm_keys where user_id like 'pmtest_%';
    select 1 as done;`);
}

try {
  await cleanup();

  section("0. A room with four people in it");
  const people = {};
  for (const id of IDS.concat([ADMIN])) {
    const idn = { userId: id, ...(await PM.generateIdentity()) };
    idn.fingerprint = await PM.fingerprint(idn.publicKey);
    people[id] = idn;
    const who = id === ADMIN ? { sub: ADMIN, email: adminEmail } : { sub: id };
    await asUser(who, `select public.pm_publish_key(
      ${literal(idn.publicKey)}, ${literal(idn.fingerprint)},
      ${literal(id.replace("pmtest_", "Test "))}, 'Mwanza');`);
  }
  await runSql(`update public.pm_keys set is_agent = true where user_id like 'pmtest_%';`);

  const admin = { sub: ADMIN, email: adminEmail };
  const made = await asUser(admin,
    `select public.pm_group_create('pmtest sk room', null, 'Mwanza',
       ${literal(JSON.stringify([AMINA, JUMA, MOLE]))}::jsonb) as id;`);
  const room = made[0].id;
  ok(!!room, "the admin opens a room", room);

  const gen0 = (await runSql(
    `select key_generation from public.pm_threads where id = ${literal(room)}::uuid;`))[0].key_generation;
  ok(gen0 === 0, "which starts at generation 0", String(gen0));

  section("1. Handing out a sender key");
  const keys = await asUser({ sub: AMINA },
    `select user_id, public_key from public.pm_thread_keys(${literal(room)}::uuid);`);
  const sk0 = PM.newSenderKey(0);
  const wraps0 = await PM.distributeSenderKey({
    threadId: room, senderId: AMINA, generation: 0, senderKey: sk0.raw,
    recipients: keys.map((k) => ({ userId: k.user_id, publicKey: k.public_key })),
  });
  const put = await asUser({ sub: AMINA },
    `select public.pm_sender_key_put(${literal(room)}::uuid, 0, ${literal(JSON.stringify(wraps0))}::jsonb) as n;`);
  ok(put[0].n === 4, "one wrap stored per member", String(put[0].n));

  const outsiderPut = await threw(() => asUser({ sub: NOSY },
    `select public.pm_sender_key_put(${literal(room)}::uuid, 0, ${literal(JSON.stringify(wraps0))}::jsonb);`));
  ok(!!outsiderPut && /not in that conversation/i.test(outsiderPut.message),
    "somebody outside the room cannot plant one", outsiderPut ? outsiderPut.message : "no error");

  section("2. Sending, and the guard that must come first");
  const virgin = await threw(() => asUser({ sub: JUMA },
    `select public.pm_send_sk(${literal(room)}::uuid, 0, 0, 'iv', 'ct');`));
  ok(!!virgin && /hand out your key/i.test(virgin.message),
    "you cannot send under a key you never handed out — it would be unreadable to everyone",
    virgin ? virgin.message : "no error raised");

  const said = "Bei ya Mwanza imepanda. Tusikubali chini ya 300,000.";
  const m0 = await PM.sealWithSenderKey({
    threadId: room, senderId: AMINA, generation: 0, seq: 0, senderKey: sk0.raw, plaintext: said,
  });
  await asUser({ sub: AMINA }, `select public.pm_send_sk(
    ${literal(room)}::uuid, 0, 0, ${literal(m0.iv)}, ${literal(m0.ciphertext)}) as id;`);
  ok(true, "and once it is handed out, a message goes with no per-recipient wrap at all");

  const wrapCount = (await runSql(
    `select count(*)::int as n from public.pm_message_keys mk
      join public.pm_messages m on m.id = mk.message_id
     where m.thread_id = ${literal(room)}::uuid;`))[0].n;
  ok(wrapCount === 0,
    "the message table holds ZERO per-recipient wraps for it — that is the whole saving", String(wrapCount));

  const raw = (await runSql(
    `select string_agg(ciphertext, ' ') as everything from public.pm_messages
      where thread_id = ${literal(room)}::uuid;`))[0].everything || "";
  ok(!/300,000|Tusikubali/i.test(raw), "and the body is still unreadable to the database owner");

  section("3. Reading it");
  for (const who of [JUMA, MOLE]) {
    const mine = await asUser({ sub: who },
      `select sender_id, generation, epk, wrapped_key from public.pm_sender_keys_for(${literal(room)}::uuid);`);
    const key = await PM.openSenderKey({
      thread_id: room, sender_id: mine[0].sender_id, generation: mine[0].generation,
      epk: mine[0].epk, wrapped_key: mine[0].wrapped_key,
    }, people[who]);
    const rows = await asUser({ sub: who },
      `select thread_id, sender_id, generation, seq, iv, ciphertext
         from public.pm_thread_messages(${literal(room)}::uuid, 50);`);
    const opened = await PM.openWithSenderKey({ ...rows[0], thread_id: room }, key);
    ok(opened === said, `${who.replace("pmtest_", "")} reads it`);
  }

  const nosyKeys = await asUser({ sub: NOSY },
    `select count(*)::int as n from public.pm_sender_keys_for(${literal(room)}::uuid);`);
  ok(nosyKeys[0].n === 0, "somebody outside the room gets no sender keys");

  section("4. THE RULE — removing someone actually removes them");
  await asUser(admin, `select public.pm_group_remove(${literal(room)}::uuid, ${literal(MOLE)});`);
  const bumped = (await runSql(
    `select key_generation from public.pm_threads where id = ${literal(room)}::uuid;`))[0].key_generation;
  ok(bumped === 1, "removing a member bumps the room's generation, in the database", String(bumped));

  const moleWraps = (await runSql(
    `select count(*)::int as n from public.pm_sender_keys
      where thread_id = ${literal(room)}::uuid and recipient_id = ${literal(MOLE)};`))[0].n;
  ok(moleWraps === 0, "and drops the wraps addressed to them");

  // The forgetful client: still holding generation 0, tries to carry on.
  const m1 = await PM.sealWithSenderKey({
    threadId: room, senderId: AMINA, generation: 0, seq: 1, senderKey: sk0.raw,
    plaintext: "Mole ameondoka, sasa tuongee.",
  });
  const stale = await threw(() => asUser({ sub: AMINA }, `select public.pm_send_sk(
    ${literal(room)}::uuid, 0, 1, ${literal(m1.iv)}, ${literal(m1.ciphertext)});`));
  ok(!!stale && /rotate/i.test(stale.message),
    "a client that forgot to rotate is REFUSED — this is the line the whole scheme rests on",
    stale ? stale.message : "no error raised, which would be a silent leak to the person just removed");

  const stalePut = await threw(() => asUser({ sub: AMINA },
    `select public.pm_sender_key_put(${literal(room)}::uuid, 0, ${literal(JSON.stringify(wraps0))}::jsonb);`));
  ok(!!stalePut && /stale/i.test(stalePut.message),
    "and it cannot re-publish the old generation either", stalePut ? stalePut.message : "no error");

  section("5. Rotating properly");
  const keys1 = await asUser({ sub: AMINA },
    `select user_id, public_key from public.pm_thread_keys(${literal(room)}::uuid);`);
  ok(!keys1.some((k) => k.user_id === MOLE), "the room's key list no longer includes the person who left");

  const sk1 = PM.nextGeneration(0);
  const wraps1 = await PM.distributeSenderKey({
    threadId: room, senderId: AMINA, generation: sk1.generation, senderKey: sk1.raw,
    recipients: keys1.map((k) => ({ userId: k.user_id, publicKey: k.public_key })),
  });
  await asUser({ sub: AMINA },
    `select public.pm_sender_key_put(${literal(room)}::uuid, 1, ${literal(JSON.stringify(wraps1))}::jsonb) as n;`);

  const afterText = "Mole ameondoka, sasa tuongee kwa uhuru.";
  const m2 = await PM.sealWithSenderKey({
    threadId: room, senderId: AMINA, generation: 1, seq: 0, senderKey: sk1.raw, plaintext: afterText,
  });
  await asUser({ sub: AMINA }, `select public.pm_send_sk(
    ${literal(room)}::uuid, 1, 0, ${literal(m2.iv)}, ${literal(m2.ciphertext)}) as id;`);
  ok(true, "after rotating, sending works again");

  // Juma is still in the room and reads it.
  const jumaKeys = await asUser({ sub: JUMA },
    `select sender_id, generation, epk, wrapped_key from public.pm_sender_keys_for(${literal(room)}::uuid)
      where generation = 1;`);
  const jumaKey1 = await PM.openSenderKey({
    thread_id: room, sender_id: AMINA, generation: 1,
    epk: jumaKeys[0].epk, wrapped_key: jumaKeys[0].wrapped_key,
  }, people[JUMA]);
  const jumaReads = await PM.openWithSenderKey({
    thread_id: room, sender_id: AMINA, generation: 1, seq: 0,
    iv: m2.iv, ciphertext: m2.ciphertext,
  }, jumaKey1);
  ok(jumaReads === afterText, "and the people still in the room read it");

  // And the removed member, holding generation 0, cannot.
  const moleTries = await threw(() => PM.openWithSenderKey({
    thread_id: room, sender_id: AMINA, generation: 1, seq: 0,
    iv: m2.iv, ciphertext: m2.ciphertext,
  }, sk0.raw));
  ok(!!moleTries,
    "while the removed member, still holding the old key, cannot open a word of it");

  const moleSees = await asUser({ sub: MOLE },
    `select count(*)::int as n from public.pm_thread_messages(${literal(room)}::uuid, 50);`);
  ok(moleSees[0].n === 0, "in fact the room's messages are no longer served to them at all");

  section("6. Old-style messages still work beside the new ones");
  const mixed = await asUser({ sub: AMINA },
    `select user_id, public_key from public.pm_thread_keys(${literal(room)}::uuid);`);
  const sealedOld = await PM.seal({
    threadId: room, senderId: AMINA, plaintext: "an ordinary wrapped message",
    recipients: mixed.map((k) => ({ userId: k.user_id, publicKey: k.public_key })),
  });
  await asUser({ sub: AMINA }, `select public.pm_send(
    ${literal(room)}::uuid, ${literal(sealedOld.iv)}, ${literal(sealedOld.ciphertext)},
    ${literal(JSON.stringify(sealedOld.keys))}::jsonb) as id;`);

  const all = await asUser({ sub: JUMA },
    `select generation, wrapped_key from public.pm_thread_messages(${literal(room)}::uuid, 50);`);
  ok(all.length === 3, "the thread now holds both kinds", JSON.stringify(all.map((r) => r.generation)));
  ok(all.some((r) => r.generation === null && r.wrapped_key),
    "the per-recipient one carries a wrap");
  ok(all.some((r) => r.generation !== null && !r.wrapped_key),
    "and the sender-key ones carry none — the client picks its path off that");
} catch (err) {
  // Without this the finally block's process.exit() swallows the exception and
  // the run reports "1 passed" with exit 0 while having tested nothing at all.
  fail++;
  console.log("\n  THREW  " + (err && err.message ? err.message : String(err)));
  if (err && err.stack) console.log(String(err.stack).split("\n").slice(1, 4).join("\n"));
} finally {
  await cleanup();
  const left = await runSql(`
    select (select count(*)::int from public.pm_sender_keys where sender_id like 'pmtest_%') as sk,
           (select count(*)::int from public.pm_keys where user_id like 'pmtest_%') as keys,
           (select count(*)::int from public.pm_threads where title like 'pmtest %') as threads;`);
  const clean = left[0].sk === 0 && left[0].keys === 0 && left[0].threads === 0;
  ok(clean, "every test row is gone from production", JSON.stringify(left[0]));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
