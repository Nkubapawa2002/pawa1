// ============================================================================
// agent_notices_test.mjs — what the admin does, and what the agent is told.
//
// supabase/features/agent/agent_notices.sql exists because everything an admin
// did in the tracker happened silently. The rules it has to keep:
//
//   · every change writes the agent a sentence, from the DATABASE, so nothing
//     depends on the panel remembering to send it;
//   · the renewal sweep can run every morning and still say one thing;
//   · a notice reaches its recipient and NOBODY else;
//   · and my_notices() computes days_left on the server, because a phone with
//     the wrong date would get the one number this feature exists for wrong.
//
// It writes to production, so every row it creates is prefixed `notitest_` and
// deleted at both ends of the run.
//
//   usage:  node tests/agent_notices_test.mjs
// ============================================================================
import { runSql, literal } from "../scripts/db/sql.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

function claimed(sub, email, sql) {
  const claims = JSON.stringify({ sub, email: email || null, role: "authenticated", is_anonymous: false });
  return runSql(
    `begin;
     do $c$ begin perform set_config('request.jwt.claims', ${literal(claims)}, true); end $c$;
     set local role authenticated;
     ${sql}
     commit;`);
}
const asUser = (sub, sql) => claimed(sub, null, sql);

// The real admin, so is_admin() is exercised as it behaves rather than against
// a row this test invented. public.admins is keyed by EMAIL and is_admin()
// reads the email claim, so the sub can be anything: it is the address that
// makes somebody an admin here, which is worth knowing before writing a test
// that hands it a user id and wonders why it is refused.
const { readFileSync } = await import("node:fs");
const adminEmail = (readFileSync("js/core/config.js", "utf8")
  .match(/ADMIN_EMAILS:\s*\[\s*"([^"]+)"/) || [])[1];
const adminIsReal = (await runSql(
  `select count(*)::int as n from public.admins where lower(email) = lower(${literal(adminEmail)});`))[0].n === 1;
const asAdmin = (sql) => claimed("notitest_admin", adminEmail, sql);

const AGENT = "notitest_agent", OTHER = "notitest_other";
const KEY = "uid:" + AGENT;

async function cleanup() {
  await runSql(`
    delete from public.agent_messages where to_user_id like 'notitest_%';
    delete from public.agent_billing  where agent_key like 'uid:notitest_%';
    select 1 as done;`);
}

const notices = async (uid) => runSql(
  `select title, kind, severity, dedupe_key, read_at from public.agent_messages
    where to_user_id = ${literal(uid)} order by created_at;`);
const titles = async (uid) => (await notices(uid)).map((r) => r.title);

try {
  await cleanup();
  ok(adminIsReal, "the real admin is in public.admins, so is_admin() is being exercised", adminEmail);

  section("1. Everything the tracker does, said out loud");

  // A billing row appearing at all is an agent entering the system. Nothing is
  // approved and nothing is paid yet, so this alone says nothing.
  await runSql(`insert into public.agent_billing (agent_key, status, amount_tzs, active)
                values (${literal(KEY)}, 'free', 0, true); select 1 as done;`);
  ok((await notices(AGENT)).length === 0,
     "a bare billing row is not news: nothing has happened to the agent yet",
     JSON.stringify(await titles(AGENT)));

  await runSql(`update public.agent_billing set approved_at = now(), approved_by = ${literal(adminEmail)}
                 where agent_key = ${literal(KEY)}; select 1 as done;`);
  ok((await titles(AGENT)).some((t) => /approved/i.test(t)),
     "approving an agent tells them, which is what lifts the seven-day clock",
     JSON.stringify(await titles(AGENT)));

  await runSql(`update public.agent_billing set paid_until = current_date + 30, amount_tzs = 10000
                 where agent_key = ${literal(KEY)}; select 1 as done;`);
  const paid = (await notices(AGENT)).find((r) => /payment recorded/i.test(r.title));
  ok(!!paid, "recording a payment tells them", JSON.stringify(await titles(AGENT)));
  ok(!!paid && /10,000/.test(paid.title), "with the amount, which is the half they can check", paid && paid.title);

  await runSql(`update public.agent_billing set active = false, note = 'Owes for March'
                 where agent_key = ${literal(KEY)}; select 1 as done;`);
  const off = (await notices(AGENT)).find((r) => /paused/i.test(r.title));
  ok(!!off && off.severity === "urgent",
     "deactivating them is urgent, because every listing they have just left the board",
     JSON.stringify(off));
  const offRow = (await runSql(`select body from public.agent_messages
     where to_user_id = ${literal(AGENT)} and title ilike '%paused%' limit 1;`))[0];
  ok(/Owes for March/.test(offRow.body) && /contact the admin/i.test(offRow.body),
     "and it carries the admin's own note plus how to get back on", offRow.body.slice(0, 90));

  await runSql(`update public.agent_billing set active = true where agent_key = ${literal(KEY)}; select 1 as done;`);
  ok((await titles(AGENT)).some((t) => /live again/i.test(t)), "turning them back on says so too");

  section("2. The reminder can run every morning");

  await runSql(`update public.agent_billing
                   set paid_until = current_date + 5, active = true, status = 'paid'
                 where agent_key = ${literal(KEY)}; select 1 as done;`);
  const first = (await asAdmin(`select public.agent_notices_remind(7) as n;`))[0].n;
  ok(first >= 1, "the sweep writes to an agent whose cover runs out inside the window", String(first));
  const warn = (await notices(AGENT)).find((r) => /ends in 5 days/i.test(r.title));
  ok(!!warn, "and says how long is left, in days, not in a date they have to work out",
     JSON.stringify(await titles(AGENT)));
  ok(!!warn && warn.severity === "warn", "five days out is a warning, not an emergency", warn && warn.severity);

  const again = (await asAdmin(`select public.agent_notices_remind(7) as n;`))[0].n;
  const howMany = (await notices(AGENT)).filter((r) => /ends in 5 days/i.test(r.title)).length;
  ok(again === 0 && howMany === 1,
     "running it a second time writes nothing, so a daily job says one thing",
     "second run wrote " + again + ", total copies " + howMany);

  // Two days out is a different sentence and a different colour, and it is a
  // different dedupe key because it is a different date being warned about.
  await runSql(`delete from public.agent_messages where to_user_id = ${literal(AGENT)};
                update public.agent_billing set paid_until = current_date + 1
                 where agent_key = ${literal(KEY)}; select 1 as done;`);
  await asAdmin(`select public.agent_notices_remind(7);`);
  const soon = (await notices(AGENT)).find((r) => /tomorrow/i.test(r.title));
  ok(!!soon && soon.severity === "urgent",
     "tomorrow is urgent, and says tomorrow rather than 'in 1 days'",
     JSON.stringify(await titles(AGENT)));

  const byAgent = await threw(() => asUser(AGENT, `select public.agent_notices_remind(7);`));
  ok(!!byAgent, "and an agent cannot run the sweep themselves",
     byAgent ? byAgent.message.slice(0, 60) : "the call succeeded!");

  section("3. A notice reaches its recipient and nobody else");

  const mine = (await asUser(AGENT, `select public.my_notices() as n;`))[0].n;
  ok(mine.unread >= 1 && Array.isArray(mine.notices) && mine.notices.length >= 1,
     "the agent reads their own", JSON.stringify({ unread: mine.unread, n: mine.notices.length }));
  ok(mine.billing && mine.billing.days_left === 1,
     "with days_left computed on the SERVER, so a phone's wrong clock cannot change it",
     JSON.stringify(mine.billing));

  const theirs = (await asUser(OTHER, `select public.my_notices() as n;`))[0].n;
  ok(theirs.unread === 0 && theirs.notices.length === 0,
     "somebody else reads none of it", JSON.stringify(theirs));

  const peek = await asUser(OTHER,
    `select count(*)::int as n from public.agent_messages where to_user_id = ${literal(AGENT)};`);
  ok(peek[0].n === 0, "and cannot read the rows directly either: RLS, not a filter in the browser");

  section("4. Marking read");

  // Two unread, so that marking one read and clearing "the rest" are visibly
  // different actions. The second is the admin typing into the compose box,
  // which is the other half of this table and goes through its own policy.
  await asAdmin(`insert into public.agent_messages (to_user_id, title, body, kind, created_by)
                 values (${literal(AGENT)}, 'A word from the admin', 'Come and see me about the Mwanza listings.',
                         'individual', ${literal(adminEmail)}); select 1 as done;`);
  const before = (await asUser(AGENT, `select public.my_notices() as n;`))[0].n;
  ok(before.unread === 2, "an admin's typed message lands in the same place as the automatic ones",
     JSON.stringify(before.notices.map((x) => x.title)));

  const one = before.notices[0];
  const marked = (await asUser(AGENT, `select public.notice_mark_read(${literal(one.id)}::uuid) as r;`))[0].r;
  ok(marked === true, "an agent marks one of their own read");
  const twice = (await asUser(AGENT, `select public.notice_mark_read(${literal(one.id)}::uuid) as r;`))[0].r;
  ok(twice === false, "and marking it twice reports that nothing changed, rather than lying");

  const notMine = await asUser(OTHER, `select public.notice_mark_read(${literal(one.id)}::uuid) as r;`);
  ok(notMine[0].r === false, "somebody else cannot mark it read");

  const rest = (await asUser(AGENT, `select public.notices_mark_all_read() as n;`))[0].n;
  const after = (await asUser(AGENT, `select public.my_notices() as n;`))[0].n;
  ok(rest >= 1 && after.unread === 0, "and clearing the rest empties the bell",
     "cleared " + rest + ", left " + after.unread);
  ok(after.billing && after.billing.days_left === 1,
     "while the subscription state stays, because it is a fact and not a message",
     JSON.stringify(after.billing));

  section("5. What is not on offer");

  const forge = await threw(() => asUser(OTHER,
    `select public.agent_notice_send(${literal(AGENT)}, 'You owe us money', 'Pay this number', 'billing', 'urgent', null);`));
  ok(!!forge, "nobody can call the database's own writer, so no client can sign a notice 'system'",
     forge ? forge.message.slice(0, 70) : "the call succeeded!");

  const direct = await threw(() => asUser(OTHER, `
    insert into public.agent_messages (to_user_id, body, title) values (${literal(AGENT)}, 'x', 'x');`));
  const forged = await runSql(
    `select count(*)::int as n from public.agent_messages where to_user_id = ${literal(AGENT)} and body = 'x';`);
  ok(forged[0].n === 0, "and cannot insert one by hand either",
     direct ? direct.message.slice(0, 70) : "the insert succeeded!");
} finally {
  await cleanup();
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
