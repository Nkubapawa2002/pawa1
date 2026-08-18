/* ===========================================================================
 * explore-rank.js — scoring one list that contains rooms, trucks, services
 * and day jobs, all at once.
 *
 * Ranking within a vertical is easy: everything shares a price, a distance and
 * a date. Ranking ACROSS verticals is the hard part, and it is the whole job
 * here — a 400,000/month room and a 15,000/trip pickup have to end up in a
 * defensible order on one screen.
 *
 * HOW THAT IS MADE POSSIBLE
 *   Every signal is normalised to 0..1 *before* anything is compared, and
 *   nothing is ever compared in its own units. Price never contributes an
 *   absolute number to the score — only "how well does this fit the budget
 *   you named", which is a fraction and therefore means the same thing to a
 *   room and to a truck.
 *
 * THE SIGNALS, and why each earns its weight
 *   text      how well the words match. IDF-weighted, so a rare word like
 *             "Mbezi" outranks a word like "room" that half the corpus has.
 *   geo       distance from the anchor, decayed exponentially. Not linear:
 *             the difference between 1 km and 3 km matters enormously, the
 *             difference between 40 km and 42 km does not.
 *   price     fit against a stated budget. NEUTRAL when no budget was stated,
 *             because "cheaper is better" is an assumption, not a fact — a
 *             suspiciously cheap listing is usually a bad one.
 *   fresh     age decay. A day job posted last week is nearly worthless; a
 *             house from last week is fine. Hence a per-kind half-life.
 *   quality   verified / has a photo / has a real description / has a pin.
 *   facet     the specifics: bedrooms, tonnage, category, listing type.
 *
 * HARD FILTERS vs SOFT SIGNALS
 *   A hard filter answers "would showing this be wrong?" — the wrong listing
 *   type, or double the stated budget. Everything else is soft. The bar for
 *   promoting a preference to a hard filter is high: a filter that removes
 *   the only three listings in a town turns a working search into an empty
 *   page, and an empty page is the one result no one can act on.
 *
 * DIVERSITY
 *   The last pass is not about relevance at all. One agent with forty
 *   near-identical listings would otherwise own the entire first screen, so
 *   repeats from the same owner and the same area are progressively demoted
 *   as the list is built. A slightly less relevant result the user has not
 *   already seen is worth more than the fifth copy of one they have.
 * =========================================================================== */
(function () {
  "use strict";

  var R_EARTH_KM = 6371;

  // Per-kind weight profiles. They differ because the verticals are not the
  // same problem: you pick a house mostly on where it is, and a fundi mostly
  // on whether they do the thing you asked for.
  var PROFILE = {
    //          text  geo  price fresh qual facet
    room:    { text: 0.30, geo: 0.30, price: 0.14, fresh: 0.08, quality: 0.08, facet: 0.10 },
    truck:   { text: 0.26, geo: 0.34, price: 0.14, fresh: 0.06, quality: 0.10, facet: 0.10 },
    service: { text: 0.36, geo: 0.24, price: 0.08, fresh: 0.06, quality: 0.14, facet: 0.12 },
    // A job's date is the point of it, so freshness carries real weight and
    // price (the pay) is a genuine draw rather than a cost to minimise.
    job:     { text: 0.30, geo: 0.28, price: 0.10, fresh: 0.18, quality: 0.04, facet: 0.10 },
  };

  // Age at which freshness has decayed to ~37%. Tuned to each vertical's real
  // shelf life: houses are purged at 15 days, day jobs expire in 7.
  var FRESH_TAU_DAYS = { room: 10, truck: 21, service: 30, job: 3 };

  // Distance decay constant, in km, when the user has not set a radius. About
  // 6 km is "the same part of a Tanzanian city".
  var GEO_TAU_DEFAULT_KM = 6;

  // Over this multiple of a stated budget, a listing is not a near miss — it
  // is an answer to a different question.
  var BUDGET_HARD_MULTIPLE = 1.5;

  function haversineKm(aLat, aLng, bLat, bLng) {
    var toRad = function (d) { return (d * Math.PI) / 180; };
    var dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R_EARTH_KM * Math.asin(Math.sqrt(x));
  }

  // ---- Text -----------------------------------------------------------------
  // Damerau-less Levenshtein, capped at 1: we only ever ask "is this one typo
  // away?", so the full matrix is wasted work. Bails as soon as a second
  // difference appears.
  function withinOneEdit(a, b) {
    if (a === b) return true;
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    var i = 0, j = 0, diff = 0;
    while (i < la && j < lb) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++diff > 1) return false;
      if (la > lb) i++;
      else if (lb > la) j++;
      else { i++; j++; }
    }
    return diff + (la - i) + (lb - j) <= 1;
  }

  /**
   * Inverse document frequency over the candidate set.
   *
   * Without this every query term counts the same, and a search for "room
   * Mbezi" is dominated by "room" — a word that four fifths of the corpus
   * contains and which therefore separates nothing. IDF is what makes the
   * rare, discriminating word carry the result.
   */
  function buildIdf(items, terms) {
    var df = {};
    terms.forEach(function (t) { df[t] = 0; });
    for (var i = 0; i < items.length; i++) {
      var text = items[i].text;
      for (var k = 0; k < terms.length; k++) {
        if (text.indexOf(terms[k]) !== -1) df[terms[k]]++;
      }
    }
    var n = Math.max(1, items.length), idf = {};
    terms.forEach(function (t) {
      // +1 smoothing so a term matching everything scores just above zero
      // rather than exactly zero (which would erase an otherwise valid match).
      idf[t] = Math.log(1 + n / (1 + df[t]));
    });
    return idf;
  }

  function textScore(item, terms, idf) {
    if (!terms.length) return 0.5;            // no words typed → neutral
    var title = item.title.toLowerCase();
    var got = 0, total = 0;
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i], w = idf[t] || 1;
      total += w;
      if (title.indexOf(t) !== -1) { got += w; continue; }          // best
      if (item.text.indexOf(t) !== -1) { got += w * 0.6; continue; } // good
      // Typo / inflection tolerance, only for words long enough that a single
      // edit is unlikely to be a different word ("moto" vs "mото").
      if (t.length >= 5 && fuzzyHit(item.text, t)) got += w * 0.3;
    }
    return total > 0 ? got / total : 0.5;
  }

  function fuzzyHit(text, term) {
    var words = text.split(" ");
    for (var i = 0; i < words.length; i++) {
      if (Math.abs(words[i].length - term.length) <= 1 && withinOneEdit(words[i], term)) return true;
    }
    return false;
  }

  // ---- Other signals --------------------------------------------------------
  function geoScore(distKm, tauKm) {
    if (distKm == null) return 0.35;   // unpinned: present, but never beats a
                                       // listing we can actually place
    return Math.exp(-distKm / (tauKm || GEO_TAU_DEFAULT_KM));
  }

  function priceScore(price, min, max) {
    if (min == null && max == null) return 0.5;      // no budget → no opinion
    if (max != null) {
      if (!price) return 0.45;                        // "price on request"
      if (price <= max) {
        // Within budget. Nudge toward listings that use the budget rather than
        // sitting at a tenth of it — an unusually cheap result in a stated
        // range is more often mispriced than a bargain.
        var use = price / max;
        return use >= 0.35 ? 1 : 0.75 + use * 0.7;
      }
      var over = (price - max) / max;
      return Math.max(0, 1 - over / (BUDGET_HARD_MULTIPLE - 1));
    }
    if (min != null && price && price >= min) return 1;
    return 0.4;
  }

  function freshScore(createdAt, kind) {
    if (!createdAt) return 0.5;
    var ms = Date.now() - new Date(createdAt).getTime();
    if (!isFinite(ms) || ms < 0) return 0.5;
    return Math.exp(-(ms / 86400000) / (FRESH_TAU_DAYS[kind] || 14));
  }

  function qualityScore(item) {
    var s = 0;
    if (item.verified) s += 0.35;
    if (item.photo) s += 0.30;
    if (item.pinned) s += 0.15;
    // A description long enough to actually describe something. The threshold
    // is low on purpose — this rewards effort, it does not demand an essay.
    if ((item.text || "").length > 120) s += 0.20;
    return Math.min(1, s);
  }

  function facetScore(item, intent) {
    var f = intent.facets || {}, g = item.facets || {}, hits = 0, asked = 0;

    if (item.kind === "room") {
      if (f.type)     { asked++; if (matchesType(g.type, f.type)) hits++; }
      if (f.roomKind) { asked++; if (g.roomKind === f.roomKind) hits++; }
      if (f.bedrooms != null) {
        asked++;
        // Exact is best; one extra bedroom is still a good answer; fewer is not.
        var d = (g.bedrooms || 0) - f.bedrooms;
        hits += d === 0 ? 1 : (d === 1 ? 0.7 : (d > 1 ? 0.35 : 0));
      }
    } else if (item.kind === "truck") {
      if (f.truckType) { asked++; if ((g.truckType || "").indexOf(f.truckType) !== -1) hits++; }
      if (f.capacityT != null) {
        asked++;
        // A bigger truck can always do a smaller job; a smaller one cannot.
        if (g.capacityT == null) hits += 0.4;
        else if (g.capacityT >= f.capacityT) hits += g.capacityT <= f.capacityT * 2 ? 1 : 0.6;
      }
    } else if (item.kind === "service") {
      if (f.category) { asked++; if (g.category === f.category) hits++; }
    } else if (item.kind === "job") {
      // Nobody can take a job that is already full.
      if (g.spotsLeft === 0) return 0;
    }
    return asked === 0 ? 0.5 : hits / asked;
  }

  // `type` is free-form since 2026-05, so exact equality would miss
  // "self contained apartment" for a query of "apartment".
  function matchesType(actual, wanted) {
    actual = (actual || "").toLowerCase();
    return actual === wanted || actual.indexOf(wanted) !== -1;
  }

  // ---- Hard filters ---------------------------------------------------------
  // Returns a reason string when the item must not be shown, else null.
  function reject(item, intent) {
    if (intent.kinds.indexOf(item.kind) === -1) return "kind";

    var f = intent.facets || {};
    // Asking to rent and being shown a listing for sale is not a near miss —
    // the price is a different order of magnitude and the result is noise.
    if (f.listing && item.kind === "room" && item.facets.listing !== f.listing) return "listing";

    if (intent.priceMax != null && item.price > intent.priceMax * BUDGET_HARD_MULTIPLE) return "budget";
    if (intent.priceMin != null && item.price && item.price < intent.priceMin * 0.5) return "budget";

    if (item.kind === "job" && item.facets.spotsLeft === 0) return "full";

    // Outside an explicit radius. Only applied to items we can actually place:
    // dropping every unpinned listing would silently hide whole towns whose
    // agents never dropped a map pin.
    if (intent.radiusKm && item._distKm != null && item._distKm > intent.radiusKm) return "radius";

    return null;
  }

  // ---- Diversity ------------------------------------------------------------
  /**
   * Greedy re-rank that demotes repetition.
   *
   * Walks the relevance-sorted list once, keeping a tally of how many results
   * each owner and each area has already contributed, and discounts the next
   * one accordingly. The discount is multiplicative and shallow, so a genuinely
   * dominant result still wins — this breaks up runs, it does not overturn the
   * ranking.
   */
  function diversify(scored, opts) {
    opts = opts || {};
    var ownerPenalty = opts.ownerPenalty == null ? 0.72 : opts.ownerPenalty;
    var areaPenalty  = opts.areaPenalty  == null ? 0.93 : opts.areaPenalty;
    var seenOwner = {}, seenArea = {}, out = [];
    var pool = scored.slice();

    while (pool.length) {
      var bestI = 0, bestV = -Infinity;
      for (var i = 0; i < pool.length; i++) {
        var it = pool[i];
        var o = it.item.ownerId || "";
        var a = (it.item.area || it.item.region || "").toLowerCase();
        var v = it.score
          * Math.pow(ownerPenalty, o ? (seenOwner[o] || 0) : 0)
          * Math.pow(areaPenalty, a ? (seenArea[a] || 0) : 0);
        if (v > bestV) { bestV = v; bestI = i; }
      }
      var pick = pool.splice(bestI, 1)[0];
      pick.finalScore = bestV;
      out.push(pick);
      var po = pick.item.ownerId || "", pa = (pick.item.area || pick.item.region || "").toLowerCase();
      if (po) seenOwner[po] = (seenOwner[po] || 0) + 1;
      if (pa) seenArea[pa] = (seenArea[pa] || 0) + 1;
      // O(n²) is fine for a few thousand rows and stops being fine well beyond
      // the size of this catalogue — past the cut, keep the relevance order.
      if (out.length >= (opts.limit || 120)) { out = out.concat(pool); break; }
    }
    return out;
  }

  // ---- The rank -------------------------------------------------------------
  /**
   * @param {Array}  items   the normalised catalogue (explore-index.js)
   * @param {Object} intent  from ExploreQuery.parse()
   * @param {Object} [opts]  { anchor:{lat,lng}, radiusKm, roadKm:Map, sort,
   *                           limit, diversity:boolean }
   * @returns {{results:Array, dropped:Object, anchorUsed:boolean}}
   */
  function rank(items, intent, opts) {
    opts = opts || {};
    var anchor = opts.anchor || (intent.place && isFinite(intent.place.lat) ? intent.place : null);
    var radiusKm = opts.radiusKm || null;
    var tau = radiusKm ? Math.max(1, radiusKm / 2.5) : GEO_TAU_DEFAULT_KM;

    // Distances first — the hard filters need them, and computing once here
    // keeps haversine out of the scoring loop.
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (anchor && it.pinned) {
        var road = opts.roadKm && opts.roadKm.get ? opts.roadKm.get(it.id) : null;
        it._distKm = road != null ? road : haversineKm(anchor.lat, anchor.lng, it.lat, it.lng);
        it._roadKm = road != null;
      } else {
        it._distKm = null;
        it._roadKm = false;
      }
    }

    var intentWithRadius = Object.assign({}, intent, { radiusKm: radiusKm });
    var kept = [], dropped = { kind: 0, listing: 0, budget: 0, radius: 0, full: 0 };
    for (var j = 0; j < items.length; j++) {
      var why = reject(items[j], intentWithRadius);
      if (why) { dropped[why] = (dropped[why] || 0) + 1; continue; }
      kept.push(items[j]);
    }

    var idf = buildIdf(kept, intent.terms || []);
    var scored = kept.map(function (item) {
      var p = PROFILE[item.kind] || PROFILE.room;
      var s = {
        text:    textScore(item, intent.terms || [], idf),
        geo:     anchor ? geoScore(item._distKm, tau) : 0.5,
        price:   priceScore(item.price, intent.priceMin, intent.priceMax),
        fresh:   freshScore(item.createdAt, item.kind),
        quality: qualityScore(item),
        facet:   facetScore(item, intent),
      };
      var base = s.text * p.text + s.geo * p.geo + s.price * p.price +
                 s.fresh * p.fresh + s.quality * p.quality + s.facet * p.facet;

      // Cross-vertical calibration. When the query clearly meant "trucks", a
      // service that survived the filters should still sit below the trucks —
      // this is the only place one vertical is allowed to outrank another for
      // a reason that is not about the listing itself.
      var kw = (intent.kindWeights && intent.kindWeights[item.kind]) || 1;
      return { item: item, score: base * (0.55 + 0.45 * kw), signals: s, distKm: item._distKm };
    });

    // Explicit sorts answer a different question than "best match" and must not
    // be second-guessed by diversity or by relevance.
    if (opts.sort === "near") {
      scored.sort(function (a, b) {
        if (a.distKm == null) return b.distKm == null ? b.score - a.score : 1;
        if (b.distKm == null) return -1;
        return a.distKm - b.distKm;
      });
    } else if (opts.sort === "cheap") {
      scored.sort(function (a, b) {
        var ap = a.item.price || Infinity, bp = b.item.price || Infinity;
        return ap === bp ? b.score - a.score : ap - bp;
      });
    } else if (opts.sort === "new") {
      scored.sort(function (a, b) {
        return new Date(b.item.createdAt || 0) - new Date(a.item.createdAt || 0);
      });
    } else {
      scored.sort(function (a, b) { return b.score - a.score; });
      if (opts.diversity !== false) scored = diversify(scored, { limit: opts.limit || 120 });
    }

    return {
      results: opts.limit ? scored.slice(0, opts.limit) : scored,
      total: scored.length,
      dropped: dropped,
      anchor: anchor,
      anchorUsed: !!anchor,
    };
  }

  window.ExploreRank = {
    rank: rank,
    haversineKm: haversineKm,
    diversify: diversify,
    buildIdf: buildIdf,
    textScore: textScore,
    priceScore: priceScore,
    withinOneEdit: withinOneEdit,
    PROFILE: PROFILE,
  };
})();
