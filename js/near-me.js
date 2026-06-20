// =====================================================================
// Near Me — unified nearby discovery
// =====================================================================
// From one GPS tap, show BOTH available rooms (house listings) and moving
// trucks around you, merged into a single list sorted nearest-first, with a
// combined map. Reuses the existing plumbing:
//   • DataStore.getHouses() / getTrucks()  — Supabase + JSON fallback
//   • pawaLocate.best()                     — robust GPS w/ friendly errors
//   • haversine distance + Leaflet markers  — same pattern as houses/trucks
//   • formatTZSWithUSD / PawaFX             — live "≈ $" price equivalent
//
// Auto-widen: if nothing falls inside the chosen radius, we expand and show
// the nearest few anyway, annotating how far they are.
(function () {
  "use strict";

  const HOUSE_TYPE_LABEL = {
    house: "House", apartment: "Apartment", room: "Room", studio: "Studio",
    plot: "Plot", office: "Office", shop: "Shop", warehouse: "Warehouse",
    villa: "Villa", other: "Property",
  };
  const TRUCK_TYPE_LABEL = {
    pickup: "Pickup", canter: "Canter", "3ton": "3-tonne",
    "7ton": "7-tonne lorry", "10ton_plus": "10-tonne+ lorry", other: "Truck",
  };
  const SERVICE_LABEL = {
    within_city: "Within city", region_wide: "Region-wide", cross_region: "Cross-region",
  };

  // How far to widen, in order, when the chosen radius is empty. If even the
  // largest ring is empty we fall back to "nearest few" (see selectRows).
  const WIDEN_STEPS = [2, 5, 10, 25, 50, 100, 250];

  let items = [];            // unified, normalised list
  let map = null, markers = [], userMarker = null, routeLayer = null;
  let userLoc = null;
  let userApprox = false;    // true when we fell back to IP/Google (city-level)
  let kindFilter = "all";    // all | rooms | trucks
  let radiusKm = 10;         // 0 = any
  let listingFilter = "";    // "" | rent | sale (rooms only)
  // Real road-distance cache: "oLat,oLng>dLat,dLng" → km, or null when no route.
  const roadKmCache = new Map();
  let enriching = false;

  // DOM refs
  let listEl, mapEl, countEl, nearBtn, kindSel, radiusSel, listingSel, hintEl, stageEl;

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
  function distanceLabel(km) {
    if (!Number.isFinite(km)) return "";
    if (km < 1) return Math.round(km * 1000) + " m away";
    return (km < 10 ? km.toFixed(1) : Math.round(km)) + " km away";
  }
  function compactTZS(p) {
    p = Number(p) || 0;
    if (p >= 1_000_000_000) return (p / 1_000_000_000).toFixed(2) + "B";
    if (p >= 1_000_000)     return (p / 1_000_000).toFixed(p % 1_000_000 === 0 ? 0 : 1) + "M";
    if (p >= 1_000)         return (p / 1_000).toFixed(0) + "k";
    return String(p);
  }
  function fxSmall(tzs) {
    const s = window.PawaFX ? window.PawaFX.format(tzs) : "";
    return s ? ` <small class="nm-fx">${esc(s)}</small>` : "";
  }
  function num(v) { const n = +v; return Number.isFinite(n) ? n : null; }

  // ---- normalise houses + trucks into one shape ----------------------------
  function toRoom(h) {
    return {
      kind: "room",
      id: h.id,
      title: h.title || "Property",
      typeLabel: HOUSE_TYPE_LABEL[h.type] || "Property",
      priceValue: compactTZS(h.price_tzs) + " ",
      priceUnit: h.listing === "sale" ? "TZS" : `TZS / ${h.period || "month"}`,
      priceTzs: Number(h.price_tzs) || 0,
      photo: (window.DataStore && h.photo) ? window.DataStore.housePhotoUrl(h.photo) : "",
      loc: [h.area, h.region].filter(Boolean).join(", "),
      lat: num(h.lat), lng: num(h.lng),
      verified: !!h.verified,
      href: `house.html?id=${encodeURIComponent(h.id)}`,
      emoji: "",
      listing: h.listing || "rent",
      tags: [
        HOUSE_TYPE_LABEL[h.type] || "Property",
        h.listing === "sale" ? "For sale" : "For rent",
        h.bedrooms ? `${h.bedrooms} bed${h.bedrooms !== 1 ? "s" : ""}` : "",
        h.bathrooms ? `${h.bathrooms} bath` : "",
      ].filter(Boolean),
    };
  }
  function toTruck(t) {
    const photo = t.photo || (Array.isArray(t.photos) && t.photos[0]) || "";
    return {
      kind: "truck",
      id: t.id,
      title: t.title || "Moving truck",
      typeLabel: TRUCK_TYPE_LABEL[t.truck_type] || "Truck",
      priceValue: "from " + compactTZS(t.price_tzs) + " ",
      priceUnit: `TZS / ${t.period || "trip"}`,
      priceTzs: Number(t.price_tzs) || 0,
      photo: (window.DataStore && photo) ? window.DataStore.truckPhotoUrl(photo) : "",
      loc: [t.area, t.region].filter(Boolean).join(", "),
      lat: num(t.lat), lng: num(t.lng),
      verified: !!t.verified,
      href: `truck.html?id=${encodeURIComponent(t.id)}`,
      emoji: "",
      listing: null,
      tags: [
        TRUCK_TYPE_LABEL[t.truck_type] || "Truck",
        t.capacity_tonnes ? `${t.capacity_tonnes}t` : "",
        t.driver_included ? "Driver" : "",
        SERVICE_LABEL[t.service_area] || "",
      ].filter(Boolean),
    };
  }

  // ---- selection: filter by kind/listing, then by distance/radius ----------
  function selectRows() {
    let pool = items.filter((it) => {
      if (kindFilter === "rooms"  && it.kind !== "room")  return false;
      if (kindFilter === "trucks" && it.kind !== "truck") return false;
      if (listingFilter && it.kind === "room" && it.listing !== listingFilter) return false;
      return true;
    });

    // No location yet — just show everything (can't rank by distance).
    if (!userLoc) return { rows: pool, widened: false, effKm: null };

    pool = pool.map((it) => ({
      ...it,
      _km: (it.lat != null && it.lng != null)
        ? haversineKm(userLoc.lat, userLoc.lng, it.lat, it.lng) : Infinity,
    })).sort((a, b) => a._km - b._km);

    // "Any" radius → everything, nearest first.
    if (!radiusKm) return { rows: pool, widened: false, effKm: null };

    // Generous straight-line gate (×1.5) so no real match is missed; render()
    // then tightens to the EXACT radius by road distance once routes resolve.
    const within = pool.filter((it) => it._km <= radiusKm * 1.5);
    if (within.length) return { rows: within, widened: false, effKm: radiusKm };

    // Auto-widen: step out until something appears, else show nearest with coords.
    for (const step of WIDEN_STEPS) {
      if (step <= radiusKm) continue;
      const hits = pool.filter((it) => it._km <= step);
      if (hits.length) return { rows: hits, widened: true, effKm: step };
    }
    const withCoords = pool.filter((it) => Number.isFinite(it._km));
    return { rows: withCoords.slice(0, 12), widened: withCoords.length > 0, effKm: null };
  }

  // ---- render --------------------------------------------------------------
  function cardHtml(it) {
    const badges = [];
    badges.push(`<span class="nm-badge kind ${it.kind}">${it.kind === "room" ? "Room" : "Truck"}</span>`);
    // REAL road distance only. Until a routing engine answers, say "measuring…"
    // rather than a crow-flies "X km away" that overstates how close it is.
    if (it._byRoad && Number.isFinite(it._dispKm)) {
      badges.push(`<span class="nm-badge dist"> ${esc(distanceLabel(it._dispKm).replace(" away", " by road"))}</span>`);
    } else if (Number.isFinite(it._km)) {
      badges.push(`<span class="nm-badge dist measuring">measuring road…</span>`);
    }
    if (it.verified) badges.push(`<span class="nm-badge verified"></span>`);
    const photoStyle = it.photo ? `background-image:url('${esc(it.photo)}')` : "background:#dfe7e2;";
    return `
      <a class="nm-card" href="${it.href}">
        <div class="nm-card-photo" style="${photoStyle}">
          ${it.photo ? "" : `<div class="nm-card-emoji">${it.emoji}</div>`}
          <div class="nm-card-badges">${badges.join("")}</div>
        </div>
        <div class="nm-card-body">
          <div class="nm-card-price">${esc(it.priceValue)}<small>${esc(it.priceUnit)}</small>${fxSmall(it.priceTzs)}</div>
          <div class="nm-card-title">${esc(it.title)}</div>
          <div class="nm-card-meta">${it.loc ? ` ${esc(it.loc)}` : `<span class="nm-card-emoji-inline">${it.emoji}</span> ${esc(it.typeLabel)}`}</div>
          <div class="nm-card-tags">${it.tags.map((x) => `<span>${esc(x)}</span>`).join("")}</div>
        </div>
      </a>`;
  }

  // Stable key for one origin→destination road distance.
  function roadKey(it) {
    return `${userLoc.lat.toFixed(4)},${userLoc.lng.toFixed(4)}>${(+it.lat).toFixed(4)},${(+it.lng).toFixed(4)}`;
  }

  // Fetch REAL driving distances for the shown rows (one OSRM matrix call),
  // cache them, then re-render so the list ranks + labels by road distance.
  async function enrichRoadDistances(rows) {
    if (!userLoc || enriching || !window.pawaRoute) return;
    const missing = rows.filter((r) =>
      Number.isFinite(r._km) && r.lat != null && r.lng != null &&
      roadKmCache.get(roadKey(r)) === undefined
    ).slice(0, 60);
    if (!missing.length) return;
    enriching = true;
    try {
      const kms = await window.pawaRoute.table(userLoc, missing.map((r) => ({ lat: +r.lat, lng: +r.lng })));
      let changed = false;
      missing.forEach((r, i) => {
        const v = kms && kms[i];
        roadKmCache.set(roadKey(r), Number.isFinite(v) ? v : null);  // null = no route (don't refetch)
        if (Number.isFinite(v)) changed = true;
      });
      if (changed) render();
    } finally { enriching = false; }
  }

  function render() {
    const sel = selectRows();
    let rows = sel.rows;
    const widened = sel.widened, effKm = sel.effKm;

    // Prefer real road distance where we've computed it; rank by it.
    if (userLoc) {
      rows = rows.map((r) => {
        const rk = (r.lat != null && r.lng != null) ? roadKmCache.get(roadKey(r)) : undefined;
        const byRoad = rk != null;
        return { ...r, _dispKm: byRoad ? rk : r._km, _byRoad: byRoad };
      }).sort((a, b) => (a._dispKm ?? Infinity) - (b._dispKm ?? Infinity));
      // Tighten the radius to EXACT road distance: drop items already routed and
      // found to be beyond the radius by road. Not-yet-routed items stay until
      // enrichment resolves them (then a re-render drops any that exceed it).
      if (radiusKm) rows = rows.filter((r) => !r._byRoad || r._dispKm <= radiusKm);
    }

    // Count + status line
    const nRooms  = rows.filter((r) => r.kind === "room").length;
    const nTrucks = rows.filter((r) => r.kind === "truck").length;
    if (countEl) {
      countEl.textContent = rows.length
        ? `${rows.length} nearby — ${nRooms} room${nRooms !== 1 ? "s" : ""}, ${nTrucks} truck${nTrucks !== 1 ? "s" : ""}${userLoc ? " · nearest first" : ""}`
        : "";
    }

    // Hint line — composes the locate prompt, an approximate-location notice,
    // and the auto-widen note as applicable.
    if (hintEl) {
      const parts = [];
      if (!userLoc) {
        parts.push("Tap “Use my location” to sort rooms and trucks by how close they are to you.");
      } else {
        if (userApprox) parts.push(" Using an approximate (city-level) location — turn on GPS / allow precise location for exact distances.");
        if (widened) parts.push(effKm
          ? `Nothing within ${radiusKm} km — showing the nearest within ${effKm} km instead.`
          : `Nothing within ${radiusKm} km — showing the nearest listings instead.`);
      }
      hintEl.textContent = parts.join("  ");
      hintEl.hidden = parts.length === 0;
    }

    renderList(rows);
    renderMarkers(rows);

    // After painting (instant, straight-line), upgrade to real road distances.
    if (userLoc) enrichRoadDistances(rows);
  }

  function renderList(rows) {
    listEl.removeAttribute("aria-busy");
    if (!rows.length) {
      listEl.innerHTML = `<div class="nm-empty">Nothing to show yet. Try “All”, widen the radius, or check back soon as more rooms and trucks get listed.</div>`;
      return;
    }
    listEl.innerHTML = rows.map(cardHtml).join("");
  }

  // ---- map -----------------------------------------------------------------
  function initMap() {
    if (!window.L || !mapEl) return;
    map = L.map(mapEl, { scrollWheelZoom: true }).setView([-6.4, 35.0], 6); // Tanzania
    window.addSatelliteHybrid(map);
  }

  // Draw the real driving route(s) (origin = user) on the map, so the distance
  // is visible as the actual road, not a straight line. When more than one
  // road reaches the place — including ferry crossings the default search
  // skips — EVERY option is drawn and the user taps the line they prefer:
  // the chosen one goes solid green with its exact km + minutes.
  async function drawRouteTo(it) {
    if (!map || !userLoc || it.lat == null || it.lng == null || !window.pawaRoute) return;
    const r = await window.pawaRoute.route(userLoc, { lat: +it.lat, lng: +it.lng });
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    if (!r || !r.geojson) {
      // No routing engine (OSRM ×2 + Valhalla) could measure it — show the honest
      // state at the destination instead of drawing a misleading straight line.
      routeLayer = L.layerGroup().addTo(map);
      L.popup().setLatLng([+it.lat, +it.lng])
        .setContent(`<strong>${esc(it.title)}</strong><br><small>Couldn’t measure the road distance right now — please try again.</small>`)
        .openOn(map);
      return;
    }
    const options = [
      { km: r.km, durationMin: r.durationMin, geojson: r.geojson, via: r.via },
      ...(r.alts || []).filter((a) => a && a.geojson),
    ];
    routeLayer = L.layerGroup().addTo(map);
    const lines = [];
    const styleFor = (chosen) => chosen
      ? { color: "#0a6f4d", weight: 6, opacity: .95, dashArray: null }
      : { color: "#5e8a79", weight: 4, opacity: .75, dashArray: "7 7" };
    const popupFor = (o, i) =>
      `<strong>${esc(it.title)}</strong><br>` +
      (options.length > 1 ? `Road option ${i + 1} of ${options.length}${o.via ? " —  via " + esc(o.via) : ""}<br>` : (o.via ? ` via ${esc(o.via)}<br>` : "")) +
      ` ${o.km.toFixed(1)} km by road · ${Math.round(o.durationMin)} min drive` +
      (options.length > 1 ? `<br><small>Tap another line to choose that road</small>` : "");
    const choose = (idx) => {
      lines.forEach((ln, i) => ln.setStyle(styleFor(i === idx)));
      lines[idx].bringToFront();
      // The user's preferred road becomes the item's displayed distance.
      if (it.lat != null && it.lng != null) roadKmCache.set(roadKey(it), options[idx].km);
    };
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
      const b = lines.reduce((bb, l) => bb ? bb.extend(l.getBounds()) : l.getBounds(), null);
      if (b) map.fitBounds(b.pad(0.25));
    } catch (_) {}
    lines[0].openPopup();
  }

  function renderMarkers(rows) {
    if (!map) return;
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    const pts = [];
    rows.forEach((it) => {
      if (it.lat == null || it.lng == null) return;
      const icon = L.divIcon({
        className: "nm-pin",
        html: `<div class="nm-pin-dot ${it.kind}">${it.emoji}</div>`,
        iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14],
      });
      const m = L.marker([it.lat, it.lng], { icon }).addTo(map);
      m.bindPopup(
        `<strong>${esc(it.title)}</strong><br>` +
        `${esc(it.priceValue)}${esc(it.priceUnit)}<br>` +
        (userLoc ? `<button type="button" class="nm-route-btn" style="margin:4px 0;border:0;background:#0a6f4d;color:#fff;border-radius:6px;padding:4px 8px;cursor:pointer;font-weight:600;"> Show road route</button><br>` : "") +
        `<a href="${it.href}">View ${it.kind === "room" ? "room" : "truck"} →</a>`
      );
      m.on("popupopen", (e) => {
        e.popup.getElement()?.querySelector(".nm-route-btn")?.addEventListener("click", () => drawRouteTo(it));
      });
      markers.push(m);
      pts.push([it.lat, it.lng]);
    });
    if (userLoc) pts.push([userLoc.lat, userLoc.lng]);
    if (pts.length) {
      try { map.fitBounds(pts, { padding: [40, 40], maxZoom: 14 }); } catch (_) {}
    }
  }

  // ---- locate --------------------------------------------------------------
  async function locateMe() {
    const span = nearBtn.querySelector("span");
    const idleText = span ? span.textContent : "Use my location";
    nearBtn.disabled = true;
    if (span) span.textContent = "Locating…";
    try {
      const fix = await window.pawaLocate.bestOrApprox({ targetAccuracy: 50, maxWaitMs: 12000 });
      userLoc = { lat: fix.lat, lng: fix.lng };
      userApprox = !!fix.approximate;
      if (span) span.textContent = userApprox ? "Approx. location" : "Sorted by distance";
      if (map) {
        if (userMarker) map.removeLayer(userMarker);
        userMarker = L.circleMarker([userLoc.lat, userLoc.lng], {
          radius: 8, color: "#0a6f4d", fillColor: "#0a6f4d", fillOpacity: .9, weight: 2,
        }).addTo(map).bindPopup("You are here");
      }
      render();
    } catch (e) {
      if (span) span.textContent = idleText;
      alert(window.pawaLocate ? window.pawaLocate.message(e) :
        ((e && e.message) || "Couldn't get your location."));
    } finally {
      nearBtn.disabled = false;
    }
  }

  // ---- AI search: natural-language query → centre map + filter -------------
  // "2-bed for rent near Mikocheni" / "trucks near Mwanza". Uses the ai-search
  // brain to extract the place + listing, geocodes the place, then re-runs the
  // normal distance selection from there. Degrades to a plain geocode of the
  // typed text when the AI brain is unavailable.
  async function aiSearch() {
    const input = $("nmAi"), btn = $("nmAiBtn"), msgEl = $("nmAiMsg");
    const q = (input?.value || "").trim();
    const setMsg = (t) => { if (msgEl) msgEl.textContent = t || ""; };
    if (!q) { input?.focus(); return; }
    const old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Searching…"; }
    setMsg("");
    try {
      let anchor = null, answer = "", listing = null, wantTrucks = false;
      if (window.AISearch && window.AISearch.available && window.AISearch.available()) {
        const parsed = await window.AISearch.parseHouse(q).catch(() => null);
        if (parsed) {
          anchor = parsed.anchor;
          answer = parsed.answer || "";
          listing = parsed.criteria && parsed.criteria.listing;
        }
      }
      if (/\btruck|lorry|canter|pickup|magari ya mizigo|gari la mizigo\b/i.test(q)) wantTrucks = true;

      if (anchor && anchor.name === "__me__") {
        await locateMe();
      } else {
        const placeQ = (anchor && anchor.name) || q;
        const hits = await (window.pawaGeo ? window.pawaGeo.suggest(placeQ, { limit: 5 }) : Promise.resolve([])).catch(() => []);
        const hit = (hits || []).find((h) => Number.isFinite(h.lat) && Number.isFinite(h.lng));
        if (!hit) { setMsg("Couldn't find that place — try a town or area name."); return; }
        userLoc = { lat: hit.lat, lng: hit.lng }; userApprox = false;
        if (map) {
          if (userMarker) map.removeLayer(userMarker);
          userMarker = L.circleMarker([hit.lat, hit.lng], {
            radius: 8, color: "#0a6f4d", fillColor: "#0a6f4d", fillOpacity: .9, weight: 2,
          }).addTo(map).bindPopup(esc(hit.name || "Search area"));
          map.setView([hit.lat, hit.lng], 13);
        }
      }
      // Reflect inferred filters in the controls.
      if (wantTrucks && kindSel) { kindFilter = "trucks"; kindSel.value = "trucks"; if (listingSel) listingSel.disabled = true; }
      if (listing && listingSel && !listingSel.disabled) { listingFilter = listing; listingSel.value = listing; }
      render();
      const where = (anchor && anchor.name && anchor.name !== "__me__") ? anchor.name : "you";
      setMsg(answer || ("Showing results near " + where + "."));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old; }
    }
  }

  // ---- mobile list/map tabs ------------------------------------------------
  function switchView(view) {
    if (!stageEl) return;
    stageEl.dataset.view = view;
    document.getElementById("tabList")?.classList.toggle("active", view === "list");
    document.getElementById("tabMap")?.classList.toggle("active", view === "map");
  }

  // ---- init ----------------------------------------------------------------
  async function init() {
    listEl = $("nmList"); mapEl = $("nmMap"); countEl = $("nmCount");
    nearBtn = $("nmNearBtn"); kindSel = $("nmKind"); radiusSel = $("nmRadius");
    listingSel = $("nmListing"); hintEl = $("nmHint"); stageEl = $("nmStage");

    initMap();

    nearBtn?.addEventListener("click", locateMe);
    $("nmAiBtn")?.addEventListener("click", aiSearch);
    $("nmAi")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); aiSearch(); } });
    kindSel?.addEventListener("change", () => {
      kindFilter = kindSel.value;
      if (listingSel) listingSel.disabled = kindFilter === "trucks";
      render();
    });
    radiusSel?.addEventListener("change", () => { radiusKm = parseFloat(radiusSel.value) || 0; render(); });
    listingSel?.addEventListener("change", () => { listingFilter = listingSel.value; render(); });

    $("tabList")?.addEventListener("click", () => switchView("list"));
    $("tabMap") ?.addEventListener("click", () => { switchView("map"); setTimeout(() => map && map.invalidateSize(), 60); });

    // Load both datasets in parallel; either failing still shows the other.
    const [hRes, tRes] = await Promise.allSettled([
      window.DataStore.getHouses(),
      window.DataStore.getTrucks(),
    ]);
    const houses = hRes.status === "fulfilled" && Array.isArray(hRes.value) ? hRes.value : [];
    const trucks = tRes.status === "fulfilled" && Array.isArray(tRes.value) ? tRes.value : [];
    // Hide houses whose deal is completed (available === false) from the public map.
    items = houses.filter((h) => h.available !== false).map(toRoom).concat(trucks.map(toTruck));

    render();

    // Re-render once live FX rates land so prices gain their "≈ $" equivalent.
    if (window.PawaFX && window.PawaFX.ready) window.PawaFX.ready.then(render);
  }

  window.initNearMePage = init;
})();
