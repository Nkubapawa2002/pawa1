// =====================================================
// Super Admin — platform overview (owner's bird's-eye pulse).
// Gated by `admins` table membership, answered by the server about the caller.
// (It used to also consult APP_CONFIG.ADMIN_EMAILS, a roster shipped to every
//  browser. That is deleted; see js/core/auth.js.)
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
  // window.t returns the KEY when a string is missing, so the fallback is what
  // stops "sa_forbidden" appearing on the screen.
  const tt = (key, fallback) => {
    const v = window.t ? window.t(key) : key;
    return (!v || v === key) ? fallback : v;
  };
  // tt() with {placeholders} filled. The counts are rewritten here after the
  // queries land, so the markup's data-i18n hook would be overwritten with
  // English a second later if these were left as literals.
  const tf = (key, fallback, vars) => {
    let out = tt(key, fallback);
    Object.keys(vars || {}).forEach((k) => {
      out = out.split("{" + k + "}").join(vars[k]);
    });
    return out;
  };
  const escT = (x) => String(x == null ? "" : x)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  /**
   * The refusal, as ONE sentence with two things dropped into it: the address
   * you are signed in as, and the name of the constant you have to go and
   * edit. Both are data inside a sentence rather than fragments joined in
   * English order, so a language can put either one anywhere.
   *
   */
  // showForbidden() is gone. It printed the address you were signed in as,
  // next to the literal string ADMIN_EMAILS -- confirming the page, the
  // account, and the mechanism, to whoever had just failed to open it.

  // The intro, whose link sits inside the sentence rather than after it.
  (function paintIntro() {
    const host = document.getElementById("saIntro");
    if (!host) return;
    const link = '<a href="admin.html">' +
      escT(tt("sa_intro_link", "Admin panel")) + "</a>";
    host.innerHTML = tt("sa_intro",
      "A read-only pulse of the whole marketplace. Day-to-day management lives in the {link}: approving agents, recording payments and tracking renters.")
      .split("{link}").map((chunk) => escT(chunk)).join(link);
  })();

  const sb     = window.SB;
  const notHere = document.getElementById("saNotHere");
  const panel   = document.getElementById("saPanel");

  /** Leave nothing behind. See the twin of this in js/pages/admin.js. */
  function vanish() {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    // The hero too. It reads "Super Admin / Platform overview: the whole
    // marketplace at a glance", which tells a stranger everything the
    // not-found below it is refusing to say.
    var hero = document.getElementById("saHero");
    if (hero && hero.parentNode) hero.parentNode.removeChild(hero);
    if (notHere) notHere.hidden = false;
    document.title = tt("nf_title", "This page isn't here.");
  }
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
  /**
   * One question, asked of the server, and it FAILS CLOSED.
   *
   * The version this replaces did two checks and the second one could not
   * refuse anybody. It read:
   *
   *     let inAdminsTable = true;
   *     try { ...count admins... } catch (e) { -- ignore, RLS may block read }
   *     if (!inAdminsTable) { ...refuse... }
   *
   * The flag starts TRUE and the catch leaves it alone, so any throw at all --
   * a network blip, a policy change, a renamed table -- fell through to the
   * console being shown. The comment called that "optional double-check",
   * which is exactly what it had become.
   *
   * Auth.isDbAdmin() returns false on every error path, and its own SELECT is
   * RLS-fenced, so a non-admin gets nothing back whether or not this page asks
   * nicely.
   */
  async function evaluateAuth() {
    let isAdmin = false;
    try { isAdmin = await window.Auth.isDbAdmin(); } catch (_) { isAdmin = false; }
    if (!isAdmin) { vanish(); return; }
    if (notHere && notHere.parentNode) notHere.parentNode.removeChild(notHere);
    show(panel);
    await loadOverview();
  }

  // ---- there is no login form here any more ----------
  // It was the second of the app's two unthrottled credential doors: this page
  // never loaded js/lib/auth-policy.js, so the lockout that guards login.html
  // did not apply to it. Sign in at login.html and come back.
  //
  // The sign-out button went with the refusal screen it lived on; the console's
  // own header still has one.

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
    flash("ok", tt("sa_loading", "Loading platform overview…"), 0);

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
    setSub("pHousesSub", housesTotal == null
      ? tt("sa_t_houses_s", "live rooms")
      : tf("sa_houses_of", "{live} live of {total} total",
           { live: fmtNum(housesLive), total: fmtNum(housesTotal) }));

    const services = await countWhere("services");
    setText("pServices", fmtNum(services));

    const trucks = await countWhere("trucks");
    setText("pTrucks", fmtNum(trucks));

    // Day jobs still hiring (open or assembling a team).
    const jobsOpen = await countWhere("day_jobs", (q) => q.in("status", ["open", "full"]));
    const jobsTotal = await countWhere("day_jobs");
    setText("pJobs", fmtNum(jobsOpen));
    setSub("pJobsSub", jobsTotal == null
      ? tt("sa_t_jobs_s", "open jobs")
      : tf("sa_jobs_of", "{open} hiring of {total} posted",
           { open: fmtNum(jobsOpen), total: fmtNum(jobsTotal) }));

    // Seeker demand pins (people looking — agents' lead board).
    const demand = await countWhere("house_demand_pins");
    setText("pDemand", fmtNum(demand));

    // Agents on the platform (one billing row per agent).
    const agents = await countWhere("agent_billing");
    const pending = await countWhere("agent_billing", (q) => q.is("approved_at", null));
    setText("pAgents", fmtNum(agents));
    setSub("pAgentsSub", pending == null
      ? tt("sa_t_agents_s", "registered")
      : (pending > 0
          ? tf("sa_awaiting", "{n} awaiting approval", { n: fmtNum(pending) })
          : tt("sa_all_approved", "all approved")));
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
      const region = (r.region || "").trim() || tt("sa_unspecified", "Unspecified");
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
      // An empty list is now just an empty list. This used to fall back to
      // printing APP_CONFIG.ADMIN_EMAILS as if those rows were admins, which
      // was two wrong things at once: the allow-list never granted anything,
      // so the table showed people who might not be admins at all; and it
      // rendered the roster into the DOM on a page whose whole subject is who
      // holds power. The roster no longer exists. If RLS hides the rows from
      // an admin, the honest answer is that this section could not be read.
      if (empty) empty.hidden = false;
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
