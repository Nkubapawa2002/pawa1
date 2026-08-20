// ============================================================================
// p_sender_key_test.mjs — the sender-key scheme that makes a large room
// affordable, and the one rule that makes it safe.
//
// The interesting assertions here are not "it encrypts and decrypts". They
// are:
//   · the cost really is paid once, not once per message;
//   · a wrap made for one person / room / generation cannot be used in
//     another;
//   · and, above all, that ROTATION ACTUALLY LOCKS SOMEONE OUT. Forgetting to
//     rotate is the silent failure of this whole design — the room keeps
//     working perfectly for everyone, including the person who was removed
//     from it — so it is pinned down here rather than trusted to a comment.
//
//   usage:  node tests/p_sender_key_test.mjs
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

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

const ROOM = "11111111-2222-3333-4444-555555555555";
const OTHER_ROOM = "99999999-8888-7777-6666-555555555555";

async function person(id) {
  const idn = { userId: id, ...(await PM.generateIdentity()) };
  return idn;
}

section("1. A key handed out once");
const amina = await person("amina");
const juma  = await person("juma");
const neema = await person("neema");
const mole  = await person("mole");
const members = [amina, juma, neema, mole];

const sk = PM.newSenderKey(0);
ok(typeof sk.raw === "string" && sk.raw.length > 20, "a sender key is generated");
ok(sk.generation === 0, "starting at generation 0");

const wraps = await PM.distributeSenderKey({
  threadId: ROOM, senderId: amina.userId, generation: sk.generation, senderKey: sk.raw,
  recipients: members.map((m) => ({ userId: m.userId, publicKey: m.publicKey })),
});
ok(wraps.length === 4, "it is wrapped once for each member, including the sender herself");
ok(wraps.every((w) => w.epk === wraps[0].epk),
   "one ephemeral key covers the whole distribution — that is what makes it one pass, not N");

section("2. Every message after that is free of ECDH");
const said = ["Habari zenu wote.", "Bei ya Mwanza imepanda.", "Tukutane Jumatatu."];
const sealedAll = [];
for (let i = 0; i < said.length; i++) {
  sealedAll.push(await PM.sealWithSenderKey({
    threadId: ROOM, senderId: amina.userId, generation: sk.generation,
    seq: i, senderKey: sk.raw, plaintext: said[i],
  }));
}
ok(sealedAll.every((s) => s.alg === "SK-A256GCM"), "each message is labelled with the scheme that made it");
ok(new Set(sealedAll.map((s) => s.iv)).size === 3, "and each gets its own IV");
ok(!sealedAll.some((s) => /Mwanza|Jumatatu/i.test(s.ciphertext)), "and none of them carries readable text");

// A member opens the key ONCE, then reads everything with it.
const jumaKey = await PM.openSenderKey({
  thread_id: ROOM, sender_id: amina.userId, generation: sk.generation,
  epk: wraps[1].epk, wrapped_key: wraps.find((w) => w.user_id === "juma").wrapped_key,
}, juma);
ok(jumaKey === sk.raw, "a member unwraps the very same sender key");

for (let i = 0; i < said.length; i++) {
  const got = await PM.openWithSenderKey({
    thread_id: ROOM, sender_id: amina.userId, generation: sk.generation,
    seq: i, iv: sealedAll[i].iv, ciphertext: sealedAll[i].ciphertext,
  }, jumaKey);
  ok(got === said[i], `message ${i + 1} reads back exactly as written`);
}

section("3. Per-message keys are actually per-message");
// If seq were ignored, a ciphertext could be replayed at another position and
// still decrypt. It must not.
const shifted = await threw(() => PM.openWithSenderKey({
  thread_id: ROOM, sender_id: amina.userId, generation: sk.generation,
  seq: 2, iv: sealedAll[0].iv, ciphertext: sealedAll[0].ciphertext,
}, jumaKey));
ok(!!shifted, "a message moved to another sequence number will not open");

const moved = await threw(() => PM.openWithSenderKey({
  thread_id: OTHER_ROOM, sender_id: amina.userId, generation: sk.generation,
  seq: 0, iv: sealedAll[0].iv, ciphertext: sealedAll[0].ciphertext,
}, jumaKey));
ok(!!moved, "nor one lifted into a different room");

const relabelled = await threw(() => PM.openWithSenderKey({
  thread_id: ROOM, sender_id: "mole", generation: sk.generation,
  seq: 0, iv: sealedAll[0].iv, ciphertext: sealedAll[0].ciphertext,
}, jumaKey));
ok(!!relabelled, "nor one relabelled as somebody else's");

section("4. A wrap belongs to one person, one room, one generation");
const notYours = await threw(() => PM.openSenderKey({
  thread_id: ROOM, sender_id: amina.userId, generation: sk.generation,
  epk: wraps[0].epk, wrapped_key: wraps.find((w) => w.user_id === "juma").wrapped_key,
}, neema));
ok(!!notYours, "Neema cannot open the wrap addressed to Juma");

const wrongRoom = await threw(() => PM.openSenderKey({
  thread_id: OTHER_ROOM, sender_id: amina.userId, generation: sk.generation,
  epk: wraps[0].epk, wrapped_key: wraps.find((w) => w.user_id === "juma").wrapped_key,
}, juma));
ok(!!wrongRoom, "and the same wrap replayed into another room is refused");

const wrongGen = await threw(() => PM.openSenderKey({
  thread_id: ROOM, sender_id: amina.userId, generation: 1,
  epk: wraps[0].epk, wrapped_key: wraps.find((w) => w.user_id === "juma").wrapped_key,
}, juma));
ok(!!wrongGen, "and claiming it is a later generation does not work either");

section("5. THE RULE — rotation has to actually lock someone out");
// Mole leaves. Amina rotates. Everything after this must be closed to Mole,
// and open to the people still in the room.
const gen1 = PM.nextGeneration(sk.generation);
ok(gen1.generation === 1, "the next generation is numbered, not guessed");
ok(gen1.raw !== sk.raw, "and is a genuinely different key");

const staying = [amina, juma, neema];
const wraps1 = await PM.distributeSenderKey({
  threadId: ROOM, senderId: amina.userId, generation: gen1.generation, senderKey: gen1.raw,
  recipients: staying.map((m) => ({ userId: m.userId, publicKey: m.publicKey })),
});
ok(wraps1.length === 3, "the new key goes only to the people still in the room");
ok(!wraps1.some((w) => w.user_id === "mole"), "Mole gets no copy of it");

const afterLeaving = await PM.sealWithSenderKey({
  threadId: ROOM, senderId: amina.userId, generation: gen1.generation,
  seq: 0, senderKey: gen1.raw, plaintext: "Sasa tunaweza kuongea kwa uhuru.",
});

// Mole still holds generation 0. That is the whole question.
const moleOldKey = await PM.openSenderKey({
  thread_id: ROOM, sender_id: amina.userId, generation: sk.generation,
  epk: wraps[0].epk, wrapped_key: wraps.find((w) => w.user_id === "mole").wrapped_key,
}, mole);
ok(moleOldKey === sk.raw, "Mole does still hold the OLD key — nothing can take it back");

const moleTries = await threw(() => PM.openWithSenderKey({
  thread_id: ROOM, sender_id: amina.userId, generation: gen1.generation,
  seq: 0, iv: afterLeaving.iv, ciphertext: afterLeaving.ciphertext,
}, moleOldKey));
ok(!!moleTries,
   "but it does not open anything sent after the rotation — this is the assertion the whole scheme rests on");

const neemaKey = await PM.openSenderKey({
  thread_id: ROOM, sender_id: amina.userId, generation: gen1.generation,
  epk: wraps1[0].epk, wrapped_key: wraps1.find((w) => w.user_id === "neema").wrapped_key,
}, neema);
const neemaReads = await PM.openWithSenderKey({
  thread_id: ROOM, sender_id: amina.userId, generation: gen1.generation,
  seq: 0, iv: afterLeaving.iv, ciphertext: afterLeaving.ciphertext,
}, neemaKey);
ok(neemaReads === "Sasa tunaweza kuongea kwa uhuru.", "and the people still in the room read it normally");

// The honest other half: rotation is forward-looking only.
const moleOld = await PM.openWithSenderKey({
  thread_id: ROOM, sender_id: amina.userId, generation: sk.generation,
  seq: 0, iv: sealedAll[0].iv, ciphertext: sealedAll[0].ciphertext,
}, moleOldKey);
ok(moleOld === said[0],
   "Mole CAN still read what was said while he was a member — rotation is forward-looking, "
   + "and pretending otherwise would be a lie");

section("6. It is cheaper, which was the entire point");
const BIG = 300;
const crowd = [];
for (let i = 0; i < BIG; i++) {
  // Reuse four real keypairs rather than generating 300: the measurement is of
  // the wrapping work, and 300 genuine keygens would dominate the clock.
  const src = members[i % members.length];
  crowd.push({ userId: "u" + i, publicKey: src.publicKey });
}
const skBig = PM.newSenderKey(0);

const t0 = Date.now();
await PM.distributeSenderKey({
  threadId: ROOM, senderId: amina.userId, generation: 0, senderKey: skBig.raw, recipients: crowd,
});
const distributeMs = Date.now() - t0;

const t1 = Date.now();
for (let i = 0; i < 10; i++) {
  await PM.sealWithSenderKey({
    threadId: ROOM, senderId: amina.userId, generation: 0, seq: i,
    senderKey: skBig.raw, plaintext: "hello everyone",
  });
}
const tenMessagesMs = Date.now() - t1;

const t2 = Date.now();
await PM.seal({ threadId: ROOM, senderId: amina.userId, plaintext: "hello everyone", recipients: crowd });
const oneOldMessageMs = Date.now() - t2;

console.log(`        handing the key to ${BIG}: ${distributeMs}ms (once)`);
console.log(`        10 messages after that: ${tenMessagesMs}ms`);
console.log(`        ONE message the old way: ${oneOldMessageMs}ms (every time)`);
ok(tenMessagesMs < oneOldMessageMs,
   `ten sender-key messages cost less than one old-style message to ${BIG} people`,
   `${tenMessagesMs}ms vs ${oneOldMessageMs}ms`);
ok(tenMessagesMs < 250, "and ten messages are effectively instant", tenMessagesMs + "ms");

section("7. The old scheme is untouched");
const direct = await PM.seal({
  threadId: ROOM, senderId: amina.userId, plaintext: "still works",
  recipients: [{ userId: juma.userId, publicKey: juma.publicKey }],
});
const back = await PM.open({
  thread_id: ROOM, sender_id: amina.userId, iv: direct.iv, ciphertext: direct.ciphertext,
  epk: direct.keys[0].epk, wrapped_key: direct.keys[0].wrapped_key,
}, juma);
ok(back === "still works", "seal()/open() behave exactly as before — direct threads did not change");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
