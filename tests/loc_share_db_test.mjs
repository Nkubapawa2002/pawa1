// ============================================================================
// loc_share_db_test.mjs — location codes against the REAL database, RLS on.
//
// loc_code_test.mjs proves the nine characters and the sealing are sound in
// isolation. This proves the other half, which is the half that can be quietly
// wrong: that the tables are unreachable except through the functions, that a
// wrong code costs the caller something, that a guest is metered rather than
// trusted, and that the row sitting in the database really does contain no
// location.
//
// Every statement runs under an explicit role — `anon` for the person at the
// house who has no account, `authenticated` for the agent — because as
// `postgres` every grant and every policy is bypassed and a test that forgets
// this proves nothing whatsoever.
//
// It writes to production. Every row it creates is deleted at both ends of the
// run, and the accounts it acts as are prefixed `loctest_`.
//
//   usage:  node tests/loc_share_db_test.mjs
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { runSql, literal } from "../scripts/db/sql.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const sandbox = { console, crypto: webcrypto, TextEncoder, TextDecoder, Buffer };
sandbox.globalThis = sandbox; sandbox.window = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, "js/lib/loc-code.js"), "utf8"), ctx, { filename: "loc-code.js" });
const L = sandbox.LocCode;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

/**
 * Run SQL as a specific Postgres role with specific JWT claims.
 *
 * scripts/db/sql.mjs only offers `authenticated`, and its asUser() sets sub and
 * email alone — a guest also needs is_anonymous in the claims or app_is_guest()
 * silently reads as "not a guest" and the guest fence tests nothing.
 */
function asRole(role, claims, sql) {
  const json = JSON.stringify(Object.assign({ role }, claims || {}));
  return runSql(
    `begin;
     do $c$ begin perform set_config('request.jwt.claims', ${literal(json)}, true); end $c$;
     set local role ${role};
     ${sql}
     commit;`
  );
}
const asAnon = (sql) => asRole("anon", {}, sql);
const asAgent = (sub, sql) => asRole("authenticated", { sub, email: sub + "@example.test" }, sql);
const asGuest = (sub, sql) => asRole("authenticated", { sub, is_anonymous: true }, sql);

// Everything this run put in the database, so it can take it all out again.
const madeHandles = [];
const madeTickets = [];
const usedAccounts = new Set();

async function cleanup() {
  const pep = `(select pepper from public.loc_share_secrets where id = 1)`;
  if (madeHandles.length) {
    await runSql(`delete from public.loc_shares where handle_pep in (${
      madeHandles.map((h) => `extensions.hmac(decode(${literal(h)}, 'hex'), ${pep}, 'sha256')`).join(",")
    });`);
  }
  if (madeTickets.length) {
    await runSql(`delete from public.loc_share_tickets where ticket_hash in (${
      madeTickets.map((t) => `extensions.digest(convert_to(${literal(t)}, 'utf8'), 'sha256')`).join(",")
    });`);
  }
  if (usedAccounts.size) {
    await runSql(`delete from public.loc_share_misses where user_id in (${
      [...usedAccounts].map(literal).join(",")
    });`);
  }
}

/** The sender's whole job: take a slip, finish the code, encrypt, store. */
async function share(place, { ttl = 30, maxOpens = 1 } = {}) {
  const [slip] = await asAnon(`select * from public.loc_share_ticket();`);
  madeTickets.push(slip.ticket);
  const code = L.completeCode(slip.locator);
  const sealed = await L.seal(code, place);
  const rev = await L.revokeToken();
  madeHandles.push(sealed.handle);
  const [row] = await asAnon(
    `select * from public.loc_share_create(
       ${literal(slip.ticket)}, ${literal(sealed.handle)}, ${literal(sealed.cipher)},
       ${literal(sealed.iv)}, ${ttl}, ${maxOpens}, ${literal(rev.hash)});`);
  return { code, handle: sealed.handle, ticket: slip.ticket, locator: slip.locator,
           revoke: rev.token, expiresAt: row && row.expires_at };
}

async function openAs(sub, code) {
  usedAccounts.add(sub);
  const handle = L.isValid(code) ? (await L.derive(code)).handle : code;
  const [row] = await asAgent(sub, `select * from public.loc_share_open(${literal(handle)});`);
  return row;
}

const PLACE = { lat: -6.792354, lng: 39.208328, acc: 9, label: "loctest shop", at: Date.now() };

try {
  await cleanup();

  section("1. Nothing reaches the tables directly");
  {
    for (const t of ["loc_shares", "loc_share_secrets", "loc_share_tickets", "loc_share_misses"]) {
      const e = await threw(() => asAnon(`select count(*) from public.${t};`));
      ok(e !== null, `anon cannot read ${t}`, e && e.message.slice(0, 90));
      const e2 = await threw(() => asAgent("loctest_probe", `select count(*) from public.${t};`));
      ok(e2 !== null, `a signed-in account cannot read ${t} either`, e2 && e2.message.slice(0, 90));
    }
    const e3 = await threw(() => asAnon(`select nextval('public.loc_share_seq');`));
    ok(e3 !== null, "and nobody can turn the counter by hand");
  }

  section("2. A slip carries one locator, and is spent once");
  {
    const a = await asAnon(`select * from public.loc_share_ticket();`);
    const b = await asAnon(`select * from public.loc_share_ticket();`);
    madeTickets.push(a[0].ticket, b[0].ticket);
    ok(a[0].locator.length === 5 && /^[0-9A-HJKMNP-TV-Z]{5}$/.test(a[0].locator),
       `the locator is five Crockford characters (${a[0].locator})`);
    ok(a[0].locator !== b[0].locator, "two slips never carry the same locator");

    // The whole reason the locator is minted server-side: a client cannot make
    // one up, because it cannot forge the signature on the slip.
    const forged = a[0].locator + "." + (Math.floor(Date.now() / 1000) + 600) + "." + "00".repeat(32);
    const code = L.completeCode(a[0].locator);
    const sealed = await L.seal(code, PLACE);
    const rev = await L.revokeToken();
    const e = await threw(() => asAnon(
      `select * from public.loc_share_create(${literal(forged)}, ${literal(sealed.handle)},
        ${literal(sealed.cipher)}, ${literal(sealed.iv)}, 30, 1, ${literal(rev.hash)});`));
    ok(e !== null && /LOC_BAD_TICKET/.test(e.message), "an invented slip is refused");

    // Spend the real one, then try to spend it again.
    madeHandles.push(sealed.handle);
    await asAnon(`select * from public.loc_share_create(${literal(a[0].ticket)}, ${literal(sealed.handle)},
      ${literal(sealed.cipher)}, ${literal(sealed.iv)}, 30, 1, ${literal(rev.hash)});`);
    const code2 = L.completeCode(a[0].locator);
    const sealed2 = await L.seal(code2, PLACE);
    const e2 = await threw(() => asAnon(
      `select * from public.loc_share_create(${literal(a[0].ticket)}, ${literal(sealed2.handle)},
        ${literal(sealed2.cipher)}, ${literal(sealed2.iv)}, 30, 1, ${literal(rev.hash)});`));
    ok(e2 !== null && /LOC_TICKET_SPENT/.test(e2.message),
       "and it cannot be spent twice — two codes must never share five characters");
  }

  section("3. The whole journey: a phone call and a pin");
  {
    const s = await share(PLACE);
    ok(/^[0-9A-HJKMNP-TV-Z]{9}$/.test(s.code), `the sender reads out ${L.format(s.code)}`);
    ok(L.isValid(s.code), "and it passes its own check character");

    const r = await openAs("loctest_agent1", s.code);
    ok(r.status === "ok", "the agent's account opens it", r && r.status);
    const back = await L.open(s.code, r.cipher, r.iv);
    ok(back.lat === PLACE.lat && back.lng === PLACE.lng,
       "and gets the exact coordinates the sender was standing on");
    ok(back.label === PLACE.label, "with the label the sender typed");
    ok(r.opens === 1 && r.max_opens === 1, "the open was counted");
  }

  section("4. A guest may open a code, and is metered for it");
  {
    // This used to assert 'forbidden'. It was the right fence for the wrong
    // reason: P-Message's front door signs people in anonymously, so the rule
    // refused most of the people who are ever handed a code, and it refused
    // them with a status neither page had a sentence for. What replaces it is
    // a budget rather than a ban, because the thing that made the old rule
    // necessary — a guest can mint a new account per request — is defeated by
    // a GLOBAL count and not by a per-account one.
    // Registered for cleanup BEFORE they are used. The misses below are guest
    // misses, and a guest miss left behind spends the global budget for an
    // hour: a test that forgets this degrades the live feature for real
    // guests, not just for itself.
    usedAccounts.add("loctest_guest");
    usedAccounts.add("loctest_guest2");

    const s = await share(PLACE);
    const [r] = await asGuest("loctest_guest", `select * from public.loc_share_open(${literal(s.handle)});`);
    ok(r.status === "ok", "a guest opens a code they were given", r && r.status);
    ok(r.cipher !== null, "and is handed the ciphertext to unseal with the code");

    // Wrong codes still cost a guest something, and sooner than an account.
    const bogus = "f".repeat(64);
    let last = null;
    for (let i = 0; i < 4; i++) {
      [last] = await asGuest("loctest_guest2",
        `select * from public.loc_share_open(${literal(bogus)});`);
    }
    ok(last.status === "rate_limited",
       "a guest guessing is stopped after three misses, not ten", last && last.status);

    const [gm] = await runSql(
      `select count(*)::int as n from public.loc_share_misses
        where user_id = 'loctest_guest2' and is_guest;`);
    ok(gm.n === 3, "and every one of those misses is recorded AS a guest miss", "n=" + gm.n);

    // The load-bearing half: a guest who rotates accounts is still metered,
    // because the global count does not care which account missed.
    const [gg] = await runSql(
      `select count(*)::int as n from public.loc_share_misses
        where is_guest and missed_at > now() - interval '1 hour';`);
    ok(gg.n >= 3, "the global guest budget sees them all, whatever they call themselves", "n=" + gg.n);

    // Not a guest, just not signed in at all. Unchanged.
    const e = await threw(() => asAnon(`select * from public.loc_share_open(${literal(s.handle)});`));
    ok(e !== null, "and anon has no permission to call it at all", e && e.message.slice(0, 80));
  }

  section("5. A code that ran out says so, and costs nothing");
  {
    const s = await share(PLACE, { maxOpens: 1 });
    await openAs("loctest_agent2", s.code);
    const again = await openAs("loctest_agent2", s.code);
    ok(again.status === "used_up", "a single-use code opens once", again && again.status);

    const [misses] = await runSql(
      `select count(*)::int as n from public.loc_share_misses where user_id = 'loctest_agent2';`);
    ok(misses.n === 0, "and a used-up code is not held against the agent who typed it correctly");

    // Age one out by hand — waiting thirty minutes is not a test.
    const s2 = await share(PLACE, { ttl: 30 });
    await runSql(`update public.loc_shares set expires_at = now() - interval '1 minute'
                  where handle_pep = extensions.hmac(decode(${literal(s2.handle)}, 'hex'),
                        (select pepper from public.loc_share_secrets where id = 1), 'sha256');`);
    const exp = await openAs("loctest_agent2", s2.code);
    ok(exp.status === "expired", "an expired code is named as expired, not as wrong", exp && exp.status);
  }

  section("6. Guessing is expensive and then it stops");
  {
    const sub = "loctest_guesser";
    let statuses = [];
    for (let i = 0; i < 12; i++) {
      const junk = L.completeCode("Z" + L.ALPHABET[i] + "9Q4");   // valid shape, no such share
      statuses.push((await openAs(sub, junk)).status);
    }
    ok(statuses.slice(0, 10).every((s) => s === "not_found"),
       "the first ten wrong codes are simply not found");
    ok(statuses[10] === "rate_limited" && statuses[11] === "rate_limited",
       "the eleventh and twelfth are refused outright", statuses.slice(9).join(","));

    // The miss must SURVIVE. A raise inside the function would have rolled the
    // insert back and the counter would reset on every attempt.
    const [n] = await runSql(
      `select count(*)::int as n from public.loc_share_misses where user_id = ${literal(sub)};`);
    ok(n.n === 10, `the ten misses were actually recorded (${n.n}) rather than rolled back`);

    // A locked-out account cannot open a share it does have the code for.
    const s = await share(PLACE);
    const blocked = await openAs(sub, s.code);
    ok(blocked.status === "rate_limited", "and the lockout applies to real codes too");

    // Someone else is unaffected.
    const fine = await openAs("loctest_agent3", s.code);
    ok(fine.status === "ok", "while another agent is untouched by it");
  }

  section("7. Only the device that made it can call it back");
  {
    const s = await share(PLACE, { maxOpens: 5 });
    const [wrong] = await asAnon(
      `select * from public.loc_share_manage(${literal(s.handle)}, 'not-the-token', true);`);
    ok(wrong.status === "forbidden", "the code alone does not revoke a share", wrong && wrong.status);

    const still = await openAs("loctest_agent4", s.code);
    ok(still.status === "ok", "so it is still open after that attempt");

    const [mine] = await asAnon(
      `select * from public.loc_share_manage(${literal(s.handle)}, ${literal(s.revoke)}, false);`);
    ok(mine.status === "ok" && mine.opens === 1,
       "the sender can see it has been opened once, without opening it");

    const [killed] = await asAnon(
      `select * from public.loc_share_manage(${literal(s.handle)}, ${literal(s.revoke)}, true);`);
    ok(killed.revoked === true, "and can revoke it");

    const dead = await openAs("loctest_agent4", s.code);
    ok(dead.status === "revoked", "after which the code is dead", dead && dead.status);

    const [row] = await runSql(
      `select cipher, iv from public.loc_shares
        where handle_pep = extensions.hmac(decode(${literal(s.handle)}, 'hex'),
              (select pepper from public.loc_share_secrets where id = 1), 'sha256');`);
    ok(row && row.cipher === "" && row.iv === "",
       "and the ciphertext is gone, not merely flagged — a deleted secret beats a promise");
  }

  section("8. What the database is actually holding");
  {
    const s = await share(PLACE, { maxOpens: 2 });
    const [row] = await runSql(
      `select * from public.loc_shares
        where handle_pep = extensions.hmac(decode(${literal(s.handle)}, 'hex'),
              (select pepper from public.loc_share_secrets where id = 1), 'sha256');`);
    const dump = JSON.stringify(row);
    ok(!dump.includes("39.20") && !dump.includes("-6.79"),
       "as the database owner, reading the row directly: no coordinates anywhere in it");
    ok(!dump.includes(PLACE.label), "no label");
    ok(!dump.includes(s.code) && !dump.includes(s.locator),
       "and not the code, nor even the five characters the server itself minted");

    const cols = Object.keys(row).sort().join(",");
    ok(cols === "cipher,created_at,expires_at,handle_pep,iv,last_opened_at,max_opens,opens,revoke_hash,revoked",
       "the row is exactly the opaque columns and nothing else", cols);

    // The claim that only the code opens it, made against the real stored row.
    const e = await threw(() => L.open(L.completeCode("ABCDE"), row.cipher, row.iv));
    ok(e !== null, "another code cannot open the stored ciphertext");
    const back = await L.open(s.code, row.cipher, row.iv);
    ok(back.lng === PLACE.lng, "the real one can");
  }

  section("9. Rubbish in is rejected before it is stored");
  {
    const [slip] = await asAnon(`select * from public.loc_share_ticket();`);
    madeTickets.push(slip.ticket);
    const rev = await L.revokeToken();
    const bad = async (handle, cipher, iv, revoke) => threw(() => asAnon(
      `select * from public.loc_share_create(${literal(slip.ticket)}, ${literal(handle)},
        ${literal(cipher)}, ${literal(iv)}, 30, 1, ${literal(revoke)});`));

    ok((await bad("nothex", "x", "y", rev.hash)) !== null, "a handle that is not 64 hex characters");
    ok((await bad("a".repeat(64), "x".repeat(5000), "y", rev.hash)) !== null, "an oversized ciphertext");
    ok((await bad("a".repeat(64), "x", "y".repeat(200), rev.hash)) !== null, "an oversized IV");
    ok((await bad("a".repeat(64), "x", "y", "short")) !== null, "a revoke hash of the wrong shape");

    const [clamped] = await asAnon(
      `select * from public.loc_share_create(${literal(slip.ticket)}, ${literal("b".repeat(64))},
        'x', 'y', 99999, 9999, ${literal(rev.hash)});`);
    madeHandles.push("b".repeat(64));
    const mins = (new Date(clamped.expires_at) - Date.now()) / 60000;
    ok(mins > 1435 && mins < 1445, `a 99999-minute request is clamped to a day (${mins.toFixed(0)} min)`);
    const [caps] = await runSql(`select max_opens from public.loc_shares
      where handle_pep = extensions.hmac(decode(${literal("b".repeat(64))}, 'hex'),
            (select pepper from public.loc_share_secrets where id = 1), 'sha256');`);
    ok(caps.max_opens === 50, `and 9999 opens is clamped to 50 (${caps.max_opens})`);
  }
} catch (err) {
  // A throw here would otherwise be swallowed by the cleanup below and the run
  // would print a tidy "0 failed" having tested almost nothing.
  fail++;
  console.log("  FAIL  the run threw before it finished\n        " + (err && err.stack || err));
} finally {
  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}
