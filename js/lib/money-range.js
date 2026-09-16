// ============================================================================
//  money-range.js — a typed budget phrase becomes { priceMin, priceMax } in TZS.
//
//  WHY THIS IS ITS OWN FILE.
//
//  Two parsers existed. js/lib/explore-query.js had this one; js/pages/houses.js
//  had an older copy, and docs/EXPLORE.md already named the drift in passing
//  ("houses.js has its own older copy of this parser that still has the
//  `between … and …` gap"). Two things had gone wrong in the copy, and both
//  were wrong answers rather than missing ones:
//
//   1. IT WAS ENGLISH ONLY. "chini ya 500k" is how half this app's users write
//      a budget, and on the houses directory — the main catalogue — it matched
//      nothing, so the phrase was dropped and every price was shown. The same
//      words worked on Explore. A bilingual app with a monolingual parser is
//      not bilingual on the screen that matters most.
//
//   2. "between 200k and 400k" SILENTLY BECAME "under 200k". The copy accepted
//      -, –, — and "to" as range separators but not "and"/"na", so the range
//      never matched, and the bare-figure rule below then took the FIRST
//      number as a ceiling. Somebody asking for 200k–400k was shown only what
//      was under 200k, with nothing on screen to say so.
//
//  So the parser lives here, once, and both callers use it.
//
//  THE TRAP THAT SHAPES THE CODE: "and" / "na" have to be accepted, because
//  "between 200k and 400k" is how people write it. But they are also what
//  joins "3 bedroom and 2 bathroom", which would otherwise parse as the range
//  2–3. That is why both sides must LOOK like money — carry a magnitude
//  suffix, or clear 50,000 — before a range is believed.
// ============================================================================

(function () {
  "use strict";

  // Longest suffixes first, and a "not followed by a letter" guard so the "b"
  // in "bedroom" (or the "m" in "modern") is never read as billions/millions.
  // "elfu" is Swahili for thousand and belongs here for the same reason the
  // bound words below do. It was in the Explore copy and NOT in the houses
  // one, which is the drift this file exists to end.
  var MONEY_RE = "([\\d][\\d.,]*)\\s*(billion|bn|b|million|mil|m|elfu|thousand|k)?(?![a-z])";

  var MULT = {
    billion: 1e9, bn: 1e9, b: 1e9,
    million: 1e6, mil: 1e6, m: 1e6,
    thousand: 1e3, elfu: 1e3, k: 1e3,
  };

  function parseMoney(numStr, suffix) {
    if (numStr == null) return null;
    var n = parseFloat(String(numStr).replace(/,/g, ""));
    if (!isFinite(n)) return null;
    var s = (suffix || "").toLowerCase();
    return Math.round(n * (MULT[s] || 1));
  }

  // A figure is money if it was written with a magnitude, or if it is too large
  // to be a room count, a bathroom count or a tonnage.
  function looksLikeMoney(suffix, value) {
    return !!(suffix || (value != null && value >= 50000));
  }

  // Both languages, on purpose. Swahili is not a later addition here: it is
  // half the reason the file exists.
  var UNDER = "(?:under|below|max|up to|upto|less than|within|maximum of?|budget of?" +
              "|chini ya|hadi|isiyozidi)";
  var OVER  = "(?:over|above|from|min|at least|minimum of?|starting at" +
              "|zaidi ya|kuanzia)";

  /**
   * @param {string} raw  what the person typed
   * @returns {{priceMin: number|null, priceMax: number|null}} TZS, or nulls
   */
  function parse(raw) {
    var text = " " + String(raw || "").toLowerCase().replace(/\s+/g, " ") + " ";
    var out = { priceMin: null, priceMax: null }, m;

    // A RANGE IS TRIED FIRST, and the reason is "hadi". It means "up to", so it
    // belongs in UNDER below — but it is also how a range is spoken, and
    // "300k hadi 600k" read by UNDER first becomes a bare ceiling of 600k with
    // the 300k floor thrown away. A range needs money on BOTH sides, which a
    // phrase like "chini ya 500k" or "hadi 300k" can never have, so trying it
    // first costs those nothing.
    var r = text.match(new RegExp(MONEY_RE + "\\s*(?:-|–|—|to|hadi|and|na)\\s*" + MONEY_RE));
    if (r) {
      var a = parseMoney(r[1], r[2]), b = parseMoney(r[3], r[4]);
      if (a != null && b != null && looksLikeMoney(r[2], a) && looksLikeMoney(r[4], b)) {
        out.priceMin = Math.min(a, b);
        out.priceMax = Math.max(a, b);
      }
    }

    if (out.priceMin == null && out.priceMax == null) {
      if ((m = text.match(new RegExp(UNDER + "\\s*(?:tzs|tsh|sh)?\\s*" + MONEY_RE)))) {
        out.priceMax = parseMoney(m[1], m[2]);
      }
      if ((m = text.match(new RegExp(OVER + "\\s*(?:tzs|tsh|sh)?\\s*" + MONEY_RE)))) {
        out.priceMin = parseMoney(m[1], m[2]);
      }
    }

    // A bare figure is a budget ceiling, because that is how people type.
    // Unsuffixed small integers are skipped so "3" (bedrooms) never becomes a
    // price.
    if (out.priceMin == null && out.priceMax == null) {
      var all = text.match(new RegExp(MONEY_RE, "g")) || [];
      for (var i = 0; i < all.length; i++) {
        var one = all[i].match(new RegExp(MONEY_RE));
        if (!one) continue;
        var sfx = (one[2] || "").toLowerCase(), val = parseMoney(one[1], one[2]);
        if (val != null && looksLikeMoney(sfx, val)) { out.priceMax = val; break; }
      }
    }
    return out;
  }

  window.MoneyRange = {
    parse: parse,
    parseMoney: parseMoney,
    looksLikeMoney: looksLikeMoney,
    MONEY_RE: MONEY_RE,
  };
})();
