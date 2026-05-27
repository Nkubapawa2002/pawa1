// ============================================================================
//  Meet & Locate — realtime GPS rooms over Tanzania
//  Stack:
//    - Leaflet + OpenStreetMap (free, no API key)
//    - Supabase Realtime channel on `live_locations`
//    - Browser geolocation watchPosition
//    - Open-Meteo for current weather (free, no API key)
//
//  Two or more people enter the same 6-character room code; everyone sees
//  every other person move on the map in real time, with weather, distance,
//  ETA, and one-tap navigation.
// ============================================================================

window.initMeetPage = () => {
  const cfg = window.APP_CONFIG;
  const sb  = window.DataStore?.sb;

  // ---- Element references -------------------------------------------------
  const lobby            = document.getElementById("meetLobby");
  const roomEl           = document.getElementById("meetRoom");
  const createRoomBtn    = document.getElementById("createRoomBtn");
  const joinRoomBtn      = document.getElementById("joinRoomBtn");
  const joinErr          = document.getElementById("joinErr");
  const roomCodeDisplay  = document.getElementById("roomCodeDisplay");
  const roomPurposeEl    = document.getElementById("roomPurpose");
  const roomMembersEl    = document.getElementById("roomMembers");
  const recenterBtn      = document.getElementById("recenterBtn");
  const leaveRoomBtn     = document.getElementById("leaveRoomBtn");
  const copyCodeBtn      = document.getElementById("copyCodeBtn");
  const shareCodeBtn     = document.getElementById("shareCodeBtn");
  const weatherBody      = document.getElementById("weatherBody");
  const closestCard      = document.getElementById("closestCard");
  const closestBody      = document.getElementById("closestBody");
  const rosterEl         = document.getElementById("roster");
  const customStatusEl   = document.getElementById("customStatus");
  const chatMsgsEl       = document.getElementById("chatMessages");
  const chatBadgeEl      = document.getElementById("chatUnreadBadge");
  const sideUnreadDot    = document.getElementById("sideUnreadDot");
  const chatInputEl      = document.getElementById("chatInput");
  const chatSendBtn      = document.getElementById("chatSendBtn");

  // ---- State --------------------------------------------------------------
  const TANZANIA_CENTER = [-6.369028, 34.888822];   // mainland TZ centroid
  const TANZANIA_BOUNDS = [[-11.75, 29.34], [-0.99, 40.45]];

  let map           = null;
  let myMarker      = null;
  let myAccuracy    = null;
  const peers       = new Map();   // user_id -> { marker, line, data, roadDistKm, roadDurMin }
  let watchId       = null;
  let pushTimer     = null;
  let lastPushed    = 0;
  let activeRoom    = null;        // { code, purpose, ... }
  let myUserId      = ensureUserId();
  let myProfile     = null;
  let realtimeCh    = null;
  let weatherTimer  = null;
  let lastFix       = null;        // {lat,lng,accuracy,heading,speed}
  let batteryRef    = null;
  let lastRosterRows = [];         // cache for road-distance re-renders
  let myStreetAddr   = "";         // my own street address from reverse geocode
  let myLastGeocodedPos = null;
  let chatMessages   = [];
  let chatUnread     = 0;

  // Watch battery once
  if (navigator.getBattery) {
    navigator.getBattery().then(b => { batteryRef = b; }).catch(() => {});
  }

  // Restore room if user refreshed while inside one
  const persisted = readPersisted();
  if (persisted?.code) {
    enterRoom(persisted).catch(() => clearPersisted());
  }

  // ---- Lobby actions ------------------------------------------------------
  createRoomBtn?.addEventListener("click", async () => {
    const name = document.getElementById("createName").value.trim();
    const role = document.getElementById("createRole").value;
    const purpose = document.getElementById("createPurpose").value;
    const tracking = document.getElementById("createTracking").value.trim() || null;
    if (!name) { alert(window.t("meet_need_name") || "Please enter your name"); return; }

    createRoomBtn.disabled = true;
    createRoomBtn.textContent = "…";
    try {
      const code = await createRoom({ purpose, tracking, created_by: name });
      myProfile = { name, role };
      await enterRoom({ code, purpose, tracking_code: tracking });
    } catch (e) {
      alert(e.message || "Could not create room");
    } finally {
      createRoomBtn.disabled = false;
      createRoomBtn.textContent = window.t("meet_create_btn") || "Create room";
    }
  });

  joinRoomBtn?.addEventListener("click", async () => {
    const name = document.getElementById("joinName").value.trim();
    const role = document.getElementById("joinRole").value;
    const code = document.getElementById("joinCode").value.trim().toUpperCase();
    joinErr.style.display = "none";
    if (!name) { joinErr.textContent = window.t("meet_need_name") || "Please enter your name"; joinErr.style.display = "block"; return; }
    if (code.length < 4) { joinErr.textContent = window.t("meet_bad_code") || "Code looks too short"; joinErr.style.display = "block"; return; }

    joinRoomBtn.disabled = true;
    joinRoomBtn.textContent = "…";
    try {
      const room = await fetchRoom(code);
      if (!room) throw new Error(window.t("meet_room_not_found") || "Room not found or expired");
      myProfile = { name, role };
      await enterRoom(room);
    } catch (e) {
      joinErr.textContent = e.message;
      joinErr.style.display = "block";
    } finally {
      joinRoomBtn.disabled = false;
      joinRoomBtn.textContent = window.t("meet_join_btn") || "Join room";
    }
  });

  // ---- Room lifecycle -----------------------------------------------------
  async function enterRoom(room) {
    activeRoom = room;
    persistRoom(room);

    // Restore profile from session if needed (page-refresh case)
    if (!myProfile) {
      const saved = JSON.parse(sessionStorage.getItem("meet_profile") || "null");
      myProfile = saved || { name: "Me", role: "guest" };
    }
    sessionStorage.setItem("meet_profile", JSON.stringify(myProfile));

    lobby.hidden = true;
    roomEl.hidden = false;
    roomCodeDisplay.textContent = room.code;
    // Mirror the code into the big share card in the side panel.
    const sideCode = document.getElementById("shareCodeDisplay");
    if (sideCode) sideCode.textContent = room.code;
    roomPurposeEl.textContent = labelPurpose(room.purpose);

    applyMobileLayout();
    initMap();
    await refreshRoster();
    subscribeRealtime();
    startGeolocate();
    startWeatherLoop();

    // On phones, the side panel (chat/roster/weather/status) is a bottom
    // sheet hidden by default. Auto-expand it on room entry so users see
    // all the same features that PC users see in their persistent side
    // panel — matching PC parity, not a hidden discovery step.
    if (window.matchMedia && window.matchMedia("(max-width: 900px)").matches) {
      document.getElementById("meetSide")?.classList.add("expanded");
    }

    setTimeout(() => map?.resize(), 200);
    setTimeout(() => map?.resize(), 700);
  }

  async function leaveRoom(silent = false) {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    if (pushTimer)    { clearInterval(pushTimer);    pushTimer    = null; }
    if (weatherTimer) { clearInterval(weatherTimer); weatherTimer = null; }
    if (realtimeCh)   { realtimeCh.unsubscribe?.();  realtimeCh   = null; }
    watchId = null;

    if (!silent && sb && activeRoom?.code) {
      try {
        await sb.from("live_locations")
          .delete()
          .match({ room_code: activeRoom.code, user_id: myUserId });
      } catch {}
    }

    peers.forEach(p => {
      p.marker?.remove();
      if (p.sourceId && map) {
        try {
          if (map.getLayer(p.sourceId + "fg")) map.removeLayer(p.sourceId + "fg");
          if (map.getLayer(p.sourceId + "bg")) map.removeLayer(p.sourceId + "bg");
          if (map.getSource(p.sourceId))       map.removeSource(p.sourceId);
        } catch(e) {}
      }
    });
    peers.clear();
    if (myMarker) { myMarker.remove(); myMarker = null; }
    if (map) { map._cleanupFn?.(); map.remove(); map = null; }

    clearPersisted();
    activeRoom = null;
    window._meetMap = null;
    const mwc = document.getElementById("mapWeatherCard");
    if (mwc) mwc.hidden = true;
    const mrc = document.getElementById("mapRosterCard");
    if (mrc) mrc.innerHTML = "";
    chatMessages = [];
    chatUnread   = 0;
    if (chatBadgeEl)   { chatBadgeEl.hidden = true; chatBadgeEl.textContent = ""; }
    if (sideUnreadDot) sideUnreadDot.hidden = true;
    if (chatMsgsEl)    chatMsgsEl.innerHTML = '<p class="chat-empty">No messages yet — say hi!</p>';
    if (chatInputEl)   chatInputEl.value = "";
    clearMobileLayout();
    roomEl.hidden = true;
    lobby.hidden  = false;
  }

  // ---- Mobile full-screen layout (JS pixel sizes — bypasses all CSS issues) ----
  function applyMobileLayout() {
    if (window.innerWidth > 900) return;
    const TOPBAR_H = 52;
    // visualViewport excludes browser address bar & bottom nav on mobile
    const vh = (window.visualViewport ? window.visualViewport.height : window.innerHeight);
    const stageH = vh - TOPBAR_H;

    roomEl.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:" + vh + "px;" +
      "z-index:500;display:block;background:#111;";

    const stage = document.querySelector(".meet-stage");
    stage.style.cssText =
      "position:absolute;top:" + TOPBAR_H + "px;left:0;right:0;" +
      "width:100%;height:" + stageH + "px;overflow:hidden;display:block;";

    const mapEl = document.getElementById("map");
    mapEl.style.cssText =
      "position:absolute;top:0;left:0;right:0;bottom:0;" +
      "width:100%;height:" + stageH + "px;" +
      "border-radius:0;border:none;box-shadow:none;";

    const topbar = document.querySelector(".meet-topbar");
    topbar.style.cssText =
      "position:absolute;top:0;left:0;right:0;height:" + TOPBAR_H + "px;" +
      "z-index:20;background:white;border-bottom:1px solid #e5e7eb;" +
      "display:flex;align-items:center;padding:0 10px;gap:6px;" +
      "box-sizing:border-box;overflow:hidden;";
  }

  function clearMobileLayout() {
    [roomEl,
     document.querySelector(".meet-stage"),
     document.getElementById("map"),
     document.querySelector(".meet-topbar")
    ].forEach(el => { if (el) el.style.cssText = ""; });
  }

  leaveRoomBtn?.addEventListener("click", () => { if (confirm(window.t("meet_leave_confirm") || "Leave this room?")) leaveRoom(); });
  document.getElementById("backRoomBtn")?.addEventListener("click", () => { if (confirm(window.t("meet_leave_confirm") || "Leave this room?")) leaveRoom(); });
  recenterBtn?.addEventListener("click", () => {
    if (lastFix && map) map.easeTo({ center: [lastFix.lng, lastFix.lat], zoom: 15, animate: true });
  });
  document.getElementById("mapRecenterBtn")?.addEventListener("click", () => {
    if (lastFix && map) map.easeTo({ center: [lastFix.lng, lastFix.lat], zoom: 15, animate: true });
  });

  // Fit-all: zoom out so every roster member (me + peers) is visible.
  document.getElementById("fabFitAll")?.addEventListener("click", () => {
    if (!map) return;
    const pts = [];
    if (lastFix) pts.push([lastFix.lng, lastFix.lat]);
    for (const p of peers.values()) pts.push([p.data.lng, p.data.lat]);
    if (pts.length < 2) {
      if (pts.length === 1) map.easeTo({ center: pts[0], zoom: 14 });
      return;
    }
    const lngs = pts.map(p => p[0]), lats = pts.map(p => p[1]);
    map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
                  { padding: 80, maxZoom: 16, duration: 600 });
  });

  // Style toggle: cycle between satellite (default) and a clean street view
  // so users on a busy map can switch to higher legibility when navigating.
  let _styleMode = "satellite";
  document.getElementById("fabStyle")?.addEventListener("click", () => {
    if (!map) return;
    _styleMode = _styleMode === "satellite" ? "streets" : "satellite";
    if (_styleMode === "streets") {
      map.setStyle({
        version: 8,
        sources: {
          osm: { type: "raster", tileSize: 256, maxzoom: 19,
                 tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
                 attribution: "© OpenStreetMap contributors" }
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }]
      });
    } else {
      // Re-init brings back satellite + overlays + all peer layers.
      const here = map.getCenter(), z = map.getZoom();
      map.remove();
      initMap();
      map.once("load", () => map.jumpTo({ center: here, zoom: z }));
    }
  });
  const sidePull = document.getElementById("sidePull");
  const meetSide = document.getElementById("meetSide");
  // Helper: update the side-pull label so users have a clear affordance
  // to collapse the expanded panel back to its normal hint.
  const syncSidePullLabel = () => {
    const lbl = sidePull?.querySelector(".side-pull-label");
    if (!lbl) return;
    const isExp = meetSide?.classList.contains("expanded");
    lbl.innerHTML = isExp
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg> Minimize`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Chat & info`;
  };
  sidePull?.addEventListener("click", () => {
    const expanded = meetSide.classList.toggle("expanded");
    syncSidePullLabel();
    if (expanded && map) setTimeout(() => map.resize(), 320);
    if (expanded) {
      chatUnread = 0;
      if (chatBadgeEl)   { chatBadgeEl.hidden = true; chatBadgeEl.textContent = ""; }
      if (sideUnreadDot) sideUnreadDot.hidden = true;
    }
  });
  // Initial label + react to auto-expand on room entry
  setTimeout(syncSidePullLabel, 50);
  new MutationObserver(syncSidePullLabel).observe(meetSide || document.body,
    { attributes: true, attributeFilter: ["class"] });
  // Tap on map collapses the drawer
  document.getElementById("map")?.addEventListener("click", () => {
    meetSide?.classList.remove("expanded");
  });
  copyCodeBtn?.addEventListener("click", () => {
    if (!activeRoom) return;
    navigator.clipboard.writeText(activeRoom.code).then(() => {
      copyCodeBtn.textContent = window.t("action_copied") || "Copied";
      setTimeout(() => copyCodeBtn.textContent = window.t("action_copy") || "Copy", 1500);
    });
  });
  // The big share-card buttons in the side panel just trigger the same
  // handlers as the small topbar buttons.
  document.getElementById("copyCodeBig")?.addEventListener("click", () => copyCodeBtn?.click());
  document.getElementById("shareCodeBig")?.addEventListener("click", () => shareCodeBtn?.click());
  shareCodeBtn?.addEventListener("click", () => {
    if (!activeRoom) return;
    const url  = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}meet.html?code=${activeRoom.code}`;
    const text = `${window.t("meet_share_text") || "Join me on Pawa Cargo Meet"}: ${activeRoom.code}\n${url}`;
    if (navigator.share) navigator.share({ title: "Pawa Meet", text, url }).catch(() => {});
    else                 navigator.clipboard.writeText(text);
  });

  // Quick status broadcasts
  document.querySelectorAll(".quick-status").forEach(btn => {
    btn.addEventListener("click", () => pushStatus(window.t(btn.dataset.status) || btn.textContent));
  });
  customStatusEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      pushStatus(customStatusEl.value.trim());
      customStatusEl.value = "";
    }
  });

  chatSendBtn?.addEventListener("click", () => {
    const text = chatInputEl?.value.trim();
    if (text && activeRoom) { sendChatMessage(text); chatInputEl.value = ""; }
  });
  chatInputEl?.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = chatInputEl.value.trim();
      if (text && activeRoom) { sendChatMessage(text); chatInputEl.value = ""; }
    }
  });

  // Auto-join via ?code=XXXX
  const params = new URLSearchParams(location.search);
  if (params.get("code")) {
    document.getElementById("joinCode").value = params.get("code").toUpperCase();
    document.getElementById("joinName").focus();
  }

  // ====================================================================
  //  Map
  // ====================================================================
  function initMap() {
    const _mbToken = window.APP_CONFIG?.MAPBOX_TOKEN || "";
    // Use Mapbox satellite when a token is set; fall back to free OSM raster tiles
    // when it isn't, so the map still renders on deployments without a Mapbox key.
    const style = _mbToken
      ? {
          version: 8,
          glyphs: `https://api.mapbox.com/fonts/v1/mapbox/{fontstack}/{range}.pbf?access_token=${_mbToken}`,
          sprite: `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/sprite?access_token=${_mbToken}`,
          sources: {
            satellite: {
              type: "raster",
              tiles: [`https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/512/{z}/{x}/{y}?access_token=${_mbToken}`],
              tileSize: 512,
              attribution: "© <a href='https://www.mapbox.com/about/maps/'>Mapbox</a> © <a href='http://www.openstreetmap.org/copyright'>OpenStreetMap</a>"
            }
          },
          layers: [{ id: "satellite", type: "raster", source: "satellite" }]
        }
      : {
          // Esri World Imagery (satellite) + Esri reference overlays for
          // roads/transportation and place/country labels — gives a "hybrid"
          // satellite-with-streets view like Google Maps Hybrid. All free,
          // no token required.
          version: 8,
          sources: {
            esri: {
              type: "raster",
              tiles: [
                "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
              ],
              tileSize: 256,
              maxzoom: 19,
              attribution: "Tiles © <a href='https://www.esri.com/'>Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community"
            },
            esri_transport: {
              type: "raster",
              tiles: [
                "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"
              ],
              tileSize: 256,
              maxzoom: 19
            },
            esri_labels: {
              type: "raster",
              tiles: [
                "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
              ],
              tileSize: 256,
              maxzoom: 19
            },
            // Carto Voyager labels-only — adds street names + POIs on top of
            // the Esri satellite imagery so users can read street labels
            // when zoomed into a neighbourhood (Esri's transport/places
            // layers alone don't show street names).
            carto_streets: {
              type: "raster",
              tiles: [
                "https://a.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
                "https://b.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
                "https://c.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
                "https://d.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png"
              ],
              tileSize: 256,
              maxzoom: 19,
              attribution: "© <a href='https://carto.com/attributions'>CARTO</a> © OpenStreetMap contributors"
            }
          },
          layers: [
            { id: "esri",           type: "raster", source: "esri" },
            { id: "esri_transport", type: "raster", source: "esri_transport" },
            { id: "esri_labels",    type: "raster", source: "esri_labels" },
            // Show street labels from zoom 12 upward (city/neighbourhood
            // level) — at lower zooms the Esri labels are enough and
            // overlaying both gets cluttered.
            { id: "carto_streets",  type: "raster", source: "carto_streets",
              minzoom: 12 }
          ]
        };
    map = new maplibregl.Map({
      container: "map",
      style,
      center: [TANZANIA_CENTER[1], TANZANIA_CENTER[0]], // MapLibre: [lng, lat]
      zoom: 6,
      maxBounds: [[29.34, -11.75], [40.45, -0.99]],
      attributionControl: true
    });

    window._meetMap = map;
    window._peers   = peers;

    const _onResize = () => { applyMobileLayout(); setTimeout(() => map?.resize(), 50); };
    window.addEventListener("resize", _onResize);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", _onResize);
    map._cleanupFn = () => {
      window.removeEventListener("resize", _onResize);
      if (window.visualViewport) window.visualViewport.removeEventListener("resize", _onResize);
    };

    map.on("load", () => {
      // TZ city context dots — bright green pins visible at low zoom over satellite
      map.addSource("tz-cities", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: TZ_CITIES.map(c => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [c.lng, c.lat] },
            properties: { name: c.name }
          }))
        }
      });
      map.addLayer({ id: "tz-city-dots", type: "circle", source: "tz-cities",
        minzoom: 3, maxzoom: 9,
        paint: { "circle-color": "#0a6630", "circle-radius": 4, "circle-opacity": 0.65,
                 "circle-stroke-color": "#fff", "circle-stroke-width": 1 }
      });
      map.addLayer({ id: "tz-city-names", type: "symbol", source: "tz-cities",
        minzoom: 4, maxzoom: 9,
        layout: { "text-field": ["get", "name"], "text-size": 11,
                  "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Regular"],
                  "text-anchor": "top", "text-offset": [0, 0.5] },
        paint: { "text-color": "#00ff88", "text-halo-color": "rgba(0,0,0,0.8)", "text-halo-width": 1.5 }
      });

      if (window.TZ_UNIVERSITIES) {
        map.addSource("tz-unis", {
          type: "geojson",
          data: {
            type: "FeatureCollection",
            features: window.TZ_UNIVERSITIES.map(u => ({
              type: "Feature",
              geometry: { type: "Point", coordinates: [u.lng, u.lat] },
              properties: { name: u.name, kind: u.kind || "" }
            }))
          }
        });
        map.addLayer({ id: "tz-uni-dots", type: "circle", source: "tz-unis",
          minzoom: 7,
          paint: { "circle-color": "#7c3aed", "circle-radius": 5, "circle-opacity": 0.7,
                   "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 }
        });
      }

      // All-pairs connecting lines with distance labels
      map.addSource("meet-peer-lines",  { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("meet-peer-labels", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "meet-lines-bg", type: "line", source: "meet-peer-lines",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": 5, "line-opacity": 0.35 }
      });
      map.addLayer({ id: "meet-lines-fg", type: "line", source: "meet-peer-lines",
        layout: { "line-cap": "butt", "line-join": "round" },
        paint: { "line-color": "#38bdf8", "line-width": 2, "line-opacity": 0.9,
                 "line-dasharray": [5, 3] }
      });
      map.addLayer({ id: "meet-lines-dist", type: "symbol", source: "meet-peer-labels",
        layout: {
          "text-field": ["get", "dist"],
          "text-size": 11,
          "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Regular"],
          "text-anchor": "center",
          "text-allow-overlap": true,
          "text-ignore-placement": true
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "rgba(0,0,0,0.8)",
          "text-halo-width": 1.5
        }
      });
    });
  }

  // ====================================================================
  //  Geolocation
  // ====================================================================
  function startGeolocate() {
    if (!navigator.geolocation) {
      weatherBody.innerHTML = `<span class="error-text">${window.t("meet_no_gps") || "Your browser doesn't support GPS."}</span>`;
      return;
    }

    // iOS Safari 14+ sometimes doesn't pop the permission prompt for
    // watchPosition() alone — getCurrentPosition() reliably does. Fire a
    // one-shot first so the prompt appears; on success start watching.
    weatherBody.innerHTML = `<span class="muted">Waiting for GPS permission…</span>`;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onFix(pos);
        watchId = navigator.geolocation.watchPosition(
          onFix,
          onGeoError,
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
        );
      },
      onGeoError,
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );

    // Throttled push of own location to DB (every 5 s minimum)
    pushTimer = setInterval(() => {
      if (lastFix && Date.now() - lastPushed > 4500) pushMyLocation();
    }, 1000);
  }

  function onFix(pos) {
    const { latitude: lat, longitude: lng, accuracy, heading, speed } = pos.coords;
    lastFix = { lat, lng, accuracy, heading, speed };

    if (!myMarker) {
      const el = makeMyIconEl(myProfile.role, heading);
      myMarker = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([lng, lat])
        .setPopup(new maplibregl.Popup({ offset: 28, closeButton: true, closeOnClick: true, maxWidth: "240px" }).setHTML(myPopupHtml()))
        .addTo(map);
      map.easeTo({ center: [lng, lat], zoom: 15, animate: true });
    } else {
      const prev = myMarker.getLngLat();
      animateMarker(myMarker, [prev.lat, prev.lng], [lat, lng]);
      myMarker.getElement().innerHTML = makeMyIconInner(myProfile.role, heading);
    }
    // Fetch my street name if moved >80 m
    const needsMyGeocode = !myLastGeocodedPos ||
      haversineKm(myLastGeocodedPos[0], myLastGeocodedPos[1], lat, lng) > 0.08;
    if (needsMyGeocode) {
      myLastGeocodedPos = [lat, lng];
      fetchAddress(lat, lng).then(addr => {
        if (!addr) return;
        myStreetAddr = addr.street ? addr.street + (addr.suburb ? ", " + addr.suburb : "") : addr.suburb;
        myMarker?.getPopup()?.setHTML(myPopupHtml());
      });
    }
    pushMyLocation();
    updateAllPeerLines();
  }

  function onGeoError(err) {
    console.warn("geo", err);
    // Surface every error type, not just PERMISSION_DENIED, so users on iOS
    // see what's actually happening when GPS silently fails.
    let msg = "Location unavailable.";
    if (err.code === err.PERMISSION_DENIED) {
      msg = "Location permission denied. iOS: Settings → Safari → Location → Allow. Then reload this page.";
    } else if (err.code === err.POSITION_UNAVAILABLE) {
      msg = "Phone can't get a GPS fix right now. Try going outside, or toggle Location Services off and on.";
    } else if (err.code === err.TIMEOUT) {
      msg = "GPS timed out. Try again — sometimes the first fix takes 30s indoors.";
    }
    weatherBody.innerHTML =
      `<span class="error-text">${msg}</span>` +
      `<br><button type="button" class="btn btn-outline btn-xs" id="retryGeoBtn" style="margin-top:8px">Try again</button>`;
    const retry = document.getElementById("retryGeoBtn");
    if (retry) retry.addEventListener("click", () => startGeolocate());
  }

  async function pushMyLocation() {
    if (!sb || !lastFix || !activeRoom) return;
    // Stop sharing if battery is critically low (let the user know via roster)
    let batt = null;
    if (batteryRef) batt = Math.round(batteryRef.level * 100);
    if (batt != null && batt < 8 && !batteryRef.charging) {
      // Soft-stop: keep the old fix, but don't push new ones to save power
      return;
    }

    lastPushed = Date.now();
    try {
      await sb.from("live_locations").upsert({
        room_code:    activeRoom.code,
        user_id:      myUserId,
        display_name: myProfile.name,
        phone:        myProfile.phone || null,
        role:         myProfile.role || "guest",
        lat:          lastFix.lat,
        lng:          lastFix.lng,
        accuracy_m:   lastFix.accuracy || null,
        heading:      lastFix.heading || null,
        speed_mps:    lastFix.speed || null,
        battery_pct:  batt,
        last_seen:    new Date().toISOString()
      }, { onConflict: "room_code,user_id" });
    } catch (e) {
      console.warn("push", e);
    }
  }

  async function pushStatus(text) {
    if (!sb || !activeRoom || !text) return;
    try {
      await sb.from("live_locations").update({
        status_text: text,
        last_seen: new Date().toISOString()
      }).match({ room_code: activeRoom.code, user_id: myUserId });
    } catch {}
  }

  // ====================================================================
  //  Realtime: roster + peer markers
  // ====================================================================
  async function refreshRoster() {
    if (!sb || !activeRoom) return;
    const { data, error } = await sb
      .from("live_locations")
      .select("*")
      .eq("room_code", activeRoom.code)
      .order("last_seen", { ascending: false });
    if (error) { console.warn(error); return; }

    // Drop stale entries (>5 min) so the roster stays clean
    const now = Date.now();
    const fresh = (data || []).filter(r =>
      now - new Date(r.last_seen).getTime() < 5 * 60 * 1000
    );

    // Update peers map
    const seen = new Set();
    for (const row of fresh) {
      seen.add(row.user_id);
      if (row.user_id === myUserId) continue;
      upsertPeer(row);
    }
    // Remove peers no longer present
    for (const [uid, p] of peers.entries()) {
      if (!seen.has(uid)) {
        p.marker?.remove();
        p.line?.remove();
        peers.delete(uid);
      }
    }

    lastRosterRows = fresh;
    renderRoster(fresh);
    renderClosest();
    updateAllPeerLines();
  }

  function subscribeRealtime() {
    if (!sb || !activeRoom) return;
    realtimeCh = sb.channel(`meet_${activeRoom.code}`)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "live_locations",
        filter: `room_code=eq.${activeRoom.code}`
      }, () => refreshRoster())
      .on("broadcast", { event: "chat" }, ({ payload }) => receiveChatMessage(payload))
      .subscribe();
  }

  function upsertPeer(row) {
    const pos = [row.lat, row.lng];
    let p = peers.get(row.user_id);
    if (!p) {
      const el = makePeerIconEl(row.role, row.heading, row.display_name);
      const marker = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([row.lng, row.lat])
        .setPopup(new maplibregl.Popup({ offset: 28, closeButton: true, closeOnClick: true, maxWidth: "240px" }).setHTML(peerPopupHtml(row)))
        .addTo(map);
      p = { marker, sourceId: null, data: row, lastRoutedFrom: null, lastGeocodedPos: null };
      peers.set(row.user_id, p);

      // Create GeoJSON route layers (after map finishes loading)
      const sid = "rt" + row.user_id.replace(/[^a-z0-9]/gi, "").slice(0, 20);
      const addRoute = () => {
        if (!map || map.getSource(sid)) return;
        try {
          map.addSource(sid, { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } } });
          map.addLayer({ id: sid + "bg", type: "line", source: sid,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#ffffff", "line-width": 14, "line-opacity": 0 } });
          map.addLayer({ id: sid + "fg", type: "line", source: sid,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": roleColor(row.role), "line-width": 8, "line-opacity": 0 } });
          p.sourceId = sid;
          if (p._pendingRoute) { applyRoute(p, p._pendingRoute); p._pendingRoute = null; }
        } catch(e) { console.warn("route layer", e); }
      };
      if (map.loaded()) addRoute(); else map.once("load", addRoute);
    } else {
      const prev = p.marker.getLngLat();
      animateMarker(p.marker, [prev.lat, prev.lng], pos);
      p.marker.getElement().innerHTML = makePeerIconInner(row.role, row.heading, row.display_name);
      p.marker.getPopup()?.setHTML(peerPopupHtml(row));
      p.data = row;
    }
    // Fetch street address if peer moved >80 m since last geocode
    const needsGeocode = !p.lastGeocodedPos ||
      haversineKm(p.lastGeocodedPos[0], p.lastGeocodedPos[1], row.lat, row.lng) > 0.08;
    if (needsGeocode) {
      p.lastGeocodedPos = [row.lat, row.lng];
      fetchAddress(row.lat, row.lng).then(addr => {
        if (!peers.has(row.user_id) || !addr) return;
        p.streetAddr = addr.street ? addr.street + (addr.suburb ? ", " + addr.suburb : "") : addr.suburb;
        p.marker.setPopupContent(peerPopupHtml(row));
        if (lastRosterRows.length) renderRoster(lastRosterRows);
      });
    }
    // Draw real road route from me to this peer using OSRM
    if (lastFix) {
      const myPos = [lastFix.lat, lastFix.lng];
      const distKm = haversineKm(lastFix.lat, lastFix.lng, row.lat, row.lng);
      const movedSinceRoute = !p.lastRoutedFrom ||
        haversineKm(p.lastRoutedFrom[0], p.lastRoutedFrom[1], lastFix.lat, lastFix.lng) > 0.15;
      if (movedSinceRoute && distKm < 150) {
        p.lastRoutedFrom = myPos;
        fetchRoadRoute(lastFix.lat, lastFix.lng, row.lat, row.lng).then(result => {
          if (!peers.has(row.user_id)) return;
          const fallback = result ? null : { latlngs: [myPos, pos], distKm: null, durMin: null, fallback: true };
          const toApply = result || fallback;
          if (p.sourceId) { applyRoute(p, toApply); }
          else             { p._pendingRoute = toApply; }
          if (result) { p.roadDistKm = result.distKm; p.roadDurMin = result.durMin; }
          if (lastRosterRows.length) { renderRoster(lastRosterRows); renderClosest(); }
        });
      }
    }
  }

  function myPopupHtml() {
    return `<div class="peer-popup">
      <strong>${esc(myProfile?.name || "Me")}</strong> <span class="muted">(you)</span><br>
      <span class="muted">${labelRole(myProfile?.role)}</span>
      ${myStreetAddr ? `<div class="peer-street">📍 ${esc(myStreetAddr)}</div>` : ""}
    </div>`;
  }

  function peerPopupHtml(row) {
    const seenAgo  = humanAgo(row.last_seen);
    const p        = peers.get(row.user_id);
    const roadDist = p?.roadDistKm;
    const roadDur  = p?.roadDurMin;
    const crowDist = lastFix ? haversineKm(lastFix.lat, lastFix.lng, row.lat, row.lng) : null;
    const distLine = roadDist != null
      ? `🛣 <strong>${roadDist.toFixed(1)} km by road</strong> · ~${roadDur} min drive`
      : crowDist != null ? `📐 ${crowDist.toFixed(2)} km (est)` : "";
    return `
      <div class="peer-popup">
        <strong>${esc(row.display_name || "—")}</strong>
        <span class="muted">${labelRole(row.role)}</span>
        ${p?.streetAddr ? `<div class="peer-street">📍 ${esc(p.streetAddr)}</div>` : ""}
        ${row.status_text ? `<div class="peer-status">"${esc(row.status_text)}"</div>` : ""}
        ${distLine ? `<div class="peer-meta">${distLine}</div>` : ""}
        <div class="peer-meta muted">last seen ${seenAgo}</div>
        ${row.phone ? `<a class="btn btn-outline btn-xs" href="tel:${row.phone}">Call</a>` : ""}
        <a class="btn btn-primary btn-xs" target="_blank" rel="noopener"
           href="https://www.google.com/maps/dir/?api=1&destination=${row.lat},${row.lng}">Navigate</a>
      </div>`;
  }

  function renderRoster(rows) {
    roomMembersEl.textContent = rows.length;
    rosterEl.innerHTML = rows.map(r => {
      const isMe     = r.user_id === myUserId;
      const p        = peers.get(r.user_id);
      const roadKm   = p?.roadDistKm;
      const crowKm   = lastFix ? haversineKm(lastFix.lat, lastFix.lng, r.lat, r.lng) : null;
      const distStr  = roadKm != null
        ? (roadKm < 1 ? Math.round(roadKm*1000)+' m' : roadKm.toFixed(1)+' km') + ' 🛣'
        : crowKm != null
          ? (crowKm < 1 ? Math.round(crowKm*1000)+' m' : crowKm.toFixed(1)+' km') + '~'
          : '';
      return `
        <li class="roster-item ${isMe ? 'me' : ''}">
          <span class="roster-dot ${roleColorClass(r.role)}"></span>
          <div class="roster-meta">
            <strong>${esc(r.display_name || "—")} ${isMe ? "<span class='muted'>(you)</span>" : ""}</strong>
            <small class="muted">${labelRole(r.role)} · ${humanAgo(r.last_seen)}</small>
            ${r.status_text ? `<small class="roster-status">"${esc(r.status_text)}"</small>` : ""}
          </div>
          ${distStr && !isMe ? `<span class="roster-dist">${distStr}</span>` : ""}
        </li>`;
    }).join("");

    // Update map roster overlay chips (peers only, not self)
    const mapRoster = document.getElementById("mapRosterCard");
    if (mapRoster) {
      const peers = rows.filter(r => r.user_id !== myUserId);
      mapRoster.innerHTML = peers.map(r => {
        const peer    = window._peers?.get(r.user_id);
        const roadKm  = peer?.roadDistKm;
        const crowKm  = lastFix ? haversineKm(lastFix.lat, lastFix.lng, r.lat, r.lng) : null;
        const distStr = roadKm != null
          ? (roadKm < 1 ? Math.round(roadKm * 1000) + " m" : roadKm.toFixed(1) + " km") + " 🛣"
          : crowKm != null
            ? (crowKm < 1 ? Math.round(crowKm * 1000) + " m" : crowKm.toFixed(1) + " km") + "~"
            : "";
        const color = roleColor(r.role);
        const firstName = esc((r.display_name || "—").split(" ")[0]);
        return `<div class="map-roster-chip" style="--chip-color:${color}"
                     onclick="window._meetMap?.easeTo({center:[${r.lng},${r.lat}],zoom:16})">
          <span class="chip-emoji">${roleEmoji(r.role)}</span>
          <span class="chip-name">${firstName}</span>
          ${distStr ? `<span class="chip-dist">${distStr}</span>` : ""}
        </div>`;
      }).join("");
    }
  }

  function renderClosest() {
    if (!lastFix || peers.size === 0) { closestCard.hidden = true; return; }
    let nearest = null, bestKm = Infinity;
    for (const p of peers.values()) {
      const km = haversineKm(lastFix.lat, lastFix.lng, p.data.lat, p.data.lng);
      if (km < bestKm) { bestKm = km; nearest = p.data; }
    }
    if (!nearest) { closestCard.hidden = true; return; }
    closestCard.hidden = false;
    const nearPeer  = peers.get(nearest.user_id);
    const roadDistKm = nearPeer?.roadDistKm;
    const roadDurMin = nearPeer?.roadDurMin;
    const displayKm  = roadDistKm ?? bestKm;
    const eta        = roadDurMin ?? etaMinutes(displayKm, nearest.speed_mps);
    const within     = displayKm < 0.05;
    const distLabel  = roadDistKm != null
      ? (roadDistKm < 1 ? Math.round(roadDistKm*1000)+" m" : roadDistKm.toFixed(2)+" km") + " by road"
      : (bestKm < 1 ? Math.round(bestKm*1000)+" m" : bestKm.toFixed(2)+" km") + " (est)";
    closestBody.innerHTML = `
      <div class="closest-name">${esc(nearest.display_name)} <span class="muted">${labelRole(nearest.role)}</span></div>
      <div class="closest-distance ${within ? 'arrived' : ''}">
        ${within ? "🎯 You've met!" : `🛣 ${distLabel} away`}
      </div>
      ${!within ? `<div class="muted small">ETA about ${eta} min</div>` : ""}
      <div class="closest-actions">
        ${nearest.phone ? `<a class="btn btn-outline btn-xs" href="tel:${nearest.phone}">Call</a>` : ""}
        <a class="btn btn-primary btn-xs" target="_blank" rel="noopener"
           href="https://www.google.com/maps/dir/?api=1&destination=${nearest.lat},${nearest.lng}">Navigate</a>
      </div>`;
  }

  // ====================================================================
  //  Peer-to-peer connecting lines (all pairs, straight-line distance)
  // ====================================================================
  function updateAllPeerLines() {
    if (!map || !map.loaded()) return;
    const lineSrc = map.getSource("meet-peer-lines");
    const lblSrc  = map.getSource("meet-peer-labels");
    if (!lineSrc || !lblSrc) return;

    const all = [];
    if (lastFix) all.push({ lat: lastFix.lat, lng: lastFix.lng });
    for (const p of peers.values()) all.push({ lat: p.data.lat, lng: p.data.lng });

    const lineFeats = [], lblFeats = [];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        const km   = haversineKm(a.lat, a.lng, b.lat, b.lng);
        const dist = km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(2) + " km";
        lineFeats.push({ type: "Feature",
          geometry: { type: "LineString", coordinates: [[a.lng, a.lat], [b.lng, b.lat]] },
          properties: { dist }
        });
        lblFeats.push({ type: "Feature",
          geometry: { type: "Point", coordinates: [(a.lng + b.lng) / 2, (a.lat + b.lat) / 2] },
          properties: { dist }
        });
      }
    }
    lineSrc.setData({ type: "FeatureCollection", features: lineFeats });
    lblSrc.setData({ type: "FeatureCollection", features: lblFeats });
  }

  // ====================================================================
  //  Room chat (Supabase broadcast — no DB required)
  // ====================================================================
  async function sendChatMessage(text) {
    if (!realtimeCh || !text || !activeRoom) return;
    const msg = {
      id:     Date.now() + "-" + myUserId.slice(0, 6),
      userId: myUserId,
      name:   myProfile?.name || "Me",
      role:   myProfile?.role || "guest",
      text:   text.trim(),
      time:   new Date().toISOString()
    };
    chatMessages.push({ ...msg, mine: true });
    renderChatMessages();
    try {
      await realtimeCh.send({ type: "broadcast", event: "chat", payload: msg });
    } catch (e) { console.warn("chat send", e); }
  }

  function receiveChatMessage(payload) {
    if (!payload || payload.userId === myUserId) return;
    chatMessages.push({ ...payload, mine: false });
    if (!meetSide?.classList.contains("expanded")) {
      chatUnread++;
      if (chatBadgeEl)   { chatBadgeEl.textContent = chatUnread; chatBadgeEl.hidden = false; }
      if (sideUnreadDot) sideUnreadDot.hidden = false;
    }
    renderChatMessages();
  }

  function renderChatMessages() {
    if (!chatMsgsEl) return;
    if (!chatMessages.length) {
      chatMsgsEl.innerHTML = '<p class="chat-empty">No messages yet — say hi!</p>';
      return;
    }
    chatMsgsEl.innerHTML = chatMessages.map(m => `
      <div class="chat-bubble ${m.mine ? "mine" : "theirs"}">
        ${!m.mine ? `<div class="chat-bubble-name">${esc(m.name || "—")} <span style="font-weight:400;opacity:.7">${labelRole(m.role)}</span></div>` : ""}
        ${esc(m.text)}
        <div class="chat-bubble-time">${chatTime(m.time)}</div>
      </div>`).join("");
    chatMsgsEl.scrollTop = chatMsgsEl.scrollHeight;
  }

  function chatTime(iso) {
    try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
    catch { return ""; }
  }

  // ====================================================================
  //  Weather (Open-Meteo, no key)
  // ====================================================================
  function startWeatherLoop() {
    weatherTimer = setInterval(loadWeather, 5 * 60 * 1000);
    setTimeout(loadWeather, 4000);
  }

  async function loadWeather() {
    if (!lastFix) return;
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${lastFix.lat}&longitude=${lastFix.lng}&current=temperature_2m,wind_speed_10m,weather_code,precipitation,relative_humidity_2m&timezone=auto`;
      const r = await fetch(u);
      const j = await r.json();
      const c = j.current;
      if (!c) return;
      const emoji = weatherEmoji(c.weather_code);
      const tempC  = Math.round(c.temperature_2m);
      const desc   = weatherText(c.weather_code);
      const wind   = Math.round(c.wind_speed_10m);

      weatherBody.innerHTML = `
        <div class="w-row">
          <div class="w-icon">${emoji}</div>
          <div class="w-num">${tempC}°<span class="w-unit">C</span></div>
        </div>
        <div class="w-meta">
          <span title="Conditions">${desc}</span>
          <span>· 💨 ${wind} km/h</span>
          <span>· 💧 ${c.relative_humidity_2m}%</span>
          ${c.precipitation > 0 ? `<span>· 🌧 ${c.precipitation} mm</span>` : ""}
        </div>`;

      // Update map weather overlay card
      const mc = document.getElementById("mapWeatherCard");
      if (mc) {
        document.getElementById("mapWeatherIcon").textContent = emoji;
        document.getElementById("mapWeatherTemp").textContent = tempC + "°C";
        document.getElementById("mapWeatherDesc").textContent = desc + " · 💨 " + wind + " km/h";
        mc.hidden = false;
        getCityName(lastFix.lat, lastFix.lng).then(city => {
          const el = document.getElementById("mapWeatherCity");
          if (el) el.textContent = city || "";
        });
      }
    } catch (e) {
      console.warn("weather", e);
    }
  }

  // ====================================================================
  //  Helpers — DB
  // ====================================================================
  async function createRoom({ purpose, tracking, created_by }) {
    const code = randomCode();
    if (sb) {
      const { error } = await sb.from("meet_rooms").insert({
        code, purpose, tracking_code: tracking, created_by
      });
      if (error) throw error;
    }
    return code;
  }

  async function fetchRoom(code) {
    if (!sb) return { code, purpose: "meet" };
    const { data, error } = await sb.from("meet_rooms")
      .select("*").eq("code", code).maybeSingle();
    if (error) throw error;
    if (!data || data.status !== "active") return null;
    if (new Date(data.expires_at).getTime() < Date.now()) return null;
    return data;
  }

  // ====================================================================
  //  Helpers — geo / format
  // ====================================================================
  function ensureUserId() {
    let id = localStorage.getItem("meet_user_id");
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) ||
           (Date.now() + "-" + Math.random().toString(16).slice(2));
      localStorage.setItem("meet_user_id", id);
    }
    return id;
  }

  function persistRoom(r) {
    sessionStorage.setItem("meet_active_room", JSON.stringify(r));
  }
  function readPersisted() {
    try { return JSON.parse(sessionStorage.getItem("meet_active_room") || "null"); }
    catch { return null; }
  }
  function clearPersisted() {
    sessionStorage.removeItem("meet_active_room");
  }

  function randomCode() {
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // unambiguous
    let s = "";
    for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  }

  function haversineKm(la1, lo1, la2, lo2) {
    const R = 6371, toRad = d => d * Math.PI / 180;
    const dLat = toRad(la2 - la1), dLng = toRad(lo2 - lo1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function etaMinutes(km, speedMps) {
    // Use observed speed if it's plausibly mobile (>1 m/s); otherwise assume a walking-friendly 25 km/h average.
    let kmh = (speedMps && speedMps > 1) ? speedMps * 3.6 : 25;
    if (kmh < 4) kmh = 4;
    return Math.max(1, Math.round((km / kmh) * 60));
  }

  function humanAgo(iso) {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60)    return s + "s ago";
    if (s < 3600)  return Math.round(s / 60) + "m ago";
    return Math.round(s / 3600) + "h ago";
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
  }

  function labelRole(r) {
    const k = "meet_role_" + (r || "guest");
    return window.t(k) || (r || "guest");
  }
  function labelPurpose(p) {
    const k = "meet_purpose_" + (p || "meet");
    return window.t(k) || (p || "meet");
  }
  function roleColorClass(r) { return "role-" + (r || "guest"); }

  // ---- Bolt/Uber-style live markers — MapLibre DOM elements ---------------
  function makeMyIconInner(role, heading) {
    const color = roleColor(role);
    const arrow = heading != null
      ? `<div class="pawa-arrow" style="transform:translateX(-50%) rotate(${heading}deg);color:${color}">▲</div>` : '';
    return `<div class="pawa-pulse-ring" style="border-color:${color}"></div>
      <div class="pawa-me-dot" style="background:${color}"><span style="font-size:15px">${roleEmoji(role)}</span></div>
      ${arrow}`;
  }
  function makeMyIconEl(role, heading) {
    const el = document.createElement("div");
    el.style.cssText = "position:relative;width:48px;height:48px";
    el.innerHTML = makeMyIconInner(role, heading);
    return el;
  }

  function makePeerIconInner(role, heading, name) {
    const color = roleColor(role);
    const arrow = (heading != null && heading !== 0)
      ? `<div class="pawa-arrow" style="transform:translateX(-50%) rotate(${heading}deg);color:${color}">▲</div>` : '';
    const label = name
      ? `<div class="pawa-name-tag" style="background:${color}">${esc((name||'').split(' ')[0])}</div>` : '';
    return `${arrow}
      <div class="pawa-peer-dot" style="background:${color}"><span style="font-size:14px">${roleEmoji(role)}</span></div>
      ${label}`;
  }
  function makePeerIconEl(role, heading, name) {
    const el = document.createElement("div");
    el.style.cssText = "position:relative;width:36px;height:52px";
    el.innerHTML = makePeerIconInner(role, heading, name);
    return el;
  }

  // ---- Smooth marker animation (Bolt-style glide) — MapLibre setLngLat ----
  function animateMarker(marker, from, to, ms) {
    ms = ms || 700;
    const start = performance.now();
    const [lat1, lng1] = from, [lat2, lng2] = to;
    function step(now) {
      const t = Math.min((now - start) / ms, 1);
      const ease = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
      marker.setLngLat([lng1+(lng2-lng1)*ease, lat1+(lat2-lat1)*ease]);
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ---- Apply OSRM route to MapLibre GeoJSON layer --------------------------
  function applyRoute(p, result) {
    if (!p.sourceId || !map) return;
    try {
      const coords = result.latlngs.map(ll => Array.isArray(ll) ? [ll[1], ll[0]] : [ll.lng, ll.lat]);
      map.getSource(p.sourceId)?.setData({ type: "Feature", geometry: { type: "LineString", coordinates: coords } });
      const isFallback = !!result.fallback;
      map.setPaintProperty(p.sourceId + "bg", "line-opacity", isFallback ? 0.2 : 0.5);
      map.setPaintProperty(p.sourceId + "fg", "line-opacity", isFallback ? 0.4 : 0.92);
      map.setPaintProperty(p.sourceId + "fg", "line-dasharray", isFallback ? [2, 2] : []);
    } catch(e) {}
  }

  // ---- OSRM road routing (free, no API key) --------------------------------
  async function fetchRoadRoute(lat1, lng1, lat2, lng2) {
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=full&geometries=geojson`;
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 7000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(tid);
      const j = await r.json();
      if (j.code === "Ok" && j.routes && j.routes[0]) {
        const route = j.routes[0];
        return {
          latlngs:  route.geometry.coordinates.map(function(c) { return [c[1], c[0]]; }),
          distKm:   route.distance / 1000,
          durMin:   Math.max(1, Math.round(route.duration / 60))
        };
      }
    } catch (e) { /* fall back to straight line */ }
    return null;
  }

  // ---- Reverse geocoding (Nominatim) --------------------------------------
  let _cityCache = { name: null, lat: null, lng: null };

  async function fetchAddress(lat, lng) {
    try {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
        { headers: { "Accept-Language": "en" } }
      );
      const j = await r.json();
      const a = j.address || {};
      return {
        street: a.road || a.pedestrian || a.footway || a.path || a.residential || "",
        suburb: a.suburb || a.neighbourhood || a.quarter || a.village || "",
        city:   a.city  || a.town || a.municipality || a.county || ""
      };
    } catch { return null; }
  }

  async function getCityName(lat, lng) {
    if (_cityCache.name && _cityCache.lat != null &&
        haversineKm(_cityCache.lat, _cityCache.lng, lat, lng) < 5) {
      return _cityCache.name;
    }
    const addr = await fetchAddress(lat, lng);
    const name = addr?.city || addr?.suburb || "";
    _cityCache = { name, lat, lng };
    return name;
  }

  // ---- Role colour & emoji (Bolt-style per-role identity) -----------------
  function roleColor(role) {
    return { sender: '#22c55e', receiver: '#3b82f6', driver: '#f59e0b', agent: '#8b5cf6', guest: '#6b7280' }[role] || '#6b7280';
  }
  function roleEmoji(role) {
    return { sender: '📦', receiver: '🤝', driver: '🚌', agent: '⭐', guest: '👤' }[role] || '👤';
  }

  // Open-Meteo weather codes (WMO)
  function weatherEmoji(code) {
    if (code == null) return "🌤";
    if (code === 0) return "☀️";
    if (code <= 2)  return "🌤";
    if (code === 3) return "☁️";
    if (code === 45 || code === 48) return "🌫";
    if (code >= 51 && code <= 67)   return "🌧";
    if (code >= 71 && code <= 77)   return "❄️";
    if (code >= 80 && code <= 82)   return "🌦";
    if (code >= 95)                 return "⛈";
    return "🌤";
  }
  function weatherText(code) {
    if (code == null) return "—";
    const map = { 0:"Clear", 1:"Mostly clear", 2:"Partly cloudy", 3:"Overcast",
      45:"Foggy", 48:"Rime fog",
      51:"Light drizzle", 53:"Drizzle", 55:"Heavy drizzle",
      61:"Light rain", 63:"Rain", 65:"Heavy rain",
      71:"Light snow", 73:"Snow", 75:"Heavy snow",
      80:"Showers", 81:"Heavy showers", 82:"Violent showers",
      95:"Thunderstorm", 96:"Thunderstorm + hail", 99:"Severe storm" };
    return map[code] || "—";
  }
};

// Major Tanzania cities — used as low-zoom context dots on the map
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
  { name: "Kilifi",        lat: -4.0833, lng: 38.4500 },
  { name: "Moshi",         lat: -3.3500, lng: 37.3333 }
];
