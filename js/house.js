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
    slides.push({ kind: "photo", url: "https://kkdpacoiwntrcukgwksh.supabase.co/storage/v1/object/public/site-photos/tierra-mallorca-rgJ1J8SDEAY-unsplash.jpg" });
  }

  const listing  = h.listing === "sale" ? "For sale" : "For rent";
  const price    = formatPrice(h);
  const verified = h.verified ? `<span class="hd-badge verified"> Verified</span>` : "";
  const typeBadge = `<span class="hd-badge type-${h.type || "house"}">${labelType(h.type)}</span>`;
  const roomKindBadge = h.room_kind === "single"
    ? `<span class="hd-badge">Single room</span>`
    : h.room_kind === "master"
      ? `<span class="hd-badge">Master room</span>`
      : "";
  const isFav    = getFavs().has(h.id);

  // Rooms & specifications — premium spec tiles with SVG icons. Only tiles
  // that have data render, so the panel adapts to each listing (a plot shows
  // size; a room rental headlines its single/master category, etc.).
  const specs = [];
  // Property type always shows, so the panel is never empty.
  specs.push(specTile(SPEC_ICONS.type, labelType(h.type), "Type"));
  // Room category is the headline fact for room-by-room rentals → accent it.
  if (h.room_kind === "single" || h.room_kind === "master")
    specs.push(specTile(SPEC_ICONS.room, h.room_kind === "master" ? "Master" : "Single", "Room", { feature: true }));
  if (h.bedrooms)
    specs.push(specTile(SPEC_ICONS.bed, h.bedrooms, h.bedrooms === 1 ? "Bedroom" : "Bedrooms"));
  if (h.bathrooms)
    specs.push(specTile(SPEC_ICONS.bath, h.bathrooms, h.bathrooms === 1 ? "Bathroom" : "Bathrooms"));
  if (h.size_sqm)
    specs.push(specTile(SPEC_ICONS.size, `${h.size_sqm} <small>m²</small>`, "Floor size", { raw: true }));
  if (h.furnished && h.furnished !== "n/a" && h.furnished !== "no")
    specs.push(specTile(SPEC_ICONS.furnished, h.furnished === "yes" ? "Furnished" : "Semi", "Furnishing"));
  // Minimum months a renter must pay upfront (rent listings only; 1 = implied).
  if (h.listing === "rent" && Number(h.min_months) > 1)
    specs.push(specTile(SPEC_ICONS.months, `${h.min_months} <small>mo</small>`, "Pay upfront", { raw: true }));
  if (h.available_from)
    specs.push(specTile(SPEC_ICONS.calendar, formatDate(h.available_from), "Available"));

  // Additional costs / bills the agent listed (electricity, water, garbage…).
  // Shown to the client so they know the full monthly cost before they call.
  const extraCosts = Array.isArray(h.extra_costs) ? h.extra_costs.filter(c => c && c.label) : [];
  const fmtMoney = window.formatTZS || ((n) => "TZS " + Number(n || 0).toLocaleString("en-US"));
  const costsHtml = extraCosts.length ? `
    <ul class="hd-costs" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;">
      ${extraCosts.map(c => {
        const b = c.billing || "month";
        const hasAmt = c.amount != null && !isNaN(c.amount) && Number(c.amount) > 0;
        let right;
        if (b === "included")     right = `<span style="color:#0a6f4d;font-weight:600;">Included in rent</span>`;
        else if (b === "metered") right = `<span style="color:#6b6960;">Metered — pay as you use</span>`;
        else if (hasAmt)          right = `<strong>${fmtMoney(c.amount)}${b === "month" ? " / month" : b === "oneoff" ? " one-time" : ""}</strong>`;
        else                      right = `<span style="color:#6b6960;">Ask agent</span>`;
        return `<li style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid #eef1f4;">
                  <span style="display:flex;align-items:center;gap:8px;">${costIcon(c.label)} ${esc(c.label)}</span>
                  <span style="text-align:right;white-space:nowrap;">${right}</span>
                </li>`;
      }).join("")}
    </ul>` : "";

  // Agent commission ("dalali" fee): paid once by the tenant to the agent for
  // finding the home — SEPARATE from the rent that goes to the landlord. The TZ
  // standard is one month's rent, so we default to that (or an explicit
  // agent_fee_tzs the agent set). Sale listings use a different model, so this
  // only applies to rentals.
  const isRentListing = (h.listing || "rent") === "rent";
  const monthsUpfront = Math.max(1, Number(h.min_months) || 1);
  const agentFee = isRentListing
    ? (Number(h.agent_fee_tzs) > 0 ? Number(h.agent_fee_tzs) : (Number(h.price_tzs) || 0))
    : 0;
  const moveInTotal = (Number(h.price_tzs) || 0) * monthsUpfront + agentFee;
  const agentFeeHtml = agentFee > 0 ? `
    <div class="hd-card hd-agent-fee">
      <h3>Agent fee</h3>
      <p class="muted" style="margin-top:-4px;">Paid once to the agent for finding the home — separate from the rent you pay the landlord.</p>
      <ul class="hd-costs" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;">
        <li style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid #eef1f4;">
          <span style="display:flex;align-items:center;gap:8px;">Agent commission <small style="color:#6b6960;">${Number(h.agent_fee_tzs) > 0 ? "" : "(one month's rent)"}</small></span>
          <strong style="white-space:nowrap;">${fmtMoney(agentFee)}</strong>
        </li>
      </ul>
      ${Number(h.price_tzs) > 0 ? `<div class="hd-movein-total" style="margin-top:10px;font-size:.92rem;">
        Estimated to move in: <strong>${fmtMoney(moveInTotal)}</strong>
        <small style="color:#6b6960;"> (${monthsUpfront} ${monthsUpfront === 1 ? "month" : "months"} rent + agent fee)</small>
      </div>` : ""}
    </div>` : "";

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
  // &house=<id> turns the meet room into a "live viewing" — the listing is
  // pinned on the live map and shown in the room's side panel.
  const meetQuery  = `code=${meetCode}&house=${encodeURIComponent(h.id)}`;
  const meetUrl    = `${location.origin}${location.pathname.replace(/[^/]*$/, "")}meet.html?${meetQuery}`;
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
             <video src="${esc(s.url)}" muted playsinline preload="none"></video>
             <span class="vbadge"></span>
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
        ${roomKindBadge}
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
      <div class="hd-loc"> ${esc(h.area || "")}${h.region ? ", " + esc(h.region) : ""}${h.address ? " · " + esc(h.address) : ""}</div>
      <div class="hd-price">${price.value} <small>${price.unit}</small></div>
      ${(h.listing === "rent" && Number(h.min_months) > 1) ? `
        <div class="hd-min-months"> Minimum <strong>${h.min_months} months</strong> upfront${
          h.price_tzs ? ` — <strong>TZS ${(h.price_tzs * h.min_months).toLocaleString("en-US")}</strong> to move in` : ""
        }</div>` : ""}
    </div>

    ${specs.length ? `
    <div class="hd-card hd-specs-card">
      <h3>Rooms &amp; specifications</h3>
      <div class="hd-specs">${specs.join("")}</div>
    </div>` : ""}

    ${h.description ? `
    <div class="hd-card">
      <h3>About this property</h3>
      <p>${esc(h.description)}</p>
    </div>` : ""}

    <div class="hd-card">
      <h3>Amenities</h3>
      ${amenitiesHtml}
    </div>

    ${costsHtml ? `
    <div class="hd-card">
      <h3>Additional costs</h3>
      <p class="muted" style="margin-top:-4px;">Bills the tenant pays on top of the price shown above.</p>
      ${costsHtml}
    </div>` : ""}

    ${agentFeeHtml}

    <div class="hd-card">
      <h3>Where it is</h3>
      <div class="hd-map" id="hdMap"></div>
      <div class="hd-map-actions">
        <a href="#" id="hdRouteBtn" role="button"> Route from my location</a>
        <a href="${mapsUrl}" target="_blank" rel="noopener"> Get directions</a>
        <a href="meet.html?${meetCode}" target="_blank" rel="noopener"> Live meet with agent</a>
      </div>

      <!-- How far is this home from the nearest main (tarmac) road? -->
      <div class="hd-main-road" id="hdMainRoad" hidden></div>

      <!-- Commute tool: how far is this home from your workplace / daily route? -->
      <div class="hd-commute" id="hdCommute" hidden>
        <label class="hd-commute-label" for="hdCommuteInput"> How far is this home from your workplace or daily route?</label>
        <div class="hd-commute-row">
          <input type="text" id="hdCommuteInput" autocomplete="off"
            placeholder="e.g. Mlimani City, Muhimbili Hospital, your office area…" />
          <button type="button" id="hdCommuteBtn" class="hd-commute-btn">Measure</button>
        </div>
        <div id="hdCommuteMsg" class="hd-commute-msg" hidden></div>
        <div id="hdCommuteResults" class="hd-commute-results"></div>
      </div>
    </div>

    <!-- What's nearby: an at-a-glance readout of the services around THIS room
         (schools, hospitals, markets, transport...) so a seeker understands the
         neighbourhood, not just the four walls. Auto-loaded; hidden until ready. -->
    <div class="hd-card hd-nearby-card" id="hdNearbyCard" hidden>
      <h3>What's nearby</h3>
      <p class="hd-nearby-sub">Important places around this home - schools, hospitals, markets and transport.</p>
      <div id="hdNearbyList" class="hd-nearby-list"></div>
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
        ${agentPhone ? `<a class="hd-cta hd-cta-call" href="tel:${agentPhoneClean}"> Call</a>` : ""}
        ${waHref     ? `<a class="hd-cta hd-cta-wa"   href="${waHref}"  target="_blank" rel="noopener"> WhatsApp</a>` : ""}
        <a class="hd-cta hd-cta-meet" href="meet.html?${meetCode}" target="_blank" rel="noopener"> Request live viewing</a>
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
    document.getElementById("hdStickyMeet").href = `meet.html?${meetCode}`;
    stickyEl.hidden = false;
  }

  // ---- Map (centered on the pin, satellite + street labels) -------------
  if (h.lat != null && h.lng != null) {
    // Hybrid base (satellite + roads + street names) with a Map ⇄ Satellite
    // toggle, so buyers can always read which street the home sits on.
    const map = new maplibregl.Map({
      container: "hdMap",
      style: window.pawaGlHybridStyle ? window.pawaGlHybridStyle() : { version: 8, sources: {}, layers: [] },
      center: [h.lng, h.lat],
      zoom: 15,
      maxBounds: [[29.34, -11.75], [40.45, -0.99]]
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    if (window.pawaGlBasemapToggle) map.addControl(window.pawaGlBasemapToggle(), "top-right");
    // Maximize / minimize the map in place (shared helper).
    window.pawaMapExpand && window.pawaMapExpand("hdMap", () => map);

    const pin = document.createElement("div");
    pin.innerHTML = `
      <svg width="32" height="42" viewBox="0 0 32 42" fill="none">
        <path d="M16 0C7.2 0 0 7.2 0 16c0 12 16 26 16 26s16-14 16-26C32 7.2 24.8 0 16 0z" fill="#0a6f4d" stroke="#fff" stroke-width="2"/>
        <circle cx="16" cy="16" r="6" fill="#fff"/>
      </svg>`;
    new maplibregl.Marker({ element: pin, anchor: "bottom" })
      .setLngLat([h.lng, h.lat])
      .addTo(map);

    // Draw the REAL driving route from the visitor's location to this house, so
    // the distance is the actual road, not a straight line.
    const routeBtn = document.getElementById("hdRouteBtn");
    routeBtn?.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!window.pawaLocate || !window.pawaRoute) return;
      const idle = routeBtn.textContent;
      routeBtn.textContent = "Locating…";
      try {
        const fix = await window.pawaLocate.best({ targetAccuracy: 80, hardTimeout: 12000 });
        const r = await window.pawaRoute.route({ lat: fix.lat, lng: fix.lng }, { lat: h.lat, lng: h.lng });
        if (!r || !r.geojson) { routeBtn.textContent = " Route unavailable"; return; }
        const ensure = () => map.isStyleLoaded() ? Promise.resolve() : new Promise((res) => map.once("load", res));
        await ensure();
        // When more than one road reaches the area, draw the alternatives too
        // (lighter dashed lines under the main route).
        const alts = (r.alts || []).filter((a) => a.geojson && Array.isArray(a.geojson.coordinates));
        // White casing under each coloured line keeps the roads visible on the
        // satellite-hybrid base. Casings share the line's source, so drop both
        // layers before the source on cleanup.
        ["hd-route-alts-casing", "hd-route-alts"].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
        if (map.getSource("hd-route-alts")) map.removeSource("hd-route-alts");
        if (alts.length) {
          map.addSource("hd-route-alts", { type: "geojson", data: {
            type: "FeatureCollection",
            features: alts.map((a) => ({ type: "Feature", geometry: a.geojson }))
          } });
          map.addLayer({ id: "hd-route-alts-casing", type: "line", source: "hd-route-alts",
            paint: { "line-color": "#fff", "line-width": 6, "line-opacity": 0.5 } });
          map.addLayer({ id: "hd-route-alts", type: "line", source: "hd-route-alts",
            paint: { "line-color": "#0a6f4d", "line-width": 4, "line-opacity": 0.6, "line-dasharray": [2, 1.5] } });
        }
        ["hd-route-casing", "hd-route"].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
        if (map.getSource("hd-route")) map.removeSource("hd-route");
        map.addSource("hd-route", { type: "geojson", data: { type: "Feature", geometry: r.geojson } });
        map.addLayer({ id: "hd-route-casing", type: "line", source: "hd-route",
          paint: { "line-color": "#fff", "line-width": 8, "line-opacity": 0.9 } });
        map.addLayer({ id: "hd-route", type: "line", source: "hd-route",
          paint: { "line-color": "#0a6f4d", "line-width": 5, "line-opacity": 0.95 } });
        new maplibregl.Marker({ color: "#1e40af" }).setLngLat([fix.lng, fix.lat]).addTo(map);
        // Fit around every road that reaches the home, not just the fastest one.
        const cs = [].concat(r.geojson.coordinates || [], ...alts.map((a) => a.geojson.coordinates));
        if (cs.length) {
          const b = cs.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(cs[0], cs[0]));
          map.fitBounds(b, { padding: 50, duration: 600 });
        }
        routeBtn.textContent = ` ${r.km.toFixed(1)} km by road · ${Math.round(r.durationMin)} min` +
          (alts.length ? ` · other road: ${alts.map((a) => a.km.toFixed(1) + " km").join(", ")}` : "");
        routeBtn.title = alts.length
          ? `Fastest road shown solid; ${alts.length === 1 ? "1 alternative road" : alts.length + " alternative roads"} shown dashed.`
          : "";
      } catch (err) {
        routeBtn.textContent = idle;
        alert((window.pawaLocate && window.pawaLocate.message ? window.pawaLocate.message(err) : (err && err.message)) || "Couldn't get your location.");
      }
    });

    // Nearby amenities overlay (schools, hospitals, markets, transport)
    attachNearbyOverlay(map, h.lat, h.lng);

    // Readable "What's nearby" summary — auto-loads so the buyer instantly sees
    // the surrounding services without having to tap the map chips.
    renderNearbySummary(h.lat, h.lng);

    // Commute tool: measure the distance from this home to the user's workplace.
    attachCommuteTool(map, h.lat, h.lng);

    // How far is this home from the nearest main (tarmac) road?
    showNearestMainRoad(h.lat, h.lng);
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
  { key: "school",     label: "Schools",     icon: "", color: "#1e40af",
    q: 'node["amenity"~"school|university|college|kindergarten"](around:RADIUS,LAT,LNG);way["amenity"~"school|university|college|kindergarten"](around:RADIUS,LAT,LNG);' },
  { key: "hospital",   label: "Hospitals",   icon: "", color: "#b91c1c",
    q: 'node["amenity"~"hospital|clinic|doctors|pharmacy"](around:RADIUS,LAT,LNG);way["amenity"~"hospital|clinic"](around:RADIUS,LAT,LNG);' },
  { key: "market",     label: "Markets",     icon: "", color: "#bc5c00",
    q: 'node["amenity"="marketplace"](around:RADIUS,LAT,LNG);node["shop"~"supermarket|mall|convenience"](around:RADIUS,LAT,LNG);way["amenity"="marketplace"](around:RADIUS,LAT,LNG);way["shop"~"supermarket|mall"](around:RADIUS,LAT,LNG);' },
  { key: "transport",  label: "Transport",   icon: "", color: "#6b3aa3",
    q: 'node["highway"="bus_stop"](around:RADIUS,LAT,LNG);node["amenity"~"bus_station|taxi"](around:RADIUS,LAT,LNG);node["railway"="station"](around:RADIUS,LAT,LNG);' },
  { key: "bank",       label: "Banks / ATMs",icon: "", color: "#0d8050",
    q: 'node["amenity"~"bank|atm|bureau_de_change"](around:RADIUS,LAT,LNG);' },
  { key: "food",       label: "Restaurants", icon: "", color: "#c2410c",
    q: 'node["amenity"~"restaurant|cafe|fast_food|food_court|bar"](around:RADIUS,LAT,LNG);way["amenity"~"restaurant|cafe"](around:RADIUS,LAT,LNG);' },
  { key: "worship",    label: "Mosques · Churches", icon: "", color: "#7c3aed",
    q: 'node["amenity"="place_of_worship"](around:RADIUS,LAT,LNG);way["amenity"="place_of_worship"](around:RADIUS,LAT,LNG);' },
  { key: "leisure",    label: "Parks · Gyms",icon: "", color: "#15803d",
    q: 'node["leisure"~"park|fitness_centre|sports_centre|playground"](around:RADIUS,LAT,LNG);way["leisure"~"park|fitness_centre|sports_centre|stadium"](around:RADIUS,LAT,LNG);' },
  { key: "fuel",       label: "Fuel",        icon: "", color: "#1e293b",
    q: 'node["amenity"="fuel"](around:RADIUS,LAT,LNG);' },
  { key: "safety",     label: "Police · Fire", icon: "", color: "#155e75",
    q: 'node["amenity"~"police|fire_station"](around:RADIUS,LAT,LNG);way["amenity"~"police|fire_station"](around:RADIUS,LAT,LNG);' },
  { key: "post",       label: "Post · Government", icon: "", color: "#92400e",
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

// Popup HTML for a nearby place. Distance is REAL road km only (never crow-flies):
// "measuring…" until the matrix answers, then "X km by road", or unavailable.
function poiPopupHtml(name, catMeta, km, state) {
  const dist = state === "road"
    ? `${km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(km < 10 ? 2 : 1) + " km"} by road`
    : state === "measuring" ? "measuring road distance…"
    : "road distance unavailable";
  return `<div class="hd-poi-popup">
    <strong>${esc(name)}</strong>
    <div class="pp-meta">${catMeta.icon} ${esc(catMeta.label)} · ${dist}</div>
  </div>`;
}

async function renderCat(map, cat, elements, store, anchor) {
  const catMeta = POI_CATS.find(c => c.key === cat);
  store[cat].forEach(m => m.remove());
  store[cat] = [];
  const entries = [];   // { popup, name, p } — to fill in real road km below
  for (const el of elements) {
    const p = el.center || { lat: el.lat, lon: el.lon };
    if (p.lat == null || p.lon == null) continue;
    const node = document.createElement("div");
    node.className = `hd-poi-marker cat-${cat}`;
    node.style.borderColor = catMeta.color;
    const name = poiLabel(el, catMeta);
    node.title = name;
    // The place's real name (the school's / hospital's actual name) is shown
    // right on the map under the pin — not hidden behind a tap.
    node.innerHTML =
      `<span class="hd-poi-ico">${catMeta.icon}</span>` +
      `<span class="hd-poi-name">${esc(name)}</span>`;
    const popup = new maplibregl.Popup({ offset: 12, closeButton: true, maxWidth: "220px" })
      .setHTML(poiPopupHtml(name, catMeta, null, "measuring"));
    const mk = new maplibregl.Marker({ element: node, anchor: "center" })
      .setLngLat([p.lon, p.lat])
      .setPopup(popup)
      .addTo(map);
    store[cat].push(mk);
    entries.push({ popup, name, p });
  }

  // Upgrade every popup to the REAL road distance home → place in one matrix
  // call (OSRM ×2 + Valhalla, cached). No straight-line is ever shown.
  if (window.pawaRoute && entries.length) {
    try {
      const kms = await window.pawaRoute.table(
        { lat: anchor.lat, lng: anchor.lng },
        entries.map((e) => ({ lat: e.p.lat, lng: e.p.lon })));
      entries.forEach((e, i) => {
        const km = kms && kms[i];
        e.popup.setHTML(poiPopupHtml(e.name, catMeta,
          Number.isFinite(km) ? km : null, Number.isFinite(km) ? "road" : "noroad"));
      });
    } catch (_) {
      entries.forEach((e) => e.popup.setHTML(poiPopupHtml(e.name, catMeta, null, "noroad")));
    }
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

// Best human-readable name for a nearby POI: the real name first (a school's or
// hospital's actual name), then operator/brand, then a humanised type — never a
// bare generic category if we can do better.
function poiLabel(el, catMeta) {
  const t = el.tags || {};
  const real = t.name || t["name:en"] || t.official_name || t.operator || t.brand;
  if (real) return real;
  const kind = t.amenity || t.shop || t.leisure || t.healthcare || t.office || t.tourism || "";
  if (kind) { const s = String(kind).replace(/_/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); }
  return catMeta.label;
}

// ============================================================================
// "What's nearby" summary — an at-a-glance, auto-loaded readout of the services
// around THIS room (schools, hospitals, markets, transport...), so a seeker
// understands the neighbourhood, not just the listing. ONE combined Overpass
// query (not one per category), cached 24h. Distances are straight-line and
// clearly marked "~"; the map markers give the exact road distance on tap.
// ============================================================================
const SUMMARY_RADIUS_M = 1500;
const NEARBY_SUMMARY_GROUPS = [
  { key: "school",    label: "Schools",             color: "#1e40af", match: t => /^(school|kindergarten|college|university)$/.test(t.amenity || "") },
  { key: "hospital",  label: "Hospitals & clinics", color: "#b91c1c", match: t => /^(hospital|clinic|doctors|pharmacy)$/.test(t.amenity || "") },
  { key: "market",    label: "Markets & shops",     color: "#bc5c00", match: t => t.amenity === "marketplace" || /^(supermarket|convenience|mall)$/.test(t.shop || "") },
  { key: "transport", label: "Transport",           color: "#6b3aa3", match: t => t.highway === "bus_stop" || /^(bus_station|taxi)$/.test(t.amenity || "") || t.railway === "station" || !!t.public_transport },
  { key: "bank",      label: "Banks & ATMs",        color: "#0d8050", match: t => /^(bank|atm|bureau_de_change)$/.test(t.amenity || "") },
  { key: "worship",   label: "Mosques & churches",  color: "#7c3aed", match: t => t.amenity === "place_of_worship" },
];

async function renderNearbySummary(lat, lng) {
  const card = document.getElementById("hdNearbyCard");
  const list = document.getElementById("hdNearbyList");
  if (!card || !list || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  card.hidden = false;
  list.innerHTML = `<p class="hd-nearby-msg">Scanning the area around this home…</p>`;

  let els;
  try { els = await fetchNearbySummary(lat, lng); }
  catch (_) { list.innerHTML = `<p class="hd-nearby-msg">Couldn't load nearby places right now — the map below still shows where it is.</p>`; return; }

  const groups = NEARBY_SUMMARY_GROUPS.map(g => {
    const seen = new Set();
    const items = [];
    for (const el of els) {
      if (!g.match(el.tags || {})) continue;
      const p = el.center || { lat: el.lat, lon: el.lon };
      if (p.lat == null || p.lon == null) continue;
      const name = poiLabel(el, g);
      const k = name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({ name, dist: haversineMetersHd(lat, lng, p.lat, p.lon) });
    }
    items.sort((a, b) => a.dist - b.dist);
    return { label: g.label, color: g.color, count: items.length, top: items.slice(0, 3) };
  }).filter(g => g.count > 0);

  if (!groups.length) {
    list.innerHTML = `<p class="hd-nearby-msg">No tagged services found within ${SUMMARY_RADIUS_M / 1000} km on OpenStreetMap. The map below still shows where it is.</p>`;
    return;
  }
  list.innerHTML = groups.map(g => `
    <div class="hd-nearby-cat">
      <div class="hd-nearby-cat-head">
        <span class="hd-nearby-dot" style="background:${g.color}"></span>
        <strong>${esc(g.label)}</strong>
        <span class="hd-nearby-count">${g.count}</span>
      </div>
      <ul class="hd-nearby-items">
        ${g.top.map(it => `<li>
          <span class="hd-nearby-name">${esc(it.name)}</span>
          <span class="hd-nearby-dist">~${fmtMetersHd(it.dist)}</span>
        </li>`).join("")}
      </ul>
    </div>`).join("");
}

async function fetchNearbySummary(lat, lng) {
  const R = SUMMARY_RADIUS_M;
  const cacheKey = `pawa_nearby_sum_${lat.toFixed(3)}_${lng.toFixed(3)}_${R}`;
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (c && (Date.now() - c.at) < POI_CACHE_TTL_MS) return c.data;
  } catch (_) {}

  const q = `[out:json][timeout:25];(` +
    `node["amenity"~"^(school|kindergarten|college|university|hospital|clinic|doctors|pharmacy|marketplace|bank|atm|bureau_de_change|place_of_worship|bus_station|taxi)$"](around:${R},${lat},${lng});` +
    `node["shop"~"^(supermarket|convenience|mall)$"](around:${R},${lat},${lng});` +
    `node["highway"="bus_stop"](around:${R},${lat},${lng});` +
    `node["railway"="station"](around:${R},${lat},${lng});` +
    `node["public_transport"](around:${R},${lat},${lng});` +
    `);out body 150;`;
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  let lastErr;
  for (const url of endpoints) {
    // fetch() has no native timeout — abort after 18s so a busy/hung Overpass
    // mirror can't leave the card stuck on "Scanning…"; we fall through to the
    // next mirror, then to the graceful failure message.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 18000);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(q),
        signal: ac.signal,
      });
      if (!r.ok) throw new Error("Overpass HTTP " + r.status);
      const j = await r.json();
      const els = (j.elements || []).filter(e => e.tags);
      try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data: els })); } catch (_) {}
      return els;
    } catch (e) { lastErr = e; }
    finally { clearTimeout(timer); }
  }
  throw lastErr || new Error("Overpass unreachable");
}

function haversineMetersHd(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}
function fmtMetersHd(m) { return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`; }

// ============================================================================
// Commute tool — "how far is this home from my workplace / daily route?"
// Geocodes the typed place via LocationIQ (pawaGeo.suggest), then measures the
// REAL driving route via pawaRoute (OSRM ×2 + Valhalla) — the actual road km +
// minutes, with the route drawn on the map. NEVER straight-line: if no engine
// can route it, we say so rather than show a crow-flies number. No match → ask
// the user for a famous area/landmark near their workplace and try again.
// ============================================================================
function attachCommuteTool(map, lat, lng) {
  const wrap  = document.getElementById("hdCommute");
  const input = document.getElementById("hdCommuteInput");
  const btn   = document.getElementById("hdCommuteBtn");
  const msgEl = document.getElementById("hdCommuteMsg");
  const resEl = document.getElementById("hdCommuteResults");
  if (!wrap || !input || !btn || !window.pawaGeo) return;
  wrap.hidden = false;

  let workMarker = null, lineReady = false, measureSeq = 0;

  function emptyLine() { return { type: "Feature", geometry: { type: "LineString", coordinates: [] } }; }
  function emptyFC()   { return { type: "FeatureCollection", features: [] }; }
  function initLine() {
    if (lineReady) return;
    const add = () => {
      // Alternative roads sit UNDER the chosen route so the main one reads first.
      // Each coloured line gets a white casing beneath it so the roads stay
      // visible on the satellite-hybrid base (dark imagery swallows raw green).
      if (!map.getSource("hd-commute-alts")) {
        map.addSource("hd-commute-alts", { type: "geojson", data: emptyFC() });
        map.addLayer({ id: "hd-commute-alts-casing", type: "line", source: "hd-commute-alts",
          paint: { "line-color": "#fff", "line-width": 5, "line-opacity": 0.5 } });
        map.addLayer({ id: "hd-commute-alts", type: "line", source: "hd-commute-alts",
          paint: { "line-color": "#0a6f4d", "line-width": 3, "line-opacity": 0.6, "line-dasharray": [2, 1.5] } });
      }
      if (!map.getSource("hd-commute-line")) {
        map.addSource("hd-commute-line", { type: "geojson", data: emptyLine() });
        map.addLayer({ id: "hd-commute-line-casing", type: "line", source: "hd-commute-line",
          paint: { "line-color": "#fff", "line-width": 6, "line-opacity": 0.9 } });
        map.addLayer({ id: "hd-commute-line", type: "line", source: "hd-commute-line",
          paint: { "line-color": "#0a6f4d", "line-width": 3, "line-opacity": 0.95 } });
      }
      lineReady = true;
    };
    if (map.isStyleLoaded()) add(); else map.once("load", add);
  }
  // Draw either the full road geometry (solid) or a 2-point fallback (dashed).
  function setLine(coords, dashed) {
    initLine();
    const data = { type: "Feature", geometry: { type: "LineString", coordinates: coords } };
    const apply = () => {
      const s = map.getSource("hd-commute-line"); if (s) s.setData(data);
      if (map.getLayer("hd-commute-line")) {
        map.setPaintProperty("hd-commute-line", "line-dasharray", dashed ? [2, 1.5] : [1, 0]);
        // Real road = brand green; straight-line estimate = amber, so the two are
        // never confused (matches near-me / services / trucks).
        map.setPaintProperty("hd-commute-line", "line-color", dashed ? "#b26a00" : "#0a6f4d");
      }
    };
    if (map.getSource && map.getSource("hd-commute-line")) apply(); else map.once("load", apply);
  }
  // The OTHER roads that also reach the place (lighter dashed lines).
  function setAltLines(coordsList) {
    initLine();
    const data = {
      type: "FeatureCollection",
      features: (coordsList || []).map((c) => ({ type: "Feature", geometry: { type: "LineString", coordinates: c } }))
    };
    const apply = () => { const s = map.getSource("hd-commute-alts"); if (s) s.setData(data); };
    if (map.getSource && map.getSource("hd-commute-alts")) apply(); else map.once("load", apply);
  }
  function fitCoords(coords) {
    try {
      const b = coords.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(b, { padding: 70, maxZoom: 15, duration: 600 });
    } catch (_) {}
  }

  function showMsg(html, kind) {
    msgEl.innerHTML = html;
    msgEl.className = "hd-commute-msg" + (kind ? " " + kind : "");
    msgEl.hidden = !html;
  }
  function fmtKm(km) { return km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(km < 10 ? 2 : 1) + " km"; }

  async function selectPlace(p, rows) {
    if (!workMarker) {
      const el = document.createElement("div");
      el.className = "hd-work-marker";
      el.textContent = "";
      workMarker = new maplibregl.Marker({ element: el, anchor: "center" });
    }
    workMarker.setLngLat([p.lng, p.lat]).addTo(map);
    if (rows) rows.forEach((r) => r.el.classList.toggle("active", r.place === p));

    const ctx = p.context ? ` <span class="hd-commute-ctx">(${esc(p.context)})</span>` : "";
    const seq = ++measureSeq;
    showMsg(`Measuring the real road distance to <strong>${esc(p.name)}</strong>…`, "");

    // Real driving route (road km + minutes + geometry to draw).
    let r = null;
    try {
      if (window.pawaRoute) r = await window.pawaRoute.route({ lat, lng }, { lat: p.lat, lng: p.lng });
    } catch (_) {}
    if (seq !== measureSeq) return;   // user already picked another place

    if (r && r.geojson && Array.isArray(r.geojson.coordinates) && r.geojson.coordinates.length) {
      p.roadKm = r.km;
      const alts = (r.alts || []).filter((a) => a.geojson && Array.isArray(a.geojson.coordinates));
      setLine(r.geojson.coordinates, false);
      setAltLines(alts.map((a) => a.geojson.coordinates));
      // Zoom out far enough to show EVERY road that reaches the place.
      fitCoords([].concat(r.geojson.coordinates, ...alts.map((a) => a.geojson.coordinates)));
      const altNote = alts.length
        ? `There ${alts.length === 1 ? "is 1 more road" : `are ${alts.length} more roads`} to reach this area — ` +
          alts.map((a) => `${fmtKm(a.km)} · ~${Math.round(a.durationMin)} min`).join(", ") +
          ` (drawn lighter on the map).`
        : `Measured along the actual road, drawn on the map.`;
      showMsg(
        ` <strong>${fmtKm(r.km)} by road</strong> · ~${Math.round(r.durationMin)} min drive ` +
        `from this home to <strong>${esc(p.name)}</strong>${ctx}. ` +
        `<span class="hd-commute-note">${altNote}</span>`,
        "ok"
      );
      if (rows) {
        const row = rows.find((x) => x.place === p);
        const kmEl = row && row.el.querySelector(".hd-cr-km");
        if (kmEl) kmEl.textContent = fmtKm(r.km) + " by road";
      }
    } else {
      // No routing engine (OSRM ×2 + Valhalla) could measure it — show the honest
      // state instead of a misleading straight-line number, and draw no fake line.
      setLine([], true);
      setAltLines([]);
      showMsg(
        `Couldn’t measure the road distance to <strong>${esc(p.name)}</strong>${ctx} right now. ` +
        `<span class="hd-commute-note">Please try again in a moment.</span>`,
        "warn"
      );
    }
  }

  function renderResults(places) {
    resEl.innerHTML = "";
    const rows = [];
    places.forEach((p) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "hd-commute-result";
      // Road distance only — blank until measured (tapping the row routes it).
      el.innerHTML =
        `<span class="hd-cr-name">${esc(p.name)}</span>` +
        `<span class="hd-cr-meta">${esc(p.tag || "Place")}${p.context ? " · " + esc(p.context) : ""}</span>` +
        `<span class="hd-cr-km">${p.roadKm != null ? fmtKm(p.roadKm) + " by road" : "tap to measure"}</span>`;
      resEl.appendChild(el);
      const row = { el, place: p };
      el.addEventListener("click", () => selectPlace(p, rows));
      rows.push(row);
    });
    return rows;
  }

  async function run() {
    const q = input.value.trim();
    if (q.length < 2) { showMsg("Type your workplace, office area or a place on your daily route.", "warn"); return; }
    btn.disabled = true; btn.textContent = "Locating…";
    showMsg(`Searching for “${esc(q)}”…`, "");
    resEl.innerHTML = "";
    let places = [];
    try { places = await window.pawaGeo.suggest(q, { limit: 6 }); } catch (_) { places = []; }
    btn.disabled = false; btn.textContent = "Measure";

    if (!places.length) {
      showMsg(
        `We couldn't find “<strong>${esc(q)}</strong>”. Try a <strong>famous area, market, school or road near your workplace</strong> ` +
        `(a well-known landmark close by), then measure again.`,
        "warn"
      );
      return;
    }
    const rows = renderResults(places);
    selectPlace(places[0], rows);   // preview the top match; tap another to refine

    // Upgrade every result's distance to the REAL road km in one OSRM matrix
    // request, so the list ranks places by how far they actually are to drive.
    if (window.pawaRoute) {
      window.pawaRoute.table({ lat, lng }, places.map((p) => ({ lat: p.lat, lng: p.lng })))
        .then((kms) => (kms || []).forEach((km, i) => {
          if (!Number.isFinite(km) || !rows[i]) return;
          places[i].roadKm = km;
          const kmEl = rows[i].el.querySelector(".hd-cr-km");
          if (kmEl) kmEl.textContent = fmtKm(km) + " by road";
        }))
        .catch(() => {});
    }
  }

  btn.addEventListener("click", run);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
}

// ============================================================================
// Nearest main road — every listing shows how close it is to the tarmac
// (motorway / trunk / primary / secondary), via the shared pawaRoads helper.
// ============================================================================
async function showNearestMainRoad(lat, lng) {
  const el = document.getElementById("hdMainRoad");
  if (!el || !window.pawaRoads || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  el.hidden = false;
  el.innerHTML = ` Checking how far the main road is…`;
  let r;
  try { r = await window.pawaRoads.nearest({ lat, lng }); } catch (_) { r = undefined; }
  if (r === undefined) { el.hidden = true; return; }   // lookup failed — say nothing wrong
  if (r) {
    const d = r.meters < 1000 ? `${r.meters} m` : `${(r.meters / 1000).toFixed(1)} km`;
    el.innerHTML = ` <strong>${d}</strong> from the nearest main road` +
      (r.name ? ` — <strong>${esc(r.name)}</strong>` : "");
  } else {
    el.innerHTML = ` More than 3 km from the nearest main road`;
  }
}

// ============================================================================
// Helpers
// ============================================================================
// A single spec tile: trusted SVG icon + value + uppercase label. Value is
// escaped unless { raw:true } (used for tiles with an inline <small> unit).
// { feature:true } renders the accented brand-gradient variant.
function specTile(icon, value, label, opts = {}) {
  const v = opts.raw ? value : esc(String(value));
  return `<div class="hd-spec${opts.feature ? " hd-spec--feature" : ""}">
    <span class="hd-spec__icon" aria-hidden="true">${icon}</span>
    <span class="hd-spec__val">${v}</span>
    <span class="hd-spec__lbl">${esc(label)}</span>
  </div>`;
}

// Lucide-style line icons (consistent 1.8 stroke) for the spec tiles.
const SPEC_ICONS = {
  type:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></svg>`,
  room:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17"/><circle cx="14.5" cy="12" r="1"/></svg>`,
  bed:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5"/><path d="M3 18v2M21 18v2"/><path d="M7 11V8a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v3"/></svg>`,
  bath:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M5 12V6a2 2 0 0 1 2-2 2 2 0 0 1 2 2"/><path d="M8 6h2"/><path d="M7 19l-1 2M18 19l1 2"/></svg>`,
  size:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/></svg>`,
  furnished: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12V8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4"/><path d="M3 12a2 2 0 0 1 2 2v3h14v-3a2 2 0 0 1 2-2"/><path d="M5 17v2M19 17v2"/></svg>`,
  months:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2"/><path d="M5 3L2 6M19 3l3 3"/></svg>`,
  calendar:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`
};

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
  return ({ apartment: "Apartment", house: "House", plot: "Plot", office: "Office", shop: "Shop / business", warehouse: "Warehouse" })[t] || (t || "Property");
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
    parking: "🅿", security: "", water_tank: "", borehole: "",
    generator: "", wifi: "", pool: "", gym: "",
    garden: "", elevator: "",
    water_connection: "", electricity_connection: ""
  })[k] || "";
}

// Pick an emoji for an additional-cost line by matching keywords in its label.
function costIcon(label) {
  const s = String(label || "").toLowerCase();
  if (/electric|umeme|luku|power/.test(s))        return "";
  if (/water|maji/.test(s))                        return "";
  if (/garbage|waste|taka|rubbish|trash/.test(s))  return "";
  if (/secur|usalama|guard|askari/.test(s))        return "";
  if (/internet|wifi|wi-fi|data/.test(s))          return "";
  if (/gas/.test(s))                               return "";
  if (/service|maintenance|matengenezo/.test(s))   return "";
  if (/park/.test(s))                              return "🅿";
  if (/cable|tv|dstv|startimes/.test(s))           return "";
  return "";
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
