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
      if (!main.length) return null;
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
              primary: "the main road", secondary: "the main road" })[t.highway] || "the main road";
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
    nearestBatch: nearestRoadBatch
  };
})();
