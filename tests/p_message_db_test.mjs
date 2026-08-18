// ============================================================================
// p_message_db_test.mjs — P-Message against the REAL database, with RLS on.
//
// p_crypto_test.mjs proves the sealing is sound in isolation. This proves the
// other half: that the server stores what it should, hands back only what the
// caller is entitled to, and — the whole point — cannot read any of it.
//
// Every statement runs as a signed-in user (`set local role authenticated` +
// request.jwt.claims), because as `postgres` every policy is bypassed and a
// test that forgets this proves nothing whatsoever.
//
// It writes to production, so every row it creates is prefixed `pmtest_` and
// deleted at both ends of the run — before, in case a previous run died
// mid-way, and after.
//
//   usage:  node tests/p_message_db_test.mjs
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

const ASHA = "pmtest_asha", JUMA = "pmtest_juma", MOLE = "pmtest_mole";
const IDS = [ASHA, JUMA, MOLE];

// The real admin, so is_admin() is exercised as it actually behaves rather
// than against a row this test invented.
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
    select 1 as done;`);
}

try {
  await cleanup();

  section("1. Publishing a key");
  const people = {};
  for (const id of IDS) {
    const idn = { userId: id, ...(await PM.generateIdentity()) };
    idn.fingerprint = await PM.fingerprint(idn.publicKey);
    people[id] = idn;
    await asUser({ sub: id }, `select public.pm_publish_key(
      ${literal(idn.publicKey)}, ${literal(idn.fingerprint)}, ${literal(id.replace("pmtest_", "Test "))}, 'Mwanza');`);
  }
  const keys = await runSql(`select user_id, region, display_name from public.pm_keys where user_id like 'pmtest_%' order by user_id;`);
  ok(keys.length === 3, "three test identities published their public keys", JSON.stringify(keys));
  ok(keys.every((k) => k.region === "Mwanza"), "the region came along, which is what makes regional broadcast possible");

  // The attack the whole key directory rests on.
  const hijack = await threw(() => asUser({ sub: MOLE },
    `update public.pm_keys set public_key = 'MOLES-KEY' where user_id = ${literal(ASHA)};`));
  const ashaKey = (await runSql(`select public_key from public.pm_keys where user_id = ${literal(ASHA)};`))[0];
  ok(ashaKey.public_key === people[ASHA].publicKey,
     "one user CANNOT overwrite another's public key — RLS refuses the substitution attack",
     hijack ? hijack.message : "update silently affected 0 rows");

  section("2. A private conversation");
  const started = await asUser({ sub: ASHA }, `select public.pm_start_direct(${literal(JUMA)}) as id;`);
  const thread = started[0].id;
  ok(!!thread, "pm_start_direct created a thread", thread);

  const again = await asUser({ sub: ASHA }, `select public.pm_start_direct(${literal(JUMA)}) as id;`);
  ok(again[0].id === thread, "tapping the same person again returns the SAME thread, not a duplicate");

  const secret = "Bei ya mwisho ni 240,000 kwa mwezi. Usimwambie mtu.";
  const sealed = await PM.seal({
    threadId: thread, senderId: ASHA, plaintext: secret,
    recipients: [
      { userId: ASHA, publicKey: people[ASHA].publicKey },
      { userId: JUMA, publicKey: people[JUMA].publicKey },
    ],
  });
  await asUser({ sub: ASHA }, `select public.pm_send(
    ${literal(thread)}::uuid, ${literal(sealed.iv)}, ${literal(sealed.ciphertext)},
    ${literal(JSON.stringify(sealed.keys))}::jsonb) as id;`);

  section("3. What the server actually holds");
  const stored = (await runSql(
    `select ciphertext, iv from public.pm_messages where thread_id = ${literal(thread)}::uuid;`))[0];
  ok(!!stored, "the message row is there");
  ok(!stored.ciphertext.includes("240") && !/usimwambie/i.test(stored.ciphertext),
     "and it is unreadable — the price is nowhere in the stored row");
  // The blunt version of the promise: read the whole table as the database
  // owner, the most privileged reader there is, and find nothing.
  const asOwner = await runSql(
    `select string_agg(ciphertext || iv, ' ') as everything from public.pm_messages
      where thread_id = ${literal(thread)}::uuid;`);
  ok(!/240,000|Usimwambie/i.test(asOwner[0].everything || ""),
     "even as the database owner — bypassing every policy — the body cannot be read");

  section("4. Who can open it");
  const rowsForJuma = await asUser({ sub: JUMA },
    `select id, thread_id, sender_id, iv, ciphertext, epk, wrapped_key, sent_at
       from public.pm_thread_messages(${literal(thread)}::uuid, 100);`);
  ok(rowsForJuma.length === 1, "the recipient gets exactly one message back", String(rowsForJuma.length));
  ok(await PM.open(rowsForJuma[0], people[JUMA]) === secret,
     "and decrypts it to the original words");

  const rowsForAsha = await asUser({ sub: ASHA },
    `select thread_id, sender_id, iv, ciphertext, epk, wrapped_key
       from public.pm_thread_messages(${literal(thread)}::uuid, 100);`);
  ok(await PM.open(rowsForAsha[0], people[ASHA]) === secret, "the sender can re-read what they sent");

  section("5. Who cannot");
  const rowsForMole = await asUser({ sub: MOLE },
    `select id from public.pm_thread_messages(${literal(thread)}::uuid, 100);`);
  ok(rowsForMole.length === 0, "an outsider asking for the thread by id gets nothing", JSON.stringify(rowsForMole));

  const directRead = await asUser({ sub: MOLE },
    `select id from public.pm_messages where thread_id = ${literal(thread)}::uuid;`);
  ok(directRead.length === 0, "and going around the RPC straight to the table gets nothing either — RLS, not politeness");

  const wrapRead = await asUser({ sub: MOLE }, `select user_id from public.pm_message_keys;`);
  ok(!wrapRead.some((r) => r.user_id === JUMA), "nor can they fetch someone else's wrapped key");

  const intrude = await threw(() => asUser({ sub: MOLE },
    `insert into public.pm_members (thread_id, user_id) values (${literal(thread)}::uuid, ${literal(MOLE)});`));
  ok(intrude !== null, "and they cannot add themselves to the conversation", "the insert should be refused");

  const forge = await threw(() => asUser({ sub: MOLE },
    `select public.pm_send(${literal(thread)}::uuid, 'aa', 'bb', '[{"user_id":"x","epk":"e","wrapped_key":"w"}]'::jsonb);`));
  ok(forge !== null && /not in that conversation/i.test(forge.message),
     "and pm_send refuses to write into a thread they are not in", forge && forge.message);

  section("6. The inbox");
  const inbox = await asUser({ sub: JUMA }, `select thread_id, kind, other_id, other_name, unread from public.pm_inbox();`);
  const mine = inbox.find((t) => t.thread_id === thread);
  ok(!!mine, "the thread shows up in the recipient's inbox");
  ok(mine && mine.other_id === ASHA, "named by the OTHER party, not by yourself", JSON.stringify(mine));
  ok(mine && mine.unread === 1, "with one unread", JSON.stringify(mine && mine.unread));
  await asUser({ sub: JUMA }, `select public.pm_mark_read(${literal(thread)}::uuid);`);
  const after = await asUser({ sub: JUMA }, `select unread from public.pm_inbox() where thread_id = ${literal(thread)}::uuid;`);
  ok(after[0] && after[0].unread === 0, "and zero after opening it");

  section("7. The directory");
  const dir = await asUser({ sub: ASHA }, `select user_id, display_name, reachable from public.pm_directory('Mwanza', null, 50);`);
  ok(dir.some((d) => d.user_id === JUMA && d.reachable), "lists other people in the region as reachable");
  ok(!dir.some((d) => d.user_id === ASHA), "and never lists you to yourself");
  const anonDir = await runSql(
    `begin; set local role anon; select count(*)::int as n from public.pm_directory(null, null, 50); commit;`);
  ok(anonDir[0].n === 0,
     "a signed-out caller holding the public anon key gets an EMPTY directory, not every agent in the country",
     JSON.stringify(anonDir));

  section("8. Admin broadcast to a region");
  if (!adminEmail) {
    ok(false, "found the configured admin email to test with");
  } else {
    const recips = await asUser({ sub: "pmtest_admin", email: adminEmail },
      `select user_id, public_key from public.pm_recipients('Mwanza');`);
    const testRecips = recips.filter((r) => r.user_id.startsWith("pmtest_"));
    ok(testRecips.length === 3, "the admin can see who is reachable in that region", String(testRecips.length));

    const notAdmin = await asUser({ sub: MOLE }, `select count(*)::int as n from public.pm_recipients(null);`);
    ok(notAdmin[0].n === 0, "a normal user asking for the recipient list gets nothing");

    const announcement = "pmtest — huduma itasimama kesho saa 2 usiku.";
    // The sender chooses the thread id, so a broadcast body is sealed against
    // the real thread exactly as a direct message is — one open() path, not a
    // second one for announcements sealed against a placeholder.
    const bthread = webcrypto.randomUUID();
    const blast = await PM.seal({
      threadId: bthread, senderId: "pmtest_admin", plaintext: announcement,
      recipients: testRecips.map((r) => ({ userId: r.user_id, publicKey: r.public_key })),
    });
    const made = await asUser({ sub: "pmtest_admin", email: adminEmail },
      `select public.pm_broadcast('pmtest Mwanza notice', 'Mwanza', ${literal(blast.iv)},
        ${literal(blast.ciphertext)}, ${literal(JSON.stringify(blast.keys))}::jsonb,
        ${literal(bthread)}::uuid) as id;`);
    ok(made[0].id === bthread,
       "one call created the thread, its members, the body and every wrapped key");

    const seen = await asUser({ sub: JUMA }, `select thread_id, kind, title from public.pm_inbox();`);
    const bc = seen.find((t) => t.thread_id === bthread);
    ok(!!bc && bc.kind === "broadcast", "it lands in a recipient's inbox as a broadcast");
    ok(!!bc && bc.title === "pmtest Mwanza notice", "with a plaintext title, so the list can say what it is");

    const brow = await asUser({ sub: JUMA },
      `select thread_id, sender_id, iv, ciphertext, epk, wrapped_key from public.pm_thread_messages(${literal(bthread)}::uuid, 10);`);
    ok(brow.length === 1 && await PM.open(brow[0], people[JUMA]) === announcement,
       "and the recipient decrypts the announcement");

    const notInIt = await asUser({ sub: "pmtest_outsider" },
      `select count(*)::int as n from public.pm_thread_messages(${literal(bthread)}::uuid, 10);`);
    ok(notInIt[0].n === 0, "somebody outside the region was not sent it and cannot read it");

    const notAdminBlast = await threw(() => asUser({ sub: MOLE },
      `select public.pm_broadcast('pmtest evil', null, 'a', 'b', '[{"user_id":"x","epk":"e","wrapped_key":"w"}]'::jsonb);`));
    ok(notAdminBlast !== null && /admins only/i.test(notAdminBlast.message),
       "and a normal user cannot broadcast to the country", notAdminBlast && notAdminBlast.message);
  }
} finally {
  await cleanup();
  console.log("\n  (test rows removed)");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
