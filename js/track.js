const TZ_TRACK_COORDS = {
  "arusha":[-3.3869,36.6829],"dar es salaam":[-6.7924,39.2083],"dodoma":[-6.1722,35.7395],
  "geita":[-2.8716,32.2300],"iringa":[-7.7706,35.6904],"kagera":[-1.3290,31.8120],
  "katavi":[-6.7945,31.3989],"kigoma":[-4.8770,29.6260],"kilimanjaro":[-3.0670,37.3500],
  "lindi":[-9.9968,39.7167],"manyara":[-3.6680,35.7450],"mara":[-1.7500,34.1500],
  "mbeya":[-8.9000,33.4500],"morogoro":[-6.8278,37.6591],"mtwara":[-10.2667,40.1833],
  "mwanza":[-2.5164,32.9175],"njombe":[-9.3300,34.7700],"pwani":[-7.5000,38.7000],
  "rukwa":[-7.9667,31.6167],"ruvuma":[-10.6833,35.6500],"shinyanga":[-3.6603,33.4214],
  "simiyu":[-2.6500,34.4000],"singida":[-4.8167,34.7500],"songwe":[-8.4000,32.9000],
  "tabora":[-5.0167,32.8000],"tanga":[-5.0700,39.0992]
};

let _trackMap = null;

function initShipmentMap(shipment) {
  if (_trackMap) { _trackMap.remove(); _trackMap = null; }
  const el = document.getElementById("shipmentMap");
  if (!el || typeof L === "undefined") return;

  const oKey = (shipment.sender?.region   || "").toLowerCase().trim();
  const dKey = (shipment.receiver?.region || "").toLowerCase().trim();
  const o = TZ_TRACK_COORDS[oKey];
  const d = TZ_TRACK_COORDS[dKey];
  if (!o && !d) { el.style.display = "none"; return; }

  const center = o && d ? [(o[0]+d[0])/2, (o[1]+d[1])/2] : (o || d);
  _trackMap = L.map(el, { zoomControl: true, scrollWheelZoom: false }).setView(center, 6);

  const _mbToken = window.APP_CONFIG?.MAPBOX_TOKEN || "";
  if (_mbToken) {
    L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/512/{z}/{x}/{y}?access_token=${_mbToken}`,
      { maxZoom: 22, tileSize: 512, zoomOffset: -1, attribution: "© Mapbox © OpenStreetMap" }
    ).addTo(_trackMap);
  } else {
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors"
    }).addTo(_trackMap);
  }

  const pinIcon = (label, color) => L.divIcon({
    className: "",
    html: `<div style="background:${color};color:#fff;font-weight:700;font-size:12px;width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.5)"><span style="transform:rotate(45deg)">${label}</span></div>`,
    iconSize: [28, 28], iconAnchor: [14, 28]
  });

  if (o) L.marker(o, { icon: pinIcon("A", "#00cfff") }).addTo(_trackMap)
    .bindTooltip(shipment.sender.region, { permanent: true, direction: "top", className: "track-map-tip" });
  if (d) L.marker(d, { icon: pinIcon("B", "#d4af37") }).addTo(_trackMap)
    .bindTooltip(shipment.receiver.region, { permanent: true, direction: "top", className: "track-map-tip" });

  if (o && d) {
    L.polyline([o, d], { color: "#00cfff", weight: 4, dashArray: "8 10", opacity: 0.9 }).addTo(_trackMap);

    const progress = { "Registered": 0, "Picked Up": 0.08, "In Transit": 0.5, "Arrived": 0.93, "Delivered": 1 }[shipment.status] ?? 0.5;
    const busPos = [o[0] + (d[0]-o[0])*progress, o[1] + (d[1]-o[1])*progress];
    L.marker(busPos, {
      icon: L.divIcon({ className: "", html: '<div style="font-size:24px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6))">🚌</div>', iconSize:[28,28], iconAnchor:[14,14] })
    }).addTo(_trackMap).bindTooltip(shipment.status, { permanent: true, direction: "top", className: "track-map-tip" });

    _trackMap.fitBounds([o, d], { padding: [55, 55] });
  } else {
    _trackMap.setView(o || d, 9);
  }

  setTimeout(() => _trackMap?.invalidateSize(), 80);
}

window.initTrackPage = () => {
  const result = document.getElementById("trackResult");
  let shipmentChannel = null;

  const STAGES = ["Registered", "Picked Up", "In Transit", "Arrived", "Delivered"];

  // -------- Tab switching --------
  document.querySelectorAll(".track-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".track-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".track-panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("panel-" + tab.dataset.tab).classList.add("active");
      result.innerHTML = "";
      cleanup();
    });
  });

  // -------- Helpers --------
  const cleanup = () => {
    if (shipmentChannel) { shipmentChannel.unsubscribe?.(); shipmentChannel = null; }
    if (_trackMap) { _trackMap.remove(); _trackMap = null; }
    window.MessagesUI.cleanup();
  };

  const statusBadge = (status) => {
    const cls = {
      "Registered": "badge-registered",
      "Picked Up": "badge-picked",
      "In Transit": "badge-transit",
      "Arrived": "badge-arrived",
      "Delivered": "badge-delivered"
    }[status] || "badge-registered";
    const label = window.t("status_" + status) || status;
    return `<span class="badge ${cls}">${label}</span>`;
  };

  const renderTimeline = (currentStatus) => {
    const currentIdx = STAGES.indexOf(currentStatus);
    return `<div class="timeline">${STAGES.map((s, i) => {
      const cls = i < currentIdx ? "done" : i === currentIdx ? "done current" : "";
      const label = window.t("status_" + s) || s;
      return `<div class="timeline-step ${cls}"><span class="timeline-dot"></span><span class="timeline-label">${label}</span></div>`;
    }).join("")}</div>`;
  };

  const phoneClean = (p) => (p || "").replace(/\s/g, "");

  const contactBtns = (name, phone) => {
    if (!phone || phone === "TBC") return "";
    const clean = phoneClean(phone);
    const wa = clean.replace(/^\+/, "");
    return `
      <div class="contact-actions">
        <a href="tel:${clean}" class="btn btn-outline btn-sm">${window.t("action_call")}</a>
        <a href="https://wa.me/${wa}" target="_blank" rel="noopener" class="btn btn-whatsapp btn-sm">${window.t("action_whatsapp")}</a>
      </div>
    `;
  };

  const renderDetail = (shipment, backFn) => {
    const cov = window.APP_CONFIG.INSURANCE_COVERAGE_PERCENT;
    const coverage = Math.round((shipment.product.value_tzs || 0) * cov / 100);

    result.innerHTML = `
      <div class="track-result">
        <button class="detail-back" id="backBtn">&larr; ${window.t("track_back")}</button>

        <div class="track-code-bar">
          <h2>${shipment.tracking_code}</h2>
          <div style="display:flex;gap:8px;align-items:center">
            ${statusBadge(shipment.status)}
            <button class="btn btn-outline btn-sm" id="copyBtn" data-code="${shipment.tracking_code}">${window.t("action_copy")}</button>
          </div>
        </div>

        <div class="track-row">
          <span class="label">${window.t("field_sender")}</span>
          <div>
            <strong>${shipment.sender.name}</strong><br/>
            <small>${shipment.sender.phone} &middot; ${shipment.sender.region}</small>
            ${contactBtns(shipment.sender.name, shipment.sender.phone)}
          </div>
        </div>
        <div class="track-row">
          <span class="label">${window.t("field_receiver")}</span>
          <div>
            <strong>${shipment.receiver.name}</strong><br/>
            <small>${shipment.receiver.phone} &middot; ${shipment.receiver.region}</small>
            ${contactBtns(shipment.receiver.name, shipment.receiver.phone)}
          </div>
        </div>
        <div class="track-row">
          <span class="label">${window.t("field_product")}</span>
          <div>${shipment.product.description} <small style="color:var(--gray)">(${shipment.product.weight_kg} kg)</small></div>
        </div>
        <div class="track-row">
          <span class="label">${window.t("field_value")}</span>
          <div><strong>${window.formatTZS(shipment.product.value_tzs)}</strong></div>
        </div>

        <div class="insurance-row">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--green-dark);flex-shrink:0">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
          <div>
            <div class="ins-amount">${window.formatTZS(coverage)}</div>
            <div class="ins-meta">${window.t("field_insurance")}</div>
          </div>
        </div>

        <div class="track-row">
          <span class="label">${window.t("field_route")}</span>
          <div>
            <strong>${shipment.bus.name}</strong><br/>
            <small>${shipment.bus.route} &middot; ${shipment.bus.departure}</small>
          </div>
        </div>
        <div class="track-row">
          <span class="label">${window.t("field_origin_agent")}</span>
          <div>
            <strong>${shipment.agent_origin.name}</strong> &middot; ${shipment.agent_origin.phone}
            ${contactBtns(shipment.agent_origin.name, shipment.agent_origin.phone)}
          </div>
        </div>
        <div class="track-row">
          <span class="label">${window.t("field_dest_agent")}</span>
          <div>
            <strong>${shipment.agent_destination.name}</strong> &middot; ${shipment.agent_destination.phone}
            ${contactBtns(shipment.agent_destination.name, shipment.agent_destination.phone)}
          </div>
        </div>

        ${renderTimeline(shipment.status)}

        <div id="shipmentMap" style="height:280px;border-radius:12px;margin-top:16px;overflow:hidden;background:#111"></div>

        ${renderRatingBlock(shipment)}
      </div>

      <div id="messagesContainer"></div>
    `;

    initShipmentMap(shipment);

    document.getElementById("backBtn").addEventListener("click", () => { cleanup(); backFn(); });

    wireRatingForm(shipment);

    // Copy button
    document.getElementById("copyBtn").addEventListener("click", (e) => {
      const btn = e.currentTarget;
      navigator.clipboard.writeText(btn.dataset.code);
      const orig = btn.textContent;
      btn.textContent = window.t("action_copied");
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });

    // Render messages
    window.MessagesUI.render(document.getElementById("messagesContainer"), shipment.tracking_code);

    // Realtime: re-render detail when shipment changes
    if (shipmentChannel) shipmentChannel.unsubscribe?.();
    shipmentChannel = window.DataStore.subscribeShipment(shipment.tracking_code, async () => {
      const fresh = await window.DataStore.findShipment(shipment.tracking_code);
      if (fresh) renderDetail(fresh, backFn);
    });
  };

  const renderList = (shipments, role, query, backFn) => {
    if (shipments.length === 0) {
      result.innerHTML = `<div class="empty"><div class="icon">[--]</div><p>${window.t("track_not_found")} <strong>${query}</strong></p></div>`;
      return;
    }

    const orderWord = shipments.length === 1 ? window.t("track_order") : window.t("track_orders");
    const roleLabel = role === "sender" ? window.t("msg_role_sender") : window.t("msg_role_receiver");

    result.innerHTML = `
      <p style="color:var(--gray);font-size:0.92rem;margin-bottom:12px">
        ${window.t("track_found")} <strong>${shipments.length}</strong> ${orderWord} ${window.t("track_for")} ${roleLabel}: <strong>${query}</strong>.
        <br/><small>${window.t("track_click_card")}</small>
      </p>
      ${shipments.map((s, i) => `
        <div class="shipment-card" data-idx="${i}">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px">
            <h4>${s.tracking_code}</h4>
            ${statusBadge(s.status)}
          </div>
          <div class="card-meta">
            <span><strong>${window.t("field_route")}:</strong> ${s.bus.route}</span>
            <span><strong>${window.t("send_bus")}:</strong> ${s.bus.name}</span>
            <span><strong>${window.t("send_dep_date")}:</strong> ${s.bus.departure}</span>
            ${role === "sender"
              ? `<span><strong>${window.t("field_receiver")}:</strong> ${s.receiver.name} (${s.receiver.region})</span>`
              : `<span><strong>${window.t("field_sender")}:</strong> ${s.sender.name} (${s.sender.region})</span>`
            }
            <span><strong>${window.t("field_value")}:</strong> ${window.formatTZS(s.product.value_tzs)}</span>
          </div>
        </div>
      `).join("")}
    `;

    result.querySelectorAll(".shipment-card").forEach((card, i) => {
      card.addEventListener("click", () => renderDetail(shipments[i], backFn));
    });
  };

  // -------- Rating block (only when delivered) --------
  function renderRatingBlock(s) {
    if (s.status !== "Delivered") return "";
    return `
      <div class="rating-block">
        <h3>How was this delivery?</h3>
        <p class="hint">Your feedback helps build trust in our agents.</p>
        <form id="rateForm" class="form-grid">
          <label>Your phone (must match sender or receiver)
            <input type="tel" name="rater_phone" required placeholder="+255 ..." />
          </label>
          <label>Rate origin agent — <strong>${s.agent_origin?.name || "—"}</strong>
            <select name="rate_origin">
              <option value="">— skip —</option>
              <option value="5">★★★★★ Excellent</option>
              <option value="4">★★★★ Good</option>
              <option value="3">★★★ Average</option>
              <option value="2">★★ Poor</option>
              <option value="1">★ Bad</option>
            </select>
          </label>
          <label>Rate destination agent — <strong>${s.agent_destination?.name || "—"}</strong>
            <select name="rate_dest">
              <option value="">— skip —</option>
              <option value="5">★★★★★ Excellent</option>
              <option value="4">★★★★ Good</option>
              <option value="3">★★★ Average</option>
              <option value="2">★★ Poor</option>
              <option value="1">★ Bad</option>
            </select>
          </label>
          <label>Comment (optional)
            <input type="text" name="comment" placeholder="A short note..." maxlength="200" />
          </label>
          <button type="submit" class="btn btn-primary">Submit rating</button>
        </form>
        <p id="rateMsg" class="banner success" style="display:none;margin-top:10px"></p>
      </div>
    `;
  }

  function wireRatingForm(shipment) {
    const form = document.getElementById("rateForm");
    if (!form) return;
    const sb = window.SB;
    const msg = document.getElementById("rateMsg");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      msg.style.display = "none";
      const fd = new FormData(form);
      const phone = (fd.get("rater_phone") || "").replace(/\s/g, "");
      const senderP = phoneClean(shipment.sender.phone);
      const receiverP = phoneClean(shipment.receiver.phone);
      if (phone !== senderP && phone !== receiverP) {
        msg.style.display = "block";
        msg.classList.remove("success"); msg.classList.add("error");
        msg.textContent = "Phone must match the sender's or receiver's phone for this shipment.";
        return;
      }
      const ratings = [];
      const ro = Number(fd.get("rate_origin"));
      const rd = Number(fd.get("rate_dest"));
      const comment = (fd.get("comment") || "").trim() || null;

      const findAgentId = async (name) => {
        if (!name) return null;
        const { data } = await sb.from("agents").select("id").ilike("name", name).limit(1);
        return data?.[0]?.id || null;
      };

      if (ro >= 1) {
        const id = await findAgentId(shipment.agent_origin?.name);
        if (id) ratings.push({ agent_id: id, tracking_code: shipment.tracking_code, rater_phone: phone, rating: ro, comment });
      }
      if (rd >= 1) {
        const id = await findAgentId(shipment.agent_destination?.name);
        if (id) ratings.push({ agent_id: id, tracking_code: shipment.tracking_code, rater_phone: phone, rating: rd, comment });
      }
      if (!ratings.length) {
        msg.style.display = "block";
        msg.classList.remove("success"); msg.classList.add("error");
        msg.textContent = "Please rate at least one agent.";
        return;
      }
      const { error } = await sb.from("agent_reviews")
        .upsert(ratings, { onConflict: "agent_id,tracking_code,rater_phone" });
      if (error) {
        msg.style.display = "block";
        msg.classList.remove("success"); msg.classList.add("error");
        msg.textContent = error.message;
        return;
      }
      msg.style.display = "block";
      msg.classList.remove("error"); msg.classList.add("success");
      msg.textContent = "Thank you! Your rating has been recorded.";
      form.reset();
    });
  }

  // -------- Search by tracking code --------
  const trackInput = document.getElementById("trackInput");
  const trackBtn = document.getElementById("trackBtn");

  const searchByCode = async () => {
    const code = trackInput.value.trim();
    if (!code) return;
    cleanup();
    result.innerHTML = `<div class="banner info">${window.t("track_searching")}</div>`;
    try {
      const shipment = await window.DataStore.findShipment(code);
      if (!shipment) {
        result.innerHTML = `<div class="empty"><div class="icon">[X]</div><p>${window.t("track_not_found")}</p></div>`;
        return;
      }
      renderDetail(shipment, () => { result.innerHTML = ""; });
    } catch (e) {
      result.innerHTML = `<div class="banner error">${e.message}</div>`;
    }
  };

  trackBtn.addEventListener("click", searchByCode);
  trackInput.addEventListener("keydown", (e) => { if (e.key === "Enter") searchByCode(); });

  // -------- Search by sender --------
  const senderQuery = document.getElementById("senderQuery");
  const senderBtn = document.getElementById("senderBtn");

  const searchBySender = async () => {
    const q = senderQuery.value.trim();
    if (!q) return;
    cleanup();
    result.innerHTML = `<div class="banner info">${window.t("track_searching")}</div>`;
    try {
      const found = await window.DataStore.findShipmentsByPhone(q, "sender");
      renderList(found, "sender", q, () => searchBySender());
    } catch (e) {
      result.innerHTML = `<div class="banner error">${e.message}</div>`;
    }
  };

  senderBtn.addEventListener("click", searchBySender);
  senderQuery.addEventListener("keydown", (e) => { if (e.key === "Enter") searchBySender(); });

  // -------- Search by receiver --------
  const receiverQuery = document.getElementById("receiverQuery");
  const receiverBtn = document.getElementById("receiverBtn");

  const searchByReceiver = async () => {
    const q = receiverQuery.value.trim();
    if (!q) return;
    cleanup();
    result.innerHTML = `<div class="banner info">${window.t("track_searching")}</div>`;
    try {
      const found = await window.DataStore.findShipmentsByPhone(q, "receiver");
      renderList(found, "receiver", q, () => searchByReceiver());
    } catch (e) {
      result.innerHTML = `<div class="banner error">${e.message}</div>`;
    }
  };

  receiverBtn.addEventListener("click", searchByReceiver);
  receiverQuery.addEventListener("keydown", (e) => { if (e.key === "Enter") searchByReceiver(); });

  // Auto-load if ?code= in URL
  const params = new URLSearchParams(location.search);
  if (params.get("code")) {
    trackInput.value = params.get("code");
    searchByCode();
  }
};
