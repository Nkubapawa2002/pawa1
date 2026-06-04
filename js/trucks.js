// Moving-trucks directory — browse hire trucks, filter by type / area /
// coverage / capacity, and sort by distance to find the truck nearest you.
//
// The "move my goods to the new home" companion to the houses listings. Same
// shape as houses.js but scoped to trucks: a split list + Leaflet map, public
// (no auth needed to browse), data from DataStore.getTrucks() with a JSON
// fallback so the page always works even before the `trucks` table is applied.

(function () {
  "use strict";

  const TYPE_LABEL = {
    pickup: "Pickup", canter: "Canter", "3ton": "3-tonne",
    "7ton": "7-tonne lorry", "10ton_plus": "10-tonne+ lorry", other: "Truck",
  };
  const SERVICE_LABEL = {
    within_city: "Within city", region_wide: "Region-wide", cross_region: "Cross-region",
  };

  let trucks = [];        // all loaded trucks
  let map = null;
  let markers = new Map();   // id -> Leaflet marker
  let userLoc = null;        // {lat,lng} once "Near me" used
  let userMarker = null;

  // DOM refs (filled in init)
  let listEl, mapEl, countEl, stageEl;
  let fType, fArea, fService, fCapacity, fSearch, areaList, nearBtn;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function haversineKm(aLat, aLng, bLat, bLng) {
    const R = 6371, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
    const x = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function photoUrl(t) {
    const p = t.photo || (Array.isArray(t.photos) && t.photos[0]) || "";
    return p && window.DataStore ? window.DataStore.truckPhotoUrl(p) : "";
  }

  // "from TZS 80k / trip"
  function formatPrice(t) {
    const p = t.price_tzs || 0;
    let value;
    if (p >= 1_000_000) value = (p / 1_000_000).toFixed(p % 1_000_000 === 0 ? 0 : 1) + "M";
    else if (p >= 1_000) value = (p / 1_000).toFixed(0) + "k";
    else value = String(p);
    return { value, unit: `TZS / ${t.period || "trip"}` };
  }

  function distanceLabel(km) {
    if (km < 1) return Math.round(km * 1000) + " m away";
    return (km < 10 ? km.toFixed(1) : Math.round(km)) + " km away";
  }

  // ---- filtering -----------------------------------------------------------
  function applyFilters() {
    const type = fType.value;
    const area = fArea.value.trim().toLowerCase();
    const service = fService.value;
    const minCap = parseFloat(fCapacity.value) || 0;
    const q = fSearch.value.trim().toLowerCase();

    let out = trucks.filter((t) => {
      if (type && t.truck_type !== type) return false;
      if (service && t.service_area !== service) return false;
      if (minCap && !(parseFloat(t.capacity_tonnes) >= minCap)) return false;
      if (area && !((t.area || "").toLowerCase().includes(area) ||
                    (t.address || "").toLowerCase().includes(area) ||
                    (t.region || "").toLowerCase().includes(area))) return false;
      if (q) {
        const hay = `${t.title || ""} ${t.area || ""} ${t.region || ""} ${t.address || ""} ${(t.owner && t.owner.name) || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    // When the user has located themselves, annotate + sort by distance.
    if (userLoc) {
      out = out.map((t) => ({
        ...t,
        _km: (Number.isFinite(+t.lat) && Number.isFinite(+t.lng))
          ? haversineKm(userLoc.lat, userLoc.lng, +t.lat, +t.lng) : Infinity,
      })).sort((a, b) => a._km - b._km);
    }
    return out;
  }

  function render() {
    const rows = applyFilters();
    countEl.textContent = rows.length
      ? `${rows.length} truck${rows.length === 1 ? "" : "s"}${userLoc ? " — nearest first" : ""}`
      : "";
    renderList(rows);
    renderMarkers(rows);
  }

  function cardHtml(t) {
    const img = photoUrl(t);
    const price = formatPrice(t);
    const badges = [];
    if (Number.isFinite(t._km)) badges.push(`<span class="tc-badge dist">${esc(distanceLabel(t._km))}</span>`);
    if (t.verified) badges.push(`<span class="tc-badge verified">✓ Verified</span>`);
    const tags = [];
    tags.push(TYPE_LABEL[t.truck_type] || "Truck");
    if (t.capacity_tonnes) tags.push(`${t.capacity_tonnes}t`);
    if (t.driver_included) tags.push("Driver");
    if (t.loaders_included) tags.push("Loaders");
    tags.push(SERVICE_LABEL[t.service_area] || "");
    const loc = [t.area, t.region].filter(Boolean).join(", ");
    const photoStyle = img
      ? `background-image:url('${esc(img)}')`
      : "background:#dfe7e2;";
    return `
      <a class="truck-card" href="truck.html?id=${encodeURIComponent(t.id)}">
        <div class="truck-card-photo" style="${photoStyle}">
          ${img ? "" : `<div style="display:flex;height:100%;align-items:center;justify-content:center;font-size:2.4rem;">🚚</div>`}
          <div class="truck-card-badges">${badges.join("")}</div>
        </div>
        <div class="truck-card-body">
          <div class="truck-card-price">from ${price.value} <small>${esc(price.unit)}</small>${t.negotiable ? ' <small>· negotiable</small>' : ""}</div>
          <div class="truck-card-title">${esc(t.title || "Moving truck")}</div>
          <div class="truck-card-meta">${loc ? `<span>📍 ${esc(loc)}</span>` : ""}</div>
          <div class="truck-card-tags">${tags.filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join("")}</div>
        </div>
      </a>`;
  }

  function renderList(rows) {
    listEl.removeAttribute("aria-busy");
    if (!rows.length) {
      listEl.innerHTML = `<div class="trucks-empty">No trucks match your filters yet. Try widening the area or coverage — or <a href="agent-trucks.html">list your own truck</a>.</div>`;
      return;
    }
    listEl.innerHTML = rows.map(cardHtml).join("");
  }

  // ---- map -----------------------------------------------------------------
  function initMap() {
    if (!window.L || !mapEl) return;
    map = L.map(mapEl, { scrollWheelZoom: true }).setView([-6.4, 35.0], 6); // Tanzania
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    }).addTo(map);
  }

  function renderMarkers(rows) {
    if (!map) return;
    markers.forEach((m) => map.removeLayer(m));
    markers.clear();
    const pts = [];
    rows.forEach((t) => {
      const lat = +t.lat, lng = +t.lng;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const price = formatPrice(t);
      const m = L.marker([lat, lng]).addTo(map);
      m.bindPopup(
        `<strong>${esc(t.title || "Moving truck")}</strong><br>` +
        `from ${price.value} ${esc(price.unit)}<br>` +
        `<a href="truck.html?id=${encodeURIComponent(t.id)}">View truck →</a>`
      );
      markers.set(t.id, m);
      pts.push([lat, lng]);
    });
    if (userLoc) pts.push([userLoc.lat, userLoc.lng]);
    if (pts.length) {
      try { map.fitBounds(pts, { padding: [40, 40], maxZoom: 13 }); } catch (_) {}
    }
  }

  // ---- "Near me" -----------------------------------------------------------
  async function locateMe() {
    const idle = nearBtn.innerHTML;
    nearBtn.disabled = true;
    nearBtn.querySelector("span").textContent = "Locating…";
    try {
      const fix = await window.pawaLocate.bestOrApprox({ targetAccuracy: 50, maxWaitMs: 12000 });
      userLoc = { lat: fix.lat, lng: fix.lng };
      nearBtn.querySelector("span").textContent = fix.approximate ? "Approx. location" : "Sorted by distance";
      if (map) {
        if (userMarker) map.removeLayer(userMarker);
        userMarker = L.circleMarker([userLoc.lat, userLoc.lng], {
          radius: 8, color: "#0a6f4d", fillColor: "#0a6f4d", fillOpacity: .9, weight: 2,
        }).addTo(map).bindPopup("You are here");
      }
      render();
    } catch (e) {
      nearBtn.innerHTML = idle;
      alert((e && e.message) ? e.message : "Couldn't get your location. Check location permission and try again.");
    } finally {
      nearBtn.disabled = false;
    }
  }

  // ---- area suggestions ----------------------------------------------------
  function fillAreaDatalist() {
    const areas = Array.from(new Set(trucks.map((t) => t.area).filter(Boolean))).sort();
    areaList.innerHTML = areas.map((a) => `<option value="${esc(a)}"></option>`).join("");
  }

  // ---- wiring --------------------------------------------------------------
  let debTimer = null;
  function debounced(fn) { clearTimeout(debTimer); debTimer = setTimeout(fn, 180); }

  async function init() {
    listEl = $("trucksList"); mapEl = $("trucksMap"); countEl = $("trucksCount"); stageEl = $("trucksStage");
    fType = $("filterType"); fArea = $("filterArea"); fService = $("filterService");
    fCapacity = $("filterCapacity"); fSearch = $("filterSearch"); areaList = $("filterAreaList");
    nearBtn = $("truckNearMeBtn");

    initMap();

    // Filters
    [fType, fService, fCapacity].forEach((el) => el.addEventListener("change", render));
    [fArea, fSearch].forEach((el) => el.addEventListener("input", () => debounced(render)));
    nearBtn.addEventListener("click", locateMe);

    // Mobile list/map tabs
    $("tabList")?.addEventListener("click", () => switchView("list"));
    $("tabMap") ?.addEventListener("click", () => { switchView("map"); setTimeout(() => map && map.invalidateSize(), 60); });

    // Load data
    try {
      trucks = await window.DataStore.getTrucks();
    } catch (e) {
      console.warn("[trucks] load failed:", e);
      trucks = [];
    }
    fillAreaDatalist();
    render();
  }

  function switchView(view) {
    stageEl.dataset.view = view;
    $("tabList").classList.toggle("active", view === "list");
    $("tabMap").classList.toggle("active", view === "map");
  }

  window.initTrucksPage = init;
})();
