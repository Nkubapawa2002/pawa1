// Offer a daily service — provider-authenticated CRUD over public.services, the
// services companion to agent-trucks.js. Sign in, then add services with photos
// and a base-location pin; customers browse them on services.html.
//
// Mirrors agent-trucks.js: Supabase email auth, owner_user_id = auth.uid()
// inserts (RLS-enforced), photo upload into the `service-photos` bucket, the 48h
// subscription banner, and a setup card with the SQL when the `services` table
// hasn't been applied yet.

window.initAgentServicesPage = async () => {
  const sb = window.DataStore?.sb;

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

  const CAT_EMOJI = {
    cleaning: "", plumbing: "", electrical: "", carpentry: "", painting: "",
    gardening: "", moving_help: "", laundry: "", cooking: "", tutoring: "",
    beauty: "", security: "", childcare: "", appliance_repair: "", other: "",
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

  let authMode = "signin";
  let editingId = null;
  let photoState = [];
  let pin = { lat: null, lng: null };
  let pinMap = null, pinMarker = null;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function showFatal(msg) {
    if (!warnEl) { alert(msg); return; }
    warnEl.innerHTML = `<div class="as-msg error"><strong>Error:</strong> ${esc(String(msg))}</div>`;
  }
  window.addEventListener("error", (e) => showFatal(e.message || "Unknown JS error"));
  window.addEventListener("unhandledrejection", (e) => showFatal(e.reason?.message || e.reason || "Promise rejected"));

  signOutBtn?.addEventListener("click", async () => {
    if (!sb) { location.reload(); return; }
    await sb.auth.signOut().catch(() => {});
    setTimeout(() => location.reload(), 150);
  });
  newBtn?.addEventListener("click", () => openForm(null));
  $("asCancelBtn")?.addEventListener("click", () => closeForm());

  if (!sb) {
    authCard.hidden = false;
    setAuthMsg("Supabase isn't configured, so sign-in is unavailable.", "error");
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
  sb.auth.onAuthStateChange((_e, session) => routeOnAuth(session));

  async function routeOnAuth(session) {
    const s = session ?? (await sb.auth.getSession()).data.session;
    if (s?.user) {
      authCard.hidden = true; dashboard.hidden = false; formSection.hidden = true;
      userEmailEl.textContent = s.user.email || "—";
      await loadMyServices();
      checkSubscription();
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
      `<button type="button" id="asResendVerify" class="as-btn" style="margin-top:8px;">Resend verification email</button>`,
      kind || "success"
    );
    $("asResendVerify")?.addEventListener("click", () => resendVerification(email));
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
        const confirm = authPasswordConfirm ? authPasswordConfirm.value : password;
        if (password !== confirm) {
          setAuthMsg("The two passwords don't match. Please re-enter them.", "error");
          return;
        }
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) {
          if (/already registered|already been registered|user already/i.test(error.message || "")) {
            authMode = "signin"; tabSignIn.click();
            setAuthMsg(`An account with <strong>${esc(email)}</strong> already exists. Switch to <strong>Sign in</strong> and enter your password.`, "error");
            return;
          }
          throw error;
        }
        if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          authMode = "signin"; tabSignIn.click();
          setAuthMsg(`An account with <strong>${esc(email)}</strong> already exists. Switch to <strong>Sign in</strong> and enter your password.`, "error");
          return;
        }
        if (data?.session) return;
        authMode = "signin"; tabSignIn.click();
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

  // ---- list my services ----------------------------------------------------
  async function loadMyServices() {
    listEl.setAttribute("aria-busy", "true");
    listEl.innerHTML = `<div class="as-hint">Loading your services…</div>`;
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
      listEl.innerHTML = `<div class="as-msg error">Couldn't load your services: ${esc(error.message)}</div>`;
      return;
    }
    newBtn.hidden = false;
    if (!data.length) {
      listEl.innerHTML = `<div class="as-hint">No services yet. Tap <strong>+ New service</strong> to add your first one.</div>`;
      return;
    }
    listEl.innerHTML = data.map((t) => {
      const img = t.photo ? window.DataStore.servicePhotoUrl(t.photo) : "";
      return `<div class="as-tile">
        <div class="as-tile-photo" style="${img ? `background-image:url('${esc(img)}')` : ""}">${img ? "" : (CAT_EMOJI[t.category] || "")}</div>
        <div class="as-tile-body">
          <h4>${esc(t.title || "Service")}</h4>
          <div class="as-hint" style="margin:0">${esc([t.area, t.region].filter(Boolean).join(", ") || "—")}</div>
          <div class="as-tile-actions">
            <button data-edit="${esc(t.id)}">Edit</button>
            <button data-del="${esc(t.id)}" style="color:#b91c1c">Delete</button>
          </div>
        </div></div>`;
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
      <div class="as-card as-setup" style="grid-column:1/-1">
        <h3 style="margin-top:0"> One-time setup needed</h3>
        <p class="as-hint">The <code>services</code> table doesn't exist yet. Run this SQL once in your Supabase SQL editor, then reload.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
          <a class="as-btn as-btn-brand" target="_blank" rel="noopener" href="${sqlEditorUrl()}">Open SQL editor</a>
          <button id="asSetupCopy" class="as-btn" type="button">Copy SQL</button>
          <button id="asSetupReload" class="as-btn" type="button">I've run it — reload</button>
        </div>
        <pre id="asSetupSql">${esc(SETUP_SQL)}</pre>
      </div>`;
    $("asSetupCopy")?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(SETUP_SQL); const b = $("asSetupCopy"); b.textContent = "Copied!"; setTimeout(() => (b.textContent = "Copy SQL"), 1500); }
      catch (_) { alert("Select the SQL below and copy it manually."); }
    });
    $("asSetupReload")?.addEventListener("click", () => { newBtn.hidden = false; loadMyServices(); });
  }

  // ---- form ----------------------------------------------------------------
  function openForm(t) {
    editingId = t?.id || null;
    formTitle.textContent = t ? "Edit service" : "Add a service";
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
    $("asOwnerName").value = t?.owner?.name || "";
    $("asOwnerPhone").value = t?.owner?.phone || "";
    $("asOwnerWa").value = t?.owner?.whatsapp || "";

    pin = { lat: Number.isFinite(+t?.lat) ? +t.lat : null, lng: Number.isFinite(+t?.lng) ? +t.lng : null };
    updatePinCoords();

    const existing = (Array.isArray(t?.photos) && t.photos.length ? t.photos : (t?.photo ? [t.photo] : []));
    photoState = existing.map((p) => ({ path: p }));
    renderPhotoGrid();

    initPinMap();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function closeForm() {
    formSection.hidden = true; dashboard.hidden = false;
  }

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
      const url = p.preview || window.DataStore.servicePhotoUrl(p.path);
      return `<div class="as-photo-cell" style="background-image:url('${esc(url)}')"><button type="button" data-rm="${i}">×</button></div>`;
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
  pinGps.addEventListener("click", async () => {
    pinGps.disabled = true; const old = pinGps.textContent; pinGps.textContent = "Locating…";
    try {
      const fix = await window.pawaLocate.best({ targetAccuracy: 50, hardTimeout: 12000 });
      setPin(fix.lat, fix.lng, true);
    } catch (e) { alert((e && e.message) || "Couldn't get your location."); }
    finally { pinGps.disabled = false; pinGps.textContent = old; }
  });

  // AI-assisted pin: describe the location in plain words → AI resolves → drop pin.
  const pinAi = $("asPinAi"), pinAiMsg = $("asPinAiMsg");
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
    saveBtn.disabled = true; saveBtn.textContent = "Saving…";
    try {
      const { data: { session } } = await sb.auth.getSession();
      const uid = session?.user?.id;
      if (!uid) throw new Error("Your session expired — please sign in again.");
      if (pin.lat == null || pin.lng == null) throw new Error("Please drop a pin for where you're based.");

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
        region: fRegion.value || null,
        area: $("asArea").value.trim() || null,
        address: $("asAddress").value.trim() || null,
        lat: pin.lat, lng: pin.lng,
        photo: paths[0] || null,
        photos: paths,
        description: $("asDescription").value.trim() || null,
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
      if (!saved || !saved.length) {
        throw new Error("Save returned no rows — check that the services table + RLS policies are applied (run the setup SQL).");
      }

      window.DataStore?.invalidateCache(["services"]);
      formMsg.className = "as-msg success";
      formMsg.textContent = editingId ? "Service updated." : "Service listed! Customers nearby can now find it.";
      formMsg.hidden = false;
      setTimeout(() => { closeForm(); loadMyServices(); }, 700);
    } catch (err) {
      formMsg.className = "as-msg error";
      formMsg.textContent = err?.message || "Couldn't save the service.";
      formMsg.hidden = false;
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = "Save service";
    }
  });

  async function deleteService(t) {
    if (!t || !confirm(`Delete "${t.title || "this service"}"?`)) return;
    const { data: { session } } = await sb.auth.getSession();
    const uid = session?.user?.id;
    const { error } = await sb.from("services").delete().eq("id", t.id).eq("owner_user_id", uid);
    if (error) { alert("Delete failed: " + error.message); return; }
    const paths = [t.photo, ...(t.photos || [])].filter((p) => p && !p.startsWith("http") && !p.startsWith("data/"));
    if (paths.length) sb.storage.from(bucket()).remove(paths).catch(() => {});
    window.DataStore?.invalidateCache(["services"]);
    loadMyServices();
  }
};
