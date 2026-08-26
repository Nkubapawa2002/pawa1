/* ===========================================================================
 * explore.js — the Explore screen.
 *
 * Owns the interaction; owns none of the thinking. The catalogue is built by
 * explore-index.js, the query is read by explore-query.js, the ordering is
 * decided by explore-rank.js and the cross-vertical pairings come from
 * explore-match.js. This file turns those into something you can tap.
 *
 * TWO PRINCIPLES IT IS BUILT AROUND
 *
 * 1. SEARCH IS LOCAL, SO IT IS INSTANT.
 *    The whole catalogue is fetched once and ranked in memory on every
 *    keystroke. Tanzania's listings are thousands of rows, not millions — a
 *    round trip per keystroke would be slower, would fail on a bad link, and
 *    would make the ranking impossible to do properly (you cannot compute IDF
 *    over a page of results you have not fetched). The cost is one load; the
 *    payoff is that everything after it responds in a frame.
 *
 * 2. AN EMPTY RESULT IS A BUG IN THE SEARCH, NOT AN ANSWER.
 *    Someone typing "chumba Njombe" into a country-wide directory should not
 *    be told "no results" while eleven rooms sit 12 km outside their radius.
 *    So when a search comes back empty the radius widens automatically,
 *    step by step, and the screen SAYS it widened. Silently changing what was
 *    asked would be worse than the empty page.
 * =========================================================================== */
(function () {
  "use strict";

  var PAGE = 24;                       // results per screenful
  var RAILS = 3;                       // how many top cards get a companion rail
  var DEBOUNCE_MS = 160;

  // Widening ladder, in km, used only when a search returns nothing.
  var WIDEN = [5, 10, 25, 50, 100, 250, 0];   // 0 = the whole country

  var RADIUS_OPTS = [
    [0, "xp_r_any", "Anywhere"],
    [2, "xp_r_2", "Within 2 km"],
    [5, "xp_r_5", "Within 5 km"],
    [10, "xp_r_10", "Within 10 km"],
    [25, "xp_r_25", "Within 25 km"],
    [50, "xp_r_50", "Within 50 km"],
    [100, "xp_r_100", "Within 100 km"],
  ];
  var SORT_OPTS = [
    ["best", "xp_s_best", "Best match"],
    ["near", "xp_s_near", "Nearest first"],
    ["cheap", "xp_s_cheap", "Cheapest first"],
    ["new", "xp_s_new", "Newest first"],
  ];
  var EXAMPLES = [
    "xp_ex1", "chumba Mbezi 300k",
    "xp_ex2", "lori Mwanza",
    "xp_ex3", "fundi umeme karibu nami",
    "xp_ex4", "2 bedroom for rent under 500k",
    "xp_ex5", "kazi za siku Dodoma",
  ];

  // ---- Element handles ------------------------------------------------------
  var el = {};
  ["xpForm", "xpBox", "xpQ", "xpClear", "xpExamples", "xpScopes", "xpPlace",
   "xpNear", "xpRegion", "xpRadius", "xpSort", "xpRead", "xpWarn", "xpCount", "xpNote",
   "xpSkeleton", "xpResults", "xpMore", "xpEmpty", "xpWiden", "xpReset",
   "xpLang", "xpLangLabel",
   "xpViewList", "xpViewMap", "xpMapWrap", "xpMap", "xpMapMsg", "xpMapRedo",
   "xpMapNote"].forEach(function (id) { el[id] = document.getElementById(id); });

  // ---- State ----------------------------------------------------------------
  var catalogue = null;         // { items, sources, counts }
  var scope = "all";
  var anchor = null;            // { lat, lng, name, source }
  var region = "";              // "" = the whole country; otherwise a region name
  var regionElsewhere = 0;      // matches this search would find OUTSIDE `region`
  var radiusKm = 0;
  var sort = "best";
  var shown = PAGE;
  var lastResults = [];
  var widenedTo = null;         // km we auto-widened to, or null
  var searchTimer = null;
  var view = "list";            // list | map
  var mapReady = false;
  var selectedId = null;        // the pin last tapped, carried back to the list
  var roadTimer = null;
  var userActed = false;        // scrolled or tapped since the last render
  var usingRoads = false;       // at least one real road distance is in play
  var refitMap = false;         // next syncMap must reframe, ignoring a user pan

  // ---- Helpers --------------------------------------------------------------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function t(key, fallback, vars) {
    var s = window.t ? window.t(key) : key;
    if (!s || s === key) s = fallback;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = String(s).replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
      });
    }
    return s;
  }

  // TZS, compact. A price is scanned, not read — "450k" lands faster than
  // "450,000" and both are unambiguous in a country that prices in thousands.
  function money(n) {
    n = Number(n) || 0;
    if (!n) return "";
    if (n >= 1e9) return (n / 1e9).toFixed(n % 1e9 ? 1 : 0) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "k";
    return String(n);
  }

  function distLabel(km) {
    if (km == null || !isFinite(km)) return "";
    if (km < 1) return Math.round(km * 1000) + " m";
    return (km < 10 ? km.toFixed(1) : Math.round(km)) + " km";
  }

  var UNIT = {
    month: "/month", total: "", trip: "/trip", hourly: "/hr", daily: "/day",
    per_job: "/job", monthly: "/month", "per worker": "/worker",
  };

  // ---- Setup ----------------------------------------------------------------
  function fillSelect(node, opts, current) {
    if (!node) return;
    node.innerHTML = opts.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(current) ? " selected" : "") +
             ">" + esc(t(o[1], o[2])) + "</option>";
    }).join("");
  }

  function renderExamples() {
    if (!el.xpExamples) return;
    var html = "";
    for (var i = 0; i < EXAMPLES.length; i += 2) {
      var q = t(EXAMPLES[i], EXAMPLES[i + 1]);
      html += '<button class="xp-ex" type="button" data-q="' + esc(q) + '">' + esc(q) + "</button>";
    }
    el.xpExamples.innerHTML = html;
  }

  function renderScopes() {
    if (!el.xpScopes) return;
    var meta = window.ExploreIndex.KIND_META;
    var counts = (catalogue && catalogue.counts) || {};
    var total = Object.keys(counts).reduce(function (a, k) { return a + (counts[k] || 0); }, 0);
    var rows = [["all", t("xp_all", "Everything"), total]];
    ["room", "truck", "service", "job"].forEach(function (k) {
      rows.push([k, t("xp_k_" + k, meta[k].label), counts[k] || 0]);
    });
    el.xpScopes.innerHTML = rows.map(function (r) {
      return '<button class="xp-scope' + (scope === r[0] ? " active" : "") + '" type="button" role="tab"' +
             ' aria-selected="' + (scope === r[0]) + '" data-k="' + esc(r[0]) + '">' +
             '<i class="xp-dot"></i>' + esc(r[1]) +
             (r[2] ? " <b>" + r[2] + "</b>" : "") + "</button>";
    }).join("");
  }

  // ---- Region -----------------------------------------------------------------
  /**
   * Explore is the national view, so it has to answer a question the homepage
   * never asks: "show me Mwanza, as though I lived there" — from Dar, from
   * Mbeya, from anywhere.
   *
   * Picking a region does three things at once, and it has to do all three or
   * it is a lie:
   *   · SCOPES the results to that region (explore-rank.js, reject/"region");
   *   · MOVES the anchor there, so every distance, the "nearest first" sort,
   *     the companion rails and the road times are all measured from the place
   *     being browsed rather than from wherever the phone happens to be;
   *   · RECENTRES the map on it.
   *
   * Without the second, someone in Dar browsing Mwanza would see Mwanza rooms
   * labelled "1,100 km away" and sorted by their distance from Dar, which is
   * worse than useless — it is confidently wrong.
   */
  function regionList() {
    return (window.TZ_REGION_CENTERS || [])
      .filter(function (r) { return r && r.name && isFinite(r.lat) && isFinite(r.lng); })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function regionCentre(name) {
    if (!name) return null;
    var want = window.ExploreRank.normRegion(name);
    var hit = regionList().filter(function (r) {
      return window.ExploreRank.normRegion(r.name) === want;
    })[0];
    return hit ? { lat: hit.lat, lng: hit.lng, name: hit.name } : null;
  }

  /** Which region a position sits in, by nearest centre. */
  function regionAt(lat, lng) {
    var best = null, bestKm = Infinity;
    regionList().forEach(function (r) {
      var km = window.ExploreRank.haversineKm(lat, lng, r.lat, r.lng);
      if (km < bestKm) { bestKm = km; best = r.name; }
    });
    return best;
  }

  function fillRegionSelect() {
    if (!el.xpRegion) return;
    var opts = ['<option value="">' + esc(t("xp_region_any", "All of Tanzania")) + "</option>"];
    regionList().forEach(function (r) {
      opts.push('<option value="' + esc(r.name) + '"' +
                (r.name === region ? " selected" : "") + ">" + esc(r.name) + "</option>");
    });
    el.xpRegion.innerHTML = opts.join("");
    el.xpRegion.value = region;
  }

  /**
   * Adopt `name` as the region being browsed and move the anchor to match.
   *
   * The one subtlety worth keeping: if the visitor's own GPS fix is already
   * inside the region they picked, that fix is kept as the anchor. Their real
   * position is strictly better than the centroid of the region they are
   * standing in — "2 km away" beats "18 km from the middle of Mwanza". The
   * centroid is a stand-in for a location we do not have, not an improvement
   * on one we do.
   */
  function applyRegion(name) {
    region = name || "";
    if (!region) {
      // Dropping the region leaves a GPS fix alone but retires a centroid,
      // which was only ever standing in for the region.
      if (anchor && anchor.source === "region") anchor = null;
      if (el.xpPlace && anchor == null) el.xpPlace.value = "";
      return;
    }
    var centre = regionCentre(region);
    if (!centre) return;
    var keepGps = anchor && anchor.source === "gps" &&
                  regionAt(anchor.lat, anchor.lng) === centre.name;
    if (!keepGps) {
      anchor = { lat: centre.lat, lng: centre.lng, name: centre.name, source: "region" };
      if (el.xpPlace) el.xpPlace.value = "";
    }
  }

  /**
   * Move the region being browsed to wherever the visitor just pointed, and
   * report whether it actually moved.
   *
   * "Near me" and "Search this area" are both concrete statements about a
   * place. Left alone, an older region choice would go on filtering results to
   * somewhere else while every distance was measured from here — the page
   * would look broken in the way that is hardest to explain. The newer, more
   * specific instruction wins.
   *
   * It only ever moves an EXISTING choice. Someone browsing the whole country
   * has not asked to be confined to one region, and confining them silently
   * would hide most of the catalogue.
   */
  function followRegionTo(lat, lng) {
    if (!region) return false;
    var here = regionAt(lat, lng);
    var norm = window.ExploreRank.normRegion;
    if (!here || norm(here) === norm(region)) return false;
    region = here;
    if (el.xpRegion) el.xpRegion.value = here;
    return true;
  }

  // ---- The search -----------------------------------------------------------
  function currentIntent() {
    var intent = window.ExploreQuery.parse(el.xpQ ? el.xpQ.value : "", { scope: scope });
    // A place typed into the location box is a stronger statement of intent
    // than one mentioned inside the query, so it wins.
    if (anchor) intent.place = anchor;
    return intent;
  }

  function run(opts) {
    opts = opts || {};
    if (!catalogue) return;
    if (!opts.keepPage) shown = PAGE;

    var intent = currentIntent();
    var useRadius = opts.radiusOverride != null ? opts.radiusOverride : radiusKm;
    // Road distances are origin-relative. Telling the cache which origin is
    // current here — rather than only inside enrich() — means clearing the
    // anchor also clears distances measured from it, instead of leaving
    // distances-from-Mbezi attached to an unanchored search.
    if (window.ExploreRoads) {
      window.ExploreRoads.syncAnchor(anchor);
      // syncAnchor empties the cache when the origin moves, so this also
      // clears the "measured by road" note the moment it stops being true.
      usingRoads = window.ExploreRoads.map().size > 0;
    }

    var out = window.ExploreRank.rank(catalogue.items, intent, {
      anchor: anchor,
      region: region || null,
      radiusKm: useRadius || null,
      sort: sort,
      diversity: sort === "best",
      // Whatever road distances have already been measured. Empty on the first
      // pass — the ranker falls back to straight lines, the list paints, and
      // scheduleRoads() below fills these in a moment later.
      roadKm: window.ExploreRoads ? window.ExploreRoads.map() : null,
    });

    // Auto-widen: only when a radius was actually constraining the result, and
    // only when there is somewhere wider to go.
    if (!out.results.length && anchor && useRadius && !opts.noWiden) {
      for (var i = 0; i < WIDEN.length; i++) {
        if (WIDEN[i] !== 0 && WIDEN[i] <= useRadius) continue;
        var wider = window.ExploreRank.rank(catalogue.items, intent, {
          // The region stays. Widening the RADIUS is a smaller promise than
          // widening the PLACE — quietly turning "nothing in Mwanza" into a
          // page of Dar listings is exactly the silent substitution the
          // auto-widen notice exists to prevent.
          anchor: anchor, region: region || null,
          radiusKm: WIDEN[i] || null, sort: sort,
          diversity: sort === "best",
        });
        if (wider.results.length) {
          widenedTo = WIDEN[i];
          out = wider;
          break;
        }
      }
    } else {
      widenedTo = null;
    }

    // Still nothing, and a region is doing the excluding? Count what lifting it
    // would find. Offered, never applied: the region was an explicit choice and
    // overriding it silently would make the picker untrustworthy.
    regionElsewhere = 0;
    if (!out.results.length && region && !opts.noWiden) {
      var anywhere = window.ExploreRank.rank(catalogue.items, intent, {
        anchor: anchor, region: null, radiusKm: null, sort: sort,
      });
      regionElsewhere = anywhere.results.length;
    }

    lastResults = out.results;
    renderRead(intent);
    renderResults(out, intent);
    syncUrl(intent);
    scheduleRoads();
  }

  // ---- Road distance --------------------------------------------------------
  /**
   * Upgrade the visible results from straight-line to real road distance.
   *
   * Deliberately slower than the search itself. Typing fires run() constantly;
   * asking a public routing service for a matrix on every keystroke would be
   * slow, wasteful and rude, so this waits for the typing to stop.
   */
  function scheduleRoads() {
    clearTimeout(roadTimer);
    if (!window.ExploreRoads || !anchor || !lastResults.length) return;
    roadTimer = setTimeout(applyRoads, 500);
  }

  async function applyRoads() {
    var before = lastResults.slice(0, 3).map(function (r) { return r.item.id; }).join(",");
    var res = await window.ExploreRoads.enrich(anchor, lastResults);
    // `changed === 0` is also what terminates the loop: run() schedules another
    // pass, enrich finds everything already measured, and nothing re-renders.
    if (res.stale || !res.changed) return;
    usingRoads = true;

    // Re-rank with the real distances, purely to see whether it matters.
    // Ordering by road can genuinely differ from ordering by crow-flies —
    // that difference is the entire point of measuring.
    var probe = window.ExploreRank.rank(catalogue.items, currentIntent(), {
      anchor: anchor,
      radiusKm: (widenedTo != null ? widenedTo : radiusKm) || null,
      sort: sort,
      diversity: sort === "best",
      roadKm: window.ExploreRoads.map(),
    });
    var after = probe.results.slice(0, 3).map(function (r) { return r.item.id; }).join(",");

    // Re-rendering swaps the cards under whatever the reader is looking at. If
    // they have already scrolled or tapped, the order is left alone and only
    // the distance labels are corrected in place — a number quietly getting
    // more accurate is fine; the list moving under a finger is not.
    if (after !== before && userActed) {
      lastResults = probe.results;
      patchDistances();
      syncMap(lastResults);
      return;
    }

    // Full re-run rather than rendering `probe` directly, so the auto-widen
    // ladder still applies. A road distance can push the last result outside
    // the radius — that must widen and say so, not empty the page.
    userActed = false;
    run({ keepPage: true });
  }

  /** Correct the distance text on already-rendered cards, without reordering. */
  function patchDistances() {
    var byId = {};
    lastResults.forEach(function (r) { byId[r.item.id] = r; });
    var cards = el.xpResults.querySelectorAll(".xp-card[data-id]");
    for (var i = 0; i < cards.length; i++) {
      var row = byId[cards[i].getAttribute("data-id")];
      if (!row || row.distKm == null) continue;
      var node = cards[i].querySelector(".xp-dist");
      if (!node) continue;
      node.textContent = distLabel(row.distKm);
      node.classList.toggle("is-road", !!row.item._roadKm);
    }
  }

  function debouncedRun() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { run(); }, DEBOUNCE_MS);
  }

  // ---- "What I understood" --------------------------------------------------
  // Showing the parse back is not decoration. A search box that silently
  // reinterprets what you typed is impossible to correct; naming each
  // assumption — and letting it be removed — is what makes it steerable.
  function renderRead(intent) {
    if (!el.xpRead) return;
    var tags = [];
    var meta = window.ExploreIndex.KIND_META;

    if (scope === "all" && !intent.isEmpty && intent.kinds.length < 4) {
      tags.push({ cls: "", text: intent.kinds.map(function (k) { return t("xp_k_" + k, meta[k].label); }).join(" + ") });
    }
    var f = intent.facets || {};
    if (f.listing) tags.push({ cls: "", text: t("xp_f_" + f.listing, f.listing === "rent" ? "for rent" : "for sale") });
    if (f.bedrooms != null) tags.push({ cls: "", text: f.bedrooms + " " + t("xp_f_bed", "bed") });
    if (f.roomKind) tags.push({ cls: "", text: f.roomKind === "master" ? t("xp_f_master", "self-contained") : t("xp_f_single", "single room") });
    if (f.category) tags.push({ cls: "", text: window.ExploreIndex.SERVICE_LABEL[f.category] || f.category });
    if (f.capacityT) tags.push({ cls: "", text: f.capacityT + " t" });

    if (intent.priceMax) tags.push({ cls: "is-money", text: t("xp_f_under", "under {v}", { v: money(intent.priceMax) }) });
    if (intent.priceMin) tags.push({ cls: "is-money", text: t("xp_f_over", "over {v}", { v: money(intent.priceMin) }) });

    // The region being browsed gets its own chip and its own ×, because
    // clearing it is a different act from clearing the anchor — and when a GPS
    // fix inside the chosen region is serving as the anchor, both are true at
    // once and both should be visible.
    if (region) {
      tags.push({
        cls: "is-place", key: "region",
        text: "🗺 " + region +
              (anchor && anchor.source === "region" && radiusKm ? " · " + radiusKm + " km" : ""),
      });
    }
    // Suppressed when the anchor is merely the region's centroid: the region
    // chip above already says that, and saying it twice reads as two filters.
    if (anchor && anchor.source !== "region") {
      tags.push({
        cls: "is-place", key: "place",
        text: (anchor.source === "gps" ? "📍 " : "") + anchor.name +
              (radiusKm ? " · " + radiusKm + " km" : ""),
      });
    }

    el.xpRead.innerHTML = tags.map(function (tg) {
      return '<span class="xp-tag ' + tg.cls + '">' + esc(tg.text) +
        (tg.key ? '<button class="xp-tag-x" type="button" data-drop="' + tg.key + '" aria-label="Remove">×</button>' : "") +
        "</span>";
    }).join("");
  }

  // ---- Rendering ------------------------------------------------------------
  var KIND_ICON = {
    room:    '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
    truck:   '<path d="M1 6h13v9H1z"/><path d="M14 9h4l3 3v3h-7z"/><circle cx="5.5" cy="18" r="1.7"/><circle cx="17.5" cy="18" r="1.7"/>',
    service: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.3L3 18l3 3 6.4-6.3a4 4 0 0 0 5.3-5.4l-2.9 2.9-2.1-2.1z"/>',
    job:     '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  };

  function kindIcon(kind, size) {
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" ' +
      'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (KIND_ICON[kind] || "") + "</svg>";
  }

  function subtitleFor(item) {
    var f = item.facets;
    if (item.kind === "room") {
      var bits = [];
      if (f.bedrooms) bits.push(f.bedrooms + " bed");
      if (f.type) bits.push(f.type);
      if (f.listing) bits.push(f.listing === "rent" ? t("xp_f_rent", "for rent") : t("xp_f_sale", "for sale"));
      return bits.join(" · ");
    }
    if (item.kind === "truck") {
      var b2 = [];
      if (f.truckType) b2.push(f.truckType);
      if (f.capacityT) b2.push(f.capacityT + " t");
      if (f.loadersIncluded) b2.push(t("xp_loaders", "loaders included"));
      return b2.join(" · ");
    }
    if (item.kind === "service") {
      var b3 = [f.categoryLabel];
      if (f.experienceYears) b3.push(f.experienceYears + " " + t("xp_yrs", "yrs exp"));
      return b3.filter(Boolean).join(" · ");
    }
    if (item.kind === "job") {
      var b4 = [];
      if (f.company) b4.push(f.company);
      if (f.spotsLeft) b4.push(f.spotsLeft + " " + t("xp_spots", "spots left"));
      return b4.join(" · ");
    }
    return "";
  }

  function priceHtml(item) {
    if (!item.price) return '<div class="xp-price is-ask">' + esc(t("xp_ask", "Ask for price")) + "</div>";
    var unit = UNIT[item.priceUnit] != null ? UNIT[item.priceUnit] : "/" + item.priceUnit;
    return '<div class="xp-price">TZS ' + money(item.price) +
           (unit ? "<small>" + esc(unit) + "</small>" : "") + "</div>";
  }

  function cardHtml(row, idx) {
    var it = row.item;
    var where = [it.area, it.region].filter(Boolean).join(", ");
    var sub = subtitleFor(it);
    var meta = window.ExploreIndex.KIND_META[it.kind];

    // Icon always rendered underneath; the photo covers it when it loads. A
    // dead image URL then degrades to the vertical's glyph instead of a blank.
    var thumb = '<i class="xp-thumb-ic">' + kindIcon(it.kind, 30) + "</i>" +
      (it.photo ? '<img src="' + esc(it.photo) + '" alt="" loading="lazy" decoding="async" />' : "");

    return '<a class="xp-card" href="' + esc(it.href) + '" data-id="' + esc(it.id) + '">' +
      '<div class="xp-card-in">' +
        '<div class="xp-thumb' + (it.photo ? " has-img" : "") + '">' + thumb +
          (it.verified ? '<div class="xp-badges"><span class="xp-verified">✓</span></div>' : "") +
        "</div>" +
        '<div class="xp-body">' +
          '<span class="xp-kind" data-k="' + it.kind + '">' + esc(t("xp_one_" + it.kind, meta.one)) + "</span>" +
          '<h3 class="xp-name">' + esc(it.title) + "</h3>" +
          '<div class="xp-meta">' +
            (sub ? "<span>" + esc(sub) + "</span>" : "") +
            (sub && where ? '<span class="xp-sep">·</span>' : "") +
            (where ? "<span>" + esc(where) + "</span>" : "") +
            (row.distKm != null
              ? '<span class="xp-sep">·</span><span class="xp-dist' + (it._roadKm ? " is-road" : "") + '">' +
                esc(distLabel(row.distKm)) + "</span>"
              : "") +
          "</div>" +
          priceHtml(it) +
        "</div>" +
      "</div>" +
      // Slot keyed by position, not by listing id: an id is user-supplied text
      // and would have to survive CSS.escape to be selectable. The index is
      // ours, and always safe.
      '<div data-comp="' + idx + '"></div>' +
      "</a>";
  }

  function railHtml(group) {
    var meta = window.ExploreIndex.KIND_META;
    return '<div class="xp-comp">' +
      '<div class="xp-comp-head">' +
        '<span class="xp-comp-t">' + esc(t("xp_comp_" + group.kind + "_t", group.title)) + "</span>" +
        '<span class="xp-comp-s">' + esc(t("xp_comp_" + group.kind + "_s", group.subtitle)) + "</span>" +
      "</div>" +
      '<div class="xp-comp-rail">' +
        group.items.map(function (c) {
          var m = meta[c.item.kind];
          var unit = UNIT[c.item.priceUnit] != null ? UNIT[c.item.priceUnit] : "";
          return '<span class="xp-mini" data-k="' + c.item.kind + '" data-href="' + esc(c.item.href) + '" role="link" tabindex="0">' +
            '<span class="xp-mini-n">' + esc(c.item.title) + "</span>" +
            '<span class="xp-mini-m">' + esc(distLabel(c.distKm)) +
              (c.item.area || c.item.region ? " · " + esc(c.item.area || c.item.region) : "") + "</span>" +
            '<span class="xp-mini-p">' + (c.item.price ? "TZS " + money(c.item.price) + esc(unit) : esc(t("xp_ask", "Ask"))) + "</span>" +
            "</span>";
        }).join("") +
      "</div>" +
    "</div>";
  }

  function renderResults(out, intent) {
    if (el.xpSkeleton) el.xpSkeleton.hidden = true;

    var rows = out.results;
    var page = rows.slice(0, shown);

    // Count + the honest note about what happened to the search.
    if (el.xpCount) {
      el.xpCount.innerHTML = rows.length
        ? esc(t("xp_count", "{n} results", { n: rows.length }))
        : "";
    }
    if (el.xpNote) {
      var notes = [];
      if (out.anchorUsed && anchor) notes.push(t("xp_from", "from {p}", { p: anchor.name }));
      // Say when distances stopped being straight lines. Without this, a
      // listing quietly leaving the results because its DRIVE is 26 km looks
      // like a glitch rather than the more accurate answer it is.
      if (usingRoads && out.anchorUsed) notes.push(t("xp_by_road", "measured by road"));
      if (out.dropped && out.dropped.budget) notes.push(t("xp_over_budget", "{n} over budget", { n: out.dropped.budget }));
      el.xpNote.textContent = notes.join(" · ");
    }

    // Auto-widen must be visible. Quietly changing the radius someone chose is
    // the kind of "helpful" that makes results impossible to trust.
    if (el.xpWarn) {
      if (widenedTo) {
        el.xpWarn.textContent = widenedTo === 0
          ? t("xp_widened_all", "Nothing within {r} km, so this is the whole country.", { r: radiusKm })
          : t("xp_widened", "Nothing within {r} km — widened to {w} km.", { r: radiusKm, w: widenedTo });
        el.xpWarn.hidden = false;
      } else if (catalogue && catalogue.sources && Object.keys(catalogue.sources).some(function (k) { return !catalogue.sources[k]; })) {
        var missing = Object.keys(catalogue.sources).filter(function (k) { return !catalogue.sources[k]; });
        el.xpWarn.textContent = t("xp_partial",
          "Some catalogues could not be loaded ({k}), so results are incomplete.",
          { k: missing.join(", ") });
        el.xpWarn.hidden = false;
      } else {
        el.xpWarn.hidden = true;
      }
    }

    if (!rows.length) {
      el.xpResults.innerHTML = "";
      // Say WHICH place came up empty, and what dropping it would find. "Nothing
      // matched that" is unhelpful when the cause is a region filter the visitor
      // set twenty seconds ago and may have forgotten.
      // Both branches are written on every empty render, never just the region
      // one: these nodes persist between searches, so a "Nothing in Mwanza"
      // left standing after the region is cleared is a stale lie.
      var emptyT = document.getElementById("xpEmptyT");
      var emptyP = document.getElementById("xpEmptyP");
      if (emptyT) {
        emptyT.textContent = region
          ? t("xp_empty_region_t", "Nothing in {r}", { r: region })
          : t("xp_empty_t", "Nothing matched that");
      }
      if (emptyP) {
        emptyP.textContent = region && regionElsewhere
          ? t("xp_empty_region_p", "{n} match this search elsewhere in Tanzania.", { n: regionElsewhere })
          : t("xp_empty_p", "Try fewer words, a wider radius, or search the whole country.");
      }
      if (el.xpWiden) {
        el.xpWiden.textContent = region
          ? t("xp_widen_region", "Search all of Tanzania instead")
          : t("xp_widen", "Search all of Tanzania");
      }
      if (el.xpEmpty) el.xpEmpty.hidden = view === "map";
      if (el.xpMore) el.xpMore.hidden = true;
      syncMap(rows);
      return;
    }
    if (el.xpEmpty) el.xpEmpty.hidden = true;

    el.xpResults.innerHTML = page.map(cardHtml).join("");

    if (el.xpMore) {
      var left = rows.length - page.length;
      el.xpMore.hidden = left <= 0 || view === "map";
      el.xpMore.textContent = t("xp_more", "Show {n} more", { n: Math.min(PAGE, left) });
    }

    renderRails(page);
    // The map draws the WHOLE ranked set, not just the visible page: "show 24
    // more" is a list affordance, and a map that only plotted the first
    // screenful would be lying about where things are.
    syncMap(rows);
  }

  // ---- Map ------------------------------------------------------------------
  /**
   * Push the current results to the map, if it is up.
   *
   * `respectUserView` is what stops the map yanking itself back to the results
   * every time a keystroke re-runs the search: once someone has dragged the
   * map, it stays where they put it and the pins update underneath them.
   */
  function syncMap(rows) {
    if (!mapReady || !window.ExploreMap.isUp()) return;
    window.ExploreMap.show(rows, {
      anchor: anchor,
      radiusKm: widenedTo != null ? widenedTo : radiusKm,
      // Normally a pan the visitor made is theirs to keep. Changing region is
      // the exception: they asked to look somewhere else, so holding the old
      // frame would leave them staring at the region they just left.
      respectUserView: !refitMap,
      selectedId: selectedId,
    });
    refitMap = false;
  }

  function applyView() {
    var isMap = view === "map";
    if (el.xpViewList) {
      el.xpViewList.classList.toggle("active", !isMap);
      el.xpViewList.setAttribute("aria-pressed", String(!isMap));
    }
    if (el.xpViewMap) {
      el.xpViewMap.classList.toggle("active", isMap);
      el.xpViewMap.setAttribute("aria-pressed", String(isMap));
    }
    if (el.xpMapWrap) el.xpMapWrap.hidden = !isMap;
    if (el.xpResults) el.xpResults.hidden = isMap;
    if (el.xpMore) el.xpMore.hidden = isMap || el.xpMore.hidden;
  }

  async function openMap() {
    view = "map";
    applyView();

    if (mapReady) {
      // Leaflet measures its container on creation; a container that was
      // `hidden` then measured 0×0 and renders a grey box until told again.
      window.ExploreMap.invalidate();
      syncMap(lastResults);
      window.ExploreMap.fit();
      return;
    }

    if (el.xpMapMsg) {
      el.xpMapMsg.textContent = t("xp_map_loading", "Loading the map…");
      el.xpMapMsg.hidden = false;
    }
    try {
      await window.ExploreMap.mount(el.xpMap, {
        getCatalogue: function () { return catalogue ? catalogue.items : []; },
        onSelect: onMapSelect,
        onDrawn: onMapDrawn,
        onMove: onMapMove,
      });
      mapReady = true;
      if (el.xpMapMsg) el.xpMapMsg.hidden = true;
      window.ExploreMap.invalidate();
      syncMap(lastResults);
      window.ExploreMap.fit();
    } catch (_) {
      // The map is an enhancement; losing it must not lose the search.
      if (el.xpMapMsg) {
        el.xpMapMsg.textContent = t("xp_map_failed",
          "The map could not load. Your results are still in the list.");
        el.xpMapMsg.hidden = false;
      }
    }
  }

  function closeMap() {
    view = "list";
    // A pin tapped on the map is still the thing the user is thinking about,
    // so the list opens ON it rather than back at the top. This is what makes
    // the two views feel like one screen instead of two places to look.
    if (selectedId) {
      var idx = lastResults.findIndex(function (r) { return r.item.id === selectedId; });
      if (idx >= 0) shown = Math.max(shown, Math.ceil((idx + 1) / PAGE) * PAGE);
    }
    applyView();
    run({ keepPage: true });
    if (selectedId) scrollToCard(selectedId);
  }

  function onMapSelect(item) {
    selectedId = item ? item.id : null;
  }

  function scrollToCard(id) {
    requestAnimationFrame(function () {
      var card = el.xpResults.querySelector('[data-id="' + cssQuote(id) + '"]');
      if (!card) return;
      try { card.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) { card.scrollIntoView(); }
      card.classList.add("is-focus");
      setTimeout(function () { card.classList.remove("is-focus"); }, 2200);
    });
  }

  // Listing ids are user-supplied text, so they cannot go into a selector raw.
  function cssQuote(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  function onMapDrawn(info) {
    if (!el.xpMapNote) return;
    var bits = [];
    if (info.capped) bits.push(t("xp_map_capped", "showing {n} — zoom in for more", { n: info.drawn }));
    else if (info.drawn) bits.push(t("xp_map_showing", "{n} on the map", { n: info.drawn }));
    // The honesty rule again: a listing with no coordinates has not been
    // filtered out, it simply cannot be drawn — and the reader must be told.
    if (info.unpinned) bits.push(t("xp_map_unpinned", "{n} without a map pin", { n: info.unpinned }));
    el.xpMapNote.textContent = bits.join(" · ");
  }

  function onMapMove(centre, spanKm) {
    if (!el.xpMapRedo || !centre) return;
    if (!anchor) { el.xpMapRedo.hidden = false; return; }
    // Offer to re-search only once the map has genuinely left the area the
    // results were framed around — otherwise the button is permanent chrome.
    var drift = window.ExploreRank.haversineKm(anchor.lat, anchor.lng, centre.lat, centre.lng);
    el.xpMapRedo.hidden = drift < Math.max(1.5, spanKm * 0.6);
  }

  function searchThisArea() {
    var c = window.ExploreMap.centre();
    if (!c) return;
    var span = Math.max(2, Math.round(window.ExploreMap.spanKm()));
    anchor = {
      lat: c.lat, lng: c.lng,
      name: regionAt(c.lat, c.lng) || t("xp_map_area", "this area"),
      source: "map",
    };
    // Same rule as "Near me", without the reframe: the visitor chose this
    // frame by panning to it, so the map stays exactly where they left it.
    followRegionTo(c.lat, c.lng);
    radiusKm = span;
    if (el.xpRadius) {
      // The radius <select> only holds fixed steps; snap to the nearest one so
      // the control never disagrees with what was actually searched.
      var opts = RADIUS_OPTS.map(function (o) { return o[0]; }).filter(Boolean);
      radiusKm = opts.reduce(function (best, v) {
        return Math.abs(v - span) < Math.abs(best - span) ? v : best;
      }, opts[0]);
      el.xpRadius.value = String(radiusKm);
    }
    if (el.xpPlace) el.xpPlace.value = "";
    if (el.xpNear) el.xpNear.classList.remove("is-on");
    el.xpMapRedo.hidden = true;
    run();
    // Keep the user's framing: they chose this view, the results came to it.
    window.ExploreMap.show(lastResults, { anchor: anchor, radiusKm: radiusKm, fit: false });
  }

  // Companion rails are the point of the page, but they are also the most
  // expensive thing on it — a full pass over the catalogue per card. Only the
  // top few get one, and only after the results have painted, so the list is
  // never held up waiting for its own footnotes.
  function renderRails(page) {
    if (!catalogue) return;
    var todo = page.slice(0, RAILS);
    requestAnimationFrame(function () {
      todo.forEach(function (row, i) {
        var slot = el.xpResults.querySelector('[data-comp="' + i + '"]');
        if (!slot) return;
        var groups = window.ExploreMatch.companionsFor(row.item, catalogue.items, { maxGroups: 1 });
        if (!groups.length) return;
        slot.innerHTML = railHtml(groups[0]);
      });
    });
  }

  // ---- Location -------------------------------------------------------------
  async function resolvePlace(text) {
    var q = (text || "").trim();
    if (q.length < 2) return null;

    // Gazetteer first: it is instant, offline, and knows the names people
    // actually type (UDSM, Kariakoo, Mbezi) better than a global geocoder.
    if (typeof window.resolveTzPlace === "function") {
      var local = window.resolveTzPlace(q);
      if (local) return { lat: local.lat, lng: local.lng, name: local.name, source: "gazetteer" };
    }
    if (window.pawaGeo && window.pawaGeo.search) {
      try {
        var res = await window.pawaGeo.search("q=" + encodeURIComponent(q + ", Tanzania") + "&limit=1");
        var hit = Array.isArray(res) ? res[0] : (res && res[0]);
        if (hit && hit.lat) {
          return {
            lat: parseFloat(hit.lat), lng: parseFloat(hit.lon || hit.lng),
            name: (hit.display_name || q).split(",")[0], source: "geocoder",
          };
        }
      } catch (_) { /* offline / gateway asleep — fall through */ }
    }
    return null;
  }

  async function useGps() {
    if (!window.pawaLocate) return;
    el.xpNear.disabled = true;
    var was = el.xpNear.querySelector("span").textContent;
    el.xpNear.querySelector("span").textContent = t("xp_locating", "Locating…");
    try {
      var fix = await window.pawaLocate.best({ targetAccuracy: 60, maxWaitMs: 20000 });
      var here = regionAt(fix.lat, fix.lng);
      anchor = { lat: fix.lat, lng: fix.lng, name: here || t("xp_you", "your location"), source: "gps" };
      el.xpNear.classList.add("is-on");
      if (el.xpPlace) el.xpPlace.value = "";
      // A fix from another region beats the region that was being browsed —
      // otherwise results stay scoped to Mwanza while distances are measured
      // from Dar, and the 10 km radius below empties the page.
      if (followRegionTo(fix.lat, fix.lng)) refitMap = true;
      if (!radiusKm) { radiusKm = 10; if (el.xpRadius) el.xpRadius.value = "10"; }
      run();
    } catch (err) {
      if (el.xpWarn) {
        el.xpWarn.textContent = (window.pawaLocate.message && window.pawaLocate.message(err)) ||
          t("xp_gps_failed", "Could not get your location.");
        el.xpWarn.hidden = false;
      }
    } finally {
      el.xpNear.disabled = false;
      el.xpNear.querySelector("span").textContent = was;
    }
  }

  // ---- URL ------------------------------------------------------------------
  // Deep links matter here: "look at this search" is the natural way to share
  // a result set, and a shared link that lands on an empty Explore is useless.
  function syncUrl(intent) {
    try {
      var p = new URLSearchParams();
      if (intent.raw) p.set("q", intent.raw);
      if (scope !== "all") p.set("k", scope);
      if (region) p.set("region", region);
      // A region centroid is reproduced from the region param, so writing it
      // as a place too would restore the same anchor twice and, worse, survive
      // clearing the region.
      //
      // A pin somebody was SENT is written back as the pin, not as its name.
      // Writing ?place=<label> would send the next load through the geocoder
      // with whatever a person typed in a chat ("the gate is the blue one"),
      // and the exact spot they walked to would be replaced by a guess or by
      // nothing. The label rides along so the box still reads in their words.
      if (anchor && anchor.source === "shared") {
        p.set("at", Number(anchor.lat).toFixed(6) + "," + Number(anchor.lng).toFixed(6));
        if (anchor.name) p.set("label", String(anchor.name).slice(0, 60));
      } else if (anchor && anchor.source !== "gps" && anchor.source !== "region") {
        p.set("place", anchor.name);
      }
      if (radiusKm) p.set("r", String(radiusKm));
      if (sort !== "best") p.set("sort", sort);
      if (view === "map") p.set("view", "map");
      var qs = p.toString();
      history.replaceState(null, "", qs ? "?" + qs : location.pathname);
    } catch (_) {}
  }

  async function readUrl() {
    var p = new URLSearchParams(location.search);
    if (p.get("q") && el.xpQ) el.xpQ.value = p.get("q");
    if (p.get("k")) scope = p.get("k");
    if (p.get("r")) radiusKm = parseInt(p.get("r"), 10) || 0;
    if (p.get("sort")) sort = p.get("sort");
    // A shared link that says "map" should open on the map. The view is
    // resolved here but the map itself is not mounted until after the
    // catalogue lands, so the load order stays the same either way.
    if (p.get("view") === "map") view = "map";
    // Region first: applyRegion() sets the centroid anchor, and a ?place= in
    // the same link is the more specific statement, so it overwrites it below.
    if (p.get("region")) applyRegion(p.get("region"));
    if (p.get("place")) {
      if (el.xpPlace) el.xpPlace.value = p.get("place");
      var resolved = await resolvePlace(p.get("place"));
      if (resolved) anchor = resolved;
    }
    // ?at=<lat>,<lng> — an exact pin, usually one somebody was sent in
    // P-Message. It is the most specific statement a link can make about
    // where to look, so it wins over ?place= and over ?region=.
    //
    // The lesson from the region picker applies exactly: scope, anchor and
    // map must move TOGETHER or the page lies. Setting the anchor alone would
    // leave an older region filtering the results to somewhere else while
    // every distance was measured from here — which looks broken in the way
    // that is hardest to explain. So the region follows the pin, and the
    // radius is set small, because "near this gate" is the question a pin
    // asks and a country-wide list is not an answer to it.
    var at = p.get("at");
    if (at) {
      var hit = window.PlaceBook ? window.PlaceBook.parse(at) : null;
      if (hit) {
        var here = regionAt(hit.lat, hit.lng);
        anchor = {
          lat: hit.lat, lng: hit.lng,
          name: p.get("label") || here || t("xp_map_area", "this area"),
          source: "shared",
        };
        if (here) {
          region = here;
          if (el.xpRegion) el.xpRegion.value = here;
        }
        if (el.xpPlace) el.xpPlace.value = anchor.name;
        if (!p.get("r")) radiusKm = 5;
        if (el.xpRadius) el.xpRadius.value = String(radiusKm);
        view = "map";
      }
    }
    syncBoxState();
  }

  function syncBoxState() {
    if (el.xpBox && el.xpQ) el.xpBox.classList.toggle("has-value", !!el.xpQ.value);
  }

  // ---- Wiring ---------------------------------------------------------------
  function wire() {
    el.xpForm && el.xpForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (el.xpQ) el.xpQ.blur();          // let the keyboard drop on mobile
      clearTimeout(searchTimer);
      run();
    });

    el.xpQ && el.xpQ.addEventListener("input", function () {
      syncBoxState();
      debouncedRun();
    });

    el.xpClear && el.xpClear.addEventListener("click", function () {
      el.xpQ.value = "";
      syncBoxState();
      el.xpQ.focus();
      run();
    });

    el.xpExamples && el.xpExamples.addEventListener("click", function (e) {
      var b = e.target.closest("[data-q]");
      if (!b) return;
      el.xpQ.value = b.dataset.q;
      syncBoxState();
      run();
    });

    el.xpScopes && el.xpScopes.addEventListener("click", function (e) {
      var b = e.target.closest("[data-k]");
      if (!b) return;
      scope = b.dataset.k;
      renderScopes();
      run();
    });

    // The location box resolves on pause, not on submit: a place is a filter,
    // and a filter you have to press Enter to apply feels broken next to a
    // search box that updates as you type.
    var placeTimer = null;
    el.xpPlace && el.xpPlace.addEventListener("input", function () {
      clearTimeout(placeTimer);
      var v = el.xpPlace.value;
      placeTimer = setTimeout(async function () {
        if (!v.trim()) { anchor = null; el.xpNear.classList.remove("is-on"); run(); return; }
        var hit = await resolvePlace(v);
        if (hit) {
          anchor = hit;
          el.xpNear.classList.remove("is-on");
          if (!radiusKm) { radiusKm = 25; if (el.xpRadius) el.xpRadius.value = "25"; }
        }
        run();
      }, 380);
    });

    el.xpNear && el.xpNear.addEventListener("click", useGps);

    // Changing the region changes what the page IS, not merely how it is
    // filtered: the anchor, the distances, the rails, the road times and the
    // map centre all move with it. Hence applyRegion() rather than a plain
    // assignment, and a full re-run rather than a re-sort.
    el.xpRegion && el.xpRegion.addEventListener("change", function () {
      applyRegion(el.xpRegion.value);
      refitMap = true;
      run();
    });

    el.xpRadius && el.xpRadius.addEventListener("change", function () {
      radiusKm = parseInt(el.xpRadius.value, 10) || 0;
      run();
    });
    el.xpSort && el.xpSort.addEventListener("change", function () {
      sort = el.xpSort.value;
      run();
    });

    el.xpMore && el.xpMore.addEventListener("click", function () {
      shown += PAGE;
      run({ keepPage: true });
    });

    el.xpWiden && el.xpWiden.addEventListener("click", function () {
      radiusKm = 0;
      if (el.xpRadius) el.xpRadius.value = "0";
      // "Search all of Tanzania" has to mean it. Leaving the region on would
      // widen the radius inside a region that already returned nothing.
      applyRegion("");
      if (el.xpRegion) el.xpRegion.value = "";
      run();
    });
    el.xpReset && el.xpReset.addEventListener("click", function () {
      el.xpQ.value = ""; el.xpPlace.value = "";
      anchor = null; scope = "all"; radiusKm = 0; sort = "best";
      applyRegion("");
      if (el.xpRegion) el.xpRegion.value = "";
      if (el.xpRadius) el.xpRadius.value = "0";
      if (el.xpSort) el.xpSort.value = "best";
      el.xpNear.classList.remove("is-on");
      syncBoxState(); renderScopes(); run();
    });

    // Removing an assumption the parser made.
    el.xpRead && el.xpRead.addEventListener("click", function (e) {
      var b = e.target.closest("[data-drop]");
      if (!b) return;
      if (b.dataset.drop === "place") {
        anchor = null;
        if (el.xpPlace) el.xpPlace.value = "";
        el.xpNear.classList.remove("is-on");
        run();
      } else if (b.dataset.drop === "region") {
        applyRegion("");
        if (el.xpRegion) el.xpRegion.value = "";
        run();
      }
    });

    // Companion tiles live inside the result <a>, so a plain nested link would
    // be invalid HTML. They are spans with an explicit link role instead.
    el.xpResults && el.xpResults.addEventListener("click", function (e) {
      var mini = e.target.closest(".xp-mini[data-href]");
      if (!mini) return;
      e.preventDefault();
      e.stopPropagation();
      location.href = mini.dataset.href;
    });
    el.xpResults && el.xpResults.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var mini = e.target.closest(".xp-mini[data-href]");
      if (!mini) return;
      e.preventDefault();
      location.href = mini.dataset.href;
    });

    // Once the reader has scrolled or tapped a card, they are reading a
    // specific position in the list — so a late road-distance pass corrects
    // the numbers there instead of reshuffling what is under their finger.
    window.addEventListener("scroll", function () {
      if (window.scrollY > 120) userActed = true;
    }, { passive: true });
    el.xpResults && el.xpResults.addEventListener("pointerdown", function () {
      userActed = true;
    }, { passive: true });

    // `error` does not bubble, so this has to listen in the capture phase.
    // Delegation is still worth it: hundreds of cards, one listener.
    el.xpResults && el.xpResults.addEventListener("error", function (e) {
      var img = e.target;
      if (img && img.tagName === "IMG") {
        var thumb = img.closest(".xp-thumb");
        if (thumb) thumb.classList.remove("has-img");
        img.remove();
      }
    }, true);

    el.xpViewMap && el.xpViewMap.addEventListener("click", function () {
      if (view !== "map") openMap();
    });
    el.xpViewList && el.xpViewList.addEventListener("click", function () {
      if (view !== "list") closeMap();
    });
    el.xpMapRedo && el.xpMapRedo.addEventListener("click", searchThisArea);

    el.xpLang && el.xpLang.addEventListener("click", function () {
      var next = (window.getLang && window.getLang()) === "sw" ? "en" : "sw";
      if (window.setLang) window.setLang(next);
    });
  }

  // ---- Boot -----------------------------------------------------------------
  async function boot() {
    if (window.applyTranslations) window.applyTranslations();
    if (el.xpLangLabel && window.getLang) {
      el.xpLangLabel.textContent = window.getLang() === "sw" ? "EN" : "SW";
    }
    renderExamples();
    fillRegionSelect();
    fillSelect(el.xpRadius, RADIUS_OPTS, radiusKm);
    fillSelect(el.xpSort, SORT_OPTS, sort);
    wire();

    await readUrl();
    fillRegionSelect();          // again: a ?region= link must show as selected
    fillSelect(el.xpRadius, RADIUS_OPTS, radiusKm);
    fillSelect(el.xpSort, SORT_OPTS, sort);

    applyView();
    catalogue = await window.ExploreIndex.load();
    renderScopes();
    run();
    // Deep-linked straight to the map: mount it now that there is something
    // to draw, so it never opens on an empty canvas.
    if (view === "map") { view = "list"; openMap(); }

    // The national video, last and deliberately unawaited: it sits at the very
    // bottom of the page and must never delay the results above it. It renders
    // its own empty state, so a failure here costs nothing.
    if (window.VideoNational) {
      window.VideoNational.mount(document.getElementById("nationalVideo"));
    }
  }

  if (document.readyState !== "loading") boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
