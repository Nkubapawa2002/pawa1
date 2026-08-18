/* ===========================================================================
 * explore-match.js — "you found a room; here are the trucks that can move you
 * into it."
 *
 * This is the reason Explore exists as one page instead of four.
 *
 * THE IDEA
 *   Nobody's actual problem stops at the edge of one catalogue. Finding a room
 *   is the start of moving into it: a truck for the furniture, someone to
 *   clean it, a fundi for the wiring the landlord never fixed. A day job in a
 *   town you don't live in is really a question about where to sleep. Four
 *   separate directories can each answer a fragment; only a joined catalogue
 *   can answer the question.
 *
 *   So every primary result carries companions from the OTHER verticals,
 *   chosen by where the primary result is — not by what the user typed.
 *
 * WHY MATCH ON THE RESULT'S PIN, NOT THE SEARCH ANCHOR
 *   The user searched "rooms in Mbezi" but is looking at a specific house in
 *   Mbezi Beach. The trucks that matter are the ones near THAT house, not the
 *   ones near the middle of the neighbourhood. Matching from the primary
 *   item's own coordinates is what makes the companion list feel like it is
 *   about the thing on screen.
 *
 * WHY THE RULES ARE A TABLE AND NOT CODE
 *   Which vertical helps which is a product decision that will change as the
 *   site grows — a fifth catalogue should be one row here, not a new branch in
 *   a function. Each rule also carries its own copy, because "Moving in?" and
 *   "Need a hand on the day?" are different offers and a generic "Related"
 *   heading would waste both.
 *
 * HONESTY RULE
 *   A companion is only shown when it is genuinely near. There is no
 *   auto-widen here, unlike the main results: a truck 90 km away is not
 *   "the truck for this house", and offering it as one would teach people to
 *   ignore the rail. Better to show nothing.
 * =========================================================================== */
(function () {
  "use strict";

  // How far a companion may be and still count as "near this listing". Tuned
  // per relationship: a truck will happily drive across a city for a job, a
  // cleaner works in their own neighbourhood, and a day-labourer will not
  // commute an hour each way for a day's pay.
  var RULES = {
    room: [
      {
        kind: "truck",
        radiusKm: 25,
        limit: 6,
        title: "Moving in?",
        subtitle: "Trucks near this place",
        icon: "truck",
      },
      {
        kind: "service",
        radiusKm: 12,
        limit: 6,
        title: "Get it ready",
        subtitle: "Cleaning, plumbing and repairs nearby",
        icon: "service",
        // The trades that actually precede a move-in. A tutor near the house
        // is not part of moving into it.
        categories: ["cleaning", "plumbing", "electrical", "carpentry",
                     "painting", "moving_help", "appliance_repair"],
      },
    ],
    truck: [
      {
        kind: "service",
        radiusKm: 20,
        limit: 6,
        title: "Need loading hands?",
        subtitle: "People who load and carry, near this truck",
        icon: "service",
        categories: ["moving_help", "cleaning"],
      },
    ],
    service: [
      {
        kind: "job",
        radiusKm: 20,
        limit: 6,
        title: "Work going on nearby",
        subtitle: "Day jobs around this area",
        icon: "job",
      },
    ],
    job: [
      {
        kind: "room",
        radiusKm: 15,
        limit: 6,
        title: "Somewhere to stay",
        subtitle: "Rooms to rent near this work",
        icon: "room",
        listing: "rent",
        // A day job pays a day's wage. Pairing it with a 2 M/month apartment
        // would be an insult dressed up as a suggestion, so the companion
        // budget is derived from the pay rather than left open.
        budgetFromPay: 30,
      },
    ],
  };

  function km(aLat, aLng, bLat, bLng) {
    return window.ExploreRank
      ? window.ExploreRank.haversineKm(aLat, aLng, bLat, bLng)
      : Infinity;
  }

  /**
   * Does this candidate satisfy the rule's own constraints (beyond distance)?
   * Kept separate from the distance test so the reason a companion was
   * excluded stays legible.
   */
  function eligible(cand, rule, primary) {
    if (cand.kind !== rule.kind) return false;
    if (cand.id === primary.id) return false;
    if (!cand.pinned) return false;              // cannot claim "nearby" without a pin

    if (rule.categories && rule.categories.indexOf(cand.facets.category) === -1) return false;
    if (rule.listing && cand.facets.listing !== rule.listing) return false;

    if (rule.budgetFromPay && primary.price) {
      // Roughly a month of this job's daily pay, as a ceiling.
      var ceiling = primary.price * rule.budgetFromPay;
      if (cand.price > ceiling) return false;
    }
    if (cand.kind === "job" && cand.facets.spotsLeft === 0) return false;
    return true;
  }

  /**
   * Companions for one item.
   *
   * Ordering inside a companion group is distance-first with a quality nudge,
   * not the full relevance model: the user did not type a query about trucks,
   * so there is no text signal to honour and pretending otherwise would just
   * be noise. Nearest good option wins.
   *
   * @param {Object} primary   the item being looked at
   * @param {Array}  all       the full normalised catalogue
   * @param {Object} [opts]    { maxGroups }
   * @returns {Array} [{ kind, title, subtitle, icon, items:[{item,distKm}] }]
   */
  function companionsFor(primary, all, opts) {
    opts = opts || {};
    if (!primary || !primary.pinned) return [];       // no pin → no honest "nearby"
    var rules = RULES[primary.kind] || [];
    var groups = [];

    for (var r = 0; r < rules.length; r++) {
      var rule = rules[r];
      var hits = [];
      for (var i = 0; i < all.length; i++) {
        var cand = all[i];
        if (!eligible(cand, rule, primary)) continue;
        var d = km(primary.lat, primary.lng, cand.lat, cand.lng);
        if (d > rule.radiusKm) continue;
        hits.push({ item: cand, distKm: d });
      }
      if (!hits.length) continue;

      hits.sort(function (a, b) {
        // Distance dominates, but a verified listing with a photo beats an
        // anonymous one a few hundred metres closer.
        var qa = (a.item.verified ? 0.6 : 0) + (a.item.photo ? 0.4 : 0);
        var qb = (b.item.verified ? 0.6 : 0) + (b.item.photo ? 0.4 : 0);
        return (a.distKm - qa * 0.8) - (b.distKm - qb * 0.8);
      });

      groups.push({
        kind: rule.kind,
        title: rule.title,
        subtitle: rule.subtitle,
        icon: rule.icon,
        radiusKm: rule.radiusKm,
        items: hits.slice(0, rule.limit),
        more: Math.max(0, hits.length - rule.limit),
      });
    }
    return opts.maxGroups ? groups.slice(0, opts.maxGroups) : groups;
  }

  /**
   * The whole-result-set version: what pairs well with everything on screen?
   *
   * Used for the summary rail above the results ("47 rooms in Mbezi — and 12
   * trucks that serve it"). Anchors on the centroid of the top results rather
   * than on any single one, so it describes the search, not the first card.
   *
   * The centroid is a plain mean, which is wrong on a sphere and irrelevant at
   * this scale — over one Tanzanian city the error is metres.
   */
  function companionsForSet(results, all, opts) {
    opts = opts || {};
    var top = results.slice(0, opts.sample || 12).filter(function (r) { return r.item.pinned; });
    if (!top.length) return [];

    var lat = 0, lng = 0;
    top.forEach(function (r) { lat += r.item.lat; lng += r.item.lng; });
    var centroid = {
      kind: top[0].item.kind,
      id: "__centroid__",
      lat: lat / top.length,
      lng: lng / top.length,
      pinned: true,
      price: top[0].item.price,
      facets: top[0].item.facets,
    };
    // A set is more spread out than a single listing, so the honest radius is
    // wider — but only by half, or "nearby" stops meaning anything.
    var groups = companionsFor(centroid, all, opts);
    return groups;
  }

  window.ExploreMatch = {
    RULES: RULES,
    companionsFor: companionsFor,
    companionsForSet: companionsForSet,
  };
})();
