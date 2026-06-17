// =====================================================
// Floating "Talk to PAWA" agent button + slide-up sheet
// Available on every page so the customer can summon the
// agent from anywhere. Posts to the agent-chat Edge Fn.
// =====================================================

(function () {
  // Don't render on the dedicated chat page (already there).
  if (document.body.dataset.page === "chat") return;

  const cfg = window.APP_CONFIG || {};
  // "Pawa talk" now runs on the CURRENT houses & services brain — the same
  // ai-chat proxy chat.html uses + a live-data system prompt. It no longer
  // touches the old bus/seat/parcel agent.
  const aiChatUrl = (cfg.SUPABASE_URL || "").replace(/\/$/, "") + (cfg.AI_CHAT_PATH || "/functions/v1/ai-chat");
  let pawaData = null, pawaDataPromise = null;

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
    if (lang === "sw") return "Karibu! Mimi ni PAWA. Niambie unachotafuta — nyumba au chumba cha kupanga/kununua, huduma (fundi, usafi, ualimu…), au kazi za kibarua.";
    return "Hi! I'm PAWA. Tell me what you're looking for — a house or room to rent or buy, a daily service (fundi, cleaning, tutoring…), or a day job.";
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

  // Load (once) the live marketplace data the prompt summarises. DataStore is
  // global on the pages that mount the FAB; if it's missing we still answer
  // with the platform's scope baked into the prompt.
  function loadPawaData() {
    if (pawaData) return Promise.resolve(pawaData);
    if (pawaDataPromise) return pawaDataPromise;
    pawaDataPromise = (async () => {
      const ds = window.DataStore;
      let houses = [], services = [];
      if (ds) {
        try { houses = await ds.getHouses(); } catch (_) {}
        try { services = await ds.getServices(); } catch (_) {}
      }
      pawaData = { houses, services };
      return pawaData;
    })();
    return pawaDataPromise;
  }

  // Houses & services persona — explicitly NOT bus/seat/parcel.
  function buildSystemPrompt(data) {
    const houses = (data && data.houses) || [];
    const services = (data && data.services) || [];
    const byRegion = {};
    houses.forEach(h => { const r = h.region || "Other"; byRegion[r] = (byRegion[r] || 0) + 1; });
    const houseLines = Object.entries(byRegion).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([r, n]) => `${r}: ${n}`).join(", ");
    const svcCats = {};
    services.forEach(s => { const c = s.category || s.type || "other"; svcCats[c] = (svcCats[c] || 0) + 1; });
    const svcLines = Object.entries(svcCats).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([c, n]) => `${c}: ${n}`).join(", ");
    const lang = (window.getLang && window.getLang()) || "en";

    return `You are PAWA AI — the assistant for Maisha na Lifeza (Pawa), Tanzania's everyday-life platform: houses & rooms to rent or buy, daily services (fundi, cleaning, tutoring, plumbing, electrical…), day jobs (vibarua) and moving trucks.

PERSONALITY: Warm, concise and genuinely helpful, like a well-connected local friend. Reply in ${lang === "sw" ? "Swahili" : "the user's language (English or Swahili)"} in 1-3 short sentences or a tight bullet list; get to the useful answer fast.

WHAT YOU HELP WITH & WHERE:
- HOUSES (houses.html): rent or buy homes, single/master rooms, plots and business premises; filter by area, budget and bedrooms, then open a listing for photos, the map and the agent's phone. Saved homes live on favorites.html.
- DAILY SERVICES (services.html): find local providers — fundi, plumber, electrician, cleaner, cook, tutor, tailor and more; browse by category/region and call them directly.
- Also available: moving trucks (trucks.html), day jobs / vibarua (jobs.html), and live GPS meet-ups with an agent.

RULES:
- Pawa NO LONGER does bus tickets, seat booking, or parcel/cargo. Never offer those. If asked, say Pawa now focuses on houses & daily services and point to houses.html or services.html.
- Never invent prices, listings, agents or phone numbers — quote only from the live data below, or tell the user to open the listing.
- Be action-oriented: suggest the exact page to tap.

LIVE DATA:
HOUSES (${houses.length} listings by region): ${houseLines || "(none yet)"}
DAILY SERVICES (${services.length} providers by category): ${svcLines || "(none yet)"}`;
  }

  async function onSubmit(e) {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    pushMsg("user", text);
    sendBtn.disabled = true;

    if (!cfg.SUPABASE_URL) {
      pushMsg("system", "AI not configured (SUPABASE_URL missing).");
      sendBtn.disabled = false;
      return;
    }

    conversation.push({ role: "user", content: text });

    // Typing indicator
    const typingEl = document.createElement("div");
    typingEl.className = "pawa-sheet-msg assistant";
    typingEl.textContent = "…";
    msgs.appendChild(typingEl);
    msgs.scrollTop = msgs.scrollHeight;

    try {
      const data = await loadPawaData();
      const res = await fetch(aiChatUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": cfg.SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + cfg.SUPABASE_ANON_KEY
        },
        body: JSON.stringify({
          system: buildSystemPrompt(data),
          messages: conversation,
          max_tokens: 700
        })
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out?.error || ("status " + res.status));
      // The sheet renders plain text, so soften markdown bold/links.
      const reply = ((out.reply || "").trim() || "(no reply)")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
      conversation.push({ role: "assistant", content: reply });
      typingEl.remove();
      pushMsg("assistant", reply);
    } catch (err) {
      typingEl.remove();
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

  // iOS Safari never fires beforeinstallprompt — show the button anyway and
  // explain Share ▸ Add to Home Screen. Hidden once installed (standalone)
  // or dismissed (remembered for 14 days).
  (function iosInstallHint() {
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    const dismissedAt = Number(localStorage.getItem("pawa_ios_install_dismissed") || 0);
    if (!isIOS || standalone || Date.now() - dismissedAt < 14 * 864e5) return;
    installBtn.classList.add("show");
    installBtn.addEventListener("click", () => {
      if (installPromptEvent) return; // real prompt available — let it run
      const tip = document.createElement("div");
      tip.setAttribute("role", "status");
      tip.style.cssText = "position:fixed;left:50%;bottom:92px;transform:translateX(-50%);z-index:9999;" +
        "background:#1a1915;color:#fff;padding:12px 18px;border-radius:14px;font-size:.92rem;max-width:88vw;" +
        "box-shadow:0 10px 30px rgba(0,0,0,.35);text-align:center";
      tip.innerHTML = " Install: tap <strong>Share</strong> &#x2191; then <strong>Add to Home Screen</strong>";
      document.body.appendChild(tip);
      setTimeout(() => tip.remove(), 6000);
      localStorage.setItem("pawa_ios_install_dismissed", String(Date.now()));
    }, { once: false });
  })();
})();
