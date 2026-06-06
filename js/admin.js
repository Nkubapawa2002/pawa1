// =====================================================
// Admin Panel — gated by Supabase Auth + admins table
// =====================================================

window.initAdminPage = async () => {
  const sb = window.SB;
  const STATUSES = ["Registered", "Picked Up", "In Transit", "Arrived", "Delivered"];

  const $ = (id) => document.getElementById(id);
  const loginGate = $("loginGate");
  const forbidden = $("forbidden");
  const adminPanel = $("adminPanel");

  if (!sb) {
    loginGate.hidden = false;
    $("loginError").hidden = false;
    $("loginError").textContent = "Supabase not configured. Check js/config.js.";
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
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("loginError");
    err.hidden = true;
    try {
      await window.Auth.signIn($("loginEmail").value.trim(), $("loginPassword").value);
      showCorrectView();
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || "Sign-in failed.";
    }
  });

  $("signupLink").addEventListener("click", async (e) => {
    e.preventDefault();
    const email = $("loginEmail").value.trim();
    const pw = $("loginPassword").value;
    const err = $("loginError");
    err.hidden = true;
    if (!email || pw.length < 6) {
      err.hidden = false;
      err.textContent = "Enter your authorized email and a password (>= 6 chars), then click create.";
      return;
    }
    try {
      await window.Auth.signUp(email, pw);
      err.hidden = false;
      err.classList.remove("error");
      err.classList.add("success");
      err.textContent = "Account created. If email confirmation is enabled, check your inbox, then sign in.";
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || "Sign-up failed.";
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

    await Promise.all([
      renderShipments(),
      renderPendingChanges(),
      renderApplications(),
      renderAgentsAdmin(),
      renderAllAgents(),
      renderRoutesEditor(),
      renderManualBooking(),
      renderCollectPayment(),
      renderCancellations()
    ]);
  }

  // ---------- shipments tab ----------
  async function renderShipments() {
    const tableContainer = $("shipmentsTable");
    const searchInput = $("searchInput");
    const statusFilter = $("statusFilter");

    const draw = async () => {
      let all;
      try { all = await window.DataStore.getShipments(); }
      catch (e) { tableContainer.innerHTML = `<div class="banner error">${e.message}</div>`; return; }

      const search = searchInput.value.toLowerCase().trim();
      const status = statusFilter.value;

      const filtered = all.filter(s => {
        if (status && s.status !== status) return false;
        if (search) {
          const hay = `${s.tracking_code} ${s.sender.name} ${s.receiver.name} ${s.bus.name}`.toLowerCase();
          if (!hay.includes(search)) return false;
        }
        return true;
      });

      if (filtered.length === 0) {
        tableContainer.innerHTML = `<div class="empty"><p>No shipments match.</p></div>`;
        return;
      }

      tableContainer.innerHTML = `
        <div class="table-wrap"><table>
          <thead><tr>
            <th>Tracking</th><th>Route</th><th>Parties</th><th>Bus</th>
            <th>Value</th><th>Status</th><th></th>
          </tr></thead>
          <tbody>
            ${filtered.map(s => `
              <tr>
                <td><code>${s.tracking_code}</code></td>
                <td>${s.sender.region} → ${s.receiver.region}</td>
                <td>${s.sender.name}<br/><small>→ ${s.receiver.name}</small></td>
                <td>${s.bus.name}</td>
                <td>${window.formatTZS(s.product.value_tzs)}</td>
                <td>
                  <select data-code="${s.tracking_code}" class="status-select">
                    ${STATUSES.map(st => `<option value="${st}" ${st === s.status ? "selected" : ""}>${st}</option>`).join("")}
                  </select>
                </td>
                <td><a href="track.html?code=${encodeURIComponent(s.tracking_code)}" class="btn btn-outline btn-sm">View</a></td>
              </tr>`).join("")}
          </tbody>
        </table></div>`;

      tableContainer.querySelectorAll(".status-select").forEach(sel => {
        sel.addEventListener("change", async (e) => {
          await window.DataStore.updateShipmentStatus(e.target.dataset.code, e.target.value);
          draw();
        });
      });
    };

    searchInput.addEventListener("input", draw);
    statusFilter.addEventListener("change", draw);
    draw();
  }

  // ---------- pending approvals tab ----------

  // PostgREST surfaces "Could not find the 'X' column of 'TABLE' in the
  // schema cache" when an approved payload references a column that no
  // longer exists on the live table (schema drift between when the change
  // was queued and when it's approved). We parse the column name out of
  // the error, strip it from the payload, and retry — repeating until the
  // payload is accepted or every column has been stripped.
  function _extractMissingColumn(errMsg) {
    if (!errMsg) return null;
    // Matches both PostgREST messages we've seen in the wild:
    //   "Could not find the 'foo' column of 'shipments' in the schema cache"
    //   "column shipments.foo does not exist"
    const m1 = /Could not find the '([^']+)' column/i.exec(errMsg);
    if (m1) return m1[1];
    const m2 = /column\s+(?:[a-zA-Z_]+\.)?([a-zA-Z_][a-zA-Z0-9_]*)\s+does not exist/i.exec(errMsg);
    if (m2) return m2[1];
    return null;
  }

  async function _runWithSchemaFallback(opFn, payloadRef, label) {
    // opFn(payload) → { error }. payloadRef is mutated in-place if columns
    // get stripped, so the caller can report what was dropped.
    const stripped = [];
    for (let i = 0; i < 25; i++) {  // hard cap so we can't loop forever
      const { error } = await opFn(payloadRef.payload);
      if (!error) return { stripped };
      const missingCol = _extractMissingColumn(error.message);
      if (!missingCol || !(missingCol in payloadRef.payload)) {
        // Not a schema-drift error, or column isn't in payload — give up.
        throw new Error(error.message);
      }
      delete payloadRef.payload[missingCol];
      stripped.push(missingCol);
      console.warn(`[admin] ${label}: stripped unknown column "${missingCol}" and retrying`);
    }
    throw new Error("Too many schema mismatches — payload could not be applied");
  }

  async function applyPendingChange(id, entityType, action) {
    const { data: change, error: fetchErr } = await sb.from("pending_changes")
      .select("*").eq("id", id).single();
    if (fetchErr) throw new Error(fetchErr.message);

    const session = await window.Auth.getSession();
    const reviewer = session?.user?.email || "admin";

    // Wrap the payload in a ref so the fallback helper can mutate it.
    const ref = { payload: { ...(change.payload || {}) } };
    let result = { stripped: [] };

    if (entityType === "shipment") {
      if (action === "insert") {
        result = await _runWithSchemaFallback(
          (p) => sb.from("shipments").insert(p),
          ref, "shipments.insert");
      } else if (action === "update") {
        result = await _runWithSchemaFallback(
          (p) => sb.from("shipments").update(p).eq("tracking_code", change.entity_id),
          ref, "shipments.update");
      } else if (action === "delete") {
        const { error } = await sb.from("shipments")
          .delete().eq("tracking_code", change.entity_id);
        if (error) throw new Error(error.message);
      }
    } else if (entityType === "bus") {
      if (action === "insert") {
        result = await _runWithSchemaFallback(
          (p) => sb.from("buses").insert(p),
          ref, "buses.insert");
      } else if (action === "update") {
        result = await _runWithSchemaFallback(
          (p) => sb.from("buses").update(p).eq("id", change.entity_id),
          ref, "buses.update");
      } else if (action === "delete") {
        const { error } = await sb.from("buses").delete().eq("id", change.entity_id);
        if (error) throw new Error(error.message);
      }
    } else if (entityType === "agent") {
      if (action === "update") {
        result = await _runWithSchemaFallback(
          (p) => sb.from("agents").update(p).eq("id", change.entity_id),
          ref, "agents.update");
      } else if (action === "delete") {
        const { error } = await sb.from("agents").delete().eq("id", change.entity_id);
        if (error) throw new Error(error.message);
      }
    }

    if (entityType === "bus")   window.DataStore?.invalidateCache(["buses"]);
    if (entityType === "agent") window.DataStore?.invalidateCache(["agents"]);

    const reviewNote = result.stripped.length
      ? `Stripped unknown columns: ${result.stripped.join(", ")}`
      : null;

    const { error: markErr } = await sb.from("pending_changes").update({
      status: "approved",
      reviewed_by: reviewer,
      reviewed_at: new Date().toISOString(),
      ...(reviewNote ? { review_note: reviewNote } : {})
    }).eq("id", id);
    if (markErr) {
      // If `review_note` doesn't exist on pending_changes, retry without it.
      if (_extractMissingColumn(markErr.message) === "review_note") {
        const { error: retryErr } = await sb.from("pending_changes").update({
          status: "approved",
          reviewed_by: reviewer,
          reviewed_at: new Date().toISOString()
        }).eq("id", id);
        if (retryErr) throw new Error(retryErr.message);
      } else {
        throw new Error(markErr.message);
      }
    }

    return result;  // caller can show "Approved (stripped: foo, bar)" if any
  }

  async function renderPendingChanges() {
    const list = $("pendingList");

    const draw = async () => {
      const { data, error } = await sb.from("pending_changes")
        .select("*").order("requested_at", { ascending: false });
      if (error) { list.innerHTML = `<div class="banner error">${error.message}</div>`; return; }

      const pending = (data || []).filter(c => c.status === "pending").length;
      $("pendingBadge").textContent = pending || "";

      if (!data || !data.length) {
        list.innerHTML = `<div class="empty"><p>No pending changes.</p></div>`;
        return;
      }

      list.innerHTML = data.map(c => {
        const p = c.payload || {};
        let summary = `${c.action.toUpperCase()} ${c.entity_type}`;
        let detail = "";

        if (c.entity_type === "shipment" && c.action === "insert") {
          summary = `New shipment: ${p.sender_name} → ${p.receiver_name} &nbsp;|&nbsp; ${p.sender_region} → ${p.receiver_region} &nbsp;|&nbsp; ${p.bus_name}`;
          detail = `
            <details style="margin-top:8px">
              <summary style="cursor:pointer;color:var(--gray);font-size:0.85rem">Full details</summary>
              <div style="margin-top:8px;font-size:0.85rem;line-height:1.8">
                <p><strong>Tracking:</strong> <code>${p.tracking_code || c.entity_id || "—"}</code></p>
                <p><strong>Sender:</strong> ${p.sender_name}, ${p.sender_phone}, ${p.sender_region}</p>
                <p><strong>Receiver:</strong> ${p.receiver_name}, ${p.receiver_phone}, ${p.receiver_region}</p>
                <p><strong>Product:</strong> ${p.product_description}, ${p.product_weight_kg} kg</p>
                <p><strong>Bus:</strong> ${p.bus_name} | ${p.bus_route} | ${p.bus_departure}</p>
                <p><strong>Value:</strong> ${window.formatTZS ? window.formatTZS(p.product_value_tzs || 0) : (p.product_value_tzs || 0) + " TZS"}</p>
                ${p.notes ? `<p><strong>Notes:</strong> ${p.notes}</p>` : ""}
              </div>
            </details>`;
        } else {
          detail = `<pre style="font-size:0.78rem;background:var(--surface);padding:8px;border-radius:4px;overflow-x:auto;margin-top:8px">${JSON.stringify(c.payload, null, 2)}</pre>`;
        }

        return `
          <div class="card application-card status-${c.status}" style="margin-bottom:14px">
            <div class="app-head">
              <h3>
                <span class="pill pill-${c.status === "pending" ? "pending" : c.status === "approved" ? "approved" : "rejected"}">${c.status}</span>
                ${c.entity_type} — ${c.action}
              </h3>
              <small>${new Date(c.requested_at).toLocaleString()}</small>
            </div>
            <p><strong>Requested by:</strong> ${c.requested_by || "—"}</p>
            <p>${summary}</p>
            ${detail}
            ${c.reject_reason ? `<p style="color:var(--danger);margin-top:8px"><strong>Rejection reason:</strong> ${c.reject_reason}</p>` : ""}
            ${c.reviewed_by ? `<p style="font-size:0.82rem;color:var(--gray);margin-top:4px">Reviewed by ${c.reviewed_by} at ${new Date(c.reviewed_at).toLocaleString()}</p>` : ""}
            ${c.status === "pending" ? `
              <div class="contact-actions" style="margin-top:12px">
                <button class="btn btn-primary btn-sm approve-change-btn"
                  data-id="${c.id}" data-type="${c.entity_type}" data-action="${c.action}">
                  ✓ Approve
                </button>
                <button class="btn btn-danger btn-sm reject-change-btn" data-id="${c.id}">
                  ✗ Reject
                </button>
              </div>` : ""}
          </div>`;
      }).join("");

      list.querySelectorAll(".approve-change-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          btn.textContent = "Approving…";
          try {
            const result = await applyPendingChange(
              Number(btn.dataset.id), btn.dataset.type, btn.dataset.action
            );
            if (result?.stripped?.length) {
              alert(
                "Approved, but the live schema is missing these columns:\n  • " +
                result.stripped.join("\n  • ") +
                "\n\nThey were dropped from the payload before applying.\n" +
                "Run the latest schema_master.sql in Supabase to restore them."
              );
            }
            if (btn.dataset.type === "shipment") renderShipments();
          } catch (ex) {
            alert("Approval failed: " + ex.message);
            btn.disabled = false;
            btn.textContent = "✓ Approve";
            return;
          }
          draw();
        });
      });

      list.querySelectorAll(".reject-change-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const reason = prompt("Reason for rejection?");
          if (!reason) return;
          const session = await window.Auth.getSession();
          const reviewer = session?.user?.email || "admin";
          const { error } = await sb.from("pending_changes").update({
            status: "rejected",
            reviewed_by: reviewer,
            reviewed_at: new Date().toISOString(),
            reject_reason: reason
          }).eq("id", Number(btn.dataset.id));
          if (error) { alert(error.message); return; }
          draw();
        });
      });
    };

    draw();
  }

  // ---------- applications tab ----------
  async function renderApplications() {
    const list = $("applicationsList");
    const draw = async () => {
      const { data, error } = await sb.from("agent_applications")
        .select("*").order("created_at", { ascending: false });
      if (error) { list.innerHTML = `<div class="banner error">${error.message}</div>`; return; }

      const pending = data.filter(a => a.status === "pending").length;
      $("appBadge").textContent = pending ? pending : "";

      if (!data.length) { list.innerHTML = `<div class="empty"><p>No applications yet.</p></div>`; return; }

      const bucket = (window.APP_CONFIG && window.APP_CONFIG.AGENT_PHOTOS_BUCKET) || "agent-photos";
      list.innerHTML = data.map(a => {
        const photoUrl = a.photo_path
          ? sb.storage.from(bucket).getPublicUrl(a.photo_path).data.publicUrl
          : "";
        return `
        <div class="card application-card status-${a.status}">
          <div class="app-head" style="display:flex;align-items:flex-start;gap:14px">
            ${photoUrl
              ? `<img src="${photoUrl}" alt="${a.full_name}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;flex-shrink:0;border:2px solid var(--border)">`
              : `<div style="width:56px;height:56px;border-radius:50%;background:var(--green-light);display:flex;align-items:center;justify-content:center;font-size:1.4rem;font-weight:700;color:var(--green-dark);flex-shrink:0">${(a.full_name||"?")[0].toUpperCase()}</div>`}
            <div style="flex:1;min-width:0">
              <h3 style="margin:0 0 2px">${a.full_name} <span class="pill pill-${a.status}">${a.status}</span></h3>
              <small>${new Date(a.created_at).toLocaleString()}</small>
            </div>
          </div>
          <p style="margin-top:10px">
            <strong>Phone:</strong> ${a.phone || "-"}
            ${a.phone ? window.DataStore.renderCallButtons(a.phone) : ""}
            &nbsp; <strong>Email:</strong> ${a.email || "-"}
          </p>
          <p><strong>Region:</strong> ${a.region} &nbsp; <strong>Terminal:</strong> ${a.terminal}</p>
          <p><strong>Buses:</strong> ${(a.buses || []).join(", ")}</p>
          <p><strong>Experience:</strong> ${a.experience_years} year(s) &nbsp; <strong>National ID:</strong> ${a.national_id}</p>
          ${a.about ? `<p><strong>About:</strong> ${a.about}</p>` : ""}
          ${a.reject_reason ? `<p><strong>Reject reason:</strong> ${a.reject_reason}</p>` : ""}
          ${a.status === "pending" ? `
            <div class="contact-actions">
              <button class="btn btn-primary btn-sm approve-btn" data-id="${a.id}">Approve</button>
              <button class="btn btn-danger btn-sm reject-btn" data-id="${a.id}">Reject</button>
            </div>` : ""}
        </div>`;
      }).join("");

      list.querySelectorAll(".approve-btn").forEach(b => b.addEventListener("click", () => {
        const card = b.closest(".application-card");
        // Remove any existing approval panel in this card
        card.querySelectorAll(".approve-panel").forEach(p => p.remove());

        const panel = document.createElement("div");
        panel.className = "approve-panel";
        panel.style.cssText = "margin-top:12px;padding:14px 16px;background:#f0fdf4;border:1.5px solid #86efac;border-radius:12px";
        panel.innerHTML = `
          <p style="font-weight:700;font-size:0.88rem;margin:0 0 10px;color:#065f46">Initial agent rating (required)</p>
          <div class="star-rating" style="display:flex;gap:6px;margin-bottom:12px" role="radiogroup" aria-label="Rating">
            ${[1,2,3,4,5].map(n => `
              <label style="cursor:pointer;font-size:1.8rem;line-height:1" title="${n} star${n>1?'s':''}">
                <input type="radio" name="init-rating-${b.dataset.id}" value="${n}" style="display:none">
                <span class="star" data-v="${n}" style="color:#d1d5db;transition:color 0.1s">★</span>
              </label>`).join("")}
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary btn-sm confirm-approve" disabled style="min-width:120px">Approve &amp; Save</button>
            <button class="btn btn-outline btn-sm cancel-approve">Cancel</button>
          </div>
          <div class="approve-err" style="color:var(--danger);font-size:0.8rem;margin-top:6px;min-height:16px"></div>`;
        card.appendChild(panel);

        // Star interaction
        const stars = panel.querySelectorAll(".star");
        const confirmBtn = panel.querySelector(".confirm-approve");
        let chosen = 0;
        panel.querySelectorAll("input[type=radio]").forEach(radio => {
          radio.addEventListener("change", () => {
            chosen = Number(radio.value);
            stars.forEach(s => {
              s.style.color = Number(s.dataset.v) <= chosen ? "#f59e0b" : "#d1d5db";
            });
            confirmBtn.disabled = false;
          });
        });
        // Hover highlight
        stars.forEach(s => {
          s.addEventListener("mouseenter", () => {
            stars.forEach(ss => {
              ss.style.color = Number(ss.dataset.v) <= Number(s.dataset.v) ? "#fbbf24" : "#d1d5db";
            });
          });
          s.addEventListener("mouseleave", () => {
            stars.forEach(ss => {
              ss.style.color = Number(ss.dataset.v) <= chosen ? "#f59e0b" : "#d1d5db";
            });
          });
        });

        panel.querySelector(".cancel-approve").addEventListener("click", () => panel.remove());

        confirmBtn.addEventListener("click", async () => {
          if (!chosen) return;
          confirmBtn.disabled = true; confirmBtn.textContent = "Approving…";
          const { error } = await sb.rpc("approve_agent_application", {
            p_app_id: Number(b.dataset.id),
            p_initial_rating: chosen
          });
          if (error) {
            panel.querySelector(".approve-err").textContent = error.message;
            confirmBtn.disabled = false; confirmBtn.textContent = "Approve & Save";
          } else {
            draw();
            renderAgentsAdmin();
          }
        });
      }));
      list.querySelectorAll(".reject-btn").forEach(b => b.addEventListener("click", async () => {
        const reason = prompt("Reason for rejection?");
        if (!reason) return;
        const { error } = await sb.rpc("reject_agent_application", { p_app_id: Number(b.dataset.id), p_reason: reason });
        if (error) alert(error.message);
        draw();
      }));
    };
    draw();
  }

  // ---------- agents admin tab ----------
  async function renderAgentsAdmin() {
    const list = $("agentsAdminList");
    // Agents + their original applications (so we can show BOTH the moment they
    // applied and the moment they were approved/registered). Matching is by phone.
    const [agRes, appRes] = await Promise.all([
      sb.from("agents").select("*").order("created_at", { ascending: false }),
      sb.from("agent_applications").select("full_name,phone,phones,status,created_at"),
    ]);
    const { data, error } = agRes;
    if (error) { list.innerHTML = `<div class="banner error">${error.message}</div>`; return; }
    if (!data.length) { list.innerHTML = `<div class="empty"><p>No agents.</p></div>`; return; }

    // Map every application phone → earliest submission date for that person.
    const appByPhone = new Map();
    const apps = (appRes && Array.isArray(appRes.data)) ? appRes.data : [];
    apps.forEach((ap) => {
      [ap.phone, ...(ap.phones || [])].filter(Boolean).forEach((p) => {
        const k = _aaNormPhone(p);
        if (!k) return;
        const prev = appByPhone.get(k);
        if (!prev || new Date(ap.created_at) < new Date(prev)) appByPhone.set(k, ap.created_at);
      });
    });
    const appliedAt = (a) => {
      for (const p of [a.phone, ...(a.phones || [])].filter(Boolean)) {
        const hit = appByPhone.get(_aaNormPhone(p));
        if (hit) return hit;
      }
      return null;
    };

    // Exact moment (date · time · year) for both timestamps.
    const fmtWhen = (iso) => {
      if (!iso) return "—";
      const d = new Date(iso);
      if (isNaN(d)) return "—";
      return d.toLocaleString(undefined, {
        year: "numeric", month: "short", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
    };
    list.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>ID</th><th>Name</th><th>Region</th><th>Phone</th><th>Buses</th><th>Exp</th><th>Rating</th><th>Verified</th><th>Applied on</th><th>Registered on</th></tr></thead>
        <tbody>
          ${data.map(a => `
            <tr>
              <td><code>${a.id}</code></td>
              <td>${a.name}</td>
              <td>${a.region}</td>
              <td>${a.phone || "-"} ${a.phone ? window.DataStore.renderCallButtons(a.phone) : ""}</td>
              <td>${(a.buses || []).join(", ")}</td>
              <td>${a.experience_years || 0}y</td>
              <td>${(Number(a.rating_avg) || 0).toFixed(2)} (${a.rating_count || 0})</td>
              <td>${a.verified ? "✓" : "—"}</td>
              <td>${fmtWhen(appliedAt(a))}</td>
              <td>${fmtWhen(a.created_at)}</td>
            </tr>`).join("")}
        </tbody>
      </table></div>`;
  }

  // ---------- All Agents tab — unified monetization tracker ----------
  // Aggregates every "agent" on the platform into one de-duplicated list:
  //   • bus / cargo agents          → public.agents (one row per agent)
  //   • house-listing agents        → derived from public.houses (agent jsonb)
  //   • truck owners                → derived from public.trucks (owner jsonb)
  // House/truck agents aren't a registered entity — they live embedded on
  // their listings — so we group them by account (owner_user_id) or phone and
  // take their EARLIEST listing date as "registered". One person who lists
  // both houses and trucks (and/or is a bus agent) collapses into a single
  // agent carrying multiple role tags.
  let _aaUnified = null;          // cached unified list so controls don't refetch
  let _aaTotals  = null;
  let _aaBillingMissing = false;  // true when the agent_billing table isn't applied yet
  let _aaByKey = new Map();        // agent_key -> unified agent (for billing saves)
  const AA_BILLING_STATUSES = ["free", "trial", "paid", "overdue", "cancelled"];
  // Standard monthly subscription every agent is expected to pay. "Pay +1 month"
  // uses this when the agent has no custom amount set yet.
  const AA_MONTHLY_FEE = (window.APP_CONFIG && window.APP_CONFIG.AGENT_MONTHLY_FEE_TZS) || 10000;
  // Subscription state from a billing row (mirrors the SQL auto-suspend rule).
  function _aaSubInfo(b) {
    b = b || {};
    const status = b.status || "free";
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const pu = b.paid_until ? new Date(String(b.paid_until).slice(0, 10) + "T00:00:00") : null;
    if (status === "cancelled") return { label: "Suspended (cancelled)", cls: "sub-exp" };
    if (status === "overdue")   return { label: "Suspended (overdue)",   cls: "sub-exp" };
    if (pu) {
      const days = Math.round((pu - today) / 86400000);
      if (days < 0)  return { label: `Expired ${-days}d ago`, cls: "sub-exp" };
      if (status === "paid" || status === "trial")
        return { label: `Active · ${days}d left`, cls: days <= 5 ? "sub-due" : "sub-ok" };
      return { label: `Until ${String(b.paid_until).slice(0, 10)}`, cls: "sub-ok" };
    }
    if (status === "paid") return { label: "Active (no expiry)", cls: "sub-ok" };
    return { label: "Not enrolled", cls: "sub-none" };
  }
  // Record one month's subscription: paid, +1 month from today (or extend from a
  // still-active expiry), at the standard fee unless a custom amount is set.
  function _aaPayMonth(key) {
    const u = _aaByKey.get(key);
    const b = (u && u.billing) || {};
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const pu = b.paid_until ? new Date(String(b.paid_until).slice(0, 10) + "T00:00:00") : null;
    const base = (pu && pu > today) ? pu : today;     // extend if still active, else start today
    const next = new Date(base); next.setMonth(next.getMonth() + 1);
    const amount = Number(b.amount_tzs) > 0 ? Number(b.amount_tzs) : AA_MONTHLY_FEE;
    _aaSaveBilling(key, { status: "paid", amount_tzs: amount, paid_until: next.toISOString().slice(0, 10) })
      .then(() => _aaDraw());
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
    const [agRes, hRes, tRes, bRes] = await Promise.allSettled([
      sb.from("agents").select("id,name,phone,email,region,buses,experience_years,rating_avg,rating_count,verified,created_at"),
      sb.from("houses").select("id,agent,owner_user_id,region,verified,created_at"),
      sb.from("trucks").select("id,owner,owner_user_id,region,verified,created_at"),
      sb.from("agent_billing").select("*"),
    ]);
    const busAgents = agRes.status === "fulfilled" && Array.isArray(agRes.value.data) ? agRes.value.data : [];
    const houses    = hRes.status  === "fulfilled" && Array.isArray(hRes.value.data)  ? hRes.value.data  : [];
    const trucks    = tRes.status  === "fulfilled" && Array.isArray(tRes.value.data)  ? tRes.value.data  : [];
    // Billing table may not be applied yet — degrade to "everyone free".
    _aaBillingMissing = !(bRes.status === "fulfilled" && !bRes.value.error);
    const billingRows = (bRes.status === "fulfilled" && Array.isArray(bRes.value.data)) ? bRes.value.data : [];
    const billingMap = new Map(billingRows.map((b) => [b.agent_key, b]));

    const map = new Map();
    const get = (key) => {
      let u = map.get(key);
      if (!u) {
        u = { key, name: "", phone: "", email: "", regions: new Set(), roles: new Set(),
              busCount: 0, houseCount: 0, truckCount: 0, registered: null, verified: false,
              experience: null, rating: null };
        map.set(key, u);
      }
      return u;
    };

    busAgents.forEach((a) => {
      const u = get(_aaIdentity(null, a.phone, a.name));
      if (a.name && !u.name) u.name = a.name;
      if (a.phone && !u.phone) u.phone = a.phone;
      if (a.email && !u.email) u.email = a.email;
      if (a.region) u.regions.add(a.region);
      u.roles.add("bus"); u.busCount += 1;
      u.experience = a.experience_years;
      u.rating = a.rating_avg;
      if (a.verified) u.verified = true;
      u.registered = _aaEarlier(u.registered, a.created_at);
    });

    houses.forEach((h) => {
      const ag = h.agent || {};
      const u = get(_aaIdentity(h.owner_user_id, ag.phone, ag.name));
      if (ag.name && (!u.name || u.name === "Agent")) u.name = ag.name;
      if (ag.phone && !u.phone) u.phone = ag.phone;
      if (h.region) u.regions.add(h.region);
      u.roles.add("house"); u.houseCount += 1;
      if (h.verified) u.verified = true;
      u.registered = _aaEarlier(u.registered, h.created_at);
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

    _aaUnified = Array.from(map.values()).map((u) => ({
      ...u, regions: Array.from(u.regions), roles: Array.from(u.roles),
      billing: billingMap.get(u.key) || { status: "free", plan: "", amount_tzs: 0, paid_until: null },
    }));
    _aaByKey = new Map(_aaUnified.map((u) => [u.key, u]));
    _aaTotals = {
      houseListings: houses.length,
      truckListings: trucks.length,
    };

    _aaRenderSummary();
    _aaDraw();
  }

  // Summary cards — recomputed whenever billing changes so the paying/revenue
  // figures stay live without a refetch.
  function _aaRenderSummary() {
    if (!_aaUnified) return;
    const isPaying = (u) => u.billing && u.billing.status === "paid";
    const totals = {
      total: _aaUnified.length,
      paying: _aaUnified.filter(isPaying).length,
      revenue: _aaUnified.filter(isPaying).reduce((s, u) => s + (Number(u.billing.amount_tzs) || 0), 0),
      bus:   _aaUnified.filter((u) => u.roles.includes("bus")).length,
      house: _aaUnified.filter((u) => u.roles.includes("house")).length,
      truck: _aaUnified.filter((u) => u.roles.includes("truck")).length,
    };

    const badge = $("allAgentsBadge");
    if (badge) badge.textContent = totals.total ? String(totals.total) : "";

    const sum = $("aaSummary");
    if (sum) {
      sum.innerHTML = [
        ["Total agents", totals.total, ""],
        ["Paying",       totals.paying, "pay"],
        ["Revenue (paid)", window.formatTZS(totals.revenue), "rev"],
        ["Bus / cargo",  totals.bus, ""],
        ["House agents", totals.house, ""],
        ["Truck owners", totals.truck, ""],
      ].map(([lbl, num, cls]) => `<div class="aa-stat ${cls}"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`).join("");
    }

    const note = $("aaBillingNote");
    if (note) {
      note.hidden = !_aaBillingMissing;
      if (_aaBillingMissing) note.textContent = "Billing not saved yet: run supabase/agent_billing.sql in Supabase to enable paid-status tracking. (Showing everyone as Free for now.)";
    }

    _aaRenderBreakdown();
  }

  // Paid-vs-unpaid + amount collected, broken down by category (bus agents /
  // house owners / truck owners) with a true unique overall total.
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
    const bus = cat("bus"), house = cat("house"), truck = cat("truck");
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
          <th>Category</th><th>Total</th><th>Paid</th><th>Unpaid</th><th>Collected (TZS)</th>
        </tr></thead>
        <tbody>
          ${row("Bus / cargo agents", bus)}
          ${row("House owners", house)}
          ${row("Truck owners", truck)}
          ${row("Overall (unique people)", overall, "aa-bd-total")}
        </tbody>
      </table>
      <p class="hint" style="margin:6px 0 0;">Someone listed in more than one category is counted once per category here, but only once in the Overall row — so the Overall total can be lower than the categories added up. Use the Billing filter below to list everyone Paid or Unpaid by name.</p>`;
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
        if (bill === "unpaid") { if (st === "paid") return false; }
        else if (st !== bill) return false;
      }
      if (q) {
        const hay = `${u.name} ${u.phone} ${u.regions.join(" ")} ${u.email}`.toLowerCase();
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

    const roleTags = (u) => u.roles.map((r) =>
      `<span class="aa-role-tag ${r}">${r === "bus" ? "Bus" : r === "house" ? "House" : "Truck"}</span>`).join("");
    const statusSel = (b) => `<select class="aa-bill-input aa-bill-status" data-field="status">${
      AA_BILLING_STATUSES.map((s) => `<option value="${s}" ${(b.status || "free") === s ? "selected" : ""}>${s}</option>`).join("")
    }</select>`;

    list.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Name</th><th>Roles</th><th>Phone</th><th>Region(s)</th>
          <th>Houses</th><th>Trucks</th><th>Buses</th><th>Verified</th><th>Registered</th>
          <th>Billing</th><th>Plan</th><th>Amount (TZS)</th><th>Paid until</th>
          <th>Subscription</th>
        </tr></thead>
        <tbody>
          ${rows.map((u) => {
            const b = u.billing || {};
            return `
            <tr data-key="${_aaEscHtml(u.key)}" class="aa-bill-${b.status || "free"}">
              <td>${u.name ? _aaEscHtml(u.name) : "<em>Unnamed</em>"}</td>
              <td>${roleTags(u)}</td>
              <td>${u.phone ? _aaEscHtml(u.phone) : "—"} ${u.phone ? window.DataStore.renderCallButtons(u.phone) : ""}</td>
              <td>${u.regions.map(_aaEscHtml).join(", ") || "—"}</td>
              <td>${u.houseCount || "—"}</td>
              <td>${u.truckCount || "—"}</td>
              <td>${u.busCount || "—"}</td>
              <td>${u.verified ? "✓" : "—"}</td>
              <td>${u.registered ? new Date(u.registered).toLocaleString() : "—"}
                  <span class="aa-reg-rel">${_aaRelTime(u.registered)}</span></td>
              <td>${statusSel(b)}</td>
              <td><input class="aa-bill-input" data-field="plan" type="text" value="${_aaEscHtml(b.plan || "")}" placeholder="—" style="width:78px"></td>
              <td><input class="aa-bill-input" data-field="amount_tzs" type="number" min="0" value="${Number(b.amount_tzs) || 0}" style="width:90px"></td>
              <td><input class="aa-bill-input" data-field="paid_until" type="date" value="${b.paid_until ? String(b.paid_until).slice(0, 10) : ""}"></td>
              <td class="aa-sub-cell">${(() => { const s = _aaSubInfo(b); return `<span class="aa-sub ${s.cls}">${s.label}</span>`; })()}
                  <button type="button" class="aa-pay-btn" data-key="${_aaEscHtml(u.key)}" title="Record one month's subscription (${window.formatTZS(AA_MONTHLY_FEE)})">+1 month</button></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table></div>`;

    // "Pay +1 month" — record a month's subscription for that agent.
    list.querySelectorAll(".aa-pay-btn").forEach((btn) => {
      btn.addEventListener("click", () => _aaPayMonth(btn.getAttribute("data-key")));
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
        };
        _aaSaveBilling(key, patch);
      });
    });
  }

  async function _aaSaveBilling(key, patch) {
    if (_aaBillingMissing) {
      alert("Billing isn't enabled yet. Run supabase/agent_billing.sql in your Supabase SQL editor, then reload this tab.");
      return;
    }
    const u = _aaByKey.get(key);
    let email = null;
    try { const s = await window.Auth.getSession(); email = s?.user?.email || null; } catch (_) {}
    const payload = { agent_key: key, name: u ? u.name : null, phone: u ? u.phone : null, updated_by: email, ...patch };
    const { error } = await sb.from("agent_billing").upsert(payload, { onConflict: "agent_key" });
    if (error) { alert("Billing save failed: " + error.message); return; }
    if (u) { u.billing = { ...u.billing, ...patch }; }
    _aaRenderSummary();
    // If a billing filter is active the row may need to drop out — redraw.
    if ($("aaBilling")?.value) _aaDraw();
  }

  function _aaExportCsv() {
    if (!_aaUnified || !_aaUnified.length) { alert("No agents to export yet."); return; }
    const esc = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["Name", "Phone", "Email", "Roles", "Regions", "House listings", "Truck listings", "Bus records", "Verified", "Registered (ISO)", "Registered (local)", "Billing status", "Plan", "Amount (TZS)", "Paid until"];
    const lines = _aaUnified
      .slice()
      .sort((a, b) => (new Date(b.registered || 0)) - (new Date(a.registered || 0)))
      .map((u) => {
        const b = u.billing || {};
        return [
          u.name, u.phone, u.email, u.roles.join("|"), u.regions.join("|"),
          u.houseCount, u.truckCount, u.busCount, u.verified ? "yes" : "no",
          u.registered || "", u.registered ? new Date(u.registered).toLocaleString() : "",
          b.status || "free", b.plan || "", Number(b.amount_tzs) || 0, b.paid_until || "",
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

  // ---------- routes editor ----------
  async function renderRoutesEditor() {
    const [buses, regions] = await Promise.all([
      window.DataStore.getBuses(),
      window.DataStore.getRegions()
    ]);
    const busSel = $("routeBus");
    busSel.innerHTML = `<option value="">— select bus —</option>` +
      buses.map(b => `<option value="${b.id}">${b.name}</option>`).join("");
    // Populate datalist for autocomplete — user can also type a region that doesn't exist yet
    $("routeRegionList").innerHTML = regions.map(r => `<option value="${r}"></option>`).join("");

    // ── Register new bus ──────────────────────────────────
    $("newBusPhoto")?.addEventListener("change", () => {
      const file = $("newBusPhoto").files[0];
      const wrap = $("newBusPhotoPreviewWrap");
      const img  = $("newBusPhotoPreview");
      if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => { img.src = ev.target.result; wrap.style.display = "block"; };
        reader.readAsDataURL(file);
      } else {
        wrap.style.display = "none";
      }
    });

    // Auto-fill prefix as admin types the bus name
    $("newBusName").addEventListener("input", () => {
      const pfx = $("newBusPrefix");
      if (!pfx.dataset.edited) {
        pfx.value = $("newBusName").value.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 4);
      }
    });
    $("newBusPrefix").addEventListener("input", () => {
      $("newBusPrefix").value = $("newBusPrefix").value.toUpperCase().replace(/[^A-Z]/g, "");
      $("newBusPrefix").dataset.edited = "1";
    });

    $("newBusForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name    = $("newBusName").value.trim();
      const contact = $("newBusContact").value.trim();
      const prefix  = $("newBusPrefix").value.trim().toUpperCase() || null;
      if (!name || !contact) return;
      if (prefix && (prefix.length < 2 || prefix.length > 5)) {
        const msg = $("newBusMsg");
        msg.hidden = false; msg.className = "banner error";
        msg.textContent = "Ticket prefix must be 2–5 letters."; return;
      }
      const msg = $("newBusMsg");
      msg.hidden = true;

      let photo_path = null;
      const photoFile = $("newBusPhoto")?.files[0];
      if (photoFile && photoFile.size > 0) {
        const safe = name.toLowerCase().replace(/[^a-z0-9]/g, "_");
        const ext  = (photoFile.name.split(".").pop() || "jpg").toLowerCase();
        photo_path = `bus_${safe}_${Date.now()}.${ext}`;
        const { error: upErr } = await sb.storage.from("bus-photos").upload(photo_path, photoFile, {
          contentType: photoFile.type || "image/jpeg",
          upsert: true
        });
        if (upErr) {
          msg.hidden = false; msg.className = "banner error";
          msg.textContent = "Photo upload failed: " + upErr.message;
          return;
        }
      }

      // `buses.id` is text NOT NULL with no DB default — existing rows use
      // the BUS### convention (BUS001, BUS002, …). Re-fetch live IDs so we
      // don't collide with rows added since the page loaded.
      const { data: existing, error: idErr } = await sb
        .from("buses").select("id");
      if (idErr) {
        msg.hidden = false; msg.className = "banner error";
        msg.textContent = "Could not allocate bus ID: " + idErr.message;
        return;
      }
      const maxN = (existing || [])
        .map(b => /^BUS(\d+)$/i.exec(b.id || ""))
        .filter(Boolean)
        .reduce((m, x) => Math.max(m, parseInt(x[1], 10)), 0);
      const newId = "BUS" + String(maxN + 1).padStart(3, "0");

      const { error } = await sb.from("buses").insert({
        id: newId, name, contact, routes: [], photo_path, ticket_prefix: prefix
      });
      if (error) {
        msg.hidden = false; msg.className = "banner error"; msg.textContent = error.message;
        return;
      }
      window.DataStore?.invalidateCache(["buses"]);
      msg.hidden = false; msg.className = "banner success";
      msg.textContent = `"${name}" registered — reloading…`;
      setTimeout(() => location.reload(), 900);
    });

    const drawExisting = () => {
      const html = buses.map(b => `
        <details class="card" style="margin-bottom:8px">
          <summary><strong>${b.name}</strong> — ${(b.routes || []).length} legs</summary>
          <ul style="margin-left:18px;margin-top:8px">
            ${(b.routes || []).map(r => `
              <li>
                ${r.from} → ${r.to}
                <small style="color:var(--gray)">(${r.departure}, ~${r.duration_hours}h)</small>
                <button class="btn btn-danger btn-sm remove-leg" data-bus="${b.id}" data-from="${r.from}" data-to="${r.to}">Remove pair</button>
              </li>`).join("")}
          </ul>
        </details>`).join("");
      $("existingRoutes").innerHTML = html || "<p>No routes yet.</p>";
      $("existingRoutes").querySelectorAll(".remove-leg").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!confirm(`Remove ${btn.dataset.from} ↔ ${btn.dataset.to} from this bus?`)) return;
          const { data: busRow, error: fetchErr } = await sb
            .from("buses").select("routes").eq("id", btn.dataset.bus).single();
          if (fetchErr) return alert(fetchErr.message);
          const filtered = (busRow.routes || []).filter(
            r => !(r.from === btn.dataset.from && r.to === btn.dataset.to) &&
                 !(r.from === btn.dataset.to   && r.to === btn.dataset.from)
          );
          const { error } = await sb.from("buses").update({ routes: filtered }).eq("id", btn.dataset.bus);
          if (error) return alert(error.message);
          window.DataStore?.invalidateCache(["buses"]);
          location.reload();
        });
      });
    };
    drawExisting();

    // ── Seat structure editor ──────────────────────────────
    const seBusSel = $("seBus");
    seBusSel.innerHTML = `<option value="">— select bus —</option>` +
      buses.map(b => `<option value="${b.id}">${b.name}</option>`).join("");

    $("seLoadBtn").addEventListener("click", () => {
      const bus = buses.find(b => b.id === seBusSel.value);
      if (!bus) { alert("Select a bus first."); return; }
      renderSeatEditor(bus);
    });

    function renderSeatEditor(bus) {
      const wrap = $("seatEditorWrap");
      if (!window.renderSeatCanvasEditor) {
        wrap.innerHTML = '<div class="banner error">Seat editor module not loaded. Ensure seat-canvas-editor.js is included.</div>';
        wrap.hidden = false;
        return;
      }
      window.renderSeatCanvasEditor(wrap, bus, sb);
    }


    $("routeForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $("routeMsg");
      msg.hidden = true;

      const busId  = busSel.value;
      const from   = $("routeFrom").value.trim();
      const to     = $("routeTo").value.trim();
      const dep    = $("routeDep").value;
      const retDep = $("routeRet").value;
      const dur    = Number($("routeDur").value);

      if (!busId || !from || !to) {
        msg.hidden = false; msg.className = "banner error";
        msg.textContent = "Please select a bus and fill in both region fields.";
        return;
      }

      // Fetch current routes then append forward + return legs
      const { data: busRow, error: fetchErr } = await sb
        .from("buses").select("routes").eq("id", busId).single();
      if (fetchErr) {
        msg.hidden = false; msg.className = "banner error"; msg.textContent = fetchErr.message;
        return;
      }
      const routes = Array.isArray(busRow.routes) ? [...busRow.routes] : [];
      routes.push({ from, to, departure: dep, duration_hours: dur });
      routes.push({ from: to, to: from, departure: retDep, duration_hours: dur });

      const { error } = await sb.from("buses").update({ routes }).eq("id", busId);
      if (error) { msg.hidden = false; msg.className = "banner error"; msg.textContent = error.message; return; }
      window.DataStore?.invalidateCache(["buses"]);
      msg.hidden = false; msg.className = "banner success";
      msg.textContent = "Route + return leg added.";
      setTimeout(() => location.reload(), 800);
    });
  }

  // ---------- manual booking ----------
  async function renderManualBooking() {
    const buses   = await window.DataStore.getBuses();
    const mbBus   = $("mbBus");
    const mbRoute = $("mbRoute");
    const mbDate  = $("mbDate");

    mbBus.innerHTML = `<option value="">— select bus —</option>` +
      buses.map(b => `<option value="${b.id}">${b.name}</option>`).join("");

    mbDate.min   = new Date().toISOString().split("T")[0];
    mbDate.value = new Date().toISOString().split("T")[0];

    mbBus.addEventListener("change", () => {
      const bus = buses.find(b => b.id === mbBus.value);
      mbRoute.disabled = !bus;
      mbRoute.innerHTML = `<option value="">— select route —</option>`;
      if (bus?.routes) {
        const seen = new Set();
        bus.routes.forEach(r => {
          const key = `${r.departure}|${r.from}|${r.to}`;
          if (!seen.has(key)) { seen.add(key); mbRoute.innerHTML += `<option value="${key}">${r.from} → ${r.to} (${r.departure})</option>`; }
        });
      }
      $("mbSeatSection").hidden = true;
    });

    let currentBus = null;
    let selectedSeat = null;

    $("mbLoadSeats").addEventListener("click", async () => {
      const busId    = mbBus.value;
      const routeVal = mbRoute.value;
      const date     = mbDate.value;
      if (!busId || !routeVal || !date) { alert("Select bus, route, and date first."); return; }
      const [dep] = routeVal.split("|");
      currentBus = buses.find(b => b.id === busId);
      const seatsTotal = currentBus?.seats_total || 50;
      const seatNames  = currentBus?.seat_names  || {};

      const { data: taken } = await sb.from("bookings")
        .select("seat_number").eq("bus_id", busId).eq("travel_date", date).eq("departure_time", dep)
        .not("status", "in", '("cancelled","expired")');
      const takenSet = new Set((taken || []).map(t => t.seat_number));
      selectedSeat = null;

      function renderMap() {
        const map = $("mbSeatMap");
        map.innerHTML = "";
        for (let s = 1; s <= seatsTotal; s++) {
          const isTaken    = takenSet.has(s);
          const isSelected = s === selectedSeat;
          const label      = seatNames[s] || s;
          const btn = document.createElement("button");
          btn.type = "button"; btn.textContent = label; btn.title = `Seat ${s}`; btn.disabled = isTaken;
          btn.style.cssText = `min-width:40px;padding:6px 8px;border-radius:7px;font-size:0.8rem;font-weight:600;` +
            `border:2px solid ${isSelected?"var(--green)":isTaken?"#ccc":"#b8d8b8"};` +
            `background:${isSelected?"var(--green)":isTaken?"#f0f0f0":"#e8f5e8"};` +
            `color:${isSelected?"#fff":isTaken?"#999":"#1a5a30"};cursor:${isTaken?"not-allowed":"pointer"};`;
          btn.addEventListener("click", () => { selectedSeat = s; renderMap(); });
          map.appendChild(btn);
        }
      }
      renderMap();
      $("mbSeatSection").hidden = false;
    });

    $("mbSubmit").addEventListener("click", async () => {
      const busId    = mbBus.value;
      const routeVal = mbRoute.value;
      const date     = mbDate.value;
      const name     = $("mbName").value.trim();
      const phone    = $("mbPhone").value.trim();
      const whatsapp = $("mbWhatsApp").value.trim();
      const fare     = Number($("mbFare").value);
      const idNo     = $("mbIdNo").value.trim();
      const msg      = $("mbMsg");
      msg.hidden = true;

      if (!selectedSeat)   { msg.hidden=false; msg.className="banner error"; msg.textContent="Select a seat."; return; }
      if (!name)           { msg.hidden=false; msg.className="banner error"; msg.textContent="Passenger name required."; return; }
      if (!phone)          { msg.hidden=false; msg.className="banner error"; msg.textContent="Phone number required."; return; }
      if (!fare || fare<1) { msg.hidden=false; msg.className="banner error"; msg.textContent="Enter a valid fare."; return; }

      const [dep, from, to] = routeVal.split("|");

      const submitBtn = $("mbSubmit");
      submitBtn.disabled = true; submitBtn.textContent = "Processing…";

      const { data: claimed, error: bookErr } = await sb.rpc("claim_ticket", {
        p_bus_id:          busId,
        p_seat_number:     selectedSeat,
        p_travel_date:     date,
        p_departure_time:  dep,
        p_origin:          from,
        p_destination:     to,
        p_passenger_name:  name,
        p_passenger_phone: phone,
        p_passenger_id_no: idNo || null,
        p_fare_tzs:        fare,
        p_trip_purpose:    "manual",
        p_return_duration: "one-way"
      });
      if (bookErr) {
        submitBtn.disabled = false; submitBtn.textContent = "Confirm & send SMS ticket";
        msg.hidden=false; msg.className="banner error"; msg.textContent=bookErr.message; return;
      }
      const ticketCode = claimed.ticket_code;

      // Completed cash payment → DB trigger confirms booking + n8n sends SMS
      const { error: payErr } = await sb.from("payments").insert({
        reference: ticketCode, reference_type: "booking", amount_tzs: fare,
        customer_name: name, customer_phone: phone,
        method: "cash", provider: "manual", status: "completed", paid_at: new Date().toISOString()
      });

      submitBtn.disabled = false; submitBtn.textContent = "Confirm & send SMS ticket";
      if (payErr) {
        msg.hidden=false; msg.className="banner error";
        msg.textContent=`Booking created but payment record failed: ${payErr.message}`; return;
      }

      msg.hidden=false; msg.className="banner success";
      msg.textContent=`Booked! Ticket ${ticketCode} — SMS sent to ${phone}.`;

      // WhatsApp deep-link with ticket details + bus photo
      const post = $("mbPostBooking");
      if (whatsapp) {
        const waNum  = whatsapp.replace(/\D/g, "");
        const photoUrl = window.DataStore.busPhotoUrl(currentBus?.photo_path);
        const text = encodeURIComponent(
          `Habari! Tiketi yako — ${currentBus.name}\n` +
          `Ticket: ${ticketCode}\n` +
          `Safari: ${from} → ${to}\n` +
          `Tarehe: ${date}  Saa: ${dep}\n` +
          `Kiti: ${selectedSeat}\n` +
          `Nauli: TZS ${fare.toLocaleString()}\n` +
          (photoUrl ? `\nPicha ya huduma zetu: ${photoUrl}` : "")
        );
        post.hidden = false;
        post.innerHTML = `
          <a href="https://wa.me/${waNum}?text=${text}" target="_blank" rel="noopener"
             class="btn btn-primary" style="background:#25D366;border-color:#25D366;">
            Send on WhatsApp
          </a>
          <span style="font-size:0.82rem;color:#666;">Opens WhatsApp with ticket details + bus photo link</span>`;
      } else {
        post.hidden = true;
      }
      selectedSeat = null;
    });
  }

  // ---------- collect payment ----------
  function renderCollectPayment() {
    const codeEl   = $("cpAdminCode");
    const searchBtn= $("cpAdminSearchBtn");
    const resultEl = $("cpAdminResult");
    if (!codeEl || !searchBtn || !resultEl) return;

    codeEl.addEventListener("input", () => { codeEl.value = codeEl.value.toUpperCase(); });
    codeEl.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
    searchBtn.addEventListener("click", doSearch);

    async function doSearch() {
      const code = codeEl.value.trim().toUpperCase();
      if (!code) return;
      resultEl.innerHTML = `<p style="color:var(--gray);font-size:0.9rem">Searching…</p>`;

      const { data: bk, error } = await sb.from("bookings")
        .select("ticket_code,bus_name,origin,destination,travel_date,departure_time,seat_number,passenger_name,passenger_phone,fare_tzs,status")
        .eq("ticket_code", code)
        .single();

      if (error || !bk) {
        resultEl.innerHTML = `<div class="banner error">Booking not found: <strong>${code}</strong></div>`;
        return;
      }
      if (!["pending","awaiting_payment"].includes(bk.status)) {
        resultEl.innerHTML = `<div class="banner warn">Booking <strong>${code}</strong> is already <strong>${bk.status}</strong> — no payment action needed.</div>`;
        return;
      }
      renderPayForm(bk);
    }

    function renderPayForm(bk) {
      const fare = bk.fare_tzs ? window.formatTZS(bk.fare_tzs) : "—";
      resultEl.innerHTML = `
        <div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:10px;padding:12px 15px;margin-bottom:16px">
          <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#065f46;margin-bottom:6px">Booking Found ✓</div>
          <p style="margin:0 0 3px"><strong>${bk.passenger_name || "—"}</strong> · Seat <strong>${bk.seat_number || "—"}</strong></p>
          <p style="margin:0 0 3px;font-size:0.88rem;color:var(--gray)">${bk.bus_name || "—"} · ${bk.origin || "—"} → ${bk.destination || "—"} · ${bk.travel_date || "—"}${bk.departure_time ? " " + bk.departure_time : ""}</p>
          <p style="margin:0"><strong>Fare: ${fare}</strong></p>
          ${bk.passenger_phone ? `<p style="margin:4px 0 0;font-size:0.82rem;color:var(--gray)">Phone on file: ${bk.passenger_phone}</p>` : ""}
        </div>

        <div style="margin-bottom:14px">
          <div style="font-size:0.78rem;font-weight:600;color:var(--gray);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:8px">Payment Method</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-primary btn-sm cpa-mthd" data-m="cash">💵 Cash</button>
            <button type="button" class="btn btn-outline btn-sm cpa-mthd" data-m="mobile">📱 Mobile Money</button>
            <button type="button" class="btn btn-outline btn-sm cpa-mthd" data-m="bank">🏦 Bank Transfer</button>
          </div>
        </div>

        <div id="cpaFields" style="max-width:480px"></div>
        <div id="cpaMsg" style="margin-top:10px;max-width:480px"></div>
        <button class="btn btn-primary" id="cpaConfirmBtn" style="margin-top:14px;min-width:200px">Authorize Payment</button>
      `;

      const fieldsEl  = $("cpaFields");
      const msgEl     = $("cpaMsg");
      const confirmBtn= $("cpaConfirmBtn");
      let selMethod   = "cash";

      const phoneField = (val, req) => `
        <div>
          <label style="display:block;margin-bottom:4px;font-size:0.82rem;font-weight:600;color:var(--gray)">
            Customer Phone${req ? ` <small style="color:var(--danger)">* required — ticket sent here</small>` : " <small>(optional)</small>"}
          </label>
          <input type="tel" id="cpaPhone" value="${val || ""}" placeholder="+255 7xx xxx xxx"
            style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:0.95rem;box-sizing:border-box" />
        </div>`;

      function renderFields(m) {
        if (m === "cash") {
          fieldsEl.innerHTML = phoneField(bk.passenger_phone, false);
        } else if (m === "mobile") {
          fieldsEl.innerHTML = `
            <div style="display:grid;gap:10px">
              <div>
                <label style="display:block;margin-bottom:4px;font-size:0.82rem;font-weight:600;color:var(--gray)">Provider *</label>
                <select id="cpaProvider" style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:0.95rem;box-sizing:border-box">
                  <option value="mpesa">M-Pesa (Vodacom)</option>
                  <option value="tigopesa">Tigo Pesa</option>
                  <option value="airtelmoney">Airtel Money</option>
                  <option value="halopesa">Halopesa (TTCL)</option>
                  <option value="azampesa">AzamPesa</option>
                </select>
              </div>
              ${phoneField(bk.passenger_phone, true)}
            </div>`;
        } else {
          fieldsEl.innerHTML = `
            <div style="display:grid;gap:10px">
              <div>
                <label style="display:block;margin-bottom:4px;font-size:0.82rem;font-weight:600;color:var(--gray)">Bank *</label>
                <select id="cpaBank" style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:0.95rem;box-sizing:border-box">
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
                <input type="text" id="cpaBankRef" placeholder="e.g. FT26001234567"
                  style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:0.95rem;box-sizing:border-box;font-family:monospace" />
              </div>
              ${phoneField(bk.passenger_phone, true)}
            </div>`;
        }
      }

      renderFields("cash");

      resultEl.querySelectorAll(".cpa-mthd").forEach(btn => {
        btn.addEventListener("click", () => {
          resultEl.querySelectorAll(".cpa-mthd").forEach(b => {
            b.classList.remove("btn-primary"); b.classList.add("btn-outline");
          });
          btn.classList.remove("btn-outline"); btn.classList.add("btn-primary");
          selMethod = btn.dataset.m;
          renderFields(selMethod);
          msgEl.innerHTML = "";
        });
      });

      confirmBtn.addEventListener("click", async () => {
        msgEl.innerHTML = "";
        const phone   = ($("cpaPhone")?.value   || "").trim();
        const bankRef = ($("cpaBankRef")?.value || "").trim();
        const bank    = $("cpaBank")?.value     || "";
        const mobProv = $("cpaProvider")?.value || "";

        let method = "cash";
        if (selMethod === "mobile") method = mobProv;
        if (selMethod === "bank")   method = bank;

        if (selMethod === "bank" && !bankRef) {
          msgEl.innerHTML = `<div class="banner error">Bank reference number is required.</div>`; return;
        }
        if (selMethod !== "cash" && !phone) {
          msgEl.innerHTML = `<div class="banner error">Customer phone is required to send the ticket.</div>`; return;
        }

        confirmBtn.disabled = true;
        confirmBtn.textContent = "Authorizing…";

        const { data: result, error } = await sb.rpc("authorize_payment", {
          p_ticket_code:    bk.ticket_code,
          p_method:         method,
          p_bank_ref:       bankRef || null,
          p_customer_phone: phone   || null
        });

        if (error) {
          msgEl.innerHTML = `<div class="banner error">${error.message}</div>`;
          confirmBtn.disabled = false;
          confirmBtn.textContent = "Authorize Payment";
          return;
        }

        const sentTo = result?.passenger_phone || phone || bk.passenger_phone || "customer";
        msgEl.innerHTML = `
          <div class="banner success">
            ✅ Payment authorized. Ticket sent to <strong>${sentTo}</strong> via SMS.
            ${selMethod === "bank" ? `<br><small>Bank ref: ${bankRef}</small>` : ""}
          </div>`;
        confirmBtn.textContent = "✓ Done";
        codeEl.value = "";
        setTimeout(() => {
          resultEl.innerHTML = "";
          confirmBtn.disabled = false;
          confirmBtn.textContent = "Authorize Payment";
        }, 5000);
      });
    }
  }

  // ---------- trip cancellations tab ----------
  function renderCancellations() {
    const wrap       = $("cancelRequestsWrap");
    const filterEl   = $("cancelStatusFilter");
    const refreshBtn = $("cancelRefreshBtn");
    if (!wrap) return;

    const statusColor = { pending: "#b45309", approved: "#0a6f4d", rejected: "#dc2626" };

    async function load() {
      wrap.innerHTML = `<div class="empty-state"><div class="es-icon">⏳</div><div>Loading…</div></div>`;
      const fv = filterEl?.value ?? "pending";
      let q = sb.from("trip_cancellation_requests")
        .select("id,bus_id,travel_date,departure_time,route_from,route_to,reason,requested_by_name,status,reviewed_at,review_note,affected_count,created_at")
        .order("created_at", { ascending: false })
        .limit(60);
      if (fv) q = q.eq("status", fv);
      const { data, error } = await q;
      if (error) { wrap.innerHTML = `<div class="banner error">${error.message}</div>`; return; }
      if (!data.length) { wrap.innerHTML = `<div class="empty-state"><div class="es-icon">✓</div><div>No ${fv || ""} requests.</div></div>`; return; }

      // Update badge
      const badge = $("cancelBadge");
      if (badge) {
        const pending = data.filter(r => r.status === "pending").length;
        badge.textContent = pending || "";
        badge.style.display = pending ? "" : "none";
      }

      wrap.innerHTML = data.map(r => `
        <div class="card" style="margin-bottom:14px;padding:18px 20px;border-left:4px solid ${statusColor[r.status] || "#999"}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
            <div>
              <strong style="font-size:1rem">${r.travel_date} ${r.departure_time ? "· " + r.departure_time : ""}</strong>
              ${r.route_from || r.route_to ? `<span style="color:#555;font-size:0.88rem"> — ${r.route_from || "?"} → ${r.route_to || "?"}</span>` : ""}
              <br>
              <span style="font-size:0.78rem;color:#888;font-family:monospace">Bus&nbsp;${r.bus_id.slice(0, 8)}…</span>
            </div>
            <span style="font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:${statusColor[r.status] || "#888"};background:${r.status === "pending" ? "#fef9c3" : r.status === "approved" ? "#dcfce7" : "#fee2e2"};border-radius:6px;padding:3px 9px">${r.status}</span>
          </div>
          <p style="margin:10px 0 4px;font-size:0.9rem"><strong>Reason:</strong> ${r.reason}</p>
          <p style="margin:0;font-size:0.8rem;color:#666">Requested by <strong>${r.requested_by_name || "—"}</strong> · ${new Date(r.created_at).toLocaleString()}</p>
          ${r.review_note ? `<p style="margin:6px 0 0;font-size:0.8rem;color:#555"><em>Admin note: ${r.review_note}</em></p>` : ""}
          ${r.status === "pending" ? `
            <div style="display:flex;gap:8px;margin-top:14px;align-items:flex-end;flex-wrap:wrap">
              <input type="text" id="cancelNote_${r.id}" placeholder="Optional note for requester…"
                     style="flex:1;min-width:180px;padding:7px 10px;border:1.5px solid var(--border);border-radius:7px;font-size:0.88rem" />
              <button class="btn btn-danger btn-sm" data-approve="${r.id}">Approve &amp; Cancel Trip</button>
              <button class="btn btn-outline btn-sm" data-reject="${r.id}">Reject</button>
            </div>` : r.affected_count != null ? `<p style="margin:8px 0 0;font-size:0.82rem;color:#555">${r.affected_count} booking(s) cancelled.</p>` : ""}
        </div>
      `).join("");

      // Wire approve/reject buttons
      wrap.querySelectorAll("[data-approve]").forEach(btn => {
        btn.addEventListener("click", async () => {
          const id   = Number(btn.dataset.approve);
          const note = ($(`cancelNote_${id}`)?.value || "").trim();
          btn.disabled = true; btn.textContent = "…";
          const { data: res, error: err } = await sb.rpc("approve_trip_cancellation", { p_request_id: id, p_note: note || null });
          if (err) { alert("Error: " + err.message); btn.disabled = false; btn.textContent = "Approve & Cancel Trip"; return; }
          alert(`Trip cancelled. ${res.affected_count} booking(s) affected. Passenger SMS notifications will be sent by n8n.`);
          load();
        });
      });
      wrap.querySelectorAll("[data-reject]").forEach(btn => {
        btn.addEventListener("click", async () => {
          const id   = Number(btn.dataset.reject);
          const note = ($(`cancelNote_${id}`)?.value || "").trim();
          if (!note && !confirm("Reject without a note?")) return;
          btn.disabled = true; btn.textContent = "…";
          const { error: err } = await sb.rpc("reject_trip_cancellation", { p_request_id: id, p_note: note || null });
          if (err) { alert("Error: " + err.message); btn.disabled = false; btn.textContent = "Reject"; return; }
          load();
        });
      });
    }

    filterEl?.addEventListener("change", load);
    refreshBtn?.addEventListener("click", load);
    load();
  }

  // ---------- start ----------
  showCorrectView();
};
