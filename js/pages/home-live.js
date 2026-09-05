// ============================================================================
//  home-live.js  (index.html)
//  The four blocks at the top of the home feed, made to behave like an app
//  rather than a poster. Pairs with js/lib/native-feel.js for the physical
//  layer and leaves js/pages/home-bands.js owning the band rotation.
//
//    1. The radar tells the truth. It used to sweep over nothing: three rings
//       and a spinner that meant "near you" as decoration. Given a fix it now
//       plots REAL listings, each blip at its true bearing and at a radius
//       proportional to its real distance, and says how many are within reach
//       and how far the closest one is.
//
//    2. The area card opens in place. Tapping it used to cost a page load
//       before you could type a single letter. The field, the matches and the
//       areas you opened before are all here; area.html is still one tap on.
//
//    3. Everything presses back, and arrives rather than being already there.
//
//  THE RULE THIS FILE INHERITS from home-bands.js: a number is never invented.
//  No fix, or no rows carrying coordinates, and the radar keeps its invitation
//  copy and draws no blips at all. A radar reporting a return it does not have
//  is worse than one that admits it is switched off.
//
//  It also never ASKS for location on load. Permission is read, and a fix is
//  used only if the browser already has one; the prompt belongs to a tap, not
//  to arriving on a home page.
// ============================================================================

(function () {
  "use strict";

  const NF = window.NativeFeel || {};
  // window.t() takes a key and nothing else: no fallback, no interpolation,
  // and it returns the KEY ITSELF when the string is missing. Both of those
  // have to be handled here or a missing key prints as "near_live_within" and
  // a present one prints its braces raw.
  const t = (k, f, vars) => {
    let out = window.t ? window.t(k) : null;
    if (!out || out === k) out = f;
    if (vars) Object.keys(vars).forEach((n) => {
      out = String(out).split("{" + n + "}").join(vars[n]);
    });
    return out;
  };
  const $ = (id) => document.getElementById(id);

  // Distances big enough to be worth drawing. Beyond this the blips crowd the
  // rim and "near you" stops being true.
  const RADAR_KM = 25;
  const MAX_BLIPS = 7;
  const RECENT_KEY = "pawa.recentAreas";
  const RECENT_MAX = 6;

  // ---- small geo ------------------------------------------------------------
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  function km(a, b) {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
      Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
    return (Math.atan2(y, x) * 180) / Math.PI;
  }
  const fmtKm = (d) => (d < 1
    ? Math.round(d * 1000) + " m"
    : (d < 10 ? d.toFixed(1) : Math.round(d)) + " km");

  // ==========================================================================
  //  1. The radar
  // ==========================================================================
  async function liveRadar() {
    const radar = $("haRadar"), live = $("haNearLive"), sub = $("haNearSub");
    if (!radar || !live || !window.pawaLocate || !window.DataStore) return;

    // The remembered fix FIRST, because it is free and instant. Asking
    // pawaLocate.best() up front looked right and was measurably wrong: it
    // holds a watch open for up to six seconds to tighten GPS accuracy, so the
    // card sat on its invitation copy for most of the time anybody was looking
    // at it and then changed under them. A radar is worth 40 metres of error
    // and worth none of that wait.
    let fix = null;
    try { fix = window.pawaLocate.lastKnown(); } catch (_) { fix = null; }

    // No remembered fix, but permission already granted: ask, and accept the
    // wait, because there is nothing on screen to spoil in that case.
    if (!fix) {
      try {
        const state = await window.pawaLocate.permissionState();
        if (state === "granted") fix = await window.pawaLocate.best({ timeout: 6000 });
      } catch (_) { fix = null; }
    }
    if (!fix || typeof fix.lat !== "number" || typeof fix.lng !== "number") return;

    let rows = [];
    try {
      const [h, tk] = await Promise.all([
        window.DataStore.getHouses().catch(() => []),
        window.DataStore.getTrucks().catch(() => []),
      ]);
      rows = [].concat(h || [], tk || []);
    } catch (_) { return; }

    // Only rows that actually carry a coordinate. A listing with no pin is not
    // "at distance zero", it is simply not on this instrument.
    const near = rows
      .filter((r) => typeof r.lat === "number" && typeof r.lng === "number")
      .map((r) => ({ d: km(fix, r), b: bearing(fix, r) }))
      .filter((r) => r.d <= RADAR_KM)
      .sort((a, b) => a.d - b.d);

    if (!near.length) return;   // nothing true to say, so nothing is said

    // The reading.
    live.innerHTML =
      '<span class="ha-near-pill"><i></i>' + esc(t("near_live", "Live")) + "</span>" +
      "<b>" + near.length + "</b>" +
      "<span>" + esc(t("near_live_within", "within {km} km", { km: RADAR_KM })) +
      ", " + esc(t("near_live_nearest", "closest {d}", { d: fmtKm(near[0].d) })) + "</span>";
    live.hidden = false;
    if (sub) sub.hidden = true;

    // The picture. Radius is the real distance scaled into the dial, angle is
    // the real bearing, with 0 degrees pointing up the way a map does.
    const half = radar.offsetWidth / 2 || 36;
    near.slice(0, MAX_BLIPS).forEach((r, i) => {
      const rr = Math.min(0.92, 0.16 + (r.d / RADAR_KM) * 0.76) * half;
      const a = rad(r.b - 90);
      const el = document.createElement("span");
      el.className = "ha-near-blip";
      el.style.left = (half + rr * Math.cos(a)) + "px";
      el.style.top = (half + rr * Math.sin(a)) + "px";
      el.style.animationDelay = (i * 70) + "ms";
      radar.appendChild(el);
    });
  }

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ==========================================================================
  //  2. The area card, opened in place
  // ==========================================================================
  function recentAreas() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").slice(0, RECENT_MAX); }
    catch (_) { return []; }
  }
  function rememberArea(name) {
    try {
      const list = recentAreas().filter((x) => x.toLowerCase() !== name.toLowerCase());
      list.unshift(name);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
    } catch (_) {}
  }
  const goArea = (name) => {
    rememberArea(name);
    location.href = "area.html?q=" + encodeURIComponent(name);
  };

  function wireArea() {
    const card = document.querySelector("a.ha-door--area");
    const wrap = $("haAreaOpen"), input = $("haAreaInput");
    const chips = $("haAreaChips"), lbl = $("haAreaLbl");
    if (!card || !wrap || !input || !chips) return;

    let regions = null;         // loaded once, on first open
    let open = false;

    const paint = (list, isRecent) => {
      chips.innerHTML = "";
      // A heading with nothing under it is what the region list looked like
      // every time it failed to load. Say so instead, and keep the field,
      // which works on its own: area.html resolves a typed name.
      if (!list.length) {
        if (lbl) lbl.hidden = true;
        const note = document.createElement("p");
        note.className = "ha-area-note";
        note.textContent = t("area_none", "Type a place and press enter.");
        chips.appendChild(note);
        return;
      }
      list.slice(0, 8).forEach((name) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ha-area-chip";
        b.textContent = name;
        b.addEventListener("click", () => {
          if (NF.haptic) NF.haptic("select");
          goArea(name);
        });
        if (NF.pressable) NF.pressable(b);
        chips.appendChild(b);
      });
      if (lbl) {
        lbl.textContent = isRecent
          ? t("area_recent", "Recently opened")
          : t("area_suggest", "Start with a region");
        lbl.hidden = false;
      }
    };

    const loadRegions = async () => {
      // An empty list is a load that failed, not an answer, so it is NOT
      // remembered: the first open would paint nothing and every open after it
      // would reuse that nothing without ever asking again.
      if (regions && regions.length) return regions;
      try {
        const rows = await window.DataStore.getRegions();
        const list = (rows || []).map((r) => (typeof r === "string" ? r : r && r.name))
          .filter(Boolean);
        if (list.length) regions = list;
        return list;
      } catch (_) { return regions || []; }
    };

    const setOpen = async (v) => {
      open = v;
      wrap.classList.toggle("is-open", v);
      // The card squares off its bottom corners so it and the panel read as
      // one object rather than two boxes overlapping.
      card.classList.toggle("is-open", v);
      card.setAttribute("aria-expanded", v ? "true" : "false");
      if (!v) return;
      const rec = recentAreas();
      if (rec.length) { paint(rec, true); }
      else {
        // PAINT FIRST, then correct. The regions come off the network, and
        // awaiting them before painting anything meant the panel spent that
        // whole round-trip as an empty box under a heading, which is exactly
        // the bare heading this file exists to avoid. The fallback line goes
        // in immediately and the chips replace it when they land.
        paint([], false);
        const list = await loadRegions();
        // Still open, and the reader has not started typing: anything else and
        // a late answer would overwrite what they are looking at now.
        if (open && !input.value.trim()) paint(list, false);
      }
      // Focus after the row has height, or the keyboard opens against a
      // collapsed panel and the page jumps.
      setTimeout(() => { try { input.focus({ preventScroll: true }); } catch (_) {} }, 280);
    };

    // Warm the list now rather than on the first tap. It is one cached read
    // the page already makes for the trust strip, and DataStore single-flights
    // it, so this costs no extra request and buys the panel its chips before
    // anybody has opened it.
    loadRegions().catch(() => {});

    card.setAttribute("role", "button");
    card.setAttribute("aria-expanded", "false");
    card.setAttribute("aria-controls", "haAreaOpen");
    card.addEventListener("click", (e) => {
      // The href stays as the no-script fallback; with script, the panel is a
      // faster answer to the same question.
      e.preventDefault();
      if (NF.haptic) NF.haptic("select");
      setOpen(!open);
    });

    input.addEventListener("input", async () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { const rec = recentAreas(); paint(rec.length ? rec : await loadRegions(), rec.length > 0); return; }
      const all = await loadRegions();
      const hit = all.filter((n) => n.toLowerCase().includes(q));
      // A typed place we do not stock a region for is still a valid search:
      // area.html resolves wards and villages that this list never had.
      paint(hit.length ? hit : [input.value.trim()], false);
      if (lbl) { lbl.textContent = t("area_matches", "Matches"); lbl.hidden = false; }
    });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const v = input.value.trim();
      if (v) goArea(v);
    });
  }

  // ==========================================================================
  //  3. The physical layer
  // ==========================================================================
  function wireFeel() {
    // One card class now, so one call. The doors, the "can't find it" pair,
    // the Frame and the two earn doors are all .ha-find-card.
    if (NF.pressableAll) NF.pressableAll(".ha-find-card");
    if (NF.reveal) NF.reveal(".ha-find-card", { stagger: 70 });
  }

  function boot() {
    try { wireFeel(); } catch (e) { console.warn("[home-live] feel", e); }
    try { wireArea(); } catch (e) { console.warn("[home-live] area", e); }
    // Last, and allowed to fail: it is the only part that touches the network,
    // and the card reads correctly without it. It is NOT allowed to fail
    // silently, though. An empty catch here hid a real bug for three runs: the
    // radar simply stayed dark and there was nothing anywhere to say why.
    liveRadar().catch((e) => console.warn("[home-live] radar", e));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else { boot(); }
})();
