// ============================================================================
//  Agent Houses dashboard
//  - Sign in / sign up with Supabase auth (email + password)
//  - List the current user's own property listings
//  - Create / edit / delete listings (matches the RLS policies in
//    supabase/schema/schema_master.sql section 34 — owner_user_id = auth.uid())
//  - GPS-verified pin picker: drag a marker on a satellite map OR use
//    the device's GPS to set lat/lng
//  - Photo upload to the `house-photos` storage bucket (client-side
//    resized to 1200px / JPEG 0.85 — keeps it under 500 KB)
// ============================================================================

window.initAgentHousesPage = async () => {
  const sb = window.DataStore?.sb;
  const tr = (k) => (window.t ? window.t(k) : k);

  // The brand green, read from the design token rather than written out
  // again. MapLibre paint properties and inline SVG fills take a colour
  // string, not a var(), so this is the one place the token is resolved.
  // Falls back to the foundation green if the stylesheet has not landed.
  const brandGreen = () => {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue("--green").trim();
    return v || "#0a6f4d";
  };

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

  // The spec sheet: room types that carry their own prices, and any category
  // of fact the agent wants to state. Shape lives in js/lib/house-spec.js.
  const fRoomSuggest     = document.getElementById("ahRoomSuggest");
  const fRoomsList       = document.getElementById("ahRoomsList");
  const fAddRoomBtn      = document.getElementById("ahAddRoomBtn");
  const fGroupSuggest    = document.getElementById("ahGroupSuggest");
  const fGroupsList      = document.getElementById("ahGroupsList");

  // The three doors onto a location somebody already shared are
  // js/lib/place-doors.js now, and that module owns its own elements. The
  // one thing this page adds on top of them is the seal; see the mount near
  // the bottom of this file.

  // The seal: "this pin is exactly where somebody put it", and the withdrawal
  // of that claim the moment it stops being true.
  const fPinSeal         = document.getElementById("ahPinSeal");

  // Media limits
  const MAX_PHOTOS    = 12;
  const MAX_VIDEOS    = 2;
  // 2 min 39 s — the platform-wide ceiling, shared with the homepage video space
  // (see js/lib/video-space.js and services/python/main.py, which does the actual
  // cutting). A clip longer than this is no longer REJECTED: the gateway trims it
  // and keeps the part within the limit.
  //
  // The size cap is what still protects slow mobile links. A 60 MB clip was
  // timing out (cold gateway + a single large PUT to storage) and surfacing as a
  // confusing "database/upload" failure, so the byte ceiling stays low even
  // though the duration ceiling went up — 2m39s of sanely-encoded phone video
  // fits well inside it, and anything that doesn't is over-bitrate for the job.
  const MAX_VIDEO_S   = (window.APP_CONFIG && window.APP_CONFIG.VIDEO_MAX_DURATION_S) || 159;
  const MAX_VIDEO_B   = 50 * 1024 * 1024;  // 50 MB
  const fTitle        = document.getElementById("ahTitle");
  const fType         = document.getElementById("ahType");
  const fTypeOther    = document.getElementById("ahTypeOther");
  const fTypeOtherRow = document.getElementById("ahTypeOtherRow");
  // Property types the dropdown offers directly; anything else is free text ("other").
  const KNOWN_TYPES   = ["apartment", "house", "plot", "office", "shop", "warehouse"];
  const fIsFrame      = document.getElementById("ahIsFrame");
  // Show the free-text box only when the provider picks "Other (any kind)".
  function syncTypeOther() {
    if (fTypeOtherRow) fTypeOtherRow.hidden = fType.value !== "other";
  }
  if (fType) fType.addEventListener("change", () => {
    syncTypeOther();
    // Picking a clearly-commercial type pre-ticks "Frame" (never auto-unticks —
    // the agent stays in control, e.g. to mark an "other" space as a frame too).
    if (fIsFrame && /^(shop|office|warehouse)$/.test(fType.value)) fIsFrame.checked = true;
  });
  const fListing      = document.getElementById("ahListing");
  const fPrice        = document.getElementById("ahPrice");
  const fPeriod       = document.getElementById("ahPeriod");
  const fMinMonths    = document.getElementById("ahMinMonths");
  const fMinMonthsRow = document.getElementById("ahMinMonthsRow");
  const fAgentFee     = document.getElementById("ahAgentFee");
  const fAgentFeeRow  = document.getElementById("ahAgentFeeRow");
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
  // What kind of account this is, and what that allows. Declared up here with
  // the rest of the module state because routeOnAuth() is awaited near the top
  // of this file and reaches them through syncAccountKind(): a `let` further
  // down is a temporal dead zone, not a definition.
  let ownerQuota    = null;         // owner_post_quota(), or null for an agent
  const isOwnerAccount = () => !!(ownerQuota && ownerQuota.is_owner);
  const trf = (k, en) => { const v = window.t ? window.t(k) : null; return (v && v !== k) ? v : en; };

  let editingId     = null;         // null = create, set = editing this id
  let openedForEdit = false;        // what the form was opened for (see openForm)
  let agentProfile  = null;         // region + area this agent operates in
  let pickedLatLng  = null;         // { lat, lng }
  let pinMap        = null;
  let pinMarker     = null;
  let customAmenities = [];         // free-text amenities added by the agent
  let nearbyData      = null;       // { schools: {label,icon,items[]}, ... }
  let nearbyFetchKey  = null;       // serialised lat/lng we last fetched for
  let nearbyTimer     = null;       // debounce timer for Overpass calls
  let searchTimer     = null;       // debounce timer for Mapbox search
  let gpsAccuracyM    = null;       // accuracy (metres) of the last GPS fix, if any
  let _videoWarmed    = false;   // see warmVideoGateway(), ~3000 lines below
  // The workspace: the board of eight parts, and one part at a time behind it.
  // Declared up here with the rest of the module state for the same reason
  // ownerQuota is: mountWorkspace() is called before any await, and a `let`
  // further down is a temporal dead zone, not a definition.
  let formWs        = null;

  // ---- Is this page finished setting itself up? --------------------------
  //
  // It is one long async function, and the New-listing button is deliberately
  // wired before the first await so that a tap during loading is not lost.
  // But openForm() reads things declared much further down — the spec-sheet
  // helper, the video-gateway flag, the amenity catalogue — and a `const`
  // further down this function does not exist yet while the dashboard is
  // still fetching its rows. Tapping in that window produced "Agent dashboard
  // error: Cannot access 'HS' before initialization", which is a sentence
  // about a temporal dead zone shown to somebody trying to list a house.
  //
  // Hoisting each name as it turns up would fix them one at a time and leave
  // the next one waiting. The real fact is simpler and only has to be said
  // once: THE PAGE IS NOT READY YET. So the intent is remembered and acted on
  // the moment it is — nothing is lost, and nothing runs early.
  let pageReady    = false;
  let queuedForm   = null;   // { row } a form asked for before we could open it
  // Where the pin was PUT BY SOMEBODY, as opposed to where it currently sits.
  // { lat, lng, acc, via, name, userId, guest, thread, at } or null. See the
  // block above renderPinSeal() for what it is for.
  let pinOrigin       = null;
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
alter table public.houses add column if not exists agent_fee_tzs bigint not null default 0;
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

  // ---- The notice strip ----------------------------------------------------
  // Everything the platform has to say about this account, in one card with a
  // pager, so the dashboard is the same height whether nothing has happened or
  // nine things have. It replaces four writers that all did
  // insertBefore(el, dashboard.firstChild) and none of which knew about the
  // others. See js/lib/agent-notice-strip.js.
  let strip = null;
  function ensureStrip() {
    if (!strip && warnEl && window.AgentNoticeStrip) {
      strip = window.AgentNoticeStrip.mount({ into: warnEl });
    }
    return strip;
  }

  /**
   * Read the account's notices ONCE and hand both halves to the strip.
   *
   * my_notices() returns the unread admin messages AND the live billing state
   * in one round trip, with days_left computed on the server. This page used to
   * fire my_agent_subscription() on top of it and read agent_messages a second
   * time directly, so three surfaces could disagree about the same account.
   */
  async function refreshNotices(force) {
    const s = ensureStrip();
    if (!s || !window.Notices) return;
    const data = await window.Notices.load(force);
    s.set("sub", [window.agentBillingNotice?.(data.billing)].filter(Boolean));
    s.set("admin", window.agentAdminNotices?.(data.notices) || []);
  }

  // ---- Surface any uncaught JS error -------------------------------------
  // Without this, a typo or RLS bug stops the script halfway through binding
  // event listeners and the user sees buttons that look fine but do nothing.
  // The raw message goes to the console, where a developer will find it; the
  // agent gets a sentence and a Reload button, because "Cannot read properties
  // of undefined" is not something to put in front of a landlord.
  function showFatal(msg) {
    try { console.error("[agent-houses]", msg); } catch (_) {}
    const s = ensureStrip();
    if (!s) { alert(trf("anx_fatal_t", "This page did not load properly")); return; }
    s.set("fatal", [{
      id: "fatal",
      source: "fatal",
      severity: "fatal",
      title: trf("anx_fatal_t", "This page did not load properly"),
      body: trf("anx_fatal_b", "Reload the page. If it happens again, tell the admin what you were doing."),
      action: { label: trf("anx_reload", "Reload"), onClick: () => location.reload() },
    }]);
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
  /**
   * Open the listing form, now or as soon as the page can.
   *
   * Every route into the form goes through here — the New button, the empty
   * state, and the edit button on each row — because all three can be tapped
   * while the page is still assembling itself, and all three used to fail
   * differently when they were.
   */
  function requestForm(row) {
    if (!pageReady) { queuedForm = { row: row || null }; return; }
    try {
      openForm(row || null);
    } catch (err) {
      showFatal("Couldn't open form: " + (err.message || err));
    }
  }

  newBtn?.addEventListener("click", () => requestForm(null));
  cancelBtn?.addEventListener("click", () => closeForm());

  // The board over the eight parts of the form, built here for the same reason
  // the buttons above are bound here: it needs the DOM and nothing else, and
  // everything below this line waits on the network. Mounted after the cancel
  // binding on purpose, because the workspace MOVES that button onto the
  // board, and a listener travels with the node while a re-created button
  // would not.
  mountWorkspace();

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
  // Listen to the CHECKBOX, not to the label around it.
  //
  // A tap on a <label> fires click twice: once from the pointer, with the label
  // as the target, and once again when the label's own activation behaviour
  // clicks the control it labels. The guard here used to be "flip it by hand
  // unless the target is the checkbox", which flipped it on the first click and
  // let the browser flip it straight back on the second, so an amenity could
  // not be turned on at all. `change` fires once, after the browser has already
  // done the toggling, and needs no guard.
  fAmenities.querySelectorAll(".ah-chip").forEach(chip => {
    const cb = chip.querySelector("input");
    cb.addEventListener("change", () => chip.classList.toggle("active", cb.checked));
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
  // NOT awaited, deliberately. Everything below this line down to
  // `pageReady = true` is the page wiring itself up, and openForm() refuses to
  // run until that flag is set. routeOnAuth() waits on the network (the
  // session, the listing list) and, for an agent, on a MODAL the person has to
  // fill in. Awaiting it here put the whole wiring behind all three: while the
  // "where do you operate?" sheet was up, or if any of those awaits rejected,
  // pageReady never became true and "New listing" queued the form forever and
  // opened nothing, with no error to explain it.
  routeOnAuth().catch((err) => showFatal(err?.message || String(err)));
  // Only react to genuine sign-in / sign-out. Supabase also fires this event on
  // TOKEN_REFRESHED, USER_UPDATED and tab-refocus — re-routing on those would
  // hide an open registration form and reload the list mid-entry (it looks like
  // the page "auto-refreshed" and wiped what you were typing).
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") { routeOnAuth(null); return; }
    if (event === "SIGNED_IN" && !authCard.hidden) routeOnAuth(session);
  });

  // The subscription guard that used to live here called my_agent_subscription()
  // and drew its own banner. my_notices() already returns that state, computed
  // on the server, in the round trip the bell was making anyway, so
  // refreshNotices() above is the whole of it now.

  // ---- the owner's account, and their allowance ---------------------------
  //
  //  js/lib/login-doors.js has four doors and one of them is marked VIP: a
  //  landlord listing their own property, with no agent in between and no
  //  monthly agent fee. Everything that makes that true lives in the database
  //  (supabase/features/house/house_owner_accounts.sql). What this dashboard
  //  has to do is three things:
  //
  //    say which account this is, on the SERVER, because the door itself is
  //    user metadata and metadata cannot be what decides who pays;
  //    not ask an owner an agent's questions;
  //    and say where they stand on their three posts BEFORE the form, because
  //    a refusal after twenty minutes of typing is an ambush, not a rule.
  async function syncAccountKind() {
    if (!window.OwnerAccount) return;
    let door = null;
    try { door = window.LoginDoors && window.LoginDoors.get(); } catch (_) {}
    if (!door) {
      try {
        const { data } = await sb.auth.getSession();
        door = data?.session?.user?.user_metadata?.account_type || null;
      } catch (_) {}
    }
    ownerQuota = await window.OwnerAccount.quota();
    // The claim is made every time this page opens, not once at sign-up, so an
    // account that predates the table is corrected the first time its owner
    // looks at it. A refusal is swallowed on purpose: it means "you are already
    // trading as an agent", which is exactly what the page does next anyway.
    if (door === "owner" && ownerQuota && ownerQuota.kind !== "owner") {
      try {
        await window.OwnerAccount.claim("owner");
        ownerQuota = await window.OwnerAccount.quota();
      } catch (_) { /* refused, and the page carries on as an agent's */ }
    }
    renderOwnerQuota();
  }

  async function refreshOwnerQuota() {
    if (!window.OwnerAccount || !isOwnerAccount()) return;
    ownerQuota = await window.OwnerAccount.quota();
    renderOwnerQuota();
  }

  function renderOwnerQuota() {
    const host = document.getElementById("ahOwnerQuota");
    if (!host) return;
    const q = ownerQuota;
    if (!q || !q.is_owner) { host.innerHTML = ""; blockNewListing(false); return; }
    const O = window.OwnerAccount;
    const full = Number(q.left) <= 0;
    // The numbers come down from the database, which reads the same two
    // functions the trigger reads. Nothing here is written twice.
    const said = [
      O.leftSentence(q),
      O.nextSentence(q),
      trf("own_acc_window", "An owner account posts {limit} listings every {days} days, with no monthly fee.")
        .replace("{limit}", q.limit).replace("{days}", q.window_days),
    ].filter(Boolean).join(" ");
    host.innerHTML =
      '<div class="owner-quota' + (full ? " is-full" : "") + '">' +
        '<span class="owner-quota-n">' + esc(String(q.left)) + "<small>/" + esc(String(q.limit)) + "</small></span>" +
        '<span class="owner-quota-tx">' +
          '<span class="owner-quota-t">' + esc(trf("own_acc_t", "Owner account")) + "</span>" +
          '<span class="owner-quota-d">' + esc(said) + "</span>" +
        "</span>" +
      "</div>";
    blockNewListing(full);
  }

  /**
   * Stop offering a form that cannot be saved.
   *
   * The database refuses the fourth post whatever this button does, so this is
   * not the fence: it is the difference between being told before and being
   * told after.
   */
  function blockNewListing(blocked) {
    const btn = document.getElementById("ahNewBtn");
    if (!btn) return;
    btn.disabled = !!blocked;
    btn.setAttribute("aria-disabled", String(!!blocked));
    if (blocked) {
      btn.title = window.OwnerAccount
        ? [window.OwnerAccount.leftSentence(ownerQuota), window.OwnerAccount.nextSentence(ownerQuota)]
            .filter(Boolean).join(" ")
        : "";
    } else {
      btn.removeAttribute("title");
    }
  }

  // A guest session is a real session. `s?.user` answered yes to one, which
  // opened this whole dashboard for somebody who has no account to own a
  // listing with. AuthGuard is the one place that knows the difference, and
  // "guest" is routed exactly like "signed out" plus an explanation.
  async function routeOnAuth(session) {
    const s = session ?? (await sb.auth.getSession()).data.session;
    // Fail closed if the guard did not load: an anonymous session is still
    // not an account, and the fallback must not be the bug this replaced.
    const who = window.AuthGuard ? await window.AuthGuard.gate({ session: s, mount: authCard })
      : (s?.user && s.user.is_anonymous !== true ? "account" : "out");
    if (who === "account") {
      authCard.hidden = true;
      dashboard.hidden = false;
      formSection.hidden = true;
      mode = "dashboard";
      // Before anything that can throw: a fatal after this point has somewhere
      // to be shown. mount() is memoised on the element, so re-entering
      // routeOnAuth (which SIGNED_IN does) cannot build a second one.
      ensureStrip();
      userEmailEl.textContent = s.user.email || tr("ah_no_email");
      // Capture (once) the region the agent belongs to + the area they operate
      // in, so their listings surface for searchers in that area.
      // Which kind of account this is, first, because the next line depends on
      // the answer. AgentProfile.ensure() opens a modal asking for an "area of
      // operations" and WRITES an agent_profiles row, and that row is what
      // makes somebody an agent everywhere else in this app: pm_publish_key
      // reads exactly it. Asking a landlord with one house an agent's question
      // and then filing them as an agent for answering it is how the VIP door
      // would have quietly stopped meaning anything.
      await syncAccountKind();
      if (!isOwnerAccount()) {
        try { agentProfile = await window.AgentProfile?.ensure(sb); } catch (_) {}
      }
      if (agentProfile?.region && fRegion && !fRegion.value) fRegion.value = agentProfile.region;
      await loadMyListings();
      // The admin's messages arrive here too, in the same round trip. An owner
      // is on no subscription, but an admin can still write to them, so this
      // runs for both kinds of account: agentBillingNotice() returns null when
      // there is no billing state to report.
      refreshNotices(true);
      loadWaitingNearMe();   // proactive demand board (renters waiting near them)
      // Two panels of coaching for somebody building an agency: keep a client
      // list, scout an area's Frame before you invest in it. Both are the
      // right advice for an agent and neither is addressed to a landlord with
      // one house to let, so an owner is spared them. The waiting-renters
      // board above is NOT gated: a room to fill is a room to fill.
      if (!isOwnerAccount()) {
        // Mounted into #ahCoach, which sits UNDER the listings, rather than
        // into the dashboard itself. Both panels insert at their mount's
        // firstChild, so passing the dashboard put two long coaching cards
        // above the properties the agent came here to manage.
        const coach = document.getElementById("ahCoach") || dashboard;
        window.renderAgentClientTip?.({ mount: coach, id: "ahClientTip", kind: "houses" });
        window.renderFrameScout?.({ mount: coach, id: "ahFrameScout", kind: "houses" });
      }
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
    // Skeleton (or keep the one already in HTML on first load). Back to the
    // plain grid the skeleton and the empty state sit in; only the populated
    // branch below switches it to the listing-card layout.
    listEl.classList.remove("aw-listings");
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
        <div class="hp-empty__title">${esc(tr("ah_list_fail"))}</div>
        <div class="hp-empty__sub">${esc(error.message)}</div>
        <button class="hp-empty__cta" type="button" onclick="location.reload()">${esc(tr("ah_try_again"))}</button>
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
        <button class="hp-empty__cta" type="button" id="ahEmptyNew">+ ${esc(tr("ah_add_first"))}</button>
      </div>`;
      document.getElementById("ahEmptyNew")?.addEventListener("click", () => requestForm(null));
      return;
    }
    // One card per property.
    //
    // This used to be an eight-column table at `min-width: 640px` inside an
    // `overflow-x: auto`, which is a sideways scroll on every phone sold, with
    // Edit and Delete parked in the column furthest off the right-hand edge.
    // It also carried eleven hardcoded English strings and six raw hex colours
    // in inline styles. Cards stack on a phone, go two and three up on a wide
    // screen, and every string and colour below comes from i18n and the tokens.
    listEl.classList.add("aw-listings");

    const typeLabel = (ty) => {
      const known = ["apartment", "house", "plot", "office", "shop", "warehouse"];
      return known.includes(ty) ? tr("ah_type_" + ty) : (ty || tr("ah_type_other"));
    };
    const ICO = {
      clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
      home:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
      pin:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
      cash:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
    };

    const cards = data.map(h => {
      const photo   = window.DataStore.housePhotoUrl(h.photo);
      const isSale  = h.listing === "sale";
      const price   = formatPrice(h);
      const unit    = isSale ? "TZS" : "TZS " + tr("aw_per_" + (h.period === "total" ? "total" : "month"));
      const where   = [h.area, h.region].filter(Boolean).join(", ");

      // The commission the TENANT pays the agent for the deal, separate from
      // the rent. The Tanzanian standard is one month's rent unless an explicit
      // figure was set. A sale runs on a different model, so it shows nothing.
      const fee = !isSale
        ? (Number(h.agent_fee_tzs) > 0 ? Number(h.agent_fee_tzs) : (Number(h.price_tzs) || 0))
        : 0;

      // Listings and their media are removed automatically 15 days after
      // posting. Three days out that stops being a fact and becomes a warning.
      const daysLeft = Math.ceil((new Date(h.created_at).getTime() + 15 * 864e5 - Date.now()) / 864e5);
      const expText  = daysLeft <= 0 ? tr("aw_expires_today")
                     : daysLeft === 1 ? tr("aw_expires_1")
                     : tr("aw_expires_n").replace("{n}", daysLeft);
      const expFlag  = `<span class="aw-flag aw-flag--${daysLeft <= 3 ? "soon" : "calm"}">${esc(expText)}</span>`;

      const offFlag = h.available === false
        ? `<span class="aw-flag aw-flag--off">${esc(tr(isSale ? "aw_off_sold" : "aw_off_rented"))}</span>`
        : "";

      return `<article class="aw-listing" data-id="${esc(h.id)}">
        <div class="aw-listing__photo" data-loading="true" style="background-image:url('${esc(photo)}')">
          <span class="aw-listing__tag${isSale ? " aw-listing__tag--sale" : ""}">${esc(tr(isSale ? "ah_for_sale" : "ah_for_rent"))}</span>
        </div>
        <div class="aw-listing__body">
          <h3 class="aw-listing__title">${esc(h.title)}</h3>
          <span class="aw-listing__price">${esc(price.value)} <small>${esc(unit)}</small></span>
          <ul class="aw-listing__facts">
            <li>${ICO.home}${esc(typeLabel(h.type))}</li>
            ${where ? `<li>${ICO.pin}${esc(where)}</li>` : ""}
            ${fee > 0 ? `<li>${ICO.cash}${esc(tr("aw_your_fee"))} <b>${fee.toLocaleString("en-US")}</b>${Number(h.agent_fee_tzs) > 0 ? "" : " " + esc(tr("aw_fee_one_month"))}</li>` : ""}
            <li>${ICO.clock}${expFlag}</li>
            ${offFlag ? `<li>${offFlag}</li>` : ""}
          </ul>
        </div>
        <div class="aw-listing__acts">
          ${!isSale ? `<button type="button" class="ah-btn ah-tenant-btn" aria-label="${esc(tr("ah_completed_btn"))}: ${esc(h.title)}">${esc(tr("ah_completed_btn"))}</button>` : ""}
          ${isSale ? `<button type="button" class="ah-btn ${h.available === false ? "" : "ah-btn-complete"} ah-sold-btn" aria-label="${esc(tr(h.available === false ? "ah_relist_btn" : "ah_mark_sold_btn"))}: ${esc(h.title)}">${esc(tr(h.available === false ? "ah_relist_btn" : "ah_mark_sold_btn"))}</button>` : ""}
          <button type="button" class="ah-btn ah-edit-btn" aria-label="${esc(tr("ah_edit"))}: ${esc(h.title)}">${esc(tr("ah_edit"))}</button>
          <button type="button" class="ah-btn ah-btn-danger ah-delete-btn" aria-label="${esc(tr("ah_delete"))}: ${esc(h.title)}">${esc(tr("ah_delete"))}</button>
        </div>
      </article>`;
    }).join("");

    listEl.innerHTML = cards;

    listEl.querySelectorAll("[data-id]").forEach(card => {
      const row = data.find(x => String(x.id) === card.dataset.id);
      if (!row) return;
      card.querySelector(".ah-edit-btn").addEventListener("click", () => requestForm(row));
      card.querySelector(".ah-delete-btn").addEventListener("click", () => deleteListing(row));
      card.querySelector(".ah-tenant-btn")?.addEventListener("click", () => openTenantPanel(row));
      card.querySelector(".ah-sold-btn")?.addEventListener("click", () => markSold(row));
    });

    // Drop the shimmer on each cover as its image arrives.
    listEl.querySelectorAll(".aw-listing__photo[data-loading]").forEach(el => {
      const m = (el.getAttribute("style") || "").match(/url\(['"]?([^'")]+)['"]?\)/);
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
    if (fMinMonthsRow) fMinMonthsRow.hidden = fListing.value !== "rent";
    if (fAgentFeeRow)  fAgentFeeRow.hidden  = fListing.value !== "rent";
  }
  fListing?.addEventListener("change", toggleMinMonths);


  function openForm(row) {
    editingId = row?.id || null;
    // What the form was OPENED for, kept separately from what it is editing.
    // They can only ever come apart one way, and that way is a bug: a form
    // opened on an existing listing that has lost the id it was editing. If
    // that ever happens the save must stop, not fall through to an insert,
    // because on an owner account an insert spends one of three posts for six
    // months. The database counts inserts and nothing else, so this is the
    // screen keeping its own promise rather than a second fence.
    openedForEdit = !!row;
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
    pinOrigin = null;
    resolvedPlace = null;
    geocodeKey = null;
    stopGpsWatch();
    if (fPinPlace) fPinPlace.hidden = true;
    fPinCoords.textContent = "No pin set";
    if (fPinSearch)        fPinSearch.value = "";
    if (fPinSearchResults) fPinSearchResults.hidden = true;
    fAmenities.querySelectorAll(".ah-chip").forEach(c => c.classList.remove("active"));
    fAmenities.querySelectorAll("input").forEach(i => i.checked = false);
    fAmenities.querySelectorAll(".ah-chip--custom").forEach(c => c.remove());
    if (fFurnished) fFurnished.value = "";
    if (fMinMonths) fMinMonths.value = 1;
    if (fAgentFee) fAgentFee.value = "";
    if (fRoomKind) fRoomKind.value = "";
    if (fIsFrame) fIsFrame.checked = false;
    if (fCostsList) fCostsList.innerHTML = "";
    if (fTypeOther) fTypeOther.value = "";
    syncTypeOther();
    resetSpec();

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
      if (fAgentFee) fAgentFee.value = row.agent_fee_tzs || "";
      if (fRoomKind) fRoomKind.value = row.room_kind || "";
      if (fIsFrame) fIsFrame.checked = !!row.is_frame;
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
      // Whoever sent this pin sent it once. Re-opening the listing to fix a
      // price must not quietly turn their location into the agent own.
      loadPinRecord(row.pin);
    }

    // The spec sheet: a saved listing brings its own rooms and categories
    // back; a new one starts on the suggestion chips alone.
    if (row) loadSpec(row);

    renderMediaGrids();
    renderCostQuick();   // build the one-tap preset chips for additional costs
    if (placeDoors) {
      placeDoors.refresh();   // locations already shared with this device
      placeDoors.scan();      // and the ones still sitting in a conversation
    }
    toggleMinMonths();   // show/hide the rent-only "minimum months" field

    // Switch UI
    dashboard.hidden = true;
    formSection.hidden = false;
    mode = "form";
    window.scrollTo({ top: 0, behavior: "smooth" });

    // The workspace. The eight parts become a board of eight tiles, and only
    // the part the agent has opened is in the layout, which is what took a
    // 390px phone off a thirteen-screen scroll.
    //
    // The pin map is no longer built here. MapLibre cannot size itself inside
    // a container that is display:none, and an agent who never opens "Where it
    // is" was paying for a map, a style, a marker and a tile budget to render
    // nothing. It is built the first time that part is opened instead, and
    // initPinMap() resizes on every visit after that.
    mountWorkspace();
    formWs?.toBoard();
  }

  /**
   * Build the workspace over the form.
   *
   * Called once while the page assembles itself rather than the first time the
   * form is opened. Nothing here measures anything, so it does not need the
   * form to be on screen, and mounting early means a test or a tool that
   * unhides #ahFormSection by hand gets the board rather than the eight raw
   * panels underneath it.
   */
  function mountWorkspace() {
    if (formWs) return formWs;
    formWs = window.AgentWorkspace?.mount({
      form: "#ahForm",
      summarize: summarizeSection,
      // The "listings last 15 days" warning is about the listing, not about
      // any one part of it, so it lives on the board beside Save rather than
      // above all eight steps in turn.
      boardOnly: ".ap-note--warn",
      // MapLibre cannot size itself inside a container that is display:none,
      // so the pin map is built the first time this part is opened, and
      // resized on every visit after that. initPinMap() does both.
      onStep: (panel) => { if (panel.id === "ahSecWhere") setTimeout(initPinMap, 60); },
    }) || null;
    return formWs;
  }

  /**
   * The line under each tile on the board.
   *
   * Five of the eight parts are described perfectly well by counting what the
   * agent has filled in, and js/lib/agent-workspace.js already does that. The
   * three below are not: a pin is set or it is not, a price is a figure rather
   * than a field, and "6 photos" is the answer where "1 of 1 filled" is noise.
   * Returning "" hands the tile back to the generic count.
   */
  function summarizeSection(panel) {
    switch (panel.id) {
      case "ahSecMedia": {
        const p = photoTiles.length, v = videoTiles.length;
        if (!p && !v) return "";
        if (!v) return tr("aw_sum_photos").replace("{n}", p);
        return tr("aw_sum_photos_videos").replace("{n}", p).replace("{v}", v);
      }
      case "ahSecPrice": {
        const n = Number(fPrice?.value);
        const rooms = fRoomsList ? fRoomsList.querySelectorAll(".ah-room").length : 0;
        const bills = fCostsList ? fCostsList.children.length : 0;
        if (!n && rooms) return tr("aw_sum_price_rooms");
        if (!n) return "";
        const money = "TZS " + n.toLocaleString("en-US");
        return bills
          ? tr("aw_sum_price_bills").replace("{money}", money).replace("{n}", bills)
          : money;
      }
      case "ahSecRooms": {
        const rooms = fRoomsList ? fRoomsList.querySelectorAll(".ah-room").length : 0;
        if (!rooms) return "";
        return rooms === 1 ? tr("aw_sum_room_1") : tr("aw_sum_rooms").replace("{n}", rooms);
      }
      case "ahSecWhere": {
        // An address is an answer and ticks the section, but it is not the
        // pin, and a tile that reads "Masaki" beside a tick while no pin
        // exists is the tile telling the agent the part is finished when the
        // one thing buyers navigate by is still missing. Say both.
        const where = [fArea?.value, fRegion?.value].filter(Boolean).join(", ").trim();
        if (!pickedLatLng) {
          return where ? tr("aw_sum_place_no_pin").replace("{place}", where) : "";
        }
        return where ? tr("aw_sum_pin_at").replace("{place}", where) : tr("aw_sum_pin");
      }
      case "ahSecSpec": {
        const groups = fGroupsList ? fGroupsList.querySelectorAll(".ah-group").length : 0;
        if (!groups) return "";
        return groups === 1 ? tr("aw_sum_group_1") : tr("aw_sum_groups").replace("{n}", groups);
      }
      default:
        return "";
    }
  }

  function closeForm() {
    formSection.hidden = true;
    dashboard.hidden = false;
    mode = "dashboard";
    editingId = null;
    openedForEdit = false;
  }

  // ---- Multi-photo + video upload -----------------------------------------
  let _tileSeq = 0;
  function nextTileId() { return "t" + (++_tileSeq); }

  fPhotoLabel.addEventListener("click", (e) => {
    if (photoTiles.length >= MAX_PHOTOS) {
      e.preventDefault();
      alert(tr("ah_photo_cap").replace("{n}", MAX_PHOTOS));
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
      // Over-length clips are trimmed by the gateway at save time rather than
      // refused here, so an agent is never sent away to find a video editor.
      // Unreadable metadata is not a reason to block either — ffprobe measures
      // it properly server-side.
      let durationOk = true;
      try { durationOk = await checkVideoDuration(file, MAX_VIDEO_S); }
      catch (_) { durationOk = true; }
      if (!durationOk) {
        const mins = Math.floor(MAX_VIDEO_S / 60), secs = MAX_VIDEO_S % 60;
        alert(`"${file.name}" is longer than ${mins} min ${secs} s — it will be trimmed to that length when you save.`);
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
    // MapLibre paint properties and an inline SVG fill cannot read a CSS
    // variable, so the brand green is read off the document once, from the
    // token, rather than written out as a literal in three more places.
    const BRAND = brandGreen();
    pinMap.on("load", () => {
      if (pinMap.getSource("ah-acc")) return;
      pinMap.addSource("ah-acc", { type: "geojson", data: emptyFC() });
      pinMap.addLayer({
        id: "ah-acc-fill", type: "fill", source: "ah-acc",
        paint: { "fill-color": BRAND, "fill-opacity": 0.12 }
      });
      pinMap.addLayer({
        id: "ah-acc-line", type: "line", source: "ah-acc",
        paint: { "line-color": BRAND, "line-width": 1.5, "line-dasharray": [2, 2] }
      });
    });

    const el = document.createElement("div");
    el.className = "ah-marker";
    el.innerHTML = `
      <svg width="32" height="42" viewBox="0 0 32 42" fill="none" aria-hidden="true">
        <path d="M16 0C7.2 0 0 7.2 0 16c0 12 16 26 16 26s16-14 16-26C32 7.2 24.8 0 16 0z" fill="${BRAND}" stroke="#fff" stroke-width="2"/>
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
      renderPinSeal();
      renderNearbyPanel();
      if (pinMap && window.AreaBoundary) AreaBoundary.clearMapLibre(pinMap);
      pinBoundaryKey = null;
      return;
    }
    const acc = accuracyBadge();
    fPinCoords.innerHTML =
      ` ${pickedLatLng.lat.toFixed(5)}, ${pickedLatLng.lng.toFixed(5)}${acc}`;
    // Every way the pin can move already ends here, which is why the seal is
    // checked here and nowhere else. See the block above renderPinSeal().
    renderPinSeal();
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

  // ==========================================================================
  //  THE SEAL — "this pin is exactly where somebody put it"
  //
  //  A location that arrives from a person is a different kind of fact from
  //  one the agent dragged onto a roof that looked about right. Somebody stood
  //  at that gate. They tapped once. The six decimal places that came out are
  //  the property, and the single most common way they stop being the property
  //  is that they pass through a human being on the way to the listing — read
  //  out on a phone, retyped, or nudged "closer to the road" by an agent who
  //  has never been there.
  //
  //  So a pin that came from a person is SEALED to the coordinates that person
  //  sent, and the form says so in words with their name in it. Nothing is
  //  locked: the sender may have pinned the wrong gate, may have been standing
  //  in the shop next door, may have had a bad fix — an agent who cannot
  //  correct that is an agent who has to throw the whole listing away. What is
  //  withheld is the CLAIM. Move the pin more than a house width off what they
  //  sent and the sentence stops saying "exactly as Amina sent it" and starts
  //  saying "you have moved this 96 m off the pin Amina sent", with the way
  //  back one tap away and the saved listing marked as the agent own pin
  //  rather than hers.
  //
  //  WHY THE CHECK LIVES IN updatePinReadout()
  //  Because every way the pin can move already ends there — the drag handler,
  //  the map click, the GPS fix, the search result, the AI locator, the remote
  //  request, and the three doors in the place panel. Breaking the seal at each
  //  of those call sites would be seven chances to forget, and the one that got
  //  forgotten would be a listing quietly claiming a person pin it had been
  //  moved off. One checkpoint cannot be forgotten.
  // ==========================================================================

  // A house width. Under this, a pin is the same doorway — GPS on a phone does
  // not repeat to better than this, and pretending otherwise would break the
  // seal on a pin nobody touched.
  const SEAL_TOLERANCE_M = 15;

  // The ways a location can arrive that mean SOMEBODY WAS STANDING THERE.
  // A pasted link, a map drag and a search result are all guesses, however
  // good, and none of them gets a seal.
  // 'chat' is what builds before this one wrote for a pin saved out of a
  // P-Message thread. It means the same thing and is normalised to 'pm'
  // below, so a pin filed last month seals exactly like one filed today.
  const SEALED_SOURCES = { pm: 1, chat: 1, code: 1, request: 1, gps: 1 };

  const TICK_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const WARN_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>' +
    '<path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

  /** How far the pin now sits from what was sent, or null when unsealed. */
  function originOffM() {
    if (!pinOrigin || !pickedLatLng) return null;
    return haversineMeters(pickedLatLng.lat, pickedLatLng.lng, pinOrigin.lat, pinOrigin.lng);
  }

  /** Is the pin still standing exactly where it was put? */
  function sealHolds() {
    const off = originOffM();
    return off != null && off <= SEAL_TOLERANCE_M;
  }

  /**
   * Remember that this pin came from somebody.
   *
   * Keeps the coordinates AS SENT even after the marker has been dragged away
   * from them, which is the only reason "put it back" can exist.
   */
  function sealPin(place) {
    // A pin that is NOT evidence does not clear a seal, it moves off it.
    // Pasting a link, searching a landmark and dragging the marker are the
    // same gesture wearing three hats, and only one of the three used to
    // come through here. Clearing on this path and not the others would
    // mean the way back to what somebody sent survived a 3 km search and
    // vanished on a paste. Only a person standing somewhere replaces a
    // person standing somewhere; resetForm() is what actually clears it.
    if (!place || !SEALED_SOURCES[place.source]) return;
    pinOrigin = {
      lat: Number(place.lat), lng: Number(place.lng),
      acc: place.acc == null ? null : (Math.round(Number(place.acc)) || null),
      via: place.source === "chat" ? "pm" : place.source,
      name: String(place.from || "").trim(),
      userId: String(place.fromId || "").trim(),
      guest: !!place.guest,
      thread: String(place.threadName || "").trim(),
      at: place.at || Date.now(),
    };
  }

  /** Who put the pin there, in words. A GPS fix has no third party in it. */
  function originWho() {
    if (!pinOrigin || pinOrigin.via === "gps") return "";
    return pinOrigin.name || tr("ah_seal_someone");
  }

  /** Put the pin back exactly where it was sent. */
  function restorePin() {
    if (!pinOrigin) return;
    pickedLatLng = { lat: pinOrigin.lat, lng: pinOrigin.lng };
    gpsAccuracyM = pinOrigin.acc;
    drawAccuracyCircle(gpsAccuracyM);
    if (pinMarker) pinMarker.setLngLat([pinOrigin.lng, pinOrigin.lat]);
    if (pinMap) pinMap.easeTo({ center: [pinOrigin.lng, pinOrigin.lat], zoom: 17, duration: 500 });
    updatePinReadout();
  }

  /**
   * The seal, on screen.
   *
   * Three states and no fourth: no seal (nothing is drawn — a hand-placed pin
   * should not have to defend itself), sealed, and moved. The moved state is a
   * warning rather than an error, because moving the pin is allowed and is
   * sometimes right.
   */
  function renderPinSeal() {
    if (!fPinSeal) return;
    if (!pinOrigin || !pickedLatLng) {
      fPinSeal.hidden = true;
      fPinSeal.innerHTML = "";
      return;
    }
    const who = originWho();
    const off = Math.round(originOffM());
    const acc = pinOrigin.acc ? tr("ah_seal_within").replace("{n}", pinOrigin.acc) : "";

    if (sealHolds()) {
      const line = pinOrigin.via === "gps"
        ? tr("ah_seal_gps")
        : tr(pinOrigin.via === "pm" ? "ah_seal_pm" : "ah_seal_shared").replace("{name}", who);
      fPinSeal.className = "ah-pin-seal is-held";
      fPinSeal.innerHTML =
        `<span class="ah-pin-seal-ic" aria-hidden="true">${TICK_SVG}</span>` +
        `<span class="ah-pin-seal-tx"><b>${esc(line)}</b>` +
        (acc ? `<span class="ah-pin-seal-sub">${esc(acc)}</span>` : "") +
        // A private person name is about to be published on a world-readable
        // listing. Saying so beside the name, at the moment it becomes true, is
        // the only place the agent can act on it — the person it names is not
        // in the room to be asked.
        (who ? `<span class="ah-pin-seal-sub">${esc(tr("ah_seal_public").replace("{name}", who))}</span>` : "") +
        (pinOrigin.guest
          ? `<span class="ah-pin-seal-sub is-warn">${esc(tr("ah_seal_guest"))}</span>`
          : "") +
        "</span>";
    } else {
      const line = pinOrigin.via === "gps"
        ? tr("ah_seal_moved_gps").replace("{n}", off)
        : tr("ah_seal_moved").replace("{n}", off).replace("{name}", who);
      fPinSeal.className = "ah-pin-seal is-moved";
      fPinSeal.innerHTML =
        `<span class="ah-pin-seal-ic" aria-hidden="true">${WARN_SVG}</span>` +
        `<span class="ah-pin-seal-tx"><b>${esc(line)}</b>` +
        `<span class="ah-pin-seal-sub">${esc(tr("ah_seal_moved_sub"))}</span></span>` +
        `<button type="button" class="ah-pin-seal-b" id="ahPinPutBack">${esc(tr("ah_seal_put_back"))}</button>`;
      const back = document.getElementById("ahPinPutBack");
      if (back) back.addEventListener("click", restorePin);
    }
    fPinSeal.hidden = false;
  }

  /**
   * What goes in houses.pin — the pin own account of where it came from.
   *
   * Read by js/pages/house.js so a seeker is told, in one sentence, that the
   * pin is exactly where somebody standing there put it. `origin` is kept even
   * when the agent has moved off it, so editing the listing later restores the
   * seal instead of quietly losing the fact that a person ever sent it.
   */
  function pinRecord() {
    if (!pinOrigin) {
      return { v: 1, via: "hand", exact: false,
               acc: gpsAccuracyM == null ? null : Math.round(gpsAccuracyM) };
    }
    const held = sealHolds();
    return {
      v: 1,
      via: pinOrigin.via === "pm" ? "p-message" : pinOrigin.via,
      exact: held,
      acc: pinOrigin.acc,
      at: new Date(pinOrigin.at).toISOString(),
      from_name: pinOrigin.name || null,
      from_user: pinOrigin.userId || null,
      from_guest: !!pinOrigin.guest,
      origin: { lat: pinOrigin.lat, lng: pinOrigin.lng },
      off_m: held ? 0 : Math.round(originOffM()),
    };
  }

  /** The seal a saved listing brings back with it, so an edit does not lose it. */
  function loadPinRecord(rec) {
    pinOrigin = null;
    if (!rec || typeof rec !== "object") return;
    const o = rec.origin && typeof rec.origin === "object" ? rec.origin : null;
    const lat = Number(o ? o.lat : NaN), lng = Number(o ? o.lng : NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const via = rec.via === "p-message" ? "pm" : rec.via;
    if (!SEALED_SOURCES[via]) return;
    pinOrigin = {
      lat: lat, lng: lng,
      acc: rec.acc == null ? null : (Number(rec.acc) || null),
      via: via,
      name: rec.from_name || "",
      userId: rec.from_user || "",
      guest: !!rec.from_guest,
      thread: "",
      at: rec.at ? (new Date(rec.at).getTime() || Date.now()) : Date.now(),
    };
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

  // ---- Reverse geocoding (Nominatim — resolves the pin to its WARD + a known
  //      surrounding landmark so listings are placed by real area, not a
  //      street name that's often unofficial or missing in Tanzania) --------
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
      fPinPlaceName.textContent = "Confirming the area…";
      fPinPlaceMeta.textContent = "";
      if (fPinFill) fPinFill.hidden = true;
    }
    try {
      const j = await pawaGeo.reverse(`format=jsonv2&lat=${pickedLatLng.lat}&lon=${pickedLatLng.lng}&zoom=18&addressdetails=1`);
      // If the pin moved again while we were waiting, drop this stale answer.
      if (key !== geocodeKey) return;
      const a = j.address || {};
      // Nominatim/LocationIQ only fills `road` when the street is OFFICIALLY
      // NAMED in OSM — an unnamed track never comes back here. So the presence
      // of `road` is exactly "an official street name is available online".
      const road = a.road || a.pedestrian || a.footway || a.residential || a.path || "";
      const area = a.neighbourhood || a.suburb || a.quarter || a.village
                 || a.town || a.city_district || a.hamlet || "";
      const city = a.city || a.town || a.municipality || a.county || "";
      const region = a.state || a.region || "";
      // Admin hierarchy (TZ): district = county-level, ward = suburb-level. Saved
      // on the listing so a searcher can find it by region / district / ward.
      const district = a.county || a.state_district || a.city_district || a.municipality || a.city || a.town || "";
      const ward = a.ward || a.suburb || a.quarter || a.neighbourhood || a.village || "";
      // CANONICAL AREA RULE (applies everywhere on the map): a spot is named by
      // its WARD — not by a street name, which in Tanzania is often unofficial or
      // missing online. Every place belongs to a ward, so this always resolves to
      // a real, lookup-able area. The ward is then paired with a nearby KNOWN
      // landmark (see nearestKnownPlace) so people can place it the way they
      // actually navigate ("Mikocheni, near Mlimani City").
      const areaLabel = ward || area || city || "";
      resolvedPlace = {
        road, area, region, city, district, ward, areaLabel,
        label: j.display_name || "",
        // True whenever we have a real handle on the spot (ward / area / city).
        // A nameless street still confirms via its ward.
        found: !!(ward || area || city)
      };
      renderPinPlace();
    } catch (err) {
      if (key !== geocodeKey) return;
      resolvedPlace = null;
      if (fPinPlace) {
        fPinPlace.classList.remove("is-loading");
        fPinPlaceName.textContent = "Couldn't verify the area (offline?)";
        fPinPlaceMeta.textContent = "Your pin still saves — buyers see it on the map.";
        if (fPinFill) fPinFill.hidden = true;
      }
    }
  }
  // The single nearest NAMED landmark around the pin, taken from the Overpass
  // nearby-places scan (nearbyData). This is the "known place surrounding the
  // area" used to describe a spot the way people actually navigate in Tanzania,
  // alongside the ward. Returns { name, dist } or null when the scan hasn't run
  // or found nothing named.
  function nearestKnownPlace() {
    if (!nearbyData) return null;
    let best = null;
    for (const g of Object.values(nearbyData)) {
      for (const it of g.items) {
        if (!it.name) continue;
        if (!best || it.dist < best.dist) best = it;
      }
    }
    return best;
  }
  function renderPinPlace() {
    if (!fPinPlace || !resolvedPlace) return;
    fPinPlace.classList.remove("is-loading");
    if (!resolvedPlace.found) {
      fPinPlaceName.textContent = "Area not recognised here";
      fPinPlaceMeta.textContent = "This looks like open land — double-check the pin sits on the property.";
      if (fPinFill) fPinFill.hidden = true;
      return;
    }
    // Headline = the WARD of the area (never the street name). Tanzania-wide,
    // this is how a place is reliably identified.
    fPinPlaceName.textContent = resolvedPlace.areaLabel || "Location confirmed";
    // Context = a known landmark people navigate by ("near Mlimani City") plus
    // the wider city / region. The landmark comes from the nearby-places scan,
    // which may still be loading — refreshNearby() re-renders this once it lands.
    const known = nearestKnownPlace();
    const bits = [];
    if (known && known.name) bits.push(`near ${known.name}`);
    for (const v of [resolvedPlace.city, resolvedPlace.region]) {
      if (v && v !== resolvedPlace.areaLabel) bits.push(v);
    }
    fPinPlaceMeta.textContent = bits.filter((v, i, arr) => arr.indexOf(v) === i).join(" · ");
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
    if (!rows.length) { fPinSearchResults.hidden = true; return; }
    fPinSearchResults.innerHTML = rows.map((r, i) => `
      <button type="button" class="ah-search-row" data-i="${i}">
        <strong>${esc(r.name)}</strong>${r.tag ? ` <span class="ah-search-tag">${esc(r.tag)}</span>` : ""}
        ${r.context ? `<br><small>${esc(r.context)}</small>` : ""}
      </button>
    `).join("");
    fPinSearchResults.hidden = false;
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
        fPinSearchResults.hidden = true;
      });
    });
  }
  fPinSearch?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = fPinSearch.value.trim();
    if (!q) { fPinSearchResults.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      const rows = await pinSearch(q);
      renderSearchResults(rows);
    }, 280);
  });
  fPinSearch?.addEventListener("blur", () => {
    // Delay so clicks on results land before we hide the panel.
    setTimeout(() => { fPinSearchResults.hidden = true; }, 180);
  });
  fPinSearch?.addEventListener("focus", () => {
    if (fPinSearchResults?.children.length) fPinSearchResults.hidden = false;
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
        if (fPinSearchResults) fPinSearchResults.hidden = true;
        if (fPinAiMsg) fPinAiMsg.textContent = " " + (loc.label || "Pinned") + (loc.answer ? " — " + loc.answer : "") + " (drag the pin to fine-tune)";
      } else if (fPinAiMsg) {
        fPinAiMsg.textContent = "Couldn't locate that — try a nearby landmark or place the pin manually.";
      }
    } finally { fPinAi.disabled = false; fPinAi.textContent = label0; }
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
      // The pin label borrows the nearest landmark from this scan — refresh it
      // now that we finally have one ("Mikocheni" → "Mikocheni · near …").
      if (resolvedPlace) renderPinPlace();
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
      // .ah-seg button.active carries the fill now. The three inline styles
      // that used to live here wrote the brand green and white out as
      // literals, which made this segment the one control on the page that
      // never followed the theme.
      b.classList.toggle("active", on);
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
    // `icon` used to sit beside every label and was rendered into a span. The
    // emoji it held were stripped when the no-emoji rule landed, leaving ten
    // empty strings and an empty span on every row, while the labels stayed in
    // English on a bilingual page. Both are gone: the label is a key now.
    const G = {
      schools:    { label: tr("ahn_schools"),    items: [] },
      hospitals:  { label: tr("ahn_hospitals"),  items: [] },
      pharmacies: { label: tr("ahn_pharmacies"), items: [] },
      worship:    { label: tr("ahn_worship"),    items: [] },
      markets:    { label: tr("ahn_markets"),    items: [] },
      banks:      { label: tr("ahn_banks"),      items: [] },
      transport:  { label: tr("ahn_transport"),  items: [] },
      food:       { label: tr("ahn_food"),       items: [] },
      services:   { label: tr("ahn_services"),   items: [] },
      leisure:    { label: tr("ahn_leisure"),    items: [] }
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
      fNearbyPanel.innerHTML = `<p class="ap-hint" style="margin:0">${esc(tr("ah_nearby_hint"))}</p>`;
      return;
    }
    if (!nearbyData) return; // mid-fetch — already showed loader
    const cats = Object.entries(nearbyData).filter(([, g]) => g.items.length > 0);
    if (!cats.length) {
      fNearbyPanel.innerHTML = `<p class="ap-hint" style="margin:0">${esc(tr("ah_nearby_none"))}</p>`;
      return;
    }
    // The nine inline styles this used to carry hardcoded #fff and #e6ebf0,
    // so every category card stayed a white slab on the dark portal. They are
    // .ah-nearby-cat and .ahn-* in the page stylesheet now.
    fNearbyPanel.innerHTML = cats.map(([, g]) => `
      <details class="ah-nearby-cat">
        <summary class="ahn-sum">
          <strong>${esc(g.label)}</strong>
          <span class="ahn-n">${g.items.length}</span>
        </summary>
        <ul class="ahn-list">
          ${g.items.map(it => `<li>
            <span>${esc(it.name || tr("ahn_unnamed"))}</span>
            <span class="ahn-d">${fmtDist(it.dist)}</span>
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

  // ---- Where the bathroom is ------------------------------------------------
  //
  //  Three answers that exclude each other, mapped onto the characteristic keys
  //  the catalogue has always had (js/lib/house-spec.js, FEATURE_GROUPS[0]).
  //  The KEY is what is stored and must not change; the question in front of it
  //  is language.
  //
  //  `drops` is what makes them exclusive. Choosing "inside" has to remove
  //  "shared" and "outside" from the room, or the listing carries two answers
  //  and the detail sheet picks whichever comes first, which is not an answer.
  //  toilet_inside / toilet_shared are dropped alongside their bathroom twins
  //  for the same reason: HouseSpec.bathroom() reads both.
  const BATH_CHOICES = [
    { key: "inside",  feat: "bath_inside",  k: "ah_bath_in",
      drops: ["bath_shared", "bath_outside", "toilet_shared"] },
    { key: "shared",  feat: "bath_shared",  k: "ah_bath_shared",
      drops: ["bath_inside", "bath_outside", "toilet_inside"] },
    { key: "outside", feat: "bath_outside", k: "ah_bath_out",
      drops: ["bath_inside", "bath_shared", "toilet_inside"] },
  ];

  // ---- Additional costs / bills (electricity, water, garbage…) -------------
  // Each row is a self-contained DOM node (label + amount + billing + remove);
  // we scrape the rows at save time, so there's no separate state to keep in
  // sync on every keystroke. `billing` covers the common Tanzanian cases.
  // The four ways a bill is charged. The VALUE is what is stored and must not
  // change; only the label in front of it is language.
  const COST_BILLING = [
    { value: "month",    i18n: "ah_cost_bill_month" },
    { value: "metered",  i18n: "ah_cost_bill_metered" },
    { value: "included", i18n: "ah_cost_bill_included" },
    { value: "oneoff",   i18n: "ah_cost_bill_oneoff" },
  ];
  // Six common bills as one-tap chips; the agent fills in the amounts, and the
  // "Add a cost" button below them takes anything these six do not cover.
  //
  // The chip writes the label in the language the agent is working in, because
  // it becomes their own words on their own listing. js/lib/house-ui.js reads
  // those words in both languages already, so "Umeme" gets the same icon and
  // the same treatment as "Electricity".
  const COST_PRESETS = [
    "ah_cost_p_electricity", "ah_cost_p_water", "ah_cost_p_garbage",
    "ah_cost_p_security", "ah_cost_p_internet", "ah_cost_p_service",
  ];

  function addCostRow(cost) {
    const c = cost || {};
    const row = document.createElement("div");
    row.className = "ah-cost-row";
    const billingOpts = COST_BILLING.map(b =>
      `<option value="${b.value}" ${c.billing === b.value ? "selected" : ""}>${esc(tr(b.i18n))}</option>`).join("");
    row.innerHTML = `
      <input type="text" class="ah-cost-label" maxlength="40" placeholder="${esc(tr("ah_cost_label_ph"))}"
             value="${esc(c.label || "")}">
      <input type="number" class="ah-cost-amount" min="0" step="1000" placeholder="${esc(tr("ah_cost_amount_ph"))}"
             value="${c.amount != null && c.amount !== "" ? Number(c.amount) : ""}">
      <select class="ah-cost-billing">${billingOpts}</select>
      <button type="button" class="ah-cost-x ah-x" aria-label="${esc(tr("ah_cost_remove"))}">×</button>
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
    for (const key of COST_PRESETS) {
      const name = tr(key);
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
    // The agent phone WAS standing there, so this is evidence in the same
    // sense a sent pin is — and an agent who takes a fix at the gate and
    // then nudges the marker onto the roof deserves the same sentence.
    sealPin({ lat: fix.lat, lng: fix.lng, acc: fix.accuracy ?? null, source: "gps" });
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
      // Only the settled fix is remembered — the progress readings are the
      // same place seen badly, and a book full of them is a book of one place.
      if (window.PlaceBook) {
        window.PlaceBook.add({
          lat: fix.lat, lng: fix.lng, acc: fix.accuracy ?? null,
          label: fTitle && fTitle.value.trim() ? fTitle.value.trim() : "",
          source: "gps",
        });
        if (placeDoors) placeDoors.refresh();
      }
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
    // Address = the ward + a known surrounding landmark ("Mikocheni, near
    // Mlimani City") — how places are actually found in Tanzania — not the
    // (often unofficial) street name.
    const known = nearestKnownPlace();
    const address = [resolvedPlace.areaLabel, known && known.name ? "near " + known.name : ""]
      .filter(Boolean).join(", ");
    if (address && fAddress) fAddress.value = address;
    // Area field is tagged with the ward (its searchable admin area).
    const areaFill = resolvedPlace.ward || resolvedPlace.area || "";
    if (areaFill && fArea && !fArea.value.trim()) fArea.value = areaFill;
    // Match the region <select> if the geocoded region is one of its options.
    if (resolvedPlace.region && fRegion) {
      const opt = Array.from(fRegion.options)
        .find(o => o.value.toLowerCase() === resolvedPlace.region.toLowerCase());
      if (opt) fRegion.value = opt.value;
    }
    fPinFill.textContent = " Filled";
    setTimeout(() => { fPinFill.textContent = "Use this address"; }, 1500);
  });

  // ==========================================================================
  //  THE SPEC SHEET — the open half of the form.
  //
  //  Two repeatable lists, both drawn here and both scraped at save time, in
  //  the same style as the additional-costs rows above: one pattern for every
  //  repeatable list on this form rather than three that drift apart.
  //
  //    rooms   the things that carry a price
  //    groups  every other fact, as a titled set of label→value lines
  //
  //  The rule everywhere below is SUGGEST A LOT, FORBID NOTHING. Every chip is
  //  a shortcut into a free-text box, never a constraint on it: an agent with a
  //  kind of room we have never heard of types its name and it publishes.
  // ==========================================================================
  const HS = window.HouseSpec || null;
  if (!HS) console.warn("[agent-houses] house-spec.js missing — spec sheet disabled");

  // ---- Rooms ---------------------------------------------------------------

  /** The catalogue as a <datalist>, so the free-text box offers without refusing. */
  function buildRoomKindList() {
    if (!HS || document.getElementById("ahdlRoomKinds")) return;
    const dl = document.createElement("datalist");
    dl.id = "ahdlRoomKinds";
    dl.innerHTML = HS.ROOM_KINDS.map(k => `<option value="${esc(HS.say(k))}"></option>`).join("");
    form.appendChild(dl);
  }

  /**
   * A typed label back to the key that gets stored.
   *
   * "Master room" and "Chumba cha master" both store `master`. Without this a
   * listing written on a Swahili phone would be invisible to an English filter
   * and vice versa — two catalogues of the same building.
   */
  function roomKeyFor(text) {
    const v = String(text || "").trim();
    if (!v || !HS) return "";
    const low = v.toLowerCase();
    const hit = HS.ROOM_KINDS.find(k =>
      k.key.toLowerCase() === low ||
      String(k.en || "").toLowerCase() === low ||
      String(k.sw || "").toLowerCase() === low);
    return hit ? hit.key : low.slice(0, 40);
  }

  /**
   * The eight characteristics offered without a heading above them.
   *
   * The rest of the catalogue is behind "More characteristics" on the same
   * card, and the free-text box beside these is the real answer to anything
   * neither list has heard of. Nothing is gone; only the wall is.
   */
  function topFeatureChips() {
    return HS.TOP_FEATURES.map(key => {
      const it = HS.feature(key);
      if (!it) return "";
      return `<button type="button" class="ah-fg" data-feat="${esc(key)}">+ ${esc(HS.say(it))}</button>`;
    }).join("");
  }

  /**
   * A finished room folds to one line.
   *
   * A room card is a kind, a price, a period, a count, a vacancy, five size
   * bands, eight characteristic chips, a free-text box and a fold with
   * twenty-six more chips behind it: 1,114px on a 390px screen. That is the
   * right amount of detail and the wrong amount of screen, because an agent
   * with four room types was scrolling past three finished ones to reach the
   * fourth. Four open cards were 4,456px of the thirteen-screen form.
   *
   * New rooms open, because the agent just asked for one. Rooms loaded from a
   * saved listing arrive folded, because the agent came back to change one of
   * them, not all four.
   */
  function roomSummary(node) {
    const val = (sel) => (node.querySelector(sel)?.value || "").trim();
    const kind = val(".ah-r-kind");
    const price = val(".ah-r-price");
    const count = Number(val(".ah-r-count")) || 1;
    const bits = [];
    if (kind) bits.push(kind);
    if (price !== "") bits.push("TZS " + Number(price).toLocaleString("en-US"));
    if (count > 1) bits.push(tr("aw_room_count").replace("{n}", count));
    return bits.length ? bits.join(", ") : tr("aw_room_blank");
  }

  function setRoomFold(node, shut) {
    node.dataset.awFold = shut ? "shut" : "open";
    const b = node.querySelector(".aw-fold");
    if (b) b.setAttribute("aria-expanded", shut ? "false" : "true");
    const sum = node.querySelector(".aw-roomsum");
    if (sum) sum.textContent = shut ? roomSummary(node) : "";
  }

  function addRoomRow(room) {
    if (!fRoomsList || !HS) return null;
    const r = room || {};
    const node = document.createElement("div");
    node.className = "ah-room";
    const periods = HS.PERIODS.map(p =>
      `<option value="${p.key}"${r.period === p.key ? " selected" : ""}>${esc(HS.say(p))}</option>`).join("");
    node.innerHTML = `
      <div class="ah-room-head">
        <strong>${esc(tr("ah_room_row"))}</strong>
        <span class="aw-roomsum"></span>
        <button type="button" class="aw-fold" aria-expanded="true" aria-label="${esc(tr("aw_room_fold"))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <button type="button" class="ah-x" aria-label="${esc(tr("ah_room_remove"))}">×</button>
      </div>
      <div class="ah-room-grid">
        <label class="ah-wide">${esc(tr("ah_room_kind_q"))}
          <input class="ah-r-kind" type="text" list="ahdlRoomKinds" maxlength="40"
                 placeholder="${esc(tr("ah_room_kind_ph"))}"
                 value="${esc(r.kind ? HS.roomLabel(r.kind) : "")}">
        </label>
        <label>${esc(tr("ah_room_price"))}
          <input class="ah-r-price" type="number" min="0" step="5000" placeholder="60000"
                 value="${r.price != null ? Number(r.price) : ""}">
        </label>
        <label>${esc(tr("ah_room_period"))}
          <select class="ah-r-period">${periods}</select>
        </label>
        <label>${esc(tr("ah_room_count"))}
          <input class="ah-r-count" type="number" min="1" max="99" step="1" value="${Number(r.count) || 1}">
        </label>
        <label>${esc(tr("ah_room_vacant"))}
          <input class="ah-r-vacant" type="number" min="0" max="99" step="1" placeholder="—"
                 value="${r.vacant == null ? "" : Number(r.vacant)}">
        </label>
        <div class="ah-wide ah-band">
          <span class="ah-band__q">${esc(HS.t("size_q"))}</span>
          <div class="ah-band__row" role="group">
            ${HS.SIZE_BANDS.map(b => `
              <button type="button" class="ah-band__b${r.sizeBand === b.key ? " is-on" : ""}"
                      data-band="${b.key}" aria-pressed="${r.sizeBand === b.key ? "true" : "false"}">
                <strong>${esc(HS.say(b))}</strong>
              </button>`).join("")}
          </div>
        </div>
        <!-- WHERE IS THE BATHROOM. Its own question, above the chips.
             It was already answerable down in the characteristics, as two of
             thirty-three chips carrying the same weight as "Freshly painted",
             and nothing stopped an agent ticking "inside" and "outside" at
             once. It is the fact that settles a viewing before anybody spends
             a Saturday and a daladala fare, so it is asked plainly, exactly
             once, and the three answers exclude each other.
             Nothing new is stored: these write the same feature keys. -->
        <div class="ah-wide ah-band ah-bath">
          <span class="ah-band__q">${esc(tr("ah_bath_q"))}</span>
          <div class="ah-band__row" role="group">
            ${BATH_CHOICES.map(c => `
              <button type="button" class="ah-band__b ah-bath__b" data-bath="${c.key}"
                      aria-pressed="false">
                <strong>${esc(tr(c.k))}</strong>
              </button>`).join("")}
          </div>
        </div>
        <div class="ah-wide ah-feats">
          <span class="ah-band__q ah-band__q--lead">${esc(HS.t("feats_q"))}</span>
          <ul class="ah-feats__on"></ul>
          <div class="ah-feats__chips">
            ${topFeatureChips()}
          </div>
          <div class="ah-feats__own">
            <input class="ah-r-featown" type="text" maxlength="60"
                   placeholder="${esc(HS.t("feats_add"))}">
            <button type="button" class="ah-feats__addb" aria-label="${esc(HS.t("feats_add"))}">+</button>
          </div>
          <details class="ah-more">
            <summary>
              <span>${esc(HS.t("feats_more"))}</span>
              <span class="ah-more__chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round"
                stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>
            </summary>
            <div class="ah-more__body">
              ${HS.FEATURE_GROUPS.map(g => {
                const rest = g.items.filter(it => HS.TOP_FEATURES.indexOf(it.key) < 0);
                if (!rest.length) return "";
                return `
                  <div class="ah-feats__grp">
                    <span class="ah-feats__gt">${esc(HS.say(g.title))}</span>
                    <div class="ah-feats__chips">
                      ${rest.map(it => `
                        <button type="button" class="ah-fg" data-feat="${esc(it.key)}">+ ${esc(HS.say(it))}</button>`).join("")}
                    </div>
                  </div>`;
              }).join("")}
            </div>
          </details>
        </div>
        <label class="ah-wide">${esc(tr("ah_room_note"))}
          <input class="ah-r-note" type="text" maxlength="200"
                 placeholder="${esc(tr("ah_room_note_ph"))}" value="${esc(r.note || "")}">
        </label>
      </div>`;
    node.querySelector(".ah-x").addEventListener("click", () => { node.remove(); renderRoomSuggest(); });
    node.querySelector(".ah-r-kind").addEventListener("input", renderRoomSuggest);

    // The whole head is the target, not just the chevron: it is a 44px-tall
    // bar on a phone and the chevron is 16px of it. The remove button inside
    // it has to be excluded, or deleting a room folds the one below it.
    node.querySelector(".ah-room-head").addEventListener("click", (e) => {
      if (e.target.closest(".ah-x")) return;
      setRoomFold(node, node.dataset.awFold !== "shut");
    });

    wireRoomExtras(node, r);
    // A folded card shows the kind and the price, so it has to be re-read when
    // either changes underneath it.
    node.addEventListener("input", () => {
      if (node.dataset.awFold === "shut") setRoomFold(node, true);
    });
    // One room open at a time. Adding the fourth room type used to leave the
    // three finished ones open above it, which is 4,456px of a 390px screen
    // spent on rooms the agent had already dealt with. Every other card folds
    // to its summary line; this one opens, unless it arrived with a listing
    // already in it, in which case nothing here is new and it folds too.
    for (const other of fRoomsList.querySelectorAll(".ah-room")) {
      if (other !== node) setRoomFold(other, true);
    }
    setRoomFold(node, !!(room && (r.kind || r.price != null)));
    fRoomsList.appendChild(node);
    renderRoomSuggest();
    return node;
  }

  function collectRooms() {
    if (!fRoomsList) return [];
    return Array.from(fRoomsList.querySelectorAll(".ah-room")).map(n => {
      const val = (sel) => n.querySelector(sel).value;
      const price = val(".ah-r-price"), vacant = val(".ah-r-vacant");
      const on = n.querySelector(".ah-band__b.is-on");
      return {
        kind:    roomKeyFor(val(".ah-r-kind")),
        price:   price === "" ? null : Number(price),
        period:  val(".ah-r-period"),
        count:   Number(val(".ah-r-count")) || 1,
        vacant:  vacant === "" ? null : Number(vacant),
        // The square-metre box is gone from the form, but a listing that was
        // saved with a real measurement keeps it: the number is parked on the
        // node at build time and written straight back out. Dropping it would
        // silently delete a fact on the next edit.
        size:    n.dataset.sizeSqm === "" ? null : Number(n.dataset.sizeSqm),
        sizeBand: on ? on.dataset.band : null,
        features: readFeatures(n),
        // "Own bathroom" was a checkbox sitting one line above a chip that
        // said the same thing, so the agent answered the same question twice
        // and could answer it two different ways. The chip is the answer now
        // and the boolean is read off it, which is also what the detail page
        // has always drawn from.
        ensuite: isEnsuite(n),
        // The free-text "what is this room like?" box was a second, unstructured
        // copy of the characteristics list. It is gone from the form, but a
        // listing saved with one keeps it: the text is parked on the node at
        // build time and written straight back out, the same way the old
        // square-metre figure is.
        traits:  n.dataset.traits || "",
        note:    val(".ah-r-note").trim(),
      };
    }).filter(r => r.kind || r.price != null || r.features.length || r.traits || r.note);
  }

  /**
   * A room is self-contained when it says so.
   *
   * `master` and `self_contained` mean it by definition, and both add the
   * chip when they are added, so this reads one place rather than two.
   */
  function isEnsuite(node) {
    return readFeatures(node).some(f => f === "bath_inside" || f === "toilet_inside");
  }

  // ---- the size bracket and the characteristics, per room row -------------
  // Both are stored on the row's own DOM so collectRooms() stays a pure read of
  // the form, the way every other field on it already works.

  /** Characteristics currently chosen on this row, in the order they were added. */
  function readFeatures(node) {
    return Array.from(node.querySelectorAll(".ah-feats__on li"))
      .map(li => li.dataset.feat)
      .filter(Boolean);
  }

  function drawChosenFeatures(node) {
    const chosen = readFeatures(node);
    // Grey out an offered chip once it is on the list; a typed one has no chip
    // to grey, which is fine — the list itself is the record.
    node.querySelectorAll(".ah-fg").forEach(b => {
      b.classList.toggle("is-used", chosen.indexOf(b.dataset.feat) >= 0);
    });
    // The bathroom question reads the same list, so it is repainted from the
    // one place that knows the list changed. paintBath never writes, so this
    // cannot loop back here.
    paintBath(node);
  }

  /** Remove named characteristics from a room, if they are on it. */
  function dropFeatures(node, keys) {
    const kill = new Set(keys.map(k => String(k).toLowerCase()));
    node.querySelectorAll(".ah-feats__on li").forEach(li => {
      if (kill.has(String(li.dataset.feat || "").toLowerCase())) li.remove();
    });
    drawChosenFeatures(node);
  }

  /**
   * Light the bathroom answer that the room's characteristics actually say.
   *
   * Read from the chip list rather than from a variable of its own, so the two
   * controls cannot drift: an agent who removes "Bathroom inside" from the
   * list below sees the question go back to unanswered, and one who taps the
   * chip in "More characteristics" sees the question answer itself. Two
   * controls over one fact are only safe while one of them is the record.
   */
  function paintBath(node) {
    const have = readFeatures(node).map(f => String(f).toLowerCase());
    const hit = BATH_CHOICES.find(c => have.indexOf(c.feat) >= 0);
    node.querySelectorAll(".ah-bath__b").forEach(b => {
      const on = !!hit && b.dataset.bath === hit.key;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function addFeature(node, value) {
    const v = String(value || "").trim().slice(0, 60);
    if (!v) return;
    const list = node.querySelector(".ah-feats__on");
    // Case-insensitive, so tapping a chip after typing the same words by hand
    // does not put the fact on the listing twice.
    const have = readFeatures(node).map(x => x.toLowerCase());
    if (have.indexOf(v.toLowerCase()) >= 0) return;
    const li = document.createElement("li");
    li.dataset.feat = v;
    li.innerHTML = `<span></span><button type="button" aria-label="${esc(HS.t("remove"))}">×</button>`;
    li.querySelector("span").textContent = HS.featureLabel(v);
    li.querySelector("button").addEventListener("click", () => {
      li.remove(); drawChosenFeatures(node);
    });
    list.appendChild(li);
    drawChosenFeatures(node);
  }

  function wireRoomExtras(node, r) {
    // Park the two facts that no longer have a box of their own; see
    // collectRooms(). Both survive an edit untouched rather than being
    // silently deleted by a form that stopped asking about them.
    node.dataset.sizeSqm = r && r.size != null ? String(Number(r.size)) : "";
    node.dataset.traits  = r && r.traits ? String(r.traits) : "";

    // The size bracket. `:not(.ah-bath__b)` matters: the bathroom row below
    // reuses the same visual class and would otherwise clear the size when it
    // is answered, and be cleared by it.
    node.querySelectorAll(".ah-band__b:not(.ah-bath__b)").forEach(b => {
      b.addEventListener("click", () => {
        const was = b.classList.contains("is-on");
        node.querySelectorAll(".ah-band__b:not(.ah-bath__b)").forEach(o => {
          o.classList.remove("is-on"); o.setAttribute("aria-pressed", "false");
        });
        // Tapping the chosen bracket again clears it. A bracket nobody meant to
        // set is worse than none, and there is otherwise no way back to "unsaid".
        if (!was) { b.classList.add("is-on"); b.setAttribute("aria-pressed", "true"); }
      });
    });

    // Where the bathroom is. Answering it writes ONE characteristic and removes
    // the ones that contradict it, so the room can never carry two answers.
    node.querySelectorAll(".ah-bath__b").forEach(b => {
      b.addEventListener("click", () => {
        const choice = BATH_CHOICES.find(c => c.key === b.dataset.bath);
        if (!choice) return;
        const was = b.classList.contains("is-on");
        // Tapping the chosen answer again clears it, the same way the size
        // bracket does: an agent who does not know must be able to say nothing.
        dropFeatures(node, [choice.feat].concat(choice.drops));
        if (!was) addFeature(node, choice.feat);
        paintBath(node);
      });
    });

    node.querySelectorAll(".ah-fg").forEach(b => {
      b.addEventListener("click", () => addFeature(node, b.dataset.feat));
    });
    const own = node.querySelector(".ah-r-featown");
    const addb = node.querySelector(".ah-feats__addb");
    const take = () => { addFeature(node, own.value); own.value = ""; own.focus(); };
    addb.addEventListener("click", take);
    own.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); take(); }
    });

    (Array.isArray(r && r.features) ? r.features : []).forEach(f => addFeature(node, f));
    // A listing saved before the checkbox became a chip carries `ensuite` and
    // no characteristic to match it. Restoring it as the chip keeps the fact
    // and puts it where the form now asks the question.
    if (r && r.ensuite && !isEnsuite(node)) addFeature(node, "bath_inside");
    drawChosenFeatures(node);
  }

  /**
   * One-tap chips for the kinds not already on the list.
   *
   * Seven are offered; the other twelve sit behind "More kinds" on the same
   * row. Nineteen at once read as a form to be worked through rather than a
   * shortcut, which is the opposite of what a suggestion is for.
   */
  function renderRoomSuggest() {
    if (!fRoomSuggest || !HS) return;
    const used = new Set(collectRooms().map(r => r.kind));
    // The list is rebuilt whenever a room is added or removed. An agent who
    // opened "More kinds" to reach a godown is usually about to add a second
    // one, so the fold does not slam shut behind them.
    const wasOpen = !!fRoomSuggest.querySelector("details[open]");
    fRoomSuggest.innerHTML = "";

    const chip = (k) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ah-sg";
      b.innerHTML = `+ ${esc(HS.say(k))}${k.hint ? `<small>${esc(HS.say(k.hint))}</small>` : ""}`;
      b.addEventListener("click", () => addRoomRow({
        kind: k.key,
        // A master and a self-contained room have their own bathroom by
        // definition, so the chip that says so is already on the card.
        features: (k.key === "master" || k.key === "self_contained") ? ["bath_inside"] : [],
        period: fListing && fListing.value === "sale" ? "total" : "month",
        count: 1,
      }));
      return b;
    };

    const isTop = (k) => HS.TOP_ROOM_KINDS.indexOf(k.key) >= 0;
    const free = HS.ROOM_KINDS.filter(k => !used.has(k.key));
    free.filter(isTop).forEach(k => fRoomSuggest.appendChild(chip(k)));

    const rest = free.filter(k => !isTop(k));
    if (!rest.length) return;
    const more = document.createElement("details");
    more.className = "ah-more ah-more--inline";
    more.open = wasOpen;
    more.innerHTML = `
      <summary>
        <span>${esc(HS.t("kinds_more"))}</span>
        <span class="ah-more__chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>
      </summary>
      <div class="ah-more__body ah-suggest"></div>`;
    const body = more.querySelector(".ah-more__body");
    rest.forEach(k => body.appendChild(chip(k)));
    fRoomSuggest.appendChild(more);
  }

  fAddRoomBtn?.addEventListener("click", () => addRoomRow({
    period: fListing && fListing.value === "sale" ? "total" : "month", count: 1,
  }));

  // ---- Detail groups -------------------------------------------------------

  function valueListId(groupKey, i) { return "ahdl_" + groupKey + "_" + i; }

  /** One <datalist> per suggested line, built once for the whole catalogue. */
  function buildValueLists() {
    if (!HS || document.getElementById("ahdlValues")) return;
    const holder = document.createElement("div");
    holder.id = "ahdlValues";
    holder.hidden = true;
    holder.innerHTML = HS.GROUPS.map(g => g.items.map((it, i) =>
      (it.values && it.values.length)
        ? `<datalist id="${valueListId(g.key, i)}">${
            it.values.map(v => `<option value="${esc(HS.say(v))}"></option>`).join("")}</datalist>`
        : "").join("")).join("");
    form.appendChild(holder);
  }

  /**
   * A category card.
   *
   * `presetKey` chooses the suggestions; the TITLE is an editable text box in
   * every case, including the ready-made ones. An agent who wants their rules
   * card to say "Masharti ya Mama Neema" gets to say that — the preset is a
   * starting point, never a label the app insists on.
   */
  function addGroup(presetKey, existing) {
    if (!fGroupsList || !HS) return null;
    const preset = HS.groupPreset(presetKey) || HS.groupPreset("custom");
    const node = document.createElement("div");
    node.className = "ah-group";
    node.dataset.key = preset.key;
    node.innerHTML = `
      <div class="ah-group-head">
        <span class="ah-place-ic" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
          stroke-linejoin="round"><path d="${preset.icon}"/></svg></span>
        <input class="ah-g-title" type="text" maxlength="60"
               placeholder="${esc(tr("ah_group_title_ph"))}"
               value="${esc((existing && existing.title) || HS.say(preset.title))}">
        <button type="button" class="ah-x" aria-label="${esc(tr("ah_group_remove"))}">×</button>
      </div>
      <div class="ah-suggest ah-g-suggest"></div>
      <div class="ah-kvs"></div>
      <button type="button" class="ah-btn ah-g-add" style="margin-top:9px;">${esc(tr("ah_group_add_line"))}</button>`;

    const kvs = node.querySelector(".ah-kvs");
    const sug = node.querySelector(".ah-g-suggest");

    function addKv(item, listId) {
      const row = document.createElement("div");
      row.className = "ah-kv";
      row.innerHTML = `
        <input class="ah-kv-l" type="text" maxlength="60"
               placeholder="${esc(tr("ah_kv_label_ph"))}" value="${esc((item && item.label) || "")}">
        <input class="ah-kv-v" type="text" maxlength="220"${listId ? ` list="${listId}"` : ""}
               placeholder="${esc(tr("ah_kv_value_ph"))}" value="${esc((item && item.value) || "")}">
        <button type="button" class="ah-x" aria-label="${esc(tr("ah_kv_remove"))}">×</button>`;
      row.querySelector(".ah-x").addEventListener("click", () => { row.remove(); paintSuggest(); });
      row.querySelector(".ah-kv-l").addEventListener("input", paintSuggest);
      kvs.appendChild(row);
      return row;
    }

    function paintSuggest() {
      sug.innerHTML = "";
      const used = new Set(Array.from(kvs.querySelectorAll(".ah-kv-l"))
        .map(i => i.value.trim().toLowerCase()).filter(Boolean));
      preset.items.forEach((it, i) => {
        const label = HS.say(it.label);
        if (used.has(label.toLowerCase())) return;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ah-sg";
        b.textContent = "+ " + label;
        b.addEventListener("click", () => {
          // The first suggested answer is filled in, not forced: it is the
          // right one often enough to save typing and always editable when it
          // is not. An empty box would make every chip a two-step.
          const first = it.values && it.values.length ? HS.say(it.values[0]) : "";
          addKv({ label: label, value: first },
                it.values && it.values.length ? valueListId(preset.key, i) : "");
          paintSuggest();
        });
        sug.appendChild(b);
      });
    }

    node.querySelector(".ah-x").addEventListener("click", () => { node.remove(); renderGroupSuggest(); });
    node.querySelector(".ah-g-add").addEventListener("click", () => { addKv({}, ""); paintSuggest(); });

    fGroupsList.appendChild(node);

    // Restoring a saved card: its lines come back as typed, and a line whose
    // label happens to match a suggestion re-uses that suggestion's answers.
    if (existing && Array.isArray(existing.items) && existing.items.length) {
      existing.items.forEach(it => {
        const i = preset.items.findIndex(p =>
          HS.say(p.label).toLowerCase() === String(it.label || "").toLowerCase());
        addKv(it, i >= 0 && preset.items[i].values && preset.items[i].values.length
          ? valueListId(preset.key, i) : "");
      });
    } else if (!existing && preset.key === "custom") {
      addKv({}, "");   // a card the agent named needs somewhere to type
    }
    paintSuggest();
    return node;
  }

  function collectGroups() {
    if (!fGroupsList) return [];
    return Array.from(fGroupsList.querySelectorAll(".ah-group")).map(n => ({
      key:   n.dataset.key || "custom",
      title: n.querySelector(".ah-g-title").value.trim(),
      items: Array.from(n.querySelectorAll(".ah-kv")).map(r => ({
        label: r.querySelector(".ah-kv-l").value.trim(),
        value: r.querySelector(".ah-kv-v").value.trim(),
      })).filter(it => it.label && it.value),
    })).filter(g => g.title && g.items.length);
  }

  function renderGroupSuggest() {
    if (!fGroupSuggest || !HS) return;
    const used = new Set(Array.from(fGroupsList.querySelectorAll(".ah-group"))
      .map(n => n.dataset.key));
    fGroupSuggest.innerHTML = "";
    HS.GROUPS.forEach(g => {
      // "Anything else" never disappears — an agent may want four of them.
      if (g.key !== "custom" && used.has(g.key)) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ah-sg";
      b.textContent = "+ " + HS.say(g.title);
      b.addEventListener("click", () => { addGroup(g.key); renderGroupSuggest(); });
      fGroupSuggest.appendChild(b);
    });
  }

  /** Everything the two lists know, cleaned by the one normaliser. */
  function collectDetails() {
    const raw = { v: 1, rooms: collectRooms(), groups: collectGroups() };
    return HS ? HS.normalize(raw) : raw;
  }

  function resetSpec() {
    if (fRoomsList)  fRoomsList.innerHTML = "";
    if (fGroupsList) fGroupsList.innerHTML = "";
    renderRoomSuggest();
    renderGroupSuggest();
  }

  function loadSpec(row) {
    if (!HS) return;
    const d = HS.fromRow(row);
    d.rooms.forEach(addRoomRow);
    d.groups.forEach(g => addGroup(g.key, g));
    renderRoomSuggest();
    renderGroupSuggest();
  }

  buildRoomKindList();
  buildValueLists();

  // ==========================================================================
  //  PINNING FROM A LOCATION SOMEBODY ALREADY SHARED
  //
  //  The pin had three sources and all three needed the agent: drag it, stand
  //  on it, or send a link and wait by the screen. But the location of a house
  //  usually already exists — somebody stood at that gate and shared it, as
  //  nine characters down a phone call or a map link in a P-Message thread.
  //
  //  Three doors, one destination, and they are js/lib/place-doors.js — the
  //  same module agent-services and agent-trucks mount. This page used to keep
  //  its own copy of all three: about 330 lines of JavaScript, 90 of markup and
  //  31 of CSS, with `ah-` spellings of the same classes and the same i18n keys
  //  read twice. The algorithms were identical, including the meet-room code
  //  generator and the poll behind the realtime socket.
  //
  //  WHAT KEPT THE FORK ALIVE was that this page's pin does more than move: it
  //  is SEALED to what arrived (sealPin) and it draws an accuracy circle, which
  //  a service or a truck has no equivalent of. That is what onPick is for, and
  //  it is the only reason a callback was needed rather than a plain swap.
  //
  //  The module owns the book (js/lib/place-book.js) and redraws it itself, so
  //  onPick must NOT file the place a second time.
  // ==========================================================================

  /**
   * The one place a chosen location becomes the pin.
   *
   * A code, a paste, a pin out of a conversation and somebody standing at the
   * gate all end here, so "the pin moved" means exactly one thing however it
   * happened — and the seal, the accuracy circle, the marker and the readout
   * all follow from a single call site instead of four that each forget a
   * different one.
   */
  function usePlace(place) {
    const lat = Number(place.lat), lng = Number(place.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    pickedLatLng = { lat, lng };
    gpsAccuracyM = place.acc == null ? null : Number(place.acc);
    // Before the readout, because the readout is where the seal is drawn.
    sealPin(place);
    drawAccuracyCircle(gpsAccuracyM);
    if (pinMarker) pinMarker.setLngLat([lng, lat]);
    if (pinMap) pinMap.easeTo({ center: [lng, lat], zoom: 17, duration: 600 });
    updatePinReadout();
  }

  // Mounted once. The map is this page's own (MapLibre here, Leaflet on the
  // other two), which is exactly why the module owns no map and hands the
  // place back instead.
  const placeDoors = window.PlaceDoors && document.getElementById("ahLocDoors")
    ? window.PlaceDoors.mount({
        into: document.getElementById("ahLocDoors"),
        sb: sb,
        purpose: "house_pin",
        title: () => (fTitle && fTitle.value.trim()) || "",
        current: () => pickedLatLng,
        onPick: usePlace,
      })
    : null;

  // ---- Save listing (create or update) ------------------------------------
  /**
   * Say something, where the agent is looking.
   *
   * #ahFormMsg is the last thing in the form, and the board moved the action
   * bar off the end of the form and onto itself — so a message written here
   * landed under eight collapsed panels, behind the fixed tab bar, on a
   * scroll position nobody was at. Centring it is what makes it a message
   * rather than a paragraph.
   *
   * `focus` is passed for the field that caused it, because on a phone the
   * keyboard opening on the right box says more than any sentence.
   */
  function sayInForm(text, kind, focus) {
    formMsg.className = "ah-msg " + (kind || "error");
    formMsg.textContent = text;
    formMsg.hidden = false;
    if (focus) { try { focus.focus({ preventScroll: true }); } catch (_) { focus.focus(); } }
    try { formMsg.scrollIntoView({ behavior: "smooth", block: "center" }); }
    catch (_) { formMsg.scrollIntoView(); }
  }

  /**
   * The first answer the form is still missing, and where it lives.
   *
   * The browser used to do this, and it did it invisibly: the listing title is
   * `required` and sits in part 2, the board takes all eight parts out of the
   * layout, and Chrome will not show a validation bubble on a control it
   * cannot focus. So it blocked the submit, logged a line to a console no
   * agent has open, and the Save button looked broken. The form is `novalidate`
   * now and this runs instead.
   *
   * A control the PAGE has hidden is skipped: the minimum-months row and the
   * "specify the kind" box are hidden when they do not apply, and neither is
   * an answer anybody owes.
   *
   * That skip is scoped to hidden ancestors INSIDE the form, and it has to be.
   * A bare closest("[hidden]") is the wrong question, for the reason
   * agent-workspace.js spells out beside hiddenInPanel(): #ahFormSection is
   * itself hidden until the agent opens the form, so every control on the page
   * answers yes to it and this returns null for a form with nothing filled in
   * at all. Only a hidden ancestor between the control and the form says
   * anything about that control.
   */
  function firstMissing() {
    const controls = form.querySelectorAll("input, select, textarea");
    for (const c of controls) {
      if (!c.willValidate || c.disabled || c.type === "hidden") continue;
      const box = c.closest("[hidden]");
      if (box && form.contains(box)) continue;
      if (!c.checkValidity()) return c;
    }
    return null;
  }

  /** The name of the part a control lives in, as the panel's own heading says it. */
  function partName(el) {
    const panel = el && el.closest(".ap-panel");
    const h = panel && panel.querySelector(".ap-panel__tx h3");
    return h ? h.textContent.trim() : "";
  }

  /**
   * Put the agent in front of the problem.
   *
   * Opening the step is the useful half. The board hides every part, so a
   * message naming one is a message about somewhere the reader cannot see;
   * with the step open the field is on screen with the cursor already in it.
   */
  function stopAt(el, text) {
    if (el && formWs && formWs.reveal) formWs.reveal(el);
    sayInForm(text, "error", el);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formMsg.hidden = true;

    // Required fields first, because this is the one that silently did nothing.
    const missing = firstMissing();
    if (missing) {
      // An EMPTY required field gets the part's own name, because "The basics
      // still needs an answer" is something a person can act on from a board
      // of eight tiles. Anything else -- a number typed as words, a date that
      // is not one -- gets the browser's own sentence, which already says what
      // is wrong with the value and says it in the reader's language.
      const part = partName(missing);
      stopAt(missing, (missing.validity.valueMissing && part)
        ? trf("ah_err_missing", "{part} still needs an answer.").replace("{part}", part)
        : (missing.validationMessage || tr("ah_msg_save_fail")));
      return;
    }

    if (!pickedLatLng) {
      stopAt(fArea || document.getElementById("ahSecWhere"), tr("ah_err_no_pin"));
      return;
    }
    // The overall price stopped being compulsory the moment a listing could
    // price its rooms individually — but SOME price has to exist, or the card
    // says nothing a person can decide on. One or the other, never neither.
    if (!(Number(fPrice.value) > 0) && !(HS && HS.priceFrom({ details: { rooms: collectRooms() } }))) {
      stopAt(fPrice, tr("ah_err_no_price"));
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

      // 3. Build row.
      //
      // The spec sheet is the listing's own account of itself; the flat
      // columns below are the projection of it that search and the old cards
      // still read. Deriving them here — rather than asking the agent to type
      // the same number twice — is what keeps the two from disagreeing.
      const details   = collectDetails();
      const roomFloor = HS ? HS.priceFrom({ details }) : null;
      const typedPrice = Number(fPrice.value) || 0;
      const id = editingId || generateId();
      const row = {
        id,
        title:       fTitle.value.trim(),
        // "Other" stores whatever kind the provider typed (falls back to "other").
        type:        fType.value === "other"
                       ? ((fTypeOther && fTypeOther.value.trim().toLowerCase()) || "other")
                       : fType.value,
        listing:     fListing.value,
        // The headline price. An agent who lists four room types and no
        // overall figure is not leaving the price blank — they are saying
        // "from the cheapest of these", so that is what the column holds.
        price_tzs:   typedPrice || (roomFloor ? roomFloor.amount : 0),
        currency:    "TZS",
        period:      typedPrice ? fPeriod.value : (roomFloor ? roomFloor.period : fPeriod.value),
        // The whole spec sheet, exactly as the agent wrote it.
        details,
        // Minimum months a tenant must pay upfront — rent only (null for sale).
        min_months:  fListing.value === "rent" ? (Math.max(1, Number(fMinMonths?.value) || 1)) : null,
        // Agent commission the tenant pays — rent only. 0/blank → the house
        // detail + dashboard default it to one month's rent.
        agent_fee_tzs: fListing.value === "rent" ? (Number(fAgentFee?.value) || 0) : 0,
        // Room category for room-by-room rentals: single vs master
        // (self-contained); null means the whole unit is listed.
        //
        // One column, and the spec sheet can hold twenty rooms — so it carries
        // the CHEAPEST room's category, which is the one a "show me singles
        // under 80,000" filter is asking about. A plot whose cheapest room is
        // a single belongs in that result even though it also has a master.
        room_kind:   (roomFloor && (roomFloor.kind === "single" || roomFloor.kind === "master"))
                       ? roomFloor.kind
                       : ((fRoomKind && fRoomKind.value) || null),
        // Explicit "this is a business space (frame)" flag — drives the Frame map.
        is_frame:    !!(fIsFrame && fIsFrame.checked),
        bedrooms:    Number(fBedrooms.value) || 0,
        bathrooms:   Number(fBathrooms.value) || 0,
        size_sqm:    fSize.value ? Number(fSize.value) : null,
        // Fall back to the agent's declared region / operating area so a listing
        // always carries the area its agent works in (searchers find it there).
        region:      fRegion.value || agentProfile?.region || null,
        area:        fArea.value.trim() || agentProfile?.area_of_operations || null,
        // Auto admin classification from the pin (region/district/ward search).
        district:    (resolvedPlace && resolvedPlace.district) || agentProfile?.district || null,
        ward:        (resolvedPlace && resolvedPlace.ward) || agentProfile?.ward || null,
        address:     fAddress.value.trim() || null,
        lat:         pickedLatLng.lat,
        lng:         pickedLatLng.lng,
        // Where the pin came from, and whether it is still standing exactly
        // there. See pinRecord() and supabase/features/house/houses_pin.sql.
        pin:         pinRecord(),
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
      // An edit that has lost its id is not a new listing. See openForm().
      if (openedForEdit && !editingId) {
        sayInForm(trf("ah_edit_lost",
          "This listing lost track of which one it was editing. Close the form and open it again from the list. Saving now would post a second listing."),
          "error");
        return;
      }

      const trySave = async (payload) => editingId
        ? sb.from("houses").update(payload).eq("id", editingId).eq("owner_user_id", uid).select()
        : sb.from("houses").insert(payload).select();
      let { data: savedRows, error } = await trySave(row);
      // A database that has not had the newer feature SQL run against it yet.
      // Both wordings are needed and only one of them was here: Postgres says
      // `column "pin" of relation "houses" does not exist`, while PostgREST
      // usually answers first with PGRST204 — `Could not find the 'pin' column
      // of 'houses' in the schema cache` — which the old pattern could not
      // match, and which then fell through to the branch below and replaced
      // the whole form with the setup card. An agent halfway through a listing
      // does not need a wall of SQL; they need the listing saved without the
      // column their database has not got yet.
      const OPTIONAL_COLS = /(photos|videos|nearby|extra_costs|min_months|room_kind|agent_fee_tzs|is_frame|details|pin)/i;
      const missingColumn = (m) =>
        OPTIONAL_COLS.test(m) &&
        (/column .* (does not exist|not found)/i.test(m) ||
         /could not find the .* column/i.test(m));
      if (error && missingColumn(error.message || "")) {
        const { photos: _p, videos: _v, nearby: _n, extra_costs: _e, min_months: _m, room_kind: _rk, agent_fee_tzs: _af, is_frame: _if, details: _d, pin: _pin, ...legacy } = row;
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

      sayInForm(editingId ? tr("ah_msg_saved_edit") : tr("ah_msg_saved_new"), "success");
      // One of the three posts has just been spent, so the panel and the New
      // listing button have to say so before the owner reaches for either.
      refreshOwnerQuota();

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
      // Only hold the form open if the panel can actually be drawn. Without
      // js/lib/demand-rows.js there are no rows and no Done button, so keeping
      // it open would strand the agent on a form they have already saved.
      const waiting = await notifyWaitingRenters(saved || row).catch(() => []);
      if (waiting.length && window.DemandRows) {
        renderWaitingPanel(waiting, saved || row);
        return;   // keep the form open so the agent can call them; "Done" closes it
      }

      setTimeout(() => {
        closeForm();
        loadMyListings();
      }, 700);
    } catch (err) {
      console.warn("save listing", err);
      sayInForm(err.message || tr("ah_msg_save_fail"), "error");
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
      p_bedrooms: Number(listing.bedrooms) || 0,
      // The listing's OWN ward and district, so a request whose point is a
      // stand-in can still be matched by the name the seeker could state
      // exactly. Without these two the named arm of house_demand_near cannot
      // fire at all and every unmappable request stays invisible.
      // See supabase/features/house/house_demand_place.sql.
      p_ward: listing.ward || (agentProfile && agentProfile.ward) || null,
      p_district: listing.district || (agentProfile && agentProfile.district) || null,
      // The whole set, not just the primary. An agent covering three wards was
      // reachable in one of them until agent_multi_area.sql.
      p_wards: (agentProfile && agentProfile.wards) || null,
      p_districts: (agentProfile && agentProfile.districts) || null
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

  /**
   * Everyone waiting here, the instant a listing saves.
   *
   * This panel owns the MOMENT, not the row. It appears over the form the agent
   * has just submitted and is scoped to that listing's own area, which is why
   * it keeps its own heading, sub-line and Done button.
   *
   * What a request LOOKS like belongs to js/lib/demand-rows.js, and handing
   * that back is the point. This function used to parse the phone number
   * itself, build its own Call and WhatsApp buttons, and colour its own
   * deadline chip on thresholds of 3 and 14 days while the board six inches
   * below it used 7 and 30. The same date read "urgent" in one panel and
   * "soon" in the other, on one screen, at one moment.
   */
  function renderWaitingPanel(rows, listing) {
    const DR = window.DemandRows;
    ensureWaitStyles();
    let panel = document.getElementById("ahWaitingPanel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "ahWaitingPanel";
      formSection.appendChild(panel);
    }
    const area = listing.area || tr("ahw_your_area");
    // house_demand_near answers about THIS listing, so a request that never
    // stated its own kind or type is read as asking for what was just posted.
    // The spec chips are drawn from the row, so that defaulting happens here
    // rather than inside the shared renderer, which knows nothing about forms.
    const items = DR.html(rows.map((r) => Object.assign({}, r, {
      listing: r.listing || listing.listing,
      type: r.type || listing.type,
    })));
    const wHead = (rows.length === 1 ? tr("ahw_near_head_one") : tr("ahw_near_head_many"))
      .replace("{n}", rows.length).replace("{where}", esc(area));
    panel.innerHTML = `
      <div class="ah-wait-card">
        <div class="ah-wait-head">${wHead}</div>
        <div class="ah-wait-sub">${tr("ahw_pin_sub").replace("{what}", listing.listing === "sale" ? tr("ahw_what_buy") : tr("ahw_what_rent"))}</div>
        ${items}
        <button type="button" id="ahWaitDone" class="ah-wait-done">${tr("ahw_done")}</button>
      </div>`;
    panel.scrollIntoView({ behavior: "smooth", block: "center" });
    document.getElementById("ahWaitDone")?.addEventListener("click", () => {
      panel.remove();
      closeForm();
      loadMyListings();
    });
  }

  // The card AROUND the waiting rows, styled once and injected on first use.
  // The rows themselves are .dm-* from css/notify.css, which this page links,
  // so what is left here is a heading, a sub-line and a Done button. It used to
  // be twenty-six literal hex values, all of them light: a mint card with
  // dark-green ink, dropped onto a portal that is dark by default. It reads on
  // both themes now because every value is a token, and the tokens are what the
  // theme switch moves.
  function ensureWaitStyles() {
    if (document.getElementById("ahWaitStyles")) return;
    const s = document.createElement("style");
    s.id = "ahWaitStyles";
    s.textContent = `
      #ahWaitingPanel{margin-top:var(--space-4)}
      .ah-wait-card{background:var(--c-brand-faint);border:1px solid var(--c-brand-soft);
        border-radius:var(--radius-lg);padding:var(--space-4) var(--space-5)}
      .ah-wait-head{font-weight:var(--fw-bold);font-size:var(--text-md);color:var(--c-brand);margin-bottom:2px}
      .ah-wait-sub{font-size:var(--text-sm);color:var(--c-text-soft);margin-bottom:var(--space-3);
        line-height:var(--lh-normal)}
      .ah-wait-done{margin-top:var(--space-3);width:100%;min-height:var(--hit-min);padding:var(--space-3);
        border:0;border-radius:var(--radius);background:var(--c-brand);color:var(--c-brand-on);
        font:inherit;font-weight:var(--fw-semibold);font-size:var(--text-sm);cursor:pointer}`;
    document.head.appendChild(s);
  }

  // ---- Proactive demand board: "renters waiting near you" -----------------
  // Don't wait for the agent to post first — surface the people ALREADY waiting
  // in their operating area, most-urgent deadline first, so they can line up a
  // deal (or re-fill a unit before its rent expires) and call before the seeker's
  // move-in date. Reuses house_demand_near at the agent's centre with a wide ring.
  async function loadWaitingNearMe() {
    if (!sb) return;
    const center = await agentCenter();
    const region = (agentProfile && agentProfile.region) || (center && center.label) || null;
    if (!center && !region) { const ex = document.getElementById("ahDemandBoard"); if (ex) ex.remove(); return; }

    // (a) Renters waiting NEAR the agent's centre (point + 12 km ring).
    let rows = [];
    if (center) {
      try {
        const calls = await Promise.all(["rent", "sale"].map((listing) =>
          sb.rpc("house_demand_near", {
            p_lat: center.lat, p_lng: center.lng, p_radius_m: 12000,
            p_listing: listing, p_type: null, p_price: 0, p_bedrooms: 0,
            // Same reason as notifyWaitingRenters: the agent's own ward is
            // what reaches a seeker who could name theirs but not pin it.
            p_ward: (agentProfile && agentProfile.ward) || null,
            p_district: (agentProfile && agentProfile.district) || null,
            p_wards: (agentProfile && agentProfile.wards) || null,
            p_districts: (agentProfile && agentProfile.districts) || null,
          }).then((r) => Array.isArray(r.data) ? r.data.map((x) => ({ ...x, listing })) : [])
            .catch(() => [])));
        const seen = new Set();
        rows = calls.flat().filter((r) => r && r.id && !seen.has(r.id) && seen.add(r.id));
      } catch (_) { rows = []; }
    }

    // (b) Everyone waiting anywhere in the agent's REGION (typed requests + map
    // alerts tagged with this region), so a request from across the region shows
    // too — not only within the 12 km ring. Region rows carry no distance.
    const regionRows = await loadRegionDemand(region);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of regionRows) if (!byId.has(r.id)) byId.set(r.id, r);
    rows = [...byId.values()];
    if (!rows.length) { const ex = document.getElementById("ahDemandBoard"); if (ex) ex.remove(); return; }

    // Own district, then soonest needed_by, then nearest. The first two tiers
    // are not decided here: DemandRows.sort owns them, so a request cannot rank
    // one way on this board and another in the bell. Array.sort is stable, so
    // sorting by distance first survives as the tie-break inside each tier,
    // which is the one thing this board knows that the bell does not.
    rows.sort((a, b) => (a.distance_m ?? 1e9) - (b.distance_m ?? 1e9));
    rows = window.DemandRows ? window.DemandRows.sort(rows) : rows;
    const offer = await getAgentOffer();
    renderDemandBoard(rows, center || { label: region }, offer);
  }

  // The matching algorithm, run in Postgres: every active, non-expired request
  // in the agent's REGION, with their own DISTRICT ranked first (match_level).
  //
  // Delegated, like the row. js/lib/demand-rows.js owns the pair of RPCs and
  // the fallback between them, so a deployment that has not run
  // house_demand_for_agent.sql degrades the same way on all three portals and
  // in the bell. This page held a third copy of it, differing only in asking
  // for 200 rows instead of 100.
  async function loadRegionDemand(region) {
    if (!sb || !region || !window.DemandRows) return [];
    return window.DemandRows.fetch({
      sb,
      region,
      district: (agentProfile && agentProfile.district) || null,
      limit: 200,
    });
  }

  // Where the agent operates: their declared profile point, else the average of
  // their own listings' coordinates, else the centre of their declared region.
  async function agentCenter() {
    const p = agentProfile;
    if (p && Number.isFinite(+p.lat) && Number.isFinite(+p.lng))
      return { lat: +p.lat, lng: +p.lng, label: p.area_of_operations || p.region };
    try {
      const { data: { session } } = await sb.auth.getSession();
      const uid = session?.user?.id;
      if (uid) {
        const { data } = await sb.from("houses").select("lat,lng").eq("owner_user_id", uid);
        const pts = (data || []).filter((h) => Number.isFinite(+h.lat) && Number.isFinite(+h.lng));
        if (pts.length) {
          return {
            lat: pts.reduce((s, h) => s + +h.lat, 0) / pts.length,
            lng: pts.reduce((s, h) => s + +h.lng, 0) / pts.length,
            label: (p && (p.area_of_operations || p.region)) || "your area",
          };
        }
      }
    } catch (_) {}
    if (p && p.region && window.resolveTzPlace) {
      const r = window.resolveTzPlace(p.region);
      if (r) return { lat: r.lat, lng: r.lng, label: p.region };
    }
    return null;
  }

  // The agent's "offer envelope" — derived from their own live listings, so we
  // can tell which waiting seekers they can actually serve. Memoised per page
  // load; resolves to false when the agent has no listings yet (→ no fit
  // judgement, every lead shown plainly).
  let agentOffer;
  async function getAgentOffer() {
    if (agentOffer !== undefined) return agentOffer;
    agentOffer = false;
    try {
      const { data: { session } } = await sb.auth.getSession();
      const uid = session?.user?.id;
      if (!uid) return agentOffer;
      const { data } = await sb.from("houses").select("price_tzs,listing,available").eq("owner_user_id", uid);
      const live = (data || []).filter((h) => h.available !== false);
      if (!live.length) return agentOffer;
      const prices = live.map((h) => Number(h.price_tzs) || 0).filter((p) => p > 0);
      agentOffer = {
        floor: prices.length ? Math.min(...prices) : 0,
        kinds: new Set(live.map((h) => h.listing || "rent")),
        count: live.length,
      };
    } catch (_) { agentOffer = false; }
    return agentOffer;
  }

  // Does this waiting seeker fit what the agent actually offers? Returns null
  // when it fits (or we can't tell — no listings yet), else a short reason. This
  // is what stops "wrong" calls: the two unambiguous mismatches are a seeker
  // whose ceiling is below the agent's cheapest unit, and a seeker after the
  // opposite kind (buy vs rent) to anything the agent lists. Advisory only — the
  // lead is dimmed and sorted last, never hidden (the agent may get new stock).
  function assessFit(r, offer) {
    if (!offer) return null;
    if (offer.kinds.size && r.listing && !offer.kinds.has(r.listing))
      return r.listing === "sale" ? tr("ahw_fit_buy_rent") : tr("ahw_fit_rent_sale");
    if (offer.floor > 0 && Number(r.max_budget_tzs) > 0 && offer.floor > Number(r.max_budget_tzs))
      return tr("ahw_fit_under").replace("{p}", fmtTzs(offer.floor));
    return null;
  }

  /**
   * The dashboard board: everyone waiting in this agent's area.
   *
   * The ROW is not drawn here. js/lib/demand-rows.js draws it, and the
   * notification panel and the other two portals draw the same one, so a
   * request cannot look or sort one way on a dashboard and another in the
   * bell. This page keeps the two things that are genuinely its own: a centre
   * with a 12 km ring around it, and assessFit(), which dims a lead this agent
   * cannot serve.
   */
  function renderDemandBoard(rows, center, offer) {
    let panel = document.getElementById("ahDemandBoard");
    if (!rows.length || !window.DemandRows) { if (panel) panel.remove(); return; }
    const DR = window.DemandRows;
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "ahDemandBoard";
      panel.className = "dm-board";
      if (listEl && listEl.parentNode) listEl.parentNode.insertBefore(panel, listEl);
      else dashboard.appendChild(panel);
    }
    // Callable-fit leads first, "may not fit" last (stable, so urgency order
    // survives within each group), and the agent's effort goes where a call
    // can land.
    const reasons = new Map(rows.map((r) => [r, assessFit(r, offer)]));
    const ordered = rows.slice().sort((a, b) =>
      (reasons.get(a) ? 1 : 0) - (reasons.get(b) ? 1 : 0));
    const shown = Math.min(12, ordered.length);
    const urgent = DR.urgentCount(ordered.slice(0, shown));
    const fits = ordered.filter((r) => !reasons.get(r)).length;
    const fitNote = offer ? `<b>${tr("ahw_fit_note").replace("{n}", fits)}</b> ` : "";
    const head = (rows.length === 1 ? tr("ahw_near_head_one") : tr("ahw_near_head_many"))
      .replace("{n}", rows.length)
      .replace("{where}", esc(center.label || tr("ahw_your_area")));

    panel.innerHTML = `
      <div class="dm-board__head">
        <h3 class="dm-board__h">${head}</h3>
        <button type="button" class="dm-board__x" id="ahBoardClose" aria-label="${esc(tr("adb_hide"))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
               stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <p class="dm-board__sub">${urgent ? `<b>${tr("ahw_urgent_week").replace("{n}", urgent)}</b> ` : ""}${fitNote}${tr("ahw_check_chips")}</p>
      ${DR.html(ordered, {
        limit: 12,
        noteOf: (r) => reasons.get(r) || "",
        noteTitle: tr("ahw_misfit_title"),
      })}`;
    document.getElementById("ahBoardClose")?.addEventListener("click", () => panel.remove());
  }

  // ---- Video gateway (services/python) -------------------------------------
  // Two jobs, one round trip, on the way to storage:
  //   · faststart — phone/Windows recorders put the MP4 `moov` index at the END
  //     of the file, so the clip stutters until the whole thing downloads. The
  //     gateway remuxes it to the front, losslessly.
  //   · trim — anything over MAX_VIDEO_S is cut to fit. This is why an
  //     over-length clip is now a warning at pick time instead of a refusal:
  //     the agent is not sent away to find a video editor.
  //
  // /faststart is the original endpoint name and still does both. If the service
  // is unset/asleep/unreachable we just upload the original — the listing never
  // fails to save over a video-optimisation step. The one consequence is that a
  // long clip uploaded while the gateway is down stays long.
  function _videoGatewayBase() {
    const cfg = (window.APP_CONFIG && window.APP_CONFIG.VIDEO_GATEWAY_URL) || "";
    if (cfg) return cfg.replace(/\/+$/, "");
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "") return "http://127.0.0.1:8094";
    return "";
  }

  // Wake a sleeping free-tier gateway when the form opens, so it's warm by the
  // time the agent finishes filling in the listing and hits save. Fire-and-forget.
  // The flag itself is declared with the rest of the state at the top of this
  // function; see there for why it cannot live here.
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
        // Trust the returned BYTES, not the X-Faststart header. That custom
        // header is hidden by CORS on the cross-origin response (github.io →
        // onrender) unless the server adds Access-Control-Expose-Headers, so it
        // read back as null and we used to discard the remuxed clip and upload
        // the stuttering original. Content-Type IS CORS-safelisted, so blob.type
        // is always readable: the server stamps "video/mp4" when it remuxed and
        // echoes the original type on passthrough. Rename .mov/.webm → .mp4 only
        // when the bytes actually became MP4.
        const becameMp4 = (blob.type || "").includes("mp4") &&
                          !(file.type || "").includes("mp4");
        const name = becameMp4
          ? (file.name || "video").replace(/\.[^.]+$/, "") + ".mp4"
          : (file.name || "video.mp4");
        return new File([blob], name, { type: blob.type || file.type || "video/mp4" });
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
    // clear(), not innerHTML = "". #ahWarn is the strip's host now, and wiping
    // it would detach the card and its live region while the handle cached on
    // the element still claimed to own them.
    strip ? strip.clear() : (warnEl.innerHTML = "");
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

  // Mark a SALE listing sold (off-market) — or re-list it. A house is
  // non-permanent: once the deal is closed the agent marks it sold so it
  // vanishes from buyers and no one enquires about a property that's gone
  // (avoids double-booking / "doubledash"). Reversible.
  async function markSold(house) {
    if (!sb || !house || !house.id) return;
    const goingOff = house.available !== false;
    const msg = goingOff
      ? `Mark "${house.title}" as SOLD?\n\nIt's removed from the public listings immediately, so no buyer enquires about a property that's already gone (prevents double-booking).`
      : `Re-list "${house.title}"?\n\nIt becomes visible to buyers again.`;
    if (!confirm(msg)) return;
    try {
      const { error } = await sb.from("houses")
        .update({ available: !goingOff, updated_at: new Date().toISOString() })
        .eq("id", house.id);
      if (error) throw error;
      house.available = !goingOff;
      window.DataStore?.invalidateCache?.(["houses"]);
      await loadMyListings();
    } catch (e) {
      alert("Couldn't update the listing: " + ((e && e.message) || e));
    }
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

  // ---- The page is now assembled -----------------------------------------
  // Everything above has been evaluated, so openForm() can reach all of it.
  // This must stay the last statement in this function: moving it up would
  // re-open exactly the window it exists to close.
  pageReady = true;
  if (queuedForm) {
    const q = queuedForm;
    queuedForm = null;
    requestForm(q.row);
  }
};
