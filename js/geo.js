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

  // The gateway runs on a free tier that SLEEPS after ~15 min idle, so a cold
  // request can take 30–50 s to wake. We never want the UI to hang that long:
  // every gateway call is given a short timeout, and on timeout/failure we fall
  // straight through to Nominatim (which is fast). When the gateway is warm it
  // wins easily; when it's cold the user just gets the direct path with a brief
  // delay. Boundary polygons are heavier, so they get a longer budget.
  const GATEWAY_TIMEOUT_MS = 3500;
  const GATEWAY_BOUNDARY_TIMEOUT_MS = 6000;
  // Cold-waking a sleeping free-tier instance takes ~30–50 s. The warmup ping
  // must outlast that, otherwise it aborts the connection before the box is up
  // and never actually wakes it — leaving every real lookup on the slow path.
  const GATEWAY_WARMUP_TIMEOUT_MS = 60000;

  // fetch() with an abort-based timeout. Throws on timeout so callers fall back.
  async function fetchTimeout(url, ms, opts = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ac.signal });
    } finally {
      clearTimeout(t);
    }
  }

  // Resolve the gateway base URL (no trailing slash), or "" for direct mode.
  function gatewayBase() {
    const cfg = (window.APP_CONFIG && window.APP_CONFIG.GEO_GATEWAY_URL) || "";
    if (cfg) return cfg.replace(/\/+$/, "");
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "") return "http://127.0.0.1:8091";
    return ""; // production with no gateway configured → call Nominatim directly
  }

  // Wake a sleeping free-tier gateway in the background once per page, so the
  // user's first real lookup is more likely to hit a warm instance. Fire-and-
  // forget; failures are ignored. Skipped for localhost (always-on dev gateway).
  //
  // Crucially this uses a long (60 s) timeout, not the 3.5 s lookup timeout: a
  // cold instance needs that long to spin up, and an early abort would tear down
  // the connection before the wake completes — so the ping would never warm it.
  let warmed = false;
  function warmup() {
    if (warmed) return;
    warmed = true;
    const base = gatewayBase();
    if (!base || /127\.0\.0\.1|localhost/.test(base)) return;
    fetchTimeout(`${base}/health`, GATEWAY_WARMUP_TIMEOUT_MS).catch(() => {});
  }

  async function call(kind, qs) {
    qs = String(qs || "").replace(/^\?/, "");
    const base = gatewayBase();

    // Prefer the gateway; on timeout or any failure fall back to Nominatim so a
    // missing or sleeping gateway never hangs (or breaks) the map.
    if (base) {
      try {
        const r = await fetchTimeout(`${base}/osm/${kind}?${qs}`, GATEWAY_TIMEOUT_MS, { headers: { Accept: "application/json" } });
        if (r.ok) return r.json();
      } catch (_) { /* timed out / failed — fall through to direct */ }
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
        const r = await fetchTimeout(`${base}/boundary?${qs}`, GATEWAY_BOUNDARY_TIMEOUT_MS, { headers: { Accept: "application/json" } });
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

  // Kick the gateway awake as soon as this script loads, so it's warming up
  // while the user reads the page — before their first search/pin.
  warmup();

  // ---- suggest(): rich country-wide autocomplete ---------------------------
  // One place that turns a typed query into MANY distinguishable suggestions
  // spanning every admin level — village, hamlet, ward, suburb, town, district,
  // region — anywhere in Tanzania. Used by every "search a place → see it on the
  // map" box (houses, ride, agent pin) so they all behave the same.
  //
  // Why it returns more than the raw boxes did:
  //   • limit is high (default 25) so same-named places everywhere show up;
  //   • dedupe=0 tells Nominatim to keep near-duplicates instead of trimming;
  //   • we DON'T collapse by name — "Mikocheni" in Kinondoni, Karatu and Tanga
  //     are three different answers, each shown with its district + region so
  //     the user can pick the right one.
  //
  // Returns: [{ name, tag, context, lat, lng, full, id }]
  //   name    — the place itself (first part of the display name)
  //   tag     — human label for the kind (Village / Ward / District / …)
  //   context — the wider area, e.g. "Kinondoni, Dar es Salaam" (for disambiguation)
  //   full    — the complete display name

  const ADMIN_TAG = {
    state: "Region", region: "Region", state_district: "District", county: "District",
    municipality: "District", district: "District", city: "City", town: "Town",
    suburb: "Suburb", neighbourhood: "Area", quarter: "Area", residential: "Area",
    village: "Village", hamlet: "Village", ward: "Ward", subward: "Area",
    administrative: "Area", isolated_dwelling: "Settlement", locality: "Locality",
    borough: "District", city_district: "District",
  };
  const SERVICE_TAG = {
    school: "School", college: "College", university: "University",
    hospital: "Hospital", clinic: "Clinic", pharmacy: "Pharmacy",
    marketplace: "Market", supermarket: "Supermarket", mall: "Mall", bank: "Bank",
    fuel: "Fuel", bus_station: "Bus station", ferry_terminal: "Ferry",
    place_of_worship: "Worship", police: "Police", restaurant: "Restaurant",
    cafe: "Cafe", hotel: "Hotel", stadium: "Stadium", airport: "Airport",
    aerodrome: "Airport",
  };
  function tagOf(it) {
    const at = (it.addresstype || "").toLowerCase();
    if (ADMIN_TAG[at]) return ADMIN_TAG[at];
    const ty = (it.type || "").toLowerCase();
    if (SERVICE_TAG[ty]) return SERVICE_TAG[ty];
    const cls = (it.class || it.category || "").toLowerCase();
    if (["amenity", "shop", "leisure", "tourism", "office", "healthcare", "building"].includes(cls)) {
      const s = (ty || cls).replace(/_/g, " ");
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
    return "Place";
  }

  async function suggest(q, opts = {}) {
    q = String(q || "").trim();
    if (q.length < 2) return [];
    const limit = opts.limit || 25;
    let list;
    try {
      list = await call("search",
        `format=jsonv2&limit=${limit}&countrycodes=tz&addressdetails=1&dedupe=0&accept-language=en&q=${encodeURIComponent(q)}`);
    } catch (_) {
      return [];
    }
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const it of list) {
      const lat = +it.lat, lng = +it.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const parts = (it.display_name || "").split(",").map(s => s.trim()).filter(Boolean);
      const name = (it.name && it.name.trim()) || parts[0] || q;
      // Wider area = the parts between the name and the country, trimmed to the
      // 3 most telling (district / region / zone) so rows stay one line.
      const context = parts.slice(1).filter(p => p !== "Tanzania").slice(0, 3).join(", ");
      // De-dupe on identity, not on name: same name + same wider area + same
      // ~100 m spot is a true duplicate; same name elsewhere is kept.
      const key = it.place_id ||
        `${name}|${context}|${lat.toFixed(3)}|${lng.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, tag: tagOf(it), context, lat, lng, full: it.display_name || name, id: key });
    }
    return out;
  }

  window.pawaGeo = {
    search: (qs) => call("search", qs),
    reverse: (qs) => call("reverse", qs),
    suggest,
    boundary,
    warmup,
    gatewayBase,
  };
})();
