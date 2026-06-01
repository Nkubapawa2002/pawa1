// ============================================================================
//  Ride — Uber-style hailing for Tanzania
//
//  Shared between two roles (rider, driver) on the same page.
//  Stack: Leaflet + OpenStreetMap, Supabase Realtime, Nominatim geocoding,
//  OSRM routing (free public demo), Payments.js for end-of-trip payment.
//
//  State machine (rider):
//    pick → searching → trip(accepted → en_route_pickup → arrived
//                            → on_trip → completed → paid)
//
//  State machine (driver):
//    register → online ⇄ offline
//    on accept: en_route_pickup → arrived → on_trip → completed
// ============================================================================

window.initRidePage = () => {
  const cfg = window.APP_CONFIG;
  const sb  = window.DataStore?.sb;

  // -------- Tanzania-only map bounds --------
  const TZ_CENTER = [-6.369028, 34.888822];
  const TZ_BOUNDS = [[-11.75, 29.34], [-0.99, 40.45]];

  // Inside-bounds check used for typed/geocoded addresses
  function inTanzania(lat, lng) {
    return lat >= TZ_BOUNDS[0][0] && lat <= TZ_BOUNDS[1][0]
        && lng >= TZ_BOUNDS[0][1] && lng <= TZ_BOUNDS[1][1];
  }

  // -------- Element refs --------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const tabs = $$(".ride-tab");
  const panels = {
    rider:  $('.ride-panel[data-panel="rider"]'),
    driver: $('.ride-panel[data-panel="driver"]'),
    friend: $('.ride-panel[data-panel="friend"]'),
  };

  // -------- Shared map state --------
  let map = null;
  let pickupMarker = null;
  let dropoffMarker = null;
  let routeLine = null;
  let myMarker = null;          // rider's own GPS pulse
  let driverMarker = null;      // assigned driver during a trip
  const driverMarkers = new Map(); // driver_id -> marker (idle drivers near rider)

  let lastFix = null;           // {lat,lng,accuracy}
  let watchId = null;
  let driverHeartbeatTimer = null;
  let driverPositionWatch = null;

  // -------- Persistent ids --------
  function ensureId(key) {
    let id = localStorage.getItem(key);
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) ||
           (Date.now() + "-" + Math.random().toString(16).slice(2));
      localStorage.setItem(key, id);
    }
    return id;
  }
  const riderId  = ensureId("ride_rider_id");
  const driverId = ensureId("ride_driver_id");

  // -------- Mode switching --------
  // Default mode is "map" — full-width Tanzania map with live driver pins.
  let mode = "map";
  const stageEl = document.getElementById("rideStage");
  const mapOverlay = document.getElementById("mapOverlay");

  function applyMode() {
    Object.entries(panels).forEach(([k, el]) => { if (el) el.hidden = (k !== mode); });
    // Map-only layout: hide the side aside, expand the map full-width.
    if (mode === "map") {
      stageEl?.classList.add("ride-stage--map-only");
      if (mapOverlay) mapOverlay.hidden = false;
    } else {
      stageEl?.classList.remove("ride-stage--map-only");
      if (mapOverlay) mapOverlay.hidden = true;
    }

    if (mode === "driver") {
      showDriverShell();
      clearNearbyDrivers();   // driver doesn't need to see other drivers
    } else {
      // Rider, map, and friend modes all want live driver pins.
      startNearbyDriversFeed();
    }
    setTimeout(() => map?.invalidateSize(), 60);
  }

  tabs.forEach(t => {
    t.addEventListener("click", () => {
      tabs.forEach(x => { x.classList.remove("active"); x.setAttribute("aria-selected", "false"); });
      t.classList.add("active");
      t.setAttribute("aria-selected", "true");
      mode = t.dataset.mode;
      applyMode();
    });
  });

  // "Request a ride" CTA on the map overlay → switch to rider tab
  document.getElementById("mapRequestRideBtn")?.addEventListener("click", () => {
    const riderTab = document.querySelector('.ride-tab[data-mode="rider"]');
    riderTab?.click();
  });

  // -------- Map init --------
  initMap();
  startGeolocate();
  showDriverShell({ silent: true });   // pre-populate the driver tab if they've registered before
  applyMode();                          // sync UI to the default mode ("map")
  hydrateDriverFromDB();                // refresh local cache from ride_drivers if the row exists

  // If the persistent KYC row exists for this device's driverId, mirror it
  // into localStorage and rebuild the online shell — this lets a returning
  // driver who cleared cache skip re-registration.
  async function hydrateDriverFromDB() {
    if (!sb) return;
    try {
      const { data } = await sb.from("ride_drivers")
        .select("full_name,phone,vehicle_type,vehicle_label,plate,license_no,national_id,experience_years,selfie_path,vehicle_photo_path,plate_photo_path,license_photo_path")
        .eq("driver_id", driverId).maybeSingle();
      if (!data) return;
      driverProfile = {
        name:              data.full_name,
        phone:             data.phone,
        vehicle_type:      data.vehicle_type,
        vehicle_label:     data.vehicle_label || "",
        plate:             data.plate || "",
        license_no:        data.license_no || "",
        national_id:       data.national_id || "",
        experience_years:  data.experience_years || 1,
        photos: {
          selfie:  data.selfie_path,
          vehicle: data.vehicle_photo_path,
          plate:   data.plate_photo_path,
          license: data.license_photo_path,
        },
      };
      localStorage.setItem("ride_driver_profile", JSON.stringify(driverProfile));
      showDriverShell({ silent: true });
    } catch { /* offline / no table — register-from-scratch path still works */ }
  }

  function initMap() {
    map = L.map("rideMap", { zoomControl: true })
      .setView(TZ_CENTER, 6)
      .setMaxBounds(TZ_BOUNDS);

    const _mbToken = window.APP_CONFIG?.MAPBOX_TOKEN || "";
    if (_mbToken) {
      L.tileLayer(
        `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/512/{z}/{x}/{y}?access_token=${_mbToken}`,
        { maxZoom: 22, tileSize: 512, zoomOffset: -1, attribution: "© Mapbox © OpenStreetMap" }
      ).addTo(map);
    } else {
      // Free Esri satellite + transport + labels overlay = hybrid view.
      L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 19, attribution: "Tiles © Esri, Maxar, Earthstar Geographics" }
      ).addTo(map);
      L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 19, pane: "overlayPane" }
      ).addTo(map);
      L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 19, pane: "overlayPane" }
      ).addTo(map);
    }

    // Major Tanzania cities for context at low zoom — bright against satellite
    TZ_CITIES.forEach(c => {
      L.circleMarker([c.lat, c.lng], {
        radius: 5, color: "#fff", weight: 1.5,
        fillColor: "#00e676", fillOpacity: 0.9
      }).addTo(map).bindTooltip(c.name, { direction: "top", offset: [0, -4] });
    });

    // Universities & colleges layer (auto-toggles by zoom)
    initUniversitiesLayer();
    map.on("zoomend", onZoomEnd);
    onZoomEnd();

    map.on("click", (e) => {
      if (mode !== "rider") return;
      const step = currentRiderStep();
      if (step !== "pick") return;
      // First click sets pickup if missing, otherwise sets dropoff.
      if (!pickupMarker) {
        setPickup(e.latlng.lat, e.latlng.lng);
      } else {
        setDropoff(e.latlng.lat, e.latlng.lng);
      }
    });
  }

  // ====================================================================
  //  Rider Geolocation (own pulse pin)
  // ====================================================================
  function startGeolocate() {
    if (!navigator.geolocation) return;
    let lastGeoLat = null, lastGeoLng = null;
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy, heading: hdg, speed } = pos.coords;
        // Heading in degrees; some devices return null when standing still.
        // Fall back to bearing-from-previous-fix so the arrow still rotates.
        let heading = (hdg != null && !isNaN(hdg)) ? hdg : null;
        if (heading == null && lastGeoLat != null) {
          const bearing = bearingDeg(lastGeoLat, lastGeoLng, lat, lng);
          if (bearing != null) heading = bearing;
        }
        lastGeoLat = lat; lastGeoLng = lng;
        lastFix = { lat, lng, accuracy, heading, speed };
        if (!myMarker) {
          myMarker = L.marker([lat, lng], { icon: makeMyIcon(), zIndexOffset: 600 })
            .addTo(map).bindPopup(t("ride_you_here", "You are here"));
          if (inTanzania(lat, lng)) map.setView([lat, lng], 14, { animate: true });
        } else {
          myMarker.setLatLng([lat, lng]);
        }
        // Auto-fill pickup with current GPS the first time we get a fix
        if (!pickupMarker && currentRiderStep() === "pick" && inTanzania(lat, lng)) {
          setPickup(lat, lng, t("ride_my_location", "My current location"));
        }
        // Forward to driver heartbeat if driver is online
        if (driverState === "online" && driverProfile) pushDriverHeartbeat();
      },
      (e) => console.warn("geo", e),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  }

  // ====================================================================
  //  Rider — pickup / dropoff selection + fare estimate
  // ====================================================================
  const pickupAddr  = $("#pickupAddr");
  const dropoffAddr = $("#dropoffAddr");
  const searchHits  = $("#searchHits");
  const requestBtn  = $("#requestRideBtn");
  const fareBox     = $("#fareSummary");
  const riderErr    = $("#riderErr");

  let pickup  = null;            // {lat,lng,label}
  let dropoff = null;            // {lat,lng,label}
  let chosenVehicle = "car";

  function currentRiderStep() {
    const panel = panels.rider;
    for (const s of ["pick", "searching", "trip"]) {
      const el = $(`[data-step="${s}"]`, panel);
      if (el && !el.hidden) return s;
    }
    return null;
  }
  function showRiderStep(step) {
    ["pick", "searching", "trip"].forEach(s => {
      const el = $(`[data-step="${s}"]`, panels.rider);
      if (el) el.hidden = (s !== step);
    });
  }

  $$(".ride-veh", panels.rider).forEach(b => {
    b.addEventListener("click", () => {
      $$(".ride-veh", panels.rider).forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      chosenVehicle = b.dataset.veh;
      updateFare();
    });
  });

  $("#pickupGpsBtn").addEventListener("click", () => {
    if (!lastFix) { showToast(t("ride_no_gps", "Waiting for GPS — allow location access."), { kind: "warn" }); return; }
    setPickup(lastFix.lat, lastFix.lng, t("ride_my_location", "My current location"));
  });

  // Geocode dropoff (and pickup) via Nominatim, bias to Tanzania
  let geocodeTimer = null;
  dropoffAddr.addEventListener("input", () => {
    clearTimeout(geocodeTimer);
    const q = dropoffAddr.value.trim();
    if (q.length < 3) { searchHits.hidden = true; return; }
    geocodeTimer = setTimeout(() => geocode(q, dropoffAddr, "dropoff"), 350);
  });
  pickupAddr.addEventListener("change", async () => {
    const q = pickupAddr.value.trim();
    if (q.length < 3) return;
    // Take the first Tanzania match silently — pickup is usually GPS, not typed.
    try {
      const j = await pawaGeo.search(`q=${encodeURIComponent(q + ", Tanzania")}&format=json&limit=1&countrycodes=tz&accept-language=en`);
      const h = (j || []).find(x => inTanzania(+x.lat, +x.lon));
      if (h) setPickup(+h.lat, +h.lon, h.display_name.split(",")[0]);
    } catch {}
  });

  async function geocode(q, anchor, kind) {
    try {
      const j = await pawaGeo.search(`q=${encodeURIComponent(q + ", Tanzania")}&format=json&addressdetails=1&limit=6&countrycodes=tz&accept-language=en`);
      const hits = (j || []).filter(h => inTanzania(+h.lat, +h.lon));
      if (!hits.length) { searchHits.hidden = true; return; }
      searchHits.hidden = false;
      searchHits.innerHTML = hits.map((h, i) => `
        <button type="button" class="ride-hit" data-i="${i}">
          <strong>${esc(h.display_name.split(",")[0])}</strong>
          <small class="muted">${esc(h.display_name)}</small>
        </button>`).join("");
      $$(".ride-hit", searchHits).forEach((btn, i) => {
        btn.addEventListener("click", () => {
          const h = hits[i];
          if (kind === "pickup") setPickup(+h.lat, +h.lon, h.display_name.split(",")[0]);
          else                   setDropoff(+h.lat, +h.lon, h.display_name.split(",")[0]);
          searchHits.hidden = true;
        });
      });
      // Position the dropdown below the anchor input
      const r2 = anchor.getBoundingClientRect();
      const pr = anchor.closest(".meet-label").getBoundingClientRect();
      searchHits.style.top   = (r2.bottom - pr.top + 4) + "px";
    } catch (e) {
      console.warn("geocode", e);
      searchHits.hidden = true;
    }
  }

  function setPickup(lat, lng, label) {
    if (!inTanzania(lat, lng)) {
      flash(riderErr, t("ride_outside_tz", "Pickup must be inside Tanzania."));
      return;
    }
    pickup = { lat, lng, label: label || "" };
    pickupAddr.value = label || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    if (pickupMarker) pickupMarker.setLatLng([lat, lng]);
    else pickupMarker = L.marker([lat, lng], { icon: makePinIcon("pickup") })
      .addTo(map).bindPopup(t("ride_pickup", "Pickup"));
    if (!label) reverseGeocode(lat, lng).then(addr => {
      if (addr) { pickup.label = addr; pickupAddr.value = addr; }
    });
    refreshRoute();
  }

  function setDropoff(lat, lng, label) {
    if (!inTanzania(lat, lng)) {
      flash(riderErr, t("ride_outside_tz_drop", "Dropoff must be inside Tanzania."));
      return;
    }
    dropoff = { lat, lng, label: label || "" };
    dropoffAddr.value = label || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    if (dropoffMarker) dropoffMarker.setLatLng([lat, lng]);
    else dropoffMarker = L.marker([lat, lng], { icon: makePinIcon("dropoff") })
      .addTo(map).bindPopup(t("ride_dropoff", "Dropoff"));
    if (!label) reverseGeocode(lat, lng).then(addr => {
      if (addr) { dropoff.label = addr; dropoffAddr.value = addr; }
    });
    refreshRoute();
  }

  async function reverseGeocode(lat, lng) {
    try {
      const j = await pawaGeo.reverse(`format=json&lat=${lat}&lon=${lng}&zoom=16&accept-language=en`);
      return j?.display_name || null;
    } catch { return null; }
  }

  // -------- Route + fare estimate via OSRM (with alternatives) --------
  let routeKm = null;
  let routeLayer = null;            // LayerGroup containing primary + alternative polylines
  async function refreshRoute() {
    if (!pickup || !dropoff || !map) { hideFare(); return; }
    if (routeLayer) { routeLayer.remove(); routeLayer = null; }
    routeLine = null;

    // Fit bounds
    const bounds = L.latLngBounds([[pickup.lat, pickup.lng], [dropoff.lat, dropoff.lng]]);
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });

    routeLayer = L.layerGroup().addTo(map);
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${pickup.lng},${pickup.lat};${dropoff.lng},${dropoff.lat}?overview=full&geometries=geojson&alternatives=true&steps=false`;
      const r = await fetch(url);
      const j = await r.json();
      const routes = j?.routes || [];
      if (!routes.length) throw new Error("no route");

      // Alternative routes first (drawn under), so the primary sits on top.
      routes.slice(1).forEach((alt, i) => {
        const coords = alt.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
        const km     = (alt.distance / 1000).toFixed(1);
        const min    = Math.round(alt.duration / 60);
        L.polyline(coords, {
          color: "#ffffff", weight: 4, opacity: 0.55, dashArray: "8 7"
        }).addTo(routeLayer)
         .bindTooltip(`${t("ride_alt_route", "Alternative")} · ${km} km · ${min} min`, { sticky: true });
      });

      const primary = routes[0];
      routeKm = primary.distance / 1000;
      const coords = primary.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      routeLine = L.polyline(coords, { color: "#00cfff", weight: 6, opacity: 0.95 })
        .addTo(routeLayer)
        .bindTooltip(`${t("ride_best_route", "Best route")} · ${routeKm.toFixed(1)} km`, { sticky: true });
    } catch {
      routeKm = haversineKm(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);
      routeLine = L.polyline([[pickup.lat, pickup.lng], [dropoff.lat, dropoff.lng]],
        { color: "#d4af37", weight: 4, dashArray: "6 8" }).addTo(routeLayer);
    }
    updateFare();
  }

  function updateFare() {
    if (routeKm == null) { hideFare(); return; }
    // Refresh the per-vehicle fare chip
    $$(".ride-veh", panels.rider).forEach(b => {
      const base = +b.dataset.base || 0;
      const perKm = +b.dataset.perkm || 0;
      const fare = Math.round((base + routeKm * perKm) / 100) * 100;
      b.dataset.fare = fare;
      $(".rv-fare", b).textContent = window.formatTZS(fare);
    });
    const sel = $(`.ride-veh.active`, panels.rider);
    const fare = +sel?.dataset.fare || 0;
    fareBox.hidden = false;
    $("#fareDistance").textContent = routeKm < 1 ? Math.round(routeKm*1000) + " m" : routeKm.toFixed(1) + " km";
    $("#farePickupEta").textContent = lastFix
      ? Math.max(2, Math.round(haversineKm(lastFix.lat, lastFix.lng, pickup.lat, pickup.lng) / 25 * 60)) + " min"
      : "—";
    $("#fareTotal").textContent = window.formatTZS(fare);
    requestBtn.disabled = !(pickup && dropoff && fare > 0);
  }
  function hideFare() { fareBox.hidden = true; requestBtn.disabled = true; }

  // ====================================================================
  //  Rider — request lifecycle
  // ====================================================================
  let activeRide = null;        // current ride_requests row
  let rideChannel = null;
  let driverFollowMarker = null;

  requestBtn.addEventListener("click", async () => {
    riderErr.style.display = "none";
    const name  = $("#riderName").value.trim();
    const phone = $("#riderPhone").value.trim();
    const notes = $("#rideNotes").value.trim() || null;
    if (!name)  { return flash(riderErr, t("ride_need_name",  "Please enter your name.")); }
    if (!phone || phone.replace(/\D/g, "").length < 9) {
      return flash(riderErr, t("ride_need_phone", "Please enter a valid phone number."));
    }
    if (!pickup || !dropoff) return;
    sessionStorage.setItem("ride_rider_profile", JSON.stringify({ name, phone }));

    const sel = $(`.ride-veh.active`, panels.rider);
    const fare = +sel.dataset.fare;

    requestBtn.disabled = true;
    requestBtn.textContent = "…";
    try {
      if (!sb) throw new Error("Database not configured");
      const { data, error } = await sb.from("ride_requests").insert({
        rider_id: riderId,
        rider_name: name,
        rider_phone: phone,
        pickup_lat:  pickup.lat,  pickup_lng:  pickup.lng,  pickup_addr:  pickup.label,
        dropoff_lat: dropoff.lat, dropoff_lng: dropoff.lng, dropoff_addr: dropoff.label,
        vehicle_type: chosenVehicle,
        notes,
        distance_km: +routeKm.toFixed(2),
        fare_tzs: fare,
        status: "requested",
      }).select("*").single();
      if (error) throw error;

      activeRide = data;
      $("#searchingDistance").textContent = $("#fareDistance").textContent;
      $("#searchingFare").textContent     = window.formatTZS(fare);
      showRiderStep("searching");
      subscribeRide(data.id);
    } catch (e) {
      flash(riderErr, e.message || "Could not request a ride.");
    } finally {
      requestBtn.disabled = false;
      requestBtn.textContent = t("ride_request_btn", "Request ride");
    }
  });

  $("#cancelSearchBtn").addEventListener("click", () => cancelRide("rider"));
  $("#cancelTripBtn").addEventListener("click", () => {
    if (confirm(t("ride_confirm_cancel", "Cancel this trip?"))) cancelRide("rider");
  });
  $("#shareTripBtn").addEventListener("click", shareTrip);
  $("#payTripBtn").addEventListener("click", () => payForRide(activeRide));

  function subscribeRide(rideId) {
    if (rideChannel) rideChannel.unsubscribe?.();
    rideChannel = sb.channel(`ride_${rideId}`)
      .on("postgres_changes", {
        event: "UPDATE", schema: "public", table: "ride_requests",
        filter: `id=eq.${rideId}`,
      }, (p) => onRideUpdate(p.new))
      .subscribe();
  }

  function onRideUpdate(row) {
    activeRide = row;
    if (row.status === "expired" || row.status === "cancelled") {
      showRiderStep("pick");
      flash(riderErr, t("ride_no_drivers", "No driver took the ride. Try again."));
      tearDownTripMap();
      return;
    }
    if (["accepted","en_route_pickup","arrived","on_trip","completed"].includes(row.status)) {
      showRiderStep("trip");
      renderTrip(row);
    }
    if (row.status === "completed" && !row.payment_id) {
      // Surface the pay button and a banner
      $("#payTripBtn").hidden = false;
      const banner = $("#tripBanner");
      banner.style.display = "block";
      banner.className = "banner success";
      banner.textContent = t("ride_arrived_dropoff", "You've reached your destination. Pay your driver.");
    }
    if (row.payment_status === "completed") {
      const banner = $("#tripBanner");
      banner.style.display = "block";
      banner.className = "banner success";
      banner.textContent = t("ride_paid", "Paid! Have a great day.");
      $("#payTripBtn").hidden = true;
    }
  }

  function renderTrip(row) {
    $("#driverName").textContent     = row.driver_name || "—";
    $("#driverVehicle").textContent  = row.driver_vehicle || "";
    $("#driverRating").textContent   = "4.9";
    $("#tripFare").textContent       = window.formatTZS(row.fare_tzs);

    // Update step pills
    $$(".rts-step", panels.rider).forEach(s => s.classList.remove("active"));
    const order = ["accepted","en_route_pickup","arrived","on_trip","completed"];
    const idx = order.indexOf(row.status);
    order.slice(0, idx + 1).forEach(st => {
      $(`.rts-step[data-state="${st}"]`, panels.rider)?.classList.add("active");
    });

    const callBtn = $("#callDriverBtn");
    if (row.driver_phone) callBtn.href = `tel:${row.driver_phone}`;

    // Plot driver pin and pickup-→-driver line
    if (row.driver_lat != null && row.driver_lng != null) {
      const pos = [row.driver_lat, row.driver_lng];
      if (!driverFollowMarker) {
        driverFollowMarker = L.marker(pos, { icon: makeDriverIcon(row.vehicle_type) })
          .addTo(map).bindPopup(`<strong>${esc(row.driver_name||"Driver")}</strong><br>${esc(row.driver_vehicle||"")}`);
      } else {
        driverFollowMarker.setLatLng(pos);
      }
      const target = (row.status === "on_trip")
        ? [row.dropoff_lat, row.dropoff_lng]
        : [row.pickup_lat,  row.pickup_lng];
      const eta = etaFromTo(pos, target, 30);
      $("#tripEta").textContent = eta + " min";
    }
  }

  async function cancelRide(by) {
    if (!activeRide) { showRiderStep("pick"); return; }
    try {
      await sb.from("ride_requests").update({
        status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: by
      }).eq("id", activeRide.id);
    } catch (e) { console.warn(e); }
    tearDownTripMap();
    activeRide = null;
    showRiderStep("pick");
  }

  function tearDownTripMap() {
    if (driverFollowMarker) { driverFollowMarker.remove(); driverFollowMarker = null; }
    if (rideChannel) { rideChannel.unsubscribe?.(); rideChannel = null; }
  }

  async function payForRide(row) {
    if (!row || !window.Payments) return;
    window.Payments.openPicker({
      reference: "RIDE-" + row.id.slice(0, 8).toUpperCase(),
      reference_type: "ride",
      amount_tzs: row.fare_tzs,
      phone: row.rider_phone,
      customer_name: row.rider_name,
      onSuccess: async (payment) => {
        await sb.from("ride_requests").update({
          payment_id: payment.id || payment.payment_id,
          payment_status: payment.status || "completed",
        }).eq("id", row.id);
      },
    });
  }

  function shareTrip() {
    if (!activeRide) return;
    const url  = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}meet.html`;
    const text = `${t("ride_share_msg", "Follow my ride live on Pawa")}: ${url}\n${t("ride_share_dest", "Heading to")}: ${activeRide.dropoff_addr || "destination"}`;
    if (navigator.share) navigator.share({ title: "Pawa Ride", text, url }).catch(() => {});
    else { navigator.clipboard.writeText(text); showToast(t("ride_share_copied", "Copied — paste it in WhatsApp / SMS."), { kind: "success" }); }
  }

  // ====================================================================
  //  Live driver feed — payload-driven realtime
  // ====================================================================
  // We do ONE bootstrap select to draw the current state, then drive every
  // subsequent change directly from the postgres_changes payload — no full
  // re-fetch on every event. Markers tween smoothly to their new position
  // and rotate to their heading. Stale markers fade and are pruned by an
  // 8-second freshness sweep.
  let nearbyDriverChannel = null;
  let stalenessSweep = null;
  const driverFreshness = new Map();   // driver_id -> last seen timestamp (ms)

  function startNearbyDriversFeed() {
    if (!sb) return;
    bootstrapNearbyDrivers();
    if (!stalenessSweep) stalenessSweep = setInterval(sweepStaleDrivers, 8000);
    if (nearbyDriverChannel) return;
    nearbyDriverChannel = sb.channel("drivers_online_feed")
      .on("postgres_changes",
          { event: "INSERT", schema: "public", table: "drivers_online" },
          (p) => onDriverInsert(p.new))
      .on("postgres_changes",
          { event: "UPDATE", schema: "public", table: "drivers_online" },
          (p) => onDriverUpdate(p.new, p.old))
      .on("postgres_changes",
          { event: "DELETE", schema: "public", table: "drivers_online" },
          (p) => onDriverDelete(p.old))
      .on("postgres_changes",
          { event: "INSERT", schema: "public", table: "ride_requests" },
          (p) => onRideRequestInsert(p.new))
      .on("postgres_changes",
          { event: "UPDATE", schema: "public", table: "ride_requests" },
          (p) => onRideRequestUpdateStream(p.new, p.old))
      .subscribe();
  }

  async function bootstrapNearbyDrivers() {
    if (mode === "driver") return;
    const { data } = await sb.from("drivers_online")
      .select("driver_id,display_name,vehicle_type,vehicle_label,lat,lng,heading,status,last_seen,rating")
      .eq("status", "online")
      .order("last_seen", { ascending: false })
      .limit(200);
    const fresh = (data || []).filter(d => Date.now() - new Date(d.last_seen).getTime() < 90_000);
    fresh.forEach(d => upsertDriverMarker(d, /*animate*/ false));
    updateDriverCounter();
  }

  function upsertDriverMarker(d, animate = true) {
    if (!d?.driver_id || d.lat == null || d.lng == null) return;
    if (mode === "driver") return;
    driverFreshness.set(d.driver_id, Date.now());
    let m = driverMarkers.get(d.driver_id);
    const labelHtml = `${vehicleEmoji(d.vehicle_type)} ${esc(d.display_name || d.vehicle_label || d.vehicle_type)}`;
    if (!m) {
      m = L.marker([d.lat, d.lng], {
        icon: makeGhostDriverIcon(d.vehicle_type, d.heading),
        zIndexOffset: 200,
      }).addTo(map);
      m.bindTooltip(labelHtml, { direction: "top" });
      m._meta = { ...d };
      m.on("click", () => routeToPoint(m._meta.lat, m._meta.lng,
        `${vehicleEmoji(m._meta.vehicle_type)} ${m._meta.display_name || m._meta.vehicle_label || t("ride_driver", "Driver")}`));
      driverMarkers.set(d.driver_id, m);
    } else {
      m.setTooltipContent(labelHtml);
      if (m._meta?.vehicle_type !== d.vehicle_type || (m._meta?.heading ?? null) !== (d.heading ?? null)) {
        m.setIcon(makeGhostDriverIcon(d.vehicle_type, d.heading));
      }
      if (animate) animateMarkerTo(m, [d.lat, d.lng], 1200);
      else m.setLatLng([d.lat, d.lng]);
      m._meta = { ...m._meta, ...d };
    }
    const el = m.getElement?.();
    if (el) el.classList.remove("pin-stale");
  }

  function onDriverInsert(d) {
    if (d.status !== "online") return;
    upsertDriverMarker(d, false);
    updateDriverCounter();
    pushTickerEvent({
      icon: vehicleEmoji(d.vehicle_type),
      text: `${shortName(d.display_name)} ${t("ride_event_went_online", "is online")}`,
      kind: "online",
    });
  }
  function onDriverUpdate(d, old) {
    if (d.status === "offline") return onDriverDelete(d);
    const moved = old && (old.lat !== d.lat || old.lng !== d.lng);
    upsertDriverMarker(d, /*animate*/ true);
    if (old?.status !== d.status && d.status === "busy") {
      pushTickerEvent({
        icon: "🟡",
        text: `${shortName(d.display_name)} ${t("ride_event_busy", "took a trip")}`,
        kind: "busy",
      });
    }
    if (!moved) updateDriverCounter();
  }
  function onDriverDelete(d) {
    const m = driverMarkers.get(d.driver_id);
    if (m) { m.remove(); driverMarkers.delete(d.driver_id); }
    driverFreshness.delete(d.driver_id);
    updateDriverCounter();
    pushTickerEvent({
      icon: "⚪",
      text: `${shortName(d.display_name)} ${t("ride_event_went_offline", "went offline")}`,
      kind: "offline",
    });
  }

  function onRideRequestInsert(r) {
    pushTickerEvent({
      icon: "🚖",
      text: `${shortName(r.rider_name)} ${t("ride_event_requested", "requested a")} ${vehicleEmoji(r.vehicle_type)} — ${shortAddr(r.pickup_addr)}`,
      kind: "request",
    });
  }
  function onRideRequestUpdateStream(r, old) {
    if (old?.status === r.status) return;
    if (r.status === "accepted" || r.status === "en_route_pickup") {
      pushTickerEvent({
        icon: "✅",
        text: `${shortName(r.driver_name)} ${t("ride_event_accepted", "accepted")} ${shortName(r.rider_name)}`,
        kind: "accept",
      });
    } else if (r.status === "completed") {
      pushTickerEvent({
        icon: "🏁",
        text: `${t("ride_event_done", "Trip done")} · ${shortAddr(r.pickup_addr)} → ${shortAddr(r.dropoff_addr)} · ${window.formatTZS(r.fare_tzs)}`,
        kind: "done",
      });
    } else if (r.status === "cancelled") {
      pushTickerEvent({
        icon: "✖",
        text: `${t("ride_event_cancelled", "Cancelled by")} ${r.cancelled_by || "rider"}`,
        kind: "cancel",
      });
    }
  }

  function sweepStaleDrivers() {
    const now = Date.now();
    for (const [id, ts] of driverFreshness.entries()) {
      const age = now - ts;
      const m = driverMarkers.get(id);
      if (!m) { driverFreshness.delete(id); continue; }
      const el = m.getElement?.();
      if (age > 30_000 && el && !el.classList.contains("pin-stale")) el.classList.add("pin-stale");
      if (age > 90_000) {
        m.remove(); driverMarkers.delete(id); driverFreshness.delete(id);
      }
    }
    updateDriverCounter();
  }

  function updateDriverCounter() {
    const counter = document.getElementById("rmoDriverCount");
    if (counter) counter.textContent = driverMarkers.size;
  }

  function clearNearbyDrivers() {
    for (const m of driverMarkers.values()) m.remove();
    driverMarkers.clear();
    driverFreshness.clear();
    updateDriverCounter();
  }

  // ----- Smooth marker animation -------------------------------------
  // Tween a Leaflet marker between latlngs with ease-out cubic. Cancels
  // any previous tween on the same marker so rapid heartbeats don't queue.
  function animateMarkerTo(marker, target, durationMs = 1200) {
    if (marker._anim) cancelAnimationFrame(marker._anim);
    const start = marker.getLatLng();
    const end = L.latLng(target[0], target[1]);
    if (start.distanceTo(end) < 1) { marker.setLatLng(end); return; }
    const t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / durationMs);
      const e = 1 - Math.pow(1 - k, 3);
      marker.setLatLng([start.lat + (end.lat - start.lat) * e,
                        start.lng + (end.lng - start.lng) * e]);
      if (k < 1) marker._anim = requestAnimationFrame(tick);
      else       marker._anim = null;
    };
    marker._anim = requestAnimationFrame(tick);
  }

  // ----- Live event ticker -------------------------------------------
  const liveTicker = document.getElementById("liveTicker");
  function pushTickerEvent({ icon, text, kind = "info" }) {
    if (!liveTicker) return;
    const empty = liveTicker.querySelector(".rlt-empty");
    if (empty) empty.remove();
    const item = document.createElement("div");
    item.className = `rlt-item rlt-${kind}`;
    item.innerHTML = `
      <span class="rlt-icon">${icon}</span>
      <span class="rlt-text">${esc(text)}</span>
      <span class="rlt-time">${t("ride_event_now", "just now")}</span>`;
    liveTicker.prepend(item);
    while (liveTicker.children.length > 12) liveTicker.lastChild.remove();
    setTimeout(() => item.classList.add("rlt-fading"), 25_000);
    setTimeout(() => item.remove(), 30_000);
  }
  function shortName(n) {
    if (!n) return t("ride_event_someone", "Someone");
    const s = String(n).trim().split(/\s+/);
    return s[0] + (s[1] ? " " + s[1][0] + "." : "");
  }
  function shortAddr(a) {
    if (!a) return "—";
    return String(a).split(",")[0].slice(0, 28);
  }

  // ====================================================================
  //  Driver mode
  // ====================================================================
  let driverState   = "register";   // register | online | offline
  let driverProfile = null;         // { name, phone, vehicle_type, vehicle_label, plate }
  let drvRequestsChannel = null;
  let drvActiveRide = null;

  function showDriverShell({ silent = false } = {}) {
    const saved = JSON.parse(localStorage.getItem("ride_driver_profile") || "null");
    if (saved && saved.name && saved.vehicle_type) {
      driverProfile = saved;
      $("#drvOnlineName").textContent    = saved.name;
      $("#drvOnlineVehicle").textContent = `${vehicleEmoji(saved.vehicle_type)} ${saved.vehicle_label || ""} · ${saved.plate || ""}`;
      $('[data-step="register"]', panels.driver).hidden = true;
      $('[data-step="online"]',   panels.driver).hidden = false;
      if (!silent && mode === "driver") goOnline();
    } else {
      $('[data-step="register"]', panels.driver).hidden = false;
      $('[data-step="online"]',   panels.driver).hidden = true;
    }
  }

  // ====================================================================
  //  Driver — Live capture (selfie, vehicle, plate, licence)
  // ====================================================================
  // Photos are captured straight from the device camera, never uploaded
  // from disk — that's the trust signal for bodaboda/bajaj registrations
  // where formal credentials are scarce. The blobs go to Supabase Storage
  // bucket "ride-driver-photos" under <driver_id>/<kind>.jpg, then a single
  // register_ride_driver RPC writes the persistent KYC row.
  const capturedPhotos = { selfie: null, vehicle: null, plate: null, license: null };
  let camStream = null, camKind = null, camFacing = "environment";

  const camWrap    = $("#drvCameraWrap");
  const camVideo   = $("#drvCameraVideo");
  const camHint    = $("#drvCamHint");
  const camShutter = $("#drvCamShutterBtn");
  const camSwitch  = $("#drvCamSwitchBtn");
  const camClose   = $("#drvCamCloseBtn");
  const drvRegErr  = $("#drvRegErr");
  const drvRegOk   = $("#drvRegOk");

  async function openCamera(kind, facing) {
    if (!navigator.mediaDevices?.getUserMedia) {
      flash(drvRegErr, t("drv_cam_unsupported", "This browser doesn't support camera capture. Use Chrome on Android or Safari on iOS."));
      return;
    }
    camKind = kind;
    camFacing = facing || "environment";
    if (camWrap) camWrap.hidden = false;
    setCamHint(kind);
    await startCamStream();
    camWrap?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function startCamStream() {
    stopCamStream();
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: camFacing }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (camVideo) camVideo.srcObject = camStream;
    } catch (e) {
      flash(drvRegErr, t("drv_cam_fail", "Could not open the camera. Allow camera access in your browser settings, then tap again."));
      closeCamera();
    }
  }

  function stopCamStream() {
    if (camStream) { camStream.getTracks().forEach(tr => tr.stop()); camStream = null; }
    if (camVideo) camVideo.srcObject = null;
  }

  function closeCamera() {
    stopCamStream();
    if (camWrap) camWrap.hidden = true;
    camKind = null;
  }

  function setCamHint(kind) {
    if (!camHint) return;
    const map = {
      selfie:  t("drv_capture_aim_self",    "Frame your face. Good lighting helps."),
      vehicle: t("drv_capture_aim_vehicle", "Frame the entire vehicle from the side."),
      plate:   t("drv_capture_aim_plate",   "Get close — the plate digits must be readable."),
      license: t("drv_capture_aim_license", "Lay the licence flat. Avoid glare."),
    };
    camHint.textContent = map[kind] || "";
  }

  camSwitch?.addEventListener("click", () => {
    camFacing = (camFacing === "user") ? "environment" : "user";
    startCamStream();
  });
  camClose?.addEventListener("click", closeCamera);

  camShutter?.addEventListener("click", async () => {
    if (!camStream || !camKind) return;
    const v = camVideo;
    const w = v.videoWidth || 1280, h = v.videoHeight || 720;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(v, 0, 0, w, h);
    const blob = await new Promise(res => c.toBlob(res, "image/jpeg", 0.85));
    if (!blob) return;
    capturedPhotos[camKind] = blob;
    paintCapCard(camKind, blob);
    closeCamera();
  });

  function paintCapCard(kind, blob) {
    const card = $(`.drv-cap-card[data-cap="${kind}"]`, panels.driver);
    if (!card) return;
    const url = URL.createObjectURL(blob);
    const thumb = $(".drv-cap-thumb", card);
    if (thumb) thumb.innerHTML = `<img src="${url}" alt="">`;
    card.classList.add("captured");
    const btn = $(".drv-cap-btn", card);
    if (btn) btn.textContent = t("drv_capture_retake", "Retake");
  }

  $$(".drv-cap-btn", panels.driver).forEach(btn => {
    btn.addEventListener("click", () => {
      openCamera(btn.dataset.cap, btn.dataset.facing || "environment");
    });
  });

  // Stop the camera if the user navigates away from the driver tab
  tabs.forEach(tab => tab.addEventListener("click", () => {
    if (tab.dataset.mode !== "driver") closeCamera();
  }));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) closeCamera();
  });

  $("#goOnlineBtn")?.addEventListener("click", async () => {
    if (drvRegErr) drvRegErr.style.display = "none";
    if (drvRegOk)  drvRegOk.style.display  = "none";

    const name        = $("#drvName").value.trim();
    const phone       = $("#drvPhone").value.trim();
    const vType       = $("#drvVehicleType").value;
    const vLabel      = $("#drvVehicleLabel").value.trim();
    const plate       = $("#drvPlate").value.trim().toUpperCase();
    const licenseNo   = $("#drvLicenseNo")?.value.trim() || "";
    const nationalId  = $("#drvNationalId")?.value.trim() || "";
    const exp         = parseInt($("#drvExperience")?.value, 10) || 1;

    if (!name)  return flash(drvRegErr, t("drv_need_name", "Please enter your full name."));
    if (!phone || phone.replace(/\D/g, "").length < 9)
      return flash(drvRegErr, t("drv_need_phone", "Please enter a valid phone number."));
    if (!plate) return flash(drvRegErr, t("drv_need_plate", "Please enter your number plate."));
    if (!capturedPhotos.selfie)
      return flash(drvRegErr, t("drv_need_selfie", "Capture a selfie before going online."));
    if (!capturedPhotos.vehicle)
      return flash(drvRegErr, t("drv_need_vehicle_photo", "Capture a photo of your vehicle."));
    if (!capturedPhotos.plate)
      return flash(drvRegErr, t("drv_need_plate_photo", "Capture a close-up of the plate."));
    if (!sb)
      return flash(drvRegErr, t("drv_need_db", "Database not configured. Add Supabase URL + key in config.js."));

    const btn = $("#goOnlineBtn");
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = t("drv_uploading", "Uploading photos…");
    try {
      const paths = {};
      for (const kind of ["selfie", "vehicle", "plate", "license"]) {
        const blob = capturedPhotos[kind];
        if (!blob) continue;
        const path = `${driverId}/${kind}.jpg`;
        const { error: upErr } = await sb.storage.from("ride-driver-photos")
          .upload(path, blob, { upsert: true, contentType: "image/jpeg", cacheControl: "3600" });
        if (upErr) throw upErr;
        paths[kind] = path;
      }

      btn.textContent = t("drv_registering", "Registering…");
      const { error: rpcErr } = await sb.rpc("register_ride_driver", {
        p_driver_id:          driverId,
        p_full_name:          name,
        p_phone:              phone,
        p_vehicle_type:       vType,
        p_vehicle_label:      vLabel || null,
        p_plate:              plate,
        p_license_no:         licenseNo || null,
        p_national_id:        nationalId || null,
        p_experience_years:   exp,
        p_selfie_path:        paths.selfie,
        p_vehicle_photo_path: paths.vehicle,
        p_plate_photo_path:   paths.plate,
        p_license_photo_path: paths.license || null,
        p_captured_lat:       lastFix?.lat ?? null,
        p_captured_lng:       lastFix?.lng ?? null,
      });
      if (rpcErr) throw rpcErr;

      driverProfile = {
        name, phone,
        vehicle_type:  vType,
        vehicle_label: vLabel,
        plate,
        license_no:        licenseNo,
        national_id:       nationalId,
        experience_years:  exp,
        photos:            paths,
      };
      localStorage.setItem("ride_driver_profile", JSON.stringify(driverProfile));
      if (drvRegOk) {
        drvRegOk.textContent = t("drv_registered",
          "Registered. You're going online — riders can now see you on the live map.");
        drvRegOk.style.display = "block";
      }
      showDriverShell();
      goOnline();
    } catch (e) {
      flash(drvRegErr, (e?.message || String(e)) + " — " + t("drv_try_again", "Try again."));
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  $("#goOfflineBtn")?.addEventListener("click", () => goOffline(true));

  $("#drvOnlineToggle")?.addEventListener("change", (e) => {
    if (e.target.checked) goOnline();
    else                  goOffline(false);
  });

  async function goOnline() {
    if (!driverProfile) return;
    driverState = "online";
    if (!lastFix) { showToast(t("drv_need_gps", "Waiting for GPS fix…"), { kind: "warn" }); }
    pushDriverHeartbeat();
    retuneHeartbeat();
    subscribeDriverRequests();
  }

  // Heartbeat cadence: 5 s while idle online, 2 s while on an active trip
  // (riders need to see the driver move smoothly during pickup/dropoff).
  function retuneHeartbeat() {
    clearInterval(driverHeartbeatTimer);
    const interval = drvActiveRide ? 2000 : 5000;
    driverHeartbeatTimer = setInterval(pushDriverHeartbeat, interval);
  }

  async function goOffline(closeShell) {
    driverState = "offline";
    clearInterval(driverHeartbeatTimer); driverHeartbeatTimer = null;
    if (drvRequestsChannel) { drvRequestsChannel.unsubscribe?.(); drvRequestsChannel = null; }
    try {
      await sb?.from("drivers_online").update({ status: "offline" }).eq("driver_id", driverId);
    } catch {}
    if (closeShell) {
      $('[data-step="online"]',   panels.driver).hidden = true;
      $('[data-step="register"]', panels.driver).hidden = false;
    }
  }

  async function pushDriverHeartbeat() {
    if (!sb || !driverProfile || !lastFix) return;
    if (!inTanzania(lastFix.lat, lastFix.lng)) return;
    try {
      await sb.rpc("driver_heartbeat", {
        p_driver_id:    driverId,
        p_display_name: driverProfile.name,
        p_phone:        driverProfile.phone,
        p_vehicle_type: driverProfile.vehicle_type,
        p_vehicle_label: driverProfile.vehicle_label,
        p_plate:        driverProfile.plate,
        p_lat:          lastFix.lat,
        p_lng:          lastFix.lng,
        p_heading:      lastFix.heading || null,
        p_status:       drvActiveRide ? "busy" : "online",
      });
    } catch (e) {
      // RPC may not exist yet — fall back to upsert
      try {
        await sb.from("drivers_online").upsert({
          driver_id: driverId,
          display_name: driverProfile.name,
          phone:        driverProfile.phone,
          vehicle_type: driverProfile.vehicle_type,
          vehicle_label: driverProfile.vehicle_label,
          plate:        driverProfile.plate,
          lat: lastFix.lat, lng: lastFix.lng, heading: lastFix.heading || null,
          status: drvActiveRide ? "busy" : "online",
          last_seen: new Date().toISOString(),
        }, { onConflict: "driver_id" });
      } catch (e2) { console.warn(e2); }
    }
    if (drvActiveRide) {
      // Push driver_lat / driver_lng to the ride row so the rider sees us move
      await sb.from("ride_requests").update({
        driver_lat: lastFix.lat, driver_lng: lastFix.lng,
        driver_heading: lastFix.heading || null,
        driver_seen_at: new Date().toISOString(),
      }).eq("id", drvActiveRide.id);
    }
  }

  function subscribeDriverRequests() {
    if (drvRequestsChannel) return;
    refreshDrvRequests();
    drvRequestsChannel = sb.channel("drv_requests")
      .on("postgres_changes", { event: "*", schema: "public", table: "ride_requests" },
          () => refreshDrvRequests())
      .subscribe();
  }

  async function refreshDrvRequests() {
    // Open requests near me (any vehicle for now; UI lets driver pick).
    const { data } = await sb.from("ride_requests")
      .select("*").eq("status", "requested")
      .order("requested_at", { ascending: false })
      .limit(20);
    const list = $("#drvRequests");
    if (!data || !data.length) {
      list.innerHTML = `<li class="drv-empty muted">${t("drv_no_requests", "No requests yet — stay near busy areas.")}</li>`;
      return;
    }
    list.innerHTML = data.map(r => {
      const km = lastFix ? haversineKm(lastFix.lat, lastFix.lng, r.pickup_lat, r.pickup_lng) : null;
      return `
        <li class="drv-req" data-id="${r.id}">
          <div class="drv-req-row">
            <strong>${esc(r.rider_name || "Rider")}</strong>
            <span class="rfare">${window.formatTZS(r.fare_tzs)}</span>
          </div>
          <div class="drv-req-row muted small">
            ${vehicleEmoji(r.vehicle_type)} ${(r.distance_km||0).toFixed(1)} km
            ${km != null ? ` · ${km.toFixed(1)} km from you` : ""}
          </div>
          <div class="drv-req-addr">
            <small>📍 ${esc(r.pickup_addr || "—")}</small>
            <small>🎯 ${esc(r.dropoff_addr || "—")}</small>
          </div>
          ${r.notes ? `<div class="muted small">"${esc(r.notes)}"</div>` : ""}
          <div class="drv-req-actions">
            <button class="btn btn-primary btn-sm drv-accept">${t("drv_accept","Accept")}</button>
          </div>
        </li>`;
    }).join("");

    $$(".drv-accept", list).forEach(btn => {
      btn.addEventListener("click", (e) => {
        const id = e.target.closest("li").dataset.id;
        const row = data.find(x => x.id === id);
        if (row) acceptRide(row);
      });
    });
  }

  async function acceptRide(row) {
    if (drvActiveRide) { showToast(t("drv_busy", "You already have an active trip."), { kind: "warn" }); return; }
    if (!driverProfile || !lastFix) return;
    // Atomic claim: only update rows that are still in 'requested'
    const { data, error } = await sb.from("ride_requests").update({
      status: "en_route_pickup",
      driver_id:       driverId,
      driver_name:     driverProfile.name,
      driver_phone:    driverProfile.phone,
      driver_vehicle:  driverProfile.vehicle_label || driverProfile.vehicle_type,
      driver_plate:    driverProfile.plate,
      driver_lat:      lastFix.lat,
      driver_lng:      lastFix.lng,
      driver_seen_at:  new Date().toISOString(),
      accepted_at:     new Date().toISOString(),
    }).eq("id", row.id).eq("status", "requested").select("*").single();

    if (error || !data) {
      showToast(t("drv_too_late", "Another driver already accepted this ride."), { kind: "warn" });
      refreshDrvRequests();
      return;
    }
    drvActiveRide = data;
    renderDrvActiveTrip(data);
    retuneHeartbeat();   // bump to 2 s cadence while on a trip
    pushDriverHeartbeat();
  }

  function renderDrvActiveTrip(row) {
    const card = $("#drvActiveTrip");
    if (!row) { card.hidden = true; return; }
    card.hidden = false;
    $("#drvTripRider").textContent = `${row.rider_name || "Rider"} · ${row.rider_phone || ""}`;
    $("#drvTripAddr").textContent  =
      row.status === "on_trip"
        ? `🎯 ${row.dropoff_addr || "Dropoff"}`
        : `📍 ${row.pickup_addr  || "Pickup"}`;

    const target = row.status === "on_trip"
      ? `${row.dropoff_lat},${row.dropoff_lng}`
      : `${row.pickup_lat},${row.pickup_lng}`;
    $("#drvNavBtn").href = `https://www.google.com/maps/dir/?api=1&destination=${target}&travelmode=driving`;
    $("#drvCallRiderBtn").href = `tel:${row.rider_phone || ""}`;

    $("#drvArrivedBtn").hidden  = !["en_route_pickup"].includes(row.status);
    $("#drvStartBtn").hidden    = !["arrived"].includes(row.status);
    $("#drvCompleteBtn").hidden = !["on_trip"].includes(row.status);
  }

  $("#drvArrivedBtn")?.addEventListener("click", () => updateDrvTrip({ status: "arrived", arrived_at: new Date().toISOString() }));
  $("#drvStartBtn")?.addEventListener("click",   () => updateDrvTrip({ status: "on_trip", started_at: new Date().toISOString() }));
  $("#drvCompleteBtn")?.addEventListener("click", async () => {
    await updateDrvTrip({ status: "completed", completed_at: new Date().toISOString() });
    drvActiveRide = null;
    retuneHeartbeat();
    $("#drvActiveTrip").hidden = true;
  });
  $("#drvCancelBtn")?.addEventListener("click", async () => {
    if (!drvActiveRide) return;
    if (!confirm(t("drv_confirm_cancel", "Cancel this trip?"))) return;
    await sb.from("ride_requests").update({
      status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: "driver"
    }).eq("id", drvActiveRide.id);
    drvActiveRide = null;
    retuneHeartbeat();
    $("#drvActiveTrip").hidden = true;
  });

  async function updateDrvTrip(patch) {
    if (!drvActiveRide) return;
    const { data, error } = await sb.from("ride_requests").update(patch)
      .eq("id", drvActiveRide.id).select("*").single();
    if (error) { showToast(error.message, { kind: "error" }); return; }
    drvActiveRide = data;
    renderDrvActiveTrip(data);
  }

  // ====================================================================
  //  Helpers — geo, format, icons
  // ====================================================================
  function haversineKm(la1, lo1, la2, lo2) {
    const R = 6371, toRad = d => d * Math.PI / 180;
    const dLat = toRad(la2 - la1), dLng = toRad(lo2 - lo1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  // Initial bearing in degrees (0 = north, clockwise). Used to rotate the
  // driver arrow when the device-reported heading is missing.
  function bearingDeg(la1, lo1, la2, lo2) {
    if (la1 === la2 && lo1 === lo2) return null;
    const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
    const φ1 = toRad(la1), φ2 = toRad(la2), Δλ = toRad(lo2 - lo1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }
  function etaFromTo(from, to, defaultKmh) {
    const km = haversineKm(from[0], from[1], to[0], to[1]);
    return Math.max(1, Math.round(km / (defaultKmh || 25) * 60));
  }
  function vehicleEmoji(v) { return ({ car:"🚗", bajaj:"🛺", bodaboda:"🏍", van:"🚐", pickup:"🛻" }[v] || "🚗"); }
  function flash(el, msg) { el.textContent = msg; el.style.display = "block"; }
  // Non-blocking toast — replaces alert() so the page never freezes on a popup.
  // Auto-dismisses after `ms` and stacks if multiple toasts fire in a row.
  function showToast(msg, { kind = "info", ms = 3500 } = {}) {
    let host = document.getElementById("rideToastHost");
    if (!host) {
      host = document.createElement("div");
      host.id = "rideToastHost";
      host.className = "ride-toast-host";
      document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = `ride-toast ride-toast-${kind}`;
    el.innerHTML = `<span>${esc(msg)}</span>
                    <button class="ride-toast-x" aria-label="Dismiss">✕</button>`;
    el.querySelector(".ride-toast-x").addEventListener("click", () => el.remove());
    host.appendChild(el);
    setTimeout(() => el.classList.add("ride-toast-fading"), ms - 600);
    setTimeout(() => el.remove(), ms);
    return el;
  }
  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }
  function t(k, fb) { return (window.t && window.t(k)) || fb || k; }

  // ====================================================================
  //  Live communication — text chat + WebRTC video, per active ride
  // ====================================================================
  // One Supabase Realtime channel per ride carries everything:
  //   • `postgres_changes` on ride_messages → text chat history & deltas
  //   • `broadcast` events (offer / answer / ice / bye) → WebRTC signaling
  // Video is true peer-to-peer; only signaling traverses our backend.
  const RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };
  let commChannel = null;          // current Supabase channel
  let commRideId  = null;
  let commRole    = null;          // 'rider' | 'driver'
  let commName    = null;
  let commPeer    = null;          // human-readable peer name
  let pc          = null;          // RTCPeerConnection
  let localStream = null;
  let pendingICE  = [];            // ICE arriving before remoteDescription is set

  const commOverlay   = document.getElementById("commOverlay");
  const commPeerName  = document.getElementById("commPeerName");
  const commPeerSub   = document.getElementById("commPeerSub");
  const commStatusDot = document.getElementById("commStatusDot");
  const commTabChat   = document.getElementById("commTabChat");
  const commTabVideo  = document.getElementById("commTabVideo");
  const commChatPane  = document.getElementById("commChatPane");
  const commVideoPane = document.getElementById("commVideoPane");
  const commThread    = document.getElementById("commThread");
  const commChatForm  = document.getElementById("commChatForm");
  const commChatInput = document.getElementById("commChatInput");
  const commLocalVid  = document.getElementById("commLocalVideo");
  const commRemoteVid = document.getElementById("commRemoteVideo");
  const commCallStatus= document.getElementById("commCallStatus");
  const commStartBtn  = document.getElementById("commStartCallBtn");
  const commHangupBtn = document.getElementById("commHangupBtn");
  const commMicBtn    = document.getElementById("commToggleMicBtn");
  const commCamBtn    = document.getElementById("commToggleCamBtn");
  const commCloseBtn  = document.getElementById("commCloseBtn");

  function setCommStatus(on) {
    if (commStatusDot) commStatusDot.classList.toggle("online", !!on);
  }

  async function openComm({ rideId, role, name, peer, openTab = "chat" }) {
    if (!sb || !rideId) {
      showToast(t("ride_comm_no_db", "Realtime is not configured. Add Supabase URL + key in config.js."), { kind: "warn" });
      return;
    }
    if (commRideId === rideId) {     // already open — just bring forward
      commOverlay.hidden = false;
      switchCommTab(openTab);
      return;
    }
    closeComm();   // tear down anything from a previous trip
    commRideId = rideId; commRole = role; commName = name || (role === "rider" ? "Rider" : "Driver");
    commPeer = peer || (role === "rider" ? t("ride_driver", "Driver") : t("ride_rider", "Rider"));
    commPeerName.textContent = commPeer;
    commPeerSub.textContent  = role === "rider"
      ? t("ride_comm_with_driver", "with your driver")
      : t("ride_comm_with_rider",  "with your rider");
    commThread.innerHTML = "";
    commOverlay.hidden = false;
    setCommStatus(false);
    switchCommTab(openTab);

    // Load chat history
    try {
      const { data } = await sb.from("ride_messages")
        .select("id,from_role,from_name,body,created_at")
        .eq("ride_id", rideId).order("created_at", { ascending: true }).limit(200);
      (data || []).forEach(renderMessage);
    } catch (e) { console.warn("chat history", e); }

    // Subscribe: chat INSERTs + WebRTC broadcast
    commChannel = sb.channel(`ride_comm_${rideId}`, { config: { broadcast: { self: false, ack: false } } })
      .on("postgres_changes",
          { event: "INSERT", schema: "public", table: "ride_messages", filter: `ride_id=eq.${rideId}` },
          (p) => renderMessage(p.new))
      .on("broadcast", { event: "rtc-offer" },  ({ payload }) => onRemoteOffer(payload))
      .on("broadcast", { event: "rtc-answer" }, ({ payload }) => onRemoteAnswer(payload))
      .on("broadcast", { event: "rtc-ice" },    ({ payload }) => onRemoteIce(payload))
      .on("broadcast", { event: "rtc-bye" },    () => endCall(/*notify*/ false))
      .subscribe((status) => setCommStatus(status === "SUBSCRIBED"));
  }

  function closeComm() {
    endCall(false);
    if (commChannel) { try { commChannel.unsubscribe(); } catch {} commChannel = null; }
    commRideId = null; commRole = null; commPeer = null;
    commOverlay.hidden = true;
    commThread.innerHTML = "";
    setCommStatus(false);
  }

  function switchCommTab(which) {
    const isChat = (which === "chat");
    commTabChat.classList.toggle("active", isChat);
    commTabChat.setAttribute("aria-selected", String(isChat));
    commTabVideo.classList.toggle("active", !isChat);
    commTabVideo.setAttribute("aria-selected", String(!isChat));
    commChatPane.hidden = !isChat;
    commVideoPane.hidden = isChat;
    if (isChat) setTimeout(() => commChatInput?.focus(), 50);
  }
  commTabChat?.addEventListener("click", () => switchCommTab("chat"));
  commTabVideo?.addEventListener("click", () => switchCommTab("video"));
  commCloseBtn?.addEventListener("click", closeComm);

  // -------- Chat --------
  function renderMessage(m) {
    if (!commThread) return;
    const mine = (m.from_role === commRole);
    const div = document.createElement("div");
    div.className = `comm-msg ${mine ? "comm-msg-mine" : "comm-msg-theirs"}`;
    const time = new Date(m.created_at || Date.now())
      .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    div.innerHTML = `
      <div class="comm-msg-bubble">${esc(m.body)}</div>
      <small class="comm-msg-meta">${esc(m.from_name || (mine ? commName : commPeer))} · ${time}</small>`;
    commThread.appendChild(div);
    commThread.scrollTop = commThread.scrollHeight;
  }

  commChatForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = commChatInput.value.trim();
    if (!body || !commRideId) return;
    commChatInput.value = "";
    try {
      // Optimistic local render so the sender sees their own bubble even
      // though postgres_changes self-broadcast is off.
      renderMessage({ from_role: commRole, from_name: commName, body, created_at: new Date().toISOString() });
      const { error } = await sb.from("ride_messages").insert({
        ride_id: commRideId, from_role: commRole, from_name: commName, body,
      });
      if (error) throw error;
    } catch (err) {
      renderMessage({ from_role: "system", from_name: "System", body: t("ride_chat_send_fail", "Could not send. Check connection."), created_at: new Date().toISOString() });
    }
  });

  // -------- WebRTC video --------
  async function startCall() {
    if (!commRideId) return;
    try {
      commCallStatus.textContent = t("ride_video_getting_media", "Asking for camera & microphone…");
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      commLocalVid.srcObject = localStream;
      buildPeer();
      localStream.getTracks().forEach(tr => pc.addTrack(tr, localStream));
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      commCallStatus.textContent = t("ride_video_calling", "Calling…");
      sendSignal("rtc-offer", { sdp: offer.sdp, type: offer.type, from: commRole });
      showInCallControls();
    } catch (e) {
      console.warn(e);
      commCallStatus.textContent = (e?.message || String(e)) + " — " + t("drv_try_again", "Try again.");
      endCall(true);
    }
  }

  async function onRemoteOffer(payload) {
    if (!commRideId || payload.from === commRole) return;
    switchCommTab("video");
    commCallStatus.textContent = t("ride_video_incoming", "Incoming video call…");
    try {
      if (!localStream) {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        commLocalVid.srcObject = localStream;
      }
      buildPeer();
      localStream.getTracks().forEach(tr => pc.addTrack(tr, localStream));
      await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      drainPendingIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal("rtc-answer", { sdp: answer.sdp, type: answer.type, from: commRole });
      showInCallControls();
    } catch (e) {
      console.warn(e);
      commCallStatus.textContent = (e?.message || String(e));
      endCall(true);
    }
  }

  async function onRemoteAnswer(payload) {
    if (!pc || payload.from === commRole) return;
    try {
      await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      drainPendingIce();
    } catch (e) { console.warn("setRemoteDescription answer", e); }
  }

  async function onRemoteIce(payload) {
    if (!payload?.candidate || payload.from === commRole) return;
    if (!pc || !pc.remoteDescription) { pendingICE.push(payload.candidate); return; }
    try { await pc.addIceCandidate(payload.candidate); }
    catch (e) { console.warn("addIceCandidate", e); }
  }

  function drainPendingIce() {
    while (pendingICE.length) {
      const c = pendingICE.shift();
      pc.addIceCandidate(c).catch(e => console.warn("drain ice", e));
    }
  }

  function buildPeer() {
    pc = new RTCPeerConnection(RTC_CONFIG);
    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal("rtc-ice", { candidate: e.candidate, from: commRole });
    };
    pc.ontrack = (e) => {
      if (commRemoteVid.srcObject !== e.streams[0]) {
        commRemoteVid.srcObject = e.streams[0];
        commCallStatus.textContent = "";
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected")    commCallStatus.textContent = "";
      if (s === "disconnected") commCallStatus.textContent = t("ride_video_lost", "Connection dropped — trying to recover…");
      if (s === "failed")       endCall(true);
    };
  }

  function sendSignal(event, payload) {
    if (!commChannel) return;
    commChannel.send({ type: "broadcast", event, payload });
  }

  function showInCallControls() {
    commStartBtn.hidden = true;
    commHangupBtn.hidden = false;
    commMicBtn.hidden = false;
    commCamBtn.hidden = false;
    commMicBtn.classList.remove("muted");
    commCamBtn.classList.remove("muted");
  }
  function hideInCallControls() {
    commStartBtn.hidden = false;
    commHangupBtn.hidden = true;
    commMicBtn.hidden = true;
    commCamBtn.hidden = true;
  }

  function endCall(notify) {
    if (notify) sendSignal("rtc-bye", { from: commRole });
    if (pc) { try { pc.close(); } catch {} pc = null; }
    if (localStream) { localStream.getTracks().forEach(tr => tr.stop()); localStream = null; }
    if (commLocalVid)  commLocalVid.srcObject  = null;
    if (commRemoteVid) commRemoteVid.srcObject = null;
    pendingICE = [];
    hideInCallControls();
    if (commCallStatus) commCallStatus.textContent = t("ride_video_idle", "Tap \"Start call\" to begin a live video.");
  }

  commStartBtn?.addEventListener("click", startCall);
  commHangupBtn?.addEventListener("click", () => endCall(true));
  commMicBtn?.addEventListener("click", () => {
    if (!localStream) return;
    const enabled = !localStream.getAudioTracks()[0]?.enabled;
    localStream.getAudioTracks().forEach(tr => tr.enabled = enabled);
    commMicBtn.classList.toggle("muted", !enabled);
    commMicBtn.textContent = enabled ? "🎙" : "🔇";
  });
  commCamBtn?.addEventListener("click", () => {
    if (!localStream) return;
    const enabled = !localStream.getVideoTracks()[0]?.enabled;
    localStream.getVideoTracks().forEach(tr => tr.enabled = enabled);
    commCamBtn.classList.toggle("muted", !enabled);
    commCamBtn.textContent = enabled ? "📷" : "🚫";
  });

  // -------- Hooks: open the overlay from rider/driver buttons --------
  $("#riderChatBtn")?.addEventListener("click", () => {
    if (!activeRide) return;
    openComm({
      rideId: activeRide.id, role: "rider",
      name: activeRide.rider_name || "Rider",
      peer: activeRide.driver_name || t("ride_driver", "Driver"),
      openTab: "chat",
    });
  });
  $("#riderVideoBtn")?.addEventListener("click", () => {
    if (!activeRide) return;
    openComm({
      rideId: activeRide.id, role: "rider",
      name: activeRide.rider_name || "Rider",
      peer: activeRide.driver_name || t("ride_driver", "Driver"),
      openTab: "video",
    });
  });
  $("#drvChatBtn")?.addEventListener("click", () => {
    if (!drvActiveRide) return;
    openComm({
      rideId: drvActiveRide.id, role: "driver",
      name: drvActiveRide.driver_name || driverProfile?.name || "Driver",
      peer: drvActiveRide.rider_name || t("ride_rider", "Rider"),
      openTab: "chat",
    });
  });
  $("#drvVideoBtn")?.addEventListener("click", () => {
    if (!drvActiveRide) return;
    openComm({
      rideId: drvActiveRide.id, role: "driver",
      name: drvActiveRide.driver_name || driverProfile?.name || "Driver",
      peer: drvActiveRide.rider_name || t("ride_rider", "Rider"),
      openTab: "video",
    });
  });

  // ====================================================================
  //  Universities & colleges layer
  // ====================================================================
  let uniLayer = null;
  let uniVisible = true;
  function initUniversitiesLayer() {
    uniLayer = L.layerGroup();
    TZ_UNIVERSITIES.forEach(u => {
      L.marker([u.lat, u.lng], { icon: makeUniIcon(u.kind) })
        .bindTooltip(u.name, { direction: "top", offset: [0, -8] })
        .bindPopup(
          `<div class="uni-popup">
             <strong>${esc(u.name)}</strong>
             <small class="muted">${esc(uniLabel(u.kind))} · ${esc(u.city || "")}</small>
             <a class="btn btn-primary btn-xs" target="_blank" rel="noopener"
                href="https://www.google.com/maps/dir/?api=1&destination=${u.lat},${u.lng}">
               ${t("ride_navigate", "Navigate")}
             </a>
           </div>`
        )
        .addTo(uniLayer);
    });
    if (uniVisible) uniLayer.addTo(map);
  }
  function onZoomEnd() {
    if (!map) return;
    const z = map.getZoom();
    // Hide the dense uni cluster at very low zooms (TZ-wide view) — too noisy
    if (uniVisible && z < 7 && map.hasLayer(uniLayer)) map.removeLayer(uniLayer);
    if (uniVisible && z >= 7 && !map.hasLayer(uniLayer)) uniLayer.addTo(map);
    // Toggle the "zoom in for street names" hint
    const hint = document.getElementById("zoomHint");
    if (hint) hint.hidden = (z >= 14);
  }

  // Toggle: clicked from the map overlay
  document.getElementById("toggleUniBtn")?.addEventListener("click", () => {
    uniVisible = !uniVisible;
    const btn = document.getElementById("toggleUniBtn");
    btn.classList.toggle("active", uniVisible);
    if (uniVisible) uniLayer.addTo(map);
    else            map.removeLayer(uniLayer);
  });

  // ====================================================================
  //  "Route me to this driver" — road-routed line w/ alternatives
  // ====================================================================
  let meetRouteLayer = null;
  function clearMeetRoute() {
    if (meetRouteLayer) { meetRouteLayer.remove(); meetRouteLayer = null; }
  }
  async function routeToPoint(targetLat, targetLng, label) {
    if (!lastFix) {
      showToast(t("ride_no_gps_route", "Waiting for your GPS — allow location access first."), { kind: "warn" });
      return;
    }
    clearMeetRoute();
    meetRouteLayer = L.layerGroup().addTo(map);
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${lastFix.lng},${lastFix.lat};${targetLng},${targetLat}?overview=full&geometries=geojson&alternatives=true&steps=false`;
      const r = await fetch(url);
      const j = await r.json();
      const routes = j?.routes || [];
      if (!routes.length) throw new Error("no route");

      // Alternative routes (gray dashed)
      routes.slice(1).forEach(alt => {
        const coords = alt.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
        const km     = (alt.distance / 1000).toFixed(1);
        const min    = Math.round(alt.duration / 60);
        L.polyline(coords, { color: "#94a3b8", weight: 5, opacity: 0.75, dashArray: "8 7" })
          .addTo(meetRouteLayer)
          .bindTooltip(`${t("ride_alt_route", "Alternative")} · ${km} km · ${min} min`, { sticky: true });
      });

      // Primary route (gold, to distinguish from pickup→dropoff green)
      const primary = routes[0];
      const km     = (primary.distance / 1000);
      const min    = Math.round(primary.duration / 60);
      const coords = primary.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      L.polyline(coords, { color: "#d4af37", weight: 6, opacity: 0.95 })
        .addTo(meetRouteLayer)
        .bindTooltip(`${esc(label || "")} · ${km.toFixed(1)} km · ${min} min`, { sticky: true })
        .openTooltip(L.latLng(coords[Math.floor(coords.length / 2)]));

      const bounds = L.latLngBounds([[lastFix.lat, lastFix.lng], [targetLat, targetLng]]);
      map.fitBounds(bounds, { padding: [60, 60], maxZoom: 15 });
    } catch (e) {
      console.warn("meet route", e);
      // Fallback: straight line
      L.polyline([[lastFix.lat, lastFix.lng], [targetLat, targetLng]],
        { color: "#d4af37", weight: 4, dashArray: "6 8" }).addTo(meetRouteLayer);
    }
  }

  function uniLabel(k) {
    return ({
      university: t("ride_uni", "University"),
      college:    t("ride_college", "College"),
      institute:  t("ride_institute", "Institute"),
    }[k] || k);
  }
  function makeUniIcon(kind) {
    const palette = {
      university: { bg: "#5b21b6", emoji: "🎓" },
      college:    { bg: "#7c3aed", emoji: "🏛" },
      institute:  { bg: "#0369a1", emoji: "🏫" },
    };
    const p = palette[kind] || palette.university;
    return L.divIcon({
      className: "ride-pin pin-uni",
      html: `<div class="pin-uni-bubble" style="background:${p.bg}">${p.emoji}</div>`,
      iconSize: [26, 26], iconAnchor: [13, 13]
    });
  }

  function makeMyIcon() {
    return L.divIcon({
      className: "ride-pin pin-self",
      html: `<div class="pin-pulse role-guest"><span></span></div>`,
      iconSize: [30, 30], iconAnchor: [15, 15]
    });
  }
  function makePinIcon(kind) {
    const color = kind === "pickup" ? "#00cfff" : "#d4af37";
    const label = kind === "pickup" ? "A" : "B";
    return L.divIcon({
      className: "ride-pin",
      html: `<div class="pin-flag" style="background:${color};color:#fff">${label}</div>`,
      iconSize: [28, 36], iconAnchor: [14, 32], popupAnchor: [0, -28]
    });
  }
  function makeDriverIcon(v) {
    return L.divIcon({
      className: "ride-pin pin-driver",
      html: `<div class="pin-driver-bubble">${vehicleEmoji(v)}</div>`,
      iconSize: [34, 34], iconAnchor: [17, 17]
    });
  }
  function makeGhostDriverIcon(v, heading) {
    const h = (heading == null || isNaN(heading)) ? null : Number(heading);
    const arrow = (h != null)
      ? `<span class="pin-arrow" style="transform: rotate(${h}deg)"></span>`
      : "";
    return L.divIcon({
      className: "ride-pin pin-driver-ghost",
      html: `<div class="pin-driver-ghost">${vehicleEmoji(v)}${arrow}</div>`,
      iconSize: [26, 26], iconAnchor: [13, 13]
    });
  }
};

// Major Tanzanian universities, colleges & institutes
// Coordinates are approximate centroids of the campus, used for map markers.
const TZ_UNIVERSITIES = [
  // Dar es Salaam
  { name: "University of Dar es Salaam (UDSM)",                   kind: "university", city: "Dar es Salaam", lat: -6.7798, lng: 39.2069 },
  { name: "Muhimbili University of Health & Allied Sciences",     kind: "university", city: "Dar es Salaam", lat: -6.8094, lng: 39.2784 },
  { name: "Ardhi University",                                     kind: "university", city: "Dar es Salaam", lat: -6.7733, lng: 39.2103 },
  { name: "Open University of Tanzania",                          kind: "university", city: "Dar es Salaam", lat: -6.8369, lng: 39.2697 },
  { name: "Hubert Kairuki Memorial University",                   kind: "university", city: "Dar es Salaam", lat: -6.7600, lng: 39.2350 },
  { name: "International Medical & Technological University",     kind: "university", city: "Dar es Salaam", lat: -6.7980, lng: 39.2540 },
  { name: "Kampala International University - Dar es Salaam",     kind: "university", city: "Dar es Salaam", lat: -6.8161, lng: 39.2803 },
  { name: "Dar es Salaam Tumaini University",                     kind: "university", city: "Dar es Salaam", lat: -6.8210, lng: 39.2770 },
  { name: "Dar es Salaam Institute of Technology (DIT)",          kind: "institute",  city: "Dar es Salaam", lat: -6.8167, lng: 39.2833 },
  { name: "Institute of Finance Management (IFM)",                kind: "institute",  city: "Dar es Salaam", lat: -6.8169, lng: 39.2871 },
  { name: "College of Business Education (CBE)",                  kind: "college",    city: "Dar es Salaam", lat: -6.8156, lng: 39.2809 },
  { name: "National Institute of Transport (NIT)",                kind: "institute",  city: "Dar es Salaam", lat: -6.8240, lng: 39.2440 },
  { name: "Tanzania Institute of Accountancy (TIA)",              kind: "institute",  city: "Dar es Salaam", lat: -6.8196, lng: 39.2800 },

  // Morogoro
  { name: "Sokoine University of Agriculture (SUA)",              kind: "university", city: "Morogoro",      lat: -6.8489, lng: 37.6533 },
  { name: "Mzumbe University",                                    kind: "university", city: "Morogoro",      lat: -6.9158, lng: 37.4944 },
  { name: "Jordan University College",                            kind: "college",    city: "Morogoro",      lat: -6.8167, lng: 37.6833 },

  // Dodoma
  { name: "University of Dodoma (UDOM)",                          kind: "university", city: "Dodoma",        lat: -6.1810, lng: 35.7780 },
  { name: "St. John's University of Tanzania",                    kind: "university", city: "Dodoma",        lat: -6.1660, lng: 35.7480 },
  { name: "College of Business Education - Dodoma",               kind: "college",    city: "Dodoma",        lat: -6.1700, lng: 35.7390 },

  // Arusha
  { name: "Nelson Mandela African Institute of Science & Tech.",  kind: "institute",  city: "Arusha",        lat: -3.4032, lng: 36.7867 },
  { name: "Mount Meru University",                                kind: "university", city: "Arusha",        lat: -3.3700, lng: 36.6900 },
  { name: "Tumaini University Makumira",                          kind: "university", city: "Usa River",     lat: -3.3300, lng: 36.8900 },
  { name: "Institute of Accountancy Arusha (IAA)",                kind: "institute",  city: "Arusha",        lat: -3.3600, lng: 36.6800 },

  // Mwanza
  { name: "St. Augustine University of Tanzania (SAUT)",          kind: "university", city: "Mwanza",        lat: -2.5717, lng: 32.8967 },
  { name: "Catholic University of Health & Allied Sciences",      kind: "university", city: "Mwanza",        lat: -2.5169, lng: 32.9192 },
  { name: "Mwanza University",                                    kind: "university", city: "Mwanza",        lat: -2.5333, lng: 32.9000 },

  // Moshi / Kilimanjaro
  { name: "Mwenge Catholic University",                           kind: "university", city: "Moshi",         lat: -3.3500, lng: 37.3300 },
  { name: "Stefano Moshi Memorial University College",            kind: "college",    city: "Moshi",         lat: -3.3300, lng: 37.3500 },
  { name: "Kilimanjaro Christian Medical University College",     kind: "college",    city: "Moshi",         lat: -3.3520, lng: 37.3440 },

  // Iringa
  { name: "University of Iringa",                                 kind: "university", city: "Iringa",        lat: -7.7700, lng: 35.7000 },
  { name: "Mkwawa University College of Education (MUCE)",        kind: "college",    city: "Iringa",        lat: -7.7670, lng: 35.6790 },
  { name: "Ruaha Catholic University (RUCU)",                     kind: "university", city: "Iringa",        lat: -7.7730, lng: 35.6900 },

  // Mbeya
  { name: "Mbeya University of Science & Technology",             kind: "university", city: "Mbeya",         lat: -8.9180, lng: 33.4520 },
  { name: "Teofilo Kisanji University",                           kind: "university", city: "Mbeya",         lat: -8.9050, lng: 33.4500 },

  // Tanga / Zanzibar / Mtwara / Bukoba
  { name: "Eckernforde Tanga University",                         kind: "university", city: "Tanga",         lat: -5.0700, lng: 39.0950 },
  { name: "State University of Zanzibar (SUZA)",                  kind: "university", city: "Zanzibar",      lat: -6.1663, lng: 39.2026 },
  { name: "Zanzibar University",                                  kind: "university", city: "Zanzibar",      lat: -6.1340, lng: 39.2070 },
  { name: "Stella Maris Mtwara University College",               kind: "college",    city: "Mtwara",        lat: -10.2667,lng: 40.1833 },
  { name: "Bugando University - College",                         kind: "college",    city: "Mwanza",        lat: -2.5160, lng: 32.9180 },
  { name: "Kampala International University - Bukoba",            kind: "college",    city: "Bukoba",        lat: -1.3300, lng: 31.8120 },
  { name: "Tabora Teachers College",                              kind: "college",    city: "Tabora",        lat: -5.0200, lng: 32.8030 },
];

// Tanzania context cities
const TZ_CITIES = [
  { name: "Dar es Salaam", lat: -6.7924, lng: 39.2083 },
  { name: "Dodoma",        lat: -6.1722, lng: 35.7395 },
  { name: "Mwanza",        lat: -2.5164, lng: 32.9175 },
  { name: "Arusha",        lat: -3.3869, lng: 36.6829 },
  { name: "Mbeya",         lat: -8.9000, lng: 33.4500 },
  { name: "Morogoro",      lat: -6.8278, lng: 37.6591 },
  { name: "Tanga",         lat: -5.0700, lng: 39.0992 },
  { name: "Iringa",        lat: -7.7706, lng: 35.6904 },
  { name: "Tabora",        lat: -5.0167, lng: 32.8000 },
  { name: "Kigoma",        lat: -4.8770, lng: 29.6260 },
  { name: "Songea",        lat: -10.6833, lng: 35.6500 },
  { name: "Sumbawanga",    lat: -7.9667, lng: 31.6167 },
  { name: "Bukoba",        lat: -1.3290, lng: 31.8120 },
  { name: "Musoma",        lat: -1.5000, lng: 33.8000 },
  { name: "Singida",       lat: -4.8167, lng: 34.7500 },
  { name: "Shinyanga",     lat: -3.6603, lng: 33.4214 },
  { name: "Lindi",         lat: -10.0000, lng: 39.7167 },
  { name: "Mtwara",        lat: -10.2667, lng: 40.1833 },
  { name: "Moshi",         lat: -3.3500, lng: 37.3333 }
];
