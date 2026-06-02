// ============================================================================
//  Payments — frontend client for the create-payment / payment-callback
//  Supabase edge functions.
//
//  This is the unified UI for every Tanzania payment method we support:
//    Mobile money: Vodacom M-Pesa, Tigo Pesa, Airtel Money, Halopesa, AzamPesa
//    Banks:        NMB, CRDB, NBC, Equity, Stanbic, other (via Selcom checkout)
//    Card:         Visa / Mastercard (via Selcom or Flutterwave)
//    Cash:         agent confirms in person
//
//  Provider routing happens server-side (functions/_shared/registry.ts).
//  The UI doesn't care which aggregator runs the rails — it just asks the
//  edge function and polls until the `payments` row reaches a terminal state.
//
//  Usage:
//    Payments.openPicker({
//      reference,        // ticket_code | tracking_code
//      reference_type,   // 'booking' | 'shipment' | 'reschedule'
//      amount_tzs,
//      phone,            // E.164
//      customer_name,
//      onSuccess: (payment) => { ... },
//      onCancel:  () => { ... },
//    });
// ============================================================================

(function () {
  const cfg = window.APP_CONFIG || {};
  const sb  = () => window.DataStore?.sb;

  // ---- Method catalogue --------------------------------------------------
  const METHODS = [
    // Mobile money
    { id: "mpesa",     label: "M-Pesa",     telco: "Vodacom",  color: "#ee2c2c", emoji: "📱", group: "mobile",
      prefixes: ["074","075","076"] },
    { id: "tigopesa",  label: "Mixx by Yas", telco: "Tigo",    color: "#1f6cd9", emoji: "📱", group: "mobile",
      prefixes: ["065","067","071"] },
    { id: "airtel",    label: "Airtel Money", telco: "Airtel", color: "#e60000", emoji: "📱", group: "mobile",
      prefixes: ["068","069","078"] },
    { id: "halopesa",  label: "Halopesa",    telco: "Halotel", color: "#ff8c00", emoji: "📱", group: "mobile",
      prefixes: ["061","062"] },
    { id: "azampesa",  label: "AzamPesa",    telco: "Azam",    color: "#00509e", emoji: "📱", group: "mobile",
      prefixes: ["073","077"] },

    // Banks (Selcom checkout)
    { id: "nmb",         label: "NMB Bank",    color: "#0072c6", emoji: "🏦", group: "bank" },
    { id: "crdb",        label: "CRDB Bank",   color: "#006b3f", emoji: "🏦", group: "bank" },
    { id: "nbc",         label: "NBC",         color: "#cc0000", emoji: "🏦", group: "bank" },
    { id: "equity",      label: "Equity Bank", color: "#cc0000", emoji: "🏦", group: "bank" },
    { id: "stanbic",     label: "Stanbic",     color: "#0033a0", emoji: "🏦", group: "bank" },
    { id: "other_bank",  label: "Other bank",  color: "#374151", emoji: "🏦", group: "bank" },

    // Card / cash
    { id: "card", label: "Card (Visa / Mastercard)", color: "#111827", emoji: "💳", group: "card" },
    { id: "cash", label: "Cash at terminal",          color: "#0a6f4d", emoji: "💵", group: "cash" },
  ];

  // Detect the most likely method from a phone number
  function detectMethod(phone) {
    const d = (phone || "").replace(/[^0-9]/g, "");
    const local = d.startsWith("255") ? "0" + d.slice(3)
                : d.startsWith("0")    ? d
                : "0" + d;
    const p3 = local.slice(0, 3);
    return METHODS.find(m => m.prefixes && m.prefixes.includes(p3));
  }

  // ---- Edge function endpoints -----------------------------------------
  function fnUrl(path) {
    const base = cfg.SUPABASE_URL || "";
    return base ? `${base}/functions/v1/${path}` : "";
  }
  async function callFn(path, body) {
    const url = fnUrl(path);
    if (!url) throw new Error("Supabase not configured");
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": cfg.SUPABASE_ANON_KEY || "",
        "Authorization": `Bearer ${cfg.SUPABASE_ANON_KEY || ""}`
      },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || j.error || `HTTP ${r.status}`);
    return j;
  }

  // ---- Status polling ---------------------------------------------------
  async function pollStatus(payment_id, { intervalMs = 3000, timeoutMs = 5 * 60 * 1000 } = {}) {
    const conn = sb();
    if (!conn) throw new Error("Supabase not configured");
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = async () => {
        if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
        // Read this one payment's status via a SECURITY DEFINER RPC. The
        // payments table is no longer world-readable (finance users only);
        // this RPC returns ONLY the row whose id the caller already holds, so
        // public checkout can still poll without exposing every payment.
        const { data: rows, error } = await conn.rpc("payment_status", { p_id: payment_id });
        const data = Array.isArray(rows) ? rows[0] : rows;
        if (error)             return reject(error);
        if (!data)             return reject(new Error("payment row missing"));
        if (["completed","failed","cancelled","expired","refunded"].includes(data.status)) {
          return resolve(data);
        }
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  // ---- Picker UI --------------------------------------------------------
  function openPicker(opts) {
    const {
      reference, reference_type = "booking", amount_tzs,
      phone: initialPhone = "", customer_name = "",
      onSuccess, onCancel
    } = opts;

    const detected = detectMethod(initialPhone);

    const wrap = document.createElement("div");
    wrap.className = "pay-modal";
    wrap.innerHTML = `
      <div class="pay-overlay"></div>
      <div class="pay-sheet" role="dialog" aria-label="Choose how to pay">
        <header class="pay-header">
          <h3>${t("pay_title", "Choose how to pay")}</h3>
          <button class="pay-close" aria-label="Close">&times;</button>
        </header>
        <div class="pay-amount">
          <span>${t("pay_amount", "Amount")}</span>
          <strong>${window.formatTZS(amount_tzs)}</strong>
        </div>
        <div class="pay-ref">${t("pay_for", "for")} <strong>${reference}</strong></div>

        <section class="pay-section">
          <h4>${t("pay_mobile_money", "Mobile money")}</h4>
          <div class="pay-grid" data-group="mobile"></div>
        </section>
        <section class="pay-section">
          <h4>${t("pay_banks", "Banks")}</h4>
          <div class="pay-grid pay-grid-bank" data-group="bank"></div>
        </section>
        <section class="pay-section pay-section-row">
          <div class="pay-grid pay-grid-card" data-group="card"></div>
          <div class="pay-grid pay-grid-cash" data-group="cash"></div>
        </section>

        <div class="pay-phone-row">
          <label>
            ${t("pay_phone", "Phone number")} <span id="payPhoneReqMark" style="color:var(--danger);font-size:0.8rem">*</span>
            <input id="payPhone" type="tel" value="${initialPhone}" placeholder="+255 712 000 000" />
          </label>
          <small id="payPhoneHint" class="muted">${t("pay_phone_ticket_hint","Your ticket will be sent to this number via SMS.")}</small>
        </div>

        <div class="pay-actions">
          <button id="payCancelBtn" class="btn btn-outline">${t("action_cancel", "Cancel")}</button>
          <button id="payContinueBtn" class="btn btn-primary" disabled>${t("pay_continue", "Continue")}</button>
        </div>

        <div id="payStatus" class="pay-status" hidden></div>
      </div>
    `;
    document.body.appendChild(wrap);
    document.body.classList.add("no-scroll");

    // Render method cards
    METHODS.forEach(m => {
      const target = wrap.querySelector(`.pay-grid[data-group="${m.group}"]`);
      if (!target) return;
      const recommended = detected && detected.id === m.id;
      const card = document.createElement("button");
      card.type = "button";
      card.className = "pay-method";
      card.dataset.method = m.id;
      card.style.borderColor = m.color;
      card.innerHTML = `
        ${recommended ? `<span class="pay-rec">${t("pay_recommended", "Best for your number")}</span>` : ""}
        <div class="pm-icon" style="color:${m.color}">${m.emoji}</div>
        <div class="pm-label">${m.label}</div>
        ${m.telco ? `<div class="pm-sub">${m.telco}</div>` : ""}
      `;
      card.addEventListener("click", () => selectMethod(m.id, card));
      target.appendChild(card);
    });

    let selected = null;
    const continueBtn = wrap.querySelector("#payContinueBtn");
    const phoneInput  = wrap.querySelector("#payPhone");
    const phoneHint   = wrap.querySelector("#payPhoneHint");
    const statusBox   = wrap.querySelector("#payStatus");

    function selectMethod(id, card) {
      selected = id;
      wrap.querySelectorAll(".pay-method").forEach(b => b.classList.remove("selected"));
      card.classList.add("selected");
      continueBtn.disabled = false;

      // If user picked a mobile-money method, hint about expected prefix
      const m = METHODS.find(x => x.id === id);
      phoneHint.style.color = "";
      if (m?.prefixes) {
        phoneHint.textContent = `${t("pay_phone_hint", "Use a")} ${m.telco} ${t("pay_phone_hint_2", "number, e.g.")} ${m.prefixes[0]}xxxxxxx`;
      } else if (id === "card") {
        phoneHint.textContent = t("pay_card_hint", "We'll redirect you to a secure card page. Your ticket is sent to this number.");
      } else if (id === "cash") {
        phoneHint.textContent = t("pay_cash_hint", "Pay cash at the terminal. Provide your phone to receive an SMS receipt.");
      } else {
        // bank: phone is required for ticket delivery after redirect
        phoneHint.textContent = t("pay_bank_hint", "Required — your ticket will be sent here after bank payment is confirmed.");
        phoneHint.style.color = "var(--danger)";
      }
    }

    // Auto-pick recommended if any
    if (detected) {
      const card = wrap.querySelector(`.pay-method[data-method="${detected.id}"]`);
      if (card) selectMethod(detected.id, card);
    }

    function close() {
      document.body.classList.remove("no-scroll");
      wrap.remove();
    }

    wrap.querySelector(".pay-close").addEventListener("click", () => { close(); onCancel?.(); });
    wrap.querySelector(".pay-overlay").addEventListener("click", () => { close(); onCancel?.(); });
    wrap.querySelector("#payCancelBtn").addEventListener("click", () => { close(); onCancel?.(); });

    continueBtn.addEventListener("click", async () => {
      const phone = phoneInput.value.trim();
      if (!selected) return;
      const isBankGroup = METHODS.find(x => x.id === selected)?.group === "bank";
      if (selected !== "cash" && (isBankGroup || selected !== "card") && phone.length < 8) {
        phoneHint.textContent = isBankGroup
          ? t("pay_bank_phone_required", "Phone number is required — we'll send your ticket here after payment.")
          : t("pay_phone_required", "Phone number is required for this method.");
        phoneHint.classList.add("error-text");
        phoneHint.style.color = "var(--danger)";
        return;
      }
      phoneHint.classList.remove("error-text");
      phoneHint.style.color = "";
      continueBtn.disabled = true;
      continueBtn.textContent = "…";
      statusBox.hidden = false;
      statusBox.className = "pay-status info";
      statusBox.textContent = t("pay_initiating", "Starting payment with provider…");

      try {
        const init = await callFn("create-payment", {
          reference, reference_type, amount_tzs,
          method: selected,
          phone, customer_name,
        });

        // Card / bank redirect flow
        if (init.payment_url) {
          statusBox.className = "pay-status info";
          statusBox.innerHTML = `${t("pay_redirecting", "Opening secure payment page…")}
            <br><a class="btn btn-primary" target="_blank" rel="noopener" href="${init.payment_url}">
            ${t("pay_open_link", "Open payment link")}</a>`;
          window.open(init.payment_url, "_blank", "noopener");
        } else if (selected === "cash") {
          statusBox.className = "pay-status success";
          statusBox.textContent = init.instructions || t("pay_cash_done", "Tell the bus agent — they'll confirm cash at the terminal.");
          setTimeout(() => { close(); onSuccess?.(init); }, 1800);
          return;
        } else {
          statusBox.className = "pay-status info";
          statusBox.textContent = init.instructions || t("pay_ussd_pushed", "USSD pushed. Approve the prompt on your phone.");
        }

        // Poll DB until terminal status
        const final = await pollStatus(init.payment_id);
        if (final.status === "completed") {
          statusBox.className = "pay-status success";
          statusBox.innerHTML = `✓ ${t("pay_completed", "Payment received! Issuing your ticket…")}`;
          setTimeout(() => { close(); onSuccess?.(final); }, 1500);
        } else if (final.status === "cancelled") {
          statusBox.className = "pay-status";
          statusBox.textContent = t("pay_cancelled", "Payment cancelled.");
          continueBtn.disabled = false;
          continueBtn.textContent = t("pay_retry", "Try again");
        } else {
          statusBox.className = "pay-status error";
          statusBox.textContent = (final.error_message || t("pay_failed", "Payment failed.")) + " " + t("pay_try_again", "Try a different method.");
          continueBtn.disabled = false;
          continueBtn.textContent = t("pay_retry", "Try again");
        }
      } catch (e) {
        statusBox.className = "pay-status error";
        statusBox.textContent = e.message || t("pay_failed", "Payment failed.");
        continueBtn.disabled = false;
        continueBtn.textContent = t("pay_retry", "Try again");
      }
    });
  }

  function t(key, fallback) { return (window.t && window.t(key)) || fallback || key; }

  // ---- Public API -------------------------------------------------------
  window.Payments = {
    openPicker,
    pollStatus,
    detectMethod,
    METHODS,
    /** Lower-level: directly call create-payment without the picker UI. */
    initiate: (body) => callFn("create-payment", body),
  };
})();
