// ============================================================================
//  truck-match.js — window.TruckMove
//
//  THE ONE PLACE THAT ANSWERS "which truck should move my things?"
//
//  WHY THIS EXISTS
//  The app has a houses catalogue and a trucks catalogue, and until now they
//  were two strangers living in the same building. Somebody found a room in
//  Mbezi, and then started again from scratch: open trucks.html, guess which
//  lorry is big enough for a two-bedroom house, guess whether a "within city"
//  truck will drive to Kibaha, and type the new address into Google Maps by
//  hand. Every one of those guesses is a fact the app already holds.
//
//  So this file is the join. Given where the load is now, where it is going,
//  and roughly how much of it there is, it ranks the trucks and says WHY each
//  one is ranked where it is. It owns no DOM and no strings a person reads
//  (except the load catalogue below): it returns facts, and the caller draws
//  them in the reader's language.
//
//  THREE DISTANCES, AND THEY ARE NOT THE SAME NUMBER
//    pickupKm   truck's base  ->  where your things are     ("how far is it?")
//    tripKm     where your things are -> the new home       ("how long a move?")
//    (the sum)  what the driver actually drives
//  Conflating the first two is the single easiest way to lie on this screen,
//  so they are separate fields and separate labels everywhere downstream.
//
//  HONESTY RULES THIS FILE KEEPS
//    · A distance is ROAD distance when a routing engine could measure it, and
//      is marked as such. Straight-line is only ever a fallback for ORDERING,
//      never a number shown as if it were a drive.
//    · No invented prices. A listing's price_tzs is a "from" figure for a trip
//      the owner had in mind; we do not multiply it by our own km and present
//      the result as a quote. We say what the trip is and let them quote it.
//    · "Cannot do this trip" is only ever said when the owner said it. Where
//      we are guessing, the answer is "ask", not "no". A truck wrongly hidden
//      is a business lost by a bug nobody can see.
//
//  Depends on (all optional, degrades cleanly): window.pawaRoute (js/lib/geo.js)
//  for real road distances. Nothing else at load time.
// ============================================================================
(function () {
  "use strict";

  // ==========================================================================
  //  THE LOAD CATALOGUE
  //
  //  Bilingual in this file rather than in js/core/i18n.js, for the reason
  //  js/lib/house-spec.js and js/lib/offer-spec.js both give at their own top:
  //  a handful of short strings that ONLY ever appear together, as one list,
  //  drift apart when they live a thousand lines away from each other, and a
  //  half-translated size picker is worse than an English one because you
  //  cannot tell which half you are reading.
  //
  //  `tonnes` is the capacity below which the move needs a second trip. It is
  //  deliberately generous: a truck that is too small is a wasted day, and the
  //  cost of suggesting one size up is a few thousand shillings.
  // ==========================================================================
  var LOADS = [
    { key: "few",       tonnes: 0.5,
      en: "A few items",              sw: "Vitu vichache",
      en_d: "A bed, a fridge, some boxes", sw_d: "Kitanda, friji, makatoni" },
    { key: "room",      tonnes: 1,
      en: "One room",                 sw: "Chumba kimoja",
      en_d: "Everything from a single room", sw_d: "Kila kitu cha chumba kimoja" },
    { key: "studio",    tonnes: 1.5,
      en: "Studio or bedsitter",      sw: "Studio au bedsitter",
      en_d: "One space, furnished",   sw_d: "Chumba kimoja chenye samani" },
    { key: "one_bed",   tonnes: 2,
      en: "One-bedroom home",         sw: "Nyumba ya chumba kimoja",
      en_d: "Sitting room, kitchen, one bedroom", sw_d: "Sebule, jiko, chumba kimoja" },
    { key: "two_bed",   tonnes: 3,
      en: "Two-bedroom home",         sw: "Nyumba ya vyumba viwili",
      en_d: "A full small household", sw_d: "Nyumba nzima ndogo" },
    { key: "three_bed", tonnes: 5,
      en: "Three-bedroom home",       sw: "Nyumba ya vyumba vitatu",
      en_d: "A full family household", sw_d: "Nyumba nzima ya familia" },
    { key: "big_house", tonnes: 7,
      en: "Four bedrooms or more",    sw: "Vyumba vinne au zaidi",
      en_d: "A large household, or two trips", sw_d: "Nyumba kubwa, au safari mbili" },
    { key: "shop",      tonnes: 5,
      en: "A shop or an office",      sw: "Duka au ofisi",
      en_d: "Stock, shelves, desks",  sw_d: "Bidhaa, rafu, madawati" },
    { key: "materials", tonnes: 7,
      en: "Building materials",       sw: "Vifaa vya ujenzi",
      en_d: "Sand, cement, blocks, timber", sw_d: "Mchanga, saruji, matofali, mbao" },
  ];

  var BY_KEY = {};
  LOADS.forEach(function (l) { BY_KEY[l.key] = l; });

  function lang() {
    try { return (window.getLang && window.getLang()) === "sw" ? "sw" : "en"; }
    catch (_) { return "en"; }
  }
  function say(row, field) {
    if (!row) return "";
    var k = field === "d" ? (lang() === "sw" ? "sw_d" : "en_d")
                          : (lang() === "sw" ? "sw" : "en");
    return row[k] || row[field === "d" ? "en_d" : "en"] || "";
  }

  function load(key) { return BY_KEY[key] || null; }
  function loadLabel(key) { return say(BY_KEY[key], ""); }
  function loadHint(key) { return say(BY_KEY[key], "d"); }

  /** The smallest truck that does this load in one trip, in tonnes. */
  function loadTonnes(key) {
    var l = BY_KEY[key];
    return l ? l.tonnes : 0;
  }

  // ==========================================================================
  //  DISTANCE
  // ==========================================================================

  var EARTH_KM = 6371;

  function fine(n) { return typeof n === "number" && isFinite(n); }
  function num(n) { return typeof n === "number" ? n : parseFloat(n); }

  /** A point is usable only when BOTH halves are real numbers. */
  function usable(p) { return !!p && fine(num(p.lat)) && fine(num(p.lng)); }

  /** Straight-line km. Ordering only, never shown as a drive. */
  function km(a, b) {
    if (!usable(a) || !usable(b)) return null;
    var toRad = function (d) { return (d * Math.PI) / 180; };
    var dLat = toRad(num(b.lat) - num(a.lat));
    var dLng = toRad(num(b.lng) - num(a.lng));
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(num(a.lat))) * Math.cos(toRad(num(b.lat))) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * EARTH_KM * Math.asin(Math.sqrt(x));
  }

  // A loaded lorry on Tanzanian roads, town and highway averaged. Used only
  // for the "about N min" beside a distance we measured ourselves; the EXACT
  // minutes come from the routing engine whenever it answers.
  var AVG_KMH = 24;
  function driveMin(k) {
    return fine(k) ? Math.max(1, Math.round((k / AVG_KMH) * 60)) : null;
  }

  /** "800 m" / "4.2 km" / "137 km". Never a bare decimal on a long distance. */
  function kmText(k) {
    if (!fine(k)) return "";
    if (k < 1) return Math.round(k * 1000) + " m";
    return (k < 10 ? k.toFixed(1) : String(Math.round(k))) + " km";
  }

  /**
   * Real road km between two points, or null when nothing could measure it.
   * Never falls back to the straight line: a crow-flies number shown as a
   * drive is the lie this whole file exists to avoid.
   */
  async function roadKm(from, to) {
    if (!usable(from) || !usable(to) || !window.pawaRoute) return null;
    try {
      var out = await window.pawaRoute.table(
        { lat: num(from.lat), lng: num(from.lng) },
        [{ lat: num(to.lat), lng: num(to.lng) }]);
      return fine(out && out[0]) ? out[0] : null;
    } catch (_) { return null; }
  }

  /**
   * Road km from one origin to many trucks, in ONE request.
   *
   * @returns {Promise<Map<id, number|null>>} null means "measured, no route",
   *          and an id that is absent was never asked about (no pin).
   */
  async function pickupKm(trucks, origin) {
    var out = new Map();
    if (!usable(origin) || !window.pawaRoute) return out;
    var rows = (trucks || []).filter(function (t) { return usable(t); });
    if (!rows.length) return out;
    // One OSRM table call carries about a hundred destinations comfortably.
    var CHUNK = 90;
    for (var i = 0; i < rows.length; i += CHUNK) {
      var slice = rows.slice(i, i + CHUNK);
      try {
        var kms = await window.pawaRoute.table(
          { lat: num(origin.lat), lng: num(origin.lng) },
          slice.map(function (t) { return { lat: num(t.lat), lng: num(t.lng) }; }));
        slice.forEach(function (t, j) {
          out.set(t.id, fine(kms[j]) ? kms[j] : null);
        });
      } catch (_) {
        slice.forEach(function (t) { out.set(t.id, null); });
      }
    }
    return out;
  }

  // ==========================================================================
  //  FIT
  // ==========================================================================

  // How far each coverage promise reasonably stretches, in km of TRIP (not of
  // deadhead). These are the boundaries of what the owner said, read
  // generously: a "within city" truck asked to do 40 km is a question, not a
  // refusal, which is why the middle answer exists.
  var CITY_KM = 35;
  var CITY_ASK_KM = 70;
  var REGION_KM = 220;
  var REGION_ASK_KM = 400;

  /**
   * Can this truck do this trip?
   *
   * @returns {"covers"|"ask"|"beyond"} "beyond" is reserved for a trip that
   *          clearly exceeds what the owner offered; everything uncertain is
   *          "ask", and a caller must never hide an "ask".
   */
  function coverage(truck, ctx) {
    var area = truck && truck.service_area;
    if (area === "cross_region") return "covers";

    var trip = ctx && fine(ctx.tripKm) ? ctx.tripKm : null;
    var crosses = regionsDiffer(truck, ctx);

    if (area === "region_wide") {
      if (crosses === true) return "ask";
      if (trip == null) return "covers";
      if (trip <= REGION_KM) return "covers";
      if (trip <= REGION_ASK_KM) return "ask";
      return "beyond";
    }
    // within_city, and anything unrecognised, read as the narrowest promise.
    if (crosses === true) return "beyond";
    if (trip == null) return "ask";
    if (trip <= CITY_KM) return "covers";
    if (trip <= CITY_ASK_KM) return "ask";
    return "beyond";
  }

  /**
   * Does the move cross a region boundary?
   * null when we do not know, and null is NOT false: an unknown region must
   * never be the reason a truck is ruled out.
   */
  function regionsDiffer(truck, ctx) {
    var a = truck && truck.region;
    var b = ctx && ctx.toRegion;
    if (!a || !b) return null;
    return String(a).trim().toLowerCase() !== String(b).trim().toLowerCase();
  }

  // Above this multiple of what the load needs, a lorry stops being "big
  // enough" and starts being "more lorry than you are paying for". Two and a
  // half is deliberately loose: a 3-tonne canter for a one-bedroom flat is
  // sensible headroom, a twelve-tonne lorry for the same flat is a bill.
  var ROOMY_MULTIPLE = 2.5;

  /**
   * Is it the right size?
   *
   * Not "is it big enough", which is the question that used to be asked here
   * and is the wrong one. A twelve-tonne lorry is big enough for a bedsitter
   * and scored identically to the canter next to it, so the most expensive
   * vehicle in the result set floated to the top of a small move. Being
   * oversized is a real cost to the customer and it is graded as one.
   *
   * @returns {"fits"|"roomy"|"tight"|"small"|"unknown"} "unknown" when the
   *          listing never stated a capacity, which is common and not a fault.
   */
  function capacity(truck, loadKey) {
    var need = loadTonnes(loadKey);
    if (!need) return "unknown";
    var has = truck && truck.capacity_tonnes != null ? num(truck.capacity_tonnes) : null;
    if (!fine(has) || has <= 0) return "unknown";
    if (has > need * ROOMY_MULTIPLE) return "roomy";
    if (has >= need) return "fits";
    if (has >= need * 0.7) return "tight";
    return "small";
  }

  // ==========================================================================
  //  THE SCORE
  //
  //  Weights, written down rather than buried in an expression, because the
  //  ranking on this screen decides whose phone rings. Every one of them is a
  //  fact the customer would weigh themselves in the same order:
  //
  //    can it do the trip at all   > is it big enough > how far away is it
  //    > does it come with a crew  > what does it cost > is it verified
  //
  //  A missing fact never scores negative. It scores nothing, so a sparse
  //  listing sinks below a complete one without being called unsuitable.
  // ==========================================================================
  var W = {
    coverage: 30,      // covers 30, ask 14, beyond 0
    capacity: 26,      // fits 26, tight 12, unknown 9, small 0
    distance: 24,      // full at 0 km, nothing left at DISTANCE_FLAT km
    crew: 8,           // driver 5 + loaders 3
    price: 8,          // cheapest in the result set gets it all
    verified: 4,
  };
  // Past this, one truck being further than another stops mattering: both are
  // a phone call and a fuel conversation.
  var DISTANCE_FLAT = 60;

  function scoreOne(truck, ctx, aux) {
    var cov = coverage(truck, ctx);
    var cap = capacity(truck, ctx && ctx.load);
    var s = 0;
    s += cov === "covers" ? W.coverage : (cov === "ask" ? W.coverage * 0.47 : 0);
    s += cap === "fits" ? W.capacity
       // Oversized still does the job, so it stays well clear of "too small".
       // It just stops beating the lorry that is the right size for the load.
       : cap === "roomy" ? W.capacity * 0.72
       : cap === "tight" ? W.capacity * 0.46
       : cap === "unknown" ? W.capacity * 0.35 : 0;

    var pk = aux.pickupKm;
    if (fine(pk)) {
      s += W.distance * Math.max(0, 1 - Math.min(pk, DISTANCE_FLAT) / DISTANCE_FLAT);
    } else if (aux.hasOrigin) {
      // We asked and got nothing back. Half marks: it is not the listing's
      // fault that no road was found, and it is not the customer's problem
      // to solve either.
      s += W.distance * 0.3;
    } else {
      // Nobody said where they are. Distance cannot separate anybody, so it
      // separates nobody: every truck gets the same share.
      s += W.distance * 0.5;
    }

    if (truck.driver_included) s += 5;
    if (truck.loaders_included) s += 3;

    var p = num(truck.price_tzs);
    if (fine(p) && p > 0 && fine(aux.cheapest) && aux.cheapest > 0 && fine(aux.dearest)) {
      var span = aux.dearest - aux.cheapest;
      s += span > 0 ? W.price * (1 - (p - aux.cheapest) / span) : W.price;
    }
    if (truck.verified) s += W.verified;

    return { score: Math.round(Math.min(100, s)), coverage: cov, capacity: cap };
  }

  /**
   * Rank trucks for one move.
   *
   * @param {Array}  trucks  rows as DataStore.getTrucks() returns them
   * @param {object} ctx
   *   ctx.from     {lat,lng}   where the load is now (optional)
   *   ctx.to       {lat,lng}   the new home (optional)
   *   ctx.toRegion string      the new home's region, for the coverage read
   *   ctx.load     string      a LOADS key (optional)
   *   ctx.tripKm   number      road km of the move itself, when measured
   *   ctx.roadKm   Map         id -> km|null, from pickupKm() (optional)
   * @returns {Array} a NEW array of NEW objects. The input rows are never
   *   touched: `trucks` is the page's cache and a `_score` written onto it
   *   would survive the next filter change and quietly rank a stale move.
   */
  function rank(trucks, ctx) {
    var c = ctx || {};
    var rows = Array.isArray(trucks) ? trucks : [];
    var hasOrigin = usable(c.from);
    var measured = c.roadKm instanceof Map ? c.roadKm : new Map();

    var prices = rows.map(function (t) { return num(t.price_tzs); })
                     .filter(function (p) { return fine(p) && p > 0; });
    var aux0 = {
      cheapest: prices.length ? Math.min.apply(null, prices) : null,
      dearest: prices.length ? Math.max.apply(null, prices) : null,
      hasOrigin: hasOrigin,
    };

    var out = rows.map(function (t) {
      var road = measured.has(t.id) ? measured.get(t.id) : undefined;
      var direct = hasOrigin ? km(c.from, t) : null;
      // The road figure when we have one; the straight line ONLY for ordering.
      var pk = fine(road) ? road : null;
      var aux = {
        cheapest: aux0.cheapest, dearest: aux0.dearest, hasOrigin: hasOrigin,
        pickupKm: fine(pk) ? pk : (fine(direct) ? direct : null),
      };
      var f = scoreOne(t, c, aux);
      return Object.assign({}, t, {
        _pickupKm: fine(pk) ? pk : null,          // real road, or nothing
        _directKm: fine(direct) ? direct : null,  // ordering only
        _pickupPending: hasOrigin && road === undefined && usable(t),
        _score: f.score,
        _coverage: f.coverage,
        _capacity: f.capacity,
      });
    });

    out.sort(function (a, b) {
      if (b._score !== a._score) return b._score - a._score;
      var ak = fine(a._pickupKm) ? a._pickupKm : (fine(a._directKm) ? a._directKm : Infinity);
      var bk = fine(b._pickupKm) ? b._pickupKm : (fine(b._directKm) ? b._directKm : Infinity);
      if (ak !== bk) return ak - bk;
      return (num(a.price_tzs) || 1e15) - (num(b.price_tzs) || 1e15);
    });

    // Superlatives, awarded once each across the whole result set. They are
    // what let a card say "closest to you" instead of "rank 1 of 34", which is
    // a number about our sorting rather than about their move.
    //
    // A superlative needs something to be superlative AMONG. The detail sheet
    // ranks exactly one lorry, and it was being told it was the cheapest here
    // and the biggest here, both true of a set of one and both meaningless to
    // read. Three is the smallest number where "the cheapest of these" is
    // information rather than a restatement, and two is the smallest where
    // "best match" is a choice rather than the only row.
    if (out.length >= 3) {
      mark(out, "_closest", function (t) {
        var k = fine(t._pickupKm) ? t._pickupKm : (fine(t._directKm) ? t._directKm : null);
        return fine(k) ? k : null;
      }, "min");
      mark(out, "_cheapest", function (t) {
        var p = num(t.price_tzs); return fine(p) && p > 0 ? p : null;
      }, "min");
      mark(out, "_biggest", function (t) {
        var v = num(t.capacity_tonnes); return fine(v) && v > 0 ? v : null;
      }, "max");
    }
    if (out.length >= 2) out[0]._best = true;

    return out;
  }

  /** Flag the single row with the smallest (or largest) value of `pick`. */
  function mark(rows, flag, pick, dir) {
    var bestRow = null, bestVal = null;
    rows.forEach(function (r) {
      var v = pick(r);
      if (v == null) return;
      if (bestVal == null || (dir === "max" ? v > bestVal : v < bestVal)) {
        bestVal = v; bestRow = r;
      }
    });
    if (bestRow) bestRow[flag] = true;
  }

  // ==========================================================================
  //  CARRYING A MOVE BETWEEN PAGES
  //
  //  The house sheet starts the move and trucks.html finishes it. Everything
  //  needed to rebuild the plan rides in the query string, so the second page
  //  never asks a question the first one already asked. Coordinates are
  //  rounded to six decimals (about 11 cm) because more is noise in a URL
  //  somebody might paste to a friend.
  // ==========================================================================

  function encode(ctx) {
    var c = ctx || {}, q = [];
    if (usable(c.to)) q.push("to=" + num(c.to.lat).toFixed(6) + "," + num(c.to.lng).toFixed(6));
    if (usable(c.from)) q.push("from=" + num(c.from.lat).toFixed(6) + "," + num(c.from.lng).toFixed(6));
    if (c.load && BY_KEY[c.load]) q.push("load=" + encodeURIComponent(c.load));
    if (c.house) q.push("house=" + encodeURIComponent(c.house));
    if (c.toLabel) q.push("toName=" + encodeURIComponent(String(c.toLabel).slice(0, 80)));
    if (c.toRegion) q.push("toRegion=" + encodeURIComponent(String(c.toRegion).slice(0, 60)));
    return q.join("&");
  }

  /** "lat,lng" -> {lat,lng}, or null for anything that is not both. */
  function point(s) {
    var parts = String(s == null ? "" : s).split(",");
    if (parts.length !== 2) return null;
    var p = { lat: parseFloat(parts[0]), lng: parseFloat(parts[1]) };
    return usable(p) ? p : null;
  }

  function decode(search) {
    var q = new URLSearchParams(search == null ? location.search : search);
    var loadKey = q.get("load");
    return {
      to: point(q.get("to")),
      from: point(q.get("from")),
      load: loadKey && BY_KEY[loadKey] ? loadKey : null,
      house: q.get("house") || null,
      toLabel: q.get("toName") || null,
      toRegion: q.get("toRegion") || null,
      tripKm: null,
    };
  }

  window.TruckMove = {
    LOADS: LOADS,
    load: load,
    loadLabel: loadLabel,
    loadHint: loadHint,
    loadTonnes: loadTonnes,
    km: km,
    kmText: kmText,
    driveMin: driveMin,
    roadKm: roadKm,
    pickupKm: pickupKm,
    coverage: coverage,
    capacity: capacity,
    regionsDiffer: regionsDiffer,
    rank: rank,
    encode: encode,
    decode: decode,
    point: point,
    usable: usable,
    AVG_KMH: AVG_KMH,
  };
})();
