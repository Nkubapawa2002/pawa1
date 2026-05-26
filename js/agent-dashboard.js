// =====================================================
// Agent Dashboard — search by phone OR name, multi-phone shipment matching
// =====================================================

window.initAgentDashboard = async () => {
  const sb = window.SB;
  const $  = (id) => document.getElementById(id);

  const STATUSES = ["Awaiting Price", "Registered", "Collected", "In Transit", "Arrived", "Delivered"];
  const ACTIVE   = ["Awaiting Price", "Registered", "Collected", "In Transit", "Arrived"];

  const loginCard  = $("loginCard");
  const dashboard  = $("dashboard");

  let agent       = null;
  let rows        = [];
  let agentPhones = new Set(); // all normalised phones for this agent
  let searchMode  = "phone";   // "phone" | "name"

  // ── Search type tabs ──────────────────────────────────────
  $("tabPhone").addEventListener("click", () => setMode("phone"));
  $("tabName").addEventListener("click",  () => setMode("name"));

  function setMode(mode) {
    searchMode = mode;
    $("tabPhone").classList.toggle("active", mode === "phone");
    $("tabName").classList.toggle("active",  mode === "name");
    const input = $("agentPhone");
    if (mode === "phone") {
      input.type = "tel";
      input.placeholder = window.t("agent_dash_phone_ph");
      $("searchLabelText").textContent = window.t("agent_dash_tab_phone");
    } else {
      input.type = "text";
      input.placeholder = window.t("agent_dash_name_ph");
      $("searchLabelText").textContent = window.t("agent_dash_tab_name");
    }
    $("agentPicker").hidden = true;
    $("agentMsg").hidden    = true;
    input.value = "";
    input.focus();
  }

  // ── Remember last session ─────────────────────────────────
  const STORE_KEY = "pawa_agent_phone";
  const saved = localStorage.getItem(STORE_KEY);
  if (saved) { $("agentPhone").value = saved; }

  $("phoneForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const term = $("agentPhone").value.trim();
    if (!term) return;
    searchMode === "phone" ? await openByPhone(term) : await openByName(term);
  });

  $("signOutAgent").addEventListener("click", () => {
    localStorage.removeItem(STORE_KEY);
    dashboard.hidden  = true;
    loginCard.hidden  = false;
    $("agentPhone").value = "";
    $("agentPicker").hidden = true;
    $("agentMsg").hidden    = true;
    $("agentPhone").focus();
  });

  $("dashStatusFilter").addEventListener("change", () => render(currentRows()));

  // ── Open by phone ─────────────────────────────────────────
  async function openByPhone(phone) {
    $("agentMsg").hidden = true;
    if (!sb) { showErr("Backend offline."); return; }

    const clean = phone.replace(/\s/g, "");

    // 1. Try primary phone column (exact match)
    let found = null;
    const { data: r1, error: e1 } = await sb.from("agents")
      .select("*")
      .or(`phone.eq.${phone},phone.eq.${clean}`)
      .limit(1);
    if (e1) { showErr(e1.message); return; }
    found = r1;

    // 2. Try phones[] array (secondary numbers)
    if (!found || !found.length) {
      const { data: r2 } = await sb.from("agents")
        .select("*")
        .contains("phones", [phone])
        .limit(1);
      if (r2 && r2.length) found = r2;
    }
    if (!found || !found.length) {
      const { data: r3 } = await sb.from("agents")
        .select("*")
        .contains("phones", [clean])
        .limit(1);
      if (r3 && r3.length) found = r3;
    }

    if (found && found.length) {
      localStorage.setItem(STORE_KEY, phone);
      openAgent(found[0]);
      return;
    }

    // 3. Not in agents — check application status
    try {
      const { data: appRows } = await sb.rpc("check_application_status", { p_phone: clean });
      if (appRows && appRows.length) {
        const app = appRows[0];
        if (app.status === "pending") {
          showErr(window.t("agent_dash_pending"));
        } else if (app.status === "rejected") {
          showErr(`${window.t("agent_dash_rejected")}: ${app.reject_reason || "Contact admin for details."}`);
        } else {
          showErr(window.t("agent_dash_no_match"));
        }
        return;
      }
    } catch {}

    showErr(window.t("agent_dash_no_match"));
  }

  // ── Open by name ──────────────────────────────────────────
  async function openByName(name) {
    if (!sb) { showErr("Backend offline."); return; }
    $("agentPicker").hidden = true;

    const { data: found, error } = await sb.from("agents")
      .select("*")
      .ilike("name", `%${name}%`)
      .order("name")
      .limit(10);

    if (error) { showErr(error.message); return; }
    if (!found || !found.length) {
      showErr(window.t("agent_dash_no_name"));
      return;
    }

    // One exact match — open directly
    if (found.length === 1) { openAgent(found[0]); return; }

    // Multiple matches — show picker
    const list = $("agentPickList");
    list.innerHTML = found.map((a, idx) => {
      const photo    = window.DataStore.agentPhotoUrl(a.photo_path);
      const initials = (a.name || "?").split(/\s+/).map(s => s[0]).join("").slice(0, 2).toUpperCase();
      const avatar   = photo
        ? `<img src="${photo}" alt="${a.name}" style="width:40px;height:40px;border-radius:50%;object-fit:cover"/>`
        : `<span class="agent-avatar" style="width:40px;height:40px;font-size:0.9rem">${initials}</span>`;
      const phones = [a.phone, ...(a.phones || [])].filter(Boolean);
      return `
        <button type="button" class="agent-pick-card" data-idx="${idx}">
          ${avatar}
          <div style="text-align:left">
            <strong>${a.name}</strong>
            <div style="font-size:0.82rem;color:var(--gray)">${a.region} · ${a.terminal || "—"}</div>
            <div style="font-size:0.8rem;color:var(--gray)">${phones.join(" / ")}</div>
          </div>
        </button>`;
    }).join("");

    $("agentPicker").hidden = false;

    list.querySelectorAll(".agent-pick-card").forEach(btn => {
      btn.addEventListener("click", () => openAgent(found[Number(btn.dataset.idx)]));
    });
  }

  // ── Open agent dashboard ──────────────────────────────────
  function openAgent(a) {
    agent = a;

    // Build the full set of normalised phones for this agent
    agentPhones = new Set(
      [a.phone, ...(a.phones || [])]
        .filter(Boolean)
        .map(norm)
    );

    // Save primary phone for session restore
    const primary = a.phone || (a.phones || [])[0] || "";
    if (primary) localStorage.setItem(STORE_KEY, primary);

    loginCard.hidden = true;
    dashboard.hidden = false;
    $("agentPicker").hidden = true;

    renderBanner(a);
    renderProfile(a);
    loadAgentRoutes(a);
    loadShipments();
    loadCashRetargets();
    initCollectPayment();
  }

  // ── Cash retargeting: cash payers waiting to be recorded ──
  async function loadCashRetargets() {
    const alertEl = $("retargetAlert");
    const formWrap = $("retargetFormWrap");
    if (!alertEl || !formWrap) return;

    let pending = [];
    if (sb) {
      try {
        const { data } = await sb
          .from("cash_retargets")
          .select("*")
          .eq("retarget_status", "pending_record")
          .order("created_at", { ascending: false })
          .limit(20);
        pending = data || [];
      } catch {}
    } else {
      pending = JSON.parse(localStorage.getItem("cash_retargets_local") || "[]")
        .filter(r => r.retarget_status === "pending_record");
    }

    if (!pending.length) {
      alertEl.hidden = true;
      formWrap.hidden = true;
      return;
    }

    alertEl.hidden = false;
    alertEl.innerHTML = `
      <div class="ra-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
        </svg>
      </div>
      <div class="ra-text">
        <strong>${pending.length}</strong> ${window.t("cash_retarget_pending_alert")}
        <div style="font-weight:500;font-size:0.85rem;margin-top:2px;opacity:0.9">${window.t("cash_retarget_sub")}</div>
      </div>
    `;

    formWrap.hidden = false;
    formWrap.innerHTML = pending.map((r, i) => `
      <div class="retarget-form" data-idx="${i}">
        <h4>${window.t("cash_retarget_title")}</h4>
        <p style="color:var(--gray);font-size:0.85rem">
          ${r.bus_name || "—"} · ${r.route || "—"} · Seat ${r.seat_number || "—"} · ${window.formatTZS(r.fare_tzs || 0)}
          ${r.passenger_phone ? `&nbsp;<a href="tel:${(r.passenger_phone).replace(/\s/g,'')}" class="btn btn-outline btn-xs">📞 ${r.passenger_phone}</a>` : ""}
        </p>
        <div class="rf-grid">
          <input type="text" data-field="customer_name" placeholder="${window.t("cash_retarget_name")}" />
          <input type="tel" data-field="customer_phone" placeholder="${window.t("cash_retarget_phone")}" value="${r.passenger_phone || ""}" />
        </div>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button class="btn btn-green btn-sm" data-action="save-retarget" data-ticket="${r.ticket_code}">
            ${window.t("cash_retarget_save")}
          </button>
          <span class="retarget-msg" style="font-size:0.85rem;color:var(--green-dark)"></span>
        </div>
      </div>
    `).join("");

    // Wire save buttons
    formWrap.querySelectorAll('[data-action="save-retarget"]').forEach(btn => {
      btn.addEventListener("click", async () => {
        const wrap = btn.closest(".retarget-form");
        const ticket = btn.dataset.ticket;
        const name = wrap.querySelector('[data-field="customer_name"]').value.trim();
        const phone = wrap.querySelector('[data-field="customer_phone"]').value.trim();
        const msgEl = wrap.querySelector(".retarget-msg");
        if (!name || !phone) {
          msgEl.textContent = "Fill name and phone.";
          msgEl.style.color = "var(--danger)";
          return;
        }
        btn.disabled = true;
        try {
          if (sb) {
            await sb.from("cash_retargets")
              .update({
                customer_name: name,
                customer_phone: phone,
                retarget_status: "recorded",
                recorded_by: agent.id || agent.name,
                recorded_at: new Date().toISOString()
              })
              .eq("ticket_code", ticket);
          } else {
            const list = JSON.parse(localStorage.getItem("cash_retargets_local") || "[]");
            const idx = list.findIndex(r => r.ticket_code === ticket);
            if (idx >= 0) {
              list[idx].customer_name = name;
              list[idx].customer_phone = phone;
              list[idx].retarget_status = "recorded";
              localStorage.setItem("cash_retargets_local", JSON.stringify(list));
            }
          }
          msgEl.textContent = "✓ " + window.t("cash_retarget_saved");
          msgEl.style.color = "var(--green-dark)";
          setTimeout(loadCashRetargets, 1200);
        } catch (e) {
          msgEl.textContent = e.message;
          msgEl.style.color = "var(--danger)";
          btn.disabled = false;
        }
      });
    });
  }

  function renderBanner(a) {
    const photo    = window.DataStore.agentPhotoUrl(a.photo_path);
    const initials = (a.name || "?").split(/\s+/).map(s => s[0]).join("").slice(0, 2).toUpperCase();
    const verified = a.verified !== false ? `<span class="verified-badge">✓ Verified</span>` : "";
    const allPhones = [a.phone, ...(a.phones || [])].filter(Boolean);

    $("agentBanner").innerHTML = `
      <div class="agent-avatar lg" id="bannerAvatar">${photo ? `<img src="${photo}" alt=""/>` : `<span>${initials}</span>`}</div>
      <div>
        <h2 style="margin:0">${a.name} ${verified}</h2>
        <p style="margin:2px 0;color:var(--gray)">${a.region} · ${a.terminal || "—"}</p>
        <p style="margin:2px 0;font-size:0.9rem"><strong>Buses:</strong> ${(a.buses || []).join(", ")}</p>
        <p style="margin:0;font-size:0.88rem;color:var(--gray)">${allPhones.map(p => `<a href="tel:${p.replace(/\s/g,'')}" class="btn btn-outline btn-xs">📞 ${p}</a>`).join(" ")}</p>
      </div>
    `;
  }

  function renderProfile(a) {
    const exp   = a.experience_years ? `<span class="profile-badge"><strong>${a.experience_years}</strong> ${window.t("label_years")} ${window.t("label_experience").toLowerCase()}</span>` : "";
    const rating = Number(a.rating_avg) || 0;
    const count  = a.rating_count || 0;
    const ratingBadge = `<span class="profile-badge rating-badge">★ ${rating.toFixed(1)} <small>(${count} ${count === 1 ? window.t("review_singular") : window.t("review_plural")})</small></span>`;
    const about  = a.about ? `<p class="profile-about"><strong>${window.t("label_about")}:</strong> ${a.about}</p>` : "";

    $("agentProfileDetails").innerHTML = `
      <h4 style="margin-bottom:10px" data-i18n="dash_profile_section">${window.t("dash_profile_section")}</h4>
      <div class="profile-badges">${ratingBadge}${exp}</div>
      ${about}
    `;

    // Wire up photo input (unbind first to avoid double-binding on refresh)
    const input = $("photoInput");
    const newInput = input.cloneNode(true);
    input.replaceWith(newInput);
    newInput.addEventListener("change", handlePhotoUpload);
  }

  async function loadAgentRoutes(a) {
    const section = $("agentRoutesSection");
    if (!section || !a.buses || !a.buses.length || !sb) return;
    try {
      const { data } = await sb.from("buses").select("name, routes").in("name", a.buses);
      if (!data || !data.length) return;
      const withRoutes = data.filter(b => b.routes && b.routes.length);
      if (!withRoutes.length) return;
      section.innerHTML = `
        <h5 style="margin:0 0 8px;font-size:0.92rem">Routes</h5>
        ${withRoutes.map(b => `
          <div style="margin-bottom:8px">
            <strong style="font-size:0.88rem">${b.name}</strong>
            <ul style="margin:4px 0 0 16px;padding:0;list-style:disc">
              ${b.routes.map(r => `
                <li style="font-size:0.83rem;color:var(--gray);margin-bottom:2px">
                  ${r.from} → ${r.to}
                  <span style="color:var(--gray-light)">· dep. ${r.departure || "—"}</span>
                </li>`).join("")}
            </ul>
          </div>`).join("")}`;
    } catch {}
  }

  async function handlePhotoUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showPhotoMsg(window.t("dash_photo_error") + "File too large (max 5 MB)", true); return; }

    const msgEl = $("photoMsg");
    msgEl.hidden = false;
    msgEl.className = "photo-msg";
    msgEl.textContent = window.t("dash_uploading_photo");

    const ext  = file.name.split(".").pop().toLowerCase() || "jpg";
    const path = `${agent.id}/${Date.now()}.${ext}`;
    const bucket = (window.APP_CONFIG && window.APP_CONFIG.AGENT_PHOTOS_BUCKET) || "agent-photos";

    const { error: upErr } = await sb.storage.from(bucket).upload(path, file, { upsert: true });
    if (upErr) { showPhotoMsg(window.t("dash_photo_error") + upErr.message, true); return; }

    const phone = agent.phone || (agent.phones || [])[0] || "";
    const { data: ok, error: rpcErr } = await sb.rpc("update_agent_photo", { p_phone: phone, p_photo_path: path });
    if (rpcErr) { showPhotoMsg(window.t("dash_photo_error") + rpcErr.message, true); return; }

    agent.photo_path = path;
    renderBanner(agent);
    renderProfile(agent);
    showPhotoMsg(window.t("dash_photo_saved"), false);
  }

  function showPhotoMsg(msg, isError) {
    const el = $("photoMsg");
    el.hidden = false;
    el.textContent = msg;
    el.className = "photo-msg" + (isError ? " error" : " success");
    if (!isError) setTimeout(() => { el.hidden = true; }, 3500);
  }

  // ── Load shipments using ALL agent phones ─────────────────
  async function loadShipments() {
    // Build unique normalised phone list
    const allPhones = [agent.phone, ...(agent.phones || [])]
      .filter(Boolean)
      .flatMap(p => [p, p.replace(/\s/g, "")])
      .filter(Boolean);
    const unique = [...new Set(allPhones)];
    const inList = unique.map(p => `"${p}"`).join(",");

    const { data, error } = await sb.from("shipments")
      .select("*")
      .or(`agent_origin_phone.in.(${inList}),agent_destination_phone.in.(${inList})`)
      .order("created_at", { ascending: false });

    if (error) {
      $("agentShipments").innerHTML = `<div class="banner error">${error.message}</div>`;
      return;
    }
    rows = data || [];

    $("kpiTotal").textContent  = rows.length;
    $("kpiActive").textContent = rows.filter(r => ACTIVE.includes(r.status)).length;
    $("kpiDone").textContent   = rows.filter(r => r.status === "Delivered").length;
    $("kpiRating").textContent = (Number(agent.rating_avg) || 0).toFixed(1) + ` (${agent.rating_count || 0})`;

    // Alert: shipments needing price agreement or confirmation
    const awaitingPrice = rows.filter(r => agentPhones.has(norm(r.agent_origin_phone)) && r.status === "Awaiting Price");
    const pending       = rows.filter(r => agentPhones.has(norm(r.agent_origin_phone)) && r.status === "Registered");
    const alertEl = $("confirmAlert");
    if (alertEl) {
      const total = awaitingPrice.length + pending.length;
      alertEl.hidden = !total;
      if (awaitingPrice.length) {
        alertEl.innerHTML = `💰 <strong>${awaitingPrice.length}</strong> shipment${awaitingPrice.length > 1 ? "s" : ""} waiting for your price confirmation.${pending.length ? ` &nbsp;·&nbsp; ⚠️ <strong>${pending.length}</strong> awaiting parcel pickup confirmation.` : ""}`;
      } else if (pending.length) {
        alertEl.innerHTML = `⚠️ <strong>${pending.length}</strong> ${window.t("dash_confirm_alert")}`;
      }
    }

    render(rows);
    subscribeRealtime();
  }

  function currentRows() {
    const f = $("dashStatusFilter").value;
    return f ? rows.filter(r => r.status === f) : rows;
  }

  // ── Render shipment cards ─────────────────────────────────
  function render(list) {
    const container = $("agentShipments");
    if (!list.length) {
      container.innerHTML = `<div class="empty"><p>No shipments here yet.</p></div>`;
      return;
    }
    container.innerHTML = list.map(s => {
      const isOrigin = s.agent_origin_phone && agentPhones.has(norm(s.agent_origin_phone));
      const role = isOrigin ? "Origin agent" : "Destination agent";
      const counterParty = isOrigin
        ? { who: "Receiver", name: s.receiver_name, phone: s.receiver_phone, region: s.receiver_region }
        : { who: "Sender",   name: s.sender_name,   phone: s.sender_phone,   region: s.sender_region };
      const wa = (counterParty.phone || "").replace(/\s/g, "").replace(/^\+/, "");

      // ── Price-agreement flow (new) ──────────────────────────
      const needsPrice   = isOrigin && s.status === "Awaiting Price";
      const needsConfirm = isOrigin && s.status === "Registered";

      const suggestedFee = s.product_suggested_fee || 0;
      const feeDisplay   = suggestedFee ? window.formatTZS(suggestedFee) : "—";

      const priceBlock = needsPrice ? `
        <div class="price-agree-block" id="pab-${s.tracking_code}"
          style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:10px;padding:14px 16px;margin:12px 0;">
          <div style="font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:#065f46;margin-bottom:8px;">
            💰 Agree on Transport Fee
          </div>
          <p style="margin:0 0 8px;font-size:0.88rem;color:#333;">
            System estimate: <strong>${feeDisplay}</strong> ·
            Weight: <strong>${s.product_weight_kg || "—"} kg</strong> ·
            Size: <strong>${s.product_size_category || "—"}</strong>
          </p>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input type="number" id="fee-${s.tracking_code}"
              placeholder="Enter final price (TZS)" value="${suggestedFee || ""}"
              style="padding:8px 11px;border:1px solid #ccc;border-radius:8px;font-size:0.9rem;width:200px;box-sizing:border-box;" />
            <button class="btn btn-primary btn-sm agree-price-btn"
              data-code="${s.tracking_code}" style="background:#0B6E4F;">
              ✓ Agree &amp; Confirm Price
            </button>
            <button class="btn btn-outline btn-sm disagree-btn"
              data-code="${s.tracking_code}" style="color:#c0392b;border-color:#c0392b;">
              ✗ Disagree
            </button>
          </div>
          <span class="price-msg" id="pmsg-${s.tracking_code}"
            style="display:none;font-size:0.85rem;margin-top:8px;"></span>
        </div>` : "";

      const confirmBtn = needsConfirm
        ? `<button class="btn btn-primary btn-sm confirm-btn" data-code="${s.tracking_code}">
             ✓ ${window.t("dash_confirm_btn")}
           </button>` : "";

      const statusBadge = needsPrice
        ? `<span class="pill" style="margin-left:6px;background:#fff3cd;color:#856404;border:1px solid #ffc107;border-radius:999px;font-size:0.72rem;font-weight:700;padding:2px 9px;">Awaiting Price</span>`
        : needsConfirm
        ? `<span class="pill pill-pending" style="margin-left:6px">Awaiting confirmation</span>`
        : "";

      // Hide status dropdown for "Awaiting Price" — agent must go through agree/disagree
      const statusDropdown = needsPrice ? "" : `
        <select class="status-select" data-code="${s.tracking_code}">
          ${STATUSES.filter(st => st !== "Awaiting Price").map(st => `<option value="${st}" ${st === s.status ? "selected" : ""}>${st}</option>`).join("")}
        </select>`;

      return `
        <div class="card shipment-card ${needsPrice ? "needs-confirm" : needsConfirm ? "needs-confirm" : ""}">
          <div class="ship-card-head">
            <div>
              <code>${s.tracking_code}</code>
              <span class="role-pill">${role}</span>
              ${statusBadge}
            </div>
            ${statusDropdown}
          </div>
          <p class="meta"><strong>Route:</strong> ${s.sender_region} → ${s.receiver_region} <small>via ${s.bus_name}</small></p>
          <p class="meta"><strong>Product:</strong> ${s.product_description} (${s.product_weight_kg} kg, ${window.formatTZS(s.product_value_tzs)})</p>
          <p class="meta"><strong>${counterParty.who}:</strong> ${counterParty.name} · ${counterParty.phone} (${counterParty.region})</p>
          ${priceBlock}
          <div class="contact-actions">
            ${confirmBtn}
            <a href="track.html?code=${encodeURIComponent(s.tracking_code)}" class="btn btn-outline btn-sm">Open &amp; chat</a>
            <a href="tel:${counterParty.phone}" class="btn btn-outline btn-sm">Call</a>
            <a href="https://wa.me/${wa}" target="_blank" rel="noopener" class="btn btn-whatsapp btn-sm">WhatsApp</a>
          </div>
        </div>`;
    }).join("");

    // ── Wire: Agree & Confirm Price ───────────────────────────
    container.querySelectorAll(".agree-price-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const code    = btn.dataset.code;
        const input   = document.getElementById("fee-" + code);
        const msgEl   = document.getElementById("pmsg-" + code);
        const fee     = parseFloat(input?.value);

        if (!fee || isNaN(fee) || fee <= 0) {
          msgEl.style.color = "var(--danger, #c0392b)";
          msgEl.textContent = "Enter a valid price before confirming.";
          msgEl.style.display = "block";
          return;
        }

        btn.disabled    = true;
        btn.textContent = "Confirming…";
        msgEl.style.display = "none";

        const { error } = await sb.from("shipments").update({
          product_freight_fee: fee,
          status: "Registered"         // price agreed → ride now active
        }).eq("tracking_code", code);

        if (error) {
          btn.disabled    = false;
          btn.textContent = "✓ Agree & Confirm Price";
          msgEl.style.color = "var(--danger, #c0392b)";
          msgEl.textContent = "Failed: " + error.message;
          msgEl.style.display = "block";
          return;
        }

        await sb.from("shipment_messages").insert({
          tracking_code: code, from_role: "system", from_name: agent.name,
          message: `Transport fee confirmed by ${agent.name}: ${window.formatTZS(fee)}. Shipment is now active.`
        }).catch(() => {});

        loadShipments();
      });
    });

    // ── Wire: Disagree ────────────────────────────────────────
    container.querySelectorAll(".disagree-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const code  = btn.dataset.code;
        const msgEl = document.getElementById("pmsg-" + code);
        const reason = prompt("Reason for disagreement (optional — sender will see this):");
        if (reason === null) return;   // cancelled

        btn.disabled    = true;
        btn.textContent = "Sending…";

        const { error } = await sb.from("shipments").update({
          status: "Needs Revision"
        }).eq("tracking_code", code);

        if (error) {
          btn.disabled    = false;
          btn.textContent = "✗ Disagree";
          msgEl.style.color = "var(--danger, #c0392b)";
          msgEl.textContent = "Failed: " + error.message;
          msgEl.style.display = "block";
          return;
        }

        await sb.from("shipment_messages").insert({
          tracking_code: code, from_role: "agent", from_name: agent.name,
          message: reason
            ? `Agent ${agent.name} requested a revision: ${reason}`
            : `Agent ${agent.name} disagreed with the proposed price. Please contact the agent to discuss.`
        }).catch(() => {});

        loadShipments();
      });
    });

    // ── Wire: Status dropdown (for non-Awaiting-Price cards) ──
    container.querySelectorAll(".status-select").forEach(sel => {
      sel.addEventListener("change", async (e) => {
        const code   = e.target.dataset.code;
        const status = e.target.value;
        const { error } = await sb.from("shipments").update({ status }).eq("tracking_code", code);
        if (error) { alert(error.message); return; }
        await sb.from("shipment_messages").insert({
          tracking_code: code, from_role: "system", from_name: agent.name,
          message: `Status updated to "${status}" by ${agent.name}.`
        });
        loadShipments();
      });
    });

    // ── Wire: Confirm parcel received (Registered → Collected) ─
    container.querySelectorAll(".confirm-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const code = btn.dataset.code;
        btn.disabled    = true;
        btn.textContent = window.t("dash_confirming");
        const { error } = await sb.from("shipments")
          .update({ status: "Collected" }).eq("tracking_code", code);
        if (error) { alert(error.message); btn.disabled = false; btn.textContent = window.t("dash_confirm_btn"); return; }
        await sb.from("shipment_messages").insert({
          tracking_code: code, from_role: "system", from_name: agent.name,
          message: `Parcel received and confirmed by origin agent ${agent.name}.`
        });
        loadShipments();
      });
    });
  }

  // ── Realtime ──────────────────────────────────────────────
  let channel = null;
  function subscribeRealtime() {
    if (channel) channel.unsubscribe?.();
    channel = sb.channel("agent_dash_" + agent.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "shipments" }, () => {
        loadShipments();
      })
      .subscribe();
  }

  // ── Collect Payment ───────────────────────────────────────
  let _payInited = false;

  function initCollectPayment() {
    if (_payInited) return;
    _payInited = true;

    const cpCode   = $("cpCode");
    const cpSearch = $("cpSearchBtn");
    const cpResult = $("cpResult");

    if (!cpCode || !cpSearch || !cpResult) return;

    cpCode.addEventListener("input", () => { cpCode.value = cpCode.value.toUpperCase(); });
    cpCode.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
    cpSearch.addEventListener("click", doSearch);

    async function doSearch() {
      const code = cpCode.value.trim().toUpperCase();
      if (!code) return;
      cpResult.innerHTML = `<p style="color:var(--gray);font-size:0.9rem">Searching…</p>`;

      const { data, error } = await sb.from("bookings")
        .select("ticket_code,bus_name,origin,destination,travel_date,departure_time,seat_number,passenger_name,passenger_phone,fare_tzs,status")
        .eq("ticket_code", code)
        .single();

      if (error || !data) {
        cpResult.innerHTML = `<div class="banner error">Booking not found: <strong>${code}</strong></div>`;
        return;
      }
      if (!["pending", "awaiting_payment"].includes(data.status)) {
        cpResult.innerHTML = `<div class="banner warn">Booking <strong>${code}</strong> is already <strong>${data.status}</strong> — no payment action needed.</div>`;
        return;
      }
      renderPayForm(data);
    }

    function renderPayForm(bk) {
      const fare = bk.fare_tzs ? window.formatTZS(bk.fare_tzs) : "—";
      cpResult.innerHTML = `
        <div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:10px;padding:12px 15px;margin-bottom:14px">
          <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#065f46;margin-bottom:6px">Booking Found ✓</div>
          <p style="margin:0 0 3px"><strong>${bk.passenger_name || "—"}</strong> · Seat <strong>${bk.seat_number || "—"}</strong></p>
          <p style="margin:0 0 3px;font-size:0.88rem;color:var(--gray)">${bk.bus_name || "—"} · ${bk.origin || "—"} → ${bk.destination || "—"} · ${bk.travel_date || "—"}${bk.departure_time ? " " + bk.departure_time : ""}</p>
          <p style="margin:0"><strong>Fare: ${fare}</strong></p>
          ${bk.passenger_phone ? `<p style="margin:4px 0 0;font-size:0.82rem;color:var(--gray)">Phone on file: ${bk.passenger_phone}</p>` : ""}
        </div>

        <div style="margin-bottom:12px">
          <div style="font-size:0.78rem;font-weight:600;color:var(--gray);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:8px">Payment Method</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-primary btn-sm cp-mthd" data-m="cash">💵 Cash</button>
            <button type="button" class="btn btn-outline btn-sm cp-mthd" data-m="mobile">📱 Mobile Money</button>
            <button type="button" class="btn btn-outline btn-sm cp-mthd" data-m="bank">🏦 Bank Transfer</button>
          </div>
        </div>

        <div id="cpMthdForm"></div>
        <div id="cpAuthMsg" style="margin-top:10px"></div>
        <button class="btn btn-primary" id="cpConfirmBtn" style="margin-top:12px;min-width:180px">Authorize Payment</button>
      `;

      const mthdForm  = $("cpMthdForm");
      const authMsg   = $("cpAuthMsg");
      const confirmBtn= $("cpConfirmBtn");
      let selMethod   = "cash";

      function renderMthdFields(m) {
        const phoneField = (label, val, req) => `
          <label style="display:block;margin-bottom:4px;font-size:0.82rem;font-weight:600;color:var(--gray)">${label}${req ? ` <small style="color:var(--danger)">* required — ticket sent here</small>` : " <small>(optional)</small>"}</label>
          <input type="tel" id="cpPhone" value="${val || ""}" placeholder="+255 7xx xxx xxx"
            style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:0.95rem;box-sizing:border-box" />`;
        if (m === "cash") {
          mthdForm.innerHTML = phoneField("Customer Phone", bk.passenger_phone, false);
        } else if (m === "mobile") {
          mthdForm.innerHTML = `
            <div style="display:grid;gap:10px">
              <div>
                <label style="display:block;margin-bottom:4px;font-size:0.82rem;font-weight:600;color:var(--gray)">Provider *</label>
                <select id="cpProvider" style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:0.95rem;box-sizing:border-box">
                  <option value="mpesa">M-Pesa (Vodacom)</option>
                  <option value="tigopesa">Tigo Pesa</option>
                  <option value="airtelmoney">Airtel Money</option>
                  <option value="halopesa">Halopesa (TTCL)</option>
                  <option value="azampesa">AzamPesa</option>
                </select>
              </div>
              <div>${phoneField("Customer Phone", bk.passenger_phone, true)}</div>
            </div>`;
        } else if (m === "bank") {
          mthdForm.innerHTML = `
            <div style="display:grid;gap:10px">
              <div>
                <label style="display:block;margin-bottom:4px;font-size:0.82rem;font-weight:600;color:var(--gray)">Bank *</label>
                <select id="cpBank" style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:0.95rem;box-sizing:border-box">
                  <option value="nmb">NMB Bank</option>
                  <option value="crdb">CRDB Bank</option>
                  <option value="nbc">NBC Bank</option>
                  <option value="equity">Equity Bank</option>
                  <option value="stanbic">Stanbic Bank</option>
                  <option value="other_bank">Other Bank</option>
                </select>
              </div>
              <div>
                <label style="display:block;margin-bottom:4px;font-size:0.82rem;font-weight:600;color:var(--gray)">Bank Reference # <small style="color:var(--danger)">* required</small></label>
                <input type="text" id="cpBankRef" placeholder="e.g. FT24001234567"
                  style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:0.95rem;box-sizing:border-box;font-family:monospace" />
              </div>
              <div>${phoneField("Customer Phone", bk.passenger_phone, true)}</div>
            </div>`;
        }
      }

      renderMthdFields("cash");

      cpResult.querySelectorAll(".cp-mthd").forEach(btn => {
        btn.addEventListener("click", () => {
          cpResult.querySelectorAll(".cp-mthd").forEach(b => {
            b.classList.remove("btn-primary");
            b.classList.add("btn-outline");
          });
          btn.classList.remove("btn-outline");
          btn.classList.add("btn-primary");
          selMethod = btn.dataset.m;
          renderMthdFields(selMethod);
          authMsg.innerHTML = "";
        });
      });

      confirmBtn.addEventListener("click", async () => {
        authMsg.innerHTML = "";
        const phone   = ($("cpPhone")?.value || "").trim();
        const bankRef = ($("cpBankRef")?.value || "").trim();
        const bank    = $("cpBank")?.value || "";
        const mobProv = $("cpProvider")?.value || "";

        let method = "cash";
        if (selMethod === "mobile") method = mobProv;
        if (selMethod === "bank")   method = bank;

        if (selMethod === "bank" && !bankRef) {
          authMsg.innerHTML = `<div class="banner error">Bank reference number is required.</div>`; return;
        }
        if (selMethod !== "cash" && !phone) {
          authMsg.innerHTML = `<div class="banner error">Customer phone is required to send the ticket.</div>`; return;
        }

        confirmBtn.disabled = true;
        confirmBtn.textContent = "Authorizing…";

        const { data: result, error } = await sb.rpc("authorize_payment", {
          p_ticket_code:    bk.ticket_code,
          p_method:         method,
          p_bank_ref:       bankRef || null,
          p_customer_phone: phone || null
        });

        if (error) {
          authMsg.innerHTML = `<div class="banner error">${error.message}</div>`;
          confirmBtn.disabled = false;
          confirmBtn.textContent = "Authorize Payment";
          return;
        }

        const sentTo = result?.passenger_phone || phone || bk.passenger_phone || "customer";
        authMsg.innerHTML = `
          <div class="banner" style="background:#f0fdf4;border-color:#86efac;color:#065f46;margin-top:4px">
            ✅ Payment authorized. Ticket sent to <strong>${sentTo}</strong> via SMS.
            ${selMethod === "bank" ? `<br><small style="opacity:0.8">Bank ref: ${bankRef}</small>` : ""}
          </div>`;
        confirmBtn.textContent = "✓ Done";
        cpCode.value = "";
        setTimeout(() => {
          cpResult.innerHTML = "";
          confirmBtn.disabled = false;
          confirmBtn.textContent = "Authorize Payment";
        }, 5000);
      });
    }
  }

  function norm(p)       { return (p || "").replace(/\s/g, ""); }
  function showErr(msg)  { const e = $("agentMsg"); e.textContent = msg; e.hidden = false; }

  // Restore last session
  if (saved) openByPhone(saved);
};
