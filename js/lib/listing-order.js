// ============================================================================
//  listing-order.js — window.ListingOrder
//
//  "No owner is buried forever."
//
//  THE PROBLEM
//  Every catalogue in this app orders by relevance, then by newest. Both are
//  right for the person searching and both are permanent for the person
//  listing: a room posted on Tuesday sits under every room posted since, and
//  it will still be under them on Friday. An owner whose listing never reached
//  the first screen never finds out why, and the honest answer is that nothing
//  was ever going to put it there.
//
//  WHY PLAIN "OLDEST FIRST" IS NOT THE FIX
//  It is the same unfairness with the sign flipped. It buries every new
//  listing instead of every old one, and it shows the stalest thing in the
//  catalogue to the person least likely to want it. Both orders have a
//  permanent bottom; that is the defect, not which end it is at.
//
//  THE FIX IS A QUEUE THAT MOVES
//  Listings are put in first-in-first-out order — the one that has waited
//  longest is at the head — and then the HEAD ADVANCES with the clock. At the
//  first turn the longest-waiting listing leads; at the next, the one behind
//  it does, and the one that just led goes to the back.
//
//      queue:   A B C D E        (A waited longest)
//      turn 0:  A B C D E
//      turn 1:  B C D E A
//      turn 2:  C D E A B
//
//  Over one full cycle every listing occupies every position exactly once. It
//  is first-in-first-out, it has no permanent bottom, and it needs no record
//  of who has already been seen — which matters, because the alternative is
//  counting impressions, and counting impressions means recording who looked
//  at what. This app has declined that trade before (see the note on outcome
//  data in js/lib/pm-match.js) and declines it here.
//
//  THREE PROPERTIES WORTH KNOWING BEFORE CHANGING ANY OF IT
//
//   1. IT IS THE SAME FOR EVERYONE IN THE SAME TURN. The rotation comes from
//      the clock, not from the viewer, so an owner who checks during their
//      turn actually sees their listing at the top. An order personalised per
//      device would make the promise unverifiable, which is the same as not
//      making it.
//
//   2. IT IS STABLE WHILE SOMEBODY IS LOOKING. `turnAt` is captured ONCE per
//      page load and passed in. Reading the clock inside the comparator would
//      reshuffle the list under a reader's finger at the turn boundary, which
//      is the one thing worse than a bad order.
//
//   3. IT NEVER OUTRANKS RELEVANCE. This orders a set that has already been
//      matched and filtered. Rotating a listing to the top of a search it does
//      not answer is not fairness to the owner, it is a worse search for
//      everybody, and it is the fastest way to have the whole idea removed.
//
//  Pure functions, no DOM, no network, no storage, so tests/listing_order_test.mjs
//  can drive the arithmetic directly.
// ============================================================================
(function () {
  "use strict";

  // How long one turn lasts. An hour is long enough that a person browsing
  // sees a settled list and short enough that a catalogue of a few dozen gets
  // right round inside a day or two.
  var TURN_MS = 60 * 60 * 1000;

  /** Which turn a moment falls in. Captured once per page load by the caller. */
  function turnAt(now) {
    var t = Number(now);
    if (!isFinite(t)) t = Date.now();
    return Math.floor(t / TURN_MS);
  }

  // Listings arrive from four tables that spell the same field two ways.
  function postedAt(row) {
    var v = row && (row.created_at || row.createdAt || row.posted_at);
    var n = v ? Date.parse(v) : NaN;
    return isFinite(n) ? n : 0;
  }

  function idOf(row) { return String((row && row.id) != null ? row.id : ""); }

  /**
   * First in, first out, with the head of the queue advancing every turn.
   *
   * Returns a NEW array. Nothing here mutates its input, which matters because
   * every caller in this repo sorts a live `visible` array in place and two of
   * them do it twice in one pass.
   *
   * @param {Array}  rows
   * @param {object} [opts]
   * @param {number}  opts.turn  the turn number, from turnAt(). Defaults to now.
   */
  function fairQueue(rows, opts) {
    var list = Array.isArray(rows) ? rows.slice() : [];
    var n = list.length;
    if (n < 2) return list;

    var o = opts || {};
    var turn = Number.isFinite(o.turn) ? o.turn : turnAt(Date.now());

    // The queue itself: longest-waiting first. Ties break on id so the order is
    // total — two listings posted in the same second must not swap places
    // between one render and the next, which is what an unstable comparator
    // does and what makes a list flicker.
    list.sort(function (a, b) {
      var d = postedAt(a) - postedAt(b);
      if (d) return d;
      var ia = idOf(a), ib = idOf(b);
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    });

    // Rotate. A negative turn (a clock set before 1970, or a caller doing
    // arithmetic) must not produce a negative index, so the modulo is taken
    // the long way round rather than with a bare %.
    var shift = ((turn % n) + n) % n;
    if (!shift) return list;
    return list.slice(shift).concat(list.slice(0, shift));
  }

  /**
   * Where one listing sits in this turn's queue, and when its turn comes.
   *
   * This is what lets a screen tell an owner something true and specific
   * instead of a slogan: "3rd of 40 right now, at the top in 2 hours". A
   * promise about fairness that cannot be checked is just a claim.
   *
   * @returns {{position:number, of:number, turnsAway:number, msAway:number}|null}
   */
  function placeOf(rows, id, opts) {
    var q = fairQueue(rows, opts);
    var want = String(id);
    for (var i = 0; i < q.length; i++) {
      if (idOf(q[i]) === want) {
        return {
          position: i + 1,
          of: q.length,
          // i turns from now this listing is at the head: the queue advances
          // by one place per turn, so the listing now at index i leads in i.
          turnsAway: i,
          msAway: i * TURN_MS,
        };
      }
    }
    return null;
  }

  window.ListingOrder = {
    TURN_MS: TURN_MS,
    turnAt: turnAt,
    fairQueue: fairQueue,
    placeOf: placeOf,
    postedAt: postedAt,
  };
})();
