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

    // ---- Advanced ranking: match the admin hierarchy the user searches by ----
    // As the user types we surface real administrative places first, ordered
    // region → district → ward → village → smaller areas, with service POIs
    // (schools, shops, …) sinking to the bottom. A strong NAME match always
    // wins first, so typing "Mikocheni" floats the Mikocheni ward even though a
    // region outranks a ward in the abstract. This makes every search box (house
    // pin, truck/service pin, near-me, directory) resolve places the same way.
    const LEVEL = {
      Region: 1, City: 2, District: 3, Town: 4, Ward: 5,
      Village: 6, Suburb: 7, Area: 7, Locality: 8, Settlement: 8,
    };
    const lcq = q.toLowerCase();
    const nameRank = (n) => {
      n = (n || "").toLowerCase();
      if (n === lcq) return 0;            // exact
      if (n.startsWith(lcq)) return 1;    // prefix — what autocomplete is for
      if (n.includes(lcq)) return 2;      // contains
      return 3;                           // matched elsewhere (e.g. in context)
    };
    const levelRank = (tag) => LEVEL[tag] || 20;  // POIs rank last
    out.sort((a, b) =>
      nameRank(a.name) - nameRank(b.name) ||
      levelRank(a.tag) - levelRank(b.tag) ||
      a.name.length - b.name.length
    );
    return out;
  }

  // ---- pawaRoute.table(): REAL road distances (not straight-line) ----------
  // One origin → many destinations in a single OSRM "table" (matrix) request,
  // so a list of places can be ranked by how far they actually are to DRIVE,
  // not the crow-flies distance. Uses the same free OSRM demo server ride.js
  // already routes against. Returns km per destination (aligned to `points`),
  // with null where a road route couldn't be found, and falls back to all-null
  // on any failure so callers degrade to haversine.
  //
  //   const kms = await pawaRoute.table({lat,lng}, [{lat,lng}, …]);  // [km|null, …]
  //
  // OSRM endpoints, tried in order. The project-osrm.org demo is best-effort and
  // regularly rate-limits (429) or 502s; the FOSSGIS routed-car instance is a
  // second public OSRM with the IDENTICAL API, so when one is down the road
  // distances and alternative routes keep working instead of every map silently
  // collapsing to straight-line haversine. We remember whichever answered last
  // and try it first, so a dead primary isn't re-hammered on every call.
  const OSRM_EPS = [
    "https://router.project-osrm.org",
    "https://routing.openstreetmap.de/routed-car",
  ];
  let osrmPref = 0;

  // A THIRD, independent routing engine (FOSSGIS Valhalla) used as a fallback
  // when both OSRM endpoints are down/rate-limited. It's a different codebase on
  // different infrastructure, so it rarely fails at the same time — which means
  // "distance to my workplace" stays a REAL road distance instead of silently
  // collapsing to a straight line. No key, CORS-enabled. Its matrix endpoint is
  // `/sources_to_targets`; distances come back in kilometres.
  const VALHALLA_EPS = [
    "https://valhalla1.openstreetmap.de",
  ];

  // One origin → many destinations via Valhalla's matrix API. Returns km per
  // destination (aligned to `dests`), null where it couldn't measure. Never
  // throws — a failure just yields all-null so the caller moves on.
  async function valhallaTable(origin, dests) {
    const body = JSON.stringify({
      sources: [{ lat: origin.lat, lon: origin.lng }],
      targets: dests.map((d) => ({ lat: d.lat, lon: d.lng })),
      costing: "auto", units: "kilometers",
    });
    for (const ep of VALHALLA_EPS) {
      try {
        const r = await fetchTimeout(ep + "/sources_to_targets", BOUNDARY_TIMEOUT_MS, {
          method: "POST", headers: { "Content-Type": "application/json" }, body,
        });
        if (!r.ok) continue;
        const j = await r.json();
        const row = j && j.sources_to_targets && j.sources_to_targets[0];
        if (!Array.isArray(row)) continue;
        return row.map((c) => (c && typeof c.distance === "number") ? c.distance : null);
      } catch (_) { /* timeout/CORS/network → next endpoint */ }
    }
    return dests.map(() => null);
  }

  // GET an OSRM service ("route" | "table") for a coordinate string, failing
  // over across endpoints and retrying transient 429/5xx. Returns parsed JSON
  // whose code === "Ok", or null when every endpoint+attempt failed (callers
  // then degrade to haversine). Never throws.
  async function osrmGet(service, coords, query) {
    const path = `/${service}/v1/driving/${coords}?${query}`;
    // preferred endpoint first, then the rest, de-duplicated
    const order = [osrmPref, ...OSRM_EPS.map((_, i) => i)].filter((v, i, a) => a.indexOf(v) === i);
    for (const idx of order) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await fetchTimeout(OSRM_EPS[idx] + path, BOUNDARY_TIMEOUT_MS,
            { headers: { Accept: "application/json" } });
          if (r.status === 429 || r.status >= 500) { await sleep(400 * (attempt + 1)); continue; }
          if (!r.ok) break;                       // 4xx → next endpoint won't differ; move on
          const j = await r.json();
          if (!j || j.code !== "Ok") break;       // routing error → try next endpoint
          osrmPref = idx;                         // stick to the one that works
          return j;
        } catch (_) { /* timeout/CORS/network → retry then next endpoint */ }
      }
    }
    return null;
  }

  // Per-pair road-distance memo (origin→dest, ~10 m grid) layered on the shared
  // geo cache. As the user filters / sorts / pans, the same listing pairs are
  // reused instead of re-hitting OSRM, which both speeds the UI up and keeps us
  // well under the free table quota. Only real numbers are cached, so a pair
  // that failed is retried next time.
  function pairKey(o, d) {
    return `pair:${(+o.lat).toFixed(4)},${(+o.lng).toFixed(4)}>${(+d.lat).toFixed(4)},${(+d.lng).toFixed(4)}`;
  }

  async function routeTable(origin, points) {
    if (!origin || !Array.isArray(points) || !points.length) return [];
    if (!Number.isFinite(+origin.lat) || !Number.isFinite(+origin.lng)) return points.map(() => null);
    origin = { lat: +origin.lat, lng: +origin.lng };

    const result = new Array(points.length).fill(null);

    // Keep only finite, not-yet-cached destinations — a single malformed listing
    // (NaN lat) must never poison the whole batch into all-null.
    const pending = [];
    points.forEach((p, i) => {
      const lat = +p.lat, lng = +p.lng;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;     // leave null
      const hit = cacheGet(pairKey(origin, { lat, lng }));
      if (hit !== undefined) { result[i] = hit; return; }
      pending.push({ i, lat, lng });
    });
    if (!pending.length) return result;

    // OSRM caps a table at 100 coordinates → 99 destinations per call. Chunk so
    // long lists all get real road km; a failed chunk just leaves its rows null.
    const CHUNK = 99;
    for (let off = 0; off < pending.length; off += CHUNK) {
      const group = pending.slice(off, off + CHUNK);
      const coords = [origin, ...group].map((p) => `${p.lng},${p.lat}`).join(";");
      const j = await osrmGet("table", coords, "sources=0&annotations=distance");
      const row = j && j.distances && j.distances[0];   // metres: origin → each coord
      if (!Array.isArray(row)) continue;                // chunk failed → rows stay null
      group.forEach((g, k) => {
        const m = row[k + 1];                           // index 0 is origin→origin
        const km = typeof m === "number" ? m / 1000 : null;
        result[g.i] = km;
        if (km != null) cacheSet(pairKey(origin, g), km);
      });
    }

    // ---- Fallback engine: Valhalla ------------------------------------------
    // Anything OSRM couldn't measure (both endpoints down, or no OSRM route) is
    // retried on the independent Valhalla matrix, so a real road distance is
    // returned far more often before any caller would resort to a straight line.
    const stillNull = pending.filter((g) => result[g.i] == null);
    if (stillNull.length) {
      const VCHUNK = 50;
      for (let off = 0; off < stillNull.length; off += VCHUNK) {
        const group = stillNull.slice(off, off + VCHUNK);
        const kms = await valhallaTable(origin, group);
        group.forEach((g, k) => {
          const km = kms[k];
          if (Number.isFinite(km)) { result[g.i] = km; cacheSet(pairKey(origin, g), km); }
        });
      }
    }

    // ---- Ferry-aware ranking ------------------------------------------------
    // OSRM's land route can be a long way round water — the classic Kigamboni
    // case: the bridge detour is ~25 km but the ferry hop is ~3 km. For the few
    // FRESHLY-fetched destinations where the road is a big detour vs the straight
    // line AND a vehicle ferry is viable, re-measure with the real ferry route
    // and keep the shorter, so a home "across the water" ranks by how near it
    // truly is. Only fresh rows are considered (cache hits were already resolved
    // on an earlier call), so each pair is ferry-checked at most once and the
    // network cost stays bounded (≤6 extra route calls per table).
    const suspects = [];
    for (const g of pending) {
      if (!viableFerries(origin, g).length) continue;
      const crow = havKm(origin, g);
      const road = result[g.i];
      if ((road != null && road > crow * 1.6) ||         // road took the long way round
          (road == null && crow > 0.5 && crow < 60)) {   // road unknown but plausibly near
        suspects.push({ ...g, crow });
      }
    }
    suspects.sort((a, b) => a.crow - b.crow);            // nearest-as-the-crow first
    for (const s of suspects.slice(0, 6)) {
      const pick = viableFerries(origin, s)[0];
      if (!pick) continue;
      const fo = await ferryOption(origin, s, pick).catch(() => null);
      if (fo && (result[s.i] == null || fo.km < result[s.i])) {
        result[s.i] = fo.km;
        cacheSet(pairKey(origin, s), fo.km);
      }
    }
    return result;
  }

  // Single A→B driving route geometry + distance, to DRAW the real road on a map
  // (so "X km" is visibly the road, not a straight line). Same OSRM server.
  // When more than one sensible road reaches the area, OSRM's alternatives are
  // returned too (`alts`, fastest first) so callers can show every option.
  //
  // FERRIES: OSRM's alternatives algorithm almost never offers a ferry when a
  // bridge/land route is faster (e.g. Tungi→IFM shows only the Kigamboni
  // bridge although the ferry route is half the distance), and the demo server
  // rejects `exclude=ferry`. So the known Tanzanian vehicle-ferry crossings
  // below are tried explicitly as via-waypoint routes and merged in, each
  // labelled `via` so the UI can say which ferry the option rides.
  //   const r = await pawaRoute.route({lat,lng}, {lat,lng});
  //   // → { km, durationMin, geojson, via?,
  //   //     alts: [{km, durationMin, geojson, via?: "Kigamboni ferry"}, …] } | null
  const FERRIES = [
    { name: "Kigamboni ferry", a: { lat: -6.8245, lng: 39.3079 }, b: { lat: -6.8186, lng: 39.3013 } },
    { name: "Kamanga ferry (Mwanza)", a: { lat: -2.5103, lng: 32.8585 }, b: { lat: -2.5164, lng: 32.8926 } },
    { name: "Kigongo–Busisi ferry", a: { lat: -2.7186, lng: 32.8930 }, b: { lat: -2.7411, lng: 32.8870 } },
    { name: "Pangani ferry", a: { lat: -5.4271, lng: 38.9763 }, b: { lat: -5.4330, lng: 38.9750 } },
    { name: "Utete ferry (Rufiji)", a: { lat: -8.0098, lng: 38.7570 }, b: { lat: -8.0180, lng: 38.7600 } },
  ];
  function havKm(a, b) {
    const R = 6371, rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  // Decode a Valhalla-encoded polyline (precision 6) → [[lng,lat], …] for GeoJSON.
  function decodeShape(encoded, precision = 6) {
    const factor = Math.pow(10, precision);
    let index = 0, lat = 0, lon = 0; const coords = [];
    while (index < encoded.length) {
      let shift = 0, result = 0, byte;
      do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
      lon += (result & 1) ? ~(result >> 1) : (result >> 1);
      coords.push([lon / factor, lat / factor]);
    }
    return coords;
  }

  // Single A→B driving route from Valhalla (the independent fallback engine),
  // returning the same { km, durationMin, geojson } shape as the OSRM path so the
  // map can draw a REAL road when both OSRM endpoints are down. null on failure.
  async function valhallaRoute(origin, dest) {
    const body = JSON.stringify({
      locations: [{ lat: origin.lat, lon: origin.lng }, { lat: dest.lat, lon: dest.lng }],
      costing: "auto", units: "kilometers",
    });
    for (const ep of VALHALLA_EPS) {
      try {
        const r = await fetchTimeout(ep + "/route", BOUNDARY_TIMEOUT_MS, {
          method: "POST", headers: { "Content-Type": "application/json" }, body });
        if (!r.ok) continue;
        const j = await r.json();
        const trip = j && j.trip, leg = trip && trip.legs && trip.legs[0];
        if (!trip || !leg || !leg.shape) continue;
        const c = decodeShape(leg.shape, 6);
        if (!c.length) continue;
        return { km: trip.summary.length, durationMin: (trip.summary.time || 0) / 60,
                 geojson: { type: "LineString", coordinates: c } };
      } catch (_) { /* next endpoint */ }
    }
    return null;
  }

  async function osrmRoute(coordList, { alternatives = 0 } = {}) {
    if (!coordList.every((p) => Number.isFinite(+p.lat) && Number.isFinite(+p.lng))) return [];
    const coords = coordList.map((p) => `${p.lng},${p.lat}`).join(";");
    const query = `overview=full&geometries=geojson` + (alternatives ? `&alternatives=${alternatives}` : "");
    const j = await osrmGet("route", coords, query);
    return ((j && j.routes) || []).filter((rt) => rt && rt.geometry);
  }
  const asLeg = (rt) => ({ km: (rt.distance || 0) / 1000, durationMin: (rt.duration || 0) / 60, geojson: rt.geometry });

  // A ferry crossing is worth offering when riding it isn't a silly detour:
  // the way to the near ramp + from the far ramp must stay comparable to the
  // straight-line trip. Both ramp orientations are considered.
  function viableFerries(origin, dest) {
    const direct = havKm(origin, dest);
    if (!(direct > 0.5 && direct < 120)) return [];
    return FERRIES.map((f) => {
      const fwd = havKm(origin, f.a) + havKm(f.b, dest);
      const rev = havKm(origin, f.b) + havKm(f.a, dest);
      const detour = Math.min(fwd, rev);
      return { f, ramps: fwd <= rev ? [f.a, f.b] : [f.b, f.a], detour };
    })
      .filter((x) => x.detour <= direct * 1.7 + 2)
      .sort((x, y) => x.detour - y.detour)
      .slice(0, 2);
  }

  async function ferryOption(origin, dest, pick) {
    const [r1, r2] = pick.ramps;
    const routes = await osrmRoute([origin, r1, r2, dest]);
    if (!routes.length || !routes[0].legs || routes[0].legs.length < 3) return null;
    // The middle leg must actually BE the crossing — if OSRM detoured around
    // the water instead of riding the ferry way, that leg balloons: drop it.
    const crossKm = (routes[0].legs[1].distance || 0) / 1000;
    if (crossKm > havKm(r1, r2) * 3 + 1) return null;
    return { ...asLeg(routes[0]), via: pick.f.name };
  }

  async function routeLine(origin, dest) {
    if (!origin || !dest) return null;
    if (![origin.lat, origin.lng, dest.lat, dest.lng].every(Number.isFinite)) return null;
    const coords = `${origin.lng},${origin.lat};${dest.lng},${dest.lat}`;
    const cacheKey = "route3:" + coords;
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;
    try {
      const [main, ...ferryHits] = await Promise.all([
        // Ask OSRM for as many distinct alternative roads as it will offer
        // (it dedupes overlapping ones, so we request generously).
        osrmRoute([origin, dest], { alternatives: 8 }),
        ...viableFerries(origin, dest).map((pick) =>
          ferryOption(origin, dest, pick).catch(() => null)),
      ]);
      if (!main.length) {
        // Both OSRM endpoints failed → draw the real road from Valhalla instead
        // of returning null (which would force the caller to a straight line).
        const v = await valhallaRoute(origin, dest);
        if (!v) return null;
        const out = { ...v, alts: (ferryHits || []).filter(Boolean) };
        cacheSet(cacheKey, out);
        return out;
      }
      const options = main.map(asLeg);
      // Merge ferry options the default search missed (dedupe by distance —
      // if the fastest route already rides that ferry the km will match).
      for (const fo of ferryHits) {
        if (!fo) continue;
        if (options.some((o) => Math.abs(o.km - fo.km) < 0.4)) continue;
        options.push(fo);
      }
      options.sort((a, b) => a.durationMin - b.durationMin);
      const out = { ...options[0], alts: options.slice(1, 9) };   // draw the fastest + up to 8 more real roads
      cacheSet(cacheKey, out);
      return out;
    } catch (_) { return null; }
  }

  // ---- pawaRoads: nearest MAIN road to a point (Overpass / OSM, free) -------
  // "Main road" = the tarmac trunk network buyers/renters actually care about:
  // motorway | trunk | primary | secondary. Returns the road's name and the
  // true perpendicular distance to its geometry in metres — not the distance
  // to the way's centre, which is meaningless for a long road.
  //
  //   const r = await pawaRoads.nearest({lat,lng});
  //   // → { name, highway, meters } | null (none within 3 km) | undefined (lookup failed)
  //   const rs = await pawaRoads.nearestBatch([{lat,lng}, …]);  // one Overpass call
  const ROAD_FILTER   = '"highway"~"^(motorway|trunk|primary|secondary)$"';
  const ROAD_RADIUS_M = 3000;
  const ROAD_TTL_MS   = 7 * 24 * 60 * 60 * 1000;   // road network barely changes
  const ROAD_BATCH    = 25;                         // around-clauses per Overpass call
  const OVERPASS_EPS  = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];

  function roadCacheKey(p) { return `pawa_mainroad_${(+p.lat).toFixed(4)}_${(+p.lng).toFixed(4)}`; }
  function roadCacheGet(p) {
    try {
      const o = JSON.parse(localStorage.getItem(roadCacheKey(p)) || "null");
      if (o && (Date.now() - o.at) < ROAD_TTL_MS) return o.v;
    } catch (_) {}
    return undefined;
  }
  function roadCacheSet(p, v) {
    try { localStorage.setItem(roadCacheKey(p), JSON.stringify({ at: Date.now(), v })); } catch (_) {}
  }

  // Metres from a point to a way's polyline — min point-to-segment distance on
  // a local equirectangular projection (fine at these sub-3-km scales).
  function distToWayM(lat, lng, geom) {
    const R = 6371000, rad = Math.PI / 180, cosLat = Math.cos(lat * rad);
    let best = Infinity;
    for (let i = 0; i < geom.length; i++) {
      const ax = (geom[i].lon - lng) * cosLat * rad * R;
      const ay = (geom[i].lat - lat) * rad * R;
      if (i === geom.length - 1) { best = Math.min(best, Math.hypot(ax, ay)); break; }
      const bx = (geom[i + 1].lon - lng) * cosLat * rad * R;
      const by = (geom[i + 1].lat - lat) * rad * R;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      let t = L2 ? (-(ax * dx + ay * dy)) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
  }

  function roadLabel(tags) {
    const t = tags || {};
    if (t.name || t["name:en"]) return t.name || t["name:en"];
    if (t.ref) return t.ref + " road";
    return ({ motorway: "the highway", trunk: "the trunk road",
              primary: "the main road", secondary: "the main road",
              tertiary: "a side road", unclassified: "a local road",
              residential: "a residential street", living_street: "a local street" })[t.highway] || "a road";
  }

  function nearestFromWays(p, ways) {
    let best = null;
    for (const w of ways) {
      if (!Array.isArray(w.geometry) || !w.geometry.length) continue;
      const m = distToWayM(+p.lat, +p.lng, w.geometry);
      if (!best || m < best.meters) {
        best = { meters: Math.round(m), name: roadLabel(w.tags), highway: (w.tags || {}).highway || "" };
      }
    }
    // The union query returns roads near EVERY point in the batch — a "nearest"
    // that came from another point's cluster isn't a road near THIS house.
    return best && best.meters <= ROAD_RADIUS_M ? best : null;
  }

  async function overpassFetch(q) {
    for (const url of OVERPASS_EPS) {
      try {
        const r = await fetchTimeout(url, 25000, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(q)
        });
        if (!r.ok) continue;
        return await r.json();
      } catch (_) {}
    }
    return null;
  }

  // Aligned to `points`: {name,highway,meters} | null (no main road within 3 km)
  // | undefined (lookup failed — caller may retry later, result is NOT cached).
  async function nearestRoadBatch(points) {
    if (!Array.isArray(points) || !points.length) return [];
    const out = points.map((p) =>
      (Number.isFinite(+p.lat) && Number.isFinite(+p.lng)) ? roadCacheGet(p) : null);
    const missing = out.map((v, i) => v === undefined ? i : -1).filter((i) => i >= 0).slice(0, ROAD_BATCH);
    if (missing.length) {
      const clauses = missing.map((i) =>
        `way[${ROAD_FILTER}](around:${ROAD_RADIUS_M},${(+points[i].lat).toFixed(5)},${(+points[i].lng).toFixed(5)});`).join("");
      const j = await overpassFetch(`[out:json][timeout:25];(${clauses});out tags geom 300;`);
      if (j && Array.isArray(j.elements)) {
        const ways = j.elements.filter((e) => e.type === "way");
        for (const i of missing) {
          out[i] = nearestFromWays(points[i], ways);
          roadCacheSet(points[i], out[i]);
        }
      }
    }
    return out;
  }

  // ---- pawaRoads.around(): the WHOLE main-road network of a frame ----------
  // The road is the root — where people (and money) flow. So instead of only
  // the single nearest road, this measures the perpendicular distance from a
  // point to EVERY main road (motorway|trunk|primary|secondary) around it, and
  // finds the JUNCTIONS where two different main roads cross — the nodes that
  // "unite people", which is exactly where commerce concentrates.
  //
  //   const r = await pawaRoads.around({lat,lng}, 1500);
  //   // → { roads: [{ name, highway, meters, near:{lat,lng}, geoms:[[{lat,lon}…]] }… sorted nearest-first],
  //   //     junctions: [{ lat, lng, meters, roads:[names], classes:[…] }… nearest-first] }

  // Closest point ON a polyline to (lat,lng): { meters, lat, lng }. Same local
  // equirectangular projection as distToWayM, but it also returns the foot point
  // so the map can draw the connector line to the road.
  function closestOnWay(lat, lng, geom) {
    const R = 6371000, rad = Math.PI / 180, cosLat = Math.cos(lat * rad);
    let best = Infinity, bp = null;
    const toLngLat = (px, py) => ({ lng: lng + px / (cosLat * rad * R), lat: lat + py / (rad * R) });
    if (geom.length === 1) {
      const ax = (geom[0].lon - lng) * cosLat * rad * R, ay = (geom[0].lat - lat) * rad * R;
      return { meters: Math.round(Math.hypot(ax, ay)), lat: geom[0].lat, lng: geom[0].lon };
    }
    for (let i = 0; i < geom.length - 1; i++) {
      const ax = (geom[i].lon - lng) * cosLat * rad * R, ay = (geom[i].lat - lat) * rad * R;
      const bx = (geom[i + 1].lon - lng) * cosLat * rad * R, by = (geom[i + 1].lat - lat) * rad * R;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      let t = L2 ? (-(ax * dx + ay * dy)) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px, py);
      if (d < best) { best = d; bp = toLngLat(px, py); }
    }
    return { meters: Math.round(best), lat: bp && bp.lat, lng: bp && bp.lng };
  }

  // Segment a-b ∩ segment c-d in lon/lat space (fine at frame scale) → {lat,lng}|null.
  function segIntersect(a, b, c, d) {
    const x1 = a.lon, y1 = a.lat, x2 = b.lon, y2 = b.lat, x3 = c.lon, y3 = c.lat, x4 = d.lon, y4 = d.lat;
    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-14) return null;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
    const u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / den;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
    return { lat: y1 + t * (y2 - y1), lng: x1 + t * (x2 - x1) };
  }

  async function mainRoadsAround(center, radiusM) {
    const lat = +(center && center.lat), lng = +(center && center.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { roads: [], junctions: [] };
    const r = Math.min(Math.max(radiusM || ROAD_RADIUS_M, 500), 6000);

    const cacheKey = `roadsv2:${lat.toFixed(4)},${lng.toFixed(4)},${r}`;
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;

    // Broadened: every drivable road, not only the carrying ones, so the map can
    // draw EACH road nearby and measure how far it is — while `roads` (main) still
    // drives the scoring + junction nodes and `others` carries the smaller roads.
    const BROAD = '"highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street)$"';
    const q = `[out:json][timeout:25];(way[${BROAD}](around:${r},${lat.toFixed(5)},${lng.toFixed(5)}););out tags geom 700;`;
    const j = await overpassFetch(q);
    if (!j || !Array.isArray(j.elements)) return { roads: [], others: [], junctions: [] };
    const ways = j.elements.filter((e) => e.type === "way" && Array.isArray(e.geometry) && e.geometry.length > 1);

    // Group the many OSM ways of one road into a single entry (min distance +
    // every segment kept, so the map can draw the whole road and the readout
    // shows one "X — 120 m" line instead of a dozen fragments).
    const CLASS_RANK = { motorway: 6, trunk: 6, primary: 5, secondary: 4, tertiary: 3, unclassified: 2, residential: 1, living_street: 1 };
    const groups = new Map();
    for (const w of ways) {
      const t = w.tags || {};
      const key = t.name || t["name:en"] || t.ref || (t.highway + ":" + w.id);
      const cp = closestOnWay(lat, lng, w.geometry);
      const g = groups.get(key) || { key, name: roadLabel(t), highway: t.highway || "", meters: Infinity, near: null, geoms: [] };
      g.geoms.push(w.geometry);
      if (cp.meters < g.meters) { g.meters = cp.meters; g.near = { lat: cp.lat, lng: cp.lng }; }
      // keep the strongest class label if a name spans classes
      if ((CLASS_RANK[t.highway] || 0) > (CLASS_RANK[g.highway] || 0)) g.highway = t.highway;
      groups.set(key, g);
    }
    const all = [...groups.values()].filter((g) => g.meters <= r).sort((a, b) => a.meters - b.meters);
    const MAIN = { motorway: 1, trunk: 1, primary: 1, secondary: 1 };
    const roads = all.filter((g) => MAIN[g.highway]);   // carrying roads — scoring + nodes
    const others = all.filter((g) => !MAIN[g.highway]); // tertiary/residential/… — drawn, measured

    // Junctions: where two DIFFERENT main roads cross. These are the nodes that
    // gather people — the "money-flow" points. Bounded work (top 12 roads).
    const list = roads.slice(0, 12);
    let junctions = [];
    for (let i = 0; i < list.length; i++) {
      for (let k = i + 1; k < list.length; k++) {
        if (list[i].name === list[k].name) continue;
        let found = null;
        outer:
        for (const ga of list[i].geoms) {
          for (let p = 0; p < ga.length - 1; p++) {
            for (const gb of list[k].geoms) {
              for (let q2 = 0; q2 < gb.length - 1; q2++) {
                const x = segIntersect(ga[p], ga[p + 1], gb[q2], gb[q2 + 1]);
                if (x) { found = x; break outer; }
              }
            }
          }
        }
        if (found) {
          const meters = Math.round(havKm({ lat, lng }, found) * 1000);
          if (meters <= r) junctions.push({ lat: found.lat, lng: found.lng, meters,
            roads: [list[i].name, list[k].name], classes: [list[i].highway, list[k].highway] });
        }
      }
    }
    // Merge junctions within ~70 m (a multi-road crossing) into one node.
    junctions.sort((a, b) => a.meters - b.meters);
    const dedup = [];
    for (const jct of junctions) {
      const near = dedup.find((d) => havKm(d, jct) * 1000 < 70);
      if (near) { for (const rn of jct.roads) if (!near.roads.includes(rn)) near.roads.push(rn); continue; }
      dedup.push(jct);
    }

    const result = { roads, others, junctions: dedup };
    cacheSet(cacheKey, result);
    return result;
  }

  // Given a point and the `roads` array from mainRoadsAround(), return the
  // nearest main road to THAT point: { road, meters, near:{lat,lng} } | null.
  // Pure geometry (no network) — used to measure each listing's / destination's
  // distance to the road people use to reach it.
  function nearestInSet(point, roads) {
    const lat = +(point && point.lat), lng = +(point && point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Array.isArray(roads) || !roads.length) return null;
    let best = null;
    for (const r of roads) {
      for (const g of (r.geoms || [])) {
        if (!Array.isArray(g) || g.length < 1) continue;
        const cp = closestOnWay(lat, lng, g);
        if (!best || cp.meters < best.meters) best = { road: r, meters: cp.meters, near: { lat: cp.lat, lng: cp.lng } };
      }
    }
    return best;
  }

  // ---- pawaPlaces: nearest well-known LANDMARK to a point (Overpass / OSM) ---
  // The recognisable place people actually navigate by in Tanzania — a market,
  // mall, school, hospital, mosque/church, bus station, fuel station, stadium…
  // Returns the nearest NAMED one within ~1.2 km as { name, kind, meters }, or
  // null when none is near (caller then shows just the ward). Cached like the
  // rest of geo — including a null result, so a barren area isn't re-queried.
  const LANDMARK_RADIUS_M = 1200;
  const LANDMARK_FILTER =
    'nwr["name"]["amenity"~"^(marketplace|hospital|clinic|university|college|school|place_of_worship|bus_station|fuel|bank|police|townhall|courthouse)$"](around:R,LAT,LNG);' +
    'nwr["name"]["shop"~"^(mall|supermarket|department_store)$"](around:R,LAT,LNG);' +
    'nwr["name"]["leisure"~"^(stadium|park|sports_centre)$"](around:R,LAT,LNG);' +
    'nwr["name"]["tourism"~"^(hotel|attraction|museum)$"](around:R,LAT,LNG);' +
    'nwr["name"]["aeroway"="aerodrome"](around:R,LAT,LNG);';

  async function nearestLandmark(point) {
    const lat = +(point && point.lat), lng = +(point && point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const cacheKey = `landmark:${lat.toFixed(4)},${lng.toFixed(4)}`;
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;
    const filt = LANDMARK_FILTER
      .replace(/R/g, LANDMARK_RADIUS_M)
      .replace(/LAT/g, lat.toFixed(5))
      .replace(/LNG/g, lng.toFixed(5));
    const j = await overpassFetch(`[out:json][timeout:25];(${filt});out center tags 60;`);
    let best = null;
    for (const el of (j && j.elements) || []) {
      const t = el.tags || {};
      const name = t.name || t["name:en"] || t["name:sw"];
      if (!name) continue;
      const elat = el.lat != null ? el.lat : (el.center && el.center.lat);
      const elng = el.lon != null ? el.lon : (el.center && el.center.lon);
      if (!Number.isFinite(elat) || !Number.isFinite(elng)) continue;
      const meters = Math.round(havKm({ lat, lng }, { lat: elat, lng: elng }) * 1000);
      if (!best || meters < best.meters) {
        best = { name, kind: t.amenity || t.shop || t.leisure || t.tourism || t.aeroway || "", meters };
      }
    }
    cacheSet(cacheKey, best);   // cache even a null hit for the session
    return best;
  }

  window.pawaGeo = {
    search: (qs) => call("search", qs),
    reverse: (qs) => call("reverse", qs),
    suggest,
    boundary,
    warmup,
    gatewayBase,
  };
  window.pawaRoute = { table: routeTable, route: routeLine };
  window.pawaRoads = {
    nearest: (p) => nearestRoadBatch([p]).then((r) => r[0]),
    nearestBatch: nearestRoadBatch,
    around: mainRoadsAround,
    nearestInSet
  };
  window.pawaPlaces = { nearestLandmark };
})();
