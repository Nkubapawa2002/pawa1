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
//
//  AND IT NOW OUTLIVES THE DEVICE IT WAS CLEARED ON.
//  Everything above was right and it was all kept in localStorage, which is one
//  browser profile on one device. That is why "the notifications still show
//  things I already saw" was a real report about a feature that worked: clear
//  on the laptop, open the phone, and every row is new again. Reinstalling the
//  app, clearing site data, or the OS reclaiming storage did the same thing.
//
//  So there are two stores now and the rule between them is simple: THE UNION,
//  AND LOCAL FIRST.
//
//    · localStorage stays the one the filters read. It is synchronous and it
//      works offline, and the bell filters a whole catalogue on every poll, so
//      a round trip in that path would be slower for a fact that hardly ever
//      differs.
//    · public.notify_cleared is the durable copy. sync() merges it in once per
//      page and remember() writes through to it.
//
//  They can never CONFLICT, only lag: there is no un-clear anywhere in the UI,
//  so both lists only grow and the union is always the right answer. That is
//  what makes a merge safe with no version, no clock and no resolution rule.
//
//  EVERY NETWORK PATH HERE IS OPTIONAL. Signed out, offline, RPC missing, the
//  table not yet applied: all of them leave the old localStorage behaviour
//  exactly as it was. Clearing a notification must never fail because of the
//  network, and a dismissal that did not reach the server is one this device
//  still honours.
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
    var wrote = rememberLocal(key, ids);
    // Write-through, after the local write and never instead of it. See push().
    if (wrote) push(key, ids);
    return wrote;
  }

  /** The local half on its own, which is also what sync() merges into. */
  function rememberLocal(key, ids) {
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

  // ---- the durable half ----------------------------------------------------

  // window.SB first, then DataStore.sb. Both are the CLIENT OBJECT, not a
  // getter: js/core/data.js assigns window.SB at create time and exports the
  // same reference as DataStore.sb. Calling it was a real bug -- "sb is not a
  // function" -- caught by tests/notify_test.mjs. Same accessor as
  // js/pages/admin-owners.js, deliberately.
  function client() {
    return window.SB || (window.DataStore && window.DataStore.sb) || null;
  }

  /**
   * Write a batch through to the server. Fire and forget, on purpose.
   *
   * remember() must stay synchronous and must always succeed: the row has
   * already gone from the screen by the time this runs, and a dismissal that
   * could fail would be a dismissal that sometimes bounces back. If this call
   * never lands, the clear is still honoured on this device forever; it just
   * does not travel, which is precisely the old behaviour.
   */
  function push(key, ids) {
    var c = client();
    if (!c || !ids || !ids.length) return;
    try {
      var p = c.rpc("notify_clear_remember", { p_kind: key, p_items: ids });
      if (p && p.then) p.then(function () {}, function () {});
    } catch (_) { /* never fatal */ }
  }

  var synced = false;

  /**
   * Merge what the ACCOUNT has cleared into what this DEVICE has cleared.
   *
   * A union, never a replacement. A device that has been offline for a week
   * holds dismissals the server has not heard of, and overwriting the local
   * list with the server's would resurrect every one of them: the exact bug
   * this whole file exists to prevent, reintroduced by the fix for it.
   *
   * Once per page. Resolves either way, including when there is no session and
   * no network, so a caller can always await it before the first draw.
   */
  function sync() {
    if (synced) return Promise.resolve(false);
    synced = true;
    var c = client();
    if (!c) return Promise.resolve(false);
    var call;
    try { call = c.rpc("notify_cleared_mine", { p_limit: MAX }); }
    catch (_) { return Promise.resolve(false); }
    if (!call || !call.then) return Promise.resolve(false);
    return call.then(function (res) {
      if (res.error || !res.data || !res.data.length) return false;
      var byKind = Object.create(null);
      res.data.forEach(function (r) {
        var k = r && r.kind;
        if (!k) return;
        (byKind[k] = byKind[k] || []).push(String(r.item_id));
      });
      var touched = false;
      // remember() already unions with what is there and keeps newest-first,
      // so this is one call per kind and no second merge routine.
      Object.keys(byKind).forEach(function (k) {
        if (rememberLocal(k, byKind[k])) touched = true;
      });
      return touched;
    }).catch(function () { return false; });
  }

  window.NotifyCleared = {
    MAX: MAX,
    list: list,
    set: set,
    remember: remember,
    drop: drop,
    sync: sync,
    // Tests drive these directly rather than standing up a fake bell.
    _rememberLocal: rememberLocal,
    _reset: function () { synced = false; },
  };
})();
