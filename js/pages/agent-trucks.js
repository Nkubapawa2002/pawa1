// Register a moving truck — owner-authenticated CRUD over public.trucks, the
// truck companion to agent-houses.js and agent-services.js. Sign in, then add
// trucks with photos and a base-location pin; users browse them on trucks.html
// and find the nearest.
//
// Mirrors the other two portals: Supabase email auth, owner_user_id =
// auth.uid() inserts (RLS-enforced), photo upload into the `truck-photos`
// bucket, and a setup card with the SQL when the table has not been applied.
//
// Every visible string here goes through T(). It used to be written in English
// in this file and nowhere else, so a Swahili owner met an entirely English
// portal the moment they signed in, on the one screen in the app that asks
// somebody to type for ten minutes. The page is also on the shared portal
// shell now (css/agent-portal.css) rather than a hundred lines of raw hex with
// a palette redefined on body[data-page], which beats css/theme-light.css on
// :root and left the whole screen dark in light mode.

window.initAgentTrucksPage = async () => {
  const sb = window.DataStore?.sb;

  // t() with a hard fallback: a missing key must show the English word rather
  // than the key name.
  const T = (k, en) => {
    const v = window.t ? window.t(k) : k;
    return v === k && en ? en : v;
  };
  // "{email} already exists" -> the email. i18n.js keeps the braces so a
  // translator can move the value inside the sentence.
  const fill = (str, vars) => String(str).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

  // Icons. Lucide-style stroke SVGs, so they take currentColor and scale with
  // the type beside them.
  const IC = {
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
    empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 6h13v9H1z"/><path d="M14 9h4l3 3v3h-7z"/><circle cx="5.5" cy="18" r="1.7"/><circle cx="17.5" cy="18" r="1.7"/></svg>',
  };

  // The exact SQL from supabase/features/truck/trucks.sql — shown in the setup card so the
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
  const kitEl = $("atKit"), locDoorsEl = $("atLocDoors");

  let authMode = "signin";
  let editingId = null;
  let photoState = [];       // [{path} | {file, preview}]
  let agentProfile = null;   // region + area this owner operates in
  let pin = { lat: null, lng: null };
  let pinMap = null, pinMarker = null;
  // Admin hierarchy (region/district/ward) auto-derived from the pin so the
  // truck is searchable by those, mirroring the houses form.
  let pinAdmin = null, truckGeoTimer = null, truckGeoKey = null;
  let rail = null;                    // the section rail down the side
  let kit = null;                     // "what comes with the truck" pick list
  let doors = null;                   // the three ways a location can arrive

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function showFatal(msg) {
    if (!warnEl) { alert(msg); return; }
    warnEl.innerHTML = `<div class="ap-msg is-error">${esc(String(msg))}</div>`;
  }
  window.addEventListener("error", (e) => showFatal(e.message || T("ap_err_unknown")));
  window.addEventListener("unhandledrejection", (e) => showFatal(e.reason?.message || e.reason || T("ap_err_unknown")));

  // A button whose label lives in a <span> beside an icon; setting textContent
  // on the button itself would throw the icon away.
  function setBtnLabel(btn, text) {
    const span = btn.querySelector("span");
    if (span) span.textContent = text; else btn.textContent = text;
  }
  function btnLabel(btn) {
    const span = btn.querySelector("span");
    return span ? span.textContent : btn.textContent;
  }

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
    if (row) row.hidden = $("atType").value !== "other";
  }
  $("atType")?.addEventListener("change", syncTruckTypeOther);

  if (!sb) {
    authCard.hidden = false;
    setAuthMsg(esc(T("ap_msg_supabase_missing")), "error");
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
      authCard.hidden = true; dashboard.hidden = false; formSection.hidden = true;
      userEmailEl.textContent = s.user.email || T("ap_no_email");
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
    authSubmit.textContent = T("at_tab_signin"); authPassword.autocomplete = "current-password";
    if (authPasswordConfirmRow) authPasswordConfirmRow.hidden = true;
    setAuthMsg("", "");
  });
  tabSignUp.addEventListener("click", () => {
    authMode = "signup"; tabSignUp.classList.add("active"); tabSignIn.classList.remove("active");
    authSubmit.textContent = T("at_tab_signup"); authPassword.autocomplete = "new-password";
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
      setAuthMsg(fill(T("ap_verify_resent"), { email: `<strong>${esc(email)}</strong>` }), "success");
    } catch (err) {
      const m = err?.message || "";
      if (/rate limit|too many|over_email_send_rate_limit/i.test(m)) {
        setAuthMsg(esc(T("ap_verify_rate")), "error");
      } else {
        setAuthMsg(esc(T("ap_verify_resend_fail")) + " " + esc(m), "error");
      }
    }
  }

  function showVerifyNotice(email, lead, kind) {
    setAuthMsg(
      `${esc(lead)} ${fill(T("ap_verify_sent"), { email: `<strong>${esc(email)}</strong>` })} ` +
      `<button type="button" id="atResendVerify" class="ap-btn ap-btn--sm" style="margin-top:var(--space-2)">` +
      `${esc(T("ap_verify_resend"))}</button>`,
      kind || "success"
    );
    $("atResendVerify")?.addEventListener("click", () => resendVerification(email));
  }

  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setAuthMsg("", "");
    const email = authEmail.value.trim(), password = authPassword.value;

    if (!isValidEmail(email)) {
      setAuthMsg(esc(T("ap_err_bad_email")), "error");
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
          setAuthMsg(esc(T("ap_err_pw_mismatch")), "error");
          return;
        }
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) {
          // Account already exists: don't silently sign in with the sign-up
          // password — send them to Sign in to use their real password.
          if (/already registered|already been registered|user already/i.test(error.message || "")) {
            authMode = "signin"; tabSignIn.click();
            setAuthMsg(fill(T("ap_err_email_exists"), { email: `<strong>${esc(email)}</strong>` }), "error");
            return;
          }
          throw error;
        }
        // Supabase anti-enumeration: an existing email returns no error and a
        // user row with an empty identities[] array. Treat that as "exists".
        if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          authMode = "signin"; tabSignIn.click();
          setAuthMsg(fill(T("ap_err_email_exists"), { email: `<strong>${esc(email)}</strong>` }), "error");
          return;
        }
        if (data?.session) return;                 // confirm-email OFF → signed in
        authMode = "signin"; tabSignIn.click();    // confirm-email ON → verify first
        showVerifyNotice(email, T("ap_msg_account_created"), "success");
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      const msg = err?.message || "";
      if (/invalid login|invalid_credentials|invalid_grant/i.test(msg)) {
        setAuthMsg(T("ap_err_wrong_password"), "error");
      } else if (/email not confirmed|email_not_confirmed/i.test(msg)) {
        showVerifyNotice(email, T("ap_err_not_verified"), "error");
      } else if (/rate limit|over_email_send_rate_limit|too many/i.test(msg)) {
        setAuthMsg(esc(T("ap_err_too_many")), "error");
      } else if (/password.*should be at least|weak password|password is too short/i.test(msg)) {
        setAuthMsg(esc(T("ap_err_pw_short")), "error");
      } else {
        setAuthMsg(esc(msg) || esc(T("ap_err_signin_failed")), "error");
      }
    } finally {
      authSubmit.disabled = false;
    }
  });

  // ---- list my trucks ------------------------------------------------------
  async function loadMyTrucks() {
    listEl.setAttribute("aria-busy", "true");
    listEl.innerHTML = `<p class="ap-hint">${esc(T("at_loading"))}</p>`;
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
      listEl.innerHTML =
        `<div class="ap-msg is-error">${esc(T("at_load_fail"))} ${esc(error.message)}</div>`;
      return;
    }
    newBtn.hidden = false;
    if (!data.length) {
      listEl.innerHTML =
        `<div class="ap-empty">${IC.empty}<h3>${esc(T("at_empty_h"))}</h3>` +
        `<p>${esc(T("at_empty_p"))}</p></div>`;
      return;
    }
    listEl.innerHTML = data.map((t) => {
      const img = t.photo ? window.DataStore.truckPhotoUrl(t.photo) : "";
      const where = [t.area, t.region].filter(Boolean).join(", ");
      return `<article class="ap-card">
        <div class="ap-card__photo" data-empty="${esc(T("ap_no_photo"))}"
             style="${img ? `background-image:url('${esc(img)}')` : ""}"></div>
        <div class="ap-card__body">
          <h4 class="ap-card__title">${esc(t.title || T("at_untitled"))}</h4>
          <span class="ap-card__meta">${esc(where || T("ap_no_area"))}</span>
        </div>
        <div class="ap-card__acts">
          <button type="button" class="ap-btn ap-btn--sm" data-edit="${esc(t.id)}">${IC.edit}<span>${esc(T("ap_edit"))}</span></button>
          <button type="button" class="ap-btn ap-btn--sm ap-btn--danger" data-del="${esc(t.id)}">${IC.trash}<span>${esc(T("ap_delete"))}</span></button>
        </div>
      </article>`;
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
      <div class="ap-panel" style="grid-column:1/-1">
        <div class="ap-panel__head">
          <span class="ap-panel__n" aria-hidden="true">${IC.warn}</span>
          <div class="ap-panel__tx">
            <h3>${esc(T("ap_setup_h"))}</h3>
            <p>${esc(T("at_setup_p"))}</p>
          </div>
        </div>
        <div class="ap-inline" style="margin-bottom:var(--space-3)">
          <a class="ap-btn ap-btn--brand" target="_blank" rel="noopener" href="${sqlEditorUrl()}">${esc(T("ap_setup_open"))}</a>
          <button id="atSetupCopy" class="ap-btn" type="button"><span>${esc(T("ap_setup_copy"))}</span></button>
          <button id="atSetupReload" class="ap-btn" type="button">${esc(T("ap_setup_reload"))}</button>
        </div>
        <pre class="ap-code" id="atSetupSql">${esc(SETUP_SQL)}</pre>
      </div>`;
    $("atSetupCopy")?.addEventListener("click", async () => {
      const b = $("atSetupCopy");
      try {
        await navigator.clipboard.writeText(SETUP_SQL);
        setBtnLabel(b, T("ap_setup_copied"));
        setTimeout(() => setBtnLabel(b, T("ap_setup_copy")), 1500);
      } catch (_) { alert(T("ap_setup_copy_fail")); }
    });
    $("atSetupReload")?.addEventListener("click", () => { newBtn.hidden = false; loadMyTrucks(); });
  }

  // ---- form ----------------------------------------------------------------
  function openForm(t) {
    editingId = t?.id || null;
    formTitle.textContent = T(t ? "at_form_title_edit" : "at_form_title_new");
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
    // The spec sheet. `details` is the same shape houses.details has: a small
    // jsonb bag beside the columns, so a fact with no column of its own is a
    // field rather than a sentence buried in a paragraph.
    //
    // "Driver included" and "Loaders included" were two checkboxes above a list
    // that says the same thing, which is how a listing ends up arguing with
    // itself. The chips are the question now, and the two columns are read back
    // off them at save time. A truck saved before this carries the booleans and
    // no chips, so the chips are restored from them here and nothing is lost.
    const det = (t && t.details && typeof t.details === "object") ? t.details : {};
    let startKit = window.TruckSpec ? window.TruckSpec.normalize(det.kit) : [];
    if (t && !startKit.length) {
      if (t.driver_included) startKit = startKit.concat("driver");
      if (t.loaders_included) startKit = startKit.concat("loaders");
    } else if (!t) {
      startKit = ["driver"];          // the ordinary case, and one less tap
    }
    mountKit(startKit);
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
    mountDoors();
    // The rail is only useful once the form exists on screen, and it has to
    // re-read the ticks after a listing is loaded into it.
    rail = rail || window.AgentPortalRail?.mount({ rail: "#atRail", form: "#atForm" });
    rail?.refresh();
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
      return `<div class="ap-tile" style="background-image:url('${esc(url)}')">
        <button type="button" class="ap-tile__x" data-rm="${i}"
                aria-label="${esc(T("ap_remove_photo"))}">&times;</button>
        ${i === 0 ? `<span class="ap-tile__flag">${esc(T("ap_cover"))}</span>` : ""}
      </div>`;
    }).join("");
    photoGrid.querySelectorAll("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => { photoState.splice(+b.dataset.rm, 1); renderPhotoGrid(); }));
    $("atPhotoAdd")?.classList.toggle("is-full", photoState.length >= 8);
  }

  // ---- pin map -------------------------------------------------------------
  function updatePinCoords() {
    const set = pin.lat != null && pin.lng != null;
    pinCoords.textContent = set
      ? `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`
      : T("ap_pin_none");
    // The rail counts a dropped pin as an answered section, and a pin has no
    // input behind it to read.
    pinCoords.dataset.hasPin = set ? "1" : "0";
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
  // ==========================================================================
  //  THE DOORS A LOCATION CAN ARRIVE THROUGH
  //
  //  The pin had three sources and every one of them needed the owner to be
  //  standing beside the truck. A lorry that sleeps at a yard across town, or
  //  an owner listing from home in the evening, had no way in at all. The
  //  shared module opens the same three doors agent-houses.html has: a code
  //  read down a phone, a pin already sitting in a P-Message thread, and a
  //  link the person there taps once. It owns no map, which is why the same
  //  file serves this Leaflet page and the MapLibre one.
  // ==========================================================================
  function mountDoors() {
    if (doors || !locDoorsEl || !window.PlaceDoors) return;
    doors = window.PlaceDoors.mount({
      into: locDoorsEl,
      sb: sb,
      purpose: "truck_pin",
      title: () => $("atTitle").value.trim(),
      current: () => (pin.lat == null ? null : pin),
      onPick: (place) => setPin(Number(place.lat), Number(place.lng), true),
    });
  }

  // ==========================================================================
  //  WHAT COMES WITH THE TRUCK
  //
  //  Three checkboxes and a free paragraph is what this used to be, and every
  //  fact a customer rings to ask about (a tarpaulin, straps, whether you go
  //  upcountry, whether the fuel is in the price) went into the paragraph,
  //  where it is invisible to search and impossible to compare. The catalogue
  //  is js/lib/offer-spec.js; the shape is js/lib/pick-list.js.
  // ==========================================================================
  function mountKit(values) {
    const spec = window.TruckSpec;
    if (!kitEl || !spec || !window.PickList) return;
    kitEl.innerHTML = window.PickList.html({
      question: T("at_kit_q"), help: T("at_kit_help"),
      emptyLabel: T("pk_none"), ownLabel: T("pk_add"), moreLabel: T("pk_more"),
      top: spec.top(), groups: spec.rest(),
    });
    kit = window.PickList.wire(kitEl.firstElementChild, {
      label: spec.label, removeLabel: T("pk_remove"), values: values || [],
    });
  }

  pinGps.addEventListener("click", async () => {
    pinGps.disabled = true;
    const old = btnLabel(pinGps);
    setBtnLabel(pinGps, T("ap_locating"));
    try {
      const fix = await window.pawaLocate.best({ targetAccuracy: 50, hardTimeout: 12000 });
      setPin(fix.lat, fix.lng, true);
    } catch (e) { alert((e && e.message) || T("ap_err_geo")); }
    finally { pinGps.disabled = false; setBtnLabel(pinGps, old); }
  });

  // AI-assisted pin: describe the location in plain words → AI resolves → drop pin.
  const pinAi = $("atPinAi"), pinAiMsg = $("atPinAiMsg");
  pinAi?.addEventListener("click", async () => {
    const q = (pinSearch.value || "").trim();
    if (!q) { pinSearch.focus(); return; }
    if (!window.AI?.locate) { if (pinAiMsg) pinAiMsg.textContent = T("ap_ai_unavailable"); return; }
    const old = btnLabel(pinAi); pinAi.disabled = true; setBtnLabel(pinAi, T("ap_locating"));
    if (pinAiMsg) pinAiMsg.textContent = "";
    try {
      const loc = await window.AI.locate(q, { regions: window.APP_CONFIG?.REGIONS });
      if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
        setPin(loc.lat, loc.lng, true);
        if (pinResults) pinResults.hidden = true;
        if (pinAiMsg) pinAiMsg.textContent = (loc.label || T("ap_ai_pinned")) + ". " + T("ap_ai_drag");
      } else if (pinAiMsg) {
        pinAiMsg.textContent = T("ap_ai_no_match");
      }
    } finally { pinAi.disabled = false; setBtnLabel(pinAi, old); }
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
    saveBtn.disabled = true;
    const oldSave = saveBtn.textContent;
    saveBtn.textContent = T("ap_saving");
    try {
      const { data: { session } } = await sb.auth.getSession();
      const uid = session?.user?.id;
      if (!uid) throw new Error(T("ap_err_session_expired"));
      if (pin.lat == null || pin.lng == null) {
        // Send them to the section that is missing rather than only saying so.
        document.getElementById("atSecPin")?.scrollIntoView({ behavior: "smooth", block: "start" });
        throw new Error(T("at_err_no_pin"));
      }

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
        // Read off the chips rather than asked twice; see openForm().
        driver_included: kitHas("driver"),
        loaders_included: kitHas("loaders"),
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
        details: {
          v: 1,
          kit: window.TruckSpec
            ? window.TruckSpec.normalize(kit ? kit.read() : [])
            : [],
        },
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
      if (!saved || !saved.length) throw new Error(T("at_err_no_rows"));

      window.DataStore?.invalidateCache(["trucks"]);
      formMsg.className = "ap-msg is-ok";
      formMsg.textContent = T(editingId ? "at_msg_updated" : "at_msg_listed");
      formMsg.hidden = false;
      setTimeout(() => { closeForm(); loadMyTrucks(); }, 700);
    } catch (err) {
      formMsg.className = "ap-msg is-error";
      formMsg.textContent = err?.message || T("at_err_save");
      formMsg.hidden = false;
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = oldSave;
    }
  });

  /** Does the kit list state this, whichever way it was added? */
  function kitHas(key) {
    return !!kit && kit.read().indexOf(key) >= 0;
  }

  async function deleteTruck(t) {
    if (!t || !confirm(fill(T("at_confirm_delete"), { title: t.title || T("at_untitled") }))) return;
    const { data: { session } } = await sb.auth.getSession();
    const uid = session?.user?.id;
    const { error } = await sb.from("trucks").delete().eq("id", t.id).eq("owner_user_id", uid);
    if (error) { alert(T("at_err_delete") + " " + error.message); return; }
    // best-effort photo cleanup
    const paths = [t.photo, ...(t.photos || [])].filter((p) => p && !p.startsWith("http") && !p.startsWith("data/"));
    if (paths.length) sb.storage.from(bucket()).remove(paths).catch(() => {});
    window.DataStore?.invalidateCache(["trucks"]);
    loadMyTrucks();
  }
};
