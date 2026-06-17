// ============================================================================
//  pawaPoly — tiny, dependency-free polygon geometry for AREA ALERTS.
//
//  A user can watch an exact shape (a drawn neighbourhood, or a whole ward /
//  suburb boundary) instead of just a circle. To decide whether a new listing
//  falls inside that shape we need a fast, robust point-in-polygon test that
//  works on the GeoJSON the boundary service returns (Polygon / MultiPolygon,
//  holes included). Coordinates are GeoJSON order: [lng, lat].
//
//  window.pawaPoly
//    .pointInGeom(lng, lat, geo, bbox?)  → bool   (main entry; bbox = fast reject)
//    .pointInPolygon(lng, lat, rings)    → bool   (rings = [outer, hole…])
//    .pointInRing(lng, lat, ring)        → bool
//    .bboxOf(geo)      → [w, s, e, n] | null
//    .centroidOf(geo)  → { lat, lng } | null   (vertex average — a display anchor)
//
//  Everything is null-safe and never throws: bad input just returns false/null
//  so a malformed boundary can't break alert matching.
// ============================================================================
(function () {
  "use strict";

  // Ray-casting (even–odd rule). Counts how many polygon edges a ray cast east
  // from the point crosses; odd = inside. Robust for the simple admin/drawn
  // polygons we deal with (no self-intersection handling needed).
  function pointInRing(x, y, ring) {
    if (!Array.isArray(ring) || ring.length < 3) return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect = ((yi > y) !== (yj > y)) &&
        (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // rings: [outerRing, hole1, hole2, …]. Inside the outer ring AND outside every
  // hole. Each ring is [[lng,lat], …].
  function pointInPolygon(x, y, rings) {
    if (!Array.isArray(rings) || !rings.length) return false;
    if (!pointInRing(x, y, rings[0])) return false;
    for (let k = 1; k < rings.length; k++) {
      if (pointInRing(x, y, rings[k])) return false;   // it's in a hole
    }
    return true;
  }

  function pointInGeom(x, y, geo, bbox) {
    if (!geo || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (Array.isArray(bbox) && bbox.length === 4) {
      if (x < bbox[0] || x > bbox[2] || y < bbox[1] || y > bbox[3]) return false;
    }
    switch (geo.type) {
      case "Polygon":      return pointInPolygon(x, y, geo.coordinates);
      case "MultiPolygon": return (geo.coordinates || []).some((poly) => pointInPolygon(x, y, poly));
      case "GeometryCollection": return (geo.geometries || []).some((g) => pointInGeom(x, y, g));
      default:             return false;
    }
  }

  function eachCoord(geo, fn) {
    if (!geo) return;
    const walk = (c) => {
      if (typeof c[0] === "number") fn(c[0], c[1]);
      else c.forEach(walk);
    };
    const geoms = geo.type === "GeometryCollection" ? (geo.geometries || []) : [geo];
    geoms.forEach((g) => { if (g && g.coordinates) walk(g.coordinates); });
  }

  function bboxOf(geo) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    eachCoord(geo, (x, y) => {
      if (x < w) w = x; if (x > e) e = x;
      if (y < s) s = y; if (y > n) n = y;
    });
    return Number.isFinite(w) ? [w, s, e, n] : null;
  }

  // Flatten a geometry to its rings (each ring = [[lng,lat], …]).
  function ringsOf(geo) {
    const out = [];
    if (!geo) return out;
    const pushPoly = (poly) => { if (Array.isArray(poly)) poly.forEach((r) => out.push(r)); };
    if (geo.type === "Polygon") pushPoly(geo.coordinates);
    else if (geo.type === "MultiPolygon") (geo.coordinates || []).forEach(pushPoly);
    else if (geo.type === "GeometryCollection") (geo.geometries || []).forEach((g) => ringsOf(g).forEach((r) => out.push(r)));
    return out;
  }

  // Vertex-average centre, ignoring each ring's duplicated closing vertex — a
  // cheap, stable anchor for "X km from your area" text (not a true area centroid).
  function centroidOf(geo) {
    let sx = 0, sy = 0, count = 0;
    for (const ring of ringsOf(geo)) {
      if (!Array.isArray(ring) || !ring.length) continue;
      let n = ring.length;
      if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) n--;
      for (let i = 0; i < n; i++) { sx += ring[i][0]; sy += ring[i][1]; count++; }
    }
    return count ? { lat: sy / count, lng: sx / count } : null;
  }

  // Metres between two lat/lng points (great-circle) — for circle areas.
  function haversineM(lat1, lng1, lat2, lng2) {
    const R = 6371000, rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // Is a point inside ONE watched area? Polygon areas carry { geo, bbox };
  // circle areas carry { lat, lng, radius_m }. Lets an alert mix both kinds.
  function pointInArea(x, y, area) {
    if (!area) return false;
    if (area.geo) return pointInGeom(x, y, area.geo, area.bbox);
    if (Number.isFinite(+area.lat) && Number.isFinite(+area.lng) && +area.radius_m > 0) {
      return haversineM(y, x, +area.lat, +area.lng) <= +area.radius_m;   // note: x=lng, y=lat
    }
    return false;
  }

  // OR across many areas — true if the point falls in ANY of them. This is how
  // one alert can watch "Mikocheni OR Mbezi OR Sinza" at once.
  function pointInAreas(x, y, areas) {
    return Array.isArray(areas) && areas.some((a) => pointInArea(x, y, a));
  }

  window.pawaPoly = { pointInRing, pointInPolygon, pointInGeom, bboxOf, centroidOf, haversineM, pointInArea, pointInAreas };
})();
