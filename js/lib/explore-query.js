/* ===========================================================================
 * explore-query.js — turning "chumba cha 200k Mwanza" into a search.
 *
 * Explore searches four catalogues at once, so before anything can be ranked
 * something has to decide WHICH catalogue the person meant. That decision is
 * this file, and it is deliberately not a classifier with a threshold: it
 * scores every vertical and returns them all with a weight, because "cleaning"
 * is genuinely both a service and a job, and picking one would be a guess
 * dressed up as an answer.
 *
 * THE RULE THAT MATTERS
 *   No evidence for any vertical → search ALL of them. An empty query is not
 *   a failure to understand; it is someone browsing. That is the whole point
 *   of a global view, and it is why this never returns "no domain".
 *
 * BILINGUAL BY CONSTRUCTION
 *   Every cue list carries the English and the Swahili together, in the same
 *   array, because a Tanzanian search box gets both in the same sentence
 *   ("nyumba for rent Mbezi"). Splitting them into two dictionaries would
 *   mean choosing a language before reading the query — exactly backwards.
 *
 * WHAT THIS IS NOT
 *   Not an AI parser. js/lib/ai-search.js exists and is better at long
 *   sentences, but it needs a key, a deployed function and a network round
 *   trip. This runs in under a millisecond, offline, every keystroke — and it
 *   is the floor the AI pass upgrades from, never the other way round.
 * =========================================================================== */
(function () {
  "use strict";

  // ---- Money ----------------------------------------------------------------
  // Longest suffixes first, plus a "not followed by a letter" guard so the "b"
  // in "bedroom" is never read as billions. Same contract as houses.js.
  var MONEY_RE = "([\\d][\\d.,]*)\\s*(billion|bn|b|million|mil|m|elfu|thousand|k)?(?![a-z])";
  var MULT = {
    k: 1e3, elfu: 1e3, thousand: 1e3,
    m: 1e6, mil: 1e6, million: 1e6,
    b: 1e9, bn: 1e9, billion: 1e9,
  };

  function parseMoney(digits, suffix) {
    var n = parseFloat(String(digits || "").replace(/,/g, ""));
    if (!isFinite(n)) return null;
    return Math.round(n * (MULT[(suffix || "").toLowerCase()] || 1));
  }

  // A figure is a price if it carries a magnitude suffix ("300k") or is simply
  // too big to be anything else. The 50,000 floor is the same one the bare-
  // figure branch uses: below it, a number in a Tanzanian property search is
  // far more likely to be a bedroom count, a tonnage or a year.
  function looksLikeMoney(suffix, value) {
    return !!suffix || value >= 50000;
  }

  function parsePrice(raw) {
    var text = " " + String(raw || "").toLowerCase().replace(/\s+/g, " ") + " ";
    var out = { priceMin: null, priceMax: null }, m;
    var UNDER = "(?:under|below|max|up to|upto|less than|within|maximum of?|budget of?|chini ya|hadi|isiyozidi)";
    var OVER  = "(?:over|above|from|min|at least|minimum of?|starting at|zaidi ya|kuanzia)";

    if ((m = text.match(new RegExp(UNDER + "\\s*(?:tzs|tsh|sh)?\\s*" + MONEY_RE)))) out.priceMax = parseMoney(m[1], m[2]);
    if ((m = text.match(new RegExp(OVER  + "\\s*(?:tzs|tsh|sh)?\\s*" + MONEY_RE)))) out.priceMin = parseMoney(m[1], m[2]);

    // Ranges. "and" / "na" have to be accepted as separators because "between
    // 200k and 400k" is how people write it — but they are also what joins
    // "3 bedroom and 2 bathroom", which would otherwise parse as the range
    // 2–3. So both sides must look like money (a magnitude suffix, or a figure
    // too large to be a room count) before this is believed.
    if (out.priceMin == null && out.priceMax == null) {
      var r = text.match(new RegExp(MONEY_RE + "\\s*(?:-|–|—|to|hadi|and|na)\\s*" + MONEY_RE));
      if (r) {
        var a = parseMoney(r[1], r[2]), b = parseMoney(r[3], r[4]);
        if (a != null && b != null && looksLikeMoney(r[2], a) && looksLikeMoney(r[4], b)) {
          out.priceMin = Math.min(a, b);
          out.priceMax = Math.max(a, b);
        }
      }
    }
    // A bare figure is a budget ceiling — that is how people type. Unsuffixed
    // small integers are skipped so "3" (bedrooms) never becomes a price.
    if (out.priceMin == null && out.priceMax == null) {
      var all = text.match(new RegExp(MONEY_RE, "g")) || [];
      for (var i = 0; i < all.length; i++) {
        var one = all[i].match(new RegExp(MONEY_RE));
        if (!one) continue;
        var sfx = (one[2] || "").toLowerCase(), val = parseMoney(one[1], one[2]);
        if (val != null && (sfx || val >= 50000)) { out.priceMax = val; break; }
      }
    }
    return out;
  }

  // ---- Domain cues ----------------------------------------------------------
  // Weight reflects how *exclusive* a word is, not how common. "lori" can only
  // mean a truck, so it is a 3. "moving" often appears in a room search ("moving
  // in June"), so it is a 1 and needs company to win.
  var CUES = {
    room: [
      [3, /\b(chumba|vyumba|nyumba|room|rooms|bedroom|bedrooms|apartment|flat|studio|house|villa|bungalow)\b/],
      [3, /\b(kiwanja|viwanja|plot|land|shamba)\b/],
      [2, /\b(ofisi|office|duka|shop|godown|warehouse|frame|kibanda|stall)\b/],
      [2, /\b(kupanga|pangisha|kupangisha|for rent|to rent|rental|renting|lease)\b/],
      [2, /\b(kuuza|kununua|for sale|to buy|buying)\b/],
      [2, /\b(master|self[-\s]?contained|self\s?contain|en[-\s]?suite)\b/],
      [1, /\b(bed|beds|br|bdrm|makazi|accommodation|hostel)\b/],
    ],
    truck: [
      [3, /\b(lori|malori|canter|kanta|pickup|pick[-\s]?up|truck|trucks|lorry|fuso)\b/],
      [3, /\b(gari la mizigo|magari ya mizigo)\b/],
      [2, /\b(kuhamisha|kuhama|kubeba mizigo|mizigo|haulage|freight|cargo)\b/],
      [2, /\b(tonne|tonnes|ton|tani)\b/],
      [1, /\b(moving|move|transport|usafirishaji|delivery)\b/],
    ],
    service: [
      [3, /\b(fundi|mafundi|seremala|dobi|yaya|mlinzi|mpishi|kinyozi)\b/],
      [3, /\b(plumber|plumbing|electrician|electrical|carpenter|carpentry|painter|painting)\b/],
      [3, /\b(cleaner|cleaning|usafi|kusafisha|laundry|gardener|gardening|bustani)\b/],
      [2, /\b(tutor|tutoring|mwalimu|nanny|childcare|babysitter|security|ulinzi|guard)\b/],
      [2, /\b(repair|kutengeneza|technician|appliance|salon|saluni|beauty|urembo)\b/],
      [2, /\b(huduma|service|services)\b/],
      [1, /\b(mabomba|umeme|rangi|mbao)\b/],
    ],
    job: [
      [3, /\b(kazi|ajira|vibarua|kibarua|employment)\b/],
      [3, /\b(day job|day jobs|casual work|hiring|vacancy|vacancies)\b/],
      [2, /\b(job|jobs|work|worker|workers|wafanyakazi|nataka kazi)\b/],
      [1, /\b(pay|malipo|mshahara|daily pay)\b/],
    ],
  };

  // Words that flip a shared cue. "cleaning job" is a job even though
  // "cleaning" is a strong service cue, and "I need a cleaner" is a service
  // even though "need" smells like hiring. Applied after scoring, as a nudge,
  // never as an override — a query naming both really does mean both.
  var TIEBREAK = [
    { re: /\b(job|jobs|kazi|vibarua|ajira|hiring|vacancy)\b/, boost: { job: 2 } },
    { re: /\b(i need|nataka|nahitaji|looking for|natafuta|hire|kukodi)\b/, boost: { service: 1, room: 1, truck: 1 } },
  ];

  function scoreDomains(text) {
    var out = { room: 0, truck: 0, service: 0, job: 0 };
    Object.keys(CUES).forEach(function (k) {
      CUES[k].forEach(function (rule) { if (rule[1].test(text)) out[k] += rule[0]; });
    });
    TIEBREAK.forEach(function (t) {
      if (!t.re.test(text)) return;
      Object.keys(t.boost).forEach(function (k) { if (out[k] > 0) out[k] += t.boost[k]; });
    });
    return out;
  }

  // ---- Places ---------------------------------------------------------------
  // The gazetteer knows regions, universities and landmarks. Matching against
  // it here means "Mwanza" or "UDSM" becomes a map anchor rather than four
  // characters the text scorer happens to like.
  function findPlace(text) {
    if (typeof window.resolveTzPlace === "function") {
      var hit = window.resolveTzPlace(text);
      if (hit) return { name: hit.name, lat: hit.lat, lng: hit.lng, kind: hit.kind || "place", source: "gazetteer" };
    }
    return null;
  }

  var NEAR_ME = /\b(near me|nearby|around me|close to me|karibu nami|karibu na mimi|jirani|hapa karibu)\b/;

  // ---- Facets ---------------------------------------------------------------
  function parseFacets(text) {
    var f = {}, m;

    if (/\b(for sale|to buy|buying|purchase|kuuza|kununua)\b/.test(text)) f.listing = "sale";
    else if (/\b(for rent|to rent|renting|rental|lease|kupanga|pangisha)\b/.test(text)) f.listing = "rent";

    if (/\b(master|self[-\s]?contained|self\s?contain|en[-\s]?suite)\b/.test(text)) f.roomKind = "master";
    else if (/\b(single\s*room|chumba\s*kimoja)\b/.test(text)) f.roomKind = "single";

    if (/\b(apartment|apartments|flat|condo)\b/.test(text)) f.type = "apartment";
    else if (/\b(villa|bungalow)\b/.test(text)) f.type = "house";
    else if (/\b(nyumba|house|home)\b/.test(text)) f.type = "house";
    else if (/\b(plot|land|kiwanja|shamba)\b/.test(text)) f.type = "plot";
    else if (/\b(shop|duka|retail|stall|kibanda|frame)\b/.test(text)) f.type = "shop";
    else if (/\b(office|ofisi)\b/.test(text)) f.type = "office";
    else if (/\b(godown|warehouse|ghala)\b/.test(text)) f.type = "warehouse";

    if ((m = text.match(/(\d+)\s*(?:\+\s*)?(?:bed|bedroom|bedrooms|br|bdr|chumba|vyumba)\b/))) {
      f.bedrooms = parseInt(m[1], 10);
    }
    if (/\bstudio\b/.test(text)) { f.type = f.type || "apartment"; if (f.bedrooms == null) f.bedrooms = 0; }

    if ((m = text.match(/(\d+(?:\.\d+)?)\s*(?:tonne|tonnes|ton|tons|tani)\b/))) {
      f.capacityT = parseFloat(m[1]);
    }
    if (/\b(canter|kanta)\b/.test(text)) f.truckType = "canter";
    else if (/\bpick[-\s]?up\b/.test(text)) f.truckType = "pickup";
    else if (/\b(lorry|fuso|lori)\b/.test(text)) f.truckType = "lorry";

    // Service category, keyed off the same synonym set the index folds in.
    var CAT = [
      ["cleaning", /\b(cleaning|cleaner|usafi|kusafisha|maid|dada wa kazi)\b/],
      ["plumbing", /\b(plumb\w*|mabomba|bomba|fundi maji)\b/],
      ["electrical", /\b(electric\w*|umeme|wiring)\b/],
      ["carpentry", /\b(carpent\w*|seremala|useremala|fundi mbao)\b/],
      ["painting", /\b(paint\w*|rangi)\b/],
      ["gardening", /\b(garden\w*|bustani|landscap\w*)\b/],
      ["moving_help", /\b(loaders|wapakiaji|movers|porter|kupakia)\b/],
      ["laundry", /\b(laundry|dobi|kufua)\b/],
      ["cooking", /\b(cook\w*|mpishi|kupika|chef|catering)\b/],
      ["tutoring", /\b(tutor\w*|mwalimu|tuition|masomo)\b/],
      ["beauty", /\b(salon|saluni|beauty|urembo|kinyozi|barber)\b/],
      ["security", /\b(security|ulinzi|mlinzi|guard|askari)\b/],
      ["childcare", /\b(childcare|yaya|nanny|babysit\w*)\b/],
      ["appliance_repair", /\b(appliance|friji|fridge|repair|kutengeneza|technician)\b/],
    ];
    for (var i = 0; i < CAT.length; i++) {
      if (CAT[i][1].test(text)) { f.category = CAT[i][0]; break; }
    }
    return f;
  }

  // ---- Stop words -----------------------------------------------------------
  // Removed before the free-text terms are handed to the ranker: they match
  // everything, so they only add noise to a relevance score. The intent they
  // carried has already been extracted into facets above.
  var STOP = new RegExp("\\b(" + [
    "a", "an", "the", "in", "at", "on", "for", "of", "to", "with", "and", "or",
    "near", "me", "my", "i", "we", "want", "need", "looking", "find", "get",
    "some", "any", "please", "around", "close", "by",
    "na", "ya", "wa", "la", "kwa", "ni", "cha", "za", "katika", "karibu",
    "nataka", "nahitaji", "natafuta", "tafuta", "mimi",
    "under", "below", "over", "above", "from", "up", "upto", "less", "than",
    "chini", "zaidi", "hadi", "kuanzia",
    "tzs", "tsh", "sh", "shillings",
  ].join("|") + ")\\b", "g");

  function freeTerms(text, placeName) {
    var t = text;
    if (placeName) t = t.replace(new RegExp(placeName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), " ");
    return t
      .replace(NEAR_ME, " ")
      .replace(STOP, " ")
      .replace(/\b\d[\d.,]*\s*(billion|bn|b|million|mil|m|elfu|thousand|k)?\b/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(function (w) { return w.length >= 2; })
      .slice(0, 12);                 // a 40-word essay is not 40 signals
  }

  // ---- The parse ------------------------------------------------------------
  /**
   * @param {string} raw            what the user typed
   * @param {object} [ctx]          { scope } — a chip the user pinned, which
   *                                overrides the inferred domains entirely
   * @returns {object} Intent
   */
  function parse(raw, ctx) {
    ctx = ctx || {};
    var text = " " + String(raw || "").toLowerCase().replace(/\s+/g, " ").trim() + " ";
    var domains = scoreDomains(text);
    var top = Math.max(domains.room, domains.truck, domains.service, domains.job);

    // Which verticals to search, and how much each is trusted. A vertical
    // scoring within half the leader stays in — that is what keeps "cleaning"
    // returning both the service and the job.
    var kinds, weights = {};
    if (ctx.scope && ctx.scope !== "all") {
      kinds = [ctx.scope];
      weights[ctx.scope] = 1;
    } else if (top === 0) {
      kinds = ["room", "truck", "service", "job"];
      kinds.forEach(function (k) { weights[k] = 1; });     // browsing: all equal
    } else {
      kinds = [];
      Object.keys(domains).forEach(function (k) {
        if (domains[k] >= top * 0.5 && domains[k] > 0) {
          kinds.push(k);
          weights[k] = domains[k] / top;
        }
      });
    }

    var place = findPlace(String(raw || ""));
    var price = parsePrice(raw);

    return {
      raw: String(raw || "").trim(),
      text: text.trim(),
      kinds: kinds,
      kindWeights: weights,
      domainScores: domains,
      confident: top >= 3,              // a strong, unambiguous cue was present
      nearMe: NEAR_ME.test(text),
      place: place,
      priceMin: price.priceMin,
      priceMax: price.priceMax,
      facets: parseFacets(text),
      terms: freeTerms(text, place && place.name),
      isEmpty: !String(raw || "").trim(),
    };
  }

  window.ExploreQuery = {
    parse: parse,
    parsePrice: parsePrice,
    parseMoney: parseMoney,
    scoreDomains: scoreDomains,
    freeTerms: freeTerms,
  };
})();
