// =====================================================
// Admin Panel — gated by Supabase Auth + admins table
// =====================================================

window.initAdminPage = async () => {
  const sb = window.SB;
  const STATUSES = ["Registered", "Picked Up", "In Transit", "Arrived", "Delivered"];

  const $ = (id) => document.getElementById(id);
  const escH = window.escHtml;   // escape user data before innerHTML interpolation
  const loginGate = $("loginGate");
  const forbidden = $("forbidden");
  const adminPanel = $("adminPanel");

  if (!sb) {
    loginGate.hidden = false;
    window.authMsg($("loginError"), "error", "Supabase not configured. Check js/core/config.js.");
    return;
  }

  // ---------- gate ----------
  async function showCorrectView() {
    const session = await window.Auth.getSession();
    if (!session) {
      loginGate.hidden = false;
      forbidden.hidden = true;
      adminPanel.hidden = true;
      return;
    }
    const email = session.user.email;
    const allowed = window.Auth.isAllowedEmail(email);
    let isAdmin = false;
    if (allowed) isAdmin = await window.Auth.isDbAdmin();

    if (!isAdmin) {
      $("whoami").textContent = email;
      forbidden.hidden = false;
      loginGate.hidden = true;
      adminPanel.hidden = true;
      return;
    }
    loginGate.hidden = true;
    forbidden.hidden = true;
    adminPanel.hidden = false;
    $("adminEmail").textContent = email;
    bootAdmin();
  }

  // ---------- login form ----------
  const setErr = (kind, text) => window.authMsg($("loginError"), kind, text);

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    setErr("", "");
    try {
      await window.Auth.signIn($("loginEmail").value.trim(), $("loginPassword").value);
      showCorrectView();
    } catch (ex) {
      setErr("error", ex.message || "Sign-in failed.");
    }
  });

  $("signupLink").addEventListener("click", async (e) => {
    e.preventDefault();
    const email = $("loginEmail").value.trim();
    const pw = $("loginPassword").value;
    setErr("", "");
    if (!email || pw.length < 6) {
      setErr("error", "Enter your authorized email and a password (>= 6 chars), then click create.");
      return;
    }
    try {
      await window.Auth.signUp(email, pw);
      setErr("ok", "Account created. If email confirmation is enabled, check your inbox, then sign in.");
    } catch (ex) {
      setErr("error", ex.message || "Sign-up failed.");
    }
  });

  $("signOutBtn")?.addEventListener("click", async () => {
    await window.Auth.signOut();
    showCorrectView();
  });

  // ---------- main admin boot (only after we know we're admin) ----------
  let booted = false;
  async function bootAdmin() {
    if (booted) return;
    booted = true;

    $("logoutBtn").addEventListener("click", async () => {
      await window.Auth.signOut();
      booted = false;
      showCorrectView();
    });

    // Tabs
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach(p => p.hidden = true);
        btn.classList.add("active");
        $("tab-" + btn.dataset.tab).hidden = false;
      });
    });

    // All Agents tab controls (filter / sort / export) — listeners once.
    $("aaSearch") ?.addEventListener("input", _aaDraw);
    $("aaRole")   ?.addEventListener("change", _aaDraw);
    $("aaBilling")?.addEventListener("change", _aaDraw);
    $("aaSort")   ?.addEventListener("change", _aaDraw);
    $("aaExportBtn")?.addEventListener("click", _aaExportCsv);

    // Bulk control bar — "loop over all agents" actions.
    $("aaBulkApprove")   ?.addEventListener("click", () => _aaBulkAction("approve"));
    $("aaBulkMonth")     ?.addEventListener("click", () => _aaBulkAction("month"));
    $("aaBulkEnroll")    ?.addEventListener("click", () => _aaBulkAction("enroll"));
    $("aaBulkFee")       ?.addEventListener("click", () => _aaBulkAction("fee"));
    $("aaBulkActivate")  ?.addEventListener("click", () => _aaBulkAction("activate"));
    $("aaBulkDeactivate")?.addEventListener("click", () => _aaBulkAction("deactivate"));
    $("aaMsgTargeted")   ?.addEventListener("click", () => _aaMessageAgents("targeted"));
    $("aaMsgUnpaid")     ?.addEventListener("click", () => _aaMessageAgents("unpaid"));
    $("aaMsgDeactivated")?.addEventListener("click", () => _aaMessageAgents("deactivated"));

    // Tenants tab controls.
    $("tenSearch")?.addEventListener("input", _tenDraw);
    $("tenFilter")?.addEventListener("change", _tenDraw);
    $("tenSort")  ?.addEventListener("change", _tenDraw);
    $("tenExportBtn")?.addEventListener("click", _tenExportCsv);

    // Day Jobs tab controls.
    $("djSearch")    ?.addEventListener("input", _djDraw);
    $("djStatus")    ?.addEventListener("change", _djDraw);
    $("djRefreshBtn")?.addEventListener("click", renderDayJobs);

    await Promise.all([
      renderAllAgents(),
      renderTenancies(),
      renderDayJobs()
    ]);
  }

  // ---------- schema-drift tolerance ----------

  // PostgREST surfaces "Could not find the 'X' column of 'TABLE' in the
  // schema cache" when an approved payload references a column that no
  // longer exists on the live table (schema drift between when the change
  // was queued and when it's approved). We parse the column name out of
  // the error, strip it from the payload, and retry — repeating until the
  // payload is accepted or every column has been stripped.
  function _extractMissingColumn(errMsg) {
    if (!errMsg) return null;
    // Matches both PostgREST messages we've seen in the wild:
    //   "Could not find the 'foo' column of 'houses' in the schema cache"
    //   "column houses.foo does not exist"
    const m1 = /Could not find the '([^']+)' column/i.exec(errMsg);
    if (m1) return m1[1];
    const m2 = /column\s+(?:[a-zA-Z_]+\.)?([a-zA-Z_][a-zA-Z0-9_]*)\s+does not exist/i.exec(errMsg);
    if (m2) return m2[1];
    return null;
  }

  // ---------- All Agents tab — unified monetization tracker ----------
  // Aggregates every "agent" on the platform into one de-duplicated list:
  //   • house-listing agents        → derived from public.houses (agent jsonb)
  //   • service providers           → derived from public.services (owner jsonb)
  //   • truck owners                → derived from public.trucks (owner jsonb)
  // House/truck agents aren't a registered entity — they live embedded on
  // their listings — so we group them by account (owner_user_id) or phone and
  // take their EARLIEST listing date as "registered". One person who lists
  // both houses and trucks (and/or services) collapses into a single
  // agent carrying multiple role tags.
  let _aaUnified = null;          // cached unified list so controls don't refetch
  let _aaTotals  = null;
  let _aaBillingMissing = false;  // true when the agent_billing table isn't applied yet
  let _aaByKey = new Map();        // agent_key -> unified agent (for billing saves)
  let _aaSelected = new Set();      // agent_keys ticked for bulk actions
  // Real money received, summed from the agent_payments ledger (NOT a guess from
  // monthly rates). `missing` = the ledger table/RPC isn't applied yet.
  let _aaCollected = { allTime: 0, thisMonth: 0, count: 0, missing: true };
  const AA_BILLING_STATUSES = ["free", "trial", "paid", "overdue", "cancelled"];
  // Standard monthly subscription every agent is expected to pay. "Pay +1 month"
  // uses this when the agent has no custom amount set yet.
  const AA_MONTHLY_FEE = (window.APP_CONFIG && window.APP_CONFIG.AGENT_MONTHLY_FEE_TZS) || 10000;
  const AA_GRACE_HOURS = (window.APP_CONFIG && window.APP_CONFIG.AGENT_GRACE_HOURS) || 48;
  const AA_APPROVAL_DAYS = (window.APP_CONFIG && window.APP_CONFIG.AGENT_APPROVAL_DAYS) || 7;
  // Lifecycle badge for a billing row (mirrors supabase/features/agent/agent_approval.sql):
  //   admin-deactivated / cancelled / overdue → suspended
  //   NOT approved → live for AA_APPROVAL_DAYS from registration, then hidden
  //   approved → normal billing (paid_until / status)
  // `registered` is the agent's earliest registration time (the approval clock).
  function _aaSubInfo(b, registered) {
    b = b || {};
    const status = b.status || "free";
    if (b.active === false) return { label: "Deactivated", cls: "sub-exp" };
    if (status === "cancelled") return { label: "Suspended (cancelled)", cls: "sub-exp" };
    if (status === "overdue")   return { label: "Suspended (overdue)",   cls: "sub-exp" };
    // Approval gate — applies until an admin approves.
    if (!b.approved_at) {
      if (registered) {
        const deadline = new Date(new Date(registered).getTime() + AA_APPROVAL_DAYS * 86400000);
        const ms = deadline - Date.now();
        if (ms > 0) {
          const days = Math.ceil(ms / 86400000);
          return { label: `Preview · ${days}d to approve`, cls: "sub-due" };
        }
        return { label: "Unapproved — hidden", cls: "sub-exp" };
      }
      return { label: "Awaiting approval", cls: "sub-none" };
    }
    // Approved → subscription billing.
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const pu = b.paid_until ? new Date(String(b.paid_until).slice(0, 10) + "T00:00:00") : null;
    if (pu) {
      const days = Math.round((pu - today) / 86400000);
      if (days < 0)  return { label: `Expired ${-days}d ago`, cls: "sub-exp" };
      if (status === "paid" || status === "trial")
        return { label: `Active · ${days}d left`, cls: days <= 5 ? "sub-due" : "sub-ok" };
      return { label: `Until ${String(b.paid_until).slice(0, 10)}`, cls: "sub-ok" };
    }
    if (status === "paid" || status === "trial") return { label: "Active (no expiry)", cls: "sub-ok" };
    return { label: "Approved · active", cls: "sub-ok" };
  }
  // House activity: is the agent still working the (non-permanent, churning)
  // houses product? "Active" = posted a house within 30 days; else "inactive".
  // Trucks/services are long-term, so they don't drive this signal.
  function _aaHouseActivity(u) {
    if (!u.houseCount || !u.lastHousePost) return "";
    const days = Math.floor((Date.now() - new Date(u.lastHousePost)) / 86400000);
    const active = days <= 30;
    const rel = days <= 0 ? "today" : days === 1 ? "1d ago" : days < 60 ? days + "d ago"
              : days < 365 ? Math.floor(days / 30) + "mo ago" : Math.floor(days / 365) + "y ago";
    return `<span title="Last house posted ${rel}" style="display:inline-block;font-size:.66rem;font-weight:800;padding:1px 6px;border-radius:20px;white-space:nowrap;`
      + `background:${active ? "#dcfce7" : "#fee2e2"};color:${active ? "#166534" : "#b91c1c"}">${active ? "active" : "inactive"} · ${rel}</span>`;
  }

  // Approve (or revoke) an agent. Approving stamps approved_at + approved_by and
  // re-activates; revoking clears approval so the agent re-enters the window.
  async function _aaApprove(key, approve) {
    let email = null;
    try { const s = await window.Auth.getSession(); email = s?.user?.email || null; } catch (_) {}
    const patch = approve
      ? { approved_at: new Date().toISOString(), approved_by: email, active: true }
      : { approved_at: null, approved_by: null };
    await _aaSaveBilling(key, patch);
    _aaDraw();
  }
  // The "approved day" an agent's monthly cycle is anchored to: the explicit
  // billing.started_on if set, else their earliest registration (when they
  // first went live = effectively their approval day).
  function _aaAnchor(u) {
    const iso = (u && u.billing && u.billing.started_on) || (u && u.registered);
    if (!iso) return null;
    const d = new Date(String(iso).slice(0, 10) + "T00:00:00");
    return isNaN(d) ? null : d;
  }
  // Add one CALENDAR month, clamped for short months (Jan 31 → Feb 28), so it
  // matches Postgres `+ interval '1 month'` used by the self-serve trigger.
  function _aaAddMonth(date) {
    const d = new Date(date); d.setHours(0, 0, 0, 0);
    const day = d.getDate();
    const r = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const dim = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
    r.setDate(Math.min(day, dim));
    return r;
  }
  // Add N whole calendar months (N >= 1).
  function _aaAddMonths(date, n) {
    let d = new Date(date);
    const months = Math.max(1, Math.round(n || 1));
    for (let i = 0; i < months; i++) d = _aaAddMonth(d);
    return d;
  }
  // The agent's monthly RATE (their custom fee, else the standard one).
  function _aaRate(b) {
    return Number(b && b.amount_tzs) > 0 ? Number(b.amount_tzs) : AA_MONTHLY_FEE;
  }
  // How long a payment buys: amount ÷ monthly rate, rounded, minimum 1 month.
  // This is the rule "how much they pay determines how long it lasts".
  function _aaMonthsForAmount(amount, rate) {
    const r = Number(rate) > 0 ? Number(rate) : AA_MONTHLY_FEE;
    return Math.max(1, Math.round((Number(amount) || 0) / r));
  }
  // Per-agent ROLLING cycle: a payment buys exactly one month from THIS agent's
  // own timeline — extending from their current expiry if still active (so
  // paying early stacks and never loses days), otherwise starting today. This
  // is identical to the self-serve mobile-money trigger
  // (apply_agent_subscription_payment), so admin + self-serve agree to the day,
  // and every agent is tracked on their own independent month — they don't have
  // to pay on the same date.
  function _aaComputeNextPaidUntil(u) {
    const b = (u && u.billing) || {};
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const pu = b.paid_until ? new Date(String(b.paid_until).slice(0, 10) + "T00:00:00") : null;
    const base = (pu && pu > today) ? pu : today;   // active → extend; lapsed → start today
    return _aaAddMonth(base);
  }
  // Apply a payment the admin received. Single source of truth: the server RPC
  // record_agent_payment (atomic — writes the agent_payments ledger AND updates
  // agent_billing: approve + activate + paid + rolled paid_until). Falls back to
  // a client-side billing-only update if the RPC isn't deployed yet (older DB),
  // so the action still works — just without a logged receipt. Updates the local
  // caches so the table + collected totals reflect the payment without a refetch.
  // Returns { ok, paid_until, months, viaRpc, error }.
  async function _aaApplyPayment(key, amountPaid, opts = {}) {
    const u = _aaByKey.get(key);
    const b = (u && u.billing) || {};
    const rate = _aaRate(b);
    // ---- Preferred path: atomic server RPC (writes the receipts ledger) ----
    try {
      const { data, error } = await sb.rpc("record_agent_payment", {
        p_key: key, p_amount: amountPaid, p_monthly_fee: AA_MONTHLY_FEE,
        p_method: opts.method || null, p_reference: opts.reference || null, p_note: opts.note || null,
        p_name: (u && u.name) || null, p_phone: (u && u.phone) || null,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const paidUntil = row && (row.paid_until || row.paidUntil) || null;
      const months = row && Number(row.months) > 0 ? Number(row.months) : _aaMonthsForAmount(amountPaid, rate);
      const newRate = row && Number(row.rate_tzs) > 0 ? Number(row.rate_tzs) : rate;
      if (u) u.billing = { ...b, status: "paid", active: true, amount_tzs: newRate,
        paid_until: paidUntil, approved_at: b.approved_at || new Date().toISOString(),
        approved_by: b.approved_by || null, note: null };
      if (_aaCollected && !_aaCollected.missing) {
        _aaCollected.allTime  += amountPaid;
        _aaCollected.thisMonth += amountPaid;
        _aaCollected.count     += 1;
      }
      return { ok: true, paid_until: paidUntil, months, viaRpc: true };
    } catch (err) {
      // Only fall back when the function genuinely isn't deployed; surface any
      // other failure (auth, constraint…) instead of silently masking it.
      const msg = ((err && (err.message || err.hint || err.details)) || "") + "";
      const missingFn = /PGRST202|could not find the function|function .* does not exist|schema cache/i.test(msg);
      if (!missingFn) return { ok: false, error: err };
    }
    // ---- Fallback: client-side billing update (no receipt logged) ----
    const months = _aaMonthsForAmount(amountPaid, rate);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const pu = b.paid_until ? new Date(String(b.paid_until).slice(0, 10) + "T00:00:00") : null;
    const base = (pu && pu > today) ? pu : today;     // active → extend; lapsed → start today
    const until = _aaAddMonths(base, months).toISOString().slice(0, 10);
    let email = null;
    try { const s = await window.Auth.getSession(); email = s?.user?.email || null; } catch (_) {}
    const patch = { status: "paid", active: true, paid_until: until };
    if (!(Number(b.amount_tzs) > 0)) patch.amount_tzs = rate;   // remember their monthly rate
    if (!b.approved_at) { patch.approved_at = new Date().toISOString(); patch.approved_by = email; }
    const anchor = _aaAnchor(u);
    if (!b.started_on && anchor) patch.started_on = anchor.toISOString().slice(0, 10);
    const okSave = await _aaSaveBillingQuiet(key, patch);
    return okSave ? { ok: true, paid_until: until, months, viaRpc: false }
                  : { ok: false, error: { message: "billing save failed" } };
  }

  // Record a payment the admin received from this agent. THE AMOUNT DETERMINES
  // HOW LONG: months = amount ÷ the agent's monthly rate (min 1). Coverage rolls
  // forward from the current expiry if still active (paying early stacks, no lost
  // days), otherwise from today. Recording a payment is also the admin CONFIRMING
  // it — so it approves the agent and re-activates the account in one step.
  async function _aaRecordPayment(key) {
    const u = _aaByKey.get(key);
    const b = (u && u.billing) || {};
    const rate = _aaRate(b);
    const fmt = (n) => (window.formatTZS ? window.formatTZS(n) : "TZS " + Number(n).toLocaleString("en-US"));
    const raw = prompt(
      "Record a payment from this agent.\n\n" +
      "Monthly fee: " + fmt(rate) + ".\n" +
      "Enter the amount they PAID (TZS). The duration is worked out from it — " +
      fmt(rate) + " = 1 month, " + fmt(rate * 3) + " = 3 months, " + fmt(rate * 12) + " = 12 months.",
      String(rate)
    );
    if (raw === null) return;
    const paid = Math.max(0, Math.round(Number(raw) || 0));
    if (paid <= 0) { alert("Enter the amount paid (a positive number)."); return; }

    const months = _aaMonthsForAmount(paid, rate);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const pu = b.paid_until ? new Date(String(b.paid_until).slice(0, 10) + "T00:00:00") : null;
    const base = (pu && pu > today) ? pu : today;     // active → extend; lapsed → start today
    const until = _aaAddMonths(base, months).toISOString().slice(0, 10);

    if (!confirm(
      fmt(paid) + " = " + months + " month" + (months === 1 ? "" : "s") + ".\n\n" +
      "This approves the agent, marks them paid & active, and extends their subscription to " +
      until + ".\n\nRecord it?"
    )) return;

    // How the money came in — stored on the receipt for your records. Optional:
    // Cancel here just leaves it blank, the payment is still recorded.
    let method = prompt("How was it paid? (cash / mobile money / bank — optional)", "cash");
    method = method === null ? null : (method.trim() || null);

    const res = await _aaApplyPayment(key, paid, { method });
    if (!res.ok) {
      alert("Couldn't record the payment: " + ((res.error && res.error.message) || "please try again."));
      return;
    }
    if (!res.viaRpc) {
      alert("Payment applied to the agent's coverage, but the receipts ledger isn't enabled yet, so it won't show in the collected totals.\n\nRun supabase/features/agent/agent_billing_setup.sql in Supabase to enable receipt logging.");
    }
    _aaRenderSummary();
    _aaDraw();
  }
  // Admin activate / deactivate switch — independent of payment status. A
  // deactivated agent's listings vanish and their dashboard shows a "contact
  // admin" notice (enforced by agent_grace_active.sql).
  function _aaToggleActive(key) {
    const u = _aaByKey.get(key);
    const isActive = !(u && u.billing && u.billing.active === false);
    if (isActive) {
      // Capture the reason the agent will see on their dashboard (stored in note).
      const reason = prompt(
        "Deactivate this agent — their listings/profile hide from clients until you reactivate.\n\nMessage the agent will see (the reason / problem):",
        "Your monthly subscription is due. Please settle it to keep your account active."
      );
      if (reason === null) return;   // cancelled
      _aaSaveBilling(key, { active: false, note: (reason || "").trim() || null }).then(() => _aaDraw());
    } else {
      _aaSaveBilling(key, { active: true, note: null }).then(() => _aaDraw());
    }
  }
  const _aaEscHtml = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  function _aaNormPhone(p) {
    const d = String(p || "").replace(/\D/g, "");
    return d ? d.slice(-9) : "";          // last 9 digits — robust to +255 / 0 prefixes
  }
  function _aaIdentity(owner_user_id, phone, name) {
    if (owner_user_id) return "uid:" + owner_user_id;
    const ph = _aaNormPhone(phone);
    if (ph) return "ph:" + ph;
    return "nm:" + String(name || "unknown").toLowerCase().trim();
  }
  function _aaRelTime(iso) {
    if (!iso) return "";
    const ms = Date.now() - new Date(iso).getTime();
    const s = ms / 1000;
    if (s < 60) return "just now";
    const m = s / 60; if (m < 60) return Math.round(m) + " min ago";
    const h = m / 60; if (h < 24) return Math.round(h) + "h ago";
    const d = h / 24; if (d < 30) return Math.round(d) + "d ago";
    const mo = d / 30; if (mo < 12) return Math.round(mo) + "mo ago";
    return (mo / 12).toFixed(1) + "y ago";
  }
  function _aaEarlier(a, b) {
    if (!a) return b; if (!b) return a;
    return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
  }

  async function renderAllAgents() {
    const list = $("allAgentsList");
    if (!list) return;
    list.innerHTML = `<div class="empty"><p>Loading agents…</p></div>`;

    // Fetch the three sources; any single failure (e.g. trucks table not yet
    // applied) degrades to an empty set rather than blanking the whole tab.
    const [hRes, tRes, sRes, bRes, pRes, payRes] = await Promise.allSettled([
      sb.from("houses").select("id,agent,owner_user_id,region,verified,created_at,available"),
      sb.from("trucks").select("id,owner,owner_user_id,region,verified,created_at"),
      sb.from("services").select("id,owner,owner_user_id,region,verified,created_at"),
      sb.from("agent_billing").select("*"),
      sb.from("agent_profiles").select("user_id,name,phone,region,area_of_operations,area_kind,district,ward"),
      sb.from("agent_payments").select("agent_key,amount_tzs,created_at"),
    ]);
    const houses    = hRes.status  === "fulfilled" && Array.isArray(hRes.value.data)  ? hRes.value.data  : [];
    const trucks    = tRes.status  === "fulfilled" && Array.isArray(tRes.value.data)  ? tRes.value.data  : [];
    const servicesR = sRes.status  === "fulfilled" && Array.isArray(sRes.value.data)  ? sRes.value.data  : [];
    // Billing table may not be applied yet — degrade to "everyone free".
    _aaBillingMissing = !(bRes.status === "fulfilled" && !bRes.value.error);
    const billingRows = (bRes.status === "fulfilled" && Array.isArray(bRes.value.data)) ? bRes.value.data : [];
    const billingMap = new Map(billingRows.map((b) => [b.agent_key, b]));
    // Agent profiles (region they belong to + area of operations), keyed by the
    // SAME "uid:<id>" identity the tracker uses, so each agent's declared area
    // lines up with their listings. Table may not be applied yet → empty map.
    const profiles    = (pRes.status === "fulfilled" && Array.isArray(pRes.value.data)) ? pRes.value.data : [];
    const profileMap  = new Map(profiles.map((p) => ["uid:" + p.user_id, p]));

    const map = new Map();
    const get = (key) => {
      let u = map.get(key);
      if (!u) {
        u = { key, name: "", phone: "", email: "", regions: new Set(), roles: new Set(),
              houseCount: 0, truckCount: 0, serviceCount: 0, registered: null, verified: false,
              experience: null, rating: null, lastHousePost: null, liveHouseCount: 0 };
        map.set(key, u);
      }
      return u;
    };

    houses.forEach((h) => {
      const ag = h.agent || {};
      const u = get(_aaIdentity(h.owner_user_id, ag.phone, ag.name));
      if (ag.name && (!u.name || u.name === "Agent")) u.name = ag.name;
      if (ag.phone && !u.phone) u.phone = ag.phone;
      if (h.region) u.regions.add(h.region);
      u.roles.add("house"); u.houseCount += 1;
      if (h.available !== false) u.liveHouseCount += 1;     // still on-market
      if (h.verified) u.verified = true;
      u.registered = _aaEarlier(u.registered, h.created_at);
      // Most-recent house post — the signal of whether the agent is active in
      // houses (the churning, non-permanent product).
      if (h.created_at && (!u.lastHousePost || new Date(h.created_at) > new Date(u.lastHousePost)))
        u.lastHousePost = h.created_at;
    });

    trucks.forEach((t) => {
      const ow = t.owner || {};
      const u = get(_aaIdentity(t.owner_user_id, ow.phone, ow.name));
      if (ow.name && (!u.name || u.name === "Agent")) u.name = ow.name;
      if (ow.phone && !u.phone) u.phone = ow.phone;
      if (t.region) u.regions.add(t.region);
      u.roles.add("truck"); u.truckCount += 1;
      if (t.verified) u.verified = true;
      u.registered = _aaEarlier(u.registered, t.created_at);
    });

    servicesR.forEach((sv) => {
      const ow = sv.owner || {};
      const u = get(_aaIdentity(sv.owner_user_id, ow.phone, ow.name));
      if (ow.name && (!u.name || u.name === "Agent")) u.name = ow.name;
      if (ow.phone && !u.phone) u.phone = ow.phone;
      if (sv.region) u.regions.add(sv.region);
      u.roles.add("service"); u.serviceCount += 1;
      if (sv.verified) u.verified = true;
      u.registered = _aaEarlier(u.registered, sv.created_at);
    });

    // Fold each agent's declared profile in: their home region counts as one of
    // their regions, and the operating area is carried for display/search. Also
    // backfill a missing name/phone from the profile.
    for (const [key, u] of map) {
      const prof = profileMap.get(key);
      if (!prof) continue;
      u.profile = prof;
      if (prof.region) u.regions.add(prof.region);
      if (prof.name && !u.name) u.name = prof.name;
      if (prof.phone && !u.phone) u.phone = prof.phone;
    }

    _aaUnified = Array.from(map.values()).map((u) => ({
      ...u, regions: Array.from(u.regions), roles: Array.from(u.roles),
      profile: u.profile || null,
      billing: billingMap.get(u.key) || { status: "free", plan: "", amount_tzs: 0, paid_until: null, active: true, started_on: null, approved_at: null, approved_by: null },
    }));
    _aaByKey = new Map(_aaUnified.map((u) => [u.key, u]));
    _aaTotals = {
      houseListings: houses.length,
      truckListings: trucks.length,
      serviceListings: servicesR.length,
    };

    // Real receipts (cash actually collected) from the agent_payments ledger.
    _aaCollected = _aaComputeCollected(payRes);

    _aaRenderSummary();
    _aaDraw();
  }

  // Sum the agent_payments ledger into all-time + this-month collected. Degrades
  // to { missing:true } when the ledger table isn't applied yet, so the summary
  // shows "—" rather than a misleading number.
  function _aaComputeCollected(payRes) {
    const ok = payRes && payRes.status === "fulfilled" && !payRes.value.error && Array.isArray(payRes.value.data);
    if (!ok) return { allTime: 0, thisMonth: 0, count: 0, missing: true };
    const rows = payRes.value.data;
    const now = new Date();
    const ym = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    let allTime = 0, thisMonth = 0;
    for (const p of rows) {
      const a = Number(p.amount_tzs) || 0;
      allTime += a;
      if (String(p.created_at || "").slice(0, 7) === ym) thisMonth += a;
    }
    return { allTime, thisMonth, count: rows.length, missing: false };
  }

  // Summary cards — recomputed whenever billing changes so the paying/revenue
  // figures stay live without a refetch.
  function _aaRenderSummary() {
    if (!_aaUnified) return;
    const isPaying = (u) => u.billing && u.billing.status === "paid";
    // Monthly run-rate = the recurring fees of every currently-paid agent (what
    // the platform bills per month while they stay active). Distinct from cash
    // actually collected, which comes from the receipts ledger (_aaCollected).
    const totals = {
      total: _aaUnified.length,
      paying: _aaUnified.filter(isPaying).length,
      pending: _aaUnified.filter((u) => !(u.billing && u.billing.approved_at)).length,
      runRate: _aaUnified.filter(isPaying).reduce((s, u) => s + (Number(u.billing.amount_tzs) || 0), 0),
      house:   _aaUnified.filter((u) => u.roles.includes("house")).length,
      truck:   _aaUnified.filter((u) => u.roles.includes("truck")).length,
      service: _aaUnified.filter((u) => u.roles.includes("service")).length,
    };

    const badge = $("allAgentsBadge");
    if (badge) badge.textContent = totals.total ? String(totals.total) : "";

    const collected = _aaCollected || { missing: true };
    const money = (v) => (collected.missing ? "—" : window.formatTZS(v));
    const sum = $("aaSummary");
    if (sum) {
      sum.innerHTML = [
        ["Total agents", totals.total, ""],
        ["Awaiting approval", totals.pending, "warn"],
        ["Paying now",       totals.paying, "pay"],
        ["Collected (all time)", money(collected.allTime), "rev"],
        ["Collected this month", money(collected.thisMonth), "rev"],
        ["Monthly run-rate", window.formatTZS(totals.runRate), ""],
        ["House agents",      totals.house, ""],
        ["Service providers", totals.service, ""],
        ["Truck owners",      totals.truck, ""],
      ].map(([lbl, num, cls]) => `<div class="aa-stat ${cls}"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`).join("");
    }

    const note = $("aaBillingNote");
    if (note) {
      const ledgerMissing = !_aaBillingMissing && collected.missing;
      note.hidden = !(_aaBillingMissing || ledgerMissing);
      if (_aaBillingMissing) note.textContent = "Billing not saved yet: run supabase/features/agent/agent_billing_setup.sql in Supabase to enable paid-status tracking. (Showing everyone as Free for now.)";
      else if (ledgerMissing) note.textContent = "Receipts ledger not enabled: run supabase/features/agent/agent_billing_setup.sql so each payment is logged and the collected totals are real. (Payments still extend coverage without it.)";
    }

    _aaRenderBreakdown();
  }

  // Paid-vs-unpaid + amount collected, broken down by category (house owners /
  // service providers / truck owners) with a true unique overall total.
  function _aaRenderBreakdown() {
    const el = $("aaBreakdown");
    if (!el || !_aaUnified) return;
    const isPaid = (u) => (u.billing && u.billing.status === "paid");
    const amt    = (u) => Number(u.billing && u.billing.amount_tzs) || 0;

    const cat = (role) => {
      const inRole = _aaUnified.filter((u) => u.roles.includes(role));
      const paid   = inRole.filter(isPaid);
      return { total: inRole.length, paid: paid.length,
               unpaid: inRole.length - paid.length,
               collected: paid.reduce((s, u) => s + amt(u), 0) };
    };
    const house = cat("house"), truck = cat("truck"), service = cat("service");
    const paidAll = _aaUnified.filter(isPaid);
    const overall = { total: _aaUnified.length, paid: paidAll.length,
                      unpaid: _aaUnified.length - paidAll.length,
                      collected: paidAll.reduce((s, u) => s + amt(u), 0) };

    const row = (label, c, cls) => `
      <tr class="${cls || ""}">
        <td class="aa-bd-cat">${label}</td>
        <td>${c.total}</td>
        <td class="aa-paid">${c.paid}</td>
        <td class="aa-unpaid">${c.unpaid}</td>
        <td class="aa-collected">${window.formatTZS(c.collected)}</td>
      </tr>`;

    el.innerHTML = `
      <h4 style="margin:0 0 8px;font-size:.95rem;">Paid vs unpaid — by category</h4>
      <table>
        <thead><tr>
          <th>Category</th><th>Total</th><th>Paid</th><th>Unpaid</th><th>Monthly fees (TZS)</th>
        </tr></thead>
        <tbody>
          ${row("House owners", house)}
          ${row("Service providers", service)}
          ${row("Truck owners", truck)}
          ${row("Overall (unique people)", overall, "aa-bd-total")}
        </tbody>
      </table>
      <p class="hint" style="margin:6px 0 0;">"Monthly fees" is the recurring run-rate of currently-paid agents in each category (not cash collected — see "Collected" in the cards above for real receipts). Someone in more than one category is counted once per category here, but only once in the Overall row — so the Overall total can be lower than the categories added up. Use the Billing filter below to list everyone Paid or Unpaid by name.</p>`;
  }

  function _aaDraw() {
    const list = $("allAgentsList");
    if (!list || !_aaUnified) return;
    const q    = ($("aaSearch")?.value || "").toLowerCase().trim();
    const role = $("aaRole")?.value || "";
    const bill = $("aaBilling")?.value || "";
    const sort = $("aaSort")?.value || "newest";

    let rows = _aaUnified.filter((u) => {
      if (role && !u.roles.includes(role)) return false;
      if (bill) {
        const st = u.billing?.status || "free";
        const ap = !!(u.billing && u.billing.approved_at);
        if (bill === "pending")       { if (ap) return false; }
        else if (bill === "approved") { if (!ap) return false; }
        else if (bill === "unpaid")   { if (st === "paid") return false; }
        else if (st !== bill) return false;
      }
      if (q) {
        const p = u.profile || {};
        const hay = `${u.name} ${u.phone} ${u.regions.join(" ")} ${u.email} ${p.area_of_operations || ""} ${p.district || ""} ${p.ward || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    rows.sort((a, b) => {
      const ta = a.registered ? new Date(a.registered).getTime() : 0;
      const tb = b.registered ? new Date(b.registered).getTime() : 0;
      return sort === "oldest" ? ta - tb : tb - ta;
    });

    if (!rows.length) { list.innerHTML = `<div class="empty"><p>No agents match.</p></div>`; return; }

    const ROLE_LABEL = { house: "House", truck: "Truck", service: "Service" };
    const roleTags = (u) => u.roles.map((r) =>
      `<span class="aa-role-tag ${r}">${ROLE_LABEL[r] || r}</span>`).join("");
    const statusSel = (b) => `<select class="aa-bill-input aa-bill-status" data-field="status">${
      AA_BILLING_STATUSES.map((s) => `<option value="${s}" ${(b.status || "free") === s ? "selected" : ""}>${s}</option>`).join("")
    }</select>`;

    list.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr>
          <th><input type="checkbox" id="aaSelectAll" title="Select all shown"></th>
          <th>Name</th><th>Roles</th><th>Phone</th><th>Region(s)</th><th>Operating area</th>
          <th>Houses</th><th>Services</th><th>Trucks</th><th>Verified</th><th>Registered</th>
          <th>Billing start</th>
          <th>Billing</th><th>Plan</th><th>Amount (TZS)</th><th>Paid until</th><th>Next due</th>
          <th>Status &amp; approval</th>
        </tr></thead>
        <tbody>
          ${rows.map((u) => {
            const b = u.billing || {};
            return `
            <tr data-key="${_aaEscHtml(u.key)}" class="aa-bill-${b.status || "free"}">
              <td><input type="checkbox" class="aa-row-check" data-key="${_aaEscHtml(u.key)}" ${_aaSelected.has(u.key) ? "checked" : ""}></td>
              <td>${u.name ? _aaEscHtml(u.name) : "<em>Unnamed</em>"}</td>
              <td>${roleTags(u)}</td>
              <td>${u.phone ? _aaEscHtml(u.phone) : "—"} ${u.phone ? window.DataStore.renderCallButtons(u.phone) : ""}</td>
              <td>${u.regions.map(_aaEscHtml).join(", ") || "—"}</td>
              <td>${(() => {
                const p = u.profile;
                if (!p || !p.area_of_operations) return "<span style='color:#94a3b8'>not set</span>";
                const kind = p.area_kind ? ` <span class="aa-area-kind" style="color:#64748b;font-size:.78em;">(${_aaEscHtml(p.area_kind)})</span>` : "";
                return _aaEscHtml(p.area_of_operations) + kind;
              })()}</td>
              <td>${u.houseCount ? `${u.houseCount}${u.liveHouseCount < u.houseCount ? ` <small style="color:#94a3b8">(${u.liveHouseCount} live)</small>` : ""}${_aaHouseActivity(u) ? "<br>" + _aaHouseActivity(u) : ""}` : "—"}</td>
              <td>${u.serviceCount || "—"}</td>
              <td>${u.truckCount || "—"}</td>
              <td>${u.verified ? "" : "—"}</td>
              <td>${u.registered ? new Date(u.registered).toLocaleString() : "—"}
                  <span class="aa-reg-rel">${_aaRelTime(u.registered)}</span></td>
              <td><input class="aa-bill-input" data-field="started_on" type="date" value="${(() => { const a = _aaAnchor(u); return a ? a.toISOString().slice(0, 10) : ""; })()}" title="Billing start / approved day (informational — the cycle now rolls one month from each payment)"></td>
              <td>${statusSel(b)}</td>
              <td><input class="aa-bill-input" data-field="plan" type="text" value="${_aaEscHtml(b.plan || "")}" placeholder="—" style="width:78px"></td>
              <td><input class="aa-bill-input" data-field="amount_tzs" type="number" min="0" value="${Number(b.amount_tzs) || 0}" style="width:90px"></td>
              <td><input class="aa-bill-input" data-field="paid_until" type="date" value="${b.paid_until ? String(b.paid_until).slice(0, 10) : ""}"></td>
              <td class="aa-nextdue">${_aaComputeNextPaidUntil(u).toISOString().slice(0, 10)}</td>
              <td class="aa-sub-cell">${(() => { const s = _aaSubInfo(b, u.registered); return `<span class="aa-sub ${s.cls}">${s.label}</span>`; })()}
                  <button type="button" class="aa-approve-btn" data-key="${_aaEscHtml(u.key)}" title="${b.approved_at ? `Approved ${String(b.approved_at).slice(0, 10)}${b.approved_by ? " by " + _aaEscHtml(b.approved_by) : ""} — click to revoke` : "Approve this agent (lifts the 7-day window)"}">${b.approved_at ? "Approved" : "Approve"}</button>
                  <button type="button" class="aa-pay-btn" data-key="${_aaEscHtml(u.key)}" title="Record a payment from this agent — the amount they paid sets how long it lasts (${window.formatTZS(AA_MONTHLY_FEE)} = 1 month). Approves & activates them.">Record payment</button>
                  <button type="button" class="aa-active-btn" data-key="${_aaEscHtml(u.key)}" title="${b.active === false ? "Reactivate this agent" : "Deactivate — hide from clients"}">${b.active === false ? "Activate" : "Deactivate"}</button></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table></div>`;

    // Approve / Revoke — lift (or reinstate) the 7-day approval window.
    list.querySelectorAll(".aa-approve-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-key");
        const u = _aaByKey.get(key);
        const approved = !!(u && u.billing && u.billing.approved_at);
        if (approved) {
          if (!confirm("Revoke approval? This agent re-enters the 7-day window and hides once it lapses.")) return;
          _aaApprove(key, false);
        } else {
          _aaApprove(key, true);
        }
      });
    });
    // "Record payment" — log the cash the admin received from this agent (the
    // amount sets how long it lasts) and approve + activate them in one step.
    list.querySelectorAll(".aa-pay-btn").forEach((btn) => {
      btn.addEventListener("click", () => _aaRecordPayment(btn.getAttribute("data-key")));
    });
    // Activate / Deactivate switch.
    list.querySelectorAll(".aa-active-btn").forEach((btn) => {
      btn.addEventListener("click", () => _aaToggleActive(btn.getAttribute("data-key")));
    });

    // Inline billing edits — save the whole billing row for that agent on change.
    list.querySelectorAll(".aa-bill-input").forEach((inp) => {
      inp.addEventListener("change", (e) => {
        const tr = e.target.closest("tr");
        if (!tr) return;
        const key = tr.getAttribute("data-key");
        const patch = {
          status:     tr.querySelector('[data-field="status"]').value,
          plan:       tr.querySelector('[data-field="plan"]').value.trim() || null,
          amount_tzs: Number(tr.querySelector('[data-field="amount_tzs"]').value) || 0,
          paid_until: tr.querySelector('[data-field="paid_until"]').value || null,
          started_on: tr.querySelector('[data-field="started_on"]').value || null,
        };
        _aaSaveBilling(key, patch).then(() => {
          // Approved day / paid-until changes shift the "Next due" preview.
          if (e.target.dataset.field === "started_on" || e.target.dataset.field === "paid_until") {
            const cell = tr.querySelector(".aa-nextdue");
            const u = _aaByKey.get(key);
            if (cell && u) cell.textContent = _aaComputeNextPaidUntil(u).toISOString().slice(0, 10);
          }
        });
      });
    });

    // Row selection (for bulk actions) — track keys, keep select-all in sync.
    const selectAll = $("aaSelectAll");
    const syncSelectAll = () => {
      const boxes = list.querySelectorAll(".aa-row-check");
      if (selectAll) selectAll.checked = boxes.length > 0 &&
        [...boxes].every((c) => c.checked);
      _aaUpdateBulkBar();
    };
    list.querySelectorAll(".aa-row-check").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) _aaSelected.add(cb.dataset.key);
        else _aaSelected.delete(cb.dataset.key);
        syncSelectAll();
      });
    });
    selectAll?.addEventListener("change", () => {
      list.querySelectorAll(".aa-row-check").forEach((cb) => {
        cb.checked = selectAll.checked;
        if (selectAll.checked) _aaSelected.add(cb.dataset.key);
        else _aaSelected.delete(cb.dataset.key);
      });
      _aaUpdateBulkBar();
    });
    _aaUpdateBulkBar();
  }

  // Upsert one billing row, transparently stripping columns the live schema is
  // missing and retrying (e.g. `started_on` before agent_billing_anchor.sql has
  // been run). Mutates `patch` so the caller's cache reflects what was saved.
  async function _aaUpsertBilling(key, patch) {
    const u = _aaByKey.get(key);
    let email = null;
    try { const s = await window.Auth.getSession(); email = s?.user?.email || null; } catch (_) {}
    let payload = { agent_key: key, name: u ? u.name : null, phone: u ? u.phone : null, updated_by: email, ...patch };
    for (let i = 0; i < 8; i++) {
      const { error } = await sb.from("agent_billing").upsert(payload, { onConflict: "agent_key" });
      if (!error) return { error: null };
      const col = _extractMissingColumn(error.message);
      if (!col || !(col in payload)) return { error };
      delete payload[col]; delete patch[col];   // drop unknown col from both
    }
    return { error: { message: "Too many schema mismatches saving billing." } };
  }

  async function _aaSaveBilling(key, patch) {
    if (_aaBillingMissing) {
      alert("Billing isn't enabled yet. Run supabase/features/agent/agent_billing_setup.sql in your Supabase SQL editor, then reload this tab.");
      return;
    }
    const u = _aaByKey.get(key);
    const { error } = await _aaUpsertBilling(key, patch);
    if (error) { alert("Billing save failed: " + error.message); return; }
    if (u) { u.billing = { ...u.billing, ...patch }; }
    _aaRenderSummary();
    // If a billing filter is active the row may need to drop out — redraw.
    if ($("aaBilling")?.value) _aaDraw();
  }

  // Quietly save one billing row (no per-row alert/redraw) — used by the bulk
  // engine so a 200-agent loop doesn't fire 200 popups. Returns true on success.
  async function _aaSaveBillingQuiet(key, patch) {
    const u = _aaByKey.get(key);
    const { error } = await _aaUpsertBilling(key, patch);
    if (error) return false;
    if (u) u.billing = { ...u.billing, ...patch };
    return true;
  }

  // ---- Bulk control bar — operate on every selected (or every filtered) agent.
  // "make a loop in all agents": the admin picks an action and it's applied to
  // the whole set at once, with a confirm + progress + result summary.
  function _aaFilteredRows() {
    // Mirror the filters _aaDraw() applies, so "all shown" matches the table.
    if (!_aaUnified) return [];
    const q    = ($("aaSearch")?.value || "").toLowerCase().trim();
    const role = $("aaRole")?.value || "";
    const bill = $("aaBilling")?.value || "";
    return _aaUnified.filter((u) => {
      if (role && !u.roles.includes(role)) return false;
      if (bill) {
        const st = u.billing?.status || "free";
        const ap = !!(u.billing && u.billing.approved_at);
        if (bill === "pending")       { if (ap) return false; }
        else if (bill === "approved") { if (!ap) return false; }
        else if (bill === "unpaid")   { if (st === "paid") return false; }
        else if (st !== bill) return false;
      }
      if (q) {
        const p = u.profile || {};
        const hay = `${u.name} ${u.phone} ${u.regions.join(" ")} ${u.email} ${p.area_of_operations || ""} ${p.district || ""} ${p.ward || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }
  // The agents a bulk action targets: ticked rows if any, else everyone shown.
  function _aaBulkTargets() {
    const shown = _aaFilteredRows();
    if (_aaSelected.size) return shown.filter((u) => _aaSelected.has(u.key));
    return shown;
  }
  function _aaUpdateBulkBar() {
    const info = $("aaBulkInfo");
    if (!info) return;
    const sel = _aaSelected.size;
    const shown = _aaFilteredRows().length;
    info.textContent = sel
      ? `${sel} selected — actions apply to these.`
      : `No rows ticked — actions apply to all ${shown} shown.`;
  }
  // Run an async op over each target with a small concurrency cap, updating a
  // live progress label. Returns { ok, fail }.
  async function _aaRunBulk(targets, label, opFn) {
    const status = $("aaBulkStatus");
    let ok = 0, fail = 0, done = 0;
    const tick = () => { if (status) status.textContent = `${label}… ${done}/${targets.length} (${fail} failed)`; };
    tick();
    const POOL = 5;
    let idx = 0;
    async function worker() {
      while (idx < targets.length) {
        const u = targets[idx++];
        try { (await opFn(u)) ? ok++ : fail++; }
        catch (_) { fail++; }
        done++; tick();
      }
    }
    await Promise.all(Array.from({ length: Math.min(POOL, targets.length) }, worker));
    if (status) status.textContent = `Done: ${ok} updated, ${fail} failed.`;
    return { ok, fail };
  }

  // ---------- Admin → agent messaging ----------
  // Send any message to an agent's ACCOUNT (it shows on their dashboard until
  // they dismiss it). Targets: the current targeted set (ticked/shown), everyone
  // unpaid, or everyone deactivated. Only agents with an account (uid key) can
  // receive an in-app message; phone-only agents are skipped (and counted).
  function _aaIsDeactivated(u) { return !!(u.billing && u.billing.active === false); }
  function _aaIsUnpaid(u) {
    const b = u.billing || {};
    if (b.active === false) return false;                 // that's "deactivated", a separate group
    return _aaSubInfo(b, u.registered).cls === "sub-exp"; // expired / overdue / cancelled / unapproved-hidden
  }
  function _aaUidFromKey(key) { return (typeof key === "string" && key.startsWith("uid:")) ? key.slice(4) : null; }

  // Compose modal → resolves to { body, sms } or null if cancelled. The SMS box
  // (on by default) also texts the message so phone-only / offline agents get it.
  function _aaComposeMessage(targetLabel, accountCount, phoneCount) {
    return new Promise((resolve) => {
      const ov = document.createElement("div");
      ov.style.cssText = "position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,.6);padding:20px";
      ov.innerHTML =
        '<div style="background:#fff;color:#0f172a;max-width:460px;width:100%;border-radius:16px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.35);font:14px/1.5 system-ui,sans-serif">' +
          '<h2 style="margin:0 0 4px;font-size:1.15rem">Message ' + _aaEscHtml(targetLabel) + '</h2>' +
          '<p style="margin:0 0 12px;color:#475569">Shows on <strong>' + accountCount + '</strong> agent account' + (accountCount === 1 ? "" : "s") + ' until dismissed.</p>' +
          '<textarea id="_aaMsgBody" rows="5" placeholder="Type your message…" style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font:inherit;resize:vertical"></textarea>' +
          '<label style="display:flex;gap:8px;align-items:flex-start;margin:10px 0 2px;font-size:.88rem;color:#334155;cursor:pointer">' +
            '<input id="_aaMsgSms" type="checkbox" checked style="margin-top:3px">' +
            '<span>Also send by <strong>SMS</strong> to ' + phoneCount + ' number' + (phoneCount === 1 ? "" : "s") + ' — reaches phone-only &amp; offline agents.</span></label>' +
          '<div id="_aaMsgErr" style="min-height:16px;color:#b91c1c;font-size:.84rem;margin:4px 0"></div>' +
          '<div style="display:flex;gap:8px;justify-content:flex-end">' +
            '<button id="_aaMsgCancel" type="button" style="padding:9px 16px;border:0;border-radius:9px;background:#e2e8f0;color:#334155;font-weight:600;cursor:pointer">Cancel</button>' +
            '<button id="_aaMsgSend" type="button" style="padding:9px 18px;border:0;border-radius:9px;background:#0a6f4d;color:#fff;font-weight:700;cursor:pointer">Send</button>' +
          '</div></div>';
      document.body.appendChild(ov);
      const body = ov.querySelector("#_aaMsgBody"), err = ov.querySelector("#_aaMsgErr");
      const smsBox = ov.querySelector("#_aaMsgSms");
      const close = (v) => { try { ov.remove(); } catch (_) {} resolve(v); };
      ov.addEventListener("click", (e) => { if (e.target === ov) close(null); });
      ov.querySelector("#_aaMsgCancel").addEventListener("click", () => close(null));
      ov.querySelector("#_aaMsgSend").addEventListener("click", () => {
        const t = (body.value || "").trim();
        if (t.length < 2) { err.textContent = "Type a message first."; return; }
        close({ body: t, sms: !!(smsBox && smsBox.checked) });
      });
      setTimeout(() => { try { body.focus(); } catch (_) {} }, 40);
    });
  }

  async function _aaMessageAgents(target) {
    let pool, label;
    if (target === "unpaid")           { pool = (_aaUnified || []).filter(_aaIsUnpaid);      label = "all unpaid agents"; }
    else if (target === "deactivated") { pool = (_aaUnified || []).filter(_aaIsDeactivated); label = "all deactivated agents"; }
    else                               { pool = _aaBulkTargets();                            label = "the targeted agents"; }

    // Account-holders (uid) get the in-app message; ALL with a phone get the SMS.
    const recipients = [];     // uids for the dashboard inbox
    const phones = [];         // numbers for the SMS fallback
    let noAccount = 0;
    for (const u of pool) {
      const uid = _aaUidFromKey(u.key);
      if (uid) recipients.push(uid); else noAccount++;
      const ph = (u.phone || "").trim();
      if (ph) phones.push(ph);
    }
    if (!recipients.length && !phones.length) { alert("No reachable agents in this group."); return; }

    const out = await _aaComposeMessage(label, recipients.length, phones.length);
    if (out == null) return;
    const body = out.body;

    let email = null;
    try { const s = await window.Auth.getSession(); email = s?.user?.email || null; } catch (_) {}
    const status = $("aaBulkStatus");
    if (status) status.textContent = "Sending…";

    // 1) In-app messages for account-holders.
    let inAppNote = "";
    if (recipients.length) {
      const rows = recipients.map((uid) => ({
        to_user_id: uid, body, kind: target === "targeted" ? "individual" : target, created_by: email,
      }));
      const { error } = await sb.from("agent_messages").insert(rows);
      if (error) {
        if (/relation .* does not exist|schema cache|could not find/i.test(error.message || ""))
          alert("In-app messaging isn't set up yet. Run supabase/features/agent/agent_messages.sql in Supabase.");
        else alert("Couldn't send in-app message: " + error.message);
        if (status) status.textContent = "Send failed.";
        return;
      }
      inAppNote = `In-app: ${recipients.length}`;
    }

    // 2) SMS fallback (reaches phone-only + offline agents).
    let smsNote = "";
    if (out.sms && phones.length && window.pawaSendSms) {
      if (status) status.textContent = (inAppNote ? inAppNote + " · " : "") + "sending SMS…";
      const r = await window.pawaSendSms(phones, body);
      smsNote = r.configured === false
        ? "SMS not deployed (run supabase/functions/send-sms)"
        : r.error ? `SMS failed (${r.error})` : `SMS: ${r.sent}`;
    } else if (out.sms && phones.length) {
      smsNote = "SMS unavailable";
    }

    if (status) status.textContent = ["Sent.", inAppNote, smsNote, noAccount ? `${noAccount} phone-only (SMS only)` : ""].filter(Boolean).join(" · ");
  }

  async function _aaBulkAction(kind) {
    if (_aaBillingMissing) {
      alert("Billing isn't enabled yet. Run supabase/features/agent/agent_billing_setup.sql in Supabase, then reload.");
      return;
    }
    const targets = _aaBulkTargets();
    if (!targets.length) { alert("No agents to act on."); return; }

    let opFn, confirmMsg, label;
    if (kind === "approve") {
      confirmMsg = `Approve ${targets.length} agent(s)? They stay live permanently (subject to billing). Unapproved agents auto-hide ${AA_APPROVAL_DAYS} days after registering.`;
      label = "Approving";
      let email = null;
      try { const s = await window.Auth.getSession(); email = s?.user?.email || null; } catch (_) {}
      opFn = (u) => _aaSaveBillingQuiet(u.key, { approved_at: new Date().toISOString(), approved_by: email, active: true });
    } else if (kind === "month") {
      confirmMsg = `Record one month's subscription for ${targets.length} agent(s)?\n\nEach agent gets a full month from their OWN timeline — extending from their current expiry if still active (paying early stacks, no lost days), otherwise starting today. Re-activates the account.`;
      label = "Recording month";
      // One month = the agent's own rate. Goes through _aaApplyPayment so each
      // bulk payment is logged to the receipts ledger and rolls a full month
      // from that agent's own expiry (paying early stacks; lapsed starts today).
      opFn = async (u) => {
        const b = u.billing || {};
        const amount = Number(b.amount_tzs) > 0 ? Number(b.amount_tzs) : AA_MONTHLY_FEE;
        const res = await _aaApplyPayment(u.key, amount, { method: "bulk" });
        return res.ok;
      };
    } else if (kind === "activate") {
      confirmMsg = `Activate ${targets.length} agent(s)? Their listings/profile become visible again.`;
      label = "Activating";
      opFn = (u) => _aaSaveBillingQuiet(u.key, { active: true, note: null });
    } else if (kind === "deactivate") {
      const reason = prompt(
        `Deactivate ${targets.length} agent(s) — their listings hide from clients until reactivated.\n\nMessage they'll all see (the reason):`,
        "Your monthly subscription is due. Please settle it to keep your account active."
      );
      if (reason === null) return;
      confirmMsg = null;   // prompt already served as the confirm step
      label = "Deactivating";
      opFn = (u) => _aaSaveBillingQuiet(u.key, { active: false, note: (reason || "").trim() || null });
    } else if (kind === "enroll") {
      confirmMsg = `Enrol ${targets.length} agent(s) on the standard ${window.formatTZS(AA_MONTHLY_FEE)}/month plan?\n\nSets their monthly fee and records their billing start. Does not take money or mark them paid — use "Record month" when they pay.`;
      label = "Enrolling";
      opFn = (u) => {
        const b = u.billing || {};
        const anchor = _aaAnchor(u);
        const patch = { amount_tzs: Number(b.amount_tzs) > 0 ? Number(b.amount_tzs) : AA_MONTHLY_FEE };
        if (!b.started_on && anchor) patch.started_on = anchor.toISOString().slice(0, 10);
        return _aaSaveBillingQuiet(u.key, patch);
      };
    } else if (kind === "fee") {
      const v = prompt(`Set the monthly fee (TZS) for ${targets.length} agent(s):`, String(AA_MONTHLY_FEE));
      if (v === null) return;
      const amount = Math.max(0, Math.round(Number(v) || 0));
      confirmMsg = null;
      label = "Setting fee";
      opFn = (u) => _aaSaveBillingQuiet(u.key, { amount_tzs: amount });
    } else { return; }

    if (confirmMsg && !confirm(confirmMsg)) return;

    // Disable the bar while running.
    const bar = $("aaBulkBar");
    bar?.querySelectorAll("button").forEach((b) => (b.disabled = true));
    await _aaRunBulk(targets, label, opFn);
    bar?.querySelectorAll("button").forEach((b) => (b.disabled = false));

    _aaSelected.clear();
    _aaRenderSummary();
    _aaDraw();
  }

  function _aaExportCsv() {
    if (!_aaUnified || !_aaUnified.length) { alert("No agents to export yet."); return; }
    const esc = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["Name", "Phone", "Email", "Roles", "Regions", "Operating area", "Area kind", "District", "Ward", "House listings", "Service listings", "Truck listings", "Bus records", "Verified", "Registered (ISO)", "Registered (local)", "Billing status", "Plan", "Amount (TZS)", "Approved on", "Paid until", "Next due"];
    const lines = _aaUnified
      .slice()
      .sort((a, b) => (new Date(b.registered || 0)) - (new Date(a.registered || 0)))
      .map((u) => {
        const b = u.billing || {};
        const p = u.profile || {};
        const anchor = _aaAnchor(u);
        return [
          u.name, u.phone, u.email, u.roles.join("|"), u.regions.join("|"),
          p.area_of_operations || "", p.area_kind || "", p.district || "", p.ward || "",
          u.houseCount, u.serviceCount, u.truckCount, u.busCount, u.verified ? "yes" : "no",
          u.registered || "", u.registered ? new Date(u.registered).toLocaleString() : "",
          b.status || "free", b.plan || "", Number(b.amount_tzs) || 0,
          anchor ? anchor.toISOString().slice(0, 10) : "", b.paid_until || "",
          _aaComputeNextPaidUntil(u).toISOString().slice(0, 10),
        ].map(esc).join(",");
      });
    const csv = [header.join(","), ...lines].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pawa-agents-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- Tenants tab — rent expiry tracker ----------
  // Central view of every house tenant agents have recorded, sorted by soonest
  // rent end so the platform can contact customers near expiry. Admin reads all
  // rows (RLS owner-or-admin) and may flip the `contacted` flag.
  let _tenAll = null;

  function _tenDays(endIso) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const end = new Date(endIso + "T00:00:00");
    return Math.round((end - today) / 86400000);
  }

  async function renderTenancies() {
    const list = $("tenantsList");
    if (!list) return;
    list.innerHTML = `<div class="empty"><p>Loading tenants…</p></div>`;

    const [tRes, hRes] = await Promise.allSettled([
      sb.from("house_tenancies").select("*"),
      sb.from("houses").select("id,agent,area,region,title"),
    ]);
    const note = $("tenNote");
    if (tRes.status !== "fulfilled" || tRes.value.error) {
      if (note) { note.hidden = false; note.textContent = "house_tenancies table not found — run supabase/features/house/house_tenancies.sql."; }
      list.innerHTML = `<div class="empty"><p>No tenant data.</p></div>`;
      _tenAll = [];
      _tenRenderSummary();
      return;
    }
    if (note) note.hidden = true;
    const tenancies = Array.isArray(tRes.value.data) ? tRes.value.data : [];
    const houses = hRes.status === "fulfilled" && Array.isArray(hRes.value.data) ? hRes.value.data : [];
    const hMap = new Map(houses.map((h) => [h.id, h]));

    _tenAll = tenancies.map((t) => {
      const h = hMap.get(t.house_id) || {};
      const ag = h.agent || {};
      return {
        ...t,
        house: t.house_label || h.title || "—",
        area: h.area || h.region || "",
        agentName: ag.name || "—",
        agentPhone: ag.phone || "",
        days: _tenDays(t.end_date),
      };
    });
    _tenRenderSummary();
    _tenDraw();
  }

  function _tenRenderSummary() {
    const badge = $("tenantsBadge");
    const active = (_tenAll || []).filter((t) => t.status === "active");
    const soon = active.filter((t) => t.days <= 30 && t.days >= 0).length;
    const overdue = active.filter((t) => t.days < 0).length;
    if (badge) badge.textContent = soon ? String(soon) : "";
    const sum = $("tenSummary");
    if (sum) {
      sum.innerHTML = [
        ["Active tenancies", active.length, ""],
        ["Ending ≤30 days", soon, "pay"],
        ["Overdue", overdue, "rev"],
        ["Total records", (_tenAll || []).length, ""],
      ].map(([lbl, num, cls]) => `<div class="aa-stat ${cls}"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`).join("");
    }
  }

  function _tenDraw() {
    const list = $("tenantsList");
    if (!list || !_tenAll) return;
    const q = ($("tenSearch")?.value || "").toLowerCase().trim();
    const filter = $("tenFilter")?.value || "ending";
    const sort = $("tenSort")?.value || "soonest";

    let rows = _tenAll.filter((t) => {
      if (filter === "active" && t.status !== "active") return false;
      if (filter === "ending" && !(t.status === "active" && t.days <= 30)) return false;
      if (q) {
        const hay = `${t.customer_name} ${t.customer_phone} ${t.house} ${t.area} ${t.agentName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    rows.sort((a, b) => sort === "latest" ? b.days - a.days : a.days - b.days);

    if (!rows.length) { list.innerHTML = `<div class="empty"><p>No tenants match.</p></div>`; return; }

    const dleft = (t) => {
      if (t.status !== "active") return `<span class="aa-role-tag">${_aaEscHtml(t.status)}</span>`;
      let cls = "ten-ok", label = `${t.days}d left`;
      if (t.days < 0) { cls = "ten-expired"; label = `${Math.abs(t.days)}d overdue`; }
      else if (t.days <= 7) { cls = "ten-soon"; label = t.days === 0 ? "ends today" : `${t.days}d left`; }
      else if (t.days <= 30) { cls = "ten-warn"; }
      return `<span class="ten-dleft ${cls}">${label}</span>`;
    };

    list.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Customer</th><th>Phone</th><th>Owner phone</th><th>House</th><th>Agent</th>
          <th>Start</th><th>Ends</th><th>Days</th><th>Status</th><th>Contacted</th>
        </tr></thead>
        <tbody>
          ${rows.map((t) => `
            <tr data-id="${_aaEscHtml(t.id)}">
              <td>${_aaEscHtml(t.customer_name)}</td>
              <td>${t.customer_phone ? `<a href="tel:${_aaEscHtml(t.customer_phone)}">${_aaEscHtml(t.customer_phone)}</a>` : "—"}</td>
              <td>${t.landlord_phone ? `<a href="tel:${_aaEscHtml(t.landlord_phone)}">${_aaEscHtml(t.landlord_phone)}</a>` : "—"}</td>
              <td>${_aaEscHtml(t.house)}${t.area ? `<br><small>${_aaEscHtml(t.area)}</small>` : ""}</td>
              <td>${_aaEscHtml(t.agentName)}${t.agentPhone ? `<br><small>${_aaEscHtml(t.agentPhone)}</small>` : ""}</td>
              <td>${_aaEscHtml(t.start_date)}</td>
              <td><strong>${_aaEscHtml(t.end_date)}</strong></td>
              <td>${dleft(t)}</td>
              <td style="text-transform:capitalize">${_aaEscHtml(t.status)}</td>
              <td><input type="checkbox" class="ten-contacted" ${t.contacted ? "checked" : ""}></td>
            </tr>`).join("")}
        </tbody>
      </table></div>`;

    list.querySelectorAll("tr[data-id]").forEach((tr) => {
      const id = tr.dataset.id;
      tr.querySelector(".ten-contacted")?.addEventListener("change", async (e) => {
        const checked = e.target.checked;
        const { error } = await sb.from("house_tenancies")
          .update({ contacted: checked, updated_at: new Date().toISOString() }).eq("id", id);
        if (error) { e.target.checked = !checked; alert("Update failed: " + error.message); return; }
        const rec = _tenAll.find((x) => x.id === id); if (rec) rec.contacted = checked;
      });
    });
  }

  function _tenExportCsv() {
    if (!_tenAll || !_tenAll.length) { alert("No tenants to export yet."); return; }
    const esc = (v) => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const header = ["Customer", "Phone", "Owner phone", "House", "Area", "Agent", "Agent phone", "Start", "Ends", "Days left", "Status", "Contacted", "Notes"];
    const lines = _tenAll.slice().sort((a, b) => a.days - b.days).map((t) => [
      t.customer_name, t.customer_phone, t.landlord_phone || "", t.house, t.area, t.agentName, t.agentPhone,
      t.start_date, t.end_date, t.days, t.status, t.contacted ? "yes" : "no", t.notes || "",
    ].map(esc).join(","));
    const csv = [header.join(","), ...lines].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `pawa-tenants-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- Day Jobs tab — vibarua board oversight ----------
  // Lists every posted job with its claimed workers (names + phones — the
  // "day_job_claims admin read" RLS policy makes them visible to admins
  // only). Close abusive/finished posts, reopen mistakes, delete spam.
  let _djJobs = [], _djClaims = new Map();   // job_id -> [claims]
  const _djEsc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  async function renderDayJobs() {
    const note = $("djNote");
    try {
      const [jobsQ, claimsQ] = await Promise.all([
        sb.from("day_jobs").select("*").order("created_at", { ascending: false }).limit(500),
        sb.from("day_job_claims").select("job_id, worker_name, worker_phone, worker_code, created_at")
          .order("created_at", { ascending: true }).limit(2000)
      ]);
      if (jobsQ.error) throw jobsQ.error;
      _djJobs = jobsQ.data || [];
      _djClaims = new Map();
      // Claims read needs the admin RLS policy; if it errors we still show jobs.
      if (!claimsQ.error) {
        for (const c of (claimsQ.data || [])) {
          if (!_djClaims.has(c.job_id)) _djClaims.set(c.job_id, []);
          _djClaims.get(c.job_id).push(c);
        }
      }
      note.hidden = true;
    } catch (e) {
      note.hidden = false;
      note.textContent = "Day jobs unavailable: " + (e.message || e) +
        " — run supabase/features/job/day_jobs.sql if the board isn't deployed yet.";
      _djJobs = [];
    }
    _djDraw();
  }

  function _djDraw() {
    const wrap = $("dayJobsList");
    if (!wrap) return;
    const q  = ($("djSearch")?.value || "").toLowerCase().trim();
    const st = $("djStatus")?.value || "";

    // Summary cards + tab badge (open jobs).
    const open = _djJobs.filter(j => j.status === "open");
    const slotsOpen = open.reduce((s, j) => s + Math.max(0, j.workers_needed - j.claimed_count), 0);
    const workers   = _djJobs.reduce((s, j) => s + (j.claimed_count || 0), 0);
    $("djBadge").textContent = open.length || "";
    const sum = $("djSummary");
    if (sum) sum.innerHTML = `
      <div class="aa-stat"><div class="num">${_djJobs.length}</div><div class="lbl">Jobs posted</div></div>
      <div class="aa-stat"><div class="num">${open.length}</div><div class="lbl">Open now</div></div>
      <div class="aa-stat"><div class="num">${slotsOpen}</div><div class="lbl">Slots unfilled</div></div>
      <div class="aa-stat pay"><div class="num">${workers}</div><div class="lbl">Workers claimed</div></div>`;

    let rows = _djJobs;
    if (st) rows = rows.filter(j => j.status === st);
    if (q)  rows = rows.filter(j =>
      (j.title || "").toLowerCase().includes(q) ||
      (j.company_name || "").toLowerCase().includes(q) ||
      (j.company_phone || "").toLowerCase().includes(q));

    if (!rows.length) {
      wrap.innerHTML = `<div class="empty-state"><div class="es-icon"></div><div>No day jobs${st || q ? " match the filter" : " posted yet"}.</div></div>`;
      return;
    }

    const stBadge = (s) => ({
      open:    `<span class="aa-sub sub-ok">open</span>`,
      full:    `<span class="aa-sub sub-due">full</span>`,
      closed:  `<span class="aa-sub sub-none">closed</span>`,
      expired: `<span class="aa-sub sub-exp">expired</span>`
    })[s] || _djEsc(s);

    wrap.innerHTML = `
      <div style="overflow-x:auto">
      <table class="data-table" style="width:100%;border-collapse:collapse;font-size:14px;background:var(--c-surface,#fff)">
        <thead><tr>
          <th style="text-align:left;padding:9px 10px">Job</th>
          <th style="text-align:left;padding:9px 10px">Company</th>
          <th style="text-align:left;padding:9px 10px">When</th>
          <th style="text-align:left;padding:9px 10px">Pay</th>
          <th style="text-align:left;padding:9px 10px">Workers</th>
          <th style="text-align:left;padding:9px 10px">Status</th>
          <th style="text-align:left;padding:9px 10px">Actions</th>
        </tr></thead>
        <tbody>
        ${rows.map(j => {
          const claims = _djClaims.get(j.id) || [];
          const when = [j.work_date || "", j.time_note || ""].filter(Boolean).join(" · ");
          const workersHtml = claims.length
            ? `<details><summary style="cursor:pointer">${j.claimed_count}/${j.workers_needed} — view workers</summary>
                 <ul style="margin:6px 0 0;padding-left:16px">
                   ${claims.map(c => `<li><code style="background:#064a33;color:#fff;border-radius:5px;padding:0 6px;font-weight:700">${_djEsc(c.worker_code || "—")}</code> ${_djEsc(c.worker_name)} — <a href="tel:${_djEsc(c.worker_phone)}">${_djEsc(c.worker_phone)}</a></li>`).join("")}
                 </ul></details>`
            : `${j.claimed_count}/${j.workers_needed}`;
          const actions = [
            (j.status === "open" || j.status === "full")
              ? `<button class="btn btn-outline btn-sm" data-dj-close="${j.id}">Close</button>` : "",
            (j.status === "closed" || j.status === "expired")
              ? `<button class="btn btn-outline btn-sm" data-dj-open="${j.id}">Reopen</button>` : "",
            `<button class="btn btn-danger btn-sm" data-dj-del="${j.id}">Delete</button>`
          ].filter(Boolean).join(" ");
          return `<tr style="border-top:1px solid var(--c-border,#e7e4dd)">
            <td style="padding:9px 10px"><strong>${_djEsc(j.title)}</strong>
              ${j.description ? `<br><small style="color:var(--c-muted,#6b6960)">${_djEsc(j.description.slice(0, 90))}${j.description.length > 90 ? "…" : ""}</small>` : ""}</td>
            <td style="padding:9px 10px">${_djEsc(j.company_name)}<br><a href="tel:${_djEsc(j.company_phone)}"><small>${_djEsc(j.company_phone)}</small></a></td>
            <td style="padding:9px 10px">${_djEsc(when || "—")}</td>
            <td style="padding:9px 10px">${j.pay_tzs ? "TZS " + Number(j.pay_tzs).toLocaleString("en-US") : "—"}</td>
            <td style="padding:9px 10px">${workersHtml}</td>
            <td style="padding:9px 10px">${stBadge(j.status)}</td>
            <td style="padding:9px 10px;white-space:nowrap">${actions}</td>
          </tr>`;
        }).join("")}
        </tbody>
      </table></div>`;

    wrap.querySelectorAll("[data-dj-close]").forEach(b => b.addEventListener("click", () => _djSetStatus(b.dataset.djClose, "closed")));
    wrap.querySelectorAll("[data-dj-open]").forEach(b => b.addEventListener("click", () => _djSetStatus(b.dataset.djOpen, "open")));
    wrap.querySelectorAll("[data-dj-del]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this job post (and its worker claims) permanently?")) return;
      const { error } = await sb.from("day_jobs").delete().eq("id", b.dataset.djDel);
      if (error) { alert("Delete failed: " + error.message); return; }
      _djJobs = _djJobs.filter(j => String(j.id) !== String(b.dataset.djDel));
      _djDraw();
    }));
  }

  async function _djSetStatus(id, status) {
    const { error } = await sb.from("day_jobs").update({ status }).eq("id", id);
    if (error) { alert("Update failed: " + error.message); return; }
    const j = _djJobs.find(x => String(x.id) === String(id));
    if (j) j.status = status;
    _djDraw();
  }

  // ---------- start ----------
  showCorrectView();
};
