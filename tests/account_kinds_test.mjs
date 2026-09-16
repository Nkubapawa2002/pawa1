// ============================================================================
// account_kinds_test.mjs — four kinds of account, and what each may actually do.
//
// WHAT THIS EXISTS TO PIN DOWN
// login.html has offered four account types since it shipped. Counted in
// production on 2026-09-16, public.account_kinds held ZERO rows across 28
// accounts and no user carried the metadata either, so the picker every new
// person sees was deciding nothing at all. Two of the four kinds also meant
// nothing anywhere: 'company' and 'user' were valid values in a CHECK
// constraint and no trigger, policy, fee rule or screen branched on either.
//
// So the questions here are the ones that were never asked:
//
//   · does each kind get recorded when somebody picks it?
//   · may an agent and an owner list, and are a company and a user refused?
//   · is an account with NO ROW left exactly as it was? (This is the one that
//     protects every existing account. account_kind() defaults to 'agent', and
//     if this file ever goes red, a live account has just lost its portal.)
//   · does the refusal say something a person can act on?
//   · can an owner still not be quietly relabelled an agent?
//
// Runs against the REAL database as a signed-in user, because as `postgres`
// every policy is bypassed and the test proves nothing. Every row it creates is
// prefixed `aktest_` and deleted at both ends of the run.
//
//   usage:  node tests/account_kinds_test.mjs
// ============================================================================
import { runSql, asUser, literal } from "../scripts/db/sql.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const AGENT = "aktest_agent", OWNER = "aktest_owner",
      COMPANY = "aktest_company", USER = "aktest_user", NOROW = "aktest_norow";
const ALL = [AGENT, OWNER, COMPANY, USER, NOROW];

async function cleanup() {
  await runSql(`
    delete from public.owner_posts   where user_id like 'aktest_%';
    delete from public.houses        where id like 'aktest_%' or owner_user_id like 'aktest_%';
    delete from public.trucks        where id like 'aktest_%' or owner_user_id like 'aktest_%';
    delete from public.services      where id like 'aktest_%' or owner_user_id like 'aktest_%';
    delete from public.agent_profiles where user_id like 'aktest_%';
    delete from public.account_kinds where user_id like 'aktest_%';
    select 1 as done;`);
}

/** A house insert attempted AS that account. Returns the error, or null. */
const tryHouse = (uid, id) => threw(() => asUser({ sub: uid }, `
  insert into public.houses (id, title, type, listing, owner_user_id, region)
  values (${literal(id)}, 'aktest house', 'room', 'rent', ${literal(uid)}, 'Mwanza');`));

try {
  await cleanup();

  // ==========================================================================
  section("0. kind_may_list() is the single answer, and it is generous by default");
  {
    const r = (await runSql(`select
      public.kind_may_list('agent')   as agent,
      public.kind_may_list('owner')   as owner,
      public.kind_may_list('company') as company,
      public.kind_may_list('user')    as usr,
      public.kind_may_list(null)      as none;`))[0];
    ok(r.agent === true, "an agent lists");
    ok(r.owner === true, "an owner lists");
    ok(r.company === false, "a job company does not");
    ok(r.usr === false, "and neither does somebody just looking");
    ok(r.none === true,
       "A NULL KIND LISTS. An account with no row has always been an agent, and this file must never narrow one",
       String(r.none));
  }

  // ==========================================================================
  section("1. Claiming a kind records it, for all four");
  for (const [uid, kind] of [[AGENT, "agent"], [OWNER, "owner"], [COMPANY, "company"], [USER, "user"]]) {
    const err = await threw(() => asUser({ sub: uid },
      `select public.account_kind_claim(${literal(kind)});`));
    ok(!err, `a ${kind} account can claim its own kind`, err ? err.message : "");
  }
  {
    const rows = await runSql(
      `select user_id, kind, set_by from public.account_kinds
        where user_id like 'aktest_%' order by user_id;`);
    ok(rows.length === 4, "four rows, one per kind", JSON.stringify(rows.map((r) => r.kind)));
    ok(rows.every((r) => r.set_by === "self"),
       "each stamped as the account's own choice, not an admin's");
  }
  {
    // The whole reason this feature was invisible: the default.
    const r = (await runSql(
      `select public.account_kind(${literal(NOROW)}) as k;`))[0];
    ok(r.k === "agent",
       "an account that claimed nothing still reads as 'agent', which is what every existing account is",
       r.k);
  }

  // ==========================================================================
  section("2. Who may put something in the catalogue");
  {
    const e = await tryHouse(AGENT, "aktest_h_agent");
    ok(!e, "an agent lists a house", e ? e.message : "");
  }
  {
    const e = await tryHouse(OWNER, "aktest_h_owner");
    ok(!e, "so does an owner", e ? e.message : "");
  }
  {
    const e = await tryHouse(NOROW, "aktest_h_norow");
    ok(!e, "AND SO DOES AN ACCOUNT WITH NO ROW. Nothing was taken from anybody", e ? e.message : "");
  }
  {
    const e = await tryHouse(COMPANY, "aktest_h_company");
    ok(!!e, "a job company is refused");
    ok(!!e && /day jobs/i.test(e.message),
       "and told what its account IS for, not just what it is not",
       e ? e.message : "");
    ok(!!e && /change your account type/i.test(e.message),
       "with the way out in the same sentence, because there is one",
       e ? e.message : "");
  }
  {
    const e = await tryHouse(USER, "aktest_h_user");
    ok(!!e, "somebody just looking is refused too");
    ok(!!e && /just looking/i.test(e.message),
       "named as the thing they chose, so the sentence is recognisable",
       e ? e.message : "");
  }
  {
    const n = (await runSql(
      `select count(*)::int as n from public.houses where id like 'aktest_h_%';`))[0].n;
    ok(n === 3, "three landed and two did not", String(n));
  }

  // ==========================================================================
  section("3. Trucks and services are fenced the same way");
  for (const [table, cols, vals] of [
    ["trucks",   "(id, title, owner_user_id, region)", "'aktest_t_c', 'aktest truck', 'aktest_company', 'Mwanza'"],
    ["services", "(id, title, owner_user_id, region)", "'aktest_s_c', 'aktest service', 'aktest_company', 'Mwanza'"],
  ]) {
    const e = await threw(() => asUser({ sub: COMPANY },
      `insert into public.${table} ${cols} values (${vals});`));
    ok(!!e && /day jobs/i.test(e.message),
       `a company cannot list in ${table} either`,
       e ? e.message : "it was allowed");
  }

  // ==========================================================================
  section("4. my_account_kind() answers about the caller and nobody else");
  {
    const r = (await asUser({ sub: COMPANY }, `select * from public.my_account_kind();`))[0];
    ok(r.kind === "company", "it reports the caller's own kind", JSON.stringify(r));
    ok(r.may_list === false, "and whether they may list");
    ok(r.is_default === false, "and that this was a choice rather than the fallback");
  }
  {
    const r = (await asUser({ sub: NOROW }, `select * from public.my_account_kind();`))[0];
    ok(r.kind === "agent" && r.is_default === true,
       "an account with no row is told it is TREATED as an agent, which is the honest word",
       JSON.stringify(r));
  }
  {
    // It takes no argument, so there is nothing to point at somebody else.
    const e = await threw(() => asUser({ sub: USER },
      `select * from public.my_account_kind(${literal(OWNER)});`));
    ok(!!e, "there is no overload that takes a user id, so it cannot be aimed at anyone");
  }

  // ==========================================================================
  section("5. An owner still cannot be quietly relabelled an agent");
  {
    // account_kind_claim refuses 'owner' for an account that already has an
    // agent page. The client-side half of this (agent-trucks.js and
    // agent-services.js calling AgentProfile.ensure() unguarded) is what this
    // release fixes; the database rule is what makes the fix checkable.
    await runSql(`insert into public.agent_profiles (user_id, name, region)
      values (${literal(AGENT)}, 'aktest agent', 'Mwanza')
      on conflict (user_id) do nothing; select 1 as done;`);
    const e = await threw(() => asUser({ sub: AGENT },
      `select public.account_kind_claim('owner');`));
    ok(!!e && /agent page/i.test(e.message),
       "an account with an agent page cannot claim the owner exemption",
       e ? e.message : "it was allowed");
  }

  // ==========================================================================
  section("6. Nothing leaked into production");
  {
    const n = (await runSql(`select
      (select count(*) from public.houses where id like 'aktest_%')
      + (select count(*) from public.account_kinds where user_id like 'aktest_%')
      + (select count(*) from public.agent_profiles where user_id like 'aktest_%') as n;`))[0].n;
    ok(n > 0, "the test's own rows are there, about to be cleaned up", String(n));
  }
  await cleanup();
  {
    const n = (await runSql(`select
      (select count(*) from public.houses where id like 'aktest_%')
      + (select count(*) from public.trucks where id like 'aktest_%')
      + (select count(*) from public.services where id like 'aktest_%')
      + (select count(*) from public.account_kinds where user_id like 'aktest_%')
      + (select count(*) from public.agent_profiles where user_id like 'aktest_%')
      + (select count(*) from public.owner_posts where user_id like 'aktest_%') as n;`))[0].n;
    ok(n === 0, "and every one of them is gone", String(n));
  }
} catch (err) {
  fail++;
  console.log("\n  FAIL  the suite itself threw\n        " + (err && err.message || err));
  try { await cleanup(); } catch (_) {}
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
