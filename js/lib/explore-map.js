/* ===========================================================================
 * explore-map.js — the map view for Explore.
 *
 * WHY THIS IS A SEPARATE FILE AND A LAZY LOAD
 *   Leaflet plus its CSS is ~160 KB, and Explore's whole promise is that
 *   search responds in a frame. Most visits never open the map. So nothing
 *   here is fetched until the map is actually asked for — the first tap on
 *   "Map" injects the library, everything before that costs nothing.
 *
 * WHAT IT DRAWS
 *   The SAME ranked results the list is showing — not a second query. A map
 *   that disagrees with the list underneath it is worse than no map, so
 *   `show()` takes the result array verbatim and never filters on its own.
 *
 * PRICE PILLS, NOT PINS
 *   A dot tells you a listing exists somewhere. A pill that reads "100k" in
 *   the vertical's own colour tells you what it is and what it costs without
 *   a single tap — which is the entire reason to look at a map of listings
 *   instead of a list of them.
 *
 * THE COMPANION OVERLAY
 *   This is the map's real job. Selecting a room draws its nearby trucks and
 *   fundis as smaller satellite markers, each tied back with a dashed line.
 *   The cross-vertical match that the list states in words — "trucks near
 *   this place" — becomes a thing you can see the shape of.
 *
 * VIEWPORT RENDERING INSTEAD OF CLUSTERING
 *   Thousands of overlapping pills would be unreadable, and a clustering
 *   plugin is another dependency on another CDN. Instead only markers inside
 *   the current bounds are drawn, capped and re-drawn on move — the same
 *   trick js/pages/near-me.js uses for its reference pins. Panning is what
 *   reveals more, which is what people already expect a map to do.
 * =========================================================================== */
(function () {
  "use strict";

  var LEAFLET_CSS = "https://cdn.jsdelivr.net/npm/leaflet@1.9/dist/leaflet.css";
  var LEAFLET_JS  = "https://cdn.jsdelivr.net/npm/leaflet@1.9/dist/leaflet.js";

  // Tanzania, whole-country view — the fallback when there is no anchor and
  // nothing to fit.
  var TZ_CENTER = [-6.4, 35.0];
  var TZ_ZOOM = 6;

  // Most pills that can be on screen at once. Past this the map stops being
  // readable, and the honest fix is to zoom in, not to draw more.
  var MAX_MARKERS = 140;

  var KIND_COLOR = {
    room: "#2EE6A6", truck: "#F6C45A", service: "#A855F7", job: "#FF8A4C",
  };

  var map = null;
  var loading = null;
  var resultLayer = null;
  var compLayer = null;
  var anchorLayer = null;
  var rows = [];              // whatever show() was last given
  var state = { anchor: null, radiusKm: 0 };
  var selectedId = null;
  var handlers = {};
  var movedByUser = false;

  // ---- Lazy load ------------------------------------------------------------
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      if (!document.querySelector('link[href="' + LEAFLET_CSS + '"]')) {
        var link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = LEAFLET_CSS;
        document.head.appendChild(link);
      }
      var s = document.createElement("script");
      s.src = LEAFLET_JS;
      s.async = true;
      s.onload = function () { resolve(window.L); };
      // A CDN that is blocked or slow must not leave the button spinning
      // forever — the caller falls back to the list and says so.
      s.onerror = function () { reject(new Error("leaflet_unavailable")); };
      document.head.appendChild(s);
    });
    return loading;
  }

  // ---- Markers --------------------------------------------------------------
  function compact(n) {
    n = Number(n) || 0;
    if (!n) return "";
    if (n >= 1e9) return (n / 1e9).toFixed(n % 1e9 ? 1 : 0) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "k";
    return String(n);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function pillIcon(item, isSelected) {
    var label = item.price ? compact(item.price) : "•";
    var cls = "xm-pill xm-" + item.kind + (isSelected ? " is-sel" : "");
    // iconSize [0,0] + a transform in CSS: Leaflet cannot know how wide a
    // variable-length price label will be, so the element centres itself.
    return window.L.divIcon({
      className: "xm-pin",
      html: '<span class="' + cls + '">' + esc(label) + "</span>",
      iconSize: [0, 0], iconAnchor: [0, 0],
    });
  }

  function companionIcon(item) {
    return window.L.divIcon({
      className: "xm-pin",
      html: '<span class="xm-comp xm-' + item.kind + '"></span>',
      iconSize: [0, 0], iconAnchor: [0, 0],
    });
  }

  function popupHtml(item, distKm) {
    var where = [item.area, item.region].filter(Boolean).join(", ");
    var price = item.price ? "TZS " + compact(item.price) : "Ask for price";
    return '<div class="xm-pop">' +
      '<span class="xm-pop-k xm-' + item.kind + '">' + esc(item.kind) + "</span>" +
      '<div class="xm-pop-t">' + esc(item.title) + "</div>" +
      (where ? '<div class="xm-pop-m">' + esc(where) +
        (distKm != null ? " · " + (distKm < 1 ? Math.round(distKm * 1000) + " m" : distKm.toFixed(1) + " km") : "") +
        "</div>" : "") +
      '<div class="xm-pop-p">' + esc(price) + "</div>" +
      '<a class="xm-pop-go" href="' + esc(item.href) + '">Open</a>' +
      "</div>";
  }

  // ---- Drawing --------------------------------------------------------------
  function drawResults() {
    if (!map || !resultLayer) return;
    resultLayer.clearLayers();

    var bounds = map.getBounds();
    var drawn = 0;
    for (var i = 0; i < rows.length && drawn < MAX_MARKERS; i++) {
      var r = rows[i], it = r.item;
      if (!it.pinned) continue;
      if (!bounds.contains([it.lat, it.lng])) continue;
      drawn++;
      var marker = window.L.marker([it.lat, it.lng], {
        icon: pillIcon(it, it.id === selectedId),
        // Results are ranked, and the ranking should survive being drawn:
        // a better result sits above a worse one where pills overlap.
        zIndexOffset: (rows.length - i) + (it.id === selectedId ? 10000 : 0),
      });
      marker.bindPopup(popupHtml(it, r.distKm), { closeButton: true, autoPan: true });
      (function (item) {
        marker.on("click", function () { select(item); });
      })(it);
      marker.addTo(resultLayer);
    }

    if (handlers.onDrawn) {
      handlers.onDrawn({
        drawn: drawn,
        pinned: rows.filter(function (r) { return r.item.pinned; }).length,
        unpinned: rows.filter(function (r) { return !r.item.pinned; }).length,
        capped: drawn >= MAX_MARKERS,
      });
    }
  }

  function drawAnchor() {
    if (!map || !anchorLayer) return;
    anchorLayer.clearLayers();
    if (!state.anchor) return;
    var a = state.anchor;

    window.L.marker([a.lat, a.lng], {
      icon: window.L.divIcon({
        className: "xm-pin",
        html: '<span class="xm-anchor"><i></i></span>',
        iconSize: [0, 0], iconAnchor: [0, 0],
      }),
      interactive: false, keyboard: false, zIndexOffset: 5000,
    }).addTo(anchorLayer);

    // The radius is a promise the list is already keeping ("within 10 km").
    // Drawing it makes that promise checkable instead of merely stated.
    if (state.radiusKm) {
      window.L.circle([a.lat, a.lng], {
        radius: state.radiusKm * 1000,
        color: "#6EC8FF", weight: 1, opacity: .5,
        fillColor: "#6EC8FF", fillOpacity: .06,
        interactive: false,
      }).addTo(anchorLayer);
    }
  }

  /**
   * Draw one item's cross-vertical companions as satellites around it.
   * Each is tied back with a dashed line, so "these belong to that" is read
   * off the picture rather than inferred from proximity.
   */
  function drawCompanions(item) {
    if (!map || !compLayer) return;
    compLayer.clearLayers();
    if (!item || !item.pinned || !window.ExploreMatch || !handlers.getCatalogue) return;

    var groups = window.ExploreMatch.companionsFor(item, handlers.getCatalogue(), { maxGroups: 2 });
    groups.forEach(function (g) {
      g.items.forEach(function (c) {
        window.L.polyline(
          [[item.lat, item.lng], [c.item.lat, c.item.lng]],
          { color: KIND_COLOR[c.item.kind] || "#fff", weight: 1.2, opacity: .5,
            dashArray: "3 5", interactive: false }
        ).addTo(compLayer);

        var m = window.L.marker([c.item.lat, c.item.lng], {
          icon: companionIcon(c.item), zIndexOffset: 2000,
        });
        m.bindPopup(popupHtml(c.item, c.distKm));
        m.addTo(compLayer);
      });
    });
    if (handlers.onCompanions) handlers.onCompanions(groups);
  }

  function select(item) {
    selectedId = item ? item.id : null;
    drawResults();
    drawCompanions(item);
    if (handlers.onSelect) handlers.onSelect(item);
  }

  // ---- Public API -----------------------------------------------------------
  /**
   * Create the map inside `elOrId`. Resolves once Leaflet is up and the tiles
   * are attached; rejects if the CDN is unreachable.
   */
  async function mount(elOrId, opts) {
    handlers = opts || {};
    var host = typeof elOrId === "string" ? document.getElementById(elOrId) : elOrId;
    if (!host) throw new Error("no_host");
    if (map) return map;

    var L = await loadLeaflet();

    map = L.map(host, {
      scrollWheelZoom: true,
      zoomControl: true,
      attributionControl: true,
    }).setView(TZ_CENTER, TZ_ZOOM);

    if (typeof window.addSatelliteHybrid === "function") window.addSatelliteHybrid(map);
    else L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      { subdomains: "abcd", maxZoom: 19, attribution: "© CARTO © OpenStreetMap" }).addTo(map);

    anchorLayer = L.layerGroup().addTo(map);
    resultLayer = L.layerGroup().addTo(map);
    compLayer = L.layerGroup().addTo(map);

    // Redraw on every move: this is what makes viewport rendering work in
    // place of a clustering plugin.
    map.on("moveend", function () {
      drawResults();
      if (handlers.onMove) handlers.onMove(centre(), spanKm());
    });
    // Distinguish "the map moved because we fitted it" from "the user dragged
    // it" — only the latter should offer to re-search this area.
    map.on("dragstart zoomstart", function (e) {
      if (e.type === "dragstart") movedByUser = true;
    });

    return map;
  }

  /** Draw a result set. Fits the view to it unless the user has taken over. */
  function show(results, opts) {
    opts = opts || {};
    rows = results || [];
    state.anchor = opts.anchor || null;
    state.radiusKm = opts.radiusKm || 0;
    if (opts.selectedId !== undefined) selectedId = opts.selectedId;

    if (!map) return;
    drawAnchor();

    if (opts.fit !== false && !(movedByUser && opts.respectUserView)) {
      fit();
      movedByUser = false;
    }
    drawResults();
    // A selection is only meaningful while its item is still in the results.
    var sel = rows.filter(function (r) { return r.item.id === selectedId; })[0];
    drawCompanions(sel ? sel.item : null);
  }

  /** Frame the pinned results, or the anchor, or the country. */
  function fit() {
    if (!map) return;
    var pts = rows.filter(function (r) { return r.item.pinned; })
                  .slice(0, 60)
                  .map(function (r) { return [r.item.lat, r.item.lng]; });
    if (state.anchor) pts.push([state.anchor.lat, state.anchor.lng]);

    if (pts.length > 1) {
      try { map.fitBounds(pts, { padding: [46, 46], maxZoom: 15 }); return; } catch (_) {}
    }
    if (pts.length === 1) { map.setView(pts[0], 14); return; }
    map.setView(TZ_CENTER, TZ_ZOOM);
  }

  function centre() {
    if (!map) return null;
    var c = map.getCenter();
    return { lat: c.lat, lng: c.lng };
  }

  // Roughly how far the visible map reaches from its centre, in km. Used to
  // turn "search this area" into a real radius instead of a guess.
  function spanKm() {
    if (!map || !window.ExploreRank) return 0;
    var b = map.getBounds(), c = map.getCenter();
    return window.ExploreRank.haversineKm(c.lat, c.lng, b.getNorth(), c.lng);
  }

  function invalidate() {
    if (map) setTimeout(function () { try { map.invalidateSize(); } catch (_) {} }, 60);
  }

  function clearSelection() { select(null); }

  function destroy() {
    if (map) { try { map.remove(); } catch (_) {} }
    map = resultLayer = compLayer = anchorLayer = null;
    rows = [];
    selectedId = null;
    movedByUser = false;
  }

  window.ExploreMap = {
    mount: mount,
    show: show,
    fit: fit,
    select: select,
    clearSelection: clearSelection,
    invalidate: invalidate,
    destroy: destroy,
    centre: centre,
    spanKm: spanKm,
    isUp: function () { return !!map; },
    KIND_COLOR: KIND_COLOR,
  };
})();
