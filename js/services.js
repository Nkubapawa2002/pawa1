// Daily-services marketplace directory — browse local service providers,
// filter by category / area / coverage / rate, and sort by distance to find
// the provider nearest you. Public (no auth to browse); data from
// DataStore.getServices() with a JSON fallback so it works before the
// `services` table is applied. Mirrors trucks.js.

(function () {
  "use strict";

  const CATEGORY = {
    cleaning: { label: "Cleaning", emoji: "" },
    plumbing: { label: "Plumbing", emoji: "" },
    electrical: { label: "Electrical", emoji: "" },
    carpentry: { label: "Carpentry", emoji: "" },
    painting: { label: "Painting", emoji: "" },
    gardening: { label: "Gardening", emoji: "" },
    moving_help: { label: "Moving help", emoji: "" },
    laundry: { label: "Laundry", emoji: "" },
    cooking: { label: "Cooking / Chef", emoji: "" },
    tutoring: { label: "Tutoring", emoji: "" },
    beauty: { label: "Beauty & Salon", emoji: "" },
    security: { label: "Security", emoji: "" },
    childcare: { label: "Childcare", emoji: "" },
    appliance_repair: { label: "Appliance repair", emoji: "" },
    other: { label: "Other", emoji: "" },
  };
  const RATE_UNIT = { hourly: "hr", daily: "day", per_job: "job", monthly: "month" };
  const SERVICE_LABEL = { within_city: "Within city", region_wide: "Region-wide", cross_region: "Cross-region" };

  let services = [];
  let map = null;
  let markers = new Map();
  let userLoc = null;
  let userMarker = null;
  // Real road distances (OSRM table) keyed by service id: km | null (no route).
  // Filled in batches after "Near me"; until then cards show direct distance.
  const roadKm = new Map();
  let enriching = false;
  let routeLayer = null;          // the currently drawn road route
  let sortMode = "nearest";       // nearest | cheapest | newest

  let listEl, mapEl, countEl, stageEl;
  let fCat, fArea, fService, fRate, fSearch, areaList, nearBtn, sortSel, chipsEl;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function haversineKm(aLat, aLng, bLat, bLng) {
    const R = 6371, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function photoUrl(s) {
    const p = s.photo || (Array.isArray(s.photos) && s.photos[0]) || "";
    return p && window.DataStore ? window.DataStore.servicePhotoUrl(p) : "";
  }
  function catLabel(c) { return (CATEGORY[c] || CATEGORY.other).label; }
  function catEmoji(c) { return (CATEGORY[c] || CATEGORY.other).emoji; }

  function formatPrice(s) {
    const p = s.price_tzs || 0;
    let value;
    if (p >= 1_000_000) value = (p / 1_000_000).toFixed(p % 1_000_000 === 0 ? 0 : 1) + "M";
    else if (p >= 1_000) value = (p / 1_000).toFixed(0) + "k";
    else value = String(p);
    return { value, unit: `TZS / ${RATE_UNIT[s.rate_type] || "job"}` };
  }
  // ~24 km/h average city driving → honest "about N min" estimate for cards;
  // the EXACT minutes come from OSRM when the user draws the route.
  function driveMin(km) { return Math.max(1, Math.round((km / 24) * 60)); }
  function kmText(km) {
    if (km < 1) return Math.round(km * 1000) + " m";
    return (km < 10 ? km.toFixed(1) : String(Math.round(km))) + " km";
  }
  function distanceLabel(s) {
    if (Number.isFinite(s._roadKm)) return ` ${kmText(s._roadKm)} by road · ~${driveMin(s._roadKm)} min`;
    if (Number.isFinite(s._km)) return `${kmText(s._km)} direct`;
    return "";
  }

  // Batch-resolve REAL road km (one OSRM table call) for rows that still
  // show the straight-line number, then re-render with the exact figures.
  async function enrichRoadDistances(rows) {
    if (!userLoc || !window.pawaRoute || enriching) return;
    const missing = rows.filter((s) =>
      Number.isFinite(+s.lat) && Number.isFinite(+s.lng) && !roadKm.has(s.id)
    ).slice(0, 99);
    if (!missing.length) return;
    enriching = true;
    try {
      const kms = await window.pawaRoute.table(
        userLoc, missing.map((s) => ({ lat: +s.lat, lng: +s.lng })));
      missing.forEach((s, i) =>
        roadKm.set(s.id, Number.isFinite(kms[i]) ? kms[i] : null));
      render();   // swap "direct" badges for road km + minutes
    } catch (_) {
      missing.forEach((s) => roadKm.set(s.id, null));
    } finally {
      enriching = false;
    }
  }

  // Draw the actual driving route(s) to a provider on the map — the visible
  // proof of the distance. When OSRM knows MORE THAN ONE sensible road, every
  // option is drawn and the user taps the line they prefer: the chosen one
  // goes solid green with its exact km + minutes, the rest stay dashed.
  async function drawRouteTo(s) {
    if (!userLoc || !window.pawaRoute || !map) return;
    const dest = { lat: +s.lat, lng: +s.lng };
    if (!Number.isFinite(dest.lat) || !Number.isFinite(dest.lng)) return;
    switchView("map");
    setTimeout(() => map.invalidateSize(), 80);
    const r = await window.pawaRoute.route(userLoc, dest);
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    if (!r || !r.geojson) {
      // Live road routing is down — draw an honest dashed straight-line estimate
      // so the tap always produces a distance, then keep the marker popup open.
      const km = haversineKm(userLoc.lat, userLoc.lng, dest.lat, dest.lng);
      const geom = { type: "LineString", coordinates: [[userLoc.lng, userLoc.lat], [dest.lng, dest.lat]] };
      routeLayer = L.layerGroup().addTo(map);
      L.geoJSON(geom, { interactive: false, style: { color: "#fff", weight: 7, opacity: .9 } }).addTo(routeLayer);
      L.geoJSON(geom, { style: { color: "#b26a00", weight: 4, opacity: .9, dashArray: "4 8" } }).addTo(routeLayer);
      const mk = markers.get(s.id);
      if (mk) {
        mk.bindPopup(
          `<strong>${esc(s.title || catLabel(s.category))}</strong><br>≈ ${km.toFixed(1)} km straight-line` +
          `<br><small>Live road routing unavailable — the road is a bit longer.</small>`).openPopup();
      }
      return;
    }
    const options = [
      { km: r.km, durationMin: r.durationMin, geojson: r.geojson },
      ...(r.alts || []).filter((a) => a && a.geojson),
    ];
    roadKm.set(s.id, options[0].km);   // exact figure beats the table estimate
    render();                          // refresh badges first — render re-fits
                                       // to all markers, route zoom comes after
    routeLayer = L.layerGroup().addTo(map);
    const title = esc(s.title || catLabel(s.category));
    const lines = [];
    const styleFor = (chosen) => chosen
      ? { color: "#0a6f4d", weight: 6, opacity: .95, dashArray: null }
      : { color: "#5e8a79", weight: 4, opacity: .75, dashArray: "7 7" };
    const popupFor = (o, i) =>
      `<strong>${title}</strong><br>` +
      (options.length > 1 ? `Road option ${i + 1} of ${options.length}${o.via ? " —  via " + esc(o.via) : ""}<br>` : (o.via ? ` via ${esc(o.via)}<br>` : "")) +
      ` ${o.km.toFixed(1)} km by road · ${Math.round(o.durationMin)} min drive` +
      (options.length > 1 ? `<br><small>Tap another line to choose that road</small>` : "");
    const choose = (idx) => {
      lines.forEach((ln, i) => ln.setStyle(styleFor(i === idx)));
      lines[idx].bringToFront();
      roadKm.set(s.id, options[idx].km);          // the user's preferred road
      renderList(applyFilters());                  // update the card badge
    };                                             // (no marker re-fit — keep view)
    // White casing under every line first, so the coloured roads stay visible on
    // any basemap (the dark satellite tiles otherwise swallow the green lines).
    options.forEach((o) =>
      L.geoJSON(o.geojson, { interactive: false, style: { color: "#fff", weight: 9, opacity: .9 } }).addTo(routeLayer));
    options.forEach((o, i) => {
      const ln = L.geoJSON(o.geojson, { style: styleFor(i === 0) }).addTo(routeLayer);
      ln.bindPopup(popupFor(o, i));
      ln.on("click", () => choose(i));
      lines.push(ln);
    });
    lines[0].bringToFront();
    try {
      const all = L.featureGroup(lines);
      map.fitBounds(all.getBounds(), { padding: [46, 46] });
    } catch (_) {}
    lines[0].openPopup();
  }

  function applyFilters() {
    const cat = fCat.value;
    const area = fArea.value.trim().toLowerCase();
    const service = fService.value;
    const rate = fRate.value;
    const q = fSearch.value.trim().toLowerCase();

    let out = services.filter((s) => {
      if (cat && s.category !== cat) return false;
      if (service && s.service_area !== service) return false;
      if (rate && s.rate_type !== rate) return false;
      if (area && !((s.area || "").toLowerCase().includes(area) ||
                    (s.address || "").toLowerCase().includes(area) ||
                    (s.region || "").toLowerCase().includes(area))) return false;
      if (q) {
        const hay = `${s.title || ""} ${catLabel(s.category)} ${s.area || ""} ${s.region || ""} ${s.address || ""} ${(s.owner && s.owner.name) || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (userLoc) {
      out = out.map((s) => {
        const has = Number.isFinite(+s.lat) && Number.isFinite(+s.lng);
        const direct = has ? haversineKm(userLoc.lat, userLoc.lng, +s.lat, +s.lng) : Infinity;
        const rk = has ? roadKm.get(s.id) : undefined;
        return { ...s, _km: direct, _roadKm: Number.isFinite(rk) ? rk : undefined };
      });
    }

    // Sort: road km when known, else direct km; cheapest; or newest.
    const sortKm = (s) => (Number.isFinite(s._roadKm) ? s._roadKm : (s._km ?? Infinity));
    if (sortMode === "cheapest") out.sort((a, b) => (+a.price_tzs || 1e15) - (+b.price_tzs || 1e15));
    else if (sortMode === "nearest" && userLoc) out.sort((a, b) => sortKm(a) - sortKm(b));
    // newest = the order DataStore returns (created_at desc)
    return out;
  }

  function render() {
    const rows = applyFilters();
    const enriched = userLoc && rows.some((s) => Number.isFinite(s._roadKm));
    countEl.textContent = rows.length
      ? `${rows.length} provider${rows.length === 1 ? "" : "s"}` +
        (userLoc && sortMode === "nearest"
          ? (enriched ? " — nearest first, by real road distance" : " — nearest first")
          : "")
      : "";
    renderList(rows);
    renderMarkers(rows);
    if (userLoc) enrichRoadDistances(rows);
  }

  function cardHtml(s) {
    const img = photoUrl(s);
    const price = formatPrice(s);
    const badges = [`<span class="sc-badge cat">${catEmoji(s.category)} ${esc(catLabel(s.category))}</span>`];
    const dist = distanceLabel(s);
    if (dist) badges.push(`<span class="sc-badge dist${Number.isFinite(s._roadKm) ? " road" : ""}">${esc(dist)}</span>`);
    if (s.verified) badges.push(`<span class="sc-badge verified"> Verified</span>`);
    const tags = [];
    if (s.experience_years) tags.push(`${s.experience_years} yrs exp`);
    if (s.availability) tags.push(s.availability);
    tags.push(SERVICE_LABEL[s.service_area] || "");
    const loc = [s.area, s.region].filter(Boolean).join(", ");
    const photoStyle = img ? `background-image:url('${esc(img)}')` : "background:#dfe7e2;";
    // Quick actions: contact is the public owner jsonb shown on the page.
    const phone = (s.owner && (s.owner.phone || s.owner.whatsapp)) || s.phone || "";
    const wa = String((s.owner && (s.owner.whatsapp || s.owner.phone)) || "").replace(/[^\d]/g, "");
    const canRoute = userLoc && Number.isFinite(+s.lat) && Number.isFinite(+s.lng);
    const actions = [
      phone ? `<a class="sca-btn call" href="tel:${esc(phone)}"> Call</a>` : "",
      wa ? `<a class="sca-btn wa" href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : "",
      canRoute ? `<button class="sca-btn route" type="button" data-route="${esc(s.id)}" title="Draw the real road route on the map"> Route</button>` : "",
    ].filter(Boolean).join("");
    return `
      <div class="svc-card">
        <a class="svc-card-link" href="service.html?id=${encodeURIComponent(s.id)}">
          <div class="svc-card-photo" style="${photoStyle}">
            ${img ? "" : `<div style="display:flex;height:100%;align-items:center;justify-content:center;font-size:2.4rem;">${catEmoji(s.category)}</div>`}
            <div class="svc-card-badges">${badges.join("")}</div>
          </div>
          <div class="svc-card-body">
            <div class="svc-card-price">from ${price.value} <small>${esc(price.unit)}</small>${s.negotiable ? ' <small>· negotiable</small>' : ""}</div>
            <div class="svc-card-title">${esc(s.title || catLabel(s.category))}</div>
            <div class="svc-card-meta">${loc ? `<span> ${esc(loc)}</span>` : ""}</div>
            <div class="svc-card-tags">${tags.filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join("")}</div>
          </div>
        </a>
        ${actions ? `<div class="svc-card-actions">${actions}</div>` : ""}
      </div>`;
  }

  function renderList(rows) {
    listEl.removeAttribute("aria-busy");
    if (!rows.length) {
      listEl.innerHTML = `<div class="svc-empty">No providers match your filters yet. Try a different category or area — or <a href="agent-services.html">offer your own service</a>.</div>`;
      return;
    }
    listEl.innerHTML = rows.map(cardHtml).join("");
  }

  function initMap() {
    if (!window.L || !mapEl) return;
    map = L.map(mapEl, { scrollWheelZoom: true }).setView([-6.4, 35.0], 6);
    window.addSatelliteHybrid(map);
  }

  function renderMarkers(rows) {
    if (!map) return;
    markers.forEach((m) => map.removeLayer(m));
    markers.clear();
    const pts = [];
    rows.forEach((s) => {
      const lat = +s.lat, lng = +s.lng;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const price = formatPrice(s);
      const m = L.marker([lat, lng]).addTo(map);
      const dist = distanceLabel(s);
      const phone = (s.owner && (s.owner.phone || s.owner.whatsapp)) || s.phone || "";
      m.bindPopup(
        `<strong>${esc(s.title || catLabel(s.category))}</strong><br>` +
        `from ${price.value} ${esc(price.unit)}<br>` +
        (dist ? `${esc(dist)}<br>` : "") +
        (phone ? `<a href="tel:${esc(phone)}"> ${esc(phone)}</a><br>` : "") +
        `<a href="service.html?id=${encodeURIComponent(s.id)}">View provider →</a>`
      );
      markers.set(s.id, m);
      pts.push([lat, lng]);
    });
    if (userLoc) pts.push([userLoc.lat, userLoc.lng]);
    if (pts.length) { try { map.fitBounds(pts, { padding: [40, 40], maxZoom: 13 }); } catch (_) {} }
  }

  async function locateMe() {
    const idle = nearBtn.innerHTML;
    nearBtn.disabled = true;
    nearBtn.querySelector("span").textContent = "Locating…";
    try {
      const fix = await window.pawaLocate.bestOrApprox({ targetAccuracy: 50, maxWaitMs: 12000 });
      userLoc = { lat: fix.lat, lng: fix.lng };
      sortMode = "nearest";
      if (sortSel) sortSel.value = "nearest";
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

  function fillAreaDatalist() {
    const areas = Array.from(new Set(services.map((s) => s.area).filter(Boolean))).sort();
    areaList.innerHTML = areas.map((a) => `<option value="${esc(a)}"></option>`).join("");
  }

  let debTimer = null;
  function debounced(fn) { clearTimeout(debTimer); debTimer = setTimeout(fn, 180); }

  // Horizontal category chip rail — one-tap filtering, synced with the select.
  function buildChips() {
    if (!chipsEl) return;
    const mk = (val, emoji, label) =>
      `<button type="button" class="svc-chip${fCat.value === val ? " active" : ""}" data-cat="${val}">${emoji} ${esc(label)}</button>`;
    chipsEl.innerHTML = mk("", "", "All") +
      Object.entries(CATEGORY).map(([k, v]) => mk(k, v.emoji, v.label)).join("");
    chipsEl.querySelectorAll(".svc-chip").forEach((b) =>
      b.addEventListener("click", () => {
        fCat.value = b.dataset.cat;
        buildChips();
        render();
      }));
  }

  async function init() {
    listEl = $("servicesList"); mapEl = $("servicesMap"); countEl = $("servicesCount"); stageEl = $("servicesStage");
    fCat = $("filterCategory"); fArea = $("filterArea"); fService = $("filterService");
    fRate = $("filterRate"); fSearch = $("filterSearch"); areaList = $("filterAreaList");
    nearBtn = $("svcNearMeBtn"); sortSel = $("svcSort"); chipsEl = $("svcChips");

    initMap();

    // Deep link from the homepage category chips: services.html?cat=cleaning
    const wantCat = new URLSearchParams(location.search).get("cat");
    if (wantCat && CATEGORY[wantCat]) fCat.value = wantCat;
    buildChips();

    [fCat, fService, fRate].forEach((el) => el.addEventListener("change", () => { buildChips(); render(); }));
    [fArea, fSearch].forEach((el) => el.addEventListener("input", () => debounced(render)));
    nearBtn.addEventListener("click", locateMe);
    sortSel?.addEventListener("change", () => { sortMode = sortSel.value; render(); });

    // "Route" buttons live inside cards — one delegated handler.
    listEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-route]");
      if (!btn) return;
      e.preventDefault();
      const s = services.find((x) => String(x.id) === btn.dataset.route);
      if (s) drawRouteTo(s);
    });

    $("tabList")?.addEventListener("click", () => switchView("list"));
    $("tabMap") ?.addEventListener("click", () => { switchView("map"); setTimeout(() => map && map.invalidateSize(), 60); });

    try {
      services = await window.DataStore.getServices();
    } catch (e) {
      console.warn("[services] load failed:", e);
      services = [];
    }
    fillAreaDatalist();
    render();
  }

  function switchView(view) {
    stageEl.dataset.view = view;
    $("tabList").classList.toggle("active", view === "list");
    $("tabMap").classList.toggle("active", view === "map");
  }

  window.initServicesPage = init;
})();
