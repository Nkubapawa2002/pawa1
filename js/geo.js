// Shared geocoding helper — routes OpenStreetMap/Nominatim lookups through the
// Go map gateway (services/go) when one is available, and falls back to calling
// Nominatim directly if the gateway is unset or unreachable.
//
// The gateway's /osm/search and /osm/reverse endpoints are a verbatim
// passthrough: same query params in, same raw Nominatim JSON out — so callers
// keep their existing parsing untouched. The win is server-side caching, a
// 1 req/s rate limit, and a proper User-Agent (Nominatim blocks abusive direct
// browser traffic).
//
// Usage:
//   const list = await pawaGeo.search("format=jsonv2&limit=8&q=Mlimani+City");
//   const j    = await pawaGeo.reverse("format=jsonv2&zoom=16&lat=-6.7&lon=39.2");
(function () {
  "use strict";

  const NOMINATIM = "https://nominatim.openstreetmap.org";

  // Resolve the gateway base URL (no trailing slash), or "" for direct mode.
  function gatewayBase() {
    const cfg = (window.APP_CONFIG && window.APP_CONFIG.GEO_GATEWAY_URL) || "";
    if (cfg) return cfg.replace(/\/+$/, "");
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "") return "http://127.0.0.1:8091";
    return ""; // production with no gateway configured → call Nominatim directly
  }

  async function call(kind, qs) {
    qs = String(qs || "").replace(/^\?/, "");
    const base = gatewayBase();

    // Prefer the gateway; on any failure fall back to Nominatim so a missing
    // or sleeping gateway never breaks the map.
    if (base) {
      try {
        const r = await fetch(`${base}/osm/${kind}?${qs}`, { headers: { Accept: "application/json" } });
        if (r.ok) return r.json();
      } catch (_) { /* fall through to direct */ }
    }
    const r = await fetch(`${NOMINATIM}/${kind}?${qs}`, { headers: { Accept: "application/json" } });
    return r.json();
  }

  // Administrative-boundary outline for an area, used to shade "what's within
  // this area" on the houses maps. Prefers the Go gateway's /boundary (cached,
  // rate-limited, simplified) and falls back to calling Nominatim directly with
  // polygon_geojson. Returns a normalised { name, tag, bbox:[w,s,e,n], geojson }
  // (geojson is a GeoJSON geometry) or null when nothing usable is found.
  //
  //   await pawaGeo.boundary({ q: "Mikocheni" })
  //   await pawaGeo.boundary({ lat: -6.77, lng: 39.24 })
  async function boundary(opts = {}) {
    const hasPoint = Number.isFinite(opts.lat) && Number.isFinite(opts.lng);
    const q = (opts.q || "").trim();
    if (!q && !hasPoint) return null;
    const base = gatewayBase();

    // 1) Gateway — returns the clean shape directly.
    if (base) {
      try {
        const qs = q
          ? `q=${encodeURIComponent(q)}`
          : `lat=${opts.lat}&lng=${opts.lng}`;
        const r = await fetch(`${base}/boundary?${qs}`, { headers: { Accept: "application/json" } });
        if (r.ok) {
          const b = await r.json();
          return b && b.geojson ? b : null;
        }
      } catch (_) { /* fall through to direct Nominatim */ }
    }

    // 2) Direct Nominatim fallback — fetch raw, then normalise client-side.
    const isPoly = (g) => g && (g.type === "Polygon" || g.type === "MultiPolygon");
    const norm = (raw) => {
      if (!raw || !raw.geojson) return null;
      const bb = raw.boundingbox; // [south, north, west, east] strings
      const bbox = Array.isArray(bb) && bb.length === 4 ? [+bb[2], +bb[0], +bb[3], +bb[1]] : undefined;
      const name = (raw.name || (raw.display_name || "").split(",").slice(0, 2).join(", ")).trim();
      return { name, tag: raw.addresstype || raw.type || "", bbox, geojson: raw.geojson };
    };
    const searchPoly = async (name) => {
      if (!name) return null;
      const list = await (await fetch(
        `${NOMINATIM}/search?format=jsonv2&polygon_geojson=1&polygon_threshold=0.0008&addressdetails=1&countrycodes=tz&limit=1&q=${encodeURIComponent(name)}`,
        { headers: { Accept: "application/json" } })).json();
      const r = norm(Array.isArray(list) ? list[0] : null);
      return r && isPoly(r.geojson) ? r : null;
    };
    try {
      if (q) return await searchPoly(q);
      // Point: a plain reverse often matches a POI node (a Point, no outline),
      // so reverse only to learn the area NAME, then forward-search it for the
      // real ward/district polygon — narrow area first, wider as fallback.
      const rev = await (await fetch(
        `${NOMINATIM}/reverse?format=jsonv2&zoom=16&addressdetails=1&lat=${opts.lat}&lon=${opts.lng}`,
        { headers: { Accept: "application/json" } })).json();
      const a = (rev && rev.address) || {};
      const near = a.suburb || a.neighbourhood || a.quarter || a.ward || a.residential || a.village || a.city_district;
      const wider = a.municipality || a.county || a.city || a.town || a.state_district;
      for (const name of [near, wider]) {
        const hit = await searchPoly(name);
        if (hit) return hit;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  window.pawaGeo = {
    search: (qs) => call("search", qs),
    reverse: (qs) => call("reverse", qs),
    boundary,
    gatewayBase,
  };
})();
