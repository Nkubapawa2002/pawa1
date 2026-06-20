// ============================================================================
//  Day Jobs (vibarua) board — jobs.html
//  - Companies post short-term jobs with a map pin, worker quota, pay & time
//  - Workers tap "I'll do it" to claim a slot: an atomic RPC (claim_day_job)
//    enforces the quota; the fill-up bar closes the job at the cap ("FULL")
//  - "Jobs near me" sorts by distance (haversine instantly, then upgraded to
//    real road km via OSRM — same pattern as the houses directory)
//  - Supabase Realtime keeps every open browser's bars in sync as slots fill
//  Backend: supabase/day_jobs.sql (tables + claim_day_job RPC + RLS)
// ============================================================================

window.initJobsPage = () => {
  const sb = window.DataStore?.sb;

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
      listEl.innerHTML = `<div class="jobs-empty">Jobs need a database connection — please try again later.</div>`;
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
      // Table not deployed yet → friendly setup note instead of a dead page.
      listEl.innerHTML = `<div class="jobs-empty">The jobs board isn't switched on yet.<br>
        <small>(Admin: run <code>supabase/day_jobs.sql</code> in the Supabase SQL editor.)</small></div>`;
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
    nearBtn.textContent = " Locating…";
    try {
      const fix = await pawaLocate.bestOrApprox({ targetAccuracy: 60, maxWaitMs: 12000 });
      userLoc = { lat: fix.lat, lng: fix.lng };
      render();
      flash("", "Sorted nearest-first", "Jobs now show how far they are from you — closest at the top.");
      enrichRoadKm();
      if (map) {
        new maplibregl.Marker({ color: "#1e40af" }).setLngLat([fix.lng, fix.lat]).addTo(map);
        map.easeTo({ center: [fix.lng, fix.lat], zoom: 12 });
      }
    } catch (err) {
      alert(pawaLocate.message ? pawaLocate.message(err) : (err?.message || "Couldn't get your location."));
    } finally {
      nearBtn.disabled = false;
      nearBtn.textContent = " Jobs near me";
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

  function hasPin(j) { return Number.isFinite(+j.lat) && Number.isFinite(+j.lng); }
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

    countEl.textContent = rows.length
      ? `${rows.length} job${rows.length === 1 ? "" : "s"} · ${rows.reduce((s, j) => s + Math.max(0, j.workers_needed - j.claimed_count), 0)} open slots`
      : "";

    if (!rows.length) {
      listEl.innerHTML = `<div class="jobs-empty">No day jobs posted yet.<br>
        Are you hiring? Tap <strong>＋ Post a job</strong> and workers nearby will see it instantly.</div>`;
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
  }

  // Jobs THIS device already claimed → { jobId: workerCode } so the worker
  // can always re-read their on-site number.
  function myClaims() {
    try { return JSON.parse(localStorage.getItem("pawa_my_claims") || "{}"); }
    catch { return {}; }
  }

  function cardHtml(j) {
    const full    = j.status !== "open" || j.claimed_count >= j.workers_needed;
    const myCode  = myClaims()[j.id];
    const pct     = Math.min(100, Math.round((j.claimed_count / Math.max(1, j.workers_needed)) * 100));
    const left    = Math.max(0, j.workers_needed - j.claimed_count);
    const pay     = j.pay_tzs ? "TZS " + Number(j.pay_tzs).toLocaleString("en-US") : "Ask";
    const when    = [j.work_date ? fmtDate(j.work_date) : "", j.time_note || ""].filter(Boolean).join(" · ");
    const where   = [j.area, j.region].filter(Boolean).join(", ");
    const dist    = userLoc && hasPin(j)
      ? `<span class="job-dist"> ${distOf(j).toFixed(1)} km${roadKm.has(j.id) ? " by road" : " away"}</span>` : "";
    const phone   = String(j.company_phone || "").replace(/\s+/g, "");
    return `
      <div class="job-card ${full ? "is-full" : ""} ${activeId === String(j.id) ? "active" : ""}" data-id="${j.id}">
        <div class="job-head">
          <div>
            <div class="job-title">${esc(j.title)}</div>
            <div class="job-company"> ${esc(j.company_name)}${where ? " · " + esc(where) : ""}</div>
          </div>
          <div class="job-pay"><strong>${esc(pay)}</strong><small>${esc(j.pay_note || "per worker")}</small></div>
        </div>
        <div class="job-meta">
          ${when ? `<span> ${esc(when)}</span>` : ""}
          ${dist}
        </div>
        ${j.description ? `<div class="job-desc">${esc(j.description)}</div>` : ""}
        ${j.requirements ? `<div class="job-req"> Requirements: ${esc(j.requirements)}</div>` : ""}
        <div class="job-quota">
          <div class="job-quota-row">
            <span class="jq-label">Workers</span>
            <span class="jq-count">${j.claimed_count} / ${j.workers_needed}${full ? "" : ` · ${left} slot${left === 1 ? "" : "s"} left`}</span>
          </div>
          <div class="job-quota-bar"><div class="job-quota-fill" style="width:${pct}%"></div></div>
        </div>
        ${myCode ? `<div class="job-mycode"> Your worker number: <strong>${esc(myCode)}</strong> — show it at the work site</div>` : ""}
        <div class="job-actions">
          ${myCode
            ? (full ? `<span class="job-full-badge" style="align-self:center">FULL — team complete</span>` : "")
            : full
              ? `<span class="job-full-badge" style="align-self:center">FULL — team complete</span>`
              : `<button type="button" class="btn btn-primary job-claim-btn" data-id="${j.id}"> I'll do it</button>`}
          ${phone ? `<a class="btn btn-outline" href="tel:${esc(phone)}"> Call</a>` : ""}
          ${hasPin(j) ? `<a class="btn btn-outline" target="_blank" rel="noopener"
              href="https://www.google.com/maps/dir/?api=1&destination=${j.lat},${j.lng}"> Navigate</a>` : ""}
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
      zoom: 10,
      maxBounds: [[29.34, -11.75], [40.45, -0.99]]
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
      el.textContent = "";
      el.title = j.title;
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
    document.getElementById("jcTitle").textContent = `Claim: ${job.title}`;
    document.getElementById("jcSub").textContent =
      `${job.company_name} needs ${job.workers_needed} worker${job.workers_needed === 1 ? "" : "s"} — ` +
      `${Math.max(0, job.workers_needed - job.claimed_count)} slot(s) left. ` +
      `Your name & phone go to the company so they can confirm you.`;
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
    if (!name || !phone) { sayClaim("err", "Enter your name and phone."); return; }
    const btn = document.getElementById("jcSubmit");
    btn.disabled = true;
    btn.textContent = "Claiming…";
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
          (r.code ? ` Your worker number is ${r.code} — show it at the work site. ` : "") +
          (r.full
            ? "You're in — and the team is now COMPLETE. The company will call you."
            : `You're in! ${r.claimed} of ${r.needed} slots taken. The company will call to confirm.`));
        // Reflect immediately (realtime will confirm shortly after).
        claimJob.claimed_count = r.claimed;
        if (r.full) claimJob.status = "full";
        render();
        setTimeout(() => { document.getElementById("jobClaimBackdrop").hidden = true; }, 3200);
      } else {
        sayClaim("err", ({
          full:    "Sorry — the last slot was just taken. The job is now full.",
          already: "You already claimed this job with this phone number.",
          closed:  "This job is no longer open.",
          missing_contact: "Enter your name and phone."
        })[r.reason] || "Couldn't claim the slot.");
        if (r.reason === "full") { claimJob.status = "full"; claimJob.claimed_count = r.claimed ?? claimJob.workers_needed; render(); }
      }
    } catch (err) {
      sayClaim("err", err.message || "Couldn't claim the slot — try again.");
    } finally {
      btn.disabled = false;
      btn.textContent = " I'll do it";
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
      postMap = L.map("jpMap").setView([-6.7924, 39.2789], 11);
      window.addSatelliteHybrid ? window.addSatelliteHybrid(postMap)
        : L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(postMap);
      postMap.on("click", (e) => setPostPin(e.latlng.lat, e.latlng.lng));
    }, 120);
  }

  function setPostPin(lat, lng) {
    postPin = { lat, lng };
    if (!postMarker) postMarker = L.marker([lat, lng]).addTo(postMap);
    else postMarker.setLatLng([lat, lng]);
    document.getElementById("jpCoords").textContent =
      ` Pinned: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }

  document.getElementById("jpGpsBtn")?.addEventListener("click", async () => {
    const b = document.getElementById("jpGpsBtn");
    b.disabled = true; b.textContent = " Locating…";
    try {
      const fix = await pawaLocate.best({ targetAccuracy: 30, hardTimeout: 12000 });
      setPostPin(fix.lat, fix.lng);
      postMap?.setView([fix.lat, fix.lng], 16);
    } catch (err) {
      alert(pawaLocate.message ? pawaLocate.message(err) : "Couldn't get your location.");
    } finally {
      b.disabled = false; b.textContent = " Use my GPS location";
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
    if (!sb) { sayPost("err", "No database connection."); return; }
    if (!postPin) { sayPost("err", "Pin the job location on the map first — workers navigate to that pin."); return; }
    const pay = parseTzs(document.getElementById("jpPay").value);
    if (!pay) { sayPost("err", "Enter the pay per worker (e.g. 15,000 or 15k)."); return; }
    const btn = document.getElementById("jpSubmit");
    btn.disabled = true; btn.textContent = "Posting…";
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
        ? "Title, company name and phone are required." : "Couldn't post the job.");
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
      sayPost("ok", "Job posted! Workers near the pin can now claim slots — you'll be called by interested workers.");
      setTimeout(() => {
        document.getElementById("jobPostBackdrop").hidden = true;
        document.getElementById("jobPostForm").reset();
        postPin = null;
        if (postMarker) { postMarker.remove(); postMarker = null; }
        document.getElementById("jpCoords").textContent = "Pin not placed yet — tap the map, or";
      }, 1600);
    } catch (err) {
      sayPost("err", err.message || "Couldn't post the job.");
    } finally {
      btn.disabled = false; btn.textContent = "Post job";
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
      sayMine("err", "No jobs posted from this device yet. Jobs you post here appear under “My jobs” so you — and only you — can see who claimed each slot.");
      return;
    }
    out.innerHTML = `<div class="jm-no-workers">Loading your jobs…</div>`;
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
        const stTxt = ({ open: " Open", full: " Full — team complete", closed: " Closed", expired: " Expired" })[j.status] || j.status;
        return `
          <div class="jm-job">
            <div class="jm-job-head">
              <span class="jm-job-title">${esc(j.title)}</span>
              <span class="jm-job-meta">${stTxt} · ${j.claimed_count}/${j.workers_needed} workers${j.work_date ? " · " + esc(fmtDate(j.work_date)) : ""}</span>
            </div>
            ${ws.length ? `
              <ul class="jm-workers">
                ${ws.map((w) => `
                  <li class="jm-worker">
                    <span><code class="jm-code">${esc(w.worker_code || "—")}</code> ${esc(w.worker_name)}</span>
                    <a href="tel:${esc(w.worker_phone)}"> ${esc(w.worker_phone)}</a>
                  </li>`).join("")}
              </ul>
              <div class="jm-no-workers">Each worker's ID (e.g. ${esc(ws[0].worker_code || "W1-01")}) is their number at the work zone — ask for it on arrival.</div>`
              : `<div class="jm-no-workers">No workers have claimed a slot yet — share the jobs page or wait for nearby workers.</div>`}
          </div>`;
      }).join("");
    } catch (err) {
      out.innerHTML = "";
      sayMine("err", err.message || "Couldn't load your jobs.");
    }
  }

  // ==========================================================================
  //  Helpers
  // ==========================================================================
  function flash(icon, title, body) {
    bannerEl.innerHTML = `<strong>${icon} ${esc(title)}</strong> — ${esc(body)}`;
    bannerEl.style.display = "block";
    setTimeout(() => { bannerEl.style.display = "none"; }, 5000);
  }

  function fmtDate(iso) {
    try {
      const d = new Date(iso + "T00:00:00");
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const diff = Math.round((d - today) / 86400000);
      if (diff === 0) return "Today";
      if (diff === 1) return "Tomorrow";
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
