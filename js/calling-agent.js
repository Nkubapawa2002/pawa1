// ============================================================================
//  Calling Agent — site-wide floating widget that lets any visitor either:
//    (A) Speak to Pawa AI in the browser (VAPI WebRTC), OR
//    (B) Request a callback (we drop a row in call_requests; n8n picks it up
//        and the AI dials the phone via VAPI outbound).
//
//  Loaded on every page via nav.js. The widget is keyless-friendly: if VAPI
//  isn't configured, the button still appears but explains how to set keys.
// ============================================================================

(function () {
  if (window.__pawaCallingAgentMounted) return;
  window.__pawaCallingAgentMounted = true;

  // Wait for config + DOM
  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  ready(() => {
    // Don't mount on the admin panel or the chat page (clutter / redundant).
    const path = location.pathname.split("/").pop();
    if (["admin.html","chat.html"].includes(path)) return;

    mountWidget();
  });

  function mountWidget() {
    const cfg = window.APP_CONFIG || {};
    const voiceConfigured = !!(cfg.VAPI_PUBLIC_KEY && cfg.VAPI_ASSISTANT_ID);

    const root = document.createElement("div");
    root.className = "pawa-call-widget";
    root.innerHTML = `
      <button class="pcw-fab" aria-label="Talk to Pawa">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.63 3.35 2 2 0 0 1 3.6 1.13h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.73a16 16 0 0 0 6 6l.96-.96a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 21.73 16z"/>
        </svg>
        <span class="pcw-pulse"></span>
      </button>
      <div class="pcw-panel" hidden>
        <header class="pcw-header">
          <strong>${t("pcw_title", "Talk to Pawa")}</strong>
          <button class="pcw-close" aria-label="Close">&times;</button>
        </header>
        <p class="pcw-sub">${t("pcw_sub", "Our AI agent helps you find houses & rooms to rent or buy and daily services — and connects you to the right agent, in Swahili or English.")}</p>

        <button class="pcw-btn primary" data-action="call-now">
          ${t("pcw_call_now", "Call Pawa now (in browser)")}
        </button>
        <div class="pcw-or">${t("pcw_or", "or")}</div>
        <div class="pcw-callback">
          <label>${t("pcw_callback_label", "Have Pawa call you back")}</label>
          <input type="tel" placeholder="+255 712 000 000" />
          <button class="pcw-btn" data-action="callback">${t("pcw_request", "Request call")}</button>
        </div>
        <p class="pcw-hint" data-role="hint">${voiceConfigured ? "" : t("pcw_no_key", "Voice agent not yet configured — add VAPI_PUBLIC_KEY in js/config.js.")}</p>
      </div>
    `;
    document.body.appendChild(root);

    const fab    = root.querySelector(".pcw-fab");
    const panel  = root.querySelector(".pcw-panel");
    const closeB = root.querySelector(".pcw-close");
    const callB  = root.querySelector("[data-action='call-now']");
    const cbB    = root.querySelector("[data-action='callback']");
    const cbIn   = root.querySelector(".pcw-callback input");
    const hintEl = root.querySelector("[data-role='hint']");

    fab.addEventListener("click", () => panel.hidden = !panel.hidden);
    closeB.addEventListener("click", () => panel.hidden = true);

    // ---- Outbound (browser → AI) ----------------------------------------
    let vapi = null;
    let active = false;
    callB.addEventListener("click", async () => {
      if (!voiceConfigured) {
        hintEl.textContent = t("pcw_no_key", "Voice agent not yet configured.");
        return;
      }
      // Lazy-load the VAPI Web SDK
      if (typeof window.Vapi === "undefined") {
        await loadScript("https://cdn.jsdelivr.net/npm/@vapi-ai/web/dist/vapi.umd.cjs");
      }
      if (active) { vapi?.stop(); return; }
      callB.disabled = true; callB.textContent = "…";
      try {
        vapi = new window.Vapi(cfg.VAPI_PUBLIC_KEY);
        vapi.on("call-start", () => { active = true; callB.disabled = false; callB.textContent = t("pcw_end", "End call"); });
        vapi.on("call-end",   () => { active = false; callB.disabled = false; callB.textContent = t("pcw_call_now","Call Pawa now"); });
        vapi.on("error", () => { active = false; callB.disabled = false; callB.textContent = t("pcw_call_now","Call Pawa now"); });
        await vapi.start(cfg.VAPI_ASSISTANT_ID);
      } catch (e) {
        callB.disabled = false; callB.textContent = t("pcw_call_now","Call Pawa now");
        hintEl.textContent = e?.message || t("pcw_failed","Could not start the call.");
      }
    });

    // ---- Inbound (real phone call via Africa's Talking → n8n webhook) ------
    cbB.addEventListener("click", async () => {
      const phone = cbIn.value.trim();
      if (phone.length < 8) { hintEl.textContent = t("pcw_phone_required","Please enter a phone number."); return; }
      cbB.disabled = true; cbB.textContent = "…";
      try {
        const cfg = window.APP_CONFIG || {};
        const webhookBase = (cfg.N8N_WEBHOOK_BASE || "").replace(/\/$/, "");
        const payload = { phone, requested_at: new Date().toISOString() };

        if (webhookBase && !webhookBase.includes("your-n8n")) {
          // Direct webhook → n8n triggers Africa's Talking real phone call immediately
          await fetch(`${webhookBase}/webhook/agent-call`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
        } else {
          // Fallback: insert to DB for n8n polling workflow
          const sb = window.DataStore?.sb;
          if (sb) {
            const { error } = await sb.from("call_requests").insert({ ...payload, status: "pending" });
            if (error) throw error;
          } else {
            const list = JSON.parse(localStorage.getItem("call_requests_local") || "[]");
            list.push(payload);
            localStorage.setItem("call_requests_local", JSON.stringify(list));
          }
        }
        hintEl.textContent = t("pcw_requested", "Got it — Pawa will ring you within a minute.");
        cbIn.value = "";
      } catch (e) {
        hintEl.textContent = e.message || t("pcw_failed","Could not request a callback.");
      } finally {
        cbB.disabled = false;
        cbB.textContent = t("pcw_request","Request call");
      }
    });
  }

  function t(k, fb) { return (window.t && window.t(k)) || fb || k; }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("script load failed: " + src));
      document.head.appendChild(s);
    });
  }
})();
