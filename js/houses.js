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
  const alertBanner= document.getElementById("housesAlertBanner");
  const watchChips = document.getElementById("housesWatchChips");
  const tabList    = document.getElementById("tabList");
  const tabMap     = document.getElementById("tabMap");

  // ---- State -------------------------------------------------------------
  let houses    = [];
  let visible   = [];
  let map       = null;
  let markers   = new Map();   // id -> marker
  let activeId  = null;
  let userLoc   = null;

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

  // ---- Geo-circle area alerts (Nominatim + GPS + draggable pin) ----------
  setupGeoAlerts();

  // ---- Near-me -----------------------------------------------------------
  nearBtn?.addEventListener("click", () => {
    if (!navigator.geolocation) { alert("Geolocation isn't supported on this device."); return; }
    nearBtn.disabled = true; nearBtn.textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        nearBtn.disabled = false;
        nearBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg> Sorted by distance`;
        if (map) map.easeTo({ center: [userLoc.lng, userLoc.lat], zoom: 12 });
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
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=tz&addressdetails=1&q=${encodeURIComponent(q)}`;
        const r = await fetch(url, { headers: { "Accept": "application/json" } });
        const list = await r.json();
        if (!list.length) { resultsEl.innerHTML = `<div class="am-search-result loading">No matches in Tanzania.</div>`; return; }
        resultsEl.innerHTML = list.map((it, i) => {
          const short = (it.display_name || "").split(",").slice(0, 2).join(", ");
          const rest  = (it.display_name || "").split(",").slice(2).join(", ");
          return `<div class="am-search-result" data-i="${i}">
            <strong>${esc(short)}</strong>
            ${rest ? `<small>${esc(rest)}</small>` : ""}
          </div>`;
        }).join("");
        resultsEl.querySelectorAll(".am-search-result").forEach(div => {
          div.addEventListener("click", () => {
            const it = list[+div.dataset.i];
            if (!it) return;
            setPin(+it.lat, +it.lon, (it.display_name || "").split(",").slice(0, 2).join(", "));
            resultsEl.hidden = true;
            searchIn.value = (it.display_name || "").split(",")[0];
          });
        });
      } catch (e) {
        resultsEl.innerHTML = `<div class="am-search-result loading">Search failed: ${esc(e.message)}</div>`;
      }
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

    if (userLoc) {
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
      listEl.innerHTML = `<div class="hp-empty" role="status">
        <div class="hp-empty__art" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>
          </svg>
        </div>
        <div class="hp-empty__title">No properties match</div>
        <div class="hp-empty__sub">Widen your filters, clear the search box, or pan the map to a different area.</div>
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
        h.size_sqm ? `<span>📐 ${h.size_sqm} m²</span>` : ""
      ].filter(Boolean).join("");
      const loc = `${esc(h.area || "—")}${h.region ? `, ${esc(h.region)}` : ""}`;
      const dist = (userLoc && Number.isFinite(h.lat) && Number.isFinite(h.lng))
        ? ` · ${distKm(userLoc, h).toFixed(1)} km away`
        : "";
      const ariaLabel = `${esc(h.title)}, ${price.value} ${price.unit}, ${loc}`;
      return `
        <div class="house-card ${activeId === h.id ? "active" : ""}" data-id="${h.id}"
             role="button" tabindex="0" aria-label="${ariaLabel}">
          <div class="house-card-photo" data-loading="true" style="background-image:url('${photo}')">
            <span class="badge">${listing}</span>
            ${verified}
          </div>
          <div class="house-card-body">
            <div class="house-card-price">${price.value} <small>${price.unit}</small></div>
            <div class="house-card-title">${esc(h.title)}</div>
            <div class="house-card-meta">${meta}</div>
            <div class="house-card-loc">📍 ${loc}${dist}</div>
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
    if (!map || !mappable?.length) return;
    const lngs = mappable.map(h => h.lng), lats = mappable.map(h => h.lat);
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 60, maxZoom: 14, duration: 500 }
    );
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
