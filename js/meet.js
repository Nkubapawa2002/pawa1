// Build stamp — shows in console AND on-screen (#meetBuildBadge) so you
// can confirm which build is loaded without DevTools. Bump on each ship.
const MEET_BUILD = "v59 (2026-06-15 houses/services reframe + WhatsApp live view)";
console.log(`[meet] build ${MEET_BUILD} loaded`);
window.addEventListener("DOMContentLoaded", () => {
  const b = document.getElementById("meetBuildBadge");
  if (b) b.textContent = "build " + MEET_BUILD;
});

// Surface ANY uncaught JS error as a visible alert on the page — without
// this, init errors die silently and buttons appear "not to work" with
// no explanation. Alerts only the first error so we don't spam.
window.addEventListener("error", (e) => {
  if (window._meetErrAlerted) return;
  window._meetErrAlerted = true;
  const msg = `[meet] uncaught: ${e.message}\nat ${e.filename || "?"}:${e.lineno || "?"}:${e.colno || "?"}`;
  console.error("[meet] caught error", e.error || e);
  alert(msg);
});
window.addEventListener("unhandledrejection", (e) => {
  if (window._meetErrAlerted) return;
  window._meetErrAlerted = true;
  const msg = `[meet] promise rejection: ${e.reason?.message || e.reason}`;
  console.error("[meet] unhandled rejection", e.reason);
  alert(msg);
});

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
  try {
    _initMeetPageImpl();
  } catch (err) {
    console.error("[meet] initMeetPage threw:", err);
    alert(`[meet] init error — buttons will not work until fixed:\n${err?.message || err}\nstack: ${err?.stack?.split("\n")?.slice(0, 3)?.join(" | ") || "n/a"}`);
    throw err;
  }
};

const _initMeetPageImpl = () => {
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
  let rosterTimer   = null;
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
  let houseCtx       = null;       // listing being viewed live (?house=<id>)
  let houseMarker    = null;       // the property's pin on the live map

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
    try { localStorage.setItem("meet_name", name); } catch (_) {}

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
    try { localStorage.setItem("meet_name", name); } catch (_) {}

    joinRoomBtn.disabled = true;
    joinRoomBtn.textContent = "…";
    try {
      let room = await fetchRoom(code);
      // Live-viewing rooms use a code synthesized by the listing page — no
      // row exists until someone arrives. First to join opens the room.
      if (!room && inviteHouseId && code === inviteCode)
        room = await ensureListingRoom(code, name);
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
    window._meetActiveRoom = true;
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
    attachHouseToMap();   // pin the listing when this room is a live viewing
    await refreshRoster();
    subscribeRealtime();
    // The roster used to refresh off Postgres realtime, but securing
    // live_locations (RPC-only, no direct table SELECT) means realtime can no
    // longer read it. Poll the room RPC instead — broadcast events (chat / RTC)
    // still flow over the channel in subscribeRealtime().
    if (rosterTimer) clearInterval(rosterTimer);
    rosterTimer = setInterval(refreshRoster, 2500);
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
    if (rosterTimer)  { clearInterval(rosterTimer);  rosterTimer  = null; }
    if (weatherTimer) { clearInterval(weatherTimer); weatherTimer = null; }
    // Stop camera BEFORE we drop the realtime channel, so peers get the
    // camera_stop broadcast and tear down their tiles for us.
    if (camStream) stopCamera({ notify: true });
    cameraStreams.clear();
    renderLiveCameras();
    if (realtimeCh)   { realtimeCh.unsubscribe?.();  realtimeCh   = null; }
    watchId = null;

    if (!silent && sb && activeRoom?.code) {
      try {
        await sb.rpc("meet_leave", { p_code: activeRoom.code, p_user_id: myUserId });
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
    if (houseMarker) { houseMarker.remove(); houseMarker = null; }
    if (map) { map._cleanupFn?.(); map.remove(); map = null; }

    clearPersisted();
    activeRoom = null;
    window._meetActiveRoom = false;
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

  // Fit-all: zoom out so every roster member (me + peers) — and the property
  // pin, when this room is a live viewing — is visible.
  document.getElementById("fabFitAll")?.addEventListener("click", () => {
    if (!map) return;
    const pts = [];
    if (lastFix) pts.push([lastFix.lng, lastFix.lat]);
    if (houseCtx && Number.isFinite(+houseCtx.lat) && Number.isFinite(+houseCtx.lng))
      pts.push([+houseCtx.lng, +houseCtx.lat]);
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
      attachHouseToMap();
      map.once("load", () => map.jumpTo({ center: here, zoom: z }));
    }
  });
  const sidePull = document.getElementById("sidePull");
  const meetSide = document.getElementById("meetSide");
  // Helper: update the side-pull label so users have an obvious "Maximize
  // / Minimize" affordance — chevron-up + "Maximize" when collapsed,
  // chevron-down + "Minimize" when expanded.
  const syncSidePullLabel = () => {
    const lbl = sidePull?.querySelector(".side-pull-label");
    if (!lbl) return;
    const isExp = meetSide?.classList.contains("expanded");
    lbl.innerHTML = isExp
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg> Minimize`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg> Maximize · Chat & info`;
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

  // Floating fallback Maximize FAB — opens the side panel even if the
  // user scrolled past the green bottom bar or the bar got covered.
  document.getElementById("meetMaximizeFab")?.addEventListener("click", () => {
    if (!meetSide?.classList.contains("expanded")) {
      meetSide.classList.add("expanded");
      syncSidePullLabel();
      if (map) setTimeout(() => map.resize(), 320);
    }
  });
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
    const text = `${window.t("meet_share_text") || "Join me on Maisha Meet"}: ${activeRoom.code}\n${url}`;
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
    if (text && activeRoom) { sendChatMessage({ text }); chatInputEl.value = ""; }
  });
  chatInputEl?.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = chatInputEl.value.trim();
      if (text && activeRoom) { sendChatMessage({ text }); chatInputEl.value = ""; }
    }
  });

  // ---- Photo attachment ----------------------------------------------------
  // Resize to max 800 px width, JPEG quality 0.7 → typically 50–150 KB so
  // it fits comfortably in a Supabase Realtime broadcast payload.
  const chatPhotoBtn   = document.getElementById("chatPhotoBtn");
  const chatPhotoInput = document.getElementById("chatPhotoInput");
  chatPhotoBtn?.addEventListener("click", () => chatPhotoInput?.click());
  chatPhotoInput?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !activeRoom) return;
    try {
      const dataUrl = await compressImage(file, 800, 0.7);
      sendChatMessage({ photo: dataUrl });
    } catch (err) {
      console.warn("photo compress failed", err);
      alert("Could not attach that photo.");
    }
  });

  function compressImage(file, maxW, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(1, maxW / img.width);
        const w = Math.round(img.width  * ratio);
        const h = Math.round(img.height * ratio);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  // ---- Voice notes ---------------------------------------------------------
  // Cross-platform recording: try mp4/AAC first (iOS native, modern Android
  // Chrome supports it) before falling back to webm/opus (older Android).
  // If we end up with webm — which iOS Safari CANNOT decode — we transcode
  // to 16 kHz mono WAV on the sender so the receiving iPhone plays it.
  // Hard cap 30 s for mp4/opus (~180 KB), 15 s when transcoding to WAV
  // (16 kHz × 16-bit × 1ch = 32 KB/s, ~480 KB max — fits Realtime payload).
  const chatVoiceBtn    = document.getElementById("chatVoiceBtn");
  const chatVoiceStatus = document.getElementById("chatVoiceStatus");
  const chatVoiceTime   = document.getElementById("chatVoiceTime");
  let mediaRec = null, recChunks = [], recStartedAt = 0, recTimer = null, recMaxTimer = null;

  // Pick the best recording mime: prefer mp4/AAC (playable on every
  // platform including iOS). Fall back to webm only if mp4 isn't supported.
  function pickRecordingMime() {
    const candidates = [
      "audio/mp4;codecs=mp4a.40.2",   // AAC-LC in mp4 — iOS native, modern Android Chrome
      "audio/mp4",
      "audio/aac",
      "audio/webm;codecs=opus",       // older Android fallback
      "audio/webm",
    ];
    for (const m of candidates) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return "";
  }

  const stopRecording = () => {
    if (mediaRec && mediaRec.state !== "inactive") mediaRec.stop();
  };

  const voiceToggle = async () => {
    console.log("[meet] voice button clicked — activeRoom:", !!activeRoom, "recording:", mediaRec?.state);
    if (mediaRec && mediaRec.state === "recording") { stopRecording(); return; }
    if (!activeRoom) { alert("Join a room first, then tap the mic to record."); return; }
    if (!navigator.mediaDevices?.getUserMedia) {
      alert("Voice recording isn't supported on this browser. Use HTTPS and a modern browser (Safari 14+, Chrome).");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickRecordingMime();
      mediaRec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      const needsTranscode = (mediaRec.mimeType || mime || "").toLowerCase().includes("webm");
      recChunks = [];
      mediaRec.ondataavailable = (ev) => { if (ev.data?.size) recChunks.push(ev.data); };
      mediaRec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        if (recTimer)    clearInterval(recTimer);
        if (recMaxTimer) clearTimeout(recMaxTimer);
        chatVoiceBtn.classList.remove("recording");
        chatVoiceStatus.hidden = true;
        let blob = new Blob(recChunks, { type: mediaRec.mimeType || "audio/webm" });
        if (blob.size < 1000) return;
        // iOS Safari can't decode webm/opus. Re-encode to WAV before sending.
        blob = await ensureCrossPlatformAudio(blob);
        const dataUrl = await blobToDataUrl(blob);
        sendChatMessage({ audio: dataUrl, mime: blob.type });
      };
      mediaRec.start();
      recStartedAt = Date.now();
      chatVoiceBtn.classList.add("recording");
      chatVoiceStatus.hidden = false;
      chatVoiceTime.textContent = "0:00";
      recTimer = setInterval(() => {
        const s = Math.floor((Date.now() - recStartedAt) / 1000);
        chatVoiceTime.textContent = `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;
      }, 200);
      // Shorter cap when transcoding (WAV is uncompressed, eats payload budget fast).
      recMaxTimer = setTimeout(stopRecording, needsTranscode ? 15000 : 30000);
    } catch (err) {
      console.warn("mic permission denied", err);
      alert("Microphone permission denied.");
    }
  };
  window._meetVoiceToggle = voiceToggle;
  chatVoiceBtn?.addEventListener("click", voiceToggle);

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  // ── Cross-platform audio shim ───────────────────────────────────────
  // iOS Safari can play: mp4/aac, mpeg, wav. CANNOT play: webm/opus.
  // Android Chrome can DECODE webm/opus via AudioContext.decodeAudioData,
  // so we resample to 16 kHz mono and re-emit as a WAV blob. Plays
  // everywhere; ~32 KB/sec.
  async function ensureCrossPlatformAudio(blob) {
    const t = (blob.type || "").toLowerCase();
    const iosSafe = t.startsWith("audio/mp4") || t.startsWith("audio/aac") ||
                    t.startsWith("audio/wav") || t.startsWith("audio/mpeg") ||
                    t.startsWith("audio/x-m4a");
    if (iosSafe) return blob;
    try {
      const arrBuf = await blob.arrayBuffer();
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return blob;
      const ctx = new Ctx();
      const audioBuf = await ctx.decodeAudioData(arrBuf.slice(0));
      ctx.close?.();
      return encodeWavMono16k(audioBuf);
    } catch (e) {
      console.warn("audio transcode to WAV failed; sending original:", e);
      return blob;
    }
  }

  // Encode an AudioBuffer as 16 kHz mono 16-bit PCM WAV.
  function encodeWavMono16k(audioBuffer) {
    const targetRate = 16000;
    const srcRate    = audioBuffer.sampleRate;
    const srcLen     = audioBuffer.length;
    // Mix down to mono first
    const mono = new Float32Array(srcLen);
    const chCount = audioBuffer.numberOfChannels;
    for (let c = 0; c < chCount; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = 0; i < srcLen; i++) mono[i] += data[i] / chCount;
    }
    // Linear-interpolation resample to 16 kHz
    const ratio = srcRate / targetRate;
    const dstLen = Math.floor(srcLen / ratio);
    const dst = new Int16Array(dstLen);
    for (let i = 0; i < dstLen; i++) {
      const srcIdx = i * ratio;
      const i0 = Math.floor(srcIdx);
      const i1 = Math.min(i0 + 1, srcLen - 1);
      const frac = srcIdx - i0;
      const s = mono[i0] * (1 - frac) + mono[i1] * frac;
      const clamped = Math.max(-1, Math.min(1, s));
      dst[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
    }
    // WAV header (RIFF / fmt / data — 16-bit PCM mono)
    const dataBytes = dst.length * 2;
    const buf = new ArrayBuffer(44 + dataBytes);
    const v = new DataView(buf);
    const ws = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    ws(0, "RIFF");                                // chunk id
    v.setUint32(4, 36 + dataBytes, true);         // chunk size
    ws(8, "WAVE");                                // format
    ws(12, "fmt ");                               // subchunk1 id
    v.setUint32(16, 16, true);                    // subchunk1 size (PCM = 16)
    v.setUint16(20, 1, true);                     // audio format (1 = PCM)
    v.setUint16(22, 1, true);                     // num channels (1 = mono)
    v.setUint32(24, targetRate, true);            // sample rate
    v.setUint32(28, targetRate * 2, true);        // byte rate
    v.setUint16(32, 2, true);                     // block align
    v.setUint16(34, 16, true);                    // bits per sample
    ws(36, "data");                               // subchunk2 id
    v.setUint32(40, dataBytes, true);             // subchunk2 size
    let off = 44;
    for (let i = 0; i < dst.length; i++, off += 2) v.setInt16(off, dst[i], true);
    return new Blob([buf], { type: "audio/wav" });
  }

  // ---- Live camera + voice (WebRTC) ----------------------------------------
  // Real-time bidirectional video + audio between everyone in the room.
  // We use the existing Supabase Realtime channel for signaling (SDP +
  // ICE), then both video and audio flow peer-to-peer over WebRTC.
  // The earlier JPEG-snapshot path was killed because 1.5 s snapshots
  // were the source of the perceived "WebRTC is slow" lag — real WebRTC
  // video is ~100 ms latency. Front/back camera switch keeps the call
  // alive (renegotiates the new video track without re-creating peers).
  const chatCameraBtn = document.getElementById("chatCameraBtn");
  const liveCamerasEl = document.getElementById("liveCameras");
  const camSwitchBtn  = document.getElementById("chatCameraSwitchBtn");
  const camGalleryBtn = document.getElementById("chatCameraGalleryBtn");
  const cameraStreams = new Map();  // user_id -> { name, role, stream, mine, mirror }
  // One <video> element per peer per render location — the strip and the
  // gallery both render the same peers simultaneously and a single video
  // element can only live at one DOM location at a time.
  const peerVideoStrip   = new Map();   // user_id -> HTMLVideoElement (strip)
  const peerVideoGallery = new Map();   // user_id -> HTMLVideoElement (gallery)
  let camStream = null, camPreviewEl = null;
  let camFacing  = "environment";   // "user" = selfie, "environment" = rear
  const CAM_W = 640, CAM_H = 480;   // higher res now that video is real WebRTC, not 1.5s JPEGs

  async function startCamera(facing = camFacing) {
    console.log("[meet] startCamera — activeRoom:", !!activeRoom, "facing:", facing);
    if (!activeRoom) { alert("Join a room first, then tap the camera to share live video."); return; }
    if (!navigator.mediaDevices?.getUserMedia) {
      alert("Camera isn't supported on this browser. The page must be served over HTTPS.");
      return;
    }
    // Stop the previous video tracks first if we're switching cameras.
    // Keep audio tracks alive across switches so the voice call doesn't drop.
    if (camStream) {
      camStream.getVideoTracks().forEach(t => t.stop());
    }
    // Try the requested facing first; fall back to plain `video:true` if
    // the constraint can't be satisfied (some iPads / desktop webcams have
    // no facingMode metadata at all and would otherwise OverconstrainError).
    // We now request audio TOO so peers can talk during the stream — see
    // the WebRTC voice section below for how the audio track gets routed.
    // We always capture the mic but apply the mute state via track.enabled
    // afterwards, so unmuting doesn't re-prompt for permission.
    let newStream;
    // Aggressive noise/echo suppression + iOS voiceIsolation when available.
    // `ideal` constraints are non-throwing — unsupported keys are ignored.
    const audioConstraint = {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl:  { ideal: true },
      voiceIsolation:   { ideal: true },   // iOS 17+ / Chrome 124+ noise cancellation
      channelCount:     { ideal: 1 },      // mono — cleaner voice
      sampleRate:       { ideal: 48000 },  // Opus native rate
    };
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: CAM_W }, height: { ideal: CAM_H } },
        audio: audioConstraint,
      });
    } catch (err1) {
      try {
        newStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: audioConstraint });
      } catch (err2) {
        // Last resort: video only (mic denied)
        try {
          newStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } catch (err3) {
          console.warn("camera permission denied", err3);
          alert("Camera permission denied or no camera available.");
          return;
        }
      }
    }
    // If we already had an audio track from a previous camera (camera switch),
    // keep it and just swap in the new video. Otherwise adopt the new stream.
    if (camStream && newStream.getVideoTracks().length) {
      // Remove old video tracks from camStream, add new video track
      camStream.getVideoTracks().forEach(t => camStream.removeTrack(t));
      newStream.getVideoTracks().forEach(t => camStream.addTrack(t));
      // Audio track: keep existing if we have one; otherwise add the new one
      if (camStream.getAudioTracks().length === 0) {
        newStream.getAudioTracks().forEach(t => camStream.addTrack(t));
      } else {
        newStream.getAudioTracks().forEach(t => t.stop());   // discard duplicate audio
      }
    } else {
      camStream = newStream;
    }
    camFacing = facing;
    // Apply current mute state to the audio track
    camStream.getAudioTracks().forEach(t => { t.enabled = !camMuted; });
    // Hand the (possibly new) audio track to every existing WebRTC peer
    // connection so they all keep hearing us after a camera switch.
    rtcReplaceLocalAudio();
    // Local preview element — required by iOS Safari even though we never
    // SHOW it (it just keeps the stream live and gives WebRTC something to
    // work with). 1×1 off-screen, must be DOM-attached + playsinline.
    if (!camPreviewEl) {
      camPreviewEl = document.createElement("video");
      camPreviewEl.setAttribute("autoplay", "");
      camPreviewEl.setAttribute("playsinline", "");
      camPreviewEl.setAttribute("webkit-playsinline", "");
      camPreviewEl.setAttribute("muted", "");
      camPreviewEl.muted = true;
      camPreviewEl.playsInline = true;
      camPreviewEl.style.cssText =
        "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;";
      document.body.appendChild(camPreviewEl);
    }
    camPreviewEl.srcObject = camStream;
    const playPromise = camPreviewEl.play();
    if (playPromise?.catch) playPromise.catch(e => console.warn("local preview play", e));
    chatCameraBtn?.classList.add("recording");
    updateCameraControls();
    // Announce we're online (with name/role) so peers know who's calling.
    rtcAnnounce();
    // For peers we already know about (their meta or first hello),
    // try to initiate the WebRTC call now.
    for (const peerId of cameraStreams.keys()) {
      if (peerId !== myUserId) rtcMaybeInitiate(peerId);
    }
  }

  async function switchCamera() {
    if (!camStream) return;
    const next = camFacing === "user" ? "environment" : "user";
    await startCamera(next);
  }

  function updateCameraControls() {
    if (camSwitchBtn) camSwitchBtn.hidden = !camStream;
    if (camMuteBtn)   camMuteBtn.hidden   = !camStream;
    // Gallery only appears when there's at least one PEER to look at —
    // your own face isn't shown anywhere.
    if (camGalleryBtn) camGalleryBtn.hidden = visibleStreams().length === 0;
  }

  function stopCamera({ notify = true } = {}) {
    if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
    if (camPreviewEl) {
      camPreviewEl.srcObject = null;
      camPreviewEl.remove();
      camPreviewEl = null;
    }
    chatCameraBtn?.classList.remove("recording");
    cameraStreams.delete(myUserId);
    renderLiveCameras();
    rtcTearDown();
    updateCameraControls();
    if (notify && realtimeCh) {
      realtimeCh.send({ type: "broadcast", event: "camera_stop", payload: { userId: myUserId } }).catch(() => {});
    }
  }

  // ── WebRTC voice + video ───────────────────────────────────────────────
  // Real-time bidirectional video + audio between everyone in the room.
  // Signaling (SDP + ICE) rides on the existing Supabase Realtime channel
  // via `rtc_*` broadcast events.
  //
  // ICE servers are built from APP_CONFIG: always the two Google STUN servers,
  // plus any TURN relay configured (TURN_URLS/USERNAME/CREDENTIAL). TURN is
  // what makes calls survive Tanzanian mobile-carrier NAT — without it,
  // STUN-only calls there fail and the call "crashes". See js/config.js.
  function buildIceServers() {
    const cfg = window.APP_CONFIG || {};
    const servers = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ];
    (cfg.STUN_URLS || []).forEach(u => { if (u) servers.push({ urls: u }); });
    const turnUrls = (cfg.TURN_URLS || []).filter(Boolean);
    if (turnUrls.length && cfg.TURN_USERNAME && cfg.TURN_CREDENTIAL) {
      servers.push({
        urls: turnUrls,
        username: cfg.TURN_USERNAME,
        credential: cfg.TURN_CREDENTIAL,
      });
    }
    return servers;
  }
  const RTC_CONFIG = {
    iceServers: buildIceServers(),
    bundlePolicy: "max-bundle",      // single transport — faster
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 2,         // pre-gather a few candidates → faster connect
  };
  // True once a TURN relay is configured — gates the "STUN-only" warning.
  const HAS_TURN = RTC_CONFIG.iceServers.some(s =>
    [].concat(s.urls).some(u => /^turns?:/i.test(u)));
  if (!HAS_TURN) {
    console.warn("[meet] No TURN server configured — calls may fail on mobile " +
      "(carrier NAT). Add TURN_URLS/TURN_USERNAME/TURN_CREDENTIAL in js/config.js.");
  }
  const peerConns  = new Map();   // user_id -> RTCPeerConnection
  let camMuted = false;
  const camMuteBtn = document.getElementById("chatCameraMuteBtn");

  function rtcAnnounce() {
    if (!realtimeCh) return;
    realtimeCh.send({
      type: "broadcast",
      event: "rtc_hello",
      payload: { from: myUserId },
    }).catch(() => {});
    // Also push my metadata so peers can label my tile before ICE establishes
    announceCameraMeta();
  }

  function getPeer(remoteId) {
    let pc = peerConns.get(remoteId);
    if (pc) return pc;
    pc = new RTCPeerConnection(RTC_CONFIG);
    peerConns.set(remoteId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate && realtimeCh) {
        realtimeCh.send({
          type: "broadcast",
          event: "rtc_ice",
          payload: { from: myUserId, to: remoteId, candidate: event.candidate.toJSON() },
        }).catch(() => {});
      }
    };

    // Incoming track (audio OR video). Both go onto the same MediaStream
    // and are bound to a single <video> element which plays the video and
    // the audio together.
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) return;
      // Hint browser to keep playout buffer minimal — trades a little
      // glitchiness for much lower latency. Critical for "we can talk".
      try { event.receiver.playoutDelayHint = 0; } catch {}
      try { event.receiver.jitterBufferTarget = 0; } catch {}

      const existing = cameraStreams.get(remoteId) || {};
      cameraStreams.set(remoteId, {
        ...existing,
        name: existing.name || "—",
        role: existing.role || "guest",
        stream,
        mine: false,
        mirror: false,
      });
      renderLiveCameras();
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      // "disconnected" is usually a transient blip (network hiccup, brief
      // signal loss) that recovers on its own — DON'T tear the call down for
      // it, or every passing glitch kills the call. Only act on a real
      // "failed"/"closed".
      if (st === "failed") {
        // One ICE restart before giving up — rescues flaky mobile networks.
        // The initiator (lower userId) re-offers with iceRestart; the answerer
        // waits for that new offer.
        if (!pc._iceRestarted && myUserId < remoteId) {
          pc._iceRestarted = true;
          rtcMaybeInitiate(remoteId, true);
          return;
        }
      }
      if (st === "failed" || st === "closed") {
        closePeer(remoteId);
        cameraStreams.delete(remoteId);
        renderLiveCameras();
        if (visibleStreams().length === 0) closeCameraGallery();
      }
    };

    // Add OUR tracks so the remote can hear+see us
    if (camStream) {
      camStream.getTracks().forEach(track => pc.addTrack(track, camStream));
    }
    // Once tracks are added, tune the codec preferences and bitrates
    rtcTuneSenders(pc);
    return pc;
  }

  // Prefer Opus for audio with FEC + DTX, and bump the bitrate so voices
  // don't sound thin or noisy. ~32-64 kbps Opus is the sweet spot.
  function rtcTuneSenders(pc) {
    try {
      const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
      for (const tr of transceivers) {
        if (tr.sender.track?.kind === "audio" && tr.setCodecPreferences) {
          const caps = RTCRtpSender.getCapabilities?.("audio");
          if (caps?.codecs) {
            const opus = caps.codecs.find(c => /opus/i.test(c.mimeType));
            const rest = caps.codecs.filter(c => c !== opus);
            if (opus) tr.setCodecPreferences([opus, ...rest]);
          }
        }
      }
    } catch (e) { console.warn("setCodecPreferences", e); }
    // Bitrate hints — small effect on quality but helps on patchy networks
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      const params = sender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      if (sender.track.kind === "audio") {
        params.encodings[0].maxBitrate = 48_000;       // clear voice
        params.encodings[0].priority   = "high";
        params.encodings[0].networkPriority = "high";
      } else if (sender.track.kind === "video") {
        params.encodings[0].maxBitrate = 350_000;      // ~350 kbps video, fits 3G
      }
      sender.setParameters(params).catch(() => {});
    }
  }

  function closePeer(remoteId) {
    const pc = peerConns.get(remoteId);
    if (pc) { try { pc.close(); } catch {} peerConns.delete(remoteId); }
    for (const map of [peerVideoStrip, peerVideoGallery]) {
      const el = map.get(remoteId);
      if (el) { try { el.srcObject = null; el.remove(); } catch {} map.delete(remoteId); }
    }
  }

  function rtcTearDown() {
    for (const id of [...peerConns.keys()]) closePeer(id);
  }

  // Called when a fresh audio/video track appears (initial start OR camera
  // switch produced new tracks) — push them to every existing peer
  // connection via replaceTrack so the call doesn't have to renegotiate.
  function rtcReplaceLocalAudio() {
    if (!camStream) return;
    const audioTrack = camStream.getAudioTracks()[0] || null;
    const videoTrack = camStream.getVideoTracks()[0] || null;
    for (const pc of peerConns.values()) {
      const senders = pc.getSenders();
      const audioSender = senders.find(s => s.track?.kind === "audio");
      const videoSender = senders.find(s => s.track?.kind === "video");
      if (audioSender) audioSender.replaceTrack(audioTrack).catch(e => console.warn("replaceTrack audio", e));
      else if (audioTrack) pc.addTrack(audioTrack, camStream);
      if (videoSender) videoSender.replaceTrack(videoTrack).catch(e => console.warn("replaceTrack video", e));
      else if (videoTrack) pc.addTrack(videoTrack, camStream);
      rtcTuneSenders(pc);
    }
  }

  // Lower userId initiates to avoid simultaneous offers ("glare").
  // iceRestart=true re-gathers ICE on an existing connection that failed.
  async function rtcMaybeInitiate(remoteId, iceRestart = false) {
    if (!camStream) return;            // we're not sharing → don't call out
    if (myUserId >= remoteId) return;  // they'll call us instead
    const pc = getPeer(remoteId);
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true, iceRestart });
      await pc.setLocalDescription(offer);
      rtcTuneSenders(pc);
      await realtimeCh.send({
        type: "broadcast",
        event: "rtc_offer",
        payload: { from: myUserId, to: remoteId, sdp: pc.localDescription },
      });
    } catch (e) { console.warn("rtc offer", e); }
  }

  async function rtcHandleOffer(payload) {
    if (payload.to !== myUserId) return;
    const pc = getPeer(payload.from);
    try {
      await pc.setRemoteDescription(payload.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await realtimeCh.send({
        type: "broadcast",
        event: "rtc_answer",
        payload: { from: myUserId, to: payload.from, sdp: pc.localDescription },
      });
    } catch (e) { console.warn("rtc answer", e); }
  }

  async function rtcHandleAnswer(payload) {
    if (payload.to !== myUserId) return;
    const pc = peerConns.get(payload.from);
    if (!pc) return;
    try { await pc.setRemoteDescription(payload.sdp); }
    catch (e) { console.warn("rtc setRemote answer", e); }
  }

  async function rtcHandleIce(payload) {
    if (payload.to !== myUserId) return;
    const pc = peerConns.get(payload.from);
    if (!pc) return;
    try { await pc.addIceCandidate(payload.candidate); }
    catch (e) { console.warn("rtc ICE", e); }
  }

  async function rtcHandleHello(payload) {
    if (payload.from === myUserId) return;
    if (!camStream) return;            // not sharing → nothing to do
    // Send peer our metadata so they can label our tile
    announceCameraMeta(payload.from);
    rtcMaybeInitiate(payload.from);
  }

  // Mute / unmute the local mic without dropping the call
  function toggleMute() {
    if (!camStream) return;
    camMuted = !camMuted;
    camStream.getAudioTracks().forEach(t => { t.enabled = !camMuted; });
    camMuteBtn?.classList.toggle("recording", camMuted);
    camMuteBtn?.setAttribute("title", camMuted ? "Mic muted — tap to unmute" : "Tap to mute mic");
  }

  camMuteBtn?.addEventListener("click", toggleMute);

  // Broadcast my display metadata (name, role) — peers need this to label
  // the incoming WebRTC track. Sent on startCamera and whenever a peer
  // joins (rtc_hello reply). Tiny payload, no media.
  function announceCameraMeta(toUserId) {
    if (!realtimeCh) return;
    realtimeCh.send({
      type: "broadcast",
      event: "camera_meta",
      payload: {
        userId: myUserId,
        name:   myProfile?.name || "Me",
        role:   myProfile?.role || "guest",
        to:     toUserId || null,        // null = everyone; specific id = direct response
      },
    }).catch(() => {});
  }

  function onPeerCameraMeta(payload) {
    if (!payload || payload.userId === myUserId) return;
    if (payload.to && payload.to !== myUserId) return;     // direct, not for us
    const existing = cameraStreams.get(payload.userId) || {};
    cameraStreams.set(payload.userId, {
      ...existing,
      name: payload.name || "—",
      role: payload.role || "guest",
      mine: false,
    });
    renderLiveCameras();
    // First time we know this peer is sharing? Try to establish the call.
    if (camStream && !peerConns.has(payload.userId)) rtcMaybeInitiate(payload.userId);
  }

  function onPeerCameraStop(payload) {
    if (!payload?.userId) return;
    cameraStreams.delete(payload.userId);
    closePeer(payload.userId);
    renderLiveCameras();
    if (visibleStreams().length === 0) closeCameraGallery();
  }

  // Show only OTHER people's cameras — not your own face. The pulsing
  // red camera button is the indicator that your camera is broadcasting.
  function visibleStreams() {
    // Only entries that actually have a MediaStream (i.e. WebRTC connected).
    // A peer might have meta set before their tracks arrive — don't render
    // an empty tile in that case.
    return Array.from(cameraStreams.entries())
      .filter(([uid, s]) => !s.mine && s.stream)
      .map(([uid, s]) => ({ ...s, userId: uid }));
  }

  // Get or create a persistent <video> element bound to a peer's MediaStream.
  // Reusing the element across renders is critical — replacing innerHTML
  // would drop the srcObject and the video would freeze for ~500 ms each
  // time anything in the strip changes.
  function getPeerVideoEl(userId, stream, mirror, location = "strip") {
    // Strip and gallery each need their own video element bound to the
    // peer's MediaStream. The strip element is muted (audio is played from
    // the gallery element when open, OR the strip element when not — see
    // muteStrategy below) to avoid double-audio. We standardize on: AUDIO
    // ALWAYS PLAYS FROM THE STRIP ELEMENT, gallery element is muted.
    const map = location === "gallery" ? peerVideoGallery : peerVideoStrip;
    let el = map.get(userId);
    if (!el) {
      el = document.createElement("video");
      el.setAttribute("autoplay", "");
      el.setAttribute("playsinline", "");
      el.setAttribute("webkit-playsinline", "");
      el.autoplay = true;
      el.playsInline = true;
      if (location === "gallery") {
        el.muted = true;
        el.setAttribute("muted", "");
      }
      map.set(userId, el);
    }
    if (el.srcObject !== stream) {
      el.srcObject = stream;
      el.play().catch(() => {});
    }
    el.style.transform = mirror ? "scaleX(-1)" : "";
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.objectFit = "cover";
    el.style.display = "block";
    return el;
  }

  function renderLiveCameras() {
    if (!liveCamerasEl) return;
    const others = visibleStreams();
    if (others.length === 0) {
      liveCamerasEl.classList.remove("has-streams");
      liveCamerasEl.innerHTML = "";
      updateCameraControls();
      if (cameraGalleryOpen) renderCameraGallery();
      return;
    }
    liveCamerasEl.classList.add("has-streams");
    // Build tiles preserving the peer <video> elements
    liveCamerasEl.innerHTML = "";
    for (const s of others) {
      const tile = document.createElement("div");
      tile.className = "live-cam-tile";
      tile.dataset.camTile = "1";
      const videoEl = getPeerVideoEl(s.userId, s.stream, s.mirror);
      tile.appendChild(videoEl);
      const label = document.createElement("div");
      label.className = "live-cam-label";
      label.innerHTML = `<span class="live-cam-dot"></span>${esc(s.name)}`;
      tile.appendChild(label);
      liveCamerasEl.appendChild(tile);
    }
    updateCameraControls();
    if (cameraGalleryOpen) renderCameraGallery();
  }

  // ── Camera gallery (fullscreen, grid view for many users) ────────────
  let cameraGalleryOpen = false;
  function openCameraGallery() {
    if (visibleStreams().length === 0) return;   // nothing to show — no peer broadcasting
    cameraGalleryOpen = true;
    let modal = document.getElementById("cameraGalleryModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "cameraGalleryModal";
      modal.className = "cam-gallery-modal";
      modal.innerHTML = `
        <div class="cam-gallery-header">
          <span class="cam-gallery-title">Live cameras (<span id="camGalleryCount">0</span>)</span>
          <button class="cam-gallery-close" type="button" aria-label="Close gallery">×</button>
        </div>
        <div class="cam-gallery-grid" id="camGalleryGrid"></div>
      `;
      document.body.appendChild(modal);
      modal.querySelector(".cam-gallery-close").addEventListener("click", closeCameraGallery);
      modal.addEventListener("click", (e) => { if (e.target === modal) closeCameraGallery(); });
    }
    modal.classList.add("open");
    renderCameraGallery();
  }
  function closeCameraGallery() {
    cameraGalleryOpen = false;
    document.getElementById("cameraGalleryModal")?.classList.remove("open");
  }
  function renderCameraGallery() {
    const grid     = document.getElementById("camGalleryGrid");
    const countEl  = document.getElementById("camGalleryCount");
    if (!grid) return;
    const others = visibleStreams();
    if (others.length === 0) { closeCameraGallery(); return; }
    countEl.textContent = others.length;
    grid.innerHTML = "";
    for (const s of others) {
      const tile = document.createElement("div");
      tile.className = "cam-gallery-tile";
      const videoEl = getPeerVideoEl(s.userId, s.stream, s.mirror, "gallery");
      tile.appendChild(videoEl);
      const label = document.createElement("div");
      label.className = "cam-gallery-label";
      label.innerHTML = `<span class="live-cam-dot"></span>${esc(s.name)}`;
      tile.appendChild(label);
      grid.appendChild(tile);
    }
    // Auto-grid column count based on PEER tile count for a balanced layout
    const n = others.length;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  }

  // Click handler (still wired via addEventListener), AND a window-global
  // mirror so the inline onclick="..." attribute in meet.html works even
  // if a JS error elsewhere breaks listener attachment.
  const cameraToggle = () => {
    console.log("[meet] camera button clicked — camStream:", !!camStream, "activeRoom:", !!activeRoom);
    if (camStream) stopCamera();
    else           startCamera();
  };
  window._meetCameraToggle = cameraToggle;

  // Strip a phone to bare digits for a wa.me link, and build a WhatsApp link
  // to a specific peer with a prompt to start a video call.
  function waDigits(p) { return String(p || "").replace(/[^\d]/g, ""); }
  function waVideoHref(phone) {
    const msg = window.t("meet_wa_video_text") || "Let's start a video call on Pawa Meet";
    return `https://wa.me/${waDigits(phone)}?text=${encodeURIComponent(msg)}`;
  }

  // ── Live view over WhatsApp ─────────────────────────────────────────────
  // The in-app WebRTC camera stays; this is an *alternative* way to go live
  // when requested. WhatsApp has no public "start a video call" deep-link, so
  // we open the chat (a direct 1:1 when exactly one peer shared a number, or
  // the contact picker otherwise) pre-filled with the room link + a prompt to
  // start the video call there.
  window._meetWhatsAppVideo = () => {
    const url = activeRoom
      ? `${location.origin}${location.pathname.replace(/[^/]*$/, '')}meet.html?code=${activeRoom.code}`
      : location.href;
    const msg = `${window.t("meet_wa_video_text") || "Let's start a video call on Pawa Meet"}${activeRoom ? ` (room ${activeRoom.code})` : ""}:\n${url}`;
    const withPhone = [...peers.values()]
      .map(p => p.data)
      .filter(d => d && d.user_id !== myUserId && d.phone);
    const href = withPhone.length === 1
      ? `https://wa.me/${waDigits(withPhone[0].phone)}?text=${encodeURIComponent(msg)}`
      : `https://wa.me/?text=${encodeURIComponent(msg)}`;   // 0 or many → pick contact/group
    window.open(href, "_blank", "noopener");
  };

  // ── One-click "Share my live location on WhatsApp" ──────────────────────
  // The headline action: from a cold lobby OR inside a room, a single tap
  //   1. puts the user in a live room (creates one if they're not in one yet),
  //   2. starts broadcasting their GPS,
  //   3. opens WhatsApp pre-filled with a live-view link the recipient opens
  //      in one tap to watch the sender move on the map in real time.
  // Pop-up blockers require window.open() to fire inside the click gesture, so
  // when room setup is async we reserve the tab synchronously (about:blank) and
  // redirect it once the room exists.
  function buildLiveViewUrl() {
    const base = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}meet.html?code=${activeRoom.code}`;
    return (houseCtx && houseCtx.id)
      ? `${base}&house=${encodeURIComponent(houseCtx.id)}`
      : base;
  }
  function buildLiveViewMessage() {
    const url = buildLiveViewUrl();
    const lead = window.t("meet_wa_live_text") || "Follow my live location on Pawa";
    let msg = `${lead} (room ${activeRoom.code}):\n${url}`;
    // Best-effort static pin so the recipient gets *something* even before they
    // open the live map. Only when we already have a fix (don't stall the tap).
    if (lastFix && Number.isFinite(lastFix.lat) && Number.isFinite(lastFix.lng)) {
      msg += `\n\n${window.t("meet_wa_pin_text") || "My location right now"}: ` +
             `https://maps.google.com/?q=${lastFix.lat.toFixed(6)},${lastFix.lng.toFixed(6)}`;
    }
    return msg;
  }
  async function shareLiveViewWhatsApp() {
    let win = null;
    const needRoom = !activeRoom;
    if (needRoom) {
      // Reserve the popup within the user gesture so it isn't blocked.
      try { win = window.open("about:blank", "_blank"); } catch (_) { win = null; }
    }
    try {
      if (needRoom) {
        const name = (
          document.getElementById("createName")?.value ||
          document.getElementById("joinName")?.value ||
          localStorage.getItem("meet_name") || ""
        ).trim() || "Me";
        try { localStorage.setItem("meet_name", name); } catch (_) {}
        myProfile = myProfile || { name, role: (inviteHouseId ? "agent" : "guest") };

        let room;
        if (inviteHouseId && inviteCode) {
          // Live viewing of a listing → reuse the stable per-listing room.
          room = await ensureListingRoom(inviteCode, name);
        } else {
          const purposeSel = document.getElementById("createPurpose");
          const purpose = (purposeSel && purposeSel.value) || "meet";
          const code = await createRoom({ purpose, tracking: null, created_by: name });
          room = { code, purpose };
        }
        await enterRoom(room);
      }

      const href = `https://wa.me/?text=${encodeURIComponent(buildLiveViewMessage())}`;
      if (win) win.location.href = href;
      else window.open(href, "_blank", "noopener");
    } catch (e) {
      if (win) { try { win.close(); } catch (_) {} }
      console.error("[meet] shareLiveViewWhatsApp failed", e);
      alert("Could not start live sharing: " + (e?.message || e));
    }
  }
  window._meetShareLiveWhatsApp = shareLiveViewWhatsApp;
  document.getElementById("waLiveLobbyBtn")?.addEventListener("click", shareLiveViewWhatsApp);
  document.getElementById("waLiveRoomBtn") ?.addEventListener("click", shareLiveViewWhatsApp);

  chatCameraBtn?.addEventListener("click", cameraToggle);
  camSwitchBtn?.addEventListener("click", switchCamera);
  camGalleryBtn?.addEventListener("click", openCameraGallery);
  // Tapping any tile in the strip opens the gallery
  liveCamerasEl?.addEventListener("click", (e) => {
    if (e.target.closest("[data-cam-tile]")) openCameraGallery();
  });
  // ESC closes the gallery
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && cameraGalleryOpen) closeCameraGallery();
  });

  // Pause when tab goes hidden so we don't burn battery / bandwidth in bg
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && camStream) stopCamera();
  });
  window.addEventListener("beforeunload", () => {
    if (camStream) stopCamera({ notify: true });
  });

  // ── Invite deep-link (?code=XXXX [&house=<listing id>]) ──────────────────
  // Opening a shared link (e.g. a client requesting a live viewing from a
  // house page) compacts the lobby to a single focused Join card: code
  // pre-filled, name remembered from last time, one tap to enter.
  const params = new URLSearchParams(location.search);
  const inviteCode    = (params.get("code") || "").toUpperCase();
  const inviteHouseId = params.get("house") || null;
  const rememberedName = localStorage.getItem("meet_name") || "";

  // Remembered name pre-fills both forms (invited or not).
  if (rememberedName) {
    const jn = document.getElementById("joinName");
    const cn = document.getElementById("createName");
    if (jn && !jn.value) jn.value = rememberedName;
    if (cn && !cn.value) cn.value = rememberedName;
  }

  if (inviteCode) {
    document.getElementById("joinCode").value = inviteCode;
    // Compact invite mode: hide everything except the Join card.
    document.querySelector(".fast-hero-card")?.setAttribute("hidden", "");
    document.getElementById("meetCreateCard")?.setAttribute("hidden", "");
    document.querySelector(".meet-features")?.setAttribute("hidden", "");
    document.querySelector(".meet-lobby-grid")?.classList.add("invite-only");
    const banner = document.getElementById("meetInviteBanner");
    if (banner) banner.hidden = false;
    (rememberedName ? joinRoomBtn : document.getElementById("joinName"))?.focus();
  }

  if (inviteHouseId) {
    // This room is a live viewing of a specific listing.
    const jr = document.getElementById("joinRole");
    if (jr) jr.value = "client";
    const icon = document.getElementById("mibIcon");
    if (icon) icon.textContent = "";
    loadHouseCtx(inviteHouseId);
  }

  async function loadHouseCtx(id) {
    try {
      const all = await window.DataStore.getHouses();
      const h = all.find((x) => x.id === id);
      if (!h) return;
      houseCtx = h;
      const t = document.getElementById("mibTitle");
      if (t) t.textContent = `Live viewing: ${h.title}`;
      const sub = document.getElementById("mibSub");
      if (sub) sub.textContent = "Enter your name and tap Join — you'll see the agent live, the property pin on the map, and the room chat.";
      fillListingCard(h);
      if (activeRoom) attachHouseToMap();   // refresh-while-in-room case
    } catch (_) {}
  }

  function fillListingCard(h) {
    const card = document.getElementById("meetListingCard");
    if (!card) return;
    card.href = `house.html?id=${encodeURIComponent(h.id)}`;
    const titleEl = document.getElementById("mlcTitle");
    if (titleEl) titleEl.textContent = h.title || "Listing";
    const price = h.price_tzs
      ? "TZS " + Number(h.price_tzs).toLocaleString("en-US") + (h.listing === "sale" ? "" : " / " + (h.period || "month"))
      : "";
    const metaEl = document.getElementById("mlcMeta");
    if (metaEl) metaEl.textContent = [h.area, h.region, price].filter(Boolean).join(" · ");
    const photo = window.DataStore.housePhotoUrl ? window.DataStore.housePhotoUrl(h.photo) : (h.photo || "");
    const ph = document.getElementById("mlcPhoto");
    if (ph && photo) ph.style.backgroundImage = `url('${photo}')`;
    card.hidden = false;
  }

  // Pin the property itself on the live map so the agent and the client can
  // both see (and navigate to) where the viewing happens.
  function attachHouseToMap() {
    if (!map || !houseCtx) return;
    const lat = +houseCtx.lat, lng = +houseCtx.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (houseMarker) { houseMarker.remove(); houseMarker = null; }
    const el = document.createElement("div");
    el.className = "meet-house-pin";
    el.innerHTML = `
      <svg width="38" height="48" viewBox="0 0 32 42" fill="none">
        <path d="M16 0C7.2 0 0 7.2 0 16c0 12 16 26 16 26s16-14 16-26C32 7.2 24.8 0 16 0z" fill="#0a6f4d" stroke="#fff" stroke-width="2"/>
        <text x="16" y="21" text-anchor="middle" font-size="13"></text>
      </svg>
      <div class="pawa-name-tag" style="background:#0a6f4d">Property</div>`;
    houseMarker = new maplibregl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([lng, lat])
      .setPopup(new maplibregl.Popup({ offset: 22, maxWidth: "240px" }).setHTML(
        `<strong>${esc(houseCtx.title || "Listing")}</strong><br>` +
        `<a href="house.html?id=${encodeURIComponent(houseCtx.id)}" target="_blank" rel="noopener">Open listing →</a><br>` +
        `<a href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}" target="_blank" rel="noopener"> Navigate there</a>`))
      .addTo(map);
    // Until the first GPS fix lands, anchor the view on the property so
    // everyone joins looking at the right place.
    if (!lastFix) map.jumpTo({ center: [lng, lat], zoom: 15 });
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
      await sb.rpc("meet_upsert_presence", {
        p_code:        activeRoom.code,
        p_user_id:     myUserId,
        p_name:        myProfile.name,
        p_phone:       myProfile.phone || null,
        p_role:        myProfile.role || "guest",
        p_lat:         lastFix.lat,
        p_lng:         lastFix.lng,
        p_accuracy_m:  lastFix.accuracy || null,
        p_heading:     lastFix.heading || null,
        p_speed_mps:   lastFix.speed || null,
        p_battery_pct: batt
      });
    } catch (e) {
      console.warn("push", e);
    }
  }

  async function pushStatus(text) {
    if (!sb || !activeRoom || !text) return;
    try {
      await sb.rpc("meet_upsert_presence", {
        p_code: activeRoom.code, p_user_id: myUserId, p_status_text: text
      });
    } catch {}
  }

  // ====================================================================
  //  Realtime: roster + peer markers
  // ====================================================================
  async function refreshRoster() {
    if (!sb || !activeRoom) return;
    // Reads go through a SECURITY DEFINER RPC keyed by the room code (the
    // shared-link capability) — the live_locations table is no longer directly
    // readable, so names/phones/GPS can't be enumerated across rooms.
    const { data, error } = await sb.rpc("meet_room_peers", { p_code: activeRoom.code });
    if (error) { console.warn(error); return; }
    (data || []).sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));

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
    // NOTE: no postgres_changes listener — live_locations is RPC-only now
    // (see meet_secure.sql), so the roster is polled (rosterTimer) instead.
    // This channel still carries the broadcast events (chat + WebRTC signaling).
    realtimeCh = sb.channel(`meet_${activeRoom.code}`)
      .on("broadcast", { event: "chat" }, ({ payload }) => receiveChatMessage(payload))
      .on("broadcast", { event: "camera_meta" }, ({ payload }) => onPeerCameraMeta(payload))
      .on("broadcast", { event: "camera_stop" }, ({ payload }) => onPeerCameraStop(payload))
      .on("broadcast", { event: "rtc_hello"  }, ({ payload }) => rtcHandleHello(payload))
      .on("broadcast", { event: "rtc_offer"  }, ({ payload }) => rtcHandleOffer(payload))
      .on("broadcast", { event: "rtc_answer" }, ({ payload }) => rtcHandleAnswer(payload))
      .on("broadcast", { event: "rtc_ice"    }, ({ payload }) => rtcHandleIce(payload))
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
        p.marker.getPopup()?.setHTML(peerPopupHtml(row));
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
      ${myStreetAddr ? `<div class="peer-street"> ${esc(myStreetAddr)}</div>` : ""}
    </div>`;
  }

  function peerPopupHtml(row) {
    const seenAgo  = humanAgo(row.last_seen);
    const p        = peers.get(row.user_id);
    const roadDist = p?.roadDistKm;
    const roadDur  = p?.roadDurMin;
    const crowDist = lastFix ? haversineKm(lastFix.lat, lastFix.lng, row.lat, row.lng) : null;
    const distLine = roadDist != null
      ? ` <strong>${roadDist.toFixed(1)} km by road</strong> · ~${roadDur} min drive`
      : crowDist != null ? ` ${crowDist.toFixed(2)} km (est)` : "";
    return `
      <div class="peer-popup">
        <strong>${esc(row.display_name || "—")}</strong>
        <span class="muted">${labelRole(row.role)}</span>
        ${p?.streetAddr ? `<div class="peer-street"> ${esc(p.streetAddr)}</div>` : ""}
        ${row.status_text ? `<div class="peer-status">"${esc(row.status_text)}"</div>` : ""}
        ${distLine ? `<div class="peer-meta">${distLine}</div>` : ""}
        <div class="peer-meta muted">last seen ${seenAgo}</div>
        ${row.phone ? `<a class="btn btn-outline btn-xs" href="tel:${row.phone}">Call</a>` : ""}
        ${row.phone ? `<a class="btn btn-xs" style="background:#25d366;color:#fff" target="_blank" rel="noopener" href="${waVideoHref(row.phone)}"> WhatsApp</a>` : ""}
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
        ? (roadKm < 1 ? Math.round(roadKm*1000)+' m' : roadKm.toFixed(1)+' km') + ' '
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
          ? (roadKm < 1 ? Math.round(roadKm * 1000) + " m" : roadKm.toFixed(1) + " km") + " "
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
    const distLabel  = roadDistKm != null
      ? (roadDistKm < 1 ? Math.round(roadDistKm*1000)+" m" : roadDistKm.toFixed(2)+" km") + " by road"
      : (bestKm < 1 ? Math.round(bestKm*1000)+" m" : bestKm.toFixed(2)+" km") + " (est)";
    closestBody.innerHTML = `
      <div class="closest-name">${esc(nearest.display_name)} <span class="muted">${labelRole(nearest.role)}</span></div>
      <div class="closest-distance"> ${distLabel} away</div>
      <div class="muted small">ETA about ${eta} min</div>
      <div class="closest-actions">
        ${nearest.phone ? `<a class="btn btn-outline btn-xs" href="tel:${nearest.phone}">Call</a>` : ""}
        ${nearest.phone ? `<a class="btn btn-xs" style="background:#25d366;color:#fff" target="_blank" rel="noopener" href="${waVideoHref(nearest.phone)}"> WhatsApp</a>` : ""}
        <a class="btn btn-primary btn-xs" target="_blank" rel="noopener"
           href="https://www.google.com/maps/dir/?api=1&destination=${nearest.lat},${nearest.lng}">Navigate</a>
      </div>`;
  }

  // ====================================================================
  //  Roommate polyline — one line through everyone in the room, in name
  //  order, with a single total-distance label at the polyline's middle.
  //  Order is alphabetical by display_name so the path stays stable
  //  across GPS ticks (otherwise the line would reshuffle every update).
  // ====================================================================
  function updateAllPeerLines() {
    if (!map || !map.loaded()) return;
    const lineSrc = map.getSource("meet-peer-lines");
    const lblSrc  = map.getSource("meet-peer-labels");
    if (!lineSrc || !lblSrc) return;

    const all = [];
    if (lastFix) {
      all.push({ name: myProfile?.name || "Me", lat: lastFix.lat, lng: lastFix.lng });
    }
    const peerPts = [];
    for (const p of peers.values()) {
      if (p.data?.lat == null || p.data?.lng == null) continue;
      peerPts.push({
        name: p.data.display_name || "—",
        lat:  p.data.lat,
        lng:  p.data.lng,
      });
    }
    peerPts.sort((a, b) => a.name.localeCompare(b.name));
    all.push(...peerPts);

    if (all.length < 2) {
      lineSrc.setData({ type: "FeatureCollection", features: [] });
      lblSrc.setData({  type: "FeatureCollection", features: [] });
      return;
    }

    const coords = all.map(p => [p.lng, p.lat]);
    let totalKm = 0;
    for (let i = 1; i < all.length; i++) {
      totalKm += haversineKm(all[i-1].lat, all[i-1].lng, all[i].lat, all[i].lng);
    }
    const totalLabel = totalKm < 1
      ? `Total: ${Math.round(totalKm * 1000)} m`
      : `Total: ${totalKm.toFixed(2)} km`;

    lineSrc.setData({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords },
        properties: { dist: totalLabel }
      }]
    });

    // Label at the geographic midpoint of the polyline (the middle
    // segment's midpoint), so it sits visually centered on the path.
    const midIdx = Math.floor(all.length / 2);
    const a = coords[midIdx - 1] || coords[0];
    const b = coords[midIdx]     || coords[0];
    const lblPt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

    lblSrc.setData({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "Point", coordinates: lblPt },
        properties: { dist: totalLabel }
      }]
    });
  }

  // ====================================================================
  //  Room chat (Supabase broadcast — no DB)
  //  Supports text, photo (data URL), and audio (data URL) messages.
  //  Nothing is persisted: messages live in-memory in this tab only and
  //  disappear on refresh, which is intentional.
  // ====================================================================
  async function sendChatMessage(opts) {
    if (!realtimeCh || !activeRoom || !opts) return;
    const msg = {
      id:     Date.now() + "-" + myUserId.slice(0, 6),
      userId: myUserId,
      name:   myProfile?.name || "Me",
      role:   myProfile?.role || "guest",
      time:   new Date().toISOString()
    };
    if (opts.text)  { msg.kind = "text";  msg.text  = opts.text.trim(); }
    if (opts.photo) { msg.kind = "photo"; msg.photo = opts.photo; }
    if (opts.audio) { msg.kind = "audio"; msg.audio = opts.audio; msg.mime = opts.mime || "audio/webm"; }
    if (!msg.kind) return;
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
    chatMsgsEl.innerHTML = chatMessages.map(m => {
      const head = !m.mine
        ? `<div class="chat-bubble-name">${esc(m.name || "—")} <span style="font-weight:400;opacity:.7">${labelRole(m.role)}</span></div>`
        : "";
      let body = "";
      if (m.kind === "photo" && m.photo) {
        body = `<img class="chat-photo" src="${m.photo}" alt="photo" onclick="window.open(this.src,'_blank')">`;
      } else if (m.kind === "audio" && m.audio) {
        body = `<audio class="chat-audio" controls preload="metadata" src="${m.audio}"></audio>`;
      } else {
        body = esc(m.text || "");
      }
      return `<div class="chat-bubble ${m.mine ? "mine" : "theirs"}">
        ${head}${body}
        <div class="chat-bubble-time">${chatTime(m.time)}</div>
      </div>`;
    }).join("");
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
          <span>·  ${wind} km/h</span>
          <span>·  ${c.relative_humidity_2m}%</span>
          ${c.precipitation > 0 ? `<span>·  ${c.precipitation} mm</span>` : ""}
        </div>`;

      // Update map weather overlay card
      const mc = document.getElementById("mapWeatherCard");
      if (mc) {
        document.getElementById("mapWeatherIcon").textContent = emoji;
        document.getElementById("mapWeatherTemp").textContent = tempC + "°C";
        document.getElementById("mapWeatherDesc").textContent = desc + " ·  " + wind + " km/h";
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

  // Create — or re-open, since per-listing codes are stable — the meet room
  // for a live property viewing. Safe under races: a duplicate insert means
  // the other party just created it, which is exactly what we wanted.
  async function ensureListingRoom(code, created_by) {
    if (!sb) return { code, purpose: "viewing" };
    const { data } = await sb.from("meet_rooms").select("*").eq("code", code).maybeSingle();
    if (!data) {
      const { error } = await sb.from("meet_rooms")
        .insert({ code, purpose: "viewing", created_by });
      if (error && error.code !== "23505") throw error;
    } else if (data.status !== "active" || new Date(data.expires_at).getTime() < Date.now()) {
      const { error } = await sb.from("meet_rooms")
        .update({ status: "active", expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString() })
        .eq("code", code);
      if (error) throw error;
    }
    return (await fetchRoom(code)) || { code, purpose: "viewing" };
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
    return window.t(k) || ({
      agent: "House agent", provider: "Service provider", landlord: "Landlord / Owner",
      client: "Client / Buyer", tenant: "Tenant / Renter", guest: "Other",
    })[r] || (r || "guest");
  }
  function labelPurpose(p) {
    const k = "meet_purpose_" + (p || "meet");
    return window.t(k) || ({
      viewing: "Live property viewing",
      service: "Service visit",
      agent: "Meeting a house agent",
      handover: "Key / property handover",
      meet: "Meeting up",
    })[p] || (p || "meet");
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
      const j = await pawaGeo.reverse(`format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=en`);
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
    return { agent: '#8b5cf6', provider: '#f59e0b', landlord: '#ec4899', client: '#0ea5e9', tenant: '#22c55e', guest: '#6b7280' }[role] || '#6b7280';
  }
  function roleEmoji(role) {
    return { agent: '', provider: '', landlord: '', client: '', tenant: '', guest: '' }[role] || '';
  }

  // Open-Meteo weather codes (WMO)
  function weatherEmoji(code) {
    if (code == null) return "";
    if (code === 0) return "";
    if (code <= 2)  return "";
    if (code === 3) return "";
    if (code === 45 || code === 48) return "";
    if (code >= 51 && code <= 67)   return "";
    if (code >= 71 && code <= 77)   return "";
    if (code >= 80 && code <= 82)   return "";
    if (code >= 95)                 return "";
    return "";
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
