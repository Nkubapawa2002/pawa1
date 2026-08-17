// ============================================================================
//  AreaBoundary — draw an administrative-area outline on a map.
//
//  When a user picks or searches an area on a houses map, we shade the actual
//  ward / suburb / district polygon it falls within (fetched via the Go gateway,
//  pawaGeo.boundary) so they can SEE what's inside that area — not just a pin.
//
//  Two renderers, one API, because houses uses two map libraries:
//    • MapLibre GL  — the main listings map (#housesMap)
//    • Leaflet      — the modal pickers (#alertModalMap, #mpModalMap)
//
//  window.AreaBoundary
//    .showOnMapLibre(map, geojson, {fit, bbox})   .clearMapLibre(map)
//    .showOnLeaflet(map,  geojson, {fit})         .clearLeaflet(map)
//
//  `geojson` is a GeoJSON geometry (Polygon / MultiPolygon / LineString…).
//  Everything is null-safe: a missing geometry, a non-area match, or an
//  un-ready map just no-ops, so a map without a boundary is never broken.
// ============================================================================

(function () {
  "use strict";

  const BRAND = "#0a6f4d";
  const SRC = "pawa-area-boundary";          // MapLibre source id
  const FILL = "pawa-area-boundary-fill";
  const LINE = "pawa-area-boundary-line";

  // Only polygonal geometries are worth shading. A Point match (e.g. a POI)
  // gives no useful outline.
  function isAreal(geo) {
    const t = geo && geo.type;
    return t === "Polygon" || t === "MultiPolygon" ||
           t === "LineString" || t === "MultiLineString" ||
           (t === "GeometryCollection" && Array.isArray(geo.geometries) && geo.geometries.some(isAreal));
  }

  function asFeature(geo) {
    return { type: "Feature", properties: {}, geometry: geo };
  }

  // ---- MapLibre ------------------------------------------------------------

  function showOnMapLibre(map, geojson, opts = {}) {
    if (!map || !geojson || !isAreal(geojson)) return;
    // The style must be loaded before addSource/addLayer. If it isn't yet,
    // retry once it is.
    if (!map.isStyleLoaded || !map.isStyleLoaded()) {
      map.once("load", () => showOnMapLibre(map, geojson, opts));
      return;
    }
    const data = asFeature(geojson);
    const src = map.getSource(SRC);
    if (src) {
      src.setData(data);
    } else {
      map.addSource(SRC, { type: "geojson", data });
      // Fill sits under the listing markers; a polygon-only filter keeps the
      // fill from erroring on LineString geometries.
      map.addLayer({
        id: FILL, type: "fill", source: SRC,
        filter: ["any", ["==", ["geometry-type"], "Polygon"], ["==", ["geometry-type"], "MultiPolygon"]],
        paint: { "fill-color": BRAND, "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: LINE, type: "line", source: SRC,
        paint: { "line-color": BRAND, "line-width": 2.5, "line-opacity": 0.9, "line-dasharray": [2, 1] },
      });
    }
    if (opts.fit !== false) fitMapLibre(map, opts.bbox, geojson);
  }

  function clearMapLibre(map) {
    if (!map || !map.getSource || !map.getSource(SRC)) return;
    [LINE, FILL].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
    map.removeSource(SRC);
  }

  function fitMapLibre(map, bbox, geojson) {
    const b = bbox && bbox.length === 4 ? bbox : bboxOf(geojson);
    if (!b) return;
    try {
      map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, maxZoom: 15, duration: 600 });
    } catch (_) { /* ignore fit failures */ }
  }

  // ---- Leaflet -------------------------------------------------------------

  function showOnLeaflet(map, geojson, opts = {}) {
    if (!map || !geojson || !isAreal(geojson) || typeof L === "undefined") return;
    clearLeaflet(map);
    const layer = L.geoJSON(asFeature(geojson), {
      style: { color: BRAND, weight: 2.5, opacity: 0.9, dashArray: "6 4", fillColor: BRAND, fillOpacity: 0.12 },
      interactive: false,
    }).addTo(map);
    map._pawaBoundaryLayer = layer;
    if (opts.fit !== false) {
      try { map.fitBounds(layer.getBounds(), { padding: [30, 30], maxZoom: 15 }); } catch (_) {}
    }
    return layer;
  }

  function clearLeaflet(map) {
    if (map && map._pawaBoundaryLayer) {
      try { map.removeLayer(map._pawaBoundaryLayer); } catch (_) {}
      map._pawaBoundaryLayer = null;
    }
  }

  // ---- bbox of a geometry (fallback when the gateway didn't supply one) -----

  function bboxOf(geo) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const visit = (coords) => {
      if (typeof coords[0] === "number") {
        const [x, y] = coords;
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      } else {
        coords.forEach(visit);
      }
    };
    const geoms = geo.type === "GeometryCollection" ? geo.geometries : [geo];
    geoms.forEach((g) => { if (g && g.coordinates) visit(g.coordinates); });
    return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
  }

  window.AreaBoundary = { showOnMapLibre, clearMapLibre, showOnLeaflet, clearLeaflet, isAreal };
})();
