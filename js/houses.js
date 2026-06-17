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
  const fRoom      = document.getElementById("filterRoom");
  const fPrice     = document.getElementById("filterPrice");
  const fSearch    = document.getElementById("filterSearch");
  const nearBtn    = document.getElementById("houseNearMeBtn");
  const alertBtn   = document.getElementById("houseAlertBtn");
  const commuteBtn = document.getElementById("houseCommuteBtn");
  const alertBanner= document.getElementById("housesAlertBanner");
  const watchChips = document.getElementById("housesWatchChips");
  const placesChips= document.getElementById("housesPlacesChips");
  const tabList    = document.getElementById("tabList");
  const tabMap     = document.getElementById("tabMap");
  const ssForm     = document.getElementById("smartSearch");
  const ssInput    = document.getElementById("smartSearchInput");
  const ssChips    = document.getElementById("smartSearchChips");
  const ssExamples = document.getElementById("smartSearchExamples");

  // ---- State -------------------------------------------------------------
  let houses    = [];
  let visible   = [];
  let map       = null;
  let markers   = new Map();   // id -> marker
  let activeId  = null;
  let userLoc   = null;
  let smartCriteria = null;        // parsed natural-language query (or null)
  let smartAiNote   = null;        // AI's one-line confirmation when AI parsed it
  let matchScores   = new Map();   // house id -> match % (when smart search active)
  let landmarkLoc   = null;        // { lat, lng, name } anchor when a known place is searched
  let landmarkMarker= null;        // MapLibre marker for the landmark anchor
  const roadKmCache = new Map();   // "oLat,oLng>dLat,dLng" → real road km | null (no route)
  let enrichingHousesRoad = false;
  const mainRoadCache = new Map(); // house id → {name,meters} | null (no main road within 3 km)
  let enrichingMainRoads = false;
  let myPlaces      = [];          // [{id,label,kind,name,lat,lng,mode,maxMin}] — "match to my life"
  let commuteScores = new Map();   // house id -> { legs, total, pass } when myPlaces active
  let commuteRoadKm = new Map();   // "placeId|houseId" -> real road km (number) | null (no road) — cached
  let enrichingCommute = false;

  // ---- Segments (Rent / Sale / Business) + list arrangement --------------
  // A "segment" is the top-level world the user is browsing. Residential
  // rentals/sales are kept apart from commercial premises so searching is
  // simpler. Business = office / shop / warehouse, either rent OR sale.
  const TYPE_LABELS = { apartment: "Apartment", house: "House", plot: "Plot",
    office: "Office", shop: "Shop / business", warehouse: "Warehouse" };
  const RESIDENTIAL_TYPES = ["apartment", "house", "plot"];
  const BUSINESS_TYPES    = ["office", "shop", "warehouse"];
  const isBusinessType  = (t) => BUSINESS_TYPES.includes(t);
  const roomKindLabel   = (k) => k === "single" ? "Single room" : k === "master" ? "Master room" : "";
  const typesForSegment = (seg) =>
    seg === "business" ? BUSINESS_TYPES
    : (seg === "rent" || seg === "sale") ? RESIDENTIAL_TYPES
    : [...RESIDENTIAL_TYPES, ...BUSINESS_TYPES];
  let segment   = "all";
  let sortMode  = localStorage.getItem("pawa.houseSort") || "recommended";
  let viewMode  = localStorage.getItem("pawa.houseView") || "comfortable";
  let mapHidden = localStorage.getItem("pawa.houseMapHidden") === "1";

  // Transport modes + place kinds for "Match to my life" (declared up here so
  // setupMyPlaces(), which runs during init, is never in their dead zone).
  const MODES = {
    walk:     { label: "Walk",     icon: "", kmh: 4.5 },
    bodaboda: { label: "Bodaboda", icon: "", kmh: 22 },
    bajaji:   { label: "Bajaji",   icon: "", kmh: 18 },
    daladala: { label: "Daladala", icon: "", kmh: 16 },
    car:      { label: "Car",      icon: "", kmh: 26 }
  };
  const PLACE_KINDS = {
    work:   { icon: "", label: "Workplace" },
    school: { icon: "", label: "School" },
    family: { icon: "", label: "Family / friends" },
    fav:    { icon: "", label: "Favourite spot" },
    custom: { icon: "", label: "Place" }
  };
  const ROAD_DETOUR = 1.3;         // straight-line km × this ≈ road km in a TZ city

  // ---- Map opens immediately, independent of data/network speed ----------
  // (initMap is hoisted; it only needs the static container, not the listings.)
  // A slow Supabase/data fetch must never leave the user staring at a blank map.
  initMap();
  // Warm up the Rust→WASM matching engine while data + tiles load.
  window.HouseMatch?.warmup?.();

  // ---- Load data (the map is already visible while this resolves) ---------
  try {
    houses = await window.DataStore.getHouses();
  } catch (e) {
    listEl.innerHTML = `<div class="banner error">Couldn't load properties: ${e.message}</div>`;
    return;
  }

  // Populate the area autocomplete from the data so it stays in sync. The area
  // filter is a free-text box (with this datalist as suggestions) so a user can
  // simply TYPE the area they want — it matches by substring, not exact value.
  const areaList = document.getElementById("filterAreaList");
  // Suggest every admin level agents have registered: region, district, ward, area.
  const areas = Array.from(new Set(houses.flatMap(h => [h.region, h.district, h.ward, h.area]).filter(Boolean))).sort();
  areas.forEach(a => {
    const opt = document.createElement("option");
    opt.value = a;
    (areaList || fArea).appendChild(opt);
  });

  // ---- Segments + list arrangement (set before the first render) ---------
  setupSegments();
  setupArrangement();

  // ---- Filters & render --------------------------------------------------
  [fListing, fType, fBeds, fRoom].forEach(el => el?.addEventListener("change", apply));
  // Free-text inputs (area + budget + search) filter live, debounced as you type.
  [fArea, fPrice, fSearch].forEach(el => el?.addEventListener("input", () => {
    clearTimeout(window._hf); window._hf = setTimeout(apply, 180);
  }));

  apply();

  // ---- Smart natural-language search -------------------------------------
  setupSmartSearch();

  // ---- Geo-circle area alerts (Nominatim + GPS + draggable pin) ----------
  setupGeoAlerts();

  // ---- "Match to my life" — rank/filter by distance to the user's places -
  setupMyPlaces();

  // ---- Near-me -----------------------------------------------------------
  nearBtn?.addEventListener("click", async () => {
    const idle = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg> Near me`;
    nearBtn.disabled = true; nearBtn.textContent = "Locating…";
    try {
      const fix = await pawaLocate.bestOrApprox({ targetAccuracy: 50 });
      userLoc = { lat: fix.lat, lng: fix.lng };
      nearBtn.disabled = false;
      const locLabel = fix.approximate ? "Approx. location" : "Sorted by distance";
      nearBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg> ${locLabel}`;
      if (map && !landmarkLoc) map.easeTo({ center: [userLoc.lng, userLoc.lat], zoom: 12 });
      updateLandmarkInfo();   // now we can show "your home is X km from <place>"
      apply();   // resort by proximity
    } catch (err) {
      nearBtn.disabled = false;
      nearBtn.innerHTML = idle;
      alert(pawaLocate.message(err));
    }
  });

  // ---- Workplace / daily-route distance ---------------------------------
  // Same tool as the house-detail page, adapted to the results map: type a
  // workplace/route, geocode it (LocationIQ, Tanzania-wide via pawaGeo.suggest),
  // then rank the listings by closeness — reusing the landmark machinery
  // (drops a pin, sorts nearest-first, each card shows its km, shades the area).
  // No match → ask the user for a famous nearby area and try again.
  (function setupWorkplaceTool() {
    const input = document.getElementById("hwInput");
    const btn   = document.getElementById("hwBtn");
    const clear = document.getElementById("hwClear");
    const msgEl = document.getElementById("hwMsg");
    const resEl = document.getElementById("hwResults");
    if (!input || !btn || !window.pawaGeo) return;

    function showMsg(html, kind) {
      msgEl.innerHTML = html;
      msgEl.className = "hw-msg" + (kind ? " " + kind : "");
      msgEl.hidden = !html;
    }
    function pick(p, rows) {
      setLandmark({ lat: p.lat, lng: p.lng, name: p.name });   // pin + re-rank + per-card distance
      if (clear) clear.hidden = false;
      showMsg(
        `Ranking homes by distance to <strong>${esc(p.name)}</strong>` +
        `${p.context ? ` <span class="hw-ctx">(${esc(p.context)})</span>` : ""}. ` +
        `Nearest first — each card shows how far it is.`,
        "ok"
      );
      if (rows) rows.forEach((r) => r.el.classList.toggle("active", r.place === p));
    }

    async function run() {
      const q = input.value.trim();
      if (q.length < 2) { showMsg("Type your workplace, office area or a place on your daily route.", "warn"); return; }
      btn.disabled = true; btn.textContent = "Locating…";
      showMsg(`Searching for “${esc(q)}”…`, "");
      resEl.innerHTML = "";
      let places = [];
      try { places = await pawaGeo.suggest(q, { limit: 6 }); } catch (_) { places = []; }
      btn.disabled = false; btn.textContent = "Measure";

      if (!places.length) {
        showMsg(
          `We couldn't find “<strong>${esc(q)}</strong>”. Try a <strong>famous area, market, school or road near your workplace</strong> ` +
          `(a well-known landmark close by), then measure again.`,
          "warn"
        );
        return;
      }
      const rows = [];
      places.forEach((p) => {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "hw-result";
        el.innerHTML =
          `<span class="hw-rname">${esc(p.name)}</span>` +
          `<span class="hw-rmeta">${esc(p.tag || "Place")}${p.context ? " · " + esc(p.context) : ""}</span>`;
        resEl.appendChild(el);
        const row = { el, place: p };
        el.addEventListener("click", () => pick(p, rows));
        rows.push(row);
      });
      pick(places[0], rows);   // preview the top match; tap another to refine
    }

    btn.addEventListener("click", run);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
    clear?.addEventListener("click", () => {
      input.value = ""; resEl.innerHTML = ""; showMsg("", ""); clear.hidden = true;
      clearLandmark(); apply();
    });
  })();

  // ====================================================================
  //  Segments (Rent / Sale / Business) + list arrangement
  // ====================================================================
  function setupSegments() {
    const ctl = document.getElementById("hpSeg");
    const refine = document.getElementById("hpBizRefine");
    if (ctl) {
      ctl.querySelectorAll(".hp-seg").forEach(btn =>
        btn.addEventListener("click", () => {
          setSegment(btn.dataset.seg);
          document.getElementById("housesStage")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }));
    }
    refine?.querySelectorAll(".hp-biz-chip").forEach(chip =>
      chip.addEventListener("click", () => {
        fListing.value = chip.dataset.listing || "";
        refine.querySelectorAll(".hp-biz-chip").forEach(c => c.classList.toggle("active", c === chip));
        apply();
      }));
    setSegment(segment, { silent: true });   // sync UI + type options for the default
  }

  // Switch segment: highlight the tab, reshape the Type dropdown, manage the
  // rent/sale value (segments drive it for residential; Business uses its own
  // refine chips), then re-filter. Pass { silent:true } to skip the re-filter
  // when another caller (smart search, bento) will run apply() itself.
  function setSegment(seg, opts = {}) {
    segment = seg || "all";
    document.getElementById("hpSeg")?.querySelectorAll(".hp-seg").forEach(b => {
      const on = b.dataset.seg === segment;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    rebuildTypeOptions();
    const refine = document.getElementById("hpBizRefine");
    if (segment === "business") {
      if (refine) {
        refine.hidden = false;
        refine.querySelectorAll(".hp-biz-chip").forEach(c =>
          c.classList.toggle("active", (c.dataset.listing || "") === (fListing.value || "")));
      }
    } else {
      if (refine) refine.hidden = true;
      fListing.value = "";   // residential segments drive listing via passesSegment()
    }
    if (!opts.silent) apply();
  }

  // The Type dropdown only offers the types that make sense for the segment
  // (residential vs commercial), keeping the current choice when still valid.
  function rebuildTypeOptions() {
    if (!fType) return;
    const allowed = typesForSegment(segment);
    const cur = fType.value;
    fType.innerHTML = `<option value="">Type: any</option>` +
      allowed.map(t => `<option value="${t}">${esc(TYPE_LABELS[t] || t)}</option>`).join("");
    fType.value = allowed.includes(cur) ? cur : "";
  }

  // Does a listing belong in the active segment? Residential segments exclude
  // commercial premises (and vice-versa) so the two worlds never mix.
  function passesSegment(h) {
    const biz = isBusinessType(h.type);
    if (segment === "business") return biz;
    if (segment === "rent") return !biz && (h.listing || "rent") === "rent";
    if (segment === "sale") return !biz && (h.listing || "rent") === "sale";
    return true;   // "all"
  }

  // ---- Sort + view density + map toggle (all persisted) ------------------
  function setupArrangement() {
    const sortSel = document.getElementById("hpSort");
    const vt      = document.getElementById("hpViewToggle");
    const mapBtn  = document.getElementById("hpMapToggle");
    if (sortSel) {
      sortSel.value = sortMode;
      sortSel.addEventListener("change", () => {
        sortMode = sortSel.value;
        localStorage.setItem("pawa.houseSort", sortMode);
        renderList();
      });
    }
    vt?.querySelectorAll("button[data-vm]").forEach(b =>
      b.addEventListener("click", () => setViewMode(b.dataset.vm)));
    setViewMode(viewMode);
    if (mapBtn) {
      mapBtn.addEventListener("click", () => setMapHidden(!mapHidden));
      setMapHidden(mapHidden);
    }
  }

  function setViewMode(vm) {
    viewMode = vm || "comfortable";
    localStorage.setItem("pawa.houseView", viewMode);
    if (listEl) listEl.dataset.vm = viewMode;
    document.getElementById("hpViewToggle")?.querySelectorAll("button[data-vm]")
      .forEach(b => b.classList.toggle("active", b.dataset.vm === viewMode));
  }

  function setMapHidden(hidden) {
    mapHidden = !!hidden;
    localStorage.setItem("pawa.houseMapHidden", mapHidden ? "1" : "0");
    stage?.classList.toggle("no-map", mapHidden);
    const btn = document.getElementById("hpMapToggle");
    if (btn) {
      btn.classList.toggle("off", mapHidden);
      const lbl = btn.querySelector("span");
      if (lbl) lbl.textContent = mapHidden ? "Show map" : "Hide map";
    }
    if (!mapHidden && map) setTimeout(() => { try { map.resize(); } catch (_) {} }, 80);
  }

  // Explicit sort chosen in the results bar. "recommended" leaves the order
  // produced by rankAndRender() (proximity / commute / match) untouched.
  function applySort() {
    switch (sortMode) {
      case "price_asc":  visible.sort((a, b) => (a.price_tzs || 0) - (b.price_tzs || 0)); break;
      case "price_desc": visible.sort((a, b) => (b.price_tzs || 0) - (a.price_tzs || 0)); break;
      case "beds":       visible.sort((a, b) => (b.bedrooms || 0) - (a.bedrooms || 0)); break;
      case "newest":     visible.sort((a, b) =>
        new Date(b.created_at || b.createdAt || 0) - new Date(a.created_at || a.createdAt || 0)); break;
      case "nearest": { const a = houseAnchor(); if (a) visible.sort((x, y) => effDist(x) - effDist(y)); break; }
    }
  }

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
  //    3. Tap " GPS" to drop the pin at the user's current location
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

  // Human summary of an alert's criteria, e.g. "rent · apartment · 2+ beds · ≤300k".
  function alertCriteriaText(a) {
    const parts = [];
    if (a.listing)   parts.push(a.listing === "sale" ? "for sale" : "for rent");
    if (a.type)      parts.push(a.type);
    if (a.beds)      parts.push(a.beds + "+ beds");
    if (a.price_max) parts.push("≤" + (a.price_max >= 1e6 ? (a.price_max / 1e6) + "M" : Math.round(a.price_max / 1e3) + "k"));
    if (a.until)     parts.push("until " + a.until);
    return parts.join(" · ");
  }

  function renderWatchChips() {
    const alerts = getGeoAlerts();
    if (!alerts.length) { watchChips.hidden = true; watchChips.innerHTML = ""; return; }
    watchChips.hidden = false;
    watchChips.innerHTML = `<span style="font-size:.8rem;font-weight:600;color:var(--c-text-muted,#6b6960);align-self:center;margin-right:4px">Watching:</span>` +
      alerts.map(a => {
        const crit = alertCriteriaText(a);
        return `
        <span class="houses-watch-chip" title="${esc(crit || "Any listing in this area")}">
           ${esc(a.name)} <small>${esc(areaLabel(a))}${crit ? " · " + esc(crit) : ""}</small>
          <button type="button" data-id="${esc(a.id)}" aria-label="Stop alerts for ${esc(a.name)}" title="Stop alerts">&times;</button>
        </span>`;
      }).join("");
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

  // Short label for an alert's extent — "N areas" when it watches several, else
  // a single area's radius (circle) or kind (drawn shape / whole ward).
  function areaLabel(a) {
    const areas = alertAreas(a);
    return areas.length > 1 ? areas.length + " areas" : areaOneLabel(areas[0]);
  }
  function areaOneLabel(one) {
    if (!one) return "area";
    if (one.geo) return one.kind === "ward" ? "whole area" : "drawn area";
    return formatRadius(one.radius_m);
  }

  // Does a listing satisfy EVERY criterion of an alert (place + when + type
  // + price + bedrooms)? Users only get pinged about the rooms they actually
  // want — never the wrong type or price.
  function alertMatches(h, a) {
    if (!pointInAlertArea(h.lat, h.lng, a)) return false;
    if (a.listing && (h.listing || "rent") !== a.listing) return false;
    if (a.type && (h.type || "house") !== a.type) return false;
    if (a.beds && Number(h.bedrooms || 0) < a.beds) return false;
    if (a.price_max && Number(h.price_tzs || 0) > a.price_max) return false;
    return true;
  }

  // Normalise any alert to a list of watched areas — the new multi-area shape
  // (a.areas) as-is, or a legacy single circle / polygon wrapped in one. Each
  // area is { kind, geo?, bbox?, lat?, lng?, radius_m?, name? }.
  function alertAreas(a) {
    if (Array.isArray(a.areas) && a.areas.length) return a.areas;
    if (a.geo) return [{ kind: a.areaKind || "custom", geo: a.geo, bbox: a.bbox }];
    if (a.radius_m != null) return [{ kind: "circle", lat: a.lat, lng: a.lng, radius_m: a.radius_m }];
    return [];
  }

  // Is a listing's point inside ANY of the alert's watched areas? One alert can
  // hold several areas (e.g. Mikocheni OR Mbezi OR Sinza). Falls back to a
  // circle-only test if pawaPoly hasn't loaded, so an old cached page can never
  // silently stop matching.
  function pointInAlertArea(lat, lng, a) {
    if (lat == null || lng == null) return false;
    const areas = alertAreas(a);
    if (window.pawaPoly) return pawaPoly.pointInAreas(+lng, +lat, areas);
    return areas.some((ar) => ar.radius_m && ar.lat != null &&
      haversineKm(lat, lng, ar.lat, ar.lng) * 1000 <= ar.radius_m);
  }

  // Drop alerts whose "needed by" date has passed — the user found a place
  // (or stopped looking); silence beats stale notifications.
  function activeGeoAlerts() {
    const all = getGeoAlerts();
    const today = new Date().toISOString().slice(0, 10);
    const live = all.filter(a => !a.until || a.until >= today);
    if (live.length !== all.length) { saveGeoAlerts(live); renderWatchChips(); }
    return live;
  }

  // "300k" / "1.2m" / "300,000" → TZS number (0 = not set / unparseable).
  function parseTzsValue(s) {
    s = String(s || "").toLowerCase().replace(/[,\s]/g, "");
    const m = s.match(/^(\d+(?:\.\d+)?)(k|m)?/);
    if (!m) return 0;
    let v = +m[1];
    if (m[2] === "k") v *= 1e3;
    if (m[2] === "m") v *= 1e6;
    return Math.round(v);
  }

  function runNewListingDiff(currentList) {
    const alerts = activeGeoAlerts();
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
        if (alertMatches(h, a)) {
          const d = haversineKm(h.lat, h.lng, a.lat, a.lng) * 1000;
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
      <span class="ab-icon"></span>
      <div class="ab-body">
        <strong>${esc(title)}</strong>
        <small>${esc(subtitle)}</small>
      </div>
      <button id="ahBannerView" type="button">View</button>
      <button id="ahBannerDismiss" type="button" aria-label="Dismiss" style="background:transparent;padding:6px 8px"></button>
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
      <button id="ahBannerDismiss" type="button" aria-label="Dismiss" style="background:transparent;padding:6px 8px"></button>`;
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
          const alerts = activeGeoAlerts();
          const hit = alerts.find(a => alertMatches(row, a));
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
    const helpEl   = document.getElementById("alertHelp");
    const radiusRow= document.getElementById("alertRadiusRow");
    const modeBtns = Array.from(document.querySelectorAll(".am-mode"));
    const drawTools= document.getElementById("alertDrawTools");
    const areaTools= document.getElementById("alertAreaTools");
    const undoBtn  = document.getElementById("alertUndoPt");
    const clearBtn = document.getElementById("alertClearPts");
    const useAreaBtn = document.getElementById("alertUseAreaBtn");
    const areaNameEl = document.getElementById("alertAreaName");
    const addAreaBtn = document.getElementById("alertAddAreaBtn");
    const areasSummary = document.getElementById("alertAreasSummary");
    const areasListEl  = document.getElementById("alertAreasList");

    const HELP = {
      circle: "Drop a pin (search, tap the map, or GPS) and set a radius. We'll alert you about new listings inside that circle.",
      draw:   "Tap the map to drop the corners of the exact area you want — a neighbourhood, a block, your route to work. 3+ points make an area.",
      area:   "Find a place, then tap “Use this whole area” to watch its entire ward / suburb — the real administrative outline, no guessing a radius.",
    };

    // Area-mode / draw-mode state (reset each open).
    let mode = "circle";
    let drawPts = [];          // [[lng,lat], …] outline being drawn
    let drawLayer = null;      // Leaflet polygon/polyline of the outline
    let drawMarkers = [];      // vertex dots
    let lastBoundary = null;   // { geo, bbox, name } last ward/suburb found under the pin
    let areaGeo = null;        // { geo, bbox, name } the chosen whole-area shape
    let committedAreas = [];   // areas already added to THIS alert (the OR list)
    let committedLayer = null; // Leaflet layerGroup showing the committed areas
    let listingDotsLayer = null; // Leaflet layerGroup of current-listing dots
    const dotsBadge = document.getElementById("alertDotsBadge");

    backdrop.hidden = false;
    alertPicked = null;
    searchIn.value = "";
    resultsEl.hidden = true;
    resultsEl.innerHTML = "";
    nameIn.value = "";
    radiusIn.value = 1500;
    radiusLbl.textContent = "1.5 km";
    // Reset the what-do-you-want criteria to sensible defaults.
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    setVal("alertListing", "rent");
    setVal("alertType", "");
    setVal("alertBeds", "");
    setVal("alertPriceMax", "");
    setVal("alertUntil", "");
    coordsEl.textContent = "Pin not placed yet — search or tap the map";
    coordsEl.classList.remove("has-pin");
    saveBtn.disabled = true;
    // Start in circle mode with the right panels showing.
    if (helpEl) helpEl.textContent = HELP.circle;
    if (radiusRow) radiusRow.hidden = false;
    if (drawTools) drawTools.hidden = true;
    if (areaTools) areaTools.hidden = true;
    if (useAreaBtn) useAreaBtn.disabled = true;
    if (areaNameEl) areaNameEl.textContent = "Search or tap a spot to find its ward / suburb.";
    modeBtns.forEach((b) => {
      const on = b.dataset.mode === "circle";
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    committedAreas = [];
    if (addAreaBtn) addAreaBtn.disabled = true;
    if (areasListEl) { areasListEl.hidden = true; areasListEl.innerHTML = ""; }
    if (areasSummary) areasSummary.textContent = "Add one or more areas — you'll be alerted in any of them.";

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
      if (drawLayer)         { drawLayer.remove();         drawLayer         = null; }
      drawMarkers.forEach((m) => m.remove()); drawMarkers = [];
      if (committedLayer)    { committedLayer.remove();    committedLayer    = null; }
      if (listingDotsLayer)  { listingDotsLayer.remove();  listingDotsLayer  = null; }
      if (dotsBadge) dotsBadge.hidden = true;
      if (alertModalMap)     { alertModalMap.remove();     alertModalMap     = null; }
      alertPicked = null; drawPts = []; areaGeo = null; lastBoundary = null; committedAreas = [];
    };
    closeBtn.onclick = close;
    cancelBtn.onclick = close;
    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

    // ---- Mode switching: Circle / Draw area / Whole ward --------------------
    function currentAreaValid() {
      return (mode === "circle" && !!alertPicked) ||
             (mode === "draw"   && drawPts.length >= 3) ||
             (mode === "area"   && !!areaGeo);
    }
    function refreshSaveState() {
      if (addAreaBtn) addAreaBtn.disabled = !currentAreaValid();
      // Save needs at least one committed area OR a valid current one.
      saveBtn.disabled = !(committedAreas.length > 0 || currentAreaValid());
      if (areasSummary) {
        areasSummary.textContent = committedAreas.length
          ? `${committedAreas.length} area${committedAreas.length > 1 ? "s" : ""} added` +
            (currentAreaValid() ? " · this one is included too" : " · define another, or Save")
          : (currentAreaValid() ? "1 area ready — add more, or just Save" : "Add one or more areas — you'll be alerted in any of them.");
      }
      renderListingDots();   // keep the matching-dot preview in sync with every change
    }
    function setMode(m) {
      mode = m;
      modeBtns.forEach((b) => {
        const on = b.dataset.mode === m;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      if (helpEl) helpEl.textContent = HELP[m] || HELP.circle;
      radiusRow.hidden = m !== "circle";
      drawTools.hidden = m !== "draw";
      areaTools.hidden = m !== "area";
      // Show only the artifacts that belong to this mode.
      if (m !== "circle" && alertRadiusCircle) { alertRadiusCircle.remove(); alertRadiusCircle = null; }
      if (m === "circle") {
        clearDrawingLayers();
        if (alertModalMap && window.AreaBoundary) AreaBoundary.clearLeaflet(alertModalMap);
        if (alertPicked) { placePinOnMap(alertPicked.lat, alertPicked.lng); }
      } else if (m === "draw") {
        if (alertModalMap && window.AreaBoundary) AreaBoundary.clearLeaflet(alertModalMap);
        redrawDrawing();
      } else if (m === "area") {
        clearDrawingLayers();
        if (useAreaBtn) useAreaBtn.disabled = !lastBoundary;
        if (areaNameEl) areaNameEl.textContent = areaGeo
          ? "Watching: " + areaGeo.name
          : (lastBoundary ? "Found: " + lastBoundary.name + " — tap to use it" : "Search or tap a spot to find its ward / suburb.");
        const shape = (areaGeo && areaGeo.geo) || (lastBoundary && lastBoundary.geo);
        if (shape && alertModalMap && window.AreaBoundary) AreaBoundary.showOnLeaflet(alertModalMap, shape, { fit: false });
      }
      refreshSaveState();
      updateCoords();
    }
    modeBtns.forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });

    // ---- Draw mode: outline an exact area by tapping the map ----------------
    function clearDrawingLayers() {
      if (drawLayer) { drawLayer.remove(); drawLayer = null; }
      drawMarkers.forEach((m) => m.remove()); drawMarkers = [];
    }
    function redrawDrawing() {
      if (!alertModalMap) return;
      clearDrawingLayers();
      if (!drawPts.length) return;
      const latlngs = drawPts.map(([lng, lat]) => [lat, lng]);
      drawLayer = (drawPts.length >= 3
        ? L.polygon(latlngs, { color: "#0a6f4d", weight: 2, fillColor: "#0a6f4d", fillOpacity: 0.18, dashArray: "6 4" })
        : L.polyline(latlngs, { color: "#0a6f4d", weight: 2, dashArray: "6 4" })).addTo(alertModalMap);
      drawPts.forEach(([lng, lat]) =>
        drawMarkers.push(L.circleMarker([lat, lng],
          { radius: 5, color: "#fff", weight: 2, fillColor: "#0a6f4d", fillOpacity: 1 }).addTo(alertModalMap)));
    }
    function addDrawPoint(lat, lng) { drawPts.push([lng, lat]); redrawDrawing(); refreshSaveState(); updateCoords(); }
    if (undoBtn)  undoBtn.onclick  = () => { drawPts.pop(); redrawDrawing(); refreshSaveState(); updateCoords(); };
    if (clearBtn) clearBtn.onclick = () => { drawPts = []; redrawDrawing(); refreshSaveState(); updateCoords(); };

    // ---- Whole-ward mode: snap to the administrative outline under the pin ---
    if (useAreaBtn) useAreaBtn.onclick = () => {
      if (!lastBoundary) return;
      areaGeo = lastBoundary;
      if (alertModalMap && window.AreaBoundary) AreaBoundary.showOnLeaflet(alertModalMap, areaGeo.geo, { fit: true });
      if (!nameIn.value && areaGeo.name) nameIn.value = areaGeo.name;
      if (areaNameEl) areaNameEl.textContent = "Watching: " + areaGeo.name;
      refreshSaveState();
      updateCoords();
    };

    // ---- Multiple areas in one alert ---------------------------------------
    function closeRing(pts) {
      const ring = pts.map((p) => p.slice());
      const f = ring[0], l = ring[ring.length - 1];
      if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]]);
      return ring;
    }
    // Snapshot the area the user is defining right now (active mode) as an area
    // object, or null when it isn't complete yet.
    function currentArea() {
      if (mode === "circle" && alertPicked)
        return { kind: "circle", lat: alertPicked.lat, lng: alertPicked.lng,
                 radius_m: +radiusIn.value, name: alertPicked.displayName };
      if (mode === "draw" && drawPts.length >= 3 && window.pawaPoly) {
        const geo = { type: "Polygon", coordinates: [closeRing(drawPts)] };
        return { kind: "custom", geo, bbox: pawaPoly.bboxOf(geo) };
      }
      if (mode === "area" && areaGeo && window.pawaPoly)
        return { kind: "ward", geo: areaGeo.geo, bbox: areaGeo.bbox || pawaPoly.bboxOf(areaGeo.geo), name: areaGeo.name };
      return null;
    }
    function areaChipText(ar) {
      const icon = ar.kind === "circle" ? "◯" : ar.kind === "ward" ? "▦" : "✎";
      const label = ar.geo ? (ar.kind === "ward" ? "whole area" : "drawn area") : formatRadius(ar.radius_m);
      return `${icon} ${esc(ar.name || label)}`;
    }
    // Clear whatever the user just defined so they can map the next area.
    function resetCurrentArea() {
      alertPicked = null;
      if (alertRadiusCircle) { alertRadiusCircle.remove(); alertRadiusCircle = null; }
      if (alertPinMarker)    { alertPinMarker.remove();    alertPinMarker    = null; }
      drawPts = []; clearDrawingLayers();
      areaGeo = null;
      if (alertModalMap && window.AreaBoundary) AreaBoundary.clearLeaflet(alertModalMap);
      if (areaNameEl) areaNameEl.textContent = "Search or tap a spot to find its ward / suburb.";
      if (useAreaBtn) useAreaBtn.disabled = !lastBoundary;
    }
    // Draw all committed areas on the map (muted, persistent) + list as chips.
    function renderCommittedAreas() {
      if (areasListEl) {
        areasListEl.hidden = !committedAreas.length;
        areasListEl.innerHTML = committedAreas.map((ar, i) =>
          `<span class="am-area-chip">${areaChipText(ar)}<button type="button" data-i="${i}" aria-label="Remove this area">&times;</button></span>`).join("");
        areasListEl.querySelectorAll("button[data-i]").forEach((b) => {
          b.onclick = () => { committedAreas.splice(+b.dataset.i, 1); renderCommittedAreas(); refreshSaveState(); };
        });
      }
      if (!alertModalMap) return;
      if (committedLayer) { committedLayer.remove(); committedLayer = null; }
      if (!committedAreas.length) return;
      committedLayer = L.layerGroup().addTo(alertModalMap);
      const style = { color: "#0a6f4d", weight: 2, opacity: .7, fillColor: "#0a6f4d", fillOpacity: .1, dashArray: "4 5" };
      committedAreas.forEach((ar) => {
        if (ar.geo) L.geoJSON({ type: "Feature", geometry: ar.geo }, { style, interactive: false }).addTo(committedLayer);
        else if (ar.radius_m) L.circle([ar.lat, ar.lng], { radius: ar.radius_m, interactive: false, ...style }).addTo(committedLayer);
      });
    }
    if (addAreaBtn) addAreaBtn.onclick = () => {
      const ar = currentArea();
      if (!ar) return;
      committedAreas.push(ar);
      resetCurrentArea();
      renderCommittedAreas();
      refreshSaveState();
      updateCoords();
    };

    // ---- Live preview: show current listings as dots on the map ------------
    // All listings appear as faint dots; the ones the alert-in-progress would
    // catch (inside ANY chosen area AND matching the criteria) light up solid,
    // so the user sees how much supply their area + filters actually capture.
    function previewAreas() {
      const a = committedAreas.slice();
      const p = currentArea();
      if (p) a.push(p);
      return a;
    }
    function previewAlert() {
      return {
        areas: previewAreas(),
        listing:   document.getElementById("alertListing")?.value || "",
        type:      document.getElementById("alertType")?.value || "",
        beds:      +(document.getElementById("alertBeds")?.value || 0) || 0,
        price_max: parseTzsValue(document.getElementById("alertPriceMax")?.value),
        // no `until` in preview — date only silences future firing, not "matches now"
      };
    }
    const DOT_MATCH = { radius: 6, color: "#fff", weight: 2, fillColor: "#0a6f4d", fillOpacity: 1 };
    const DOT_OTHER = { radius: 3, color: "#0a6f4d", weight: 1, opacity: .4, fillColor: "#0a6f4d", fillOpacity: .22, interactive: false };
    const MAX_OTHER_DOTS = 500;   // cap faint dots so dense cities stay smooth
    function renderListingDots() {
      if (!alertModalMap) return;
      if (listingDotsLayer) { listingDotsLayer.remove(); listingDotsLayer = null; }
      const valid = (Array.isArray(houses) ? houses : [])
        .filter((h) => Number.isFinite(+h.lat) && Number.isFinite(+h.lng));
      listingDotsLayer = L.layerGroup().addTo(alertModalMap);
      const preview = previewAlert();
      const hasArea = preview.areas.length > 0;
      const matching = [], others = [];
      for (const h of valid) {
        if (hasArea && alertMatches(h, preview)) matching.push(h); else others.push(h);
      }
      const addDot = (h, style) => {
        const d = L.circleMarker([+h.lat, +h.lng], style);
        if (style === DOT_MATCH) d.bindPopup(`<strong>${esc(h.title || "Listing")}</strong>` +
          (h.price_tzs ? `<br>${esc(shortTzs(+h.price_tzs))} TZS` : ""));
        d.addTo(listingDotsLayer);
      };
      others.slice(0, MAX_OTHER_DOTS).forEach((h) => addDot(h, DOT_OTHER));
      matching.forEach((h) => addDot(h, DOT_MATCH));     // drawn last → on top
      if (dotsBadge) {
        if (!valid.length) { dotsBadge.hidden = true; }
        else {
          dotsBadge.hidden = false;
          dotsBadge.textContent = hasArea
            ? `${matching.length} of ${valid.length} listings match`
            : `${valid.length} listings nearby — choose an area to filter`;
        }
      }
    }
    // Re-light the dots when criteria change (areas/pin changes already refresh
    // via refreshSaveState → renderListingDots).
    ["alertListing", "alertType", "alertBeds", "alertPriceMax"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.oninput = renderListingDots;
    });

    // Radius slider — update label, redraw circle, refresh coords text
    radiusIn.oninput = () => {
      const m = +radiusIn.value;
      radiusLbl.textContent = formatRadius(m);
      updateCoords();
      drawRadiusCircle();
      renderListingDots();   // a bigger/smaller circle catches different listings
    };

    // GPS button
    gpsBtn.onclick = async () => {
      gpsBtn.disabled = true; gpsBtn.textContent = " Locating…";
      try {
        const fix = await pawaLocate.best({ targetAccuracy: 20,
          onProgress: (f) => setPin(f.lat, f.lng, "My current location") });
        setPin(fix.lat, fix.lng, "My current location");
      } catch (err) {
        alert(pawaLocate.message(err));
      } finally {
        gpsBtn.disabled = false; gpsBtn.textContent = " GPS";
      }
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
      // Known places (universities, hospitals, malls, airports…) resolve
      // instantly from the gazetteer and float to the top of the results, so
      // "UDSM" or "Mlimani City" drops the pin exactly on the spot. Below them
      // we list every matching village / ward / district / area in the country.
      const combined = [];
      const known = window.resolveTzPlace && window.resolveTzPlace(q);
      if (known) combined.push({ name: known.name, tag: "Known place", context: "", lat: known.lat, lng: known.lng, _known: true });
      try {
        const hits = await pawaGeo.suggest(q, { limit: 25 });
        for (const h of hits) {
          if (combined.some(c => c.name === h.name && c.context === h.context)) continue;
          combined.push(h);
        }
      } catch (e) {
        if (!combined.length) { resultsEl.innerHTML = `<div class="am-search-result loading">Search failed: ${esc(e.message)}</div>`; return; }
      }
      if (!combined.length) { resultsEl.innerHTML = `<div class="am-search-result loading">No matches in Tanzania.</div>`; return; }
      resultsEl.innerHTML = combined.map((it, i) =>
        `<div class="am-search-result" data-i="${i}">
          <strong>${esc(it.name)}</strong> <span class="am-tag${it._known ? " known" : ""}">${esc(it.tag || "Place")}</span>
          ${it.context ? `<small>${esc(it.context)}</small>` : ""}
        </div>`).join("");
      resultsEl.querySelectorAll(".am-search-result[data-i]").forEach(div => {
        div.addEventListener("click", () => {
          const it = combined[+div.dataset.i];
          if (!it) return;
          setPin(it.lat, it.lng, it.name);
          resultsEl.hidden = true;
          searchIn.value = it.name;
        });
      });
    }

    // Save — one alert can hold several areas (the OR list): everything already
    // added, plus the area being defined right now if it's complete.
    saveBtn.onclick = async () => {
      const areas = committedAreas.slice();
      const pend = currentArea();
      if (pend) areas.push(pend);
      if (!areas.length) return;

      if ("Notification" in window && Notification.permission === "default") {
        try { await Notification.requestPermission(); } catch (_) {}
      }
      // Representative centre (first area) for "X km from your area" text + sorting.
      const c0 = (areas[0].geo && window.pawaPoly)
        ? pawaPoly.centroidOf(areas[0].geo)
        : { lat: areas[0].lat, lng: areas[0].lng };
      const defaultName = areas.length > 1
        ? `${areas.length} areas`
        : (areas[0].name || areaOneLabel(areas[0]));

      const alerts = getGeoAlerts();
      const newAlert = {
        id: "ga-" + Date.now().toString(36),
        name: (nameIn.value.trim() || defaultName || "Watched area").slice(0, 60),
        lat: c0 ? c0.lat : null,
        lng: c0 ? c0.lng : null,
        areas,            // [{ kind, geo?, bbox?, lat?, lng?, radius_m?, name? }, …]
        // What exactly the user wants — wrong type/price never notifies.
        listing:   document.getElementById("alertListing")?.value || "",
        type:      document.getElementById("alertType")?.value || "",
        beds:      +(document.getElementById("alertBeds")?.value || 0) || 0,
        price_max: parseTzsValue(document.getElementById("alertPriceMax")?.value),
        until:     document.getElementById("alertUntil")?.value || "",
        createdAt: new Date().toISOString()
      };
      alerts.push(newAlert);
      saveGeoAlerts(alerts);
      const seen = getSeenIds();
      houses.forEach(h => seen.add(h.id));
      saveSeenIds(seen);
      renderWatchChips();
      const where = areas.length > 1
        ? `in any of your ${areas.length} areas`
        : (areas[0].geo
            ? (areas[0].kind === "ward" ? `anywhere in ${newAlert.name}` : "anywhere inside your drawn area")
            : `within ${formatRadius(areas[0].radius_m)} of this spot`);
      flashBanner("", `Alert saved: ${newAlert.name}`,
        `We'll notify you about ${alertCriteriaText(newAlert) || "new listings"} ${where}.`);
      close();
    };

    // ---- setPin -------------------------------------------------------
    // Always update coords + enable Save immediately (map may still be
    // loading). The marker + circle are deferred to placePinOnMap which
    // is called once the map is ready.
    function setPin(lat, lng, displayName) {
      alertPicked = { lat, lng, displayName: displayName || "Selected location" };
      updateCoords();
      refreshSaveState();   // circle: enables Save; area: stays gated on "Use this whole area"
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
          updateAlertBoundary(ll.lat, ll.lng);
        });
      } else {
        alertPinMarker.setLatLng([lat, lng]);
      }
      alertModalMap.setView([lat, lng], Math.max(alertModalMap.getZoom(), 14));
      drawRadiusCircle();
      updateAlertBoundary(lat, lng);
    }

    // Shade the administrative area the dropped pin falls within, so the user
    // sees exactly which ward/suburb their watched area covers. No-ops without
    // the gateway/boundary module; the pin + radius work regardless.
    async function updateAlertBoundary(lat, lng) {
      if (!alertModalMap || !window.AreaBoundary || !window.pawaGeo || !pawaGeo.boundary) return;
      const b = await pawaGeo.boundary({ lat, lng });
      if (!alertModalMap) return;   // modal closed while we were fetching
      if (b && AreaBoundary.isAreal(b.geojson)) {
        // Capture it so "Whole ward" mode can snap the alert to this outline.
        lastBoundary = {
          geo: b.geojson,
          bbox: b.bbox || (window.pawaPoly ? pawaPoly.bboxOf(b.geojson) : null),
          name: b.name || "this area",
        };
        if (mode !== "draw") AreaBoundary.showOnLeaflet(alertModalMap, b.geojson, { fit: false });
        if (useAreaBtn) useAreaBtn.disabled = false;
        if (areaNameEl && mode === "area" && !areaGeo) areaNameEl.textContent = "Found: " + lastBoundary.name + " — tap to use it";
        if (mode === "area") updateCoords();
      } else {
        lastBoundary = null;
        AreaBoundary.clearLeaflet(alertModalMap);
        if (useAreaBtn) useAreaBtn.disabled = true;
        if (areaNameEl && mode === "area") areaNameEl.textContent = "No ward outline here — try a nearby spot.";
      }
    }

    function updateCoords() {
      if (mode === "draw") {
        if (!drawPts.length) { coordsEl.classList.remove("has-pin"); coordsEl.textContent = "Tap the map to outline your area"; return; }
        coordsEl.classList.add("has-pin");
        coordsEl.textContent = drawPts.length < 3
          ? `${drawPts.length} point${drawPts.length === 1 ? "" : "s"} — add ${3 - drawPts.length} more to close the area`
          : `${drawPts.length}-point area outlined`;
        return;
      }
      if (mode === "area") {
        if (areaGeo) { coordsEl.classList.add("has-pin"); coordsEl.textContent = `Watching all of ${areaGeo.name}`; }
        else { coordsEl.classList.remove("has-pin"); coordsEl.textContent = lastBoundary ? 'Tap "Use this whole area"' : "Find a ward / suburb first"; }
        return;
      }
      if (!alertPicked) return;
      coordsEl.classList.add("has-pin");
      coordsEl.textContent = ` ${alertPicked.lat.toFixed(5)}, ${alertPicked.lng.toFixed(5)}  ·  radius ${formatRadius(+radiusIn.value)}`;
    }

    // ---- drawRadiusCircle (Leaflet L.circle) -------------------------
    function drawRadiusCircle() {
      if (mode !== "circle") { if (alertRadiusCircle) { alertRadiusCircle.remove(); alertRadiusCircle = null; } return; }
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
        // Satellite + crisp street-name labels, with a Map/Satellite toggle so
        // the user can switch to a plain street map and read road names clearly
        // when choosing the area to be alerted about.
        window.addSatelliteHybrid(alertModalMap);
        L.control.zoom({ position: "topright" }).addTo(alertModalMap);
        alertModalMap.on("click", (e) => {
          if (mode === "draw") addDrawPoint(e.latlng.lat, e.latlng.lng);
          else setPin(e.latlng.lat, e.latlng.lng, null);   // circle + area both drop a locating pin
        });
        // Force layout recalc after Leaflet renders its tiles
        alertModalMap.whenReady(() => { alertModalMap.invalidateSize(); renderListingDots(); });
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
  //  Smart search — parse a plain-language query into structured criteria,
  //  reflect it into the dropdown filters, then rank results by match score.
  // ====================================================================
  const AMENITY_SYNONYMS = {
    parking:                ["parking", "garage", "car park"],
    security:               ["security", "guard", "gated", "24h", "24 hour"],
    water_tank:             ["water tank", "water storage"],
    borehole:               ["borehole", "well", "kisima"],
    generator:              ["generator", "backup power", "genset", "standby power"],
    wifi:                   ["wifi", "wi-fi", "internet", "fibre", "fiber"],
    pool:                   ["pool", "swimming"],
    gym:                    ["gym", "fitness"],
    garden:                 ["garden", "yard", "lawn"],
    elevator:               ["elevator", "lift"],
    water_connection:       ["water connection", "piped water", "city water", "maji"],
    electricity_connection: ["electricity", "power", "umeme"]
  };
  function amenityLabel(k) {
    return ({ parking:"Parking", security:"Security", water_tank:"Water tank",
      borehole:"Borehole", generator:"Generator", wifi:"Wi-Fi", pool:"Pool",
      gym:"Gym", garden:"Garden", elevator:"Elevator",
      water_connection:"Water", electricity_connection:"Electricity" })[k] || k;
  }
  function parseMoney(numStr, suffix) {
    let n = parseFloat(String(numStr).replace(/[,\s]/g, ""));
    if (!isFinite(n)) return null;
    const s = (suffix || "").toLowerCase();
    if (/^b/.test(s)) n *= 1e9;
    else if (/^m/.test(s)) n *= 1e6;
    else if (/^k/.test(s) || /thousand/.test(s)) n *= 1e3;
    return Math.round(n);
  }
  function shortTzs(p) {
    if (p >= 1e9) return (p/1e9).toFixed(p % 1e9 ? 1 : 0) + "B";
    if (p >= 1e6) return (p/1e6).toFixed(p % 1e6 ? 1 : 0) + "M";
    if (p >= 1e3) return (p/1e3).toFixed(0) + "k";
    return String(p);
  }

  // Parse a free-typed budget phrase into { priceMin, priceMax } in TZS, so a
  // user can filter by writing their own words instead of picking a bucket:
  //   "900k"            → max 900,000
  //   "under 2m"        → max 2,000,000      "over 500k" → min 500,000
  //   "min 1m max 3m"   → 1,000,000 – 3,000,000
  //   "500k - 1.5m"     → 500,000 – 1,500,000   ("to" works too)
  // Shared by the budget filter box and the smart natural-language search.
  // Longest suffixes first + a "not followed by a letter" guard so the "b" in
  // "bedroom" (or "m" in "modern") is never read as billions/millions.
  const MONEY_RE = "([\\d][\\d.,]*)\\s*(billion|bn|b|million|mil|m|thousand|k)?(?![a-z])";
  function parsePriceText(raw) {
    const text = " " + String(raw || "").toLowerCase().replace(/\s+/g, " ") + " ";
    const out = { priceMin: null, priceMax: null };
    let m;
    if ((m = text.match(new RegExp("(?:under|below|max|up to|upto|less than|within|maximum of?|budget of?)\\s*(?:tzs|tsh|sh)?\\s*" + MONEY_RE)))) out.priceMax = parseMoney(m[1], m[2]);
    if ((m = text.match(new RegExp("(?:over|above|from|min|at least|minimum of?|starting at)\\s*(?:tzs|tsh|sh)?\\s*" + MONEY_RE)))) out.priceMin = parseMoney(m[1], m[2]);
    // Range "a - b" / "a to b" when no explicit bound word was found.
    if (out.priceMin == null && out.priceMax == null) {
      const r = text.match(new RegExp(MONEY_RE + "\\s*(?:-|–|—|to)\\s*" + MONEY_RE));
      if (r) {
        const a = parseMoney(r[1], r[2]), b = parseMoney(r[3], r[4]);
        if (a != null && b != null) { out.priceMin = Math.min(a, b); out.priceMax = Math.max(a, b); }
      }
    }
    // Bare figure → treat as a budget ceiling. Skip small unsuffixed integers so
    // a stray "3" (bedrooms) never becomes a price.
    if (out.priceMin == null && out.priceMax == null) {
      for (const a of text.matchAll(new RegExp(MONEY_RE, "g"))) {
        const sfx = (a[2] || "").toLowerCase(), val = parseMoney(a[1], a[2]);
        if (val != null && (sfx || val >= 50000)) { out.priceMax = val; break; }
      }
    }
    return out;
  }

  function setupSmartSearch() {
    if (!ssForm) return;
    ssForm.addEventListener("submit", (e) => { e.preventDefault(); runSmartSearch(ssInput.value); });
    ssExamples?.querySelectorAll(".ss-ex").forEach(btn => {
      btn.addEventListener("click", () => { ssInput.value = btn.dataset.q; runSmartSearch(btn.dataset.q); });
    });
  }

  function runSmartSearch(text) {
    const q = (text || "").trim();
    if (!q) { clearSmartSearch(); return; }
    smartAiNote = null;                       // reset any prior AI confirmation
    // Instant regex baseline — the page reacts immediately, even offline or
    // before (or without) the AI brain. The AI pass below upgrades it.
    smartCriteria = parseSmartQuery(q);
    applySmartCriteria(smartCriteria);
    if (ssExamples) ssExamples.hidden = true;
    document.getElementById("housesStage")?.scrollIntoView({ behavior: "smooth", block: "start" });

    // Known-place anchoring (async): if the query names a university, hospital,
    // mall, airport, etc., drop a precise pin on it and rank listings by how
    // close they are to that place.
    maybeAnchorLandmark(q);

    // AI upgrade (async, no-op unless the ai-search Edge Function + key are
    // configured): replaces the regex criteria with Claude's richer reading.
    enhanceSmartSearchWithAI(q);
  }

  // Reflect a criteria object into the dropdowns + chips and re-rank. Shared by
  // the regex baseline and the AI pass so both render identically.
  function applySmartCriteria(c) {
    // A commercial type lands in Business; otherwise the listing word picks the
    // residential segment. setSegment reshapes the Type dropdown to match.
    const seg = isBusinessType(c.type) ? "business"
              : c.listing === "sale" ? "sale"
              : c.listing === "rent" ? "rent" : "all";
    setSegment(seg, { silent: true });
    if (seg === "business") {
      fListing.value = c.listing || "";
      document.getElementById("hpBizRefine")?.querySelectorAll(".hp-biz-chip")
        .forEach(ch => ch.classList.toggle("active", (ch.dataset.listing || "") === (fListing.value || "")));
    }
    fType.value = typesForSegment(seg).includes(c.type) ? (c.type || "") : "";
    fArea.value = c.area || "";   // free-text box — just drop the parsed area in
    if (c.bedrooms) {
      const b = String(Math.min(4, c.bedrooms));
      fBeds.value = Array.from(fBeds.options).some(o => o.value === b) ? b : "";
    } else fBeds.value = "";
    if (fRoom) fRoom.value = c.roomKind || "";
    // The bucketed price <select> can't express an arbitrary budget, so leave
    // it on "any"; the numeric cap lives in smartCriteria and is applied later.
    fPrice.value = "";
    if (fSearch) fSearch.value = "";   // the little text box is now redundant
    renderSmartChips();
    apply();
  }

  // Ask the AI brain (ai-search Edge Function) to parse the query, then adopt
  // its result if it's still the active query. Silently does nothing when the
  // endpoint/key isn't set, the call fails, or the query turned out to be a
  // ride — so the regex baseline always stands as the safety net.
  async function enhanceSmartSearchWithAI(q) {
    if (!window.AISearch || !AISearch.available()) return;
    let res;
    try {
      res = await AISearch.parseHouse(q, {
        origin: userLoc || null,
        areas,
        lang: window.getLang?.() || null,
      });
    } catch (_) { return; }
    if (!res) return;
    // The user may have typed a new query while we waited — don't clobber it.
    if ((ssInput?.value || "").trim() !== q) return;
    if (res.domain === "ride") return;        // not a housing query → keep regex result

    smartCriteria = res.criteria;
    smartAiNote = (res.answer || "").trim() || null;
    applySmartCriteria(smartCriteria);

    // The AI's anchor wins over the regex one: an explicit place, or the
    // device's GPS when the user said "near me".
    if (res.anchor) {
      if (res.anchor.name === "__me__") nearBtn?.click();
      else anchorByName(res.anchor.name);
    }
  }

  // Geocode an explicit place name (gazetteer first, OSM second) and anchor the
  // map on it — the AI-driven twin of maybeAnchorLandmark()'s phrase logic.
  async function anchorByName(name) {
    const phrase = (name || "").trim();
    if (phrase.length < 3) return;
    const local = (window.resolveTzPlace && window.resolveTzPlace(phrase)) || null;
    if (local) setLandmark({ lat: local.lat, lng: local.lng, name: local.name });
    const remote = await geocodePlace(phrase);
    if (remote && (!local || distKm(local, remote) <= 40)) {
      setLandmark({ lat: remote.lat, lng: remote.lng, name: local ? local.name : remote.name });
    }
  }

  // ====================================================================
  //  Known-place anchoring
  //  Resolve a landmark from the query (gazetteer first for instant,
  //  reliable pins; OSM/Nominatim second to refine to the exact site),
  //  drop a distinct pin on the map, and switch ranking to "nearest to
  //  that place first". Distances use the haversine great-circle formula.
  // ====================================================================
  function extractPlacePhrase(raw) {
    const m = String(raw || "").match(/\b(?:near|nearby|close to|next to|around|beside|by|opposite|adjacent to|at)\s+(.+)$/i);
    return (m ? m[1] : raw || "").trim();
  }

  // Should we even try? Yes if the user wrote "near <x>", or typed a bare
  // place name (no property criteria parsed), or the gazetteer already
  // recognises a place inside the query.
  function shouldAnchor(q, c) {
    if (/\b(near|nearby|close to|next to|around|beside|opposite|adjacent to)\b/i.test(q)) return true;
    const bare = !c.listing && !c.type && c.bedrooms == null && c.bathrooms == null &&
                 c.priceMax == null && c.priceMin == null && !c.area &&
                 !(c.amenities || []).length && !(c.keywords || []).length;
    if (bare) return true;
    return !!(window.resolveTzPlace && window.resolveTzPlace(extractPlacePhrase(q)));
  }

  // Geocode a place phrase via Nominatim (TZ-only). Returns {lat,lng,name}
  // or null. Validated against Tanzania's bounding box so a stray match in
  // another country never anchors the map.
  async function geocodePlace(phrase) {
    const q = (phrase || "").trim();
    if (q.length < 3) return null;
    try {
      const list = await pawaGeo.search(`format=json&limit=1&countrycodes=tz&q=${encodeURIComponent(q)}`);
      const it = list && list[0];
      if (!it) return null;
      const lat = +it.lat, lng = +it.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      if (lat < -11.75 || lat > -0.99 || lng < 29.34 || lng > 40.45) return null;  // outside TZ
      return { lat, lng, name: (it.display_name || q).split(",").slice(0, 2).join(", ") };
    } catch (_) { return null; }
  }

  async function maybeAnchorLandmark(rawQuery) {
    const c = smartCriteria || {};
    if (!shouldAnchor(rawQuery, c)) { clearLandmark(); return; }

    const phrase = extractPlacePhrase(rawQuery);
    const local  = (window.resolveTzPlace && (window.resolveTzPlace(phrase) || window.resolveTzPlace(rawQuery))) || null;

    // Show the gazetteer pin immediately (fast, offline-safe) if we have one.
    if (local) setLandmark({ lat: local.lat, lng: local.lng, name: local.name });

    // Then refine to the precise OSM coordinates. Only accept the remote
    // result if it's within ~40 km of the gazetteer guess (sanity check),
    // or if we had no gazetteer guess at all.
    const remote = await geocodePlace(phrase);
    if (remote) {
      if (!local || distKm(local, remote) <= 40) {
        setLandmark({ lat: remote.lat, lng: remote.lng, name: local ? local.name : remote.name });
      }
    } else if (!local) {
      clearLandmark();
    }
  }

  function setLandmark(loc) {
    landmarkLoc = loc;
    ensureLandmarkStyles();
    if (map) {
      if (!landmarkMarker) {
        const el = document.createElement("div");
        el.className = "landmark-marker";
        el.innerHTML = `<span class="lm-pin"></span><span class="lm-label"></span>`;
        landmarkMarker = new maplibregl.Marker({ element: el, anchor: "bottom" })
          .setLngLat([loc.lng, loc.lat]).addTo(map);
      } else {
        landmarkMarker.setLngLat([loc.lng, loc.lat]);
      }
      landmarkMarker.getElement().querySelector(".lm-label").textContent = loc.name;
    }
    renderSmartChips();
    updateLandmarkInfo();
    apply();   // re-rank by distance to the landmark
    drawAreaBoundary(loc);   // shade the actual area this place sits within
  }

  function clearLandmark() {
    if (!landmarkLoc && !landmarkMarker) return;
    landmarkLoc = null;
    if (landmarkMarker) { landmarkMarker.remove(); landmarkMarker = null; }
    if (map && window.AreaBoundary) AreaBoundary.clearMapLibre(map);
    boundaryKey = null;
    const info = document.getElementById("housesAlertBanner");
    if (info && info.dataset.kind === "landmark") info.hidden = true;
  }

  // Fetch + shade the administrative outline of the area a landmark falls in.
  // Tries the named area's own polygon first (most precise for "Mikocheni"),
  // then the area enclosing the point (best for a POI like a university).
  // No-ops cleanly when the gateway, the boundary module, or a polygon is
  // unavailable — the pin still works without an outline.
  let boundaryKey = null;
  async function drawAreaBoundary(loc) {
    if (!map || !window.AreaBoundary || !window.pawaGeo || !pawaGeo.boundary) return;
    const key = `${landmarkShort(loc.name)}|${loc.lat.toFixed(3)},${loc.lng.toFixed(3)}`;
    if (key === boundaryKey) return;      // same area already drawn
    boundaryKey = key;
    let b = null;
    if (loc.name) b = await pawaGeo.boundary({ q: landmarkShort(loc.name) });
    if (!(b && AreaBoundary.isAreal(b.geojson)) && Number.isFinite(loc.lat)) {
      b = await pawaGeo.boundary({ lat: loc.lat, lng: loc.lng });
    }
    if (boundaryKey !== key) return;      // a newer search superseded this one
    if (b && AreaBoundary.isAreal(b.geojson)) {
      AreaBoundary.showOnMapLibre(map, b.geojson, { bbox: b.bbox, fit: true });
    } else {
      AreaBoundary.clearMapLibre(map);
    }
  }

  function landmarkShort(name) {
    return String(name || "").split(",")[0].trim();
  }

  function updateLandmarkInfo() {
    if (!landmarkLoc) return;
    const name = landmarkShort(landmarkLoc.name);
    const body = userLoc
      ? `Your location is ${distKm(userLoc, landmarkLoc).toFixed(1)} km from ${name} · listings below are sorted nearest-first`
      : `Tap “Near me” to measure how far ${name} is from where you live · listings below are sorted nearest-first`;
    alertBanner.innerHTML = `
      <span class="ab-icon"></span>
      <div class="ab-body">
        <strong>${esc(name)}</strong>
        <small>${esc(body)}</small>
      </div>
      <button id="lmBannerDismiss" type="button" aria-label="Dismiss" style="background:transparent;padding:6px 8px"></button>`;
    alertBanner.hidden = false;
    alertBanner.dataset.kind = "landmark";
    document.getElementById("lmBannerDismiss")?.addEventListener("click", () => { alertBanner.hidden = true; });
  }

  function ensureLandmarkStyles() {
    if (document.getElementById("lmMarkerStyles")) return;
    const s = document.createElement("style");
    s.id = "lmMarkerStyles";
    s.textContent = `
      .landmark-marker{display:flex;align-items:center;gap:4px;transform:translateY(2px);pointer-events:none}
      .landmark-marker .lm-pin{font-size:26px;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
      .landmark-marker .lm-label{background:#0a6f4d;color:#fff;font:600 11px/1.2 system-ui,sans-serif;
        padding:3px 7px;border-radius:999px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.3);max-width:160px;
        overflow:hidden;text-overflow:ellipsis}`;
    document.head.appendChild(s);
  }

  function clearSmartSearch() {
    smartCriteria = null;
    smartAiNote = null;
    matchScores.clear();
    clearLandmark();
    if (ssInput) ssInput.value = "";
    if (ssChips) { ssChips.hidden = true; ssChips.innerHTML = ""; }
    if (ssExamples) ssExamples.hidden = false;
    [fListing, fType, fArea, fBeds, fPrice].forEach(el => { if (el) el.value = ""; });
    setSegment("all", { silent: true });
    apply();
  }

  function renderSmartChips() {
    if (!ssChips || !smartCriteria) return;
    const c = smartCriteria, chips = [];
    if (smartAiNote) chips.push(` ${smartAiNote}`);
    if (landmarkLoc) chips.push(` near ${landmarkShort(landmarkLoc.name)}`);
    if (c.listing)   chips.push(c.listing === "sale" ? "For sale" : "For rent");
    if (c.type)      chips.push(({ apartment:"Apartment", house:"House", plot:"Plot", office:"Office", shop:"Shop/business" })[c.type] || c.type);
    if (c.bedrooms)  chips.push(`${c.bedrooms}+ bed`);
    if (c.bathrooms) chips.push(`${c.bathrooms}+ bath`);
    if (c.roomKind)  chips.push(c.roomKind === "master" ? "Master room" : "Single room");
    if (c.area)      chips.push(` ${c.area}`);
    if (c.priceMax)  chips.push(`≤ ${shortTzs(c.priceMax)} TZS`);
    if (c.priceMin)  chips.push(`≥ ${shortTzs(c.priceMin)} TZS`);
    (c.amenities || []).forEach(a => chips.push(amenityLabel(a)));
    (c.keywords  || []).forEach(k => chips.push(`"${k}"`));
    ssChips.innerHTML =
      chips.filter(Boolean).map(t => `<span class="ss-chip">${esc(t)}</span>`).join("") +
      `<span class="ss-chip ss-chip-clear" id="ssClear">Clear </span>`;
    ssChips.hidden = false;
    document.getElementById("ssClear")?.addEventListener("click", clearSmartSearch);
  }

  function parseSmartQuery(raw) {
    const text = " " + raw.toLowerCase().replace(/\s+/g, " ") + " ";
    const c = { listing:null, type:null, bedrooms:null, bathrooms:null,
                area:null, priceMax:null, priceMin:null, roomKind:null, amenities:[], keywords:[] };

    // Room category — "master"/"self-contained" vs a plain "single room".
    if (/\b(master|self[-\s]?contained|self\s?contain|en[-\s]?suite)\b/.test(text)) c.roomKind = "master";
    else if (/\bsingle\s*room\b|\bchumba\s*kimoja\b/.test(text)) c.roomKind = "single";

    if (/\b(for sale|to buy|buying|purchase|sale)\b/.test(text)) c.listing = "sale";
    else if (/\b(for rent|to rent|renting|rental|rent|lease)\b/.test(text)) c.listing = "rent";

    if (/\b(apartment|apartments|flat|condo)\b/.test(text)) c.type = "apartment";
    else if (/\b(house|villa|bungalow|home|nyumba)\b/.test(text)) c.type = "house";
    else if (/\b(plot|land|kiwanja|shamba)\b/.test(text)) c.type = "plot";
    else if (/\b(shop|commercial|retail|duka|biashara|stall|frame|kibanda)\b/.test(text)) c.type = "shop";
    else if (/\b(office|ofisi)\b/.test(text)) c.type = "office";

    let m = text.match(/(\d+)\s*(?:\+\s*)?(?:bed|bedroom|bedrooms|br|bdr|chumba|vyumba)\b/);
    if (m) c.bedrooms = parseInt(m[1], 10);
    if (/\bstudio\b/.test(text)) { c.type = c.type || "apartment"; if (c.bedrooms == null) c.bedrooms = 0; }
    m = text.match(/(\d+)\s*(?:bath|bathroom|bathrooms|ba)\b/);
    if (m) c.bathrooms = parseInt(m[1], 10);

    // Price — ceilings / floors / ranges, via the shared budget parser.
    const pp = parsePriceText(raw);
    c.priceMax = pp.priceMax;
    c.priceMin = pp.priceMin;

    // Area — match against the real area list from the data (longest wins).
    let bestArea = null;
    for (const a of areas) {
      if (a && text.includes(" " + a.toLowerCase())) {
        if (!bestArea || a.length > bestArea.length) bestArea = a;
      }
    }
    if (bestArea) c.area = bestArea;

    for (const [key, syns] of Object.entries(AMENITY_SYNONYMS)) {
      if (syns.some(s => text.includes(s))) c.amenities.push(key);
    }

    const KW = ["sea view", "ocean view", "beachfront", "modern", "spacious",
      "luxury", "quiet", "furnished", "unfurnished", "penthouse", "duplex",
      "ensuite", "balcony", "tarmac", "gated", "newly built"];
    for (const k of KW) if (text.includes(k) && !c.amenities.includes(k)) c.keywords.push(k);

    return c;
  }

  function scoreHouse(h, c) {
    let score = 0, max = 0;
    const has = (v) => v != null && v !== "";
    if (has(c.area)) {
      max += 30;
      const hay = `${h.area || ""} ${h.address || ""} ${h.region || ""}`.toLowerCase();
      if (hay.includes(c.area.toLowerCase())) score += 30;
    }
    if (has(c.type))     { max += 18; if (h.type === c.type) score += 18; }
    if (has(c.listing))  { max += 14; if (h.listing === c.listing) score += 14; }
    if (has(c.bedrooms)) { max += 20; const b = h.bedrooms || 0;
      if (b >= c.bedrooms) score += 20; else if (b === c.bedrooms - 1) score += 10; }
    if (has(c.bathrooms)){ max += 8;  if ((h.bathrooms || 0) >= c.bathrooms) score += 8; }
    if (has(c.priceMax)) { max += 25; const p = h.price_tzs || 0;
      if (p <= c.priceMax) score += (p <= c.priceMax * 0.85 ? 25 : 20);
      else if (p <= c.priceMax * 1.1) score += 8; }
    if (has(c.priceMin)) { max += 6;  if ((h.price_tzs || 0) >= c.priceMin) score += 6; }
    if (c.amenities?.length) {
      const am = (h.amenities || []).map(x => String(x).toLowerCase());
      for (const a of c.amenities) {
        max += 8;
        if (am.some(x => x.includes(a) || x.includes(amenityLabel(a).toLowerCase()))) score += 8;
      }
    }
    if (c.keywords?.length) {
      const hay = `${h.title || ""} ${h.description || ""} ${h.furnished || ""}`.toLowerCase();
      for (const k of c.keywords) { max += 5; if (hay.includes(k)) score += 5; }
    }
    return max ? Math.round((score / max) * 100) : 100;
  }

  // ====================================================================
  //  "Match to my life" — personalised distance / commute matching
  //
  //  The user lists the places that matter to them (workplace, a child's
  //  school, a favourite area). For every listing we estimate, per place:
  //    road_km  = haversine(listing, place) × DETOUR  (straight-line → road)
  //    minutes  = road_km / mode_speed × 60           (per transport mode)
  //  A listing is kept only if it satisfies every place's max-time limit
  //  (when one is set), and the list is ranked by the *total* estimated
  //  travel time across all places — i.e. the home that fits your life best
  //  sits at the top. Everything runs client-side (no routing API needed).
  //  (MODES / PLACE_KINDS / ROAD_DETOUR are declared near the top of the file.)
  // ====================================================================
  function getMyPlaces() {
    try { return JSON.parse(localStorage.getItem("pawa_house_my_places") || "[]"); }
    catch { return []; }
  }
  function saveMyPlaces(arr) {
    // A place may have moved (re-pinned) while keeping its id, so any cached
    // road legs are now stale — drop them; they refill from the new coords.
    commuteRoadKm.clear();
    localStorage.setItem("pawa_house_my_places", JSON.stringify(arr));
  }
  function modeOf(m)  { return MODES[m] || MODES.car; }
  function kindOf(k)  { return PLACE_KINDS[k] || PLACE_KINDS.custom; }
  function roadKm(a, b) { return distKm(a, b) * ROAD_DETOUR; }
  function travelMin(km, mode) { return km / modeOf(mode).kmh * 60; }
  function fmtMin(min) {
    if (min < 1) return "<1 min";
    if (min < 60) return Math.round(min) + " min";
    const h = Math.floor(min / 60), mm = Math.round(min % 60);
    return mm ? `${h}h ${mm}m` : `${h}h`;
  }

  // Per-listing commute breakdown, or null when it can't be evaluated. Uses the
  // REAL road distance per leg once enrichCommuteRoad() has fetched it; until
  // then (or if routing is down) it falls back to the straight-line × detour
  // estimate so the feature always works offline.
  function commuteFor(h) {
    if (!myPlaces.length || !Number.isFinite(h.lat) || !Number.isFinite(h.lng)) return null;
    const legs = myPlaces.map(p => {
      const real = commuteRoadKm.get(p.id + "|" + h.id);
      const road = Number.isFinite(real);
      const km = road ? real : roadKm(p, h);
      const min = travelMin(km, p.mode);
      return { place: p, km, min, road, ok: p.maxMin ? min <= p.maxMin : true };
    });
    return { legs, total: legs.reduce((s, l) => s + l.min, 0), pass: legs.every(l => l.ok) };
  }

  // Background: fill in the real road distance for each place→listing leg via the
  // shared, cached, fail-over OSRM table, then re-rank with the accurate figures.
  // Bounded (top listings only) and self-terminating once every pair is known.
  async function enrichCommuteRoad() {
    if (!myPlaces.length || enrichingCommute || !window.pawaRoute) return;
    const dests = visible.filter(h => Number.isFinite(h.lat) && Number.isFinite(h.lng)).slice(0, 40);
    if (!dests.length) return;
    const missing = myPlaces.some(p => dests.some(h => !commuteRoadKm.has(p.id + "|" + h.id)));
    if (!missing) return;
    enrichingCommute = true;
    try {
      let changed = false;
      for (const p of myPlaces) {
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
        const need = dests.filter(h => !commuteRoadKm.has(p.id + "|" + h.id));
        if (!need.length) continue;
        const kms = await window.pawaRoute.table({ lat: p.lat, lng: p.lng },
          need.map(h => ({ lat: +h.lat, lng: +h.lng })));
        need.forEach((h, i) => {
          const v = kms && kms[i];
          commuteRoadKm.set(p.id + "|" + h.id, Number.isFinite(v) ? v : null);
          if (Number.isFinite(v)) changed = true;
        });
      }
      // Re-run the pipeline so the new road km re-filter (max-time) + re-rank.
      // Converges: every pair is now cached, so the next pass finds nothing missing.
      if (changed) apply();
    } finally { enrichingCommute = false; }
  }

  function setupMyPlaces() {
    myPlaces = getMyPlaces();
    commuteBtn?.addEventListener("click", openPlacesModal);
    renderPlacesChips();
    // setupMyPlaces runs AFTER the first apply(), so saved places would otherwise
    // sit idle (chips shown, list unmatched) until the user touched a filter.
    if (myPlaces.length) apply();
  }

  function renderPlacesChips() {
    if (!placesChips) return;
    if (!myPlaces.length) { placesChips.hidden = true; placesChips.innerHTML = ""; return; }
    placesChips.hidden = false;
    placesChips.innerHTML =
      `<span style="font-size:.8rem;font-weight:600;color:var(--c-text-muted,#6b6960);align-self:center;margin-right:2px">Matching your life:</span>` +
      myPlaces.map(p => `
        <span class="hp-place-chip" title="${esc(p.name || "")}">
          ${kindOf(p.kind).icon} ${esc(p.label)} <small>${modeOf(p.mode).icon}${p.maxMin ? ` ≤${p.maxMin}m` : ""}</small>
          <button type="button" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.label)}">&times;</button>
        </span>`).join("") +
      `<span class="hp-place-chip clear" id="mpEditChip">Edit </span>`;
    placesChips.querySelectorAll("button[data-id]").forEach(btn => {
      btn.addEventListener("click", () => {
        myPlaces = myPlaces.filter(x => x.id !== btn.dataset.id);
        saveMyPlaces(myPlaces);
        renderPlacesChips();
        apply();
      });
    });
    document.getElementById("mpEditChip")?.addEventListener("click", openPlacesModal);
  }

  // Classify an OSM/Nominatim result into a short human tag: an
  // administrative level (Region → District → Ward → Village → Area) or the
  // kind of community service (School, Hospital, Market, Bank, …).
  function resultTag(it) {
    const at = (it.addresstype || "").toLowerCase();
    const ADMIN = {
      state: "Region", region: "Region", county: "District", state_district: "District",
      municipality: "District", district: "District", city: "City", town: "Town",
      suburb: "Suburb", neighbourhood: "Area", quarter: "Area", residential: "Area",
      village: "Village", hamlet: "Village", ward: "Ward", administrative: "Area"
    };
    if (ADMIN[at]) return ADMIN[at];
    const cls = (it.class || "").toLowerCase(), type = (it.type || "").toLowerCase();
    const SERVICE = {
      school: "School", college: "College", university: "University", kindergarten: "School",
      hospital: "Hospital", clinic: "Clinic", doctors: "Clinic", pharmacy: "Pharmacy",
      marketplace: "Market", supermarket: "Supermarket", mall: "Mall", bank: "Bank", atm: "ATM",
      fuel: "Fuel", bus_station: "Bus station", taxi: "Taxi rank", ferry_terminal: "Ferry",
      place_of_worship: "Worship", police: "Police", fire_station: "Fire", post_office: "Post",
      restaurant: "Restaurant", cafe: "Cafe", hotel: "Hotel", stadium: "Stadium",
      airport: "Airport", aerodrome: "Airport"
    };
    if (SERVICE[type]) return SERVICE[type];
    if (["amenity", "shop", "leisure", "tourism", "office", "healthcare", "building"].includes(cls))
      return (type || cls).replace(/_/g, " ").replace(/\b\w/, c => c.toUpperCase());
    return "Place";
  }

  // Friendly "nearby area" name from a reverse-geocode address — used when
  // the exact spot isn't a named place (a map tap, drag or GPS fix).
  function placeAreaLabel(j) {
    const a = (j && j.address) || {};
    const near  = a.suburb || a.neighbourhood || a.quarter || a.village || a.hamlet ||
                  a.ward || a.residential || a.city_district;
    const wider = a.city || a.town || a.municipality || a.county || a.state_district || a.state;
    const parts = [...new Set([near, wider].filter(Boolean))].slice(0, 2);
    if (parts.length) return parts.join(", ");
    return (j && j.display_name || "").split(",").slice(0, 2).join(", ");
  }

  // Search: gazetteer first (instant, known landmarks), then OSM/Nominatim
  // for regions, districts, wards, villages, famous areas and services.
  async function searchPlaces(q) {
    const out = [];
    const known = window.resolveTzPlace && window.resolveTzPlace(q);
    if (known) out.push({ name: known.name, lat: known.lat, lng: known.lng, tag: "Known place", context: "", known: true });
    try {
      // Country-wide: every matching village / ward / district / area, each kept
      // distinct (same name in different districts all show), not just the top 8.
      const hits = await pawaGeo.suggest(q, { limit: 25 });
      for (const h of hits) {
        if (out.some(o => o.name === h.name && o.context === h.context)) continue;
        out.push(h);
      }
    } catch (_) { /* offline / rate-limited — gazetteer result still stands */ }
    return out;
  }

  // Reverse-geocode a tapped/dragged point into a nearby-area label.
  async function reverseName(lat, lng) {
    try {
      return placeAreaLabel(await pawaGeo.reverse(`format=jsonv2&zoom=16&addressdetails=1&lat=${lat}&lon=${lng}`));
    } catch (_) { return null; }
  }

  // Map-driven place picker. Each place is a row (kind / label / mode / max
  // time); a shared Leaflet map + search box write to whichever row is
  // selected. Pick by search (admin areas + services), by tapping the map,
  // by dragging a pin, or by GPS — unknown spots are reverse-geocoded to a
  // nearby-area name.
  function openPlacesModal() {
    const backdrop = document.getElementById("placesModalBackdrop");
    const listEl   = document.getElementById("mpList");
    const addBtn   = document.getElementById("mpAddBtn");
    const saveBtn  = document.getElementById("mpSaveBtn");
    const cancelBtn= document.getElementById("mpCancelBtn");
    const closeBtn = document.getElementById("mpCloseBtn");
    const clearBtn = document.getElementById("mpClearBtn");
    const searchIn = document.getElementById("mpSearchInput");
    const gpsBtn   = document.getElementById("mpGpsBtn");
    const resultsEl= document.getElementById("mpSearchResults");
    const coordsEl = document.getElementById("mpCoords");
    if (!backdrop) return;

    const blank = () => ({ id: "mp-" + Math.random().toString(36).slice(2, 8),
      kind: "work", label: "", name: "", lat: null, lng: null, mode: "daladala", maxMin: null });
    let draft = myPlaces.length ? myPlaces.map(p => ({ ...p })) : [blank()];
    let activeId = draft[0].id;
    let mpMap = null, mpMarkers = {};

    backdrop.hidden = false;
    if (searchIn) searchIn.value = "";
    if (resultsEl) { resultsEl.hidden = true; resultsEl.innerHTML = ""; }
    renderRows();
    updateCoords();

    let isOpen = true;
    const initTimer = setTimeout(() => { if (isOpen) initMap(); }, 130);

    function hasUsable()   { return draft.some(p => Number.isFinite(p.lat) && Number.isFinite(p.lng)); }
    function syncSave()    { saveBtn.disabled = !hasUsable(); }
    function activePlace() { return draft.find(p => p.id === activeId) || draft[0]; }

    function renderRows() {
      listEl.innerHTML = "";
      draft.forEach(p => listEl.appendChild(buildRow(p)));
      syncSave();
    }

    function buildRow(p) {
      const row = document.createElement("div");
      row.className = "mp-row" + (p.id === activeId ? " is-active" : "");
      row.innerHTML = `
        <div class="mp-row-top">
          <select class="mp-kind" aria-label="Kind of place">
            ${Object.entries(PLACE_KINDS).map(([k, v]) => `<option value="${k}"${p.kind === k ? " selected" : ""}>${v.icon} ${v.label}</option>`).join("")}
          </select>
          <input class="mp-label" type="text" maxlength="40" placeholder="Label (e.g. My office)" value="${esc(p.label)}" />
          <button class="mp-remove" type="button" title="Remove this place" aria-label="Remove">&times;</button>
        </div>
        <div class="mp-row-bottom">
          <label class="mp-mode-lbl">By
            <select class="mp-mode" aria-label="Transport mode">
              ${Object.entries(MODES).map(([k, v]) => `<option value="${k}"${p.mode === k ? " selected" : ""}>${v.icon} ${v.label}</option>`).join("")}
            </select>
          </label>
          <label class="mp-max-lbl">Max
            <select class="mp-max" aria-label="Maximum travel time">
              <option value="">any time</option>
              ${[10, 15, 20, 30, 45, 60, 90].map(m => `<option value="${m}"${+p.maxMin === m ? " selected" : ""}>${m} min</option>`).join("")}
            </select>
          </label>
          <span class="mp-status${p.lat != null ? " set" : ""}">${p.lat != null ? " " + esc(p.name || "location set") : "tap map / search →"}</span>
        </div>`;

      const labelIn = row.querySelector(".mp-label");
      row.querySelector(".mp-kind").addEventListener("change", (e) => {
        p.kind = e.target.value;
        if (!labelIn.value.trim()) { labelIn.value = kindOf(p.kind).label; p.label = labelIn.value; }
        refreshMarker(p);
      });
      labelIn.addEventListener("input", () => { p.label = labelIn.value; });
      row.querySelector(".mp-mode").addEventListener("change", (e) => { p.mode = e.target.value; });
      row.querySelector(".mp-max").addEventListener("change", (e) => { p.maxMin = e.target.value ? +e.target.value : null; });
      row.querySelector(".mp-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        if (mpMarkers[p.id]) { mpMarkers[p.id].remove(); delete mpMarkers[p.id]; }
        draft = draft.filter(x => x !== p);
        if (!draft.length) draft.push(blank());
        if (activeId === p.id) activeId = draft[0].id;
        renderRows(); updateCoords();
      });
      // Selecting a row makes the search / GPS / map taps target it.
      row.addEventListener("click", (e) => {
        if (e.target.closest("select,input,button")) return;
        setActive(p.id);
      });
      return row;
    }

    function setActive(id) {
      activeId = id;
      const rows = listEl.querySelectorAll(".mp-row");
      draft.forEach((p, i) => { if (rows[i]) rows[i].classList.toggle("is-active", p.id === id); });
      const p = activePlace();
      if (mpMap && Number.isFinite(p.lat) && Number.isFinite(p.lng))
        mpMap.setView([p.lat, p.lng], Math.max(mpMap.getZoom(), 14));
      updateCoords();
    }

    function updateCoords() {
      if (!coordsEl) return;
      const p = activePlace(), k = kindOf(p.kind);
      coordsEl.textContent = Number.isFinite(p.lat)
        ? `${k.icon} ${p.label || k.label}: ${p.name || (p.lat.toFixed(4) + ", " + p.lng.toFixed(4))}`
        : `Setting ${k.icon} ${p.label || k.label} — search or tap the map`;
      coordsEl.classList.toggle("has-pin", Number.isFinite(p.lat));
    }

    // Write a location onto the active place, refresh its pin, and (when no
    // name is known) reverse-geocode the nearby area.
    async function setActiveLocation(lat, lng, name) {
      const p = activePlace();
      p.lat = lat; p.lng = lng;
      if (name) p.name = name;
      if (!p.label || !p.label.trim()) p.label = kindOf(p.kind).label;
      refreshMarker(p);
      renderRows(); setActive(p.id); syncSave();
      if (!name) {
        const near = await reverseName(lat, lng);
        if (near && p.lat === lat && p.lng === lng) { p.name = near; renderRows(); setActive(p.id); }
      }
    }

    function refreshMarker(p) {
      if (!mpMap) return;
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) {
        if (mpMarkers[p.id]) { mpMarkers[p.id].remove(); delete mpMarkers[p.id]; }
        return;
      }
      const icon = L.divIcon({ className: "mp-pin", html: kindOf(p.kind).icon, iconSize: [26, 26], iconAnchor: [13, 26] });
      if (mpMarkers[p.id]) {
        mpMarkers[p.id].setLatLng([p.lat, p.lng]).setIcon(icon);
      } else {
        const mk = L.marker([p.lat, p.lng], { draggable: true, icon }).addTo(mpMap);
        mk.on("dragend", () => { const ll = mk.getLatLng(); setActive(p.id); setActiveLocation(ll.lat, ll.lng, null); });
        mk.on("click", () => setActive(p.id));
        mpMarkers[p.id] = mk;
      }
    }

    function initMap() {
      if (mpMap) { mpMap.invalidateSize(); return; }
      try {
        mpMap = L.map("mpModalMap", { center: [-6.7924, 39.2789], zoom: 11,
          maxBounds: [[-11.75, 29.34], [-0.99, 40.45]], zoomControl: false });
        window.addSatelliteHybrid(mpMap);
        L.control.zoom({ position: "topright" }).addTo(mpMap);
        mpMap.on("click", (e) => setActiveLocation(e.latlng.lat, e.latlng.lng, null));
        mpMap.whenReady(() => mpMap.invalidateSize());
        draft.forEach(refreshMarker);
        const first = draft.find(p => Number.isFinite(p.lat));
        if (first) mpMap.setView([first.lat, first.lng], 13);
      } catch (err) {
        const el = document.getElementById("mpModalMap");
        if (el) el.innerHTML = `<div style="padding:20px;color:#b91c1c;font-size:.85rem">Map error: ${esc(String(err))}</div>`;
      }
    }

    // ---- shared search box (admin areas + community services) ----
    let searchTimer;
    if (searchIn) searchIn.oninput = () => {
      clearTimeout(searchTimer);
      const q = searchIn.value.trim();
      if (q.length < 2) { resultsEl.hidden = true; return; }
      searchTimer = setTimeout(async () => {
        resultsEl.hidden = false;
        resultsEl.innerHTML = `<div class="am-search-result loading">Searching…</div>`;
        const hits = await searchPlaces(q);
        if (!hits.length) { resultsEl.innerHTML = `<div class="am-search-result loading">No matches — tap the map to drop a pin.</div>`; return; }
        resultsEl.innerHTML = hits.map((it, i) => {
          const rest = it.context || "";
          return `<div class="am-search-result" data-i="${i}">
            <strong>${esc(it.name)}</strong> <span class="am-tag${it.known ? " known" : ""}">${esc(it.tag || "Place")}</span>
            ${rest ? `<small>${esc(rest)}</small>` : ""}
          </div>`;
        }).join("");
        resultsEl.querySelectorAll(".am-search-result[data-i]").forEach(div => {
          div.addEventListener("click", () => {
            const it = hits[+div.dataset.i];
            if (!it) return;
            setActiveLocation(it.lat, it.lng, it.name);
            if (mpMap) mpMap.setView([it.lat, it.lng], 15);
            resultsEl.hidden = true; searchIn.value = "";
          });
        });
      }, 320);
    };

    if (gpsBtn) gpsBtn.onclick = async () => {
      gpsBtn.disabled = true; gpsBtn.textContent = " …";
      try {
        const fix = await pawaLocate.best({ targetAccuracy: 20 });
        setActiveLocation(fix.lat, fix.lng, null);
        if (mpMap) mpMap.setView([fix.lat, fix.lng], 15);
      } catch (err) {
        alert(pawaLocate.message(err));
      } finally {
        gpsBtn.disabled = false; gpsBtn.textContent = " GPS";
      }
    };

    const close = () => {
      isOpen = false; clearTimeout(initTimer);
      backdrop.hidden = true; listEl.innerHTML = "";
      Object.values(mpMarkers).forEach(m => m.remove()); mpMarkers = {};
      if (mpMap) { mpMap.remove(); mpMap = null; }
    };
    addBtn.onclick    = () => { const b = blank(); draft.push(b); activeId = b.id; renderRows(); setActive(b.id); updateCoords(); };
    clearBtn.onclick  = () => { Object.values(mpMarkers).forEach(m => m.remove()); mpMarkers = {}; const b = blank(); draft = [b]; activeId = b.id; renderRows(); updateCoords(); };
    closeBtn.onclick  = close;
    cancelBtn.onclick = close;
    backdrop.onclick  = (e) => { if (e.target === backdrop) close(); };
    saveBtn.onclick = () => {
      myPlaces = draft
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))
        .map(p => ({ ...p, label: (p.label || "").trim() || kindOf(p.kind).label }));
      saveMyPlaces(myPlaces);
      renderPlacesChips();
      apply();
      close();
      document.getElementById("housesStage")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  }

  // ====================================================================
  //  Apply filters → re-render list and map markers
  // ====================================================================
  function apply() {
    const listing = fListing.value;
    const type    = fType.value;
    const area    = fArea.value.trim().toLowerCase();
    const beds    = parseInt(fBeds.value || "0", 10);
    const room    = fRoom ? fRoom.value : "";   // single | master | whole | ""
    const price   = fPrice.value;
    const q       = fSearch.value.toLowerCase().trim();

    visible = houses.filter(h => {
      if (h.available === false) return false;   // deal completed → off the public list
      if (!passesSegment(h)) return false;       // Rent / Sale / Business world
      if (listing && h.listing !== listing) return false;
      if (type    && h.type    !== type)    return false;
      if (area) {
        // Typed area: match anywhere in the admin hierarchy (region/district/ward)
        // + area/address, so a region, district ("Kinondoni") OR ward ("Mikocheni")
        // each surfaces every listing an agent registered in that exact area.
        const areaHay = [h.area, h.address, h.region, h.district, h.ward].filter(Boolean).join(" ").toLowerCase();
        if (!areaHay.includes(area)) return false;
      }
      if (beds    && (h.bedrooms || 0) < beds) return false;
      if (room) {
        // "whole" = the entire property (no single/master tag); otherwise an
        // exact room-category match.
        if (room === "whole") { if (h.room_kind === "single" || h.room_kind === "master") return false; }
        else if (h.room_kind !== room) return false;
      }
      if (price) {
        // Free-typed budget ("900k", "under 2m", "500k - 1.5m"). A tiny 5%
        // grace on the ceiling keeps a listing that's only just over budget.
        const { priceMin, priceMax } = parsePriceText(price);
        const p = h.price_tzs || 0;
        if (priceMax != null && p > priceMax * 1.05) return false;
        if (priceMin != null && p < priceMin) return false;
      }
      if (q) {
        // Extended haystack so typing "rent", "apartment", "3 bed", a price
        // figure, or an area name in the same search box all narrow the list.
        // Bedroom variants ("3 bed", "3br", "3 bedroom") let users phrase it
        // however they like. Price is included as a raw int so partial
        // matches work ("500000" hits anything between 500k and 5M).
        const hay = [
          h.title, h.area, h.address, h.region, h.district, h.ward,
          h.listing, h.type,
          h.bedrooms ? `${h.bedrooms}bed ${h.bedrooms} bed ${h.bedrooms} bedroom ${h.bedrooms}br` : "",
          h.bathrooms ? `${h.bathrooms} bath` : "",
          h.price_tzs ? String(h.price_tzs) : ""
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    // Smart search: apply the numeric budget cap (the bucketed <select> can't)
    // and score every remaining listing for the "% match" badge.
    if (smartCriteria) {
      if (smartCriteria.priceMax)
        visible = visible.filter(h => (h.price_tzs || 0) <= smartCriteria.priceMax * 1.1);
      if (smartCriteria.priceMin)
        visible = visible.filter(h => (h.price_tzs || 0) >= smartCriteria.priceMin * 0.9);
      matchScores.clear();
      visible.forEach(h => matchScores.set(h.id, scoreHouse(h, smartCriteria)));
    } else {
      matchScores.clear();
    }

    // "Match to my life": annotate every listing with its commute breakdown,
    // and drop any that bust a per-place max-time limit (homes without map
    // coordinates can't be evaluated, so they're kept rather than hidden).
    commuteScores.clear();
    if (myPlaces.length) {
      visible = visible.filter(h => {
        const c = commuteFor(h);
        if (c) commuteScores.set(h.id, c);
        return !c || c.pass;
      });
    }

    // Hand off final ranking + render. The composite ranker runs in WASM
    // (async), so it lives in its own function; the four tuned modes below
    // keep their existing order.
    rankAndRender();
  }

  // Final ranking + render. Ranking precedence:
  //   1. distance to the searched place (when a landmark is anchored),
  //   2. total estimated travel time to the user's places,
  //   3. smart-search match score,
  //   4. distance from the user ("Near me").
  // The default near-me / landmark case is upgraded to the Rust→WASM
  // composite score (proximity + budget fit + spec fit) so "best matches near
  // me" beats a raw distance list when the user also set a budget or bedrooms.
  // Real road distance (OSRM) from the current anchor (searched place or GPS) to
  // each home — upgrades the straight-line distance shown + sorted in the list.
  function houseAnchor() { return landmarkLoc || userLoc || null; }
  function roadKeyH(h) {
    const a = houseAnchor();
    if (!a || !Number.isFinite(h.lat) || !Number.isFinite(h.lng)) return null;
    return `${(+a.lat).toFixed(4)},${(+a.lng).toFixed(4)}>${(+h.lat).toFixed(4)},${(+h.lng).toFixed(4)}`;
  }
  function roadOf(h) { const k = roadKeyH(h); const v = k ? roadKmCache.get(k) : undefined; return v != null ? v : null; }
  function effDist(h) { const r = roadOf(h); if (r != null) return r; const a = houseAnchor(); return a ? distKm(a, h) : Infinity; }
  async function enrichHousesRoad() {
    const a = houseAnchor();
    if (!a || enrichingHousesRoad || !window.pawaRoute) return;
    const targets = visible.filter((h) => roadKeyH(h) && roadKmCache.get(roadKeyH(h)) === undefined).slice(0, 40);
    if (!targets.length) return;
    enrichingHousesRoad = true;
    try {
      const kms = await window.pawaRoute.table(a, targets.map((h) => ({ lat: +h.lat, lng: +h.lng })));
      let changed = false;
      targets.forEach((h, i) => {
        const v = kms && kms[i];
        roadKmCache.set(roadKeyH(h), Number.isFinite(v) ? v : null);
        if (Number.isFinite(v)) changed = true;
      });
      if (changed) {
        if (landmarkLoc) visible.sort((x, y) => effDist(x) - effDist(y));
        else if (userLoc && !myPlaces.length && !smartCriteria) visible.sort((x, y) => effDist(x) - effDist(y));
        renderList(); renderMarkers();
      }
    } finally { enrichingHousesRoad = false; }
  }

  async function rankAndRender() {
    const anchor = landmarkLoc || userLoc || null;
    const useComposite = !!(anchor && !myPlaces.length && !smartCriteria && window.HouseMatch);
    if (useComposite) {
      try {
        const scores = await HouseMatch.rank(visible, {
          anchor,
          maxBudget: budgetCapFromFilter(),
          minBedrooms: parseInt(fBeds.value || "0", 10) || 0,
          listing: fListing.value || "",
          type: fType.value || ""
        });
        // Drop anything the engine hard-filtered (over budget / wrong kind),
        // then order by composite score, breaking ties by distance.
        visible = visible.filter(h => (scores.get(h.id)?.score ?? 0) >= 0);
        visible.sort((a, b) => {
          const sa = scores.get(a.id)?.score ?? 0, sb = scores.get(b.id)?.score ?? 0;
          if (sb !== sa) return sb - sa;
          const da = scores.get(a.id)?.distKm ?? Infinity, db = scores.get(b.id)?.distKm ?? Infinity;
          return da - db;
        });
        renderList();
        renderMarkers();
        enrichHousesRoad();
        return;
      } catch (_) { /* fall through to the classic sorts */ }
    }
    if (landmarkLoc) {
      visible.sort((a, b) => effDist(a) - effDist(b));
    } else if (myPlaces.length) {
      const tot = id => (commuteScores.get(id) ? commuteScores.get(id).total : Infinity);
      visible.sort((a, b) => tot(a.id) - tot(b.id));
    } else if (smartCriteria) {
      visible.sort((a, b) => (matchScores.get(b.id) || 0) - (matchScores.get(a.id) || 0));
    } else if (userLoc) {
      visible.sort((a, b) => effDist(a) - effDist(b));
    }

    renderList();
    renderMarkers();
    enrichHousesRoad();
    if (myPlaces.length) enrichCommuteRoad();   // upgrade commute legs to real road km
  }

  // The budget box is free text ("900k", "under 2m", "1m - 3m"); its ceiling is
  // the cap the composite ranker treats as the budget. Empty / no figure → 0.
  function budgetCapFromFilter() {
    return parsePriceText(fPrice.value).priceMax || 0;
  }

  // ====================================================================
  //  List rendering
  // ====================================================================
  function renderList() {
    applySort();   // the results-bar sort wins over the default ranked order
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
      // Build a human-readable description of what was searched so the
      // "not found" message is specific rather than a generic fallback.
      const c = smartCriteria;
      const textQ = fSearch?.value.trim();
      let notFoundTitle = "No properties match";
      let notFoundSub   = "Widen your filters, clear the search box, or browse all listings.";
      if (c || textQ) {
        const parts = [];
        if (textQ) parts.push(`"${textQ}"`);
        if (c) {
          if (c.bedrooms != null) parts.push(`${c.bedrooms} bedroom${c.bedrooms !== 1 ? "s" : ""}`);
          if (c.type)    parts.push(({ apartment:"apartment", house:"house", plot:"plot", office:"office", shop:"shop/business" })[c.type] || c.type);
          if (c.listing) parts.push(c.listing === "sale" ? "for sale" : "for rent");
          if (c.area)    parts.push(`in ${c.area}`);
          if (c.priceMax) parts.push(`under ${shortTzs(c.priceMax)} TZS`);
        }
        const desc = parts.length ? parts.join(", ") : (ssInput?.value.trim() || "");
        notFoundTitle = desc
          ? `No property found: ${esc(desc)}`
          : "No matching property found";
        notFoundSub = "Such a property does not exist in our current listings. Try different criteria or clear the search to browse all available properties.";
      }
      listEl.innerHTML = `<div class="hp-empty" role="status">
        <div class="hp-empty__art" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>
          </svg>
        </div>
        <div class="hp-empty__title">${notFoundTitle}</div>
        <div class="hp-empty__sub">${notFoundSub}</div>
        <div class="hp-empty__actions">
          <button class="hp-empty__cta" type="button" id="hpClearFilters">Clear all filters</button>
          <button class="hp-empty__cta hp-empty__cta--ghost" type="button" id="hpPinArea"> Pin this area &amp; get alerted</button>
        </div>
        <div id="hpPinForm" hidden></div>
      </div>`;
      const clearBtn = document.getElementById("hpClearFilters");
      clearBtn?.addEventListener("click", () => {
        [fListing, fType, fArea, fBeds, fRoom, fPrice].forEach(el => { if (el) el.value = ""; });
        if (fSearch) fSearch.value = "";
        setSegment("all", { silent: true });
        apply();
      });
      wireDemandCta();
      return;
    }

    listEl.innerHTML = visible.map((h, i) => {
      const photo  = window.DataStore.housePhotoUrl(h.photo);
      const price  = formatPrice(h);
      const listing = h.listing === "sale" ? "For sale" : "For rent";
      const verified = h.verified ? `<span class="verified"> Verified</span>` : "";
      const roomKind = roomKindLabel(h.room_kind);
      const meta = [
        roomKind ? `<span class="house-card-roomkind">${roomKind}</span>` : "",
        h.bedrooms ? `<span> ${h.bedrooms} bed${h.bedrooms !== 1 ? "s" : ""}</span>` : "",
        h.bathrooms ? `<span> ${h.bathrooms} bath${h.bathrooms !== 1 ? "s" : ""}</span>` : "",
        h.size_sqm ? `<span> ${h.size_sqm} m²</span>` : "",
        (h.listing === "rent" && Number(h.min_months) > 1) ? `<span> ${h.min_months} mo min</span>` : ""
      ].filter(Boolean).join("");
      const loc = `${esc(h.area || "—")}${h.region ? `, ${esc(h.region)}` : ""}`;
      const hasCoords = Number.isFinite(h.lat) && Number.isFinite(h.lng);
      const rk = hasCoords ? roadOf(h) : null;
      const dist = (landmarkLoc && hasCoords)
        ? ` · ${(rk != null ? rk : distKm(landmarkLoc, h)).toFixed(1)} km${rk != null ? " " : ""} to ${esc(landmarkShort(landmarkLoc.name))}`
        : (userLoc && hasCoords)
          ? ` · ${(rk != null ? rk : distKm(userLoc, h)).toFixed(1)} km ${rk != null ? "by road" : "away"}`
          : "";
      const ariaLabel = `${esc(h.title)}, ${price.value} ${price.unit}, ${loc}`;
      const matchPct = smartCriteria ? matchScores.get(h.id) : null;
      const matchCls = matchPct == null ? "" : matchPct >= 75 ? "" : matchPct >= 50 ? "mid" : "low";
      const matchBadge = matchPct == null ? ""
        : `<span class="house-card-match ${matchCls}"> ${matchPct}% match</span>`;
      // Compact hint that this listing has extra bills (electricity, water…),
      // so clients know there are costs on top of the price before they click.
      const bills = Array.isArray(h.extra_costs) ? h.extra_costs.filter(c => c && c.label) : [];
      const billsHint = bills.length
        ? `<div class="house-card-bills" style="font-size:.78rem;color:#6b6960;margin-top:4px;"> + ${
            bills.slice(0, 2).map(c => esc(c.label)).join(", ")
          }${bills.length > 2 ? ` +${bills.length - 2}` : ""} ${bills.length === 1 ? "bill" : "bills"}</div>`
        : "";
      const commute = commuteScores.get(h.id);
      const commuteHtml = commute ? `<div class="house-card-commute">${
        commute.legs.map(l => `<span class="hc-leg${l.ok ? "" : " over"}">${kindOf(l.place.kind).icon} ${esc(l.place.label)} · ${l.km.toFixed(1)} km · ~${fmtMin(l.min)} ${modeOf(l.place.mode).icon}</span>`).join("")
      }</div>` : "";
      // Nearest MAIN road (tarmac) — filled from cache now, or patched in
      // place once the batched Overpass lookup resolves (enrichMainRoads).
      const mr = hasCoords ? mainRoadCache.get(h.id) : null;
      const roadHtml = hasCoords
        ? `<div class="house-card-road" data-road-id="${h.id}"${mainRoadCache.has(h.id) ? "" : " hidden"}>${mainRoadCache.has(h.id) ? mainRoadText(mr) : ""}</div>`
        : "";
      return `
        <div class="house-card ${activeId === h.id ? "active" : ""}" data-id="${h.id}"
             role="button" tabindex="0" aria-label="${ariaLabel}">
          <div class="house-card-photo" data-loading="true" style="background-image:url('${photo}')">
            <span class="badge">${listing}</span>
            ${verified}
            ${matchBadge}
          </div>
          <div class="house-card-body">
            <div class="house-card-price">${price.value} <small>${price.unit}</small></div>
            <div class="house-card-title">${esc(h.title)}</div>
            <div class="house-card-meta">${meta}</div>
            <div class="house-card-loc"> ${loc}${dist}</div>
            ${roadHtml}
            ${billsHint}
            ${commuteHtml}
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

    enrichMainRoads();
  }

  // ---- Nearest main road per card -----------------------------------------
  // Every listing shows how close it is to the tarmac (motorway / trunk /
  // primary / secondary). One batched Overpass call per ~25 uncached homes
  // via the shared pawaRoads helper; cards are patched in place — no
  // re-render, so photos don't flicker.
  function mainRoadText(mr) {
    if (!mr) return ` 3 km+ from a main road`;
    const d = mr.meters < 1000 ? `${Math.round(mr.meters)} m` : `${(mr.meters / 1000).toFixed(1)} km`;
    return ` ${d} to ${esc(mr.name)}`;
  }
  async function enrichMainRoads() {
    if (enrichingMainRoads || !window.pawaRoads) return;
    const targets = visible.filter((h) =>
      Number.isFinite(+h.lat) && Number.isFinite(+h.lng) && !mainRoadCache.has(h.id)).slice(0, 25);
    if (!targets.length) return;
    enrichingMainRoads = true;
    let progress = false;
    try {
      const res = await window.pawaRoads.nearestBatch(targets.map((h) => ({ lat: +h.lat, lng: +h.lng })));
      targets.forEach((h, i) => {
        if (res[i] === undefined) return;        // lookup failed — retry on a later render
        mainRoadCache.set(h.id, res[i]);
        progress = true;
        const el = listEl.querySelector(`.house-card-road[data-road-id="${h.id}"]`);
        if (el) { el.innerHTML = mainRoadText(res[i]); el.hidden = false; }
      });
    } catch (_) {
    } finally { enrichingMainRoads = false; }
    // More homes than one batch? Keep going while Overpass keeps answering.
    if (progress && visible.some((h) =>
      Number.isFinite(+h.lat) && Number.isFinite(+h.lng) && !mainRoadCache.has(h.id))) {
      enrichMainRoads();
    }
  }

  // ---- Bento overview tiles ---------------------------------------------
  function updateBentoCounts() {
    const total = houses.length;
    // Residential rent/sale exclude commercial premises so the counts line up
    // with what each segment actually shows.
    const rent = houses.filter(h => !isBusinessType(h.type) && h.listing === "rent").length;
    const sale = houses.filter(h => !isBusinessType(h.type) && h.listing === "sale").length;
    const business = houses.filter(h => isBusinessType(h.type)).length;
    const verified = houses.filter(h => h.verified).length;
    let favs = 0;
    try { favs = JSON.parse(localStorage.getItem("pawa.houseFavs") || "[]").length; } catch {}
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("hpBentoTotal", total);
    set("hpBentoRent", rent);
    set("hpBentoSale", sale);
    set("hpBentoBusiness", business);
    set("hpBentoVerified", verified);
    set("hpBentoFavs", favs);
    // Segment-switcher pill counts
    set("hpSegCountAll", total);
    set("hpSegCountRent", rent);
    set("hpSegCountSale", sale);
    set("hpSegCountBiz", business);
  }

  document.querySelectorAll(".hp-bento__cell[data-quickfilter]").forEach(cell => {
    cell.addEventListener("click", (e) => {
      e.preventDefault();
      const qf = cell.dataset.quickfilter;
      if (qf === "rent" || qf === "sale" || qf === "business") {
        setSegment(qf, { silent: true });
      } else if (qf === "verified") {
        setSegment("all", { silent: true });
        if (fSearch) fSearch.value = "verified";
      } else {
        setSegment("all", { silent: true });
        [fType, fArea, fBeds, fRoom, fPrice].forEach(el => { if (el) el.value = ""; });
        if (fSearch) fSearch.value = "";
      }
      apply();
      document.getElementById("housesStage")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  // ---- Filter bar -------------------------------------------------------
  // (Previously the toolbar turned sticky on scroll, but it then floated over
  //  the list + map and hid listings as you scrolled. It now scrolls away with
  //  the rest of the page so the list and map stay fully visible.)

  // ====================================================================
  //  Map
  // ====================================================================
  function initMap() {
    // Hybrid base (satellite + roads + street names) with a Map ⇄ Satellite
    // toggle — shared style from config.js so every map reads the same.
    map = new maplibregl.Map({
      container: "housesMap",
      style: window.pawaGlHybridStyle ? window.pawaGlHybridStyle() : { version: 8, sources: {}, layers: [] },
      center: [39.2789, -6.7924],   // Dar es Salaam — most listings cluster here
      zoom: 11,
      maxBounds: TZ_BOUNDS,
      attributionControl: true
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    if (window.pawaGlBasemapToggle) map.addControl(window.pawaGlBasemapToggle(), "top-right");
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
    if (!map) return;
    // Include the landmark anchor in the viewport so the searched place and
    // the nearby listings are visible together.
    const pts = (mappable || []).map(h => [h.lng, h.lat]);
    if (landmarkLoc) pts.push([landmarkLoc.lng, landmarkLoc.lat]);
    if (!pts.length) return;
    if (pts.length === 1) {
      map.easeTo({ center: pts[0], zoom: Math.max(13, map.getZoom()), duration: 500 });
      return;
    }
    const lngs = pts.map(p => p[0]), lats = pts.map(p => p[1]);
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 60, maxZoom: 14, duration: 500 }
    );
  }

  function distToLandmark(h) {
    if (!landmarkLoc || !Number.isFinite(h.lat) || !Number.isFinite(h.lng)) return Infinity;
    return distKm(landmarkLoc, h);
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
        ${ph ? `<a class="btn-call" href="tel:${phClean}"> Call</a>` : ""}
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

  // ====================================================================
  //  Demand pins — "no room here yet? pin the area, get alerted"
  //
  //  When a search comes up empty, the renter can drop a server-side demand
  //  pin: their wanted spot + budget + specs + phone. It persists to
  //  public.house_demand_pins (RLS: they own it). Later, when an agent posts
  //  a property near that spot, the agent dashboard surfaces the waiting
  //  renters and their numbers (see js/agent-houses.js + the house_demand_near
  //  RPC). This is the persistent, agent-reaching cousin of the localStorage
  //  geo-alerts above — those only notify the same browser; a demand pin
  //  reaches the person who can actually post the room.
  // ====================================================================
  // Resolve a point to pin. Order of preference:
  //   1. an anchored landmark ("near UDSM"),
  //   2. the user's GPS ("Near me"),
  //   3. PIN BY NAME — geocode whatever area/place the search names, so a
  //      renter can pin "Tegeta" or "Mbezi Beach" without dropping a GPS pin.
  //      Gazetteer first (instant, offline-safe), then Nominatim (TZ-only).
  // The `approx` flag widens the acceptance radius since a centroid is coarse.
  async function anchorForPin() {
    if (landmarkLoc) return { lat: landmarkLoc.lat, lng: landmarkLoc.lng, label: landmarkShort(landmarkLoc.name) };
    if (userLoc)     return { lat: userLoc.lat, lng: userLoc.lng, label: "your current location" };

    const name = (fArea.value || smartCriteria?.area ||
                  (fSearch?.value || "").trim() || (ssInput?.value || "").trim());
    if (name && name.length >= 2) {
      const known = window.resolveTzPlace && window.resolveTzPlace(name);
      if (known) return { lat: known.lat, lng: known.lng, label: known.name, approx: true };
      const geo = await geocodePlace(name);
      if (geo) return { lat: geo.lat, lng: geo.lng, label: landmarkShort(geo.name), approx: true };
    }
    return null;
  }

  function wireDemandCta() {
    ensureDemandStyles();
    const btn = document.getElementById("hpPinArea");
    const formWrap = document.getElementById("hpPinForm");
    if (!btn || !formWrap) return;
    btn.addEventListener("click", async () => {
      const origLabel = btn.textContent;
      btn.disabled = true; btn.textContent = " Finding the area…";
      let anchor = null;
      try { anchor = await anchorForPin(); } catch (_) {}
      btn.disabled = false; btn.textContent = origLabel;
      if (!anchor) {
        flashBanner("", "Which area?",
          "Type an area or place name in the search box (or tap “Near me”), then pin again — we need a spot to alert agents about.");
        return;
      }
      const budget = budgetCapFromFilter() || (smartCriteria?.priceMax || 0);
      const beds   = parseInt(fBeds.value || "0", 10) || (smartCriteria?.bedrooms || 0);
      const wants  = [];
      if (beds)   wants.push(`${beds}+ bed`);
      if (budget) wants.push(`≤ ${shortTzs(budget)} TZS`);
      formWrap.hidden = false;
      btn.hidden = true;
      formWrap.innerHTML = `
        <div class="hp-pin-form">
          <p class="hp-pin-form__lead">We'll alert agents who post near <strong>${esc(anchor.label)}</strong>
            ${wants.length ? `for <strong>${esc(wants.join(" · "))}</strong>` : ""} that you're waiting.
            Leave a phone so they can reach you:</p>
          <div class="hp-pin-form__row">
            <input id="hpPinPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+255 7XX XXX XXX">
            <input id="hpPinName" type="text" autocomplete="name" placeholder="Your name (optional)">
          </div>
          <button type="button" id="hpPinSubmit" class="hp-empty__cta"> Notify me when a room appears</button>
          <div id="hpPinMsg" class="hp-pin-form__msg" hidden></div>
        </div>`;
      const phoneEl = document.getElementById("hpPinPhone");
      const nameEl  = document.getElementById("hpPinName");
      const subEl   = document.getElementById("hpPinSubmit");
      const msgEl   = document.getElementById("hpPinMsg");
      phoneEl?.focus();
      subEl?.addEventListener("click", async () => {
        msgEl.hidden = true;
        subEl.disabled = true; subEl.textContent = "Saving…";
        try {
          await createDemandPin(anchor, { phone: phoneEl.value, name: nameEl.value });
          formWrap.innerHTML = `<div class="hp-pin-form hp-pin-form--done">
             <strong>You're on the waiting list for ${esc(anchor.label)}.</strong>
            <span>The moment an agent posts a matching room nearby, they'll see your number and call you.</span>
          </div>`;
        } catch (err) {
          subEl.disabled = false; subEl.textContent = " Notify me when a room appears";
          msgEl.hidden = false;
          msgEl.textContent = err.message || "Couldn't save your pin — please try again.";
        }
      });
    });
  }

  async function createDemandPin(anchor, { phone, name }) {
    const digits = String(phone || "").replace(/[^\d+]/g, "");
    if (digits.replace(/\D/g, "").length < 9) throw new Error("Please enter a valid phone number.");
    const area = (landmarkLoc && landmarkShort(landmarkLoc.name)) || fArea.value || (smartCriteria?.area) || null;
    const allowedTypes = new Set(["apartment", "house", "plot", "office", "shop"]);
    const wantType = fType.value || smartCriteria?.type || null;
    const pin = {
      id: "dp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      lat: anchor.lat,
      lng: anchor.lng,
      area: area || anchor.label || null,
      // A name-geocoded centroid is coarse, so accept a wider ring around it.
      radius_m: anchor.approx ? 3500 : 2000,
      listing: (fListing.value || smartCriteria?.listing || "rent") === "sale" ? "sale" : "rent",
      type: allowedTypes.has(wantType) ? wantType : null,
      min_bedrooms: parseInt(fBeds.value || "0", 10) || (smartCriteria?.bedrooms || 0) || 0,
      max_budget_tzs: budgetCapFromFilter() || (smartCriteria?.priceMax || 0) || 0,
      phone: digits,
      name: (name || "").trim() || null
    };
    const sb = window.DataStore?.sb;
    if (!sb) {
      // No backend wired — keep it locally so the intent isn't lost.
      const local = JSON.parse(localStorage.getItem("pawa_demand_pins") || "[]");
      local.push(pin); localStorage.setItem("pawa_demand_pins", JSON.stringify(local));
      return pin;
    }
    try {
      const { data: { session } } = await sb.auth.getSession();
      pin.user_id = session?.user?.id || null;
    } catch (_) { pin.user_id = null; }
    const { error } = await sb.from("house_demand_pins").insert(pin);
    if (error) {
      if (/relation .* does not exist|schema cache/i.test(error.message || ""))
        throw new Error("Waiting lists aren't set up yet on this server. Run supabase/setup_house_demand.sql.");
      throw error;
    }
    const mine = JSON.parse(localStorage.getItem("pawa_my_demand_pins") || "[]");
    mine.push({ id: pin.id, area: pin.area, lat: pin.lat, lng: pin.lng, at: Date.now() });
    localStorage.setItem("pawa_my_demand_pins", JSON.stringify(mine));
    return pin;
  }

  function ensureDemandStyles() {
    if (document.getElementById("hpDemandStyles")) return;
    const s = document.createElement("style");
    s.id = "hpDemandStyles";
    s.textContent = `
      .hp-empty__actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
      .hp-empty__cta--ghost{background:transparent;color:#0a6f4d;box-shadow:inset 0 0 0 1.5px #0a6f4d}
      .hp-pin-form{margin:14px auto 0;max-width:380px;text-align:left;background:#f7faf8;
        border:1px solid #d8e6df;border-radius:14px;padding:14px 16px}
      .hp-pin-form__lead{margin:0 0 10px;font-size:.86rem;line-height:1.45;color:#33403a}
      .hp-pin-form__row{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
      .hp-pin-form input{width:100%;padding:10px 12px;border:1px solid #cdd9d3;border-radius:9px;font-size:.92rem}
      .hp-pin-form input:focus{outline:none;border-color:#0a6f4d;box-shadow:0 0 0 3px rgba(10,111,77,.15)}
      .hp-pin-form .hp-empty__cta{width:100%}
      .hp-pin-form__msg{margin-top:8px;font-size:.82rem;color:#b91c1c}
      .hp-pin-form--done{display:flex;flex-direction:column;gap:3px;font-size:.88rem;color:#0a6f4d}
      .hp-pin-form--done span{color:#33403a}`;
    document.head.appendChild(s);
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
