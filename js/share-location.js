// ============================================================================
//  share-location.js — the on-site person's one-tap GPS share.
//
//  Opened from a link the agent sends (?c=<meet room code>). One button captures
//  the device GPS and writes it to live_locations for that room; the agent's
//  listing form is subscribed to the same room and drops the pin instantly.
//  No login. Reuses the public meet_rooms / live_locations tables.
// ============================================================================
(function () {
  "use strict";
  const params = new URLSearchParams(location.search);
  const code = (params.get("c") || "").trim().toUpperCase();
  const C = window.APP_CONFIG || {};
  const sb = (window.supabase && C.SUPABASE_URL && C.SUPABASE_ANON_KEY)
    ? window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY)
    : null;

  const $ = (id) => document.getElementById(id);
  const statusEl = $("slStatus");
  const btn = $("slBtn");

  if (!code)  { statusEl.textContent = "Invalid link — it has no code."; btn.disabled = true; return; }
  if (!sb)    { statusEl.textContent = "Service unavailable right now."; btn.disabled = true; return; }

  btn.addEventListener("click", () => {
    if (!navigator.geolocation) { statusEl.textContent = "This device can't share location."; return; }
    btn.disabled = true;
    statusEl.textContent = "Getting your location…";
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      try {
        const { error } = await sb.from("live_locations").insert({
          room_code: code,
          user_id: "onsite-" + Math.random().toString(36).slice(2, 8),
          display_name: "At the house",
          role: "onsite",
          lat, lng, accuracy_m: accuracy || null,
        });
        if (error) throw error;
        statusEl.innerHTML = " Location shared with the agent.<br>You can close this page now.";
        btn.style.display = "none";
      } catch (e) {
        statusEl.textContent = "Couldn't send: " + (e.message || e);
        btn.disabled = false;
      }
    }, (err) => {
      statusEl.textContent = (err && err.code === err.PERMISSION_DENIED)
        ? "Please allow location access, then tap again."
        : "Couldn't get your location. Move outside and try again.";
      btn.disabled = false;
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
})();
