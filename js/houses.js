// ============================================================================
//  Houses directory — public browsing of property listings (House Booking TZ).
//
//  Stack:
//    - MapLibre + Esri World Imagery satellite + Carto Voyager labels
//      (same as meet.html so we don't reinvent the basemap layer cake).
//    - DataStore.getHouses() — Supabase if configured, otherwise
//      data/houses.json fallback.
//    - No auth required — anyone can browse, filter, see on the map,
//      and call/WhatsApp the listing agent.
// ============================================================================

window.initHousesPage = async () => {
  // Tanzania bounds — keep users from panning to Antarctica.
  const TZ_CENTER = [-6.369028, 34.888822];
  const TZ_BOUNDS = [[29.34, -11.75], [40.45, -0.99]];

  // ---- Element refs ------------------------------------------------------
  const listEl     = document.getElementById("housesList");
  const stage      = document.getElementById("housesStage");
  const countEl    = document.getElementById("housesCount");
  const fListing   = document.getElementById("filterListing");
  const fType      = document.getElementById("filterType");
  const fArea      = document.getElementById("filterArea");
  const fBeds      = document.getElementById("filterBeds");
  const fPrice     = document.getElementById("filterPrice");
  const fSearch    = document.getElementById("filterSearch");
  const nearBtn    = document.getElementById("houseNearMeBtn");
  const alertBtn   = document.getElementById("houseAlertBtn");
  const commuteBtn = document.getElementById("houseCommuteBtn");
  const alertBanner= document.getElementById("housesAlertBanner");
  const watchChips = document.getElementById("housesWatchChips");
  const placesChips= document.getElementById("housesPlacesChips");
  const tabList    = document.getElementById("tabList");
  const tabMap     = document.getElementById("tabMap");
  const ssForm     = document.getElementById("smartSearch");
  const ssInput    = document.getElementById("smartSearchInput");
  const ssChips    = document.getElementById("smartSearchChips");
  const ssExamples = document.getElementById("smartSearchExamples");

  // ---- State -------------------------------------------------------------
  let houses    = [];
  let visible   = [];
  let map       = null;
  let markers   = new Map();   // id -> marker
  let activeId  = null;
  let userLoc   = null;
  let smartCriteria = null;        // parsed natural-language query (or null)
  let matchScores   = new Map();   // house id -> match % (when smart search active)
  let landmarkLoc   = null;        // { lat, lng, name } anchor when a known place is searched
  let landmarkMarker= null;        // MapLibre marker for the landmark anchor
  let myPlaces      = [];          // [{id,label,kind,name,lat,lng,mode,maxMin}] — "match to my life"
  let commuteScores = new Map();   // house id -> { legs, total, pass } when myPlaces active

  // Transport modes + place kinds for "Match to my life" (declared up here so
  // setupMyPlaces(), which runs during init, is never in their dead zone).
  const MODES = {
    walk:     { label: "Walk",     icon: "🚶", kmh: 4.5 },
    bodaboda: { label: "Bodaboda", icon: "🏍️", kmh: 22 },
    bajaji:   { label: "Bajaji",   icon: "🛺", kmh: 18 },
    daladala: { label: "Daladala", icon: "🚌", kmh: 16 },
    car:      { label: "Car",      icon: "🚗", kmh: 26 }
  };
  const PLACE_KINDS = {
    work:   { icon: "🏢", label: "Workplace" },
    school: { icon: "🏫", label: "School" },
    family: { icon: "👪", label: "Family / friends" },
    fav:    { icon: "⭐", label: "Favourite spot" },
    custom: { icon: "📍", label: "Place" }
  };
  const ROAD_DETOUR = 1.3;         // straight-line km × this ≈ road km in a TZ city

  // ---- Load data ---------------------------------------------------------
  try {
    houses = await window.DataStore.getHouses();
  } catch (e) {
    listEl.innerHTML = `<div class="banner error">Couldn't load properties: ${e.message}</div>`;
    return;
  }

  // Populate the area filter from the data so it stays in sync.
  const areas = Array.from(new Set(houses.map(h => h.area).filter(Boolean))).sort();
  areas.forEach(a => {
    const opt = document.createElement("option");
    opt.value = a; opt.textContent = a;
    fArea.appendChild(opt);
  });

  // ---- Map setup ---------------------------------------------------------
  initMap();

  // ---- Filters & render --------------------------------------------------
  [fListing, fType, fArea, fBeds, fPrice].forEach(el => el?.addEventListener("change", apply));
  fSearch?.addEventListener("input", () => { clearTimeout(window._hf); window._hf = setTimeout(apply, 180); });

  apply();

  // ---- Smart natural-language search -------------------------------------
  setupSmartSearch();

  // ---- Geo-circle area alerts (Nominatim + GPS + draggable pin) ----------
  setupGeoAlerts();

  // ---- "Match to my life" — rank/filter by distance to the user's places -
  setupMyPlaces();

  // ---- Near-me -----------------------------------------------------------
  nearBtn?.addEventListener("click", () => {
    if (!navigator.geolocation) { alert("Geolocation isn't supported on this device."); return; }
    nearBtn.disabled = true; nearBtn.textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        nearBtn.disabled = false;
        nearBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg> Sorted by distance`;
        if (map && !landmarkLoc) map.easeTo({ center: [userLoc.lng, userLoc.lat], zoom: 12 });
        updateLandmarkInfo();   // now we can show "your home is X km from <place>"
        apply();   // resort by proximity
      },
      (err) => {
        nearBtn.disabled = false;
        nearBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg> Near me`;
        alert("Couldn't get your location: " + err.message);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // ====================================================================
  //  Geo-circle area alerts
  //  A user can save any number of "watched areas". Each one is a point
  //  on the map + a radius in metres. A new listing fires an alert when
  //    haversine(listing, alert.center) <= alert.radius_m
  //  …which is way smarter than the old exact-string match (catches
  //  listings labelled "Mikocheni B" vs "Mikocheni" vs nameless infill).
  //
  //  Picking the area uses three input modes inside one modal:
  //    1. Search a place name (Nominatim — OSM, free, TZ-filtered)
  //    2. Drop a pin by tapping the map (street labels visible at z≥11)
  //    3. Tap "📍 GPS" to drop the pin at the user's current location
  //  Radius is a slider, 250 m → 10 km. Save persists to localStorage.
  // ====================================================================
  function getGeoAlerts() {
    try { return JSON.parse(localStorage.getItem("pawa_house_geo_alerts") || "[]"); }
    catch { return []; }
  }
  function saveGeoAlerts(arr) {
    localStorage.setItem("pawa_house_geo_alerts", JSON.stringify(arr));
  }
  function getSeenIds() {
    try { return new Set(JSON.parse(localStorage.getItem("pawa_house_seen_ids") || "[]")); }
    catch { return new Set(); }
  }
  function saveSeenIds(set) {
    const arr = [...set].slice(-500);
    localStorage.setItem("pawa_house_seen_ids", JSON.stringify(arr));
  }

  function setupGeoAlerts() {
    renderWatchChips();
    alertBtn?.addEventListener("click", () => openAlertModal());

    // Diff current listings against the "seen" set and fire alerts for
    // anything new that falls inside any watched circle.
    runNewListingDiff(houses);

    // Live realtime — fires instantly while page is open.
    setupRealtimeAlerts();
  }

  function renderWatchChips() {
    const alerts = getGeoAlerts();
    if (!alerts.length) { watchChips.hidden = true; watchChips.innerHTML = ""; return; }
    watchChips.hidden = false;
    watchChips.innerHTML = `<span style="font-size:.8rem;font-weight:600;color:var(--c-text-muted,#6b6960);align-self:center;margin-right:4px">Watching:</span>` +
      alerts.map(a => `
        <span class="houses-watch-chip">
          🔔 ${esc(a.name)} <small>${formatRadius(a.radius_m)}</small>
          <button type="button" data-id="${esc(a.id)}" aria-label="Stop alerts for ${esc(a.name)}" title="Stop alerts">&times;</button>
        </span>
      `).join("");
    watchChips.querySelectorAll("button[data-id]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const a = alerts.find(x => x.id === id);
        if (!a) return;
        if (!confirm(`Stop alerts for "${a.name}"?`)) return;
        saveGeoAlerts(alerts.filter(x => x.id !== id));
        renderWatchChips();
      });
    });
  }

  function formatRadius(m) {
    return m >= 1000 ? (m/1000).toFixed(m % 1000 === 0 ? 0 : 1) + " km" : m + " m";
  }

  function runNewListingDiff(currentList) {
    const alerts = getGeoAlerts();
    if (!alerts.length) {
      const seen = getSeenIds();
      currentList.forEach(h => seen.add(h.id));
      saveSeenIds(seen);
      return;
    }
    const seen = getSeenIds();
    const matches = [];
    for (const h of currentList) {
      if (seen.has(h.id)) continue;
      if (h.lat == null || h.lng == null) continue;
      for (const a of alerts) {
        const d = haversineKm(h.lat, h.lng, a.lat, a.lng) * 1000;  // metres
        if (d <= a.radius_m) {
          matches.push({ h, alert: a, dist_m: Math.round(d) });
          break;
        }
      }
    }
    if (matches.length) announceNewListings(matches);
    currentList.forEach(h => seen.add(h.id));
    saveSeenIds(seen);
  }

  function announceNewListings(matches) {
    if (!matches.length) return;
    // matches: [{h, alert, dist_m}]
    const first = matches[0];
    const more  = matches.length - 1;
    const title = matches.length === 1
      ? `New property near ${first.alert.name}`
      : `${matches.length} new properties matched your alerts`;
    const subtitle = matches.length === 1
      ? `${first.h.title} · ${first.dist_m < 1000 ? first.dist_m + " m" : (first.dist_m/1000).toFixed(1) + " km"} from your pin`
      : `${first.h.title}${more ? ` + ${more} more` : ""}`;
    const rows = matches.map(m => m.h);

    // In-page banner
    alertBanner.innerHTML = `
      <span class="ab-icon">🔔</span>
      <div class="ab-body">
        <strong>${esc(title)}</strong>
        <small>${esc(subtitle)}</small>
      </div>
      <button id="ahBannerView" type="button">View</button>
      <button id="ahBannerDismiss" type="button" aria-label="Dismiss" style="background:transparent;padding:6px 8px">✕</button>
    `;
    alertBanner.hidden = false;
    document.getElementById("ahBannerView")?.addEventListener("click", () => {
      if (rows.length === 1) location.href = `house.html?id=${encodeURIComponent(first.h.id)}`;
      else {
        const card = listEl.querySelector(`.house-card[data-id="${first.h.id}"]`);
        card?.scrollIntoView({ behavior: "smooth", block: "center" });
        alertBanner.hidden = true;
      }
    });
    document.getElementById("ahBannerDismiss")?.addEventListener("click", () => {
      alertBanner.hidden = true;
    });

    // OS notification (only if permission granted)
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        const n = new Notification("Pawa Houses — " + title, {
          body: subtitle,
          icon: "icons/icon-maskable.svg",
          badge: "icons/icon-maskable.svg",
          tag: "pawa-house-alert",
          renotify: true
        });
        n.onclick = () => {
          window.focus();
          if (rows.length === 1) location.href = `house.html?id=${encodeURIComponent(first.h.id)}`;
          n.close();
        };
      } catch (_) { /* some browsers block direct Notification on insecure origins */ }
    }
  }

  function flashBanner(icon, title, body) {
    alertBanner.innerHTML = `
      <span class="ab-icon">${icon}</span>
      <div class="ab-body">
        <strong>${esc(title)}</strong>
        <small>${esc(body)}</small>
      </div>
      <button id="ahBannerDismiss" type="button" aria-label="Dismiss" style="background:transparent;padding:6px 8px">✕</button>`;
    alertBanner.hidden = false;
    document.getElementById("ahBannerDismiss")?.addEventListener("click", () => alertBanner.hidden = true);
    setTimeout(() => { alertBanner.hidden = true; }, 6000);
  }

  function setupRealtimeAlerts() {
    const sb = window.DataStore?.sb;
    if (!sb) return;
    try {
      const ch = sb.channel("pawa-houses-alerts");
      ch.on("postgres_changes",
        { event: "INSERT", schema: "public", table: "houses" },
        (payload) => {
          const row = payload?.new;
          if (!row || row.lat == null || row.lng == null) return;
          const alerts = getGeoAlerts();
          const hit = alerts.find(a =>
            haversineKm(row.lat, row.lng, a.lat, a.lng) * 1000 <= a.radius_m);
          if (!hit) return;
          if (!houses.find(h => h.id === row.id)) {
            houses.unshift(row);
            apply();
          }
          const d_m = Math.round(haversineKm(row.lat, row.lng, hit.lat, hit.lng) * 1000);
          announceNewListings([{ h: row, alert: hit, dist_m: d_m }]);
        }
      );
      ch.subscribe();
    } catch (e) { /* table missing or RLS blocks — no-op */ }
  }

  // ====================================================================
  //  Alert modal — search, GPS, drop pin, radius, save
  // ====================================================================
  let alertModalMap    = null;   // Leaflet map instance
  let alertPinMarker   = null;   // Leaflet marker
  let alertRadiusCircle= null;   // Leaflet circle layer
  let alertPicked      = null;   // { lat, lng, displayName }

  function openAlertModal() {
    const backdrop = document.getElementById("alertModalBackdrop");
    const closeBtn = document.getElementById("alertCloseBtn");
    const cancelBtn= document.getElementById("alertCancelBtn");
    const saveBtn  = document.getElementById("alertSaveBtn");
    const searchIn = document.getElementById("alertSearchInput");
    const resultsEl= document.getElementById("alertSearchResults");
    const gpsBtn   = document.getElementById("alertGpsBtn");
    const radiusIn = document.getElementById("alertRadius");
    const radiusLbl= document.getElementById("alertRadiusLabel");
    const nameIn   = document.getElementById("alertName");
    const coordsEl = document.getElementById("alertCoords");

    backdrop.hidden = false;
    alertPicked = null;
    searchIn.value = "";
    resultsEl.hidden = true;
    resultsEl.innerHTML = "";
    nameIn.value = "";
    radiusIn.value = 1500;
    radiusLbl.textContent = "1.5 km";
    coordsEl.textContent = "Pin not placed yet — search or tap the map";
    coordsEl.classList.remove("has-pin");
    saveBtn.disabled = true;

    // Leaflet (Canvas2D) has no WebGL context limits and no transform-
    // timing issues — a simple 120 ms delay is enough for the modal to
    // finish its CSS slide-in before invalidateSize() is called.
    let isOpen = true;
    const initTimer = setTimeout(() => {
      if (!isOpen) return;
      initAlertMap();
      if (alertModalMap) alertModalMap.invalidateSize();
    }, 120);

    const close = () => {
      isOpen = false;
      clearTimeout(initTimer);
      backdrop.hidden = true;
      if (alertRadiusCircle) { alertRadiusCircle.remove(); alertRadiusCircle = null; }
      if (alertPinMarker)    { alertPinMarker.remove();    alertPinMarker    = null; }
      if (alertModalMap)     { alertModalMap.remove();     alertModalMap     = null; }
      alertPicked = null;
    };
    closeBtn.onclick = close;
    cancelBtn.onclick = close;
    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

    // Radius slider — update label, redraw circle, refresh coords text
    radiusIn.oninput = () => {
      const m = +radiusIn.value;
      radiusLbl.textContent = formatRadius(m);
      updateCoords();
      drawRadiusCircle();
    };

    // GPS button
    gpsBtn.onclick = () => {
      if (!navigator.geolocation) { alert("Geolocation isn't supported."); return; }
      gpsBtn.disabled = true; gpsBtn.textContent = "📍 Locating…";
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setPin(pos.coords.latitude, pos.coords.longitude, "My current location");
          gpsBtn.disabled = false; gpsBtn.textContent = "📍 GPS";
        },
        (err) => {
          gpsBtn.disabled = false; gpsBtn.textContent = "📍 GPS";
          alert("Couldn't get GPS: " + err.message);
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    };

    // Nominatim search (debounced 350 ms)
    let searchTimer;
    searchIn.oninput = () => {
      clearTimeout(searchTimer);
      const q = searchIn.value.trim();
      if (q.length < 2) { resultsEl.hidden = true; return; }
      searchTimer = setTimeout(() => doSearch(q), 350);
    };
    async function doSearch(q) {
      resultsEl.hidden = false;
      resultsEl.innerHTML = `<div class="am-search-result loading">Searching…</div>`;
      // Known places (universities, hospitals, malls, airports…) resolve
      // instantly from the gazetteer and float to the top of the results, so
      // "UDSM" or "Mlimani City" drops the pin exactly on the spot.
      const combined = [];
      const known = window.resolveTzPlace && window.resolveTzPlace(q);
      if (known) combined.push({ display_name: known.name, lat: known.lat, lon: known.lng, _known: true });
      const short2 = (it) => (it.display_name || "").split(",").slice(0, 2).join(", ");
      try {
        const list = await pawaGeo.search(`format=json&limit=6&countrycodes=tz&addressdetails=1&q=${encodeURIComponent(q)}`);
        for (const it of list) {
          if (combined.some(c => short2(c) === short2(it))) continue;
          combined.push(it);
        }
      } catch (e) {
        if (!combined.length) { resultsEl.innerHTML = `<div class="am-search-result loading">Search failed: ${esc(e.message)}</div>`; return; }
      }
      if (!combined.length) { resultsEl.innerHTML = `<div class="am-search-result loading">No matches in Tanzania.</div>`; return; }
      resultsEl.innerHTML = combined.map((it, i) => {
        const rest = (it.display_name || "").split(",").slice(2).join(", ");
        return `<div class="am-search-result" data-i="${i}">
          <strong>${esc(short2(it))}${it._known ? " · known place" : ""}</strong>
          ${rest ? `<small>${esc(rest)}</small>` : ""}
        </div>`;
      }).join("");
      resultsEl.querySelectorAll(".am-search-result").forEach(div => {
        div.addEventListener("click", () => {
          const it = combined[+div.dataset.i];
          if (!it) return;
          setPin(+it.lat, +it.lon, short2(it));
          resultsEl.hidden = true;
          searchIn.value = (it.display_name || "").split(",")[0];
        });
      });
    }

    // Save
    saveBtn.onclick = async () => {
      if (!alertPicked) return;
      if ("Notification" in window && Notification.permission === "default") {
        try { await Notification.requestPermission(); } catch (_) {}
      }
      const alerts = getGeoAlerts();
      const newAlert = {
        id: "ga-" + Date.now().toString(36),
        name: (nameIn.value.trim() || alertPicked.displayName || "Watched area").slice(0, 60),
        lat: alertPicked.lat,
        lng: alertPicked.lng,
        radius_m: +radiusIn.value,
        createdAt: new Date().toISOString()
      };
      alerts.push(newAlert);
      saveGeoAlerts(alerts);
      const seen = getSeenIds();
      houses.forEach(h => seen.add(h.id));
      saveSeenIds(seen);
      renderWatchChips();
      flashBanner("🔔", `Alert saved: ${newAlert.name}`,
        `We'll notify you when a new listing appears within ${formatRadius(newAlert.radius_m)} of this spot.`);
      close();
    };

    // ---- setPin -------------------------------------------------------
    // Always update coords + enable Save immediately (map may still be
    // loading). The marker + circle are deferred to placePinOnMap which
    // is called once the map is ready.
    function setPin(lat, lng, displayName) {
      alertPicked = { lat, lng, displayName: displayName || "Selected location" };
      updateCoords();
      saveBtn.disabled = false;
      if (!nameIn.value && displayName) nameIn.value = displayName;
      if (!alertModalMap) return;  // map not yet init; initAlertMap's 'load' handler will render the pin
      placePinOnMap(lat, lng);
    }

    // ---- placePinOnMap (Leaflet) --------------------------------------
    function placePinOnMap(lat, lng) {
      if (!alertPinMarker) {
        alertPinMarker = L.marker([lat, lng], { draggable: true }).addTo(alertModalMap);
        alertPinMarker.on("dragend", () => {
          const ll = alertPinMarker.getLatLng();
          alertPicked = { ...alertPicked, lat: ll.lat, lng: ll.lng };
          updateCoords();
          drawRadiusCircle();
        });
      } else {
        alertPinMarker.setLatLng([lat, lng]);
      }
      alertModalMap.setView([lat, lng], Math.max(alertModalMap.getZoom(), 14));
      drawRadiusCircle();
    }

    function updateCoords() {
      if (!alertPicked) return;
      coordsEl.classList.add("has-pin");
      coordsEl.textContent = `📍 ${alertPicked.lat.toFixed(5)}, ${alertPicked.lng.toFixed(5)}  ·  radius ${formatRadius(+radiusIn.value)}`;
    }

    // ---- drawRadiusCircle (Leaflet L.circle) -------------------------
    function drawRadiusCircle() {
      if (!alertModalMap || !alertPicked) return;
      if (alertRadiusCircle) {
        alertRadiusCircle.setLatLng([alertPicked.lat, alertPicked.lng]);
        alertRadiusCircle.setRadius(+radiusIn.value);
      } else {
        alertRadiusCircle = L.circle([alertPicked.lat, alertPicked.lng], {
          radius: +radiusIn.value,
          color: "#0a6f4d",
          fillColor: "#0a6f4d",
          fillOpacity: 0.18,
          weight: 2,
          dashArray: "6 4"
        }).addTo(alertModalMap);
      }
    }

    // ---- initAlertMap (Leaflet — Canvas2D, no WebGL) -----------------
    function initAlertMap() {
      if (alertModalMap) { alertModalMap.invalidateSize(); return; }
      try {
        alertModalMap = L.map("alertModalMap", {
          center: [-6.7924, 39.2789],
          zoom: 11,
          maxBounds: [[-11.75, 29.34], [-0.99, 40.45]],
          zoomControl: false
        });
        // Satellite imagery base layer
        L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          { attribution: "Tiles © Esri", maxZoom: 19 }
        ).addTo(alertModalMap);
        // Road + place-name labels overlay (shows streets clearly)
        L.tileLayer(
          "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png",
          { attribution: "© CARTO", maxZoom: 19, opacity: 0.9, subdomains: "abcd" }
        ).addTo(alertModalMap);
        L.control.zoom({ position: "topright" }).addTo(alertModalMap);
        alertModalMap.on("click", (e) => setPin(e.latlng.lat, e.latlng.lng, null));
        // Force layout recalc after Leaflet renders its tiles
        alertModalMap.whenReady(() => alertModalMap.invalidateSize());
        // If GPS / search already fired before map was ready, place the pin
        if (alertPicked) placePinOnMap(alertPicked.lat, alertPicked.lng);
      } catch (err) {
        const mapEl = document.getElementById("alertModalMap");
        if (mapEl) mapEl.innerHTML =
          `<div style="padding:20px;color:#b91c1c;font-size:.85rem">Map error: ${esc(String(err))}</div>`;
      }
    }
  }

  // Generate a 64-sided polygon approximating a geographic circle of
  // `radius_m` metres around (lat, lng). Used to render the alert area
  // on the modal map and (later) to do server-side ST_DWithin queries.
  function circlePolygon(lat, lng, radius_m, sides = 64) {
    const R = 6378137;
    const coords = [];
    for (let i = 0; i <= sides; i++) {
      const t = (i / sides) * 2 * Math.PI;
      const dx = radius_m * Math.cos(t);
      const dy = radius_m * Math.sin(t);
      const dLat = (dy / R) * (180 / Math.PI);
      const dLng = (dx / R) * (180 / Math.PI) / Math.cos(lat * Math.PI / 180);
      coords.push([lng + dLng, lat + dLat]);
    }
    return { type: "Polygon", coordinates: [coords] };
  }

  // ---- Mobile tab switcher -----------------------------------------------
  tabList?.addEventListener("click", () => switchView("list"));
  tabMap ?.addEventListener("click", () => switchView("map"));
  function switchView(v) {
    stage.dataset.view = v;
    tabList.classList.toggle("active", v === "list");
    tabMap .classList.toggle("active", v === "map");
    if (v === "map" && map) setTimeout(() => { try { map.resize(); } catch (_) {} }, 100);
  }

  // ====================================================================
  //  Smart search — parse a plain-language query into structured criteria,
  //  reflect it into the dropdown filters, then rank results by match score.
  // ====================================================================
  const AMENITY_SYNONYMS = {
    parking:                ["parking", "garage", "car park"],
    security:               ["security", "guard", "gated", "24h", "24 hour"],
    water_tank:             ["water tank", "water storage"],
    borehole:               ["borehole", "well", "kisima"],
    generator:              ["generator", "backup power", "genset", "standby power"],
    wifi:                   ["wifi", "wi-fi", "internet", "fibre", "fiber"],
    pool:                   ["pool", "swimming"],
    gym:                    ["gym", "fitness"],
    garden:                 ["garden", "yard", "lawn"],
    elevator:               ["elevator", "lift"],
    water_connection:       ["water connection", "piped water", "city water", "maji"],
    electricity_connection: ["electricity", "power", "umeme"]
  };
  function amenityLabel(k) {
    return ({ parking:"Parking", security:"Security", water_tank:"Water tank",
      borehole:"Borehole", generator:"Generator", wifi:"Wi-Fi", pool:"Pool",
      gym:"Gym", garden:"Garden", elevator:"Elevator",
      water_connection:"Water", electricity_connection:"Electricity" })[k] || k;
  }
  function parseMoney(numStr, suffix) {
    let n = parseFloat(String(numStr).replace(/[,\s]/g, ""));
    if (!isFinite(n)) return null;
    const s = (suffix || "").toLowerCase();
    if (/^b/.test(s)) n *= 1e9;
    else if (/^m/.test(s)) n *= 1e6;
    else if (/^k/.test(s) || /thousand/.test(s)) n *= 1e3;
    return Math.round(n);
  }
  function shortTzs(p) {
    if (p >= 1e9) return (p/1e9).toFixed(p % 1e9 ? 1 : 0) + "B";
    if (p >= 1e6) return (p/1e6).toFixed(p % 1e6 ? 1 : 0) + "M";
    if (p >= 1e3) return (p/1e3).toFixed(0) + "k";
    return String(p);
  }

  function setupSmartSearch() {
    if (!ssForm) return;
    ssForm.addEventListener("submit", (e) => { e.preventDefault(); runSmartSearch(ssInput.value); });
    ssExamples?.querySelectorAll(".ss-ex").forEach(btn => {
      btn.addEventListener("click", () => { ssInput.value = btn.dataset.q; runSmartSearch(btn.dataset.q); });
    });
  }

  function runSmartSearch(text) {
    const q = (text || "").trim();
    if (!q) { clearSmartSearch(); return; }
    smartCriteria = parseSmartQuery(q);
    // Reflect confident structured criteria into the dropdowns so the user
    // sees exactly how we read their request (and can tweak it by hand).
    fListing.value = smartCriteria.listing || "";
    fType.value    = smartCriteria.type    || "";
    fArea.value = (smartCriteria.area && Array.from(fArea.options).some(o => o.value === smartCriteria.area))
      ? smartCriteria.area : "";
    if (smartCriteria.bedrooms) {
      const b = String(Math.min(4, smartCriteria.bedrooms));
      fBeds.value = Array.from(fBeds.options).some(o => o.value === b) ? b : "";
    } else fBeds.value = "";
    // The bucketed price <select> can't express an arbitrary budget, so leave
    // it on "any"; the numeric cap lives in smartCriteria and is applied below.
    fPrice.value = "";
    if (fSearch) fSearch.value = "";   // the little text box is now redundant
    renderSmartChips();
    apply();
    if (ssExamples) ssExamples.hidden = true;
    document.getElementById("housesStage")?.scrollIntoView({ behavior: "smooth", block: "start" });

    // Known-place anchoring (async): if the query names a university, hospital,
    // mall, airport, etc., drop a precise pin on it and rank listings by how
    // close they are to that place.
    maybeAnchorLandmark(q);
  }

  // ====================================================================
  //  Known-place anchoring
  //  Resolve a landmark from the query (gazetteer first for instant,
  //  reliable pins; OSM/Nominatim second to refine to the exact site),
  //  drop a distinct pin on the map, and switch ranking to "nearest to
  //  that place first". Distances use the haversine great-circle formula.
  // ====================================================================
  function extractPlacePhrase(raw) {
    const m = String(raw || "").match(/\b(?:near|nearby|close to|next to|around|beside|by|opposite|adjacent to|at)\s+(.+)$/i);
    return (m ? m[1] : raw || "").trim();
  }

  // Should we even try? Yes if the user wrote "near <x>", or typed a bare
  // place name (no property criteria parsed), or the gazetteer already
  // recognises a place inside the query.
  function shouldAnchor(q, c) {
    if (/\b(near|nearby|close to|next to|around|beside|opposite|adjacent to)\b/i.test(q)) return true;
    const bare = !c.listing && !c.type && c.bedrooms == null && c.bathrooms == null &&
                 c.priceMax == null && c.priceMin == null && !c.area &&
                 !(c.amenities || []).length && !(c.keywords || []).length;
    if (bare) return true;
    return !!(window.resolveTzPlace && window.resolveTzPlace(extractPlacePhrase(q)));
  }

  // Geocode a place phrase via Nominatim (TZ-only). Returns {lat,lng,name}
  // or null. Validated against Tanzania's bounding box so a stray match in
  // another country never anchors the map.
  async function geocodePlace(phrase) {
    const q = (phrase || "").trim();
    if (q.length < 3) return null;
    try {
      const list = await pawaGeo.search(`format=json&limit=1&countrycodes=tz&q=${encodeURIComponent(q)}`);
      const it = list && list[0];
      if (!it) return null;
      const lat = +it.lat, lng = +it.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      if (lat < -11.75 || lat > -0.99 || lng < 29.34 || lng > 40.45) return null;  // outside TZ
      return { lat, lng, name: (it.display_name || q).split(",").slice(0, 2).join(", ") };
    } catch (_) { return null; }
  }

  async function maybeAnchorLandmark(rawQuery) {
    const c = smartCriteria || {};
    if (!shouldAnchor(rawQuery, c)) { clearLandmark(); return; }

    const phrase = extractPlacePhrase(rawQuery);
    const local  = (window.resolveTzPlace && (window.resolveTzPlace(phrase) || window.resolveTzPlace(rawQuery))) || null;

    // Show the gazetteer pin immediately (fast, offline-safe) if we have one.
    if (local) setLandmark({ lat: local.lat, lng: local.lng, name: local.name });

    // Then refine to the precise OSM coordinates. Only accept the remote
    // result if it's within ~40 km of the gazetteer guess (sanity check),
    // or if we had no gazetteer guess at all.
    const remote = await geocodePlace(phrase);
    if (remote) {
      if (!local || distKm(local, remote) <= 40) {
        setLandmark({ lat: remote.lat, lng: remote.lng, name: local ? local.name : remote.name });
      }
    } else if (!local) {
      clearLandmark();
    }
  }

  function setLandmark(loc) {
    landmarkLoc = loc;
    ensureLandmarkStyles();
    if (map) {
      if (!landmarkMarker) {
        const el = document.createElement("div");
        el.className = "landmark-marker";
        el.innerHTML = `<span class="lm-pin">📍</span><span class="lm-label"></span>`;
        landmarkMarker = new maplibregl.Marker({ element: el, anchor: "bottom" })
          .setLngLat([loc.lng, loc.lat]).addTo(map);
      } else {
        landmarkMarker.setLngLat([loc.lng, loc.lat]);
      }
      landmarkMarker.getElement().querySelector(".lm-label").textContent = loc.name;
    }
    renderSmartChips();
    updateLandmarkInfo();
    apply();   // re-rank by distance to the landmark
  }

  function clearLandmark() {
    if (!landmarkLoc && !landmarkMarker) return;
    landmarkLoc = null;
    if (landmarkMarker) { landmarkMarker.remove(); landmarkMarker = null; }
    const info = document.getElementById("housesAlertBanner");
    if (info && info.dataset.kind === "landmark") info.hidden = true;
  }

  function landmarkShort(name) {
    return String(name || "").split(",")[0].trim();
  }

  function updateLandmarkInfo() {
    if (!landmarkLoc) return;
    const name = landmarkShort(landmarkLoc.name);
    const body = userLoc
      ? `Your location is ${distKm(userLoc, landmarkLoc).toFixed(1)} km from ${name} · listings below are sorted nearest-first`
      : `Tap “Near me” to measure how far ${name} is from where you live · listings below are sorted nearest-first`;
    alertBanner.innerHTML = `
      <span class="ab-icon">📍</span>
      <div class="ab-body">
        <strong>${esc(name)}</strong>
        <small>${esc(body)}</small>
      </div>
      <button id="lmBannerDismiss" type="button" aria-label="Dismiss" style="background:transparent;padding:6px 8px">✕</button>`;
    alertBanner.hidden = false;
    alertBanner.dataset.kind = "landmark";
    document.getElementById("lmBannerDismiss")?.addEventListener("click", () => { alertBanner.hidden = true; });
  }

  function ensureLandmarkStyles() {
    if (document.getElementById("lmMarkerStyles")) return;
    const s = document.createElement("style");
    s.id = "lmMarkerStyles";
    s.textContent = `
      .landmark-marker{display:flex;align-items:center;gap:4px;transform:translateY(2px);pointer-events:none}
      .landmark-marker .lm-pin{font-size:26px;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
      .landmark-marker .lm-label{background:#0a6f4d;color:#fff;font:600 11px/1.2 system-ui,sans-serif;
        padding:3px 7px;border-radius:999px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.3);max-width:160px;
        overflow:hidden;text-overflow:ellipsis}`;
    document.head.appendChild(s);
  }

  function clearSmartSearch() {
    smartCriteria = null;
    matchScores.clear();
    clearLandmark();
    if (ssInput) ssInput.value = "";
    if (ssChips) { ssChips.hidden = true; ssChips.innerHTML = ""; }
    if (ssExamples) ssExamples.hidden = false;
    [fListing, fType, fArea, fBeds, fPrice].forEach(el => { if (el) el.value = ""; });
    apply();
  }

  function renderSmartChips() {
    if (!ssChips || !smartCriteria) return;
    const c = smartCriteria, chips = [];
    if (landmarkLoc) chips.push(`📍 near ${landmarkShort(landmarkLoc.name)}`);
    if (c.listing)   chips.push(c.listing === "sale" ? "For sale" : "For rent");
    if (c.type)      chips.push(({ apartment:"Apartment", house:"House", plot:"Plot", office:"Office/shop" })[c.type]);
    if (c.bedrooms)  chips.push(`${c.bedrooms}+ bed`);
    if (c.bathrooms) chips.push(`${c.bathrooms}+ bath`);
    if (c.area)      chips.push(`📍 ${c.area}`);
    if (c.priceMax)  chips.push(`≤ ${shortTzs(c.priceMax)} TZS`);
    if (c.priceMin)  chips.push(`≥ ${shortTzs(c.priceMin)} TZS`);
    (c.amenities || []).forEach(a => chips.push(amenityLabel(a)));
    (c.keywords  || []).forEach(k => chips.push(`"${k}"`));
    ssChips.innerHTML =
      chips.filter(Boolean).map(t => `<span class="ss-chip">${esc(t)}</span>`).join("") +
      `<span class="ss-chip ss-chip-clear" id="ssClear">Clear ✕</span>`;
    ssChips.hidden = false;
    document.getElementById("ssClear")?.addEventListener("click", clearSmartSearch);
  }

  function parseSmartQuery(raw) {
    const text = " " + raw.toLowerCase().replace(/\s+/g, " ") + " ";
    const c = { listing:null, type:null, bedrooms:null, bathrooms:null,
                area:null, priceMax:null, priceMin:null, amenities:[], keywords:[] };

    if (/\b(for sale|to buy|buying|purchase|sale)\b/.test(text)) c.listing = "sale";
    else if (/\b(for rent|to rent|renting|rental|rent|lease)\b/.test(text)) c.listing = "rent";

    if (/\b(apartment|apartments|flat|condo)\b/.test(text)) c.type = "apartment";
    else if (/\b(house|villa|bungalow|home|nyumba)\b/.test(text)) c.type = "house";
    else if (/\b(plot|land|kiwanja|shamba)\b/.test(text)) c.type = "plot";
    else if (/\b(office|shop|commercial|retail|duka)\b/.test(text)) c.type = "office";

    let m = text.match(/(\d+)\s*(?:\+\s*)?(?:bed|bedroom|bedrooms|br|bdr|chumba|vyumba)\b/);
    if (m) c.bedrooms = parseInt(m[1], 10);
    if (/\bstudio\b/.test(text)) { c.type = c.type || "apartment"; if (c.bedrooms == null) c.bedrooms = 0; }
    m = text.match(/(\d+)\s*(?:bath|bathroom|bathrooms|ba)\b/);
    if (m) c.bathrooms = parseInt(m[1], 10);

    // Price — ceilings / floors with magnitude suffix or currency words.
    const MON = "([\\d][\\d.,]*)\\s*(b|bn|billion|m|mil|million|k|thousand)?";
    let pm;
    if ((pm = text.match(new RegExp("(?:under|below|max|up to|upto|less than|within|maximum of?)\\s*(?:tzs|tsh|sh)?\\s*" + MON))))
      c.priceMax = parseMoney(pm[1], pm[2]);
    if ((pm = text.match(new RegExp("(?:over|above|from|min|at least|minimum of?|starting at)\\s*(?:tzs|tsh|sh)?\\s*" + MON))))
      c.priceMin = parseMoney(pm[1], pm[2]);
    // No explicit ceiling/floor → treat the first magnitude-suffixed (or large)
    // figure as a budget cap. Guard against catching bedroom/bath integers.
    if (c.priceMax == null && c.priceMin == null) {
      const all = [...text.matchAll(new RegExp(MON, "g"))];
      for (const a of all) {
        const sfx = (a[2] || "").toLowerCase(), val = parseMoney(a[1], a[2]);
        if (val != null && (sfx || val >= 50000)) { c.priceMax = val; break; }
      }
    }

    // Area — match against the real area list from the data (longest wins).
    let bestArea = null;
    for (const a of areas) {
      if (a && text.includes(" " + a.toLowerCase())) {
        if (!bestArea || a.length > bestArea.length) bestArea = a;
      }
    }
    if (bestArea) c.area = bestArea;

    for (const [key, syns] of Object.entries(AMENITY_SYNONYMS)) {
      if (syns.some(s => text.includes(s))) c.amenities.push(key);
    }

    const KW = ["sea view", "ocean view", "beachfront", "modern", "spacious",
      "luxury", "quiet", "furnished", "unfurnished", "penthouse", "duplex",
      "ensuite", "balcony", "tarmac", "gated", "newly built"];
    for (const k of KW) if (text.includes(k) && !c.amenities.includes(k)) c.keywords.push(k);

    return c;
  }

  function scoreHouse(h, c) {
    let score = 0, max = 0;
    const has = (v) => v != null && v !== "";
    if (has(c.area)) {
      max += 30;
      const hay = `${h.area || ""} ${h.address || ""} ${h.region || ""}`.toLowerCase();
      if (hay.includes(c.area.toLowerCase())) score += 30;
    }
    if (has(c.type))     { max += 18; if (h.type === c.type) score += 18; }
    if (has(c.listing))  { max += 14; if (h.listing === c.listing) score += 14; }
    if (has(c.bedrooms)) { max += 20; const b = h.bedrooms || 0;
      if (b >= c.bedrooms) score += 20; else if (b === c.bedrooms - 1) score += 10; }
    if (has(c.bathrooms)){ max += 8;  if ((h.bathrooms || 0) >= c.bathrooms) score += 8; }
    if (has(c.priceMax)) { max += 25; const p = h.price_tzs || 0;
      if (p <= c.priceMax) score += (p <= c.priceMax * 0.85 ? 25 : 20);
      else if (p <= c.priceMax * 1.1) score += 8; }
    if (has(c.priceMin)) { max += 6;  if ((h.price_tzs || 0) >= c.priceMin) score += 6; }
    if (c.amenities?.length) {
      const am = (h.amenities || []).map(x => String(x).toLowerCase());
      for (const a of c.amenities) {
        max += 8;
        if (am.some(x => x.includes(a) || x.includes(amenityLabel(a).toLowerCase()))) score += 8;
      }
    }
    if (c.keywords?.length) {
      const hay = `${h.title || ""} ${h.description || ""} ${h.furnished || ""}`.toLowerCase();
      for (const k of c.keywords) { max += 5; if (hay.includes(k)) score += 5; }
    }
    return max ? Math.round((score / max) * 100) : 100;
  }

  // ====================================================================
  //  "Match to my life" — personalised distance / commute matching
  //
  //  The user lists the places that matter to them (workplace, a child's
  //  school, a favourite area). For every listing we estimate, per place:
  //    road_km  = haversine(listing, place) × DETOUR  (straight-line → road)
  //    minutes  = road_km / mode_speed × 60           (per transport mode)
  //  A listing is kept only if it satisfies every place's max-time limit
  //  (when one is set), and the list is ranked by the *total* estimated
  //  travel time across all places — i.e. the home that fits your life best
  //  sits at the top. Everything runs client-side (no routing API needed).
  //  (MODES / PLACE_KINDS / ROAD_DETOUR are declared near the top of the file.)
  // ====================================================================
  function getMyPlaces() {
    try { return JSON.parse(localStorage.getItem("pawa_house_my_places") || "[]"); }
    catch { return []; }
  }
  function saveMyPlaces(arr) {
    localStorage.setItem("pawa_house_my_places", JSON.stringify(arr));
  }
  function modeOf(m)  { return MODES[m] || MODES.car; }
  function kindOf(k)  { return PLACE_KINDS[k] || PLACE_KINDS.custom; }
  function roadKm(a, b) { return distKm(a, b) * ROAD_DETOUR; }
  function travelMin(km, mode) { return km / modeOf(mode).kmh * 60; }
  function fmtMin(min) {
    if (min < 1) return "<1 min";
    if (min < 60) return Math.round(min) + " min";
    const h = Math.floor(min / 60), mm = Math.round(min % 60);
    return mm ? `${h}h ${mm}m` : `${h}h`;
  }

  // Per-listing commute breakdown, or null when it can't be evaluated.
  function commuteFor(h) {
    if (!myPlaces.length || !Number.isFinite(h.lat) || !Number.isFinite(h.lng)) return null;
    const legs = myPlaces.map(p => {
      const km = roadKm(p, h);
      const min = travelMin(km, p.mode);
      return { place: p, km, min, ok: p.maxMin ? min <= p.maxMin : true };
    });
    return { legs, total: legs.reduce((s, l) => s + l.min, 0), pass: legs.every(l => l.ok) };
  }

  function setupMyPlaces() {
    myPlaces = getMyPlaces();
    commuteBtn?.addEventListener("click", openPlacesModal);
    renderPlacesChips();
  }

  function renderPlacesChips() {
    if (!placesChips) return;
    if (!myPlaces.length) { placesChips.hidden = true; placesChips.innerHTML = ""; return; }
    placesChips.hidden = false;
    placesChips.innerHTML =
      `<span style="font-size:.8rem;font-weight:600;color:var(--c-text-muted,#6b6960);align-self:center;margin-right:2px">Matching your life:</span>` +
      myPlaces.map(p => `
        <span class="hp-place-chip" title="${esc(p.name || "")}">
          ${kindOf(p.kind).icon} ${esc(p.label)} <small>${modeOf(p.mode).icon}${p.maxMin ? ` ≤${p.maxMin}m` : ""}</small>
          <button type="button" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.label)}">&times;</button>
        </span>`).join("") +
      `<span class="hp-place-chip clear" id="mpEditChip">Edit ✎</span>`;
    placesChips.querySelectorAll("button[data-id]").forEach(btn => {
      btn.addEventListener("click", () => {
        myPlaces = myPlaces.filter(x => x.id !== btn.dataset.id);
        saveMyPlaces(myPlaces);
        renderPlacesChips();
        apply();
      });
    });
    document.getElementById("mpEditChip")?.addEventListener("click", openPlacesModal);
  }

  // Classify an OSM/Nominatim result into a short human tag: an
  // administrative level (Region → District → Ward → Village → Area) or the
  // kind of community service (School, Hospital, Market, Bank, …).
  function resultTag(it) {
    const at = (it.addresstype || "").toLowerCase();
    const ADMIN = {
      state: "Region", region: "Region", county: "District", state_district: "District",
      municipality: "District", district: "District", city: "City", town: "Town",
      suburb: "Suburb", neighbourhood: "Area", quarter: "Area", residential: "Area",
      village: "Village", hamlet: "Village", ward: "Ward", administrative: "Area"
    };
    if (ADMIN[at]) return ADMIN[at];
    const cls = (it.class || "").toLowerCase(), type = (it.type || "").toLowerCase();
    const SERVICE = {
      school: "School", college: "College", university: "University", kindergarten: "School",
      hospital: "Hospital", clinic: "Clinic", doctors: "Clinic", pharmacy: "Pharmacy",
      marketplace: "Market", supermarket: "Supermarket", mall: "Mall", bank: "Bank", atm: "ATM",
      fuel: "Fuel", bus_station: "Bus station", taxi: "Taxi rank", ferry_terminal: "Ferry",
      place_of_worship: "Worship", police: "Police", fire_station: "Fire", post_office: "Post",
      restaurant: "Restaurant", cafe: "Cafe", hotel: "Hotel", stadium: "Stadium",
      airport: "Airport", aerodrome: "Airport"
    };
    if (SERVICE[type]) return SERVICE[type];
    if (["amenity", "shop", "leisure", "tourism", "office", "healthcare", "building"].includes(cls))
      return (type || cls).replace(/_/g, " ").replace(/\b\w/, c => c.toUpperCase());
    return "Place";
  }

  // Friendly "nearby area" name from a reverse-geocode address — used when
  // the exact spot isn't a named place (a map tap, drag or GPS fix).
  function placeAreaLabel(j) {
    const a = (j && j.address) || {};
    const near  = a.suburb || a.neighbourhood || a.quarter || a.village || a.hamlet ||
                  a.ward || a.residential || a.city_district;
    const wider = a.city || a.town || a.municipality || a.county || a.state_district || a.state;
    const parts = [...new Set([near, wider].filter(Boolean))].slice(0, 2);
    if (parts.length) return parts.join(", ");
    return (j && j.display_name || "").split(",").slice(0, 2).join(", ");
  }

  // Search: gazetteer first (instant, known landmarks), then OSM/Nominatim
  // for regions, districts, wards, villages, famous areas and services.
  async function searchPlaces(q) {
    const out = [];
    const known = window.resolveTzPlace && window.resolveTzPlace(q);
    if (known) out.push({ name: known.name, lat: known.lat, lng: known.lng, tag: "Known place", known: true });
    try {
      const list = await pawaGeo.search(`format=jsonv2&limit=8&countrycodes=tz&addressdetails=1&q=${encodeURIComponent(q)}`);
      for (const it of list) {
        const lat = +it.lat, lng = +it.lon;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const name = (it.display_name || "").split(",").slice(0, 2).join(", ");
        if (out.some(o => o.name === name)) continue;
        out.push({ name, full: it.display_name, lat, lng, tag: resultTag(it) });
      }
    } catch (_) { /* offline / rate-limited — gazetteer result still stands */ }
    return out.slice(0, 8);
  }

  // Reverse-geocode a tapped/dragged point into a nearby-area label.
  async function reverseName(lat, lng) {
    try {
      return placeAreaLabel(await pawaGeo.reverse(`format=jsonv2&zoom=16&addressdetails=1&lat=${lat}&lon=${lng}`));
    } catch (_) { return null; }
  }

  // Map-driven place picker. Each place is a row (kind / label / mode / max
  // time); a shared Leaflet map + search box write to whichever row is
  // selected. Pick by search (admin areas + services), by tapping the map,
  // by dragging a pin, or by GPS — unknown spots are reverse-geocoded to a
  // nearby-area name.
  function openPlacesModal() {
    const backdrop = document.getElementById("placesModalBackdrop");
    const listEl   = document.getElementById("mpList");
    const addBtn   = document.getElementById("mpAddBtn");
    const saveBtn  = document.getElementById("mpSaveBtn");
    const cancelBtn= document.getElementById("mpCancelBtn");
    const closeBtn = document.getElementById("mpCloseBtn");
    const clearBtn = document.getElementById("mpClearBtn");
    const searchIn = document.getElementById("mpSearchInput");
    const gpsBtn   = document.getElementById("mpGpsBtn");
    const resultsEl= document.getElementById("mpSearchResults");
    const coordsEl = document.getElementById("mpCoords");
    if (!backdrop) return;

    const blank = () => ({ id: "mp-" + Math.random().toString(36).slice(2, 8),
      kind: "work", label: "", name: "", lat: null, lng: null, mode: "daladala", maxMin: null });
    let draft = myPlaces.length ? myPlaces.map(p => ({ ...p })) : [blank()];
    let activeId = draft[0].id;
    let mpMap = null, mpMarkers = {};

    backdrop.hidden = false;
    if (searchIn) searchIn.value = "";
    if (resultsEl) { resultsEl.hidden = true; resultsEl.innerHTML = ""; }
    renderRows();
    updateCoords();

    let isOpen = true;
    const initTimer = setTimeout(() => { if (isOpen) initMap(); }, 130);

    function hasUsable()   { return draft.some(p => Number.isFinite(p.lat) && Number.isFinite(p.lng)); }
    function syncSave()    { saveBtn.disabled = !hasUsable(); }
    function activePlace() { return draft.find(p => p.id === activeId) || draft[0]; }

    function renderRows() {
      listEl.innerHTML = "";
      draft.forEach(p => listEl.appendChild(buildRow(p)));
      syncSave();
    }

    function buildRow(p) {
      const row = document.createElement("div");
      row.className = "mp-row" + (p.id === activeId ? " is-active" : "");
      row.innerHTML = `
        <div class="mp-row-top">
          <select class="mp-kind" aria-label="Kind of place">
            ${Object.entries(PLACE_KINDS).map(([k, v]) => `<option value="${k}"${p.kind === k ? " selected" : ""}>${v.icon} ${v.label}</option>`).join("")}
          </select>
          <input class="mp-label" type="text" maxlength="40" placeholder="Label (e.g. My office)" value="${esc(p.label)}" />
          <button class="mp-remove" type="button" title="Remove this place" aria-label="Remove">&times;</button>
        </div>
        <div class="mp-row-bottom">
          <label class="mp-mode-lbl">By
            <select class="mp-mode" aria-label="Transport mode">
              ${Object.entries(MODES).map(([k, v]) => `<option value="${k}"${p.mode === k ? " selected" : ""}>${v.icon} ${v.label}</option>`).join("")}
            </select>
          </label>
          <label class="mp-max-lbl">Max
            <select class="mp-max" aria-label="Maximum travel time">
              <option value="">any time</option>
              ${[10, 15, 20, 30, 45, 60, 90].map(m => `<option value="${m}"${+p.maxMin === m ? " selected" : ""}>${m} min</option>`).join("")}
            </select>
          </label>
          <span class="mp-status${p.lat != null ? " set" : ""}">${p.lat != null ? "📍 " + esc(p.name || "location set") : "tap map / search →"}</span>
        </div>`;

      const labelIn = row.querySelector(".mp-label");
      row.querySelector(".mp-kind").addEventListener("change", (e) => {
        p.kind = e.target.value;
        if (!labelIn.value.trim()) { labelIn.value = kindOf(p.kind).label; p.label = labelIn.value; }
        refreshMarker(p);
      });
      labelIn.addEventListener("input", () => { p.label = labelIn.value; });
      row.querySelector(".mp-mode").addEventListener("change", (e) => { p.mode = e.target.value; });
      row.querySelector(".mp-max").addEventListener("change", (e) => { p.maxMin = e.target.value ? +e.target.value : null; });
      row.querySelector(".mp-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        if (mpMarkers[p.id]) { mpMarkers[p.id].remove(); delete mpMarkers[p.id]; }
        draft = draft.filter(x => x !== p);
        if (!draft.length) draft.push(blank());
        if (activeId === p.id) activeId = draft[0].id;
        renderRows(); updateCoords();
      });
      // Selecting a row makes the search / GPS / map taps target it.
      row.addEventListener("click", (e) => {
        if (e.target.closest("select,input,button")) return;
        setActive(p.id);
      });
      return row;
    }

    function setActive(id) {
      activeId = id;
      const rows = listEl.querySelectorAll(".mp-row");
      draft.forEach((p, i) => { if (rows[i]) rows[i].classList.toggle("is-active", p.id === id); });
      const p = activePlace();
      if (mpMap && Number.isFinite(p.lat) && Number.isFinite(p.lng))
        mpMap.setView([p.lat, p.lng], Math.max(mpMap.getZoom(), 14));
      updateCoords();
    }

    function updateCoords() {
      if (!coordsEl) return;
      const p = activePlace(), k = kindOf(p.kind);
      coordsEl.textContent = Number.isFinite(p.lat)
        ? `${k.icon} ${p.label || k.label}: ${p.name || (p.lat.toFixed(4) + ", " + p.lng.toFixed(4))}`
        : `Setting ${k.icon} ${p.label || k.label} — search or tap the map`;
      coordsEl.classList.toggle("has-pin", Number.isFinite(p.lat));
    }

    // Write a location onto the active place, refresh its pin, and (when no
    // name is known) reverse-geocode the nearby area.
    async function setActiveLocation(lat, lng, name) {
      const p = activePlace();
      p.lat = lat; p.lng = lng;
      if (name) p.name = name;
      if (!p.label || !p.label.trim()) p.label = kindOf(p.kind).label;
      refreshMarker(p);
      renderRows(); setActive(p.id); syncSave();
      if (!name) {
        const near = await reverseName(lat, lng);
        if (near && p.lat === lat && p.lng === lng) { p.name = near; renderRows(); setActive(p.id); }
      }
    }

    function refreshMarker(p) {
      if (!mpMap) return;
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) {
        if (mpMarkers[p.id]) { mpMarkers[p.id].remove(); delete mpMarkers[p.id]; }
        return;
      }
      const icon = L.divIcon({ className: "mp-pin", html: kindOf(p.kind).icon, iconSize: [26, 26], iconAnchor: [13, 26] });
      if (mpMarkers[p.id]) {
        mpMarkers[p.id].setLatLng([p.lat, p.lng]).setIcon(icon);
      } else {
        const mk = L.marker([p.lat, p.lng], { draggable: true, icon }).addTo(mpMap);
        mk.on("dragend", () => { const ll = mk.getLatLng(); setActive(p.id); setActiveLocation(ll.lat, ll.lng, null); });
        mk.on("click", () => setActive(p.id));
        mpMarkers[p.id] = mk;
      }
    }

    function initMap() {
      if (mpMap) { mpMap.invalidateSize(); return; }
      try {
        mpMap = L.map("mpModalMap", { center: [-6.7924, 39.2789], zoom: 11,
          maxBounds: [[-11.75, 29.34], [-0.99, 40.45]], zoomControl: false });
        L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          { attribution: "Tiles © Esri", maxZoom: 19 }).addTo(mpMap);
        L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png",
          { attribution: "© CARTO", maxZoom: 19, opacity: 0.9, subdomains: "abcd" }).addTo(mpMap);
        L.control.zoom({ position: "topright" }).addTo(mpMap);
        mpMap.on("click", (e) => setActiveLocation(e.latlng.lat, e.latlng.lng, null));
        mpMap.whenReady(() => mpMap.invalidateSize());
        draft.forEach(refreshMarker);
        const first = draft.find(p => Number.isFinite(p.lat));
        if (first) mpMap.setView([first.lat, first.lng], 13);
      } catch (err) {
        const el = document.getElementById("mpModalMap");
        if (el) el.innerHTML = `<div style="padding:20px;color:#b91c1c;font-size:.85rem">Map error: ${esc(String(err))}</div>`;
      }
    }

    // ---- shared search box (admin areas + community services) ----
    let searchTimer;
    if (searchIn) searchIn.oninput = () => {
      clearTimeout(searchTimer);
      const q = searchIn.value.trim();
      if (q.length < 2) { resultsEl.hidden = true; return; }
      searchTimer = setTimeout(async () => {
        resultsEl.hidden = false;
        resultsEl.innerHTML = `<div class="am-search-result loading">Searching…</div>`;
        const hits = await searchPlaces(q);
        if (!hits.length) { resultsEl.innerHTML = `<div class="am-search-result loading">No matches — tap the map to drop a pin.</div>`; return; }
        resultsEl.innerHTML = hits.map((it, i) => {
          const rest = it.full ? it.full.split(",").slice(2, 4).join(",").trim() : "";
          return `<div class="am-search-result" data-i="${i}">
            <strong>${esc(it.name)}</strong> <span class="am-tag${it.known ? " known" : ""}">${esc(it.tag || "Place")}</span>
            ${rest ? `<small>${esc(rest)}</small>` : ""}
          </div>`;
        }).join("");
        resultsEl.querySelectorAll(".am-search-result[data-i]").forEach(div => {
          div.addEventListener("click", () => {
            const it = hits[+div.dataset.i];
            if (!it) return;
            setActiveLocation(it.lat, it.lng, it.name);
            if (mpMap) mpMap.setView([it.lat, it.lng], 15);
            resultsEl.hidden = true; searchIn.value = "";
          });
        });
      }, 320);
    };

    if (gpsBtn) gpsBtn.onclick = () => {
      if (!navigator.geolocation) { alert("Geolocation isn't supported."); return; }
      gpsBtn.disabled = true; gpsBtn.textContent = "📍 …";
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          gpsBtn.disabled = false; gpsBtn.textContent = "📍 GPS";
          setActiveLocation(pos.coords.latitude, pos.coords.longitude, null);
          if (mpMap) mpMap.setView([pos.coords.latitude, pos.coords.longitude], 15);
        },
        () => { gpsBtn.disabled = false; gpsBtn.textContent = "📍 GPS"; alert("Couldn't get your GPS location."); },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    };

    const close = () => {
      isOpen = false; clearTimeout(initTimer);
      backdrop.hidden = true; listEl.innerHTML = "";
      Object.values(mpMarkers).forEach(m => m.remove()); mpMarkers = {};
      if (mpMap) { mpMap.remove(); mpMap = null; }
    };
    addBtn.onclick    = () => { const b = blank(); draft.push(b); activeId = b.id; renderRows(); setActive(b.id); updateCoords(); };
    clearBtn.onclick  = () => { Object.values(mpMarkers).forEach(m => m.remove()); mpMarkers = {}; const b = blank(); draft = [b]; activeId = b.id; renderRows(); updateCoords(); };
    closeBtn.onclick  = close;
    cancelBtn.onclick = close;
    backdrop.onclick  = (e) => { if (e.target === backdrop) close(); };
    saveBtn.onclick = () => {
      myPlaces = draft
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))
        .map(p => ({ ...p, label: (p.label || "").trim() || kindOf(p.kind).label }));
      saveMyPlaces(myPlaces);
      renderPlacesChips();
      apply();
      close();
      document.getElementById("housesStage")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  }

  // ====================================================================
  //  Apply filters → re-render list and map markers
  // ====================================================================
  function apply() {
    const listing = fListing.value;
    const type    = fType.value;
    const area    = fArea.value;
    const beds    = parseInt(fBeds.value || "0", 10);
    const price   = fPrice.value;
    const q       = fSearch.value.toLowerCase().trim();

    visible = houses.filter(h => {
      if (listing && h.listing !== listing) return false;
      if (type    && h.type    !== type)    return false;
      if (area    && h.area    !== area)    return false;
      if (beds    && (h.bedrooms || 0) < beds) return false;
      if (price) {
        const [pl, lo, hi] = price.split("_");
        if (h.listing !== pl) return false;
        const p = h.price_tzs || 0;
        if (lo && p < +lo) return false;
        if (hi && p > +hi) return false;
      }
      if (q) {
        // Extended haystack so typing "rent", "apartment", "3 bed", a price
        // figure, or an area name in the same search box all narrow the list.
        // Bedroom variants ("3 bed", "3br", "3 bedroom") let users phrase it
        // however they like. Price is included as a raw int so partial
        // matches work ("500000" hits anything between 500k and 5M).
        const hay = [
          h.title, h.area, h.address, h.region,
          h.listing, h.type,
          h.bedrooms ? `${h.bedrooms}bed ${h.bedrooms} bed ${h.bedrooms} bedroom ${h.bedrooms}br` : "",
          h.bathrooms ? `${h.bathrooms} bath` : "",
          h.price_tzs ? String(h.price_tzs) : ""
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    // Smart search: apply the numeric budget cap (the bucketed <select> can't)
    // and score every remaining listing for the "% match" badge.
    if (smartCriteria) {
      if (smartCriteria.priceMax)
        visible = visible.filter(h => (h.price_tzs || 0) <= smartCriteria.priceMax * 1.1);
      if (smartCriteria.priceMin)
        visible = visible.filter(h => (h.price_tzs || 0) >= smartCriteria.priceMin * 0.9);
      matchScores.clear();
      visible.forEach(h => matchScores.set(h.id, scoreHouse(h, smartCriteria)));
    } else {
      matchScores.clear();
    }

    // "Match to my life": annotate every listing with its commute breakdown,
    // and drop any that bust a per-place max-time limit (homes without map
    // coordinates can't be evaluated, so they're kept rather than hidden).
    commuteScores.clear();
    if (myPlaces.length) {
      visible = visible.filter(h => {
        const c = commuteFor(h);
        if (c) commuteScores.set(h.id, c);
        return !c || c.pass;
      });
    }

    // Ranking precedence:
    //   1. distance to the searched place (when a landmark is anchored),
    //   2. total estimated travel time to the user's places,
    //   3. smart-search match score,
    //   4. distance from the user ("Near me").
    if (landmarkLoc) {
      visible.sort((a, b) => distToLandmark(a) - distToLandmark(b));
    } else if (myPlaces.length) {
      const tot = id => (commuteScores.get(id) ? commuteScores.get(id).total : Infinity);
      visible.sort((a, b) => tot(a.id) - tot(b.id));
    } else if (smartCriteria) {
      visible.sort((a, b) => (matchScores.get(b.id) || 0) - (matchScores.get(a.id) || 0));
    } else if (userLoc) {
      visible.sort((a, b) => distKm(userLoc, a) - distKm(userLoc, b));
    }

    renderList();
    renderMarkers();
  }

  // ====================================================================
  //  List rendering
  // ====================================================================
  function renderList() {
    countEl.textContent = visible.length
      ? `${visible.length} ${visible.length === 1 ? "property" : "properties"}`
      : "";

    // a11y: skeleton is gone — clear busy state and announce result count.
    listEl.setAttribute("aria-busy", "false");
    const liveEl = document.getElementById("housesAnnounce");
    if (liveEl) {
      liveEl.textContent = visible.length
        ? `${visible.length} ${visible.length === 1 ? "property" : "properties"} found`
        : "No properties match your filters";
    }
    updateBentoCounts();

    if (!visible.length) {
      // Build a human-readable description of what was searched so the
      // "not found" message is specific rather than a generic fallback.
      const c = smartCriteria;
      const textQ = fSearch?.value.trim();
      let notFoundTitle = "No properties match";
      let notFoundSub   = "Widen your filters, clear the search box, or browse all listings.";
      if (c || textQ) {
        const parts = [];
        if (textQ) parts.push(`"${textQ}"`);
        if (c) {
          if (c.bedrooms != null) parts.push(`${c.bedrooms} bedroom${c.bedrooms !== 1 ? "s" : ""}`);
          if (c.type)    parts.push(({ apartment:"apartment", house:"house", plot:"plot", office:"office/shop" })[c.type] || c.type);
          if (c.listing) parts.push(c.listing === "sale" ? "for sale" : "for rent");
          if (c.area)    parts.push(`in ${c.area}`);
          if (c.priceMax) parts.push(`under ${shortTzs(c.priceMax)} TZS`);
        }
        const desc = parts.length ? parts.join(", ") : (ssInput?.value.trim() || "");
        notFoundTitle = desc
          ? `No property found: ${esc(desc)}`
          : "No matching property found";
        notFoundSub = "Such a property does not exist in our current listings. Try different criteria or clear the search to browse all available properties.";
      }
      listEl.innerHTML = `<div class="hp-empty" role="status">
        <div class="hp-empty__art" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>
          </svg>
        </div>
        <div class="hp-empty__title">${notFoundTitle}</div>
        <div class="hp-empty__sub">${notFoundSub}</div>
        <button class="hp-empty__cta" type="button" id="hpClearFilters">Clear all filters</button>
      </div>`;
      const clearBtn = document.getElementById("hpClearFilters");
      clearBtn?.addEventListener("click", () => {
        [fListing, fType, fArea, fBeds, fPrice].forEach(el => { if (el) el.value = ""; });
        if (fSearch) fSearch.value = "";
        apply();
      });
      return;
    }

    listEl.innerHTML = visible.map((h, i) => {
      const photo  = window.DataStore.housePhotoUrl(h.photo);
      const price  = formatPrice(h);
      const listing = h.listing === "sale" ? "For sale" : "For rent";
      const verified = h.verified ? `<span class="verified">✓ Verified</span>` : "";
      const meta = [
        h.bedrooms ? `<span>🛏 ${h.bedrooms} bed${h.bedrooms !== 1 ? "s" : ""}</span>` : "",
        h.bathrooms ? `<span>🛁 ${h.bathrooms} bath${h.bathrooms !== 1 ? "s" : ""}</span>` : "",
        h.size_sqm ? `<span>📐 ${h.size_sqm} m²</span>` : "",
        (h.listing === "rent" && Number(h.min_months) > 1) ? `<span>🗓 ${h.min_months} mo min</span>` : ""
      ].filter(Boolean).join("");
      const loc = `${esc(h.area || "—")}${h.region ? `, ${esc(h.region)}` : ""}`;
      const hasCoords = Number.isFinite(h.lat) && Number.isFinite(h.lng);
      const dist = (landmarkLoc && hasCoords)
        ? ` · ${distKm(landmarkLoc, h).toFixed(1)} km to ${esc(landmarkShort(landmarkLoc.name))}`
        : (userLoc && hasCoords)
          ? ` · ${distKm(userLoc, h).toFixed(1)} km away`
          : "";
      const ariaLabel = `${esc(h.title)}, ${price.value} ${price.unit}, ${loc}`;
      const matchPct = smartCriteria ? matchScores.get(h.id) : null;
      const matchCls = matchPct == null ? "" : matchPct >= 75 ? "" : matchPct >= 50 ? "mid" : "low";
      const matchBadge = matchPct == null ? ""
        : `<span class="house-card-match ${matchCls}">✨ ${matchPct}% match</span>`;
      const commute = commuteScores.get(h.id);
      const commuteHtml = commute ? `<div class="house-card-commute">${
        commute.legs.map(l => `<span class="hc-leg${l.ok ? "" : " over"}">${kindOf(l.place.kind).icon} ${esc(l.place.label)} · ${l.km.toFixed(1)} km · ~${fmtMin(l.min)} ${modeOf(l.place.mode).icon}</span>`).join("")
      }</div>` : "";
      return `
        <div class="house-card ${activeId === h.id ? "active" : ""}" data-id="${h.id}"
             role="button" tabindex="0" aria-label="${ariaLabel}">
          <div class="house-card-photo" data-loading="true" style="background-image:url('${photo}')">
            <span class="badge">${listing}</span>
            ${verified}
            ${matchBadge}
          </div>
          <div class="house-card-body">
            <div class="house-card-price">${price.value} <small>${price.unit}</small></div>
            <div class="house-card-title">${esc(h.title)}</div>
            <div class="house-card-meta">${meta}</div>
            <div class="house-card-loc">📍 ${loc}${dist}</div>
            ${commuteHtml}
            <a href="house.html?id=${encodeURIComponent(h.id)}"
               class="house-card-view" aria-label="View details for ${esc(h.title)}">View details →</a>
          </div>
        </div>`;
    }).join("");

    // Pre-load each card photo to drop the shimmer once the image is ready.
    listEl.querySelectorAll(".house-card-photo[data-loading]").forEach(el => {
      const match = el.getAttribute("style").match(/url\(['"]?([^'")]+)['"]?\)/);
      if (!match) { el.removeAttribute("data-loading"); return; }
      const img = new Image();
      img.decoding = "async";
      img.loading = "lazy";
      img.onload = img.onerror = () => el.removeAttribute("data-loading");
      img.src = match[1];
    });

    listEl.querySelectorAll(".house-card").forEach(card => {
      card.addEventListener("click", (e) => {
        // Don't hijack the "View details" link click.
        if (e.target.closest(".house-card-view")) return;
        focusHouse(card.dataset.id, { fromList: true });
      });
      card.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.target.closest(".house-card-view")) {
          e.preventDefault();
          focusHouse(card.dataset.id, { fromList: true });
        }
      });
    });
  }

  // ---- Bento overview tiles ---------------------------------------------
  function updateBentoCounts() {
    const total = houses.length;
    const rent = houses.filter(h => h.listing === "rent").length;
    const sale = houses.filter(h => h.listing === "sale").length;
    const verified = houses.filter(h => h.verified).length;
    let favs = 0;
    try { favs = JSON.parse(localStorage.getItem("pawa.houseFavs") || "[]").length; } catch {}
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("hpBentoTotal", total);
    set("hpBentoRent", rent);
    set("hpBentoSale", sale);
    set("hpBentoVerified", verified);
    set("hpBentoFavs", favs);
  }

  document.querySelectorAll(".hp-bento__cell[data-quickfilter]").forEach(cell => {
    cell.addEventListener("click", (e) => {
      e.preventDefault();
      const qf = cell.dataset.quickfilter;
      if (qf === "rent" || qf === "sale") {
        if (fListing) fListing.value = qf;
      } else if (qf === "verified") {
        if (fSearch) fSearch.value = "verified";
      } else {
        [fListing, fType, fArea, fBeds, fPrice].forEach(el => { if (el) el.value = ""; });
        if (fSearch) fSearch.value = "";
      }
      apply();
      document.getElementById("housesStage")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  // ---- Sticky filter bar on scroll --------------------------------------
  const toolbar = document.querySelector(".houses-toolbar");
  if (toolbar && "IntersectionObserver" in window) {
    const sentinel = document.createElement("div");
    sentinel.style.cssText = "height:1px;width:100%;";
    toolbar.parentNode.insertBefore(sentinel, toolbar);
    const obs = new IntersectionObserver(([entry]) => {
      toolbar.classList.toggle("is-sticky", !entry.isIntersecting);
    }, { rootMargin: "-1px 0px 0px 0px", threshold: 0 });
    obs.observe(sentinel);
  }

  // ====================================================================
  //  Map
  // ====================================================================
  function initMap() {
    map = new maplibregl.Map({
      container: "housesMap",
      style: {
        version: 8,
        sources: {
          esri: {
            type: "raster",
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256, maxzoom: 19,
            attribution: "Tiles © Esri"
          },
          esri_transport: {
            type: "raster",
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256, maxzoom: 19
          },
          carto_labels: {
            type: "raster",
            tiles: [
              "https://a.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
              "https://b.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
              "https://c.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
              "https://d.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png"
            ],
            tileSize: 256, maxzoom: 19,
            attribution: "© CARTO © OpenStreetMap contributors"
          }
        },
        layers: [
          { id: "esri",           type: "raster", source: "esri" },
          { id: "esri_transport", type: "raster", source: "esri_transport" },
          { id: "carto_labels",   type: "raster", source: "carto_labels", minzoom: 11 }
        ]
      },
      center: [39.2789, -6.7924],   // Dar es Salaam — most listings cluster here
      zoom: 11,
      maxBounds: TZ_BOUNDS,
      attributionControl: true
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  }

  function renderMarkers() {
    if (!map) return;
    // Only houses with real coordinates get pinned — otherwise the marker
    // lands at [0,0] in the Gulf of Guinea.
    const mappable = visible.filter(h => Number.isFinite(h.lat) && Number.isFinite(h.lng));
    const visibleIds = new Set(mappable.map(h => h.id));
    for (const [id, mk] of markers) {
      if (!visibleIds.has(id)) { mk.remove(); markers.delete(id); }
    }
    for (const h of mappable) {
      if (markers.has(h.id)) continue;
      const el = document.createElement("div");
      el.className = `house-marker type-${h.type || "house"}`;
      el.textContent = shortPrice(h);
      el.addEventListener("click", (e) => { e.stopPropagation(); focusHouse(h.id, { fromMap: true }); });
      const popup = new maplibregl.Popup({ offset: 14, closeButton: true, closeOnClick: true, maxWidth: "260px" })
        .setHTML(popupHtml(h));
      const mk = new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat([h.lng, h.lat])
        .setPopup(popup)
        .addTo(map);
      markers.set(h.id, mk);
    }
    fitToVisible(mappable);
  }

  function fitToVisible(mappable) {
    if (!map) return;
    // Include the landmark anchor in the viewport so the searched place and
    // the nearby listings are visible together.
    const pts = (mappable || []).map(h => [h.lng, h.lat]);
    if (landmarkLoc) pts.push([landmarkLoc.lng, landmarkLoc.lat]);
    if (!pts.length) return;
    if (pts.length === 1) {
      map.easeTo({ center: pts[0], zoom: Math.max(13, map.getZoom()), duration: 500 });
      return;
    }
    const lngs = pts.map(p => p[0]), lats = pts.map(p => p[1]);
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 60, maxZoom: 14, duration: 500 }
    );
  }

  function distToLandmark(h) {
    if (!landmarkLoc || !Number.isFinite(h.lat) || !Number.isFinite(h.lng)) return Infinity;
    return distKm(landmarkLoc, h);
  }

  function focusHouse(id, opts = {}) {
    activeId = id;
    const h = visible.find(x => x.id === id);
    if (!h) return;
    // Highlight card
    listEl.querySelectorAll(".house-card").forEach(c => c.classList.toggle("active", c.dataset.id === id));
    // Highlight + open marker
    markers.forEach((mk, mid) => mk.getElement().classList.toggle("active", mid === id));
    const mk = markers.get(id);
    if (mk) {
      map.easeTo({ center: [h.lng, h.lat], zoom: Math.max(13, map.getZoom()), duration: 350 });
      mk.togglePopup();
    }
    // On mobile, scroll the active card into view OR swap to map if user
    // tapped a pin while on the list tab.
    if (opts.fromList && window.matchMedia("(max-width: 900px)").matches) {
      switchView("map");
    } else if (opts.fromList) {
      const card = listEl.querySelector(`.house-card[data-id="${id}"]`);
      card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      // Coming from the map — pulse the card so it's easy to spot.
      const card = listEl.querySelector(`.house-card[data-id="${id}"]`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "nearest" });
        card.classList.remove("is-flash");
        // Force reflow so the animation can replay.
        // eslint-disable-next-line no-unused-expressions
        void card.offsetWidth;
        card.classList.add("is-flash");
      }
    }
  }

  // ====================================================================
  //  Helpers
  // ====================================================================
  function popupHtml(h) {
    const photo = window.DataStore.housePhotoUrl(h.photo);
    const price = formatPrice(h);
    const meta = [
      h.bedrooms ? `${h.bedrooms} bed` : "",
      h.bathrooms ? `${h.bathrooms} bath` : "",
      h.size_sqm ? `${h.size_sqm} m²` : ""
    ].filter(Boolean).join(" · ");
    const ph = h.agent?.phone || "";
    const phClean = ph.replace(/\s+/g, "");
    const wa = ph.replace(/^\+/, "").replace(/\s+/g, "");
    return `<div class="house-popup">
      ${photo ? `<img src="${photo}" alt="${esc(h.title)}">` : ""}
      <h4>${esc(h.title)}</h4>
      <div class="price">${price.value} <span style="font-weight:500;color:#666">${price.unit}</span></div>
      <div class="pop-meta">${esc(h.area || "")}${h.region ? ", " + esc(h.region) : ""}${meta ? " · " + meta : ""}</div>
      <div class="pop-actions">
        ${ph ? `<a class="btn-call" href="tel:${phClean}">📞 Call</a>` : ""}
        ${ph ? `<a class="btn-wa" target="_blank" rel="noopener" href="https://wa.me/${wa}">WhatsApp</a>` : ""}
      </div>
    </div>`;
  }

  function formatPrice(h) {
    const p = h.price_tzs || 0;
    let value;
    if (p >= 1_000_000_000) value = (p / 1_000_000_000).toFixed(2) + "B";
    else if (p >= 1_000_000) value = (p / 1_000_000).toFixed(p % 1_000_000 === 0 ? 0 : 1) + "M";
    else if (p >= 1_000)    value = (p / 1_000).toFixed(0) + "k";
    else value = String(p);
    const unit = h.listing === "sale"
      ? "TZS"
      : `TZS / ${h.period || "month"}`;
    return { value: `${value} `, unit };
  }

  function shortPrice(h) {
    const p = h.price_tzs || 0;
    if (p >= 1_000_000_000) return (p / 1_000_000_000).toFixed(1) + "B";
    if (p >= 1_000_000)     return (p / 1_000_000).toFixed(p % 1_000_000 === 0 ? 0 : 1) + "M";
    if (p >= 1_000)         return (p / 1_000).toFixed(0) + "k";
    return String(p);
  }

  function distKm(a, b) {
    const R = 6371, dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const x = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  // 4-arg form used by the area-alert distance checks (runNewListingDiff
  // + the Realtime INSERT handler). Same maths, different signature.
  function haversineKm(lat1, lng1, lat2, lng2) {
    return distKm({ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 });
  }
  function toRad(d) { return d * Math.PI / 180; }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
};
