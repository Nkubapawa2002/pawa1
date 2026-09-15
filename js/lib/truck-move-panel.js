// ============================================================================
//  truck-move-panel.js — window.TruckMovePanel
//
//  "Move my things here", on the property sheet.
//
//  THE WHOLE POINT OF IT
//  Somebody has just decided on a room. At that exact moment they know three
//  things the trucks catalogue would otherwise make them type again: where the
//  room is, roughly how much furniture they own, and, if they let us ask, where
//  they are standing. One button collects all three and comes back with the
//  lorries that can actually do it, nearest first.
//
//  ONE PRESS IS THE BUDGET. The panel starts with everything it can know for
//  free already filled in: the destination is this listing, and the load size
//  is guessed from the listing's own bedroom count, which is right often
//  enough to be a better starting point than an empty picker. The press is
//  what buys the location prompt, because asking for GPS to render a page
//  nobody asked about is how permission prompts get refused forever.
//
//  ...BUT THE PRESS MUST NOT BE THE ONLY DOOR. For a long time it was: the
//  only way to say where your things were was to be standing on top of them
//  with the location permission granted. Everybody else (planning from work,
//  arranging a lorry for a relative, reading on a laptop, or simply having
//  said no to the prompt once) got a planner that could not measure the move
//  and could not rank by distance, and no way at all to tell it what it was
//  missing. There are four doors now, in the order they cost the reader
//  something: a fix another part of this page already found, the GPS button,
//  a place they saved once on houses.html, and typing an area. See doorsHtml()
//  in js/lib/truck-move-ui.js.
//
//  THE MEASUREMENT IS DRAWN, NOT ONLY COUNTED. "18 km by road" in a pill is a
//  number to be taken on trust. The same number on a map, with the lorry's
//  base, your things and the new home marked and the two legs in different
//  lines, is a job somebody can look at and judge. js/lib/truck-move-map.js
//  draws it; the three distances stay exactly as separate here as they are in
//  truck-match.js.
//
//  WHAT IT REFUSES TO DO
//  It does not hide a truck it is unsure about, it does not invent a price for
//  the move, and it does not show a straight-line distance dressed up as a
//  drive. js/lib/truck-match.js keeps those three promises; this file only has
//  to not undo them.
//
//  Depends at call time on: TruckMove, TruckMoveUI, DataStore, pawaLocate,
//  and optionally TruckMoveMap, PawaMaps, pawaGeo and pawaRoute. Every one is
//  guarded, because a property sheet that cannot find a lorry must still be a
//  property sheet.
// ============================================================================
(function () {
  "use strict";

  var UI = function () { return window.TruckMoveUI; };
  var TM = function () { return window.TruckMove; };

  // How many matches the property sheet shows before handing over to the
  // directory. Four fills a phone screen without becoming a second catalogue
  // inside the first one.
  var SHOWN = 4;

  /**
   * The load size this listing implies.
   *
   * A guess, and labelled as one in the copy, but a guess from the listing's
   * own facts rather than from nothing. Business premises are their own
   * answer: a shop's contents have no relationship to its bedroom count.
   */
  function guessLoad(h) {
    if (!h) return "two_bed";
    var type = String(h.type || "").toLowerCase();
    if (type === "shop" || type === "office" || type === "warehouse") return "shop";
    if (type === "plot") return "materials";
    var beds = Number(h.bedrooms);
    if (!isFinite(beds) || beds <= 0) return "studio";
    if (beds === 1) return "one_bed";
    if (beds === 2) return "two_bed";
    if (beds === 3) return "three_bed";
    return "big_house";
  }

  /** Where this listing is, as a place a person would name. */
  function houseWhere(h) {
    return [h && h.area, h && h.region].filter(Boolean).join(", ") ||
      (h && h.title) || "";
  }

  /**
   * Mount the panel.
   *
   * @param {HTMLElement} root  the container inside the property sheet
   * @param {object} house      the listing being read
   */
  function mount(root, house) {
    if (!root || !TM() || !UI()) return;
    var ui = UI(), T = ui.T, esc = ui.esc, fill = ui.fill;

    var ctx = {
      to: TM().usable(house) ? { lat: Number(house.lat), lng: Number(house.lng) } : null,
      toLabel: houseWhere(house),
      toRegion: house && house.region ? house.region : null,
      from: null,
      load: guessLoad(house),
      tripKm: null,
      house: house && house.id ? house.id : null,
    };

    var trucks = null;       // the catalogue, fetched once
    var rows = [];           // the ranked answer
    var busy = false;
    var gl = null;           // the measurement map, built the first time it is needed
    var shown = null;        // which lorry the map is currently drawing
    var shownLine = null;    // and the road it was drawn with, so a repaint is free

    root.classList.add("tm");
    root.innerHTML = shell();
    var loadsEl = root.querySelector("[data-tm-loads]");
    var msgEl = root.querySelector("[data-tm-msg]");
    var listEl = root.querySelector("[data-tm-results]");
    var goBtn = root.querySelector("[data-tm-go]");
    var allEl = root.querySelector("[data-tm-all]");
    var fromEl = root.querySelector("#tmFromValue");
    var fromBtn = root.querySelector("#tmFromBtn");
    var doorsEl = root.querySelector("[data-tm-doors]");
    var measureEl = root.querySelector("[data-tm-measure]");

    wireLoads();
    wireDoors();
    if (fromBtn) fromBtn.addEventListener("click", function () { toggleDoors(); });
    if (goBtn) goBtn.addEventListener("click", function () { run(); });
    paintAll();

    // A fix somebody else on this page already paid for. js/lib/house-you.js
    // puts the reader on the map at the top of the sheet; if they pressed that
    // button, this planner already knows where their things are and must not
    // raise a second prompt for the same answer.
    var held = window.PawaMaps && window.PawaMaps.knownOrigin
      ? window.PawaMaps.knownOrigin() : null;
    if (held) setFrom(held, T("tm_from_here", "Where you are now"), true);
    window.addEventListener("pawa:house-origin", function (e) {
      var p = e && e.detail && e.detail.from;
      if (!p || ctx.from) return;
      setFrom(p, e.detail.approximate ? T("tm_from_approx", "Near you, roughly")
                                      : T("tm_from_here", "Where you are now"), true);
    });

    // ---- the markup ------------------------------------------------------
    function shell() {
      var noPin = !ctx.to;
      return (
        '<p class="tm-load__hint">' + esc(T("tm_load_q", "What are you moving?")) + "</p>" +
        '<div data-tm-loads>' + ui.loadsHtml(ctx.load) + "</div>" +
        '<div class="tm-legs">' +
          ui.legHtml({
            icon: "gps", label: T("tm_leg_from", "Your things are in"),
            value: T("tm_from_unknown", "Not set yet"), empty: true,
            id: "tmFromValue",
            action: T("tm_set", "Set"), actionId: "tmFromBtn",
          }) +
          ui.doorsHtml(window.PawaMaps ? window.PawaMaps.savedPlaces() : []) +
          ui.legHtml({
            icon: "home", label: T("tm_leg_to", "Moving to"),
            value: ctx.toLabel || T("tm_to_this", "This property"),
            empty: false,
          }) +
        "</div>" +
        (noPin
          ? '<p class="tm-msg is-warn">' +
              esc(T("tm_no_pin", "This listing has no pin yet, so the length of the move cannot be measured. The trucks below are still the ones nearest you.")) +
            "</p>"
          : "") +
        measureShell() +
        '<button type="button" class="tm-go" data-tm-go>' + ui.ico("truck", 18) +
          "<span>" + esc(T("tm_find", "Find trucks for this move")) + "</span></button>" +
        '<p class="tm-msg" data-tm-msg role="status" aria-live="polite" hidden></p>' +
        '<div data-tm-results></div>' +
        '<a class="tm-go tm-go--quiet" data-tm-all hidden href="trucks.html">' +
          ui.ico("truck", 18) + "<span>" +
          esc(T("tm_all", "See every truck for this move")) + "</span></a>"
      );
    }

    /**
     * The measurement, as a map and a legend.
     *
     * Hidden until there is something true to draw. Three rows, and they are
     * the three distances truck-match.js keeps apart on purpose: what the
     * lorry drives empty to reach your things, what it then drives loaded, and
     * the sum, which is the only one an owner prices. Each row carries the
     * same line the map draws it with, so a number and a line can never come
     * apart in the reader's head.
     */
    function measureShell() {
      return '<div class="tm-measure" data-tm-measure hidden>' +
        '<div class="tm-measure__map" data-tm-map></div>' +
        '<div class="tm-measure__legs" data-tm-legs></div>' +
        '<p class="tm-measure__note">' + esc(T("tm_trip_note",
          "The owner quotes the price. This is the distance they will be quoting for.")) +
        "</p></div>";
    }

    /** One row of the legend: the line it is drawn with, the figure, the words. */
    function legRow(kind, km, words) {
      return '<div class="tm-measure__leg' + (kind === "total" ? " is-total" : "") + '">' +
        '<span class="tm-measure__key is-' + kind + '" aria-hidden="true"></span>' +
        '<b class="tm-measure__n">' +
          esc(km == null ? T("tm_not_measured", "not measured") : TM().kmText(km)) + "</b>" +
        "<span>" + esc(words) + "</span></div>";
    }

    function wireLoads() {
      if (!loadsEl) return;
      loadsEl.addEventListener("click", function (e) {
        var b = e.target.closest("[data-tm-load]");
        if (!b) return;
        ctx.load = b.dataset.tmLoad;
        loadsEl.querySelectorAll("[data-tm-load]").forEach(function (x) {
          x.setAttribute("aria-pressed", String(x.dataset.tmLoad === ctx.load));
        });
        paintAll();
        // Changing the size after a search re-ranks what is already on screen
        // rather than making somebody press the button twice.
        if (rows.length) { rank(); paintResults(); }
      });
    }

    // ---- state -> screen -------------------------------------------------
    function say(text, warn) {
      if (!msgEl) return;
      msgEl.hidden = !text;
      msgEl.textContent = text || "";
      msgEl.classList.toggle("is-warn", !!warn);
    }

    function paintAll() {
      if (fromEl) {
        var known = ctx.from;
        fromEl.textContent = known
          ? (ctx.fromLabel || T("tm_from_here", "Where you are now"))
          : T("tm_from_unknown", "Not set yet");
        fromEl.classList.toggle("is-empty", !known);
      }
      if (fromBtn) {
        fromBtn.textContent = ctx.from ? T("tm_change", "Change") : T("tm_set", "Set");
      }
      if (allEl) {
        allEl.href = "trucks.html" + (function () {
          var q = TM().encode(ctx);
          return q ? "?" + q : "";
        })();
      }
    }

    // ---- where your things are: the four doors ---------------------------

    function toggleDoors(force) {
      if (!doorsEl) return;
      var on = force === undefined ? doorsEl.hidden : !!force;
      doorsEl.hidden = !on;
      if (on) {
        var input = doorsEl.querySelector("[data-tm-where-input]");
        // Not focused on a phone: the keyboard would cover the buttons above
        // it, which are the answers that cost no typing at all.
        if (input && window.innerWidth > 720) input.focus();
      }
    }

    function wireDoors() {
      if (!doorsEl) return;
      doorsEl.addEventListener("click", function (e) {
        var b = e.target.closest("[data-tm-door]");
        if (b) {
          if (b.dataset.tmDoor === "gps") { locate(true); return; }
          var places = window.PawaMaps ? window.PawaMaps.savedPlaces() : [];
          var p = places[Number(b.dataset.tmI)];
          if (p) setFrom({ lat: Number(p.lat), lng: Number(p.lng) }, p.name || "");
          return;
        }
        if (e.target.closest("[data-tm-where-go]")) resolveTyped();
      });
      var input = doorsEl.querySelector("[data-tm-where-input]");
      if (input) {
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); resolveTyped(); }
        });
      }
    }

    /**
     * A typed area becomes a point.
     *
     * pawaGeo.suggest() reads our own gazetteer before it asks a geocoder, so
     * a ward somebody typed from memory usually resolves with no round trip.
     * The top usable row is the answer; there is no picker, because the pickup
     * is re-editable and a wrong one costs one more tap, where a list of five
     * places costs everybody a decision. Same choice as trucks.html.
     */
    async function resolveTyped() {
      var input = doorsEl && doorsEl.querySelector("[data-tm-where-input]");
      var q = ((input && input.value) || "").trim();
      if (q.length < 2 || !window.pawaGeo) return;
      say(T("tm_looking", "Looking that place up."));
      try {
        var hits = await window.pawaGeo.suggest(q, { limit: 5, near: ctx.to });
        var hit = (hits || []).find(function (h) { return TM().usable(h); });
        if (!hit) {
          say(T("tm_where_miss", "We could not find that place. Try the ward or the town."), true);
          return;
        }
        say("");
        if (input) input.value = "";
        setFrom({ lat: Number(hit.lat), lng: Number(hit.lng) },
                [hit.name, hit.context].filter(Boolean).join(", "));
      } catch (_) {
        say(T("tm_where_miss", "We could not find that place. Try the ward or the town."), true);
      }
    }

    /**
     * One place the origin is written down, whichever door it came through.
     *
     * `quiet` is set when the fix came from elsewhere on the page, in which
     * case the panel takes it without re-ranking a search nobody has started.
     */
    function setFrom(p, label, quiet) {
      ctx.from = { lat: Number(p.lat), lng: Number(p.lng) };
      ctx.fromLabel = label || T("tm_from_here", "Where you are now");
      toggleDoors(false);
      paintAll();
      if (quiet && !rows.length) { measureTrip(); return; }
      // A pickup that moves invalidates every road measured from the old one,
      // so they go rather than sitting on the cards as figures about a place
      // nobody is moving from.
      ctx.roadKm = null;
      shownLine = null;
      measureTrip();
      if (rows.length) { rank(); paintResults(); measurePickups(); }
    }

    // ---- the measurement, drawn ------------------------------------------

    /** Build the map the first time there is a move worth drawing. */
    function ensureMap() {
      if (gl || !window.TruckMoveMap || !measureEl) return gl;
      var host = measureEl.querySelector("[data-tm-map]");
      if (!host) return null;
      // Unhidden BEFORE the map is built: maplibre measures its container on
      // construction, and a container inside a display:none block is 0x0, and
      // stays 0x0 until something resizes it.
      measureEl.hidden = false;
      gl = window.TruckMoveMap.mount(host);
      if (gl) {
        gl.setMove(ctx.from, ctx.to);
        gl.resize();
      }
      return gl;
    }

    function paintMeasure() {
      if (!measureEl) return;
      var pickup = (shown && shown._pickupKm != null) ? shown._pickupKm : null;
      var trip = ctx.tripKm;
      if (trip == null && pickup == null) { measureEl.hidden = true; return; }
      measureEl.hidden = false;
      if (gl) gl.resize();
      var legsEl = measureEl.querySelector("[data-tm-legs]");
      if (!legsEl) return;
      var total = (trip != null && pickup != null) ? trip + pickup : null;
      legsEl.innerHTML =
        legRow("pickup", pickup, shown
          ? fill(T("tm_leg_pickup_of", "{name} to your things, empty"),
                 { name: shown.title || T("td_truck", "Moving truck") })
          : T("tm_leg_pickup", "The lorry to your things, empty")) +
        legRow("trip", trip, T("tm_leg_trip", "Your things to the new home, loaded")) +
        (total != null
          ? legRow("total", total, T("tm_leg_total", "What the driver drives in all"))
          : "");
    }

    /**
     * Draw one lorry's own leg on the measurement map.
     *
     * The geometry is fetched here and nowhere else, and only for the lorry
     * being looked at: eighty roads nobody asked to see is the same request
     * bill and a slower answer for the one that was asked for.
     *
     * The FIGURE in the legend still comes from pickupKm(), never from this
     * call. Both are the same engine, and a legend that quietly switched to a
     * second measurement would put two numbers on one leg.
     */
    async function focusTruck(row) {
      var same = shown && row && String(shown.id) === String(row.id);
      shown = row || null;
      paintMeasure();
      // Nothing to put on a map: no pickup means no lorry leg to draw and no
      // trip to draw either, and building one here would un-hide an empty
      // square that paintMeasure has just decided should not be on screen.
      if (!row || !TM().usable(row) || !TM().usable(ctx.from)) return;
      var m = ensureMap();
      if (!m) return;
      // Repainting the results (a load size changed, the roads came back)
      // calls this again for the lorry already drawn. Re-fetching the same
      // road every time is a request per repaint for a line already on screen.
      if (same && shownLine) { m.setTruck(row, shownLine); return; }
      var line = [];
      if (window.pawaRoute && window.pawaRoute.route) {
        try {
          var r = await window.pawaRoute.route(
            { lat: Number(row.lat), lng: Number(row.lng) }, ctx.from);
          if (r && r.geojson && r.geojson.coordinates) line = r.geojson.coordinates;
        } catch (_) { line = []; }
      }
      if (!shown || String(shown.id) !== String(row.id)) return;   // somebody chose another
      shownLine = line;
      m.setTruck(row, line);
    }

    function paintResults() {
      if (!listEl) return;
      if (!rows.length) {
        listEl.innerHTML = "";
        if (allEl) allEl.hidden = false;
        return;
      }
      listEl.innerHTML =
        '<p class="tm-count">' + esc(countText()) + "</p>" +
        ui.listHtml(rows, ctx, {
          limit: SHOWN,
          // Every card can take over the map above it. Without this the map
          // could only ever show the top match, and "which of these four is
          // on my side of town" is exactly the question four cards raise.
          extra: function (r) {
            if (!window.TruckMoveMap || !TM().usable(r)) return "";
            var label = T("tm_show_on_map", "Show this one on the map");
            return '<button type="button" class="tm-act tm-act--show" data-tm-show="' +
              ui.esc(String(r.id)) + '" aria-label="' + ui.esc(label) + '">' +
              ui.ico("route", 14) + "<span>" + ui.esc(label) + "</span></button>";
          },
        });
      if (allEl) allEl.hidden = false;
      paintAll();
      // The top match owns the map until somebody says otherwise. A map that
      // opened empty beside four results would be a control nobody presses.
      if (!shown || !rows.some(function (r) { return r.id === shown.id; })) {
        focusTruck(rows[0]);
      } else {
        focusTruck(rows.filter(function (r) { return r.id === shown.id; })[0]);
      }
    }

    // One delegated listener on the results, bound once at mount. Re-binding
    // per card after every repaint is how four cards end up with six handlers.
    if (listEl) {
      listEl.addEventListener("click", function (e) {
        var b = e.target.closest("[data-tm-show]");
        if (!b || !listEl.contains(b)) return;
        var row = rows.filter(function (r) { return String(r.id) === b.dataset.tmShow; })[0];
        if (!row) return;
        focusTruck(row);
        if (measureEl && measureEl.scrollIntoView) {
          measureEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    }

    function countText() {
      var n = rows.length;
      if (ctx.from) {
        return fill(T("tm_count_near", "{n} trucks can do this move. The nearest is first."), { n: n });
      }
      return fill(T("tm_count", "{n} trucks can do this move."), { n: n });
    }

    // ---- the work --------------------------------------------------------

    /**
     * Ask the device where we are.
     *
     * `soft` is true when the person pressed the location button themselves,
     * which is the one case where a refusal deserves a visible sentence: they
     * asked for it. During a search a refusal is silent, because the search
     * carries on perfectly well without it and two messages about one prompt
     * reads as an argument.
     */
    async function locate(soft) {
      if (!window.pawaLocate) return null;
      say(T("tm_locating", "Getting your location."));
      try {
        var fix = await window.pawaLocate.bestOrApprox({ targetAccuracy: 60, maxWaitMs: 12000 });
        // Through setFrom like every other door, so the picker closes, the
        // stale roads are dropped and the map is re-drawn in one place rather
        // than in four slightly different ones.
        setFrom({ lat: fix.lat, lng: fix.lng }, fix.approximate
          ? T("tm_from_approx", "Near you, roughly")
          : T("tm_from_here", "Where you are now"));
        // Shared, so the map at the top of the sheet can put the reader on it
        // without asking for the same permission a second time.
        try {
          window.dispatchEvent(new CustomEvent("pawa:house-origin", {
            detail: { from: ctx.from, approximate: !!fix.approximate },
          }));
        } catch (_) {}
        say("");
        return ctx.from;
      } catch (e) {
        if (soft) {
          say((e && e.message) || T("tm_gps_fail",
            "We could not get your location. The trucks below are still ranked by size and coverage."), true);
        } else {
          say("");
        }
        return null;
      }
    }

    /**
     * Measure the move itself, once we know both ends.
     *
     * pawaRoute.route() is asked first because it answers with the road AND
     * its length in one call, and the panel now needs both: the figure for the
     * legend and the geometry for the line. Falling back to roadKm() keeps the
     * number when only the table endpoint is up. One call, one number, one
     * line, so the legend and the map can never be quoting different roads.
     */
    async function measureTrip() {
      if (!ctx.to || !ctx.from) {
        ctx.tripKm = null;
        if (gl) gl.setTripLine([]);
        paintMeasure();
        return;
      }
      var line = [], km = null;
      if (window.pawaRoute && window.pawaRoute.route) {
        try {
          var r = await window.pawaRoute.route(ctx.from, ctx.to);
          if (r && typeof r.km === "number") {
            km = r.km;
            if (r.geojson && r.geojson.coordinates) line = r.geojson.coordinates;
          }
        } catch (_) { /* fall through to the table endpoint */ }
      }
      if (km == null) km = await TM().roadKm(ctx.from, ctx.to);
      ctx.tripKm = km;
      if (km != null) {
        var m = ensureMap();
        if (m) { m.setMove(ctx.from, ctx.to); m.setTripLine(line); }
      }
      paintMeasure();
    }

    function rank() {
      rows = TM().rank(trucks || [], ctx);
    }

    async function run() {
      if (busy) return;
      busy = true;
      if (goBtn) goBtn.disabled = true;
      try {
        if (!ctx.from) await locate(false);

        if (!trucks) {
          say(T("tm_finding", "Finding trucks."));
          try {
            trucks = await window.DataStore.getTrucks();
          } catch (e) {
            trucks = [];
          }
        }
        rank();
        paintResults();

        // The two measurements that need the network come AFTER the list is on
        // screen. A ranked list with "measuring" on it is useful; a spinner
        // covering the same list while we time the roads is not.
        say(rows.length ? T("tm_measuring_all", "Measuring the roads.") : "");
        await Promise.all([measureTrip(), measurePickups()]);
        say("");
        if (!rows.length) paintResults();
      } finally {
        busy = false;
        if (goBtn) goBtn.disabled = false;
      }
    }

    /** Real road km from the pickup to each lorry, in one request. */
    async function measurePickups() {
      if (!ctx.from || !rows.length) return;
      // Only the handful on screen plus a little headroom: the customer is
      // choosing between these, and measuring eighty lorries they will never
      // scroll to costs the same request either way but delays this one.
      var head = rows.slice(0, Math.max(SHOWN * 3, 12));
      ctx.roadKm = await TM().pickupKm(head, ctx.from);
      rank();
      paintResults();
    }

    window.addEventListener("resize", function () { if (gl) gl.resize(); });
  }

  window.TruckMovePanel = { mount: mount, guessLoad: guessLoad };
})();
