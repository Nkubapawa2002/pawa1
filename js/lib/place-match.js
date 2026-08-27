// ============================================================================
//  place-match.js — the reasoning layer between what somebody TYPES and the
//  places this app knows about.
//
//  THE PROBLEM THIS EXISTS TO FIX
//  Every "search a place" box in this app used to hand the raw string straight
//  to LocationIQ and believe whatever came back. Four things go wrong with that,
//  and all four are reproducible against the live geocoder today:
//
//    1. IT DOES NOT KNOW THE PLACE.  q="Mwalimu Nyerere Memorial Academy"
//       answers {"error":"Unable to geocode"} — a real university our own
//       gazetteer has had coordinates for all along.
//    2. IT ANSWERS CONFIDENTLY AND WRONGLY.  q="Mwl Nyerere University" returns
//       exactly one row: "Taasisi ya Mwl. Nyerere, Tabora" — 800 km from the
//       Dar es Salaam campus the person meant. One row is not "no match", so
//       every fallback downstream was skipped and the map moved to Tabora.
//    3. IT HAS NO SPELLING TOLERANCE AT ALL.  q="Mikoceni" (one letter) → no
//       match. In a country where place names are transliterated several ways
//       and typed on a phone keyboard, that is most of the traffic.
//    4. IT IS THE SLOW PATH FOR ANSWERS WE ALREADY HAVE.  A lookup is up to
//       three SEQUENTIAL round trips (calls held 550 ms apart, 8 s timeout,
//       three retries on 429) before the box shows anything — to find a mall
//       whose coordinates are in a const array two files away.
//
//  WHAT THIS FILE DOES INSTEAD
//  It scores the typed string against the local gazetteer (tz-places.js) with
//  no network at all, so the places we know are answered in microseconds and
//  the geocoder is only ever asked about the ones we don't. The scoring is
//  built to survive how people actually type:
//
//    · ABBREVIATIONS       "mwl" → mwalimu, "muhim" → Muhimbili, because a
//                          short token that is a subsequence of a name token
//                          scores as a match rather than as noise.
//    · MISSPELLINGS        "unuversity", "Mikoceni" — bounded Optimal String
//                          Alignment distance (Levenshtein + transposition),
//                          with the allowance scaled to the word's length so a
//                          4-letter word cannot mutate into a different one.
//    · SWAHILI / ENGLISH   "chuo kikuu" == university, "uwanja wa ndege" ==
//                          airport, "hospitali" == hospital, and academy /
//                          college / institute / campus all count as each other
//                          — which is the whole reason a search for "Mwalimu
//                          Nyerere University" must find an *Academy*.
//    · FILLER              "my", "kwa", "karibu na", "near" carry no location
//                          and are dropped before scoring.
//    · WORD IMPORTANCE     tokens are weighted by how RARE they are in the
//                          gazetteer (an IDF weight). "nyerere" appears twice
//                          and decides the answer; "university" appears in
//                          thirty names and decides almost nothing. Without
//                          this, "Mwalimu Nyerere University" matched every
//                          university in the country about equally.
//    · WHERE YOU ARE       an optional `near` point breaks near-ties toward the
//                          closer place, capped so it can never overturn a real
//                          difference in name match. This is what keeps the Dar
//                          campus above the Tabora institute for a Dar listing.
//
//  WHAT IT DELIBERATELY DOES NOT DO
//  It never invents coordinates and it never touches the network. A caller that
//  acts on a result with nobody watching must still check `score` — a 0.42 is a
//  guess at a word the user did not type, and this file says so rather than
//  quietly rounding it up to an answer.
//
//  Consumed by: js/lib/tz-places.js (resolveTzPlace / closestTzPlaces),
//  js/lib/geo.js (suggest), js/pages/house.js (the commute box).
//  Pure and side-effect free — tests/place_match_test.mjs drives it directly.
// ============================================================================
(function () {
  "use strict";

  // ---- confidence bars, named once so every caller means the same thing ----
  // STRONG: safe to act on unattended (move a map, measure a route).
  // OFFER:  worth showing a person as "did you mean", never acted on alone.
  const STRONG = 0.82;
  const OFFER = 0.42;

  // Words that are pure grammar or pure direction. They are dropped from the
  // QUERY only — a name keeps every word it has, because an unmatched name word
  // costs nothing while an unmatched query word costs a lot.
  const FILLER = new Set([
    "the", "a", "an", "of", "and", "or", "to", "at", "in", "on", "for", "my",
    "our", "me", "is", "this", "near", "nearby", "next", "beside", "around",
    "close", "by", "from",
    // Swahili connectives and the "over by the…" words people type in an address
    "ya", "wa", "cha", "za", "la", "na", "kwa", "kwenye", "karibu", "hapo",
    "pale", "eneo", "mtaa", "upande", "hadi", "toka", "mpaka",
  ]);

  // Multi-word forms that mean one thing. Applied before tokenising so the
  // pieces never get scored separately ("ndege" on its own is a bird).
  const PHRASES = [
    [/\bchuo kikuu (cha|ya)\b/g, "university"],
    [/\bchuo kikuu\b/g, "university"],
    [/\buwanja wa ndege\b/g, "airport"],
    [/\bkituo cha mabasi\b/g, "bus station"],
    [/\bstendi ya mabasi\b/g, "bus station"],
    [/\bshule ya sekondari\b/g, "secondary school"],
    [/\bshule ya msingi\b/g, "primary school"],
    [/\bhospitali ya\b/g, "hospital"],
    [/\bkituo cha afya\b/g, "clinic"],
  ];

  // Single tokens that are simply another spelling of a word the gazetteer uses.
  // Kept deliberately short: anything that could plausibly BE a place name
  // ("dar", "mji") is left alone and handled by ordinary matching instead.
  const TOKEN_SYNONYM = {
    mwl: "mwalimu", mwalim: "mwalimu",
    uni: "university", univ: "university", varsity: "university",
    chuo: "university", vyuo: "university",
    hosp: "hospital", hospitali: "hospital",
    soko: "market", masoko: "market",
    shule: "school", skuli: "school",
    stesheni: "station", stendi: "station", stn: "station",
    sec: "secondary", pri: "primary",
    intl: "international",
    uwanja: "stadium",
    dsm: "dar",
  };

  // Words that are different names for the same KIND of place. Matching across
  // a group scores below an exact word match but far above nothing, which is
  // what lets "Mwalimu Nyerere University" land on "…Memorial Academy".
  const CLASS_GROUPS = [
    ["university", "college", "institute", "academy", "campus", "polytechnic", "school"],
    ["hospital", "clinic", "medical", "dispensary"],
    ["market", "marketplace", "mall", "shopping"],
    ["airport", "aerodrome", "airfield"],
    ["stadium", "ground", "arena"],
    ["terminal", "station", "stand", "depot", "ferry"],
  ];
  const CLASS_OF = (function () {
    const m = new Map();
    CLASS_GROUPS.forEach((g, i) => g.forEach((w) => { if (!m.has(w)) m.set(w, i); }));
    return m;
  })();
  const CLASS_SIM = 0.72;

  // ---- text ----------------------------------------------------------------
  function normalize(s) {
    return String(s == null ? "" : s)
      .normalize("NFD").replace(/[̀-ͯ]/g, "")   // drop accents
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function expand(s) {
    let t = normalize(s);
    for (const pair of PHRASES) t = t.replace(pair[0], pair[1]);
    return t.replace(/\s+/g, " ").trim();
  }

  // Query → the tokens we actually score with. Filler out, synonyms in. If the
  // filter empties the query ("kwa"), keep the raw tokens: a person who typed
  // only grammar still deserves the best guess we have.
  function queryTokens(q) {
    const raw = expand(q).split(" ").filter(Boolean);
    const kept = raw.filter((w) => !FILLER.has(w) && w.length > 1);
    return (kept.length ? kept : raw).map((w) => TOKEN_SYNONYM[w] || w);
  }

  // Name → tokens. Names keep their filler (it is free) but lose 1-char noise.
  function nameTokens(s) {
    return expand(s).split(" ").filter((w) => w.length > 1)
      .map((w) => TOKEN_SYNONYM[w] || w);
  }

  // ---- edit distance -------------------------------------------------------
  // Optimal String Alignment: Levenshtein plus adjacent transposition, so
  // "Mikoecni" costs 1 and not 2. Bails out as soon as an entire row exceeds
  // `max`, which keeps it cheap over a few hundred names.
  function osaDistance(a, b, max) {
    if (a === b) return 0;
    if (max == null) max = Math.max(a.length, b.length);
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const n = b.length;
    let two = null;                       // row i-2
    let one = new Array(n + 1);           // row i-1
    for (let j = 0; j <= n; j++) one[j] = j;
    for (let i = 1; i <= a.length; i++) {
      const row = new Array(n + 1);
      row[0] = i;
      let rowBest = row[0];
      for (let j = 1; j <= n; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        let v = Math.min(one[j] + 1, row[j - 1] + 1, one[j - 1] + cost);
        if (i > 1 && j > 1 &&
            a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
            a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
          v = Math.min(v, two[j - 2] + 1);
        }
        row[j] = v;
        if (v < rowBest) rowBest = v;
      }
      if (rowBest > max) return max + 1;
      two = one; one = row;
    }
    return one[n];
  }

  // How many edits a word of this length may be wrong by. Short words get
  // almost none: at distance 2, "Sinza" and "Simiyu" would be the same word.
  function editBudget(len) { return len <= 4 ? 1 : len <= 7 ? 2 : 3; }

  const BIGRAM_CACHE = new Map();
  function bigrams(s) {
    let m = BIGRAM_CACHE.get(s);
    if (m) return m;
    m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    if (BIGRAM_CACHE.size > 4000) BIGRAM_CACHE.clear();
    BIGRAM_CACHE.set(s, m);
    return m;
  }
  function dice(a, b) {
    if (!a.size || !b.size) return 0;
    let shared = 0, total = 0;
    a.forEach((n, g) => { shared += Math.min(n, b.get(g) || 0); total += n; });
    b.forEach((n) => { total += n; });
    return (2 * shared) / total;
  }

  function isSubsequence(a, b) {
    let i = 0;
    for (let j = 0; j < b.length && i < a.length; j++) if (a[i] === b[j]) i++;
    return i === a.length;
  }

  // ---- token similarity, 0..1 ---------------------------------------------
  // The ladder is ordered by how much evidence each rung actually carries, and
  // every rung below an exact match is capped, so a pile of near-matches can
  // never add up to the certainty of the real word.
  // Memoised, because this runs query-tokens × name-tokens × every place on
  // every keystroke, and the name side of that product is a fixed vocabulary of
  // a few hundred words. Without the cache a search costs ~40 ms — too slow to
  // put behind a keypress, which is the whole point of answering locally.
  const SIM_CACHE = new Map();
  function tokenSim(q, n) {
    if (q === n) return 1;
    if (!q || !n) return 0;
    const key = q + " " + n;
    const hit = SIM_CACHE.get(key);
    if (hit !== undefined) return hit;
    const val = tokenSimRaw(q, n);
    if (SIM_CACHE.size > 30000) SIM_CACHE.clear();
    SIM_CACHE.set(key, val);
    return val;
  }

  function tokenSimRaw(q, n) {
    // A typed prefix: "muhim" for Muhimbili. Still typing counts as matching.
    if (q.length >= 3 && n.startsWith(q)) return 0.94;
    if (n.length >= 3 && q.startsWith(n)) return 0.9;
    // An initialism written without its vowels: "mwl" inside "mwalimu". Only
    // for short query tokens, and only when the first letter agrees — otherwise
    // every 3-letter string would match half the gazetteer.
    if (q.length >= 2 && q.length <= 5 && n.length > q.length &&
        q.charAt(0) === n.charAt(0) && isSubsequence(q, n)) {
      return 0.82;
    }
    const budget = editBudget(Math.max(q.length, n.length));
    const d = osaDistance(q, n, budget);
    if (d <= budget) {
      // One edit in a long word is nearly the word; one edit in a short one is not.
      const sim = 1 - d / Math.max(q.length, n.length);
      if (sim >= 0.6) return Math.min(0.88, sim);
    }
    if (CLASS_OF.has(q) && CLASS_OF.get(q) === CLASS_OF.get(n)) return CLASS_SIM;
    const dc = dice(bigrams(q), bigrams(n));
    return dc >= 0.55 ? dc * 0.78 : 0;
  }

  // ---- the gazetteer index -------------------------------------------------
  // Built once from the tz-places.js globals, and rebuilt only if those arrays
  // change (they are static consts, so in practice this runs once per page).
  let INDEX = null, INDEX_SIG = "";

  function sourceRows() {
    return [].concat(
      window.TZ_UNIVERSITIES || [], window.TZ_LANDMARKS || [], window.TZ_REGION_CENTERS || []
    );
  }

  // Every string a place answers to. Mirrors the rule resolveTzPlace has always
  // used: an UPPERCASE parenthetical is an abbreviation the place is known by
  // ("(UDSM)"); a Title-case one is a location qualifier ("(Mikocheni)") and
  // must never become the place's name.
  function namesOf(p) {
    const out = new Set();
    out.add(p.name);
    const abbr = (p.name.match(/\(([^)]+)\)/) || [])[1];
    if (abbr && /^[A-Z0-9.\s/&-]{2,}$/.test(abbr.trim())) out.add(abbr.trim());
    const noParen = p.name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
    if (noParen) out.add(noParen);
    for (const a of (p.aliases || [])) out.add(a);
    return [...out].filter(Boolean);
  }

  function buildIndex() {
    const rows = sourceRows();
    const sig = rows.length + "|" + ((rows[0] || {}).name || "") + "|" +
      ((rows[rows.length - 1] || {}).name || "");
    if (INDEX && INDEX_SIG === sig) return INDEX;

    const entries = [];
    const df = new Map();          // token -> how many places contain it
    for (const p of rows) {
      if (!p || !p.name || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
      const variants = namesOf(p).map((n) => ({ text: n, tokens: nameTokens(n), norm: expand(n) }));
      // The city is part of what a place answers to ("Mlimani City Dar"), but it
      // is never the reason a place wins — it joins the token pool, not the name
      // list, so "Dar" alone cannot out-rank an actual Dar es Salaam place name.
      const cityTokens = p.city ? nameTokens(p.city) : [];
      const all = new Set();
      variants.forEach((v) => v.tokens.forEach((t) => all.add(t)));
      cityTokens.forEach((t) => all.add(t));
      all.forEach((t) => df.set(t, (df.get(t) || 0) + 1));
      entries.push({ place: p, variants, cityTokens });
    }
    const N = Math.max(1, entries.length);
    // Inverse document frequency, floored above zero so a word that is in every
    // single name ("university") contributes a whisper rather than a vote. An
    // unknown word gets the maximum weight, which is correct: it is the whole
    // question being asked.
    const idf = (t) => Math.max(0.08, Math.log((N + 1) / ((df.get(t) || 0) + 1)));

    const vocab = new Map();       // token -> df, for spelling correction
    df.forEach((c, t) => { if (t.length >= 3) vocab.set(t, c); });

    INDEX = { entries, idf, vocab, N };
    INDEX_SIG = sig;
    return INDEX;
  }

  // ---- spelling correction against the gazetteer's own vocabulary ----------
  // Only ever used to give the ONLINE geocoder a second, better-spelled chance
  // after the literal query found nothing. Conservative on purpose: a token
  // that is already a real word is never touched, and a correction must be
  // unambiguous — two candidates equally close means we genuinely do not know
  // which word was meant, and guessing there would move somebody's map for them.
  function correctToken(tok, vocab) {
    if (tok.length < 4 || vocab.has(tok)) return null;
    const budget = tok.length <= 6 ? 1 : 2;
    let best = null, bestD = budget + 1, tie = false;
    vocab.forEach((freq, w) => {
      if (Math.abs(w.length - tok.length) > budget) return;
      const d = osaDistance(tok, w, budget);
      if (d > budget) return;
      if (d < bestD) { bestD = d; best = w; tie = false; return; }
      if (d === bestD && best !== w) {
        // A tie between two spellings is broken only when one is clearly the
        // commoner word in the gazetteer; otherwise the query is left alone.
        const fw = vocab.get(w) || 0, fb = vocab.get(best) || 0;
        if (fw > fb * 2) { best = w; tie = false; }
        else if (fb <= fw * 2) tie = true;
      }
    });
    return (tie || !best) ? null : best;
  }

  // correct("mwl nyerere unuversity") -> { query: "mwl nyerere university",
  //                                       corrected: true, fixes: [[from, to]] }
  function correct(q) {
    const vocab = buildIndex().vocab;
    const words = expand(q).split(" ").filter(Boolean);
    const fixes = [];
    const out = words.map((w) => {
      const c = correctToken(w, vocab);
      if (c && c !== w) { fixes.push([w, c]); return c; }
      return w;
    });
    return { query: out.join(" "), corrected: fixes.length > 0, fixes };
  }

  // ---- scoring -------------------------------------------------------------
  // How much of the NAME the query failed to ask for is allowed to cost it.
  // Without this, "University of Dar es Salaam" and "Kampala International
  // University - Dar es Salaam" both score a flat 1.00 for the query "chuo
  // kikuu cha dar es salaam", because every word the person typed is present in
  // both — and the tie then fell to whichever centroid happened to sit closer.
  // A name that says MORE than was asked is a weaker answer than one that says
  // exactly it, so the two extra high-information words ("kampala",
  // "international") have to weigh something. Only a sixth of the score, so a
  // long official name can still win on the words that actually matter.
  const COVERAGE_WEIGHT = 0.15;

  function scoreVariant(qTokens, weights, vTokens, extraTokens, idf) {
    const pool = (extraTokens && extraTokens.length) ? vTokens.concat(extraTokens) : vTokens;
    const nameBest = new Array(vTokens.length).fill(0);
    let got = 0, total = 0, hits = 0, allExact = true;
    for (let i = 0; i < qTokens.length; i++) {
      const w = weights[i];
      total += w;
      let best = 0;
      for (let j = 0; j < pool.length; j++) {
        const s = tokenSim(qTokens[i], pool[j]);
        if (s > best) best = s;
        if (j < nameBest.length && s > nameBest[j]) nameBest[j] = s;
        if (best === 1 && j >= nameBest.length - 1) break;
      }
      got += w * best;
      if (best >= 0.8) hits++;
      // `exact` is not "a good score" — it is "every word this person typed is
      // a word this place is called". That distinction is load-bearing: four
      // callers act on the top hit with nobody watching, and they are allowed to
      // move a map on a word that was typed, never on a word that was guessed.
      if (best < 1) allExact = false;
    }
    const qScore = total ? got / total : 0;
    // Coverage of the name, weighted the same way: an unmatched "of" is nothing,
    // an unmatched "Kampala" is the difference between two universities.
    let cGot = 0, cTotal = 0;
    for (let j = 0; j < vTokens.length; j++) {
      const w = idf(vTokens[j]);
      cTotal += w;
      cGot += w * nameBest[j];
    }
    const coverage = cTotal ? cGot / cTotal : 1;
    return { score: qScore * (1 - COVERAGE_WEIGHT + COVERAGE_WEIGHT * coverage), hits, exact: allExact };
  }

  const R_EARTH_KM = 6371;
  function haversineKm(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const s = Math.pow(Math.sin(dLat / 2), 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.pow(Math.sin(dLng / 2), 2);
    return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  // How much a nearby place is allowed to gain over a distant one. Capped hard:
  // proximity breaks a TIE, it does not win an argument. 0.06 is smaller than
  // the gap between any two meaningfully different name matches.
  const MAX_NEAR_BONUS = 0.06;
  function nearAdjust(score, place, near) {
    if (!near || !Number.isFinite(near.lat) || !Number.isFinite(near.lng)) return score;
    const km = haversineKm(near, place);
    // Full bonus inside ~25 km (the same city), fading to nothing by ~600 km.
    const closeness = km <= 25 ? 1 : Math.max(0, 1 - (km - 25) / 575);
    return score + MAX_NEAR_BONUS * closeness;
  }

  // search(q, { near, limit, min }) -> [{ name, lat, lng, kind, city, r, score,
  //                                       adjusted, hits, matchedOn, km }] best first.
  function search(q, opts) {
    opts = opts || {};
    const idx = buildIndex();
    if (normalize(q).length < 2) return [];
    const qTokens = queryTokens(q);
    if (!qTokens.length) return [];
    const weights = qTokens.map(idx.idf);
    const qNorm = expand(q);
    const min = opts.min == null ? OFFER : opts.min;

    const scored = [];
    for (const e of idx.entries) {
      let best = 0, bestName = "", bestHits = 0, exact = false;
      for (const v of e.variants) {
        // The whole query IS one of this place's names: nothing beats that, and
        // no amount of token arithmetic should be able to talk us out of it.
        if (v.norm === qNorm) { best = 1; bestName = v.text; bestHits = qTokens.length; exact = true; break; }
        const r = scoreVariant(qTokens, weights, v.tokens, e.cityTokens, idx.idf);
        if (r.score > best) { best = r.score; bestName = v.text; bestHits = r.hits; exact = r.exact; }
      }
      if (best < min) continue;
      const p = e.place;
      const km = (opts.near && Number.isFinite(opts.near.lat)) ? haversineKm(opts.near, p) : undefined;
      scored.push({
        name: p.name, lat: p.lat, lng: p.lng, kind: p.kind, city: p.city, r: p.r,
        score: best, adjusted: nearAdjust(best, p, opts.near), hits: bestHits,
        exact, matchedOn: bestName, km,
      });
    }
    scored.sort((a, b) =>
      b.adjusted - a.adjusted ||
      b.hits - a.hits ||
      ((a.km == null || b.km == null) ? 0 : a.km - b.km) ||
      a.name.length - b.name.length);
    return scored.slice(0, opts.limit || 8);
  }

  // The single best answer, or null when nothing clears the bar the caller set.
  // `best(q, { near, min: STRONG })` is what an unattended caller wants.
  function best(q, opts) {
    const hits = search(q, Object.assign({ limit: 1 }, opts || {}));
    return hits.length ? hits[0] : null;
  }

  window.pawaPlaceMatch = {
    STRONG, OFFER,
    normalize, expand, queryTokens, nameTokens,
    tokenSim, osaDistance, correct, search, best, haversineKm,
    _index: buildIndex,
  };
})();
