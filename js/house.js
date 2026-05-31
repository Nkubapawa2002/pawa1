// ============================================================================
//  House detail page  (house.html?id=h-001)
//  - Loads the single property from DataStore.getHouses() (DB or fallback)
//  - Renders photo, header, stats, description, amenities, map, agent card
//  - Wires Call / WhatsApp / Request-viewing / Get-directions actions
//  - "Request viewing" auto-generates a Pawa Meet room code and pre-fills a
//    WhatsApp message to the agent with the deep-link join URL — re-uses
//    the existing meet.html live-location flow with zero extra wiring.
//  - Favorites kept in localStorage["pawa_house_favs"] (no auth needed)
// ============================================================================

window.initHousePage = async () => {
  const bodyEl   = document.getElementById("hdBody");
  const stickyEl = document.getElementById("hdSticky");
  const params   = new URLSearchParams(location.search);
  const id       = params.get("id");

  if (!id) {
    bodyEl.setAttribute("aria-busy", "false");
    bodyEl.innerHTML = emptyState({
      title: "No listing selected",
      sub: "Open a property from the houses directory to see its details.",
      ctaHref: "houses.html",
      ctaLabel: "Browse listings"
    });
    return;
  }

  // Skeleton is already in the DOM (from the HTML). Just wait for data.
  let h;
  try {
    const all = await window.DataStore.getHouses();
    h = all.find(x => x.id === id);
  } catch (e) {
    bodyEl.setAttribute("aria-busy", "false");
    bodyEl.innerHTML = emptyState({
      title: "Couldn't load this listing",
      sub: esc(e.message || String(e)),
      ctaHref: "javascript:location.reload()",
      ctaLabel: "Try again",
      danger: true
    });
    return;
  }

  if (!h) {
    bodyEl.setAttribute("aria-busy", "false");
    bodyEl.innerHTML = emptyState({
      title: "Listing not found",
      sub: `No property with id "${esc(id)}" is currently listed. It may have been removed.`,
      ctaHref: "houses.html",
      ctaLabel: "Back to listings"
    });
    return;
  }
  bodyEl.setAttribute("aria-busy", "false");

  // Set the page title so browser tabs / WhatsApp previews look right.
  document.title = `${h.title} — Pawa Houses`;

  render(h);
};

// ============================================================================
// Render
// ============================================================================
function render(h) {
  const bodyEl   = document.getElementById("hdBody");
  const stickyEl = document.getElementById("hdSticky");

  // Media: combine photos[] and videos[] into one carousel. Back-compat:
  // if the row predates the multi-media migration, photos[] is empty so we
  // fall back to the single `photo` column.
  const photoList = (Array.isArray(h.photos) && h.photos.length)
    ? h.photos
    : (h.photo ? [h.photo] : []);
  const videoList = Array.isArray(h.videos) ? h.videos : [];
  const slides = [
    ...photoList.map(p => ({ kind: "photo", url: window.DataStore.housePhotoUrl(p) })),
    ...videoList.map(v => ({ kind: "video", url: window.DataStore.housePhotoUrl(v) })),
  ];
  if (!slides.length) {
    slides.push({ kind: "photo", url: "data/tierra-mallorca-rgJ1J8SDEAY-unsplash.jpg" });
  }

  const listing  = h.listing === "sale" ? "For sale" : "For rent";
  const price    = formatPrice(h);
  const verified = h.verified ? `<span class="hd-badge verified">✓ Verified</span>` : "";
  const typeBadge = `<span class="hd-badge type-${h.type || "house"}">${labelType(h.type)}</span>`;
  const isFav    = getFavs().has(h.id);

  // Stats — only show ones that make sense for the type.
  const stats = [];
  if (h.bedrooms)   stats.push(stat("🛏", h.bedrooms,   "Bedrooms"));
  if (h.bathrooms)  stats.push(stat("🛁", h.bathrooms,  "Bathrooms"));
  if (h.size_sqm)   stats.push(stat("📐", h.size_sqm + " m²", "Size"));
  if (h.furnished && h.furnished !== "n/a" && h.furnished !== "no")
    stats.push(stat("🛋", h.furnished === "yes" ? "Yes" : "Semi", "Furnished"));
  if (h.available_from)
    stats.push(stat("📅", formatDate(h.available_from), "Available"));

  // Amenities list
  const amenitiesHtml = (h.amenities || []).length
    ? `<div class="hd-chips">${h.amenities.map(a => `<span class="hd-chip">${amenityIcon(a)} ${labelAmenity(a)}</span>`).join("")}</div>`
    : `<p class="muted">No amenities listed.</p>`;

  // Agent
  const agentName  = h.agent?.name  || "Listing agent";
  const agentPhone = h.agent?.phone || "";
  const agentPhoneClean = agentPhone.replace(/\s+/g, "");
  const waNumber   = agentPhone.replace(/^\+/, "").replace(/\s+/g, "");
  const initials   = agentName.split(/\s+/).map(w => w[0]).join("").slice(0,2).toUpperCase();

  // Maps / viewing links
  const mapsUrl    = `https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}`;
  const meetCode   = roomCodeFor(h.id);
  const meetUrl    = `${location.origin}${location.pathname.replace(/[^/]*$/, "")}meet.html?code=${meetCode}`;
  const waText     = encodeURIComponent(
    `Hi ${agentName}, I'm interested in your listing on Pawa Houses:\n` +
    `"${h.title}" (${listing}, ${price.value} ${price.unit}).\n` +
    `Could we do a live viewing? Join me on Pawa Live Meet — code ${meetCode}: ${meetUrl}`);
  const waHref     = waNumber ? `https://wa.me/${waNumber}?text=${waText}` : "";

  // Build the slide and thumbnail markup for the carousel.
  const slidesHtml = slides.map((s, i) => s.kind === "video"
    ? `<div class="hd-gallery-slide is-video" data-i="${i}">
         <video src="${esc(s.url)}" controls playsinline preload="${i === 0 ? "metadata" : "none"}"></video>
       </div>`
    : `<div class="hd-gallery-slide" data-i="${i}">
         <img src="${esc(s.url)}" alt="${esc(h.title)} — photo ${i + 1}"
              loading="${i === 0 ? "eager" : "lazy"}" decoding="async">
       </div>`).join("");

  const thumbsHtml = slides.length > 1 ? `
    <div class="hd-gallery-thumbs" id="hdGalleryThumbs" role="tablist" aria-label="Media">
      ${slides.map((s, i) => s.kind === "video"
        ? `<button type="button" class="hd-gallery-thumb ${i === 0 ? "active" : ""}" data-i="${i}" role="tab"
                   aria-label="Open video ${i + 1 - photoList.length}">
             <video src="${esc(s.url)}" muted playsinline preload="metadata"></video>
             <span class="vbadge">▶</span>
           </button>`
        : `<button type="button" class="hd-gallery-thumb ${i === 0 ? "active" : ""}" data-i="${i}" role="tab"
                   aria-label="Open photo ${i + 1}">
             <img src="${esc(s.url)}" alt="" loading="lazy" decoding="async">
           </button>`).join("")}
    </div>` : "";

  const dotsHtml = slides.length > 1 ? `
    <div class="hd-gallery-dots" aria-hidden="true">
      ${slides.map((_, i) => `<span class="hd-gallery-dot ${i === 0 ? "active" : ""}" data-i="${i}"></span>`).join("")}
    </div>` : "";

  bodyEl.innerHTML = `
    <!-- Media gallery -->
    <div class="hd-gallery">
      <div class="hd-gallery-stage" id="hdGalleryStage">${slidesHtml}</div>
      <div class="hd-hero-badges">
        <span class="hd-badge">${listing}</span>
        ${typeBadge}
        ${verified}
      </div>
      <div class="hd-hero-actions">
        <button id="hdFavBtn" class="hd-icon-btn ${isFav ? 'fav-active' : ''}" aria-label="Save to favourites" title="Save to favourites">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        </button>
        <button id="hdShareBtn" class="hd-icon-btn" aria-label="Share this listing" title="Share">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        </button>
      </div>
      ${slides.length > 1 ? `
        <button type="button" class="hd-gallery-nav prev" id="hdGalleryPrev" aria-label="Previous">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <button type="button" class="hd-gallery-nav next" id="hdGalleryNext" aria-label="Next">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <div class="hd-gallery-counter" id="hdGalleryCounter">1 / ${slides.length}</div>
        ${dotsHtml}
      ` : ""}
      ${thumbsHtml}
    </div>

    <!-- Header (title + price) -->
    <div class="hd-header">
      <h1 class="hd-title">${esc(h.title)}</h1>
      <div class="hd-loc">📍 ${esc(h.area || "")}${h.region ? ", " + esc(h.region) : ""}${h.address ? " · " + esc(h.address) : ""}</div>
      <div class="hd-price">${price.value} <small>${price.unit}</small></div>
      ${stats.length ? `<div class="hd-stats">${stats.join("")}</div>` : ""}
    </div>

    ${h.description ? `
    <div class="hd-card">
      <h3>About this property</h3>
      <p>${esc(h.description)}</p>
    </div>` : ""}

    <div class="hd-card">
      <h3>Amenities</h3>
      ${amenitiesHtml}
    </div>

    <div class="hd-card">
      <h3>Where it is</h3>
      <div class="hd-map" id="hdMap"></div>
      <div class="hd-map-actions">
        <a href="${mapsUrl}" target="_blank" rel="noopener">🧭 Get directions</a>
        <a href="meet.html?code=${meetCode}" target="_blank" rel="noopener">📍 Live meet with agent</a>
      </div>
    </div>

    <div class="hd-card">
      <h3>Listing agent</h3>
      <div class="hd-agent">
        <div class="hd-agent-avatar">${esc(initials || "?")}</div>
        <div class="hd-agent-meta">
          <div class="hd-agent-name">${esc(agentName)}</div>
          <div class="hd-agent-role">Verified by Pawa · responds within 1 day</div>
        </div>
      </div>
      <div class="hd-cta-row hd-cta-row-mobile-hide">
        ${agentPhone ? `<a class="hd-cta hd-cta-call" href="tel:${agentPhoneClean}">📞 Call</a>` : ""}
        ${waHref     ? `<a class="hd-cta hd-cta-wa"   href="${waHref}"  target="_blank" rel="noopener">💬 WhatsApp</a>` : ""}
        <a class="hd-cta hd-cta-meet" href="meet.html?code=${meetCode}" target="_blank" rel="noopener">📍 Request live viewing</a>
      </div>
    </div>
  `;

  // Wire up the media carousel (prev/next, dots, thumbnails, scroll-snap
  // keeps the active index in sync, videos pause when scrolled away).
  if (slides.length > 1) wireGallery(slides.length);
  else hookSingleVideoAutopause(bodyEl);

  // ---- Wire up actions ---------------------------------------------------
  // Favorite (also records save-order so the favorites page can sort by
  // "recently saved" without needing a per-id timestamp)
  document.getElementById("hdFavBtn")?.addEventListener("click", () => {
    const favs = getFavs();
    let order; try { order = JSON.parse(localStorage.getItem("pawa_house_fav_order") || "[]"); }
                catch { order = []; }
    if (favs.has(h.id)) {
      favs.delete(h.id);
      order = order.filter(x => x !== h.id);
    } else {
      favs.add(h.id);
      // Move to the end so it sorts as the most recent.
      order = order.filter(x => x !== h.id);
      order.push(h.id);
    }
    localStorage.setItem("pawa_house_favs", JSON.stringify([...favs]));
    localStorage.setItem("pawa_house_fav_order", JSON.stringify(order));
    const btn = document.getElementById("hdFavBtn");
    const nowFav = favs.has(h.id);
    btn.classList.toggle("fav-active", nowFav);
    btn.querySelector("svg")?.setAttribute("fill", nowFav ? "currentColor" : "none");
  });

  // Share
  document.getElementById("hdShareBtn")?.addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}?id=${h.id}`;
    const text = `${h.title} — ${price.value} ${price.unit} on Pawa Houses`;
    if (navigator.share) {
      try { await navigator.share({ title: h.title, text, url }); } catch (_) {}
      return;
    }
    // Clipboard API can fail on insecure contexts (http://, some in-app
    // browsers) or when the user has blocked clipboard access. Fall back
    // to a hidden <input> + execCommand("copy"), and as a last resort
    // prompt() so the link is at least selectable.
    try {
      await navigator.clipboard.writeText(url);
      alert("Link copied to clipboard");
    } catch (_) {
      try {
        const tmp = document.createElement("input");
        tmp.value = url;
        tmp.style.cssText = "position:fixed;top:-1000px;opacity:0";
        document.body.appendChild(tmp);
        tmp.select();
        const ok = document.execCommand("copy");
        tmp.remove();
        if (ok) alert("Link copied to clipboard");
        else window.prompt("Copy this link:", url);
      } catch (_2) {
        window.prompt("Copy this link:", url);
      }
    }
  });

  // Sticky bottom CTAs (phones)
  if (agentPhone) {
    document.getElementById("hdStickyCall").href = `tel:${agentPhoneClean}`;
    document.getElementById("hdStickyWa").href   = waHref;
    document.getElementById("hdStickyMeet").href = `meet.html?code=${meetCode}`;
    stickyEl.hidden = false;
  }

  // ---- Map (centered on the pin, satellite + street labels) -------------
  if (h.lat != null && h.lng != null) {
    const map = new maplibregl.Map({
      container: "hdMap",
      style: {
        version: 8,
        sources: {
          esri: { type: "raster",
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256, maxzoom: 19, attribution: "Tiles © Esri" },
          carto: { type: "raster",
            tiles: [
              "https://a.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
              "https://b.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png"
            ],
            tileSize: 256, maxzoom: 19,
            attribution: "© CARTO © OpenStreetMap contributors" }
        },
        layers: [
          { id: "esri",  type: "raster", source: "esri" },
          { id: "carto", type: "raster", source: "carto", minzoom: 11 }
        ]
      },
      center: [h.lng, h.lat],
      zoom: 15,
      maxBounds: [[29.34, -11.75], [40.45, -0.99]]
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    const pin = document.createElement("div");
    pin.innerHTML = `
      <svg width="32" height="42" viewBox="0 0 32 42" fill="none">
        <path d="M16 0C7.2 0 0 7.2 0 16c0 12 16 26 16 26s16-14 16-26C32 7.2 24.8 0 16 0z" fill="#0a6f4d" stroke="#fff" stroke-width="2"/>
        <circle cx="16" cy="16" r="6" fill="#fff"/>
      </svg>`;
    new maplibregl.Marker({ element: pin, anchor: "bottom" })
      .setLngLat([h.lng, h.lat])
      .addTo(map);

    // Nearby amenities overlay (schools, hospitals, markets, transport)
    attachNearbyOverlay(map, h.lat, h.lng);
  } else {
    document.getElementById("hdMap").innerHTML =
      `<div class="hd-state" style="margin:0;border-radius:0;height:100%"><p>No pin set for this listing yet.</p></div>`;
  }
}

// ============================================================================
// Nearby amenities (Overpass / OpenStreetMap, free, no API key)
// ============================================================================
// Full set of "nearby infrastructure" categories per SKILL.md 3.2 — all
// fetched live from OpenStreetMap via the Overpass API. Categories are
// loaded lazily on first chip-tap (and the first two are auto-loaded
// when the map opens so the buyer gets immediate context).
const POI_CATS = [
  { key: "school",     label: "Schools",     icon: "🏫", color: "#1e40af",
    q: 'node["amenity"~"school|university|college|kindergarten"](around:RADIUS,LAT,LNG);way["amenity"~"school|university|college|kindergarten"](around:RADIUS,LAT,LNG);' },
  { key: "hospital",   label: "Hospitals",   icon: "🏥", color: "#b91c1c",
    q: 'node["amenity"~"hospital|clinic|doctors|pharmacy"](around:RADIUS,LAT,LNG);way["amenity"~"hospital|clinic"](around:RADIUS,LAT,LNG);' },
  { key: "market",     label: "Markets",     icon: "🛒", color: "#bc5c00",
    q: 'node["amenity"="marketplace"](around:RADIUS,LAT,LNG);node["shop"~"supermarket|mall|convenience"](around:RADIUS,LAT,LNG);way["amenity"="marketplace"](around:RADIUS,LAT,LNG);way["shop"~"supermarket|mall"](around:RADIUS,LAT,LNG);' },
  { key: "transport",  label: "Transport",   icon: "🚏", color: "#6b3aa3",
    q: 'node["highway"="bus_stop"](around:RADIUS,LAT,LNG);node["amenity"~"bus_station|taxi"](around:RADIUS,LAT,LNG);node["railway"="station"](around:RADIUS,LAT,LNG);' },
  { key: "bank",       label: "Banks / ATMs",icon: "🏦", color: "#0d8050",
    q: 'node["amenity"~"bank|atm|bureau_de_change"](around:RADIUS,LAT,LNG);' },
  { key: "food",       label: "Restaurants", icon: "🍽", color: "#c2410c",
    q: 'node["amenity"~"restaurant|cafe|fast_food|food_court|bar"](around:RADIUS,LAT,LNG);way["amenity"~"restaurant|cafe"](around:RADIUS,LAT,LNG);' },
  { key: "worship",    label: "Mosques · Churches", icon: "🕌", color: "#7c3aed",
    q: 'node["amenity"="place_of_worship"](around:RADIUS,LAT,LNG);way["amenity"="place_of_worship"](around:RADIUS,LAT,LNG);' },
  { key: "leisure",    label: "Parks · Gyms",icon: "🏞", color: "#15803d",
    q: 'node["leisure"~"park|fitness_centre|sports_centre|playground"](around:RADIUS,LAT,LNG);way["leisure"~"park|fitness_centre|sports_centre|stadium"](around:RADIUS,LAT,LNG);' },
  { key: "fuel",       label: "Fuel",        icon: "⛽", color: "#1e293b",
    q: 'node["amenity"="fuel"](around:RADIUS,LAT,LNG);' },
  { key: "safety",     label: "Police · Fire", icon: "🚓", color: "#155e75",
    q: 'node["amenity"~"police|fire_station"](around:RADIUS,LAT,LNG);way["amenity"~"police|fire_station"](around:RADIUS,LAT,LNG);' },
  { key: "post",       label: "Post · Government", icon: "🏛", color: "#92400e",
    q: 'node["amenity"~"post_office|townhall|courthouse|embassy"](around:RADIUS,LAT,LNG);way["amenity"~"post_office|townhall|courthouse|embassy"](around:RADIUS,LAT,LNG);' }
];

const POI_RADIUS_M     = 1500;            // 1.5 km around the property
const POI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function attachNearbyOverlay(map, lat, lng) {
  const mapEl = document.getElementById("hdMap");
  if (!mapEl) return;

  // Build the floating toolbar of category chips.
  const toolbar = document.createElement("div");
  toolbar.className = "hd-poi-toolbar";
  toolbar.innerHTML = POI_CATS.map(c =>
    `<button type="button" class="hd-poi-chip" data-cat="${c.key}">
       <span>${c.icon}</span><span>${c.label}</span>
     </button>`
  ).join("");
  mapEl.appendChild(toolbar);

  const status = document.createElement("div");
  status.className = "hd-poi-status";
  status.hidden = true;
  mapEl.appendChild(status);

  // Build the stores from POI_CATS so we always have an entry for every
  // category — the old hardcoded literal only listed the original four
  // and threw "Cannot read properties of undefined (reading 'forEach')"
  // when any of the newer chips (bank / food / worship / etc.) was tapped.
  const markersByCat = Object.fromEntries(POI_CATS.map(c => [c.key, []]));
  const dataByCat    = Object.fromEntries(POI_CATS.map(c => [c.key, null]));

  toolbar.querySelectorAll(".hd-poi-chip").forEach(chip => {
    chip.addEventListener("click", async () => {
      const cat = chip.dataset.cat;
      const meta = POI_CATS.find(c => c.key === cat);
      const on  = !chip.classList.contains("active");
      if (on) {
        chip.classList.add("active");
        if (!dataByCat[cat]) {
          chip.classList.add("loading");
          showStatus(`Loading nearby ${meta.label}…`);
          try {
            dataByCat[cat] = await fetchPois(cat, lat, lng);
          } catch (e) {
            console.warn("overpass", cat, e);
            chip.classList.remove("loading", "active");
            showStatus(`Couldn't load nearby ${meta.label}.`, 2500);
            return;
          }
          chip.classList.remove("loading");
        }
        renderCat(map, cat, dataByCat[cat], markersByCat, { lat, lng });
        const n = dataByCat[cat].length;
        showStatus(n
          ? `${n} result${n === 1 ? "" : "s"} · ${meta.label} within ${POI_RADIUS_M/1000} km`
          : `No ${meta.label} found nearby`, 2200);
      } else {
        chip.classList.remove("active");
        (markersByCat[cat] || []).forEach(m => m.remove());
        markersByCat[cat] = [];
        hideStatus();
      }
    });
  });

  // Tip the user that the chips are tappable — they only fire Overpass on demand.
  showStatus("Tap a category to see nearby places", 4000);

  function showStatus(text, autoHideMs) {
    status.textContent = text;
    status.hidden = false;
    if (autoHideMs) setTimeout(() => { status.hidden = true; }, autoHideMs);
  }
  function hideStatus() { status.hidden = true; }
}

function renderCat(map, cat, elements, store, anchor) {
  const catMeta = POI_CATS.find(c => c.key === cat);
  store[cat].forEach(m => m.remove());
  store[cat] = [];
  for (const el of elements) {
    const p = el.center || { lat: el.lat, lon: el.lon };
    if (p.lat == null || p.lon == null) continue;
    const node = document.createElement("div");
    node.className = `hd-poi-marker cat-${cat}`;
    node.style.borderColor = catMeta.color;
    node.textContent = catMeta.icon;
    node.title = el.tags?.name || catMeta.label;
    const km = haversine(anchor.lat, anchor.lng, p.lat, p.lon);
    const popup = new maplibregl.Popup({ offset: 12, closeButton: true, maxWidth: "220px" })
      .setHTML(`<div class="hd-poi-popup">
        <strong>${esc(el.tags?.name || catMeta.label)}</strong>
        <div class="pp-meta">${catMeta.icon} ${esc(catMeta.label)} · ${km < 1 ? Math.round(km*1000) + " m" : km.toFixed(2) + " km"} away</div>
      </div>`);
    const mk = new maplibregl.Marker({ element: node, anchor: "center" })
      .setLngLat([p.lon, p.lat])
      .setPopup(popup)
      .addTo(map);
    store[cat].push(mk);
  }
}

async function fetchPois(cat, lat, lng) {
  const cacheKey = `pawa_pois_${cat}_${lat.toFixed(3)}_${lng.toFixed(3)}_${POI_RADIUS_M}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (cached && (Date.now() - cached.at) < POI_CACHE_TTL_MS) {
      return cached.data;
    }
  } catch (_) {}

  const meta = POI_CATS.find(c => c.key === cat);
  const q = `[out:json][timeout:25];(${meta.q.replace(/RADIUS/g, POI_RADIUS_M).replace(/LAT/g, lat).replace(/LNG/g, lng)});out center 60;`;
  // Two Overpass mirrors — try the second if the first is busy.
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];
  let lastErr;
  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(q)
      });
      if (!r.ok) throw new Error("Overpass HTTP " + r.status);
      const j = await r.json();
      const els = (j.elements || []).filter(e => e.tags); // drop nameless ways' inner nodes
      try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data: els })); } catch (_) {}
      return els;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Overpass unreachable");
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ============================================================================
// Helpers
// ============================================================================
function stat(emoji, value, label) {
  return `<div class="hd-stat">
    <div class="hd-stat-val">${emoji} ${esc(String(value))}</div>
    <div class="hd-stat-lbl">${esc(label)}</div>
  </div>`;
}

function stateHtml(title, body) {
  return `<div class="hd-state"><h3>${esc(title)}</h3><p>${body}</p></div>`;
}

function emptyState({ title, sub, ctaHref, ctaLabel, danger = false }) {
  const art = danger
    ? `<div class="hp-empty__art" style="background:var(--c-danger-soft,#fce4e4);color:var(--c-danger,#b91c1c);box-shadow:inset 0 0 0 1px rgba(185,28,28,.18)">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><circle cx="12" cy="16" r="1"/>
         </svg>
       </div>`
    : `<div class="hp-empty__art" aria-hidden="true">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
           <path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>
         </svg>
       </div>`;
  return `<div class="hp-empty" role="${danger ? 'alert' : 'status'}">
    ${art}
    <div class="hp-empty__title">${esc(title)}</div>
    <div class="hp-empty__sub">${sub}</div>
    ${ctaHref ? `<a class="hp-empty__cta" href="${ctaHref}">${esc(ctaLabel)}</a>` : ""}
  </div>`;
}

function formatPrice(h) {
  const p = h.price_tzs || 0;
  let value;
  if (p >= 1_000_000_000) value = (p / 1_000_000_000).toFixed(2) + "B";
  else if (p >= 1_000_000) value = (p / 1_000_000).toFixed(p % 1_000_000 === 0 ? 0 : 1) + "M";
  else if (p >= 1_000)     value = (p / 1_000).toFixed(0) + "k";
  else value = String(p);
  const unit = h.listing === "sale" ? "TZS" : `TZS / ${h.period || "month"}`;
  return { value, unit };
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  } catch { return iso; }
}

function labelType(t) {
  return ({ apartment: "Apartment", house: "House", plot: "Plot", office: "Office / shop" })[t] || (t || "Property");
}

function labelAmenity(k) {
  return ({
    parking: "Parking",
    security: "24h security",
    water_tank: "Water tank",
    borehole: "Borehole",
    generator: "Generator",
    wifi: "Wi-Fi",
    pool: "Swimming pool",
    gym: "Gym",
    garden: "Garden",
    elevator: "Elevator",
    water_connection: "Water (utility)",
    electricity_connection: "Electricity (utility)"
  })[k] || k.replace(/_/g, " ");
}

function amenityIcon(k) {
  return ({
    parking: "🅿️", security: "🛡️", water_tank: "🚰", borehole: "💧",
    generator: "🔌", wifi: "📶", pool: "🏊", gym: "🏋️",
    garden: "🌳", elevator: "🛗",
    water_connection: "🚰", electricity_connection: "⚡"
  })[k] || "✓";
}

// Stable 6-character room code derived from the listing id — same listing
// always yields the same code so multiple buyers + agent land in one room.
function roomCodeFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) { code += chars[h % chars.length]; h = Math.floor(h / chars.length) + 17; }
  return code;
}

function getFavs() {
  try { return new Set(JSON.parse(localStorage.getItem("pawa_house_favs") || "[]")); }
  catch { return new Set(); }
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ============================================================================
// Media gallery — scroll-snap carousel with prev/next, dots, thumbnails.
// Videos auto-pause when they scroll out of view to keep CPU + data usage sane.
// ============================================================================
function wireGallery(total) {
  const stage   = document.getElementById("hdGalleryStage");
  const prev    = document.getElementById("hdGalleryPrev");
  const next    = document.getElementById("hdGalleryNext");
  const counter = document.getElementById("hdGalleryCounter");
  const dots    = document.querySelectorAll(".hd-gallery-dot");
  const thumbs  = document.querySelectorAll("#hdGalleryThumbs .hd-gallery-thumb");
  if (!stage) return;

  let current = 0;

  function goTo(i) {
    current = Math.max(0, Math.min(total - 1, i));
    const slide = stage.children[current];
    if (slide) stage.scrollTo({ left: slide.offsetLeft, behavior: "smooth" });
    update();
  }
  function update() {
    if (counter) counter.textContent = `${current + 1} / ${total}`;
    dots.forEach((d, i)   => d.classList.toggle("active", i === current));
    thumbs.forEach((t, i) => t.classList.toggle("active", i === current));
    if (prev) prev.disabled = current <= 0;
    if (next) next.disabled = current >= total - 1;
    stage.querySelectorAll("video").forEach((v, i) => {
      if (i !== current) try { v.pause(); } catch (_) {}
    });
  }

  prev?.addEventListener("click", () => goTo(current - 1));
  next?.addEventListener("click", () => goTo(current + 1));
  thumbs.forEach(t => t.addEventListener("click", () => goTo(parseInt(t.dataset.i, 10))));

  // Scroll-snap on iOS triggers many `scroll` events — debounce + read the
  // currently-snapped slide based on scrollLeft / stage width.
  let scrollDebounce;
  stage.addEventListener("scroll", () => {
    clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(() => {
      const w = stage.clientWidth || 1;
      const i = Math.round(stage.scrollLeft / w);
      if (i !== current) { current = Math.max(0, Math.min(total - 1, i)); update(); }
    }, 60);
  }, { passive: true });

  stage.tabIndex = 0;
  stage.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft")  { e.preventDefault(); goTo(current - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); goTo(current + 1); }
  });

  update();
}

function hookSingleVideoAutopause(rootEl) {
  const v = rootEl.querySelector(".hd-gallery video");
  if (!v) return;
  const io = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) try { v.pause(); } catch (_) {}
  }, { threshold: 0.1 });
  io.observe(v);
}
