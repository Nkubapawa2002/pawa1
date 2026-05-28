// ============================================================================
//  Agent Houses dashboard
//  - Sign in / sign up with Supabase auth (email + password)
//  - List the current user's own property listings
//  - Create / edit / delete listings (matches the RLS policies in
//    supabase/schema_master.sql section 34 — owner_user_id = auth.uid())
//  - GPS-verified pin picker: drag a marker on a satellite map OR use
//    the device's GPS to set lat/lng
//  - Photo upload to the `house-photos` storage bucket (client-side
//    resized to 1200px / JPEG 0.85 — keeps it under 500 KB)
// ============================================================================

window.initAgentHousesPage = async () => {
  const sb = window.DataStore?.sb;
  const tr = (k) => (window.t ? window.t(k) : k);

  // ---- Element refs --------------------------------------------------------
  const authCard      = document.getElementById("ahAuthCard");
  const dashboard     = document.getElementById("ahDashboard");
  const formSection   = document.getElementById("ahFormSection");
  const warnEl        = document.getElementById("ahWarn");

  // Auth form
  const tabSignIn     = document.getElementById("tabSignIn");
  const tabSignUp     = document.getElementById("tabSignUp");
  const authForm      = document.getElementById("ahAuthForm");
  const authEmail     = document.getElementById("ahEmail");
  const authPassword  = document.getElementById("ahPassword");
  const authSubmit    = document.getElementById("ahAuthSubmit");
  const authMsg       = document.getElementById("ahAuthMsg");

  // Dashboard
  const userEmailEl   = document.getElementById("ahUserEmail");
  const newBtn        = document.getElementById("ahNewBtn");
  const signOutBtn    = document.getElementById("ahSignOut");
  const listEl        = document.getElementById("ahList");

  // Listing form
  const form          = document.getElementById("ahForm");
  const formTitle     = document.getElementById("ahFormTitle");
  const fPhotoInput   = document.getElementById("ahPhotoInput");
  const fPhotoLabel   = document.getElementById("ahPhotoLabel");
  const fTitle        = document.getElementById("ahTitle");
  const fType         = document.getElementById("ahType");
  const fListing      = document.getElementById("ahListing");
  const fPrice        = document.getElementById("ahPrice");
  const fPeriod       = document.getElementById("ahPeriod");
  const fBedrooms     = document.getElementById("ahBedrooms");
  const fBathrooms    = document.getElementById("ahBathrooms");
  const fSize         = document.getElementById("ahSize");
  const fRegion       = document.getElementById("ahRegion");
  const fArea         = document.getElementById("ahArea");
  const fAddress      = document.getElementById("ahAddress");
  const fFurnished    = document.getElementById("ahFurnished");
  const fAmenities    = document.getElementById("ahAmenities");
  const fDescription  = document.getElementById("ahDescription");
  const fAvailable    = document.getElementById("ahAvailable");
  const fAgentPhone   = document.getElementById("ahAgentPhone");
  const fPinCoords    = document.getElementById("ahPinCoords");
  const fPinGps       = document.getElementById("ahPinGps");
  const formMsg       = document.getElementById("ahFormMsg");
  const saveBtn       = document.getElementById("ahSaveBtn");
  const cancelBtn     = document.getElementById("ahCancelBtn");

  // ---- State ---------------------------------------------------------------
  let mode          = "auth";       // 'auth' | 'dashboard' | 'form'
  let authMode      = "signin";     // 'signin' | 'signup'
  let editingId     = null;         // null = create, set = editing this id
  let pickedLatLng  = null;         // { lat, lng }
  let stagedPhoto   = null;         // base64 data URL (waiting to be uploaded)
  let stagedPhotoExisting = null;   // existing photo path/URL when editing
  let pinMap        = null;
  let pinMarker     = null;

  const AMENITY_OPTIONS = [
    { key: "parking",                i18n: "ah_am_parking" },
    { key: "security",               i18n: "ah_am_security" },
    { key: "water_tank",             i18n: "ah_am_water_tank" },
    { key: "borehole",               i18n: "ah_am_borehole" },
    { key: "generator",              i18n: "ah_am_generator" },
    { key: "wifi",                   i18n: "ah_am_wifi" },
    { key: "pool",                   i18n: "ah_am_pool" },
    { key: "gym",                    i18n: "ah_am_gym" },
    { key: "garden",                 i18n: "ah_am_garden" },
    { key: "elevator",               i18n: "ah_am_elevator" },
    { key: "water_connection",       i18n: "ah_am_water_conn" },
    { key: "electricity_connection", i18n: "ah_am_elec_conn" }
  ];

  // ---- Hard requirement: Supabase must be configured -----------------------
  if (!sb) {
    authCard.hidden = false;
    authMsg.textContent = tr("ah_msg_supabase_missing");
    authMsg.className = "ah-msg error";
    authMsg.hidden = false;
    authForm.querySelectorAll("input, button").forEach(el => el.disabled = true);
    return;
  }

  // ---- Build amenity chips -------------------------------------------------
  fAmenities.innerHTML = AMENITY_OPTIONS.map(a => `
    <label class="ah-chip" data-key="${a.key}">
      <input type="checkbox" value="${a.key}">
      ${esc(tr(a.i18n))}
    </label>
  `).join("");
  fAmenities.querySelectorAll(".ah-chip").forEach(chip => {
    const cb = chip.querySelector("input");
    chip.addEventListener("click", (e) => {
      // Don't double-toggle when the click was on the (hidden) checkbox.
      if (e.target !== cb) cb.checked = !cb.checked;
      chip.classList.toggle("active", cb.checked);
    });
  });

  // ---- Populate region dropdown from existing regions table ----------------
  try {
    const regions = await window.DataStore.getRegions?.() || [];
    regions.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r; opt.textContent = r;
      fRegion.appendChild(opt);
    });
  } catch (_) { /* non-fatal — agent can type a region by hand below */ }

  // ---- Auth state ----------------------------------------------------------
  await routeOnAuth();
  sb.auth.onAuthStateChange((_event, session) => routeOnAuth(session));

  async function routeOnAuth(session) {
    const s = session ?? (await sb.auth.getSession()).data.session;
    if (s?.user) {
      authCard.hidden = true;
      dashboard.hidden = false;
      formSection.hidden = true;
      mode = "dashboard";
      userEmailEl.textContent = s.user.email || tr("ah_no_email");
      await loadMyListings();
    } else {
      authCard.hidden = false;
      dashboard.hidden = true;
      formSection.hidden = true;
      mode = "auth";
    }
  }

  // ---- Sign in / sign up tabs ---------------------------------------------
  tabSignIn.addEventListener("click", () => {
    authMode = "signin";
    tabSignIn.classList.add("active");
    tabSignUp.classList.remove("active");
    authSubmit.textContent = tr("ah_tab_signin");
    authPassword.autocomplete = "current-password";
    authMsg.hidden = true;
  });
  tabSignUp.addEventListener("click", () => {
    authMode = "signup";
    tabSignUp.classList.add("active");
    tabSignIn.classList.remove("active");
    authSubmit.textContent = tr("ah_tab_signup");
    authPassword.autocomplete = "new-password";
    authMsg.hidden = true;
  });

  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    authMsg.hidden = true;
    authSubmit.disabled = true;
    const email = authEmail.value.trim();
    const password = authPassword.value;
    try {
      if (authMode === "signup") {
        const { error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        authMsg.className = "ah-msg success";
        authMsg.textContent = tr("ah_msg_signup_ok");
        authMsg.hidden = false;
        authMode = "signin";
        tabSignIn.click();
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // onAuthStateChange will route us into the dashboard.
      }
    } catch (err) {
      authMsg.className = "ah-msg error";
      authMsg.textContent = err.message || tr("ah_msg_auth_fail");
      authMsg.hidden = false;
    } finally {
      authSubmit.disabled = false;
    }
  });

  signOutBtn.addEventListener("click", async () => {
    await sb.auth.signOut();
    // onAuthStateChange handles the rest.
  });

  // ---- Load my listings ----------------------------------------------------
  async function loadMyListings() {
    // Skeleton (or keep the one already in HTML on first load).
    listEl.setAttribute("aria-busy", "true");
    listEl.innerHTML = `
      <div class="hp-sk-card" style="grid-template-columns:1fr;grid-template-rows:160px auto" aria-hidden="true">
        <div class="hp-sk-card__photo" style="height:160px"></div>
        <div class="hp-sk-card__body">
          <span class="hp-sk hp-sk--title"></span>
          <span class="hp-sk hp-sk--price"></span>
          <span class="hp-sk hp-sk--line" style="width:60%"></span>
        </div>
      </div>
      <div class="hp-sk-card" style="grid-template-columns:1fr;grid-template-rows:160px auto" aria-hidden="true">
        <div class="hp-sk-card__photo" style="height:160px"></div>
        <div class="hp-sk-card__body">
          <span class="hp-sk hp-sk--title"></span>
          <span class="hp-sk hp-sk--price"></span>
          <span class="hp-sk hp-sk--line" style="width:60%"></span>
        </div>
      </div>`;
    const { data: { session } } = await sb.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) return;
    const { data, error } = await sb.from("houses")
      .select("*")
      .eq("owner_user_id", uid)
      .order("created_at", { ascending: false });
    listEl.setAttribute("aria-busy", "false");
    if (error) {
      // If the table is missing, render a proper setup card with the SQL
      // inline + Copy button + deep link to the user's Supabase SQL
      // editor. Hides the New-listing button while in this state since
      // saving would also fail.
      if (/relation .* does not exist|schema cache/i.test(error.message)) {
        renderSetupCard();
        return;
      }
      listEl.innerHTML = `<div class="hp-empty" role="alert">
        <div class="hp-empty__art" style="background:var(--c-danger-soft,#fce4e4);color:var(--c-danger,#b91c1c);box-shadow:inset 0 0 0 1px rgba(185,28,28,.18)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><circle cx="12" cy="16" r="1"/>
          </svg>
        </div>
        <div class="hp-empty__title">Couldn't load your listings</div>
        <div class="hp-empty__sub">${esc(error.message)}</div>
        <button class="hp-empty__cta" type="button" onclick="location.reload()">Try again</button>
      </div>`;
      return;
    }
    if (!data?.length) {
      listEl.innerHTML = `<div class="hp-empty" role="status">
        <div class="hp-empty__art" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M12 14v6"/><path d="M9 17h6"/>
          </svg>
        </div>
        <div class="hp-empty__title">${esc(tr("ah_no_listings"))}</div>
        <div class="hp-empty__sub">${tr("ah_no_listings_hint_html")}</div>
        <button class="hp-empty__cta" type="button" id="ahEmptyNew">+ Add your first listing</button>
      </div>`;
      document.getElementById("ahEmptyNew")?.addEventListener("click", () => openForm(null));
      return;
    }
    listEl.innerHTML = data.map(h => {
      const photo = window.DataStore.housePhotoUrl(h.photo);
      const listing = h.listing === "sale" ? tr("ah_for_sale") : tr("ah_for_rent");
      const price = formatPrice(h);
      return `<div class="ah-card" data-id="${h.id}">
        <div class="ah-card-photo" data-loading="true" style="background-image:url('${photo}')">
          <span class="badge">${esc(listing)}</span>
        </div>
        <div class="ah-card-body">
          <div class="ah-card-title">${esc(h.title)}</div>
          <div class="ah-card-price">${price.value} <small style="font-size:.72rem;font-weight:500;color:#6b6960">${price.unit}</small></div>
          <div class="ah-card-meta">📍 ${esc(h.area || "—")}${h.region ? ", " + esc(h.region) : ""}</div>
        </div>
        <div class="ah-card-actions">
          <button class="ah-btn ah-edit-btn" aria-label="Edit ${esc(h.title)}">${esc(tr("ah_edit"))}</button>
          <button class="ah-btn ah-btn-danger ah-delete-btn" aria-label="Delete ${esc(h.title)}">${esc(tr("ah_delete"))}</button>
        </div>
      </div>`;
    }).join("");
    listEl.querySelectorAll(".ah-card").forEach(card => {
      const id = card.dataset.id;
      const row = data.find(x => x.id === id);
      card.querySelector(".ah-edit-btn").addEventListener("click", () => openForm(row));
      card.querySelector(".ah-delete-btn").addEventListener("click", () => deleteListing(row));
    });
    // Drop shimmer on each card photo when its image is ready.
    listEl.querySelectorAll(".ah-card-photo[data-loading]").forEach(el => {
      const m = el.getAttribute("style").match(/url\(['"]?([^'")]+)['"]?\)/);
      if (!m) { el.removeAttribute("data-loading"); return; }
      const img = new Image();
      img.decoding = "async"; img.loading = "lazy";
      img.onload = img.onerror = () => el.removeAttribute("data-loading");
      img.src = m[1];
    });
  }

  // ---- Open form (create or edit) -----------------------------------------
  newBtn.addEventListener("click", () => openForm(null));
  cancelBtn.addEventListener("click", () => closeForm());

  function openForm(row) {
    editingId = row?.id || null;
    formTitle.textContent = row ? tr("ah_form_title_edit") : tr("ah_form_title_new");
    formMsg.hidden = true;

    // Reset fields
    form.reset();
    pickedLatLng = null;
    stagedPhoto = null;
    stagedPhotoExisting = null;
    fPinCoords.textContent = "No pin set";
    fAmenities.querySelectorAll(".ah-chip").forEach(c => c.classList.remove("active"));
    fAmenities.querySelectorAll("input").forEach(i => i.checked = false);
    resetPhotoLabel();

    if (row) {
      fTitle.value       = row.title || "";
      fType.value        = row.type || "apartment";
      fListing.value     = row.listing || "rent";
      fPrice.value       = row.price_tzs || "";
      fPeriod.value      = row.period || (row.listing === "sale" ? "total" : "month");
      fBedrooms.value    = row.bedrooms ?? 0;
      fBathrooms.value   = row.bathrooms ?? 0;
      fSize.value        = row.size_sqm ?? "";
      fRegion.value      = row.region || "";
      fArea.value        = row.area || "";
      fAddress.value     = row.address || "";
      fFurnished.value   = row.furnished || "no";
      fDescription.value = row.description || "";
      fAvailable.value   = row.available_from || "";
      fAgentPhone.value  = row.agent?.phone || "";
      (row.amenities || []).forEach(k => {
        const chip = fAmenities.querySelector(`.ah-chip[data-key="${k}"]`);
        if (chip) { chip.classList.add("active"); chip.querySelector("input").checked = true; }
      });
      if (row.photo) {
        stagedPhotoExisting = row.photo;
        const url = window.DataStore.housePhotoUrl(row.photo);
        fPhotoLabel.classList.add("has-photo");
        fPhotoLabel.innerHTML = `<img src="${url}" class="ah-photo-preview" alt="">`;
      }
      if (row.lat != null && row.lng != null) {
        pickedLatLng = { lat: Number(row.lat), lng: Number(row.lng) };
      }
    }

    // Switch UI
    dashboard.hidden = true;
    formSection.hidden = false;
    mode = "form";
    window.scrollTo({ top: 0, behavior: "smooth" });

    // Init or refresh pin picker map (must wait for the section to be
    // visible before MapLibre can size itself correctly).
    setTimeout(() => initPinMap(), 80);
  }

  function closeForm() {
    formSection.hidden = true;
    dashboard.hidden = false;
    mode = "dashboard";
    editingId = null;
  }

  // ---- Photo upload (client-side) -----------------------------------------
  fPhotoLabel.addEventListener("click", () => fPhotoInput.click());
  fPhotoInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { alert(tr("ah_err_photo_too_large")); return; }
    try {
      const dataUrl = await compressImage(file, 1200, 0.85);
      stagedPhoto = dataUrl;
      fPhotoLabel.classList.add("has-photo");
      fPhotoLabel.innerHTML = `<img src="${dataUrl}" class="ah-photo-preview" alt="">`;
    } catch (err) {
      alert(tr("ah_err_photo_read") + err.message);
    }
  });

  function resetPhotoLabel() {
    fPhotoLabel.classList.remove("has-photo");
    fPhotoLabel.innerHTML = `
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
      <p>${esc(tr("ah_upload_cta"))}</p>
      <small>${esc(tr("ah_upload_hint"))}</small>`;
  }

  function compressImage(file, maxW, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(1, maxW / img.width);
        const w = Math.round(img.width  * ratio);
        const h = Math.round(img.height * ratio);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  // ---- Pin picker map (MapLibre satellite + draggable marker) -------------
  function initPinMap() {
    if (pinMap) {
      pinMap.resize();
      // Reposition the marker to wherever the current form expects it.
      // If editing an existing row → snap to that row's pin. If creating
      // a new listing (pickedLatLng == null) → drop the marker on the
      // map's default center so it never shows the *previous* listing's
      // pin until the user drags it.
      const target = pickedLatLng
        ? [pickedLatLng.lng, pickedLatLng.lat]
        : [39.2789, -6.7924];                  // Dar es Salaam default
      const zoom   = pickedLatLng ? 15 : 11;
      if (pinMarker) pinMarker.setLngLat(target);
      pinMap.easeTo({ center: target, zoom, duration: 350 });
      updatePinReadout();
      return;
    }
    pinMap = new maplibregl.Map({
      container: "ahPinMap",
      style: {
        version: 8,
        sources: {
          esri: { type: "raster",
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256, maxzoom: 19, attribution: "Tiles © Esri" },
          carto_labels: { type: "raster",
            tiles: [
              "https://a.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
              "https://b.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png"
            ],
            tileSize: 256, maxzoom: 19,
            attribution: "© CARTO © OpenStreetMap contributors" }
        },
        layers: [
          { id: "esri",         type: "raster", source: "esri" },
          { id: "carto_labels", type: "raster", source: "carto_labels", minzoom: 11 }
        ]
      },
      center: pickedLatLng ? [pickedLatLng.lng, pickedLatLng.lat] : [39.2789, -6.7924],
      zoom: pickedLatLng ? 15 : 11,
      maxBounds: [[29.34, -11.75], [40.45, -0.99]]
    });
    pinMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    const el = document.createElement("div");
    el.style.cssText = "width:32px;height:42px;display:flex;align-items:center;justify-content:center;cursor:grab;";
    el.innerHTML = `
      <svg width="32" height="42" viewBox="0 0 32 42" fill="none">
        <path d="M16 0C7.2 0 0 7.2 0 16c0 12 16 26 16 26s16-14 16-26C32 7.2 24.8 0 16 0z" fill="#0a6f4d" stroke="#fff" stroke-width="2"/>
        <circle cx="16" cy="16" r="6" fill="#fff"/>
      </svg>`;

    pinMarker = new maplibregl.Marker({ element: el, draggable: true, anchor: "bottom" })
      .setLngLat(pickedLatLng ? [pickedLatLng.lng, pickedLatLng.lat] : pinMap.getCenter())
      .addTo(pinMap);
    pinMarker.on("dragend", () => {
      const ll = pinMarker.getLngLat();
      pickedLatLng = { lat: ll.lat, lng: ll.lng };
      updatePinReadout();
    });

    // Clicking the map also places the pin where the user tapped.
    pinMap.on("click", (e) => {
      pinMarker.setLngLat(e.lngLat);
      pickedLatLng = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      updatePinReadout();
    });

    // If we have an existing pin, mark it as picked immediately.
    if (pickedLatLng) updatePinReadout();
  }

  function updatePinReadout() {
    if (!pickedLatLng) { fPinCoords.textContent = tr("ah_pin_none"); return; }
    fPinCoords.textContent = `📍 ${pickedLatLng.lat.toFixed(5)}, ${pickedLatLng.lng.toFixed(5)}`;
  }

  fPinGps.addEventListener("click", () => {
    if (!navigator.geolocation) { alert(tr("ah_err_no_geo")); return; }
    fPinGps.disabled = true;
    fPinGps.textContent = tr("ah_pin_locating");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        pickedLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (pinMarker) pinMarker.setLngLat([pickedLatLng.lng, pickedLatLng.lat]);
        if (pinMap)    pinMap.easeTo({ center: [pickedLatLng.lng, pickedLatLng.lat], zoom: 17 });
        updatePinReadout();
        fPinGps.disabled = false;
        fPinGps.textContent = tr("ah_pin_gps");
      },
      (err) => {
        fPinGps.disabled = false;
        fPinGps.textContent = tr("ah_pin_gps");
        alert(tr("ah_err_geo") + err.message);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // ---- Save listing (create or update) ------------------------------------
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formMsg.hidden = true;
    if (!pickedLatLng) {
      formMsg.className = "ah-msg error";
      formMsg.textContent = tr("ah_err_no_pin");
      formMsg.hidden = false;
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = tr("ah_saving");

    try {
      const { data: { session } } = await sb.auth.getSession();
      const uid = session?.user?.id;
      if (!uid) throw new Error(tr("ah_err_session_expired"));

      // 1. Upload photo if a new one was staged.
      let photoPath = stagedPhotoExisting || null;
      if (stagedPhoto) {
        photoPath = await uploadPhoto(stagedPhoto, uid);
      }

      // 2. Gather amenities
      const amenities = Array.from(fAmenities.querySelectorAll("input:checked")).map(i => i.value);

      // 3. Build row
      const id = editingId || generateId();
      const row = {
        id,
        title:       fTitle.value.trim(),
        type:        fType.value,
        listing:     fListing.value,
        price_tzs:   Number(fPrice.value) || 0,
        currency:    "TZS",
        period:      fPeriod.value,
        bedrooms:    Number(fBedrooms.value) || 0,
        bathrooms:   Number(fBathrooms.value) || 0,
        size_sqm:    fSize.value ? Number(fSize.value) : null,
        region:      fRegion.value || null,
        area:        fArea.value.trim() || null,
        address:     fAddress.value.trim() || null,
        lat:         pickedLatLng.lat,
        lng:         pickedLatLng.lng,
        amenities,
        furnished:   fFurnished.value,
        photo:       photoPath,
        description: fDescription.value.trim() || null,
        available_from: fAvailable.value || null,
        agent: {
          name:  session.user.user_metadata?.name || session.user.email?.split("@")[0] || "Agent",
          phone: fAgentPhone.value.trim() || null,
          whatsapp: true
        },
        owner_user_id: uid
      };

      // 4. Insert or update
      const { error } = editingId
        ? await sb.from("houses").update(row).eq("id", editingId).eq("owner_user_id", uid)
        : await sb.from("houses").insert(row);
      if (error) {
        // Missing-table → kick the user back to the dashboard so the
        // setup card is visible, rather than burying the same error
        // inside the form.
        if (/relation .* does not exist|schema cache/i.test(error.message)) {
          closeForm();
          renderSetupCard();
          return;
        }
        throw error;
      }

      formMsg.className = "ah-msg success";
      formMsg.textContent = editingId ? tr("ah_msg_saved_edit") : tr("ah_msg_saved_new");
      formMsg.hidden = false;
      setTimeout(() => {
        closeForm();
        loadMyListings();
      }, 700);
    } catch (err) {
      console.warn("save listing", err);
      formMsg.className = "ah-msg error";
      formMsg.textContent = err.message || tr("ah_msg_save_fail");
      formMsg.hidden = false;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = tr("ah_save");
    }
  });

  // Upload a data-URL JPEG to the house-photos bucket and return the path.
  async function uploadPhoto(dataUrl, uid) {
    const bucket = (window.APP_CONFIG && window.APP_CONFIG.HOUSE_PHOTOS_BUCKET) || "house-photos";
    const blob = await (await fetch(dataUrl)).blob();
    const ext  = "jpg";
    const path = `${uid}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await sb.storage.from(bucket).upload(path, blob, {
      contentType: "image/jpeg",
      upsert: false
    });
    if (error) throw error;
    return path;
  }

  // ---- Delete listing ------------------------------------------------------
  async function deleteListing(row) {
    if (!confirm(tr("ah_confirm_delete").replace("{title}", row.title))) return;
    const { data: { session } } = await sb.auth.getSession();
    const uid = session?.user?.id;
    const { error } = await sb.from("houses").delete().eq("id", row.id).eq("owner_user_id", uid);
    if (error) { alert(tr("ah_err_delete") + error.message); return; }
    // Best-effort: clean up the photo too.
    if (row.photo && !row.photo.startsWith("http") && !row.photo.startsWith("data/")) {
      const bucket = (window.APP_CONFIG && window.APP_CONFIG.HOUSE_PHOTOS_BUCKET) || "house-photos";
      sb.storage.from(bucket).remove([row.photo]).catch(() => {});
    }
    loadMyListings();
  }

  // ---- One-click setup card for missing Supabase table --------------------
  // SQL is a self-contained subset of supabase/schema_master.sql section 34
  // — drops the regions FK + admin policy so it can run on a fresh project.
  const SETUP_SQL = `-- Pawa Houses — public.houses table + house-photos storage bucket.
-- Paste this into your Supabase SQL editor and click "Run".

create table if not exists public.houses (
  id                text primary key,
  title             text not null,
  type              text not null check (type in ('apartment','house','plot','office')),
  listing           text not null check (listing in ('rent','sale')),
  price_tzs         bigint not null default 0 check (price_tzs >= 0),
  currency          text not null default 'TZS',
  period            text default 'month',
  bedrooms          int  not null default 0,
  bathrooms         int  not null default 0,
  size_sqm          int,
  region            text,
  area              text,
  address           text,
  lat               double precision,
  lng               double precision,
  amenities         text[] not null default '{}',
  furnished         text default 'no' check (furnished in ('yes','no','semi','n/a')),
  photo             text,
  description       text,
  verified          boolean not null default false,
  available_from    date,
  agent             jsonb not null default '{}'::jsonb,
  owner_user_id     uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists houses_region_idx     on public.houses (region);
create index if not exists houses_area_idx       on public.houses (area);
create index if not exists houses_type_idx       on public.houses (type);
create index if not exists houses_listing_idx    on public.houses (listing);
create index if not exists houses_price_idx      on public.houses (price_tzs);
create index if not exists houses_lat_lng_idx    on public.houses (lat, lng);

alter table public.houses enable row level security;

drop policy if exists "houses readable"     on public.houses;
drop policy if exists "houses owner insert" on public.houses;
drop policy if exists "houses owner update" on public.houses;
drop policy if exists "houses owner delete" on public.houses;

create policy "houses readable" on public.houses for select using (true);
create policy "houses owner insert" on public.houses for insert
  with check (auth.uid() is not null and owner_user_id = auth.uid());
create policy "houses owner update" on public.houses for update
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy "houses owner delete" on public.houses for delete
  using (owner_user_id = auth.uid());

-- house-photos storage bucket (public, 20 MB, jpeg/png/webp)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'house-photos', 'house-photos', true, 20971520,
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "house-photos readable" on storage.objects;
create policy "house-photos readable" on storage.objects for select
  using (bucket_id = 'house-photos');

drop policy if exists "house-photos upload" on storage.objects;
create policy "house-photos upload" on storage.objects for insert
  with check (bucket_id = 'house-photos' and auth.uid() is not null);`;

  function sqlEditorUrl() {
    const u = window.APP_CONFIG?.SUPABASE_URL || "";
    const m = u.match(/^https?:\/\/([^.]+)\.supabase\.co/i);
    return m ? `https://supabase.com/dashboard/project/${m[1]}/sql/new` : "https://supabase.com/dashboard";
  }

  function renderSetupCard() {
    // Hide the New-listing button while setup is needed.
    newBtn.hidden = true;
    warnEl.innerHTML = "";
    const tr = (k) => (window.t ? window.t(k) : k);
    const lineCount = SETUP_SQL.split("\n").length;
    listEl.innerHTML = `
      <div class="ah-setup-card">
        <div class="ah-setup-head">
          <div class="ah-setup-icon">⚙️</div>
          <div>
            <h3>${esc(tr("ah_setup_title"))}</h3>
            <p>${tr("ah_setup_desc_html")}</p>
          </div>
        </div>

        <div class="ah-setup-steps">
          <ol>
            <li>${tr("ah_setup_step_1_html")}</li>
            <li>${tr("ah_setup_step_2_html")}</li>
            <li>${tr("ah_setup_step_3_html")}</li>
            <li>${tr("ah_setup_step_4_html")}</li>
          </ol>
        </div>

        <div class="ah-setup-actions">
          <a class="ah-btn ah-btn-brand" target="_blank" rel="noopener"
             href="${sqlEditorUrl()}">${esc(tr("ah_setup_open_editor"))}</a>
          <button id="ahSetupCopy"   class="ah-btn" type="button">${esc(tr("ah_setup_copy_sql"))}</button>
          <button id="ahSetupReload" class="ah-btn" type="button">${esc(tr("ah_setup_reload"))}</button>
        </div>

        <details class="ah-setup-details" open>
          <summary>${esc(tr("ah_setup_show_sql"))} (${lineCount} ${esc(tr("ah_setup_lines"))})</summary>
          <pre class="ah-setup-sql" id="ahSetupSql">${esc(SETUP_SQL)}</pre>
        </details>
      </div>`;

    document.getElementById("ahSetupCopy")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(SETUP_SQL);
        const b = document.getElementById("ahSetupCopy");
        const old = b.textContent;
        b.textContent = tr("ah_setup_copied");
        setTimeout(() => { b.textContent = old; }, 1500);
      } catch (_) {
        // Fallback: select the <pre> so user can long-press → copy.
        const range = document.createRange();
        range.selectNodeContents(document.getElementById("ahSetupSql"));
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
        alert(tr("ah_setup_copy_fail"));
      }
    });

    document.getElementById("ahSetupReload")?.addEventListener("click", () => {
      newBtn.hidden = false;
      loadMyListings();
    });
  }

  // ---- Helpers -------------------------------------------------------------
  function generateId() {
    return "h-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
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

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
};
