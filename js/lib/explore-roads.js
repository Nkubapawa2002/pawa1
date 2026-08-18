/* ===========================================================================
 * explore-roads.js — turning straight lines into real road distance.
 *
 * A haversine distance is a lie that is usually close enough. Over a Tanzanian
 * city it stops being close enough in exactly the cases people care about: a
 * house on the far side of a creek is 900 m away and a 25 km drive, and the
 * Kigamboni ferry crossing is 3 km by boat and a bridge detour by car. Ranking
 * those by straight line puts the wrong listing first.
 *
 * js/lib/geo.js already solves the hard part — pawaRoute.table() is an OSRM
 * matrix with a Valhalla fallback, per-pair caching and ferry-aware ranking.
 * This file is the policy layer around it: WHICH listings are worth measuring,
 * WHEN, and what to do when the answer arrives late.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE
 *   Road distance is an UPGRADE, never a dependency. The list renders instantly
 *   with straight-line distance; this arrives afterwards and corrects it. If
 *   OSRM is down, rate-limited, or the user is offline, nothing breaks and
 *   nothing waits — the numbers simply stay approximate. That is why every
 *   failure path here returns quietly instead of surfacing an error.
 *
 * WHY ONLY THE TOP FEW
 *   OSRM's public endpoints are a shared free service. Measuring 2,000 listings
 *   because someone typed a letter would be both slow and rude, and 1,960 of
 *   those answers would never be looked at. Only the results near the top of
 *   the page get measured, and only once the typing has stopped.
 *
 * STALENESS
 *   Every request carries a token. By the time a matrix returns the user has
 *   often typed something else, and applying old distances to new results would
 *   put confident, precise, wrong numbers on screen. A stale answer is dropped,
 *   not merged.
 * =========================================================================== */
(function () {
  "use strict";

  // How many of the top results to measure. Comfortably more than one
  // screenful, comfortably under OSRM's 99-destination table limit, so a
  // settled search is one request rather than several.
  var DEFAULT_LIMIT = 40;

  // A road can be shorter than the straight line only by measurement error, so
  // anything under this ratio means the matrix returned something wrong (a
  // snapped-to-wrong-road result, usually) and is discarded.
  var MIN_PLAUSIBLE_RATIO = 0.85;

  var known = new Map();      // item id → road km, for the CURRENT anchor only
  var anchorKey = "";
  var token = 0;
  var inFlight = false;

  function keyOf(anchor) {
    if (!anchor) return "";
    return (+anchor.lat).toFixed(4) + "," + (+anchor.lng).toFixed(4);
  }

  /**
   * Drop everything measured against a different origin.
   *
   * Road distances are origin-relative, so keeping them across an anchor change
   * would silently attribute distances-from-Mbezi to a search from Mwanza.
   * pawaRoute keeps its own per-pair cache, so re-measuring after the user
   * switches back is nearly free — this map is only about correctness.
   */
  function syncAnchor(anchor) {
    var k = keyOf(anchor);
    if (k === anchorKey) return;
    anchorKey = k;
    known = new Map();
    token++;                  // abandon anything already in flight
  }

  /** What we already know, for handing to ExploreRank.rank({ roadKm }). */
  function map() { return known; }

  function has(id) { return known.has(id); }

  /**
   * Measure the top results, if there is anything worth measuring.
   *
   * Resolves with { changed, stale }:
   *   changed — how many items gained a road distance they did not have
   *   stale   — the search moved on; the caller must not re-render
   *
   * Never rejects.
   */
  async function enrich(anchor, rows, opts) {
    opts = opts || {};
    var limit = opts.limit || DEFAULT_LIMIT;

    if (!anchor || !window.pawaRoute || !window.pawaRoute.table) return { changed: 0, stale: false };
    syncAnchor(anchor);

    // Only pinned results, only ones we have not already measured, only the
    // top of the list. An item without coordinates has no road to measure.
    var todo = [];
    for (var i = 0; i < rows.length && todo.length < limit; i++) {
      var it = rows[i].item;
      if (!it.pinned || known.has(it.id)) continue;
      todo.push(it);
    }
    if (!todo.length) return { changed: 0, stale: false };

    // One matrix at a time. Overlapping requests would race to write the same
    // map and burn quota re-measuring what the first call is already fetching.
    if (inFlight) return { changed: 0, stale: true };
    inFlight = true;

    var mine = ++token;
    var changed = 0;
    try {
      var kms = await window.pawaRoute.table(
        { lat: anchor.lat, lng: anchor.lng },
        todo.map(function (it) { return { lat: it.lat, lng: it.lng }; })
      );
      if (mine !== token) return { changed: 0, stale: true };

      for (var j = 0; j < todo.length; j++) {
        var km = kms[j];
        if (!isFinite(km) || km == null) continue;
        // Sanity-check against the straight line the ranker already has.
        // A road that is meaningfully SHORTER than the crow flies is not a
        // road, it is a bad snap — and a wrong precise number is worse than
        // an honest approximate one.
        var straight = window.ExploreRank
          ? window.ExploreRank.haversineKm(anchor.lat, anchor.lng, todo[j].lat, todo[j].lng)
          : null;
        if (straight != null && straight > 0.2 && km < straight * MIN_PLAUSIBLE_RATIO) continue;
        known.set(todo[j].id, km);
        changed++;
      }
    } catch (_) {
      // Offline, blocked, rate-limited, timed out — all the same answer here:
      // the list keeps its straight-line distances and nobody is told off.
      return { changed: 0, stale: false };
    } finally {
      inFlight = false;
    }
    return { changed: changed, stale: false };
  }

  function reset() {
    known = new Map();
    anchorKey = "";
    token++;
  }

  window.ExploreRoads = {
    enrich: enrich,
    map: map,
    has: has,
    reset: reset,
    syncAnchor: syncAnchor,
    DEFAULT_LIMIT: DEFAULT_LIMIT,
  };
})();
