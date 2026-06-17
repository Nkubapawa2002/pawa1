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
  const authPasswordConfirm    = document.getElementById("ahPasswordConfirm");
  const authPasswordConfirmRow = document.getElementById("ahPasswordConfirmRow");
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

  // Additional costs / bills (electricity, water, garbage…) shown to clients
  const fCostsList       = document.getElementById("ahCostsList");
  const fCostQuick       = document.getElementById("ahCostQuick");
  const fAddCostBtn      = document.getElementById("ahAddCostBtn");

  // Media limits
  const MAX_PHOTOS    = 12;
  const MAX_VIDEOS    = 2;
  // Keep clips SHORT so they upload reliably on slow mobile links. A 60 s / 60 MB
  // clip was timing out (cold faststart gateway + a single large PUT to storage),
  // which surfaced as a "database/upload" failure. 20 s ≈ a few MB → uploads fast.
  const MAX_VIDEO_S   = 20;            // seconds
  const MAX_VIDEO_B   = 20 * 1024 * 1024;  // 20 MB
  const fTitle        = document.getElementById("ahTitle");
  const fType         = document.getElementById("ahType");
  const fTypeOther    = document.getElementById("ahTypeOther");
  const fTypeOtherRow = document.getElementById("ahTypeOtherRow");
  // Property types the dropdown offers directly; anything else is free text ("other").
  const KNOWN_TYPES   = ["apartment", "house", "plot", "office", "shop", "warehouse"];
  // Show the free-text box only when the provider picks "Other (any kind)".
  function syncTypeOther() {
    if (fTypeOtherRow) fTypeOtherRow.style.display = fType.value === "other" ? "" : "none";
  }
  if (fType) fType.addEventListener("change", syncTypeOther);
  const fListing      = document.getElementById("ahListing");
  const fPrice        = document.getElementById("ahPrice");
  const fPeriod       = document.getElementById("ahPeriod");
  const fMinMonths    = document.getElementById("ahMinMonths");
  const fMinMonthsRow = document.getElementById("ahMinMonthsRow");
  const fRoomKind     = document.getElementById("ahRoomKind");
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
  let gpsAbort        = null;       // AbortController for an in-progress GPS capture

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
  type              text not null,  -- apartment/house/plot/office/shop/warehouse or free-text ("other")
  listing           text not null check (listing in ('rent','sale')),
  price_tzs         bigint not null default 0 check (price_tzs >= 0),
  currency          text not null default 'TZS',
  period            text default 'month',
  bedrooms          int  not null default 0,
  bathrooms         int  not null default 0,
  size_sqm          int,
  min_months        int  not null default 1,  -- min months a renter pays upfront
  room_kind         text,  -- 'single' | 'master' | null (whole unit) — for room-by-room rentals
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
  extra_costs       jsonb not null default '[]'::jsonb,  -- [{label,amount,billing}] bills shown to clients
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
alter table public.houses add column if not exists extra_costs jsonb not null default '[]'::jsonb;
alter table public.houses add column if not exists min_months int not null default 1;
alter table public.houses add column if not exists room_kind text;
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
    setAuthMsg(tr("ah_msg_supabase_missing"), "error");
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

  // Subscription / activation guard: deactivation, lapsed subscription, or the
  // 48h pay-or-pause grace expiring → paywall (RLS also hides the listings);
  // during grace, a live countdown demanding payment.
  async function checkSubscription() {
    if (!sb) return;
    try {
      const { data } = await sb.rpc("my_agent_subscription");
      const sub = Array.isArray(data) ? data[0] : data;
      window.renderAgentSubBanner(sub, { mount: dashboard, id: "ahSubPaywall", what: "listings" });
    } catch (_) { /* RPC not deployed yet — ignore */ }
  }

  async function routeOnAuth(session) {
    const s = session ?? (await sb.auth.getSession()).data.session;
    if (s?.user) {
      authCard.hidden = true;
      dashboard.hidden = false;
      formSection.hidden = true;
      mode = "dashboard";
      userEmailEl.textContent = s.user.email || tr("ah_no_email");
      await loadMyListings();
      checkSubscription();
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
    if (authPasswordConfirmRow) authPasswordConfirmRow.hidden = true;
    setAuthMsg("", "");
  });
  tabSignUp.addEventListener("click", () => {
    authMode = "signup";
    tabSignUp.classList.add("active");
    tabSignIn.classList.remove("active");
    authSubmit.textContent = tr("ah_tab_signup");
    authPassword.autocomplete = "new-password";
    if (authPasswordConfirmRow) { authPasswordConfirmRow.hidden = false; authPasswordConfirm.value = ""; }
    setAuthMsg("", "");
  });

  function setAuthMsg(html, kind /* "error" | "success" */) {
    const mod = kind === "error" ? "is-error" : (kind === "success" || kind === "ok") ? "is-ok" : "";
    authMsg.className = "auth-msg" + (mod && html ? " " + mod + " is-show" : "");
    authMsg.innerHTML = html || "";
  }
  // Reject anything that isn't a syntactically valid address before we call
  // Supabase. (Real deliverability is proven by the verification email.)
  function isValidEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }

  async function resendVerification(email) {
    try {
      const { error } = await sb.auth.resend({ type: "signup", email });
      if (error) throw error;
      setAuthMsg(`Verification link re-sent to <strong>${esc(email)}</strong>. Check your inbox (and spam folder).`, "success");
    } catch (err) {
      const m = err?.message || "";
      if (/rate limit|too many|over_email_send_rate_limit/i.test(m)) {
        setAuthMsg("Please wait a minute before requesting another verification email.", "error");
      } else {
        setAuthMsg("Couldn't resend the link: " + esc(m || "please try again later."), "error");
      }
    }
  }

  function showVerifyNotice(email, lead, kind) {
    setAuthMsg(
      `${lead} We sent a verification link to <strong>${esc(email)}</strong>. ` +
      `Open it to activate your account, then come back here and sign in. ` +
      `<button type="button" id="ahResendVerify" class="ah-btn" style="margin-top:8px;">Resend verification email</button>`,
      kind || "success"
    );
    document.getElementById("ahResendVerify")?.addEventListener("click", () => resendVerification(email));
  }

  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setAuthMsg("", "");
    const email = authEmail.value.trim();
    const password = authPassword.value;

    if (!isValidEmail(email)) {
      setAuthMsg("Please enter a valid email address (e.g. name@example.com).", "error");
      authEmail.focus();
      return;
    }

    authSubmit.disabled = true;
    try {
      if (authMode === "signup") {
        // Require the re-entered password to match — stops a typo from creating
        // an account with a password the owner can never reproduce.
        const confirm = authPasswordConfirm ? authPasswordConfirm.value : password;
        if (password !== confirm) {
          setAuthMsg(tr("ah_err_pw_mismatch"), "error");
          return;
        }
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) {
          // Account already exists: do NOT silently sign in with the sign-up
          // password (that conflates creating an account with logging into an
          // existing one). Send them to the Sign-in tab to enter their real
          // password instead.
          if (/already registered|already been registered|user already/i.test(error.message || "")) {
            authMode = "signin"; tabSignIn.click();
            setAuthMsg(tr("ah_err_email_exists").replace("{email}", `<strong>${esc(email)}</strong>`), "error");
            return;
          }
          throw error;
        }
        // Supabase anti-enumeration: an existing email returns no error and a
        // user row with an empty identities[] array. Treat that as "exists".
        if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          authMode = "signin"; tabSignIn.click();
          setAuthMsg(tr("ah_err_email_exists").replace("{email}", `<strong>${esc(email)}</strong>`), "error");
          return;
        }
        if (data?.session) return;                 // confirm-email OFF → signed in
        // No session → confirm-email is ON. Switch to Sign-in (its handler
        // clears the message) then show the verify notice + resend button.
        authMode = "signin"; tabSignIn.click();
        showVerifyNotice(email, "Account created.", "success");
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // onAuthStateChange will route us into the dashboard.
      }
    } catch (err) {
      const msg = err?.message || "";
      if (/invalid login|invalid_credentials|invalid_grant/i.test(msg)) {
        setAuthMsg(`Wrong email or password. If you don't have an account yet, tap <strong>${esc(tr("ah_tab_signup") || "Create account")}</strong> above.`, "error");
      } else if (/email not confirmed|email_not_confirmed/i.test(msg)) {
        showVerifyNotice(email, "Your email isn't verified yet.", "error");
      } else if (/rate limit|over_email_send_rate_limit|too many/i.test(msg)) {
        setAuthMsg("Too many attempts. Please wait a minute, then try again.", "error");
      } else if (/password.*should be at least|weak password|password is too short/i.test(msg)) {
        setAuthMsg("Password must be at least 6 characters.", "error");
      } else {
        setAuthMsg(esc(msg) || tr("ah_msg_auth_fail"), "error");
      }
    } finally {
      authSubmit.disabled = false;
    }
  });

  // signOutBtn listener is attached above (before any await) so it works
  // even if init throws somewhere in between.

  // ---- Load my listings ----------------------------------------------------
  async function loadMyListings() {
    // Skeleton (or keep the one already in HTML on first load). Reset to the
    // grid layout — only the populated-listings branch switches to table mode.
    listEl.classList.remove("ah-table-mode");
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
    // Listings render as a compact table (one row per property) so an agent
    // can scan/manage many listings at a glance, like the parcel dashboard.
    listEl.classList.add("ah-table-mode");
    const typeLabel = t => ({ apartment: "Apartment", house: "House", plot: "Plot", office: "Office", shop: "Shop / business", warehouse: "Warehouse" }[t] || (t || "—"));
    const rows = data.map(h => {
      const photo = window.DataStore.housePhotoUrl(h.photo);
      const listing = h.listing === "sale" ? tr("ah_for_sale") : tr("ah_for_rent");
      const price = formatPrice(h);
      const where = esc(h.area || "—") + (h.region ? ", " + esc(h.region) : "");
      // Listings auto-delete (row + photos/videos) 15 days after posting.
      const daysLeft = Math.ceil((new Date(h.created_at).getTime() + 15 * 864e5 - Date.now()) / 864e5);
      const expChip = daysLeft <= 3
        ? `<span title="This listing and its photos/videos are removed automatically 15 days after posting" style="display:inline-block;background:#fde6e2;color:#b3261e;font-size:.7rem;font-weight:700;padding:2px 7px;border-radius:20px;white-space:nowrap;">${daysLeft <= 0 ? "Expires today" : "Expires in " + daysLeft + "d"}</span>`
        : `<span title="This listing and its photos/videos are removed automatically 15 days after posting" style="display:inline-block;background:#eef2f7;color:#5b6472;font-size:.7rem;font-weight:700;padding:2px 7px;border-radius:20px;white-space:nowrap;">Expires in ${daysLeft}d</span>`;
      return `<tr data-id="${h.id}">
        <td class="ah-td-photo">
          <span class="ah-thumb" data-loading="true" style="background-image:url('${photo}')"></span>
        </td>
        <td class="ah-td-title"><span class="ah-row-title">${esc(h.title)}</span>${h.available === false ? ` <span style="display:inline-block;background:#fde6e2;color:#b3261e;font-size:.7rem;font-weight:700;padding:2px 7px;border-radius:20px;white-space:nowrap;">Rented · off-market</span>` : ""} ${expChip}</td>
        <td class="ah-td-type">${esc(typeLabel(h.type))}${h.room_kind === "single" ? ` · ${esc("Single room")}` : h.room_kind === "master" ? ` · ${esc("Master room")}` : ""}</td>
        <td class="ah-td-listing"><span class="ah-pill ah-pill-${h.listing === "sale" ? "sale" : "rent"}">${esc(listing)}</span></td>
        <td class="ah-td-price"><strong>${price.value}</strong> <small>${price.unit}</small></td>
        <td class="ah-td-area">${where}</td>
        <td class="ah-td-actions">
          ${h.listing === "rent" ? `<button class="ah-btn ah-tenant-btn" aria-label="Mark deal completed for ${esc(h.title)}">${esc(tr("ah_completed_btn"))}</button>` : ""}
          <button class="ah-btn ah-edit-btn" aria-label="Edit ${esc(h.title)}">${esc(tr("ah_edit"))}</button>
          <button class="ah-btn ah-btn-danger ah-delete-btn" aria-label="Delete ${esc(h.title)}">${esc(tr("ah_delete"))}</button>
        </td>
      </tr>`;
    }).join("");
    listEl.innerHTML = `<table class="ah-table">
      <thead>
        <tr>
          <th class="ah-td-photo"></th>
          <th>Property</th>
          <th>Type</th>
          <th>Listing</th>
          <th>Price</th>
          <th>Area</th>
          <th class="ah-td-actions"></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
    listEl.querySelectorAll("tr[data-id]").forEach(tr => {
      const id = tr.dataset.id;
      const row = data.find(x => x.id === id);
      tr.querySelector(".ah-edit-btn").addEventListener("click", () => openForm(row));
      tr.querySelector(".ah-delete-btn").addEventListener("click", () => deleteListing(row));
      tr.querySelector(".ah-tenant-btn")?.addEventListener("click", () => openTenantPanel(row));
    });
    // Drop shimmer on each row thumbnail when its image is ready.
    listEl.querySelectorAll(".ah-thumb[data-loading]").forEach(el => {
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
    if (fRoomKind) fRoomKind.value = "";
    if (fCostsList) fCostsList.innerHTML = "";
    if (fTypeOther) fTypeOther.value = "";
    syncTypeOther();

    if (row) {
      fTitle.value       = row.title || "";
      // A free-text "any kind" type lands in the Other box; known types select directly.
      if (row.type && !KNOWN_TYPES.includes(row.type)) {
        fType.value = "other";
        if (fTypeOther) fTypeOther.value = row.type;
      } else {
        fType.value = row.type || "apartment";
        if (fTypeOther) fTypeOther.value = "";
      }
      syncTypeOther();
      fListing.value     = row.listing || "rent";
      fPrice.value       = row.price_tzs || "";
      fPeriod.value      = row.period || (row.listing === "sale" ? "total" : "month");
      if (fMinMonths) fMinMonths.value = row.min_months ?? 1;
      if (fRoomKind) fRoomKind.value = row.room_kind || "";
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
      // Restore saved additional costs into editable rows.
      if (Array.isArray(row.extra_costs)) {
        row.extra_costs.forEach(c => { if (c && c.label) addCostRow(c); });
      }
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
    renderCostQuick();   // build the one-tap preset chips for additional costs
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
        alert(`"${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_VIDEO_B / 1024 / 1024} MB per video — please trim it to a short clip.`);
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
      ? `<span class="ah-enhanced-flag" title="Auto-enhanced for clarity & colour"> Enhanced</span>` : "";
    const flag   = isVideo ? `<span class="ah-video-flag"> Video</span>` : enhanced;
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
    // Shared hybrid base (satellite + Esri road overlay + street-name labels,
    // labels from z≥9 so agents can read road names while zoomed out) with the
    // shared Map ⇄ Satellite toggle — both from config.js.
    pinMap = new maplibregl.Map({
      container: "ahPinMap",
      style: window.pawaGlHybridStyle ? window.pawaGlHybridStyle() : { version: 8, sources: {}, layers: [] },
      center: pickedLatLng ? [pickedLatLng.lng, pickedLatLng.lat] : [39.2789, -6.7924],
      zoom: pickedLatLng ? 16 : 11,
      maxBounds: [[29.34, -11.75], [40.45, -0.99]]
    });
    pinMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    if (window.pawaGlBasemapToggle) pinMap.addControl(window.pawaGlBasemapToggle(), "top-right");
    // Maximize / minimize the pin map in place (shared helper). Grow the picker
    // wrapper (the map fills it via inset:0) so the absolute map follows.
    window.pawaMapExpand && window.pawaMapExpand(".ah-pin-picker", () => pinMap);

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
      ` ${pickedLatLng.lat.toFixed(5)}, ${pickedLatLng.lng.toFixed(5)}${acc}`;
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
      // Admin hierarchy (TZ): district = county-level, ward = suburb-level. Saved
      // on the listing so a searcher can find it by region / district / ward.
      const district = a.county || a.state_district || a.city_district || a.municipality || a.city || a.town || "";
      const ward = a.suburb || a.quarter || a.neighbourhood || a.ward || a.village || "";
      resolvedPlace = {
        road, area, region, city, district, ward,
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
  // Country-wide place search across every admin level (village/ward/district…).
  // Uses the shared Nominatim helper so it works with no Mapbox token; if a token
  // is set, Mapbox autocomplete is merged in first for snappier typeahead.
  async function pinSearch(q) {
    let rows = [];
    if (mapboxToken()) { try { rows = await mapboxSearch(q); } catch (_) {} }
    try {
      const hits = await pawaGeo.suggest(q, { limit: 25 });
      for (const h of hits) {
        if (rows.some(r => r.name === h.name)) continue;
        rows.push({ name: h.name, tag: h.tag, context: h.context, lat: h.lat, lng: h.lng });
      }
    } catch (_) { /* offline — Mapbox rows (if any) still stand */ }
    return rows;
  }
  function renderSearchResults(rows) {
    if (!fPinSearchResults) return;
    if (!rows.length) { fPinSearchResults.style.display = "none"; return; }
    fPinSearchResults.innerHTML = rows.map((r, i) => `
      <button type="button" class="ah-search-row" data-i="${i}"
              style="display:block;width:100%;text-align:left;border:0;background:transparent;padding:10px 14px;border-bottom:1px solid #eef1f4;cursor:pointer;font-size:.9rem;">
        <strong style="font-weight:600;">${esc(r.name)}</strong>${r.tag ? ` <span style="color:#0a6f4d;font-size:.74rem;">${esc(r.tag)}</span>` : ""}
        ${r.context ? `<br><small style="color:#6b7a73;font-size:.78rem;">${esc(r.context)}</small>` : ""}
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
      const rows = await pinSearch(q);
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

  // AI-assisted pin: the agent types a free description (landmark, "behind X")
  // and the AI resolves it to a map pin — no need to pick from the list.
  const fPinAi = document.getElementById("ahPinAi");
  const fPinAiMsg = document.getElementById("ahPinAiMsg");
  fPinAi?.addEventListener("click", async () => {
    const q = (fPinSearch?.value || "").trim();
    if (!q) { fPinSearch?.focus(); return; }
    if (!window.AI?.locate) { fPinAiMsg && (fPinAiMsg.textContent = "AI is unavailable — use the search list or GPS."); return; }
    const label0 = fPinAi.textContent;
    fPinAi.disabled = true; fPinAi.textContent = "Locating…";
    if (fPinAiMsg) fPinAiMsg.textContent = "";
    try {
      const loc = await window.AI.locate(q, { regions: window.APP_CONFIG?.REGIONS });
      if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
        pickedLatLng = { lat: loc.lat, lng: loc.lng };
        gpsAccuracyM = null; drawAccuracyCircle(null);
        if (pinMarker) pinMarker.setLngLat([loc.lng, loc.lat]);
        if (pinMap) pinMap.easeTo({ center: [loc.lng, loc.lat], zoom: 16, duration: 600 });
        updatePinReadout();
        if (fPinSearchResults) fPinSearchResults.style.display = "none";
        if (fPinAiMsg) fPinAiMsg.textContent = " " + (loc.label || "Pinned") + (loc.answer ? " — " + loc.answer : "") + " (drag the pin to fine-tune)";
      } else if (fPinAiMsg) {
        fPinAiMsg.textContent = "Couldn't locate that — try a nearby landmark or place the pin manually.";
      }
    } finally { fPinAi.disabled = false; fPinAi.textContent = label0; }
  });

  // ---- Remote location: someone at the house shares their GPS to this form --
  // Reuses the meet room + live_locations realtime infra. The agent generates a
  // share link; the person there taps "Share my location" (share-location.html);
  // the pin drops here automatically — so a house can be registered off-site.
  function randomMeetCode() {
    const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = ""; for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }
  const reqBtn = document.getElementById("ahReqLoc");
  let reqChannel = null, reqPoll = null;
  function reqCleanup() {
    if (reqChannel) { try { sb.removeChannel(reqChannel); } catch (_) {} reqChannel = null; }
    if (reqPoll) { clearInterval(reqPoll); reqPoll = null; }
  }
  function reqApply(row) {
    if (!row || !Number.isFinite(+row.lat) || !Number.isFinite(+row.lng)) return;
    pickedLatLng = { lat: +row.lat, lng: +row.lng };
    gpsAccuracyM = row.accuracy_m || null; drawAccuracyCircle(gpsAccuracyM);
    if (pinMarker) pinMarker.setLngLat([+row.lng, +row.lat]);
    if (pinMap) pinMap.easeTo({ center: [+row.lng, +row.lat], zoom: 16, duration: 600 });
    updatePinReadout();
    const st = document.getElementById("ahReqLocStatus");
    if (st) st.textContent = " Location received from the house — drag the pin to fine-tune if needed.";
    reqCleanup();
  }
  reqBtn?.addEventListener("click", async () => {
    if (!sb) return;
    reqBtn.disabled = true;
    const st = document.getElementById("ahReqLocStatus");
    try {
      const code = randomMeetCode();
      const { error } = await sb.from("meet_rooms").insert({ code, purpose: "house_pin", created_by: "agent" });
      if (error) throw error;
      const base = location.origin + location.pathname.replace(/[^/]*$/, "");
      const link = `${base}share-location.html?c=${code}`;
      document.getElementById("ahReqLocBox").style.display = "block";
      document.getElementById("ahReqLocLink").value = link;
      document.getElementById("ahReqLocWa").href =
        `https://wa.me/?text=${encodeURIComponent("Please share the house location for the listing: " + link)}`;
      if (st) st.textContent = "Waiting for the location… keep this open.";
      reqCleanup();
      reqChannel = sb.channel(`house_pin_${code}`)
        .on("postgres_changes",
          { event: "*", schema: "public", table: "live_locations", filter: `room_code=eq.${code}` },
          ({ new: row }) => reqApply(row))
        .subscribe();
      // Poll fallback in case realtime isn't enabled.
      reqPoll = setInterval(async () => {
        const { data } = await sb.from("live_locations")
          .select("lat,lng,accuracy_m").eq("room_code", code)
          .order("last_seen", { ascending: false }).limit(1);
        if (data && data[0]) reqApply(data[0]);
      }, 4000);
    } catch (e) {
      if (st) st.textContent = "Couldn't start the request: " + (e.message || e);
    } finally { reqBtn.disabled = false; }
  });
  document.getElementById("ahReqLocCopy")?.addEventListener("click", () => {
    const inp = document.getElementById("ahReqLocLink");
    inp.select(); navigator.clipboard?.writeText(inp.value).catch(() => {});
    const b = document.getElementById("ahReqLocCopy"); const t = b.textContent;
    b.textContent = "Copied "; setTimeout(() => (b.textContent = t), 1500);
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
    fNearbyPanel.innerHTML = `<p class="muted" style="margin:0;font-size:.9rem;"> Scanning ${radiusKm} km around your pin for schools, hospitals, transport…</p>`;
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
      schools:    { label: "Schools",            icon: "", items: [] },
      hospitals:  { label: "Hospitals & clinics",icon: "", items: [] },
      pharmacies: { label: "Pharmacies",         icon: "", items: [] },
      worship:    { label: "Mosques & churches", icon: "", items: [] },
      markets:    { label: "Markets & shops",    icon: "", items: [] },
      banks:      { label: "Banks & ATMs",       icon: "", items: [] },
      transport:  { label: "Transport",          icon: "", items: [] },
      food:       { label: "Restaurants & cafes",icon: "", items: [] },
      services:   { label: "Public services",    icon: "", items: [] },
      leisure:    { label: "Parks & leisure",    icon: "", items: [] }
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

  // ---- Additional costs / bills (electricity, water, garbage…) -------------
  // Each row is a self-contained DOM node (label + amount + billing + remove);
  // we scrape the rows at save time, so there's no separate state to keep in
  // sync on every keystroke. `billing` covers the common Tanzanian cases.
  const COST_BILLING = [
    { value: "month",    label: "per month" },
    { value: "metered",  label: "metered (pay as you use)" },
    { value: "included", label: "included in rent" },
    { value: "oneoff",   label: "one-time" },
  ];
  // Common bills offered as one-tap chips (label only — the agent fills amounts).
  const COST_PRESETS = ["Electricity", "Water", "Garbage", "Security", "Internet", "Service charge"];

  function addCostRow(cost) {
    const c = cost || {};
    const row = document.createElement("div");
    row.className = "ah-cost-row";
    row.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
    const billingOpts = COST_BILLING.map(b =>
      `<option value="${b.value}" ${c.billing === b.value ? "selected" : ""}>${b.label}</option>`).join("");
    row.innerHTML = `
      <input type="text" class="ah-cost-label" maxlength="40" placeholder="Bill name — e.g. Electricity"
             value="${esc(c.label || "")}" style="flex:1 1 160px;min-width:0;padding:9px 12px;border:1px solid #d0d7de;border-radius:8px;font-size:.92rem;">
      <input type="number" class="ah-cost-amount" min="0" step="1000" placeholder="TZS (optional)"
             value="${c.amount != null && c.amount !== "" ? Number(c.amount) : ""}" style="flex:0 1 130px;min-width:0;padding:9px 12px;border:1px solid #d0d7de;border-radius:8px;font-size:.92rem;">
      <select class="ah-cost-billing" style="flex:0 1 150px;min-width:0;padding:9px 10px;border:1px solid #d0d7de;border-radius:8px;font-size:.9rem;">${billingOpts}</select>
      <button type="button" class="ah-cost-x" aria-label="Remove cost"
              style="border:0;background:transparent;cursor:pointer;font-weight:700;font-size:1.2rem;color:#888;line-height:1;padding:4px 8px;">×</button>
    `;
    row.querySelector(".ah-cost-x").addEventListener("click", () => row.remove());
    fCostsList.appendChild(row);
    return row;
  }

  // Read the current rows into a clean array; rows without a label are dropped.
  function collectExtraCosts() {
    if (!fCostsList) return [];
    return Array.from(fCostsList.querySelectorAll(".ah-cost-row")).map(row => {
      const label   = row.querySelector(".ah-cost-label").value.trim();
      const amtRaw  = row.querySelector(".ah-cost-amount").value;
      const billing = row.querySelector(".ah-cost-billing").value;
      const amount  = amtRaw === "" ? null : Number(amtRaw);
      return { label, amount: (amount != null && !isNaN(amount)) ? amount : null, billing };
    }).filter(c => c.label);
  }

  // Build the one-tap preset chips (skip any already added).
  function renderCostQuick() {
    if (!fCostQuick) return;
    const existing = new Set(
      Array.from(fCostsList.querySelectorAll(".ah-cost-label"))
        .map(i => i.value.trim().toLowerCase()).filter(Boolean));
    fCostQuick.innerHTML = "";
    for (const name of COST_PRESETS) {
      if (existing.has(name.toLowerCase())) continue;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "ah-chip";
      chip.textContent = "+ " + name;
      chip.addEventListener("click", () => {
        addCostRow({ label: name, billing: "month" });
        renderCostQuick();
      });
      fCostQuick.appendChild(chip);
    }
  }

  fAddCostBtn?.addEventListener("click", () => {
    addCostRow({ billing: "month" });
    renderCostQuick();
  });

  // GPS pinning with "best-fix" capture (via the shared pawaLocate helper): it
  // fires a prompt-safe one-shot first (so iOS actually asks), then keeps the
  // tightest reading for a few seconds, showing progress as it sharpens.
  const applyFix = (fix) => {
    pickedLatLng = { lat: fix.lat, lng: fix.lng };
    gpsAccuracyM = fix.accuracy ?? null;
    if (pinMarker) pinMarker.setLngLat([pickedLatLng.lng, pickedLatLng.lat]);
    if (pinMap) {
      // Zoom tighter for precise fixes, looser when accuracy is poor.
      const z = gpsAccuracyM == null ? 17 : gpsAccuracyM <= 25 ? 18 : gpsAccuracyM <= 80 ? 16 : 15;
      pinMap.easeTo({ center: [pickedLatLng.lng, pickedLatLng.lat], zoom: z });
    }
    drawAccuracyCircle(gpsAccuracyM);
    updatePinReadout();
  };

  fPinGps.addEventListener("click", async () => {
    if (!pawaLocate.supported()) { alert(tr("ah_err_no_geo")); return; }
    // A second tap cancels an in-progress lock.
    if (gpsAbort) { stopGpsWatch(); return; }

    gpsAbort = new AbortController();
    fPinGps.disabled = false;            // keep tappable so it can cancel
    fPinGps.textContent = tr("ah_pin_locating");
    try {
      const fix = await pawaLocate.best({
        targetAccuracy: 12, maxWaitMs: 8000,
        signal: gpsAbort.signal,
        onProgress: applyFix,            // show progress as it tightens
      });
      applyFix(fix);
    } catch (err) {
      if (err.code !== "aborted") alert(tr("ah_err_geo") + pawaLocate.message(err));
    } finally {
      gpsAbort = null;
      fPinGps.disabled = false;
      fPinGps.textContent = tr("ah_pin_gps");
    }
  });

  function stopGpsWatch() {
    if (gpsAbort) { try { gpsAbort.abort(); } catch (_) {} gpsAbort = null; }
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
    fPinFill.textContent = " Filled";
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
      _videoOptimizeFailures = 0;
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
        // "Other" stores whatever kind the provider typed (falls back to "other").
        type:        fType.value === "other"
                       ? ((fTypeOther && fTypeOther.value.trim().toLowerCase()) || "other")
                       : fType.value,
        listing:     fListing.value,
        price_tzs:   Number(fPrice.value) || 0,
        currency:    "TZS",
        period:      fPeriod.value,
        // Minimum months a tenant must pay upfront — rent only (null for sale).
        min_months:  fListing.value === "rent" ? (Math.max(1, Number(fMinMonths?.value) || 1)) : null,
        // Room category for room-by-room rentals: single vs master
        // (self-contained); null/"" means the whole unit is listed.
        room_kind:   (fRoomKind && fRoomKind.value) || null,
        bedrooms:    Number(fBedrooms.value) || 0,
        bathrooms:   Number(fBathrooms.value) || 0,
        size_sqm:    fSize.value ? Number(fSize.value) : null,
        region:      fRegion.value || null,
        area:        fArea.value.trim() || null,
        // Auto admin classification from the pin (region/district/ward search).
        district:    (resolvedPlace && resolvedPlace.district) || null,
        ward:        (resolvedPlace && resolvedPlace.ward) || null,
        address:     fAddress.value.trim() || null,
        lat:         pickedLatLng.lat,
        lng:         pickedLatLng.lng,
        amenities,
        furnished:   fFurnished.value.trim() || null,
        photo:       coverPath,
        photos:      photoPaths,
        videos:      videoPaths,
        nearby:      nearbyData || {},
        extra_costs: collectExtraCosts(),
        description: fDescription.value.trim() || null,
        available_from: fAvailable.value || null,
        agent: {
          // Public on the directory — never derive a name from the email
          // (its local-part would expose part of the agent's private address).
          name:  session.user.user_metadata?.name || "Agent",
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
      if (error && /column .*(photos|videos|nearby|extra_costs|min_months|room_kind).* (does not exist|not found)/i.test(error.message)) {
        const { photos: _p, videos: _v, nearby: _n, extra_costs: _e, min_months: _m, room_kind: _rk, ...legacy } = row;
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

      // The clip(s) saved, but the optimiser couldn't reach/process them, so
      // they may stutter on playback. Tell the agent so they can re-save once
      // the gateway is awake, rather than leaving a broken video live silently.
      if (_videoOptimizeFailures > 0) {
        alert(
          `Saved — but ${_videoOptimizeFailures} video${_videoOptimizeFailures > 1 ? "s" : ""} ` +
          `could not be optimised for smooth playback (the video service was unreachable). ` +
          `The listing is live, but those clips may stutter. Please edit the listing and save ` +
          `again in a minute to fix them.`
        );
      }

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
          <a class="ah-wait-btn call" href="tel:${esc(phone)}"> Call</a>
          ${intl ? `<a class="ah-wait-btn wa" href="https://wa.me/${esc(intl)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
        </div>
      </div>`;
    }).join("");
    panel.innerHTML = `
      <div class="ah-wait-card">
        <div class="ah-wait-head"> ${rows.length} ${rows.length === 1 ? "person is" : "people are"} waiting near ${esc(area)}</div>
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

  // fetch() has no native timeout — wrap it with an AbortController so a hung /
  // cold request can't block the upload forever.
  function _fetchTimeout(url, opts, ms) {
    const ac = new AbortController();
    const id = setTimeout(() => ac.abort(), ms);
    return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(id));
  }

  // Poll /health until the (possibly asleep) gateway answers OK, or give up.
  // Render free-tier cold starts take ~15–50s, so we wait up to ~60s. Returns
  // true once the service is awake, false if it never came up in time.
  async function _waitGatewayReady(base, budgetMs = 60000) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      try {
        const r = await _fetchTimeout(`${base}/health`, {}, 10000);
        if (r.ok) return true;
      } catch (_) { /* still waking */ }
      await new Promise((res) => setTimeout(res, 3000));
    }
    return false;
  }

  // Count of videos in the current save that could NOT be optimised, so the save
  // flow can warn the agent instead of silently storing a clip that will stutter.
  let _videoOptimizeFailures = 0;

  async function faststart(file) {
    const base = _videoGatewayBase();
    if (!base || !file) return file;

    // A cold free-tier gateway used to make the single fetch fail, so we'd
    // silently upload the un-optimised original (moov at end → stutter). Wake it
    // and wait before remuxing; only fall back if it truly never comes up.
    const ready = await _waitGatewayReady(base);
    if (!ready) { _videoOptimizeFailures++; return file; }

    // One real attempt + one retry — covers a flaky wake mid-spin-up. Give the
    // remux a generous timeout (large clips on a just-woken instance are slow).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await _fetchTimeout(`${base}/faststart`, {
          method: "POST",
          headers: { "Content-Type": file.type || "video/mp4" },
          body: file,
        }, 90000);
        if (!r.ok) continue;
        const blob = await r.blob();
        if (!blob || !blob.size) continue;
        // "applied" → server remuxed it; result is MP4, so rename to match
        // (e.g. an iPhone .mov becomes .mp4). "passthrough" → already faststart.
        if (r.headers.get("X-Faststart") === "applied") {
          const name = (file.name || "video").replace(/\.[^.]+$/, "") + ".mp4";
          return new File([blob], name, { type: "video/mp4" });
        }
        return file; // already faststart — nothing to do
      } catch (_) { /* timeout / network — retry once */ }
    }
    _videoOptimizeFailures++;
    return file; // gateway awake but remux failed — upload original, warn later
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
          <div class="ah-setup-icon"></div>
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

  // ---- Tenant tracking (rent listings) -------------------------------------
  // The owning agent records each renter + rental length; the DB computes the
  // end date. Admin monitors all tenancies centrally (admin.html → Tenants).
  let _tenantModal = null;

  function computeEnd(startIso, months) {
    if (!startIso || !months || months < 1) return "";
    const d = new Date(startIso + "T00:00:00");
    if (isNaN(d)) return "";
    d.setMonth(d.getMonth() + months);
    return d.toISOString().slice(0, 10);
  }

  function daysLeftBadge(endIso) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const end = new Date(endIso + "T00:00:00");
    const days = Math.round((end - today) / 86400000);
    if (days < 0)   return { cls: "expired", label: `${Math.abs(days)}d overdue` };
    if (days === 0) return { cls: "soon", label: "ends today" };
    if (days <= 7)  return { cls: "soon", label: `${days}d left` };
    if (days <= 30) return { cls: "warn", label: `${days}d left` };
    return { cls: "ok", label: `${days}d left` };
  }

  function closeTenantPanel() { if (_tenantModal) _tenantModal.style.display = "none"; }

  async function openTenantPanel(house) {
    const { data: { session } } = await sb.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) { alert(tr("ah_must_signin") || "Please sign in."); return; }
    if (!_tenantModal) {
      _tenantModal = document.createElement("div");
      _tenantModal.className = "ah-tenant-overlay";
      _tenantModal.innerHTML = `<div class="ah-tenant-modal" role="dialog" aria-modal="true">
        <button class="ah-tenant-close" aria-label="Close">&times;</button>
        <div class="ah-tenant-body"></div>
      </div>`;
      document.body.appendChild(_tenantModal);
      _tenantModal.addEventListener("click", (e) => { if (e.target === _tenantModal) closeTenantPanel(); });
      _tenantModal.querySelector(".ah-tenant-close").addEventListener("click", closeTenantPanel);
    }
    _tenantModal.style.display = "flex";
    const body = _tenantModal.querySelector(".ah-tenant-body");
    body.innerHTML = `<div class="ah-tenant-empty">${esc(tr("ah_loading") || "Loading…")}</div>`;
    await renderTenantPanel(house, uid, body, null);
  }

  async function renderTenantPanel(house, uid, body, editRow) {
    const { data, error } = await sb.from("house_tenancies")
      .select("*").eq("house_id", house.id).order("end_date", { ascending: false });
    const list = !error && Array.isArray(data) ? data : [];

    // A completed deal (an ACTIVE tenant) drops the house from the public list;
    // when no tenancy is active it's re-listed. New listings default to available.
    if (!error) {
      const shouldAvail = !list.some((t) => t.status === "active");
      if (house.available !== shouldAvail) {
        house.available = shouldAvail;
        sb.from("houses").update({ available: shouldAvail, updated_at: new Date().toISOString() })
          .eq("id", house.id).eq("owner_user_id", uid).then(() => { if (typeof loadMyListings === "function") loadMyListings(); });
      }
    }

    const defMonths = editRow?.months ?? (house.min_months || 1);
    const defStart  = editRow?.start_date ?? new Date().toISOString().slice(0, 10);

    const existing = list.length ? list.map(t => {
      const b = daysLeftBadge(t.end_date);
      const active = t.status === "active";
      return `<div class="ah-tenant-row ${active ? "is-active" : ""}" data-tid="${esc(t.id)}">
        <div class="ah-tenant-main">
          <strong>${esc(t.customer_name)}</strong> · <a href="tel:${esc(t.customer_phone)}">${esc(t.customer_phone)}</a>
          ${t.landlord_phone ? `<div class="ah-tenant-meta"> ${esc(tr("ah_tenant_landlord"))}: <a href="tel:${esc(t.landlord_phone)}">${esc(t.landlord_phone)}</a></div>` : ""}
          <div class="ah-tenant-meta">${esc(t.start_date)} → <strong>${esc(t.end_date)}</strong>
            ${active ? `<span class="ah-dleft ah-dleft-${b.cls}">${esc(b.label)}</span>`
                     : `<span class="ah-tenant-status">${esc(t.status)}</span>`}
          </div>
          ${t.notes ? `<div class="ah-tenant-note">${esc(t.notes)}</div>` : ""}
        </div>
        <div class="ah-tenant-acts">
          <button class="ah-btn ah-t-edit">${esc(tr("ah_edit"))}</button>
          ${active ? `<button class="ah-btn ah-t-end">${esc(tr("ah_tenant_mark_ended"))}</button>
                      <button class="ah-btn ah-t-renew">${esc(tr("ah_tenant_renew"))}</button>` : ""}
          <button class="ah-btn ah-btn-danger ah-t-del">${esc(tr("ah_delete"))}</button>
        </div>
      </div>`;
    }).join("") : `<div class="ah-tenant-empty">${esc(tr("ah_tenant_none"))}</div>`;

    body.innerHTML = `
      <h3 class="ah-tenant-h">${esc(tr("ah_tenant_title"))}</h3>
      <div class="ah-tenant-sub">${esc(house.title)}</div>
      <div class="ah-tenant-list">${existing}</div>
      <form class="ah-tenant-form" autocomplete="off">
        <h4>${editRow && editRow.id ? esc(tr("ah_edit")) : esc(tr("ah_tenant_add"))}</h4>
        <label>${esc(tr("ah_tenant_name"))}<input id="tnName" required maxlength="120" value="${editRow ? esc(editRow.customer_name) : ""}"></label>
        <label>${esc(tr("ah_tenant_phone"))}<input id="tnPhone" type="tel" required maxlength="30" value="${editRow ? esc(editRow.customer_phone) : ""}"></label>
        <label>${esc(tr("ah_tenant_landlord"))}<input id="tnLandlord" type="tel" maxlength="30" value="${editRow ? esc(editRow.landlord_phone || "") : ""}"></label>
        <div class="ah-tenant-grid">
          <label>${esc(tr("ah_tenant_start"))}<input id="tnStart" type="date" required value="${esc(defStart)}"></label>
          <label>${esc(tr("ah_tenant_months"))}<input id="tnMonths" type="number" min="1" step="1" required value="${defMonths}"></label>
        </div>
        <div class="ah-tenant-endprev">${esc(tr("ah_tenant_end"))}: <strong id="tnEndPrev">—</strong></div>
        <label>${esc(tr("ah_tenant_notes"))}<textarea id="tnNotes" rows="2" maxlength="400">${editRow ? esc(editRow.notes || "") : ""}</textarea></label>
        <div class="ah-tenant-msg" id="tnMsg" hidden></div>
        <div class="ah-tenant-formacts">
          <button type="submit" class="ah-btn ah-btn-brand">${esc(tr("ah_tenant_save"))}</button>
          ${editRow && editRow.id ? `<button type="button" class="ah-btn ah-t-cancel">${esc(tr("ah_cancel") || "Cancel")}</button>` : ""}
        </div>
      </form>`;

    const startEl = body.querySelector("#tnStart"), monthsEl = body.querySelector("#tnMonths"), prevEl = body.querySelector("#tnEndPrev");
    const updatePrev = () => { prevEl.textContent = computeEnd(startEl.value, parseInt(monthsEl.value, 10)) || "—"; };
    startEl.addEventListener("input", updatePrev); monthsEl.addEventListener("input", updatePrev); updatePrev();

    body.querySelectorAll(".ah-tenant-row").forEach(rowEl => {
      const t = list.find(x => x.id === rowEl.dataset.tid);
      rowEl.querySelector(".ah-t-edit").addEventListener("click", () => renderTenantPanel(house, uid, body, t));
      rowEl.querySelector(".ah-t-del")?.addEventListener("click", async () => {
        if (!confirm(tr("ah_tenant_del_confirm") || "Delete this tenant record?")) return;
        await sb.from("house_tenancies").delete().eq("id", t.id).eq("owner_user_id", uid);
        renderTenantPanel(house, uid, body, null);
      });
      rowEl.querySelector(".ah-t-end")?.addEventListener("click", async () => {
        await sb.from("house_tenancies").update({ status: "ended", updated_at: new Date().toISOString() }).eq("id", t.id).eq("owner_user_id", uid);
        renderTenantPanel(house, uid, body, null);
      });
      rowEl.querySelector(".ah-t-renew")?.addEventListener("click", async () => {
        await sb.from("house_tenancies").update({ status: "renewed", updated_at: new Date().toISOString() }).eq("id", t.id).eq("owner_user_id", uid);
        renderTenantPanel(house, uid, body, { customer_name: t.customer_name, customer_phone: t.customer_phone, landlord_phone: t.landlord_phone, start_date: t.end_date, months: house.min_months || t.months, notes: t.notes });
      });
    });

    const form = body.querySelector(".ah-tenant-form");
    body.querySelector(".ah-t-cancel")?.addEventListener("click", () => renderTenantPanel(house, uid, body, null));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = body.querySelector("#tnMsg");
      const payload = {
        house_id: house.id,
        house_label: [house.title, house.area].filter(Boolean).join(" — "),
        owner_user_id: uid,
        customer_name: body.querySelector("#tnName").value.trim(),
        customer_phone: body.querySelector("#tnPhone").value.trim(),
        landlord_phone: body.querySelector("#tnLandlord").value.trim() || null,
        start_date: body.querySelector("#tnStart").value,
        months: Math.max(1, parseInt(body.querySelector("#tnMonths").value, 10) || 1),
        notes: body.querySelector("#tnNotes").value.trim() || null,
        updated_at: new Date().toISOString()
      };
      const isEdit = editRow && editRow.id;
      const q = isEdit
        ? sb.from("house_tenancies").update(payload).eq("id", editRow.id).eq("owner_user_id", uid)
        : sb.from("house_tenancies").insert({ ...payload, id: generateId().replace(/^h-/, "ht-"), status: "active" });
      const { error: e2 } = await q;
      if (e2) { msg.hidden = false; msg.className = "ah-tenant-msg err"; msg.textContent = e2.message; return; }
      renderTenantPanel(house, uid, body, null);
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
