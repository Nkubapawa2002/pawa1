// =====================================================
// Super Admin — platform overview (owner's bird's-eye pulse).
// Gated by APP_CONFIG.ADMIN_EMAILS + admins table membership.
// =====================================================
// This is the READ-ONLY top-level view of the whole marketplace: how many
// agents, live listings (houses / services / trucks), open day-jobs and seeker
// demand exist, how much money has actually been collected, where the platform
// reaches (regional coverage) and who has owner access. Day-to-day management
// (approving agents, recording payments, tracking renters) lives in admin.html;
// this page is the snapshot you open to know the platform's health at a glance.
// Every query degrades gracefully — a missing table or RLS block shows "—"
// instead of breaking the whole page.

window.initSuperAdmin = async () => {
  const sb     = window.SB;
  const gate   = document.getElementById("saLoginGate");
  const forb   = document.getElementById("saForbidden");
  const panel  = document.getElementById("saPanel");
  const status = document.getElementById("saStatus");

  function show(el) { el.hidden = false; }
  function hide(el) { el.hidden = true; }
  function flash(kind, msg, ttlMs = 3500) {
    status.innerHTML = `<div class="sa-banner ${kind}">${msg}</div>`;
    if (ttlMs) setTimeout(() => status.innerHTML = "", ttlMs);
  }
  const escapeHTML = window.escHtml || ((s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])));

  // ---- Auth gate (unchanged from the old tenant panel) ----------
  async function evaluateAuth() {
    const session = await window.Auth.getSession();
    if (!session) { hide(forb); hide(panel); show(gate); return; }
    const email = session.user?.email || "";
    if (!window.Auth.isAllowedEmail(email)) {
      document.getElementById("saWhoami").textContent = email;
      hide(gate); hide(panel); show(forb);
      return;
    }
    // Optional double-check: are they in `admins` table too?
    let inAdminsTable = true;
    try {
      const { count } = await sb.from("admins").select("*", { count: "exact", head: true });
      inAdminsTable = (count ?? 0) > 0;
    } catch (e) { /* ignore — RLS may block read */ }
    if (!inAdminsTable) {
      document.getElementById("saWhoami").textContent = email + " (not in admins table)";
      hide(gate); hide(panel); show(forb);
      return;
    }
    hide(gate); hide(forb); show(panel);
    await loadOverview();
  }

  // ---- Login form ----------
  document.getElementById("saLoginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("saEmail").value.trim();
    const password = document.getElementById("saPassword").value;
    const errEl = document.getElementById("saLoginError");
    window.authMsg(errEl, "", "");
    try {
      await window.Auth.signIn(email, password);
      await evaluateAuth();
    } catch (err) {
      window.authMsg(errEl, "error", err.message || String(err));
    }
  });

  document.getElementById("saSignOut").addEventListener("click", async () => {
    await window.Auth.signOut();
    location.reload();
  });

  document.getElementById("saRefresh")?.addEventListener("click", () => {
    loadOverview();
  });

  // ---- Small query helpers ----------
  // A filtered exact-count that never throws: returns a number, or null if the
  // table is missing / blocked by RLS (so the card can show "—").
  async function countWhere(table, build) {
    try {
      let q = sb.from(table).select("*", { count: "exact", head: true });
      if (build) q = build(q);
      const { count, error } = await q;
      if (error) { console.warn(`count ${table} failed:`, error.message); return null; }
      return count ?? 0;
    } catch (e) {
      console.warn(`count ${table} threw:`, e?.message || e);
      return null;
    }
  }

  // Fetch a column (or columns) defensively; [] on any failure.
  async function fetchCol(table, cols, build) {
    try {
      let q = sb.from(table).select(cols);
      if (build) q = build(q);
      const { data, error } = await q;
      if (error) { console.warn(`fetch ${table} failed:`, error.message); return []; }
      return data || [];
    } catch (e) {
      console.warn(`fetch ${table} threw:`, e?.message || e);
      return [];
    }
  }

  const fmtNum = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
  const fmtTzs = (n) => (n == null ? "—" : (window.formatTZS ? window.formatTZS(n) : "TZS " + Number(n).toLocaleString("en-US")));
  const setText = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  const setSub  = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };

  function startOfMonthISO() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
  }
  const todayISO = () => new Date().toISOString().slice(0, 10);

  // ---- Main load ----------
  async function loadOverview() {
    flash("ok", "Loading platform overview…", 0);

    await Promise.all([
      loadPulse(),
      loadRevenue(),
      loadCoverage(),
      loadAccess(),
    ]);

    status.innerHTML = "";
  }

  // 1) Marketplace pulse — live counts across every offering.
  async function loadPulse() {
    // Houses: "live" matches the public directory rule (available !== false).
    const housesLive = await countWhere("houses", (q) => q.or("available.is.null,available.eq.true"));
    const housesTotal = await countWhere("houses");
    setText("pHouses", fmtNum(housesLive));
    setSub("pHousesSub", housesTotal == null ? "live rooms" :
      `${fmtNum(housesLive)} live of ${fmtNum(housesTotal)} total`);

    const services = await countWhere("services");
    setText("pServices", fmtNum(services));

    const trucks = await countWhere("trucks");
    setText("pTrucks", fmtNum(trucks));

    // Day jobs still hiring (open or assembling a team).
    const jobsOpen = await countWhere("day_jobs", (q) => q.in("status", ["open", "full"]));
    const jobsTotal = await countWhere("day_jobs");
    setText("pJobs", fmtNum(jobsOpen));
    setSub("pJobsSub", jobsTotal == null ? "open jobs" : `${fmtNum(jobsOpen)} hiring of ${fmtNum(jobsTotal)} posted`);

    // Seeker demand pins (people looking — agents' lead board).
    const demand = await countWhere("house_demand_pins");
    setText("pDemand", fmtNum(demand));

    // Agents on the platform (one billing row per agent).
    const agents = await countWhere("agent_billing");
    const pending = await countWhere("agent_billing", (q) => q.is("approved_at", null));
    setText("pAgents", fmtNum(agents));
    setSub("pAgentsSub", pending == null ? "registered" :
      (pending > 0 ? `${fmtNum(pending)} awaiting approval` : "all approved"));
  }

  // 2) Revenue — real money collected (source of truth = agent_payments ledger).
  async function loadRevenue() {
    const rows = await fetchCol("agent_payments", "amount_tzs, created_at");
    if (!rows.length) {
      // Could be genuinely zero, or the ledger table isn't live yet.
      setText("rTotal", fmtTzs(0));
      setText("rMonth", fmtTzs(0));
    } else {
      const monthStart = startOfMonthISO();
      let total = 0, month = 0;
      rows.forEach((r) => {
        const amt = Number(r.amount_tzs) || 0;
        total += amt;
        if (r.created_at && r.created_at >= monthStart) month += amt;
      });
      setText("rTotal", fmtTzs(total));
      setText("rMonth", fmtTzs(month));
    }

    // Active subscriptions = switched on AND coverage not yet lapsed.
    const activeSubs = await countWhere("agent_billing", (q) =>
      q.eq("active", true).gte("paid_until", todayISO()));
    setText("rActive", fmtNum(activeSubs));

    const receipts = rows.length;
    setText("rReceipts", fmtNum(receipts));
  }

  // 3) Regional coverage — where the platform actually reaches. Combine the
  //    region of every live listing across houses / services / trucks.
  async function loadCoverage() {
    const tbody = document.querySelector("#coverageTable tbody");
    const empty = document.getElementById("coverageEmpty");
    if (!tbody) return;

    const [houses, services, trucks] = await Promise.all([
      fetchCol("houses",   "region", (q) => q.or("available.is.null,available.eq.true").limit(5000)),
      fetchCol("services", "region", (q) => q.limit(5000)),
      fetchCol("trucks",   "region", (q) => q.limit(5000)),
    ]);

    const map = new Map(); // region -> { houses, services, trucks }
    const bump = (rows, key) => rows.forEach((r) => {
      const region = (r.region || "").trim() || "Unspecified";
      const e = map.get(region) || { houses: 0, services: 0, trucks: 0 };
      e[key]++; map.set(region, e);
    });
    bump(houses, "houses");
    bump(services, "services");
    bump(trucks, "trucks");

    const regions = [...map.entries()]
      .map(([region, c]) => ({ region, ...c, total: c.houses + c.services + c.trucks }))
      .sort((a, b) => b.total - a.total);

    tbody.innerHTML = "";
    if (!regions.length) { if (empty) empty.hidden = false; return; }
    if (empty) empty.hidden = true;

    setText("coverageCount", `${regions.length} region${regions.length === 1 ? "" : "s"} covered`);

    regions.slice(0, 25).forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td><strong>${escapeHTML(r.region)}</strong></td>` +
        `<td>${fmtNum(r.houses)}</td>` +
        `<td>${fmtNum(r.services)}</td>` +
        `<td>${fmtNum(r.trucks)}</td>` +
        `<td><strong>${fmtNum(r.total)}</strong></td>`;
      tbody.appendChild(tr);
    });
  }

  // 4) Platform access — who holds owner/admin keys.
  async function loadAccess() {
    const tbody = document.querySelector("#accessTable tbody");
    const empty = document.getElementById("accessEmpty");
    if (!tbody) return;

    const admins = await fetchCol("admins", "email, created_at, name", (q) => q.limit(200));
    tbody.innerHTML = "";

    if (!admins.length) {
      // RLS commonly hides the row list even from an admin (head-count works,
      // full read may not) — fall back to the configured allow-list so the
      // section is never blank for a legitimate owner.
      const cfgEmails = (window.APP_CONFIG?.ADMIN_EMAILS) || [];
      if (!cfgEmails.length) { if (empty) empty.hidden = false; return; }
      if (empty) empty.hidden = true;
      cfgEmails.forEach((em) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${escapeHTML(em)}</td><td><em>config allow-list</em></td>`;
        tbody.appendChild(tr);
      });
      return;
    }

    if (empty) empty.hidden = true;
    admins.forEach((a) => {
      const tr = document.createElement("tr");
      const when = a.created_at
        ? new Date(a.created_at).toLocaleDateString("en-GB", { dateStyle: "medium" })
        : "—";
      tr.innerHTML = `<td>${escapeHTML(a.email || a.name || "—")}</td><td>${escapeHTML(when)}</td>`;
      tbody.appendChild(tr);
    });
  }

  await evaluateAuth();
};
