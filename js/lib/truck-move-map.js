// ============================================================================
//  truck-move-map.js — window.TruckMoveMap
//
//  THE MEASUREMENT, DRAWN.
//
//  The move planner has always been able to say "18 km by road". A number in a
//  pill is a fact somebody has to take on trust: it does not say which
//  direction, whether the lorry is on the far side of town, or whether the two
//  legs of the job are one short hop and one long haul or the other way round.
//  Every one of those changes what an owner will quote, and every one of them
//  is obvious the instant the same numbers are drawn.
//
//  So this is the three-distance rule from js/lib/truck-match.js, given a
//  picture:
//
//    the lorry's base  --- dashed gold --->  your things   (the pickup leg)
//    your things       --- solid green --->  the new home  (the move itself)
//
//  and the sum of the two is what the driver actually drives, which is the
//  number a price is built on. Three marks, two lines, no invention: THIS FILE
//  MEASURES NOTHING. It is handed geometry that a routing engine returned, and
//  draws it. When a caller has no geometry it draws nothing rather than a
//  straight line, because a ruled line between two points on a map is read as
//  a road by everyone who has ever used a map, and it is not one.
//
//  Used by js/lib/truck-move-panel.js. Guarded on maplibre-gl: a page without
//  it gets a planner with no map, never a broken planner.
//
//  Styling: section 5 of css/truck-move.css (.tm-measure*).
// ============================================================================
(function () {
  "use strict";

  function T(k, en) {
    var v = window.t ? window.t(k) : k;
    return (v === k && en != null) ? en : v;
  }

  function usable(p) {
    return !!p && isFinite(Number(p.lat)) && isFinite(Number(p.lng));
  }
  function ll(p) { return [Number(p.lng), Number(p.lat)]; }

  function token(name) {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch (_) { return ""; }
  }

  function emptyLine() {
    return { type: "Feature", geometry: { type: "LineString", coordinates: [] } };
  }

  /**
   * Put a map in this element.
   *
   * @param {HTMLElement} el
   * @returns {object|null} the handle, or null when there is no maplibre here
   */
  function mount(el) {
    if (!el || !window.maplibregl) return null;

    // Resolved once, from the page's own palette: this component lives on
    // three pages with three different skins and a baked hex would be the
    // wrong green on at least one of them.
    var GREEN = token("--green") || token("--green-emerald") || token("--green-neon");
    var GOLD  = token("--gold-warm") || token("--gold");

    var map = new maplibregl.Map({
      container: el,
      style: window.pawaGlHybridStyle ? window.pawaGlHybridStyle()
                                      : { version: 8, sources: {}, layers: [] },
      center: [35.0, -6.3],
      zoom: 5,
      maxBounds: [[29.34, -11.75], [40.45, -0.99]],
      attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    // The same trap as the property sheet's map: maplibre paints the compact
    // attribution OPEN on first render, which on a 190px map is a bar of
    // credits across a quarter of the picture. See js/lib/house-place.js.
    var shut = function () {
      var d = el.querySelector("details.maplibregl-ctrl-attrib");
      if (d) d.open = false;
    };
    shut();
    map.once("load", shut);
    map.once("idle", shut);
    // A map this small inside a scrolling page must not eat the scroll.
    try { map.scrollZoom.disable(); map.dragRotate.disable(); map.touchZoomRotate.disableRotation(); } catch (_) {}

    var ready = false;
    var marks = {};      // name -> maplibregl.Marker
    var ends = { from: null, to: null, base: null };

    function whenReady(fn) {
      if (ready || map.isStyleLoaded()) { fn(); return; }
      map.once("load", function () { ready = true; fn(); });
    }

    function initLines() {
      if (map.getSource("tm-trip")) return;
      // The pickup leg sits UNDER the move, because the move is the job and
      // the deadhead is the overhead.
      map.addSource("tm-pickup", { type: "geojson", data: emptyLine() });
      map.addLayer({ id: "tm-pickup-casing", type: "line", source: "tm-pickup",
        paint: { "line-color": "#fff", "line-width": 5, "line-opacity": 0.65 } });
      map.addLayer({ id: "tm-pickup", type: "line", source: "tm-pickup",
        paint: { "line-color": GOLD, "line-width": 3, "line-opacity": 0.95,
                 "line-dasharray": [2, 1.4] } });

      map.addSource("tm-trip", { type: "geojson", data: emptyLine() });
      map.addLayer({ id: "tm-trip-casing", type: "line", source: "tm-trip",
        paint: { "line-color": "#fff", "line-width": 6, "line-opacity": 0.9 } });
      map.addLayer({ id: "tm-trip", type: "line", source: "tm-trip",
        paint: { "line-color": GREEN, "line-width": 3.4, "line-opacity": 0.97 } });
    }

    function setLine(id, coords) {
      whenReady(function () {
        initLines();
        var s = map.getSource(id);
        if (s) {
          s.setData({ type: "Feature",
            geometry: { type: "LineString", coordinates: coords || [] } });
        }
      });
    }

    /**
     * One mark. Three shapes, never three colours of one shape: a dot is a
     * person, a teardrop is a place, a square is a vehicle, and that reading
     * survives a phone in the sun and an eye that cannot separate the hues.
     */
    function setMark(name, point, kind, label) {
      if (!usable(point)) {
        if (marks[name]) { marks[name].remove(); delete marks[name]; }
        return;
      }
      if (!marks[name]) {
        var node = document.createElement("div");
        node.className = "tm-mark is-" + kind;
        if (label) node.setAttribute("aria-label", label);
        marks[name] = new maplibregl.Marker({
          element: node,
          anchor: kind === "home" ? "bottom" : "center",
        });
      }
      marks[name].setLngLat(ll(point)).addTo(map);
    }

    function fit(extraCoords) {
      var pts = [];
      ["from", "to", "base"].forEach(function (k) {
        if (usable(ends[k])) pts.push(ll(ends[k]));
      });
      (extraCoords || []).forEach(function (c) { pts.push(c); });
      if (!pts.length) return;
      whenReady(function () {
        try {
          var b = pts.reduce(function (bb, c) { return bb.extend(c); },
            new maplibregl.LngLatBounds(pts[0], pts[0]));
          map.fitBounds(b, { padding: { top: 34, right: 30, bottom: 44, left: 30 },
                             maxZoom: 14, duration: 600 });
        } catch (_) {}
      });
    }

    return {
      map: map,

      /** The two ends of the move. Called as soon as both are known. */
      setMove: function (from, to) {
        ends.from = usable(from) ? from : null;
        ends.to = usable(to) ? to : null;
        setMark("from", ends.from, "me", T("tm_leg_from", "Your things are in"));
        setMark("to", ends.to, "home", T("tm_leg_to", "Moving to"));
        fit();
      },

      /** The road of the move, as a routing engine returned it. */
      setTripLine: function (coords) {
        setLine("tm-trip", coords);
        if (coords && coords.length) fit(coords);
      },

      /** Which lorry is being looked at, and the road from its base to the load. */
      setTruck: function (row, coords) {
        ends.base = usable(row) ? { lat: Number(row.lat), lng: Number(row.lng) } : null;
        setMark("base", ends.base, "truck", (row && row.title) || T("td_truck", "Moving truck"));
        setLine("tm-pickup", coords || []);
        fit(coords);
      },

      /** The container changed size (it was hidden, or the panel grew). */
      resize: function () { try { map.resize(); } catch (_) {} },

      destroy: function () {
        Object.keys(marks).forEach(function (k) { marks[k].remove(); });
        marks = {};
        try { map.remove(); } catch (_) {}
      },
    };
  }

  window.TruckMoveMap = { mount: mount };
})();
