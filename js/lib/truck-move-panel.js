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
//  WHAT IT REFUSES TO DO
//  It does not hide a truck it is unsure about, it does not invent a price for
//  the move, and it does not show a straight-line distance dressed up as a
//  drive. js/lib/truck-match.js keeps those three promises; this file only has
//  to not undo them.
//
//  Depends at call time on: TruckMove, TruckMoveUI, DataStore, pawaLocate.
//  Every one is guarded, because a property sheet that cannot find a lorry
//  must still be a property sheet.
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

    root.classList.add("tm");
    root.innerHTML = shell();
    var loadsEl = root.querySelector("[data-tm-loads]");
    var msgEl = root.querySelector("[data-tm-msg]");
    var tripEl = root.querySelector("[data-tm-trip]");
    var listEl = root.querySelector("[data-tm-results]");
    var goBtn = root.querySelector("[data-tm-go]");
    var allEl = root.querySelector("[data-tm-all]");
    var fromEl = root.querySelector("#tmFromValue");
    var fromBtn = root.querySelector("#tmFromBtn");

    wireLoads();
    if (fromBtn) fromBtn.addEventListener("click", function () { locate(true); });
    if (goBtn) goBtn.addEventListener("click", function () { run(); });
    paintAll();

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
            action: T("tm_use_gps", "Use my location"), actionId: "tmFromBtn",
          }) +
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
        '<div class="tm-trip" data-tm-trip hidden></div>' +
        '<button type="button" class="tm-go" data-tm-go>' + ui.ico("truck", 18) +
          "<span>" + esc(T("tm_find", "Find trucks for this move")) + "</span></button>" +
        '<p class="tm-msg" data-tm-msg role="status" aria-live="polite" hidden></p>' +
        '<div data-tm-results></div>' +
        '<a class="tm-go tm-go--quiet" data-tm-all hidden href="trucks.html">' +
          ui.ico("truck", 18) + "<span>" +
          esc(T("tm_all", "See every truck for this move")) + "</span></a>"
      );
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
      if (allEl) {
        allEl.href = "trucks.html" + (function () {
          var q = TM().encode(ctx);
          return q ? "?" + q : "";
        })();
      }
    }

    function paintTrip() {
      if (!tripEl) return;
      if (ctx.tripKm == null) { tripEl.hidden = true; return; }
      var mins = TM().driveMin(ctx.tripKm);
      tripEl.hidden = false;
      tripEl.innerHTML =
        '<span class="tm-trip__n">' + esc(TM().kmText(ctx.tripKm)) + "</span>" +
        "<span>" + esc(fill(T("tm_trip", "by road from where you are, about {min} minutes of driving"),
                            { min: mins })) + "</span>" +
        '<span class="tm-trip__note">' +
          esc(T("tm_trip_note", "The owner quotes the price. This is the distance they will be quoting for.")) +
        "</span>";
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
        ui.listHtml(rows, ctx, { limit: SHOWN });
      if (allEl) allEl.hidden = false;
      paintAll();
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
        ctx.from = { lat: fix.lat, lng: fix.lng };
        ctx.fromLabel = fix.approximate
          ? T("tm_from_approx", "Near you, roughly")
          : T("tm_from_here", "Where you are now");
        paintAll();
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

    /** Measure the move itself, once we know both ends. */
    async function measureTrip() {
      if (!ctx.to || !ctx.from) { ctx.tripKm = null; paintTrip(); return; }
      var k = await TM().roadKm(ctx.from, ctx.to);
      ctx.tripKm = k;
      paintTrip();
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
  }

  window.TruckMovePanel = { mount: mount, guessLoad: guessLoad };
})();
