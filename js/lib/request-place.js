// =====================================================================
// Request a place — TYPE it (or tap your location), and SEE where it lands
// =====================================================================
// The simplest way for a seeker to raise demand: pick their REGION (the hard
// routing key), optionally name the area, say the PRICE and WHEN. We save it as
// a house_demand_pin tagged with that region, and every agent operating there
// sees it on their dashboard and can call them.
//
// Why a region PICKER (not just a typed place): in Tanzania many street/area
// names are informal and don't geocode. If we required a findable place, those
// requests would dead-end and never reach an agent. So:
//   • the REGION is chosen from the canonical list (or set from GPS) and is
//     ALWAYS present → every request is routed to the right agents;
//   • the typed area is an OPTIONAL label we try to geocode for precision, and
//     if it can't be found we fall back to the GPS point, then the region
//     centroid — sending never fails.
//
// Why there is now a MAP in here. That fallback chain is the whole point of
// this modal and it was also completely invisible: someone typed "Mikocheni",
// the geocoder missed, and the request silently went out on the centroid of Dar
// es Salaam with a radius nobody chose. The seeker saw "Request sent" either
// way. So the modal draws the point it is ABOUT to send, and the circle it will
// be matched on (house_demand_near matches on `greatest(d.radius_m, …)`, so the
// radius is a real number with real consequences, not decoration). Three rules
// hold it honest:
//   1. the map shows the point that will be SENT — the preview runs the same
//      fallback chain, and submit sends the point the map is showing;
//   2. the caption says WHICH step of the chain won, so "middle of the region"
//      never masquerades as "your street";
//   3. a pin the seeker drags beats every automatic step, and nothing later
//      moves it back.
// Leaflet is fetched only when the modal opens — two of the three pages that
// include this file have no map of their own — and if it never arrives the
// modal keeps working, with the caption saying so.
//
// It reuses the same house_demand_pins table + privacy model as the map-based
// area alerts (the phone is only ever returned to agents via SECURITY DEFINER
// RPCs), so this is purely a friendlier ON-RAMP, not a new data path.
//
//   window.pawaRequestPlace.open();              // open the request modal
//   window.pawaRequestPlace.open({ region });    // prefill a region
//   window.pawaRequestPlace.openMine();          // "my requests" + remove
(function () {
  "use strict";

  const esc = (s) => window.escHtml ? window.escHtml(s) : String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Translate via the central i18n dictionary (rp_* keys). Falls back to the key
  // (then English inside window.t) so the modal never shows a blank.
  const T = (k) => (window.t ? window.t(k) : k);

  const MINE_KEY = "pawa_my_demand_pins";
  let picked = null;      // { lat, lng, name, region } chosen from suggestions
  let gpsPoint = null;    // { lat, lng } from "use my location"
  let gpsDistrict = null; // district reverse-geocoded from the GPS point
  let pinned = null;      // { lat, lng } the seeker placed BY HAND on the map
  let sugTimer = null;

  // ---- map constants ------------------------------------------------------
  // Same Leaflet build every other map page in this repo pins, so a seeker who
  // has already opened houses.html gets it from cache instead of the network.
  const LEAFLET_CSS = "https://cdn.jsdelivr.net/npm/leaflet@1.9/dist/leaflet.css";
  const LEAFLET_JS  = "https://cdn.jsdelivr.net/npm/leaflet@1.9/dist/leaflet.js";
  const LEAFLET_WAIT_MS = 9000;   // past this we show the modal without a map

  // 3 km is what every request sent before this map existed used, so it stays
  // the default — this change must not silently re-scope anybody's search.
  const RADIUS_MIN_KM = 1, RADIUS_MAX_KM = 25, RADIUS_DEFAULT_KM = 3;
  const MAP_DEBOUNCE_MS = 420;    // longer than the suggestion debounce (320ms)
  // The view is FITTED to the circle rather than set to a fixed zoom: the
  // circle is the thing the request is matched on, and at a zoom picked in
  // advance it is either a dot behind the marker or larger than the box. These
  // are only ceilings, so a 1 km circle cannot zoom into somebody's roof.
  const FIT_MAX_ZOOM = 14;          // a pin, a picked place, a GPS fix
  const FIT_MAX_ZOOM_REGION = 12;   // a centroid: keep some of the region in frame
  const FIT_PAD = 16;

  // ---- text helpers -------------------------------------------------------

  // Normalise a raw region string (e.g. "Dar es Salaam Region") to the canonical
  // name agents pick from (data/regions.json), so region matching actually lines
  // up between a seeker's typed request and an agent's declared region.
  async function canonRegion(raw) {
    raw = String(raw || "").replace(/\s+region$/i, "").trim();
    if (!raw) return null;
    try {
      const regs = (window.DataStore && await window.DataStore.getRegions()) || [];
      const lc = raw.toLowerCase();
      const exact = regs.find((r) => r.toLowerCase() === lc);
      if (exact) return exact;
      const part = regs.find((r) => lc.includes(r.toLowerCase()) || r.toLowerCase().includes(lc));
      if (part) return part;
    } catch (_) {}
    return raw;
  }

  // Strip a "District"/"Wilaya" suffix so a reverse-geocoded district lines up
  // with the agent's declared district (agent_profiles.district).
  function canonDistrict(raw) {
    return String(raw || "").replace(/\s+(district|wilaya)$/i, "").trim() || null;
  }

  // Simplify a messy area label into one clean, specific area string:
  //   • a "double dash"/" - "/"—" between words becomes a comma boundary
  //     (intra-word hyphens like "self-contained" are left alone);
  //   • runs of whitespace collapse;
  //   • duplicate comma-segments (case-insensitive) are dropped, keeping the
  //     first — so "Mikocheni - Mikocheni B, Kinondoni" → "Mikocheni, Mikocheni B, Kinondoni".
  function simplifyArea(s) {
    let t = String(s || "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    t = t.replace(/(\s+[-–—]+\s+|[-–—]{2,})/g, ", ");   // spaced/doubled dashes → comma
    const seen = new Set();
    const parts = t.split(",")
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter((p) => { const k = p.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    return parts.join(", ");
  }

  // Loose place-name equality. Geocoders and our own gazetteer disagree about
  // punctuation and spacing for the same place — "Dar es Salaam" comes back as
  // "Dar es-Salaam" — so compare the letters and digits and nothing else.
  const normPlace = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

  // Put the hits that sit in the region the seeker already chose at the top.
  // Tanzania reuses place names heavily — there is a Mikocheni in Dar and a
  // Mikocheni in Arusha, 600 km apart — and the geocoder has no idea which one
  // was meant. We do: the region is already on the form. Non-matching hits are
  // kept, just lower, because the region can be the thing that is wrong.
  function preferRegion(list, region) {
    const want = normPlace(String(region || "").replace(/\s+region$/i, ""));
    if (!want || !Array.isArray(list) || list.length < 2) return list || [];
    const hit = (h) => normPlace([h.context, h.full, h.name].filter(Boolean).join(" ")).includes(want);
    const inRegion = list.filter(hit), rest = list.filter((h) => !hit(h));
    return inRegion.concat(rest);
  }

  // Region centroid from the bundled gazetteer (js/lib/tz-places.js) — the last-
  // resort point so a request with no findable street still has coordinates.
  function regionCentroid(name) {
    const lc = String(name || "").toLowerCase().replace(/\s+region$/, "").trim();
    if (!lc) return null;
    const list = window.TZ_REGION_CENTERS || [];
    return list.find((r) => r.kind === "region" &&
      (r.name.toLowerCase() === lc || (r.aliases || []).includes(lc))) || null;
  }

  // Build the human-readable spec line that travels to the agent in `note`
  // (every demand RPC already returns `note`, so no schema change is needed).
  // It carries the specs that DON'T have their own column — self-contained,
  // furnished, bathrooms, payment plan, must-have amenities, and the seeker's
  // free-text "what to avoid" — so the agent sees the full requirement and can
  // skip places that don't fit.
  function buildSpecNote(spec) {
    const parts = [];
    if (spec.selfContained) parts.push("Self-contained");
    if (spec.furnished) parts.push(spec.furnished);
    if (spec.baths) parts.push(spec.baths + "+ bath");
    if (spec.pay === "Monthly") parts.push("pays monthly");
    else if (spec.pay === "Flexible") parts.push("flexible payment");
    else if (spec.pay) parts.push("can pay " + spec.pay + " upfront");
    if (spec.amenities && spec.amenities.length) parts.push("must have: " + spec.amenities.join(", "));
    let note = parts.join(" · ");
    const extra = String(spec.elseText || "").replace(/\s+/g, " ").trim();
    if (extra) note += (note ? " · " : "") + "avoid/notes: " + extra;
    return note || null;
  }

  // ---- styles -------------------------------------------------------------

  function ensureStyles() {
    if (document.getElementById("rpStyles")) return;
    const s = document.createElement("style");
    s.id = "rpStyles";
    s.textContent = `
      .rp-back{position:fixed;inset:0;z-index:100000;display:flex;align-items:flex-end;justify-content:center;
        background:rgba(2,6,23,.6);padding:0}
      @media(min-width:560px){.rp-back{align-items:center;padding:20px}}
      .rp-card{background:#fff;color:#16201b;width:100%;max-width:440px;max-height:92vh;overflow:auto;
        border-radius:18px 18px 0 0;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.35);
        font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
      @media(min-width:560px){.rp-card{border-radius:18px}}
      /* This sheet is opened from pages whose body sets its own text colour and
         display face — p-chat.html paints #E9F3EE on a near-black ground. An
         h2 that inherits either of those lands as pale serif on this white
         card. The card is its own surface, so it states its own. */
      .rp-card h2{margin:0 0 3px;font-size:1.18rem;color:#16201b;font-family:inherit}
      .rp-card .rp-lead{margin:0 0 15px;color:#52605a;font-size:.9rem}
      .rp-row{margin-bottom:12px;position:relative}
      .rp-row label{display:block;font-weight:700;font-size:.82rem;margin:0 0 5px;color:#34403a}
      .rp-row label small{font-weight:400;color:#7a877f}
      .rp-row input,.rp-row select{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cdd9d3;
        border-radius:10px;font-size:1rem;background:#fff;color:#16201b}
      .rp-row input:focus,.rp-row select:focus{outline:none;border-color:#0a6f4d;box-shadow:0 0 0 3px rgba(10,111,77,.15)}
      .rp-2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .rp-loc{margin-top:7px;width:100%;display:inline-flex;align-items:center;justify-content:center;gap:6px;
        padding:9px 12px;min-height:44px;box-sizing:border-box;border:1px dashed #0a6f4d;border-radius:10px;
        background:#f2faf6;color:#0a6f4d;font-weight:700;font-size:.86rem;cursor:pointer}
      .rp-loc:disabled{opacity:.6;cursor:default}
      .rp-sug{position:absolute;left:0;right:0;top:100%;z-index:5;background:#fff;border:1px solid #d8e6df;
        border-radius:0 0 10px 10px;max-height:210px;overflow:auto;box-shadow:0 12px 30px rgba(0,0,0,.14)}
      .rp-sug[hidden]{display:none}
      .rp-sug button{display:block;width:100%;text-align:left;border:0;background:none;padding:11px 12px;
        min-height:44px;box-sizing:border-box;cursor:pointer;font:inherit;color:#16201b;border-bottom:1px solid #f0f3f1}
      .rp-sug button:hover{background:#f2f7f4}
      .rp-sug b{display:block;font-size:.9rem}
      .rp-sug span{font-size:.78rem;color:#6b7a73}
      .rp-picked{font-size:.8rem;color:#0a6f4d;margin-top:5px;font-weight:600}
      .rp-go{width:100%;padding:13px;border:0;border-radius:11px;background:#0a6f4d;color:#fff;font-weight:800;
        font-size:1rem;cursor:pointer;margin-top:4px}
      .rp-go:disabled{opacity:.6;cursor:default}
      .rp-foot{display:flex;gap:8px;margin-top:8px}
      .rp-link{flex:1;padding:10px;min-height:44px;border:0;border-radius:11px;background:none;color:#64748b;
        font-size:.92rem;cursor:pointer}
      .rp-link.rp-strong{color:#0a6f4d;font-weight:700}
      .rp-msg{min-height:18px;font-size:.84rem;color:#b91c1c;margin:2px 0 6px}
      .rp-msg.ok{color:#0a6f4d}
      .rp-done{text-align:center;padding:10px 4px}
      .rp-done .rp-tick{width:54px;height:54px;border-radius:50%;background:#e7f5ee;color:#0a6f4d;display:flex;
        align-items:center;justify-content:center;font-size:28px;margin:6px auto 12px}
      .rp-done h3{margin:0 0 6px;font-size:1.1rem;color:#0a6f4d}
      .rp-done p{margin:0 0 14px;color:#41504a;font-size:.92rem;line-height:1.5}
      .rp-mine{margin:8px 0 0;padding:0;list-style:none}
      .rp-mine li{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;
        padding:11px 0;border-top:1px solid #eef2f0}
      .rp-mine li:first-child{border-top:0}
      .rp-mine .rp-mine-where{font-weight:700;font-size:.92rem;color:#16201b}
      .rp-mine .rp-mine-sub{font-size:.78rem;color:#6b7a73;margin-top:2px}
      .rp-mine .rp-rm{flex-shrink:0;padding:7px 12px;min-height:40px;border:1px solid #f0c9c4;border-radius:9px;
        background:#fff5f4;color:#b3261e;font-weight:700;font-size:.82rem;cursor:pointer}
      .rp-mine .rp-rm:disabled{opacity:.55;cursor:default}
      .rp-empty{color:#52605a;font-size:.9rem;text-align:center;padding:14px 4px}
      .rp-row textarea{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cdd9d3;
        border-radius:10px;font:inherit;font-size:.95rem;resize:vertical;color:#16201b}
      .rp-row textarea:focus{outline:none;border-color:#0a6f4d;box-shadow:0 0 0 3px rgba(10,111,77,.15)}
      .rp-check{display:flex;align-items:center}
      .rp-chk{display:flex;align-items:center;gap:8px;min-height:40px;font-weight:600;color:#34403a;cursor:pointer;margin:0}
      .rp-chk input{width:auto;flex-shrink:0;margin:0}
      .rp-chk small{font-weight:400;color:#7a877f;display:block}
      .rp-amen{display:flex;flex-wrap:wrap;gap:6px}
      .rp-amen label{display:inline-flex;align-items:center;gap:5px;font-size:.82rem;padding:6px 12px;
        min-height:40px;box-sizing:border-box;border:1px solid #cdd9d3;border-radius:999px;background:#fff;
        cursor:pointer;color:#34403a}
      .rp-amen input{width:auto;margin:0}
      .rp-amen label:has(input:checked){border-color:#0a6f4d;background:#eafaf3;color:#0a6f4d;font-weight:600}
      /* ---- the area map ------------------------------------------------
         A short map: it has to sit between "where" and "what" inside a sheet
         that already scrolls, so it earns its height by being glanceable, not
         by being a map you work in. 190px still shows a few streets either
         side of the circle at zoom 14. */
      .rp-map-wrap{position:relative;height:190px;border-radius:12px;overflow:hidden;
        border:1px solid #cdd9d3;background:#e8efec}
      .rp-map{position:absolute;inset:0}
      /* Leaflet writes its own z-index stack (400–800) and would otherwise sit
         over the suggestion dropdown that hangs down from the field above. */
      .rp-map-wrap .leaflet-pane,.rp-map-wrap .leaflet-top,.rp-map-wrap .leaflet-bottom{z-index:1}
      /* Leaflet's own zoom buttons are 26px. On the phone this sheet is built
         for, that is under half a fingertip — and they sit in a corner, where a
         miss lands on the map and moves the pin. */
      .rp-map-wrap .leaflet-bar a{width:40px;height:40px;line-height:40px;font-size:19px}
      .rp-map-veil{position:absolute;inset:0;z-index:2;display:flex;align-items:center;
        justify-content:center;text-align:center;padding:14px;background:#eef3f1;color:#52605a;
        font-size:.82rem;line-height:1.45}
      .rp-map-veil[hidden]{display:none}
      .rp-map-cap{margin:6px 0 0;font-size:.78rem;line-height:1.45;color:#52605a;min-height:17px}
      .rp-map-cap.rp-cap-soft{color:#8a5a12}   /* an approximate point, said plainly */
      .rp-map-cap.rp-cap-firm{color:#0a6f4d;font-weight:600}
      /* ---- radius ------------------------------------------------------ */
      .rp-rad{margin-top:11px}
      .rp-rad-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
      .rp-rad-top label{margin:0}
      .rp-rad output{font-size:.82rem;font-weight:700;color:#0a6f4d;white-space:nowrap}
      /* A native range track is ~4px tall and the thumb ~16px. Padding the
         input up to 40px gives the thumb a row a finger can actually find,
         without changing how the control looks. */
      .rp-rad input[type=range]{width:100%;height:40px;margin:0;padding:0;background:none;
        accent-color:#0a6f4d;cursor:pointer;box-sizing:border-box}
      .rp-rad-help{margin:0;font-size:.76rem;line-height:1.45;color:#7a877f}`;
    document.head.appendChild(s);
  }

  // ---- dialog plumbing ----------------------------------------------------
  // One at a time, page held still, Escape out, Tab kept inside, focus handed
  // back — all of it lives in js/lib/dialog.js, because the area-alert sheet in
  // js/pages/houses.js needs exactly the same four things and a second copy is
  // a second thing to forget. This file only says WHICH element and what to do
  // when it closes.
  function alreadyOpen() {
    return !!(window.pawaDialog && window.pawaDialog.isOpen());
  }

  // A sheet may hold something with a lifetime of its own — the Leaflet map is
  // the first: it registers listeners on window and document, so a modal opened
  // and closed three times would leave three live maps redrawing behind the
  // page. Whoever builds the sheet parks a teardown on it and every exit path
  // (button, Escape, backdrop, dialog.js) runs it exactly once.
  function runCleanup(back) {
    const fn = back && back.__rpCleanup;
    if (!fn) return;
    back.__rpCleanup = null;
    try { fn(); } catch (_) {}
  }

  function mount(back, titleId) {
    document.body.appendChild(back);
    if (window.pawaDialog) {
      window.pawaDialog.open(back, {
        labelledBy: titleId,
        onClose: () => { runCleanup(back); back.remove(); },
      });
    } else if (titleId) {
      // dialog.js missing: the sheet still works, it just loses the trap.
      back.setAttribute("aria-labelledby", titleId);
    }
  }

  function close(back) {
    if (window.pawaDialog && window.pawaDialog.close(back)) return;
    runCleanup(back);
    try { back.remove(); } catch (_) {}
  }

  // Give an OPTIONAL step a deadline. geo.js allows itself 8 seconds per call,
  // which is right for a map that has nothing else to draw — but here the
  // geocode only SHARPENS a request that is already routable by region, and the
  // seeker is watching a button that says "Sending…". Past the cap we send with
  // what we have rather than make them wait on a nicety.
  function withCap(promise, ms, fallback) {
    return Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise((res) => setTimeout(() => res(fallback), ms)),
    ]);
  }

  const GEO_CAP_MS = 3000;

  // ---- Leaflet, on demand -------------------------------------------------
  // Of the three pages that include this file, only houses.html already ships
  // Leaflet; index.html and p-chat.html do not, and making all three carry a
  // map library for a modal most visits never open would be a tax on every
  // first paint. So we fetch it the first time the modal opens.
  //
  // Resolves TRUE/FALSE rather than rejecting: a missing map degrades this
  // modal, it does not break it, and every caller treats false as "draw the
  // caption, skip the canvas". A failure is not cached — the next open tries
  // again, because the usual cause is a connection that has since come back.
  let leafletPromise = null;
  function ensureLeaflet() {
    if (window.L && window.L.map) return Promise.resolve(true);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise((resolve) => {
      let settled = false;
      const done = (okFlag) => {
        if (settled) return;
        settled = true;
        if (!okFlag) leafletPromise = null;      // let a later open retry
        resolve(okFlag);
      };
      try {
        if (!document.querySelector('link[data-rp-leaflet]')) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = LEAFLET_CSS;
          link.setAttribute("data-rp-leaflet", "1");
          document.head.appendChild(link);
        }
        const s = document.createElement("script");
        s.src = LEAFLET_JS;
        s.async = true;
        // A stub server can answer this URL with something that is not Leaflet,
        // so onload is not proof — check for the API we are about to call.
        s.onload = () => done(!!(window.L && window.L.map));
        s.onerror = () => done(false);
        document.head.appendChild(s);
        setTimeout(() => done(!!(window.L && window.L.map)), LEAFLET_WAIT_MS);
      } catch (_) { done(false); }
    });
    return leafletPromise;
  }

  // Today, in the seeker's OWN timezone. toISOString() would hand back the UTC
  // date, which is yesterday for anyone east of Greenwich late in the evening —
  // and Tanzania is UTC+3, so it would be wrong every night.
  function todayLocal() {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // What the seeker sees when sending fails. The real error is logged for us;
  // "duplicate key value violates unique constraint" is not something anyone
  // outside this repo can act on.
  function friendlyError(err) {
    const raw = String((err && err.message) || "");
    if (err && err.code === "setup") return T("rp_err_setup");
    if (/Failed to fetch|NetworkError|network|timeout/i.test(raw)) return T("rp_err_network");
    if (/relation .* does not exist|schema cache|PGRST\d+/i.test(raw)) return T("rp_err_setup");
    return T("rp_send_fail");
  }

  // ---- persistence --------------------------------------------------------

  function readMine() {
    try { return JSON.parse(localStorage.getItem(MINE_KEY) || "[]"); } catch (_) { return []; }
  }
  function writeMine(arr) {
    try { localStorage.setItem(MINE_KEY, JSON.stringify(arr)); } catch (_) {}
  }

  // Persist the demand pin. Preferred path is the SECURITY DEFINER RPC
  // house_demand_create() — it stamps ownership from app_uid() (signed-in user
  // owns it; anonymous => user_id NULL, still removable by id+phone) and lets a
  // signed-out seeker create a demand even under the new `sb_publishable_` API
  // key, which the `hdp insert` RLS policy rejects for a direct anon insert
  // (42501). See supabase/features/house/house_demand_create.sql. Falls back to the legacy
  // column-stripping insert only when that RPC isn't deployed yet.
  async function saveDemand(pin) {
    const sb = window.DataStore && window.DataStore.sb;
    if (!sb) return;   // local-only echo handled by the caller

    // Signature of "RPC not installed on this server" — distinct from a real
    // validation/permission error raised inside the function (those re-throw).
    const rpcMissing = (msg) => /PGRST202|Could not find the function|schema cache/i.test(msg || "");

    try {
      const { error } = await sb.rpc("house_demand_create", {
        p_id:             pin.id,
        p_lat:            pin.lat,
        p_lng:            pin.lng,
        p_phone:          pin.phone,
        p_region:         pin.region || null,
        p_area:           pin.area || null,
        p_district:       pin.district || null,
        p_radius_m:       pin.radius_m || 3000,
        p_listing:        pin.listing || "rent",
        p_type:           pin.type || null,
        p_min_bedrooms:   pin.min_bedrooms || 0,
        p_max_budget_tzs: pin.max_budget_tzs || 0,
        p_name:           pin.name || null,
        p_note:           pin.note || null,
        p_needed_from:    pin.needed_from || null,
        p_needed_by:      pin.needed_by || null
      });
      if (!error) return;
      if (!rpcMissing(error.message)) throw error;   // real error → surface it
    } catch (e) {
      if (!rpcMissing(e.message)) throw e;
    }

    // ---- Fallback: RPC not installed. Direct insert, stripping any column the
    // live schema lacks. Works for signed-in users under the existing RLS policy.
    try {
      const { data: { session } } = await sb.auth.getSession();
      pin.user_id = session && session.user ? session.user.id : null;
    } catch (_) { pin.user_id = null; }
    let payload = { ...pin }, error;
    const keep = new Set(["phone", "lat", "lng", "id"]);
    for (let i = 0; i < 6; i++) {
      ({ error } = await sb.from("house_demand_pins").insert(payload));
      if (!error) break;
      const m = /column "?([a-z_]+)"?\s+.*does not exist|Could not find the '([a-z_]+)' column/i.exec(error.message || "");
      const col = m && (m[1] || m[2]);
      if (col && col in payload && !keep.has(col)) { delete payload[col]; continue; }
      break;
    }
    if (error) {
      if (/relation .* does not exist|schema cache/i.test(error.message || "")) {
        const e = new Error("house_demand_pins missing — run supabase/features/house/setup_house_demand.sql + house_demand_region.sql");
        e.code = "setup";
        throw e;
      }
      throw error;
    }
  }

  // Remove one of MY requests. Signed-in → RLS owner delete; anonymous → the
  // id+phone SECURITY DEFINER RPC. Always drops the local echo too.
  async function removeDemand(id, phone) {
    const sb = window.DataStore && window.DataStore.sb;
    if (sb) {
      let session = null;
      try { ({ data: { session } } = await sb.auth.getSession()); } catch (_) {}
      if (session && session.user) {
        const { error } = await sb.from("house_demand_pins").delete().eq("id", id);
        if (error) throw error;
      } else {
        // Anonymous: proven by id + phone. If the RPC isn't installed we still
        // clear it locally so the seeker's own list is correct.
        try { await sb.rpc("house_demand_remove", { p_id: id, p_phone: phone || "" }); }
        catch (_) {}
      }
    }
    writeMine(readMine().filter((r) => r.id !== id));
  }

  // ---- resolve the target point + region ---------------------------------
  // Region is the guaranteed routing key (already chosen). We then find the best
  // POINT for the request, in falling order of precision:
  //   picked suggestion → geocoded typed text → GPS fix → region centroid.
  // District is reverse-geocoded from whatever point we land on (for precise
  // agent routing) unless GPS already gave us one.
  //
  // `at` is the point the MAP is currently showing. When it is present it wins
  // outright: the modal draws a pin and a circle before you press send, and the
  // request has to go where the picture said it would. The chain below is then
  // only the path for a modal whose map never resolved anything at all.
  async function resolveTarget({ region, text, gps, district, at }) {
    let lat = null, lng = null, area = text, dist = district || null, regOut = region;

    if (at && Number.isFinite(at.lat) && Number.isFinite(at.lng)) {
      lat = +at.lat; lng = +at.lng;
      if (!area && picked && picked.name) area = picked.name;
    } else if (picked && Number.isFinite(picked.lat) && Number.isFinite(picked.lng)) {
      lat = +picked.lat; lng = +picked.lng; area = area || picked.name;
    } else if (text) {
      const hits = preferRegion(await withCap(
        window.pawaGeo ? window.pawaGeo.suggest(text, { limit: 6 }) : [], GEO_CAP_MS, []), region);
      const h = (hits || []).find((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng));
      if (h) { lat = +h.lat; lng = +h.lng; area = area || h.name; }
    }
    if (lat == null && gps) { lat = gps.lat; lng = gps.lng; }
    if (lat == null) { const c = regionCentroid(region); if (c) { lat = c.lat; lng = c.lng; } }

    if (lat != null && lng != null && window.pawaGeo) {
      try {
        const j = await withCap(
          window.pawaGeo.reverse(`format=json&zoom=12&addressdetails=1&lat=${lat}&lon=${lng}`),
          GEO_CAP_MS, null);
        const a = (j && j.address) || {};
        if (!dist) dist = canonDistrict(a.county || a.state_district || a.city_district || a.district || a.municipality || "");
        if (!regOut) regOut = await canonRegion(a.state || a.region || a.county || "");
      } catch (_) {}
    }
    return { lat, lng, area: simplifyArea(area) || region, region: regOut, district: dist };
  }

  // ---- region <select> population -----------------------------------------
  // Render the bundled gazetteer IMMEDIATELY so the picker is always usable
  // (even offline / on a slow link — never blocks sending), then upgrade to the
  // canonical regions list in the background. Preserves the current selection.
  function fillRegions(selectEl, preselect) {
    const render = (regs) => {
      const want = (selectEl.value || preselect || "").toLowerCase();
      selectEl.innerHTML = `<option value="">${T("rp_region_choose")}</option>` +
        regs.map((r) => `<option value="${esc(r)}"${r.toLowerCase() === want ? " selected" : ""}>${esc(r)}</option>`).join("");
    };
    const local = (window.TZ_REGION_CENTERS || []).filter((r) => r.kind === "region").map((r) => r.name).sort();
    if (local.length) render(local);
    Promise.resolve(window.DataStore && window.DataStore.getRegions ? window.DataStore.getRegions() : [])
      .then((regs) => { if (Array.isArray(regs) && regs.length) render(regs); })
      .catch(() => {});
  }

  // =====================================================================
  // The request modal
  // =====================================================================
  function open(opts) {
    opts = opts || {};
    if (alreadyOpen()) return;
    ensureStyles();
    picked = null; gpsPoint = null; gpsDistrict = null; pinned = null;

    const back = document.createElement("div");
    back.className = "rp-back";
    back.setAttribute("role", "dialog");
    back.setAttribute("aria-modal", "true");
    back.innerHTML = `
      <div class="rp-card">
        <h2 id="rpTitle">${T("rp_title")}</h2>
        <p class="rp-lead">${T("rp_lead")}</p>

        <div class="rp-row">
          <label for="rpRegion">${T("rp_region_label")} <small>${T("rp_region_small")}</small></label>
          <select id="rpRegion"><option value="">${T("rp_region_choose")}</option></select>
          <button id="rpLoc" class="rp-loc" type="button"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true" width="14" height="14" style="vertical-align:-2px"><path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z" stroke="currentColor" stroke-width="1.9"/><circle cx="12" cy="10" r="2.4" stroke="currentColor" stroke-width="1.9"/></svg> ${T("rp_use_loc")}</button>
        </div>

        <div class="rp-row">
          <label for="rpWhere">${T("rp_where_label")} <small>${T("rp_where_small")}</small></label>
          <input id="rpWhere" type="text" autocomplete="off" placeholder="${T("rp_where_ph")}" />
          <div id="rpSug" class="rp-sug" hidden></div>
          <div id="rpPicked" class="rp-picked" hidden></div>
        </div>

        <!-- The area the request will actually cover. Static markup carries no
             point and no claim: the veil says "loading" until the script has a
             map, and says so plainly if the library never arrives. -->
        <div class="rp-row">
          <label for="rpMap">${T("rp_map_label")} <small>${T("rp_map_small")}</small></label>
          <div class="rp-map-wrap">
            <div id="rpMap" class="rp-map"></div>
            <div class="rp-map-veil" id="rpMapVeil">${T("rp_map_loading")}</div>
          </div>
          <p class="rp-map-cap" id="rpMapCap" role="status">${T("rp_map_cap_none")}</p>
          <div class="rp-rad">
            <div class="rp-rad-top">
              <label for="rpRadius">${T("rp_radius_label")}</label>
              <output id="rpRadiusOut" for="rpRadius">${T("rp_radius_out").replace("{km}", RADIUS_DEFAULT_KM)}</output>
            </div>
            <input id="rpRadius" type="range" min="${RADIUS_MIN_KM}" max="${RADIUS_MAX_KM}" step="1"
                   value="${RADIUS_DEFAULT_KM}" aria-describedby="rpRadiusHelp" />
            <p class="rp-rad-help" id="rpRadiusHelp">${T("rp_radius_help").replace("{km}", RADIUS_DEFAULT_KM)}</p>
          </div>
        </div>

        <div class="rp-2">
          <div class="rp-row">
            <label for="rpListing">${T("rp_listing_label")}</label>
            <select id="rpListing">
              <option value="rent">${T("rp_listing_rent")}</option>
              <option value="sale">${T("rp_listing_buy")}</option>
            </select>
          </div>
          <div class="rp-row">
            <label for="rpType">${T("rp_type_label")} <small>${T("rp_optional")}</small></label>
            <input id="rpType" type="text" list="rpTypeList" autocomplete="off" maxlength="40" placeholder="${T("rp_type_ph")}" />
            <datalist id="rpTypeList">
              <option value="Single room"></option>
              <option value="Self-contained room"></option>
              <option value="Apartment"></option>
              <option value="House"></option>
              <option value="Shop / business space"></option>
              <option value="Office"></option>
              <option value="Warehouse / godown"></option>
              <option value="Frame (business space)"></option>
              <option value="Hostel"></option>
              <option value="Plot"></option>
            </datalist>
          </div>
        </div>

        <div class="rp-2">
          <div class="rp-row">
            <label for="rpPrice">${T("rp_price_label")} <small>${T("rp_price_small")}</small></label>
            <input id="rpPrice" type="number" inputmode="numeric" min="0" placeholder="${T("rp_price_ph")}" />
          </div>
          <div class="rp-row">
            <label for="rpPay">${T("rp_pay_label")} <small>${T("rp_pay_small")}</small></label>
            <select id="rpPay">
              <option value="">${T("rp_pay_none")}</option>
              <option value="Monthly">${T("rp_pay_monthly")}</option>
              <option value="3 months">${T("rp_pay_3")}</option>
              <option value="6 months">${T("rp_pay_6")}</option>
              <option value="12 months">${T("rp_pay_12")}</option>
              <option value="Flexible">${T("rp_pay_flex")}</option>
            </select>
          </div>
        </div>

        <div class="rp-2">
          <div class="rp-row">
            <label for="rpBeds">${T("rp_beds_label")} <small>${T("rp_min")}</small></label>
            <input id="rpBeds" type="number" inputmode="numeric" min="0" placeholder="${T("rp_any")}" />
          </div>
          <div class="rp-row">
            <label for="rpBaths">${T("rp_baths_label")} <small>${T("rp_min")}</small></label>
            <input id="rpBaths" type="number" inputmode="numeric" min="0" placeholder="${T("rp_any")}" />
          </div>
        </div>

        <div class="rp-2">
          <div class="rp-row">
            <label for="rpFurnished">${T("rp_furnished_label")}</label>
            <select id="rpFurnished">
              <option value="">${T("rp_furn_either")}</option>
              <option value="Furnished">${T("rp_furn_yes")}</option>
              <option value="Unfurnished">${T("rp_furn_no")}</option>
            </select>
          </div>
          <div class="rp-row rp-check">
            <label class="rp-chk"><input id="rpSelfC" type="checkbox" /> <span>${T("rp_selfc")} <small>${T("rp_selfc_small")}</small></span></label>
          </div>
        </div>

        <div class="rp-row">
          <label>${T("rp_must_label")} <small>${T("rp_must_small")}</small></label>
          <div class="rp-amen" id="rpAmen">
            <label><input type="checkbox" value="Water" /> ${T("rp_am_water")}</label>
            <label><input type="checkbox" value="Electricity (LUKU)" /> ${T("rp_am_elec")}</label>
            <label><input type="checkbox" value="Own meter" /> ${T("rp_am_meter")}</label>
            <label><input type="checkbox" value="Parking" /> ${T("rp_am_parking")}</label>
            <label><input type="checkbox" value="Fence / security" /> ${T("rp_am_fence")}</label>
            <label><input type="checkbox" value="Tiled floor" /> ${T("rp_am_tiled")}</label>
            <label><input type="checkbox" value="Master ensuite" /> ${T("rp_am_ensuite")}</label>
            <label><input type="checkbox" value="Fitted kitchen" /> ${T("rp_am_kitchen")}</label>
            <label><input type="checkbox" value="Ceiling" /> ${T("rp_am_ceiling")}</label>
          </div>
        </div>

        <div class="rp-2">
          <div class="rp-row">
            <label for="rpFrom">${T("rp_from_label")} <small>${T("rp_optional")}</small></label>
            <input id="rpFrom" type="date" min="${todayLocal()}" />
          </div>
          <div class="rp-row">
            <label for="rpWhen">${T("rp_by_label")} <small>${T("rp_deadline")}</small></label>
            <input id="rpWhen" type="date" min="${todayLocal()}" />
          </div>
        </div>

        <div class="rp-row">
          <label for="rpElse">${T("rp_else_label")} <small>${T("rp_optional")}</small></label>
          <textarea id="rpElse" rows="2" maxlength="300" placeholder="${T("rp_else_ph")}"></textarea>
        </div>

        <div class="rp-2">
          <div class="rp-row">
            <label for="rpPhone">${T("rp_phone_label")} <small>${T("rp_phone_small")}</small></label>
            <input id="rpPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="07XX XXX XXX" />
          </div>
          <div class="rp-row">
            <label for="rpName">${T("rp_name_label")} <small>${T("rp_optional")}</small></label>
            <input id="rpName" type="text" maxlength="60" autocomplete="name" placeholder="e.g. Asha" />
          </div>
        </div>

        <div id="rpMsg" class="rp-msg" role="status"></div>
        <button id="rpGo" class="rp-go" type="button">${T("rp_send")}</button>
        <div class="rp-foot">
          <button id="rpMine" class="rp-link rp-strong" type="button">${T("rp_my")}</button>
          <button id="rpCancel" class="rp-link" type="button">${T("rp_cancel")}</button>
        </div>
      </div>`;
    mount(back, "rpTitle");

    const $ = (id) => back.querySelector(id);
    const regionEl = $("#rpRegion"), locEl = $("#rpLoc");
    const whereEl = $("#rpWhere"), sugEl = $("#rpSug"), pickedEl = $("#rpPicked");
    const msgEl = $("#rpMsg"), goEl = $("#rpGo");
    const setMsg = (t, ok) => { msgEl.textContent = t || ""; msgEl.classList.toggle("ok", !!ok); };

    fillRegions(regionEl, opts.region);

    back.addEventListener("click", (e) => { if (e.target === back) close(back); });
    $("#rpCancel").addEventListener("click", () => close(back));
    $("#rpMine").addEventListener("click", () => { close(back); openMine(); });
    if (opts.where) whereEl.value = opts.where;

    // =====================================================================
    // The area map
    // =====================================================================
    // Everything below keeps ONE fact — `shown`, the point this request will be
    // sent on — and paints it three ways: the marker, the circle, and the
    // caption that names which rule chose it. `shown` is also what submit reads,
    // so there is no second resolution that could disagree with the picture.
    const mapEl = $("#rpMap"), veilEl = $("#rpMapVeil"), capEl = $("#rpMapCap");
    const radiusEl = $("#rpRadius"), radiusOutEl = $("#rpRadiusOut"), radiusHelpEl = $("#rpRadiusHelp");

    let map = null, marker = null, circle = null, mapRO = null;
    let shown = null;                // { lat, lng, src } — the point we will send
    let gpsWins = false;             // a fresh fix outranks the label it wrote
    // Two independent races, two counters: mapSeq guards which resolution owns
    // the pin, labelSeq guards which reverse-geocode owns the area label. One
    // shared counter had them cancelling each other, so moving the region
    // picker could silently drop the name of a pin the seeker had just placed.
    let mapTimer = null, mapSeq = 0, labelSeq = 0;
    let radiusKm = RADIUS_DEFAULT_KM;

    const radiusM = () => Math.round(radiusKm * 1000);

    // Captions, one per step of the fallback chain. "firm" = a point somebody
    // chose or measured; "soft" = a guess we are admitting to.
    const CAPTION = {
      pin:    { key: "rp_map_cap_pin",    tone: "rp-cap-firm" },
      pick:   { key: "rp_map_cap_pick",   tone: "rp-cap-firm" },
      gps:    { key: "rp_map_cap_gps",    tone: "rp-cap-firm" },
      typed:  { key: "rp_map_cap_typed",  tone: "" },
      region: { key: "rp_map_cap_region", tone: "rp-cap-soft" },
      none:   { key: "rp_map_cap_none",   tone: "" },
    };

    function setCaption(src) {
      const c = CAPTION[src] || CAPTION.none;
      capEl.textContent = T(c.key).replace("{region}", regionEl.value || T("rp_region_label"));
      capEl.classList.remove("rp-cap-soft", "rp-cap-firm");
      if (c.tone) capEl.classList.add(c.tone);
    }

    // Frame the circle, not the point. Falls back to a plain setView if
    // getBounds is unavailable for any reason — a map centred on the right
    // place at the wrong zoom still beats a map that threw.
    function fitCircle(pt) {
      if (!map || !circle || !pt) return;
      const cap = pt.src === "region" ? FIT_MAX_ZOOM_REGION : FIT_MAX_ZOOM;
      try {
        map.fitBounds(circle.getBounds(), { padding: [FIT_PAD, FIT_PAD], maxZoom: cap });
      } catch (_) {
        try { map.setView([pt.lat, pt.lng], cap); } catch (__) {}
      }
    }

    // Draw (or move) the pin and its circle. Only re-centres when the POINT
    // moved: re-fitting on every keystroke would undo a zoom the seeker just
    // made to check which side of the road they are on.
    function draw(pt, { recentre } = {}) {
      if (!map || !pt) return;
      const ll = [pt.lat, pt.lng];
      if (!marker) {
        marker = L.marker(ll, { draggable: true, keyboard: true,
          title: T("rp_map_small"), alt: T("rp_map_label") }).addTo(map);
        marker.on("dragend", () => {
          const p = marker.getLatLng();
          setPinned(p.lat, p.lng);
        });
      } else {
        marker.setLatLng(ll);
      }
      if (!circle) {
        circle = L.circle(ll, { radius: radiusM(), color: "#0a6f4d", weight: 2,
          fillColor: "#0a6f4d", fillOpacity: 0.12, interactive: false }).addTo(map);
      } else {
        circle.setLatLng(ll); circle.setRadius(radiusM());
      }
      if (recentre) fitCircle(pt);
    }

    // A point the seeker placed by hand. It outranks every automatic step for
    // the rest of this modal's life — the one thing a map like this must
    // guarantee is that dragging the pin is not undone by a later keystroke.
    function setPinned(lat, lng) {
      pinned = { lat: +lat, lng: +lng };
      shown = { lat: pinned.lat, lng: pinned.lng, src: "pin" };
      draw(shown, { recentre: false });
      setCaption("pin");
      labelFromPoint(pinned.lat, pinned.lng);
    }

    // Name the spot the seeker dropped the pin on, and offer it as the area
    // label if they haven't typed one. Best-effort and silent: the request is
    // already routable without it.
    async function labelFromPoint(lat, lng) {
      if (!window.pawaGeo || whereEl.value.trim()) return;
      const seq = ++labelSeq;
      try {
        const j = await withCap(
          window.pawaGeo.reverse(`format=json&zoom=16&addressdetails=1&lat=${lat}&lon=${lng}`),
          GEO_CAP_MS, null);
        if (seq !== labelSeq) return;                     // a newer pin won
        const a = (j && j.address) || {};
        // `ward` is the unit Tanzanian addresses are actually given in, and
        // Nominatim returns it where suburb/neighbourhood are both absent —
        // which in Dar is most of the time. Without it the label falls through
        // to the road name, and an agent gets "Msese Road" instead of
        // "Hananasif", which is the half of the address they navigate by.
        const label = simplifyArea([a.suburb || a.neighbourhood || a.ward || a.village || a.hamlet || a.road,
          a.city || a.town || a.city_district].filter(Boolean).join(", "));
        if (label && !whereEl.value.trim()) {
          whereEl.value = label;
          pickedEl.textContent = label;
          pickedEl.hidden = false;
        }
      } catch (_) {}
    }

    // The fallback chain:
    //   hand pin → fresh GPS fix → picked suggestion → geocoded text → an older
    //   GPS point → region centroid.
    // Whatever this returns is what submit sends, so the picture cannot drift
    // from the payload. The one ordering that is NOT resolveTarget's is the
    // fresh fix: "use my location" writes a neighbourhood name into the area
    // box, and geocoding that name back would quietly replace a 20-metre GPS
    // point with the centroid of a suburb. Typing over the box clears the flag
    // and hands the lead back to the text, which is what typing means.
    async function computePoint() {
      if (pinned) return { lat: pinned.lat, lng: pinned.lng, src: "pin" };
      if (gpsWins && gpsPoint) return { lat: gpsPoint.lat, lng: gpsPoint.lng, src: "gps" };
      if (picked && Number.isFinite(+picked.lat) && Number.isFinite(+picked.lng)) {
        return { lat: +picked.lat, lng: +picked.lng, src: "pick" };
      }
      const text = simplifyArea(whereEl.value);
      if (text.length >= 2 && window.pawaGeo) {
        const hits = preferRegion(
          await withCap(window.pawaGeo.suggest(text, { limit: 6 }), GEO_CAP_MS, []), regionEl.value);
        const h = (hits || []).find((x) => Number.isFinite(+x.lat) && Number.isFinite(+x.lng));
        if (h) return { lat: +h.lat, lng: +h.lng, src: "typed" };
      }
      if (gpsPoint) return { lat: gpsPoint.lat, lng: gpsPoint.lng, src: "gps" };
      const c = regionCentroid(regionEl.value);
      if (c) return { lat: c.lat, lng: c.lng, src: "region" };
      return null;
    }

    // Re-resolve and repaint. Returns the promise so submit can wait out an
    // in-flight geocode instead of racing it, and sequence-numbered so a slow
    // answer for an old query cannot overwrite a newer one.
    function refreshMap() {
      const seq = ++mapSeq;
      return (async () => {
        const pt = await computePoint();
        if (seq !== mapSeq) return;
        const moved = !shown || !pt ||
          Math.abs(shown.lat - pt.lat) > 1e-6 || Math.abs(shown.lng - pt.lng) > 1e-6;
        shown = pt;
        setCaption(pt ? pt.src : "none");
        if (pt) draw(pt, { recentre: moved });
      })();
    }

    function scheduleRefresh() {
      clearTimeout(mapTimer);
      mapTimer = setTimeout(refreshMap, MAP_DEBOUNCE_MS);
    }

    // ---- radius ----
    function paintRadius() {
      radiusOutEl.textContent = T("rp_radius_out").replace("{km}", radiusKm);
      radiusHelpEl.textContent = T("rp_radius_help").replace("{km}", radiusKm);
      if (circle) { try { circle.setRadius(radiusM()); } catch (_) {} }
    }
    radiusEl.addEventListener("input", () => {
      const v = Number(radiusEl.value);
      radiusKm = Math.min(RADIUS_MAX_KM, Math.max(RADIUS_MIN_KM, Number.isFinite(v) ? v : RADIUS_DEFAULT_KM));
      paintRadius();
    });
    // Re-frame on RELEASE, not on every step: the circle growing inside a still
    // map is what makes the size legible, and a view that re-fits 24 times
    // during one drag just looks broken.
    radiusEl.addEventListener("change", () => fitCircle(shown));

    // ---- bring the map up ----
    // The modal is usable the whole time this is in flight; the veil says which
    // of the two ends we are at. Nothing here can block sending.
    (async () => {
      const okL = await ensureLeaflet();
      if (!back.isConnected) return;                      // closed while loading
      if (!okL) {
        veilEl.textContent = T("rp_map_offline");
        refreshMap();                                     // caption still tells the truth
        return;
      }
      try {
        map = L.map(mapEl, { zoomControl: false, attributionControl: false })
          .setView([-6.4, 35.0], 5);                      // Tanzania, until we know better
        L.control.zoom({ position: "bottomright" }).addTo(map);
        if (typeof window.addSatelliteHybrid === "function") {
          window.addSatelliteHybrid(map, { control: false });
        } else {
          L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(map);
        }
        // Tapping the map is the same act as dragging the pin, and on a phone
        // it is the easier of the two.
        map.on("click", (e) => setPinned(e.latlng.lat, e.latlng.lng));
        // A Leaflet map created inside a sheet that is still sliding in
        // measures 0×0 and paints grey. Re-measure across a few frames and
        // whenever the container actually resizes.
        const fixSize = () => { try { map && map.invalidateSize(); } catch (_) {} };
        requestAnimationFrame(fixSize);
        [120, 350, 700].forEach((d) => setTimeout(() => { if (back.isConnected) fixSize(); }, d));
        try {
          if ("ResizeObserver" in window) { mapRO = new ResizeObserver(fixSize); mapRO.observe(mapEl); }
        } catch (_) {}
        veilEl.hidden = true;
        refreshMap();
      } catch (err) {
        try { console.error("[request-place] map failed:", err); } catch (_) {}
        map = null;
        veilEl.hidden = false;
        veilEl.textContent = T("rp_map_offline");
        refreshMap();
      }
    })();

    // Leaflet holds listeners on window/document; a modal that is opened and
    // closed a few times would otherwise leave one live map per open.
    back.__rpCleanup = () => {
      clearTimeout(mapTimer);
      mapSeq++; labelSeq++;                      // orphan any in-flight geocode
      try { mapRO && mapRO.disconnect(); } catch (_) {}
      try { map && map.remove(); } catch (_) {}
      map = marker = circle = mapRO = null;
    };

    // ---- use my location → set region + district + point ----
    locEl.addEventListener("click", async () => {
      if (!window.pawaLocate || !window.pawaLocate.supported()) { setMsg(T("rp_loc_unavail")); return; }
      locEl.disabled = true; locEl.textContent = T("rp_locating"); setMsg(T("rp_loc_getting"), true);
      try {
        const fix = await window.pawaLocate.best({ maxWaitMs: 9000 });
        gpsPoint = { lat: fix.lat, lng: fix.lng };
        // Asking for your location is a deliberate act, so it takes the map —
        // over a hand pin and over a suggestion picked earlier. Only typing
        // over the area box hands the lead back.
        pinned = null; picked = null; gpsWins = true;
        refreshMap();
        let reg = "", label = "";
        if (window.pawaGeo) {
          try {
            const j = await window.pawaGeo.reverse(`format=json&zoom=14&addressdetails=1&lat=${fix.lat}&lon=${fix.lng}`);
            const a = (j && j.address) || {};
            reg = await canonRegion(a.state || a.region || a.county || "");
            gpsDistrict = canonDistrict(a.county || a.state_district || a.city_district || a.municipality || a.district || "");
            label = simplifyArea([a.suburb || a.neighbourhood || a.ward || a.village || a.hamlet, a.city || a.town || a.city_district].filter(Boolean).join(", "));
          } catch (_) {}
        }
        if (reg) { await fillRegions(regionEl, reg); }
        if (label && !whereEl.value.trim()) whereEl.value = label;
        setMsg(reg ? `${T("rp_loc_found_set")} ${reg}.` : T("rp_loc_found_confirm"), true);
      } catch (e) {
        setMsg((window.pawaLocate && window.pawaLocate.message) ? window.pawaLocate.message(e) : T("rp_loc_fail"));
      } finally {
        locEl.disabled = false; locEl.textContent = T("rp_use_loc");
      }
    });

    // ---- live place suggestions ----
    function showSug(list) {
      if (!list || !list.length) { sugEl.hidden = true; sugEl.innerHTML = ""; return; }
      sugEl.innerHTML = list.slice(0, 6).map((h, i) =>
        `<button type="button" data-i="${i}"><b>${esc(h.name)}</b><span>${esc(h.context || "")}</span></button>`).join("");
      sugEl.hidden = false;
      sugEl.querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
        const h = list[+b.dataset.i];
        picked = { lat: +h.lat, lng: +h.lng, name: h.name, region: (h.context ? String(h.context).split(",").map((s) => s.trim()).pop() : "") };
        whereEl.value = simplifyArea(h.name + (h.context ? ", " + h.context : ""));
        pickedEl.textContent = (h.name || "") + (h.context ? " · " + h.context : "");
        pickedEl.hidden = false;
        sugEl.hidden = true;
        // Choosing a place from the list is as deliberate as dropping a pin, so
        // it replaces one — and the map jumps there immediately rather than
        // waiting out the debounce.
        pinned = null; gpsWins = false;
        refreshMap();
        // Best-effort: set region from the suggestion if the user hasn't chosen one.
        if (!regionEl.value && picked.region) {
          const r = await canonRegion(picked.region);
          if (r) await fillRegions(regionEl, r);
        }
      }));
    }
    whereEl.addEventListener("input", () => {
      picked = null; pickedEl.hidden = true;
      // Typing is the seeker describing the place in their own words, so the
      // text gets the lead back from a GPS fix. It does NOT clear a hand pin:
      // people drop the pin and then name it, and moving it out from under
      // them while they type is the one thing a map like this must not do.
      gpsWins = false;
      scheduleRefresh();
      const q = whereEl.value.trim();
      clearTimeout(sugTimer);
      if (q.length < 2 || !window.pawaGeo) { sugEl.hidden = true; return; }
      sugTimer = setTimeout(async () => {
        const list = await window.pawaGeo.suggest(q, { limit: 6 }).catch(() => []);
        // Same ordering the map preview uses — a list whose first row is not
        // the place the pin jumped to is worse than no list at all.
        showSug(preferRegion(list, regionEl.value));
      }, 320);
    });

    // The region is the routing key, so when nothing more precise has been said
    // its centroid IS the request — moving the picker has to move the circle.
    regionEl.addEventListener("change", () => refreshMap());

    // ---- submit ----
    goEl.addEventListener("click", async () => {
      const region = regionEl.value.trim();
      const text = simplifyArea(whereEl.value);
      const phone = $("#rpPhone").value.trim();
      const digits = phone.replace(/\D/g, "");
      const from = $("#rpFrom").value || "", by = $("#rpWhen").value || "";
      if (!region) { setMsg(T("rp_need_region")); regionEl.focus(); return; }
      // 9 digits is a bare local number, 12 is +255 with the country code; a
      // 15-digit "number" is a typo we should catch here rather than hand to an
      // agent who then cannot call anyone.
      if (digits.length < 9 || digits.length > 13) { setMsg(T("rp_need_phone")); $("#rpPhone").focus(); return; }
      if (from && by && from > by) { setMsg(T("rp_date_order")); $("#rpWhen").focus(); return; }

      goEl.disabled = true; goEl.textContent = T("rp_sending"); setMsg("");
      try {
        // Send exactly what the map is showing. A geocode fired by the last
        // keystroke may still be in flight — wait it out rather than race it,
        // or the seeker watches the pin move a beat AFTER pressing send.
        clearTimeout(mapTimer);
        await refreshMap();
        const place = await resolveTarget({
          region, text, gps: gpsPoint, district: gpsDistrict, at: shown });
        if (place.lat == null || place.lng == null) {
          setMsg(T("rp_no_place")); goEl.disabled = false; goEl.textContent = T("rp_send"); return;
        }

        const typeVal = ($("#rpType").value || "").trim().toLowerCase().slice(0, 40);
        const nameVal = ($("#rpName").value || "").trim().slice(0, 60);
        const amenities = Array.from(back.querySelectorAll("#rpAmen input:checked")).map((c) => c.value);
        const note = buildSpecNote({
          selfContained: $("#rpSelfC").checked,
          furnished: $("#rpFurnished").value || "",
          baths: Number($("#rpBaths").value) || 0,
          pay: $("#rpPay").value || "",
          amenities,
          elseText: $("#rpElse").value || "",
        });
        const pin = {
          id: "dp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          lat: place.lat, lng: place.lng,
          area: place.area || text || region,
          region: place.region || region,
          district: place.district || null,
          radius_m: radiusM(),
          listing: $("#rpListing").value === "sale" ? "sale" : "rent",
          type: typeVal || null,
          min_bedrooms: Number($("#rpBeds").value) || 0,
          max_budget_tzs: Number($("#rpPrice").value) || 0,
          phone: phone,
          name: nameVal || null,
          needed_from: $("#rpFrom").value || null,
          needed_by: $("#rpWhen").value || null,
          note: note,
        };
        await saveDemand(pin);

        // Remember locally (incl. phone, so an anonymous seeker can REMOVE it
        // later — the phone is the ownership proof the delete RPC checks).
        const mine = readMine();
        mine.push({ id: pin.id, area: pin.area, region: pin.region, listing: pin.listing,
          type: pin.type, max_budget_tzs: pin.max_budget_tzs, needed_by: pin.needed_by,
          phone: pin.phone, lat: pin.lat, lng: pin.lng, radius_m: pin.radius_m, at: Date.now() });
        writeMine(mine);

        const whatTxt = pin.listing === "sale" ? T("rp_what_buy") : T("rp_what_rent");
        const byTxt = pin.needed_by ? " " + T("rp_by_word") + ` <strong>${esc(pin.needed_by)}</strong>` : "";
        const body = T("rp_sent_body")
          .replace("{region}", `<strong>${esc(pin.region)}</strong>`)
          .replace("{what}", whatTxt)
          .replace("{area}", `<strong>${esc(pin.area)}</strong>`)
          .replace("{by}", byTxt);
        $(".rp-card").innerHTML = `<div class="rp-done">
          <div class="rp-tick">✓</div>
          <h3>${T("rp_sent_title")}</h3>
          <p>${body}</p>
          <button class="rp-go" type="button" id="rpDone">${T("rp_done")}</button>
          <div class="rp-foot"><button class="rp-link rp-strong" type="button" id="rpToMine">${T("rp_my")}</button></div>
        </div>`;
        $("#rpDone").addEventListener("click", () => close(back));
        $("#rpToMine").addEventListener("click", () => { close(back); openMine(); });
      } catch (err) {
        // The detail is for us; the seeker gets something they can act on.
        try { console.error("[request-place] send failed:", err); } catch (_) {}
        setMsg(friendlyError(err));
        goEl.disabled = false; goEl.textContent = T("rp_send");
      }
    });

    setTimeout(() => { try { regionEl.focus(); } catch (_) {} }, 40);
  }

  // =====================================================================
  // "My requests" — see and remove your own requests
  // =====================================================================
  function fmtTzs(p) {
    p = Number(p) || 0;
    if (p >= 1e6) return (p / 1e6).toFixed(p % 1e6 ? 1 : 0) + "M";
    if (p >= 1e3) return Math.round(p / 1e3) + "k";
    return p ? String(p) : "";
  }

  // Merge the local echo with the DB rows the seeker owns (signed-in only — RLS
  // owner read). DB rows are authoritative for "is it still active".
  async function fetchMine() {
    const local = readMine();
    const byId = new Map();
    const sb = window.DataStore && window.DataStore.sb;
    if (sb) {
      try {
        const { data: { session } } = await sb.auth.getSession();
        if (session && session.user) {
          const { data } = await sb.from("house_demand_pins")
            .select("id,area,region,listing,type,max_budget_tzs,needed_by,active,created_at,phone,radius_m")
            .eq("user_id", session.user.id).order("created_at", { ascending: false });
          (data || []).forEach((r) => byId.set(r.id, { ...r, at: new Date(r.created_at).getTime() }));
        }
      } catch (_) {}
    }
    local.forEach((r) => { if (!byId.has(r.id)) byId.set(r.id, r); });
    return [...byId.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  function mineRowHtml(r) {
    const bits = [r.listing === "sale" ? T("rp_bit_buying") : T("rp_bit_renting")];
    if (r.type) bits.push(esc(r.type));
    if (r.max_budget_tzs) bits.push("≤ " + fmtTzs(r.max_budget_tzs) + " TZS");
    // The radius the seeker chose decides which agents ever see this request,
    // so it belongs in the row that explains why one is or is not getting calls.
    if (r.radius_m) bits.push(T("rp_bit_within").replace("{km}", Math.round(r.radius_m / 1000) || 1));
    if (r.needed_by) bits.push(T("rp_by_word") + " " + esc(String(r.needed_by).slice(0, 10)));
    if (r.active === false) bits.push(T("rp_bit_closed"));
    return `<li data-id="${esc(r.id)}">
      <div>
        <div class="rp-mine-where">${esc(r.area || r.region || T("rp_your_request"))}</div>
        <div class="rp-mine-sub">${esc(r.region || "")}${r.region ? " · " : ""}${bits.join(" · ")}</div>
      </div>
      <button class="rp-rm" type="button" data-id="${esc(r.id)}" data-phone="${esc(r.phone || "")}">${T("rp_remove")}</button>
    </li>`;
  }

  async function openMine() {
    if (alreadyOpen()) return;
    ensureStyles();
    const back = document.createElement("div");
    back.className = "rp-back";
    back.setAttribute("role", "dialog");
    back.setAttribute("aria-modal", "true");
    back.innerHTML = `
      <div class="rp-card">
        <h2 id="rpMineTitle">${T("rp_my")}</h2>
        <p class="rp-lead">${T("rp_my_lead")}</p>
        <div id="rpMineBody"><p class="rp-empty">${T("rp_loading")}</p></div>
        <button class="rp-go" type="button" id="rpNew">${T("rp_new")}</button>
        <div class="rp-foot"><button class="rp-link" type="button" id="rpMineClose">${T("rp_close")}</button></div>
      </div>`;
    mount(back, "rpMineTitle");

    const body = back.querySelector("#rpMineBody");
    back.addEventListener("click", (e) => { if (e.target === back) close(back); });
    back.querySelector("#rpMineClose").addEventListener("click", () => close(back));
    back.querySelector("#rpNew").addEventListener("click", () => { close(back); open(); });

    async function render() {
      const rows = await fetchMine();
      if (!rows.length) { body.innerHTML = `<p class="rp-empty">${T("rp_none")}</p>`; return; }
      body.innerHTML = `<ul class="rp-mine">${rows.map(mineRowHtml).join("")}</ul>`;
      body.querySelectorAll(".rp-rm").forEach((btn) => btn.addEventListener("click", async () => {
        btn.disabled = true; btn.textContent = T("rp_removing");
        try {
          await removeDemand(btn.dataset.id, btn.dataset.phone);
          const li = btn.closest("li"); if (li) li.remove();
          if (!body.querySelector(".rp-mine li")) body.innerHTML = `<p class="rp-empty">${T("rp_none")}</p>`;
        } catch (_) {
          btn.disabled = false; btn.textContent = T("rp_remove");
        }
      }));
    }
    render();
  }

  window.pawaRequestPlace = { open, openMine };
  window.pawaCanonRegion = canonRegion;
  window.pawaCanonDistrict = canonDistrict;
  window.pawaSimplifyArea = simplifyArea;
})();
