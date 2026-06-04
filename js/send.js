window.initSendPage = async () => {
  const form       = document.getElementById("sendForm");
  const banner     = document.getElementById("resultBanner");
  const busHint    = document.getElementById("busHint");
  const insPreview = document.getElementById("insurancePreview");
  const agentSel   = document.getElementById("originAgentSelect");
  const agentCard  = document.getElementById("originAgentCard");
  const agentMsg   = document.getElementById("originAgentMsg");
  const submitBtn  = form.querySelector('button[type="submit"]');
  const freightEl  = document.getElementById("freightEstimate");

  let regions = [], buses = [], agents = [];
  try {
    [regions, buses, agents] = await Promise.all([
      window.DataStore.getRegions(),
      window.DataStore.getBuses(),
      window.DataStore.getAgents()
    ]);
  } catch (e) {
    banner.innerHTML = `<div class="banner error">Could not load data: ${e.message}</div>`;
    return;
  }

  // Populate region selects
  ["senderRegion", "receiverRegion"].forEach(name => {
    const sel = form.elements[name];
    regions.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r; opt.textContent = r;
      sel.appendChild(opt);
    });
  });

  // Populate bus select
  const busSelect = form.elements.bus;
  buses.forEach(b => {
    const opt = document.createElement("option");
    opt.value = b.id; opt.textContent = b.name;
    busSelect.appendChild(opt);
  });

  // ── Origin agent picker ───────────────────────────────────
  function refreshAgentPicker() {
    const region = form.elements.senderRegion.value;
    agentSel.innerHTML = `<option value="">${window.t("send_pick_agent")}</option>`;
    agentCard.hidden = true;
    agentMsg.textContent = "";
    if (!region) return;
    const list = window.DataStore.findAgentsByRegion(agents, region);
    if (!list.length) {
      agentMsg.textContent = window.t("send_no_agents_region");
      agentMsg.style.color = "var(--warn)";
      return;
    }
    list.forEach(a => {
      const opt = document.createElement("option");
      opt.value = a.id || a.name;
      opt.textContent = `${a.name} — ${a.terminal || region}`;
      opt.dataset.agentId = a.id || "";
      agentSel.appendChild(opt);
    });
  }

  function showAgentCard() {
    const region = form.elements.senderRegion.value;
    const val    = agentSel.value;
    if (!val) { agentCard.hidden = true; return; }
    const list = window.DataStore.findAgentsByRegion(agents, region);
    const a    = list.find(x => (x.id || x.name) === val);
    if (!a) { agentCard.hidden = true; return; }
    const photo    = window.DataStore.agentPhotoUrl(a.photo_path);
    const initials = (a.name || "?").split(/\s+/).map(s => s[0]).join("").slice(0, 2).toUpperCase();
    const avatar   = photo
      ? `<img src="${photo}" alt="${a.name}" />`
      : `<span>${initials}</span>`;
    const phones   = (a.phones && a.phones.length) ? a.phones : (a.phone ? [a.phone] : []);
    const verified = a.verified !== false ? `<span class="verified-badge">✓ ${window.t("label_verified")}</span>` : "";
    const stars    = Number(a.rating_avg) ? `⭐ ${Number(a.rating_avg).toFixed(1)}` : "";
    agentCard.hidden  = false;
    agentCard.innerHTML = `
      <div class="agent-preview-inner">
        <div class="agent-avatar">${avatar}</div>
        <div>
          <strong>${a.name}</strong> ${verified} ${stars ? `<small style="color:var(--gray)">${stars}</small>` : ""}
          <p style="margin:3px 0 2px;font-size:0.87rem;color:var(--gray)">
            ${window.t("send_agent_preview_terminal")} ${a.terminal || a.region}
          </p>
          <p style="margin:0;font-size:0.87rem;color:var(--gray)">
            ${window.t("send_agent_preview_buses")} ${(a.buses || []).join(", ") || "—"}
          </p>
          ${window.DataStore.renderAgentPhones(phones)}
        </div>
      </div>`;
  }

  form.elements.senderRegion.addEventListener("change", () => {
    refreshAgentPicker();
    showAgentCard();
    updateBusHint();
    updateFreight();
  });
  agentSel.addEventListener("change", showAgentCard);

  // ── Insurance preview ─────────────────────────────────────
  const updateInsurance = () => {
    const v = parseFloat(form.elements.value.value);
    if (!v || isNaN(v) || v <= 0) { insPreview.style.display = "none"; return; }
    const cov = Math.round(v * (window.APP_CONFIG.INSURANCE_COVERAGE_PERCENT / 100));
    insPreview.style.display = "block";
    insPreview.innerHTML = `<strong>${window.t("field_insurance")}:</strong> ${window.formatTZS(cov)}`;
  };
  form.elements.value.addEventListener("input", updateInsurance);

  // ── Freight estimate (display-only, agent confirms real price) ──
  const weightInput    = document.getElementById("weightInput");
  const sizeCategoryEl = document.getElementById("sizeCategorySelect");
  let _suggestedFee = 0;

  const updateFreight = () => {
    const cfg  = window.APP_CONFIG;
    const kg   = parseFloat(weightInput?.value || 0);
    const size = sizeCategoryEl?.value || "medium";
    if (!kg || isNaN(kg) || kg <= 0) { if (freightEl) freightEl.textContent = "—"; return; }
    const base     = cfg.FREIGHT_BASE_TZS || 2000;
    const perKg    = cfg.FREIGHT_PER_KG_TZS || 500;
    const sizeM    = (cfg.FREIGHT_SIZE_MULTIPLIERS || {})[size] || 1.0;
    const maintPct = cfg.FREIGHT_MAINTENANCE_PCT || 10;
    _suggestedFee  = Math.round((base + kg * perKg) * sizeM * (1 + maintPct / 100));
    if (freightEl) {
      const fx = window.PawaFX ? window.PawaFX.format(_suggestedFee) : "";
      freightEl.textContent =
        `~${window.formatTZS(_suggestedFee)}${fx ? " " + fx : ""} (${kg} kg, ${size})`;
    }
  };

  weightInput?.addEventListener("input", updateFreight);
  sizeCategoryEl?.addEventListener("change", updateFreight);
  // Re-render the estimate once live FX rates finish loading.
  if (window.PawaFX && window.PawaFX.ready) window.PawaFX.ready.then(updateFreight);

  // ── Bus route hint ────────────────────────────────────────
  const updateBusHint = () => {
    const fromReg = form.elements.senderRegion.value;
    const toReg   = form.elements.receiverRegion.value;
    const busId   = busSelect.value;
    if (!fromReg || !toReg || !busId) { busHint.textContent = ""; return; }
    const bus   = buses.find(b => b.id === busId);
    const route = bus.routes.find(r => r.from === fromReg && r.to === toReg);
    if (route) {
      busHint.textContent = `${bus.name}: ${route.from} → ${route.to}, departs ${route.departure} (~${route.duration_hours}h).`;
      busHint.style.color = "var(--success)";
    } else {
      busHint.textContent = `${bus.name} has no direct ${fromReg} → ${toReg} route in our records.`;
      busHint.style.color = "var(--warn)";
    }
  };
  ["receiverRegion", "bus"].forEach(n => form.elements[n].addEventListener("change", updateBusHint));

  // Default departure: tomorrow
  form.elements.depDate.value = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  // ── Submit ────────────────────────────────────────────────
  let submitting = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submitting) return;
    banner.innerHTML = "";

    if (!agentSel.value) {
      banner.innerHTML = `<div class="banner error">${window.t("send_agent_required")}</div>`;
      banner.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }

    submitting            = true;
    submitBtn.disabled    = true;
    submitBtn.textContent = window.t("send_submitting");

    const f              = form.elements;
    const senderRegion   = f.senderRegion.value;
    const receiverRegion = f.receiverRegion.value;
    const bus            = buses.find(b => b.id === f.bus.value);
    const route          = bus.routes.find(r => r.from === senderRegion && r.to === receiverRegion);

    const regionAgents = window.DataStore.findAgentsByRegion(agents, senderRegion);
    const originAgent  = regionAgents.find(a => (a.id || a.name) === agentSel.value) || regionAgents[0];

    const destAgents = window.DataStore.findAgentsByRegion(agents, receiverRegion);
    const destAgent  = destAgents.find(a => a.buses?.includes(bus.name)) || destAgents[0];

    const trackingCode = await window.DataStore.generateTrackingCode(senderRegion, receiverRegion);
    const value        = parseFloat(f.value.value) || 0;

    const shipment = {
      tracking_code: trackingCode,
      sender:   { name: f.senderName.value,   phone: f.senderPhone.value,   region: senderRegion },
      receiver: { name: f.receiverName.value,  phone: f.receiverPhone.value, region: receiverRegion },
      product: {
        description:   f.productDesc.value,
        weight_kg:     parseFloat(f.weight.value),
        size_category: sizeCategoryEl?.value || "medium",
        freight_fee:   0,           // agent will set the confirmed price
        suggested_fee: _suggestedFee,
        value_tzs:     value,
        insured:       true
      },
      bus: {
        name:      bus.name,
        route:     `${senderRegion} → ${receiverRegion}`,
        departure: `${f.depDate.value} ${route ? route.departure : "TBC"}`
      },
      agent_origin: originAgent
        ? { name: originAgent.name, phone: originAgent.phone || (originAgent.phones || [])[0] || "" }
        : { name: "TBC", phone: "TBC" },
      agent_destination: destAgent
        ? { name: destAgent.name, phone: destAgent.phone || (destAgent.phones || [])[0] || "" }
        : { name: "TBC", phone: "TBC" },
      status:     "Awaiting Price",   // agent must agree/set price before ride starts
      notes:      f.notes.value || null,
      created_at: new Date().toISOString().slice(0, 10)
    };

    try {
      await window.DataStore.createShipment(shipment);

      // Show the tracking code and price-agreement panel immediately
      showPricePanel(trackingCode, originAgent, _suggestedFee);

      form.reset();
      agentCard.hidden = true;
      agentSel.innerHTML = `<option value="">${window.t("send_pick_agent")}</option>`;
      form.elements.depDate.value = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      insPreview.style.display = "none";
      if (freightEl) freightEl.textContent = "—";
      form.hidden = true;
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      banner.innerHTML = `<div class="banner error">${window.t("send_error")} (${err.message})</div>`;
    } finally {
      submitting            = false;
      submitBtn.disabled    = false;
      submitBtn.textContent = window.t("send_submit");
    }
  });

  // ── Price-agreement live panel ────────────────────────────
  let _pollInterval = null;
  let _lastCode     = null;

  function showPricePanel(trackingCode, originAgent, suggestedFee) {
    _lastCode = trackingCode;

    const panel    = document.getElementById("pricePanel");
    const codeEl   = document.getElementById("panelTrackingCode");
    const contactEl = document.getElementById("agentContactBox");
    const titleEl  = document.getElementById("pricePanelTitle");
    const subEl    = document.getElementById("pricePanelSub");

    codeEl.textContent = trackingCode;
    titleEl.textContent = "Request submitted — awaiting agent price confirmation.";

    const agentName     = originAgent?.name     || "your agent";
    const agentTerminal = originAgent?.terminal || originAgent?.region || "the terminal";
    const agentPhone    = originAgent?.phone || (originAgent?.phones || [])[0] || "";

    subEl.textContent = `Once approved, go to ${agentTerminal} and meet ${agentName}${agentPhone ? ` (${agentPhone})` : ""} to agree on the transport fee.`;

    contactEl.innerHTML = `
      <strong>📋 What happens next:</strong><br/>
      <ol style="margin:6px 0 0 16px;padding:0;font-size:0.85rem;line-height:1.8;">
        <li>Admin reviews and approves your request.</li>
        <li><strong>${agentName}</strong> will agree or set the final transport fee.</li>
        <li>This panel updates automatically — the final price will appear below.</li>
        <li>Once price is agreed, your shipment becomes active and the <strong>tracking code above</strong> goes live.</li>
      </ol>
      ${suggestedFee ? `<div style="margin-top:10px;font-size:0.82rem;color:#555;">System estimate: <strong>${window.formatTZS(suggestedFee)}</strong> — agent may confirm or adjust this.</div>` : ""}`;

    panel.hidden = false;

    // Start polling every 15 seconds
    clearInterval(_pollInterval);
    pollPrice(trackingCode);
    _pollInterval = setInterval(() => pollPrice(trackingCode), 15000);
  }

  async function pollPrice(trackingCode) {
    const statusEl  = document.getElementById("priceStatusBox");
    const contentEl = document.getElementById("priceStatusContent");
    const checkBtn  = document.getElementById("checkPriceBtn");
    const checkStat = document.getElementById("priceCheckStatus");
    const iconEl    = document.getElementById("pricePanelIcon");
    const titleEl   = document.getElementById("pricePanelTitle");

    try {
      const sb = window.SB;
      if (!sb) return;
      const { data } = await sb
        .from("shipments")
        .select("status, product_freight_fee, agent_origin_name, agent_origin_phone")
        .eq("tracking_code", trackingCode)
        .maybeSingle();

      if (!data) return;

      const status = data.status;
      const fee    = data.product_freight_fee;
      const now    = new Date().toLocaleTimeString();

      if (status === "Awaiting Price" || !status) {
        statusEl.style.background = "#fff8e1";
        statusEl.style.border     = "1px solid #ffe082";
        contentEl.style.color     = "#7a5a00";
        contentEl.textContent     = `Awaiting agent confirmation. Last checked: ${now}`;
        checkStat.textContent     = `Checked at ${now}`;

      } else if (status === "Needs Revision") {
        clearInterval(_pollInterval);
        iconEl.textContent          = "✏️";
        titleEl.textContent         = "Agent requested a revision.";
        statusEl.style.background   = "#fff3cd";
        statusEl.style.border       = "1px solid #ffc107";
        contentEl.style.color       = "#856404";
        contentEl.innerHTML         = `Your agent has reviewed the request and asked for changes. Please contact them to discuss.`;

      } else if (fee && parseFloat(fee) > 0) {
        // Price agreed — ride is active
        clearInterval(_pollInterval);
        iconEl.textContent        = "✅";
        titleEl.textContent       = "Price confirmed — your ride is now active!";
        statusEl.style.background = "#d1fae5";
        statusEl.style.border     = "1px solid #6ee7b7";
        contentEl.style.color     = "#065f46";
        contentEl.innerHTML       = `
          <strong style="font-size:1.15rem;">Transport fee: ${window.formatTZS(parseFloat(fee))}</strong><br/>
          <span style="font-size:0.85rem;">Agreed by your agent · Status: <strong>${status}</strong></span><br/>
          <span style="font-size:0.83rem;color:#555;margin-top:4px;display:block;">
            Present tracking code <strong>${trackingCode}</strong> when delivering your parcel.
          </span>`;
        checkBtn.textContent = "View tracking →";
        checkBtn.onclick = () => { window.location.href = `track.html?code=${encodeURIComponent(trackingCode)}`; };
      }
    } catch {}
  }

  document.getElementById("checkPriceBtn").addEventListener("click", () => {
    if (_lastCode) pollPrice(_lastCode);
  });
};
