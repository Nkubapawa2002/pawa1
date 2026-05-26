// ─── Booking mode tab switch ────────────────────────────────────────────────
window.switchBookMode = (mode) => {
  document.querySelectorAll(".book-mode-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".book-panel").forEach(p => p.classList.remove("active"));
  document.getElementById(mode === "voice" ? "modeTabVoice" : "modeTabWeb").classList.add("active");
  document.getElementById(mode === "voice" ? "panelVoice" : "panelWeb").classList.add("active");
};

// ─── Voice booking (VAPI integration) ───────────────────────────────────────
window.initVoiceBooking = () => {
  const cfg       = window.APP_CONFIG;
  const callBtn   = document.getElementById("voiceCallBtn");
  const micRings  = document.getElementById("micRings");
  const statusBadge = document.getElementById("voiceStatusBadge");
  const statusText  = document.getElementById("voiceStatusText");
  const noKeyEl   = document.getElementById("voiceNoKey");
  const micIcon   = document.getElementById("micIcon");

  if (!cfg.VAPI_PUBLIC_KEY || !cfg.VAPI_ASSISTANT_ID) {
    if (noKeyEl) noKeyEl.style.display = "block";
    if (callBtn) callBtn.disabled = true;
    return;
  }

  let vapi = null;
  let callActive = false;

  function setStatus(state) {
    statusBadge.className = "voice-status-badge " + state;
    if (state === "calling") {
      statusText.textContent = window.t("voice_calling");
      callBtn.classList.add("calling");
      callBtn.classList.remove("active-call");
      micRings.classList.add("active");
    } else if (state === "active-call") {
      statusText.textContent = window.t("voice_active");
      callBtn.classList.remove("calling");
      callBtn.classList.add("active-call");
      micRings.classList.add("active");
      // Change mic icon to phone-off (end call)
      micIcon.innerHTML = `<line x1="1" y1="1" x2="23" y2="23"/><path d="M16.5 16.5L7.5 7.5M9 9a5 5 0 0 0-5 5v3a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2 1 1 0 0 1 1-1h4a1 1 0 0 1 1 1 2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a5 5 0 0 0-5-5"/>`;
    } else {
      statusText.textContent = window.t("voice_idle");
      callBtn.classList.remove("calling", "active-call");
      micRings.classList.remove("active");
      // Restore mic icon
      micIcon.innerHTML = `<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>`;
    }
  }

  callBtn.addEventListener("click", async () => {
    if (callActive) {
      vapi?.stop();
      return;
    }
    setStatus("calling");
    callActive = false;
    try {
      vapi = new window.Vapi(cfg.VAPI_PUBLIC_KEY);

      vapi.on("call-start", () => {
        callActive = true;
        setStatus("active-call");
      });

      vapi.on("call-end", () => {
        callActive = false;
        setStatus("idle");
      });

      vapi.on("error", (err) => {
        console.error("VAPI error:", err);
        callActive = false;
        setStatus("idle");
      });

      await vapi.start(cfg.VAPI_ASSISTANT_ID);
    } catch (err) {
      console.error("Could not start voice call:", err);
      callActive = false;
      setStatus("idle");
    }
  });
};

// ─── Check booking status by phone ──────────────────────────────────────────
window.checkVoiceBookingStatus = async () => {
  const phoneEl = document.getElementById("statusPhone");
  const resultEl = document.getElementById("statusResult");
  const phone = (phoneEl?.value || "").trim();
  if (!phone) return;

  resultEl.innerHTML = `<div class="banner info">${window.t("voice_checking")}</div>`;

  const sb = window.DataStore?.sb;
  let bookings = [];

  if (sb) {
    try {
      const normalized = phone.replace(/\s/g, "");
      const { data, error } = await sb
        .from("bookings")
        .select("*")
        .or(`passenger_phone.eq.${normalized},passenger_phone.eq.${phone}`)
        .order("created_at", { ascending: false })
        .limit(5);
      if (!error && data) bookings = data;
    } catch {}
  } else {
    const local = JSON.parse(localStorage.getItem("bookings_local") || "[]");
    bookings = local.filter(b => (b.passenger_phone || "").replace(/\s/g, "") === phone.replace(/\s/g, ""));
  }

  if (!bookings.length) {
    resultEl.innerHTML = `<div class="banner">${window.t("voice_no_booking")}</div>`;
    return;
  }

  resultEl.innerHTML = bookings.map(b => {
    const ph = (b.passenger_phone || "").replace(/\s/g, "");
    const callLink = ph
      ? `<a href="tel:${ph}" class="btn btn-outline btn-sm" style="margin-top:6px">📞 ${b.passenger_phone}</a>`
      : "";
    const tc  = b.ticket_code || b.tracking_code || "";
    const pfx = tc.split("-")[0];
    const prefixBadge = (pfx && pfx !== "TK")
      ? `<span style="font-family:monospace;font-size:0.65rem;font-weight:700;letter-spacing:1.5px;background:#e8f5e8;color:#0a6f4d;border:1px solid #86efac;border-radius:4px;padding:1px 6px;margin-left:6px;vertical-align:middle">${pfx}</span>`
      : "";
    return `
    <div class="booking-status-card">
      <div class="bk-code">${tc || "—"}${prefixBadge}</div>
      <div class="bk-row"><strong>${b.bus_name || "—"}</strong> &nbsp;·&nbsp; ${b.origin || "?"} → ${b.destination || "?"}</div>
      <div class="bk-row">${window.t("book_pick_date")}: <strong>${b.travel_date || "—"}</strong> &nbsp;·&nbsp; ${window.t("book_pick_dep")}: <strong>${b.departure_time || "—"}</strong></div>
      <div class="bk-row">${window.t("book_passenger_section")}: <strong>Seat ${b.seat_number || "—"}</strong></div>
      <div class="bk-row">${window.t("field_status")}: <strong>${b.status || "—"}</strong></div>
      ${b.fare_tzs ? `<div class="bk-row">${window.t("book_fare")}: <strong>${window.formatTZS(b.fare_tzs)}</strong></div>` : ""}
      ${callLink}
    </div>`;
  }).join("");
};

// ─── Seat-map booking page logic ─────────────────────────────────────────────
window.initBookPage = async () => {
  const busPicker    = document.getElementById("busPicker");
  const routePicker  = document.getElementById("routePicker");
  const datePicker   = document.getElementById("datePicker");
  const seatMapSec   = document.getElementById("seatMapSection");
  const seatGrid     = document.getElementById("seatGrid");
  const backBench    = document.getElementById("backBench");
  const fareDisplay  = document.getElementById("fareDisplay");
  const paxSection   = document.getElementById("passengerSection");
  const confirmBtn   = document.getElementById("confirmBtn");
  const seatDisplay  = document.getElementById("selectedSeatDisplay");
  const successBanner  = document.getElementById("successBanner");
  const ticketCode     = document.getElementById("ticketCode");
  const ticketDetails  = document.getElementById("ticketDetails");
  const pendingBanner  = document.getElementById("pendingBanner");
  const pendingDetails = document.getElementById("pendingDetails");
  const webPayStatus   = document.getElementById("webPayStatus");
  const banner         = document.getElementById("banner");

  let buses = [];
  let selectedBus   = null;
  let selectedRoute = null;
  let selectedSeat  = null;
  let takenSeats    = new Set();

  // Min date = today
  const today = new Date().toISOString().slice(0, 10);
  datePicker.min   = today;
  datePicker.value = today;

  try {
    buses = await window.DataStore.getBuses();
  } catch (e) {
    showBanner(e.message, "error");
    return;
  }

  buses.forEach(b => {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.name;
    busPicker.appendChild(opt);
  });

  // Pre-select bus from ?bus= param
  const busParam = new URLSearchParams(location.search).get("bus");
  if (busParam) {
    busPicker.value = busParam;
    onBusChange();
  }

  busPicker.addEventListener("change", onBusChange);
  routePicker.addEventListener("change", onSelectionChange);
  datePicker.addEventListener("change", onSelectionChange);
  confirmBtn.addEventListener("click", onConfirm);

  // ─── handlers ───────────────────────────────────────────────

  function onBusChange() {
    const id = busPicker.value;
    selectedBus   = buses.find(b => b.id === id) || null;
    selectedRoute = null;
    selectedSeat  = null;

    routePicker.innerHTML = `<option value="">${window.t("book_select_route")}</option>`;

    // Show bus-specific payment note if present
    const busPayNote = document.getElementById("busPaymentNote");
    if (busPayNote) {
      if (selectedBus?.payment_note) {
        busPayNote.textContent = selectedBus.payment_note;
        busPayNote.style.display = "block";
      } else {
        busPayNote.style.display = "none";
      }
    }

    if (!selectedBus) {
      seatMapSec.hidden = true;
      paxSection.hidden = true;
      return;
    }
    (selectedBus.routes || []).forEach((r, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = `${r.from} → ${r.to}  (${r.departure})`;
      routePicker.appendChild(opt);
    });

    onSelectionChange();
  }

  async function onSelectionChange() {
    const routeIdx = routePicker.value;
    const date     = datePicker.value;

    if (!selectedBus || routeIdx === "" || !date) {
      seatMapSec.hidden = true;
      paxSection.hidden = true;
      return;
    }

    selectedRoute = (selectedBus.routes || [])[Number(routeIdx)];
    selectedSeat  = null;
    paxSection.hidden = true;
    seatDisplay.style.display = "none";

    await loadTakenSeats(selectedBus.id, date, selectedRoute.departure);

    // Bus-full handling — every seat (1–50) taken
    const TOTAL_SEATS = 50;
    if (takenSeats.size >= TOTAL_SEATS) {
      seatMapSec.hidden = true;
      showBusFullBanner();
      return;
    }

    renderSeatMap();
    seatMapSec.hidden = false;
  }

  function showBusFullBanner() {
    let bf = document.getElementById("busFullInline");
    if (!bf) {
      bf = document.createElement("div");
      bf.id = "busFullInline";
      bf.className = "bus-full-card";
      const insertAfter = document.querySelector(".booking-pickers");
      insertAfter?.parentNode.insertBefore(bf, insertAfter.nextSibling);
    }
    // Build the next trip suggestion from the same route's other buses
    const sameRoute = (buses || []).flatMap(b =>
      (b.routes || [])
        .filter(r => r.from === selectedRoute.from && r.to === selectedRoute.to)
        .map(r => ({ bus_name: b.name, ...r, fare_tzs: Math.round((b.fare_per_km || 80) * (distKm(r.from, r.to) || 0)) }))
    ).filter(r => r.bus_name !== selectedBus.name).slice(0, 1);

    const next = sameRoute[0];
    const nextHtml = next
      ? `<strong>${next.bus_name}</strong> · ${next.from} → ${next.to} · ${next.departure} · ${window.formatTZS(next.fare_tzs)}`
      : window.t("fast_bus_full_sub");

    bf.innerHTML = `
      <h3>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <span>${window.t("fast_bus_full_title")}</span>
      </h3>
      <p>${window.t("fast_bus_full_sub")}</p>
      <div style="margin-top:10px;font-size:0.92rem;color:#78350f">${nextHtml}</div>
      <div class="bf-actions">
        <a href="book-fast.html" class="btn btn-primary">${window.t("fast_bus_full_yes")}</a>
        <button type="button" class="btn btn-outline" onclick="document.getElementById('busFullInline').remove()">${window.t("fast_bus_full_no")}</button>
      </div>
    `;
  }

  let heldSeats = new Set();

  async function loadTakenSeats(busId, date, departure) {
    takenSeats = new Set();
    heldSeats  = new Set();
    const sb = window.DataStore.sb;
    if (sb) {
      try {
        const { data, error } = await sb
          .from("bookings")
          .select("seat_number, status")
          .eq("bus_id", busId)
          .eq("travel_date", date)
          .eq("departure_time", departure)
          .neq("status", "cancelled")
          .neq("status", "expired");
        if (!error && data) {
          data.forEach(r => {
            if (r.status === "pending") heldSeats.add(r.seat_number);
            else takenSeats.add(r.seat_number);
          });
        }
      } catch {}
    } else {
      const stored = JSON.parse(localStorage.getItem("bookings_local") || "[]");
      stored
        .filter(b =>
          b.bus_id === busId &&
          b.travel_date === date &&
          b.departure_time === departure &&
          b.status !== "cancelled" &&
          b.status !== "expired"
        )
        .forEach(b => {
          if (b.status === "pending") heldSeats.add(b.seat_number);
          else takenSeats.add(b.seat_number);
        });
    }
  }

  // ─── seat map renderer ───────────────────────────────────────

  function renderSeatMap() {
    seatGrid.innerHTML  = "";
    backBench.innerHTML = "";

    // 12 rows × 4 seats = 48 seats (2-aisle-2 layout)
    for (let row = 0; row < 12; row++) {
      const rowDiv = document.createElement("div");
      rowDiv.className = "seat-row";
      for (let col = 0; col < 4; col++) {
        // Insert aisle gap before col 2
        if (col === 2) {
          const spacer = document.createElement("div");
          spacer.className = "seat-aisle";
          rowDiv.appendChild(spacer);
        }
        const seatNum = row * 4 + col + 1;
        rowDiv.appendChild(buildSeat(seatNum));
      }
      seatGrid.appendChild(rowDiv);
    }

    // Back bench: 2 central seats (49, 50)
    for (let n = 49; n <= 50; n++) backBench.appendChild(buildSeat(n));

    // Fare estimate
    const dist = distKm(selectedRoute.from, selectedRoute.to);
    const fare = dist ? Math.round((selectedBus.fare_per_km || 80) * dist) : 0;
    if (fare) {
      fareDisplay.textContent = `${window.t("book_fare")}: TZS ${fare.toLocaleString()} · ${selectedRoute.from} → ${selectedRoute.to}`;
      fareDisplay.hidden = false;
    } else {
      fareDisplay.hidden = true;
    }
  }

  function buildSeat(num) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "seat";
    btn.dataset.seat = num;
    btn.textContent = num;
    if (takenSeats.has(num)) {
      btn.classList.add("taken");
      btn.disabled = true;
      btn.title = window.t("book_seat_legend_taken");
    } else if (heldSeats.has(num)) {
      btn.classList.add("held");
      btn.disabled = true;
      btn.title = window.t("book_seat_legend_held");
    } else {
      btn.classList.add("free");
      btn.addEventListener("click", () => onSeatPick(num, btn));
    }
    return btn;
  }

  function onSeatPick(num, el) {
    // clear previous selection
    [seatGrid, backBench].forEach(container => {
      container.querySelectorAll(".seat.selected").forEach(s => {
        s.classList.replace("selected", "free");
      });
    });

    selectedSeat = num;
    el.classList.replace("free", "selected");

    seatDisplay.textContent = `Seat ${num}`;
    seatDisplay.style.display = "";
    paxSection.hidden = false;
    paxSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ─── confirm ─────────────────────────────────────────────────

  async function onConfirm() {
    if (!selectedSeat) { showBanner(window.t("book_pick_seat"), "warn"); return; }

    const name           = document.getElementById("paxName").value.trim();
    const phone          = document.getElementById("paxPhone").value.trim();
    const idNo           = document.getElementById("paxId").value.trim();
    const tripPurpose    = document.getElementById("paxTripPurpose").value || null;
    const returnDuration = document.getElementById("paxReturnDuration").value || null;

    if (!name || !phone) { showBanner("Please fill in name and phone.", "warn"); return; }

    confirmBtn.disabled   = true;
    confirmBtn.textContent = window.t("book_booking");

    const date = datePicker.value;
    const dist = distKm(selectedRoute.from, selectedRoute.to);
    const fare = dist ? Math.round((selectedBus.fare_per_km || 80) * dist) : 0;

    try {
      const sb   = window.DataStore.sb;
      let code;

      if (sb) {
        // Atomic: generate company ticket code + insert booking in one DB call
        const { data: claimed, error } = await sb.rpc("claim_ticket", {
          p_bus_id:          selectedBus.id,
          p_seat_number:     parseInt(selectedSeat, 10),
          p_travel_date:     date,
          p_departure_time:  selectedRoute.departure,
          p_origin:          selectedRoute.from,
          p_destination:     selectedRoute.to,
          p_passenger_name:  name,
          p_passenger_phone: phone,
          p_passenger_id_no: idNo || null,
          p_fare_tzs:        fare,
          p_trip_purpose:    tripPurpose,
          p_return_duration: returnDuration
        });
        if (error) throw error;
        code = claimed.ticket_code;
      } else {
        // Offline fallback (demo/localStorage)
        code = generateTicketCode(selectedBus.id, date, selectedSeat);
        const local = JSON.parse(localStorage.getItem("bookings_local") || "[]");
        local.push({
          ticket_code: code, bus_id: selectedBus.id, bus_name: selectedBus.name,
          origin: selectedRoute.from, destination: selectedRoute.to,
          travel_date: date, departure_time: selectedRoute.departure,
          seat_number: selectedSeat, passenger_name: name, passenger_phone: phone,
          passenger_id_no: idNo || null, fare_tzs: fare,
          trip_purpose: tripPurpose, return_duration: returnDuration,
          status: "pending", id: Date.now(), created_at: new Date().toISOString()
        });
        localStorage.setItem("bookings_local", JSON.stringify(local));
      }

      // Hide form, show pending payment panel — NO ticket yet
      seatMapSec.hidden    = true;
      paxSection.hidden    = true;
      pendingBanner.hidden = false;
      pendingDetails.innerHTML =
        `<strong>${selectedBus.name}</strong> · ${selectedRoute.from} → ${selectedRoute.to} ·
         Seat <strong>${selectedSeat}</strong>${fare ? ` · <strong>${window.formatTZS(fare)}</strong>` : ""}`;
      pendingBanner.scrollIntoView({ behavior: "smooth" });

      // ── Validate payment ──────────────────────────────────
      function showTicket() {
        pendingBanner.hidden = true;
        ticketCode.textContent = code;
        ticketDetails.innerHTML = `
          <p><strong>${selectedBus.name}</strong></p>
          <p>${selectedRoute.from} &rarr; ${selectedRoute.to}</p>
          <p>${window.t("book_pick_date")}: <strong>${date}</strong> &nbsp;|&nbsp;
             ${window.t("book_pick_dep")}: <strong>${selectedRoute.departure}</strong></p>
          <p>Seat: <strong>${selectedSeat}</strong> &nbsp;|&nbsp; ${name} &nbsp;|&nbsp; ${phone}</p>
          ${fare ? `<p>${window.t("book_fare")}: <strong>${window.formatTZS(fare)}</strong></p>` : ""}`;
        successBanner.hidden = false;
        successBanner.scrollIntoView({ behavior: "smooth" });
      }

      document.getElementById("webValidatePayBtn").onclick = async () => {
        webPayStatus.innerHTML = `<span class="pay-status-pill checking">Checking payment…</span>`;
        let confirmed = false;
        if (sb) {
          try {
            const { data } = await sb.from("bookings").select("status")
              .eq("ticket_code", code).maybeSingle();
            confirmed = data?.status === "confirmed";
          } catch {}
        } else {
          // Offline demo: always succeed
          confirmed = true;
          const local = JSON.parse(localStorage.getItem("bookings_local") || "[]");
          const idx = local.findIndex(b => b.ticket_code === code);
          if (idx >= 0) { local[idx].status = "confirmed"; localStorage.setItem("bookings_local", JSON.stringify(local)); }
        }
        if (confirmed) {
          showTicket();
        } else {
          webPayStatus.innerHTML = `<span class="pay-status-pill failed">Payment not confirmed yet — pay first then try again.</span>`;
        }
      };

      document.getElementById("webCancelHoldBtn").onclick = async () => {
        if (!confirm("Cancel this seat hold? The seat will be released.")) return;
        if (sb) {
          await sb.from("bookings").update({ status: "cancelled" }).eq("ticket_code", code).catch(() => {});
        } else {
          const local = JSON.parse(localStorage.getItem("bookings_local") || "[]");
          const idx = local.findIndex(b => b.ticket_code === code);
          if (idx >= 0) { local[idx].status = "cancelled"; localStorage.setItem("bookings_local", JSON.stringify(local)); }
        }
        pendingBanner.hidden = true;
        seatMapSec.hidden    = false;
        await onSelectionChange();
        showBanner("Seat released. Choose another seat.", "warn");
      };

    } catch (e) {
      showBanner(e.message, "error");
    } finally {
      confirmBtn.disabled    = false;
      confirmBtn.textContent = window.t("book_confirm");
    }
  }

  // ─── helpers ─────────────────────────────────────────────────

  function showBanner(msg, type = "error") {
    banner.textContent = msg;
    banner.className   = `banner ${type}`;
    banner.style.display = "block";
    setTimeout(() => { banner.style.display = "none"; }, 5000);
  }

  function generateTicketCode(busId, date, seat) {
    const d = date.replace(/-/g, "");
    const s = String(seat).padStart(2, "0");
    const r = String(Math.floor(Math.random() * 900) + 100);
    return `TK-${busId}-${d}-S${s}-${r}`;
  }
};

// Approximate road distances (km) between major Tanzania cities
function distKm(from, to) {
  const D = {
    "Dar es Salaam-Arusha": 680,
    "Dar es Salaam-Moshi": 550,
    "Dar es Salaam-Morogoro": 195,
    "Dar es Salaam-Mbeya": 900,
    "Dar es Salaam-Mwanza": 1250,
    "Dar es Salaam-Tanga": 360,
    "Dar es Salaam-Dodoma": 450,
    "Dar es Salaam-Bukoba": 1600,
    "Dar es Salaam-Iringa": 500,
    "Arusha-Mwanza": 700,
    "Arusha-Dodoma": 480,
    "Arusha-Moshi": 80,
    "Moshi-Mwanza": 800,
    "Mbeya-Iringa": 300,
    "Morogoro-Mbeya": 705,
    "Tanga-Moshi": 280,
  };
  const key = `${from}-${to}`;
  const rev = `${to}-${from}`;
  return D[key] || D[rev] || 0;
}
