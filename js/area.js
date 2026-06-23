// ============================================================================
//  Explore an AREA by name  (area.html)
//
//  One smart box: a user types a region, district, ward OR village — no GPS,
//  no location permission — and instantly sees every HOUSE and every SERVICE
//  available in that exact area, side by side.
//
//  How a typed place becomes an accurate area (minimal questions, best answers):
//    1. Autocomplete blends three sources so one or two letters already help:
//         • the areas that ACTUALLY have listings (region/district/ward/area
//           tags off the loaded houses + services), labelled with a live count;
//         • the offline gazetteer (js/tz-places.js — every region + the common
//           Dar wards/landmarks) for instant, correct local hits;
//         • pawaGeo.suggest() (LocationIQ, country-wide) for everything else,
//           right down to villages and hamlets.
//    2. Picking one resolves it to a real ADMINISTRATIVE BOUNDARY polygon
//       (pawaGeo.boundary) when we can — exact "inside this ward/district"
//       containment — and falls back to a level-scaled circle when offline.
//    3. A listing is "here" when its pin is inside that area (precise) OR its
//       own region/district/ward/area text matches the place (catches listings
//       with no coordinates). A region guard stops a same-named ward in another
//       region from leaking in.
//
//  Public, no auth. Data via DataStore.getHouses()/getServices() (Supabase →
//  JSON fallback). Reuses pawaGeo, pawaPoly, the tz-places gazetteer and the
//  shared satellite basemap, so it behaves exactly like the rest of the app.
// ============================================================================

(function () {
  "use strict";

  // Fallback circle radius (metres) by admin level, used only when no real
  // boundary polygon is available. Bigger levels → bigger circle; the tag match
  // below still captures the rest of a large region by name.
  const RADIUS_BY_LEVEL = {
    Region: 30000, City: 14000, District: 9000, Town: 5000,
    Ward: 2600, Suburb: 2600, Area: 2600, Village: 2200,
    Locality: 2000, Settlement: 1800,
  };
  const DEFAULT_RADIUS_M = 3000;

  const CATEGORY = {
    cleaning: "Cleaning", plumbing: "Plumbing", electrical: "Electrical",
    carpentry: "Carpentry", painting: "Painting", gardening: "Gardening",
    moving_help: "Moving help", laundry: "Laundry", cooking: "Cooking / Chef",
    tutoring: "Tutoring", beauty: "Beauty & Salon", security: "Security",
    childcare: "Childcare", appliance_repair: "Appliance repair", other: "Other",
  };
  const RATE_UNIT = { hourly: "hr", daily: "day", per_job: "job", monthly: "month" };

  // ---- State -------------------------------------------------------------
  let houses = [];
  let services = [];
  let chosen = null;       // { name, tag, lat, lng, context, region }
  let areaShape = null;    // pawaPoly area: {geo,bbox} polygon | {lat,lng,radius_m} circle
  let view = "all";        // all | houses | services
  let map = null, boundaryLayer = null, markersLayer = null, centerMarker = null;
  let suggestSeq = 0, geoSeq = 0, suggestTimer = null;
  let activeSuggest = -1, suggestItems = [];

  // ---- Tiny utils --------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (window.escHtml ? window.escHtml(s) : String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;"));
  const norm = (s) => String(s == null ? "" : s).toLowerCase()
    .replace(/[.,()]/g, " ").replace(/\s+/g, " ").trim();

  function haversineM(aLat, aLng, bLat, bLng) {
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
    const x = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function kmText(km) {
    if (!Number.isFinite(km)) return "";
    if (km < 1) return Math.round(km * 1000) + " m";
    return (km < 10 ? km.toFixed(1) : String(Math.round(km))) + " km";
  }
  function shortTzs(n) {
    n = +n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "k";
    return String(n);
  }

  // ---- Region canonicalisation (for the precision guard) -----------------
  // Build an alias→canonical map from the gazetteer's region centres so we can
  // tell "Dar es Salaam" / "dar" / "dsm" are the same region. Used to drop a
  // same-named ward that actually sits in a DIFFERENT region from a tag match.
  const REGION_CANON = (() => {
    const m = new Map();
    (window.TZ_REGION_CENTERS || []).forEach((r) => {
      m.set(norm(r.name), r.name);
      (r.aliases || []).forEach((a) => m.set(norm(a), r.name));
    });
    return m;
  })();
  function canonRegion(s) {
    const n = norm(s);
    if (!n) return null;
    if (REGION_CANON.has(n)) return REGION_CANON.get(n);
    for (const [k, v] of REGION_CANON) if (n.includes(k) || (k.length >= 4 && k.includes(n))) return v;
    return s || null;
  }
  // The region implied by a suggestion (its name if it IS a region, else the
  // last meaningful part of its context, e.g. "…, Dar es Salaam").
  function regionOfSuggestion(p) {
    if ((p.tag || "") === "Region") return canonRegion(p.name);
    const parts = String(p.context || "").split(",").map((s) => s.trim()).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const c = canonRegion(parts[i]);
      if (c && REGION_CANON.has(norm(parts[i]))) return c;
    }
    return parts.length ? canonRegion(parts[parts.length - 1]) : null;
  }

  // ---- Matching: is a listing inside the chosen area? --------------------
  function listingHay(o) {
    return norm([o.region, o.district, o.ward, o.area, o.address].filter(Boolean).join(" "));
  }
  function geoMatch(o) {
    const lat = +o.lat, lng = +o.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !areaShape) return false;
    if (window.pawaPoly) return window.pawaPoly.pointInArea(lng, lat, areaShape);
    if (areaShape.radius_m) return haversineM(lat, lng, areaShape.lat, areaShape.lng) <= areaShape.radius_m;
    return false;
  }
  function tagMatch(o) {
    if (!chosen) return false;
    const token = norm(chosen.name);
    if (token.length < 3) return false;
    if (!listingHay(o).includes(token)) return false;
    // Precision guard: a name match in a different region isn't this place.
    if (chosen.region && o.region && canonRegion(o.region) !== chosen.region) return false;
    return true;
  }
  function inArea(o) { return geoMatch(o) || tagMatch(o); }

  function distMeters(o) {
    if (!chosen || !Number.isFinite(+o.lat) || !Number.isFinite(+o.lng)) return Infinity;
    if (!Number.isFinite(chosen.lat) || !Number.isFinite(chosen.lng)) return Infinity;
    return haversineM(+o.lat, +o.lng, chosen.lat, chosen.lng);
  }
  function sortByDistance(rows) {
    return rows.slice().sort((a, b) => distMeters(a) - distMeters(b));
  }

  // ====================================================================
  //  Autocomplete
  // ====================================================================
  // Local index of suggestible places: the areas that actually have listings
  // (with counts) + the offline gazetteer. Rebuilt once listings are loaded.
  let localIndex = [];
  function buildLocalIndex() {
    const counts = new Map();   // norm(name) -> { name, houses, services, regions:Map }
    const bump = (name, kind, region) => {
      const key = norm(name);
      if (!key || key.length < 2) return;
      const e = counts.get(key) || { name: String(name).trim(), houses: 0, services: 0, regions: new Map() };
      e[kind]++;
      const cr = canonRegion(region);
      if (cr) e.regions.set(cr, (e.regions.get(cr) || 0) + 1);
      counts.set(key, e);
    };
    houses.forEach((h) => [h.ward, h.area, h.district, h.region].forEach((n) => n && bump(n, "houses", h.region)));
    services.forEach((s) => [s.area, s.region].forEach((n) => n && bump(n, "services", s.region)));

    const fromTags = [...counts.values()].map((e) => {
      // Dominant region for this area name — labels the row AND powers the
      // cross-region guard so "Sinza, Mwanza" never leaks into "Sinza, Dar".
      let region = "", best = 0;
      for (const [r, c] of e.regions) if (c > best) { best = c; region = r; }
      return {
        name: e.name, tag: "Has listings", context: region, region, lat: NaN, lng: NaN,
        houses: e.houses, services: e.services, _src: "tag",
      };
    });
    const gaz = [
      ...(window.TZ_REGION_CENTERS || []).map((r) => ({ name: r.name, tag: "Region", lat: r.lat, lng: r.lng, context: "Tanzania", _src: "gaz" })),
      ...(window.TZ_LANDMARKS || []).filter((l) => l.kind === "area").map((l) => ({ name: l.name, tag: "Area", lat: l.lat, lng: l.lng, context: l.city || "", _src: "gaz" })),
    ];
    localIndex = [...fromTags, ...gaz];
  }

  function localSuggest(q) {
    const n = norm(q);
    if (n.length < 2) return [];
    const scored = [];
    for (const it of localIndex) {
      const nm = norm(it.name);
      let rank;
      if (nm === n) rank = 0;
      else if (nm.startsWith(n)) rank = 1;
      else if (nm.includes(n)) rank = 2;
      else continue;
      scored.push({ ...it, _rank: rank });
    }
    // Areas with listings first, then by match quality, then shorter names.
    scored.sort((a, b) =>
      (b._src === "tag") - (a._src === "tag") ||
      a._rank - b._rank ||
      a.name.length - b.name.length);
    return scored.slice(0, 8);
  }

  // Merge local + online suggestions, de-duped by name + region context.
  function mergeSuggestions(local, online) {
    const out = [], seen = new Set();
    const keyOf = (p) => norm(p.name) + "|" + norm(regionOfSuggestion(p) || p.context || "");
    for (const p of [...local, ...online]) {
      const k = keyOf(p);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
      if (out.length >= 12) break;
    }
    return out;
  }

  function suggestRowHtml(p, i) {
    const count = (p.houses || p.services)
      ? `<span class="ar-sg-count">${p.houses ? p.houses + "🏠" : ""}${p.houses && p.services ? " " : ""}${p.services ? p.services + "🛠" : ""}</span>`
      : "";
    const ctx = p.context && !/^tanzania$/i.test(p.context) ? `<span class="ar-sg-ctx">${esc(p.context)}</span>` : "";
    return `<button type="button" class="ar-sg-row${i === activeSuggest ? " active" : ""}" data-i="${i}" role="option">
        <span class="ar-sg-pin" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 21s7-5.6 7-11a7 7 0 10-14 0c0 5.4 7 11 7 11z" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="10" r="2.3" fill="currentColor"/></svg></span>
        <span class="ar-sg-main"><span class="ar-sg-name">${esc(p.name)}</span>${ctx}</span>
        <span class="ar-sg-tag">${esc(p.tag || "Place")}</span>${count}
      </button>`;
  }

  function renderSuggestions(items) {
    const box = $("arSuggest");
    suggestItems = items;
    activeSuggest = -1;
    if (!items.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.innerHTML = items.map(suggestRowHtml).join("");
    box.hidden = false;
    box.querySelectorAll(".ar-sg-row").forEach((row) =>
      row.addEventListener("click", () => choosePlace(suggestItems[+row.dataset.i])));
  }

  function hideSuggestions() { const b = $("arSuggest"); if (b) { b.hidden = true; } }

  async function onSearchInput() {
    const q = $("arInput").value.trim();
    clearTimeout(suggestTimer);
    if (q.length < 2) { renderSuggestions([]); return; }
    const local = localSuggest(q);
    renderSuggestions(local);   // instant, from gazetteer + listing tags
    // …then enrich with country-wide online matches (villages etc.).
    const seq = ++suggestSeq;
    suggestTimer = setTimeout(async () => {
      let online = [];
      try { online = window.pawaGeo ? await window.pawaGeo.suggest(q, { limit: 12 }) : []; }
      catch (_) { online = []; }
      if (seq !== suggestSeq) return;     // a newer keystroke already ran
      renderSuggestions(mergeSuggestions(localSuggest(q), online));
    }, 240);
  }

  // ====================================================================
  //  Choosing a place → resolve area → render
  // ====================================================================
  async function choosePlace(p) {
    if (!p) return;
    hideSuggestions();
    $("arInput").value = p.name;
    chosen = {
      name: p.name,
      tag: p.tag && p.tag !== "Has listings" ? p.tag : "Area",
      lat: +p.lat, lng: +p.lng,
      context: p.context || "",
      region: p.region ? canonRegion(p.region) : regionOfSuggestion(p),
    };

    // If a listing-tag suggestion had no coordinates, borrow a centre from the
    // gazetteer (or the online geocoder) so the map + circle have an anchor.
    if (!Number.isFinite(chosen.lat) || !Number.isFinite(chosen.lng)) {
      const g = window.resolveTzPlace && window.resolveTzPlace(p.name);
      if (g) { chosen.lat = g.lat; chosen.lng = g.lng; if (!chosen.region) chosen.region = regionOfSuggestion({ name: p.name }); }
    }

    // Immediate: a level-scaled circle so results appear with zero latency.
    areaShape = (Number.isFinite(chosen.lat) && Number.isFinite(chosen.lng))
      ? { lat: chosen.lat, lng: chosen.lng, radius_m: RADIUS_BY_LEVEL[chosen.tag] || DEFAULT_RADIUS_M }
      : null;
    renderResults();
    renderArea();

    // Upgrade to the real administrative boundary in the background (exact
    // containment). Falls back silently to the circle when offline / no key.
    const seq = ++geoSeq;
    if (window.pawaGeo && window.pawaGeo.boundary) {
      const q = chosen.region && !norm(p.context).includes(norm(chosen.region))
        ? `${p.name}, ${chosen.region}` : (p.full || p.name);
      let b = null;
      try { b = await window.pawaGeo.boundary({ q }); } catch (_) { b = null; }
      if (seq !== geoSeq) return;          // a newer pick superseded this one
      if (b && b.geojson) {
        areaShape = { geo: b.geojson, bbox: b.bbox };
        if (window.pawaPoly && b.bbox) {
          const c = window.pawaPoly.centroidOf ? window.pawaPoly.centroidOf(b.geojson) : null;
          if (c && Number.isFinite(c[1])) { chosen.lat = c[1]; chosen.lng = c[0]; }
        }
        renderResults();
        renderArea();
      }
    }
  }

  // ====================================================================
  //  Rendering — banner, counts, lists, map
  // ====================================================================
  function setView(v) {
    view = v;
    document.querySelectorAll(".ar-seg-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === v));
    renderResults();
  }

  function houseCard(h) {
    const img = window.DataStore ? window.DataStore.housePhotoUrl(h.photo || (h.photos || [])[0]) : "";
    const loc = [h.ward || h.area, h.region].filter(Boolean).join(", ");
    const km = distMeters(h) / 1000;
    const beds = h.room_kind === "single" ? "Single room" : h.room_kind === "master" ? "Master room"
      : [h.bedrooms ? h.bedrooms + " bd" : "", h.bathrooms ? h.bathrooms + " ba" : ""].filter(Boolean).join(" · ");
    const price = h.price_tzs ? `${shortTzs(h.price_tzs)} <small>TZS${h.listing === "sale" ? "" : " / " + (h.period || "month")}</small>` : "Ask";
    const photoStyle = img ? `background-image:url('${esc(img)}')` : "";
    return `<a class="ar-card" href="house.html?id=${encodeURIComponent(h.id)}">
        <span class="ar-card-photo" style="${photoStyle}">
          ${img ? "" : `<span class="ar-card-ph">🏠</span>`}
          ${h.verified ? `<span class="ar-badge verified">✓ Verified</span>` : ""}
          ${Number.isFinite(km) ? `<span class="ar-badge dist">${kmText(km)}</span>` : ""}
        </span>
        <span class="ar-card-body">
          <span class="ar-card-price">${price}</span>
          <span class="ar-card-title">${esc(h.title || "Property")}</span>
          ${loc ? `<span class="ar-card-meta">📍 ${esc(loc)}</span>` : ""}
          ${beds ? `<span class="ar-card-tags"><span>${esc(beds)}</span>${h.type ? `<span>${esc(h.type)}</span>` : ""}</span>` : ""}
        </span>
      </a>`;
  }

  function serviceCard(s) {
    const img = window.DataStore ? window.DataStore.servicePhotoUrl(s.photo || (s.photos || [])[0]) : "";
    const loc = [s.area, s.region].filter(Boolean).join(", ");
    const km = distMeters(s) / 1000;
    const cat = CATEGORY[s.category] || CATEGORY.other;
    const price = s.price_tzs ? `from ${shortTzs(s.price_tzs)} <small>TZS / ${RATE_UNIT[s.rate_type] || "job"}</small>` : "Ask";
    const photoStyle = img ? `background-image:url('${esc(img)}')` : "";
    return `<a class="ar-card" href="service.html?id=${encodeURIComponent(s.id)}">
        <span class="ar-card-photo svc" style="${photoStyle}">
          ${img ? "" : `<span class="ar-card-ph">🛠</span>`}
          <span class="ar-badge cat">${esc(cat)}</span>
          ${s.verified ? `<span class="ar-badge verified">✓ Verified</span>` : ""}
          ${Number.isFinite(km) ? `<span class="ar-badge dist">${kmText(km)}</span>` : ""}
        </span>
        <span class="ar-card-body">
          <span class="ar-card-price">${price}</span>
          <span class="ar-card-title">${esc(s.title || cat)}</span>
          ${loc ? `<span class="ar-card-meta">📍 ${esc(loc)}</span>` : ""}
          ${s.experience_years ? `<span class="ar-card-tags"><span>${esc(s.experience_years)} yrs exp</span></span>` : ""}
        </span>
      </a>`;
  }

  function renderResults() {
    const banner = $("arBanner");
    const seg = $("arSeg");
    const results = $("arResults");
    if (!chosen) {
      banner.hidden = true; seg.hidden = true;
      results.innerHTML = "";
      $("arIntro").hidden = false;
      return;
    }
    $("arIntro").hidden = true;

    const hRows = sortByDistance(houses.filter(inArea));
    const sRows = sortByDistance(services.filter(inArea));
    const total = hRows.length + sRows.length;

    // Banner: which area, how much is here.
    const ctx = chosen.context && !/^tanzania$/i.test(chosen.context) ? ` · ${esc(chosen.context)}` : "";
    banner.hidden = false;
    banner.innerHTML = `
      <div class="ar-banner-main">
        <span class="ar-banner-pin" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 21s7-5.6 7-11a7 7 0 10-14 0c0 5.4 7 11 7 11z" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="10" r="2.3" fill="currentColor"/></svg></span>
        <div>
          <div class="ar-banner-name">${esc(chosen.name)} <span class="ar-banner-tag">${esc(chosen.tag)}</span></div>
          <div class="ar-banner-sub">${total ? `${hRows.length} home${hRows.length === 1 ? "" : "s"} · ${sRows.length} service${sRows.length === 1 ? "" : "s"} here` : "Nothing listed here yet"}${ctx}</div>
        </div>
      </div>
      <button type="button" class="ar-banner-change" id="arChange">Change area</button>`;
    $("arChange").addEventListener("click", () => {
      chosen = null; areaShape = null;
      $("arInput").value = ""; $("arInput").focus();
      renderResults(); renderArea();
    });

    // Segmented toggle with live counts.
    seg.hidden = false;
    seg.innerHTML = `
      <button type="button" class="ar-seg-btn${view === "all" ? " active" : ""}" data-view="all">All <b>${total}</b></button>
      <button type="button" class="ar-seg-btn${view === "houses" ? " active" : ""}" data-view="houses">🏠 Homes <b>${hRows.length}</b></button>
      <button type="button" class="ar-seg-btn${view === "services" ? " active" : ""}" data-view="services">🛠 Services <b>${sRows.length}</b></button>`;
    seg.querySelectorAll(".ar-seg-btn").forEach((b) =>
      b.addEventListener("click", () => setView(b.dataset.view)));

    // Result sections.
    if (!total) {
      results.innerHTML = `<div class="ar-empty">
          <div class="ar-empty-ic">🔍</div>
          <b>Nothing listed in ${esc(chosen.name)} yet</b>
          <span>Be the first — <a href="agent-houses.html">list a house</a> or <a href="agent-services.html">offer a service</a> here. Or try a nearby area.</span>
        </div>`;
      renderMarkers([]);
      return;
    }
    const blocks = [];
    if (view !== "services" && hRows.length) {
      blocks.push(`<div class="ar-sec"><div class="ar-sec-head"><h2>🏠 Homes in ${esc(chosen.name)}</h2><a href="houses.html">All homes →</a></div>
        <div class="ar-grid">${hRows.map(houseCard).join("")}</div></div>`);
    }
    if (view !== "houses" && sRows.length) {
      blocks.push(`<div class="ar-sec"><div class="ar-sec-head"><h2>🛠 Services in ${esc(chosen.name)}</h2><a href="services.html">All services →</a></div>
        <div class="ar-grid">${sRows.map(serviceCard).join("")}</div></div>`);
    }
    if (!blocks.length) {
      const none = view === "houses" ? "homes" : "services";
      blocks.push(`<div class="ar-empty"><div class="ar-empty-ic">🔍</div><b>No ${none} in ${esc(chosen.name)} yet</b><span>Switch the filter above to see what is here.</span></div>`);
    }
    results.innerHTML = blocks.join("");
    renderMarkers([...hRows.map((h) => ({ o: h, kind: "house" })), ...sRows.map((s) => ({ o: s, kind: "service" }))]);
  }

  // ---- Map: shade the area + drop a marker per listing -------------------
  function ensureMap() {
    if (map || !window.L || !$("arMap")) return;
    try {
      map = L.map($("arMap"), { scrollWheelZoom: true, attributionControl: false }).setView([-6.4, 35.0], 5);
      if (window.addSatelliteHybrid) window.addSatelliteHybrid(map);
    } catch (_) { map = null; }
  }

  function renderArea() {
    const wrap = $("arMap");
    // Keep the map hidden until there's an area to show — no empty grey box.
    if (!chosen || !areaShape) { if (wrap) wrap.hidden = true; return; }
    if (wrap) wrap.hidden = false;
    ensureMap();
    if (!map) { if (wrap) wrap.hidden = true; return; }
    setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 60);
    if (boundaryLayer) { map.removeLayer(boundaryLayer); boundaryLayer = null; }
    if (centerMarker) { map.removeLayer(centerMarker); centerMarker = null; }
    if (!chosen || !areaShape) return;
    const style = { color: "#2EE6A6", weight: 2.5, fillColor: "#2EE6A6", fillOpacity: 0.10 };
    try {
      if (areaShape.geo) {
        // White casing under the outline so it reads on the dark satellite tiles.
        boundaryLayer = L.layerGroup([
          L.geoJSON({ type: "Feature", geometry: areaShape.geo }, { interactive: false, style: { color: "#fff", weight: 5, opacity: .9, fill: false } }),
          L.geoJSON({ type: "Feature", geometry: areaShape.geo }, { interactive: false, style }),
        ]).addTo(map);
        try { map.fitBounds(L.geoJSON({ type: "Feature", geometry: areaShape.geo }).getBounds(), { padding: [30, 30] }); } catch (_) {}
      } else if (Number.isFinite(areaShape.lat)) {
        boundaryLayer = L.circle([areaShape.lat, areaShape.lng], { radius: areaShape.radius_m, ...style }).addTo(map);
        map.fitBounds(boundaryLayer.getBounds(), { padding: [30, 30] });
      }
    } catch (_) {}
  }

  function renderMarkers(items) {
    if (!map) return;
    if (markersLayer) { map.removeLayer(markersLayer); markersLayer = null; }
    if (!items.length) return;
    markersLayer = L.layerGroup().addTo(map);
    items.forEach(({ o, kind }) => {
      const lat = +o.lat, lng = +o.lng;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const color = kind === "house" ? "#2EE6A6" : "#F6C45A";
      const mk = L.circleMarker([lat, lng], { radius: 6, color: "#06170F", weight: 1.5, fillColor: color, fillOpacity: 1 });
      const href = kind === "house" ? `house.html?id=${encodeURIComponent(o.id)}` : `service.html?id=${encodeURIComponent(o.id)}`;
      const price = o.price_tzs ? `<br>${shortTzs(o.price_tzs)} TZS` : "";
      mk.bindPopup(`<strong>${esc(o.title || (kind === "house" ? "Property" : "Service"))}</strong>${price}<br><a href="${href}">View →</a>`);
      mk.addTo(markersLayer);
    });
  }

  // ---- Popular areas (zero-typing entry) ---------------------------------
  function renderPopular() {
    const el = $("arPopular");
    if (!el) return;
    // Areas that actually have the most listings, then a few headline regions.
    const top = localIndex
      .filter((p) => p._src === "tag" && (p.houses + p.services) > 0)
      .sort((a, b) => (b.houses + b.services) - (a.houses + a.services))
      .slice(0, 6);
    const regions = (window.TZ_REGION_CENTERS || [])
      .filter((r) => ["Dar es Salaam", "Mwanza", "Arusha", "Dodoma", "Mbeya", "Zanzibar"].includes(r.name) ||
        r.aliases?.includes("zanzibar"))
      .slice(0, 5)
      .map((r) => ({ name: r.name, tag: "Region", lat: r.lat, lng: r.lng, context: "Tanzania" }));
    const chips = [...top, ...regions].slice(0, 10);
    if (!chips.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<span class="ar-pop-lbl">Popular:</span>` +
      chips.map((p, i) => `<button type="button" class="ar-pop-chip" data-i="${i}">${esc(p.name)}</button>`).join("");
    el.querySelectorAll(".ar-pop-chip").forEach((b) =>
      b.addEventListener("click", () => choosePlace(chips[+b.dataset.i])));
  }

  // ====================================================================
  //  Boot
  // ====================================================================
  async function init() {
    const input = $("arInput");
    const form = $("arForm");

    // Load both datasets in parallel; either failing must not break the box.
    const [h, s] = await Promise.allSettled([
      window.DataStore.getHouses(), window.DataStore.getServices(),
    ]);
    houses = h.status === "fulfilled" && Array.isArray(h.value) ? h.value : [];
    services = s.status === "fulfilled" && Array.isArray(s.value) ? s.value : [];
    buildLocalIndex();
    renderPopular();

    input.addEventListener("input", onSearchInput);
    input.addEventListener("focus", onSearchInput);
    input.addEventListener("keydown", (e) => {
      const box = $("arSuggest");
      if (box.hidden || !suggestItems.length) {
        if (e.key === "Enter") { e.preventDefault(); runFreeSearch(); }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        activeSuggest = e.key === "ArrowDown"
          ? Math.min(suggestItems.length - 1, activeSuggest + 1)
          : Math.max(0, activeSuggest - 1);
        box.querySelectorAll(".ar-sg-row").forEach((r, i) => r.classList.toggle("active", i === activeSuggest));
      } else if (e.key === "Enter") {
        e.preventDefault();
        choosePlace(suggestItems[activeSuggest >= 0 ? activeSuggest : 0]);
      } else if (e.key === "Escape") {
        hideSuggestions();
      }
    });
    form.addEventListener("submit", (e) => { e.preventDefault(); runFreeSearch(); });

    // Dismiss the dropdown when tapping elsewhere.
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".ar-searchwrap")) hideSuggestions();
    });

    // Deep link: area.html?q=Sinza (homepage search / shared links).
    const q = new URLSearchParams(location.search).get("q") || new URLSearchParams(location.search).get("area");
    if (q) { input.value = q; runFreeSearch(); }
  }

  // Enter with no highlighted row: take the best available match for the typed
  // text (local first, then the online geocoder) so the user is never stuck.
  async function runFreeSearch() {
    const q = $("arInput").value.trim();
    if (q.length < 2) { $("arInput").focus(); return; }
    hideSuggestions();
    const local = localSuggest(q);
    if (local.length) { choosePlace(local[0]); return; }
    let online = [];
    try { online = window.pawaGeo ? await window.pawaGeo.suggest(q, { limit: 6 }) : []; } catch (_) { online = []; }
    if (online.length) choosePlace(online[0]);
    else {
      // Nothing resolved — let the user know plainly (no silent dead end).
      chosen = null; areaShape = null;
      $("arBanner").hidden = false;
      $("arBanner").innerHTML = `<div class="ar-banner-main"><div><div class="ar-banner-name">No area called “${esc(q)}”</div><div class="ar-banner-sub">Check the spelling, or try the district/region it's in.</div></div></div>`;
      $("arResults").innerHTML = ""; $("arSeg").hidden = true; $("arIntro").hidden = true;
    }
  }

  window.initAreaPage = init;
})();
