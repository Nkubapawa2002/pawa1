// ============================================================================
//  share-location.js — one tap, one exact spot.
//
//  TWO WAYS IN, and they are not the same job:
//
//  1. AGENT MODE  (?c=<meet room code>)
//     The agent sends this link to whoever is standing at the property. One
//     button captures the device GPS and writes it to live_locations for that
//     room; the agent's listing form is subscribed to the same room and drops
//     the pin instantly. No login. Reuses the public meet_rooms /
//     live_locations tables.
//
//  2. SHARE MODE  (no code — how P-Chat opens it)
//     P-Chat offers "Share a location — send anyone the exact spot of a house,
//     a shop or a meeting point". That door used to arrive here with no code,
//     and the page answered "Invalid link — it has no code" with the button
//     disabled: a tool advertised on the tab and dead on arrival. So without a
//     code the page does the obvious thing instead — captures where you are
//     and hands you a link anyone can open in their maps app. Nothing is sent
//     anywhere; the link is yours to send.
//
//  Location goes through pawaLocate (js/lib/geolocate.js) rather than raw
//  navigator.geolocation, because it already knows how to wait for a real fix
//  and how to explain a refusal in words a person can act on.
// ============================================================================
(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  const code = (params.get("c") || "").trim().toUpperCase();
  const C = window.APP_CONFIG || {};
  const sb = (window.supabase && C.SUPABASE_URL && C.SUPABASE_ANON_KEY)
    ? window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY)
    : null;

  const T = (k) => (window.t ? window.t(k) : k);
  const $ = (id) => document.getElementById(id);
  const statusEl = $("slStatus");
  const btn = $("slBtn");
  const titleEl = $("slTitle");
  const leadEl = $("slLead");
  const resultEl = $("slResult");

  // A fix, however we got it: { lat, lng, accuracy } from pawaLocate, falling
  // back to the raw API if the library is not on the page.
  async function locate() {
    if (window.pawaLocate && window.pawaLocate.supported()) {
      return window.pawaLocate.best({ maxWaitMs: 20000 });
    }
    if (!navigator.geolocation) throw new Error(T("sl_no_gps"));
    return new Promise((res, rej) => {
      navigator.geolocation.getCurrentPosition(
        (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
        rej,
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }

  function explain(e) {
    if (window.pawaLocate && window.pawaLocate.message) return window.pawaLocate.message(e);
    return (e && e.message) || T("sl_fail");
  }

  // ---------------------------------------------------------------- share mode
  function startShareMode() {
    if (titleEl) titleEl.textContent = T("sl_share_title");
    if (leadEl) leadEl.innerHTML = T("sl_share_lead");
    btn.textContent = T("sl_share_btn");

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      statusEl.textContent = T("sl_getting");
      try {
        const fix = await locate();
        const lat = Number(fix.lat).toFixed(6), lng = Number(fix.lng).toFixed(6);
        // A plain geo query every maps app understands — Google Maps, Apple
        // Maps and OSM all open it, so the receiver needs nothing installed.
        const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
        const acc = fix.accuracy ? T("sl_accuracy").replace("{m}", Math.round(fix.accuracy)) : "";

        statusEl.textContent = "";
        resultEl.hidden = false;
        resultEl.innerHTML = `
          <div class="sl-coords">${lat}, ${lng}</div>
          <div class="sl-acc">${acc}</div>
          <div class="sl-actions">
            <button id="slSend" class="sl-act sl-act-primary" type="button">${T("sl_send_link")}</button>
            <a id="slOpen" class="sl-act" href="${url}" target="_blank" rel="noopener">${T("sl_open_maps")}</a>
          </div>
          <button id="slAgain" class="sl-again" type="button">${T("sl_again")}</button>`;

        const text = `${T("sl_share_text")}\n${url}`;
        $("slSend").addEventListener("click", async () => {
          // Web Share where it exists (that is the native sheet on a phone),
          // then the clipboard, then a prompt the person can copy out of — the
          // same ladder js/pages/house.js uses, and for the same reason: the
          // clipboard API fails on http:// and inside some in-app browsers.
          if (navigator.share) {
            try { await navigator.share({ title: T("sl_share_title"), text, url }); return; } catch (_) { /* cancelled */ }
          }
          try {
            await navigator.clipboard.writeText(text);
            statusEl.textContent = T("sl_copied");
            return;
          } catch (_) {}
          try { window.prompt(T("sl_copy_manual"), url); } catch (_) {}
        });
        $("slAgain").addEventListener("click", () => {
          resultEl.hidden = true; resultEl.innerHTML = "";
          statusEl.textContent = "";
          btn.disabled = false;
        });
        btn.style.display = "none";
      } catch (e) {
        statusEl.textContent = explain(e);
        btn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------- agent mode
  function startAgentMode() {
    if (!sb) { statusEl.textContent = T("sl_unavailable"); btn.disabled = true; return; }

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      statusEl.textContent = T("sl_getting");
      try {
        const fix = await locate();
        const { error } = await sb.from("live_locations").insert({
          room_code: code,
          user_id: "onsite-" + Math.random().toString(36).slice(2, 8),
          display_name: "At the house",
          role: "onsite",
          lat: fix.lat, lng: fix.lng, accuracy_m: fix.accuracy || null,
        });
        if (error) throw error;
        statusEl.innerHTML = T("sl_sent");
        btn.style.display = "none";
      } catch (e) {
        // A geolocation refusal and a database failure are different problems
        // and deserve different sentences.
        statusEl.textContent = (e && (e.code === 1 || e.code === 2 || e.code === 3))
          ? explain(e)
          : T("sl_send_fail");
        try { console.error("[share-location] send failed:", e); } catch (_) {}
        btn.disabled = false;
      }
    });
  }

  if (code) startAgentMode();
  else startShareMode();
})();
