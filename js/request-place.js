// =====================================================================
// Request a place — TYPE it, no map
// =====================================================================
// The simplest way for a seeker to raise demand: just type WHERE they want, the
// PRICE they can pay, and WHEN they need it. We geocode the place (to a point +
// its region), save it as a house_demand_pin tagged with that region, and every
// agent operating in that region sees it on their dashboard and can call them.
//
// It reuses the same house_demand_pins table + privacy model as the map-based
// area alerts (the phone is only ever returned to agents via SECURITY DEFINER
// RPCs), so this is purely a friendlier ON-RAMP, not a new data path.
//
//   window.pawaRequestPlace.open();           // open the modal
//   window.pawaRequestPlace.open({ region }); // prefill nothing special yet
(function () {
  "use strict";

  const esc = (s) => window.escHtml ? window.escHtml(s) : String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let picked = null;      // { lat, lng, name, region } chosen from suggestions
  let sugTimer = null;

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
      .rp-cancel{width:100%;padding:10px;border:0;border-radius:11px;background:none;color:#64748b;
        font-size:.92rem;cursor:pointer;margin-top:6px}
      .rp-msg{min-height:18px;font-size:.84rem;color:#b91c1c;margin:2px 0 6px}
      .rp-msg.ok{color:#0a6f4d}
      .rp-done{text-align:center;padding:10px 4px}
      .rp-done .rp-tick{width:54px;height:54px;border-radius:50%;background:#e7f5ee;color:#0a6f4d;display:flex;
        align-items:center;justify-content:center;font-size:28px;margin:6px auto 12px}
      .rp-done h3{margin:0 0 6px;font-size:1.1rem;color:#0a6f4d}
      .rp-done p{margin:0 0 14px;color:#41504a;font-size:.92rem;line-height:1.5}`;
    document.head.appendChild(s);
  }

  function close(back) { try { back.remove(); } catch (_) {} }

  // Resolve the typed place → { lat, lng, name, region }. Uses the chosen
  // suggestion when there is one, else geocodes the typed text; then reverse-
  // geocodes for the region so agents can be matched by region.
  // Strip a "District"/"Wilaya" suffix so a reverse-geocoded district lines up
  // with the agent's declared district (agent_profiles.district).
  function canonDistrict(raw) {
    return String(raw || "").replace(/\s+(district|wilaya)$/i, "").trim() || null;
  }

  async function resolvePlace(text) {
    let hit = picked;
    if (!hit) {
      const hits = await (window.pawaGeo ? window.pawaGeo.suggest(text, { limit: 5 }) : Promise.resolve([])).catch(() => []);
      hit = (hits || []).find((h) => Number.isFinite(h.lat) && Number.isFinite(h.lng)) || null;
    }
    if (!hit) return null;
    // One reverse-geocode gives BOTH the region (the hard match key) and the
    // district (the precise routing key — agents declare a region + district).
    let region = hit.region || "", district = "";
    if (window.pawaGeo) {
      try {
        const j = await window.pawaGeo.reverse(`format=json&zoom=12&addressdetails=1&lat=${hit.lat}&lon=${hit.lng}`);
        const a = (j && j.address) || {};
        if (!region) region = a.state || a.region || a.county || a.state_district || "";
        district = a.county || a.state_district || a.city_district || a.district || a.municipality || "";
      } catch (_) {}
    }
    if (!region && hit.context) region = String(hit.context).split(",").map((s) => s.trim()).filter(Boolean).pop() || "";
    return { lat: +hit.lat, lng: +hit.lng, name: hit.name || text,
      region: (await canonRegion(region)) || null, district: canonDistrict(district) };
  }

  // Insert the demand pin, stripping any column the live schema lacks (region /
  // needed_by on older DBs) so it always saves; falls back to localStorage with
  // no backend.
  async function saveDemand(pin) {
    const sb = window.DataStore && window.DataStore.sb;
    if (!sb) {
      const local = JSON.parse(localStorage.getItem("pawa_demand_pins") || "[]");
      local.push(pin); localStorage.setItem("pawa_demand_pins", JSON.stringify(local));
      return;
    }
    try {
      const { data: { session } } = await sb.auth.getSession();
      pin.user_id = session && session.user ? session.user.id : null;
    } catch (_) { pin.user_id = null; }
    let payload = { ...pin }, error;
    for (let i = 0; i < 5; i++) {
      ({ error } = await sb.from("house_demand_pins").insert(payload));
      if (!error) break;
      const m = /column "?([a-z_]+)"?\s+.*does not exist|Could not find the '([a-z_]+)' column/i.exec(error.message || "");
      const col = m && (m[1] || m[2]);
      if (col && col in payload && col !== "phone" && col !== "lat" && col !== "lng" && col !== "id") { delete payload[col]; continue; }
      break;
    }
    if (error) {
      if (/relation .* does not exist|schema cache/i.test(error.message || ""))
        throw new Error("Requests aren't set up on this server yet. Run supabase/setup_house_demand.sql + house_demand_region.sql.");
      throw error;
    }
  }

  function open(opts) {
    opts = opts || {};
    ensureStyles();
    picked = null;

    const back = document.createElement("div");
    back.className = "rp-back";
    back.setAttribute("role", "dialog");
    back.setAttribute("aria-modal", "true");
    back.innerHTML = `
      <div class="rp-card">
        <h2>Tell us what you want</h2>
        <p class="rp-lead">No map — just type it. Agents working in that area will see your request and call you when something matches.</p>

        <div class="rp-row">
          <label for="rpWhere">Where do you want it? <small>town, ward or area</small></label>
          <input id="rpWhere" type="text" autocomplete="off" placeholder="e.g. Mikocheni, Kinondoni" />
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
            <label for="rpType">Type <small>(optional — type anything)</small></label>
            <input id="rpType" type="text" list="rpTypeList" autocomplete="off" maxlength="40" placeholder="e.g. self-contained, frame, godown, hostel…" />
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
            <label for="rpPrice">Max price <small>(TZS)</small></label>
            <input id="rpPrice" type="number" inputmode="numeric" min="0" placeholder="e.g. 250000" />
          </div>
          <div class="rp-row">
            <label for="rpBeds">Bedrooms <small>(min)</small></label>
            <input id="rpBeds" type="number" inputmode="numeric" min="0" placeholder="any" />
          </div>
        </div>

        <div class="rp-2">
          <div class="rp-row">
            <label for="rpWhen">When do you need it by?</label>
            <input id="rpWhen" type="date" />
          </div>
          <div class="rp-row">
            <label for="rpPhone">Your phone <small>(so an agent can call)</small></label>
            <input id="rpPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="07XX XXX XXX" />
          </div>
        </div>

        <div id="rpMsg" class="rp-msg" role="status"></div>
        <button id="rpGo" class="rp-go" type="button">Send my request</button>
        <button id="rpCancel" class="rp-cancel" type="button">Cancel</button>
      </div>`;
    document.body.appendChild(back);

    const $ = (id) => back.querySelector(id);
    const whereEl = $("#rpWhere"), sugEl = $("#rpSug"), pickedEl = $("#rpPicked");
    const msgEl = $("#rpMsg"), goEl = $("#rpGo");
    const setMsg = (t, ok) => { msgEl.textContent = t || ""; msgEl.classList.toggle("ok", !!ok); };

    back.addEventListener("click", (e) => { if (e.target === back) close(back); });
    $("#rpCancel").addEventListener("click", () => close(back));
    if (opts.where) whereEl.value = opts.where;

    // ---- live place suggestions ----
    function showSug(list) {
      if (!list || !list.length) { sugEl.hidden = true; sugEl.innerHTML = ""; return; }
      sugEl.innerHTML = list.slice(0, 6).map((h, i) =>
        `<button type="button" data-i="${i}"><b>${esc(h.name)}</b><span>${esc(h.context || "")}</span></button>`).join("");
      sugEl.hidden = false;
      sugEl.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
        const h = list[+b.dataset.i];
        picked = { lat: +h.lat, lng: +h.lng, name: h.name, region: (h.context ? String(h.context).split(",").map((s) => s.trim()).pop() : "") };
        whereEl.value = h.name + (h.context ? ", " + h.context : "");
        pickedEl.textContent = " " + (h.name || "") + (h.context ? " · " + h.context : "");
        pickedEl.hidden = false;
        sugEl.hidden = true;
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
      const text = whereEl.value.trim();
      const phone = $("#rpPhone").value.trim();
      const digits = phone.replace(/\D/g, "");
      if (!text) { setMsg("Type where you want the place."); whereEl.focus(); return; }
      if (digits.length < 9) { setMsg("Enter a phone number so an agent can reach you."); $("#rpPhone").focus(); return; }

      goEl.disabled = true; goEl.textContent = "Sending…"; setMsg("");
      try {
        const place = await resolvePlace(text);
        if (!place) { setMsg("Couldn't find that place — try a town, ward or area name."); goEl.disabled = false; goEl.textContent = "Send my request"; return; }

        // Free-text type — the seeker may want ANY kind of place, not only the
        // listed ones (self-contained, frame, godown, hostel, …).
        const typeVal = ($("#rpType").value || "").trim().toLowerCase().slice(0, 40);
        const pin = {
          id: "dp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          lat: place.lat, lng: place.lng,
          area: place.name || text,
          region: place.region || null,
          district: place.district || null,
          radius_m: 3000,
          listing: $("#rpListing").value === "sale" ? "sale" : "rent",
          type: typeVal || null,
          min_bedrooms: Number($("#rpBeds").value) || 0,
          max_budget_tzs: Number($("#rpPrice").value) || 0,
          phone: phone,
          name: null,
          needed_from: null,
          needed_by: $("#rpWhen").value || null,
          note: "Typed request",
        };
        await saveDemand(pin);

        // Remember locally (so the seeker can see it was sent).
        try {
          const mine = JSON.parse(localStorage.getItem("pawa_my_demand_pins") || "[]");
          mine.push({ id: pin.id, area: pin.area, region: pin.region, lat: pin.lat, lng: pin.lng, at: Date.now() });
          localStorage.setItem("pawa_my_demand_pins", JSON.stringify(mine));
        } catch (_) {}

        const regionStr = place.region ? esc(place.region) : esc(place.name || text);
        $(".rp-card").innerHTML = `<div class="rp-done">
          <div class="rp-tick">✓</div>
          <h3>Request sent</h3>
          <p>Agents working in <strong>${regionStr}</strong> can now see that you want a place ${pin.listing === "sale" ? "to buy" : "to rent"} in <strong>${esc(pin.area)}</strong>${pin.needed_by ? ` by <strong>${esc(pin.needed_by)}</strong>` : ""}. They'll call you on the number you gave when something matches.</p>
          <button class="rp-go" type="button" id="rpDone">Done</button>
        </div>`;
        $("#rpDone").addEventListener("click", () => close(back));
      } catch (err) {
        setMsg((err && err.message) || "Couldn't send your request — please try again.");
        goEl.disabled = false; goEl.textContent = "Send my request";
      }
    });

    setTimeout(() => { try { whereEl.focus(); } catch (_) {} }, 40);
  }

  window.pawaRequestPlace = { open };
  window.pawaCanonRegion = canonRegion;
  window.pawaCanonDistrict = canonDistrict;
})();
