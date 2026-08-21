// ============================================================================
// p_crypto_test.mjs — the encryption behind P-Message, exercised end to end.
//
// Crypto code that is merely "not obviously broken" is worthless: the failure
// mode is silent, and the thing it fails at is the one thing it was for. So
// these tests are written as attacks, not as happy paths — every one of them
// is a way the scheme could be wrong while still appearing to work:
//
//   · the wrong person can decrypt it            (wrap bound to the recipient)
//   · a row moved to another thread still opens  (AAD binds thread + sender)
//   · two messages reuse the same key or IV      (fresh per message)
//   · the ciphertext leaks the plaintext         (no substring survives)
//   · a broadcast to N costs N body encryptions  (one body, N wraps)
//   · a wrong backup passphrase quietly succeeds (must throw)
//
//   usage:  node tests/p_crypto_test.mjs
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The lib is a browser IIFE that hangs itself on the global. Give it a global
// with WebCrypto and a localStorage stand-in, then drive the real thing.
const store = new Map();
const sandbox = {
  console,
  crypto: webcrypto,
  TextEncoder, TextDecoder, Buffer,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
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

// ---- Cast --------------------------------------------------------------------
const asha = { userId: "user_asha", ...(await PM.generateIdentity()) };
const juma = { userId: "user_juma", ...(await PM.generateIdentity()) };
const mole = { userId: "user_mole", ...(await PM.generateIdentity()) };   // uninvited
const pub = (p) => ({ userId: p.userId, publicKey: p.publicKey });

section("1. A message to one person");
{
  const sealed = await PM.seal({
    threadId: "t-1", senderId: asha.userId,
    recipients: [pub(asha), pub(juma)],
    plaintext: "Nyumba ya Mbezi bado ipo? Naweza kuja kesho saa nne.",
  });

  ok(sealed.keys.length === 2, "one wrapped key per recipient, sender included");
  ok(sealed.keys.every((k) => k.epk === sealed.keys[0].epk),
     "one ephemeral key serves the whole message");

  const forJuma = { thread_id: "t-1", sender_id: asha.userId, iv: sealed.iv,
    ciphertext: sealed.ciphertext, ...sealed.keys.find((k) => k.user_id === juma.userId) };
  ok(await PM.open(forJuma, juma) === "Nyumba ya Mbezi bado ipo? Naweza kuja kesho saa nne.",
     "the recipient reads it back exactly");

  const forAsha = { thread_id: "t-1", sender_id: asha.userId, iv: sealed.iv,
    ciphertext: sealed.ciphertext, ...sealed.keys.find((k) => k.user_id === asha.userId) };
  ok((await PM.open(forAsha, asha)).startsWith("Nyumba ya Mbezi"),
     "the SENDER can still read their own message — their copy is a wrap like any other");

  // What the database actually holds.
  ok(!sealed.ciphertext.includes("Mbezi") && !sealed.ciphertext.includes("nyumba"),
     "the stored ciphertext carries no readable trace of the message");
  ok(!JSON.stringify(sealed).includes("saa nne"),
     "nor does anything else in the stored row");
}

section("2. The uninvited");
{
  const sealed = await PM.seal({
    threadId: "t-2", senderId: asha.userId,
    recipients: [pub(asha), pub(juma)],
    plaintext: "the rent is 250,000",
  });
  const stolen = { thread_id: "t-2", sender_id: asha.userId, iv: sealed.iv,
    ciphertext: sealed.ciphertext, ...sealed.keys.find((k) => k.user_id === juma.userId) };

  ok(await threw(() => PM.open(stolen, mole)) !== null,
     "someone who was never a recipient cannot open a stolen row, key and all");

  // The subtler attack: the eavesdropper has their OWN valid identity and
  // rewrites the row's user_id to point at Juma's wrap. The wrap is derived
  // under both names, so it still fails.
  const relabelled = { ...stolen, user_id: mole.userId };
  ok(await threw(() => PM.open(relabelled, mole)) !== null,
     "relabelling a wrap to another user does not make it open");
}

section("3. A ciphertext cannot be moved");
{
  const sealed = await PM.seal({
    threadId: "t-3", senderId: asha.userId,
    recipients: [pub(asha), pub(juma)],
    plaintext: "yes, tomorrow works",
  });
  const mine = sealed.keys.find((k) => k.user_id === juma.userId);

  const movedThread = { thread_id: "t-OTHER", sender_id: asha.userId, iv: sealed.iv,
    ciphertext: sealed.ciphertext, ...mine };
  ok(await threw(() => PM.open(movedThread, juma)) !== null,
     "replayed into a different thread, it will not decrypt (AAD binds the thread)");

  const forgedSender = { thread_id: "t-3", sender_id: mole.userId, iv: sealed.iv,
    ciphertext: sealed.ciphertext, ...mine };
  ok(await threw(() => PM.open(forgedSender, juma)) !== null,
     "re-attributed to another sender, it will not decrypt either");

  const tampered = { thread_id: "t-3", sender_id: asha.userId, iv: sealed.iv, ...mine,
    ciphertext: sealed.ciphertext.slice(0, -4) + (sealed.ciphertext.endsWith("A") ? "BBBB" : "AAAA") };
  ok(await threw(() => PM.open(tampered, juma)) !== null,
     "a single edited byte is rejected, not silently mangled (GCM is authenticated)");
}

section("4. Nothing is reused");
{
  const a = await PM.seal({ threadId: "t-4", senderId: asha.userId, recipients: [pub(juma)], plaintext: "same" });
  const b = await PM.seal({ threadId: "t-4", senderId: asha.userId, recipients: [pub(juma)], plaintext: "same" });
  ok(a.iv !== b.iv, "a fresh IV per message");
  ok(a.ciphertext !== b.ciphertext, "the same words twice produce different ciphertext");
  ok(a.keys[0].epk !== b.keys[0].epk, "a fresh ephemeral key per message");
  ok(a.keys[0].wrapped_key !== b.keys[0].wrapped_key, "and a fresh content key");
}

section("5. An encrypted national broadcast");
{
  // The load-bearing question for admin -> everyone: does the cost per extra
  // recipient stay a key wrap, or does it become another whole encryption?
  const crowd = [];
  for (let i = 0; i < 60; i++) crowd.push({ userId: "u" + i, ...(await PM.generateIdentity()) });

  const t0 = Date.now();
  const sealed = await PM.seal({
    threadId: "t-broadcast", senderId: "admin",
    recipients: crowd.map(pub),
    plaintext: "Huduma itasimama kesho kuanzia saa 2 usiku kwa matengenezo.",
  });
  const ms = Date.now() - t0;

  ok(sealed.keys.length === 60, "every recipient gets their own wrapped key");
  ok(new Set(sealed.keys.map((k) => k.epk)).size === 1,
     "the body is encrypted ONCE — the per-recipient cost is one small wrap");
  ok(new Set(sealed.keys.map((k) => k.wrapped_key)).size === 60,
     "and no two recipients share a wrap");

  const pickTwo = [crowd[0], crowd[59]];
  for (const who of pickTwo) {
    const row = { thread_id: "t-broadcast", sender_id: "admin", iv: sealed.iv,
      ciphertext: sealed.ciphertext, ...sealed.keys.find((k) => k.user_id === who.userId) };
    ok((await PM.open(row, who)).includes("matengenezo"), `${who.userId} can read the broadcast`);
  }
  console.log(`        (60 recipients sealed in ${ms} ms)`);
  ok(ms < 8000, "60 recipients seal in well under the time a person would wait", ms + " ms");
}

section("6. Safety numbers");
{
  const f1 = await PM.fingerprint(asha.publicKey);
  const f2 = await PM.fingerprint(asha.publicKey);
  ok(f1 === f2, "the same key always shows the same safety number");
  ok(f1 !== await PM.fingerprint(juma.publicKey), "a different key shows a different one");
  ok(/^(\d{5} ){5}\d{5}$/.test(f1), "thirty digits in six groups of five", f1);
  // The old number was twelve digits: 10^12 ~ 2^40. Anyone who can substitute
  // a key in the database could grind keypairs until one produced the
  // victim's number, and 2^40 hashes is hours on a GPU, not centuries.
  ok(f1.replace(/ /g, "").length === 30,
     "10^30 of them, so a colliding key cannot be ground out");
}

section("7. Losing the phone");
{
  const blob = await PM.backup(asha, "correct horse battery");
  ok(blob.startsWith("PM1."), "a backup is a single pasteable string", blob.slice(0, 12) + "…");
  ok(!blob.includes(asha.privateKey.slice(0, 24)),
     "the private key is not sitting in the backup in the clear");

  const wrong = await threw(() => PM.restore(blob, "correct horse batteryy"));
  ok(wrong !== null && /passphrase/i.test(wrong.message), "a wrong passphrase is refused, not fudged");
  ok(await threw(() => PM.restore("PM1.aa.bb.cc", "correct horse battery")) !== null,
     "so is a mangled backup string");
  ok(await threw(() => PM.backup(asha, "short")) !== null, "and a too-short passphrase is refused up front");

  const restored = await PM.restore(blob, "correct horse battery");
  ok(restored.publicKey === asha.publicKey, "the right passphrase returns the same identity");

  // The real test of a backup: can the restored identity read old mail?
  const sealed = await PM.seal({ threadId: "t-7", senderId: juma.userId,
    recipients: [pub(asha), pub(juma)], plaintext: "sent before the phone was lost" });
  const row = { thread_id: "t-7", sender_id: juma.userId, iv: sealed.iv,
    ciphertext: sealed.ciphertext, ...sealed.keys.find((k) => k.user_id === asha.userId) };
  ok(await PM.open(row, { userId: asha.userId, ...restored }) === "sent before the phone was lost",
     "and the restored identity opens mail sent to the old device");
}

section("8. The device store");
{
  PM.forget();
  ok(PM.load() === null, "no identity to start with");
  PM.save(juma);
  ok(PM.load().publicKey === juma.publicKey, "saved and loaded intact");
  PM.forget();
  ok(PM.load() === null, "forget() really removes it — clearing site data loses the history");
}

section("9. Nothing to send to");
{
  const e = await threw(() => PM.seal({ threadId: "t-9", senderId: asha.userId, recipients: [], plaintext: "hi" }));
  ok(e !== null && /recipient/i.test(e.message),
     "sending to nobody fails loudly instead of writing an unreadable row", e && e.message);

  const e2 = await threw(() => PM.seal({
    threadId: "t-9", senderId: asha.userId,
    recipients: [{ userId: "no-key-user" }], plaintext: "hi",
  }));
  ok(e2 !== null, "a recipient who has never opened P-Message is not silently dropped into the void");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
