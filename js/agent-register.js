// =====================================================
// Agent self-registration form
// Public submit -> agent_applications (status = pending).
// Admin reviews & approves in admin.html.
// =====================================================

window.initAgentRegisterPage = async () => {
  const form = document.getElementById("agentForm");
  const banner = document.getElementById("resultBanner");
  const sb = window.SB;

  if (!sb) {
    banner.innerHTML = `<div class="banner error">${window.t("agent_reg_err_backend")}</div>`;
    form.style.display = "none";
    return;
  }

  let regions = [];
  try {
    regions = await window.DataStore.getRegions();
  } catch (e) {
    banner.innerHTML = `<div class="banner error">Could not load form options: ${e.message}</div>`;
    return;
  }

  const regionSel = form.elements["region"];
  regions.forEach(r => {
    const o = document.createElement("option");
    o.value = r; o.textContent = r;
    regionSel.appendChild(o);
  });

  // ── Bus tag input ─────────────────────────────────────────
  const busNameInput = document.getElementById("busNameInput");
  const addBusBtn    = document.getElementById("addBusBtn");
  const busTags      = document.getElementById("busTags");
  let buses_added    = [];

  function renderBusTags() {
    busTags.innerHTML = buses_added.map(name => `
      <span class="bus-tag">
        ${name}
        <button type="button" class="tag-remove" data-name="${name}" title="Remove">×</button>
      </span>`).join("");
    busTags.querySelectorAll(".tag-remove").forEach(btn => {
      btn.addEventListener("click", () => {
        buses_added = buses_added.filter(b => b !== btn.dataset.name);
        renderBusTags();
      });
    });
  }

  function addBus() {
    const name = busNameInput.value.trim();
    if (!name) return;
    if (!buses_added.includes(name)) {
      buses_added.push(name);
      renderBusTags();
    }
    busNameInput.value = "";
    busNameInput.focus();
  }

  addBusBtn.addEventListener("click", addBus);
  busNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addBus(); }
  });

  // ── Photo preview ─────────────────────────────────────────────
  const photoInput = document.getElementById("photoInput");
  const photoPreviewWrap = document.getElementById("photoPreviewWrap");
  const photoPreview = document.getElementById("photoPreview");

  photoInput?.addEventListener("change", () => {
    const file = photoInput.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        photoPreview.src = e.target.result;
        photoPreviewWrap.style.display = "block";
      };
      reader.readAsDataURL(file);
    } else {
      photoPreviewWrap.style.display = "none";
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    banner.innerHTML = "";

    const fd  = new FormData(form);
    const exp = Number(fd.get("experience_years"));

    if (!buses_added.length) {
      banner.innerHTML = `<div class="banner error">${window.t("agent_reg_err_buses")}</div>`;
      return;
    }
    if (!exp || exp < 1) {
      banner.innerHTML = `<div class="banner error">${window.t("agent_reg_err_exp")}</div>`;
      return;
    }
    if (!document.getElementById("agreeTerms").checked) {
      banner.innerHTML = `<div class="banner error">${window.t("agent_reg_err_terms")}</div>`;
      return;
    }

    // Photo is required for all agents
    const photoFile = fd.get("photo");
    if (!photoFile || photoFile.size === 0) {
      banner.innerHTML = `<div class="banner error">Profile photo is required. Please upload a clear photo of yourself.</div>`;
      photoInput?.focus();
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    const submitBtn = form.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    submitBtn.textContent = window.t("agent_reg_submitting");

    let photo_path = null;
    if (photoFile && photoFile.size > 0) {
      const safe = (fd.get("phone") || "anon").replace(/[^0-9]/g, "");
      const ext = (photoFile.name.split(".").pop() || "jpg").toLowerCase();
      photo_path = `applicant_${safe}_${Date.now()}.${ext}`;
      const { error: upErr } = await sb.storage.from("agent-photos").upload(photo_path, photoFile, {
        contentType: photoFile.type || "image/jpeg",
        upsert: true
      });
      if (upErr) {
        submitBtn.disabled = false;
        submitBtn.textContent = window.t("agent_reg_submit");
        banner.innerHTML = `<div class="banner error">${window.t("agent_reg_err_photo")}${upErr.message}</div>`;
        return;
      }
    }

    const payload = {
      full_name: fd.get("full_name").trim(),
      phone: fd.get("phone").trim(),
      email: fd.get("email").trim() || null,
      region: fd.get("region"),
      terminal: fd.get("terminal").trim(),
      buses: buses_added,
      experience_years: exp,
      national_id: fd.get("national_id")?.trim() || null,
      about: (fd.get("about") || "").trim() || null,
      photo_path
    };

    // Stamp the application with the active tenant so the approved agent
    // ends up in the right dashboard. Falls back to the column default
    // (demo tenant) when the registration page is accessed without any
    // tenant context (e.g. standalone pawa.tz site).
    try {
      if (typeof window.loadTenantContext === "function") {
        const t = await window.loadTenantContext();
        if (t?.id) payload.tenant_id = t.id;
      } else if (window.PAWA_TENANT?.id) {
        payload.tenant_id = window.PAWA_TENANT.id;
      }
    } catch { /* leave default */ }

    const { error } = await sb.from("agent_applications").insert(payload);

    submitBtn.disabled = false;
    submitBtn.textContent = window.t("agent_reg_submit");

    if (error) {
      banner.innerHTML = `<div class="banner error">${error.message}</div>`;
      return;
    }

    banner.innerHTML = `<div class="banner success">${window.t("agent_reg_success")}</div>`;
    form.reset();
    buses_added = [];
    renderBusTags();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // ── Withdraw / delete application ─────────────────────────
  const withdrawForm   = document.getElementById("withdrawForm");
  const withdrawResult = document.getElementById("withdrawResult");

  withdrawForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    withdrawResult.innerHTML = "";
    const raw   = document.getElementById("withdrawPhone").value.trim();
    const phone = raw.replace(/\s/g, "");
    if (!phone) return;

    const submitBtn = withdrawForm.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    submitBtn.textContent = "Searching…";

    // Look up by phone (try both spaced and clean forms)
    const { data, error } = await sb.from("agent_applications")
      .select("id, full_name, status")
      .or(`phone.eq.${raw},phone.eq.${phone}`)
      .maybeSingle();

    submitBtn.disabled = false;
    submitBtn.textContent = "Delete my application";

    if (error || !data) {
      withdrawResult.innerHTML = `<div class="banner error">No application found for this phone number.</div>`;
      return;
    }
    if (data.status === "approved") {
      withdrawResult.innerHTML = `<div class="banner error">This application has already been approved and cannot be deleted here. Contact admin.</div>`;
      return;
    }

    if (!confirm(`Delete application for "${data.full_name}"? This cannot be undone.`)) return;

    const { error: delErr } = await sb.from("agent_applications").delete().eq("id", data.id);
    if (delErr) {
      withdrawResult.innerHTML = `<div class="banner error">${delErr.message}</div>`;
      return;
    }
    withdrawResult.innerHTML = `<div class="banner success">Application deleted successfully.</div>`;
    withdrawForm.reset();
  });
};
