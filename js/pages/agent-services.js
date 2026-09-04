// Offer a daily service — provider-authenticated CRUD over public.services, the
// services companion to agent-trucks.js. Sign in, then add services with photos
// and a base-location pin; customers browse them on services.html.
//
// Mirrors agent-trucks.js: Supabase email auth, owner_user_id = auth.uid()
// inserts (RLS-enforced), photo upload into the `service-photos` bucket, the 48h
// subscription banner, and a setup card with the SQL when the `services` table
// hasn't been applied yet.
//
// Every visible string on this screen goes through t(). It used to be written
// in English here and nowhere else, which meant a Swahili provider met an
// entirely English portal the moment they signed in — the one screen in the
// app that asks somebody to type for ten minutes.

window.initAgentServicesPage = async () => {
  const sb = window.DataStore?.sb;

  // t() with a hard fallback: this file runs before nothing, but a missing key
  // must show the English word rather than the key name.
  const T = (k, en) => {
    const v = window.t ? window.t(k) : k;
    return v === k && en ? en : v;
  };
  // "{email} already exists" → the email. i18n.js keeps the braces so a
  // translator can move the value inside the sentence.
  const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

  const SETUP_SQL = `-- Pawa Daily Services — public.services table + service-photos storage bucket.
create table if not exists public.services (
  id text primary key,
  title text not null,
  category text not null default 'other'
    check (category in ('cleaning','plumbing','electrical','carpentry','painting',
      'gardening','moving_help','laundry','cooking','tutoring','beauty','security',
      'childcare','appliance_repair','other')),
  price_tzs bigint not null default 0 check (price_tzs >= 0),
  currency text not null default 'TZS',
  rate_type text not null default 'per_job' check (rate_type in ('hourly','daily','per_job','monthly')),
  negotiable boolean not null default true,
  experience_years int,
  availability text,
  service_area text not null default 'within_city'
    check (service_area in ('within_city','region_wide','cross_region')),
  region text references public.regions(name) on update cascade,
  area text, address text, lat double precision, lng double precision,
  photo text, photos text[] not null default '{}'::text[],
  description text, verified boolean not null default false,
  owner jsonb not null default '{}'::jsonb,
  owner_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.services enable row level security;
drop policy if exists "services readable" on public.services;
drop policy if exists "services owner insert" on public.services;
drop policy if exists "services owner update" on public.services;
drop policy if exists "services owner delete" on public.services;
create policy "services readable" on public.services for select using (true);
create policy "services owner insert" on public.services for insert
  with check (auth.uid() is not null and owner_user_id = auth.uid());
create policy "services owner update" on public.services for update
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy "services owner delete" on public.services for delete
  using (owner_user_id = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('service-photos','service-photos',true,20971520,array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = excluded.public;
drop policy if exists "service-photos readable" on storage.objects;
create policy "service-photos readable" on storage.objects for select using (bucket_id = 'service-photos');
drop policy if exists "service-photos upload" on storage.objects;
create policy "service-photos upload" on storage.objects for insert
  with check (bucket_id = 'service-photos' and auth.uid() is not null);`;

  // Icons. Lucide-style stroke SVGs, so they take currentColor, scale with the
  // type beside them, and read the same on every phone. This is what replaced
  // the category emoji map that used to sit here.
  const IC = {
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
    empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.3L3 18l3 3 6.4-6.3a4 4 0 0 0 5.3-5.4l-2.9 2.9-2.1-2.1z"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 20h20z"/><path d="M12 9v5M12 17.2v.1"/></svg>',
  };

  const $ = (id) => document.getElementById(id);
  const authCard = $("asAuthCard"), dashboard = $("asDashboard"), formSection = $("asFormSection");
  const warnEl = $("asWarn"), listEl = $("asList"), userEmailEl = $("asUserEmail");
  const tabSignIn = $("tabSignIn"), tabSignUp = $("tabSignUp");
  const authForm = $("asAuthForm"), authEmail = $("asEmail"), authPassword = $("asPassword");
  const authPasswordConfirm = $("asPasswordConfirm"), authPasswordConfirmRow = $("asPasswordConfirmRow");
  const authSubmit = $("asAuthSubmit"), authMsg = $("asAuthMsg");
  const newBtn = $("asNewBtn"), signOutBtn = $("asSignOut");
  const form = $("asForm"), formTitle = $("asFormTitle"), formMsg = $("asFormMsg");
  const photoInput = $("asPhotoInput"), photoGrid = $("asPhotoGrid");
  const fRegion = $("asRegion");
  const pinSearch = $("asPinSearch"), pinResults = $("asPinResults");
  const pinMapEl = $("asPinMap"), pinCoords = $("asPinCoords"), pinGps = $("asPinGps");
  const includesEl = $("asIncludes"), locDoorsEl = $("asLocDoors");
  const fCategory = $("asCategory"), fCategoryOtherRow = $("asCategoryOtherRow");

  const MAX_PHOTOS = 8;

  let authMode = "signin";
  let editingId = null;
  let photoState = [];
  let agentProfile = null;            // region + area this agent operates in
  let pin = { lat: null, lng: null };
  let pinMap = null, pinMarker = null;
  let rail = null;
  let includes = null;                // the "what the customer gets" pick list
  let doors = null;                   // the three ways a location can arrive

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  // The label of a button is now a span beside an icon, so setting textContent
  // on the button would delete the icon with it.
  function setBtnLabel(btn, text) {
    const span = btn?.querySelector("span");
    if (span) span.textContent = text; else if (btn) btn.textContent = text;
  }
  function btnLabel(btn) {
    return btn?.querySelector("span")?.textContent ?? btn?.textContent ?? "";
  }
  function showFatal(msg) {
    if (!warnEl) { alert(msg); return; }
    warnEl.innerHTML =
      `<div class="ap-note ap-note--warn"><span class="ap-note__ic">${IC.warn}</span>` +
      `<span><strong>${esc(T("ap_error"))}</strong> ${esc(String(msg))}</span></div>`;
  }
  window.addEventListener("error", (e) => showFatal(e.message || T("ap_err_unknown")));
  window.addEventListener("unhandledrejection", (e) => showFatal(e.reason?.message || e.reason || T("ap_err_unknown")));

  signOutBtn?.addEventListener("click", async () => {
    if (!sb) { location.reload(); return; }
    await sb.auth.signOut().catch(() => {});
    setTimeout(() => location.reload(), 150);
  });
  newBtn?.addEventListener("click", () => openForm(null));
  $("asCancelBtn")?.addEventListener("click", () => closeForm());

  if (!sb) {
    authCard.hidden = false;
    setAuthMsg(esc(T("ap_msg_supabase_missing")), "error");
    authForm.querySelectorAll("input,button").forEach((el) => (el.disabled = true));
    return;
  }

  try {
    const regions = (await window.DataStore.getRegions?.()) || [];
    regions.forEach((r) => {
      const o = document.createElement("option"); o.value = r; o.textContent = r; fRegion.appendChild(o);
    });
  } catch (_) { /* provider can leave region blank */ }

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
      // First thing after sign-in: make sure the agent has declared the region
      // they belong to + the area they operate in. New listings inherit these
      // so searchers in that area find this provider's services.
      try { agentProfile = await window.AgentProfile?.ensure(sb); } catch (_) {}
      if (agentProfile?.region && fRegion && !fRegion.value) fRegion.value = agentProfile.region;
      await loadMyServices();
      checkSubscription();
      window.renderAgentClientTip?.({ mount: dashboard, id: "asClientTip", kind: "services" });
      window.renderFrameScout?.({ mount: dashboard, id: "asFrameScout", kind: "services" });
      window.renderAgentMessages?.({ sb, mount: dashboard });
      window.AgentDemandBoard?.load({ sb, agentProfile, mount: dashboard, kind: "services" });
    } else {
      authCard.hidden = false; dashboard.hidden = true; formSection.hidden = true;
    }
  }

  // Subscription / activation guard (shared banner): deactivation, lapsed
  // subscription, or the 48h pay-or-pause grace expiring → paywall (RLS also
  // hides the listings); during grace, a live countdown demanding payment.
  async function checkSubscription() {
    if (!sb) return;
    try {
      const { data } = await sb.rpc("my_agent_subscription");
      const sub = Array.isArray(data) ? data[0] : data;
      window.renderAgentSubBanner(sub, { mount: dashboard, id: "asSubPaywall", what: "listings" });
    } catch (_) { /* RPC not deployed yet — ignore */ }
  }

  tabSignIn.addEventListener("click", () => {
    authMode = "signin"; tabSignIn.classList.add("active"); tabSignUp.classList.remove("active");
    authSubmit.textContent = T("as_tab_signin"); authPassword.autocomplete = "current-password";
    if (authPasswordConfirmRow) authPasswordConfirmRow.hidden = true;
    setAuthMsg("", "");
  });
  tabSignUp.addEventListener("click", () => {
    authMode = "signup"; tabSignUp.classList.add("active"); tabSignIn.classList.remove("active");
    authSubmit.textContent = T("as_tab_signup"); authPassword.autocomplete = "new-password";
    if (authPasswordConfirmRow) { authPasswordConfirmRow.hidden = false; authPasswordConfirm.value = ""; }
    setAuthMsg("", "");
  });

  function setAuthMsg(html, kind) {
    const mod = kind === "error" ? "is-error" : (kind === "success" || kind === "ok") ? "is-ok" : "";
    authMsg.className = "auth-msg" + (mod && html ? " " + mod + " is-show" : "");
    authMsg.innerHTML = html || "";
  }
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
      `<button type="button" id="asResendVerify" class="ap-btn ap-btn--sm" style="margin-top:var(--space-2)">` +
      `${esc(T("ap_verify_resend"))}</button>`,
      kind || "success"
    );
    $("asResendVerify")?.addEventListener("click", () => resendVerification(email));
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
        const confirm = authPasswordConfirm ? authPasswordConfirm.value : password;
        if (password !== confirm) {
          setAuthMsg(esc(T("ap_err_pw_mismatch")), "error");
          return;
        }
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) {
          if (/already registered|already been registered|user already/i.test(error.message || "")) {
            authMode = "signin"; tabSignIn.click();
            setAuthMsg(fill(T("ap_err_email_exists"), { email: `<strong>${esc(email)}</strong>` }), "error");
            return;
          }
          throw error;
        }
        if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          authMode = "signin"; tabSignIn.click();
          setAuthMsg(fill(T("ap_err_email_exists"), { email: `<strong>${esc(email)}</strong>` }), "error");
          return;
        }
        if (data?.session) return;
        authMode = "signin"; tabSignIn.click();
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

  // ---- list my services ----------------------------------------------------
  async function loadMyServices() {
    listEl.setAttribute("aria-busy", "true");
    listEl.innerHTML = `<p class="ap-hint">${esc(T("as_loading"))}</p>`;
    const { data: { session } } = await sb.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) return;
    const { data, error } = await sb.from("services").select("*")
      .eq("owner_user_id", uid).order("created_at", { ascending: false });
    listEl.setAttribute("aria-busy", "false");
    if (error) {
      if (/relation .* does not exist|schema cache|could not find the table/i.test(error.message)) {
        renderSetupCard();
        return;
      }
      listEl.innerHTML =
        `<div class="ap-msg is-error">${esc(T("as_load_fail"))} ${esc(error.message)}</div>`;
      return;
    }
    newBtn.hidden = false;
    if (!data.length) {
      listEl.innerHTML =
        `<div class="ap-empty">${IC.empty}<h3>${esc(T("as_empty_h"))}</h3>` +
        `<p>${esc(T("as_empty_p"))}</p></div>`;
      return;
    }
    listEl.innerHTML = data.map((t) => {
      const img = t.photo ? window.DataStore.servicePhotoUrl(t.photo) : "";
      const where = [t.area, t.region].filter(Boolean).join(", ");
      return `<article class="ap-card">
        <div class="ap-card__photo" data-empty="${esc(T("ap_no_photo"))}"
             style="${img ? `background-image:url('${esc(img)}')` : ""}"></div>
        <div class="ap-card__body">
          <h4 class="ap-card__title">${esc(t.title || T("as_untitled"))}</h4>
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
      b.addEventListener("click", () => deleteService(data.find((x) => x.id === b.dataset.del))));
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
            <p>${esc(T("as_setup_p"))}</p>
          </div>
        </div>
        <div class="ap-inline" style="margin-bottom:var(--space-3)">
          <a class="ap-btn ap-btn--brand" target="_blank" rel="noopener" href="${sqlEditorUrl()}">${esc(T("ap_setup_open"))}</a>
          <button id="asSetupCopy" class="ap-btn" type="button"><span>${esc(T("ap_setup_copy"))}</span></button>
          <button id="asSetupReload" class="ap-btn" type="button">${esc(T("ap_setup_reload"))}</button>
        </div>
        <pre class="ap-code" id="asSetupSql">${esc(SETUP_SQL)}</pre>
      </div>`;
    $("asSetupCopy")?.addEventListener("click", async () => {
      const b = $("asSetupCopy");
      try {
        await navigator.clipboard.writeText(SETUP_SQL);
        setBtnLabel(b, T("ap_setup_copied"));
        setTimeout(() => setBtnLabel(b, T("ap_setup_copy")), 1500);
      } catch (_) { alert(T("ap_setup_copy_fail")); }
    });
    $("asSetupReload")?.addEventListener("click", () => { newBtn.hidden = false; loadMyServices(); });
  }

  // ---- form ----------------------------------------------------------------
  function openForm(t) {
    editingId = t?.id || null;
    formTitle.textContent = T(t ? "as_form_title_edit" : "as_form_title_new");
    formMsg.hidden = true;
    dashboard.hidden = true; formSection.hidden = false;

    $("asTitle").value = t?.title || "";
    $("asCategory").value = t?.category || "cleaning";
    $("asExperience").value = t?.experience_years ?? "";
    $("asPrice").value = t?.price_tzs ?? "";
    $("asRate").value = t?.rate_type || "per_job";
    $("asService").value = t?.service_area || "within_city";
    $("asAvailability").value = t?.availability || "";
    $("asNegotiable").checked = t ? !!t.negotiable : true;
    fRegion.value = t?.region || "";
    $("asArea").value = t?.area || "";
    $("asAddress").value = t?.address || "";
    $("asDescription").value = t?.description || "";
    // The spec sheet. `details` is the same shape houses.details has: a small
    // jsonb bag beside the columns, so a fact that has no column of its own is
    // still a field rather than a sentence in a paragraph.
    const det = (t && t.details && typeof t.details === "object") ? t.details : {};
    $("asCategoryOther").value = det.categoryOther || "";
    syncCategoryOther();
    mountIncludes(window.ServiceSpec ? window.ServiceSpec.normalize(det.includes) : []);
    $("asOwnerName").value = t?.owner?.name || "";
    $("asOwnerPhone").value = t?.owner?.phone || "";
    $("asOwnerWa").value = t?.owner?.whatsapp || "";

    pin = { lat: Number.isFinite(+t?.lat) ? +t.lat : null, lng: Number.isFinite(+t?.lng) ? +t.lng : null };
    updatePinCoords();

    const existing = (Array.isArray(t?.photos) && t.photos.length ? t.photos : (t?.photo ? [t.photo] : []));
    photoState = existing.map((p) => ({ path: p }));
    renderPhotoGrid();

    initPinMap();
    mountDoors();
    // The rail is only useful once the form exists on screen, and it has to
    // re-read the ticks after a listing is loaded into it.
    rail = rail || window.AgentPortalRail?.mount({ rail: "#asRail", form: "#asForm" });
    rail?.refresh();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function closeForm() {
    formSection.hidden = true; dashboard.hidden = false;
  }

  photoInput.addEventListener("change", () => {
    [...photoInput.files].forEach((file) => {
      if (photoState.length >= MAX_PHOTOS) return;
      const reader = new FileReader();
      reader.onload = () => { photoState.push({ file, preview: reader.result }); renderPhotoGrid(); };
      reader.readAsDataURL(file);
    });
    photoInput.value = "";
  });
  function renderPhotoGrid() {
    photoGrid.innerHTML = photoState.map((p, i) => {
      const url = p.preview || window.DataStore.servicePhotoUrl(p.path);
      return `<div class="ap-tile" style="background-image:url('${esc(url)}')">
        ${i === 0 ? `<span class="ap-tile__flag">${esc(T("ap_cover"))}</span>` : ""}
        <button type="button" class="ap-tile__x" data-rm="${i}"
                aria-label="${esc(T("ap_remove_photo"))}">${IC.x}</button>
      </div>`;
    }).join("");
    photoGrid.querySelectorAll("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => { photoState.splice(+b.dataset.rm, 1); renderPhotoGrid(); }));
    $("asPhotoAdd")?.classList.toggle("is-full", photoState.length >= MAX_PHOTOS);
  }

  // ==========================================================================
  //  WHAT THE CUSTOMER GETS
  //
  //  Every fact behind a booking used to land in the free paragraph: own
  //  tools, a receipt, Sunday work, a guarantee. There it is invisible to
  //  search, impossible to compare across providers, and gone the moment the
  //  paragraph gets long. js/lib/offer-spec.js is the catalogue and
  //  js/lib/pick-list.js is the one shape a catalogue is allowed to take here:
  //  a few offered, a box for the provider's own words, the rest folded.
  // ==========================================================================
  function mountIncludes(values) {
    const spec = window.ServiceSpec;
    if (!includesEl || !spec || !window.PickList) return;
    includesEl.innerHTML = window.PickList.html({
      question: T("as_inc_q"), help: T("as_inc_help"),
      emptyLabel: T("pk_none"), ownLabel: T("pk_add"), moreLabel: T("pk_more"),
      top: spec.top(), groups: spec.rest(),
    });
    includes = window.PickList.wire(includesEl.firstElementChild, {
      label: spec.label, removeLabel: T("pk_remove"), values: values || [],
    });
  }

  // "Something else" saved as `other` and left the trade itself with nowhere
  // to go. The category column has a CHECK behind it, so the words go on the
  // spec sheet beside the characteristics rather than into the enum.
  function syncCategoryOther() {
    if (!fCategoryOtherRow || !fCategory) return;
    fCategoryOtherRow.hidden = fCategory.value !== "other";
  }
  fCategory?.addEventListener("change", syncCategoryOther);

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
    if (pinMap) {
      if (!pinMarker) {
        pinMarker = L.marker([lat, lng], { draggable: true }).addTo(pinMap);
        pinMarker.on("dragend", () => { const ll = pinMarker.getLatLng(); pin = { lat: ll.lat, lng: ll.lng }; updatePinCoords(); });
      } else {
        pinMarker.setLatLng([lat, lng]);
      }
      if (recenter) pinMap.setView([lat, lng], 14);
    }
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
  //  The pin had three sources and every one of them needed the provider to be
  //  standing on it. A fundi whose phone never leaves the workshop, or whose
  //  base is the yard his brother watches, had no way in at all. The shared
  //  module opens the same three doors agent-houses.html has: a code read down
  //  a phone, a pin already sitting in a P-Message thread, and a link the
  //  person there taps once. It owns no map, which is why the same file serves
  //  this Leaflet page and the MapLibre one.
  // ==========================================================================
  function mountDoors() {
    if (doors || !locDoorsEl || !window.PlaceDoors) return;
    doors = window.PlaceDoors.mount({
      into: locDoorsEl,
      sb: sb,
      purpose: "service_pin",
      title: () => $("asTitle").value.trim(),
      current: () => (pin.lat == null ? null : pin),
      onPick: (place) => setPin(Number(place.lat), Number(place.lng), true),
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
  const pinAi = $("asPinAi"), pinAiMsg = $("asPinAiMsg");
  pinAi?.addEventListener("click", async () => {
    const q = (pinSearch.value || "").trim();
    if (!q) { pinSearch.focus(); return; }
    if (!window.AI?.locate) { if (pinAiMsg) pinAiMsg.textContent = T("ap_ai_unavailable"); return; }
    const old = btnLabel(pinAi);
    pinAi.disabled = true; setBtnLabel(pinAi, T("ap_locating"));
    if (pinAiMsg) pinAiMsg.textContent = "";
    try {
      const loc = await window.AI.locate(q, { regions: window.APP_CONFIG?.REGIONS });
      if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
        setPin(loc.lat, loc.lng, true);
        if (pinResults) pinResults.hidden = true;
        if (pinAiMsg) {
          const what = loc.label || T("ap_ai_pinned");
          pinAiMsg.textContent = loc.answer
            ? `${what}. ${loc.answer} ${T("ap_ai_drag")}`
            : `${what}. ${T("ap_ai_drag")}`;
        }
      } else if (pinAiMsg) {
        pinAiMsg.textContent = T("ap_ai_no_match");
      }
    } finally { pinAi.disabled = false; setBtnLabel(pinAi, old); }
  });

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
            if (!$("asArea").value && s.name) $("asArea").value = s.name;
            pinResults.hidden = true; pinSearch.value = s.name;
          }));
      } catch (_) { pinResults.hidden = true; }
    }, 220);
  });
  document.addEventListener("click", (e) => {
    if (!pinResults.contains(e.target) && e.target !== pinSearch) pinResults.hidden = true;
  });

  // ---- upload + save -------------------------------------------------------
  function bucket() { return (window.APP_CONFIG && window.APP_CONFIG.SERVICE_PHOTOS_BUCKET) || "service-photos"; }
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
    const saveBtn = $("asSaveBtn");
    saveBtn.disabled = true;
    const oldSave = saveBtn.textContent;
    saveBtn.textContent = T("ap_saving");
    try {
      const { data: { session } } = await sb.auth.getSession();
      const uid = session?.user?.id;
      if (!uid) throw new Error(T("ap_err_session_expired"));
      if (pin.lat == null || pin.lng == null) {
        // Send them to the section that is missing rather than only saying so.
        document.getElementById("asSecPin")?.scrollIntoView({ behavior: "smooth", block: "start" });
        throw new Error(T("as_err_no_pin"));
      }

      const paths = [];
      for (const p of photoState) {
        if (p.path) paths.push(p.path);
        else if (p.file) paths.push(await uploadFile(p.file, uid));
      }

      const row = {
        id: editingId || ("s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6)),
        title: $("asTitle").value.trim(),
        category: $("asCategory").value,
        price_tzs: parseInt($("asPrice").value, 10) || 0,
        currency: "TZS",
        rate_type: $("asRate").value,
        negotiable: $("asNegotiable").checked,
        experience_years: $("asExperience").value ? parseInt($("asExperience").value, 10) : null,
        availability: $("asAvailability").value.trim() || null,
        service_area: $("asService").value,
        // Fall back to the agent's declared region / operating area so the
        // listing always surfaces for searchers in the area they work in.
        region: fRegion.value || agentProfile?.region || null,
        area: $("asArea").value.trim() || agentProfile?.area_of_operations || null,
        address: $("asAddress").value.trim() || null,
        lat: pin.lat, lng: pin.lng,
        photo: paths[0] || null,
        photos: paths,
        description: $("asDescription").value.trim() || null,
        details: {
          v: 1,
          includes: window.ServiceSpec
            ? window.ServiceSpec.normalize(includes ? includes.read() : [])
            : [],
          // Only when the category is the one that cannot say what it is.
          categoryOther: $("asCategory").value === "other"
            ? ($("asCategoryOther").value.trim() || null) : null,
        },
        owner: {
          name: $("asOwnerName").value.trim(),
          phone: $("asOwnerPhone").value.trim(),
          whatsapp: $("asOwnerWa").value.trim() || $("asOwnerPhone").value.trim(),
        },
        owner_user_id: uid,
      };

      const q = editingId
        ? sb.from("services").update(row).eq("id", editingId).eq("owner_user_id", uid).select()
        : sb.from("services").insert(row).select();
      const { data: saved, error } = await q;
      if (error) throw error;
      if (!saved || !saved.length) throw new Error(T("as_err_no_rows"));

      window.DataStore?.invalidateCache(["services"]);
      formMsg.className = "ap-msg is-ok";
      formMsg.textContent = T(editingId ? "as_msg_updated" : "as_msg_listed");
      formMsg.hidden = false;
      setTimeout(() => { closeForm(); loadMyServices(); }, 700);
    } catch (err) {
      formMsg.className = "ap-msg is-error";
      formMsg.textContent = err?.message || T("as_err_save");
      formMsg.hidden = false;
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = oldSave;
    }
  });

  async function deleteService(t) {
    if (!t) return;
    if (!confirm(fill(T("as_confirm_delete"), { title: t.title || T("as_untitled") }))) return;
    const { data: { session } } = await sb.auth.getSession();
    const uid = session?.user?.id;
    const { error } = await sb.from("services").delete().eq("id", t.id).eq("owner_user_id", uid);
    if (error) { alert(T("as_err_delete") + " " + error.message); return; }
    const paths = [t.photo, ...(t.photos || [])].filter((p) => p && !p.startsWith("http") && !p.startsWith("data/"));
    if (paths.length) sb.storage.from(bucket()).remove(paths).catch(() => {});
    window.DataStore?.invalidateCache(["services"]);
    loadMyServices();
  }
};
