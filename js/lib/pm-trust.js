// ============================================================================
//  pm-trust.js — what key did I see last time?
//
//  P-Message's key distribution is trust-on-first-use: public keys arrive from
//  the same database that stores the messages. That is survivable, but only if
//  first use is actually the ONLY time trust is extended. Until this file
//  existed it was not — every fetch was a first use. The server could hand you
//  the right key for a month and a substituted one on the day it mattered, and
//  nothing anywhere would have noticed.
//
//  So: the key is written down the first time it is seen, compared every time
//  after, and a change raises an alarm that BLOCKS the thread until a person
//  deals with it. Signal calls this a safety number change; it is the single
//  thing that turns "the server cannot read this passively" into "the server
//  cannot read this without me being told".
//
//  THREE RULES, each of which is the whole point of the file:
//
//   1. THE ALARM IS STICKY. "changed" is written to storage, not computed. It
//      survives a reload and cannot be cleared by fetching the key again —
//      otherwise the attacker clears it by doing nothing.
//   2. A CHANGED KEY IS NEVER SILENTLY VERIFIED. Accepting a change ("they
//      bought a new phone") returns to merely-seen, never to verified. What
//      was verified was the OLD key; nobody has checked this one.
//   3. IT LIVES ON THE DEVICE, NOT ON THE SERVER. A record of which keys you
//      have seen, held by the server, is a record the server can edit — which
//      hands it to the exact party it exists to catch. localStorage or
//      nowhere.
//
//  Records are scoped by MY OWN user id. A guest session and a signed-in
//  account in the same browser are different identities with different
//  histories, and one's decisions must never be read as the other's.
// ============================================================================

(function () {
  "use strict";

  var STORE = "pm-trust-v1";

  // seen     — recorded on first sight, not checked by a human
  // verified — compared out of band, by camera or by reading the digits
  // changed  — the key is not the one recorded. The alarm.
  var SEEN = "seen", VERIFIED = "verified", CHANGED = "changed";

  function now() { return new Date().toISOString(); }

  function all() {
    try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch (_) { return {}; }
  }
  function save(book) {
    try { localStorage.setItem(STORE, JSON.stringify(book)); return true; } catch (_) { return false; }
  }
  function get(meId, peerId) {
    if (!meId || !peerId) return null;
    var book = all();
    return (book[meId] && book[meId][peerId]) || null;
  }
  function put(meId, peerId, rec) {
    var book = all();
    if (!book[meId]) book[meId] = {};
    book[meId][peerId] = rec;
    return save(book);
  }

  /**
   * Record the key just received for someone, and say what it means.
   *
   * Returns { status, verified, changed, wasVerified, since, changedAt }.
   * status is "new" the first time, "same" when it matches what is on file,
   * and "changed" when it does not — and once it is "changed" it STAYS
   * changed, for the same key, until a person says otherwise.
   */
  function record(meId, peerId, publicKey, name) {
    if (!meId || !peerId || !publicKey) return null;
    var prev = get(meId, peerId);

    if (!prev) {
      put(meId, peerId, { key: publicKey, name: name || "", state: SEEN, firstSeen: now() });
      return { status: "new", verified: false, changed: false, since: null };
    }

    if (prev.key === publicKey) {
      // Note what is NOT here: no downgrade, no refresh of the timestamp, and
      // above all no clearing of CHANGED. A key that arrived under an alarm
      // keeps its alarm however many times it arrives again.
      if (name && name !== prev.name) { prev.name = name; put(meId, peerId, prev); }
      return {
        status: prev.state === CHANGED ? "changed" : "same",
        verified: prev.state === VERIFIED,
        changed: prev.state === CHANGED,
        wasVerified: !!prev.wasVerified,
        since: prev.verifiedAt || prev.firstSeen,
        changedAt: prev.changedAt || null,
      };
    }

    // A different key for someone we have met. Either they reinstalled, or
    // somebody is standing in the middle. This code cannot tell the two apart
    // and must not guess — it raises the alarm and lets a human decide.
    put(meId, peerId, {
      key: publicKey,
      name: name || prev.name || "",
      state: CHANGED,
      firstSeen: prev.firstSeen,
      changedAt: now(),
      previousKey: prev.key,
      wasVerified: prev.state === VERIFIED,
    });
    return {
      status: "changed", verified: false, changed: true,
      wasVerified: prev.state === VERIFIED,
      since: prev.verifiedAt || prev.firstSeen,
      changedAt: now(),
    };
  }

  /** Read the current state without recording anything. */
  function status(meId, peerId) {
    var rec = get(meId, peerId);
    if (!rec) return { status: "unknown", verified: false, changed: false };
    return {
      status: rec.state, verified: rec.state === VERIFIED, changed: rec.state === CHANGED,
      wasVerified: !!rec.wasVerified, key: rec.key,
      since: rec.verifiedAt || rec.firstSeen, changedAt: rec.changedAt || null,
    };
  }

  /**
   * Two people compared the number and it matched. Only ever called with the
   * key that was actually on screen while they compared, so a race that
   * swapped it underneath cannot end in a verified record.
   */
  function markVerified(meId, peerId, publicKey, name) {
    if (!meId || !peerId || !publicKey) return false;
    var prev = get(meId, peerId) || {};
    return put(meId, peerId, {
      key: publicKey,
      name: name || prev.name || "",
      state: VERIFIED,
      firstSeen: prev.firstSeen || now(),
      verifiedAt: now(),
      previousKey: prev.previousKey || null,
      wasVerified: !!prev.wasVerified,
    });
  }

  /**
   * "It is fine, they got a new phone." Clears the alarm — and deliberately
   * lands on SEEN, not VERIFIED. What was verified was the key that is now
   * gone; this one has been checked by nobody.
   */
  function accept(meId, peerId) {
    var prev = get(meId, peerId);
    if (!prev) return false;
    return put(meId, peerId, {
      key: prev.key, name: prev.name, state: SEEN,
      firstSeen: prev.firstSeen, acceptedAt: now(),
      previousKey: prev.previousKey || null,
      wasVerified: false,
    });
  }

  function forget(meId, peerId) {
    var book = all();
    if (book[meId]) { delete book[meId][peerId]; save(book); }
    return true;
  }

  /** Everyone on file for this identity, newest alarm first. */
  function list(meId) {
    var book = all()[meId] || {};
    return Object.keys(book).map(function (id) {
      var r = book[id];
      return { userId: id, name: r.name, state: r.state, key: r.key,
               since: r.verifiedAt || r.firstSeen, changedAt: r.changedAt || null };
    }).sort(function (a, b) {
      if ((a.state === CHANGED) !== (b.state === CHANGED)) return a.state === CHANGED ? -1 : 1;
      return String(b.since || "").localeCompare(String(a.since || ""));
    });
  }

  /** Dropped wholesale when an identity is abandoned — see PMCrypto.forget(). */
  function forgetAll(meId) {
    var book = all();
    if (meId) { delete book[meId]; } else { book = {}; }
    return save(book);
  }

  window.PMTrust = {
    record: record, status: status, markVerified: markVerified,
    accept: accept, forget: forget, forgetAll: forgetAll, list: list,
    SEEN: SEEN, VERIFIED: VERIFIED, CHANGED: CHANGED,
  };
})();
