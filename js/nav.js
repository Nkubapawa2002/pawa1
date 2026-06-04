// Renders the shared navigation bar at the top of every page.
// Tabs are grouped into 3 dropdown menus to keep the bar tidy.
window.renderNav = (active) => {
  const lang = window.getLang();

  const link = (href, key, extra = "") =>
    `<a href="${href}" class="nav-dropdown-item ${active === href ? 'active' : ''} ${extra}">${window.t(key)}</a>`;

  // Mark a group "active" if any of its child pages is the current page
  const groupActive = (pages) => pages.includes(active) ? "active" : "";

  const SERVICES = ["send.html", "track.html", "book-fast.html", "chat.html", "meet.html", "ride.html"];
  const NETWORK  = ["buses.html", "agents.html", "houses.html", "trucks.html", "near-me.html", "favorites.html"];
  const ACCOUNT  = ["agent-register.html", "agent.html", "agent-houses.html", "agent-trucks.html", "dashboard.html", "admin.html", "accounting.html", "super-admin.html"];
  const SAAS_PAGES = ["saas.html", "signup.html"];

  const onlinePill = window.DataStore?.isOnline
    ? `<span class="online-pill">${window.t("online_badge")}</span>`
    : "";

  const html = `
    <nav class="navbar">
      <div class="nav-container">
        <a href="index.html" class="nav-brand">
          <span class="logo">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="6" width="18" height="12" rx="2"/>
              <path d="M3 10h18M7 18v2M17 18v2"/>
              <circle cx="8" cy="15" r="1"/><circle cx="16" cy="15" r="1"/>
            </svg>
          </span>
          ${window.t("brand")}<span class="gold">${window.t("brand_2")}</span>
        </a>

        <button class="nav-toggle" aria-label="Menu" aria-expanded="false">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <line x1="3" y1="6"  x2="21" y2="6"/>
            <line x1="3" y1="12" x2="21" y2="12"/>
            <line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>

        <ul class="nav-links">
          <li><a href="index.html" class="nav-top-link ${active === 'index.html' ? 'active' : ''}">${window.t("nav_home")}</a></li>
          <li><a href="saas.html" class="nav-top-link nav-fast-link ${SAAS_PAGES.includes(active) ? 'active' : ''}">${window.t("nav_for_companies") || "For Companies"}</a></li>

          <li class="nav-group">
            <button class="nav-top-link nav-group-btn ${groupActive(SERVICES)}" aria-expanded="false">
              ${window.t("nav_group_services")}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="nav-dropdown">
              ${link("send.html",      "nav_send")}
              ${link("track.html",     "nav_track")}
              ${link("book-fast.html", "nav_book_fast", "nav-fast-link")}
              ${link("book.html",      "nav_book")}
              ${link("ride.html",      "nav_ride", "nav-ride-link")}
              ${link("meet.html",      "nav_meet", "nav-meet-link")}
              ${link("chat.html",      "nav_chat")}
            </div>
          </li>

          <li class="nav-group">
            <button class="nav-top-link nav-group-btn ${groupActive(NETWORK)}" aria-expanded="false">
              ${window.t("nav_group_network")}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="nav-dropdown">
              ${link("buses.html",     "nav_buses")}
              ${link("agents.html",    "nav_agents")}
              ${link("houses.html",    "nav_houses")}
              ${link("trucks.html",    "nav_trucks")}
              ${link("near-me.html",   "nav_near_me")}
              ${link("favorites.html", "nav_favorites")}
            </div>
          </li>

          <li class="nav-group">
            <button class="nav-top-link nav-group-btn ${groupActive(ACCOUNT)}" aria-expanded="false">
              ${window.t("nav_group_account")}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="nav-dropdown">
              ${link("agent-register.html", "nav_agent_register")}
              ${link("agent.html",          "nav_agent_dashboard")}
              ${link("agent-houses.html",   "nav_agent_houses")}
              ${link("agent-trucks.html",   "nav_agent_trucks")}
              ${link("dashboard.html",     "nav_dashboard",   "nav-company-link")}
              ${link("accounting.html",    "nav_finance",     "nav-company-link")}
              ${link("admin.html",          "nav_admin",       "nav-admin-link")}
              ${link("super-admin.html",   "nav_super_admin", "nav-admin-link")}
            </div>
          </li>
        </ul>

        <div class="nav-right">
          ${onlinePill}
          <button id="navSignOut" class="lang-toggle nav-signout" type="button" style="display:none">${window.t("nav_logout") || "Sign out"}</button>
          <button class="lang-toggle" onclick="window.setLang('${lang === 'en' ? 'sw' : 'en'}')">${window.t("lang_toggle")}</button>
        </div>
      </div>
    </nav>
  `;

  const slot = document.getElementById("nav-slot");
  if (slot) slot.outerHTML = html;

  // ---- Dropdown behaviour ----
  document.querySelectorAll(".nav-group").forEach(group => {
    const btn = group.querySelector(".nav-group-btn");
    if (!btn) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = group.classList.contains("open");
      // Close any other open dropdown
      document.querySelectorAll(".nav-group.open").forEach(g => g.classList.remove("open"));
      if (!open) {
        group.classList.add("open");
        btn.setAttribute("aria-expanded", "true");
      } else {
        btn.setAttribute("aria-expanded", "false");
      }
    });
  });

  // Close dropdowns when clicking outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".nav-group")) {
      document.querySelectorAll(".nav-group.open").forEach(g => {
        g.classList.remove("open");
        g.querySelector(".nav-group-btn")?.setAttribute("aria-expanded", "false");
      });
    }
  });

  // Mobile hamburger toggle
  const toggle = document.querySelector(".nav-toggle");
  const links  = document.querySelector(".nav-links");
  toggle?.addEventListener("click", () => {
    const open = links.classList.toggle("open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  // Hide company/admin links until auth is confirmed (fail-closed).
  // NOTE: this is a UX gate only; real authorization is enforced on the
  // destination pages + Supabase RLS. See mobile-nav.js for full security note.
  document.querySelectorAll(".nav-company-link, .nav-admin-link").forEach(el => el.style.display = "none");

  // Universal "Sign out" — works on EVERY page that has the shared nav, so a
  // logged-in user is never stranded without a way out (previously logout
  // lived only on the gated dashboards). Shown only when a Supabase session
  // actually exists; wired here so the handler survives nav re-renders.
  const navSignOut = document.getElementById("navSignOut");
  navSignOut?.addEventListener("click", async () => {
    navSignOut.disabled = true;
    try {
      // Clear the finance page's offline bypass too, so logout is total.
      try { sessionStorage.removeItem("fin_offline_session"); } catch (_) {}
      await window.Auth?.signOut();
    } catch (_) { /* sign out is best-effort — reload regardless */ }
    location.reload();
  });

  (async () => {
    if (!window.Auth) return;
    try {
      const email = await window.Auth.currentEmail();
      if (!email) return;  // not logged in → links stay hidden

      // Logged in (any Supabase user) → expose the universal Sign-out button.
      if (navSignOut) navSignOut.style.display = "";

      // Admin allowlist (APP_CONFIG.ADMIN_EMAILS + admins table).
      if (window.Auth.isAllowedEmail(email)) {
        document.querySelectorAll(".nav-company-link, .nav-admin-link").forEach(el => el.style.display = "");
        return;
      }

      // Tenant users get company links only — NOT admin.
      const sb = window.SB || window.DataStore?.sb;
      if (!sb) return;
      const session = await window.Auth.getSession();
      const uid = session?.user?.id;
      if (!uid) return;

      const { data, error } = await sb
        .from("tenant_users")
        .select("tenant_id")
        .eq("user_id", uid)
        .limit(1);
      if (error || !data || data.length === 0) return;

      document.querySelectorAll(".nav-company-link").forEach(el => el.style.display = "");
    } catch {
      // Fail-closed: any error → links stay hidden.
    }
  })();

  // Lazy-load the floating "Talk to Pawa" widget on every page that has a nav.
  if (!document.querySelector('script[data-pawa-call]')) {
    const s = document.createElement("script");
    s.src = "js/calling-agent.js";
    s.dataset.pawaCall = "1";
    s.async = true;
    document.body.appendChild(s);
  }
};

window.renderFooter = () => {
  const slot = document.getElementById("footer-slot");
  if (slot) {
    slot.outerHTML = `<footer class="footer">
      ${window.t("footer_text")} ${window.t("footer_help")}
      <a href="chat.html">${window.t("footer_chat")}</a>.
    </footer>`;
  }
};
