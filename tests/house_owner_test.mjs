// ============================================================================
// house_owner_test.mjs — the landlord who is not an agent, against the REAL
// database with RLS on.
//
// supabase/features/house/house_owner_accounts.sql makes one promise and one
// restriction, and they only work as a pair:
//
//   the promise      an owner account pays no agent fee, so its listings are
//                    never hidden by agent_key_suspended().
//   the restriction  three posts every 180 days, counted in a ledger that
//                    survives the listing being deleted.
//
// Most of this file is about the ways the restriction could be walked around:
// delete and repost, edit into a new listing, award yourself the owner badge,
// or claim the owner kind after already trading as an agent.
//
// It writes to production, so every row it creates is prefixed `owntest_` and
// deleted at both ends of the run.
//
//   usage:  node tests/house_owner_test.mjs
// ============================================================================
import { webcrypto } from "node:crypto";
import { runSql, literal } from "../scripts/db/sql.mjs";

// pm_publish_key checks the shape of what it is given (p_message_security.sql),
// so section 6 hands it real P-256 keys. Nothing here opens anything with them.
async function realKey() {
  const kp = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return Buffer.from(await webcrypto.subtle.exportKey("spki", kp.publicKey))
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

function claimed(sub, anon, sql) {
  const claims = JSON.stringify({ sub, role: "authenticated", is_anonymous: anon });
  return runSql(
    `begin;
     do $c$ begin perform set_config('request.jwt.claims', ${literal(claims)}, true); end $c$;
     set local role authenticated;
     ${sql}
     commit;`);
}
const asUser = (sub, sql) => claimed(sub, false, sql);
const asGuest = (sub, sql) => claimed(sub, true, sql);

const OWNER = "owntest_owner", AGENT = "owntest_agent", TRADER = "owntest_trader";
const GUEST = "owntest_guest";

// One house, posted by whoever is signed in. The id is the client's own, the
// way js/pages/agent-houses.js generates it.
const postHouse = (who, id, title) => asUser(who, `
  insert into public.houses (id, title, type, room_kind, listing, price_tzs, period, region,
                            agent_fee_tzs, owner_user_id, created_at)
  values (${literal(id)}, ${literal(title)}, 'room', 'room', 'rent', 120000, 'month', 'Mwanza',
          200000, ${literal(who)}, now());`);

async function cleanup() {
  await runSql(`
    delete from public.houses        where id like 'owntest_%' or owner_user_id like 'owntest_%';
    delete from public.trucks        where owner_user_id like 'owntest_%';
    delete from public.services      where owner_user_id like 'owntest_%';
    delete from public.pm_message_keys where user_id like 'owntest_%';
    delete from public.pm_messages   where sender_id like 'owntest_%';
    delete from public.pm_members    where user_id like 'owntest_%';
    delete from public.pm_threads    where created_by like 'owntest_%';
    delete from public.pm_keys       where user_id like 'owntest_%';
    delete from public.owner_posts   where user_id like 'owntest_%';
    delete from public.account_kinds where user_id like 'owntest_%';
    delete from public.agent_profiles where user_id like 'owntest_%';
    delete from public.agent_billing where agent_key like 'uid:owntest_%';
    select 1 as done;`);
}

const houseCount = async (who) =>
  (await runSql(`select count(*)::int as n from public.houses where owner_user_id = ${literal(who)};`))[0].n;
const ledgerCount = async (who) =>
  (await runSql(`select count(*)::int as n from public.owner_posts where user_id = ${literal(who)};`))[0].n;

try {
  await cleanup();

  section("1. Claiming the kind");

  const claim = await asUser(OWNER, `select public.account_kind_claim('owner') as k;`);
  ok(claim[0].k === "owner", "an account can claim the owner kind", JSON.stringify(claim[0]));

  const again = await asUser(OWNER, `select public.account_kind_claim('owner') as k;`);
  ok(again[0].k === "owner", "and claiming it twice is not an error, because the account page claims on every open");

  const kinds = await runSql(`select public.account_kind(${literal(OWNER)}) as o,
                                     public.account_kind(${literal(AGENT)}) as a,
                                     public.is_owner_account(${literal(OWNER)}) as io,
                                     public.is_owner_account(${literal(AGENT)}) as ia;`);
  ok(kinds[0].o === "owner" && kinds[0].a === "agent",
     "an account with no row is an agent, which is what every account was before this table existed",
     JSON.stringify(kinds[0]));
  ok(kinds[0].io === true && kinds[0].ia === false, "and is_owner_account agrees");

  const byGuest = await threw(() => asGuest(GUEST, `select public.account_kind_claim('owner');`));
  ok(!!byGuest, "a guest session cannot claim to be a landlord",
     byGuest ? byGuest.message.slice(0, 80) : "the call succeeded!");

  // An account that already has an agent storefront is trading as an agent,
  // whatever it taps at the door.
  await runSql(`insert into public.agent_profiles (user_id, name, region)
                values (${literal(TRADER)}, 'Owntest Trader', 'Mwanza'); select 1 as done;`);
  const asAgentAlready = await threw(() => asUser(TRADER, `select public.account_kind_claim('owner');`));
  ok(!!asAgentAlready && /agent page/i.test(asAgentAlready.message),
     "an account with an agent page cannot claim the fee exemption",
     asAgentAlready ? asAgentAlready.message.slice(0, 90) : "the call succeeded!");

  section("2. Three posts, and the fourth");

  await postHouse(OWNER, "owntest_h1", "Owntest room one");
  await postHouse(OWNER, "owntest_h2", "Owntest room two");
  await postHouse(OWNER, "owntest_h3", "Owntest room three");
  ok(await houseCount(OWNER) === 3, "an owner posts three listings");
  ok(await ledgerCount(OWNER) === 3, "and every one of them is in the ledger");

  const flags = await runSql(
    `select count(*)::int as n from public.houses where owner_user_id = ${literal(OWNER)} and posted_by_owner;`);
  ok(flags[0].n === 3, "each one carries posted_by_owner, so a card can say where it came from");

  const fourth = await threw(() => postHouse(OWNER, "owntest_h4", "Owntest room four"));
  ok(!!fourth && await houseCount(OWNER) === 3,
     "the fourth is refused",
     fourth ? fourth.message.slice(0, 120) : "the insert succeeded!");
  ok(!!fourth && /owner account can post/i.test(fourth.message),
     "with a sentence that says what the allowance is and when the next slot frees",
     fourth ? fourth.message.slice(0, 160) : "");

  section("3. The ways round it that must not work");

  // The one this whole design exists for: delete a listing, post another.
  await asUser(OWNER, `delete from public.houses where id = 'owntest_h1';`);
  ok(await houseCount(OWNER) === 2, "the owner deletes one of their three");
  ok(await ledgerCount(OWNER) === 3, "the ledger still remembers it, because deleting is not un-posting");
  const repost = await threw(() => postHouse(OWNER, "owntest_h5", "Owntest reposted"));
  ok(!!repost && await houseCount(OWNER) === 2,
     "so deleting does NOT buy another post",
     repost ? repost.message.slice(0, 90) : "the insert succeeded!");

  // Editing is free, and must stay free: it is the same room with a better
  // photograph. What it must not do is count as a post or change the badge.
  await asUser(OWNER, `update public.houses set title = 'Owntest room two, repainted'
                        where id = 'owntest_h2' and owner_user_id = ${literal(OWNER)};`);
  const edited = await runSql(`select title, posted_by_owner from public.houses where id = 'owntest_h2';`);
  ok(edited[0].title === "Owntest room two, repainted" && edited[0].posted_by_owner === true,
     "editing a listing is free and leaves the badge alone", JSON.stringify(edited[0]));
  ok(await ledgerCount(OWNER) === 3, "and does not spend a slot");

  // "No agent fees" is the whole VIP promise, so it is a fact about the row
  // and not a claim on a card: the form sent 200,000 and the trigger zeroed it.
  const fees = await runSql(`select
      (select agent_fee_tzs from public.houses where id = 'owntest_h2') as owner_fee;`);
  ok(Number(fees[0].owner_fee) === 0,
     "an owner's listing carries no agent fee, whatever the form sent", JSON.stringify(fees[0]));

  await asUser(OWNER, `update public.houses set agent_fee_tzs = 500000
                        where id = 'owntest_h2' and owner_user_id = ${literal(OWNER)};`);
  const refee = await runSql(`select agent_fee_tzs from public.houses where id = 'owntest_h2';`);
  ok(Number(refee[0].agent_fee_tzs) === 0,
     "and an owner cannot grow one on the next edit", JSON.stringify(refee[0]));

  // The badge is not the client's to award or to remove.
  await asUser(OWNER, `update public.houses set posted_by_owner = false
                        where id = 'owntest_h2' and owner_user_id = ${literal(OWNER)};`);
  const held = await runSql(`select posted_by_owner from public.houses where id = 'owntest_h2';`);
  ok(held[0].posted_by_owner === true, "an owner cannot drop their own badge by writing to the column");

  await postHouse(AGENT, "owntest_a1", "Owntest agent room");
  await asUser(AGENT, `update public.houses set posted_by_owner = true
                        where id = 'owntest_a1' and owner_user_id = ${literal(AGENT)};`);
  const faked = await runSql(`select posted_by_owner from public.houses where id = 'owntest_a1';`);
  ok(faked[0].posted_by_owner === false,
     "and an agent cannot award themselves one, which is why the flag is not a column the client writes");

  const agentFee = await runSql(`select agent_fee_tzs from public.houses where id = 'owntest_a1';`);
  ok(Number(agentFee[0].agent_fee_tzs) === 200000,
     "an agent's listing keeps the fee it was given, so the zeroing is the owner's alone",
     JSON.stringify(agentFee[0]));

  section("4. What an agent account still gets");

  await postHouse(AGENT, "owntest_a2", "Owntest agent room two");
  await postHouse(AGENT, "owntest_a3", "Owntest agent room three");
  await postHouse(AGENT, "owntest_a4", "Owntest agent room four");
  ok(await houseCount(AGENT) === 4, "an agent account is not capped: it pays a fee instead");
  ok(await ledgerCount(AGENT) === 0, "and nothing about it reaches the owner ledger");

  section("5. No fee, which is the whole promise");

  // Backdate both accounts past the 7-day approval window. Without the
  // exemption this is the moment every listing they have disappears from the
  // board until an admin approves them.
  await runSql(`update public.houses set created_at = now() - interval '30 days'
                 where owner_user_id in (${literal(OWNER)}, ${literal(AGENT)});
                select 1 as done;`);
  const susp = await runSql(
    `select public.agent_key_suspended('uid:' || ${literal(OWNER)}) as owner_susp,
            public.agent_key_suspended('uid:' || ${literal(AGENT)}) as agent_susp;`);
  ok(susp[0].owner_susp === false, "an owner account is never suspended for not paying an agent fee");
  ok(susp[0].agent_susp === true,
     "while an unapproved agent past the 7-day window still is, so the exemption is doing the work",
     JSON.stringify(susp[0]));

  const visible = await asUser("owntest_stranger",
    `select count(*)::int as n from public.houses where owner_user_id = ${literal(OWNER)};`);
  ok(visible[0].n === 2, "and a stranger can still see the owner's listings", JSON.stringify(visible[0]));
  const hidden = await asUser("owntest_stranger",
    `select count(*)::int as n from public.houses where owner_user_id = ${literal(AGENT)};`);
  ok(hidden[0].n === 0, "where the lapsed agent's are hidden from them", JSON.stringify(hidden[0]));

  section("6. A guest can still reach them");

  // An owner has no agent_profiles row, which is what pm_publish_key reads to
  // set pm_keys.is_agent. Without the arm added in section 8 of the migration,
  // becoming an owner would quietly make a landlord unreachable by exactly the
  // people most likely to want them: somebody browsing without an account.
  const realKeyOwner = await realKey();
  await asUser(OWNER, `select public.pm_publish_key(${literal(realKeyOwner)}, '123456789012', 'Owntest Owner', 'Mwanza');`);
  await asGuest(GUEST, `select public.pm_publish_key(${literal(await realKey())}, '123456789012', 'Owntest Guest', 'Mwanza');`);
  const isAgent = await runSql(`select is_agent from public.pm_keys where user_id = ${literal(OWNER)};`);
  ok(isAgent[0].is_agent === false, "the owner is not an agent in pm_keys, because they have no agent page");

  const thread = await asGuest(GUEST, `select public.pm_start_direct(${literal(OWNER)}) as id;`);
  ok(!!thread[0].id, "and a guest can open a conversation with them anyway", JSON.stringify(thread[0]));

  await runSql(`insert into public.pm_keys (user_id, public_key, fingerprint, is_guest)
                values ('owntest_guest2', ${literal(await realKey())}, '1', true)
                on conflict (user_id) do update set is_guest = true; select 1 as done;`);
  const guestToGuest = await threw(() => asGuest(GUEST, `select public.pm_start_direct('owntest_guest2');`));
  ok(!!guestToGuest, "while guest to guest is still refused, which is the rule that stops the spam",
     guestToGuest ? guestToGuest.message.slice(0, 90) : "the call succeeded!");

  section("7. What the account page is told");

  const q = (await asUser(OWNER, `select public.owner_post_quota() as q;`))[0].q;
  ok(q.is_owner === true && q.limit === 3 && q.used === 3 && q.left === 0,
     "the quota RPC reports the allowance, what is used and what is left", JSON.stringify(q));
  ok(!!q.next_free_at, "and when the next slot frees, because the account is at its ceiling");
  ok(q.window_days === 180, "over the window the trigger actually enforces");

  const agentQ = (await asUser(AGENT, `select public.owner_post_quota() as q;`))[0].q;
  ok(agentQ.is_owner === false && agentQ.next_free_at === null,
     "an agent account is told it is not on an allowance at all", JSON.stringify(agentQ));

  const nosy = await threw(() => asUser(AGENT, `select public.owner_post_quota(${literal(OWNER)});`));
  ok(!!nosy, "and cannot read somebody else's", nosy ? nosy.message.slice(0, 60) : "the call succeeded!");
} finally {
  await cleanup();
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
