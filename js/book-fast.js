// ============================================================================
//  Book Seat Fast — AI voice-agentic booking
//
//  Flow:
//    1. Load buses from Supabase → render picker cards
//    2. User selects a bus → unlock call section, pass context to agent
//    3. VAPI browser call  OR  n8n webhook → Africa's Talking real call
//    4. Supabase Realtime watches passenger_phone → reveal ticket instantly
// ============================================================================

window.initBookFastPage = () => {
  const cfg = window.APP_CONFIG || {};
  const sb  = window.DataStore?.sb;

  // ── DOM refs ─────────────────────────────────────────────────────────────────
  const busGrid       = document.getElementById('busGrid');
  const busSearch     = document.getElementById('busSearch');
  const seatSection   = document.getElementById('seatSection');
  const callSection   = document.getElementById('callSection');
  const callLocked    = document.getElementById('callLocked');
  const routePicker   = document.getElementById('routePicker');
  const datePicker    = document.getElementById('datePicker');
  const seatSummary   = document.getElementById('seatSummary');
  const seatGrid      = document.getElementById('seatGrid');
  const proceedCallBtn= document.getElementById('proceedCallBtn');
  const bannerIcon        = document.getElementById('bannerIcon');
  const bannerName        = document.getElementById('bannerName');
  const bannerRoutes      = document.getElementById('bannerRoutes');
  const changeBusBtn      = document.getElementById('changeBusBtn');
  const virtualNumDisplay = document.getElementById('virtualNumDisplay');
  const virtualNumLink    = document.getElementById('virtualNumLink');
  const virtualNumCallBtn = document.getElementById('virtualNumCallBtn');
  const noVirtualNum      = document.getElementById('noVirtualNum');
  const providerLabel     = document.getElementById('providerLabel');
  const providerIcon      = document.getElementById('providerIcon');
  const smsProviderLabel  = document.getElementById('smsProviderLabel');
  const phoneEl           = document.getElementById('userPhone');
  const callBtn       = document.getElementById('callAgentBtn');
  const callLabel     = document.getElementById('callLabel');
  const callSub       = document.getElementById('callSub');
  const cbBtn         = document.getElementById('requestCallBtn');
  const cbMsg         = document.getElementById('callbackMsg');
  const noKeyEl       = document.getElementById('voiceNoKey');
  const ticketReveal  = document.getElementById('ticketReveal');
  const ticketDetails = document.getElementById('ticketDetails');

  // Pre-fill phone from URL
  const urlPhone = new URLSearchParams(location.search).get('phone');
  if (urlPhone && phoneEl) phoneEl.value = urlPhone;

  // ── VAPI config check ─────────────────────────────────────────────────────
  const voiceOk = !!(cfg.VAPI_PUBLIC_KEY && cfg.VAPI_ASSISTANT_ID);
  if (!voiceOk && noKeyEl) noKeyEl.hidden = false;

  // ── Virtual phone number setup ────────────────────────────────────────────
  const virtNum = cfg.VIRTUAL_PHONE_NUMBER || '';
  const virtDisplay = cfg.VIRTUAL_PHONE_DISPLAY || virtNum;
  if (virtNum) {
    if (virtualNumDisplay) virtualNumDisplay.textContent = virtDisplay;
    if (virtualNumLink)    virtualNumLink.href    = 'tel:' + virtNum.replace(/\s/g, '');
    if (virtualNumCallBtn) virtualNumCallBtn.href = 'tel:' + virtNum.replace(/\s/g, '');
    if (noVirtualNum)      noVirtualNum.hidden = true;
  } else {
    if (noVirtualNum)      noVirtualNum.hidden = false;
    if (document.getElementById('virtualNumBlock'))
      document.getElementById('virtualNumBlock').style.display = 'none';
  }

  // Provider badge
  const provider = (cfg.SMS_PROVIDER || 'africas_talking').toLowerCase();
  const isAT     = provider === 'africas_talking';
  const isTwilio = provider === 'twilio';
  if (providerIcon)    providerIcon.textContent  = isAT ? '📡' : isTwilio ? '🔵' : '📡';
  if (providerLabel)   providerLabel.textContent  = isAT
    ? "Africa's Talking · VAPI AI"
    : isTwilio
    ? 'Twilio · VAPI AI'
    : 'Voice AI · 24/7';
  if (smsProviderLabel) smsProviderLabel.textContent = isAT ? "Africa's Talking" : isTwilio ? 'Twilio' : 'SMS';

  // ── State ─────────────────────────────────────────────────────────────────
  let allBuses      = [];   // raw from DB
  let selectedBus   = null; // { id, name, routes, photo_path, ... }
  let selectedRoute = null; // { from, to, departure, duration_hours }
  let selectedDate  = '';
  let vapi          = null;
  let active        = false;
  let realtimeCh    = null;

  // Client-side seat hold (UX only — actual DB hold happens via the AI agent).
  // 12 min 54 sec — must match the voice agent (n8n reserve_seat workflow
  // uses `now() + interval '12 minutes 54 seconds'`) and the VAPI assistant
  // prompt, so what the user sees ticking matches what the AI promised.
  const HOLD_SECONDS = 12 * 60 + 54;
  const HOLD_LS_KEY  = "pawa_active_hold_v1";   // localStorage key used to resume
                                                // the timer across page reloads.

  // ── Pay-now section refs ────────────────────────────────────────────────
  const paySection         = document.getElementById('paySection');
  const paySummary         = document.getElementById('paySummary');
  const payAmountEl        = document.getElementById('payAmount');
  const payMethodGrid      = document.getElementById('payMethodGrid');
  const payPhoneWrap       = document.getElementById('payPhoneWrap');
  const payPhoneEl         = document.getElementById('payPhone');
  const payPhoneNote       = document.getElementById('payPhoneNote');
  const payDiffTicketToggle = document.getElementById('payDiffTicketToggle');
  const payTicketPhoneWrap = document.getElementById('payTicketPhoneWrap');
  const payTicketPhoneEl   = document.getElementById('payTicketPhone');
  const payNowBtn          = document.getElementById('payNowBtn');
  const payStatus          = document.getElementById('payStatus');

  // Tanzania mobile-money methods (kind="mobile" in HTML). For these the
  // gateway sends a USSD push to whatever number the user enters.
  const MOBILE_METHODS = new Set(['mpesa','tigopesa','airtel','halopesa','azampesa']);
  let payChosenMethod  = null;       // 'mpesa' | 'card' | …
  let payInFlight      = false;       // prevents double-clicks
  let payPollTimer     = null;
  let heldSeat       = null;   // seat number currently held by this visitor
  let holdEndsAt     = 0;      // epoch ms — when this hold expires
  let holdTimerId    = null;   // interval id

  // ── Route summary card ────────────────────────────────────────────────────
  const routeCard       = document.getElementById('routeCard');
  const routeFromEl     = document.getElementById('routeFrom');
  const routeToEl       = document.getElementById('routeTo');
  const routeDateEl     = document.getElementById('routeDate');
  const routeDepartEl   = document.getElementById('routeDeparture');
  const routeArriveEl   = document.getElementById('routeArrival');
  const routeDurEl      = document.getElementById('routeDuration');
  const holdBanner      = document.getElementById('holdCountdown');
  const holdSeatNumEl   = document.getElementById('heldSeatNum');
  const holdTimeEl      = document.getElementById('holdCountdownTime');
  const holdBarEl       = document.getElementById('holdCountdownBar');
  const releaseSeatBtn  = document.getElementById('releaseSeatBtn');

  function fmtTime(t) {
    // Accept "07:30", "0730", "7:30 AM" — return as-is if already formatted.
    if (!t) return '—';
    const s = String(t).trim();
    if (/^\d{1,2}:\d{2}/.test(s)) return s.length === 4 ? '0' + s : s;
    if (/^\d{4}$/.test(s)) return s.slice(0,2) + ':' + s.slice(2);
    return s;
  }
  function addHours(timeStr, hours) {
    // Add `hours` (decimal) to a "HH:MM" departure time; return "HH:MM".
    const m = /^(\d{1,2}):(\d{2})/.exec(timeStr || '');
    if (!m || !hours) return '—';
    const total = parseInt(m[1]) * 60 + parseInt(m[2]) + Math.round(hours * 60);
    const h = Math.floor((total / 60) % 24);
    const mm = total % 60;
    return String(h).padStart(2,'0') + ':' + String(mm).padStart(2,'0');
  }
  function fmtDateNice(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString(undefined, { weekday:'short', day:'numeric', month:'short' });
  }
  function renderRouteCard() {
    if (!routeCard) return;
    if (!selectedRoute) { routeCard.hidden = true; return; }
    routeCard.hidden = false;
    routeFromEl.textContent   = selectedRoute.from || '—';
    routeToEl.textContent     = selectedRoute.to   || '—';
    routeDateEl.textContent   = fmtDateNice(selectedDate);
    routeDepartEl.textContent = fmtTime(selectedRoute.departure);
    routeArriveEl.textContent = addHours(selectedRoute.departure, selectedRoute.duration_hours);
    routeDurEl.textContent    = selectedRoute.duration_hours ? `${selectedRoute.duration_hours} h` : '—';
  }

  // ── Seat hold + countdown ─────────────────────────────────────────────────
  // The hold is now a REAL row in `bookings` with status='awaiting_payment'
  // and expires_at = now() + 12:09. This makes the seat appear as taken to
  // every other visitor immediately (via Realtime). When the timer hits 0
  // — or the user releases it explicitly — we flip status='expired' so the
  // seat goes back to available. The voice agent later upgrades this same
  // row to status='confirmed' on successful payment.
  let heldRowId = null;   // bookings.id of the current held row (if any)

  function fmtCountdown(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return String(m).padStart(2,'0') + ':' + String(r).padStart(2,'0');
  }

  function genHoldTicketCode() {
    // Tiny human-readable code so the AI agent can look up the held row.
    // Real ticket code is issued by the agent once payment clears.
    return 'HOLD-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  async function holdSeat(seatNum) {
    if (!selectedBus || !selectedRoute || !selectedDate) return;
    if (!sb) {
      // Offline fallback: keep the old client-only hold.
      heldSeat = seatNum;
      holdEndsAt = Date.now() + HOLD_SECONDS * 1000;
      showHoldBanner(seatNum);
      startTicker();
      loadSeatMap();
      return;
    }

    // Optimistic UI: show the hold immediately, persist in the background.
    // We use a provisional client-side deadline until the INSERT returns,
    // then snap to the server's `expires_at` so the displayed countdown is
    // always the same as the deadline stored in the bookings row.
    heldSeat   = seatNum;
    holdEndsAt = Date.now() + HOLD_SECONDS * 1000;
    heldRowId  = null;
    showHoldBanner(seatNum);
    startTicker();
    loadSeatMap();

    const phone = (phoneEl?.value || '').trim() || 'pending-hold';
    const provisionalExpiry = new Date(holdEndsAt).toISOString();
    const payload = {
      ticket_code:    genHoldTicketCode(),
      bus_id:         selectedBus.id,
      bus_name:       selectedBus.name,
      origin:         selectedRoute.from,
      destination:    selectedRoute.to,
      travel_date:    selectedDate,
      departure_time: selectedRoute.departure || '',
      seat_number:    seatNum,
      passenger_name: 'HOLD',
      passenger_phone: phone,
      fare_tzs:       0,
      status:         'awaiting_payment',
      expires_at:     provisionalExpiry
    };

    const { data, error } = await sb.from('bookings')
      .insert(payload).select('id, expires_at').single();
    if (error) {
      // The most likely failure is a uniqueness conflict (someone else
      // beat us to the seat in the same second). Roll back the visual hold.
      heldSeat = null; holdEndsAt = 0;
      stopTicker();
      holdBanner.hidden = true;
      // For the conflict case, offer the find-next-trip cascade immediately
      // rather than just alerting — the rider's next click would otherwise
      // probably hit the same race.
      const isConflict = error.code === '23505' || /duplicate|unique/i.test(error.message || '');
      if (isConflict) {
        const tryNext = confirm(`Seat ${seatNum} was just taken by someone else. Would you like us to find the next available trip on this route?`);
        if (tryNext) { await loadSeatMap(); tryNextAvailableTrip(); return; }
      } else {
        alert('Could not hold seat ' + seatNum + ': ' + error.message);
      }
      loadSeatMap();
      return;
    }
    heldRowId  = data?.id || null;
    // Snap the visible timer to the authoritative server timestamp.
    if (data?.expires_at) {
      holdEndsAt = new Date(data.expires_at).getTime();
      updateCountdown();
    }
    // Persist so a refresh doesn't lose the hold mid-window.
    saveHoldToLS({
      rowId:   heldRowId,
      seatNum: heldSeat,
      endsAt:  holdEndsAt,
      busId:   selectedBus.id,
      date:    selectedDate,
    });
    // Open the pay-now flow as soon as the hold is locked in.
    await showPaySection();
  }

  // ── Pay-now flow ─────────────────────────────────────────────────────────
  // The flow:
  //   1. Show summary + suggested fare + Tanzania payment methods.
  //   2. User picks a method; for mobile-money methods, an extra phone input
  //      appears so they can pay from a different number than the booking.
  //   3. Pay click → write fare onto the bookings row → call the
  //      create-payment edge function with reference=ticket_code → poll
  //      bookings.status until 'confirmed' (or the hold expires).
  //
  // Why we don't do USSD client-side: the actual push happens server-side
  // in the create-payment edge function, which routes to whichever gateway
  // owns the chosen method (Selcom / ClickPesa / AzamPay / Flutterwave).
  //
  async function showPaySection() {
    if (!paySection || !heldSeat || !selectedBus || !selectedRoute) return;
    paySection.hidden = false;

    // Summary text
    const date   = fmtDateNice(selectedDate) || selectedDate;
    const dep    = fmtTime(selectedRoute.departure);
    paySummary.innerHTML = `
      <div>🚌 <strong>${selectedBus.name}</strong> &middot; Seat <strong>#${heldSeat}</strong></div>
      <div>📍 ${selectedRoute.from} → ${selectedRoute.to} &middot; ${date} &middot; ${dep}</div>
      <div>🎟️ Ticket reference will be the held-row code once confirmed.</div>
    `;

    // Prefill fare from history; user can override before paying.
    const est = await estimateFare(selectedBus, selectedRoute);
    payAmountEl.value = est;

    // Prefill paying phone with the user's phone if set.
    if (payPhoneEl && !payPhoneEl.value && phoneEl?.value) {
      payPhoneEl.value = phoneEl.value.trim();
    }
    refreshPayBtnState();
  }

  function hidePaySection() {
    if (!paySection) return;
    paySection.hidden = true;
    payChosenMethod = null;
    payMethodGrid?.querySelectorAll('.pay-method.selected').forEach(b => b.classList.remove('selected'));
    if (payStatus) { payStatus.hidden = true; payStatus.textContent = ''; }
    if (payPollTimer) { clearInterval(payPollTimer); payPollTimer = null; }
    payInFlight = false;
  }

  // Suggested fare. Strategy:
  //   1. Median of recent confirmed/pending bookings on the same
  //      (bus_id, origin, destination, departure_time).
  //   2. Fallback to fare_per_km * 200 (rough 200km baseline).
  //   3. Floor of 15 000 TZS.
  async function estimateFare(bus, route) {
    if (!sb) {
      const fpkm = Number(bus?.fare_per_km) || 80;
      return Math.max(15000, Math.round(fpkm * 200 / 500) * 500);
    }
    try {
      const { data } = await sb.from('bookings')
        .select('fare_tzs')
        .eq('bus_id', bus.id)
        .eq('origin', route.from)
        .eq('destination', route.to)
        .eq('departure_time', route.departure || '')
        .in('status', ['confirmed','pending','rescheduled'])
        .gt('fare_tzs', 0)
        .order('created_at', { ascending: false })
        .limit(20);
      const fares = (data || []).map(r => Number(r.fare_tzs)).filter(n => n > 0);
      if (fares.length) {
        fares.sort((a,b) => a-b);
        return fares[Math.floor(fares.length/2)];
      }
    } catch { /* fall through */ }
    const fpkm = Number(bus?.fare_per_km) || 80;
    return Math.max(15000, Math.round(fpkm * 200 / 500) * 500);
  }

  // Method-select click delegation.
  payMethodGrid?.addEventListener('click', (e) => {
    const btn = e.target.closest('.pay-method');
    if (!btn) return;
    payMethodGrid.querySelectorAll('.pay-method.selected').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    payChosenMethod = btn.dataset.method;
    const kind = btn.dataset.kind;
    // Mobile-money asks for the paying phone. Card/bank flows skip it.
    if (payPhoneWrap) payPhoneWrap.style.display = (kind === 'mobile') ? '' : 'none';
    refreshPayBtnState();
  });

  [payAmountEl, payPhoneEl, payTicketPhoneEl].forEach(el => el?.addEventListener('input', refreshPayBtnState));

  // Toggle: "Send ticket to a different number".
  payDiffTicketToggle?.addEventListener('change', () => {
    if (!payTicketPhoneWrap) return;
    payTicketPhoneWrap.hidden = !payDiffTicketToggle.checked;
    if (!payDiffTicketToggle.checked && payTicketPhoneEl) payTicketPhoneEl.value = "";
    refreshPayBtnState();
  });

  function refreshPayBtnState() {
    if (!payNowBtn) return;
    const amt   = Number(payAmountEl?.value || 0);
    const phone = (payPhoneEl?.value || '').trim();
    const needsPhone   = MOBILE_METHODS.has(payChosenMethod);
    const wantDiffTix  = !!payDiffTicketToggle?.checked;
    const ticketPhone  = (payTicketPhoneEl?.value || '').trim();
    const ok =
      !!heldRowId &&
      !!payChosenMethod &&
      amt >= 1000 &&
      (!needsPhone || phone.length >= 9) &&
      (!wantDiffTix || ticketPhone.length >= 9);
    payNowBtn.disabled = !ok || payInFlight;
  }

  function showPayStatus(kind, text) {
    if (!payStatus) return;
    payStatus.hidden = false;
    payStatus.className = 'pay-status ' + kind;
    payStatus.textContent = text;
  }

  payNowBtn?.addEventListener('click', async () => {
    if (!heldRowId || !payChosenMethod) return;
    if (payInFlight) return;
    payInFlight = true; refreshPayBtnState();

    const amount  = Number(payAmountEl.value);
    const phone   = (payPhoneEl?.value || phoneEl?.value || '').trim();
    const needsPhone = MOBILE_METHODS.has(payChosenMethod);
    if (needsPhone && phone.length < 9) {
      showPayStatus('err', 'Tafadhali ingiza namba ya simu inayolipa (mfano +255712345678).');
      payInFlight = false; refreshPayBtnState(); return;
    }

    showPayStatus('info', 'Inatuma USSD push… angalia simu yako.');

    // 1. Decide which phone receives the SMS ticket. Default to the
    //    paying phone, unless the rider toggled the override.
    const wantsDiffTicket = !!payDiffTicketToggle?.checked;
    const ticketPhoneRaw  = (payTicketPhoneEl?.value || '').trim();
    const ticketPhone     = wantsDiffTicket && ticketPhoneRaw ? ticketPhoneRaw : phone;

    // Write the agreed fare + receive phone onto the bookings row before
    // payment. The booking's ticket_code is used as the payment reference.
    let bookingRow = null;
    try {
      const updates = { fare_tzs: amount, passenger_phone: ticketPhone };
      const { data, error } = await sb.from('bookings')
        .update(updates)
        .eq('id', heldRowId)
        .eq('status', 'awaiting_payment')
        .select('id, ticket_code, passenger_phone, fare_tzs')
        .single();
      if (error) throw error;
      bookingRow = data;
    } catch (err) {
      showPayStatus('err', 'Sikuweza kuhifadhi bei kwenye booking: ' + (err.message || err));
      payInFlight = false; refreshPayBtnState();
      return;
    }

    // 2. Call the create-payment edge function. We use the SDK so the anon
    //    key + project URL are picked up automatically.
    const payload = {
      reference:       bookingRow.ticket_code,
      reference_type:  'booking',
      amount_tzs:      amount,
      method:          payChosenMethod,
      phone:           needsPhone ? phone : (bookingRow.passenger_phone || phone),
      customer_name:   (document.getElementById('passengerName')?.value || '').trim() || 'Pawa rider',
      description:     `Bus ticket ${selectedBus?.name || ''} · Seat ${heldSeat}`,
    };

    let fnRes;
    try {
      fnRes = await sb.functions.invoke('create-payment', { body: payload });
    } catch (err) {
      fnRes = { error: err };
    }
    if (fnRes.error) {
      const msg = fnRes.error?.message || String(fnRes.error);
      showPayStatus('err',
        'Gateway haikuweza kupokea ombi: ' + msg +
        '. Hakikisha edge function create-payment ime-deploy.');
      payInFlight = false; refreshPayBtnState();
      return;
    }

    const next = fnRes.data || {};
    if (next.payment_url) {
      // Card / web-redirect provider returned a URL to load.
      showPayStatus('info', 'Inafungua dirisha la malipo…');
      window.open(next.payment_url, '_blank', 'noopener');
    } else if (next.status === 'completed') {
      // Demo provider short-circuit — payment is already done.
      showPayStatus('info', 'Inaangalia hali ya malipo…');
    } else if (needsPhone) {
      // Real USSD push went out. Keep the message in front of them until
      // the poller flips to confirmed, including a step-by-step prompt.
      showPayStatus('warn',
        `📲 USSD push imetumwa kwa ${phone}.\n` +
        `Hatua 1: angalia simu yako ya rununu.\n` +
        `Hatua 2: ingiza PIN yako ya M-Pesa / mtandao uliouchagua.\n` +
        `Hatua 3: thibitisha kiasi cha TZS ${Number(amount).toLocaleString()}.\n` +
        `Subiri sekunde 10–30 tukamilishe malipo na kukutumia tiketi kwa SMS.`);
      // Keep the message visible while we poll; don't auto-dismiss.
      if (payStatus) payStatus.style.whiteSpace = 'pre-line';
    } else {
      showPayStatus('info', 'Ombi la malipo limetumwa. Inangoja gateway ithibitishe…');
    }

    // 3. Poll the booking status. We watch the bookings row (since the
    //    gateway callback eventually flips status='confirmed'). Poll every
    //    3 s; stop on confirmed/expired/cancelled OR when hold expires.
    if (payPollTimer) clearInterval(payPollTimer);
    payPollTimer = setInterval(pollBookingStatus, 3000);
    setTimeout(pollBookingStatus, 800);  // first check shortly after push
  });

  async function pollBookingStatus() {
    if (!heldRowId || !sb) { clearInterval(payPollTimer); payPollTimer = null; return; }
    const { data, error } = await sb.from('bookings')
      .select('id, ticket_code, status, fare_tzs, seat_number, bus_name, expires_at, travel_date, departure_time, passenger_phone')
      .eq('id', heldRowId)
      .maybeSingle();
    if (error || !data) return;

    if (data.status === 'confirmed' || data.status === 'paid') {
      clearInterval(payPollTimer); payPollTimer = null;
      showPayStatus('ok',
        `✅ Malipo yamekamilika! Tiketi: ${data.ticket_code}. SMS ya tiketi itafika hivi karibuni.`);
      revealTicket(data);
      // Don't auto-release — the hold row is now confirmed.
      clearHoldFromLS();
      stopTicker();
      holdBanner.hidden = true;
      payInFlight = false;
    } else if (data.status === 'expired' || data.status === 'cancelled' || data.status === 'failed') {
      clearInterval(payPollTimer); payPollTimer = null;
      showPayStatus('err',
        'Malipo hayakukamilika — booking ni ' + data.status + '. Tafadhali shika kiti tena na ujaribu.');
      payInFlight = false; refreshPayBtnState();
    } else if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
      clearInterval(payPollTimer); payPollTimer = null;
      showPayStatus('err', 'Muda wa hifadhi umekwisha. Shika kiti tena.');
      payInFlight = false; refreshPayBtnState();
    }
    // else: still pending/awaiting_payment — keep polling.
  }

  // Surface the confirmed booking using the existing ticketReveal markup.
  function revealTicket(row) {
    const reveal = document.getElementById('ticketReveal');
    const body   = document.getElementById('ticketDetails');
    if (!reveal || !body) return;
    body.innerHTML = `
      <div><strong>Ticket:</strong> ${row.ticket_code}</div>
      <div><strong>Seat:</strong> #${row.seat_number} on ${row.bus_name}</div>
      <div><strong>Fare:</strong> TZS ${Number(row.fare_tzs).toLocaleString()}</div>
    `;
    reveal.hidden = false;
    renderReminderCard(row);
    reveal.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ── Trip-reminder picker ────────────────────────────────────────────────
  // Section 53 of the schema gives every confirmed booking a 'default'
  // reminder (mandatory, departure − 2 h) plus an optional 'custom' reminder
  // the rider can add on top. The custom reminder is ADDITIVE — cancelling
  // it leaves the default firing. The UI mirrors this with two clearly
  // separated rows.
  function renderReminderCard(row) {
    const card = document.getElementById('reminderCard');
    if (!card) return;
    card.hidden = false;
    card.dataset.bookingId = row.id;
    card.dataset.depMs     = String(computeDepartureMs(row.travel_date, row.departure_time) || '');
    const phoneNote = document.getElementById('reminderPhoneNote');
    if (phoneNote) phoneNote.textContent = row.passenger_phone || 'the phone on file';
    refreshReminderRows(row.id);
  }

  function computeDepartureMs(dateStr, timeStr) {
    if (!dateStr || !timeStr) return 0;
    const m = String(timeStr).match(/(\d{1,2}):(\d{2})/);
    if (!m) return 0;
    // Best-effort local construction; the server stores in Africa/Dar.
    // Display-only — write-back uses the rider's local picker so the user
    // sees the same time they intended.
    const d = new Date(String(dateStr) + 'T' + m[1].padStart(2,'0') + ':' + m[2] + ':00');
    const t = d.getTime();
    return isNaN(t) ? 0 : t;
  }

  function fmtDateTime(d) {
    if (!d) return '—';
    return new Intl.DateTimeFormat(undefined, {
      weekday:'short', day:'numeric', month:'short',
      hour:'2-digit', minute:'2-digit', hour12:false,
    }).format(d);
  }

  function setReminderStatus(kind, msg, ttl = 3000) {
    const el = document.getElementById('reminderStatus');
    if (!el) return;
    el.hidden = false;
    el.className = 'reminder-status ' + kind;
    el.textContent = msg;
    if (ttl) setTimeout(() => { el.hidden = true; }, ttl);
  }

  // Read the two reminder rows (default + custom) for this booking and
  // paint each into its own UI row. The default row is always rendered
  // as locked, even when it's been migrated and somehow cancelled, so
  // the rider never thinks they can opt out.
  async function refreshReminderRows(bookingId) {
    if (!sb || !bookingId) return;
    const { data } = await sb.from('trip_reminders')
      .select('kind, fire_at, fired_at, cancelled')
      .eq('booking_id', bookingId);

    const def = (data || []).find(r => r.kind === 'default');
    const cus = (data || []).find(r => r.kind === 'custom');

    const defTime = document.getElementById('reminderDefaultTime');
    if (defTime) defTime.textContent = def?.fire_at ? fmtDateTime(new Date(def.fire_at)) : '—';

    const cusLabel = document.getElementById('reminderCustomLabel');
    const cusTime  = document.getElementById('reminderCustomTime');
    if (cusLabel && cusTime) {
      if (!cus || cus.cancelled) {
        cusLabel.textContent = 'Not set — pick a moment below to add one';
        cusTime.textContent  = '—';
      } else {
        cusLabel.textContent = 'Active';
        cusTime.textContent  = fmtDateTime(new Date(cus.fire_at));
      }
    }
  }

  async function applyCustomLead(leadMinutes) {
    const card = document.getElementById('reminderCard');
    if (!card) return;
    const bookingId = Number(card.dataset.bookingId);
    const depMs     = Number(card.dataset.depMs);
    if (!bookingId || !depMs) {
      setReminderStatus('err', 'Cannot compute departure time on this booking.');
      return;
    }
    const targetMs = depMs - leadMinutes * 60 * 1000;
    if (targetMs <= Date.now()) {
      setReminderStatus('err', 'That lead time has already passed — pick a sooner one.');
      return;
    }
    await saveCustom(bookingId, new Date(targetMs).toISOString());
  }

  async function saveCustom(bookingId, isoTime) {
    setReminderStatus('info', 'Saving…', 0);
    const { error } = await sb.rpc('set_custom_reminder', { p_booking_id: bookingId, p_at: isoTime });
    if (error) { setReminderStatus('err', error.message); return; }
    await refreshReminderRows(bookingId);
    setReminderStatus('ok', 'Personal reminder added.');
  }

  async function cancelCustom() {
    const card = document.getElementById('reminderCard');
    const bookingId = Number(card?.dataset.bookingId);
    if (!bookingId) return;
    setReminderStatus('info', 'Cancelling…', 0);
    const { error } = await sb.rpc('cancel_custom_reminder', { p_booking_id: bookingId });
    if (error) { setReminderStatus('err', error.message); return; }
    await refreshReminderRows(bookingId);
    setReminderStatus('ok', 'Personal reminder cancelled. The standard call still fires.');
  }

  // Event delegation — card is mounted dynamically after payment confirms.
  document.getElementById('reminderCard')?.addEventListener('click', (e) => {
    const opt = e.target.closest('.reminder-opt');
    if (opt) {
      document.querySelectorAll('.reminder-opt.selected').forEach(b => b.classList.remove('selected'));
      opt.classList.add('selected');
      if (opt.dataset.lead === 'custom') {
        document.getElementById('reminderCustomWrap').hidden = false;
        return;
      }
      document.getElementById('reminderCustomWrap').hidden = true;
      applyCustomLead(Number(opt.dataset.lead));
    } else if (e.target.id === 'reminderCustomSave') {
      const val = document.getElementById('reminderCustomInput').value;
      if (!val) return;
      const card = document.getElementById('reminderCard');
      saveCustom(Number(card.dataset.bookingId), new Date(val).toISOString());
    } else if (e.target.id === 'reminderSkipBtn') {
      cancelCustom();
    }
  });

  // ── localStorage helpers — resume the timer across reloads ──────────────
  function saveHoldToLS(rec) {
    try { localStorage.setItem(HOLD_LS_KEY, JSON.stringify(rec)); } catch {}
  }
  function clearHoldFromLS() {
    try { localStorage.removeItem(HOLD_LS_KEY); } catch {}
  }
  async function resumeHoldFromLS() {
    let rec;
    try { rec = JSON.parse(localStorage.getItem(HOLD_LS_KEY) || "null"); } catch { rec = null; }
    if (!rec || !rec.rowId) return;
    // If already expired, drop it.
    if (!rec.endsAt || rec.endsAt <= Date.now()) { clearHoldFromLS(); return; }
    // Verify the row is still HELD before showing the timer. Saves users
    // who paid via voice agent (status='confirmed') from seeing a stale
    // countdown.
    if (sb) {
      const { data } = await sb.from('bookings')
        .select('id, seat_number, expires_at, status, bus_id, travel_date')
        .eq('id', rec.rowId)
        .maybeSingle();
      if (!data || data.status !== 'awaiting_payment') { clearHoldFromLS(); return; }
      heldRowId  = data.id;
      heldSeat   = data.seat_number;
      holdEndsAt = new Date(data.expires_at).getTime();
    } else {
      heldRowId  = rec.rowId;
      heldSeat   = rec.seatNum;
      holdEndsAt = rec.endsAt;
    }
    showHoldBanner(heldSeat);
    startTicker();
    // Re-open the pay section if we resumed an active hold. selectedBus /
    // selectedRoute may not be set yet (the rest of the page is loading), so
    // we delay one tick — showPaySection() bails out early when state is
    // missing, and the bus-selection flow will trigger it again.
    setTimeout(() => { showPaySection().catch(()=>{}); }, 0);
  }
  // Run once on load.
  resumeHoldFromLS();

  let holdSnapshot = null;  // remembers banner text labels for restore
  function showHoldBanner(seatNum) {
    holdSnapshot = holdSnapshot || {
      title: holdBanner.querySelector('.hold-countdown-title').innerHTML,
      sub:   holdBanner.querySelector('.hold-countdown-sub').textContent
    };
    holdBanner.querySelector('.hold-countdown-title').innerHTML = holdSnapshot.title;
    holdBanner.querySelector('.hold-countdown-sub').textContent = holdSnapshot.sub;
    holdSeatNumEl.textContent = seatNum;
    holdBanner.hidden = false;
    holdBanner.classList.remove('expiring', 'hold-countdown-released');
    updateCountdown();
  }

  function startTicker() {
    if (holdTimerId) clearInterval(holdTimerId);
    holdTimerId = setInterval(updateCountdown, 1000);
  }
  function stopTicker() {
    if (holdTimerId) { clearInterval(holdTimerId); holdTimerId = null; }
  }

  function updateCountdown() {
    const remaining = Math.max(0, (holdEndsAt - Date.now()) / 1000);
    holdTimeEl.textContent = fmtCountdown(remaining);
    const pct = (remaining / HOLD_SECONDS) * 100;
    if (holdBarEl) holdBarEl.style.width = pct + '%';
    if (remaining <= 60 && remaining > 0) holdBanner.classList.add('expiring');
    if (remaining <= 0) releaseHeldSeat({ expired: true });
  }

  async function releaseHeldSeat({ expired = false } = {}) {
    stopTicker();
    hidePaySection();
    const rowId   = heldRowId;
    const wasHeld = !!heldSeat;
    heldSeat = null; heldRowId = null; holdEndsAt = 0;
    clearHoldFromLS();

    // Best-effort DB cleanup. We don't await before clearing UI state so
    // the user gets instant feedback; if the network call fails the row
    // will still expire naturally once the server-side cron picks it up.
    if (sb && rowId) {
      sb.from('bookings')
        .update({ status: 'expired' })
        .eq('id', rowId)
        .eq('status', 'awaiting_payment')  // don't clobber confirmed payments
        .then(() => {}, () => {});
    }

    if (expired) {
      holdBanner.classList.add('hold-countdown-released');
      holdSeatNumEl.textContent = '—';
      holdTimeEl.textContent = '00:00';
      holdBanner.querySelector('.hold-countdown-title').innerHTML =
        '⚠️ Hold expired — the seat was released';
      holdBanner.querySelector('.hold-countdown-sub').textContent =
        'Tap another green seat to hold it again.';
      setTimeout(() => {
        holdBanner.hidden = true;
        // Restore default labels for next hold.
        if (holdSnapshot) {
          holdBanner.querySelector('.hold-countdown-title').innerHTML = holdSnapshot.title;
          holdBanner.querySelector('.hold-countdown-sub').textContent = holdSnapshot.sub;
        }
      }, 4000);
    } else {
      holdBanner.hidden = true;
    }
    if (wasHeld) loadSeatMap();
  }

  releaseSeatBtn?.addEventListener('click', () => releaseHeldSeat({ expired: false }));

  // If the user leaves the page mid-hold, let the seat go.
  window.addEventListener('beforeunload', () => {
    if (heldRowId && sb && navigator.sendBeacon) {
      // sendBeacon needs an absolute URL; build the PostgREST update URL.
      const cfg2 = window.APP_CONFIG || {};
      const base = (cfg2.SUPABASE_URL || '').replace(/\/$/, '');
      const key  = cfg2.SUPABASE_ANON_KEY || '';
      if (base && key) {
        const url = `${base}/rest/v1/bookings?id=eq.${heldRowId}&status=eq.awaiting_payment`;
        const body = new Blob([JSON.stringify({ status: 'expired' })],
                              { type: 'application/json' });
        // Best-effort; sendBeacon can't set headers via fetch-style options, so
        // this only works when Supabase RLS lets anon update bookings (it does).
        try {
          fetch(url, {
            method: 'PATCH',
            headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'expired' }),
            keepalive: true
          }).catch(()=>{});
        } catch {}
      }
    }
  });

  // ── Realtime: other visitors' holds appear instantly on the seat map ──
  // Channel is (re)opened whenever the trip selection changes.
  let tripChannel = null;
  function subscribeTrip() {
    if (!sb || !selectedBus || !selectedDate) return;
    if (tripChannel) { sb.removeChannel(tripChannel); tripChannel = null; }
    const chName = `trip-${selectedBus.id}-${selectedDate}`;
    tripChannel = sb.channel(chName)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'bookings',
        filter: `bus_id=eq.${selectedBus.id}`
      }, (payload) => {
        // Only re-load the map if the row touches the current travel_date.
        const row = payload.new || payload.old || {};
        if (row.travel_date && row.travel_date !== selectedDate) return;
        loadSeatMap();
      })
      .subscribe();
  }

  // ── Storage photo URL ─────────────────────────────────────────────────────
  const BUS_BUCKET = (cfg.BUS_PHOTOS_BUCKET) || 'bus-photos';
  function busPhotoUrl(path) {
    if (!path) return '';
    if (path.startsWith('http')) return path;
    if (!sb) return `data/${path}`;
    return sb.storage.from(BUS_BUCKET).getPublicUrl(path).data.publicUrl;
  }

  // ── Load buses ────────────────────────────────────────────────────────────
  async function loadBuses() {
    busGrid.innerHTML = '<div class="bus-grid-placeholder"><div style="font-size:1.8rem;margin-bottom:8px">🚌</div>Loading buses…</div>';

    // Try pre-loaded URL param first
    const urlBus = new URLSearchParams(location.search).get('bus');

    try {
      let query = sb
        ? sb.from('buses').select('id,name,routes,photo_path,seats_total,fare_per_km').order('name')
        : null;
      const { data, error } = query ? await query : { data: null, error: 'no sb' };

      if (error || !data?.length) {
        // Fallback: load from JSON
        const res = await fetch('data/buses.json').catch(() => ({ ok: false }));
        allBuses = res.ok ? await res.json() : [];
      } else {
        allBuses = data;
      }
    } catch {
      allBuses = [];
    }

    renderBusGrid(allBuses);

    // Auto-select from URL param
    if (urlBus) {
      const found = allBuses.find(b => b.id === urlBus);
      if (found) selectBus(found);
    }
  }

  // ── Render bus cards ──────────────────────────────────────────────────────
  function renderBusGrid(buses) {
    // Count chip: tells the user this list is comprehensive ("all 16 buses"),
    // and how many are matching their search.
    const total = allBuses.length;
    const showing = buses.length;
    const countChip = total
      ? `<div class="bus-grid-count">
           ${showing === total
             ? `Showing all <strong>${total}</strong> registered buses — pick any to continue`
             : `Showing <strong>${showing}</strong> of <strong>${total}</strong> buses`}
         </div>`
      : '';

    if (!buses.length) {
      busGrid.innerHTML = countChip + '<div class="bus-grid-placeholder">No buses match your search. Clear the search to see all.</div>';
      return;
    }

    busGrid.innerHTML = countChip + buses.map(bus => {
      const photo = busPhotoUrl(bus.photo_path);
      const allRoutes = bus.routes || [];
      const routes = allRoutes.slice(0, 3);
      const isSelected = selectedBus?.id === bus.id;
      const hasRoutes = allRoutes.length > 0;

      return `
      <div class="bus-card${isSelected ? ' selected' : ''}" data-id="${bus.id}" role="button" tabindex="0">
        <div class="bus-card-inner">
          <div class="bus-card-check">✓</div>
          ${photo
            ? `<img class="bus-card-photo" src="${photo}" alt="${bus.name}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
            : ''}
          <div class="bus-card-photo-placeholder" style="${photo ? 'display:none' : ''}">🚌</div>
        </div>
        <div class="bus-card-body">
          <div class="bus-card-name">${bus.name}</div>
          <div class="bus-card-routes">
            ${hasRoutes ? routes.map(r => `
              <div class="bus-route-pill">
                <span class="dep">${r.departure || ''}</span>
                <span>${r.from} → ${r.to}</span>
              </div>`).join('') : `
              <div class="bus-route-pill" style="color:#9ca3af;font-style:italic">
                Routes not yet configured
              </div>`}
            ${allRoutes.length > 3
              ? `<div style="font-size:0.68rem;color:#9ca3af">+${allRoutes.length - 3} more routes</div>`
              : ''}
          </div>
          <button class="bus-select-btn">${isSelected ? '✓ Selected' : 'Select bus'}</button>
        </div>
      </div>`;
    }).join('');

    // Wire click events
    busGrid.querySelectorAll('.bus-card').forEach(card => {
      const handler = () => {
        const bus = buses.find(b => b.id === card.dataset.id);
        if (bus) selectBus(bus);
      };
      card.addEventListener('click', handler);
      card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') handler(); });
    });
  }

  // ── Select a bus → show seat section ─────────────────────────────────────
  function selectBus(bus) {
    selectedBus = bus;

    // Update grid selected state
    const q = busSearch?.value.trim().toLowerCase() || '';
    renderBusGrid(q ? allBuses.filter(b => matchesBus(b, q)) : allBuses);

    // Populate route picker. If the bus has no routes yet, surface a
    // clear "no routes" placeholder so the user understands why the
    // seat map is empty — instead of letting them stare at a blank picker.
    if (routePicker) {
      const routes = bus.routes || [];
      if (routes.length) {
        routePicker.innerHTML = routes.map((r, i) =>
          `<option value="${i}">${r.from} → ${r.to} · ${r.departure}</option>`
        ).join('');
        routePicker.disabled = false;
        selectedRoute = routes[0];
      } else {
        routePicker.innerHTML = '<option value="">— no routes configured for this bus yet —</option>';
        routePicker.disabled = true;
        selectedRoute = null;
      }
    }

    // Set default date = today
    const today = new Date().toISOString().slice(0, 10);
    if (datePicker) {
      datePicker.min   = today;
      datePicker.value = today;
      selectedDate     = today;
    }

    // Show seat section, hide locked card
    seatSection.hidden = false;
    callSection.hidden = true;
    callLocked.hidden  = true;
    seatSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // If the bus has no routes, the user can't proceed — disable the
    // "Book by voice" button and surface a clear hint in the seat summary.
    if (!selectedRoute) {
      if (proceedCallBtn) {
        proceedCallBtn.disabled = true;
        proceedCallBtn.style.opacity = '0.5';
        proceedCallBtn.style.cursor = 'not-allowed';
      }
      if (seatSummary) {
        seatSummary.innerHTML = `
          <div style="flex:1;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:12px;color:#9a3412;font-size:0.85rem;line-height:1.5">
            <strong>⚠️ This bus has no routes yet.</strong><br>
            The company hasn't published its schedule. Pick a different bus, or call them directly.
          </div>`;
      }
      if (seatGrid) seatGrid.innerHTML = '';
    } else {
      if (proceedCallBtn) {
        proceedCallBtn.disabled = false;
        proceedCallBtn.style.opacity = '';
        proceedCallBtn.style.cursor = '';
      }
    }

    // Render the route summary FIRST, then the seat map.
    renderRouteCard();
    loadSeatMap();
    subscribeTrip();
  }

  // ── Route / date change → reload seat map ────────────────────────────────
  routePicker?.addEventListener('change', () => {
    const idx = parseInt(routePicker.value);
    selectedRoute = selectedBus?.routes?.[idx] || null;
    // Changing route invalidates any seat hold (different trip).
    if (heldSeat) releaseHeldSeat();
    renderRouteCard();
    loadSeatMap();
    subscribeTrip();
  });

  datePicker?.addEventListener('change', () => {
    selectedDate = datePicker.value;
    if (heldSeat) releaseHeldSeat();
    renderRouteCard();
    loadSeatMap();
    subscribeTrip();
  });

  // ── Load bookings and render seat map ─────────────────────────────────────
  // ── "Bus full → next trip" cascade ───────────────────────────────────────
  // Calls the find_next_available_trip RPC with the rider's current
  // (origin, destination, travel_date, departure_time). The RPC walks the
  // next 5 chronological candidates on the same route and returns the
  // first one with ≥1 free seat. We hop to it: swap selectedBus,
  // selectedRoute, selectedDate; re-render route card; re-load seat map.
  // The rider can click again — the search is stateless, so each click
  // moves the cursor forward by one available trip.
  async function tryNextAvailableTrip() {
    if (!sb || !selectedBus || !selectedRoute || !selectedDate) return;
    const btn = document.getElementById('findNextTripBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Searching…'; }

    const { data, error } = await sb.rpc('find_next_available_trip', {
      p_origin:         selectedRoute.from,
      p_destination:    selectedRoute.to,
      p_travel_date:    selectedDate,
      p_departure_time: selectedRoute.departure || '',
      p_max_attempts:   5,
    });
    if (error) {
      alert('Could not search next trip: ' + error.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Find next →'; }
      return;
    }
    const next = (data || [])[0];
    if (!next) {
      // Replace the banner with a clearer "we tried" message.
      const wrap = document.getElementById('tripFullBanner');
      if (wrap) {
        wrap.classList.remove('c-banner-warning');
        wrap.classList.add('c-banner-danger');
        wrap.innerHTML = `
          <div>
            <strong>No availability found.</strong>
            <div style="font-size:0.78rem; opacity:0.85; margin-top:2px">
              We walked the next 5 trips on ${selectedRoute.from} → ${selectedRoute.to} — all full.
              Try a different route or date.
            </div>
          </div>`;
      }
      return;
    }

    // Fetch the full bus row for the new bus_id so route + photo are
    // ready when we re-render. Often this is the same bus (next day on
    // same departure) — handled either way.
    let newBus = selectedBus;
    if (next.bus_id !== selectedBus.id) {
      const { data: busRow } = await sb.from('buses')
        .select('id,name,routes,photo_path,seats_total,fare_per_km')
        .eq('id', next.bus_id).maybeSingle();
      if (busRow) newBus = busRow;
    }
    const newRoute = (newBus.routes || []).find(r =>
      String(r.from || '').toLowerCase() === selectedRoute.from.toLowerCase() &&
      String(r.to   || '').toLowerCase() === selectedRoute.to.toLowerCase() &&
      String(r.departure || '') === next.departure_time
    ) || { from: selectedRoute.from, to: selectedRoute.to, departure: next.departure_time };

    selectedBus   = newBus;
    selectedRoute = newRoute;
    selectedDate  = next.trip_date;

    // Update the date input + bus card selection so the rest of the page
    // stays consistent with the new context.
    const dateEl = document.getElementById('travelDate');
    if (dateEl) dateEl.value = next.trip_date;

    renderRouteCard();
    loadSeatMap();

    // Floating toast so the rider notices the jump (banner is gone now).
    showTripJumpToast(next);
  }

  function showTripJumpToast(next) {
    const t = document.createElement('div');
    t.className = 'c-banner c-banner-success';
    t.style.cssText = 'position:fixed; bottom:24px; left:50%; transform:translateX(-50%); z-index:9999; box-shadow:var(--c-shadow-lg); max-width:380px;';
    t.innerHTML = `
      ✅ Hopped to next trip — <strong>${next.bus_name}</strong> on
      <strong>${next.trip_date}</strong> at <strong>${next.departure_time}</strong>
      (${next.available_seats} of ${next.seats_total} seats free, hop #${next.hops_searched}).`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5500);
  }

  async function loadSeatMap() {
    if (!selectedBus || !selectedDate) return;

    seatSummary.innerHTML = '<span style="font-size:0.8rem;color:#9ca3af">Loading availability…</span>';
    seatGrid.innerHTML    = '';

    const total = selectedBus.seats_total || 50;
    let bookedMap = {}; // seat_number → status

    if (sb) {
      const { data } = await sb
        .from('bookings')
        .select('seat_number,status,expires_at')
        .eq('bus_id', selectedBus.id)
        .eq('travel_date', selectedDate)
        .not('seat_number', 'is', null);

      const now = Date.now();
      (data || []).forEach(b => {
        // A held row whose timer has elapsed is effectively free — treat it
        // as 'expired' regardless of the persisted status. Server-side cron
        // will eventually flip the row, but the customer shouldn't have to
        // wait for that to see the seat go green again.
        let st = b.status;
        if (st === 'awaiting_payment' && b.expires_at && new Date(b.expires_at).getTime() < now) {
          st = 'expired';
        }
        // If multiple bookings for same seat, worst status wins
        const existing = bookedMap[b.seat_number];
        const priority = { confirmed: 3, boarded: 3, completed: 3, pending: 2, awaiting_payment: 2, held: 1 };
        if (!existing || (priority[st] || 0) > (priority[existing] || 0)) {
          bookedMap[b.seat_number] = st;
        }
      });
    }

    renderSeatMap(total, bookedMap);
  }

  // ── Draw the seat grid ────────────────────────────────────────────────────
  function renderSeatMap(total, bookedMap) {
    const rowCount = Math.ceil(total / 4);
    let available = 0, booked = 0, pending = 0;

    // Count
    for (let s = 1; s <= total; s++) {
      const st = bookedMap[s];
      if (!st || st === 'expired' || st === 'cancelled') available++;
      else if (st === 'confirmed' || st === 'boarded' || st === 'completed') booked++;
      else pending++;
    }

    // Seat availability summary (route info is shown in the prominent
    // route card above the seat map). When the trip is full, append a
    // "find next available" button that walks up to 5 candidate trips on
    // the same route via the find_next_available_trip RPC.
    const pct = Math.round((available / total) * 100);
    const fullBanner = available === 0 ? `
      <div id="tripFullBanner" class="c-banner c-banner-warning" style="margin-top:10px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap">
        <div>
          <strong>This trip is fully booked.</strong>
          <div style="font-size:0.78rem; opacity:0.85; margin-top:2px">We can walk you to the next available trip on this route (up to 5 fallbacks).</div>
        </div>
        <button id="findNextTripBtn" class="c-btn c-btn-accent c-btn-sm">Find next →</button>
      </div>` : '';

    seatSummary.innerHTML = `
      <div style="flex:1;min-width:180px">
        <div style="height:8px;border-radius:99px;background:#e5e7eb;overflow:hidden;margin-bottom:6px">
          <div style="height:100%;background:#16a34a;width:${pct}%;border-radius:99px;transition:width 0.4s"></div>
        </div>
        <div style="font-size:0.78rem;color:#374151">
          <strong style="color:#15803d">${available} available</strong> ·
          <span style="color:#dc2626">${booked} booked</span> ·
          <span style="color:#b45309">${pending} pending</span>
          of ${total} seats
        </div>
        ${fullBanner}
      </div>`;

    document.getElementById('findNextTripBtn')?.addEventListener('click', tryNextAvailableTrip);

    // Seat grid — 4 per row, 2+aisle+2 layout
    // Columns: left-A, left-B, aisle, right-C, right-D
    seatGrid.style.gridTemplateColumns = '1fr 1fr 10px 1fr 1fr';
    let html = '';
    // Column headers
    html += `<div style="text-align:center;font-size:0.6rem;font-weight:700;color:#9ca3af;padding-bottom:4px">A</div>`;
    html += `<div style="text-align:center;font-size:0.6rem;font-weight:700;color:#9ca3af;padding-bottom:4px">B</div>`;
    html += `<div></div>`;
    html += `<div style="text-align:center;font-size:0.6rem;font-weight:700;color:#9ca3af;padding-bottom:4px">C</div>`;
    html += `<div style="text-align:center;font-size:0.6rem;font-weight:700;color:#9ca3af;padding-bottom:4px">D</div>`;

    for (let row = 0; row < rowCount; row++) {
      const seats = [
        row * 4 + 1,   // A
        row * 4 + 2,   // B
        null,          // aisle
        row * 4 + 3,   // C
        row * 4 + 4,   // D
      ];
      seats.forEach(sn => {
        if (sn === null) { html += `<div style="width:10px"></div>`; return; }
        if (sn > total)  { html += `<div></div>`; return; }
        const st = bookedMap[sn];
        let cls, title, dataAct = '';
        if (heldSeat === sn) {
          cls = 'seat seat-mine';      title = `Seat ${sn} — Held by you`; dataAct = ` data-mine="1"`;
        } else if (!st || st === 'expired' || st === 'cancelled') {
          cls = 'seat seat-available'; title = `Seat ${sn} — Tap to hold`; dataAct = ` data-hold="1"`;
        } else if (st === 'confirmed' || st === 'boarded' || st === 'completed') {
          cls = 'seat seat-booked';    title = `Seat ${sn} — Booked`;
        } else if (st === 'held') {
          cls = 'seat seat-held';      title = `Seat ${sn} — On hold`;
        } else {
          cls = 'seat seat-pending';   title = `Seat ${sn} — Pending payment`;
        }
        html += `<div class="${cls}" title="${title}" data-seat="${sn}"${dataAct} style="margin:2px">${sn}</div>`;
      });
    }

    seatGrid.style.gridTemplateColumns = '1fr 1fr 10px 1fr 1fr';
    seatGrid.innerHTML = html;

    // Wire click → hold-for-12:09. Only fires on available seats; tapping
    // your own held seat releases it.
    seatGrid.querySelectorAll('.seat[data-hold="1"]').forEach(el => {
      el.addEventListener('click', () => {
        const sn = parseInt(el.dataset.seat);
        if (!sn) return;
        holdSeat(sn);
      });
    });
    seatGrid.querySelectorAll('.seat[data-mine="1"]').forEach(el => {
      el.addEventListener('click', () => releaseHeldSeat({ expired: false }));
    });
  }

  // ── Proceed to call ───────────────────────────────────────────────────────
  proceedCallBtn?.addEventListener('click', () => {
    // Build banner for call section
    const photo = busPhotoUrl(selectedBus.photo_path);
    if (photo) {
      bannerIcon.innerHTML = `<img src="${photo}" alt="${selectedBus.name}" style="width:48px;height:48px;border-radius:8px;object-fit:cover">`;
    } else {
      bannerIcon.innerHTML = '🚌';
      bannerIcon.className = 'placeholder-icon';
    }
    bannerName.textContent = selectedBus.name;
    const routeStr = selectedRoute
      ? `${selectedRoute.from} → ${selectedRoute.to} · ${selectedRoute.departure} · ${selectedDate}`
      : selectedDate;
    const seatStr = heldSeat ? ` · Seat ${heldSeat} (held ${fmtCountdown((holdEndsAt - Date.now())/1000)})` : '';
    bannerRoutes.textContent = routeStr + seatStr;

    callSection.hidden = false;
    callSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // ── Search / filter ───────────────────────────────────────────────────────
  function matchesBus(bus, q) {
    if (!q) return true;
    const hay = [bus.name, ...(bus.routes || []).flatMap(r => [r.from, r.to])].join(' ').toLowerCase();
    return hay.includes(q);
  }

  busSearch?.addEventListener('input', () => {
    const q = busSearch.value.trim().toLowerCase();
    renderBusGrid(q ? allBuses.filter(b => matchesBus(b, q)) : allBuses);
  });

  // Change bus — collapse steps 2+3 and scroll back to bus grid
  changeBusBtn?.addEventListener('click', () => {
    callSection.hidden  = true;
    seatSection.hidden  = true;
    callLocked.hidden   = false;
    selectedBus   = null;
    selectedRoute = null;
    selectedDate  = '';
    renderBusGrid(allBuses);
    busGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ── Supabase Realtime — watch bookings by phone ───────────────────────────
  function subscribePhone(phone) {
    if (!sb || !phone || phone.length < 8) return;
    if (realtimeCh) { sb.removeChannel(realtimeCh); realtimeCh = null; }

    realtimeCh = sb.channel('bf-' + phone.replace(/\D/g, ''))
      .on('postgres_changes', {
        event:  'UPDATE',
        schema: 'public',
        table:  'bookings',
        filter: `passenger_phone=eq.${phone}`
      }, ({ new: row }) => {
        if (row.status === 'confirmed') showTicket(row);
      })
      .subscribe();
  }

  if (phoneEl?.value.trim()) subscribePhone(phoneEl.value.trim());
  phoneEl?.addEventListener('change', () => subscribePhone(phoneEl.value.trim()));

  // ── VAPI browser call ─────────────────────────────────────────────────────
  callBtn?.addEventListener('click', async () => {
    if (!voiceOk) { noKeyEl.hidden = false; noKeyEl.scrollIntoView({ behavior: 'smooth' }); return; }
    if (active) { vapi?.stop(); return; }

    setCallState('connecting');

    try {
      if (!vapi) {
        vapi = new window.Vapi(cfg.VAPI_PUBLIC_KEY);

        vapi.on('call-start', () => {
          active = true;
          setCallState('active');
          const ph = phoneEl?.value.trim();
          if (ph) subscribePhone(ph);
        });

        vapi.on('call-end', () => { active = false; setCallState('idle'); });

        vapi.on('error', err => {
          console.error('VAPI:', err);
          active = false;
          setCallState('error');
        });

        vapi.on('message', msg => {
          try {
            if (msg?.type === 'tool-calls') {
              (msg.toolCalls || [])
                .filter(t => t.function?.name === 'claim_ticket')
                .forEach(tc => {
                  const result = JSON.parse(tc.function?.result || 'null');
                  if (result?.ticket_code) showTicket(result);
                });
            }
            // Extract phone from transcript if not filled yet
            if (msg?.type === 'transcript' && msg.role === 'user' && !phoneEl?.value.trim()) {
              const m = msg.transcript?.match(/\+?2557\d{8}|\+?255\s?\d{9}|07\d{8}|06\d{8}/);
              if (m) { phoneEl.value = m[0]; subscribePhone(m[0]); }
            }
          } catch (_) {}
        });
      }

      // Build metadata — full context so agent skips those questions
      const meta = { phone: phoneEl?.value.trim() || '' };
      if (selectedBus) {
        meta.bus_id   = selectedBus.id;
        meta.bus_name = selectedBus.name;
      }
      if (selectedRoute) {
        meta.route_from     = selectedRoute.from;
        meta.route_to       = selectedRoute.to;
        meta.departure_time = selectedRoute.departure;
      }
      if (selectedDate) meta.travel_date = selectedDate;
      if (heldSeat) {
        meta.seat_number       = heldSeat;
        meta.seat_hold_expires = new Date(holdEndsAt).toISOString();
        if (heldRowId) meta.hold_booking_id = heldRowId;
      }

      await vapi.start(cfg.VAPI_ASSISTANT_ID, { variableValues: meta });
    } catch (e) {
      active = false;
      setCallState('error');
      console.error('VAPI start failed:', e);
    }
  });

  function setCallState(state) {
    if (!callBtn) return;
    callBtn.disabled = (state === 'connecting');
    callBtn.classList.toggle('active', state === 'active');
    const states = {
      idle:       { label: 'Tap to call AI agent',          sub: 'Free · Swahili & English · instant booking' },
      connecting: { label: 'Connecting…',                   sub: 'Setting up your AI call' },
      active:     { label: 'Call active — speak now',       sub: 'Tap the button to end the call' },
      error:      { label: 'Tap to call AI agent',          sub: 'Could not connect — check mic permissions and retry' },
    };
    const s = states[state] || states.idle;
    if (callLabel) callLabel.textContent = s.label;
    if (callSub)   callSub.textContent   = s.sub;
  }

  // ── n8n webhook → Africa's Talking real phone call ────────────────────────
  cbBtn?.addEventListener('click', async () => {
    const phone = phoneEl?.value.trim();
    if (!phone || phone.length < 8) {
      cbMsg.textContent = 'Enter your phone number above first';
      cbMsg.style.color = 'var(--danger)';
      phoneEl?.focus();
      return;
    }

    cbBtn.disabled   = true;
    cbBtn.textContent = '…';
    cbMsg.textContent = '';

    try {
      const webhookBase = (cfg.N8N_WEBHOOK_BASE || '').replace(/\/$/, '');
      const payload = {
        phone,
        requested_at:   new Date().toISOString(),
        bus_id:         selectedBus?.id   || new URLSearchParams(location.search).get('bus') || null,
        bus_name:       selectedBus?.name || null,
        route_from:     selectedRoute?.from        || null,
        route_to:       selectedRoute?.to          || null,
        departure_time: selectedRoute?.departure   || null,
        travel_date:    selectedDate               || null,
        seat_number:    heldSeat || null,
        seat_hold_expires: heldSeat ? new Date(holdEndsAt).toISOString() : null,
        hold_booking_id: heldRowId || null,
      };

      if (webhookBase && !webhookBase.includes('your-n8n')) {
        await fetch(`${webhookBase}/webhook/agent-call`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(payload)
        });
      }

      if (sb) {
        await sb.from('call_requests')
          .insert({ ...payload, status: 'pending' })
          .then(() => {}).catch(() => {});
      }

      subscribePhone(phone);
      cbMsg.textContent = 'Agent will call you within a minute';
      cbMsg.style.color = 'var(--green-dark)';
    } catch {
      cbMsg.textContent = 'Request failed — please try again';
      cbMsg.style.color = 'var(--danger)';
    }

    cbBtn.disabled    = false;
    cbBtn.textContent = '📞 Call me back';
  });

  // ── Ticket display ────────────────────────────────────────────────────────
  function showTicket(data) {
    if (!ticketReveal || !ticketDetails) return;

    const tc  = data.ticket_code || '';
    const pfx = tc.split('-')[0];
    const rest = tc.slice(pfx.length);
    const isReschedule = tc.includes('-R-');

    const codeHtml = pfx
      ? `<span style="color:var(--green-dark);font-weight:800;font-family:monospace">${pfx}</span>`
        + (isReschedule ? `<span style="color:#d97706;font-weight:700;font-family:monospace">-R-</span>` : '')
        + `<span style="font-family:monospace">${isReschedule ? rest.replace('-R-', '') : rest}</span>`
      : `<span style="font-family:monospace">${tc}</span>`;

    const headerLabel = document.getElementById('ticketHeaderLabel');
    if (headerLabel) headerLabel.textContent = isReschedule ? 'RESCHEDULED ✓' : 'BOOKING CONFIRMED';

    ticketDetails.innerHTML = `
      <div style="text-align:center;padding:10px 0 6px">
        <div style="font-size:1.35rem;font-weight:800;letter-spacing:0.5px;margin-bottom:4px">${codeHtml}</div>
        ${isReschedule
          ? `<span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:0.72rem;
                          font-weight:700;border-radius:6px;padding:2px 10px;letter-spacing:0.8px">RESCHEDULED</span>`
          : ''}
      </div>
      <div style="display:grid;gap:7px;font-size:0.88rem;padding:0 4px">
        ${row('Bus',      data.bus_name)}
        ${data.origin && data.destination
          ? `<div><strong>Route:</strong> ${data.origin} → ${data.destination}</div>` : ''}
        ${row('Date',     data.travel_date)}
        ${row('Departs',  data.departure_time)}
        ${row('Seat',     data.seat_number)}
        ${row('Passenger',data.passenger_name)}
        ${data.fare_tzs
          ? `<div><strong>Fare:</strong> ${window.formatTZS ? window.formatTZS(data.fare_tzs) : 'TZS ' + data.fare_tzs}</div>` : ''}
      </div>`;

    ticketReveal.hidden = false;
    ticketReveal.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function row(label, val) {
    return val ? `<div><strong>${label}:</strong> ${val}</div>` : '';
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  loadBuses();
};
