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
  const fPhotoGrid    = document.getElementById("ahPhotoGrid");
  const fVideoInput   = document.getElementById("ahVideoInput");
  const fVideoLabel   = document.getElementById("ahVideoLabel");
  const fVideoGrid    = document.getElementById("ahVideoGrid");

  // Map search + nearby panel + custom amenity input
  const fPinSearch       = document.getElementById("ahPinSearch");
  const fPinSearchResults= document.getElementById("ahPinSearchResults");
  const fNearbyPanel     = document.getElementById("ahNearbyPanel");
  const fNearbyRadius    = document.getElementById("ahNearbyRadius");
  const fNearbyRefresh   = document.getElementById("ahNearbyRefresh");
  const fNearbyStatus    = document.getElementById("ahNearbyStatus");
  const fCustomAmenity   = document.getElementById("ahCustomAmenity");
  const fAddAmenityBtn   = document.getElementById("ahAddAmenityBtn");

  // Media limits
  const MAX_PHOTOS    = 12;
  const MAX_VIDEOS    = 2;
  const MAX_VIDEO_S   = 60;            // seconds
  const MAX_VIDEO_B   = 60 * 1024 * 1024;  // 60 MB
  const fTitle        = document.getElementById("ahTitle");
  const fType         = document.getElementById("ahType");
  const fListing      = document.getElementById("ahListing");
  const fPrice        = document.getElementById("ahPrice");
  const fPeriod       = document.getElementById("ahPeriod");
  const fMinMonths    = document.getElementById("ahMinMonths");
  const fMinMonthsRow = document.getElementById("ahMinMonthsRow");
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
  const fPinPlace     = document.getElementById("ahPinPlace");
  const fPinPlaceName = document.getElementById("ahPinPlaceName");
  const fPinPlaceMeta = document.getElementById("ahPinPlaceMeta");
  const fPinFill      = document.getElementById("ahPinFill");
  const formMsg       = document.getElementById("ahFormMsg");
  const saveBtn       = document.getElementById("ahSaveBtn");
  const cancelBtn     = document.getElementById("ahCancelBtn");

  // ---- State ---------------------------------------------------------------
  let mode          = "auth";       // 'auth' | 'dashboard' | 'form'
  let authMode      = "signin";     // 'signin' | 'signup'
  let editingId     = null;         // null = create, set = editing this id
  let pickedLatLng  = null;         // { lat, lng }
  let pinMap        = null;
  let pinMarker     = null;
  let customAmenities = [];         // free-text amenities added by the agent
  let nearbyData      = null;       // { schools: {label,icon,items[]}, ... }
  let nearbyFetchKey  = null;       // serialised lat/lng we last fetched for
  let nearbyTimer     = null;       // debounce timer for Overpass calls
  let searchTimer     = null;       // debounce timer for Mapbox search
  let gpsAccuracyM    = null;       // accuracy (metres) of the last GPS fix, if any
  let geocodeTimer    = null;       // debounce timer for reverse-geocode lookups
  let geocodeKey      = null;       // lat/lng we last reverse-geocoded for
  let resolvedPlace   = null;       // { road, area, region, label } from reverse geocode
  let gpsWatchId      = null;       // active watchPosition id (best-fix capture)

  // ---- Media state (multi-photo + multi-video) -----------------------------
  // Each tile carries one of:
  //   { kind:'staged-photo', dataUrl, file, id }   newly added photo (not yet uploaded)
  //   { kind:'staged-video', objectUrl, file, id } newly added video (not yet uploaded)
  //   { kind:'existing',     path, mediaType, id } already in storage (path only)
  // First photo tile is automatically used as the cover (`photo` column).
  let photoTiles = [];
  let videoTiles = [];
  let dragSrcId  = null;

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

  // ---- Setup SQL (declared early so renderSetupCard can run from any await
  //      branch without hitting a temporal-dead-zone ReferenceError) --------
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
  min_months        int  not null default 1,  -- min months a renter pays upfront
  region            text,
  area              text,
  address           text,
  lat               double precision,
  lng               double precision,
  amenities         text[] not null default '{}',
  furnished         text default 'no',  -- free-text (e.g. "fridge, gas cooker")
  photo             text,
  photos            text[] not null default '{}'::text[],
  videos            text[] not null default '{}'::text[],
  nearby            jsonb not null default '{}'::jsonb,
  description       text,
  verified          boolean not null default false,
  available_from    date,
  agent             jsonb not null default '{}'::jsonb,
  owner_user_id     uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Idempotent column adds for older databases.
alter table public.houses add column if not exists photos text[] not null default '{}'::text[];
alter table public.houses add column if not exists videos text[] not null default '{}'::text[];
alter table public.houses add column if not exists nearby jsonb  not null default '{}'::jsonb;
alter table public.houses add column if not exists min_months int not null default 1;
alter table public.houses add column if not exists owner_user_id uuid references auth.users(id) on delete set null;
-- Drop legacy furnished CHECK if it exists, so the field can hold free text.
do $$
declare con record;
begin
  for con in
    select c.conname from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'houses' and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%furnished%'
  loop
    execute 'alter table public.houses drop constraint if exists "' || con.conname || '"';
  end loop;
end $$;

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

-- house-photos storage bucket (public, 60 MB, photos + short video clips)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'house-photos', 'house-photos', true, 62914560,
  array['image/jpeg','image/png','image/webp',
        'video/mp4','video/webm','video/quicktime']
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

  // ---- Surface any uncaught JS error as a visible banner -------------------
  // Without this, a typo or RLS bug stops the script halfway through binding
  // event listeners and the user sees buttons that look fine but do nothing.
  function showFatal(msg) {
    if (!warnEl) { alert(msg); return; }
    warnEl.innerHTML = `<div style="background:#fce4e4;color:#b91c1c;border:1px solid #f5b3b3;padding:12px 14px;border-radius:10px;margin-bottom:12px;font-size:.9rem;line-height:1.4"><strong>Agent dashboard error:</strong> ${esc(String(msg))}</div>`;
  }
  window.addEventListener("error", (e) => showFatal(e.message || "Unknown JS error"));
  window.addEventListener("unhandledrejection", (e) => showFatal(e.reason?.message || e.reason || "Promise rejected"));

  // ---- Critical button bindings (do this BEFORE any await so they always
  // work even if a later step throws) ---------------------------------------
  signOutBtn?.addEventListener("click", async () => {
    try {
      console.log("[agent-houses] sign out clicked");
      if (!sb) { location.reload(); return; }
      const { error } = await sb.auth.signOut();
      if (error) { showFatal("Sign out failed: " + error.message); return; }
      // onAuthStateChange handles the UI swap; force a reload as a fallback
      // in case the listener didn't get attached yet.
      setTimeout(() => location.reload(), 200);
    } catch (err) {
      showFatal("Sign out threw: " + (err.message || err));
    }
  });
  newBtn?.addEventListener("click", () => {
    try {
      console.log("[agent-houses] new listing clicked");
      openForm(null);
    } catch (err) {
      showFatal("Couldn't open form: " + (err.message || err));
    }
  });
  cancelBtn?.addEventListener("click", () => closeForm());

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
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) {
          // If the account already exists, treat the click as a sign-in attempt.
          if (/already registered|already been registered|user already/i.test(error.message || "")) {
            const { error: siErr } = await sb.auth.signInWithPassword({ email, password });
            if (siErr) throw siErr;
            return; // onAuthStateChange routes us into the dashboard.
          }
          throw error;
        }
        if (data?.session) {
          // confirm-email is OFF — the signUp call already signed them in.
          return;
        }
        // No session returned → Supabase has confirm-email turned ON.
        // Be explicit so they don't try to sign in next and hit "Email not confirmed".
        authMsg.className = "ah-msg success";
        authMsg.innerHTML =
          `Account created. Check <strong>${esc(email)}</strong> for a ` +
          `verification link, then come back here and sign in.`;
        authMsg.hidden = false;
        authMode = "signin";
        tabSignIn.click();
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // onAuthStateChange will route us into the dashboard.
      }
    } catch (err) {
      const msg = err?.message || "";
      authMsg.className = "ah-msg error";
      if (/invalid login|invalid_credentials|invalid_grant/i.test(msg)) {
        authMsg.innerHTML =
          `Wrong email or password. If you don't have an account yet, tap ` +
          `<strong>${esc(tr("ah_tab_signup") || "Create account")}</strong> above.`;
      } else if (/email not confirmed|email_not_confirmed/i.test(msg)) {
        authMsg.innerHTML =
          `Please confirm your email first — we sent a verification link to ` +
          `<strong>${esc(email)}</strong>. Open it, then come back here and sign in.`;
      } else if (/rate limit|over_email_send_rate_limit|too many/i.test(msg)) {
        authMsg.textContent = "Too many attempts. Please wait a minute, then try again.";
      } else if (/password.*should be at least|weak password|password is too short/i.test(msg)) {
        authMsg.textContent = "Password must be at least 6 characters.";
      } else {
        authMsg.textContent = msg || tr("ah_msg_auth_fail");
      }
      authMsg.hidden = false;
    } finally {
      authSubmit.disabled = false;
    }
  });

  // signOutBtn listener is attached above (before any await) so it works
  // even if init throws somewhere in between.

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
  // newBtn / cancelBtn listeners are attached above (before any await).

  // "Minimum months upfront" only makes sense for rentals — hide it for sale.
  function toggleMinMonths() {
    if (fMinMonthsRow) fMinMonthsRow.style.display = (fListing.value === "rent") ? "" : "none";
  }
  fListing?.addEventListener("change", toggleMinMonths);

  function openForm(row) {
    editingId = row?.id || null;
    formTitle.textContent = row ? tr("ah_form_title_edit") : tr("ah_form_title_new");
    formMsg.hidden = true;
    warmVideoGateway();  // wake the faststart service while the agent fills the form

    // Reset fields
    form.reset();
    pickedLatLng = null;
    photoTiles = [];
    videoTiles = [];
    customAmenities = [];
    nearbyData = null;
    nearbyFetchKey = null;
    gpsAccuracyM = null;
    resolvedPlace = null;
    geocodeKey = null;
    stopGpsWatch();
    if (fPinPlace) fPinPlace.hidden = true;
    fPinCoords.textContent = "No pin set";
    if (fPinSearch)        fPinSearch.value = "";
    if (fPinSearchResults) fPinSearchResults.style.display = "none";
    fAmenities.querySelectorAll(".ah-chip").forEach(c => c.classList.remove("active"));
    fAmenities.querySelectorAll("input").forEach(i => i.checked = false);
    fAmenities.querySelectorAll(".ah-chip--custom").forEach(c => c.remove());
    if (fFurnished) fFurnished.value = "";
    if (fMinMonths) fMinMonths.value = 1;

    if (row) {
      fTitle.value       = row.title || "";
      fType.value        = row.type || "apartment";
      fListing.value     = row.listing || "rent";
      fPrice.value       = row.price_tzs || "";
      fPeriod.value      = row.period || (row.listing === "sale" ? "total" : "month");
      if (fMinMonths) fMinMonths.value = row.min_months ?? 1;
      fBedrooms.value    = row.bedrooms ?? 0;
      fBathrooms.value   = row.bathrooms ?? 0;
      fSize.value        = row.size_sqm ?? "";
      fRegion.value      = row.region || "";
      fArea.value        = row.area || "";
      fAddress.value     = row.address || "";
      fFurnished.value   = row.furnished || "";
      fDescription.value = row.description || "";
      fAvailable.value   = row.available_from || "";
      fAgentPhone.value  = row.agent?.phone || "";
      // Split saved amenities into predefined chips vs free-text custom chips.
      const knownKeys = new Set(AMENITY_OPTIONS.map(o => o.key));
      (row.amenities || []).forEach(k => {
        if (knownKeys.has(k)) {
          const chip = fAmenities.querySelector(`.ah-chip[data-key="${k}"]`);
          if (chip) { chip.classList.add("active"); chip.querySelector("input").checked = true; }
        } else if (k && typeof k === "string") {
          customAmenities.push(k);
        }
      });
      renderCustomAmenities();
      // Restore the saved nearby snapshot so the preview shows immediately;
      // it'll be refreshed on the next pin move.
      if (row.nearby && typeof row.nearby === "object") {
        nearbyData = row.nearby;
        nearbyFetchKey = row.lat != null && row.lng != null
          ? `${Number(row.lat).toFixed(4)},${Number(row.lng).toFixed(4)}`
          : null;
      }

      // Seed media tiles from existing arrays (back-compat: fall back to the
      // single legacy `photo` column when `photos` is empty).
      const existingPhotos = Array.isArray(row.photos) && row.photos.length
        ? row.photos
        : (row.photo ? [row.photo] : []);
      existingPhotos.forEach(p => photoTiles.push({
        kind: "existing", path: p, mediaType: "photo", id: nextTileId()
      }));
      (row.videos || []).forEach(v => videoTiles.push({
        kind: "existing", path: v, mediaType: "video", id: nextTileId()
      }));

      if (row.lat != null && row.lng != null) {
        pickedLatLng = { lat: Number(row.lat), lng: Number(row.lng) };
      }
    }

    renderMediaGrids();
    toggleMinMonths();   // show/hide the rent-only "minimum months" field

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

  // ---- Multi-photo + video upload -----------------------------------------
  let _tileSeq = 0;
  function nextTileId() { return "t" + (++_tileSeq); }

  fPhotoLabel.addEventListener("click", (e) => {
    if (photoTiles.length >= MAX_PHOTOS) {
      e.preventDefault();
      alert(`You can add up to ${MAX_PHOTOS} photos per listing.`);
      return;
    }
    fPhotoInput.click();
  });
  fPhotoInput.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";   // allow re-picking the same file
    for (const file of files) {
      if (photoTiles.length >= MAX_PHOTOS) {
        alert(`You can add up to ${MAX_PHOTOS} photos per listing.`);
        break;
      }
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
        alert(`"${file.name}" is not a supported image format.`);
        continue;
      }
      try {
        const dataUrl = await compressImage(file, 1600, 0.85);
        photoTiles.push({
          kind: "staged-photo",
          dataUrl,
          file,
          id: nextTileId()
        });
        renderMediaGrids();
      } catch (err) {
        alert(`Couldn't read "${file.name}": ` + err.message);
      }
    }
  });

  fVideoLabel.addEventListener("click", (e) => {
    if (videoTiles.length >= MAX_VIDEOS) {
      e.preventDefault();
      alert(`You can add up to ${MAX_VIDEOS} videos per listing.`);
      return;
    }
    fVideoInput.click();
  });
  fVideoInput.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    for (const file of files) {
      if (videoTiles.length >= MAX_VIDEOS) {
        alert(`You can add up to ${MAX_VIDEOS} videos per listing.`);
        break;
      }
      if (file.size > MAX_VIDEO_B) {
        alert(`"${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is 60 MB per video.`);
        continue;
      }
      let durationOk = false;
      try { durationOk = await checkVideoDuration(file, MAX_VIDEO_S); }
      catch (err) { alert(`Couldn't read "${file.name}": ` + err.message); continue; }
      if (!durationOk) {
        alert(`"${file.name}" is longer than ${MAX_VIDEO_S} seconds. Please trim it first.`);
        continue;
      }
      const objectUrl = URL.createObjectURL(file);
      videoTiles.push({
        kind: "staged-video",
        objectUrl,
        file,
        id: nextTileId()
      });
      renderMediaGrids();
    }
  });

  function compressImage(file, maxW, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const ratio = Math.min(1, maxW / img.width);
        const w = Math.round(img.width  * ratio);
        const h = Math.round(img.height * ratio);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        // High-quality downscale, then a tasteful auto-enhance pass so phone
        // snaps look like professional listing photos.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, w, h);
        try { autoEnhancePhoto(ctx, w, h); }
        catch (err) { console.warn("[agent-houses] photo enhance skipped:", err?.message || err); }
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }

  // ---- Auto-enhance ---------------------------------------------------------
  // Turns flat, dim phone photos into bright, punchy listing shots WITHOUT
  // looking artificial. Pipeline, all on a 2D canvas (no libraries):
  //   1. Auto-levels — stretch the luminance histogram between its 0.4% and
  //      99.6% percentiles so blacks are black and whites are white. The
  //      stretch is applied per RGB channel through the SAME luma window,
  //      which also neutralises mild colour casts (grey-world white balance).
  //   2. Gentle S-curve contrast for depth, a soft midtone lift so interiors
  //      don't go muddy, and a modest saturation bump.
  //   3. Light unsharp mask for crispness.
  // Every step is intentionally restrained — a low-contrast guard skips the
  // stretch on already well-exposed photos so we never wreck a good image.
  function autoEnhancePhoto(ctx, w, h) {
    const SAT       = 1.14;   // saturation multiplier
    const CONTRAST  = 0.14;   // S-curve strength
    const MID_LIFT  = 0.05;   // brighten shadows/midtones
    const SHARPEN   = 0.45;   // unsharp amount (0 = off)

    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const px = d.length / 4;

    // 1) Luminance histogram → percentile clip points.
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const y = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      hist[y]++;
    }
    const clip = px * 0.004;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > clip) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > clip) { hi = v; break; } }
    // Low-contrast / already-balanced guard: don't force a stretch.
    if (hi - lo < 24) { lo = 0; hi = 255; }
    const scale = 255 / Math.max(1, hi - lo);

    // Build a tone-mapping LUT once: levels → S-curve contrast → midtone lift.
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      let x = (v - lo) * scale;
      if (x < 0) x = 0; else if (x > 255) x = 255;
      let t = x / 255;
      // Smooth S-curve centred on mid-grey.
      t = t + CONTRAST * (t - 0.5) * (1 - Math.abs(2 * t - 1)) * 2;
      // Lift midtones a touch (gamma-ish, keeps highlights intact).
      t = t + MID_LIFT * Math.sin(t * Math.PI);
      lut[v] = Math.round(Math.min(1, Math.max(0, t)) * 255);
    }

    // Apply tone curve + saturation.
    for (let i = 0; i < d.length; i += 4) {
      let r = lut[d[i]], g = lut[d[i + 1]], b = lut[d[i + 2]];
      const y = r * 0.299 + g * 0.587 + b * 0.114;
      r = y + (r - y) * SAT;
      g = y + (g - y) * SAT;
      b = y + (b - y) * SAT;
      d[i]     = r < 0 ? 0 : r > 255 ? 255 : r;
      d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }

    // 3) Light unsharp mask: blend each pixel away from its 4-neighbour mean.
    if (SHARPEN > 0) {
      const src = new Uint8ClampedArray(d);            // tone-mapped copy
      const idx = (x, y) => (y * w + x) * 4;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const o = idx(x, y);
          for (let ch = 0; ch < 3; ch++) {
            const c0 = src[o + ch];
            const mean = (src[idx(x - 1, y) + ch] + src[idx(x + 1, y) + ch] +
                          src[idx(x, y - 1) + ch] + src[idx(x, y + 1) + ch]) * 0.25;
            const val = c0 + (c0 - mean) * SHARPEN;
            d[o + ch] = val < 0 ? 0 : val > 255 ? 255 : val;
          }
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
  }

  function checkVideoDuration(file, maxSec) {
    return new Promise((resolve, reject) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.onloadedmetadata = () => {
        URL.revokeObjectURL(v.src);
        resolve(v.duration <= maxSec + 0.5);   // half-second tolerance
      };
      v.onerror = () => reject(new Error("Couldn't read video metadata"));
      v.src = URL.createObjectURL(file);
    });
  }

  // ---- Render media grids -------------------------------------------------
  function renderMediaGrids() {
    renderTileGrid(fPhotoGrid, photoTiles, "photo");
    renderTileGrid(fVideoGrid, videoTiles, "video");
    fPhotoLabel.classList.toggle("full", photoTiles.length >= MAX_PHOTOS);
    fVideoLabel.classList.toggle("full", videoTiles.length >= MAX_VIDEOS);
  }

  function renderTileGrid(gridEl, tiles, kind) {
    if (!gridEl) return;
    gridEl.innerHTML = tiles.map((t, i) => tileHtml(t, kind, i)).join("");
    gridEl.querySelectorAll(".ah-media-tile").forEach(el => {
      const id = el.dataset.id;
      el.querySelector(".ah-tile-remove")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (kind === "photo") photoTiles = photoTiles.filter(t => t.id !== id);
        else                  videoTiles = videoTiles.filter(t => t.id !== id);
        renderMediaGrids();
      });
      // Drag-to-reorder within the same grid.
      el.draggable = true;
      el.addEventListener("dragstart", (e) => {
        dragSrcId = id;
        el.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", id); } catch (_) {}
      });
      el.addEventListener("dragend", () => {
        el.classList.remove("dragging");
        gridEl.querySelectorAll(".drop-target").forEach(d => d.classList.remove("drop-target"));
        dragSrcId = null;
      });
      el.addEventListener("dragover", (e) => {
        if (!dragSrcId || dragSrcId === id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        el.classList.add("drop-target");
      });
      el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        el.classList.remove("drop-target");
        const arr = kind === "photo" ? photoTiles : videoTiles;
        const from = arr.findIndex(t => t.id === dragSrcId);
        const to   = arr.findIndex(t => t.id === id);
        if (from < 0 || to < 0 || from === to) return;
        const [moved] = arr.splice(from, 1);
        arr.splice(to, 0, moved);
        renderMediaGrids();
      });
    });
  }

  function tileHtml(t, kind, idx) {
    const src = t.kind === "staged-photo" ? t.dataUrl
              : t.kind === "staged-video" ? t.objectUrl
              : window.DataStore.housePhotoUrl(t.path);
    const isVideo = kind === "video";
    const cover  = (!isVideo && idx === 0) ? `<span class="ah-cover-flag">Cover</span>` : "";
    const enhanced = (t.kind === "staged-photo")
      ? `<span class="ah-enhanced-flag" title="Auto-enhanced for clarity & colour">✨ Enhanced</span>` : "";
    const flag   = isVideo ? `<span class="ah-video-flag">▶ Video</span>` : enhanced;
    const media  = isVideo
      ? `<video src="${esc(src)}" muted playsinline preload="metadata"></video>`
      : `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">`;
    return `
      <div class="ah-media-tile" data-id="${esc(t.id)}" data-kind="${kind}">
        ${media}
        ${cover}
        ${flag}
        <button type="button" class="ah-tile-remove" aria-label="Remove">&times;</button>
      </div>`;
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
          // Street + place-name labels kick in earlier (z≥9) so agents can
          // read road names while still zoomed out and pin the exact street.
          { id: "carto_labels", type: "raster", source: "carto_labels", minzoom: 9 }
        ]
      },
      center: pickedLatLng ? [pickedLatLng.lng, pickedLatLng.lat] : [39.2789, -6.7924],
      zoom: pickedLatLng ? 16 : 11,
      maxBounds: [[29.34, -11.75], [40.45, -0.99]]
    });
    pinMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    // GPS-accuracy circle (filled when a device fix arrives) — shows buyers
    // and the agent how tight the location lock is.
    pinMap.on("load", () => {
      if (pinMap.getSource("ah-acc")) return;
      pinMap.addSource("ah-acc", { type: "geojson", data: emptyFC() });
      pinMap.addLayer({
        id: "ah-acc-fill", type: "fill", source: "ah-acc",
        paint: { "fill-color": "#0a6f4d", "fill-opacity": 0.12 }
      });
      pinMap.addLayer({
        id: "ah-acc-line", type: "line", source: "ah-acc",
        paint: { "line-color": "#0a6f4d", "line-width": 1.5, "line-dasharray": [2, 2] }
      });
    });

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
      gpsAccuracyM = null;          // hand-placed → no device accuracy
      drawAccuracyCircle(null);
      updatePinReadout();
    });

    // Clicking the map also places the pin where the user tapped.
    pinMap.on("click", (e) => {
      pinMarker.setLngLat(e.lngLat);
      pickedLatLng = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      gpsAccuracyM = null;
      drawAccuracyCircle(null);
      updatePinReadout();
    });

    // If we have an existing pin, mark it as picked immediately.
    if (pickedLatLng) updatePinReadout();
  }

  function updatePinReadout() {
    if (!pickedLatLng) {
      fPinCoords.textContent = tr("ah_pin_none");
      nearbyData = null;
      resolvedPlace = null;
      if (fPinPlace) fPinPlace.hidden = true;
      drawAccuracyCircle(null);
      renderNearbyPanel();
      if (pinMap && window.AreaBoundary) AreaBoundary.clearMapLibre(pinMap);
      pinBoundaryKey = null;
      return;
    }
    const acc = accuracyBadge();
    fPinCoords.innerHTML =
      `📍 ${pickedLatLng.lat.toFixed(5)}, ${pickedLatLng.lng.toFixed(5)}${acc}`;
    scheduleNearbyRefresh();
    scheduleReverseGeocode();
    drawPinBoundary();
  }

  // Shade the administrative area (ward/suburb) the dropped pin falls within so
  // the agent can confirm the listing sits in the right neighbourhood. Keyed so
  // it only re-fetches when the pin actually moves to a new ~100 m cell.
  let pinBoundaryKey = null;
  async function drawPinBoundary() {
    if (!pinMap || !pickedLatLng || !window.AreaBoundary || !window.pawaGeo || !pawaGeo.boundary) return;
    const key = `${pickedLatLng.lat.toFixed(3)},${pickedLatLng.lng.toFixed(3)}`;
    if (key === pinBoundaryKey) return;
    pinBoundaryKey = key;
    const b = await pawaGeo.boundary({ lat: pickedLatLng.lat, lng: pickedLatLng.lng });
    if (pinBoundaryKey !== key) return;   // pin moved again before this returned
    if (b && AreaBoundary.isAreal(b.geojson)) {
      AreaBoundary.showOnMapLibre(pinMap, b.geojson, { fit: false });
    } else {
      AreaBoundary.clearMapLibre(pinMap);
    }
  }

  // Pretty accuracy chip appended to the coords readout. `null` means the pin
  // was placed/edited by hand (no device accuracy to report).
  function accuracyBadge() {
    if (gpsAccuracyM == null) return "";
    const m = Math.round(gpsAccuracyM);
    const cls = m <= 15 ? "good" : m <= 50 ? "ok" : "poor";
    const txt = cls === "good" ? `±${m} m · precise`
              : cls === "ok"   ? `±${m} m`
              :                  `±${m} m · move closer`;
    return ` <span class="ah-pin-acc ${cls}">${txt}</span>`;
  }

  // ---- Accuracy circle on the pin map -------------------------------------
  function emptyFC() { return { type: "FeatureCollection", features: [] }; }
  function geoCircle(lat, lng, radiusM, sides = 48) {
    const R = 6378137, coords = [];
    for (let i = 0; i <= sides; i++) {
      const t = (i / sides) * 2 * Math.PI;
      const dLat = (radiusM * Math.sin(t) / R) * (180 / Math.PI);
      const dLng = (radiusM * Math.cos(t) / R) * (180 / Math.PI) / Math.cos(lat * Math.PI / 180);
      coords.push([lng + dLng, lat + dLat]);
    }
    return { type: "Feature", geometry: { type: "Polygon", coordinates: [coords] }, properties: {} };
  }
  function drawAccuracyCircle(radiusM) {
    if (!pinMap) return;
    const src = pinMap.getSource("ah-acc");
    if (!src) return;   // style not loaded yet
    if (!radiusM || !pickedLatLng) { src.setData(emptyFC()); return; }
    src.setData({ type: "FeatureCollection",
      features: [geoCircle(pickedLatLng.lat, pickedLatLng.lng, radiusM)] });
  }

  // ---- Reverse geocoding (Nominatim — confirms the pin sits on a real,
  //      named street/area so listings can't fake a location) --------------
  function scheduleReverseGeocode() {
    clearTimeout(geocodeTimer);
    geocodeTimer = setTimeout(() => reverseGeocode(), 600);
  }
  async function reverseGeocode() {
    if (!pickedLatLng) return;
    const key = `${pickedLatLng.lat.toFixed(5)},${pickedLatLng.lng.toFixed(5)}`;
    if (key === geocodeKey && resolvedPlace) { renderPinPlace(); return; }
    geocodeKey = key;
    if (fPinPlace) {
      fPinPlace.hidden = false;
      fPinPlace.classList.add("is-loading");
      fPinPlaceName.textContent = "Confirming the street…";
      fPinPlaceMeta.textContent = "";
      if (fPinFill) fPinFill.hidden = true;
    }
    try {
      const j = await pawaGeo.reverse(`format=jsonv2&lat=${pickedLatLng.lat}&lon=${pickedLatLng.lng}&zoom=18&addressdetails=1`);
      // If the pin moved again while we were waiting, drop this stale answer.
      if (key !== geocodeKey) return;
      const a = j.address || {};
      const road = a.road || a.pedestrian || a.footway || a.residential || a.path || "";
      const area = a.neighbourhood || a.suburb || a.quarter || a.village
                 || a.town || a.city_district || a.hamlet || "";
      const city = a.city || a.town || a.municipality || a.county || "";
      const region = a.state || a.region || "";
      resolvedPlace = {
        road, area, region, city,
        label: j.display_name || "",
        found: !!(road || area || city)
      };
      renderPinPlace();
    } catch (err) {
      if (key !== geocodeKey) return;
      resolvedPlace = null;
      if (fPinPlace) {
        fPinPlace.classList.remove("is-loading");
        fPinPlaceName.textContent = "Couldn't verify the street (offline?)";
        fPinPlaceMeta.textContent = "Your pin still saves — buyers see it on the map.";
        if (fPinFill) fPinFill.hidden = true;
      }
    }
  }
  function renderPinPlace() {
    if (!fPinPlace || !resolvedPlace) return;
    fPinPlace.classList.remove("is-loading");
    if (!resolvedPlace.found) {
      fPinPlaceName.textContent = "No named street here";
      fPinPlaceMeta.textContent = "This looks like open land — double-check the pin sits on the property.";
      if (fPinFill) fPinFill.hidden = true;
      return;
    }
    const primary = resolvedPlace.road
      ? `${resolvedPlace.road}${resolvedPlace.area ? ", " + resolvedPlace.area : ""}`
      : (resolvedPlace.area || resolvedPlace.city);
    fPinPlaceName.textContent = primary || "Location confirmed";
    fPinPlaceMeta.textContent = [resolvedPlace.city, resolvedPlace.region]
      .filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(" · ");
    if (fPinFill) fPinFill.hidden = false;
  }

  // ---- Mapbox geocoding (search box) --------------------------------------
  function mapboxToken() {
    return (window.APP_CONFIG && window.APP_CONFIG.MAPBOX_TOKEN) || "";
  }
  async function mapboxSearch(q) {
    const token = mapboxToken();
    if (!token || !q || q.length < 2) return [];
    const proximity = pickedLatLng
      ? `&proximity=${pickedLatLng.lng},${pickedLatLng.lat}`
      : `&proximity=39.2789,-6.7924`; // Dar es Salaam — biases to TZ centres
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json`
              + `?access_token=${token}&country=tz&autocomplete=true&limit=6&language=en${proximity}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return [];
      const j = await res.json();
      return (j.features || []).map(f => ({
        name: f.place_name || f.text,
        lat:  f.center?.[1],
        lng:  f.center?.[0]
      })).filter(r => r.lat != null && r.lng != null);
    } catch (_) {
      return [];
    }
  }
  function renderSearchResults(rows) {
    if (!fPinSearchResults) return;
    if (!rows.length) { fPinSearchResults.style.display = "none"; return; }
    fPinSearchResults.innerHTML = rows.map((r, i) => `
      <button type="button" class="ah-search-row" data-i="${i}"
              style="display:block;width:100%;text-align:left;border:0;background:transparent;padding:10px 14px;border-bottom:1px solid #eef1f4;cursor:pointer;font-size:.9rem;">
        ${esc(r.name)}
      </button>
    `).join("");
    fPinSearchResults.style.display = "block";
    fPinSearchResults.querySelectorAll(".ah-search-row").forEach(b => {
      b.addEventListener("click", () => {
        const r = rows[Number(b.dataset.i)];
        pickedLatLng = { lat: r.lat, lng: r.lng };
        gpsAccuracyM = null;
        drawAccuracyCircle(null);
        if (pinMarker) pinMarker.setLngLat([r.lng, r.lat]);
        if (pinMap)    pinMap.easeTo({ center: [r.lng, r.lat], zoom: 16, duration: 600 });
        updatePinReadout();
        fPinSearch.value = r.name;
        fPinSearchResults.style.display = "none";
      });
    });
  }
  fPinSearch?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = fPinSearch.value.trim();
    if (!q) { fPinSearchResults.style.display = "none"; return; }
    searchTimer = setTimeout(async () => {
      const rows = await mapboxSearch(q);
      renderSearchResults(rows);
    }, 280);
  });
  fPinSearch?.addEventListener("blur", () => {
    // Delay so clicks on results land before we hide the panel.
    setTimeout(() => { fPinSearchResults.style.display = "none"; }, 180);
  });
  fPinSearch?.addEventListener("focus", () => {
    if (fPinSearchResults?.children.length) fPinSearchResults.style.display = "block";
  });

  // ---- Overpass nearby POI lookup -----------------------------------------
  let NEARBY_RADIUS_M = 1500;
  function setNearbyStatus(text) { if (fNearbyStatus) fNearbyStatus.textContent = text || ""; }
  function scheduleNearbyRefresh() {
    if (!pickedLatLng) return;
    clearTimeout(nearbyTimer);
    nearbyTimer = setTimeout(() => refreshNearby(), 450);
  }
  async function refreshNearby({ force = false } = {}) {
    if (!pickedLatLng) return;
    // Cache key includes radius so changing it triggers a real refetch.
    const key = `${pickedLatLng.lat.toFixed(4)},${pickedLatLng.lng.toFixed(4)}@${NEARBY_RADIUS_M}`;
    if (!force && key === nearbyFetchKey && nearbyData) {
      // Snapshot already loaded (e.g. restored on edit) — just paint it.
      renderNearbyPanel();
      return;
    }
    nearbyFetchKey = key;
    const radiusKm = (NEARBY_RADIUS_M / 1000).toFixed(NEARBY_RADIUS_M < 1000 ? 0 : 1);
    fNearbyPanel.innerHTML = `<p class="muted" style="margin:0;font-size:.9rem;">🔎 Scanning ${radiusKm} km around your pin for schools, hospitals, transport…</p>`;
    setNearbyStatus("scanning…");
    const lat = pickedLatLng.lat, lng = pickedLatLng.lng;
    const q = `
      [out:json][timeout:25];
      (
        node["amenity"~"^(school|kindergarten|college|university|hospital|clinic|doctors|pharmacy|bank|atm|marketplace|place_of_worship|bus_station|fuel|police|post_office|restaurant|cafe|fast_food)$"](around:${NEARBY_RADIUS_M},${lat},${lng});
        node["shop"~"^(supermarket|convenience|mall)$"](around:${NEARBY_RADIUS_M},${lat},${lng});
        node["public_transport"~"^(station|stop_position|platform)$"](around:${NEARBY_RADIUS_M},${lat},${lng});
        node["leisure"~"^(park|playground|sports_centre|stadium)$"](around:${NEARBY_RADIUS_M},${lat},${lng});
      );
      out body 200;`;
    try {
      const res = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: "data=" + encodeURIComponent(q)
      });
      if (!res.ok) throw new Error("overpass " + res.status);
      const j = await res.json();
      // If the pin/radius changed while we were waiting, drop this stale result.
      if (key !== nearbyFetchKey) return;
      nearbyData = groupNearby(j.elements || [], lat, lng);
      const total = Object.values(nearbyData).reduce((s, g) => s + g.items.length, 0);
      setNearbyStatus(`${total} place${total === 1 ? "" : "s"} within ${radiusKm} km`);
      renderNearbyPanel();
    } catch (err) {
      console.warn("[agent-houses] overpass failed", err);
      setNearbyStatus("scan failed");
      fNearbyPanel.innerHTML = `<p class="muted" style="margin:0;font-size:.9rem;color:#b91c1c;">Couldn't reach the nearby-places service — your listing will still save without this preview. Tap <strong>↻ Refresh</strong> to try again.</p>`;
    }
  }

  // Radius selector — segmented button group. Switching radius forces a
  // re-fetch since the cached snapshot is now stale.
  fNearbyRadius?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-r]");
    if (!btn || !fNearbyRadius.contains(btn)) return;
    const r = Number(btn.dataset.r);
    if (!Number.isFinite(r) || r <= 0 || r === NEARBY_RADIUS_M) return;
    NEARBY_RADIUS_M = r;
    fNearbyRadius.querySelectorAll("button[data-r]").forEach(b => {
      const on = Number(b.dataset.r) === NEARBY_RADIUS_M;
      b.classList.toggle("active", on);
      // Inline-style toggle since these buttons don't pull from a stylesheet.
      b.style.background = on ? "#0a6f4d" : "transparent";
      b.style.color      = on ? "#fff"    : "";
      b.style.fontWeight = on ? "600"     : "";
    });
    if (pickedLatLng) refreshNearby({ force: true });
  });

  // Manual refresh — useful if Overpass timed out, or to update after the
  // agent moved/edited tags on the property in the meantime.
  fNearbyRefresh?.addEventListener("click", () => {
    if (!pickedLatLng) {
      setNearbyStatus("drop a pin first");
      setTimeout(() => setNearbyStatus(""), 1800);
      return;
    }
    refreshNearby({ force: true });
  });
  function groupNearby(elements, lat, lng) {
    const G = {
      schools:    { label: "Schools",            icon: "🏫", items: [] },
      hospitals:  { label: "Hospitals & clinics",icon: "🏥", items: [] },
      pharmacies: { label: "Pharmacies",         icon: "💊", items: [] },
      worship:    { label: "Mosques & churches", icon: "🕌", items: [] },
      markets:    { label: "Markets & shops",    icon: "🛒", items: [] },
      banks:      { label: "Banks & ATMs",       icon: "🏧", items: [] },
      transport:  { label: "Transport",          icon: "🚌", items: [] },
      food:       { label: "Restaurants & cafes",icon: "🍽️", items: [] },
      services:   { label: "Public services",    icon: "🏛️", items: [] },
      leisure:    { label: "Parks & leisure",    icon: "🌳", items: [] }
    };
    for (const el of elements) {
      const t = el.tags || {};
      const a = t.amenity || "", s = t.shop || "", l = t.leisure || "";
      const name = t.name || t["name:en"] || t["name:sw"] || null;
      const dist = haversineMeters(lat, lng, el.lat, el.lon);
      const entry = { name, dist };
      if (/^(school|kindergarten|college|university)$/.test(a)) G.schools.items.push(entry);
      else if (/^(hospital|clinic|doctors)$/.test(a))            G.hospitals.items.push(entry);
      else if (a === "pharmacy")                                  G.pharmacies.items.push(entry);
      else if (a === "place_of_worship")                          G.worship.items.push(entry);
      else if (a === "marketplace" || /^(supermarket|convenience|mall)$/.test(s)) G.markets.items.push(entry);
      else if (/^(bank|atm)$/.test(a))                            G.banks.items.push(entry);
      else if (a === "bus_station" || t.public_transport)         G.transport.items.push(entry);
      else if (/^(restaurant|cafe|fast_food)$/.test(a))           G.food.items.push(entry);
      else if (/^(police|post_office|fuel)$/.test(a))             G.services.items.push(entry);
      else if (/^(park|playground|sports_centre|stadium)$/.test(l)) G.leisure.items.push(entry);
    }
    for (const k of Object.keys(G)) {
      const seen = new Set();
      G[k].items = G[k].items
        .sort((a, b) => a.dist - b.dist)
        .filter(it => { const key = (it.name || "") + "|" + it.dist; if (seen.has(key)) return false; seen.add(key); return true; })
        .slice(0, 8);
    }
    return G;
  }
  function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
  }
  function fmtDist(m) { return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`; }
  function renderNearbyPanel() {
    if (!fNearbyPanel) return;
    if (!pickedLatLng) {
      fNearbyPanel.innerHTML = `<p class="muted" style="margin:0;font-size:.9rem;">Drop a pin first, then this panel will fill in automatically.</p>`;
      return;
    }
    if (!nearbyData) return; // mid-fetch — already showed loader
    const cats = Object.entries(nearbyData).filter(([, g]) => g.items.length > 0);
    if (!cats.length) {
      fNearbyPanel.innerHTML = `<p class="muted" style="margin:0;font-size:.9rem;">No tagged services found in OpenStreetMap within 1.5 km. Buyers can still see your pin on the map.</p>`;
      return;
    }
    fNearbyPanel.innerHTML = cats.map(([, g]) => `
      <details class="ah-nearby-cat" style="margin:6px 0;background:#fff;border:1px solid #e6ebf0;border-radius:8px;padding:8px 10px;">
        <summary style="cursor:pointer;font-size:.92rem;display:flex;align-items:center;gap:8px;">
          <span style="font-size:1.05rem;">${g.icon}</span>
          <strong>${esc(g.label)}</strong>
          <span class="muted" style="margin-left:auto;font-size:.85rem;">${g.items.length}</span>
        </summary>
        <ul style="list-style:none;margin:8px 0 4px;padding:0 0 0 28px;font-size:.86rem;">
          ${g.items.map(it => `<li style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;">
            <span>${esc(it.name || "Unnamed")}</span>
            <span class="muted" style="white-space:nowrap;">${fmtDist(it.dist)}</span>
          </li>`).join("")}
        </ul>
      </details>
    `).join("");
  }

  // ---- Custom (free-text) amenities ---------------------------------------
  function addCustomAmenity(text) {
    const v = (text || "").trim();
    if (!v) return;
    // Normalise: lowercase comparison so duplicates don't pile up.
    const key = v.toLowerCase();
    if (customAmenities.some(x => x.toLowerCase() === key)) return;
    // Also dedupe against predefined keys (matched against translated label).
    const predefinedLabels = AMENITY_OPTIONS.map(o => (tr(o.i18n) || o.key).toLowerCase());
    if (predefinedLabels.includes(key)) {
      // Toggle the predefined chip on instead of adding a duplicate.
      const idx = predefinedLabels.indexOf(key);
      const chip = fAmenities.querySelector(`.ah-chip[data-key="${AMENITY_OPTIONS[idx].key}"]`);
      if (chip) {
        const cb = chip.querySelector("input");
        cb.checked = true;
        chip.classList.add("active");
      }
      return;
    }
    customAmenities.push(v);
    renderCustomAmenities();
  }
  function renderCustomAmenities() {
    // Remove old custom chips so we can re-render in order.
    fAmenities.querySelectorAll(".ah-chip.ah-chip--custom").forEach(c => c.remove());
    for (const v of customAmenities) {
      const chip = document.createElement("label");
      chip.className = "ah-chip ah-chip--custom active";
      chip.dataset.custom = "1";
      chip.dataset.label  = v;
      chip.innerHTML = `
        <input type="checkbox" checked value="${esc(v)}">
        ${esc(v)}
        <button type="button" class="ah-chip-x" aria-label="Remove"
                style="margin-left:6px;border:0;background:transparent;cursor:pointer;font-weight:700;color:#888;">×</button>
      `;
      chip.querySelector(".ah-chip-x").addEventListener("click", (e) => {
        e.stopPropagation();
        customAmenities = customAmenities.filter(x => x !== v);
        chip.remove();
      });
      fAmenities.appendChild(chip);
    }
  }
  fAddAmenityBtn?.addEventListener("click", () => {
    addCustomAmenity(fCustomAmenity.value);
    fCustomAmenity.value = "";
    fCustomAmenity.focus();
  });
  fCustomAmenity?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addCustomAmenity(fCustomAmenity.value);
      fCustomAmenity.value = "";
    }
  });

  // GPS pinning with "best-fix" capture: a single getCurrentPosition often
  // returns a coarse cell-tower fix first. We watch for a few seconds and keep
  // the tightest reading, stopping early once it's precise enough (≤12 m).
  fPinGps.addEventListener("click", () => {
    if (!navigator.geolocation) { alert(tr("ah_err_no_geo")); return; }
    // A second tap cancels an in-progress lock.
    if (gpsWatchId != null) { stopGpsWatch(); return; }

    fPinGps.disabled = false;            // keep tappable so it can cancel
    fPinGps.textContent = tr("ah_pin_locating");
    let best = null;
    const GOOD_ENOUGH_M = 12;
    const MAX_WAIT_MS    = 8000;

    const applyFix = (pos) => {
      pickedLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      gpsAccuracyM = pos.coords.accuracy ?? null;
      if (pinMarker) pinMarker.setLngLat([pickedLatLng.lng, pickedLatLng.lat]);
      if (pinMap) {
        // Zoom tighter for precise fixes, looser when accuracy is poor.
        const z = gpsAccuracyM == null ? 17 : gpsAccuracyM <= 25 ? 18 : gpsAccuracyM <= 80 ? 16 : 15;
        pinMap.easeTo({ center: [pickedLatLng.lng, pickedLatLng.lat], zoom: z });
      }
      drawAccuracyCircle(gpsAccuracyM);
      updatePinReadout();
    };

    const finish = () => {
      stopGpsWatch();
      if (best) applyFix(best);
    };

    gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (!best || (pos.coords.accuracy ?? 1e9) < (best.coords.accuracy ?? 1e9)) {
          best = pos;
          applyFix(pos);     // show progress as it tightens
        }
        if ((pos.coords.accuracy ?? 1e9) <= GOOD_ENOUGH_M) finish();
      },
      (err) => {
        stopGpsWatch();
        if (!best) alert(tr("ah_err_geo") + err.message);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: MAX_WAIT_MS }
    );
    // Hard stop so the button never gets stuck spinning.
    setTimeout(finish, MAX_WAIT_MS);
  });

  function stopGpsWatch() {
    if (gpsWatchId != null) {
      try { navigator.geolocation.clearWatch(gpsWatchId); } catch (_) {}
      gpsWatchId = null;
    }
    fPinGps.disabled = false;
    fPinGps.textContent = tr("ah_pin_gps");
  }

  // "Use this address" — fill the address / area / region fields from the
  // reverse-geocoded place so the typed text always matches the real pin.
  fPinFill?.addEventListener("click", () => {
    if (!resolvedPlace) return;
    const street = resolvedPlace.road
      ? `${resolvedPlace.road}${resolvedPlace.area ? ", " + resolvedPlace.area : ""}`
      : (resolvedPlace.area || resolvedPlace.city || "");
    if (street && fAddress) fAddress.value = street;
    if (resolvedPlace.area && fArea && !fArea.value.trim()) fArea.value = resolvedPlace.area;
    // Match the region <select> if the geocoded region is one of its options.
    if (resolvedPlace.region && fRegion) {
      const opt = Array.from(fRegion.options)
        .find(o => o.value.toLowerCase() === resolvedPlace.region.toLowerCase());
      if (opt) fRegion.value = opt.value;
    }
    fPinFill.textContent = "✓ Filled";
    setTimeout(() => { fPinFill.textContent = "Use this address"; }, 1500);
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

      // 1. Upload any newly-staged media (preserves the user's ordering).
      const photoPaths = [];
      for (const t of photoTiles) {
        if (t.kind === "existing")          photoPaths.push(t.path);
        else if (t.kind === "staged-photo") photoPaths.push(await uploadDataUrl(t.dataUrl, uid, "jpg", "image/jpeg"));
      }
      const videoPaths = [];
      for (const t of videoTiles) {
        if (t.kind === "existing")          videoPaths.push(t.path);
        else if (t.kind === "staged-video") videoPaths.push(await uploadFile(await faststart(t.file), uid));
      }
      const coverPath = photoPaths[0] || null;

      // 2. Gather amenities — predefined chips + free-text customs (deduped).
      const checkedKeys = Array.from(
        fAmenities.querySelectorAll('.ah-chip:not(.ah-chip--custom) input:checked')
      ).map(i => i.value);
      const amenities = Array.from(new Set([...checkedKeys, ...customAmenities.map(s => s.trim()).filter(Boolean)]));

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
        // Minimum months a tenant must pay upfront — rent only (null for sale).
        min_months:  fListing.value === "rent" ? (Math.max(1, Number(fMinMonths?.value) || 1)) : null,
        bedrooms:    Number(fBedrooms.value) || 0,
        bathrooms:   Number(fBathrooms.value) || 0,
        size_sqm:    fSize.value ? Number(fSize.value) : null,
        region:      fRegion.value || null,
        area:        fArea.value.trim() || null,
        address:     fAddress.value.trim() || null,
        lat:         pickedLatLng.lat,
        lng:         pickedLatLng.lng,
        amenities,
        furnished:   fFurnished.value.trim() || null,
        photo:       coverPath,
        photos:      photoPaths,
        videos:      videoPaths,
        nearby:      nearbyData || {},
        description: fDescription.value.trim() || null,
        available_from: fAvailable.value || null,
        agent: {
          name:  session.user.user_metadata?.name || session.user.email?.split("@")[0] || "Agent",
          phone: fAgentPhone.value.trim() || null,
          whatsapp: true
        },
        owner_user_id: uid
      };

      // 4. Insert or update.
      // If the DB hasn't been migrated yet, `photos`/`videos` columns may
      // be missing — fall back to writing without them so the listing still
      // saves with the legacy `photo` cover. Use .select() so we get the
      // actual saved row back — that's the only way to know an insert
      // didn't silently get filtered out by RLS or a write-only schema.
      const trySave = async (payload) => editingId
        ? sb.from("houses").update(payload).eq("id", editingId).eq("owner_user_id", uid).select()
        : sb.from("houses").insert(payload).select();
      let { data: savedRows, error } = await trySave(row);
      if (error && /column .*(photos|videos|nearby|min_months).* (does not exist|not found)/i.test(error.message)) {
        const { photos: _p, videos: _v, nearby: _n, min_months: _m, ...legacy } = row;
        ({ data: savedRows, error } = await trySave(legacy));
      }
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
      window.DataStore?.invalidateCache(["houses"]);

      // Verify the row really landed and is tagged with this user's id.
      // Without these checks, the form silently "saves" but the listing
      // never appears in either the dashboard or the public houses page —
      // the two real causes are (a) RLS quietly dropped the insert, or
      // (b) the row was inserted but `owner_user_id` ended up null/wrong
      // (outdated schema with no owner_user_id column, or a permissive
      // RLS that doesn't enforce it).
      const saved = Array.isArray(savedRows) ? savedRows[0] : null;
      console.log("[agent-houses] save result", { editingId, savedRows, uid, payloadOwner: row.owner_user_id });
      if (!saved) {
        const { data: probe } = await sb.from("houses").select("id, owner_user_id").eq("id", row.id).maybeSingle();
        if (!probe) {
          throw new Error(
            "Save returned no row. Your Supabase `houses` table is " +
            "missing the `owner_user_id` column or the RLS policies. " +
            "Open Supabase → SQL Editor and re-run the setup SQL on this page."
          );
        }
        if (probe.owner_user_id !== uid) {
          throw new Error(
            "The listing was inserted but its owner_user_id (" +
            (probe.owner_user_id || "null") +
            ") doesn't match your session (" + uid + "). " +
            "Re-run the setup SQL — the RLS policy isn't tagging owners correctly."
          );
        }
      } else if (saved.owner_user_id && saved.owner_user_id !== uid) {
        throw new Error(
          "Listing saved with the wrong owner (" + saved.owner_user_id +
          " ≠ " + uid + "). Re-run the setup SQL so RLS enforces owner_user_id = auth.uid()."
        );
      } else if (saved.owner_user_id == null && !editingId) {
        throw new Error(
          "Listing inserted but owner_user_id came back null. " +
          "Your `houses` table is missing the owner_user_id column — " +
          "re-run the setup SQL on this page."
        );
      }

      formMsg.className = "ah-msg success";
      formMsg.textContent = editingId ? tr("ah_msg_saved_edit") : tr("ah_msg_saved_new");
      formMsg.hidden = false;

      // Who's been waiting for a room here? Surface renters who pinned this
      // area (with budget/specs matching this listing) and their phones, so
      // the agent can reach them the instant the listing goes live.
      const waiting = await notifyWaitingRenters(saved || row).catch(() => []);
      if (waiting.length) {
        renderWaitingPanel(waiting, saved || row);
        return;   // keep the form open so the agent can call them; "Done" closes it
      }

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

  // ---- Waiting renters (demand pins) --------------------------------------
  // After a listing saves, ask Supabase who pinned this area waiting for a
  // matching room. The house_demand_near RPC is SECURITY DEFINER, so it can
  // return the renters' phone numbers near this exact spot (and nowhere else).
  async function notifyWaitingRenters(listing) {
    if (!sb || listing.lat == null || listing.lng == null) return [];
    const { data, error } = await sb.rpc("house_demand_near", {
      p_lat: Number(listing.lat),
      p_lng: Number(listing.lng),
      p_radius_m: 1500,
      p_listing: listing.listing || "rent",
      p_type: listing.type || null,
      p_price: Number(listing.price_tzs) || 0,
      p_bedrooms: Number(listing.bedrooms) || 0
    });
    if (error) {
      // RPC missing (setup SQL not run yet) → silently skip; it's an add-on.
      if (!/function .* does not exist|schema cache|could not find/i.test(error.message || ""))
        console.warn("[agent-houses] demand lookup failed:", error.message);
      return [];
    }
    return Array.isArray(data) ? data : [];
  }

  function fmtTzs(p) {
    p = Number(p) || 0;
    if (p >= 1e9) return (p / 1e9).toFixed(p % 1e9 ? 1 : 0) + "B";
    if (p >= 1e6) return (p / 1e6).toFixed(p % 1e6 ? 1 : 0) + "M";
    if (p >= 1e3) return (p / 1e3).toFixed(0) + "k";
    return String(p);
  }

  function renderWaitingPanel(rows, listing) {
    ensureWaitStyles();
    let panel = document.getElementById("ahWaitingPanel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "ahWaitingPanel";
      formSection.appendChild(panel);
    }
    const area = listing.area || "this area";
    const items = rows.map(r => {
      const phone  = String(r.phone || "").trim();
      const digits = phone.replace(/\D/g, "");
      const intl   = digits.startsWith("0") ? "255" + digits.slice(1) : digits;
      const bits = [];
      if (r.max_budget_tzs) bits.push(`≤ ${fmtTzs(r.max_budget_tzs)} TZS`);
      if (r.min_bedrooms)   bits.push(`${r.min_bedrooms}+ bed`);
      if (r.distance_m != null)
        bits.push(`${r.distance_m < 1000 ? r.distance_m + " m" : (r.distance_m / 1000).toFixed(1) + " km"} away`);
      return `<div class="ah-wait-row">
        <div class="ah-wait-who">
          <strong>${esc(r.name || "Waiting renter")}</strong>
          <small>${esc(bits.join(" · "))}</small>
        </div>
        <div class="ah-wait-cta">
          <a class="ah-wait-btn call" href="tel:${esc(phone)}">📞 Call</a>
          ${intl ? `<a class="ah-wait-btn wa" href="https://wa.me/${esc(intl)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
        </div>
      </div>`;
    }).join("");
    panel.innerHTML = `
      <div class="ah-wait-card">
        <div class="ah-wait-head">🔔 ${rows.length} ${rows.length === 1 ? "person is" : "people are"} waiting near ${esc(area)}</div>
        <div class="ah-wait-sub">They pinned this area for a ${listing.listing === "sale" ? "property to buy" : "place to rent"} matching your new listing. Reach out before someone else does.</div>
        ${items}
        <button type="button" id="ahWaitDone" class="ah-wait-done">Done — back to my listings</button>
      </div>`;
    panel.scrollIntoView({ behavior: "smooth", block: "center" });
    document.getElementById("ahWaitDone")?.addEventListener("click", () => {
      panel.remove();
      closeForm();
      loadMyListings();
    });
  }

  function ensureWaitStyles() {
    if (document.getElementById("ahWaitStyles")) return;
    const s = document.createElement("style");
    s.id = "ahWaitStyles";
    s.textContent = `
      #ahWaitingPanel{margin-top:16px}
      .ah-wait-card{background:#f0f8f4;border:1px solid #bfe0cf;border-radius:16px;padding:16px 18px}
      .ah-wait-head{font-weight:700;font-size:1.02rem;color:#0a6f4d;margin-bottom:2px}
      .ah-wait-sub{font-size:.85rem;color:#41504a;margin-bottom:12px;line-height:1.45}
      .ah-wait-row{display:flex;align-items:center;justify-content:space-between;gap:10px;
        padding:10px 0;border-top:1px solid #d6e8de}
      .ah-wait-who strong{display:block;font-size:.92rem}
      .ah-wait-who small{color:#6b7a73;font-size:.78rem}
      .ah-wait-cta{display:flex;gap:6px;flex-shrink:0}
      .ah-wait-btn{font-size:.82rem;font-weight:600;text-decoration:none;padding:7px 12px;border-radius:8px;white-space:nowrap}
      .ah-wait-btn.call{background:#0a6f4d;color:#fff}
      .ah-wait-btn.wa{background:#fff;color:#0a6f4d;box-shadow:inset 0 0 0 1.5px #0a6f4d}
      .ah-wait-done{margin-top:12px;width:100%;padding:10px;border:0;border-radius:9px;
        background:#0a6f4d;color:#fff;font-weight:600;font-size:.9rem;cursor:pointer}`;
    document.head.appendChild(s);
  }

  // ---- Video faststart gateway (services/python) ---------------------------
  // Phone/Windows recorders put the MP4 `moov` index at the END of the file, so
  // the clip stutters until the whole thing downloads. We remux it to faststart
  // (moov to the front, lossless) via the python service before upload. If that
  // service is unset/asleep/unreachable we just upload the original — the listing
  // never fails to save over a video-optimisation step.
  function _videoGatewayBase() {
    const cfg = (window.APP_CONFIG && window.APP_CONFIG.VIDEO_GATEWAY_URL) || "";
    if (cfg) return cfg.replace(/\/+$/, "");
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "") return "http://127.0.0.1:8094";
    return "";
  }

  // Wake a sleeping free-tier gateway when the form opens, so it's warm by the
  // time the agent finishes filling in the listing and hits save. Fire-and-forget.
  let _videoWarmed = false;
  function warmVideoGateway() {
    if (_videoWarmed) return;
    _videoWarmed = true;
    const base = _videoGatewayBase();
    if (!base || /127\.0\.0\.1|localhost/.test(base)) return;
    fetch(`${base}/health`).catch(() => {});
  }

  async function faststart(file) {
    const base = _videoGatewayBase();
    if (!base || !file) return file;
    try {
      const r = await fetch(`${base}/faststart`, {
        method: "POST",
        headers: { "Content-Type": file.type || "video/mp4" },
        body: file,
      });
      if (!r.ok) return file;
      const blob = await r.blob();
      if (!blob || !blob.size) return file;
      // When the server actually remuxed it, the result is MP4 — rename so the
      // stored path/extension matches (e.g. an iPhone .mov becomes .mp4).
      if (r.headers.get("X-Faststart") === "applied") {
        const name = (file.name || "video").replace(/\.[^.]+$/, "") + ".mp4";
        return new File([blob], name, { type: "video/mp4" });
      }
      return file;
    } catch (_) {
      return file; // gateway down / cold — upload the original untouched
    }
  }

  // Upload helpers — both write into the `house-photos` bucket (which since
  // schema section 34c also accepts video MIME types). Return the storage
  // path so we can persist it in the photos[]/videos[] arrays.
  function _mediaBucket() {
    return (window.APP_CONFIG && window.APP_CONFIG.HOUSE_PHOTOS_BUCKET) || "house-photos";
  }
  async function uploadDataUrl(dataUrl, uid, ext, contentType) {
    const blob = await (await fetch(dataUrl)).blob();
    return _uploadBlob(blob, uid, ext, contentType);
  }
  async function uploadFile(file, uid) {
    const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || "bin").toLowerCase();
    return _uploadBlob(file, uid, ext, file.type || "application/octet-stream");
  }
  async function _uploadBlob(blob, uid, ext, contentType) {
    const bucket = _mediaBucket();
    const path = `${uid}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await sb.storage.from(bucket).upload(path, blob, {
      contentType,
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
    window.DataStore?.invalidateCache(["houses"]);
    // Best-effort: clean up every media path that lives in our bucket.
    const all = [row.photo, ...(row.photos || []), ...(row.videos || [])]
      .filter(p => p && !p.startsWith("http") && !p.startsWith("data/"));
    if (all.length) {
      const bucket = (window.APP_CONFIG && window.APP_CONFIG.HOUSE_PHOTOS_BUCKET) || "house-photos";
      sb.storage.from(bucket).remove(all).catch(() => {});
    }
    loadMyListings();
  }

  // SETUP_SQL is declared near the top of this function (before any await)
  // so renderSetupCard() can run from inside loadMyListings without hitting
  // a temporal-dead-zone error.

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
