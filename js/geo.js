// Shared geocoding helper — talks DIRECTLY to LocationIQ (a hosted, CORS-enabled
// geocoder) from the browser. There is no server hop: this removes the old
// self-hosted Go map gateway from the path, which was the source of the map pain
// (free-tier cold starts + the public Nominatim 403/429 block on browser and
// shared-IP traffic). LocationIQ allows direct browser calls and speaks the
// Nominatim v1 JSON shape (format=json), so callers keep their existing parsing.
//
// The API key lives in APP_CONFIG.LOCATIONIQ_KEY. It is a CLIENT-SIDE key and
// MUST be domain-restricted in the LocationIQ dashboard (Settings → restrict by
// referer/domain) so it can't be reused from other sites — the standard pattern
// for browser map keys (Mapbox / Google Maps work the same way).
//
// To protect the shared daily quota, every lookup is cached in-memory + session
// storage (repeat queries never leave the browser) and typing is debounced.
//
// Usage:
//   const list = await pawaGeo.search("format=jsonv2&limit=8&q=Mlimani+City");
//   const j    = await pawaGeo.reverse("format=jsonv2&zoom=16&lat=-6.7&lon=39.2");
(function () {
  "use strict";

  // Regional endpoint — us1 or eu1 both serve Tanzania fine.
  const LIQ_BASE = "https://us1.locationiq.com/v1";

  const TIMEOUT_MS = 8000;
  const BOUNDARY_TIMEOUT_MS = 9000;
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 h — geocodes are stable

  function liqKey() {
    return (window.APP_CONFIG && window.APP_CONFIG.LOCATIONIQ_KEY) || "";
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // fetch() with an abort-based timeout.
  async function fetchTimeout(url, ms, opts = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ac.signal });
    } finally {
      clearTimeout(t);
    }
  }

  // ---- client-side cache (cuts the shared LocationIQ quota dramatically) ----
  const mem = new Map();
  function cacheGet(key) {
    const hit = mem.get(key);
    if (hit && hit.exp > Date.now()) return hit.val;
    try {
      const raw = sessionStorage.getItem("geo:" + key);
      if (raw) {
        const o = JSON.parse(raw);
        if (o.exp > Date.now()) { mem.set(key, o); return o.val; }
      }
    } catch (_) {}
    return undefined;
  }
  function cacheSet(key, val) {
    const o = { val, exp: Date.now() + CACHE_TTL_MS };
    mem.set(key, o);
    try { sessionStorage.setItem("geo:" + key, JSON.stringify(o)); } catch (_) {}
  }

  // Build a LocationIQ URL from a Nominatim-style query string. LocationIQ uses
  // format=json (it rejects jsonv2) and needs the key appended.
  function liqUrl(kind, qs) {
    qs = String(qs || "").replace(/^\?/, "").replace(/format=jsonv2/g, "format=json");
    if (!/(^|&)format=/.test(qs)) qs += (qs ? "&" : "") + "format=json";
    return `${LIQ_BASE}/${kind}?${qs}&key=${encodeURIComponent(liqKey())}`;
  }

  // Client-side throttle: keep upstream calls ≥550 ms apart so a page firing a
  // few lookups at once (e.g. suggest + boundary) never trips LocationIQ's free
  // 2 req/s limit on its own. Cached hits skip this entirely.
  let nextSlot = 0;
  async function throttle() {
    const MIN_GAP = 550;
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + MIN_GAP;
    if (wait) await sleep(wait);
  }

  // Single place that hits LocationIQ: throttled, with backoff retries on 429.
  // Returns parsed JSON, or null on any failure (callers degrade gracefully).
  async function liqFetch(url, ms) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await throttle();
      try {
        const r = await fetchTimeout(url, ms, { headers: { Accept: "application/json" } });
        if (r.status === 429) { await sleep(600 * (attempt + 1)); continue; }
        if (!r.ok) return null;
        return await r.json();
      } catch (_) { return null; }
    }
    return null;
  }

  // Core call: cache → LocationIQ → empty on failure. Never throws: callers get
  // [] (search) or {} (reverse) so the map degrades gracefully instead of breaking.
  async function call(kind, qs) {
    const original = String(qs || "").replace(/^\?/, "");
    const cacheKey = kind + "?" + original;
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;
    if (!liqKey()) {
      console.warn("[geo] APP_CONFIG.LOCATIONIQ_KEY is not set — geocoding is disabled.");
      return kind === "reverse" ? {} : [];
    }
    const j = await liqFetch(liqUrl(kind, original), TIMEOUT_MS);
    if (j == null) return kind === "reverse" ? {} : [];
    cacheSet(cacheKey, j);
    return j;
  }

  // Kept for backwards-compat with callers that referenced the old gateway API.
  function warmup() {}              // gateway removed — nothing to warm
  function gatewayBase() { return ""; }

  // Administrative-boundary outline for an area, used to shade "what's within
  // this area" on the houses maps — fetched directly from LocationIQ with
  // polygon_geojson. Returns a normalised { name, tag, bbox:[w,s,e,n], geojson }
  // (geojson is a GeoJSON geometry) or null when nothing usable is found.
  //
  //   await pawaGeo.boundary({ q: "Mikocheni" })
  //   await pawaGeo.boundary({ lat: -6.77, lng: 39.24 })
  async function boundary(opts = {}) {
    const hasPoint = Number.isFinite(opts.lat) && Number.isFinite(opts.lng);
    const q = (opts.q || "").trim();
    if (!q && !hasPoint) return null;
    if (!liqKey()) return null;

    const cacheKey = "boundary:" + (q || `${opts.lat},${opts.lng}`);
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;

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
      const url = liqUrl("search",
        `format=json&polygon_geojson=1&polygon_threshold=0.0008&addressdetails=1&countrycodes=tz&limit=1&q=${encodeURIComponent(name)}`);
      const list = await liqFetch(url, BOUNDARY_TIMEOUT_MS);
      const r = norm(Array.isArray(list) ? list[0] : null);
      return r && isPoly(r.geojson) ? r : null;
    };

    let result = null;
    try {
      if (q) {
        result = await searchPoly(q);
      } else {
        // Point: a plain reverse often matches a POI node (a Point, no outline),
        // so reverse only to learn the area NAME, then forward-search it for the
        // real ward/district polygon — narrow area first, wider as fallback.
        const url = liqUrl("reverse", `format=json&zoom=16&addressdetails=1&lat=${opts.lat}&lon=${opts.lng}`);
        const rev = (await liqFetch(url, BOUNDARY_TIMEOUT_MS)) || {};
        const a = (rev && rev.address) || {};
        const near = a.suburb || a.neighbourhood || a.quarter || a.ward || a.residential || a.village || a.city_district;
        const wider = a.municipality || a.county || a.city || a.town || a.state_district;
        for (const name of [near, wider]) {
          const hit = await searchPoly(name);
          if (hit) { result = hit; break; }
        }
      }
    } catch (_) { result = null; }
    if (result) cacheSet(cacheKey, result); // only cache real hits, never null
    return result;
  }

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
    // LocationIQ's format=json omits addresstype, but for place/boundary results
    // the `type` field carries the same admin kind (village, ward, suburb, …),
    // so fall back to it before giving up to the generic label.
    if (ADMIN_TAG[ty]) return ADMIN_TAG[ty];
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
