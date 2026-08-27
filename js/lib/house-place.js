// ============================================================================
//  house-place.js — everything about WHERE the property is.
//
//  The map and its pin, the real driving route from the visitor, the pin's
//  provenance line, the tappable OpenStreetMap amenity overlay, the distance to
//  the nearest main road, and the commute measure ("how far is this from my
//  workplace?").
//
//  These were ~700 lines inside js/pages/house.js, wrapped around the rendering
//  code rather than beside it. They share one subject and no state with the
//  rest of the screen, so they are one file now.
//
//  Depends on: house-ui.js (esc, ico, ICO, the distance helpers) — which must
//  load FIRST, because POI_CATS below calls ico() as it is built —
//  house-area.js (renderNearbySummary), geo.js (pawaGeo, pawaRoute),
//  geolocate.js (pawaLocate), map-expand.js, and maplibre-gl.
// ============================================================================

// ============================================================================
// Map — the pin, the route home, the amenity overlay, the commute measure
// ============================================================================
function mountMap(h) {
  const mapEl = document.getElementById("hdMap");
  if (!mapEl) return;

  if (h.lat == null || h.lng == null) {
    mapEl.innerHTML = `<div class="hd-state" style="margin:0;border-radius:0;height:100%"><p>No pin set for this listing yet.</p></div>`;
    return;
  }

  // Hybrid base (satellite + roads + street names) with a Map / Satellite
  // toggle, so a buyer can always read which street the home sits on.
  const map = new maplibregl.Map({
    container: "hdMap",
    style: window.pawaGlHybridStyle ? window.pawaGlHybridStyle() : { version: 8, sources: {}, layers: [] },
    center: [h.lng, h.lat],
    zoom: 15,
    maxBounds: [[29.34, -11.75], [40.45, -0.99]]
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  if (window.pawaGlBasemapToggle) map.addControl(window.pawaGlBasemapToggle(), "top-right");
  window.pawaMapExpand && window.pawaMapExpand("hdMap", () => map);

  const pin = document.createElement("div");
  pin.innerHTML = `
    <svg width="32" height="42" viewBox="0 0 32 42" fill="none">
      <path d="M16 0C7.2 0 0 7.2 0 16c0 12 16 26 16 26s16-14 16-26C32 7.2 24.8 0 16 0z"
            fill="var(--green-emerald)" stroke="var(--bg-app)" stroke-width="2"/>
      <circle cx="16" cy="16" r="6" fill="var(--bg-app)"/>
    </svg>`;
  new maplibregl.Marker({ element: pin, anchor: "bottom" })
    .setLngLat([h.lng, h.lat])
    .addTo(map);

  wireRouteButton(map, h);
  attachNearbyOverlay(map, h.lat, h.lng);
  attachCommuteTool(map, h.lat, h.lng);
  showNearestMainRoad(h.lat, h.lng);
}

/**
 * Draw the REAL driving route from the visitor to this house, so the distance
 * is the actual road rather than a straight line.
 */
function wireRouteButton(map, h) {
  const routeBtn = document.getElementById("hdRouteBtn");
  routeBtn?.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!window.pawaLocate || !window.pawaRoute) return;
    const idle = routeBtn.innerHTML;
    routeBtn.textContent = "Locating…";
    try {
      const fix = await window.pawaLocate.best({ targetAccuracy: 80, hardTimeout: 12000 });
      const r = await window.pawaRoute.route({ lat: fix.lat, lng: fix.lng }, { lat: h.lat, lng: h.lng });
      if (!r || !r.geojson) { routeBtn.textContent = "Route unavailable"; return; }
      const ensure = () => map.isStyleLoaded() ? Promise.resolve() : new Promise((res) => map.once("load", res));
      await ensure();

      // When more than one road reaches the area, draw the alternatives too
      // (lighter dashed lines under the main route). White casing under each
      // coloured line keeps them visible on the satellite-hybrid base; casings
      // share the line's source, so drop both layers before the source.
      const alts = (r.alts || []).filter((a) => a.geojson && Array.isArray(a.geojson.coordinates));
      ["hd-route-alts-casing", "hd-route-alts"].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource("hd-route-alts")) map.removeSource("hd-route-alts");
      if (alts.length) {
        map.addSource("hd-route-alts", { type: "geojson", data: {
          type: "FeatureCollection",
          features: alts.map((a) => ({ type: "Feature", geometry: a.geojson }))
        } });
        map.addLayer({ id: "hd-route-alts-casing", type: "line", source: "hd-route-alts",
          paint: { "line-color": ROUTE_CASING, "line-width": 6, "line-opacity": 0.5 } });
        map.addLayer({ id: "hd-route-alts", type: "line", source: "hd-route-alts",
          paint: { "line-color": ROUTE_LINE, "line-width": 4, "line-opacity": 0.6, "line-dasharray": [2, 1.5] } });
      }
      ["hd-route-casing", "hd-route"].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource("hd-route")) map.removeSource("hd-route");
      map.addSource("hd-route", { type: "geojson", data: { type: "Feature", geometry: r.geojson } });
      map.addLayer({ id: "hd-route-casing", type: "line", source: "hd-route",
        paint: { "line-color": ROUTE_CASING, "line-width": 8, "line-opacity": 0.9 } });
      map.addLayer({ id: "hd-route", type: "line", source: "hd-route",
        paint: { "line-color": ROUTE_LINE, "line-width": 5, "line-opacity": 0.95 } });
      new maplibregl.Marker({ color: ROUTE_LINE }).setLngLat([fix.lng, fix.lat]).addTo(map);

      // Fit around every road that reaches the home, not just the fastest one.
      const cs = [].concat(r.geojson.coordinates || [], ...alts.map((a) => a.geojson.coordinates));
      if (cs.length) {
        const b = cs.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(cs[0], cs[0]));
        map.fitBounds(b, { padding: 50, duration: 600 });
      }
      routeBtn.textContent = `${r.km.toFixed(1)} km by road · ${Math.round(r.durationMin)} min` +
        (alts.length ? ` · other road: ${alts.map((a) => a.km.toFixed(1) + " km").join(", ")}` : "");
      routeBtn.title = alts.length
        ? `Fastest road shown solid; ${alts.length === 1 ? "1 alternative road" : alts.length + " alternative roads"} shown dashed.`
        : "";
    } catch (err) {
      routeBtn.innerHTML = idle;
      alert((window.pawaLocate && window.pawaLocate.message ? window.pawaLocate.message(err) : (err && err.message)) || "Couldn't get your location.");
    }
  });
}

// maplibre paints into a <canvas>, which cannot read a CSS custom property, so
// these two are the only place on this page where the brand green and its
// casing are written as values. They are read from the design system at load
// time rather than typed, so a token change still reaches the map.
const ROUTE_LINE   = cssToken("--green-emerald", "#2EE6A6");
const ROUTE_CASING = cssToken("--bg-app", "#070C0A");
// The commute measure draws over satellite imagery, where the neon accent
// disappears — so it uses the deeper foundation green, again read from the
// design system rather than typed. The amber is not a brand colour: it exists
// only to mark "this is a straight-line estimate, not a road", and it means the
// same thing on near-me, services and trucks.
const COMMUTE_LINE = cssToken("--green", "#0a6f4d");
const COMMUTE_EST  = "#b26a00";

function cssToken(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (_) { return fallback; }
}

// ============================================================================
// Nearby amenities (Overpass / OpenStreetMap, free, no API key)
// ============================================================================
// Full set of "nearby infrastructure" categories per docs/SKILL.md 3.2 — all
// fetched live from OpenStreetMap via the Overpass API. Categories are
// loaded lazily on first chip-tap (and the first two are auto-loaded
// when the map opens so the buyer gets immediate context).
const POI_CATS = [
  { key: "school",     label: "Schools",     icon: ico(ICO.building, 12), color: "var(--info)",
    q: 'node["amenity"~"school|university|college|kindergarten"](around:RADIUS,LAT,LNG);way["amenity"~"school|university|college|kindergarten"](around:RADIUS,LAT,LNG);' },
  { key: "hospital",   label: "Hospitals",   icon: ico(ICO.cross, 12), color: "var(--danger)",
    q: 'node["amenity"~"hospital|clinic|doctors|pharmacy"](around:RADIUS,LAT,LNG);way["amenity"~"hospital|clinic"](around:RADIUS,LAT,LNG);' },
  { key: "market",     label: "Markets",     icon: ico(ICO.cart, 12), color: "var(--warn)",
    q: 'node["amenity"="marketplace"](around:RADIUS,LAT,LNG);node["shop"~"supermarket|mall|convenience"](around:RADIUS,LAT,LNG);way["amenity"="marketplace"](around:RADIUS,LAT,LNG);way["shop"~"supermarket|mall"](around:RADIUS,LAT,LNG);' },
  { key: "transport",  label: "Transport",   icon: ico(ICO.bus, 12), color: "var(--green-bright)",
    q: 'node["highway"="bus_stop"](around:RADIUS,LAT,LNG);node["amenity"~"bus_station|taxi"](around:RADIUS,LAT,LNG);node["railway"="station"](around:RADIUS,LAT,LNG);' },
  { key: "bank",       label: "Banks / ATMs", icon: ico(ICO.bank, 12), color: "var(--green-neon)",
    q: 'node["amenity"~"bank|atm|bureau_de_change"](around:RADIUS,LAT,LNG);' },
  { key: "food",       label: "Restaurants", icon: ico(ICO.fork, 12), color: "var(--gold-warm)",
    q: 'node["amenity"~"restaurant|cafe|fast_food|food_court|bar"](around:RADIUS,LAT,LNG);way["amenity"~"restaurant|cafe"](around:RADIUS,LAT,LNG);' },
  { key: "worship",    label: "Mosques · Churches", icon: ico(ICO.pray, 12), color: "var(--gold)",
    q: 'node["amenity"="place_of_worship"](around:RADIUS,LAT,LNG);way["amenity"="place_of_worship"](around:RADIUS,LAT,LNG);' },
  { key: "leisure",    label: "Parks · Gyms", icon: ico(ICO.tree, 12), color: "var(--green-emerald)",
    q: 'node["leisure"~"park|fitness_centre|sports_centre|playground"](around:RADIUS,LAT,LNG);way["leisure"~"park|fitness_centre|sports_centre|stadium"](around:RADIUS,LAT,LNG);' },
  { key: "fuel",       label: "Fuel",        icon: ico(ICO.fuel, 12), color: "var(--text-muted)",
    q: 'node["amenity"="fuel"](around:RADIUS,LAT,LNG);' },
  { key: "safety",     label: "Police · Fire", icon: ico(ICO.shield, 12), color: "var(--text-info)",
    q: 'node["amenity"~"police|fire_station"](around:RADIUS,LAT,LNG);way["amenity"~"police|fire_station"](around:RADIUS,LAT,LNG);' },
  { key: "post",       label: "Post · Government", icon: ico(ICO.bank, 12), color: "var(--gold-dark)",
    q: 'node["amenity"~"post_office|townhall|courthouse|embassy"](around:RADIUS,LAT,LNG);way["amenity"~"post_office|townhall|courthouse|embassy"](around:RADIUS,LAT,LNG);' }
];

const POI_RADIUS_M     = 1500;            // 1.5 km around the property
const POI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Who put this pin here?
//
// Two listings with the same two coordinates have never been the same claim.
// One was pinned by an agent dragging a marker onto a roof that looked about
// right from a satellite photo; the other by the person who lives there,
// standing at the gate, tapping once. A seeker about to spend a Saturday and a
// daladala fare on a viewing is entitled to know which they are looking at.
//
// Said ONLY when it is still exactly true. `exact` goes false the moment the
// agent moves the marker more than a house's width off what was sent, and this
// then draws nothing rather than something weaker — an agent correcting a pin
// that was wrong is doing the right thing, and a listing that hedged about it
// would teach agents not to correct pins. Silence is the honest default: the
// absence of the line is not an accusation, it is just the ordinary case.
//
// Shape: supabase/features/house/houses_pin.sql.
// ---------------------------------------------------------------------------
function pinProvenance(h) {
  const pin = h && h.pin;
  if (!pin || typeof pin !== "object" || pin.exact !== true) return "";

  const acc = Number(pin.acc);
  const within = Number.isFinite(acc) && acc > 0 ? ` \u2014 to within ${Math.round(acc)} m` : "";

  // The agent's own phone has no third party in it, so it gets its own
  // sentence rather than being forced through one written about somebody else.
  if (pin.via === "gps") {
    return provLine(`Pinned by the agent, standing at the property${within}.`);
  }

  // A name somebody chose for themselves in a room is not the same as one
  // behind an account, and reading them the same way is how the weaker of the
  // two borrows the authority of the stronger.
  const who = pin.from_name
    ? esc(String(pin.from_name)) + (pin.from_guest ? " (unverified)" : "")
    : "the person who was there";

  const how = pin.via === "p-message" ? ", and sent from there in an encrypted message"
            : pin.via === "code"      ? ", and read out from there as a location code"
            : pin.via === "request"   ? ", and shared from there as it was taken"
            : "";

  return provLine(`Pinned exactly where ${who} was standing${how}${within}.`);
}

// The one shape the provenance line is drawn in, so the three sentences above
// cannot drift into three slightly different rows.
function provLine(text) {
  return `<p class="hd-pin-prov">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M20 6 9 17l-5-5"/></svg>
      <span>${text}</span>
    </p>`;
}

function attachNearbyOverlay(map, lat, lng) {
  const mapEl = document.getElementById("hdMap");
  if (!mapEl) return;

  // Build the floating toolbar of category chips.
  const toolbar = document.createElement("div");
  toolbar.className = "hd-poi-toolbar";
  toolbar.innerHTML = POI_CATS.map(c =>
    `<button type="button" class="hd-poi-chip" data-cat="${c.key}">
       <span>${c.icon}</span><span>${c.label}</span>
     </button>`
  ).join("");
  mapEl.appendChild(toolbar);

  const status = document.createElement("div");
  status.className = "hd-poi-status";
  status.hidden = true;
  mapEl.appendChild(status);

  // Build the stores from POI_CATS so we always have an entry for every
  // category — the old hardcoded literal only listed the original four
  // and threw "Cannot read properties of undefined (reading 'forEach')"
  // when any of the newer chips (bank / food / worship / etc.) was tapped.
  const markersByCat = Object.fromEntries(POI_CATS.map(c => [c.key, []]));
  const dataByCat    = Object.fromEntries(POI_CATS.map(c => [c.key, null]));

  toolbar.querySelectorAll(".hd-poi-chip").forEach(chip => {
    chip.addEventListener("click", async () => {
      const cat = chip.dataset.cat;
      const meta = POI_CATS.find(c => c.key === cat);
      const on  = !chip.classList.contains("active");
      if (on) {
        chip.classList.add("active");
        if (!dataByCat[cat]) {
          chip.classList.add("loading");
          showStatus(`Loading nearby ${meta.label}…`);
          try {
            dataByCat[cat] = await fetchPois(cat, lat, lng);
          } catch (e) {
            console.warn("overpass", cat, e);
            chip.classList.remove("loading", "active");
            showStatus(`Couldn't load nearby ${meta.label}.`, 2500);
            return;
          }
          chip.classList.remove("loading");
        }
        renderCat(map, cat, dataByCat[cat], markersByCat, { lat, lng });
        const n = dataByCat[cat].length;
        showStatus(n
          ? `${n} result${n === 1 ? "" : "s"} · ${meta.label} within ${POI_RADIUS_M/1000} km`
          : `No ${meta.label} found nearby`, 2200);
      } else {
        chip.classList.remove("active");
        (markersByCat[cat] || []).forEach(m => m.remove());
        markersByCat[cat] = [];
        hideStatus();
      }
    });
  });

  // Tip the user that the chips are tappable — they only fire Overpass on demand.
  showStatus("Tap a category to see nearby places", 4000);

  function showStatus(text, autoHideMs) {
    status.textContent = text;
    status.hidden = false;
    if (autoHideMs) setTimeout(() => { status.hidden = true; }, autoHideMs);
  }
  function hideStatus() { status.hidden = true; }
}

// Popup HTML for a nearby place. Distance is REAL road km only (never crow-flies):
// "measuring…" until the matrix answers, then "X km by road", or unavailable.
function poiPopupHtml(name, catMeta, km, state) {
  const dist = state === "road"
    ? `${km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(km < 10 ? 2 : 1) + " km"} by road`
    : state === "measuring" ? "measuring road distance…"
    : "road distance unavailable";
  return `<div class="hd-poi-popup">
    <strong>${esc(name)}</strong>
    <div class="pp-meta">${catMeta.icon} ${esc(catMeta.label)} · ${dist}</div>
  </div>`;
}

async function renderCat(map, cat, elements, store, anchor) {
  const catMeta = POI_CATS.find(c => c.key === cat);
  store[cat].forEach(m => m.remove());
  store[cat] = [];
  const entries = [];   // { popup, name, p } — to fill in real road km below
  for (const el of elements) {
    const p = el.center || { lat: el.lat, lon: el.lon };
    if (p.lat == null || p.lon == null) continue;
    const node = document.createElement("div");
    node.className = `hd-poi-marker cat-${cat}`;
    node.style.borderColor = catMeta.color;
    const name = poiLabel(el, catMeta);
    node.title = name;
    // The place's real name (the school's / hospital's actual name) is shown
    // right on the map under the pin — not hidden behind a tap.
    node.innerHTML =
      `<span class="hd-poi-ico">${catMeta.icon}</span>` +
      `<span class="hd-poi-name">${esc(name)}</span>`;
    const popup = new maplibregl.Popup({ offset: 12, closeButton: true, maxWidth: "220px" })
      .setHTML(poiPopupHtml(name, catMeta, null, "measuring"));
    const mk = new maplibregl.Marker({ element: node, anchor: "center" })
      .setLngLat([p.lon, p.lat])
      .setPopup(popup)
      .addTo(map);
    store[cat].push(mk);
    entries.push({ popup, name, p });
  }

  // Upgrade every popup to the REAL road distance home → place in one matrix
  // call (OSRM ×2 + Valhalla, cached). No straight-line is ever shown.
  if (window.pawaRoute && entries.length) {
    try {
      const kms = await window.pawaRoute.table(
        { lat: anchor.lat, lng: anchor.lng },
        entries.map((e) => ({ lat: e.p.lat, lng: e.p.lon })));
      entries.forEach((e, i) => {
        const km = kms && kms[i];
        e.popup.setHTML(poiPopupHtml(e.name, catMeta,
          Number.isFinite(km) ? km : null, Number.isFinite(km) ? "road" : "noroad"));
      });
    } catch (_) {
      entries.forEach((e) => e.popup.setHTML(poiPopupHtml(e.name, catMeta, null, "noroad")));
    }
  }
}

async function fetchPois(cat, lat, lng) {
  const cacheKey = `pawa_pois_${cat}_${lat.toFixed(3)}_${lng.toFixed(3)}_${POI_RADIUS_M}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (cached && (Date.now() - cached.at) < POI_CACHE_TTL_MS) {
      return cached.data;
    }
  } catch (_) {}

  const meta = POI_CATS.find(c => c.key === cat);
  const q = `[out:json][timeout:25];(${meta.q.replace(/RADIUS/g, POI_RADIUS_M).replace(/LAT/g, lat).replace(/LNG/g, lng)});out center 60;`;
  // Two Overpass mirrors — try the second if the first is busy.
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];
  let lastErr;
  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(q)
      });
      if (!r.ok) throw new Error("Overpass HTTP " + r.status);
      const j = await r.json();
      const els = (j.elements || []).filter(e => e.tags); // drop nameless ways' inner nodes
      try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data: els })); } catch (_) {}
      return els;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Overpass unreachable");
}

// Best human-readable name for a nearby POI: the real name first (a school's or
// hospital's actual name), then operator/brand, then a humanised type — never a
// bare generic category if we can do better.
function poiLabel(el, catMeta) {
  const t = el.tags || {};
  const real = t.name || t["name:en"] || t.official_name || t.operator || t.brand;
  if (real) return real;
  const kind = t.amenity || t.shop || t.leisure || t.healthcare || t.office || t.tourism || "";
  if (kind) { const s = String(kind).replace(/_/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); }
  return catMeta.label;
}

// ============================================================================
// Commute tool — "how far is this home from my workplace / daily route?"
// Geocodes the typed place via LocationIQ (pawaGeo.suggest), then measures the
// REAL driving route via pawaRoute (OSRM ×2 + Valhalla) — the actual road km +
// minutes, with the route drawn on the map. NEVER straight-line: if no engine
// can route it, we say so rather than show a crow-flies number. No match → ask
// the user for a famous area/landmark near their workplace and try again.
// ============================================================================
function attachCommuteTool(map, lat, lng) {
  const wrap  = document.getElementById("hdCommute");
  const input = document.getElementById("hdCommuteInput");
  const btn   = document.getElementById("hdCommuteBtn");
  const msgEl = document.getElementById("hdCommuteMsg");
  const resEl = document.getElementById("hdCommuteResults");
  if (!wrap || !input || !btn || !window.pawaGeo) return;
  wrap.hidden = false;

  let workMarker = null, lineReady = false, measureSeq = 0;

  function emptyLine() { return { type: "Feature", geometry: { type: "LineString", coordinates: [] } }; }
  function emptyFC()   { return { type: "FeatureCollection", features: [] }; }
  function initLine() {
    if (lineReady) return;
    const add = () => {
      // Alternative roads sit UNDER the chosen route so the main one reads first.
      // Each coloured line gets a white casing beneath it so the roads stay
      // visible on the satellite-hybrid base (dark imagery swallows raw green).
      if (!map.getSource("hd-commute-alts")) {
        map.addSource("hd-commute-alts", { type: "geojson", data: emptyFC() });
        map.addLayer({ id: "hd-commute-alts-casing", type: "line", source: "hd-commute-alts",
          paint: { "line-color": "#fff", "line-width": 5, "line-opacity": 0.5 } });
        map.addLayer({ id: "hd-commute-alts", type: "line", source: "hd-commute-alts",
          paint: { "line-color": COMMUTE_LINE, "line-width": 3, "line-opacity": 0.6, "line-dasharray": [2, 1.5] } });
      }
      if (!map.getSource("hd-commute-line")) {
        map.addSource("hd-commute-line", { type: "geojson", data: emptyLine() });
        map.addLayer({ id: "hd-commute-line-casing", type: "line", source: "hd-commute-line",
          paint: { "line-color": "#fff", "line-width": 6, "line-opacity": 0.9 } });
        map.addLayer({ id: "hd-commute-line", type: "line", source: "hd-commute-line",
          paint: { "line-color": COMMUTE_LINE, "line-width": 3, "line-opacity": 0.95 } });
      }
      lineReady = true;
    };
    if (map.isStyleLoaded()) add(); else map.once("load", add);
  }
  // Draw either the full road geometry (solid) or a 2-point fallback (dashed).
  function setLine(coords, dashed) {
    initLine();
    const data = { type: "Feature", geometry: { type: "LineString", coordinates: coords } };
    const apply = () => {
      const s = map.getSource("hd-commute-line"); if (s) s.setData(data);
      if (map.getLayer("hd-commute-line")) {
        map.setPaintProperty("hd-commute-line", "line-dasharray", dashed ? [2, 1.5] : [1, 0]);
        // Real road = brand green; straight-line estimate = amber, so the two are
        // never confused (matches near-me / services / trucks).
        map.setPaintProperty("hd-commute-line", "line-color", dashed ? COMMUTE_EST : COMMUTE_LINE);
      }
    };
    if (map.getSource && map.getSource("hd-commute-line")) apply(); else map.once("load", apply);
  }
  // The OTHER roads that also reach the place (lighter dashed lines).
  function setAltLines(coordsList) {
    initLine();
    const data = {
      type: "FeatureCollection",
      features: (coordsList || []).map((c) => ({ type: "Feature", geometry: { type: "LineString", coordinates: c } }))
    };
    const apply = () => { const s = map.getSource("hd-commute-alts"); if (s) s.setData(data); };
    if (map.getSource && map.getSource("hd-commute-alts")) apply(); else map.once("load", apply);
  }
  function fitCoords(coords) {
    try {
      const b = coords.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(b, { padding: 70, maxZoom: 15, duration: 600 });
    } catch (_) {}
  }

  function showMsg(html, kind) {
    msgEl.innerHTML = html;
    msgEl.className = "hd-commute-msg" + (kind ? " " + kind : "");
    msgEl.hidden = !html;
  }
  function fmtKm(km) { return km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(km < 10 ? 2 : 1) + " km"; }

  async function selectPlace(p, rows) {
    if (!workMarker) {
      const el = document.createElement("div");
      el.className = "hd-work-marker";
      el.textContent = "";
      workMarker = new maplibregl.Marker({ element: el, anchor: "center" });
    }
    workMarker.setLngLat([p.lng, p.lat]).addTo(map);
    if (rows) rows.forEach((r) => r.el.classList.toggle("active", r.place === p));

    const ctx = p.context ? ` <span class="hd-commute-ctx">(${esc(p.context)})</span>` : "";
    const seq = ++measureSeq;
    showMsg(`Measuring the real road distance to <strong>${esc(p.name)}</strong>…`, "");

    // Real driving route (road km + minutes + geometry to draw).
    let r = null;
    try {
      if (window.pawaRoute) r = await window.pawaRoute.route({ lat, lng }, { lat: p.lat, lng: p.lng });
    } catch (_) {}
    if (seq !== measureSeq) return;   // user already picked another place

    if (r && r.geojson && Array.isArray(r.geojson.coordinates) && r.geojson.coordinates.length) {
      p.roadKm = r.km;
      const alts = (r.alts || []).filter((a) => a.geojson && Array.isArray(a.geojson.coordinates));
      setLine(r.geojson.coordinates, false);
      setAltLines(alts.map((a) => a.geojson.coordinates));
      // Zoom out far enough to show EVERY road that reaches the place.
      fitCoords([].concat(r.geojson.coordinates, ...alts.map((a) => a.geojson.coordinates)));
      const altNote = alts.length
        ? `There ${alts.length === 1 ? "is 1 more road" : `are ${alts.length} more roads`} to reach this area — ` +
          alts.map((a) => `${fmtKm(a.km)} · ~${Math.round(a.durationMin)} min`).join(", ") +
          ` (drawn lighter on the map).`
        : `Measured along the actual road, drawn on the map.`;
      showMsg(
        ` <strong>${fmtKm(r.km)} by road</strong> · ~${Math.round(r.durationMin)} min drive ` +
        `from this home to <strong>${esc(p.name)}</strong>${ctx}. ` +
        `<span class="hd-commute-note">${altNote}</span>`,
        "ok"
      );
      if (rows) {
        const row = rows.find((x) => x.place === p);
        const kmEl = row && row.el.querySelector(".hd-cr-km");
        if (kmEl) kmEl.textContent = fmtKm(r.km) + " by road";
      }
    } else {
      // No routing engine (OSRM ×2 + Valhalla) could measure it — show the honest
      // state instead of a misleading straight-line number, and draw no fake line.
      setLine([], true);
      setAltLines([]);
      showMsg(
        `Couldn’t measure the road distance to <strong>${esc(p.name)}</strong>${ctx} right now. ` +
        `<span class="hd-commute-note">Please try again in a moment.</span>`,
        "warn"
      );
    }
  }

  function renderResults(places) {
    resEl.innerHTML = "";
    const rows = [];
    places.forEach((p) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "hd-commute-result";
      // Road distance only — blank until measured (tapping the row routes it).
      el.innerHTML =
        `<span class="hd-cr-name">${esc(p.name)}</span>` +
        `<span class="hd-cr-meta">${esc(p.tag || "Place")}${p.context ? " · " + esc(p.context) : ""}</span>` +
        `<span class="hd-cr-km">${p.roadKm != null ? fmtKm(p.roadKm) + " by road" : "tap to measure"}</span>`;
      resEl.appendChild(el);
      const row = { el, place: p };
      el.addEventListener("click", () => selectPlace(p, rows));
      rows.push(row);
    });
    return rows;
  }

  // ---- as you type: the places we already know, with no network at all ----
  // The box used to show NOTHING until a whole network round trip came back, so
  // the first feedback a person got about a misspelling was a failure several
  // seconds after they had finished typing. pawaPlaceMatch scores the local
  // gazetteer in about 5 ms, which is well inside a keystroke, so the answer for
  // anywhere we know appears as the word is finished. Nothing here measures a
  // route — routing is expensive and stays behind an explicit tap.
  let previewTimer = 0, previewedFor = "";
  function preview() {
    const q = input.value.trim();
    if (q === previewedFor) return;
    previewedFor = q;
    if (q.length < 2 || !window.pawaPlaceMatch) { return; }
    // `near` is this listing's own pin: of two places with the same name, the
    // one a person commuting to this house could plausibly mean is the near one.
    const hits = window.pawaPlaceMatch.search(q, { near: { lat, lng }, limit: 5 });
    if (!hits.length) return;   // leave whatever is on screen; the geocoder may know it
    const places = hits.map((h) => ({
      name: h.name, tag: h.kind ? h.kind.charAt(0).toUpperCase() + h.kind.slice(1) : "Place",
      context: h.city && h.city !== h.name ? h.city : "", lat: h.lat, lng: h.lng,
      local: true, score: h.score, exact: h.exact,
    }));
    renderResults(places);
    // "Found" only for a place whose name was actually typed. A high score on a
    // misspelling is still a guess at a letter nobody typed, so the box asks
    // instead of asserting — the same line pawaGeo.suggest draws with `fuzzy`.
    const sure = hits[0].exact;
    showMsg(
      sure
        ? `Found <strong>${esc(hits[0].name)}</strong>. Tap it to measure the road distance, or press Measure to search wider.`
        : `Did you mean <strong>${esc(hits[0].name)}</strong>? Tap a place to measure it, or press Measure to search everywhere.`,
      sure ? "ok" : "warn"
    );
  }

  async function run() {
    const q = input.value.trim();
    if (q.length < 2) { showMsg("Type your workplace, office area or a place on your daily route.", "warn"); return; }
    btn.disabled = true; btn.textContent = "Locating…";
    showMsg(`Searching for “${esc(q)}”…`, "");
    resEl.innerHTML = "";
    let places = [];
    try { places = await window.pawaGeo.suggest(q, { limit: 6, near: { lat, lng } }); } catch (_) { places = []; }
    btn.disabled = false; btn.textContent = "Measure";

    if (!places.length) {
      showMsg(
        `We couldn't find “<strong>${esc(q)}</strong>”. Try a <strong>famous area, market, school or road near your workplace</strong> ` +
        `(a well-known landmark close by), then measure again.`,
        "warn"
      );
      return;
    }
    const rows = renderResults(places);
    // When the best we have is a GUESS at a word nobody typed, say so and stop.
    // Auto-measuring a guess draws a confident green route to a place the person
    // never asked for, which is the one outcome worse than not knowing.
    if (places[0].fuzzy) {
      showMsg(`No exact match for “<strong>${esc(q)}</strong>” — these are the closest places we know. ` +
              `Tap the right one to measure it.`, "warn");
      return;
    }
    selectPlace(places[0], rows);   // preview the top match; tap another to refine

    // Upgrade every result's distance to the REAL road km in one OSRM matrix
    // request, so the list ranks places by how far they actually are to drive.
    if (window.pawaRoute) {
      window.pawaRoute.table({ lat, lng }, places.map((p) => ({ lat: p.lat, lng: p.lng })))
        .then((kms) => (kms || []).forEach((km, i) => {
          if (!Number.isFinite(km) || !rows[i]) return;
          places[i].roadKm = km;
          const kmEl = rows[i].el.querySelector(".hd-cr-km");
          if (kmEl) kmEl.textContent = fmtKm(km) + " by road";
        }))
        .catch(() => {});
    }
  }

  btn.addEventListener("click", run);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
  // 180 ms is long enough that the preview does not flicker mid-word and short
  // enough that it is on screen before the finger reaches the next key.
  input.addEventListener("input", () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(preview, 180);
  });
}

// ============================================================================
// Nearest main road — every listing shows how close it is to the tarmac
// (motorway / trunk / primary / secondary), via the shared pawaRoads helper.
// ============================================================================
async function showNearestMainRoad(lat, lng) {
  const el = document.getElementById("hdMainRoad");
  if (!el || !window.pawaRoads || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  el.hidden = false;
  el.innerHTML = ` Checking how far the main road is…`;
  let r;
  try { r = await window.pawaRoads.nearest({ lat, lng }); } catch (_) { r = undefined; }
  if (r === undefined) { el.hidden = true; return; }   // lookup failed — say nothing wrong
  if (r) {
    const d = r.meters < 1000 ? `${r.meters} m` : `${(r.meters / 1000).toFixed(1)} km`;
    el.innerHTML = ` <strong>${d}</strong> from the nearest main road` +
      (r.name ? ` — <strong>${esc(r.name)}</strong>` : "");
  } else {
    el.innerHTML = ` More than 3 km from the nearest main road`;
  }
}
