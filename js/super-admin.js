// =====================================================
// Super Admin — tenant approval + oversight.
// Gated by APP_CONFIG.ADMIN_EMAILS + admins table membership.
// =====================================================

window.initSuperAdmin = async () => {
  const sb     = window.SB;
  const cfg    = window.APP_CONFIG || {};
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

  // ---- Auth gate ----------
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
    await loadAll();
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

  // ---- Data loading ----------
  async function loadAll() {
    const { data, error } = await sb.from("tenants")
      .select("id, slug, display_name, legal_name, contact_email, contact_phone, status, owner_user_id, created_at, approved_at")
      .order("created_at", { ascending: false });
    if (error) { flash("err", "Load failed: " + error.message, 0); return; }
    renderCounts(data);
    renderPending(data);
    renderAll(data);
  }

  function renderCounts(rows) {
    const counts = { pending_approval: 0, active: 0, suspended: 0, rejected: 0 };
    rows.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
    document.getElementById("cntPending").textContent   = counts.pending_approval;
    document.getElementById("cntActive").textContent    = counts.active;
    document.getElementById("cntSuspended").textContent = counts.suspended;
    document.getElementById("cntRejected").textContent  = counts.rejected;
  }

  function fmtDate(s) {
    if (!s) return "—";
    const d = new Date(s);
    return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  }

  function renderPending(rows) {
    const pending = rows.filter(r => r.status === "pending_approval");
    const tbody = document.querySelector("#pendingTable tbody");
    const empty = document.getElementById("pendingEmpty");
    tbody.innerHTML = "";
    if (pending.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;
    pending.forEach(r => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><code>${escapeHTML(r.slug)}</code></td>
        <td><strong>${escapeHTML(r.display_name)}</strong>${r.legal_name ? `<br/><small>${escapeHTML(r.legal_name)}</small>` : ""}</td>
        <td>${escapeHTML(r.contact_email)}<br/><small>${escapeHTML(r.contact_phone || "")}</small></td>
        <td>${fmtDate(r.created_at)}</td>
        <td class="sa-actions">
          <button class="sa-btn approve" data-act="approve" data-id="${r.id}">Approve</button>
          <button class="sa-btn reject"  data-act="reject"  data-id="${r.id}">Reject</button>
        </td>`;
      tbody.appendChild(tr);
    });
  }

  function renderAll(rows) {
    const tbody = document.querySelector("#allTable tbody");
    const empty = document.getElementById("allEmpty");
    tbody.innerHTML = "";
    if (rows.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;
    rows.forEach(r => {
      const tr = document.createElement("tr");
      const actions = r.status === "active"
        ? `<button class="sa-btn suspend" data-act="suspend" data-id="${r.id}">Suspend</button>`
        : r.status === "suspended"
        ? `<button class="sa-btn approve" data-act="reactivate" data-id="${r.id}">Reactivate</button>`
        : r.status === "rejected"
        ? `<button class="sa-btn approve" data-act="reconsider" data-id="${r.id}">Reconsider</button>`
        : "";
      tr.innerHTML = `
        <td><code>${escapeHTML(r.slug)}</code></td>
        <td>${escapeHTML(r.display_name)}</td>
        <td>${escapeHTML(r.contact_email)}</td>
        <td><span class="sa-status ${r.status === "pending_approval" ? "pending" : r.status}">${r.status.replace("_"," ")}</span></td>
        <td>${fmtDate(r.created_at)}</td>
        <td class="sa-actions">${actions}</td>`;
      tbody.appendChild(tr);
    });
  }

  // ---- Action handlers ----------
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id  = btn.dataset.id;
    const act = btn.dataset.act;
    btn.disabled = true;

    try {
      if (act === "approve" || act === "reactivate" || act === "reconsider") {
        await callApprove(id, "active");
        flash("ok", "Tenant activated.");
      } else if (act === "reject") {
        const note = prompt("Optional rejection note (visible in audit only):") || null;
        await callApprove(id, "rejected", note);
        flash("ok", "Tenant marked rejected.");
      } else if (act === "suspend") {
        await callApprove(id, "suspended");
        flash("ok", "Tenant suspended.");
      }
      // Refresh quietly — never let a refresh failure overwrite the success banner
      loadAll().catch(e => console.warn("List refresh failed (DB change still saved):", e));
    } catch (err) {
      console.error("Action failed:", err);
      const msg = err?.message || err?.error_description || err?.code || String(err);
      flash("err", "Action failed: " + msg, 0);
    } finally {
      btn.disabled = false;
    }
  });

  // ---- Status change: try RPC, fall back to direct UPDATE ----
  async function callApprove(tenantId, newStatus, rejectionNote) {
    // 1) Preferred: SECURITY DEFINER RPC (admin check inside function)
    try {
      const { data, error } = await sb.rpc("set_tenant_status", {
        p_tenant_id: tenantId,
        p_status:    newStatus,
        p_note:      rejectionNote || null
      });
      if (!error) {
        console.log("RPC ok:", data);
        return { ok: true, data };
      }
      console.warn("RPC failed, falling back to direct UPDATE:", error);
    } catch (e) {
      console.warn("RPC threw, falling back to direct UPDATE:", e?.message || e);
    }

    // 2) Fallback: direct UPDATE (admin RLS allows it)
    const session = await window.Auth.getSession();
    const patch = { status: newStatus };
    if (newStatus === "active") {
      patch.approved_at = new Date().toISOString();
      patch.approved_by = session?.user?.id || null;
    } else if (newStatus === "rejected") {
      patch.rejection_note = rejectionNote || null;
    } else {
      patch.rejection_note = null;
    }
    const { data, error } = await sb.from("tenants").update(patch).eq("id", tenantId).select();
    if (error) throw error;
    if (!data || data.length === 0) throw new Error("Tenant not found or update blocked by RLS");
    console.log("Direct UPDATE ok:", data);
    return { ok: true, data };
  }

  function escapeHTML(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, c => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]
    ));
  }

  await evaluateAuth();
};
