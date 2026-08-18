// ============================================================================
//  p-crypto.js — the encryption behind P-Message.
//
//  WHAT IS PROMISED, EXACTLY
//  The server stores ciphertext, an IV, and one wrapped key per recipient. It
//  never sees a message body, and it never holds a private key. Anyone with
//  the database — us included — sees who talked to whom and when, and nothing
//  of what was said.
//
//  WHAT IS NOT PROMISED, AND MUST NOT BE CLAIMED
//   · Metadata is in the clear: thread membership, timestamps, message sizes.
//   · Key distribution is trust-on-first-use. Public keys are served by the
//     same database that stores the messages, so an attacker who controls it
//     could hand you a key of their own. That is what fingerprint() is for:
//     two people comparing the same 12 digits out of band (aloud, in person)
//     detect the substitution. Until they do, the guarantee is "the server
//     cannot read this passively", not "the server cannot ever read this".
//   · The private key lives in this browser. Clear the site data and the old
//     messages are unreadable — by design, and worth saying out loud in the
//     UI rather than discovering after the fact. backup()/restore() exist so
//     that is a choice rather than an accident.
//   · The AI assistant thread is NOT end-to-end encrypted and never can be:
//     a model that answers you has to read you. P-Message keeps it visibly
//     separate for that reason.
//
//  THE SCHEME (all WebCrypto primitives, no dependencies, no build step)
//    identity      ECDH P-256 keypair, generated on this device
//    per message   random AES-256-GCM content key, random 96-bit IV
//    body          AES-GCM(content key, plaintext), AAD = thread id + sender
//    key wrapping  one ephemeral ECDH keypair per message; for each recipient
//                  ECDH(ephemeral priv, their pub) -> HKDF-SHA256 -> AES-KW-ish
//                  AES-GCM wrap of the content key
//    backup        PBKDF2-SHA256(210k) of a passphrase -> AES-GCM over PKCS8
//
//  One ephemeral keypair per message, one wrap per recipient: sending to 900
//  people costs 900 wraps and ONE body encryption. That is what makes an
//  encrypted national broadcast affordable.
//
//  AAD binds a ciphertext to its thread and sender, so a stored row cannot be
//  replayed into a different conversation and still decrypt.
//
//  Everything here is pure: no network, no DOM, no storage beyond the two
//  explicit load/save helpers. tests/p_crypto_test.mjs drives it under Node.
// ============================================================================

(function () {
  "use strict";

  var STORE_KEY = "pm-identity-v1";     // localStorage: this device's keypair
  var CURVE = "P-256";
  var KDF_INFO = "pawa-p-message-v1";
  var PBKDF2_ROUNDS = 210000;

  // Node's webcrypto and the browser's differ only in where they hang.
  var g = typeof globalThis !== "undefined" ? globalThis : window;
  function subtle() {
    var c = g.crypto || (g.msCrypto);
    if (!c || !c.subtle) {
      throw new Error("Encryption needs a secure page (https:// or localhost).");
    }
    return c.subtle;
  }
  function randomBytes(n) {
    var b = new Uint8Array(n);
    (g.crypto || {}).getRandomValues(b);
    return b;
  }

  // ---- base64url ------------------------------------------------------------
  // Chosen over plain base64 because these strings travel in JSON, in URLs and
  // in Postgres text columns; "+/=" survives none of those cleanly.
  function b64u(buf) {
    var bytes = new Uint8Array(buf), s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    var b64 = (g.btoa ? g.btoa(s) : Buffer.from(bytes).toString("base64"));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unb64u(str) {
    var b64 = String(str).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    var bin = g.atob ? g.atob(b64) : Buffer.from(b64, "base64").toString("binary");
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function utf8(s) { return new TextEncoder().encode(String(s)); }
  function fromUtf8(buf) { return new TextDecoder().decode(buf); }
  function concat(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }

  // ---- identity -------------------------------------------------------------
  async function generateIdentity() {
    var pair = await subtle().generateKey(
      { name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"]);
    var pub = await subtle().exportKey("spki", pair.publicKey);
    var priv = await subtle().exportKey("pkcs8", pair.privateKey);
    return { publicKey: b64u(pub), privateKey: b64u(priv) };
  }

  async function importPublic(b64) {
    return subtle().importKey("spki", unb64u(b64), { name: "ECDH", namedCurve: CURVE }, true, []);
  }
  async function importPrivate(b64) {
    return subtle().importKey("pkcs8", unb64u(b64), { name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"]);
  }

  /**
   * The safety number two people read to each other.
   *
   * Twelve digits in groups of four: long enough that guessing one is hopeless
   * (10^12), short enough to say over a phone call — which is the whole point,
   * since the comparison has to happen somewhere the server cannot reach.
   */
  async function fingerprint(publicKeyB64) {
    var hash = await subtle().digest("SHA-256", unb64u(publicKeyB64));
    var b = new Uint8Array(hash), digits = "";
    for (var i = 0; i < 6; i++) {
      digits += String(((b[i * 2] << 8) | b[i * 2 + 1]) % 100).padStart(2, "0");
    }
    return digits.replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3");
  }

  // ---- key agreement --------------------------------------------------------
  // ECDH gives a shared secret; HKDF turns it into a key. Skipping the HKDF and
  // using the raw X coordinate as a key is the classic mistake here — it is not
  // uniformly distributed, and it would be identical for every message between
  // the same two people.
  async function wrapKeyFor(theirPublicB64, ephemeralPriv, contentKeyRaw, info) {
    var theirPub = await importPublic(theirPublicB64);
    var shared = await subtle().deriveBits(
      { name: "ECDH", public: theirPub }, ephemeralPriv, 256);
    var hkdfKey = await subtle().importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    var aes = await subtle().deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(info) },
      hkdfKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    var iv = randomBytes(12);
    var wrapped = await subtle().encrypt({ name: "AES-GCM", iv: iv }, aes, contentKeyRaw);
    return b64u(concat(iv, new Uint8Array(wrapped)));
  }

  async function unwrapKey(epkB64, myPrivateB64, wrappedB64, info) {
    var epk = await importPublic(epkB64);
    var mine = await importPrivate(myPrivateB64);
    var shared = await subtle().deriveBits({ name: "ECDH", public: epk }, mine, 256);
    var hkdfKey = await subtle().importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    var aes = await subtle().deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(info) },
      hkdfKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    var all = unb64u(wrappedB64);
    var raw = await subtle().decrypt(
      { name: "AES-GCM", iv: all.slice(0, 12) }, aes, all.slice(12));
    return new Uint8Array(raw);
  }

  // The label every wrap is derived under. Naming the pair inside the KDF means
  // a wrap made for one recipient cannot be replayed at another, even by
  // someone who can rewrite the row it sits in.
  function wrapInfo(senderId, recipientId) {
    return KDF_INFO + "|wrap|" + senderId + "|" + recipientId;
  }
  // The body's AAD. Not secret — authenticated. Moving a ciphertext to another
  // thread, or relabelling its sender, breaks decryption instead of silently
  // succeeding.
  function bodyAad(threadId, senderId) {
    return utf8(KDF_INFO + "|body|" + threadId + "|" + senderId);
  }

  /**
   * Encrypt one message for many recipients.
   *
   * `recipients` is [{ userId, publicKey }] — the sender MUST be in the list to
   * be able to read their own message back (their own copy is just another
   * wrap; there is no separate "sent" store).
   */
  async function seal(opts) {
    var threadId = opts.threadId, senderId = opts.senderId;
    var recipients = opts.recipients || [];
    if (!recipients.length) throw new Error("No recipients with a published key.");

    var contentKeyRaw = randomBytes(32);
    var contentKey = await subtle().importKey(
      "raw", contentKeyRaw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    var iv = randomBytes(12);
    var body = await subtle().encrypt(
      { name: "AES-GCM", iv: iv, additionalData: bodyAad(threadId, senderId) },
      contentKey, utf8(opts.plaintext));

    // ONE ephemeral keypair for the whole message: the per-recipient cost is a
    // single ECDH + HKDF, which is what keeps a national broadcast tractable.
    var eph = await subtle().generateKey({ name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"]);
    var epk = b64u(await subtle().exportKey("spki", eph.publicKey));

    var keys = [];
    for (var i = 0; i < recipients.length; i++) {
      var r = recipients[i];
      if (!r || !r.publicKey || !r.userId) continue;
      keys.push({
        user_id: r.userId,
        epk: epk,
        wrapped_key: await wrapKeyFor(r.publicKey, eph.privateKey, contentKeyRaw, wrapInfo(senderId, r.userId)),
      });
    }
    if (!keys.length) throw new Error("No recipients with a published key.");

    return { alg: "ECDH-P256+A256GCM", iv: b64u(iv), ciphertext: b64u(body), keys: keys };
  }

  /**
   * Decrypt a message addressed to me.
   *
   * `row` is the stored message joined to MY wrapped key:
   *   { thread_id, sender_id, iv, ciphertext, epk, wrapped_key }
   */
  async function open(row, me) {
    var contentKeyRaw = await unwrapKey(
      row.epk, me.privateKey, row.wrapped_key, wrapInfo(row.sender_id, me.userId));
    var contentKey = await subtle().importKey(
      "raw", contentKeyRaw, { name: "AES-GCM" }, false, ["decrypt"]);
    var plain = await subtle().decrypt(
      { name: "AES-GCM", iv: unb64u(row.iv), additionalData: bodyAad(row.thread_id, row.sender_id) },
      contentKey, unb64u(row.ciphertext));
    return fromUtf8(plain);
  }

  // ---- passphrase backup ----------------------------------------------------
  // The device key is the whole account. Without this, a lost phone is a lost
  // history and there is nothing anyone can do about it — so the escape hatch
  // is offered up front rather than after the loss.
  async function backup(identity, passphrase) {
    if (!passphrase || String(passphrase).length < 8) {
      throw new Error("Choose a passphrase of at least 8 characters.");
    }
    var salt = randomBytes(16);
    var base = await subtle().importKey("raw", utf8(passphrase), "PBKDF2", false, ["deriveKey"]);
    var key = await subtle().deriveKey(
      { name: "PBKDF2", salt: salt, iterations: PBKDF2_ROUNDS, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    var iv = randomBytes(12);
    var sealed = await subtle().encrypt({ name: "AES-GCM", iv: iv }, key,
      utf8(JSON.stringify({ publicKey: identity.publicKey, privateKey: identity.privateKey })));
    return "PM1." + b64u(salt) + "." + b64u(iv) + "." + b64u(sealed);
  }

  async function restore(blob, passphrase) {
    var parts = String(blob || "").trim().split(".");
    if (parts.length !== 4 || parts[0] !== "PM1") throw new Error("That is not a P-Message backup code.");
    var base = await subtle().importKey("raw", utf8(passphrase), "PBKDF2", false, ["deriveKey"]);
    var key = await subtle().deriveKey(
      { name: "PBKDF2", salt: unb64u(parts[1]), iterations: PBKDF2_ROUNDS, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    var plain;
    try {
      plain = await subtle().decrypt({ name: "AES-GCM", iv: unb64u(parts[2]) }, key, unb64u(parts[3]));
    } catch (_) {
      throw new Error("Wrong passphrase.");
    }
    var id = JSON.parse(fromUtf8(plain));
    if (!id.publicKey || !id.privateKey) throw new Error("That backup is incomplete.");
    return id;
  }

  // ---- device storage -------------------------------------------------------
  // localStorage, deliberately: sessionStorage would throw the key away on
  // every tab close, and IndexedDB buys nothing here — neither is protected
  // from a script running on this origin, so the honest line is "this device".
  function load() {
    try {
      var raw = g.localStorage && g.localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var id = JSON.parse(raw);
      return (id && id.publicKey && id.privateKey) ? id : null;
    } catch (_) { return null; }
  }
  function save(identity) {
    try { g.localStorage.setItem(STORE_KEY, JSON.stringify(identity)); return true; }
    catch (_) { return false; }
  }
  function forget() {
    try { g.localStorage.removeItem(STORE_KEY); } catch (_) {}
  }

  function available() {
    try { return !!subtle(); } catch (_) { return false; }
  }

  g.PMCrypto = {
    available: available,
    generateIdentity: generateIdentity,
    fingerprint: fingerprint,
    seal: seal,
    open: open,
    backup: backup,
    restore: restore,
    load: load,
    save: save,
    forget: forget,
    STORE_KEY: STORE_KEY,
  };
})();
