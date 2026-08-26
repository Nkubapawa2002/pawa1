// ============================================================================
//  pm-places.js — the pins people have sent me, read from outside P-Message.
//
//  THE PROBLEM
//  Somebody standing at a gate sends a pin down an encrypted thread. The agent
//  reads it on p-message.html, and then has to put it on a listing — which is a
//  different page. Until now the crossing was manual and lossy in three ways:
//
//    * the agent taps "Save this pin" and hopes to remember it later, or
//    * the agent copies the message text and pastes it into the listing form,
//      where six decimal places get one character wrong and nobody finds out, or
//    * the agent reads the coordinates out and types them.
//
//  All three are a person retyping a number, which is exactly where a pin stops
//  being the place somebody was standing. So this file crosses the gap for
//  them: it opens the threads this device can already read, finds the pins in
//  them, and hands them over as data — coordinates untouched, and with the one
//  fact the listing form cannot reconstruct afterwards, which is WHO sent it
//  and in which conversation.
//
//  WHY IT IS SAFE TO DO THIS FROM ANOTHER PAGE
//  The messages are end-to-end encrypted and the key that opens them is in this
//  browser's localStorage (js/lib/p-crypto.js). Any page on this origin that
//  the same person is signed into can already open them; that is a property of
//  the design, not a hole this file makes. What this file is careful about is
//  the other direction: it NEVER creates anything.
//
//    * It calls PMStore.attach(), not ensureIdentity(). ensureIdentity would
//      MINT a keypair when the device has none and publish it, and that key
//      would become the account's published key — every message sent under the
//      real key on the real device would stop opening. Reading must not be able
//      to do that. attach() refuses instead, and this file reports the reason.
//    * It sends no message, marks nothing read, and writes to no table. The
//      only trace of a scan is the rows it read.
//
//  ONLY WHAT CAME IN, NEVER WHAT WENT OUT
//  A pin the agent sent themselves is not evidence of anything — it is the
//  agent's own guess, travelling in a circle. Listing it beside pins that
//  people standing at gates actually sent would make the two look alike at the
//  moment the difference matters most. So `mine` messages are dropped.
//
//  A ROOM COUNTS, AND SAYS SO
//  A pin from a direct thread carries a name from pm_keys. A pin from a room
//  carries a name its sender chose for themselves, and `fromGuest` says whether
//  that person ever proved who they are. Both are offered — a landlord's
//  caretaker posting the gate in a neighbourhood room is a perfectly ordinary
//  way for a location to arrive — but the difference is passed through rather
//  than flattened, because the form puts a name on a public listing.
//
//  Read by: js/pages/agent-houses.js. Nothing else yet, and nothing here is
//  specific to houses — a truck or a service listing can use it unchanged.
// ============================================================================
(function () {
  "use strict";

  // How far back to look. A pin is a fact about a property, so "recent" is not
  // measured in hours — but a scan is one round trip per thread, and an agent
  // with sixty conversations should not pay sixty of them to fill a list that
  // is only ever eight rows long. The newest threads are the ones a listing
  // being written right now is about.
  var THREADS = 12;
  var PER_THREAD = 60;
  var PARALLEL = 4;      // threads opened at once — a phone on 3G, not a server

  // Two pins closer together than this are the same gate. ~15 m, the same
  // figure place-book.js uses, so a place does not appear once here and twice
  // there.
  var SAME_M = 0.00015;

  var cache = null;      // the last scan, kept for the life of the page

  function near(a, b) { return Math.abs(a - b) < SAME_M; }

  /**
   * Can this device read its own threads right now, and if not, which of the
   * four reasons is it?
   *
   * Said as a reason rather than a boolean because all four are ordinary and
   * each needs a different sentence from the page: "sign in", "open P-Message
   * once on this phone", "unlock", "this browser cannot do crypto". A single
   * "unavailable" would send an agent looking for a fault that is not there.
   */
  function available() {
    if (!window.PMStore || !window.PMPlace || !window.PlaceBook) return "unavailable";
    if (!window.PMCrypto || !window.PMCrypto.available()) return "no_crypto";
    if (window.PMDeviceLock && window.PMDeviceLock.isLocked()) return "locked";
    if (!window.PMCrypto.load()) return "no_key";
    return null;
  }

  /** Run `fn` over `rows` a few at a time. */
  async function pool(rows, width, fn) {
    var out = [];
    var i = 0;
    async function worker() {
      while (i < rows.length) {
        var mine = rows[i++];
        try { out.push(await fn(mine)); } catch (_) { out.push(null); }
      }
    }
    var runners = [];
    for (var w = 0; w < Math.min(width, rows.length); w++) runners.push(worker());
    await Promise.all(runners);
    return out;
  }

  /** The name to show for a conversation: the person, or the room's title. */
  function threadName(row) {
    if (row.kind === "direct") return String(row.other_name || "").trim();
    return String(row.title || "").trim();
  }

  /**
   * Every pin sent to this device, newest first.
   *
   * Returns { ok, reason, places[] }. `reason` is set on every failure INCLUDING
   * the empty one, so a caller never has to guess whether "no places" means
   * "nobody has sent you one" or "this device cannot read your messages".
   */
  async function scan(opts) {
    var o = opts || {};
    if (cache && !o.refresh) return cache;

    var why = available();
    if (why) return (cache = { ok: false, reason: why, places: [] });

    var identity = null;
    try { identity = await window.PMStore.attach(); } catch (_) { identity = null; }
    if (!identity) return (cache = { ok: false, reason: "signed_out", places: [] });

    var threads = [];
    try {
      threads = (await window.PMStore.inbox()) || [];
    } catch (err) {
      return { ok: false, reason: "offline", places: [] };   // not cached: retry is free
    }

    // The assistant thread is local and unencrypted and has no other person in
    // it; a broadcast is something this account SENT. Neither can carry a pin
    // somebody sent to us.
    threads = threads.filter(function (r) {
      return r && r.thread_id && (r.kind === "direct" || r.kind === "group");
    }).slice(0, THREADS);

    var found = [];
    await pool(threads, PARALLEL, async function (th) {
      var rows = await window.PMStore.messages(th.thread_id, PER_THREAD);
      (rows || []).forEach(function (m) {
        if (!m || m.mine || m.failed || !m.text) return;
        var hit = window.PMPlace.read(m.text);
        if (!hit) return;
        found.push({
          lat: hit.lat,
          lng: hit.lng,
          acc: hit.acc,
          label: hit.label || "",
          outside: !!hit.outside,
          at: new Date(m.at).getTime() || Date.now(),
          msgId: m.id,
          fromId: m.senderId || "",
          fromName: String(m.senderName || "").trim(),
          fromGuest: !!m.senderGuest,
          threadId: th.thread_id,
          threadKind: th.kind,
          threadName: threadName(th),
        });
      });
    });

    found.sort(function (a, b) { return b.at - a.at; });

    // The same gate sent twice by the same person is one row, the newer one.
    // Sent by two DIFFERENT people it stays two rows: that is two people
    // saying the same thing, and collapsing it would hide the corroboration
    // and put one of the two names on a listing arbitrarily.
    var out = [];
    found.forEach(function (p) {
      var dup = out.some(function (q) {
        return q.fromId === p.fromId && near(q.lat, p.lat) && near(q.lng, p.lng);
      });
      if (!dup) out.push(p);
    });

    cache = { ok: true, reason: out.length ? null : "empty", places: out };
    return cache;
  }

  /** Whatever the last scan found, without going near the network. */
  function cached() { return cache; }

  /** Forget it — used when the page wants a fresh look after a send. */
  function drop() { cache = null; }

  window.PMPlaces = {
    available: available,
    scan: scan,
    cached: cached,
    drop: drop,
    THREADS: THREADS,
    PER_THREAD: PER_THREAD,
  };
})();
