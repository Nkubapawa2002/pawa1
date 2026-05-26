// =====================================================
// Company Dashboard — full tenant command centre
// Tabs: Overview · Shipments · Agents · Buses · Team · Settings
// Auth + tenant resolution handled by auth.js / tenant.js.
// =====================================================

const PAGE_SIZE = 25;
let _tenantId  = null;
let _tenantCtx = null;

// Shipments pagination state
let _shipPage   = 0;
let _shipFilter = { q: "", status: "" };

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ── Utility ──────────────────────────────────────────
function setText(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt ?? "—";
}
function flash(id, kind, msg, ttlMs = 4000) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = "db-status " + kind;
  el.textContent = msg;
  el.style.display = "";
  if (ttlMs) setTimeout(() => { el.style.display = "none"; el.textContent = ""; }, ttlMs);
}
function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"numeric" }); }
  catch { return iso; }
}
function shipBadge(status) {
  const cls = (status || "").replace(/\s+/g, "-");
  return `<span class="st-badge ${cls}">${status || "—"}</span>`;
}
function roleBadge(role) {
  return `<span class="role-badge ${role}">${role}</span>`;
}
function stars(avg, count) {
  if (!count) return `<span class="muted">No ratings</span>`;
  const full = Math.round(avg);
  return `<span class="rating-stars">${"★".repeat(full)}${"☆".repeat(5 - full)}</span> <span style="font-size:0.78rem;color:#888;">${Number(avg).toFixed(1)} (${count})</span>`;
}
function emptyState(icon, msg) {
  return `<div class="empty-state"><div class="es-icon">${icon}</div><div>${msg}</div></div>`;
}
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ══════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════
window.initDashboard = async () => {
  const sb   = window.SB;
  const login = document.getElementById("dbLogin");
  const forb  = document.getElementById("dbForbidden");
  const head  = document.getElementById("dbHeader");
  const tabs  = document.getElementById("dbTabs");

  function show(el) { el.hidden = false; }
  function hide(el) { el.hidden = true;  }

  // switchTab must live inside initDashboard so it can see the load* functions
  // defined below via closure. Exposing it on window keeps the inline onclick
  // handlers in dashboard.html working.
  function switchTab(name) {
    document.querySelectorAll(".db-tab").forEach(b => {
      b.classList.toggle("active", b.dataset.tab === name);
    });
    document.querySelectorAll(".db-tab-panel").forEach(p => {
      p.hidden = p.id !== "tab" + capitalize(name);
    });
    if (name === "shipments"       && !document.getElementById("shipmentsTableWrap").dataset.loaded) loadShipments();
    if (name === "agents"          && !document.getElementById("agentGridWrap").dataset.loaded)    loadAgentTab();
    if (name === "buses"           && !document.getElementById("busListWrap").dataset.loaded)      loadBuses();
    if (name === "team"            && !document.getElementById("teamTableWrap").dataset.loaded)    loadTeam();
    if (name === "aiConversations" && !document.getElementById("aiResponsesWrap").dataset.loaded) loadAiConversations();
    if (name === "cancelTrip"      && !document.getElementById("ctHistoryWrap").dataset.loaded)  loadCancelTrip();
  }
  window.switchTab = switchTab;

  document.getElementById("loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    const email = document.getElementById("loginEmail").value.trim();
    const pwd   = document.getElementById("loginPassword").value;
    const err   = document.getElementById("loginError");
    err.hidden = true;
    try {
      await window.Auth.signIn(email, pwd);
      await boot();
    } catch (ex) {
      err.textContent = ex.message || String(ex);
      err.hidden = false;
    }
  });

  document.getElementById("signOutBtn").addEventListener("click",  () => window.Auth.signOut().then(() => location.reload()));
  document.getElementById("signOutBtn2").addEventListener("click", () => window.Auth.signOut().then(() => location.reload()));

  document.querySelectorAll(".db-tab").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.getElementById("refreshAll").addEventListener("click", () => {
    if (_tenantId) { loadOverviewStats(_tenantId); refreshMetrics(); loadOnboarding(_tenantId); }
  });

  async function boot() {
    const session = await window.Auth.getSession();
    if (!session) { hide(forb); hide(head); hide(tabs); show(login); return; }

    const tenant = await window.loadTenantContext();
    if (!tenant || tenant.status !== "active") {
      setText("whoami", session.user?.email || "");
      hide(login); hide(head); hide(tabs); show(forb);
      return;
    }

    _tenantId  = tenant.id;
    _tenantCtx = tenant;

    hide(login); hide(forb); show(head); show(tabs);
    setText("tenantName",      tenant.display_name || tenant.slug);
    setText("tenantSlug",      tenant.slug);
    setText("tenantId",        tenant.id);
    setText("tenantApprovedAt", fmtDate(tenant.approved_at));
    const ts = document.getElementById("tenantStatus");
    ts.textContent = tenant.status;
    ts.className   = "pill-status " + tenant.status;

    switchTab("overview");
    await Promise.all([
      loadOverviewStats(tenant.id),
      loadSettingsForm(tenant.id),
      loadKeyStatus(tenant.id),
      refreshMetrics(),
      loadOnboarding(tenant.id),
      populateRegionDropdowns(),
    ]);
    loadRecentShipments(tenant.id);
  }

  await boot();

  // ══════════════════════════════════════════════════
  // OVERVIEW — KPI counts
  // ══════════════════════════════════════════════════
  async function loadOverviewStats(tenantId) {
    try {
      const [shipR, agentR, busR, teamR] = await Promise.all([
        sb.from("shipments").select("status").eq("tenant_id", tenantId),
        sb.from("agents").select("id").eq("tenant_id", tenantId),
        sb.from("buses").select("id").eq("tenant_id", tenantId),
        sb.from("tenant_users").select("user_id").eq("tenant_id", tenantId),
      ]);
      const rows      = shipR.data || [];
      setText("kpiShipments", rows.length);
      setText("kpiInTransit", rows.filter(r => r.status === "In Transit").length);
      setText("kpiDelivered",  rows.filter(r => r.status === "Delivered").length);
      setText("kpiAgents",    agentR.data?.length ?? "—");
      setText("kpiBuses",     busR.data?.length   ?? "—");
      setText("kpiTeam",      teamR.data?.length  ?? "—");
    } catch (e) { console.warn("Overview stats:", e); }
  }

  async function loadRecentShipments(tenantId) {
    const wrap = document.getElementById("recentShipmentsWrap");
    try {
      const { data } = await sb.from("shipments")
        .select("tracking_code, product_description, sender_name, receiver_name, status, created_at")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(5);
      if (!data?.length) { wrap.innerHTML = emptyState("📦", "No shipments yet."); return; }
      wrap.innerHTML = `
        <div class="db-table-wrap">
          <table class="db-table">
            <thead><tr><th>Tracking</th><th>Product</th><th>From</th><th>To</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>
              ${data.map(s => `<tr>
                <td class="mono">${s.tracking_code}</td>
                <td>${s.product_description || "—"}</td>
                <td>${s.sender_name}</td>
                <td>${s.receiver_name}</td>
                <td>${shipBadge(s.status)}</td>
                <td class="muted">${fmtDate(s.created_at)}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>`;
    } catch (e) { wrap.innerHTML = emptyState("⚠️", "Could not load."); }
  }

  // ══════════════════════════════════════════════════
  // ONBOARDING CHECKLIST
  // ══════════════════════════════════════════════════
  async function loadOnboarding(tenantId) {
    try {
      const [ksR, busR, agentR] = await Promise.all([
        sb.from("tenant_secret_status")
          .select("anthropic_configured, vapi_private_configured, at_configured, payment_configured")
          .eq("tenant_id", tenantId).maybeSingle(),
        sb.from("buses").select("id").eq("tenant_id", tenantId).limit(1),
        sb.from("agents").select("id").eq("tenant_id", tenantId).limit(1),
      ]);
      const ks = ksR.data || {};

      const steps = [
        { done: !!ks.anthropic_configured,  label: "Anthropic API key configured",   action: "settings", actionLabel: "Set up →" },
        { done: !!ks.vapi_private_configured,label: "VAPI voice agent configured",    action: "settings", actionLabel: "Set up →" },
        { done: !!ks.payment_configured,     label: "Payment gateway configured",     action: "settings", actionLabel: "Set up →" },
        { done: !!(busR.data?.length),       label: "At least one bus added",         action: "buses",    actionLabel: "Add bus →" },
        { done: !!(agentR.data?.length),     label: "At least one agent added",       action: "agents",   actionLabel: "Add agent →" },
      ];

      const allDone = steps.every(s => s.done);
      const section = document.getElementById("onboardingSection");
      section.hidden = allDone;

      if (!allDone) {
        const list = document.getElementById("onboardingList");
        list.innerHTML = steps.map(s => `
          <li>
            <div class="check-icon ${s.done ? "done" : "todo"}">${s.done ? "✓" : "!"}</div>
            <span style="${s.done ? "text-decoration:line-through; color:#aaa;" : ""}">${s.label}</span>
            ${!s.done ? `<button class="btn btn-outline btn-sm check-action" onclick="window.switchTab('${s.action}')">${s.actionLabel}</button>` : ""}
          </li>`).join("");
      }
    } catch (e) { console.warn("Onboarding check:", e); }
  }

  // ══════════════════════════════════════════════════
  // SHIPMENTS TAB
  // ══════════════════════════════════════════════════
  document.getElementById("shipSearchBtn").addEventListener("click", () => {
    _shipFilter.q      = document.getElementById("shipSearch").value.trim();
    _shipFilter.status = document.getElementById("shipStatusFilter").value;
    _shipPage = 0;
    loadShipments();
  });
  document.getElementById("shipSearch").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("shipSearchBtn").click();
  });
  document.getElementById("shipPrevBtn").addEventListener("click", () => { _shipPage--; loadShipments(); });
  document.getElementById("shipNextBtn").addEventListener("click", () => { _shipPage++; loadShipments(); });

  async function loadShipments() {
    if (!_tenantId) return;
    const wrap = document.getElementById("shipmentsTableWrap");
    wrap.dataset.loaded = "1";
    wrap.innerHTML = emptyState("⏳", "Loading shipments…");

    const from = _shipPage * PAGE_SIZE;
    const to   = from + PAGE_SIZE - 1;
    let q = sb.from("shipments")
      .select("tracking_code, product_description, product_weight_kg, sender_name, sender_region, receiver_name, receiver_region, status, bus_name, created_at", { count: "exact" })
      .eq("tenant_id", _tenantId)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (_shipFilter.status) q = q.eq("status", _shipFilter.status);
    if (_shipFilter.q) {
      const term = `%${_shipFilter.q}%`;
      q = q.or(`tracking_code.ilike.${term},sender_name.ilike.${term},receiver_name.ilike.${term}`);
    }

    const { data, count } = await q;
    if (!data?.length) { wrap.innerHTML = emptyState("📦", "No shipments found."); return; }

    setText("shipmentsCount", `${count ?? data.length} total`);
    document.getElementById("shipPageInfo").textContent = `Page ${_shipPage + 1} of ${Math.ceil((count || data.length) / PAGE_SIZE)}`;
    document.getElementById("shipPrevBtn").disabled = _shipPage === 0;
    document.getElementById("shipNextBtn").disabled = (from + PAGE_SIZE) >= (count || data.length);

    wrap.innerHTML = `
      <div class="db-table-wrap">
        <table class="db-table">
          <thead><tr><th>Tracking</th><th>Product</th><th>From</th><th>To</th><th>Bus</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>
            ${data.map(s => `<tr>
              <td class="mono">${s.tracking_code}</td>
              <td>${s.product_description || "—"} <span class="muted">${s.product_weight_kg}kg</span></td>
              <td>${s.sender_name}<br><span class="muted">${s.sender_region}</span></td>
              <td>${s.receiver_name}<br><span class="muted">${s.receiver_region}</span></td>
              <td class="muted">${s.bus_name || "—"}</td>
              <td>${shipBadge(s.status)}</td>
              <td class="muted">${fmtDate(s.created_at)}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }

  // ══════════════════════════════════════════════════
  // AGENTS TAB — add agent + applications + list
  // ══════════════════════════════════════════════════

  // Populate region dropdowns from regions table
  async function populateRegionDropdowns() {
    const { data } = await sb.from("regions").select("name").order("name");
    if (!data?.length) return;
    const selects = ["ag_region"];
    selects.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = `<option value="">— select —</option>` +
        data.map(r => `<option value="${r.name}">${r.name}</option>`).join("");
    });
  }

  // Add agent form
  document.getElementById("addAgentForm").addEventListener("submit", async e => {
    e.preventDefault();
    if (!_tenantId) return;
    const name     = document.getElementById("ag_name").value.trim();
    const phone    = document.getElementById("ag_phone").value.trim();
    const region   = document.getElementById("ag_region").value;
    const terminal = document.getElementById("ag_terminal").value.trim();
    const email    = document.getElementById("ag_email").value.trim() || null;
    const exp      = parseInt(document.getElementById("ag_exp").value) || 1;

    // Generate agent id: next in sequence for this tenant
    const { data: existing } = await sb.from("agents")
      .select("id").eq("tenant_id", _tenantId).like("id", "AG%");
    const nums = (existing || []).map(a => parseInt((a.id.match(/\d+$/) || ["0"])[0])).filter(Boolean);
    const next = nums.length ? Math.max(...nums) + 1 : 1;
    const id   = "AG" + String(next).padStart(3, "0");

    const { error } = await sb.from("agents").insert({
      id, name, phone, region, terminal,
      email, experience_years: exp,
      verified: true, buses: [], tenant_id: _tenantId,
    });

    if (error) {
      flash("addAgentStatus", "err", "Failed: " + error.message, 6000);
    } else {
      flash("addAgentStatus", "ok", `Agent ${name} added as ${id}.`);
      document.getElementById("addAgentForm").reset();
      document.getElementById("agentGridWrap").dataset.loaded = "";
      loadAgentTab();
      loadOverviewStats(_tenantId);
      loadOnboarding(_tenantId);
    }
  });

  document.getElementById("agentSearchBtn").addEventListener("click", () => {
    const q = document.getElementById("agentSearch").value.trim();
    if (_tenantId) loadAgents(q);
  });
  document.getElementById("agentSearch").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("agentSearchBtn").click();
  });

  async function loadAgentTab() {
    await Promise.all([loadAgents(), loadAgentApplications()]);
  }

  async function loadAgents(searchQ = "") {
    if (!_tenantId) return;
    const wrap = document.getElementById("agentGridWrap");
    wrap.dataset.loaded = "1";
    wrap.innerHTML = emptyState("⏳", "Loading…");

    let q = sb.from("agents")
      .select("id, name, phone, region, terminal, buses, verified, rating_avg, rating_count, email")
      .eq("tenant_id", _tenantId).order("name");

    if (searchQ) {
      const term = `%${searchQ}%`;
      q = q.or(`name.ilike.${term},phone.ilike.${term},region.ilike.${term},terminal.ilike.${term}`);
    }

    const { data, error } = await q;
    setText("agentsCount", data ? `${data.length} agent${data.length !== 1 ? "s" : ""}` : "");

    if (error || !data?.length) {
      wrap.innerHTML = emptyState("👥", error ? "Error: " + error.message : "No agents yet. Add one above.");
      return;
    }

    wrap.className = "agent-grid";
    wrap.innerHTML = data.map(a => `
      <div class="agent-card">
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div>
            <div class="ac-name">${a.name}</div>
            <div class="ac-id">${a.id}</div>
          </div>
          <span style="font-size:0.72rem; padding:2px 8px; border-radius:999px; font-weight:700;
            background:${a.verified ? "#e0f5e7" : "#ffe1d6"};
            color:${a.verified ? "#1a5a30" : "#802b00"}">
            ${a.verified ? "Verified" : "Unverified"}
          </span>
        </div>
        <div class="ac-row">Phone: <span>${a.phone}</span> ${a.phone ? window.DataStore.renderCallButtons(a.phone) : ""}</div>
        <div class="ac-row">Region: <span>${a.region}</span></div>
        ${a.terminal ? `<div class="ac-row">Terminal: <span>${a.terminal}</span></div>` : ""}
        ${a.email    ? `<div class="ac-row">Email: <span>${a.email}</span></div>` : ""}
        <div class="ac-row" style="margin-top:8px;">${stars(a.rating_avg, a.rating_count)}</div>
        ${(a.buses || []).length ? `<div style="margin-top:8px;">${a.buses.map(b => `<span class="route-pill">${b}</span>`).join("")}</div>` : ""}
      </div>`).join("");
  }

  async function loadAgentApplications() {
    if (!_tenantId) return;
    const wrap = document.getElementById("agentAppsWrap");

    const { data, error } = await sb.from("agent_applications")
      .select("id, full_name, phone, region, terminal, status, created_at, reject_reason")
      .eq("tenant_id", _tenantId)
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (error) { wrap.innerHTML = emptyState("⚠️", error.message); return; }
    if (!data?.length) { wrap.innerHTML = emptyState("📋", "No pending applications."); return; }

    wrap.innerHTML = data.map(app => `
      <div class="app-card" id="app-${app.id}">
        <div class="app-name">${app.full_name}</div>
        <div class="app-meta">${app.phone} · ${app.region} · ${app.terminal}</div>
        <div class="app-meta">Applied ${fmtDate(app.created_at)}</div>
        <div class="app-actions">
          ${app.phone ? window.DataStore.renderCallButtons(app.phone) : ""}
          <button class="btn btn-primary btn-sm" onclick="approveApp(${app.id})">Approve</button>
          <button class="btn btn-outline btn-sm" onclick="rejectApp(${app.id})">Reject</button>
        </div>
      </div>`).join("");
  }

  window.approveApp = async (appId) => {
    const { error } = await sb.rpc("approve_agent_application", { p_app_id: appId });
    if (error) { alert("Approve failed: " + error.message); return; }
    document.getElementById("app-" + appId)?.remove();
    loadAgents();
  };

  window.rejectApp = async (appId) => {
    const reason = prompt("Reason for rejection (optional):");
    if (reason === null) return;
    const { error } = await sb.rpc("reject_agent_application", { p_app_id: appId, p_reason: reason || "" });
    if (error) { alert("Reject failed: " + error.message); return; }
    document.getElementById("app-" + appId)?.remove();
  };

  // ══════════════════════════════════════════════════
  // BUSES TAB — add bus + add/remove routes
  // ══════════════════════════════════════════════════

  document.getElementById("addBusForm").addEventListener("submit", async e => {
    e.preventDefault();
    if (!_tenantId) return;
    const name    = document.getElementById("bus_name").value.trim();
    const contact = document.getElementById("bus_contact").value.trim();
    const seats   = parseInt(document.getElementById("bus_seats").value) || 50;
    const about   = document.getElementById("bus_about").value.trim() || null;

    // Generate a slug-style id: slugify name + tenant prefix
    const slug  = slugify(name);
    const ts    = _tenantCtx?.slug || "t";
    const busId = `${ts}-${slug}`.slice(0, 40);

    const { error } = await sb.from("buses").insert({
      id: busId, name, contact, about,
      routes: [], seats_total: seats,
      verified: true, tenant_id: _tenantId,
    });

    if (error) {
      flash("addBusStatus", "err", error.code === "23505" ? "A bus with that name already exists." : "Failed: " + error.message, 6000);
    } else {
      flash("addBusStatus", "ok", `${name} saved.`);
      document.getElementById("addBusForm").reset();
      document.getElementById("bus_seats").value = "50";
      document.getElementById("busListWrap").dataset.loaded = "";
      loadBuses();
      loadOverviewStats(_tenantId);
      loadOnboarding(_tenantId);
    }
  });

  // Loaded buses are cached so the search can filter without a round-trip.
  let _busCache = [];

  async function loadBuses() {
    const wrap = document.getElementById("busListWrap");
    wrap.dataset.loaded = "1";
    wrap.innerHTML = emptyState("⏳", "Loading buses…");

    // Platform admins (email in APP_CONFIG.ADMIN_EMAILS) see every bus across
    // all tenants so they can edit any seat layout. Regular tenant users only
    // see their own company's buses.
    const email = await window.Auth.currentEmail();
    const isPlatformAdmin = window.Auth.isAllowedEmail(email);

    if (!isPlatformAdmin && !_tenantId) {
      _busCache = [];
      wrap.innerHTML = emptyState("🚌", "No tenant context — sign in to your company account.");
      return;
    }

    let query = sb.from("buses")
      .select("id, name, contact, routes, about, verified, seats_total, seat_names, seat_layout, tenant_id")
      .order("name")
      .limit(2000);
    if (!isPlatformAdmin) query = query.eq("tenant_id", _tenantId);

    const { data, error } = await query;

    const scopeLabel = isPlatformAdmin ? "all tenants" : "your company";
    setText("busesCount", data ? `${data.length} bus${data.length !== 1 ? "es" : ""} · ${scopeLabel}` : "");

    if (error || !data?.length) {
      _busCache = [];
      wrap.innerHTML = emptyState("🚌", error ? "Error: " + error.message : "No buses yet. Add one above.");
      return;
    }

    _busCache = data;
    renderBusCards(_busCache);

    // Admin-only: reveal the pending-approvals section and fetch the queue.
    const pendingSection = document.getElementById("pendingLayoutSection");
    if (pendingSection) {
      pendingSection.hidden = !isPlatformAdmin;
      if (isPlatformAdmin) loadPendingLayoutEdits();
    }
  }

  // ── Pending seat-layout edits queue (admin only) ─────────────────────────
  async function loadPendingLayoutEdits() {
    const wrap = document.getElementById("pendingLayoutWrap");
    if (!wrap) return;
    wrap.innerHTML = emptyState("⏳", "Loading pending edits…");

    const { data, error } = await sb.from("bus_layout_pending")
      .select("id, bus_id, tenant_id, proposed_by_email, proposed_at, seats_total, seat_layout, status")
      .eq("status", "pending")
      .order("proposed_at", { ascending: false })
      .limit(200);

    if (error) {
      wrap.innerHTML = emptyState("⚠️", "Could not load queue: " + error.message);
      return;
    }
    if (!data?.length) {
      wrap.innerHTML = emptyState("✅", "No pending seat-layout edits. Everything is approved.");
      return;
    }

    wrap.innerHTML = data.map(row => {
      const itemCount = Array.isArray(row.seat_layout?.items)
        ? row.seat_layout.items.filter(it => it.type === "seat").length
        : (row.seats_total ?? "?");
      return `
        <div class="bus-card" data-pending-id="${row.id}"
             style="border:1px solid #fcd9a8; background:#fff;">
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px;">
            <span style="font-weight:700; font-size:1rem;">${row.bus_id}</span>
            <span style="font-size:0.72rem; padding:2px 8px; border-radius:999px; background:#fff3e0; color:#8a4b00; font-weight:700;">${itemCount} seat${itemCount !== 1 ? "s" : ""}</span>
            <span style="font-size:0.78rem; color:#666;">proposed by ${row.proposed_by_email || "?"} · ${fmtDate(row.proposed_at)}</span>
          </div>
          <div style="font-size:0.78rem; color:#777; margin-bottom:8px;">
            tenant <span class="copyable">${row.tenant_id}</span>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm"  data-pending-approve="${row.id}">✓ Approve &amp; apply</button>
            <button class="btn btn-outline btn-sm" data-pending-reject="${row.id}">✕ Reject</button>
            <button class="btn btn-outline btn-sm" data-pending-preview="${row.bus_id}">👁 Preview in editor</button>
            <span class="db-status muted" id="pendStatus_${row.id}" style="display:none; font-size:0.82rem;"></span>
          </div>
        </div>`;
    }).join("");
  }

  async function approvePendingLayout(requestId) {
    const statusEl = document.getElementById(`pendStatus_${requestId}`);
    if (statusEl) { statusEl.style.display = ""; statusEl.className = "db-status muted"; statusEl.textContent = "Applying…"; }
    const { error } = await sb.rpc("approve_bus_layout", { p_request_id: requestId });
    if (error) {
      if (statusEl) { statusEl.className = "db-status err"; statusEl.textContent = error.message; }
      return;
    }
    // Refresh both queue and the bus list (so the new seat count shows).
    await Promise.all([loadPendingLayoutEdits(), loadBuses()]);
  }

  async function rejectPendingLayout(requestId) {
    const note = prompt("Reason for rejection (optional):") || null;
    const statusEl = document.getElementById(`pendStatus_${requestId}`);
    if (statusEl) { statusEl.style.display = ""; statusEl.className = "db-status muted"; statusEl.textContent = "Rejecting…"; }
    const { error } = await sb.rpc("reject_bus_layout", { p_request_id: requestId, p_note: note });
    if (error) {
      if (statusEl) { statusEl.className = "db-status err"; statusEl.textContent = error.message; }
      return;
    }
    loadPendingLayoutEdits();
  }

  // Single delegated listener so we don't rebind every render.
  document.getElementById("pendingLayoutWrap")?.addEventListener("click", (e) => {
    const apId = e.target.getAttribute?.("data-pending-approve");
    const rjId = e.target.getAttribute?.("data-pending-reject");
    const pvBus = e.target.getAttribute?.("data-pending-preview");
    if (apId) approvePendingLayout(apId);
    else if (rjId) rejectPendingLayout(rjId);
    else if (pvBus) window.openSeatCanvas?.(pvBus);
  });
  document.getElementById("pendingRefreshBtn")?.addEventListener("click", loadPendingLayoutEdits);

  // Client-side filter. Reapplied every time the search input changes.
  function filterBuses(q) {
    const term = q.trim().toLowerCase();
    if (!term) {
      setText("busesCount", `${_busCache.length} bus${_busCache.length !== 1 ? "es" : ""}`);
      renderBusCards(_busCache);
      return;
    }
    const hits = _busCache.filter(b => {
      const hay = [
        b.id, b.name, b.contact, b.about, b.tenant_id,
        ...(Array.isArray(b.routes) ? b.routes.flatMap(r => [r.from, r.to, r.departure]) : [])
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(term);
    });
    setText("busesCount", `${hits.length} of ${_busCache.length} bus${_busCache.length !== 1 ? "es" : ""}`);
    if (!hits.length) {
      document.getElementById("busListWrap").innerHTML =
        emptyState("🔎", `No buses match "${q}". Clear the search to see all.`);
      return;
    }
    renderBusCards(hits);
  }

  function renderBusCards(buses) {
    const wrap = document.getElementById("busListWrap");
    wrap.innerHTML = buses.map(bus => {
      const routes = Array.isArray(bus.routes) ? bus.routes : [];
      const routeRows = routes.map((r, i) => `
        <div class="route-row">
          <span class="route-pill">${r.from || "?"} → ${r.to || "?"}</span>
          <span class="muted">Dep: ${r.departure || "—"}</span>
          <span class="muted">${r.duration_hours ? r.duration_hours + "h" : ""}</span>
          <button class="route-del" onclick="removeRoute('${bus.id}', ${i})" title="Remove route">✕</button>
        </div>`).join("");

      return `
        <div class="bus-card" id="buscard-${bus.id}">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">
            <span style="font-weight:700; font-size:1rem;">${bus.name}</span>
            <span style="font-family:monospace; font-size:0.75rem; color:#888;">${bus.id}</span>
            ${bus.verified ? `<span style="font-size:0.72rem; padding:2px 8px; border-radius:999px; background:#e0f5e7; color:#1a5a30; font-weight:700;">Verified</span>` : ""}
          </div>
          ${bus.contact ? `<div style="font-size:0.82rem; color:#555;">Contact: ${bus.contact}</div>` : ""}
          ${bus.about   ? `<div style="font-size:0.82rem; color:#555; margin-top:2px;">${bus.about}</div>` : ""}
          ${bus.seats_total ? `<div style="font-size:0.78rem; color:#888; margin-top:2px;">${bus.seats_total} seats</div>` : ""}

          <div style="margin-top:12px;">
            <strong style="font-size:0.82rem; color:#444; text-transform:uppercase; letter-spacing:0.4px;">Routes</strong>
            ${routeRows || `<div class="muted" style="font-size:0.82rem; margin-top:6px;">No routes yet.</div>`}
          </div>

          <!-- Add route inline form -->
          <button class="btn btn-outline btn-sm" style="margin-top:10px;"
            onclick="toggleRouteForm('${bus.id}')">+ Add Route</button>
          <button class="btn btn-primary btn-sm" style="margin-top:10px;"
            onclick="openSeatCanvas('${bus.id}')">🎨 Edit Seats (canvas)</button>

          <div class="add-route-form" id="rform-${bus.id}">
            <strong style="font-size:0.82rem;">New route for ${bus.name}</strong>
            <div class="route-grid" style="margin-top:10px;">
              <div>
                <label>From</label>
                <input type="text" id="rf_from_${bus.id}" placeholder="Dar es Salaam" />
              </div>
              <div>
                <label>To</label>
                <input type="text" id="rf_to_${bus.id}" placeholder="Mwanza" />
              </div>
              <div>
                <label>Departure (outbound)</label>
                <input type="text" id="rf_dep_${bus.id}" placeholder="06:00" />
              </div>
              <div>
                <label>Departure (return)</label>
                <input type="text" id="rf_ret_${bus.id}" placeholder="14:00" />
              </div>
              <div>
                <label>Duration (hours)</label>
                <input type="number" id="rf_dur_${bus.id}" min="0.5" step="0.5" value="8" />
              </div>
            </div>
            <div style="display:flex; gap:8px; margin-top:10px;">
              <button class="btn btn-primary btn-sm" onclick="saveRoute('${bus.id}')">Save route</button>
              <button class="btn btn-outline btn-sm" onclick="toggleRouteForm('${bus.id}')">Cancel</button>
              <span id="rform_status_${bus.id}" class="db-status muted" style="display:none; font-size:0.82rem;"></span>
            </div>
          </div>
        </div>`;
    }).join("");
  }

  window.toggleRouteForm = (busId) => {
    const form = document.getElementById("rform-" + busId);
    if (form) form.classList.toggle("open");
  };

  // ── Seat canvas modal ─────────────────────────────────────────────
  // Opens the shared drag-and-drop canvas editor (seat-canvas-editor.js)
  // in a modal overlay, scoped to a single bus. Visibility is toggled via
  // style.display (not the `hidden` attr) because the backdrop carries an
  // inline display:flex when open, which would otherwise override `hidden`.
  window.openSeatCanvas = (busId) => {
    try {
      const backdrop = document.getElementById("seatModalBackdrop");
      const body     = document.getElementById("seatModalBody");
      const title    = document.getElementById("seatModalTitle");
      if (!backdrop || !body || !title) {
        console.error("[openSeatCanvas] modal markup missing", { backdrop, body, title });
        alert("Seat editor markup missing from the page.");
        return;
      }
      const bus = _busCache.find(b => b.id === busId);
      if (!bus) {
        console.error("[openSeatCanvas] bus not in cache", busId, _busCache);
        alert("Could not find that bus — try clicking Buses & Routes again.");
        return;
      }
      title.textContent = `🎨 Seat editor — ${bus.name}`;
      body.innerHTML = "";
      backdrop.style.display = "flex";
      document.body.style.overflow = "hidden";
      if (!window.renderSeatCanvasEditor) {
        body.innerHTML = '<div class="db-status err">Seat editor module failed to load (seat-canvas-editor.js missing).</div>';
        return;
      }
      window.renderSeatCanvasEditor(body, bus, sb, {
        onSaved: (updated) => {
          const idx = _busCache.findIndex(b => b.id === updated.id);
          if (idx >= 0) _busCache[idx] = { ..._busCache[idx], ...updated };
          const q = (document.getElementById("busSearch")?.value || "").trim();
          if (q) filterBuses(q); else renderBusCards(_busCache);
        },
        onSubmitted: () => {
          // Tenant submitted a pending edit — refresh the admin queue so it
          // shows up immediately for any admin viewing the same dashboard.
          loadPendingLayoutEdits();
        }
      });
    } catch (err) {
      console.error("[openSeatCanvas] failed", err);
      alert("Seat editor crashed: " + (err.message || err));
    }
  };

  function closeSeatModal() {
    const backdrop = document.getElementById("seatModalBackdrop");
    if (!backdrop) return;
    backdrop.style.display = "none";
    document.body.style.overflow = "";
    const body = document.getElementById("seatModalBody");
    if (body) body.innerHTML = "";
  }
  document.getElementById("seatModalClose")?.addEventListener("click", closeSeatModal);
  document.getElementById("seatModalBackdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "seatModalBackdrop") closeSeatModal();
  });

  // ── Bus search wiring ────────────────────────────────────────────
  const _busSearchEl   = document.getElementById("busSearch");
  const _busSearchClear = document.getElementById("busSearchClear");
  if (_busSearchEl) {
    _busSearchEl.addEventListener("input", () => filterBuses(_busSearchEl.value));
  }
  if (_busSearchClear) {
    _busSearchClear.addEventListener("click", () => {
      if (_busSearchEl) _busSearchEl.value = "";
      filterBuses("");
    });
  }

  window.saveRoute = async (busId) => {
    const from     = document.getElementById(`rf_from_${busId}`)?.value.trim();
    const to       = document.getElementById(`rf_to_${busId}`)?.value.trim();
    const dep      = document.getElementById(`rf_dep_${busId}`)?.value.trim();
    const ret      = document.getElementById(`rf_ret_${busId}`)?.value.trim();
    const dur      = parseFloat(document.getElementById(`rf_dur_${busId}`)?.value) || 8;
    const statusEl = document.getElementById(`rform_status_${busId}`);

    if (!from || !to || !dep || !ret) {
      if (statusEl) { statusEl.className = "db-status err"; statusEl.textContent = "Fill all fields."; statusEl.style.display = ""; }
      return;
    }

    // Fetch current routes then append
    const { data: busRow, error: fetchErr } = await sb.from("buses")
      .select("routes").eq("id", busId).single();
    if (fetchErr) { alert("Fetch failed: " + fetchErr.message); return; }

    const current = Array.isArray(busRow.routes) ? busRow.routes : [];
    const updated = [
      ...current,
      { from, to, departure: dep, duration_hours: dur },
      { from: to, to: from, departure: ret, duration_hours: dur },
    ];

    const { error } = await sb.from("buses")
      .update({ routes: updated }).eq("id", busId).eq("tenant_id", _tenantId);

    if (error) {
      if (statusEl) { statusEl.className = "db-status err"; statusEl.textContent = "Failed: " + error.message; statusEl.style.display = ""; }
    } else {
      document.getElementById("busListWrap").dataset.loaded = "";
      loadBuses();
      loadOnboarding(_tenantId);
    }
  };

  window.removeRoute = async (busId, routeIndex) => {
    if (!confirm("Remove this route?")) return;
    const { data: busRow } = await sb.from("buses").select("routes").eq("id", busId).single();
    const routes = (busRow?.routes || []).filter((_, i) => i !== routeIndex);
    await sb.from("buses").update({ routes }).eq("id", busId).eq("tenant_id", _tenantId);
    document.getElementById("busListWrap").dataset.loaded = "";
    loadBuses();
  };

  // ══════════════════════════════════════════════════
  // TEAM TAB
  // ══════════════════════════════════════════════════
  document.getElementById("inviteForm").addEventListener("submit", async e => {
    e.preventDefault();
    if (!_tenantId) return;
    const email   = document.getElementById("inviteEmail").value.trim();
    const role    = document.getElementById("inviteRole").value;
    const session = await window.Auth.getSession();
    if (!session) return;

    const { error } = await sb.from("tenant_invites").insert({
      tenant_id: _tenantId, email, role, invited_by: session.user.id,
    });

    if (error) {
      flash("inviteStatus", "err", "Failed: " + error.message, 5000);
    } else {
      flash("inviteStatus", "ok", `Invite sent to ${email}.`);
      document.getElementById("inviteEmail").value = "";
      loadTeam();
    }
  });

  // ══════════════════════════════════════════════════
  // CANCEL TRIP
  // ══════════════════════════════════════════════════
  async function loadCancelTrip() {
    if (!_tenantId) return;
    const histWrap  = document.getElementById("ctHistoryWrap");
    const permWarn  = document.getElementById("ctPermWarn");
    const ctForm    = document.getElementById("ctForm");
    const ctStatus  = document.getElementById("ctStatus");
    const ctBusEl   = document.getElementById("ctBusId");
    const refreshBtn= document.getElementById("ctRefreshBtn");
    if (!histWrap) return;
    histWrap.dataset.loaded = "1";

    // Check current user's cancellation permission
    const { data: { user } } = await sb.auth.getUser();
    let canCancel = false;
    if (user) {
      const { data: tu } = await sb.from("tenant_users")
        .select("can_cancel_trips, role")
        .eq("tenant_id", _tenantId).eq("user_id", user.id).maybeSingle();
      canCancel = !!(tu?.can_cancel_trips);
      // Owners and admins implicitly have it
      if (tu?.role === "owner" || tu?.role === "admin") canCancel = true;
    }

    if (!canCancel) {
      permWarn.style.display = "";
      ctForm.style.opacity = "0.4";
      ctForm.querySelectorAll("input,select,textarea,button").forEach(el => el.disabled = true);
    } else {
      permWarn.style.display = "none";
      // Populate bus selector
      const { data: buses } = await sb.from("buses").select("id,name").eq("tenant_id", _tenantId).order("name");
      (buses || []).forEach(b => {
        const o = document.createElement("option");
        o.value = b.id; o.textContent = b.name;
        ctBusEl.appendChild(o);
      });

      ctForm.addEventListener("submit", async e => {
        e.preventDefault();
        const busId  = ctBusEl.value;
        const date   = document.getElementById("ctDate").value;
        const dep    = document.getElementById("ctDeparture").value || null;
        const from   = document.getElementById("ctFrom").value.trim() || null;
        const to     = document.getElementById("ctTo").value.trim() || null;
        const reason = document.getElementById("ctReason").value.trim();

        if (!busId || !date || !reason) return;

        const submitBtn = document.getElementById("ctSubmitBtn");
        submitBtn.disabled = true; submitBtn.textContent = "Submitting…";
        ctStatus.style.display = "none";

        const { error } = await sb.rpc("request_trip_cancellation", {
          p_bus_id: busId, p_travel_date: date,
          p_departure_time: dep, p_route_from: from, p_route_to: to,
          p_reason: reason
        });

        if (error) {
          ctStatus.textContent = error.message;
          ctStatus.style.color = "var(--danger)";
          ctStatus.style.display = "";
        } else {
          ctStatus.textContent = "Request submitted — awaiting admin approval.";
          ctStatus.style.color = "var(--green-dark)";
          ctStatus.style.display = "";
          ctForm.reset();
          loadHistory();
        }
        submitBtn.disabled = false; submitBtn.textContent = "Submit for Admin Approval";
      });
    }

    async function loadHistory() {
      histWrap.innerHTML = `<div class="empty-state"><div class="es-icon">⏳</div><div>Loading…</div></div>`;
      const { data, error } = await sb.from("trip_cancellation_requests")
        .select("id,bus_id,travel_date,departure_time,route_from,route_to,reason,status,review_note,affected_count,created_at")
        .eq("tenant_id", _tenantId)
        .order("created_at", { ascending: false })
        .limit(30);
      if (error || !data?.length) {
        histWrap.innerHTML = `<div class="empty-state"><div class="es-icon">📋</div><div>${error ? error.message : "No requests yet."}</div></div>`;
        return;
      }
      const statusStyle = { pending: "background:#fef9c3;color:#92400e", approved: "background:#dcfce7;color:#166534", rejected: "background:#fee2e2;color:#991b1b" };
      histWrap.innerHTML = `<div class="db-table-wrap"><table class="db-table">
        <thead><tr><th>Date</th><th>Route</th><th>Reason</th><th>Status</th><th>Note</th></tr></thead>
        <tbody>
          ${data.map(r => `<tr>
            <td>${r.travel_date}${r.departure_time ? " " + r.departure_time : ""}</td>
            <td>${r.route_from || "—"} → ${r.route_to || "—"}</td>
            <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.reason}">${r.reason}</td>
            <td><span style="font-size:0.75rem;font-weight:700;border-radius:5px;padding:2px 8px;${statusStyle[r.status] || ""}">${r.status}</span>${r.affected_count != null ? ` <small>(${r.affected_count} bookings)</small>` : ""}</td>
            <td style="font-size:0.8rem;color:#666">${r.review_note || "—"}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>`;
    }

    refreshBtn?.addEventListener("click", loadHistory);
    loadHistory();
  }

  async function loadTeam() {
    if (!_tenantId) return;
    const wrap        = document.getElementById("teamTableWrap");
    const pendingWrap = document.getElementById("pendingInvitesWrap");
    wrap.dataset.loaded = "1";

    // Check if current viewer is admin/owner (can toggle permissions)
    const { data: { user: me } } = await sb.auth.getUser();
    let viewerIsAdmin = false;
    if (me) {
      const { data: myTu } = await sb.from("tenant_users")
        .select("role").eq("tenant_id", _tenantId).eq("user_id", me.id).maybeSingle();
      viewerIsAdmin = myTu?.role === "admin" || myTu?.role === "owner";
    }

    const [membersRes, invitesRes] = await Promise.all([
      sb.from("tenant_users").select("user_id, role, joined_at, can_cancel_trips").eq("tenant_id", _tenantId).order("joined_at"),
      sb.from("tenant_invites").select("id, email, role, expires_at, created_at")
        .eq("tenant_id", _tenantId).is("accepted_at", null).order("created_at", { ascending: false }),
    ]);

    const members = membersRes.data || [];
    wrap.innerHTML = !members.length ? emptyState("👤", "No members found.") : `
      <div class="db-table-wrap">
        <table class="db-table">
          <thead><tr><th>User</th><th>Role</th><th>Can Cancel Trips</th><th>Joined</th></tr></thead>
          <tbody>
            ${members.map(m => `<tr>
              <td class="mono" style="font-size:0.8rem;">${m.user_id.slice(0,8)}…</td>
              <td>${roleBadge(m.role)}</td>
              <td style="text-align:center">
                ${viewerIsAdmin
                  ? `<button class="btn btn-outline btn-sm cancel-perm-toggle"
                        data-uid="${m.user_id}"
                        data-val="${m.can_cancel_trips ? "1" : "0"}"
                        style="font-size:0.75rem;padding:2px 10px;${m.can_cancel_trips ? "color:var(--green-dark);border-color:var(--green-dark)" : ""}">
                        ${m.can_cancel_trips ? "✓ Enabled" : "Disabled"}
                     </button>`
                  : m.can_cancel_trips ? '<span style="color:var(--green-dark);font-size:0.8rem">✓</span>' : '<span style="color:#ccc;font-size:0.8rem">—</span>'}
              </td>
              <td class="muted">${fmtDate(m.joined_at)}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>`;

    // Wire toggle buttons (admin only)
    if (viewerIsAdmin) {
      wrap.querySelectorAll(".cancel-perm-toggle").forEach(btn => {
        btn.addEventListener("click", async () => {
          const uid      = btn.dataset.uid;
          const current  = btn.dataset.val === "1";
          const newVal   = !current;
          btn.disabled   = true; btn.textContent = "…";
          const { error } = await sb.from("tenant_users")
            .update({ can_cancel_trips: newVal })
            .eq("tenant_id", _tenantId).eq("user_id", uid);
          if (error) { alert(error.message); btn.disabled = false; return; }
          // Reload team table to reflect change
          wrap.dataset.loaded = "";
          loadTeam();
        });
      });
    }

    const invites = (invitesRes.data || []).filter(i => new Date(i.expires_at) > new Date());
    pendingWrap.innerHTML = !invites.length ? emptyState("✉️", "No pending invites.") : `
      <div class="db-table-wrap">
        <table class="db-table">
          <thead><tr><th>Email</th><th>Role</th><th>Sent</th><th>Expires</th></tr></thead>
          <tbody>
            ${invites.map(i => `<tr>
              <td>${i.email}</td>
              <td>${roleBadge(i.role)}</td>
              <td class="muted">${fmtDate(i.created_at)}</td>
              <td class="muted">${fmtDate(i.expires_at)}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }

  // ══════════════════════════════════════════════════
  // SETTINGS — branding
  // ══════════════════════════════════════════════════
  async function loadSettingsForm(tenantId) {
    const { data } = await sb.from("tenant_settings")
      .select("branding, languages, default_language, anthropic_model, system_prompt_overrides, vapi_assistant_id, vapi_phone_number_id, vapi_public_key, at_username, at_sender_id, at_whatsapp_number, payment_gateway")
      .eq("tenant_id", tenantId).maybeSingle();
    const s = data || {};
    const b = s.branding || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
    set("b_display",      b.company_name_display);
    set("b_agent",        b.agent_name || "PAWA");
    set("b_color",        b.primary_color || "#0B6E4F");
    set("b_logo",         b.logo_url);
    set("b_tagline",      b.tagline);
    set("b_default_lang", s.default_language || "sw");
    set("b_languages",    (s.languages || []).join(","));
    set("b_overrides",    s.system_prompt_overrides);
    set("k_anthropic_model",      s.anthropic_model || "claude-opus-4-7");
    set("k_vapi_assistant_id",    s.vapi_assistant_id);
    set("k_vapi_phone_number_id", s.vapi_phone_number_id);
    set("k_vapi_public_key",      s.vapi_public_key);
    set("k_at_username",          s.at_username);
    set("k_at_sender_id",         s.at_sender_id);
    set("k_at_whatsapp_number",   s.at_whatsapp_number);
    set("k_payment_gateway",      s.payment_gateway);
  }

  async function loadKeyStatus(tenantId) {
    const { data } = await sb.from("tenant_secret_status")
      .select("anthropic_configured, vapi_private_configured, vapi_assistant_configured, at_configured, payment_configured")
      .eq("tenant_id", tenantId).maybeSingle();
    const ks = data || {};
    const mark = (id, ok) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.className = "key-state " + (ok ? "set" : "unset");
      el.textContent = ok ? "set" : "not set";
    };
    mark("ks_anthropic",     !!ks.anthropic_configured);
    mark("ks_vapi_assistant",!!ks.vapi_assistant_configured);
    mark("ks_vapi_private",  !!ks.vapi_private_configured);
    mark("ks_at",            !!ks.at_configured);
    mark("ks_payment",       !!ks.payment_configured);
  }

  document.getElementById("brandingForm").addEventListener("submit", async e => {
    e.preventDefault();
    const tenantId = window.tenantId();
    if (!tenantId) return;
    const branding = {
      logo_url:             document.getElementById("b_logo").value || null,
      primary_color:        document.getElementById("b_color").value || "#0B6E4F",
      company_name_display: document.getElementById("b_display").value || null,
      agent_name:           document.getElementById("b_agent").value || "PAWA",
      tagline:              document.getElementById("b_tagline").value || null,
    };
    const languages = (document.getElementById("b_languages").value || "sw,en")
      .split(",").map(s => s.trim()).filter(Boolean);
    const { error } = await sb.rpc("update_tenant_branding", {
      _tenant_id: tenantId, _branding: branding,
      _languages: languages,
      _default_language: document.getElementById("b_default_lang").value,
      _system_prompt_overrides: document.getElementById("b_overrides").value || null,
    });
    const el = document.getElementById("brandingStatus");
    if (error) { el.className = "db-status err"; el.textContent = "Failed: " + error.message; }
    else       { el.className = "db-status ok";  el.textContent = "Saved."; setTimeout(() => el.textContent = "", 2500); }
  });

  // ══════════════════════════════════════════════════
  // SETTINGS — API keys
  // ══════════════════════════════════════════════════
  document.getElementById("keysForm").addEventListener("submit", async e => {
    e.preventDefault();
    const tenantId = window.tenantId();
    const cfg = window.APP_CONFIG || {};
    if (!tenantId) return;
    const fields = [
      ["k_anthropic",              "anthropic_api_key"],
      ["k_anthropic_model",        "anthropic_model"],
      ["k_vapi_assistant_id",      "vapi_assistant_id"],
      ["k_vapi_phone_number_id",   "vapi_phone_number_id"],
      ["k_vapi_public_key",        "vapi_public_key"],
      ["k_vapi_private_key",       "vapi_private_key"],
      ["k_at_api_key",             "at_api_key"],
      ["k_at_username",            "at_username"],
      ["k_at_sender_id",           "at_sender_id"],
      ["k_at_whatsapp_number",     "at_whatsapp_number"],
      ["k_payment_gateway",        "payment_gateway"],
      ["k_payment_gateway_token",  "payment_gateway_token"],
      ["k_payment_gateway_secret", "payment_gateway_secret"],
    ];
    const keys = {};
    fields.forEach(([id, name]) => { const v = document.getElementById(id)?.value; if (v) keys[name] = v; });

    const session = await window.Auth.getSession();
    const url = (cfg.SUPABASE_URL || "").replace(/\/$/, "") + "/functions/v1/update-tenant-keys";
    const statusEl = document.getElementById("keysStatus");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + session.access_token, "apikey": cfg.SUPABASE_ANON_KEY },
        body: JSON.stringify({ tenant_id: tenantId, keys }),
      });
      if (!res.ok) throw new Error(await res.text());
      const r = await res.json();
      statusEl.className = "db-status ok";
      statusEl.textContent = `Saved ${r.updated.length} key(s).`;
      ["k_anthropic","k_vapi_private_key","k_at_api_key","k_payment_gateway_token","k_payment_gateway_secret"]
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
      await loadKeyStatus(tenantId);
      loadOnboarding(tenantId);
      setTimeout(() => statusEl.textContent = "", 3500);
    } catch (err) {
      statusEl.className = "db-status err";
      statusEl.textContent = "Failed: " + (err.message || err);
    }
  });

  // ══════════════════════════════════════════════════
  // AI CONVERSATIONS TAB
  // ══════════════════════════════════════════════════

  // All raw data cached in-memory for client-side filtering
  let _aiCallHistory = [];
  let _aiMessages    = [];
  let _aiResponses   = [];

  document.getElementById("refreshAiConv").addEventListener("click", () => loadAiConversations(true));

  document.getElementById("msgSearchBtn").addEventListener("click",    () => renderMessages());
  document.getElementById("aiRespSearchBtn").addEventListener("click", () => renderAiResponses());
  document.getElementById("callHistoryFilter").addEventListener("change", () => renderCallHistory());
  document.getElementById("msgSearch").addEventListener("keydown",    e => { if (e.key === "Enter") renderMessages(); });
  document.getElementById("aiRespSearch").addEventListener("keydown", e => { if (e.key === "Enter") renderAiResponses(); });

  async function loadAiConversations(forceRefresh = false) {
    const wrap = document.getElementById("aiResponsesWrap");
    if (!forceRefresh && wrap.dataset.loaded) return;
    wrap.dataset.loaded = "1";

    const cfg    = window.APP_CONFIG || {};
    const base   = (cfg.N8N_WEBHOOK_BASE || "").replace(/\/$/, "");
    const statusEl = document.getElementById("aiConvStatus");

    statusEl.style.display = "block";
    statusEl.className = "db-status muted";
    statusEl.textContent = "Loading AI conversation data…";

    if (!base) {
      statusEl.className = "db-status warn";
      statusEl.textContent = "N8N_WEBHOOK_BASE not configured — AI conversation data unavailable.";
      document.getElementById("callHistoryWrap").innerHTML = emptyState("⚙️", "Configure N8N_WEBHOOK_BASE in js/config.js to enable AI logs.");
      document.getElementById("messagesWrap").innerHTML    = emptyState("⚙️", "Configure N8N_WEBHOOK_BASE to see messages.");
      document.getElementById("aiResponsesWrap").innerHTML = emptyState("⚙️", "Configure N8N_WEBHOOK_BASE to see AI responses.");
      return;
    }

    const slug    = window.tenantSlug ? window.tenantSlug() : (_tenantCtx?.slug || "");
    const headers = { "Content-Type": "application/json" };
    const body    = JSON.stringify({ tenant_slug: slug });

    // Fetch all four data sources in parallel
    const [activeRes, historyRes, msgsRes, aiRes] = await Promise.allSettled([
      fetch(base + "/webhook/ai/active-calls",  { method: "POST", headers, body }),
      fetch(base + "/webhook/ai/call-history",  { method: "POST", headers, body }),
      fetch(base + "/webhook/ai/messages",      { method: "POST", headers, body }),
      fetch(base + "/webhook/ai/responses",     { method: "POST", headers, body }),
    ]);

    // Active calls
    renderActiveCalls(activeRes.status === "fulfilled" ? await safeJson(activeRes.value) : []);

    // Call history
    _aiCallHistory = historyRes.status === "fulfilled" ? await safeJson(historyRes.value) : [];
    renderCallHistory();

    // Messages
    _aiMessages = msgsRes.status === "fulfilled" ? await safeJson(msgsRes.value) : [];
    renderMessages();

    // AI responses
    _aiResponses = aiRes.status === "fulfilled" ? await safeJson(aiRes.value) : [];
    renderAiResponses();

    updateAiKpis();

    statusEl.className = "db-status muted";
    statusEl.textContent = "Updated " + new Date().toLocaleTimeString();
    setTimeout(() => statusEl.style.display = "none", 2500);
  }

  async function safeJson(res) {
    try { const j = await res.json(); return Array.isArray(j) ? j : (j?.data || j?.rows || j?.results || []); }
    catch { return []; }
  }

  function renderActiveCalls(rows) {
    const wrap  = document.getElementById("activeCallsWrap");
    const badge = document.getElementById("activeCallsBadge");
    const live  = rows.filter(r => (r.status || "").toLowerCase() === "in-progress" || r.active || r.status === "active" || !r.ended_at);
    badge.textContent = live.length + " live";
    badge.className   = "pill-status " + (live.length ? "active" : "pending");
    setText("aiKpiActiveCalls", live.length);

    if (!live.length) {
      wrap.innerHTML = emptyState("📞", "No active calls right now.");
      return;
    }
    wrap.innerHTML = live.map(c => {
      const phone = c.phone_number || c.caller || c.customer_number || "Unknown";
      const since = c.started_at  || c.start_time || c.created_at || "";
      const dur   = since ? Math.floor((Date.now() - new Date(since)) / 60000) + " min" : "—";
      return `<div class="call-live-card">
        <div class="call-live-dot"></div>
        <div style="flex:1; min-width:0;">
          <div class="cl-phone">${phone}</div>
          <div class="cl-meta">${c.direction || "inbound"} · started ${since ? new Date(since).toLocaleTimeString() : "—"}</div>
        </div>
        <div class="cl-dur">${dur}</div>
      </div>`;
    }).join("");
  }

  function renderCallHistory() {
    const wrap    = document.getElementById("callHistoryWrap");
    const filter  = document.getElementById("callHistoryFilter").value.toLowerCase();
    let rows = _aiCallHistory;
    if (filter) rows = rows.filter(r => (r.status || r.end_reason || "").toLowerCase().includes(filter));

    if (!rows.length) { wrap.innerHTML = emptyState("📵", filter ? "No calls match that filter." : "No call history yet."); return; }

    wrap.innerHTML = `
      <div class="db-table-wrap">
        <table class="db-table">
          <thead><tr><th>Phone</th><th>Direction</th><th>Status</th><th>Duration</th><th>Summary</th><th>Date</th></tr></thead>
          <tbody>
            ${rows.slice(0, 100).map(c => {
              const phone = c.phone_number || c.caller || c.customer_number || "—";
              const dir   = c.direction || "inbound";
              const stat  = c.status || c.end_reason || "—";
              const sec   = c.duration_seconds || c.duration_sec || c.duration || 0;
              const dur   = sec ? Math.floor(sec / 60) + "m " + (sec % 60) + "s" : "—";
              const sum   = c.summary || c.call_summary || c.transcript_summary || "—";
              const dt    = c.created_at || c.started_at || c.date || "";
              return `<tr>
                <td class="mono">${phone}</td>
                <td><span class="msg-pill ${dir === "inbound" ? "in" : "out"}">${dir}</span></td>
                <td><span class="st-badge ${stat.replace(/\s+/g,"-")}">${stat}</span></td>
                <td class="muted">${dur}</td>
                <td style="max-width:260px; white-space:normal; font-size:0.82rem; color:#555;">${sum.slice(0, 120)}${sum.length > 120 ? "…" : ""}</td>
                <td class="muted">${fmtDate(dt)}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`;
  }

  function renderMessages() {
    const wrap   = document.getElementById("messagesWrap");
    const search = (document.getElementById("msgSearch").value || "").toLowerCase();
    const dir    = document.getElementById("msgDirFilter").value.toLowerCase();
    const chan   = document.getElementById("msgChanFilter").value.toLowerCase();

    let rows = _aiMessages;
    if (dir)    rows = rows.filter(r => (r.direction || "").toLowerCase() === dir);
    if (chan)   rows = rows.filter(r => (r.channel || r.type || "").toLowerCase().includes(chan));
    if (search) rows = rows.filter(r => JSON.stringify(r).toLowerCase().includes(search));

    if (!rows.length) { wrap.innerHTML = emptyState("💬", rows.length === 0 && !_aiMessages.length ? "No messages logged yet." : "No messages match the filter."); return; }

    wrap.innerHTML = `
      <div class="db-table-wrap">
        <table class="db-table">
          <thead><tr><th>Phone</th><th>Channel</th><th>Direction</th><th>Message</th><th>AI Reply</th><th>Date</th></tr></thead>
          <tbody>
            ${rows.slice(0, 100).map(m => {
              const phone   = m.phone_number || m.from || m.to || "—";
              const channel = (m.channel || m.type || "sms").toLowerCase();
              const inbound = (m.direction || "inbound").toLowerCase() === "inbound";
              const content = m.content || m.message || m.body || m.text || "—";
              const reply   = m.ai_reply || m.response || m.ai_response || "";
              const dt      = m.sent_at || m.created_at || m.timestamp || m.date || "";
              return `<tr>
                <td class="mono">${phone}</td>
                <td><span class="msg-pill ${channel.includes("what") ? "wa" : "sms"}">${channel}</span></td>
                <td><span class="msg-pill ${inbound ? "in" : "out"}">${inbound ? "inbound" : "outbound"}</span></td>
                <td style="max-width:200px; white-space:normal; font-size:0.82rem;">${content.slice(0,120)}${content.length>120?"…":""}</td>
                <td style="max-width:200px; white-space:normal; font-size:0.82rem; color:#0B6E4F;">${reply ? reply.slice(0,120)+(reply.length>120?"…":"") : '<span class="muted">—</span>'}</td>
                <td class="muted">${fmtDate(dt)}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`;
  }

  function renderAiResponses() {
    const wrap   = document.getElementById("aiResponsesWrap");
    const search = (document.getElementById("aiRespSearch").value || "").toLowerCase();
    const chan   = document.getElementById("aiRespChanFilter").value.toLowerCase();

    let rows = _aiResponses;
    if (chan)   rows = rows.filter(r => (r.channel || r.type || "").toLowerCase().includes(chan));
    if (search) rows = rows.filter(r => JSON.stringify(r).toLowerCase().includes(search));

    if (!rows.length) { wrap.innerHTML = emptyState("🤖", !_aiResponses.length ? "No AI responses logged yet." : "No responses match the filter."); return; }

    wrap.innerHTML = rows.slice(0, 50).map(r => {
      const phone   = r.phone_number || r.caller || r.customer || "—";
      const channel = (r.channel || r.type || "call").toLowerCase();
      const ts      = r.timestamp || r.created_at || r.date || "";
      const userMsg = r.user_message || r.customer_input || r.transcript || r.input || r.question || "—";
      const aiMsg   = r.ai_response || r.response || r.reply || r.answer || r.assistant || "—";
      const intent  = r.intent || r.detected_intent || "";
      const chanCls = channel.includes("call") ? "call" : channel.includes("what") ? "wa" : channel.includes("sms") ? "sms" : "chat";
      return `
        <div class="ai-turn-card">
          <div class="turn-meta">
            <span class="ai-channel-badge ${chanCls}">${channel}</span>
            <strong style="margin:0 8px;">${phone}</strong>
            ${intent ? `<span style="font-style:italic; color:#666;">intent: ${intent}</span>` : ""}
            <span style="float:right; color:#aaa;">${ts ? new Date(ts).toLocaleString() : ""}</span>
          </div>
          <div class="turn-user"><div class="turn-label">Customer</div>${userMsg}</div>
          <div class="turn-ai"><div class="turn-label">AI (${r.model || "Claude"})</div>${aiMsg}</div>
        </div>`;
    }).join("");
  }

  function updateAiKpis() {
    const today = new Date().toDateString();
    const callsToday = _aiCallHistory.filter(c => {
      const d = c.created_at || c.started_at || c.date || "";
      return d && new Date(d).toDateString() === today;
    }).length;
    const msgsToday = _aiMessages.filter(m => {
      const d = m.sent_at || m.created_at || m.timestamp || "";
      return d && new Date(d).toDateString() === today;
    }).length;
    const respToday = _aiResponses.filter(r => {
      const d = r.timestamp || r.created_at || r.date || "";
      return d && new Date(d).toDateString() === today;
    }).length;

    const durations = _aiCallHistory
      .map(c => parseInt(c.duration_seconds || c.duration_sec || c.duration || 0))
      .filter(Boolean);
    const avgDur = durations.length
      ? (durations.reduce((a, b) => a + b, 0) / durations.length / 60).toFixed(1)
      : "—";

    setText("aiKpiCallsToday", callsToday || _aiCallHistory.length);
    setText("aiKpiMsgsToday",  msgsToday  || _aiMessages.length);
    setText("aiKpiResponses",  respToday  || _aiResponses.length);
    setText("aiKpiAvgDur",     avgDur);
  }

  // ══════════════════════════════════════════════════
  // BOOKING METRICS (n8n)
  // ══════════════════════════════════════════════════
  document.getElementById("refreshMetrics").addEventListener("click", refreshMetrics);

  async function refreshMetrics() {
    const cfg    = window.APP_CONFIG || {};
    const status = document.getElementById("metricsStatus");
    status.style.display = "block";
    status.className = "db-status muted";
    status.textContent = "Loading…";

    const base = (cfg.N8N_WEBHOOK_BASE || "").replace(/\/$/, "");
    if (!base) {
      status.className = "db-status warn";
      status.textContent = "N8N_WEBHOOK_BASE not configured — booking metrics unavailable.";
      return;
    }
    const slug    = window.tenantSlug();
    const headers = { "Content-Type": "application/json" };
    const body    = extra => JSON.stringify({ tenant_slug: slug, ...(extra || {}) });

    try {
      const [tbsRes, phRes] = await Promise.all([
        fetch(base + "/webhook/vapi/today-bookings-summary", { method:"POST", headers, body: body() }),
        fetch(base + "/webhook/vapi/pending-holds",         { method:"POST", headers, body: body() }),
      ]);
      const tbs = await tbsRes.json();
      const ph  = await phRes.json();

      const tbsResult = tbs.results?.[0]?.result || "";
      const lines = tbsResult.split("\n");
      const grab = re => { for (const l of lines) { const m = l.match(re); if (m) return m[1]; } return "—"; };
      setText("mHeld",      grab(/Umehifadhiwa: (\d+)/i));
      setText("mConfirmed", grab(/Iliyothibitishwa: (\d+)/i));
      setText("mCancelled", grab(/Iliyofutwa: (\d+)/i));
      setText("mRevenue",   grab(/TZS\s+([\d,]+)/));
      const cnt = ((ph.results?.[0]?.result || "").match(/^\d+\./gm) || []).length;
      setText("mPending", cnt || "0");

      status.className = "db-status muted";
      status.textContent = "Updated " + new Date().toLocaleTimeString();
      setTimeout(() => status.style.display = "none", 2500);
    } catch (err) {
      status.className = "db-status err";
      status.textContent = "Could not reach n8n: " + (err.message || err);
    }
  }
};
