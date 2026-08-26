// ============================================================================
// p_message_invite_test.mjs — agent-to-customer invite links, against the REAL
// database.
//
// The thing this leans hardest on is that the token is never stored. A test
// that only checked "the link works" would pass just as happily against a
// table holding raw tokens, which is the one property that makes an invite
// safe to keep in a database at all.
//
// Writes to production; every row is prefixed `pmtest_` and removed at both
// ends of the run.
//
//   usage:  node tests/p_message_invite_test.mjs
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webcrypto, createHash, randomBytes } from "node:crypto";
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

// The token the agent's browser makes: 32 random bytes, base64url. Only its
// hash ever reaches the database.
const newToken = () => randomBytes(32).toString("base64url");
const hashOf = (t) => createHash("sha256").update(t, "utf8").digest("hex");

// asUser() sets only sub/email, but app_is_guest() reads the `is_anonymous`
// claim that Supabase stamps into an anonymous session. Without it every guest
// fence in the schema silently reads as "not a guest" and a test of those
// fences proves nothing — so a guest session has to be spelled out in full.
function asGuest(sub, sql) {
  const claims = JSON.stringify({ sub, email: null, role: "authenticated", is_anonymous: true });
  return runSql(
    `begin;
     do $claims$ begin perform set_config('request.jwt.claims', ${literal(claims)}, true); end $claims$;
     set local role authenticated;
     ${sql}
     commit;`
  );
}

const AMINA = "pmtest_amina";   // the agent
const CUST  = "pmtest_cust";    // the customer, a guest
const OTHER = "pmtest_other";   // somebody else entirely

async function cleanup() {
  await runSql(`
    delete from public.pm_invites where agent_id like 'pmtest_%' or accepted_by like 'pmtest_%';
    delete from public.pm_message_keys where user_id like 'pmtest_%';
    delete from public.pm_messages where sender_id like 'pmtest_%'
       or thread_id in (select id from public.pm_threads where created_by like 'pmtest_%');
    delete from public.pm_members where user_id like 'pmtest_%'
       or thread_id in (select id from public.pm_threads where created_by like 'pmtest_%');
    delete from public.pm_threads where created_by like 'pmtest_%';
    delete from public.pm_keys where user_id like 'pmtest_%';
    select 1 as done;`);
}

try {
  await cleanup();

  section("0. An agent and a customer who has never been here");
  const people = {};
  for (const id of [AMINA, CUST, OTHER]) {
    const idn = { userId: id, ...(await PM.generateIdentity()) };
    idn.fingerprint = await PM.fingerprint(idn.publicKey);
    people[id] = idn;
    await asUser({ sub: id }, `select public.pm_publish_key(
      ${literal(idn.publicKey)}, ${literal(idn.fingerprint)},
      ${literal(id.replace("pmtest_", "Test "))}, 'Mwanza');`);
  }
  await runSql(`update public.pm_keys set is_agent = true where user_id = ${literal(AMINA)};`);
  await runSql(`update public.pm_keys set is_guest = true where user_id = ${literal(CUST)};`);
  ok(true, "an agent with a key, and a customer whose session is anonymous");

  section("1. Making a link");
  const token = newToken();
  const made = await asUser({ sub: AMINA },
    `select * from public.pm_invite_create(${literal(hashOf(token))}, 'the couple from Kariakoo', 14);`);
  ok(made.length === 1, "the agent creates an invite");
  ok(new Date(made[0].expires_at) > new Date(), "it expires in the future, not the past");

  // THE property. Everything else about invites is convenience; this is the
  // reason the table is safe to have.
  const stored = await runSql(
    `select token_hash, label, agent_id from public.pm_invites where agent_id = ${literal(AMINA)};`);
  ok(stored[0].token_hash !== token,
    "the raw token is NOT what was stored");
  ok(stored[0].token_hash === hashOf(token),
    "what is stored is its sha256 — a stolen database yields no usable links");
  const dump = await runSql(
    `select coalesce(string_agg(token_hash || ' ' || coalesce(label,''), ' '), '') as all_of_it
       from public.pm_invites;`);
  ok(!dump[0].all_of_it.includes(token),
    "and the token appears nowhere in the table, read as the database owner");

  const malformed = await threw(() => asUser({ sub: AMINA },
    `select * from public.pm_invite_create('not-a-hash', null, 14);`));
  ok(!!malformed && /malformed/i.test(malformed.message),
    "something that is not a sha256 is refused rather than stored",
    malformed ? malformed.message : "no error raised");

  const guestTries = await threw(() => asGuest(CUST,
    `select * from public.pm_invite_create(${literal(hashOf(newToken()))}, null, 14);`));
  ok(!!guestTries && /guest/i.test(guestTries.message),
    "a guest cannot mint invites — two anonymous tabs talking is a spam network",
    guestTries ? guestTries.message : "no error raised");

  section("2. What the customer sees before committing");
  const peek = await asGuest(CUST, `select * from public.pm_invite_peek(${literal(token)});`);
  ok(peek.length === 1 && peek[0].state === "open", "the link resolves, and says it is open",
    JSON.stringify(peek[0]));
  ok(peek[0].agent_name === "Test amina", "and names who is inviting them", peek[0].agent_name);

  const peekJunk = await asGuest(CUST,
    `select count(*)::int as n from public.pm_invite_peek('a-made-up-token');`);
  ok(peekJunk[0].n === 0, "a guessed token resolves to nothing at all");

  section("3. Accepting");
  const accepted = await asGuest(CUST, `select public.pm_invite_accept(${literal(token)}) as id;`);
  const thread = accepted[0].id;
  ok(!!thread, "the customer accepts and gets a thread", thread);

  const roster = await runSql(
    `select user_id, role from public.pm_members where thread_id = ${literal(thread)}::uuid order by user_id;`);
  ok(roster.length === 2, "with exactly two people in it");
  ok(roster.some((r) => r.user_id === AMINA) && roster.some((r) => r.user_id === CUST),
    "the agent and the customer", JSON.stringify(roster));

  // Reopening your own link from your browser history is not an attack.
  const again = await asGuest(CUST, `select public.pm_invite_accept(${literal(token)}) as id;`);
  ok(again[0].id === thread,
    "the same customer reopening the link lands back in the SAME thread, not a second one");

  const stolen = await threw(() => asUser({ sub: OTHER },
    `select public.pm_invite_accept(${literal(token)}) as id;`));
  ok(!!stolen && /already been used/i.test(stolen.message),
    "but somebody else with the same link is refused — it is single use",
    stolen ? stolen.message : "no error raised");

  section("4. The thread is an ordinary encrypted one");
  const secret = "Ndiyo, bado ipo. Tuonane kesho saa nne.";
  const keys = await asUser({ sub: AMINA },
    `select user_id, public_key from public.pm_thread_keys(${literal(thread)}::uuid);`);
  ok(keys.length === 2, "pm_thread_keys works here too — one code path for every kind of thread");
  const sealed = await PM.seal({
    threadId: thread, senderId: AMINA, plaintext: secret,
    recipients: keys.map((k) => ({ userId: k.user_id, publicKey: k.public_key })),
  });
  await asUser({ sub: AMINA }, `select public.pm_send(
    ${literal(thread)}::uuid, ${literal(sealed.iv)}, ${literal(sealed.ciphertext)},
    ${literal(JSON.stringify(sealed.keys))}::jsonb) as id;`);

  const raw = (await runSql(
    `select string_agg(ciphertext, ' ') as everything from public.pm_messages
      where thread_id = ${literal(thread)}::uuid;`))[0].everything || "";
  ok(!/saa nne|bado ipo/i.test(raw),
    "the body is unreadable to the database owner, exactly as in any other thread");

  const custRows = await asGuest(CUST,
    `select thread_id, sender_id, iv, ciphertext, epk, wrapped_key
       from public.pm_thread_messages(${literal(thread)}::uuid, 50);`);
  const opened = await PM.open({ ...custRows[0], thread_id: thread }, people[CUST]);
  ok(opened === secret, "and the customer — who has no account — reads it perfectly");

  section("5. Expiry and withdrawal");
  const dead = newToken();
  await asUser({ sub: AMINA }, `select * from public.pm_invite_create(${literal(hashOf(dead))}, 'stale', 14);`);
  await runSql(`update public.pm_invites set expires_at = now() - interval '1 day'
                 where token_hash = ${literal(hashOf(dead))};`);
  const expired = await threw(() => asUser({ sub: OTHER },
    `select public.pm_invite_accept(${literal(dead)}) as id;`));
  ok(!!expired && /expired/i.test(expired.message),
    "an expired link says so, rather than 'invalid'", expired ? expired.message : "no error");

  const pulled = newToken();
  await asUser({ sub: AMINA }, `select * from public.pm_invite_create(${literal(hashOf(pulled))}, 'oops', 14);`);
  await asUser({ sub: AMINA }, `select public.pm_invite_revoke(${literal(hashOf(pulled))});`);
  const revoked = await threw(() => asUser({ sub: OTHER },
    `select public.pm_invite_accept(${literal(pulled)}) as id;`));
  ok(!!revoked && /withdrawn/i.test(revoked.message), "a withdrawn link says that instead",
    revoked ? revoked.message : "no error");

  section("6. The agent's own list");
  const mine = await asUser({ sub: AMINA }, `select label, state, thread_id from public.pm_invites_mine(50);`);
  ok(mine.length === 3, "the agent sees their three invites", String(mine.length));
  const used = mine.find((m) => m.label === "the couple from Kariakoo");
  ok(used && used.state === "used" && used.thread_id === thread,
    "the accepted one points at the conversation it created", JSON.stringify(used));
  ok(mine.some((m) => m.state === "expired") && mine.some((m) => m.state === "revoked"),
    "and the dead ones are labelled honestly rather than just missing");

  const nosy = await asUser({ sub: OTHER }, `select count(*)::int as n from public.pm_invites_mine(50);`);
  ok(nosy[0].n === 0, "another agent sees none of them");

  const nosyTable = await asUser({ sub: OTHER }, `select count(*)::int as n from public.pm_invites;`);
  ok(nosyTable[0].n === 0, "and RLS hides the rows themselves, not just the function");
} catch (err) {
  // Without this the finally block's process.exit() swallows the exception
  // and the run reports a pass with exit 0 while having tested nothing.
  fail++;
  console.log("\n  THREW  " + (err && err.message ? err.message : String(err)));
  if (err && err.stack) console.log(String(err.stack).split("\n").slice(1, 4).join("\n"));
} finally {
  await cleanup();
  const left = await runSql(`
    select (select count(*)::int from public.pm_invites where agent_id like 'pmtest_%') as invites,
           (select count(*)::int from public.pm_keys where user_id like 'pmtest_%') as keys,
           (select count(*)::int from public.pm_threads where created_by like 'pmtest_%') as threads;`);
  const clean = left[0].invites === 0 && left[0].keys === 0 && left[0].threads === 0;
  ok(clean, "every test row is gone from production", JSON.stringify(left[0]));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
