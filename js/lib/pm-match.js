// ============================================================================
//  pm-match.js — which agent should you actually write to?
//
//  P-Message can list every agent in Tanzania. That is not the same as being
//  able to answer the only question a person arrives with: "who can help me
//  with THIS, HERE?" Alphabetical order answers it by accident or not at all.
//
//  This file turns the columns pm_agent_finder() returns into an estimate of
//  P(this person can help with this need) and ranks by it. No DOM, no network,
//  no globals but its own — so every claim below can be argued with in
//  tests/pm_match_test.mjs without a browser or a database.
//
//  ---------------------------------------------------------------------------
//  WHAT THE NUMBER IS, AND WHAT IT IS NOT
//
//  It is an estimate built from listings: what someone lists, where they say
//  they work, when they last touched it. That is all we have and all we are
//  willing to have — the signal that would beat every one of these is "does
//  this person reply", and measuring it means building a picture of who
//  answered whom, which is the exact thing this feature promises not to do.
//  A worse ranking, honestly obtained.
//
//  So it is NOT a reply rate, NOT a rating, NOT fitted to any outcome data
//  (there is none), and the weights below are stated judgements rather than
//  measurements. The screen therefore shows the REASONS beside every row and
//  a coarse band — Strong / Good / Possible — instead of printing "87%" at
//  somebody as though it had been measured.
//
//  ---------------------------------------------------------------------------
//  HOW THE EVIDENCE IS COMBINED
//
//  In log-odds, which is the only combination rule that is correct rather than
//  convenient:
//
//      logit(p) = logit(prior) + Σ LLR_i
//
//  Each piece of evidence contributes a log likelihood ratio — how much more
//  likely that evidence is from someone who can help than from someone who
//  cannot. Multiplying probabilities together is wrong (it drives everything
//  to zero); averaging scores is arbitrary (it has no meaning to be right or
//  wrong about). Adding log-odds is Bayes' rule, once, with the independence
//  assumption written down where it can be checked — and where it is FALSE it
//  is handled rather than ignored: see pickPlace(), which deliberately takes
//  the strongest place signal instead of summing signals that are all the same
//  fact told three ways.
//
//  Small counts are the trap this file exists to avoid. One truck is not "100%
//  a truck specialist"; it is one truck. Every share is therefore floored by a
//  Wilson score interval, so confidence has to be earned by a denominator.
// ============================================================================

(function () {
  "use strict";

  // ---- constants -----------------------------------------------------------
  // Named because a magic 0.12 in the middle of a log is unreviewable.

  // The base rate: pick an agent at random who can be messaged, and this is
  // roughly the chance they can serve an arbitrary need. Low on purpose —
  // most agents cannot help with most requests, and a prior that pretends
  // otherwise flatters everybody equally and ranks nobody.
  var PRIOR = 0.12;

  // Log likelihood ratios, in nats. A weight of 1.6 is about a 5x likelihood
  // ratio; 2.3 is about 10x. Nothing here is bigger than 10x on its own,
  // because no single column in this database is worth more than that.
  var W = {
    DEPTH: 1.7,        // how many listings in the wanted category
    FOCUS: 2.0,        // what share of their listings is that category
    NOTHING_HERE: -1.9,// they list things, but nothing in this category
    PLACE_EXACT: 2.2,  // the search words match their area or ward outright
    PLACE_WARD: 1.9,
    PLACE_DISTRICT: 1.1,
    PLACE_REGION: 0.55,
    PLACE_ELSEWHERE: -1.3,
    DISTANCE: 1.5,     // scaled by how far, when both sides have a point
    FRESH: 0.9,        // scaled by how long ago they last touched a listing
    VERIFIED: 0.7,     // scaled by the verified share, Wilson-floored
  };

  // log1p(n)/log1p(SATURATE) is the depth curve: the fourth truck says much
  // less than the second, and the fortieth says nothing new at all.
  var DEPTH_SATURATE = 8;

  // Distance decay length in km. At 25km the distance term has fallen to 1/e;
  // Tanzanian districts are large, and an agent 25km away is a different
  // proposition from one across the street but not a useless one.
  var DISTANCE_SCALE_KM = 25;

  // Half-life on "when did they last touch a listing". Six months: long
  // enough not to punish an agent with a stable, still-available listing,
  // short enough that an abandoned profile drifts down.
  var FRESH_HALFLIFE_DAYS = 180;

  // Wilson z. 1.96 is the 95% interval — the conventional choice, and the
  // point of it here is to be conservative about small denominators rather
  // than to make a formal statistical statement.
  var Z = 1.96;

  // The four categories a person can be attached to — the same four the site
  // sells. Day jobs were absent from this list for one reason only:
  // public.day_jobs had no owner column, so there was nobody to message about
  // one. supabase/features/job/day_jobs_owner.sql gives it an owner and
  // p_message_jobs.sql counts it, so "jobs" is evidence like any other now.
  //
  // The ORDER is not decorative: FOCUS below is measured against 1/len, so
  // adding a category moves the point at which a mix stops being a
  // speciality. With four, an agent who deals evenly in all of them sits at
  // the neutral point and earns nothing from focus, which is the intent.
  var CATEGORIES = ["houses", "services", "trucks", "jobs"];

  // ---- small mathematics ---------------------------------------------------

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  function logit(p) {
    p = clamp(p, 1e-9, 1 - 1e-9);
    return Math.log(p / (1 - p));
  }
  function sigmoid(x) {
    // Split by sign so neither branch overflows exp() on a big magnitude.
    if (x >= 0) return 1 / (1 + Math.exp(-x));
    var e = Math.exp(x);
    return e / (1 + e);
  }

  /**
   * The lower end of a Wilson score interval for k successes in n trials.
   *
   * This is the whole reason small counts do not lie here. The naive share
   * k/n says 1 truck out of 1 listing is a 100% truck specialist, which is a
   * statement about a sample of one dressed up as a statement about a person.
   * Wilson pulls that back towards the middle by an amount that depends on n,
   * so confidence has to be bought with a denominator:
   *
   *      1/1   -> 0.21        5/5   -> 0.57        50/50 -> 0.93
   *
   * n = 0 returns 0: no listings is no evidence, and no evidence must not be
   * allowed to read as evidence of anything.
   */
  function wilsonLower(k, n, z) {
    if (!n || n <= 0) return 0;
    z = z || Z;
    k = clamp(k, 0, n);
    var phat = k / n;
    var z2 = z * z;
    var denom = 1 + z2 / n;
    var centre = phat + z2 / (2 * n);
    var margin = z * Math.sqrt(phat * (1 - phat) / n + z2 / (4 * n * n));
    return clamp((centre - margin) / denom, 0, 1);
  }

  /** Exponential decay to 0.5 at one half-life. Out-of-range input decays to 0. */
  function decay(days, halfLife) {
    if (days == null || !isFinite(days) || days < 0) return 0;
    return Math.pow(0.5, days / (halfLife || FRESH_HALFLIFE_DAYS));
  }

  /** Great-circle distance in km. Returns null if either point is missing. */
  function haversineKm(a, b) {
    if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
    var R = 6371;
    var toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad;
    var dLng = (b.lng - a.lng) * toRad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /**
   * Normalised Shannon entropy of someone's category mix, 0..1.
   *
   * 0 means everything they list is one kind of thing; 1 means it is spread
   * evenly across every category there is. This is NOT used in the score — for a chosen
   * category the focus term already says what is needed, and using both would
   * be counting one fact twice. It is used to LABEL a row ("mostly rooms",
   * "rooms, services and trucks"), which is a different job.
   */
  function entropy(counts) {
    var total = 0, i;
    for (i = 0; i < counts.length; i++) total += counts[i];
    if (total <= 0 || counts.length < 2) return 0;
    var h = 0;
    for (i = 0; i < counts.length; i++) {
      if (counts[i] <= 0) continue;
      var p = counts[i] / total;
      h -= p * Math.log(p);
    }
    // Normalised against ALL the categories passed in, not just the ones with
    // a count. Someone who splits evenly between houses and services is spread
    // across two slots of however many exist and comes out well short of 1.
    // Dividing by the USED slots instead would call them as broad as someone
    // doing all of them, which is the opposite of what this is measuring.
    return clamp(h / Math.log(counts.length), 0, 1);
  }

  // ---- reading a row -------------------------------------------------------

  // Built by walking CATEGORIES rather than by naming each field, so a fifth
  // category is one entry in one list instead of four edits in four places
  // that have to agree. A row from an older pm_agent_finder simply has no
  // n_jobs, which reads as 0 — the honest answer for a database that was not
  // asked the question.
  var COLUMN = {
    houses: "n_houses", services: "n_services", trucks: "n_trucks", jobs: "n_jobs",
  };

  function counts(a) {
    var c = {};
    for (var i = 0; i < CATEGORIES.length; i++) {
      var cat = CATEGORIES[i];
      c[cat] = Math.max(0, a[COLUMN[cat]] | 0);
    }
    return c;
  }
  function totalOf(c) {
    var total = 0;
    for (var i = 0; i < CATEGORIES.length; i++) total += c[CATEGORIES[i]] || 0;
    return total;
  }
  function countList(c) {
    return CATEGORIES.map(function (cat) { return c[cat] || 0; });
  }

  function norm(s) {
    return String(s == null ? "" : s).trim().toLowerCase();
  }
  // "Nyamagana" should match a search for "nyamagana district" and vice versa,
  // without matching "Nya" — a two-letter overlap is a coincidence, not a place.
  function placeHit(field, query) {
    var f = norm(field), q = norm(query);
    if (!f || q.length < 3) return false;
    return f.indexOf(q) >= 0 || q.indexOf(f) >= 0;
  }

  // ---- the place term ------------------------------------------------------
  /**
   * ONE place signal, not four.
   *
   * Ward, district, region and distance are not independent pieces of
   * evidence: they are the same fact at four resolutions. Naive Bayes adds
   * independent evidence, so adding all four would triple-count a single
   * match and hand a runaway score to anyone who happens to be in the right
   * region. The strongest applicable signal is taken and the rest are dropped,
   * which is the standard, honest handling of a known independence violation.
   */
  function pickPlace(a, need) {
    var q = need.query;
    var best = null;

    if (q && q.length >= 3) {
      if (placeHit(a.area, q)) best = { llr: W.PLACE_EXACT, why: "place_area", detail: a.area };
      else if (placeHit(a.ward, q)) best = { llr: W.PLACE_WARD, why: "place_ward", detail: a.ward };
      else if (placeHit(a.district, q)) best = { llr: W.PLACE_DISTRICT, why: "place_district", detail: a.district };
      else if (placeHit(a.region, q)) best = { llr: W.PLACE_REGION, why: "place_region", detail: a.region };
    }

    if (!best && need.ward && placeHit(a.ward, need.ward)) {
      best = { llr: W.PLACE_WARD, why: "place_ward", detail: a.ward };
    }
    if (!best && need.district && placeHit(a.district, need.district)) {
      best = { llr: W.PLACE_DISTRICT, why: "place_district", detail: a.district };
    }
    if (!best && need.region) {
      best = norm(a.region) === norm(need.region)
        ? { llr: W.PLACE_REGION, why: "place_region", detail: a.region }
        // Only a NEGATIVE when we actually know they are somewhere else. An
        // agent with no region recorded is unknown, and unknown is not wrong.
        : (a.region ? { llr: W.PLACE_ELSEWHERE, why: "place_elsewhere", detail: a.region } : null);
    }

    // Distance competes with the text hierarchy rather than adding to it, for
    // the same reason: a point 800m away and a matching ward name are one
    // fact. Whichever says more, says it.
    var km = haversineKm(need.at, { lat: a.lat, lng: a.lng });
    if (km != null) {
      var near = Math.exp(-km / DISTANCE_SCALE_KM);
      var dist = { llr: W.DISTANCE * (2 * near - 1), why: "distance", detail: km };
      if (!best || dist.llr > best.llr) best = dist;
    }
    return best;
  }

  // ---- the score -----------------------------------------------------------
  /**
   * P(this person can help with this need), and the reasons for it.
   *
   * `need` is { category, query, region, district, ward, at:{lat,lng} } — all
   * optional. With nothing set at all the answer is the prior for everybody,
   * which is the correct answer to "rank these people by nothing".
   *
   * Reachability is deliberately NOT folded in. "Can they help" and "can they
   * be reached" are different questions and blending them produces a number
   * that answers neither; the caller sorts unreachable people to the bottom
   * and says why on the row.
   */
  function score(agent, need) {
    need = need || {};
    var c = counts(agent);
    var total = totalOf(c);
    var evidence = [];
    var sum = 0;

    function add(llr, why, detail) {
      if (!llr) return;
      sum += llr;
      evidence.push({ why: why, llr: llr, detail: detail });
    }

    // --- what they deal in ---
    var cat = need.category;
    if (cat && CATEGORIES.indexOf(cat) >= 0) {
      var n = c[cat];
      if (n > 0) {
        // Depth: more listings in the wanted category is better, with
        // sharply diminishing returns.
        var depth = clamp(Math.log1p(n) / Math.log1p(DEPTH_SATURATE), 0, 1);
        add(W.DEPTH * depth, "category_depth", n);

        // Focus: what share of everything they list is this category, floored
        // by Wilson so a single listing cannot claim to be a speciality. The
        // baseline is 1/CATEGORIES.length — an agent who deals equally in all
        // of them tells you nothing by also dealing in this one — so this term
        // goes NEGATIVE for someone with one truck among eleven houses, which
        // is right.
        var share = wilsonLower(n, total);
        add(W.FOCUS * (share - 1 / CATEGORIES.length), "category_focus", share);
      } else if (total > 0) {
        // They list things, and none of them are this. That is real evidence
        // against, unlike listing nothing at all.
        add(W.NOTHING_HERE, "category_absent", cat);
      }
      // total === 0 adds nothing in either direction: no listings is no
      // evidence, and must not be allowed to read as evidence of absence.
    }

    // --- where they work ---
    var place = pickPlace(agent, need);
    if (place) add(place.llr, place.why, place.detail);

    // --- are they still here ---
    if (agent.last_listed_at) {
      var days = (Date.now() - new Date(agent.last_listed_at).getTime()) / 86400000;
      var fresh = decay(days, FRESH_HALFLIFE_DAYS);
      add(W.FRESH * (2 * fresh - 1), "freshness", days);
    }

    // --- has anyone checked their listings ---
    if (total > 0) {
      var vshare = wilsonLower(Math.max(0, agent.n_verified | 0), total);
      if (vshare > 0) add(W.VERIFIED * vshare, "verified", vshare);
    }

    var p = sigmoid(logit(PRIOR) + sum);

    return {
      p: p,
      band: band(p),
      llr: sum,
      evidence: evidence,
      counts: c,
      total: total,
      spread: entropy(countList(c)),
    };
  }

  // Coarse bands, because a probability estimated from listings deserves to be
  // reported at the resolution it was actually earned at. These are the words
  // the screen shows; the number stays inside this file except where a
  // combination is the point (see shortlist).
  function band(p) {
    if (p >= 0.62) return "strong";
    if (p >= 0.38) return "good";
    if (p >= 0.18) return "possible";
    return "weak";
  }

  /**
   * Score everybody and sort.
   *
   * Reachable people come first regardless of score: an unreachable agent
   * cannot be written to at all, so a brilliant match who has never opened
   * P-Message is not a better answer to "who do I message" than a mediocre one
   * who has. Name is the final tiebreak so the order is stable between two
   * loads with identical scores.
   */
  function rank(agents, need) {
    var out = (agents || []).map(function (a) {
      var s = score(a, need);
      s.agent = a;
      return s;
    });
    out.sort(function (x, y) {
      var rx = x.agent.reachable ? 1 : 0, ry = y.agent.reachable ? 1 : 0;
      if (rx !== ry) return ry - rx;
      if (y.p !== x.p) return y.p - x.p;
      return String(x.agent.display_name || "").localeCompare(String(y.agent.display_name || ""));
    });
    return out;
  }

  // ---- the combination -----------------------------------------------------
  /**
   * If I write to the top k, what is the chance at least one can help?
   *
   * The tempting answer is 1 - Π(1 - p_i), and it is wrong in a way that
   * matters: it treats the candidates as independent, so five agents at 40%
   * come out at 92% and the screen tells somebody they are nearly certain to
   * be helped. They are not. Five agents in the same ward, all listing rooms,
   * fail TOGETHER — if what you want is not available in that ward this week,
   * it is not available from any of them.
   *
   * So the model has one latent factor. Let G be "this need is servable in
   * this scope at all", with P(G) = g. Given G, the agents are treated as
   * independent; without G nobody can help. Then
   *
   *     p_i = g * q_i                         (q_i is the conditional rate)
   *     P(at least one of k) = g * (1 - Π (1 - q_i))
   *
   * which is a genuine dependent-events calculation with exactly one extra
   * parameter, rather than a fudge factor. And g means something you can
   * argue with: the chance the thing exists nearby at all. It is set from how
   * ALIKE the shortlist is — candidates spread across different wards share
   * little and g approaches G_MAX; candidates piled into one ward share
   * almost everything and g falls to G_MIN.
   *
   * The consequence is the honest one: the combined figure can never reach 1.
   * Messaging more people does not make a thing exist.
   */
  var G_MAX = 0.97;   // candidates with nothing in common
  var G_MIN = 0.75;   // candidates who would all fail for the same reason

  function similarity(scored) {
    if (scored.length < 2) return 0;
    // Fraction of pairs sharing the finest place we know for both. Ward if we
    // have it for both, else district, else region; if we know neither side's
    // place, the pair contributes nothing rather than being assumed apart.
    var pairs = 0, same = 0;
    for (var i = 0; i < scored.length; i++) {
      for (var j = i + 1; j < scored.length; j++) {
        var a = scored[i].agent, b = scored[j].agent;
        var fields = ["ward", "district", "region"];
        for (var f = 0; f < fields.length; f++) {
          var av = norm(a[fields[f]]), bv = norm(b[fields[f]]);
          if (!av || !bv) continue;
          pairs++;
          if (av === bv) same++;
          break;
        }
      }
    }
    return pairs ? same / pairs : 0;
  }

  /**
   * The smallest set of people worth writing to, and how good that set is.
   *
   * Returns { picks, p, g, capped }. `capped` is true when the target could
   * not be reached however many were added — the case where the right thing to
   * tell someone is that this is as good as it gets here, not to keep listing
   * names at them.
   */
  function shortlist(scored, target, opts) {
    opts = opts || {};
    var max = opts.max || 5;
    var pool = (scored || []).filter(function (s) { return s.agent.reachable; }).slice(0, max);
    if (!pool.length) return { picks: [], p: 0, g: G_MAX, capped: true };

    var g = G_MAX - (G_MAX - G_MIN) * similarity(pool);
    var picks = [], prodFail = 1, best = 0;

    for (var i = 0; i < pool.length; i++) {
      var q = clamp(pool[i].p / g, 0, 1);
      prodFail *= (1 - q);
      picks.push(pool[i]);
      best = g * (1 - prodFail);
      if (best >= (target || 0.8)) break;
    }
    return { picks: picks, p: best, g: g, capped: best < (target || 0.8) };
  }

  window.PMMatch = {
    score: score,
    rank: rank,
    shortlist: shortlist,
    band: band,
    // Exported because they are the claims worth testing on their own, and a
    // helper nobody can reach is a helper nobody can check.
    wilsonLower: wilsonLower,
    entropy: entropy,
    decay: decay,
    haversineKm: haversineKm,
    logit: logit,
    sigmoid: sigmoid,
    CATEGORIES: CATEGORIES,
    PRIOR: PRIOR,
    WEIGHTS: W,
  };
})();
