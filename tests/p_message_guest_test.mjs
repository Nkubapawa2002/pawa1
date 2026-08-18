// ============================================================================
// p_message_guest_test.mjs — guests, against the REAL database with RLS on.
//
// Letting somebody chat without an account meant turning on anonymous
// sign-ins, and that changed the meaning of every policy in the schema that
// said "authenticated". This file exists mostly to prove the DOWNSIDE was
// closed, not that the feature works:
//
//   · a guest cannot post a house, a service, a truck or an agent profile —
//     the catalogue is not open to free unidentified accounts;
//   · a guest can hold a key and message an AGENT, with the same encryption;
//   · a guest cannot message another guest, and cannot open unlimited threads;
//   · a guest is not in the directory and not in a broadcast.
//
// Every statement runs as a signed-in user with the is_anonymous claim set,
// which is exactly what Supabase puts in an anonymous session's JWT.
//
//   usage:  node tests/p_message_guest_test.mjs
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { runSql, literal } from "../scripts/db/sql.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const store = new Map();
const sandbox = {
  console, crypto: webcrypto, TextEncoder, TextDecoder, Buffer,
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
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
 * Run SQL as an ANONYMOUS session — the is_anonymous claim is the only thing
 * that separates a guest from a real account, so it is the only thing this
 * helper adds.
 */
function asGuest(sub, sql) {
  const claims = JSON.stringify({ sub, role: "authenticated", is_anonymous: true });
  return runSql(
    `begin;
     do $c$ begin perform set_config('request.jwt.claims', ${literal(claims)}, true); end $c$;
     set local role authenticated;
     ${sql}
     commit;`);
}
function asMember(sub, sql) {
  const claims = JSON.stringify({ sub, role: "authenticated", is_anonymous: false });
  return runSql(
    `begin;
     do $c$ begin perform set_config('request.jwt.claims', ${literal(claims)}, true); end $c$;
     set local role authenticated;
     ${sql}
     commit;`);
}

const GUEST = "pmtest_guest", GUEST2 = "pmtest_guest2", AGENT = "pmtest_agent";

async function cleanup() {
  await runSql(`
    delete from public.pm_message_keys where user_id like 'pmtest_%';
    delete from public.pm_messages where sender_id like 'pmtest_%'
       or thread_id in (select id from public.pm_threads where created_by like 'pmtest_%');
    delete from public.pm_members where user_id like 'pmtest_%'
       or thread_id in (select id from public.pm_threads where created_by like 'pmtest_%');
    delete from public.pm_threads where created_by like 'pmtest_%';
    delete from public.pm_keys where user_id like 'pmtest_%';
    delete from public.houses where owner_user_id like 'pmtest_%';
    delete from public.services where owner_user_id like 'pmtest_%';
    delete from public.agent_profiles where user_id like 'pmtest_%';
    select 1 as done;`);
}

try {
  await cleanup();

  section("1. The fence — what a guest must NOT be able to do");
  // These policies all read "authenticated and owns the row". Before anonymous
  // sign-ins that meant "has an email"; it does not any more, which is why
  // every one of them gained `and not app_is_guest()`.
  const house = await threw(() => asGuest(GUEST, `
    insert into public.houses (id, title, type, listing, price_tzs, period, region, owner_user_id, created_at)
    values ('pmtest_h1', 'Free spam listing', 'room', 'rent', 1, 'month', 'Mwanza', ${literal(GUEST)}, now());`));
  const houseRows = await runSql(`select count(*)::int as n from public.houses where owner_user_id = ${literal(GUEST)};`);
  ok(houseRows[0].n === 0, "a guest cannot post a house listing", house ? house.message.slice(0, 90) : "insert succeeded!");

  const svc = await threw(() => asGuest(GUEST, `
    insert into public.services (id, title, category, region, owner_user_id, created_at)
    values ('pmtest_s1', 'Free spam service', 'cleaning', 'Mwanza', ${literal(GUEST)}, now());`));
  const svcRows = await runSql(`select count(*)::int as n from public.services where owner_user_id = ${literal(GUEST)};`);
  ok(svcRows[0].n === 0, "nor a service", svc ? svc.message.slice(0, 90) : "insert succeeded!");

  await threw(() => asGuest(GUEST, `
    insert into public.agent_profiles (user_id, name, region) values (${literal(GUEST)}, 'Fake Agent', 'Mwanza');`));
  const apRows = await runSql(`select count(*)::int as n from public.agent_profiles where user_id = ${literal(GUEST)};`);
  ok(apRows[0].n === 0, "nor claim to be an agent");

  // And the same statements still work for a real account, so the fence did
  // not simply break posting for everyone.
  await asMember("pmtest_owner", `
    insert into public.houses (id, title, type, listing, price_tzs, period, region, owner_user_id, created_at)
    values ('pmtest_h2', 'Real listing', 'room', 'rent', 200000, 'month', 'Mwanza', 'pmtest_owner', now());`);
  const realRows = await runSql(`select count(*)::int as n from public.houses where id = 'pmtest_h2';`);
  ok(realRows[0].n === 1, "while a signed-in account posts exactly as before");
  await runSql(`delete from public.houses where id = 'pmtest_h2';`);

  section("2. What a guest CAN do");
  const agent = { userId: AGENT, ...(await PM.generateIdentity()) };
  agent.fingerprint = await PM.fingerprint(agent.publicKey);
  await runSql(`insert into public.agent_profiles (user_id, name, region, area_of_operations)
                values (${literal(AGENT)}, 'Test Agent', 'Mwanza', 'Nyamagana')
                on conflict (user_id) do nothing;`);
  await asMember(AGENT, `select public.pm_publish_key(${literal(agent.publicKey)}, ${literal(agent.fingerprint)}, null, 'Mwanza');`);

  const guest = { userId: GUEST, ...(await PM.generateIdentity()) };
  guest.fingerprint = await PM.fingerprint(guest.publicKey);
  const pub = await asGuest(GUEST, `select is_guest, display_name from public.pm_publish_key(
    ${literal(guest.publicKey)}, ${literal(guest.fingerprint)}, 'Asha (guest)', 'Mwanza');`);
  ok(pub[0] && pub[0].is_guest === true, "a guest can publish a key, and it is marked as a guest's");
  ok(pub[0] && pub[0].display_name === "Asha (guest)", "under a name they chose");

  const dir = await asGuest(GUEST, `select user_id, is_agent from public.pm_directory('Mwanza', null, 50);`);
  ok(dir.some((d) => d.user_id === AGENT), "a guest can see agents in the directory");

  const thread = (await asGuest(GUEST, `select public.pm_start_direct(${literal(AGENT)}) as id;`))[0].id;
  ok(!!thread, "and open a conversation with one");

  // Same encryption. Not a lesser mode for people without an account.
  const words = "Chumba cha Nyamagana bado kipo? Naweza kuja leo jioni.";
  const sealed = await PM.seal({
    threadId: thread, senderId: GUEST, plaintext: words,
    recipients: [{ userId: GUEST, publicKey: guest.publicKey }, { userId: AGENT, publicKey: agent.publicKey }],
  });
  await asGuest(GUEST, `select public.pm_send(${literal(thread)}::uuid, ${literal(sealed.iv)},
    ${literal(sealed.ciphertext)}, ${literal(JSON.stringify(sealed.keys))}::jsonb);`);

  const held = await runSql(`select ciphertext from public.pm_messages where thread_id = ${literal(thread)}::uuid;`);
  ok(held.length === 1 && !held[0].ciphertext.includes("Nyamagana"),
     "the guest's message is stored encrypted, exactly like everyone else's");

  const forAgent = await asMember(AGENT, `select thread_id, sender_id, iv, ciphertext, epk, wrapped_key
    from public.pm_thread_messages(${literal(thread)}::uuid, 10);`);
  ok(forAgent.length === 1 && await PM.open(forAgent[0], agent) === words,
     "and the agent decrypts it");

  const inbox = await asMember(AGENT, `select other_id, other_guest from public.pm_inbox();`);
  const row = inbox.find((r) => r.other_id === GUEST);
  ok(!!row && row.other_guest === true,
     "the agent's inbox marks them a guest — true, and worth knowing before answering");

  const peer = await asMember(AGENT, `select display_name, fingerprint, is_guest from public.pm_peer(${literal(GUEST)});`);
  ok(peer[0] && peer[0].fingerprint === guest.fingerprint,
     "and the agent can still check the guest's safety number, though guests are not in the directory");
  const stranger = await asMember("pmtest_stranger", `select count(*)::int as n from public.pm_peer(${literal(GUEST)});`);
  ok(stranger[0].n === 0, "while somebody who shares no thread with them gets nothing");

  section("3. The limits on a guest");
  const guest2 = { userId: GUEST2, ...(await PM.generateIdentity()) };
  await asGuest(GUEST2, `select public.pm_publish_key(${literal(guest2.publicKey)},
    ${literal(await PM.fingerprint(guest2.publicKey))}, 'Other guest', 'Mwanza');`);

  const g2g = await threw(() => asGuest(GUEST, `select public.pm_start_direct(${literal(GUEST2)});`));
  ok(g2g !== null && /only message agents/i.test(g2g.message),
     "a guest cannot open a thread with another guest", g2g && g2g.message.slice(0, 90));

  const dirAsGuest = await asGuest(GUEST2, `select user_id from public.pm_directory(null, null, 200);`);
  ok(!dirAsGuest.some((d) => d.user_id === GUEST),
     "guests are not listed in the directory — it is for finding agents, not for a roll of every visitor");

  // The spam recipe is free accounts plus unlimited new threads, so the second
  // half is capped.
  await runSql(`insert into public.pm_threads (kind, created_by, created_at)
                select 'direct', ${literal(GUEST)}, now() from generate_series(1, 5);`);
  const capped = await threw(() => asGuest(GUEST, `select public.pm_start_direct(${literal(AGENT)});`));
  ok(capped !== null && /too many/i.test(capped.message),
     "and a guest who opens five conversations in an hour is asked to wait or sign in",
     capped && capped.message.slice(0, 90));

  const recips = await asMember("pmtest_admin", `select count(*)::int as n from public.pm_recipients(null);`);
  ok(recips[0].n === 0, "a non-admin still gets no recipient list");

  section("4. Broadcasts go to accounts, not to passers-by");
  const adminEmail = (readFileSync(join(ROOT, "js/core/config.js"), "utf8")
    .match(/ADMIN_EMAILS:\s*\[\s*"([^"]+)"/) || [])[1];
  const all = await runSql(
    `begin;
     do $c$ begin perform set_config('request.jwt.claims',
       ${literal(JSON.stringify({ sub: "pmtest_admin", email: adminEmail, role: "authenticated" }))}, true); end $c$;
     set local role authenticated;
     select user_id from public.pm_recipients(null);
     commit;`);
  ok(!all.some((r) => r.user_id === GUEST || r.user_id === GUEST2),
     "no guest is in the recipient list — a guest session is a browser tab, and counting it would inflate the number sent");
  ok(all.some((r) => r.user_id === AGENT), "the agent is");
} finally {
  await cleanup();
  console.log("\n  (test rows removed)");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
