// ============================================================================
//  pm-device-lock.js — keep the private key in the phone's secure hardware
//  instead of in localStorage.
//
//  WHAT IS ACTUALLY WRONG WITHOUT IT
//  The identity private key sits in localStorage as base64. Anything that runs
//  JavaScript on this origin can read it, and so can anyone holding the phone
//  unlocked. The messages are encrypted at rest on the server and not at rest
//  on the device, which is the wrong way round for a phone that gets lost,
//  borrowed, or repaired.
//
//  HOW IT WORKS
//  WebAuthn's PRF extension turns a passkey into a key-derivation oracle: give
//  the authenticator a salt and it returns 32 bytes derived from a secret held
//  in hardware it will not export. Those bytes become an AES-GCM key, and the
//  private key is stored wrapped under it. Getting them back needs a user
//  gesture and the device's own biometric check, which is exactly the gate we
//  want and cannot build in JavaScript.
//
//  THREE THINGS THIS DELIBERATELY DOES NOT DO
//
//   1. IT NEVER TURNS ITSELF ON. PRF is missing on plenty of real phones and a
//      security feature that silently fails half the time is worse than one
//      people choose. supported() is a real check, not a version sniff, and
//      everything stays as it was when the answer is no.
//   2. IT KEEPS NO PLAINTEXT FALLBACK. A second copy of the key next to the
//      wrapped one would make this decoration. When the lock is on, the
//      wrapped blob is the only copy on the device.
//   3. IT REFUSES TO ENROL WITHOUT A BACKUP. Which follows from (2): if the
//      passkey is deleted — phone reset, passkeys cleared — the key is gone
//      and every message with it. The caller must pass proof that a backup
//      code was made in this session. That is not paternalism; it is the
//      difference between a security feature and a data-loss bug.
//
//  The unwrapped key lives in memory for the session only (PMCrypto's
//  useForSession), so a reload asks again.
// ============================================================================

(function () {
  "use strict";

  var STORE = "pm-device-lock-v1";
  var INFO = "pm-device-lock-v1";
  var RP_NAME = "Maisha na Lifeza";
  var CRED_NAME = "P-Message key";

  function subtle() {
    var c = window.crypto;
    if (!c || !c.subtle) throw new Error("NO_CRYPTO");
    return c.subtle;
  }
  function randomBytes(n) {
    var b = new Uint8Array(n);
    window.crypto.getRandomValues(b);
    return b;
  }
  function b64u(buf) {
    var bytes = new Uint8Array(buf), s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unb64u(str) {
    var s = String(str).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function utf8(s) { return new TextEncoder().encode(String(s)); }
  function fromUtf8(b) { return new TextDecoder().decode(b); }

  function blob() {
    try {
      var raw = localStorage.getItem(STORE);
      if (!raw) return null;
      var v = JSON.parse(raw);
      return (v && v.credentialId && v.wrapped && v.iv && v.salt) ? v : null;
    } catch (_) { return null; }
  }

  /** WebAuthn at all. Whether the authenticator does PRF is only knowable by asking. */
  function available() {
    return typeof window.PublicKeyCredential === "function" &&
      !!(navigator.credentials && navigator.credentials.create);
  }

  /** Is there a platform authenticator (a fingerprint, a face, a PIN) here? */
  async function supported() {
    if (!available()) return false;
    try {
      return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (_) { return false; }
  }

  function isEnrolled() { return !!blob(); }

  /**
   * Enrolled, and not yet opened in this session.
   *
   * pm-store checks this BEFORE deciding it has no identity — without that,
   * a locked device looks like a brand-new one and would quietly mint a
   * second keypair, orphaning every message ever received.
   */
  function isLocked() {
    if (!isEnrolled()) return false;
    return !(window.PMCrypto && window.PMCrypto.load());
  }

  /** The public half is public; it is readable without any prompt at all. */
  function publicKey() {
    var v = blob();
    return v ? v.publicKey : null;
  }

  async function wrapKeyFrom(prfBytes) {
    var base = await subtle().importKey("raw", prfBytes, "HKDF", false, ["deriveKey"]);
    return subtle().deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(INFO) },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  function prfResult(assertion) {
    var ext = assertion.getClientExtensionResults();
    var r = ext && ext.prf && ext.prf.results && ext.prf.results.first;
    return r ? new Uint8Array(r) : null;
  }

  /**
   * Ask the authenticator for the PRF bytes.
   *
   * Deliberately a separate assertion rather than reading them off the
   * registration: several browsers report only `prf.enabled` at create time
   * and hand over results on a later get(). Always taking the second step
   * means one code path rather than two, and the second step is the one that
   * has to work anyway.
   */
  async function evaluatePrf(credentialId, salt) {
    var assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: credentialId
          ? [{ id: unb64u(credentialId), type: "public-key" }] : [],
        userVerification: "required",
        timeout: 60000,
        extensions: { prf: { eval: { first: salt } } },
      },
    });
    var bytes = prfResult(assertion);
    if (!bytes) throw new Error("NO_PRF");
    return bytes;
  }

  /**
   * Put the identity behind the device's own check.
   *
   * @param {{publicKey: string, privateKey: string}} identity
   * @param {{userId: string, label?: string, backupSaved: boolean}} opts
   */
  async function enroll(identity, opts) {
    opts = opts || {};
    if (!identity || !identity.privateKey) throw new Error("NO_IDENTITY");
    if (!opts.backupSaved) throw new Error("NO_BACKUP");
    if (!available()) throw new Error("UNSUPPORTED");

    var userId = utf8(String(opts.userId || "pm-user"));
    var cred = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { name: RP_NAME },
        user: { id: userId, name: opts.label || CRED_NAME, displayName: opts.label || CRED_NAME },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          residentKey: "required",
          userVerification: "required",
        },
        timeout: 60000,
        extensions: { prf: {} },
      },
    });
    if (!cred) throw new Error("CANCELLED");

    var ext = cred.getClientExtensionResults();
    if (!(ext && ext.prf && ext.prf.enabled)) throw new Error("NO_PRF");

    var credentialId = b64u(cred.rawId);
    var salt = randomBytes(32);
    var prf = await evaluatePrf(credentialId, salt);
    var key = await wrapKeyFrom(prf);
    var iv = randomBytes(12);
    var sealed = await subtle().encrypt({ name: "AES-GCM", iv: iv }, key,
      utf8(JSON.stringify({ publicKey: identity.publicKey, privateKey: identity.privateKey })));

    localStorage.setItem(STORE, JSON.stringify({
      v: 1,
      credentialId: credentialId,
      salt: b64u(salt),
      iv: b64u(iv),
      wrapped: b64u(sealed),
      publicKey: identity.publicKey,
    }));

    // The plaintext copy goes only once the wrapped one is written and
    // readable — in that order, so a failure anywhere above leaves the device
    // exactly as it was rather than with no key at all.
    await unwrap(blob());
    window.PMCrypto.forget();
    window.PMCrypto.useForSession(identity);
    return true;
  }

  async function unwrap(v) {
    var prf = await evaluatePrf(v.credentialId, unb64u(v.salt));
    var key = await wrapKeyFrom(prf);
    var plain;
    try {
      plain = await subtle().decrypt({ name: "AES-GCM", iv: unb64u(v.iv) }, key, unb64u(v.wrapped));
    } catch (_) {
      // The authenticator answered, but with different bytes: a different
      // passkey, or one that was reset. Not a wrong password — nothing the
      // person can retype their way out of.
      throw new Error("WRONG_KEY");
    }
    var id = JSON.parse(fromUtf8(plain));
    if (!id.publicKey || !id.privateKey) throw new Error("CORRUPT");
    return id;
  }

  /** Prompt, unwrap, and hand the identity to this session only. */
  async function unlock() {
    var v = blob();
    if (!v) throw new Error("NOT_ENROLLED");
    var id = await unwrap(v);
    window.PMCrypto.useForSession(id);
    return id;
  }

  /**
   * Back to plain storage. Requires the key to be open already, because the
   * alternative — dropping the wrapped blob without having recovered what is
   * inside it — is just deleting someone's identity.
   */
  async function disable() {
    var id = window.PMCrypto && window.PMCrypto.load();
    if (!id) throw new Error("LOCKED");
    window.PMCrypto.save(id);
    localStorage.removeItem(STORE);
    return true;
  }

  /** Used when the whole identity is being abandoned, not merely unlocked. */
  function forget() {
    try { localStorage.removeItem(STORE); } catch (_) {}
  }

  window.PMDeviceLock = {
    available: available,
    supported: supported,
    isEnrolled: isEnrolled,
    isLocked: isLocked,
    publicKey: publicKey,
    enroll: enroll,
    unlock: unlock,
    disable: disable,
    forget: forget,
    STORE_KEY: STORE,
  };
})();
