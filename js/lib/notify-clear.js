// ============================================================================
//  notify-clear.js — "clear this, and do not show it to me again".
//
//  WHAT THIS IS FOR, AND WHY IT IS NOT A WATERMARK AND NOT A MUTE.
//
//  Clearing a notification used to mean one of two things, and neither was
//  what anybody asked for.
//
//    mark as read   moves a timestamp. The row goes, and comes straight back
//                   the moment one more thing is posted anywhere in the
//                   country. That is the right behaviour for a DOOR somebody
//                   walked through, and the wrong one for a dismissal.
//    mute the kind  switches the whole category off for good. Right for
//                   somebody who never wants to hear about trucks again;
//                   catastrophic for somebody who only wanted these four rows
//                   off their screen, which is almost everybody.
//
//  What a person means by "clear this" is neither. They mean THESE: the ones
//  in front of them, gone, and something genuinely new later is still welcome.
//  That is a statement about IDENTITY, so this file keeps identities: the ids
//  of exactly what a row was counting when it was cleared. Nothing in that
//  list is ever counted again; a room listed tomorrow is not in it, and speaks
//  up as it should.
//
//  WHY IT IS ITS OWN FILE. The same reason js/lib/notify-mute.js is: the
//  question "has this been cleared" has no network in it, and js/core/notify.js
//  is a polling engine with a cache and two realtime channels. Anything else
//  that wants the answer (a settings screen, a page that raises its own
//  banner) can have it for the cost of one script tag instead of a
//  subscription. It shares the one localStorage key the bell already uses,
//  because this is the same kind of fact about the same device and one key is
//  one thing to clear.
//
//  IT DOES NOT KNOW WHAT AN ID MEANS. A caller says what names a row, and the
//  names differ on purpose: a house is its id, a conversation is its id plus
//  the time of its last message (so clearing quietens that chat until somebody
//  says something new), a changed safety number is the peer plus the moment it
//  changed (so the same peer changing keys again next month is a new warning).
//  Those decisions live with the thing being counted, in js/core/notify.js.
// ============================================================================
(function () {
  "use strict";

  var SEEN_KEY = "pawa_notify_seen";

  // A device-local list that can only grow, so it is capped. Generous enough
  // that it never bites in practice (four hundred cleared rooms is years of
  // use) and the bell's own watermark retires most entries long before this
  // does. Newest kept: the cap must never drop what was cleared this morning
  // in favour of what was cleared last year.
  var MAX = 400;

  function read() {
    try {
      var raw = JSON.parse(localStorage.getItem(SEEN_KEY) || "null");
      if (raw && typeof raw === "object") return raw;
    } catch (_) {}
    return null;
  }

  function write(next) {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(next)); } catch (_) {}
  }

  /** Every id cleared under one key, newest first. */
  function list(key) {
    var s = read();
    var g = s && s.gone && s.gone[key];
    return Array.isArray(g) ? g : [];
  }

  /** The same, as a lookup, for filters that run over every row of a catalogue. */
  function set(key) {
    var out = Object.create(null);
    list(key).forEach(function (id) { out[id] = true; });
    return out;
  }

  /**
   * Write ids down as cleared.
   *
   * It writes into whatever object is already under the key, creating one only
   * if there is none: the bell keeps its watermarks there and notify-mute.js
   * keeps the off switches, and replacing the object wholesale would reset
   * "what have I already seen" as a side effect of clearing a row.
   */
  function remember(key, ids) {
    if (!key || !ids || !ids.length) return false;
    var s = read() || {};
    s.gone = s.gone || {};
    var have = Array.isArray(s.gone[key]) ? s.gone[key] : [];
    var seen = Object.create(null);
    var next = [];
    ids.concat(have).forEach(function (id) {
      var k = String(id == null ? "" : id);
      if (!k || seen[k]) return;
      seen[k] = true;
      next.push(k);
    });
    s.gone[key] = next.slice(0, MAX);
    write(s);
    return true;
  }

  /** Drop from `rows` whatever has been cleared, by whatever `idOf` calls it. */
  function drop(key, rows, idOf) {
    var gone = set(key);
    return (rows || []).filter(function (r) { return !gone[idOf(r)]; });
  }

  window.NotifyCleared = {
    MAX: MAX,
    list: list,
    set: set,
    remember: remember,
    drop: drop,
  };
})();
