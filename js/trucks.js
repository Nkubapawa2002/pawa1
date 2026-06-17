// Moving-trucks directory — browse hire trucks, filter by type / area /
// coverage / capacity, and sort by distance to find the truck nearest you.
//
// The "move my goods to the new home" companion to the houses listings. Same
// shape as houses.js but scoped to trucks: a split list + Leaflet map, public
// (no auth needed to browse), data from DataStore.getTrucks() with a JSON
// fallback so the page always works even before the `trucks` table is applied.

(function () {
  "use strict";

  const TYPE_LABEL = {
    pickup: "Pickup", canter: "Canter", "3ton": "3-tonne",
    "7ton": "7-tonne lorry", "10ton_plus": "10-tonne+ lorry", other: "Other",
  };
  // Capitalise a free-text custom kind ("tipper" → "Tipper") for display.
  const typeLabel = (tt) => TYPE_LABEL[tt] || (tt ? tt.charAt(0).toUpperCase() + tt.slice(1) : "Truck");
  const SERVICE_LABEL = {
    within_city: "Within city", region_wide: "Region-wide", cross_region: "Cross-region",
  };

  let trucks = [];        // all loaded trucks
  let map = null;
  let markers = new Map();   // id -> Leaflet marker
  let userLoc = null;        // {lat,lng} once "Near me" used
  let userMarker = null;
  // Real road distances (OSRM table) keyed by truck id: km | null (no route).
  // Filled in batches after "Near me"; until then cards show direct distance.
  const roadKm = new Map();
  let enriching = false;
  let routeLayer = null;          // the currently drawn road route
  let sortMode = "nearest";       // nearest | cheapest | newest

  // DOM refs (filled in init)
  let listEl, mapEl, countEl, stageEl;
  let fType, fArea, fService, fCapacity, fSearch, areaList, nearBtn, sortSel;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function haversineKm(aLat, aLng, bLat, bLng) {
    const R = 6371, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
    const x = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function photoUrl(t) {
    const p = t.photo || (Array.isArray(t.photos) && t.photos[0]) || "";
    return p && window.DataStore ? window.DataStore.truckPhotoUrl(p) : "";
  }

  // "from TZS 80k / trip"
  function formatPrice(t) {
    const p = t.price_tzs || 0;
    let value;
    if (p >= 1_000_000) value = (p / 1_000_000).toFixed(p % 1_000_000 === 0 ? 0 : 1) + "M";
    else if (p >= 1_000) value = (p / 1_000).toFixed(0) + "k";
    else value = String(p);
    return { value, unit: `TZS / ${t.period || "trip"}` };
  }

  // ~24 km/h average city driving → honest "about N min" estimate for cards;
  // the EXACT minutes come from OSRM when the user draws the route.
  function driveMin(km) { return Math.max(1, Math.round((km / 24) * 60)); }
  function kmText(km) {
    if (km < 1) return Math.round(km * 1000) + " m";
    return (km < 10 ? km.toFixed(1) : String(Math.round(km))) + " km";
  }
  function distanceLabel(t) {
    if (Number.isFinite(t._roadKm)) return ` ${kmText(t._roadKm)} by road · ~${driveMin(t._roadKm)} min`;
    if (Number.isFinite(t._km)) return `${kmText(t._km)} direct`;
    return "";
  }

  // Batch-resolve REAL road km (one OSRM table call) for rows that still
  // show the straight-line number, then re-render with the exact figures.
  async function enrichRoadDistances(rows) {
    if (!userLoc || !window.pawaRoute || enriching) return;
    const missing = rows.filter((t) =>
      Number.isFinite(+t.lat) && Number.isFinite(+t.lng) && !roadKm.has(t.id)
    ).slice(0, 99);
    if (!missing.length) return;
    enriching = true;
    try {
      const kms = await window.pawaRoute.table(
        userLoc, missing.map((t) => ({ lat: +t.lat, lng: +t.lng })));
      missing.forEach((t, i) =>
        roadKm.set(t.id, Number.isFinite(kms[i]) ? kms[i] : null));
      render();   // swap "direct" badges for road km + minutes
    } catch (_) {
      missing.forEach((t) => roadKm.set(t.id, null));
    } finally {
      enriching = false;
    }
  }

  // Draw the actual driving route(s) to a truck on the map — the visible
  // proof of the distance. When OSRM knows MORE THAN ONE sensible road, every
  // option is drawn and the user taps the line they prefer: the chosen one
  // goes solid green with its exact km + minutes, the rest stay dashed.
  async function drawRouteTo(t) {
    if (!userLoc || !window.pawaRoute || !map) return;
    const dest = { lat: +t.lat, lng: +t.lng };
    if (!Number.isFinite(dest.lat) || !Number.isFinite(dest.lng)) return;
    switchView("map");
    setTimeout(() => map.invalidateSize(), 80);
    const r = await window.pawaRoute.route(userLoc, dest);
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    if (!r || !r.geojson) {
      // Live road routing is down — draw an honest dashed straight-line estimate
      // so the tap always produces a distance, then keep the marker popup open.
      const km = haversineKm(userLoc.lat, userLoc.lng, dest.lat, dest.lng);
      const geom = { type: "LineString", coordinates: [[userLoc.lng, userLoc.lat], [dest.lng, dest.lat]] };
      routeLayer = L.layerGroup().addTo(map);
      L.geoJSON(geom, { interactive: false, style: { color: "#fff", weight: 7, opacity: .9 } }).addTo(routeLayer);
      L.geoJSON(geom, { style: { color: "#b26a00", weight: 4, opacity: .9, dashArray: "4 8" } }).addTo(routeLayer);
      const mk = markers.get(t.id);
      if (mk) {
        mk.bindPopup(
          `<strong>${esc(t.title || "Moving truck")}</strong><br>≈ ${km.toFixed(1)} km straight-line` +
          `<br><small>Live road routing unavailable — the road is a bit longer.</small>`).openPopup();
      }
      return;
    }
    const options = [
      { km: r.km, durationMin: r.durationMin, geojson: r.geojson },
      ...(r.alts || []).filter((a) => a && a.geojson),
    ];
    roadKm.set(t.id, options[0].km);   // exact figure beats the table estimate
    render();                          // refresh badges first — render re-fits
                                       // to all markers, route zoom comes after
    routeLayer = L.layerGroup().addTo(map);
    const title = esc(t.title || "Moving truck");
    const lines = [];
    const styleFor = (chosen) => chosen
      ? { color: "#0a6f4d", weight: 6, opacity: .95, dashArray: null }
      : { color: "#5e8a79", weight: 4, opacity: .75, dashArray: "7 7" };
    const popupFor = (o, i) =>
      `<strong>${title}</strong><br>` +
      (options.length > 1 ? `Road option ${i + 1} of ${options.length}${o.via ? " —  via " + esc(o.via) : ""}<br>` : (o.via ? ` via ${esc(o.via)}<br>` : "")) +
      ` ${o.km.toFixed(1)} km by road · ${Math.round(o.durationMin)} min drive` +
      (options.length > 1 ? `<br><small>Tap another line to choose that road</small>` : "");
    const choose = (idx) => {
      lines.forEach((ln, i) => ln.setStyle(styleFor(i === idx)));
      lines[idx].bringToFront();
      roadKm.set(t.id, options[idx].km);          // the user's preferred road
      renderList(applyFilters());                  // update the card badge
    };                                             // (no marker re-fit — keep view)
    // White casing under every line first, so the coloured roads stay visible on
    // any basemap (the dark satellite tiles otherwise swallow the green lines).
    options.forEach((o) =>
      L.geoJSON(o.geojson, { interactive: false, style: { color: "#fff", weight: 9, opacity: .9 } }).addTo(routeLayer));
    options.forEach((o, i) => {
      const ln = L.geoJSON(o.geojson, { style: styleFor(i === 0) }).addTo(routeLayer);
      ln.bindPopup(popupFor(o, i));
      ln.on("click", () => choose(i));
      lines.push(ln);
    });
    lines[0].bringToFront();
    try {
      const all = L.featureGroup(lines);
      map.fitBounds(all.getBounds(), { padding: [46, 46] });
    } catch (_) {}
    lines[0].openPopup();
  }

  // ---- filtering -----------------------------------------------------------
  function applyFilters() {
    const type = fType.value;
    const area = fArea.value.trim().toLowerCase();
    const service = fService.value;
    const minCap = parseFloat(fCapacity.value) || 0;
    const q = fSearch.value.trim().toLowerCase();

    let out = trucks.filter((t) => {
      if (type && t.truck_type !== type) return false;
      if (service && t.service_area !== service) return false;
      if (minCap && !(parseFloat(t.capacity_tonnes) >= minCap)) return false;
      if (area && !([t.area, t.address, t.region, t.district, t.ward]
                    .some((v) => (v || "").toLowerCase().includes(area)))) return false;
      if (q) {
        const hay = `${t.title || ""} ${t.area || ""} ${t.region || ""} ${t.district || ""} ${t.ward || ""} ${t.address || ""} ${(t.owner && t.owner.name) || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    // When the user has located themselves, annotate with direct + road km.
    if (userLoc) {
      out = out.map((t) => {
        const has = Number.isFinite(+t.lat) && Number.isFinite(+t.lng);
        const direct = has ? haversineKm(userLoc.lat, userLoc.lng, +t.lat, +t.lng) : Infinity;
        const rk = has ? roadKm.get(t.id) : undefined;
        return { ...t, _km: direct, _roadKm: Number.isFinite(rk) ? rk : undefined };
      });
    }

    // Sort: road km when known, else direct km; cheapest; or newest.
    const sortKm = (t) => (Number.isFinite(t._roadKm) ? t._roadKm : (t._km ?? Infinity));
    if (sortMode === "cheapest") out.sort((a, b) => (+a.price_tzs || 1e15) - (+b.price_tzs || 1e15));
    else if (sortMode === "nearest" && userLoc) out.sort((a, b) => sortKm(a) - sortKm(b));
    // newest = the order DataStore returns (created_at desc)
    return out;
  }

  function render() {
    const rows = applyFilters();
    const enriched = userLoc && rows.some((t) => Number.isFinite(t._roadKm));
    countEl.textContent = rows.length
      ? `${rows.length} truck${rows.length === 1 ? "" : "s"}` +
        (userLoc && sortMode === "nearest"
          ? (enriched ? " — nearest first, by real road distance" : " — nearest first")
          : "")
      : "";
    renderList(rows);
    renderMarkers(rows);
    if (userLoc) enrichRoadDistances(rows);
  }

  function cardHtml(t) {
    const img = photoUrl(t);
    const price = formatPrice(t);
    const badges = [];
    const dist = distanceLabel(t);
    if (dist) badges.push(`<span class="tc-badge dist${Number.isFinite(t._roadKm) ? " road" : ""}">${esc(dist)}</span>`);
    if (t.verified) badges.push(`<span class="tc-badge verified"> Verified</span>`);
    const tags = [];
    tags.push(typeLabel(t.truck_type));
    if (t.capacity_tonnes) tags.push(`${t.capacity_tonnes}t`);
    if (t.driver_included) tags.push("Driver");
    if (t.loaders_included) tags.push("Loaders");
    tags.push(SERVICE_LABEL[t.service_area] || "");
    const loc = [t.area, t.region].filter(Boolean).join(", ");
    const photoStyle = img
      ? `background-image:url('${esc(img)}')`
      : "background:#dfe7e2;";
    // Quick actions: contact is the public owner jsonb shown on the page.
    const phone = (t.owner && (t.owner.phone || t.owner.whatsapp)) || t.phone || "";
    const wa = String((t.owner && (t.owner.whatsapp || t.owner.phone)) || "").replace(/[^\d]/g, "");
    const canRoute = userLoc && Number.isFinite(+t.lat) && Number.isFinite(+t.lng);
    const actions = [
      phone ? `<a class="tca-btn call" href="tel:${esc(phone)}"> Call</a>` : "",
      wa ? `<a class="tca-btn wa" href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : "",
      canRoute ? `<button class="tca-btn route" type="button" data-route="${esc(t.id)}" title="Draw the real road route on the map"> Route</button>` : "",
    ].filter(Boolean).join("");
    return `
      <div class="truck-card">
        <a class="truck-card-link" href="truck.html?id=${encodeURIComponent(t.id)}">
          <div class="truck-card-photo" style="${photoStyle}">
            ${img ? "" : `<div style="display:flex;height:100%;align-items:center;justify-content:center;font-size:2.4rem;"></div>`}
            <div class="truck-card-badges">${badges.join("")}</div>
          </div>
          <div class="truck-card-body">
            <div class="truck-card-price">from ${price.value} <small>${esc(price.unit)}</small>${t.negotiable ? ' <small>· negotiable</small>' : ""}</div>
            <div class="truck-card-title">${esc(t.title || "Moving truck")}</div>
            <div class="truck-card-meta">${loc ? `<span> ${esc(loc)}</span>` : ""}</div>
            <div class="truck-card-tags">${tags.filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join("")}</div>
          </div>
        </a>
        ${actions ? `<div class="truck-card-actions">${actions}</div>` : ""}
      </div>`;
  }

  function renderList(rows) {
    listEl.removeAttribute("aria-busy");
    if (!rows.length) {
      listEl.innerHTML = `<div class="trucks-empty">No trucks match your filters yet. Try widening the area or coverage — or <a href="agent-trucks.html">list your own truck</a>.</div>`;
      return;
    }
    listEl.innerHTML = rows.map(cardHtml).join("");
  }

  // ---- map -----------------------------------------------------------------
  function initMap() {
    if (!window.L || !mapEl) return;
    map = L.map(mapEl, { scrollWheelZoom: true }).setView([-6.4, 35.0], 6); // Tanzania
    window.addSatelliteHybrid(map);
  }

  function renderMarkers(rows) {
    if (!map) return;
    markers.forEach((m) => map.removeLayer(m));
    markers.clear();
    const pts = [];
    rows.forEach((t) => {
      const lat = +t.lat, lng = +t.lng;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const price = formatPrice(t);
      const m = L.marker([lat, lng]).addTo(map);
      const dist = distanceLabel(t);
      const phone = (t.owner && (t.owner.phone || t.owner.whatsapp)) || t.phone || "";
      m.bindPopup(
        `<strong>${esc(t.title || "Moving truck")}</strong><br>` +
        `from ${price.value} ${esc(price.unit)}<br>` +
        (dist ? `${esc(dist)}<br>` : "") +
        (phone ? `<a href="tel:${esc(phone)}"> ${esc(phone)}</a><br>` : "") +
        `<a href="truck.html?id=${encodeURIComponent(t.id)}">View truck →</a>`
      );
      markers.set(t.id, m);
      pts.push([lat, lng]);
    });
    if (userLoc) pts.push([userLoc.lat, userLoc.lng]);
    if (pts.length) {
      try { map.fitBounds(pts, { padding: [40, 40], maxZoom: 13 }); } catch (_) {}
    }
  }

  // ---- "Near me" -----------------------------------------------------------
  async function locateMe() {
    const idle = nearBtn.innerHTML;
    nearBtn.disabled = true;
    nearBtn.querySelector("span").textContent = "Locating…";
    try {
      const fix = await window.pawaLocate.bestOrApprox({ targetAccuracy: 50, maxWaitMs: 12000 });
      userLoc = { lat: fix.lat, lng: fix.lng };
      sortMode = "nearest";
      if (sortSel) sortSel.value = "nearest";
      nearBtn.querySelector("span").textContent = fix.approximate ? "Approx. location" : "Sorted by distance";
      if (map) {
        if (userMarker) map.removeLayer(userMarker);
        userMarker = L.circleMarker([userLoc.lat, userLoc.lng], {
          radius: 8, color: "#0a6f4d", fillColor: "#0a6f4d", fillOpacity: .9, weight: 2,
        }).addTo(map).bindPopup("You are here");
      }
      render();
    } catch (e) {
      nearBtn.innerHTML = idle;
      alert((e && e.message) ? e.message : "Couldn't get your location. Check location permission and try again.");
    } finally {
      nearBtn.disabled = false;
    }
  }

  // ---- area suggestions ----------------------------------------------------
  function fillAreaDatalist() {
    // Suggest every admin level agents have registered: region, district, ward, area.
    const areas = Array.from(new Set(
      trucks.flatMap((t) => [t.region, t.district, t.ward, t.area]).filter(Boolean)
    )).sort();
    areaList.innerHTML = areas.map((a) => `<option value="${esc(a)}"></option>`).join("");
  }

  // ---- wiring --------------------------------------------------------------
  let debTimer = null;
  function debounced(fn) { clearTimeout(debTimer); debTimer = setTimeout(fn, 180); }

  async function init() {
    listEl = $("trucksList"); mapEl = $("trucksMap"); countEl = $("trucksCount"); stageEl = $("trucksStage");
    fType = $("filterType"); fArea = $("filterArea"); fService = $("filterService");
    fCapacity = $("filterCapacity"); fSearch = $("filterSearch"); areaList = $("filterAreaList");
    nearBtn = $("truckNearMeBtn"); sortSel = $("truckSort");

    initMap();

    // Filters
    [fType, fService, fCapacity].forEach((el) => el.addEventListener("change", render));
    [fArea, fSearch].forEach((el) => el.addEventListener("input", () => debounced(render)));
    nearBtn.addEventListener("click", locateMe);
    sortSel?.addEventListener("change", () => { sortMode = sortSel.value; render(); });

    // "Route" buttons live inside cards — one delegated handler.
    listEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-route]");
      if (!btn) return;
      e.preventDefault();
      const t = trucks.find((x) => String(x.id) === btn.dataset.route);
      if (t) drawRouteTo(t);
    });

    // Mobile list/map tabs
    $("tabList")?.addEventListener("click", () => switchView("list"));
    $("tabMap") ?.addEventListener("click", () => { switchView("map"); setTimeout(() => map && map.invalidateSize(), 60); });

    // Load data
    try {
      trucks = await window.DataStore.getTrucks();
    } catch (e) {
      console.warn("[trucks] load failed:", e);
      trucks = [];
    }
    fillAreaDatalist();
    render();
  }

  function switchView(view) {
    stageEl.dataset.view = view;
    $("tabList").classList.toggle("active", view === "list");
    $("tabMap").classList.toggle("active", view === "map");
  }

  window.initTrucksPage = init;
})();
