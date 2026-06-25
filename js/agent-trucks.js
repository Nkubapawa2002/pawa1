// Register a moving truck — owner-authenticated CRUD over public.trucks, the
// truck companion to agent-houses.js. Sign in, then add trucks with photos and
// a base-location pin; users browse them on trucks.html and find the nearest.
//
// Mirrors agent-houses.js: Supabase email auth, owner_user_id = auth.uid()
// inserts (RLS-enforced), photo upload into the `truck-photos` bucket, and a
// setup card with the SQL when the `trucks` table hasn't been applied yet.

window.initAgentTrucksPage = async () => {
  const sb = window.DataStore?.sb;

  // The exact SQL from supabase/trucks.sql — shown in the setup card so the
  // owner can create the table + bucket without leaving the page.
  const SETUP_SQL = `-- Pawa Moving Trucks — public.trucks table + truck-photos storage bucket.
create table if not exists public.trucks (
  id                text primary key,
  title             text not null,
  truck_type        text not null default 'canter'
                      check (truck_type in ('pickup','canter','3ton','7ton','10ton_plus','other')),
  capacity_tonnes   numeric check (capacity_tonnes is null or capacity_tonnes >= 0),
  price_tzs         bigint not null default 0 check (price_tzs >= 0),
  currency          text not null default 'TZS',
  period            text not null default 'trip',
  negotiable        boolean not null default true,
  driver_included   boolean not null default true,
  loaders_included  boolean not null default false,
  service_area      text not null default 'within_city'
                      check (service_area in ('within_city','region_wide','cross_region')),
  region            text references public.regions(name) on update cascade,
  area              text,
  address           text,
  lat               double precision,
  lng               double precision,
  photo             text,
  photos            text[] not null default '{}'::text[],
  description       text,
  verified          boolean not null default false,
  owner             jsonb not null default '{}'::jsonb,
  owner_user_id     uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
alter table public.trucks enable row level security;
drop policy if exists "trucks readable"     on public.trucks;
drop policy if exists "trucks owner insert" on public.trucks;
drop policy if exists "trucks owner update" on public.trucks;
drop policy if exists "trucks owner delete" on public.trucks;
create policy "trucks readable" on public.trucks for select using (true);
create policy "trucks owner insert" on public.trucks for insert
  with check (auth.uid() is not null and owner_user_id = auth.uid());
create policy "trucks owner update" on public.trucks for update
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy "trucks owner delete" on public.trucks for delete
  using (owner_user_id = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('truck-photos','truck-photos',true,20971520,array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = excluded.public;
drop policy if exists "truck-photos readable" on storage.objects;
create policy "truck-photos readable" on storage.objects for select using (bucket_id = 'truck-photos');
drop policy if exists "truck-photos upload" on storage.objects;
create policy "truck-photos upload" on storage.objects for insert
  with check (bucket_id = 'truck-photos' and auth.uid() is not null);`;

  // ---- element refs --------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const authCard = $("atAuthCard"), dashboard = $("atDashboard"), formSection = $("atFormSection");
  const warnEl = $("atWarn"), listEl = $("atList"), userEmailEl = $("atUserEmail");
  const tabSignIn = $("tabSignIn"), tabSignUp = $("tabSignUp");
  const authForm = $("atAuthForm"), authEmail = $("atEmail"), authPassword = $("atPassword");
  const authPasswordConfirm = $("atPasswordConfirm"), authPasswordConfirmRow = $("atPasswordConfirmRow");
  const authSubmit = $("atAuthSubmit"), authMsg = $("atAuthMsg");
  const newBtn = $("atNewBtn"), signOutBtn = $("atSignOut");
  const form = $("atForm"), formTitle = $("atFormTitle"), formMsg = $("atFormMsg");
  const photoInput = $("atPhotoInput"), photoGrid = $("atPhotoGrid");
  const fRegion = $("atRegion");
  const pinSearch = $("atPinSearch"), pinResults = $("atPinResults");
  const pinMapEl = $("atPinMap"), pinCoords = $("atPinCoords"), pinGps = $("atPinGps");

  let authMode = "signin";
  let editingId = null;
  let photoState = [];       // [{path} | {file, preview}]
  let agentProfile = null;   // region + area this owner operates in
  let pin = { lat: null, lng: null };
  let pinMap = null, pinMarker = null;
  // Admin hierarchy (region/district/ward) auto-derived from the pin so the
  // truck is searchable by those, mirroring the houses form.
  let pinAdmin = null, truckGeoTimer = null, truckGeoKey = null;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function showFatal(msg) {
    if (!warnEl) { alert(msg); return; }
    warnEl.innerHTML = `<div class="at-msg error"><strong>Error:</strong> ${esc(String(msg))}</div>`;
  }
  window.addEventListener("error", (e) => showFatal(e.message || "Unknown JS error"));
  window.addEventListener("unhandledrejection", (e) => showFatal(e.reason?.message || e.reason || "Promise rejected"));

  // Bind critical buttons before any await.
  signOutBtn?.addEventListener("click", async () => {
    if (!sb) { location.reload(); return; }
    await sb.auth.signOut().catch(() => {});
    setTimeout(() => location.reload(), 150);
  });
  newBtn?.addEventListener("click", () => openForm(null));
  $("atCancelBtn")?.addEventListener("click", () => closeForm());

  // Truck types the dropdown offers directly; anything else is a free-text "other" kind.
  const KNOWN_TRUCK_TYPES = ["pickup", "canter", "3ton", "7ton", "10ton_plus", "other"];
  function syncTruckTypeOther() {
    const row = $("atTypeOtherRow");
    if (row) row.style.display = $("atType").value === "other" ? "" : "none";
  }
  $("atType")?.addEventListener("change", syncTruckTypeOther);

  if (!sb) {
    authCard.hidden = false;
    setAuthMsg("Supabase isn't configured, so sign-in is unavailable.", "error");
    authForm.querySelectorAll("input,button").forEach((el) => (el.disabled = true));
    return;
  }

  // ---- region dropdown -----------------------------------------------------
  try {
    const regions = (await window.DataStore.getRegions?.()) || [];
    regions.forEach((r) => {
      const o = document.createElement("option"); o.value = r; o.textContent = r; fRegion.appendChild(o);
    });
  } catch (_) { /* owner can leave region blank */ }

  // ---- auth ----------------------------------------------------------------
  await routeOnAuth();
  // Only react to genuine sign-in / sign-out. Supabase also fires this event on
  // TOKEN_REFRESHED, USER_UPDATED and tab-refocus — re-routing on those would
  // hide an open registration form and reload the list mid-entry (it looks like
  // the page "auto-refreshed" and wiped what you were typing).
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") { routeOnAuth(null); return; }
    if (event === "SIGNED_IN" && !authCard.hidden) routeOnAuth(session);
  });

  async function routeOnAuth(session) {
    const s = session ?? (await sb.auth.getSession()).data.session;
    if (s?.user) {
      authCard.hidden = true; dashboard.hidden = false; formSection.hidden = true;
      userEmailEl.textContent = s.user.email || "—";
      // Make sure the owner has declared the region they belong to + the area
      // they operate in before they list — so their trucks surface to searchers
      // in that area.
      try { agentProfile = await window.AgentProfile?.ensure(sb); } catch (_) {}
      if (agentProfile?.region && fRegion && !fRegion.value) fRegion.value = agentProfile.region;
      await loadMyTrucks();
      checkSubscription();
      window.renderAgentClientTip?.({ mount: dashboard, id: "atClientTip", kind: "trucks" });
      window.renderFrameScout?.({ mount: dashboard, id: "atFrameScout", kind: "trucks" });
      window.renderAgentMessages?.({ sb, mount: dashboard });
      window.AgentDemandBoard?.load({ sb, agentProfile, mount: dashboard, kind: "trucks" });
    } else {
      authCard.hidden = false; dashboard.hidden = true; formSection.hidden = true;
    }
  }

  // Subscription / activation guard: deactivation, lapsed subscription, or the
  // 48h pay-or-pause grace expiring → paywall (RLS also hides the trucks);
  // during grace, a live countdown demanding payment.
  async function checkSubscription() {
    if (!sb) return;
    try {
      const { data } = await sb.rpc("my_agent_subscription");
      const sub = Array.isArray(data) ? data[0] : data;
      window.renderAgentSubBanner(sub, { mount: dashboard, id: "atSubPaywall", what: "trucks" });
    } catch (_) { /* RPC not deployed yet — ignore */ }
  }

  tabSignIn.addEventListener("click", () => {
    authMode = "signin"; tabSignIn.classList.add("active"); tabSignUp.classList.remove("active");
    authSubmit.textContent = "Sign in"; authPassword.autocomplete = "current-password";
    if (authPasswordConfirmRow) authPasswordConfirmRow.hidden = true;
    setAuthMsg("", "");
  });
  tabSignUp.addEventListener("click", () => {
    authMode = "signup"; tabSignUp.classList.add("active"); tabSignIn.classList.remove("active");
    authSubmit.textContent = "Create account"; authPassword.autocomplete = "new-password";
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
      `Open it to activate your account, then sign in. ` +
      `<button type="button" id="atResendVerify" class="at-btn" style="margin-top:8px;">Resend verification email</button>`,
      kind || "success"
    );
    $("atResendVerify")?.addEventListener("click", () => resendVerification(email));
  }

  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setAuthMsg("", "");
    const email = authEmail.value.trim(), password = authPassword.value;

    if (!isValidEmail(email)) {
      setAuthMsg("Please enter a valid email address (e.g. name@example.com).", "error");
      authEmail.focus();
      return;
    }

    authSubmit.disabled = true;
    try {
      if (authMode === "signup") {
        // Require the re-entered password to match — a typo otherwise creates an
        // account with a password the owner can never reproduce.
        const confirm = authPasswordConfirm ? authPasswordConfirm.value : password;
        if (password !== confirm) {
          setAuthMsg("The two passwords don't match. Please re-enter them.", "error");
          return;
        }
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) {
          // Account already exists: don't silently sign in with the sign-up
          // password — send them to Sign in to use their real password.
          if (/already registered|already been registered|user already/i.test(error.message || "")) {
            authMode = "signin"; tabSignIn.click();
            setAuthMsg(`An account with <strong>${esc(email)}</strong> already exists. Switch to <strong>Sign in</strong> and enter your password.`, "error");
            return;
          }
          throw error;
        }
        // Supabase anti-enumeration: an existing email returns no error and a
        // user row with an empty identities[] array. Treat that as "exists".
        if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          authMode = "signin"; tabSignIn.click();
          setAuthMsg(`An account with <strong>${esc(email)}</strong> already exists. Switch to <strong>Sign in</strong> and enter your password.`, "error");
          return;
        }
        if (data?.session) return;                 // confirm-email OFF → signed in
        authMode = "signin"; tabSignIn.click();    // confirm-email ON → verify first
        showVerifyNotice(email, "Account created.", "success");
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      const msg = err?.message || "";
      if (/invalid login|invalid_credentials|invalid_grant/i.test(msg)) {
        setAuthMsg(`Wrong email or password. If you're new, tap <strong>Create account</strong>.`, "error");
      } else if (/email not confirmed|email_not_confirmed/i.test(msg)) {
        showVerifyNotice(email, "Your email isn't verified yet.", "error");
      } else if (/rate limit|over_email_send_rate_limit|too many/i.test(msg)) {
        setAuthMsg("Too many attempts. Please wait a minute, then try again.", "error");
      } else if (/password.*should be at least|weak password|password is too short/i.test(msg)) {
        setAuthMsg("Password must be at least 6 characters.", "error");
      } else {
        setAuthMsg(esc(msg) || "Sign-in failed. Please try again.", "error");
      }
    } finally {
      authSubmit.disabled = false;
    }
  });

  // ---- list my trucks ------------------------------------------------------
  async function loadMyTrucks() {
    listEl.setAttribute("aria-busy", "true");
    listEl.innerHTML = `<div class="at-hint">Loading your trucks…</div>`;
    const { data: { session } } = await sb.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) return;
    const { data, error } = await sb.from("trucks").select("*")
      .eq("owner_user_id", uid).order("created_at", { ascending: false });
    listEl.setAttribute("aria-busy", "false");
    if (error) {
      if (/relation .* does not exist|schema cache|could not find the table/i.test(error.message)) {
        renderSetupCard();
        return;
      }
      listEl.innerHTML = `<div class="at-msg error">Couldn't load your trucks: ${esc(error.message)}</div>`;
      return;
    }
    newBtn.hidden = false;
    if (!data.length) {
      listEl.innerHTML = `<div class="at-hint">No trucks yet. Tap <strong>+ New truck</strong> to add your first one.</div>`;
      return;
    }
    listEl.innerHTML = data.map((t) => {
      const img = t.photo ? window.DataStore.truckPhotoUrl(t.photo) : "";
      return `<div class="at-tile">
        <div class="at-tile-photo" style="${img ? `background-image:url('${esc(img)}')` : ""}">${img ? "" : ""}</div>
        <div class="at-tile-body">
          <h4>${esc(t.title || "Truck")}</h4>
          <div class="at-hint" style="margin:0">${esc([t.area, t.region].filter(Boolean).join(", ") || "—")}</div>
          <div class="at-tile-actions">
            <button data-edit="${esc(t.id)}">Edit</button>
            <button data-del="${esc(t.id)}" style="color:#b91c1c">Delete</button>
          </div>
        </div></div>`;
    }).join("");
    listEl.querySelectorAll("[data-edit]").forEach((b) =>
      b.addEventListener("click", () => openForm(data.find((x) => x.id === b.dataset.edit))));
    listEl.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", () => deleteTruck(data.find((x) => x.id === b.dataset.del))));
  }

  function sqlEditorUrl() {
    const u = window.APP_CONFIG?.SUPABASE_URL || "";
    const m = u.match(/^https?:\/\/([^.]+)\.supabase\.co/i);
    return m ? `https://supabase.com/dashboard/project/${m[1]}/sql/new` : "https://supabase.com/dashboard";
  }
  function renderSetupCard() {
    newBtn.hidden = true;
    listEl.innerHTML = `
      <div class="at-card at-setup" style="grid-column:1/-1">
        <h3 style="margin-top:0"> One-time setup needed</h3>
        <p class="at-hint">The <code>trucks</code> table doesn't exist yet. Run this SQL once in your Supabase SQL editor, then reload.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
          <a class="at-btn at-btn-brand" target="_blank" rel="noopener" href="${sqlEditorUrl()}">Open SQL editor</a>
          <button id="atSetupCopy" class="at-btn" type="button">Copy SQL</button>
          <button id="atSetupReload" class="at-btn" type="button">I've run it — reload</button>
        </div>
        <pre id="atSetupSql">${esc(SETUP_SQL)}</pre>
      </div>`;
    $("atSetupCopy")?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(SETUP_SQL); const b = $("atSetupCopy"); b.textContent = "Copied!"; setTimeout(() => (b.textContent = "Copy SQL"), 1500); }
      catch (_) { alert("Select the SQL below and copy it manually."); }
    });
    $("atSetupReload")?.addEventListener("click", () => { newBtn.hidden = false; loadMyTrucks(); });
  }

  // ---- form ----------------------------------------------------------------
  function openForm(t) {
    editingId = t?.id || null;
    formTitle.textContent = t ? "Edit truck" : "Add a truck";
    formMsg.hidden = true;
    dashboard.hidden = true; formSection.hidden = false;

    // reset fields
    $("atTitle").value = t?.title || "";
    // A free-text "any kind" truck_type lands in the Other box; known types select directly.
    const _tt = t?.truck_type || "canter";
    if (_tt && !KNOWN_TRUCK_TYPES.includes(_tt)) {
      $("atType").value = "other";
      $("atTypeOther").value = _tt;
    } else {
      $("atType").value = _tt;
      $("atTypeOther").value = "";
    }
    syncTruckTypeOther();
    $("atCapacity").value = t?.capacity_tonnes ?? "";
    $("atPrice").value = t?.price_tzs ?? "";
    $("atService").value = t?.service_area || "region_wide";
    $("atNegotiable").checked = t ? !!t.negotiable : true;
    $("atDriver").checked = t ? !!t.driver_included : true;
    $("atLoaders").checked = t ? !!t.loaders_included : false;
    fRegion.value = t?.region || "";
    $("atArea").value = t?.area || "";
    $("atAddress").value = t?.address || "";
    $("atDescription").value = t?.description || "";
    $("atOwnerName").value = t?.owner?.name || "";
    $("atOwnerPhone").value = t?.owner?.phone || "";
    $("atOwnerWa").value = t?.owner?.whatsapp || "";

    pin = { lat: Number.isFinite(+t?.lat) ? +t.lat : null, lng: Number.isFinite(+t?.lng) ? +t.lng : null };
    updatePinCoords();

    // photos
    const existing = (Array.isArray(t?.photos) && t.photos.length ? t.photos : (t?.photo ? [t.photo] : []));
    photoState = existing.map((p) => ({ path: p }));
    renderPhotoGrid();

    initPinMap();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function closeForm() {
    formSection.hidden = true; dashboard.hidden = false;
  }

  // photo grid
  photoInput.addEventListener("change", () => {
    [...photoInput.files].forEach((file) => {
      if (photoState.length >= 8) return;
      const reader = new FileReader();
      reader.onload = () => { photoState.push({ file, preview: reader.result }); renderPhotoGrid(); };
      reader.readAsDataURL(file);
    });
    photoInput.value = "";
  });
  function renderPhotoGrid() {
    photoGrid.innerHTML = photoState.map((p, i) => {
      const url = p.preview || window.DataStore.truckPhotoUrl(p.path);
      return `<div class="at-photo-cell" style="background-image:url('${esc(url)}')"><button type="button" data-rm="${i}">×</button></div>`;
    }).join("");
    photoGrid.querySelectorAll("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => { photoState.splice(+b.dataset.rm, 1); renderPhotoGrid(); }));
  }

  // ---- pin map -------------------------------------------------------------
  function updatePinCoords() {
    pinCoords.textContent = (pin.lat != null && pin.lng != null)
      ? `Pin: ${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}` : "No pin set";
  }
  function setPin(lat, lng, recenter) {
    pin = { lat, lng };
    updatePinCoords();
    geocodeTruckPin();
    if (pinMap) {
      if (!pinMarker) {
        pinMarker = L.marker([lat, lng], { draggable: true }).addTo(pinMap);
        pinMarker.on("dragend", () => { const ll = pinMarker.getLatLng(); pin = { lat: ll.lat, lng: ll.lng }; updatePinCoords(); geocodeTruckPin(); });
      } else {
        pinMarker.setLatLng([lat, lng]);
      }
      if (recenter) pinMap.setView([lat, lng], 14);
    }
  }
  // Reverse-geocode the pin → region/district/ward/area (debounced, cached in
  // geo.js). Auto-fills blank region/area inputs so the listing is searchable.
  function geocodeTruckPin() {
    if (pin.lat == null || pin.lng == null || !window.pawaGeo) return;
    const key = `${(+pin.lat).toFixed(5)},${(+pin.lng).toFixed(5)}`;
    if (key === truckGeoKey) return;
    truckGeoKey = key;
    clearTimeout(truckGeoTimer);
    truckGeoTimer = setTimeout(async () => {
      try {
        const j = await window.pawaGeo.reverse(`format=jsonv2&lat=${pin.lat}&lon=${pin.lng}&zoom=18&addressdetails=1`);
        if (truckGeoKey !== key) return;
        const a = (j && j.address) || {};
        const region = a.state || a.region || "";
        const district = a.county || a.state_district || a.city_district || a.municipality || a.city || a.town || "";
        const ward = a.ward || a.suburb || a.quarter || a.neighbourhood || a.village || "";
        const area = a.neighbourhood || a.suburb || a.quarter || a.village || a.town || a.city_district || a.hamlet || "";
        pinAdmin = { region, district, ward, area };
        if (region && fRegion && !fRegion.value) fRegion.value = region;
        const areaEl = $("atArea");
        // Tag by the neighbourhood area when there is one, else by the ward — so a
        // truck pinned on a nameless street still gets a real, searchable area.
        const areaFill = area || ward;
        if (areaFill && areaEl && !areaEl.value.trim()) areaEl.value = areaFill;
      } catch (_) { /* offline → the pin still saves */ }
    }, 600);
  }
  function initPinMap() {
    if (pinMap) { setTimeout(() => pinMap.invalidateSize(), 80); if (pin.lat != null) setPin(pin.lat, pin.lng, true); return; }
    if (!window.L || !pinMapEl) return;
    pinMap = L.map(pinMapEl, { scrollWheelZoom: true }).setView(
      pin.lat != null ? [pin.lat, pin.lng] : [-6.4, 35.0], pin.lat != null ? 14 : 6);
    window.addSatelliteHybrid(pinMap);
    pinMap.on("click", (e) => setPin(e.latlng.lat, e.latlng.lng, false));
    if (pin.lat != null) setPin(pin.lat, pin.lng, true);
    setTimeout(() => pinMap.invalidateSize(), 120);
  }
  pinGps.addEventListener("click", async () => {
    pinGps.disabled = true; const old = pinGps.textContent; pinGps.textContent = "Locating…";
    try {
      const fix = await window.pawaLocate.best({ targetAccuracy: 50, hardTimeout: 12000 });
      setPin(fix.lat, fix.lng, true);
    } catch (e) { alert((e && e.message) || "Couldn't get your location."); }
    finally { pinGps.disabled = false; pinGps.textContent = old; }
  });

  // AI-assisted pin: describe the location in plain words → AI resolves → drop pin.
  const pinAi = $("atPinAi"), pinAiMsg = $("atPinAiMsg");
  pinAi?.addEventListener("click", async () => {
    const q = (pinSearch.value || "").trim();
    if (!q) { pinSearch.focus(); return; }
    if (!window.AI?.locate) { if (pinAiMsg) pinAiMsg.textContent = "AI unavailable — use the list or GPS."; return; }
    const old = pinAi.textContent; pinAi.disabled = true; pinAi.textContent = "Locating…";
    if (pinAiMsg) pinAiMsg.textContent = "";
    try {
      const loc = await window.AI.locate(q, { regions: window.APP_CONFIG?.REGIONS });
      if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
        setPin(loc.lat, loc.lng, true);
        if (pinResults) pinResults.hidden = true;
        if (pinAiMsg) pinAiMsg.textContent = " " + (loc.label || "Pinned") + (loc.answer ? " — " + loc.answer : "") + " (drag to fine-tune)";
      } else if (pinAiMsg) {
        pinAiMsg.textContent = "Couldn't locate that — try a nearby landmark or tap the map.";
      }
    } finally { pinAi.disabled = false; pinAi.textContent = old; }
  });

  // pin search (pawaGeo suggest)
  let searchTimer = null;
  pinSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = pinSearch.value.trim();
    if (q.length < 2) { pinResults.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      try {
        const list = await window.pawaGeo.suggest(q, { limit: 8 });
        if (!list.length) { pinResults.hidden = true; return; }
        pinResults.innerHTML = list.map((s, i) =>
          `<button type="button" data-i="${i}"><strong>${esc(s.name)}</strong>${s.tag ? ` <small>· ${esc(s.tag)}</small>` : ""}<br><small>${esc(s.context || "")}</small></button>`).join("");
        pinResults.hidden = false;
        pinResults.querySelectorAll("button").forEach((b) =>
          b.addEventListener("click", () => {
            const s = list[+b.dataset.i];
            setPin(s.lat, s.lng, true);
            if (!$("atArea").value && s.name) $("atArea").value = s.name;
            pinResults.hidden = true; pinSearch.value = s.name;
          }));
      } catch (_) { pinResults.hidden = true; }
    }, 220);
  });
  document.addEventListener("click", (e) => {
    if (!pinResults.contains(e.target) && e.target !== pinSearch) pinResults.hidden = true;
  });

  // ---- upload + save -------------------------------------------------------
  function bucket() { return (window.APP_CONFIG && window.APP_CONFIG.TRUCK_PHOTOS_BUCKET) || "truck-photos"; }
  async function uploadFile(file, uid) {
    const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || "jpg").toLowerCase();
    const path = `${uid}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await sb.storage.from(bucket()).upload(path, file, {
      contentType: file.type || "image/jpeg", upsert: false,
    });
    if (error) throw error;
    return path;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formMsg.hidden = true;
    const saveBtn = $("atSaveBtn");
    saveBtn.disabled = true; saveBtn.textContent = "Saving…";
    try {
      const { data: { session } } = await sb.auth.getSession();
      const uid = session?.user?.id;
      if (!uid) throw new Error("Your session expired — please sign in again.");
      if (pin.lat == null || pin.lng == null) throw new Error("Please drop a pin for where the truck is based.");

      // Upload any new photos; keep existing storage paths.
      const paths = [];
      for (const p of photoState) {
        if (p.path) paths.push(p.path);
        else if (p.file) paths.push(await uploadFile(p.file, uid));
      }

      const row = {
        id: editingId || ("t-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6)),
        title: $("atTitle").value.trim(),
        // "Other" stores whatever kind the provider typed (falls back to "other").
        truck_type: $("atType").value === "other"
                      ? (($("atTypeOther").value || "").trim().toLowerCase() || "other")
                      : $("atType").value,
        capacity_tonnes: $("atCapacity").value ? parseFloat($("atCapacity").value) : null,
        price_tzs: parseInt($("atPrice").value, 10) || 0,
        currency: "TZS",
        period: "trip",
        negotiable: $("atNegotiable").checked,
        driver_included: $("atDriver").checked,
        loaders_included: $("atLoaders").checked,
        service_area: $("atService").value,
        region: fRegion.value || (pinAdmin && pinAdmin.region) || agentProfile?.region || null,
        area: $("atArea").value.trim() || (pinAdmin && pinAdmin.area) || agentProfile?.area_of_operations || null,
        district: (pinAdmin && pinAdmin.district) || agentProfile?.district || null,
        ward: (pinAdmin && pinAdmin.ward) || agentProfile?.ward || null,
        address: $("atAddress").value.trim() || null,
        lat: pin.lat, lng: pin.lng,
        photo: paths[0] || null,
        photos: paths,
        description: $("atDescription").value.trim() || null,
        owner: {
          name: $("atOwnerName").value.trim(),
          phone: $("atOwnerPhone").value.trim(),
          whatsapp: $("atOwnerWa").value.trim() || $("atOwnerPhone").value.trim(),
        },
        owner_user_id: uid,
      };

      const q = editingId
        ? sb.from("trucks").update(row).eq("id", editingId).eq("owner_user_id", uid).select()
        : sb.from("trucks").insert(row).select();
      const { data: saved, error } = await q;
      if (error) throw error;
      if (!saved || !saved.length) {
        throw new Error("Save returned no rows — check that the trucks table + RLS policies are applied (run the setup SQL).");
      }

      window.DataStore?.invalidateCache(["trucks"]);
      formMsg.className = "at-msg success";
      formMsg.textContent = editingId ? "Truck updated." : "Truck listed! People moving house can now find it.";
      formMsg.hidden = false;
      setTimeout(() => { closeForm(); loadMyTrucks(); }, 700);
    } catch (err) {
      formMsg.className = "at-msg error";
      formMsg.textContent = err?.message || "Couldn't save the truck.";
      formMsg.hidden = false;
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = "Save truck";
    }
  });

  async function deleteTruck(t) {
    if (!t || !confirm(`Delete "${t.title || "this truck"}"?`)) return;
    const { data: { session } } = await sb.auth.getSession();
    const uid = session?.user?.id;
    const { error } = await sb.from("trucks").delete().eq("id", t.id).eq("owner_user_id", uid);
    if (error) { alert("Delete failed: " + error.message); return; }
    // best-effort photo cleanup
    const paths = [t.photo, ...(t.photos || [])].filter((p) => p && !p.startsWith("http") && !p.startsWith("data/"));
    if (paths.length) sb.storage.from(bucket()).remove(paths).catch(() => {});
    window.DataStore?.invalidateCache(["trucks"]);
    loadMyTrucks();
  }
};
