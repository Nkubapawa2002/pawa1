/**
 * pm-hidden.js — "delete this message" on one phone, and nowhere else.
 *
 * WHAT THIS IS
 * A list of message ids this device has been told to stop drawing. That is
 * all it is, and the wording everywhere in the UI has to keep saying so.
 *
 * WHY IT IS NOT A DELETE
 * P-Message encrypts a body once and wraps the key for each recipient
 * (docs/P_MESSAGE.md). The recipient's copy is on the recipient's phone,
 * decrypted with a key this device has never held and cannot reach. There is
 * no request this app could send that would take it back, and there is no
 * server permission that would help: a "delete for everyone" would be a
 * message asking the other phone to please forget, which a modified client
 * ignores. Every chat app that offers one has that same hole; the difference
 * is that most of them do not say so.
 *
 * So this feature promises exactly what it can do. It hides the message here.
 * The copy on the other phone is theirs, and the screen says that in words
 * before anything is hidden, not in small print afterwards.
 *
 * WHY IT IS REVERSIBLE
 * Nothing is destroyed, so hiding is undoable and the conversation says how
 * many are hidden. An irreversible local delete would be the one shape of
 * this feature that could lose something: the message is still on the server
 * either way, so "gone forever from this device" would be a cost with no
 * matching benefit.
 *
 * SCOPE
 * Records are kept per SIGNED-IN USER, like js/lib/pm-trust.js does with its
 * pins. Two accounts on one browser must not inherit each other's hidden
 * lists: they are different people, and one of them hiding a message is not
 * a statement about what the other should see.
 *
 * STORAGE
 * localStorage, one key, a plain object. The ids are already opaque uuids and
 * carry no words, so there is nothing here worth encrypting that is not
 * already encrypted at rest by the browser profile itself.
 */
(function () {
  "use strict";

  var KEY = "pm-hidden-v1";
  // A phone that has hidden two thousand messages has a different problem
  // from the one this file solves, and an unbounded list in localStorage is
  // how a page stops loading one day with no explanation. Oldest go first.
  var MAX_PER_USER = 2000;

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      var obj = raw ? JSON.parse(raw) : null;
      return (obj && typeof obj === "object") ? obj : {};
    } catch (_) {
      // A corrupt or unavailable store is not a reason to break the
      // conversation. It means nothing is hidden, which is the safe direction:
      // showing a message somebody hid is recoverable, hiding one they did not
      // is not visible to them at all.
      return {};
    }
  }

  function save(all) {
    try { localStorage.setItem(KEY, JSON.stringify(all)); return true; }
    catch (_) { return false; }
  }

  function bucket(all, me) {
    var id = String(me || "anon");
    if (!all[id] || typeof all[id] !== "object") all[id] = {};
    return all[id];
  }

  /** Every id this user has hidden, as a plain object of id -> when. */
  function map(me) {
    return bucket(load(), me);
  }

  function isHidden(me, msgId) {
    if (!msgId) return false;
    return Object.prototype.hasOwnProperty.call(map(me), String(msgId));
  }

  /**
   * Stop drawing one message on this device.
   *
   * Returns false when the store refused the write, so the caller can say
   * "it did not stick" rather than redrawing a message the person just
   * watched disappear.
   */
  function hide(me, msgId) {
    if (!msgId) return false;
    var all = load();
    var mine = bucket(all, me);
    mine[String(msgId)] = Date.now();

    var ids = Object.keys(mine);
    if (ids.length > MAX_PER_USER) {
      ids.sort(function (a, b) { return (mine[a] || 0) - (mine[b] || 0); });
      ids.slice(0, ids.length - MAX_PER_USER).forEach(function (old) { delete mine[old]; });
    }
    return save(all);
  }

  function show(me, msgId) {
    if (!msgId) return false;
    var all = load();
    var mine = bucket(all, me);
    if (!Object.prototype.hasOwnProperty.call(mine, String(msgId))) return true;
    delete mine[String(msgId)];
    return save(all);
  }

  /**
   * Split a page of decrypted rows into what to draw and what to count.
   *
   * Done here rather than in the page so that "hidden" means one thing: the
   * log, the inbox preview and anything that comes later all ask the same
   * function instead of each reimplementing the test.
   */
  function partition(me, rows) {
    var mine = map(me);
    var kept = [], hiddenIds = [];
    (rows || []).forEach(function (r) {
      if (r && r.id && Object.prototype.hasOwnProperty.call(mine, String(r.id))) hiddenIds.push(r.id);
      else kept.push(r);
    });
    return { rows: kept, hidden: hiddenIds };
  }

  /** Put back everything hidden out of this particular page of rows. */
  function showAll(me, ids) {
    var all = load();
    var mine = bucket(all, me);
    (ids || []).forEach(function (id) { delete mine[String(id)]; });
    return save(all);
  }

  window.PMHidden = {
    isHidden: isHidden,
    hide: hide,
    show: show,
    showAll: showAll,
    partition: partition,
    map: map,
    STORAGE_KEY: KEY,
  };
})();
