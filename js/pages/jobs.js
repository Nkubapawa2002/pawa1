// ============================================================================
//  Day Jobs (vibarua) board — jobs.html
//  - Companies post short-term jobs with a map pin, worker quota, pay & time
//  - Workers tap "I'll do it" to claim a slot: an atomic RPC (claim_day_job)
//    enforces the quota; the fill-up bar closes the job at the cap ("FULL")
//  - "Jobs near me" sorts by distance (haversine instantly, then upgraded to
//    real road km via OSRM — same pattern as the houses directory)
//  - Supabase Realtime keeps every open browser's bars in sync as slots fill
//  Backend: supabase/features/job/day_jobs.sql (tables + claim_day_job RPC + RLS)
// ============================================================================

// Tanzania, as one rectangle. The map is clamped to it and hasPin() measures
// against it, so a coordinate the map could never show is not treated as a
// place. One constant, because two copies of it would drift.
const TZ_BOUNDS = { minLng: 29.34, minLat: -11.75, maxLng: 40.45, maxLat: -0.99 };

window.initJobsPage = () => {
  const sb = window.DataStore?.sb;
  // Every sentence this page writes at runtime — the empty state and the two
  // failure states — goes through here, so the board speaks the language the
  // rest of the app is set to.
  // Some of those sentences carry a number or a name, and t() takes a key and
  // nothing else, so the substitution happens here rather than in i18n.js.
  const T = (k, vars) => {
    let out = window.t ? window.t(k) : k;
    if (vars) for (const name in vars) out = out.split("{" + name + "}").join(vars[name]);
    return out;
  };

  // Lucide-style stroke icons. Every mark on this board used to be an emoji;
  // stripping them left the labels with a leading space and the map pins with
  // nothing at all. These inherit currentColor, scale with the type beside
  // them, and are hidden from a screen reader, which reads the label instead.
  const ICON = {
    locate:    '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12h18"/>',
    plus:      '<path d="M12 5v14M5 12h14"/>',
    check:     '<path d="M4 12.5l5 5L20 6.5"/>',
    phone:     '<path d="M6.6 3h3l1.5 4-2 1.4a12 12 0 0 0 5.5 5.5l1.4-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.2 2 2 0 0 1 6.6 3z"/>',
    navigate:  '<path d="M3 11l18-8-8 18-2-8z"/>',
    calendar:  '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
    pin:       '<path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
    clipboard: '<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V3.5h6V5M9 11h6M9 15h4"/>',
    building:  '<path d="M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M15 21V10h3a2 2 0 0 1 2 2v9M3 21h18M8 7h3M8 11h3M8 15h3"/>',
    id:        '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M5.8 16c.5-1.4 1.7-2.1 3.2-2.1s2.7.7 3.2 2.1M15 10h4M15 14h3"/>',
    message:   '<path d="M21 14a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
    users:     '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20c0-3.3 2.9-5 6.5-5s6.5 1.7 6.5 5M17 5.2a3 3 0 0 1 0 6M18.5 20c0-2.6-1-4.2-2.7-5"/>'
  };
  const icon = (name) =>
    `<svg class="ji" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ""}</svg>`;

  // The label span inside an icon button. Swapping the button's textContent
  // would delete the icon with it, which is how "Locating…" used to lose it.
  const label = (btn) => btn?.querySelector("[data-i18n], .jb-label") || btn;

  const listEl    = document.getElementById("jobList");
  const countEl   = document.getElementById("jobsCount");
  const bannerEl  = document.getElementById("jobsBanner");
  const nearBtn   = document.getElementById("jobsNearBtn");
  const postBtn   = document.getElementById("jobsPostBtn");

  let jobs     = [];            // current rows
  let userLoc  = null;          // { lat, lng } after "near me"
  let map      = null;
  let markers  = new Map();     // job id -> maplibre marker
  let activeId = null;
  const roadKm = new Map();     // job id -> real road km (OSRM upgrade)
  let claimJob = null;          // job being claimed in the modal
  // job id -> { user_id, display_name } for posters who can be written to.
  // Only ever filled for a signed-in visitor, and only with posters who
  // already hold a P-Message key — see day_job_posters() for why that second
  // condition is the one that keeps this from being a disclosure.
  const posters = new Map();
  const posterAsked = new Set();   // ids already looked up, hit or miss

  // ---- Boot ----------------------------------------------------------------
  initMap();
  loadJobs();
  subscribeRealtime();

  nearBtn?.addEventListener("click", locateMe);
  postBtn?.addEventListener("click", openPostModal);
  document.getElementById("jobsMineBtn")?.addEventListener("click", openMineModal);

  // ==========================================================================
  //  Data
  // ==========================================================================
  async function loadJobs() {
    if (!sb) {
      listEl.setAttribute("aria-busy", "false");
      listEl.innerHTML = `<div class="jobs-empty">${T("jb_err_offline")}</div>`;
      return;
    }
    const { data, error } = await sb.from("day_jobs")
      .select("*")
      .in("status", ["open", "full"])
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(200);
    listEl.setAttribute("aria-busy", "false");
    if (error) {
      // Table not deployed yet. The person looking at this is a worker after a
      // day's pay, not an administrator — the SQL file to run is a note for us
      // and belongs in the console, not on their screen.
      try {
        console.error("[jobs] day_jobs unavailable — run supabase/features/job/day_jobs.sql:", error.message || error);
      } catch (_) {}
      listEl.innerHTML = `<div class="jobs-empty">${T("jb_err_setup")}</div>`;
      return;
    }
    jobs = data || [];
    render();
  }

  function subscribeRealtime() {
    if (!sb) return;
    try {
      sb.channel("pawa-day-jobs")
        .on("postgres_changes", { event: "*", schema: "public", table: "day_jobs" }, (payload) => {
          const row = payload?.new;
          if (!row) return;
          const i = jobs.findIndex(j => j.id === row.id);
          if (payload.eventType === "INSERT" && i < 0) jobs.unshift(row);
          else if (i >= 0) jobs[i] = row;
          render();
        })
        .subscribe();
    } catch (_) {}
  }

  // ==========================================================================
  //  Near me — sort by distance, upgrade to real road km
  // ==========================================================================
  async function locateMe() {
    if (!window.pawaLocate) return;
    nearBtn.disabled = true;
    label(nearBtn).textContent = T("jb_locating");
    try {
      const fix = await pawaLocate.bestOrApprox({ targetAccuracy: 60, maxWaitMs: 12000 });
      userLoc = { lat: fix.lat, lng: fix.lng };
      render();
      flash("locate", T("jb_sorted_t"), T("jb_sorted_d"));
      enrichRoadKm();
      if (map) {
        new maplibregl.Marker({ color: "#1e40af" }).setLngLat([fix.lng, fix.lat]).addTo(map);
        map.easeTo({ center: [fix.lng, fix.lat], zoom: 12 });
      }
    } catch (err) {
      alert(pawaLocate.message ? pawaLocate.message(err) : (err?.message || T("jb_loc_fail")));
    } finally {
      nearBtn.disabled = false;
      label(nearBtn).textContent = T("jb_near");
    }
  }

  async function enrichRoadKm() {
    if (!userLoc || !window.pawaRoute) return;
    const targets = jobs.filter(j => hasPin(j) && !roadKm.has(j.id)).slice(0, 40);
    if (!targets.length) return;
    try {
      const kms = await pawaRoute.table(userLoc, targets.map(j => ({ lat: +j.lat, lng: +j.lng })));
      let changed = false;
      targets.forEach((j, i) => {
        if (Number.isFinite(kms?.[i])) { roadKm.set(j.id, kms[i]); changed = true; }
      });
      if (changed) render();
    } catch (_) {}
  }

  /**
   * Does this job have a real map pin?
   *
   * day_jobs.lat/lng are nullable, and `+null` is 0, which IS finite — so the
   * old test said yes to every job posted without coordinates and dropped a
   * marker on Null Island. One such row was enough to break the board: the
   * fitBounds below then spanned the Gulf of Guinea to Dar es Salaam and the
   * map opened on the Atlantic, and the card grew a Navigate button pointing
   * at "null,null". A pin counts only if it is inside the country the map
   * will actually show.
   */
  function hasPin(j) {
    if (j?.lat == null || j?.lng == null) return false;
    const lat = +j.lat, lng = +j.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    return lat >= TZ_BOUNDS.minLat && lat <= TZ_BOUNDS.maxLat
        && lng >= TZ_BOUNDS.minLng && lng <= TZ_BOUNDS.maxLng;
  }
  function distOf(j) {
    if (!userLoc || !hasPin(j)) return Infinity;
    const rk = roadKm.get(j.id);
    return rk != null ? rk : haversineKm(userLoc.lat, userLoc.lng, +j.lat, +j.lng);
  }

  // ==========================================================================
  //  Render — list + map markers
  // ==========================================================================
  function render() {
    const rows = [...jobs];
    if (userLoc) rows.sort((a, b) => distOf(a) - distOf(b));

    const openSlots = rows.reduce((sum, j) => sum + Math.max(0, j.workers_needed - j.claimed_count), 0);
    countEl.textContent = rows.length
      ? `${rows.length === 1 ? T("jb_one_job") : T("jb_n_jobs", { n: rows.length })} · ${T("jb_n_slots", { n: openSlots })}`
      : "";

    if (!rows.length) {
      listEl.innerHTML = `<div class="jobs-empty">${T("jb_empty")}</div>`;
      renderMarkers(rows);
      return;
    }

    listEl.innerHTML = rows.map(cardHtml).join("");

    // Wire claim + focus
    listEl.querySelectorAll(".job-claim-btn:not([disabled])").forEach(btn => {
      btn.addEventListener("click", () => openClaimModal(jobs.find(j => String(j.id) === btn.dataset.id)));
    });
    listEl.querySelectorAll(".job-card").forEach(card => {
      card.addEventListener("click", (e) => {
        if (e.target.closest("button, a")) return;
        focusJob(card.dataset.id);
      });
    });

    renderMarkers(rows);
    paintPosterButtons();
    findPosters(rows);
  }

  // Jobs THIS device already claimed → { jobId: workerCode } so the worker
  // can always re-read their on-site number.
  function myClaims() {
    try { return JSON.parse(localStorage.getItem("pawa_my_claims") || "{}"); }
    catch { return {}; }
  }

  /**
   * Who, of the people on screen, can actually be written to.
   *
   * A day job posted before the board had owners belongs to a phone number and
   * nobody else — there is no account to message and no button to draw. One
   * lookup for the whole list rather than one per card, and each id is asked
   * about once: a miss is an answer, and re-asking it on every redraw would be
   * a request per card per render for a result that does not change.
   *
   * Skipped entirely for a signed-out visitor. day_job_posters() would return
   * nothing for them anyway — that fence is in the database, not here — so
   * this is about not making the request, not about trusting the client.
   */
  async function findPosters(rows) {
    if (!sb) return;
    const want = rows.map((j) => Number(j.id)).filter((id) => id && !posterAsked.has(id));
    if (!want.length) return;
    // Auth.getSession() resolves to the session itself, or null — not to a
    // { data } envelope. Destructuring one out of it yields undefined, which
    // reads as "signed out" for everybody and draws the button for nobody.
    try {
      if (!window.Auth || !(await window.Auth.getSession())) return;
    } catch (_) { return; }

    want.forEach((id) => posterAsked.add(id));
    try {
      const { data, error } = await sb.rpc("day_job_posters", { p_job_ids: want });
      if (error) throw error;
      (data || []).forEach((r) => posters.set(Number(r.job_id), r));
    } catch (_) {
      // A failed lookup means no Message buttons this time round, which is the
      // board exactly as it was before this feature. Nothing to say to a
      // worker about it, so nothing is said.
      return;
    }
    paintPosterButtons();
  }

  // The link itself. Built in one place because it is drawn from two — once
  // inline when the answer is already known, once injected when it arrives
  // after the cards do.
  function posterLinkHtml(p) {
    // The URL comes from js/lib/pm-reach.js, which is where the same link is
    // built for a house, a truck and a service. The board keeps its own class
    // and its own one-word label — what it stops owning is the shape of the
    // link, so all four catalogues cannot drift apart.
    const href = window.PMReach
      ? window.PMReach.href(p.user_id)
      : `p-message.html?to=${encodeURIComponent(p.user_id)}`;
    return `<a class="btn btn-outline job-msg-btn" data-to="${esc(p.user_id)}"
      href="${esc(href)}">${icon("message")}<span>${esc(T("jb_message"))}</span></a>`;
  }

  /**
   * Put the button on cards that are already drawn.
   *
   * It goes immediately after Call, not at the end: Call and Message are the
   * two ways to reach a person and belong together, while Navigate answers a
   * different question and can sit after them both.
   */
  function paintPosterButtons() {
    if (!listEl) return;
    listEl.querySelectorAll(".job-card").forEach((card) => {
      const p = posters.get(Number(card.dataset.id));
      if (!p || card.querySelector(".job-msg-btn")) return;
      const acts = card.querySelector(".job-actions");
      if (!acts) return;
      const wrap = document.createElement("div");
      wrap.innerHTML = posterLinkHtml(p);
      const link = wrap.firstElementChild;
      const nav = acts.querySelector('a[href*="google.com/maps"]');
      if (nav) acts.insertBefore(link, nav);
      else acts.appendChild(link);
    });
  }

  function cardHtml(j) {
    const full    = j.status !== "open" || j.claimed_count >= j.workers_needed;
    const myCode  = myClaims()[j.id];
    const pct     = Math.min(100, Math.round((j.claimed_count / Math.max(1, j.workers_needed)) * 100));
    const left    = Math.max(0, j.workers_needed - j.claimed_count);
    const pay     = j.pay_tzs ? "TZS " + Number(j.pay_tzs).toLocaleString("en-US") : T("jb_pay_ask");
    const when    = [j.work_date ? fmtDate(j.work_date) : "", j.time_note || ""].filter(Boolean).join(" · ");
    const where   = [j.area, j.region].filter(Boolean).join(", ");
    const km      = distOf(j);
    const dist    = userLoc && hasPin(j)
      ? `<span class="job-dist">${icon("pin")}${esc(T(roadKm.has(j.id) ? "jb_km_road" : "jb_km_away", { n: km.toFixed(1) }))}</span>`
      : "";
    const phone   = String(j.company_phone || "").replace(/\s+/g, "");
    const fullBadge = `<span class="job-full-badge">${esc(T("jb_full_badge"))}</span>`;
    return `
      <div class="job-card ${full ? "is-full" : ""} ${activeId === String(j.id) ? "active" : ""}" data-id="${j.id}">
        <div class="job-head">
          <div>
            <div class="job-title">${esc(j.title)}</div>
            <div class="job-company">${icon("building")}<span>${esc(j.company_name)}${where ? " · " + esc(where) : ""}</span></div>
          </div>
          <div class="job-pay"><strong>${esc(pay)}</strong><small>${esc(j.pay_note || T("jb_per_worker"))}</small></div>
        </div>
        <div class="job-meta">
          ${when ? `<span>${icon("calendar")}${esc(when)}</span>` : ""}
          ${dist}
        </div>
        ${j.description ? `<div class="job-desc">${esc(j.description)}</div>` : ""}
        ${j.requirements ? `<div class="job-req">${icon("clipboard")}<span>${esc(T("jb_req_label"))}: ${esc(j.requirements)}</span></div>` : ""}
        <div class="job-quota">
          <div class="job-quota-row">
            <span class="jq-label">${icon("users")}${esc(T("jb_workers"))}</span>
            <span class="jq-count">${j.claimed_count} / ${j.workers_needed}${full ? "" : ` · ${esc(left === 1 ? T("jb_slot_left") : T("jb_slots_left", { n: left }))}`}</span>
          </div>
          <div class="job-quota-bar"><div class="job-quota-fill" style="width:${pct}%"></div></div>
        </div>
        ${myCode ? `<div class="job-mycode">${icon("id")}<span>${esc(T("jb_mycode"))}: <strong>${esc(myCode)}</strong>. ${esc(T("jb_mycode_hint"))}</span></div>` : ""}
        <div class="job-actions">
          ${full
            ? fullBadge
            : myCode
              ? ""
              : `<button type="button" class="btn btn-primary job-claim-btn" data-id="${j.id}">${icon("check")}<span>${esc(T("jb_do_it"))}</span></button>`}
          ${phone ? `<a class="btn btn-outline" href="tel:${esc(phone)}">${icon("phone")}<span>${esc(T("jb_call"))}</span></a>` : ""}
          ${posters.has(Number(j.id)) ? posterLinkHtml(posters.get(Number(j.id))) : ""}
          ${hasPin(j) ? `<a class="btn btn-outline" target="_blank" rel="noopener"
              href="https://www.google.com/maps/dir/?api=1&destination=${j.lat},${j.lng}">${icon("navigate")}<span>${esc(T("jb_navigate"))}</span></a>` : ""}
        </div>
      </div>`;
  }

  // ==========================================================================
  //  Map
  // ==========================================================================
  function initMap() {
    const el = document.getElementById("jobsMap");
    if (!el || !window.maplibregl) return;
    map = new maplibregl.Map({
      container: "jobsMap",
      style: window.pawaGlHybridStyle ? window.pawaGlHybridStyle() : { version: 8, sources: {}, layers: [] },
      center: [39.2789, -6.7924],
      // Collapsed to the (i) button. Expanded, the credit is a white slab
      // three lines deep across the bottom of a 358px-wide phone map, sitting
      // on top of whichever job pin is nearest the coast.
      attributionControl: { compact: true },
      zoom: 10,
      maxBounds: [[TZ_BOUNDS.minLng, TZ_BOUNDS.minLat], [TZ_BOUNDS.maxLng, TZ_BOUNDS.maxLat]]
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    if (window.pawaGlBasemapToggle) map.addControl(window.pawaGlBasemapToggle(), "top-right");
  }

  function renderMarkers(rows) {
    if (!map) return;
    markers.forEach(m => m.remove());
    markers.clear();
    const pts = [];
    for (const j of rows) {
      if (!hasPin(j)) continue;
      const full = j.status !== "open" || j.claimed_count >= j.workers_needed;
      const el = document.createElement("div");
      el.className = "job-pin" + (full ? " full" : "");
      el.innerHTML = icon("briefcase");
      el.title = j.title;
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.setAttribute("aria-label", j.title);
      el.addEventListener("click", () => focusJob(String(j.id)));
      const mk = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([+j.lng, +j.lat]).addTo(map);
      markers.set(j.id, mk);
      pts.push([+j.lng, +j.lat]);
    }
    if (pts.length > 1 && !userLoc) {
      try {
        const b = pts.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(pts[0], pts[0]));
        map.fitBounds(b, { padding: 60, maxZoom: 13, duration: 500 });
      } catch (_) {}
    } else if (pts.length === 1 && !userLoc) {
      map.easeTo({ center: pts[0], zoom: 13 });
    }
  }

  function focusJob(id) {
    activeId = String(id);
    listEl.querySelectorAll(".job-card").forEach(c =>
      c.classList.toggle("active", c.dataset.id === activeId));
    const card = listEl.querySelector(`.job-card[data-id="${activeId}"]`);
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const j = jobs.find(x => String(x.id) === activeId);
    if (j && hasPin(j) && map) map.easeTo({ center: [+j.lng, +j.lat], zoom: 15 });
  }

  // ==========================================================================
  //  Claim a slot ("vote")
  // ==========================================================================
  function openClaimModal(job) {
    if (!job) return;
    claimJob = job;
    const bd = document.getElementById("jobClaimBackdrop");
    document.getElementById("jcTitle").textContent = T("jb_claim_t", { title: job.title });
    const left = Math.max(0, job.workers_needed - job.claimed_count);
    document.getElementById("jcSub").textContent =
      T(job.workers_needed === 1 ? "jb_claim_need_1" : "jb_claim_need",
        { company: job.company_name, n: job.workers_needed, left }) +
      " " + T("jb_claim_sub");
    // Remember the worker's contact between jobs.
    try {
      const saved = JSON.parse(localStorage.getItem("pawa_worker_contact") || "null");
      if (saved) {
        document.getElementById("jcName").value  ||= saved.name  || "";
        document.getElementById("jcPhone").value ||= saved.phone || "";
      }
    } catch (_) {}
    sayClaim("", "");
    bd.hidden = false;
  }

  document.getElementById("jcCancel")?.addEventListener("click", () =>
    document.getElementById("jobClaimBackdrop").hidden = true);
  document.getElementById("jobClaimBackdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.hidden = true;
  });

  function sayClaim(kind, msg) {
    const el = document.getElementById("jcStatus");
    el.className = "jm-status" + (kind ? " " + kind : "");
    el.textContent = msg;
  }

  document.getElementById("jobClaimForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!claimJob || !sb) return;
    const name  = document.getElementById("jcName").value.trim();
    const phone = document.getElementById("jcPhone").value.trim();
    if (!name || !phone) { sayClaim("err", T("jb_c_need_both")); return; }
    const btn = document.getElementById("jcSubmit");
    btn.disabled = true;
    label(btn).textContent = T("jb_claiming");
    try {
      localStorage.setItem("pawa_worker_contact", JSON.stringify({ name, phone }));
      const device = localStorage.getItem("meet_user_id") || null;
      const { data, error } = await sb.rpc("claim_day_job",
        { p_job_id: claimJob.id, p_name: name, p_phone: phone, p_device: device });
      if (error) throw error;
      const r = typeof data === "string" ? JSON.parse(data) : data;
      if (r.ok) {
        // Remember my claim + worker number so the card keeps showing it.
        if (r.code) {
          try {
            const mine = myClaims();
            mine[claimJob.id] = r.code;
            localStorage.setItem("pawa_my_claims", JSON.stringify(mine));
          } catch (_) {}
        }
        sayClaim("ok",
          (r.code ? T("jb_claim_code", { code: r.code }) + " " : "") +
          (r.full ? T("jb_claim_ok_full")
                  : T("jb_claim_ok", { c: r.claimed, n: r.needed })));
        // Reflect immediately (realtime will confirm shortly after).
        claimJob.claimed_count = r.claimed;
        if (r.full) claimJob.status = "full";
        render();
        setTimeout(() => { document.getElementById("jobClaimBackdrop").hidden = true; }, 3200);
      } else {
        sayClaim("err", ({
          full:    T("jb_claim_e_full"),
          already: T("jb_claim_e_already"),
          closed:  T("jb_claim_e_closed"),
          missing_contact: T("jb_c_need_both")
        })[r.reason] || T("jb_claim_e_other"));
        if (r.reason === "full") { claimJob.status = "full"; claimJob.claimed_count = r.claimed ?? claimJob.workers_needed; render(); }
      }
    } catch (err) {
      sayClaim("err", err.message || T("jb_claim_e_other"));
    } finally {
      btn.disabled = false;
      label(btn).textContent = T("jb_do_it");
    }
  });

  // ==========================================================================
  //  Post a job
  // ==========================================================================
  let postMap = null, postMarker = null, postPin = null;

  function openPostModal() {
    const bd = document.getElementById("jobPostBackdrop");
    bd.hidden = false;
    sayPost("", "");
    document.getElementById("jpDate").min = new Date().toISOString().slice(0, 10);
    // Leaflet picker (Canvas2D — no WebGL limits inside a modal).
    setTimeout(() => {
      if (postMap) { postMap.invalidateSize(); return; }
      if (!window.L) {
        // No map library. Say so, and leave the GPS button as the way through —
        // the pin is what gets submitted, not the map.
        const hint = document.getElementById("jpCoords");
        if (hint) hint.textContent = T("jb_map_offline");
        return;
      }
      postMap = L.map("jpMap").setView([-6.7924, 39.2789], 11);
      window.addSatelliteHybrid ? window.addSatelliteHybrid(postMap)
        : L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(postMap);
      postMap.on("click", (e) => setPostPin(e.latlng.lat, e.latlng.lng));
    }, 120);
  }

  function setPostPin(lat, lng) {
    postPin = { lat, lng };
    // The marker is the picture of the pin, not the pin itself.
    if (postMap && window.L) {
      if (!postMarker) postMarker = L.marker([lat, lng]).addTo(postMap);
      else postMarker.setLatLng([lat, lng]);
    }
    document.getElementById("jpCoords").textContent =
      `${T("jb_pinned")}: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }

  document.getElementById("jpGpsBtn")?.addEventListener("click", async () => {
    const b = document.getElementById("jpGpsBtn");
    b.disabled = true; label(b).textContent = T("jb_locating");
    try {
      const fix = await pawaLocate.best({ targetAccuracy: 30, hardTimeout: 12000 });
      setPostPin(fix.lat, fix.lng);
      postMap?.setView([fix.lat, fix.lng], 16);
    } catch (err) {
      alert(pawaLocate.message ? pawaLocate.message(err) : T("jb_loc_fail"));
    } finally {
      b.disabled = false; label(b).textContent = T("jb_gps");
    }
  });

  document.getElementById("jpCancel")?.addEventListener("click", () =>
    document.getElementById("jobPostBackdrop").hidden = true);
  document.getElementById("jobPostBackdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.hidden = true;
  });

  function sayPost(kind, msg) {
    const el = document.getElementById("jpStatus");
    el.className = "jm-status" + (kind ? " " + kind : "");
    el.textContent = msg;
  }

  function parseTzs(s) {
    s = String(s || "").toLowerCase().replace(/[,\s]/g, "");
    const m = s.match(/^(\d+(?:\.\d+)?)(k|m)?/);
    if (!m) return 0;
    let v = +m[1];
    if (m[2] === "k") v *= 1e3;
    if (m[2] === "m") v *= 1e6;
    return Math.round(v);
  }

  document.getElementById("jobPostForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!sb) { sayPost("err", T("jb_no_db")); return; }
    if (!postPin) { sayPost("err", T("jb_need_pin")); return; }
    const pay = parseTzs(document.getElementById("jpPay").value);
    if (!pay) { sayPost("err", T("jb_need_pay")); return; }
    const btn = document.getElementById("jpSubmit");
    btn.disabled = true; btn.textContent = T("jb_posting");
    try {
      // Reverse-geocode a readable area name for the card (best effort).
      let area = "", region = "";
      try {
        const j = await pawaGeo.reverse(`format=jsonv2&zoom=16&addressdetails=1&lat=${postPin.lat}&lon=${postPin.lng}`);
        const a = j?.address || {};
        // Name the job's area by its ward (Tanzania-wide), falling through the
        // equivalent neighbourhood tags when the ward field isn't filled.
        area   = a.ward || a.suburb || a.quarter || a.neighbourhood || a.village || a.town || a.city_district || a.county || "";
        region = a.state || a.region || a.city || "";
      } catch (_) {}
      const row = {
        title:          document.getElementById("jpTitle").value.trim(),
        description:    document.getElementById("jpDesc").value.trim(),
        requirements:   document.getElementById("jpReq").value.trim() || null,
        company_name:   document.getElementById("jpCompany").value.trim(),
        company_phone:  document.getElementById("jpPhone").value.trim(),
        workers_needed: Math.max(1, Math.min(500, +document.getElementById("jpWorkers").value || 1)),
        pay_tzs:        pay,
        pay_note:       document.getElementById("jpPayNote").value.trim() || null,
        work_date:      document.getElementById("jpDate").value || null,
        time_note:      document.getElementById("jpTime").value.trim() || null,
        lat: postPin.lat, lng: postPin.lng,
        area: area || null, region: region || null
      };
      // Posting goes through the RPC so the job is minted with an ownership
      // token — our proof of ownership for viewing worker contacts later.
      const { data, error } = await sb.rpc("post_day_job", { p: row });
      if (error) throw error;
      const r = typeof data === "string" ? JSON.parse(data) : data;
      if (!r?.ok) throw new Error(r?.reason === "missing_fields"
        ? T("jb_post_missing") : T("jb_post_fail"));
      const job = r.job;
      // Keep the secret on THIS device — it's the only way to see who claimed
      // slots. Lose it (clear storage) and only an admin can recover contacts.
      try {
        const mine = myPosts();
        mine[job.id] = { token: r.token, title: job.title, phone: row.company_phone };
        localStorage.setItem("pawa_my_posts", JSON.stringify(mine));
        localStorage.setItem("pawa_company_phone", row.company_phone);
      } catch (_) {}
      jobs.unshift(job);
      render();
      sayPost("ok", T("jb_post_ok"));
      setTimeout(() => {
        document.getElementById("jobPostBackdrop").hidden = true;
        document.getElementById("jobPostForm").reset();
        postPin = null;
        if (postMarker) { postMarker.remove(); postMarker = null; }
        document.getElementById("jpCoords").textContent = T("jb_no_pin");
      }, 1600);
    } catch (err) {
      sayPost("err", err.message || T("jb_post_fail"));
    } finally {
      btn.disabled = false; btn.textContent = T("jb_post_btn");
    }
  });

  // ==========================================================================
  //  My jobs & workers — the company owner sees who claimed their slots.
  //  Ownership is proven by the per-job secret token THIS device received when
  //  the job was posted (stored in pawa_my_posts) — NOT by the phone number,
  //  which is public on the board. Worker contacts come from day_job_workers,
  //  which only returns rows when the token matches the post.
  // ==========================================================================
  function myPosts() {
    try { return JSON.parse(localStorage.getItem("pawa_my_posts") || "{}"); }
    catch { return {}; }
  }

  function openMineModal() {
    const bd = document.getElementById("jobMineBackdrop");
    bd.hidden = false;
    sayMine("", "");
    loadMine();
  }

  document.getElementById("jmCancel")?.addEventListener("click", () =>
    document.getElementById("jobMineBackdrop").hidden = true);
  document.getElementById("jobMineBackdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.hidden = true;
  });
  document.getElementById("jobMineForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    loadMine();
  });

  function sayMine(kind, msg) {
    const el = document.getElementById("jmStatus");
    el.className = "jm-status" + (kind ? " " + kind : "");
    el.textContent = msg;
  }

  async function loadMine() {
    if (!sb) return;
    const out = document.getElementById("jmResults");
    const mine = myPosts();
    const ids = Object.keys(mine);
    if (!ids.length) {
      out.innerHTML = "";
      sayMine("err", T("jb_mine_none"));
      return;
    }
    out.innerHTML = `<div class="jm-no-workers">${esc(T("jb_mine_loading"))}</div>`;
    sayMine("", "");
    try {
      // Current job state (status/counts) for each owned id — public read.
      const { data, error } = await sb.from("day_jobs").select("*")
        .in("id", ids.map(Number)).limit(300);
      if (error) throw error;
      const byId = new Map((data || []).map(j => [String(j.id), j]));
      // Workers per job, via the token-verified RPC (only our jobs return rows).
      const workerLists = await Promise.all(ids.map(id =>
        sb.rpc("day_job_workers", { p_job_id: Number(id), p_manage_token: mine[id].token })
          .then(r => r.error ? [] : (r.data || []))
          .catch(() => [])
      ));
      const order = ids.slice().sort((a, b) => Number(b) - Number(a));  // newest first
      out.innerHTML = order.map(id => {
        const j  = byId.get(id) || { title: mine[id].title, status: "expired", claimed_count: 0, workers_needed: 0 };
        const ws = workerLists[ids.indexOf(id)];
        const stTxt = ({ open: T("jb_st_open"), full: T("jb_st_full"),
                         closed: T("jb_st_closed"), expired: T("jb_st_expired") })[j.status] || j.status;
        return `
          <div class="jm-job">
            <div class="jm-job-head">
              <span class="jm-job-title">${esc(j.title)}</span>
              <span class="jm-job-meta">${esc(stTxt)} · ${j.claimed_count}/${j.workers_needed} ${esc(T("jb_mine_workers"))}${j.work_date ? " · " + esc(fmtDate(j.work_date)) : ""}</span>
            </div>
            ${ws.length ? `
              <ul class="jm-workers">
                ${ws.map((w) => `
                  <li class="jm-worker">
                    <span><code class="jm-code">${esc(w.worker_code || "—")}</code> ${esc(w.worker_name)}</span>
                    <a href="tel:${esc(w.worker_phone)}">${icon("phone")}<span>${esc(w.worker_phone)}</span></a>
                  </li>`).join("")}
              </ul>
              <div class="jm-no-workers">${esc(T("jb_code_hint", { code: ws[0].worker_code || "W1-01" }))}</div>`
              : `<div class="jm-no-workers">${esc(T("jb_no_claims"))}</div>`}
          </div>`;
      }).join("");
    } catch (err) {
      out.innerHTML = "";
      sayMine("err", err.message || T("jb_mine_fail"));
    }
  }

  // ==========================================================================
  //  Helpers
  // ==========================================================================
  function flash(name, title, body) {
    bannerEl.innerHTML = `<strong>${icon(name)}${esc(title)}</strong> <span>${esc(body)}</span>`;
    bannerEl.style.display = "block";
    setTimeout(() => { bannerEl.style.display = "none"; }, 5000);
  }

  function fmtDate(iso) {
    try {
      const d = new Date(iso + "T00:00:00");
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const diff = Math.round((d - today) / 86400000);
      if (diff === 0) return T("jb_today");
      if (diff === 1) return T("jb_tomorrow");
      return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    } catch { return iso; }
  }

  function haversineKm(la1, lo1, la2, lo2) {
    const R = 6371, toRad = d => d * Math.PI / 180;
    const dLat = toRad(la2 - la1), dLng = toRad(lo2 - lo1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, m =>
      ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
  }
};
