// =====================================================================
// Request a place — TYPE it (or tap your location), no map needed
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

  const MINE_KEY = "pawa_my_demand_pins";
  let picked = null;      // { lat, lng, name, region } chosen from suggestions
  let gpsPoint = null;    // { lat, lng } from "use my location"
  let gpsDistrict = null; // district reverse-geocoded from the GPS point
  let sugTimer = null;

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

  // Region centroid from the bundled gazetteer (js/tz-places.js) — the last-
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
      .rp-card h2{margin:0 0 3px;font-size:1.18rem}
      .rp-card .rp-lead{margin:0 0 15px;color:#52605a;font-size:.9rem}
      .rp-row{margin-bottom:12px;position:relative}
      .rp-row label{display:block;font-weight:700;font-size:.82rem;margin:0 0 5px;color:#34403a}
      .rp-row label small{font-weight:400;color:#7a877f}
      .rp-row input,.rp-row select{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cdd9d3;
        border-radius:10px;font-size:1rem;background:#fff;color:#16201b}
      .rp-row input:focus,.rp-row select:focus{outline:none;border-color:#0a6f4d;box-shadow:0 0 0 3px rgba(10,111,77,.15)}
      .rp-2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .rp-loc{margin-top:7px;width:100%;display:inline-flex;align-items:center;justify-content:center;gap:6px;
        padding:9px 12px;border:1px dashed #0a6f4d;border-radius:10px;background:#f2faf6;color:#0a6f4d;
        font-weight:700;font-size:.86rem;cursor:pointer}
      .rp-loc:disabled{opacity:.6;cursor:default}
      .rp-sug{position:absolute;left:0;right:0;top:100%;z-index:5;background:#fff;border:1px solid #d8e6df;
        border-radius:0 0 10px 10px;max-height:210px;overflow:auto;box-shadow:0 12px 30px rgba(0,0,0,.14)}
      .rp-sug[hidden]{display:none}
      .rp-sug button{display:block;width:100%;text-align:left;border:0;background:none;padding:9px 12px;cursor:pointer;
        font:inherit;color:#16201b;border-bottom:1px solid #f0f3f1}
      .rp-sug button:hover{background:#f2f7f4}
      .rp-sug b{display:block;font-size:.9rem}
      .rp-sug span{font-size:.78rem;color:#6b7a73}
      .rp-picked{font-size:.8rem;color:#0a6f4d;margin-top:5px;font-weight:600}
      .rp-go{width:100%;padding:13px;border:0;border-radius:11px;background:#0a6f4d;color:#fff;font-weight:800;
        font-size:1rem;cursor:pointer;margin-top:4px}
      .rp-go:disabled{opacity:.6;cursor:default}
      .rp-foot{display:flex;gap:8px;margin-top:8px}
      .rp-link{flex:1;padding:10px;border:0;border-radius:11px;background:none;color:#64748b;
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
      .rp-mine .rp-rm{flex-shrink:0;padding:7px 12px;border:1px solid #f0c9c4;border-radius:9px;background:#fff5f4;
        color:#b3261e;font-weight:700;font-size:.82rem;cursor:pointer}
      .rp-mine .rp-rm:disabled{opacity:.55;cursor:default}
      .rp-empty{color:#52605a;font-size:.9rem;text-align:center;padding:14px 4px}
      .rp-row textarea{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cdd9d3;
        border-radius:10px;font:inherit;font-size:.95rem;resize:vertical;color:#16201b}
      .rp-row textarea:focus{outline:none;border-color:#0a6f4d;box-shadow:0 0 0 3px rgba(10,111,77,.15)}
      .rp-check{display:flex;align-items:center}
      .rp-chk{display:flex;align-items:center;gap:8px;font-weight:600;color:#34403a;cursor:pointer;margin:0}
      .rp-chk input{width:auto;flex-shrink:0;margin:0}
      .rp-chk small{font-weight:400;color:#7a877f;display:block}
      .rp-amen{display:flex;flex-wrap:wrap;gap:6px}
      .rp-amen label{display:inline-flex;align-items:center;gap:5px;font-size:.82rem;padding:6px 10px;
        border:1px solid #cdd9d3;border-radius:999px;background:#fff;cursor:pointer;color:#34403a}
      .rp-amen input{width:auto;margin:0}
      .rp-amen label:has(input:checked){border-color:#0a6f4d;background:#eafaf3;color:#0a6f4d;font-weight:600}`;
    document.head.appendChild(s);
  }

  function close(back) { try { back.remove(); } catch (_) {} }

  // ---- persistence --------------------------------------------------------

  function readMine() {
    try { return JSON.parse(localStorage.getItem(MINE_KEY) || "[]"); } catch (_) { return []; }
  }
  function writeMine(arr) {
    try { localStorage.setItem(MINE_KEY, JSON.stringify(arr)); } catch (_) {}
  }

  // Insert the demand pin, stripping any column the live schema lacks (region /
  // district / needed_by on older DBs) so it always saves; falls back to
  // localStorage with no backend.
  async function saveDemand(pin) {
    const sb = window.DataStore && window.DataStore.sb;
    if (!sb) return;   // local-only echo handled by the caller
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
      if (/relation .* does not exist|schema cache/i.test(error.message || ""))
        throw new Error("Requests aren't set up on this server yet. Run supabase/setup_house_demand.sql + house_demand_region.sql.");
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
  async function resolveTarget({ region, text, gps, district }) {
    let lat = null, lng = null, area = text, dist = district || null, regOut = region;

    if (picked && Number.isFinite(picked.lat) && Number.isFinite(picked.lng)) {
      lat = +picked.lat; lng = +picked.lng; area = area || picked.name;
    } else if (text) {
      const hits = await (window.pawaGeo ? window.pawaGeo.suggest(text, { limit: 5 }) : Promise.resolve([])).catch(() => []);
      const h = (hits || []).find((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng));
      if (h) { lat = +h.lat; lng = +h.lng; area = area || h.name; }
    }
    if (lat == null && gps) { lat = gps.lat; lng = gps.lng; }
    if (lat == null) { const c = regionCentroid(region); if (c) { lat = c.lat; lng = c.lng; } }

    if (lat != null && lng != null && window.pawaGeo) {
      try {
        const j = await window.pawaGeo.reverse(`format=json&zoom=12&addressdetails=1&lat=${lat}&lon=${lng}`);
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
      selectEl.innerHTML = `<option value="">Choose your region…</option>` +
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
    ensureStyles();
    picked = null; gpsPoint = null; gpsDistrict = null;

    const back = document.createElement("div");
    back.className = "rp-back";
    back.setAttribute("role", "dialog");
    back.setAttribute("aria-modal", "true");
    back.innerHTML = `
      <div class="rp-card">
        <h2>Tell us what you want</h2>
        <p class="rp-lead">No map needed. Pick your region, say what you want and when — agents working there will see your request and call you when something matches.</p>

        <div class="rp-row">
          <label for="rpRegion">Your region <small>(which region to search in)</small></label>
          <select id="rpRegion"><option value="">Choose your region…</option></select>
          <button id="rpLoc" class="rp-loc" type="button">📍 Use my location to set this</button>
        </div>

        <div class="rp-row">
          <label for="rpWhere">Area or street <small>(optional — even an informal name)</small></label>
          <input id="rpWhere" type="text" autocomplete="off" placeholder="e.g. Mikocheni, near the market" />
          <div id="rpSug" class="rp-sug" hidden></div>
          <div id="rpPicked" class="rp-picked" hidden></div>
        </div>

        <div class="rp-2">
          <div class="rp-row">
            <label for="rpListing">Rent or buy?</label>
            <select id="rpListing">
              <option value="rent">For rent</option>
              <option value="sale">To buy</option>
            </select>
          </div>
          <div class="rp-row">
            <label for="rpType">Type <small>(optional)</small></label>
            <input id="rpType" type="text" list="rpTypeList" autocomplete="off" maxlength="40" placeholder="e.g. self-contained, godown…" />
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
            <label for="rpPrice">Max price <small>(TZS / month)</small></label>
            <input id="rpPrice" type="number" inputmode="numeric" min="0" placeholder="e.g. 250000" />
          </div>
          <div class="rp-row">
            <label for="rpPay">Payment plan <small>(upfront)</small></label>
            <select id="rpPay">
              <option value="">No preference</option>
              <option value="Monthly">Monthly</option>
              <option value="3 months">3 months</option>
              <option value="6 months">6 months</option>
              <option value="12 months">12 months</option>
              <option value="Flexible">Flexible</option>
            </select>
          </div>
        </div>

        <div class="rp-2">
          <div class="rp-row">
            <label for="rpBeds">Bedrooms <small>(min)</small></label>
            <input id="rpBeds" type="number" inputmode="numeric" min="0" placeholder="any" />
          </div>
          <div class="rp-row">
            <label for="rpBaths">Bathrooms <small>(min)</small></label>
            <input id="rpBaths" type="number" inputmode="numeric" min="0" placeholder="any" />
          </div>
        </div>

        <div class="rp-2">
          <div class="rp-row">
            <label for="rpFurnished">Furnished?</label>
            <select id="rpFurnished">
              <option value="">Either</option>
              <option value="Furnished">Furnished</option>
              <option value="Unfurnished">Unfurnished</option>
            </select>
          </div>
          <div class="rp-row rp-check">
            <label class="rp-chk"><input id="rpSelfC" type="checkbox" /> <span>Self-contained <small>toilet inside</small></span></label>
          </div>
        </div>

        <div class="rp-row">
          <label>Must have <small>(tick what you can't do without — agents skip places missing these)</small></label>
          <div class="rp-amen" id="rpAmen">
            <label><input type="checkbox" value="Water" /> Water</label>
            <label><input type="checkbox" value="Electricity (LUKU)" /> Electricity</label>
            <label><input type="checkbox" value="Own meter" /> Own meter</label>
            <label><input type="checkbox" value="Parking" /> Parking</label>
            <label><input type="checkbox" value="Fence / security" /> Fence / security</label>
            <label><input type="checkbox" value="Tiled floor" /> Tiled</label>
            <label><input type="checkbox" value="Master ensuite" /> Master ensuite</label>
            <label><input type="checkbox" value="Fitted kitchen" /> Kitchen</label>
            <label><input type="checkbox" value="Ceiling" /> Ceiling</label>
          </div>
        </div>

        <div class="rp-2">
          <div class="rp-row">
            <label for="rpFrom">Move in from <small>(optional)</small></label>
            <input id="rpFrom" type="date" />
          </div>
          <div class="rp-row">
            <label for="rpWhen">Need it by <small>(deadline)</small></label>
            <input id="rpWhen" type="date" />
          </div>
        </div>

        <div class="rp-row">
          <label for="rpElse">Anything else / what to avoid <small>(optional)</small></label>
          <textarea id="rpElse" rows="2" maxlength="300" placeholder="e.g. not on a main road, ground floor only, near a school…"></textarea>
        </div>

        <div class="rp-2">
          <div class="rp-row">
            <label for="rpPhone">Your phone <small>(so an agent can call)</small></label>
            <input id="rpPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="07XX XXX XXX" />
          </div>
          <div class="rp-row">
            <label for="rpName">Your name <small>(optional)</small></label>
            <input id="rpName" type="text" maxlength="60" autocomplete="name" placeholder="e.g. Asha" />
          </div>
        </div>

        <div id="rpMsg" class="rp-msg" role="status"></div>
        <button id="rpGo" class="rp-go" type="button">Send my request</button>
        <div class="rp-foot">
          <button id="rpMine" class="rp-link rp-strong" type="button">My requests</button>
          <button id="rpCancel" class="rp-link" type="button">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(back);

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

    // ---- use my location → set region + district + point ----
    locEl.addEventListener("click", async () => {
      if (!window.pawaLocate || !window.pawaLocate.supported()) { setMsg("Location isn't available on this device — pick your region instead."); return; }
      locEl.disabled = true; locEl.textContent = "Locating…"; setMsg("Getting your location…", true);
      try {
        const fix = await window.pawaLocate.best({ maxWaitMs: 9000 });
        gpsPoint = { lat: fix.lat, lng: fix.lng };
        let reg = "", label = "";
        if (window.pawaGeo) {
          try {
            const j = await window.pawaGeo.reverse(`format=json&zoom=14&addressdetails=1&lat=${fix.lat}&lon=${fix.lng}`);
            const a = (j && j.address) || {};
            reg = await canonRegion(a.state || a.region || a.county || "");
            gpsDistrict = canonDistrict(a.county || a.state_district || a.city_district || a.municipality || a.district || "");
            label = simplifyArea([a.suburb || a.neighbourhood || a.village || a.hamlet, a.city || a.town || a.city_district].filter(Boolean).join(", "));
          } catch (_) {}
        }
        if (reg) { await fillRegions(regionEl, reg); }
        if (label && !whereEl.value.trim()) whereEl.value = label;
        setMsg(reg ? `Location found — region set to ${reg}.` : "Location found — please confirm your region.", true);
      } catch (e) {
        setMsg((window.pawaLocate && window.pawaLocate.message) ? window.pawaLocate.message(e) : "Couldn't get your location — pick your region instead.");
      } finally {
        locEl.disabled = false; locEl.textContent = "📍 Use my location to set this";
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
        pickedEl.textContent = "📍 " + (h.name || "") + (h.context ? " · " + h.context : "");
        pickedEl.hidden = false;
        sugEl.hidden = true;
        // Best-effort: set region from the suggestion if the user hasn't chosen one.
        if (!regionEl.value && picked.region) {
          const r = await canonRegion(picked.region);
          if (r) await fillRegions(regionEl, r);
        }
      }));
    }
    whereEl.addEventListener("input", () => {
      picked = null; pickedEl.hidden = true;
      const q = whereEl.value.trim();
      clearTimeout(sugTimer);
      if (q.length < 2 || !window.pawaGeo) { sugEl.hidden = true; return; }
      sugTimer = setTimeout(async () => {
        const list = await window.pawaGeo.suggest(q, { limit: 6 }).catch(() => []);
        showSug(list);
      }, 320);
    });

    // ---- submit ----
    goEl.addEventListener("click", async () => {
      const region = regionEl.value.trim();
      const text = simplifyArea(whereEl.value);
      const phone = $("#rpPhone").value.trim();
      const digits = phone.replace(/\D/g, "");
      if (!region) { setMsg("Choose your region (or tap “Use my location”)."); regionEl.focus(); return; }
      if (digits.length < 9) { setMsg("Enter a phone number so an agent can reach you."); $("#rpPhone").focus(); return; }

      goEl.disabled = true; goEl.textContent = "Sending…"; setMsg("");
      try {
        const place = await resolveTarget({ region, text, gps: gpsPoint, district: gpsDistrict });
        if (place.lat == null || place.lng == null) {
          setMsg("Couldn't place that — tap “Use my location”, or type a nearby town."); goEl.disabled = false; goEl.textContent = "Send my request"; return;
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
          radius_m: 3000,
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
          phone: pin.phone, lat: pin.lat, lng: pin.lng, at: Date.now() });
        writeMine(mine);

        const regionStr = esc(pin.region);
        $(".rp-card").innerHTML = `<div class="rp-done">
          <div class="rp-tick">✓</div>
          <h3>Request sent</h3>
          <p>Agents working in <strong>${regionStr}</strong> can now see that you want a place ${pin.listing === "sale" ? "to buy" : "to rent"} in <strong>${esc(pin.area)}</strong>${pin.needed_by ? ` by <strong>${esc(pin.needed_by)}</strong>` : ""}. They'll call you on the number you gave when something matches.</p>
          <button class="rp-go" type="button" id="rpDone">Done</button>
          <div class="rp-foot"><button class="rp-link rp-strong" type="button" id="rpToMine">My requests</button></div>
        </div>`;
        $("#rpDone").addEventListener("click", () => close(back));
        $("#rpToMine").addEventListener("click", () => { close(back); openMine(); });
      } catch (err) {
        setMsg((err && err.message) || "Couldn't send your request — please try again.");
        goEl.disabled = false; goEl.textContent = "Send my request";
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
            .select("id,area,region,listing,type,max_budget_tzs,needed_by,active,created_at,phone")
            .eq("user_id", session.user.id).order("created_at", { ascending: false });
          (data || []).forEach((r) => byId.set(r.id, { ...r, at: new Date(r.created_at).getTime() }));
        }
      } catch (_) {}
    }
    local.forEach((r) => { if (!byId.has(r.id)) byId.set(r.id, r); });
    return [...byId.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  function mineRowHtml(r) {
    const bits = [r.listing === "sale" ? "buying" : "renting"];
    if (r.type) bits.push(esc(r.type));
    if (r.max_budget_tzs) bits.push("≤ " + fmtTzs(r.max_budget_tzs) + " TZS");
    if (r.needed_by) bits.push("by " + esc(String(r.needed_by).slice(0, 10)));
    if (r.active === false) bits.push("closed");
    return `<li data-id="${esc(r.id)}">
      <div>
        <div class="rp-mine-where">${esc(r.area || r.region || "Your request")}</div>
        <div class="rp-mine-sub">${esc(r.region || "")}${r.region ? " · " : ""}${bits.join(" · ")}</div>
      </div>
      <button class="rp-rm" type="button" data-id="${esc(r.id)}" data-phone="${esc(r.phone || "")}">Remove</button>
    </li>`;
  }

  async function openMine() {
    ensureStyles();
    const back = document.createElement("div");
    back.className = "rp-back";
    back.setAttribute("role", "dialog");
    back.setAttribute("aria-modal", "true");
    back.innerHTML = `
      <div class="rp-card">
        <h2>My requests</h2>
        <p class="rp-lead">Requests you've sent. Remove one once you've found a place — agents will stop seeing it.</p>
        <div id="rpMineBody"><p class="rp-empty">Loading…</p></div>
        <button class="rp-go" type="button" id="rpNew">+ New request</button>
        <div class="rp-foot"><button class="rp-link" type="button" id="rpMineClose">Close</button></div>
      </div>`;
    document.body.appendChild(back);

    const body = back.querySelector("#rpMineBody");
    back.addEventListener("click", (e) => { if (e.target === back) close(back); });
    back.querySelector("#rpMineClose").addEventListener("click", () => close(back));
    back.querySelector("#rpNew").addEventListener("click", () => { close(back); open(); });

    async function render() {
      const rows = await fetchMine();
      if (!rows.length) { body.innerHTML = `<p class="rp-empty">You haven't sent any requests yet.</p>`; return; }
      body.innerHTML = `<ul class="rp-mine">${rows.map(mineRowHtml).join("")}</ul>`;
      body.querySelectorAll(".rp-rm").forEach((btn) => btn.addEventListener("click", async () => {
        btn.disabled = true; btn.textContent = "Removing…";
        try {
          await removeDemand(btn.dataset.id, btn.dataset.phone);
          const li = btn.closest("li"); if (li) li.remove();
          if (!body.querySelector(".rp-mine li")) body.innerHTML = `<p class="rp-empty">You haven't sent any requests yet.</p>`;
        } catch (_) {
          btn.disabled = false; btn.textContent = "Remove";
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
