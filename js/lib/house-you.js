// ============================================================================
//  house-you.js — window.HouseYou
//
//  WHERE YOU ARE, AND WHERE THIS HOME IS, ON ONE MAP.
//
//  The map on a property sheet has always drawn exactly one thing: a green pin
//  on the house. That answers "where is it" only for somebody who already
//  knows the neighbourhood by its shape from above. For everybody else a
//  satellite square with one pin on it is a picture, not an answer, and the
//  question they actually have is the one the two Google Maps buttons
//  underneath quietly assume: how far is this from ME, and which way is it?
//
//  So this file puts the reader ON the map beside the house, joins the two
//  with the real road, and says the distance in words above the buttons. After
//  that, "Directions in Google Maps" is a hand-off to a route the reader has
//  already seen the shape of, rather than a leap.
//
//  THREE RULES IT KEEPS
//
//  1. NOTHING IS ASKED FOR ON LOAD. A fix that js/lib/maps-handoff.js already
//     holds (fresh, under twenty minutes) is used immediately and costs
//     nothing. Otherwise there is one button, and the permission prompt is
//     tied to pressing it. Opening a listing must never raise a location
//     prompt.
//  2. A ROAD IS A ROAD AND A STRAIGHT LINE IS NOT. The solid green line is
//     geometry a routing engine returned. When no route comes back the line is
//     dashed amber and the sentence says "in a straight line", because a
//     crow-flies number dressed up as a drive is the one lie this whole part
//     of the app refuses to tell. Same rule, same two colours, as the commute
//     tool beside it.
//  3. THE FIX IS SHARED, NOT RE-ASKED. Every fix is announced on
//     `pawa:house-origin`, and js/lib/truck-move-panel.js listens: press once
//     here and the move planner further down the page already knows where your
//     things are. Two prompts for one answer is how a permission gets refused
//     for good.
//
//  Styling: section 13 of css/house-detail.css (.hd-you*). Depends at call
//  time on maplibre-gl, and optionally on PawaMaps, pawaLocate and pawaRoute,
//  each guarded: a listing whose distance cannot be measured is still a
//  listing.
// ============================================================================
(function () {
  "use strict";

  function T(k, en) {
    var v = window.t ? window.t(k) : k;
    return (v === k && en != null) ? en : v;
  }
  function fill(s, vars) {
    return String(s).replace(/\{(\w+)\}/g, function (m, k) {
      return (vars && k in vars) ? vars[k] : m;
    });
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // The two line colours, read off the page's own tokens so a brand change
  // carries. Identical pair to js/lib/house-place.js: measured road is brand
  // green, estimate is amber, and they must never swap meaning between two
  // lines drawn on the same square of map.
  function token(name) {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch (_) { return ""; }
  }
  // Read, never written down. maplibre paint properties take a colour STRING,
  // so a var() cannot be handed to them and the value has to be resolved here;
  // resolving it from three brand names in turn is how it is done without a
  // hex literal in this file that a design-system change would leave behind.
  var ROAD_COLOR = token("--green") || token("--green-emerald") || token("--green-neon");
  // The amber that means "this is an estimate, not a measured road". Written
  // out rather than taken from --warn because its twin, COMMUTE_EST in
  // js/lib/house-place.js, is this exact value, and two different ambers on
  // one square of map would read as two different claims.
  var EST_COLOR  = "#b26a00";

  var ICO = {
    gps:  '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>' +
          '<circle cx="12" cy="12" r="8"/>',
    car:  '<path d="M5 17h14M6.5 17V9.8l1.7-3.3a2 2 0 0 1 1.8-1.1h4a2 2 0 0 1 1.8 1.1l1.7 3.3V17"/>' +
          '<path d="M6.5 10h11"/><circle cx="8.5" cy="17" r="1.6"/><circle cx="15.5" cy="17" r="1.6"/>',
    spin: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  };
  function ico(name, size) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"' +
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="' +
      (size || 16) + '" height="' + (size || 16) + '">' + (ICO[name] || "") + "</svg>";
  }

  /** "800 m" / "4.2 km" / "137 km". The same rounding the truck planner uses. */
  function kmText(k) {
    if (typeof k !== "number" || !isFinite(k)) return "";
    if (k < 1) return Math.round(k * 1000) + " m";
    return (k < 10 ? k.toFixed(1) : String(Math.round(k))) + " km";
  }

  /** Straight-line km, for the honest fallback sentence only. */
  function directKm(a, b) {
    var R = 6371, rad = function (d) { return (d * Math.PI) / 180; };
    var dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  // A loaded car on Tanzanian roads, town and highway averaged. Only ever used
  // beside a distance a routing engine measured; it never turns a straight
  // line into minutes.
  var AVG_KMH = 30;
  function driveMin(k) {
    return (typeof k === "number" && isFinite(k)) ? Math.max(1, Math.round((k / AVG_KMH) * 60)) : null;
  }

  /**
   * Mount the strip under the map.
   *
   * @param {object} o
   * @param {maplibregl.Map} o.map
   * @param {{lat:number,lng:number}} o.home
   * @param {string} [o.where]  the home's area and region, as a person says it
   */
  function mount(o) {
    var root = document.getElementById("hdYou");
    if (!root || !o || !o.map || !o.home) return;
    var map = o.map, home = o.home;
    var where = o.where || "";

    var from = null;          // the fix, once we have one
    var approx = false;       // city-level rather than GPS
    var marker = null;
    var lineReady = false;
    var seq = 0;              // so a slow route cannot overwrite a newer one

    root.hidden = false;
    paintAsk();

    // A fix maps-handoff.js is already holding costs nothing and asks nobody.
    // Under twenty minutes old, or it would put somebody in the last town they
    // were in and call it "where you are now".
    var held = window.PawaMaps && window.PawaMaps.knownOrigin
      ? window.PawaMaps.knownOrigin() : null;
    if (held) use(held, false);

    // Somebody else on this page found the reader first. The move planner asks
    // for a fix too, and the two must never prompt separately for one answer.
    window.addEventListener("pawa:house-origin", function (e) {
      var p = e && e.detail && e.detail.from;
      if (!p || from) return;
      use(p, !!(e.detail && e.detail.approximate), true);
    });

    // ---- the two states ---------------------------------------------------

    /** Before we know: one button, and what pressing it buys. */
    function paintAsk(msg, warn) {
      root.className = "hd-you";
      root.innerHTML =
        '<button type="button" class="hd-you__ask" id="hdYouBtn">' +
          '<span class="hd-you__ask-ic">' + ico("gps", 18) + "</span>" +
          '<span class="hd-you__ask-tx">' +
            '<span class="hd-you__ask-t">' + esc(T("hs_you_btn", "Show me where I am")) + "</span>" +
            '<small class="hd-you__ask-d">' + esc(msg || T("hs_you_d",
              "Put yourself on this map beside the home, and see how far apart the two are.")) +
            "</small>" +
          "</span>" +
        "</button>";
      if (warn) root.classList.add("is-warn");
      var btn = root.querySelector("#hdYouBtn");
      if (btn) btn.addEventListener("click", function () { locate(btn); });
    }

    /**
     * After: the two ends of the journey, one above the other, joined.
     *
     * A spine rather than a row. At 390px a row puts three things and a number
     * on one line and truncates the only two words that name what the reader
     * is looking at; stacked, each end keeps its own name and its own address
     * line, and the distance sits in the join where it belongs.
     */
    function paintPair(spanHtml) {
      root.className = "hd-you is-on";
      root.innerHTML =
        '<div class="hd-you__pair">' +
          '<div class="hd-you__end">' +
            '<span class="hd-you__mark is-me" aria-hidden="true"></span>' +
            '<span class="hd-you__end-tx">' +
              '<span class="hd-you__end-t">' + esc(T("hs_you_me", "Where you are now")) + "</span>" +
              (approx
                ? '<small class="hd-you__end-d">' +
                    esc(T("hs_you_approx", "Roughly. Your phone gave the area, not the exact spot.")) +
                  "</small>"
                : "") +
            "</span>" +
            '<button type="button" class="hd-you__again" id="hdYouAgain">' +
              esc(T("hs_you_again", "Update")) + "</button>" +
          "</div>" +
          '<div class="hd-you__span" id="hdYouSpan">' + spanHtml + "</div>" +
          '<div class="hd-you__end">' +
            '<span class="hd-you__mark is-home" aria-hidden="true"></span>' +
            '<span class="hd-you__end-tx">' +
              '<span class="hd-you__end-t">' + esc(T("hs_you_home", "This home")) + "</span>" +
              (where ? '<small class="hd-you__end-d">' + esc(where) + "</small>" : "") +
            "</span>" +
          "</div>" +
        "</div>";
      var again = root.querySelector("#hdYouAgain");
      if (again) again.addEventListener("click", function () { locate(again); });
    }

    /** The middle of the spine: whatever we can honestly say about the gap. */
    function spanHtml(state, km, min) {
      if (state === "measuring") {
        return '<span class="hd-you__km is-wait">' + ico("spin", 14) + "</span>" +
          '<small class="hd-you__gap">' + esc(T("hs_you_wait", "Measuring the road.")) + "</small>";
      }
      if (state === "road") {
        return '<span class="hd-you__km">' + esc(kmText(km)) + "</span>" +
          '<small class="hd-you__gap">' + ico("car", 13) + esc(fill(
            T("hs_you_road", "by road, about {min} minutes by car"), { min: min })) + "</small>";
      }
      return '<span class="hd-you__km is-est">' + esc(kmText(km)) + "</span>" +
        '<small class="hd-you__gap">' + esc(T("hs_you_line",
          "in a straight line. The road will be longer than this.")) + "</small>";
    }

    function setSpan(html) {
      var el = root.querySelector("#hdYouSpan");
      if (el) el.innerHTML = html;
    }

    // ---- asking the device ------------------------------------------------
    async function locate(btn) {
      if (!window.pawaLocate) return;
      if (btn) btn.disabled = true;
      if (!from) paintAsk(T("hs_you_asking", "Asking your phone where you are."));
      try {
        var fix = await window.pawaLocate.bestOrApprox({ targetAccuracy: 60, maxWaitMs: 12000 });
        use({ lat: fix.lat, lng: fix.lng }, !!fix.approximate, false);
      } catch (e) {
        // A refusal is an answer. The two Google Maps buttons below still work,
        // because Google uses the device's own location when we omit an origin,
        // and saying so is more use than an apology.
        paintAsk(T("hs_you_fail",
          "We could not get your location. The buttons below still work: Google Maps will use your phone."), true);
      }
    }

    /**
     * A fix, from wherever it came.
     *
     * `quiet` is true when another part of the page found it, in which case we
     * adopt it without re-announcing: two listeners passing one fix back and
     * forth is a loop, and the loop is silent until the day it is not.
     */
    function use(p, isApprox, quiet) {
      from = { lat: Number(p.lat), lng: Number(p.lng) };
      approx = !!isApprox;
      paintPair(spanHtml("measuring"));
      drawMe();
      fitBoth();
      tellTheRest(quiet);
      measure();
    }

    function tellTheRest(quiet) {
      if (quiet) return;
      try {
        window.dispatchEvent(new CustomEvent("pawa:house-origin", {
          detail: { from: from, approximate: approx },
        }));
      } catch (_) {}
    }

    // ---- the map ----------------------------------------------------------

    /** The reader, as a dot with a halo. Never the same shape as the pin. */
    function drawMe() {
      if (!marker) {
        var el = document.createElement("div");
        el.className = "hd-you-marker";
        el.setAttribute("aria-label", T("hs_you_me", "Where you are now"));
        marker = new maplibregl.Marker({ element: el, anchor: "center" });
      }
      marker.setLngLat([from.lng, from.lat]).addTo(map);
    }

    function emptyLine() {
      return { type: "Feature", geometry: { type: "LineString", coordinates: [] } };
    }

    /**
     * Its own source and layers, never the commute tool's.
     *
     * Both lines can be on this map at the same time (how far am I from the
     * house, and how far is the house from my work), and sharing one source
     * would mean whichever was measured last silently erased the other.
     */
    function initLine() {
      if (lineReady) return;
      var add = function () {
        if (!map.getSource("hd-you-line")) {
          map.addSource("hd-you-line", { type: "geojson", data: emptyLine() });
          // A white casing under the colour, because raw green on dark
          // satellite imagery reads as a crack in the picture rather than a
          // road. Same treatment as the commute line beside it.
          map.addLayer({
            id: "hd-you-line-casing", type: "line", source: "hd-you-line",
            paint: { "line-color": "#fff", "line-width": 6, "line-opacity": 0.9 },
          });
          map.addLayer({
            id: "hd-you-line", type: "line", source: "hd-you-line",
            paint: { "line-color": ROAD_COLOR, "line-width": 3, "line-opacity": 0.95 },
          });
        }
        lineReady = true;
      };
      if (map.isStyleLoaded()) add(); else map.once("load", add);
    }

    function setLine(coords, dashed) {
      initLine();
      var data = { type: "Feature", geometry: { type: "LineString", coordinates: coords } };
      var apply = function () {
        var s = map.getSource("hd-you-line");
        if (s) s.setData(data);
        if (map.getLayer("hd-you-line")) {
          map.setPaintProperty("hd-you-line", "line-dasharray", dashed ? [2, 1.5] : [1, 0]);
          map.setPaintProperty("hd-you-line", "line-color", dashed ? EST_COLOR : ROAD_COLOR);
        }
      };
      if (map.getSource && map.getSource("hd-you-line")) apply(); else map.once("load", apply);
    }

    function fitBoth() {
      try {
        var b = new maplibregl.LngLatBounds([from.lng, from.lat], [from.lng, from.lat]);
        b.extend([home.lng, home.lat]);
        map.fitBounds(b, { padding: { top: 50, right: 40, bottom: 80, left: 40 },
                           maxZoom: 15, duration: 700 });
      } catch (_) {}
    }

    // ---- the measurement --------------------------------------------------
    async function measure() {
      var mine = ++seq;
      // The straight line goes down FIRST, dashed, so the map answers "which
      // way, and roughly how far" in the same frame the dot lands in. The road
      // replaces it a second or two later. An empty map with "measuring" under
      // it makes the reader wait for the part they already have.
      var direct = directKm(from, home);
      setLine([[from.lng, from.lat], [home.lng, home.lat]], true);

      var road = null;
      if (window.pawaRoute && window.pawaRoute.route) {
        try { road = await window.pawaRoute.route(from, home); } catch (_) { road = null; }
      }
      if (mine !== seq) return;

      if (road && road.geojson && road.geojson.coordinates) {
        setLine(road.geojson.coordinates, false);
        var mins = road.durationMin ? Math.max(1, Math.round(road.durationMin)) : driveMin(road.km);
        setSpan(spanHtml("road", road.km, mins));
        fitCoords(road.geojson.coordinates);
      } else {
        setSpan(spanHtml("direct", direct));
      }
    }

    function fitCoords(coords) {
      if (!coords || !coords.length) return;
      try {
        var b = coords.reduce(function (bb, c) { return bb.extend(c); },
          new maplibregl.LngLatBounds(coords[0], coords[0]));
        map.fitBounds(b, { padding: { top: 50, right: 40, bottom: 80, left: 40 },
                           maxZoom: 15, duration: 600 });
      } catch (_) {}
    }
  }

  window.HouseYou = { mount: mount, kmText: kmText };
})();
