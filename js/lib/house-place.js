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

  // Before the early return, deliberately. The hand-off is a link, not a map
  // feature: a listing whose map cannot be drawn here still has coordinates
  // worth handing to the app that navigates.
  wireDirections(h);

  if (h.lat == null || h.lng == null) {
    mapEl.innerHTML = `<div class="hd-state" style="margin:0;border-radius:0;height:100%"><p>${esc(T("hs_dir_nopin", "This listing has no pin yet, so there is nowhere to navigate to."))}</p></div>`;
    return;
  }

  // Hybrid base (satellite + roads + street names) with a Map / Satellite
  // toggle, so a buyer can always read which street the home sits on.
  //
  // EVERY CONTROL HANGS OFF THE BOTTOM. Four things used to land in the top
  // strip of a 320px map: the Maximize pill, eleven scrolling category chips,
  // the zoom stepper and the basemap toggle. The pill covered the first chip,
  // and between them they hid the part of the neighbourhood directly above the
  // pin, which is the part somebody is reading the map for. The chips moved out
  // of the map entirely (see attachNearbyOverlay); the rest moved down here.
  //
  // The attribution is added by hand only so it can be `compact`: the default
  // paints a full-width white bar of credits across the foot of the imagery.
  const map = new maplibregl.Map({
    container: "hdMap",
    style: window.pawaGlHybridStyle ? window.pawaGlHybridStyle() : { version: 8, sources: {}, layers: [] },
    center: [h.lng, h.lat],
    zoom: 15,
    maxBounds: [[29.34, -11.75], [40.45, -0.99]],
    attributionControl: false
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
  // MapLibre renders the compact attribution OPEN on first paint, which is a
  // 254px bar of credits lying across the foot of the imagery and straight
  // through the Maximize button at 390px. Closed, it is the (i) that compact
  // mode exists to be, and the credit is one tap away, which is what the tile
  // terms ask for. Re-closed on load because the control reopens itself when
  // the style finishes and the attributions are recounted.
  const shutAttrib = () => {
    const d = mapEl.querySelector("details.maplibregl-ctrl-attrib");
    if (d) d.open = false;
  };
  shutAttrib();
  map.once("load", shutAttrib);
  map.once("idle", shutAttrib);
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  if (window.pawaGlBasemapToggle) map.addControl(window.pawaGlBasemapToggle(), "bottom-right");
  // Bottom-LEFT, so it never stacks under the three above. The shared button is
  // top-left everywhere else in the app; css/house-detail.css moves this one.
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

  attachNearbyOverlay(map, h.lat, h.lng);
  attachCommuteTool(map, h.lat, h.lng);
  showNearestMainRoad(h.lat, h.lng);
}

/**
 * The hand-off to Google Maps: one tap, nothing to fill in.
 *
 * All of the thinking is in js/lib/maps-handoff.js, and the one rule worth
 * repeating here is why this is not an async click handler. Waiting for a GPS
 * fix and THEN navigating is a popup the browser blocks and a href rewritten
 * after the click has already been followed. So the link is always valid and
 * gets better in the background instead.
 *
 * TWO links, one destination. The main one is for going; the second is for
 * looking, which is the job the hand-drawn OSRM line used to do here and did
 * badly: a road on a 320px square, bought with a location prompt and several
 * seconds of waiting. Google Maps already has the whole route, the traffic on
 * it and a screen to spread it over, and both boxes are filled in either way.
 */
function wireDirections(h) {
  if (!window.PawaMaps) return;
  const to = { lat: h.lat, lng: h.lng };
  ["hdDirBtn", "hdRouteBtn"].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) window.PawaMaps.bindDirections(btn, to, { mode: "car" });
  });
}

/** The one status line under the two map actions. Empty means hidden. */
function showGoMsg(text) {
  const el = document.getElementById("hdGoMsg");
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
}

// The five kinds "Match to my life" stores, as words. The keys are set by
// js/pages/houses.js and are not ours to rename; anything it has not heard of
// is a place, which is true and is better than printing a database word.
const PLACE_KIND_KEY = {
  work: "hs_work", school: "hs_school", family: "hs_family", fav: "hs_fav",
};
const PLACE_KIND_EN = {
  work: "Workplace", school: "School", family: "Family", fav: "Favourite spot",
};

function placeKindLabel(kind) {
  const key = PLACE_KIND_KEY[kind];
  return key ? T(key, PLACE_KIND_EN[kind]) : T("hs_place_other", "Place");
}

/**
 * The places this person already told us they travel to.
 *
 * Each row offers both answers, because they are different questions asked in
 * the same breath: Google Maps takes you there, and the map here tells you how
 * far it is without leaving the listing. The Google link is a real anchor with
 * a real href, so it is a navigation and never a blocked popup.
 *
 * @param {number}   lat  this listing's pin, which is the ORIGIN here
 * @param {number}   lng
 * @param {Function} onMeasure  called with a place to route on this page's map
 */
function renderSavedPlaces(lat, lng, onMeasure) {
  const box = document.getElementById("hdSaved");
  if (!box || !window.PawaMaps) return;

  const places = window.PawaMaps.savedPlaces();
  if (!places.length) {
    // Not an empty state with a button to somewhere else: the place editor
    // lives on houses.html and sending somebody off this listing to fill in a
    // form is how you lose them. One sentence, so the box is explicable the
    // next time they see it full.
    box.innerHTML = `<p class="hd-saved__none">${esc(T("hs_far_add", "Save a place once and it is here on every listing."))}</p>`;
    box.hidden = false;
    return;
  }

  // Workplace first. It is the one the whole feature is named after and the
  // one that decides whether a home is liveable; a café should never outrank it
  // just because it was saved later.
  const order = { work: 0, school: 1, family: 2, custom: 3, fav: 4 };
  const sorted = places.slice().sort((a, b) =>
    (order[a.kind] ?? 3) - (order[b.kind] ?? 3));

  box.innerHTML = sorted.map((p, i) => {
    const name = String(p.name || p.label || "").trim() || placeKindLabel(p.kind);
    const href = window.PawaMaps.directions(p, {
      from: { lat, lng }, mode: window.PawaMaps.modeOf(p),
    });
    return `<div class="hd-saved__row">
      <span class="hd-saved__who">
        <span class="hd-saved__n">${esc(name)}</span>
        <span class="hd-saved__k">${esc(placeKindLabel(p.kind))}</span>
      </span>
      <span class="hd-saved__acts">
        <a class="hd-saved__go" href="${href}" target="_blank" rel="noopener">${ico(ICO.nav, 13)} ${esc(T("hs_far_open", "Open in Google Maps"))}</a>
        <button type="button" class="hd-saved__here" data-i="${i}">${ico(ICO.route, 13)} ${esc(T("hs_far_here", "Draw it on this map"))}</button>
      </span>
    </div>`;
  }).join("");
  box.hidden = false;

  box.querySelectorAll(".hd-saved__here").forEach((b) => {
    b.addEventListener("click", () => {
      const p = sorted[parseInt(b.dataset.i, 10)];
      if (!p) return;
      // Shaped like a pawaGeo suggestion, because that is what selectPlace()
      // measures. `tag` is what its row prints, so it says what kind of place
      // this is rather than repeating the name.
      onMeasure({ name: String(p.name || p.label || "").trim() || placeKindLabel(p.kind),
                  tag: placeKindLabel(p.kind), lat: p.lat, lng: p.lng, saved: true });
    });
  });
}

// maplibre paints into a <canvas>, which cannot read a CSS custom property, so
// this is the only place on this page where a brand colour is written as a
// value. It is read from the design system at load time rather than typed, so a
// token change still reaches the map.
//
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
// `label` is the English fallback only. What a person reads comes from `k`
// through catLabel(), resolved at render time so switching language repaints
// the chips instead of leaving eleven English words on a Swahili page.
const POI_CATS = [
  { key: "school",     k: "hs_poi_school",    label: "Schools",              icon: ico(ICO.building, 12), color: "var(--info)",
    q: 'node["amenity"~"school|university|college|kindergarten"](around:RADIUS,LAT,LNG);way["amenity"~"school|university|college|kindergarten"](around:RADIUS,LAT,LNG);' },
  { key: "hospital",   k: "hs_poi_hospital",  label: "Hospitals",            icon: ico(ICO.cross, 12), color: "var(--danger)",
    q: 'node["amenity"~"hospital|clinic|doctors|pharmacy"](around:RADIUS,LAT,LNG);way["amenity"~"hospital|clinic"](around:RADIUS,LAT,LNG);' },
  { key: "market",     k: "hs_poi_market",    label: "Markets",              icon: ico(ICO.cart, 12), color: "var(--warn)",
    q: 'node["amenity"="marketplace"](around:RADIUS,LAT,LNG);node["shop"~"supermarket|mall|convenience"](around:RADIUS,LAT,LNG);way["amenity"="marketplace"](around:RADIUS,LAT,LNG);way["shop"~"supermarket|mall"](around:RADIUS,LAT,LNG);' },
  { key: "transport",  k: "hs_poi_transport", label: "Transport",            icon: ico(ICO.bus, 12), color: "var(--green-bright)",
    q: 'node["highway"="bus_stop"](around:RADIUS,LAT,LNG);node["amenity"~"bus_station|taxi"](around:RADIUS,LAT,LNG);node["railway"="station"](around:RADIUS,LAT,LNG);' },
  { key: "bank",       k: "hs_poi_bank",      label: "Banks and ATMs",       icon: ico(ICO.bank, 12), color: "var(--green-neon)",
    q: 'node["amenity"~"bank|atm|bureau_de_change"](around:RADIUS,LAT,LNG);' },
  { key: "food",       k: "hs_poi_food",      label: "Restaurants",          icon: ico(ICO.fork, 12), color: "var(--gold-warm)",
    q: 'node["amenity"~"restaurant|cafe|fast_food|food_court|bar"](around:RADIUS,LAT,LNG);way["amenity"~"restaurant|cafe"](around:RADIUS,LAT,LNG);' },
  { key: "worship",    k: "hs_poi_worship",   label: "Mosques and churches", icon: ico(ICO.pray, 12), color: "var(--gold)",
    q: 'node["amenity"="place_of_worship"](around:RADIUS,LAT,LNG);way["amenity"="place_of_worship"](around:RADIUS,LAT,LNG);' },
  { key: "leisure",    k: "hs_poi_leisure",   label: "Parks and gyms",       icon: ico(ICO.tree, 12), color: "var(--green-emerald)",
    q: 'node["leisure"~"park|fitness_centre|sports_centre|playground"](around:RADIUS,LAT,LNG);way["leisure"~"park|fitness_centre|sports_centre|stadium"](around:RADIUS,LAT,LNG);' },
  { key: "fuel",       k: "hs_poi_fuel",      label: "Fuel",                 icon: ico(ICO.fuel, 12), color: "var(--text-muted)",
    q: 'node["amenity"="fuel"](around:RADIUS,LAT,LNG);' },
  { key: "safety",     k: "hs_poi_safety",    label: "Police and fire",      icon: ico(ICO.shield, 12), color: "var(--text-info)",
    q: 'node["amenity"~"police|fire_station"](around:RADIUS,LAT,LNG);way["amenity"~"police|fire_station"](around:RADIUS,LAT,LNG);' },
  { key: "post",       k: "hs_poi_post",      label: "Post and government",  icon: ico(ICO.bank, 12), color: "var(--gold-dark)",
    q: 'node["amenity"~"post_office|townhall|courthouse|embassy"](around:RADIUS,LAT,LNG);way["amenity"~"post_office|townhall|courthouse|embassy"](around:RADIUS,LAT,LNG);' }
];

const POI_RADIUS_M     = 1500;            // 1.5 km around the property
const POI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// What this kind of place is called, in the language being read.
//
// `k` is optional on purpose: poiLabel() below is shared with house-area.js,
// whose NEARBY_META carries a label and no key at all, and a category with no
// key still has to come back with its word rather than an empty chip.
function catLabel(cat) {
  if (!cat) return T("hs_place_other", "Place");
  return cat.k ? T(cat.k, cat.label) : (cat.label || T("hs_place_other", "Place"));
}

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

/**
 * The kinds of place around this home, as chips that paint pins on the map.
 *
 * These used to float across the TOP of the map, eleven of them in a strip that
 * scrolled sideways under the Maximize button, which covered the first one. On
 * a 320px map that is most of the sky above the pin spent on a toolbar. They
 * live under the map now, in `#hdPoi`, where they can be read without being in
 * the way of the thing they act on and where the whole row fits on two lines
 * instead of hiding eight chips off the right edge.
 *
 * Nothing else changed: a chip still fetches its category from Overpass on the
 * first tap, and only on a tap.
 */
function attachNearbyOverlay(map, lat, lng) {
  const host = document.getElementById("hdPoi");
  if (!host) return;

  host.hidden = false;
  host.innerHTML = `
    <p class="hd-poi__label">${esc(T("hs_poi_t", "Places around this home"))}</p>
    <div class="hd-poi-toolbar">${POI_CATS.map((c) =>
      `<button type="button" class="hd-poi-chip" data-cat="${c.key}">
         ${c.icon}<span>${esc(catLabel(c))}</span>
       </button>`).join("")}</div>
    <p class="hd-poi-status" role="status" aria-live="polite">${esc(T("hs_poi_hint", "Tap a kind of place to see it on the map."))}</p>`;

  const toolbar = host.querySelector(".hd-poi-toolbar");
  const status  = host.querySelector(".hd-poi-status");

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
      const what = catLabel(meta);
      const on  = !chip.classList.contains("active");
      if (!on) {
        chip.classList.remove("active");
        (markersByCat[cat] || []).forEach(m => m.remove());
        markersByCat[cat] = [];
        showHint();
        return;
      }
      chip.classList.add("active");
      if (!dataByCat[cat]) {
        chip.classList.add("loading");
        showStatus(fillT(T("hs_poi_load", "Loading {what}…"), { what }));
        try {
          dataByCat[cat] = await fetchPois(cat, lat, lng);
        } catch (e) {
          console.warn("overpass", cat, e);
          chip.classList.remove("loading", "active");
          showStatus(fillT(T("hs_poi_fail", "Could not load {what}."), { what }));
          return;
        }
        chip.classList.remove("loading");
      }
      renderCat(map, cat, dataByCat[cat], markersByCat, { lat, lng });
      const n = dataByCat[cat].length;
      showStatus(n
        ? fillT(T("hs_poi_found", "{n} {what} within {km} km"),
                { n, what: what.toLowerCase(), km: POI_RADIUS_M / 1000 })
        : fillT(T("hs_poi_none", "No {what} found nearby"), { what: what.toLowerCase() }));
    });
  });

  // The status line is a permanent row rather than a pill that appears over the
  // imagery and vanishes on a timer, so the block never changes height and the
  // map never has anything sitting on it. With nothing chosen it says what the
  // chips are for, which is the state it spends most of its life in.
  function showStatus(text) { status.textContent = text; }
  function showHint() {
    const anyOn = !!toolbar.querySelector(".hd-poi-chip.active");
    if (!anyOn) showStatus(T("hs_poi_hint", "Tap a kind of place to see it on the map."));
  }
}

// Popup HTML for a nearby place. Distance is REAL road km only (never crow-flies):
// "measuring…" until the matrix answers, then "X km by road", or unavailable.
function poiPopupHtml(name, catMeta, km, state) {
  const dist = state === "road"
    ? fillT(T("hs_far_by_road", "{km} by road"),
            { km: km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(km < 10 ? 2 : 1) + " km" })
    : state === "measuring" ? T("hs_poi_measuring", "measuring road distance…")
    : T("hs_poi_nodist", "road distance unavailable");
  return `<div class="hd-poi-popup">
    <strong>${esc(name)}</strong>
    <div class="pp-meta">${catMeta.icon} ${esc(catLabel(catMeta))} · ${esc(dist)}</div>
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
  return catLabel(catMeta);
}

// ============================================================================
// Commute tool — "how far is this home from my workplace / daily route?"
//
// Two ways in, and the first one is new.
//
//   THE PLACES ALREADY SAVED. "Match to my life" on houses.html asks a person
//   once for their workplace, their school and the spots they visit, and keeps
//   them on the device. This sheet never read them, so on every single listing
//   it asked for a workplace that had already been typed, spelled and pinned.
//   They are now the first thing in the box, each with a one-tap hand-off to
//   Google Maps and a one-tap draw on the map here. Nothing to type at all.
//
//   ANYWHERE ELSE. The typed box, unchanged: LocationIQ (pawaGeo.suggest) to
//   find it, then the REAL driving route via pawaRoute (OSRM ×2 + Valhalla) —
//   the actual road km + minutes, drawn on the map. NEVER straight-line: if no
//   engine can route it we say so rather than show a crow-flies number.
// ============================================================================
function attachCommuteTool(map, lat, lng) {
  const wrap  = document.getElementById("hdCommute");
  const input = document.getElementById("hdCommuteInput");
  const btn   = document.getElementById("hdCommuteBtn");
  const msgEl = document.getElementById("hdCommuteMsg");
  const resEl = document.getElementById("hdCommuteResults");
  const openEl = document.getElementById("hdCommuteOpen");
  if (!wrap || !input || !btn || !window.pawaGeo) return;
  wrap.hidden = false;
  renderSavedPlaces(lat, lng, (p) => selectPlace(p));

  let workMarker = null, lineReady = false, measureSeq = 0;

  // ---- the typed area, as a Google Maps link -----------------------------
  //
  // The box answers "how far", and the answer was a number and a line on a
  // 320px map. What somebody does next with that answer is look at the route,
  // and there was nothing here to look at it with, so the area they had just
  // typed had to be typed a second time into Google Maps.
  //
  // It is an ANCHOR, painted the moment a name resolves to a point, and never a
  // window.open() from the Measure handler: that runs after the geocoder has
  // been awaited, and a popup opened seconds after the tap is blocked by every
  // browser. The same rule as js/lib/maps-handoff.js, for the same reason.
  //
  // The origin is THIS HOME, not the visitor: the question in the label above
  // is how far the home is from the place, not how far the reader is.
  function paintOpen(p) {
    if (!openEl || !window.PawaMaps) return;
    const href = p && window.PawaMaps.usable(p)
      ? window.PawaMaps.directions(p, { from: { lat, lng }, mode: "car" })
      : "";
    if (!href) { openEl.hidden = true; openEl.removeAttribute("href"); return; }
    openEl.href = href;
    const d = openEl.querySelector(".hd-commute-open__d");
    if (d) d.innerHTML = fillT(T("hs_far_open_d", "This home to {name}, both already filled in."),
                               { name: `<strong>${esc(p.name || "")}</strong>` });
    openEl.hidden = false;
  }

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
    paintOpen(p);

    const ctx = p.context ? ` <span class="hd-commute-ctx">(${esc(p.context)})</span>` : "";
    const seq = ++measureSeq;
    const who = `<strong>${esc(p.name)}</strong>`;
    showMsg(fillT(T("hs_far_measuring", "Measuring the real road distance to {name}…"), { name: who }), "");

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
      const altList = alts.map((a) => `${fmtKm(a.km)}, ~${Math.round(a.durationMin)} min`).join(", ");
      const altNote = !alts.length
        ? T("hs_far_road_note", "Measured along the actual road, drawn on the map.")
        : alts.length === 1
          ? fillT(T("hs_far_alt_one", "There is 1 more road into this area: {list}. It is drawn lighter on the map."), { list: altList })
          : fillT(T("hs_far_alt_many", "There are {n} more roads into this area: {list}. They are drawn lighter on the map."),
                  { n: alts.length, list: altList });
      showMsg(
        fillT(T("hs_far_road", "{km} by road, about {min} min drive from this home to {name}."),
              { km: `<strong>${fmtKm(r.km)}</strong>`, min: Math.round(r.durationMin), name: who + ctx }) +
        ` <span class="hd-commute-note">${altNote}</span>`,
        "ok"
      );
      if (rows) {
        const row = rows.find((x) => x.place === p);
        const kmEl = row && row.el.querySelector(".hd-cr-km");
        if (kmEl) kmEl.textContent = fillT(T("hs_far_by_road", "{km} by road"), { km: fmtKm(r.km) });
      }
    } else {
      // No routing engine (OSRM ×2 + Valhalla) could measure it — show the honest
      // state instead of a misleading straight-line number, and draw no fake line.
      setLine([], true);
      setAltLines([]);
      showMsg(
        fillT(T("hs_far_nomeasure", "Could not measure the road distance to {name} right now."), { name: who + ctx }) +
        ` <span class="hd-commute-note">${T("hs_far_retry", "Please try again in a moment.")}</span>`,
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
        `<span class="hd-cr-meta">${esc(p.tag || T("hs_place_other", "Place"))}${p.context ? " · " + esc(p.context) : ""}</span>` +
        `<span class="hd-cr-km">${p.roadKm != null
          ? esc(fillT(T("hs_far_by_road", "{km} by road"), { km: fmtKm(p.roadKm) }))
          : esc(T("hs_far_tap", "tap to measure"))}</span>`;
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
    if (q.length < 2) { paintOpen(null); return; }
    if (!window.pawaPlaceMatch) return;
    // `near` is this listing's own pin: of two places with the same name, the
    // one a person commuting to this house could plausibly mean is the near one.
    const hits = window.pawaPlaceMatch.search(q, { near: { lat, lng }, limit: 5 });
    if (!hits.length) return;   // leave whatever is on screen; the geocoder may know it
    const places = hits.map((h) => ({
      name: h.name, tag: h.kind ? h.kind.charAt(0).toUpperCase() + h.kind.slice(1) : T("hs_place_other", "Place"),
      context: h.city && h.city !== h.name ? h.city : "", lat: h.lat, lng: h.lng,
      local: true, score: h.score, exact: h.exact,
    }));
    renderResults(places);
    // Google Maps is now one tap away from the word that was just typed, with
    // this home and that place both already in it. Nothing is measured and no
    // network is touched to get here; the link is simply correct as soon as the
    // name resolves to a point.
    paintOpen(places[0]);
    // "Found" only for a place whose name was actually typed. A high score on a
    // misspelling is still a guess at a letter nobody typed, so the box asks
    // instead of asserting — the same line pawaGeo.suggest draws with `fuzzy`.
    const sure = hits[0].exact;
    const who  = `<strong>${esc(hits[0].name)}</strong>`;
    showMsg(
      sure
        ? fillT(T("hs_far_found", "Found {name}. Tap it to measure the road distance, or press Measure to search wider."), { name: who })
        : fillT(T("hs_far_didyou", "Did you mean {name}? Tap a place to measure it, or press Measure to search everywhere."), { name: who }),
      sure ? "ok" : "warn"
    );
  }

  async function run() {
    const q = input.value.trim();
    if (q.length < 2) {
      showMsg(T("hs_far_type", "Type your workplace, office area or a place on your daily route."), "warn");
      return;
    }
    btn.disabled = true; btn.textContent = T("hs_far_busy", "Looking…");
    showMsg(fillT(T("hs_far_searching", "Searching for “{q}”…"), { q: esc(q) }), "");
    resEl.innerHTML = "";
    let places = [];
    try { places = await window.pawaGeo.suggest(q, { limit: 6, near: { lat, lng } }); } catch (_) { places = []; }
    btn.disabled = false; btn.textContent = T("hs_far_go", "Measure");

    if (!places.length) {
      showMsg(fillT(T("hs_far_none",
        "We could not find “{q}”. Try a famous area, market, school or road near your workplace, then measure again."),
        { q: `<strong>${esc(q)}</strong>` }), "warn");
      return;
    }
    const rows = renderResults(places);
    // When the best we have is a GUESS at a word nobody typed, say so and stop.
    // Auto-measuring a guess draws a confident green route to a place the person
    // never asked for, which is the one outcome worse than not knowing.
    if (places[0].fuzzy) {
      // The link goes with it: a Google Maps route to a guess is the same wrong
      // answer, just harder to take back once the other app has opened.
      paintOpen(null);
      showMsg(fillT(T("hs_far_fuzzy",
        "No exact match for “{q}”. These are the closest places we know. Tap the right one to measure it."),
        { q: `<strong>${esc(q)}</strong>` }), "warn");
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
          if (kmEl) kmEl.textContent = fillT(T("hs_far_by_road", "{km} by road"), { km: fmtKm(km) });
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
