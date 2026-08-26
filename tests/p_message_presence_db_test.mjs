// ============================================================================
// p_message_presence_db_test.mjs — presence, the storefront and reply targets,
// against production.
// ============================================================================
// Three migrations added three things a page cannot check for itself:
//
//   • pm_presence holds when somebody last had P-Message open, and the whole
//     containment argument is that NOTHING can read it directly — the table
//     has RLS on and not one policy, and only SECURITY DEFINER functions that
//     already decide who may see whom hand it out. A policy quietly added
//     later would turn presence into a tracking API and nothing on any screen
//     would look different. That is what section 1 is for.
//
//   • pm_agent_card / pm_agent_listings are the storefront. They are
//     signed-in only, they refuse guests, and they never return a phone
//     number — the last one is the invariant every function touching this
//     directory holds, and the easiest one to break by adding a column.
//
//   • reply_to must point at a message in the SAME thread. Without that check
//     a reply could name a message in a conversation the sender was never in,
//     and the id of a stranger's message would sit in a row they can read.
//
// Every attack is run through `set local role authenticated` with real JWT
// claims. As `postgres` every policy is bypassed and the test would prove
// nothing at all.
//
// It writes to production. Every row is prefixed `pmpres_` and deleted at both
// ends of the run.
//
//   usage:  node tests/p_message_presence_db_test.mjs
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

function asAnon(sql) {
  return runSql(
    `begin;
     do $claims$ begin perform set_config('request.jwt.claims', '{"role":"anon"}', true); end $claims$;
     set local role anon;
     ${sql}
     commit;`
  );
}

const AMINA = "pmpres_amina", JOHN = "pmpres_john", MOLE = "pmpres_mole";
const GUEST = "pmpres_guest";
const IDS = [AMINA, JOHN, MOLE, GUEST];

async function cleanup() {
  await runSql(`
    delete from public.pm_message_keys where user_id like 'pmpres_%'
       or message_id in (select id from public.pm_messages where sender_id like 'pmpres_%');
    delete from public.pm_messages where sender_id like 'pmpres_%'
       or thread_id in (select id from public.pm_threads where created_by like 'pmpres_%');
    delete from public.pm_members where user_id like 'pmpres_%'
       or thread_id in (select id from public.pm_threads where created_by like 'pmpres_%');
    delete from public.pm_threads where created_by like 'pmpres_%';
    delete from public.pm_presence where user_id like 'pmpres_%';
    delete from public.pm_keys where user_id like 'pmpres_%';
    delete from public.houses where owner_user_id like 'pmpres_%';
    delete from public.agent_profiles where user_id like 'pmpres_%';
    select 1 as done;`);
}

try {
  await cleanup();

  const people = {};
  for (const id of IDS) {
    const idn = { userId: id, ...(await PM.generateIdentity()) };
    idn.fingerprint = await PM.fingerprint(idn.publicKey);
    people[id] = idn;
  }

  // Amina is a real agent with a bio and one house listed. That is what the
  // storefront is FOR, so the fixture has to be a storefront-shaped person
  // rather than a bare key row.
  await runSql(`
    insert into public.agent_profiles (user_id, name, region, area_of_operations, district, ward, bio)
    values (${literal(AMINA)}, 'pmpres Amina', 'Mwanza', 'Nyamagana', 'Nyamagana', 'Mirongo',
            'pmpres bio — twenty years of plumbing')
    on conflict (user_id) do update set bio = excluded.bio;
    insert into public.houses (id, title, type, listing, price_tzs, region, area, owner_user_id)
    values ('pmpres-h1', 'pmpres two rooms', 'apartment', 'rent', 250000, 'Mwanza', 'Nyamagana', ${literal(AMINA)})
    on conflict (id) do nothing;`);

  for (const id of [AMINA, JOHN, MOLE]) {
    await asUser({ sub: id },
      `select public.pm_publish_key(${literal(people[id].publicKey)},
         ${literal(people[id].fingerprint)}, ${literal("pmpres " + id.slice(7))}, 'Mwanza');`);
  }
  await asGuest({ sub: GUEST },
    `select public.pm_publish_key(${literal(people[GUEST].publicKey)},
       ${literal(people[GUEST].fingerprint)}, 'pmpres visitor', 'Mwanza');`);

  // ==========================================================================
  section("1. Presence is not a table anybody can read");
  // ==========================================================================
  await asUser({ sub: AMINA }, `select public.pm_touch_seen();`);

  const policies = await runSql(
    `select count(*)::int as n from pg_policies where schemaname='public' and tablename='pm_presence';`);
  ok(policies[0].n === 0,
     "pm_presence carries not one policy — the containment is the absence, not a clever one",
     JSON.stringify(policies[0]));

  const rls = await runSql(
    `select relrowsecurity as on from pg_class where relname='pm_presence' and relnamespace='public'::regnamespace;`);
  ok(rls[0].on === true, "with row security switched on, so no policy means no rows");

  const peek = await threw(() => asUser({ sub: MOLE },
    `select last_seen_at from public.pm_presence where user_id = ${literal(AMINA)};`));
  const peeked = peek === null
    ? await asUser({ sub: MOLE }, `select count(*)::int as n from public.pm_presence;`)
    : null;
  ok(peek !== null || (peeked && peeked[0].n === 0),
     "so a signed-in stranger reading the table directly gets nothing",
     peek && peek.message);

  const anonPeek = await threw(() => asAnon(`select count(*) from public.pm_presence;`));
  const anonRows = anonPeek === null ? await asAnon(`select count(*)::int as n from public.pm_presence;`) : null;
  ok(anonPeek !== null || (anonRows && anonRows[0].n === 0),
     "and so does anybody holding only the public anon key");

  // The heartbeat itself: cheap on purpose, and it must not rewrite a value
  // that is already fresh, or a tab left open all day is a write per minute
  // for nothing.
  const beats = await asUser({ sub: AMINA },
    `select public.pm_touch_seen() as a, public.pm_touch_seen() as b;`);
  ok(beats[0].a && String(beats[0].a) === String(beats[0].b),
     "a second beat inside the window returns the stored time and writes nothing",
     JSON.stringify(beats[0]));

  const anonBeat = await asAnon(`select public.pm_touch_seen() as t;`);
  ok(anonBeat[0].t === null, "and somebody signed out has no presence to record");

  // ==========================================================================
  section("2. It comes back only through the doors that already decide who sees whom");
  // ==========================================================================
  const found = await asUser({ sub: MOLE },
    `select user_id, last_seen_at, kinds from public.pm_agent_finder(null, null, null, 200);`);
  const aminaRow = found.find((r) => r.user_id === AMINA);
  ok(!!aminaRow && !!aminaRow.last_seen_at,
     "the directory carries when an agent was last here", JSON.stringify(aminaRow));
  ok(!!aminaRow && Array.isArray(aminaRow.kinds) && aminaRow.kinds.includes("apartment"),
     "and WHAT KIND of thing they list, not only how many",
     JSON.stringify(aminaRow && aminaRow.kinds));

  // Seconds would tell an observer when somebody put the phone down. Minutes
  // tell them what they came for.
  ok(!!aminaRow && new Date(aminaRow.last_seen_at).getUTCSeconds() === 0,
     "truncated to the minute on the way out");

  const guestSees = await asGuest({ sub: GUEST },
    `select count(*)::int as n from public.pm_agent_finder(null, null, null, 200);`);
  ok(guestSees[0].n >= 1,
     "a guest can still find an agent — the directory was never closed to them");

  // pm_peer is the conversation header, and it has always required a shared
  // thread. Presence rides on that fence rather than getting one of its own.
  const noThread = await asUser({ sub: MOLE },
    `select count(*)::int as n from public.pm_peer(${literal(AMINA)});`);
  ok(noThread[0].n === 0,
     "pm_peer still says nothing about somebody you share no conversation with");

  const thread = (await asUser({ sub: JOHN },
    `select public.pm_start_direct(${literal(AMINA)}) as id;`))[0].id;
  const peer = await asUser({ sub: JOHN }, `select * from public.pm_peer(${literal(AMINA)});`);
  ok(peer.length === 1 && !!peer[0].last_seen_at,
     "and tells somebody who does share one", JSON.stringify(peer[0] && peer[0].last_seen_at));

  // ==========================================================================
  section("3. The storefront");
  // ==========================================================================
  const card = await asUser({ sub: MOLE }, `select * from public.pm_agent_card(${literal(AMINA)});`);
  ok(card.length === 1, "an agent has a card");
  ok(card[0].is_agent === true && card[0].reachable === true,
     "which says they are an agent and can be written to", JSON.stringify(card[0] && card[0].reachable));
  ok(/twenty years of plumbing/.test(card[0].bio || ""),
     "carrying the bio they wrote themselves", card[0] && card[0].bio);
  ok(card[0].n_houses === 1, "and a count of what they list", JSON.stringify(card[0] && card[0].n_houses));

  // The invariant every function on this directory holds.
  ok(!Object.keys(card[0]).some((k) => /phone/i.test(k)),
     "and NO phone number — the one column this whole directory exists to withhold",
     JSON.stringify(Object.keys(card[0])));

  const listings = await asUser({ sub: MOLE }, `select * from public.pm_agent_listings(${literal(AMINA)}, 60);`);
  ok(listings.length === 1 && listings[0].listing_id === "pmpres-h1",
     "their listings come back with them", JSON.stringify(listings.map((l) => l.listing_id)));
  ok(listings[0].kind === "apartment" && listings[0].cat === "houses",
     "each one saying which catalogue it is in and what kind of thing it is",
     JSON.stringify({ cat: listings[0].cat, kind: listings[0].kind }));
  ok(!Object.keys(listings[0]).some((k) => /phone/i.test(k)),
     "and still no phone number");

  const anonCard = await asAnon(`select count(*)::int as n from public.pm_agent_card(${literal(AMINA)});`);
  ok(anonCard[0].n === 0,
     "somebody signed out gets no card — a storefront that worked signed-out would enumerate every agent in the country");
  const anonList = await asAnon(`select count(*)::int as n from public.pm_agent_listings(${literal(AMINA)}, 60);`);
  ok(anonList[0].n === 0, "and no catalogue either");

  const guestCard = await asGuest({ sub: GUEST },
    `select count(*)::int as n from public.pm_agent_card(${literal(GUEST)});`);
  ok(guestCard[0].n === 0,
     "and a guest has no storefront of their own — a disposable identity is not a page to link to");

  const nobody = await asUser({ sub: MOLE }, `select count(*)::int as n from public.pm_agent_card('pmpres_nobody');`);
  ok(nobody[0].n === 0, "an id nobody owns answers with nothing, not with an error that confirms the guess");

  // ==========================================================================
  section("4. A reply can only answer a message in the same conversation");
  // ==========================================================================
  const sealFor = async (senderId, threadId, recipients, text) => {
    const idn = people[senderId];
    return PM.seal({
      threadId, senderId,
      recipients: recipients.map((r) => ({ userId: r, publicKey: people[r].publicKey })),
      plaintext: text,
    });
  };

  const s1 = await sealFor(JOHN, thread, [JOHN, AMINA], "pmpres first");
  const first = (await asUser({ sub: JOHN },
    `select public.pm_send(${literal(thread)}::uuid, ${literal(s1.iv)}, ${literal(s1.ciphertext)},
       ${literal(JSON.stringify(s1.keys))}::jsonb) as id;`))[0].id;

  const s2 = await sealFor(AMINA, thread, [JOHN, AMINA], "pmpres answer");
  const answer = (await asUser({ sub: AMINA },
    `select public.pm_send(${literal(thread)}::uuid, ${literal(s2.iv)}, ${literal(s2.ciphertext)},
       ${literal(JSON.stringify(s2.keys))}::jsonb, ${literal(first)}::uuid) as id;`))[0].id;

  const rows = await asUser({ sub: JOHN },
    `select id, reply_to from public.pm_thread_messages(${literal(thread)}::uuid, 50);`);
  const answered = rows.find((r) => r.id === answer);
  ok(!!answered && answered.reply_to === first,
     "an answer carries the id of what it answers, and the thread hands it back",
     JSON.stringify(answered));

  // The whole design: only the id is stored. Nothing in the row can be the
  // quoted words, because the quoted words were never sent.
  const stored = await runSql(
    `select column_name from information_schema.columns
      where table_schema='public' and table_name='pm_messages' order by ordinal_position;`);
  const cols = stored.map((c) => c.column_name);
  ok(cols.includes("reply_to") && !cols.some((c) => /quote|preview|excerpt/i.test(c)),
     "and the table stores an id and no preview — the quote is drawn from the reader's own decrypted copy",
     JSON.stringify(cols));

  // A second conversation, and a reply that tries to reach across it.
  const other = (await asUser({ sub: JOHN },
    `select public.pm_start_direct(${literal(MOLE)}) as id;`))[0].id;
  const s3 = await sealFor(JOHN, other, [JOHN, MOLE], "pmpres elsewhere");
  const crossed = await threw(() => asUser({ sub: JOHN },
    `select public.pm_send(${literal(other)}::uuid, ${literal(s3.iv)}, ${literal(s3.ciphertext)},
       ${literal(JSON.stringify(s3.keys))}::jsonb, ${literal(first)}::uuid);`));
  ok(crossed !== null,
     "a reply pointing at a message in ANOTHER conversation is refused",
     crossed && crossed.message);

  const junk = await threw(() => asUser({ sub: JOHN },
    `select public.pm_send(${literal(other)}::uuid, ${literal(s3.iv)}, ${literal(s3.ciphertext)},
       ${literal(JSON.stringify(s3.keys))}::jsonb, '00000000-0000-0000-0000-000000000000'::uuid);`));
  ok(junk !== null, "and so is one pointing at a message that does not exist", junk && junk.message);

  // The ordinary case must still be ordinary: nearly every message is not a
  // reply, and a check that made those fail would be worse than no check.
  const plain = await threw(() => asUser({ sub: JOHN },
    `select public.pm_send(${literal(other)}::uuid, ${literal(s3.iv)}, ${literal(s3.ciphertext)},
       ${literal(JSON.stringify(s3.keys))}::jsonb);`));
  ok(plain === null, "while a message that answers nothing goes as it always did", plain && plain.message);

  // ==========================================================================
  section("5. Nothing here loosened the table fences");
  // ==========================================================================
  const writes = await runSql(
    `select tablename, cmd from pg_policies
      where schemaname='public' and tablename like 'pm\\_%' and cmd <> 'SELECT';`);
  ok(writes.length === 0,
     "still no write policy on any pm_ table: every write goes through a function that checks something",
     JSON.stringify(writes));

  const viewGrants = await runSql(
    `select count(*)::int as n from information_schema.role_table_grants
      where table_schema='public' and table_name='pm_owner_listings'
        and grantee in ('anon','authenticated');`);
  ok(viewGrants[0].n === 0,
     "and pm_owner_listings is still not readable by a client, though it now carries titles and prices",
     JSON.stringify(viewGrants[0]));
} catch (e) {
  fail++;
  console.log("\n  FAIL  the run itself threw\n        " + (e && e.message ? e.message : String(e)));
} finally {
  await cleanup();
  console.log("\n  (test rows removed)");
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
