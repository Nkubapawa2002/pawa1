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
  let map = null, markers = [], userMarker = null;
  let userLoc = null;
  let userApprox = false;    // true when we fell back to IP/Google (city-level)
  let kindFilter = "all";    // all | rooms | trucks
  let radiusKm = 10;         // 0 = any
  let listingFilter = "";    // "" | rent | sale (rooms only)

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
      emoji: "🏠",
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
      emoji: "🚚",
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

    const within = pool.filter((it) => it._km <= radiusKm);
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
    if (Number.isFinite(it._km)) badges.push(`<span class="nm-badge dist">${esc(distanceLabel(it._km))}</span>`);
    if (it.verified) badges.push(`<span class="nm-badge verified">✓</span>`);
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
          <div class="nm-card-meta">${it.loc ? `📍 ${esc(it.loc)}` : `<span class="nm-card-emoji-inline">${it.emoji}</span> ${esc(it.typeLabel)}`}</div>
          <div class="nm-card-tags">${it.tags.map((x) => `<span>${esc(x)}</span>`).join("")}</div>
        </div>
      </a>`;
  }

  function render() {
    const { rows, widened, effKm } = selectRows();

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
        if (userApprox) parts.push("📍 Using an approximate (city-level) location — turn on GPS / allow precise location for exact distances.");
        if (widened) parts.push(effKm
          ? `Nothing within ${radiusKm} km — showing the nearest within ${effKm} km instead.`
          : `Nothing within ${radiusKm} km — showing the nearest listings instead.`);
      }
      hintEl.textContent = parts.join("  ");
      hintEl.hidden = parts.length === 0;
    }

    renderList(rows);
    renderMarkers(rows);
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
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap &copy; CARTO",
    }).addTo(map);
  }

  function renderMarkers(rows) {
    if (!map) return;
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
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
        `<a href="${it.href}">View ${it.kind === "room" ? "room" : "truck"} →</a>`
      );
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
    items = houses.map(toRoom).concat(trucks.map(toTruck));

    render();

    // Re-render once live FX rates land so prices gain their "≈ $" equivalent.
    if (window.PawaFX && window.PawaFX.ready) window.PawaFX.ready.then(render);
  }

  window.initNearMePage = init;
})();
