// =====================================================
// Floating "Talk to PAWA" agent button + slide-up sheet
// Available on every page so the customer can summon the
// agent from anywhere. Posts to the agent-chat Edge Fn.
// =====================================================

(function () {
  // Don't render on the dedicated chat page (already there).
  if (document.body.dataset.page === "chat") return;

  const cfg = window.APP_CONFIG || {};
  const agentUrl = (cfg.SUPABASE_URL || "").replace(/\/$/, "") + "/functions/v1/agent-chat";

  // FAB button
  const fab = document.createElement("button");
  fab.className = "pawa-fab";
  fab.type = "button";
  fab.setAttribute("aria-label", "Open Pawa agent");
  fab.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12a8 8 0 0 1-12.7 6.5L3 20l1.5-5.3A8 8 0 1 1 21 12z"/>
    </svg>
  `;
  document.body.appendChild(fab);

  // Sheet + backdrop (lazily attached the first time the FAB is opened)
  let sheet, backdrop, msgs, input, sendBtn, conversation = [], convId = null, attached = false;

  function attachSheet() {
    if (attached) return;
    attached = true;

    backdrop = document.createElement("div");
    backdrop.className = "pawa-sheet-backdrop";
    document.body.appendChild(backdrop);

    sheet = document.createElement("section");
    sheet.className = "pawa-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Pawa agent");
    sheet.innerHTML = `
      <div class="pawa-sheet-grabber" aria-hidden="true"></div>
      <header class="pawa-sheet-header">
        <div class="avatar">P</div>
        <div class="meta">
          <div class="name" data-tenant-name>PAWA</div>
          <div class="sub">Powered by Claude</div>
        </div>
        <button class="pawa-sheet-close" aria-label="Close">×</button>
      </header>
      <div class="pawa-sheet-messages" aria-live="polite"></div>
      <form class="pawa-sheet-composer" autocomplete="off">
        <input type="text" placeholder="Andika hapa au uliza chochote..." aria-label="Message" />
        <button type="submit" aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14M13 5l7 7-7 7"/>
          </svg>
        </button>
      </form>
    `;
    document.body.appendChild(sheet);

    msgs    = sheet.querySelector(".pawa-sheet-messages");
    input   = sheet.querySelector("input");
    sendBtn = sheet.querySelector("button[type=submit]");

    sheet.querySelector(".pawa-sheet-close").addEventListener("click", close);
    backdrop.addEventListener("click", close);
    sheet.querySelector("form").addEventListener("submit", onSubmit);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

    pushMsg("assistant", greeting());
  }

  function greeting() {
    const lang = (window.getLang && window.getLang()) || "sw";
    if (lang === "sw") return "Karibu! Mimi ni PAWA. Niambie unataka nini — tiketi, mzigo, au taarifa zingine.";
    return "Hi! I'm PAWA. Tell me what you need — a seat, a parcel, or anything else.";
  }

  function pushMsg(role, text) {
    const el = document.createElement("div");
    el.className = `pawa-sheet-msg ${role}`;
    el.textContent = text;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function open() {
    attachSheet();
    requestAnimationFrame(() => {
      backdrop.classList.add("open");
      sheet.classList.add("open");
      setTimeout(() => input.focus(), 250);
    });
  }
  function close() {
    if (!sheet) return;
    backdrop.classList.remove("open");
    sheet.classList.remove("open");
  }

  fab.addEventListener("click", open);

  async function onSubmit(e) {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    pushMsg("user", text);
    sendBtn.disabled = true;

    if (!cfg.SUPABASE_URL) {
      pushMsg("system", "Agent endpoint not configured (SUPABASE_URL missing).");
      sendBtn.disabled = false;
      return;
    }

    const tenant_slug = (window.tenantSlug && window.tenantSlug()) || "bus-tz-pawa";
    conversation.push({ role: "user", content: text });

    try {
      const res = await fetch(agentUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": cfg.SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + cfg.SUPABASE_ANON_KEY
        },
        body: JSON.stringify({
          tenant_slug,
          conversation_id: convId || (convId = "fab-" + Math.random().toString(36).slice(2, 10)),
          messages: conversation
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || ("status " + res.status));
      if (Array.isArray(data.messages)) {
        conversation = data.messages;
      }
      pushMsg("assistant", data.reply || "(no reply)");
    } catch (err) {
      pushMsg("system", "Agent error: " + (err.message || err));
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  // ---- "Install Pawa" prompt ---------------------------------------
  // beforeinstallprompt fires on Android Chrome when the site qualifies.
  let installPromptEvent = null;
  const installBtn = document.createElement("button");
  installBtn.className = "pwa-install-btn";
  installBtn.type = "button";
  installBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>
    </svg> Install Pawa`;
  installBtn.addEventListener("click", async () => {
    if (!installPromptEvent) return;
    installPromptEvent.prompt();
    await installPromptEvent.userChoice.catch(() => {});
    installPromptEvent = null;
    installBtn.classList.remove("show");
  });
  document.body.appendChild(installBtn);

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPromptEvent = e;
    installBtn.classList.add("show");
  });
  window.addEventListener("appinstalled", () => {
    installBtn.classList.remove("show");
  });
})();
