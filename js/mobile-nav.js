// =====================================================
// Mobile bottom-nav + "More" drawer.
// Bottom tab bar: Home / Book / Send / Chat / More
// More drawer: all remaining services + auth-gated company & admin links.
// =====================================================

(function () {
  const t = (k, fallback) => (window.t ? (window.t(k) || fallback) : fallback);

  const ICONS = {
    home:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10"/></svg>`,
    book:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 18v2M17 18v2"/><circle cx="8" cy="14" r="1"/><circle cx="16" cy="14" r="1"/></svg>`,
    send:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l18-7-7 18-2-8-9-3z"/></svg>`,
    chat:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-12.7 6.5L3 20l1.5-5.3A8 8 0 1 1 21 12z"/></svg>`,
    house: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10"/></svg>`,
    services: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2-2 2.6-2.6z"/></svg>`,
    more:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>`,
  };

  function tabsFor(active) {
    const HIDDEN = (window.APP_CONFIG && window.APP_CONFIG.HIDDEN_NAV) || [];
    return [
      { href: "index.html",     label: t("nav_home", "Home"),         icon: ICONS.home },
      { href: "houses.html",    label: t("nav_houses", "Houses"),     icon: ICONS.house },
      { href: "services.html",  label: t("nav_services", "Services"), icon: ICONS.services },
      { href: "chat.html",      label: t("nav_chat", "Chat"),         icon: ICONS.chat },
      { href: "#more-drawer",   label: t("nav_more", "More"),         icon: ICONS.more, isMore: true },
    ].filter(tab => tab.isMore || !HIDDEN.includes(tab.href))
     .map(tab => ({ ...tab, active: !tab.isMore && active === tab.href }));
  }

  const ACTIVE_MAP = {
    "service.html":        "services.html",
    "house.html":          "houses.html",
    "truck.html":          "trucks.html",
    "admin.html":          null,
    "super-admin.html":    null,
  };

  // ── Drawer HTML ──────────────────────────────────────────────
  function drawerHTML() {
    const HIDDEN = (window.APP_CONFIG && window.APP_CONFIG.HIDDEN_NAV) || [];
    const hidden = (href) => HIDDEN.includes(href);
    const row = (href, icon, label, cls = "") =>
      hidden(href) ? "" :
      `<a href="${href}" class="mnav-row ${cls}"><span class="mnav-row-icon">${icon}</span><span class="mnav-row-label">${label}</span><svg class="mnav-row-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></a>`;

    // Rows that require auth carry both a CSS class and inline display:none so
    // they NEVER render before the auth check resolves — even if JS throws.
    const lockedRow = (href, icon, label, cls) =>
      `<a href="${href}" class="mnav-row ${cls}" style="display:none"><span class="mnav-row-icon">${icon}</span><span class="mnav-row-label">${label}</span><svg class="mnav-row-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></a>`;

    return `
    <div id="more-backdrop" class="mnav-backdrop"></div>
    <div id="more-drawer" class="mnav-drawer" role="dialog" aria-modal="true" aria-label="All services">
      <div class="mnav-grabber"></div>
      <div class="mnav-drawer-scroll">

        <div class="mnav-section-label">Services</div>
        ${row("meet.html",   "", t("nav_meet","Meet & Locate"))}
        ${row("chat.html",   "", t("nav_chat","Chat"))}

        <div class="mnav-section-label">Network</div>
        ${row("houses.html",   "", t("nav_houses","Houses"))}
        ${row("services.html", "", t("nav_services","Services"))}
        ${row("trucks.html",   "", t("nav_trucks","Moving Trucks"))}
        ${row("near-me.html",  "", t("nav_near_me","Near Me"))}
        ${row("favorites.html","", t("nav_favorites","Favorites"))}

        <div class="mnav-section-label">Account</div>
        ${row("agent-houses.html",    "", t("nav_agent_houses","My House Listings"))}
        ${row("agent-services.html",  "", t("nav_agent_services","My Services"))}
        ${row("agent-trucks.html",    "", t("nav_agent_trucks","My Trucks"))}

        <div class="mnav-section-label mnav-admin-section" style="display:none">Admin</div>
        ${lockedRow("admin.html",       "", t("nav_admin","Admin Panel"),    "mnav-admin-row")}
        ${lockedRow("super-admin.html", "", t("nav_super_admin","Super Admin"), "mnav-admin-row")}

      </div>
    </div>`;
  }

  // ── Styles ───────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("mnav-styles")) return;
    const s = document.createElement("style");
    s.id = "mnav-styles";
    s.textContent = `
      /* ── Backdrop ── */
      .mnav-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,.45);
        z-index: 960;
        opacity: 0; pointer-events: none;
        transition: opacity .22s ease;
      }
      .mnav-backdrop.open { opacity: 1; pointer-events: auto; }

      /* ── Drawer ── */
      .mnav-drawer {
        position: fixed; left: 0; right: 0; bottom: 0;
        max-height: 88vh;
        background: #fff;
        border-radius: 22px 22px 0 0;
        box-shadow: 0 -8px 40px rgba(0,0,0,.18);
        z-index: 970;
        transform: translateY(100%);
        transition: transform .26s cubic-bezier(.21,.84,.34,1);
        display: flex; flex-direction: column;
        padding-bottom: calc(env(safe-area-inset-bottom,0px) + 16px);
      }
      .mnav-drawer.open { transform: translateY(0); }

      .mnav-grabber {
        width: 44px; height: 4px; border-radius: 2px;
        background: #cbd5e1; margin: 10px auto 6px; flex-shrink: 0;
      }

      .mnav-drawer-scroll {
        overflow-y: auto; flex: 1; padding: 4px 0 8px;
        -webkit-overflow-scrolling: touch;
      }

      /* ── Section label ── */
      .mnav-section-label {
        font-size: 0.65rem; font-weight: 900;
        letter-spacing: 1.4px; text-transform: uppercase;
        color: #94a3b8;
        padding: 14px 20px 6px;
      }
      .mnav-section-label:first-child { padding-top: 8px; }

      /* ── Row ── */
      .mnav-row {
        display: flex; align-items: center; gap: 14px;
        padding: 13px 20px;
        color: #1e293b; text-decoration: none;
        transition: background .12s;
        border-radius: 0;
      }
      .mnav-row:hover, .mnav-row:active { background: #f0fdf4; color: #065f46; }
      .mnav-row-icon { font-size: 1.3rem; width: 28px; text-align: center; flex-shrink: 0; }
      .mnav-row-label { flex: 1; font-size: 0.97rem; font-weight: 600; }
      .mnav-row-chev { width: 16px; height: 16px; color: #cbd5e1; flex-shrink: 0; }
    `;
    document.head.appendChild(s);
  }

  // ── Bottom nav HTML ──────────────────────────────────────────
  function bottomNavHTML(tabs) {
    return `<nav class="bottom-nav" role="navigation" aria-label="Primary">
      <div class="bottom-nav-inner">
        ${tabs.map(tab => tab.isMore
          ? `<button class="mnav-more-btn ${tab.active ? 'active' : ''}" id="mnav-more-btn" aria-haspopup="dialog">
              ${tab.icon}<span>${tab.label}</span>
             </button>`
          : `<a href="${tab.href}" class="${tab.active ? 'active' : ''}" aria-current="${tab.active ? 'page' : 'false'}">
              ${tab.icon}<span>${tab.label}</span>
             </a>`
        ).join("")}
      </div>
    </nav>`;
  }

  // ── Auth-gate company/admin rows ─────────────────────────────
  // SECURITY NOTE: This only controls *visibility* of links in the drawer.
  // It is NOT a security boundary — a determined user can navigate to admin
  // pages directly. Real authorization MUST be enforced by:
  //   1. The destination page (admin.html, dashboard.html, etc.) checking
  //      auth on load and redirecting away if unauthorized.
  //   2. Supabase Row-Level Security on every sensitive table.
  // Hiding here is purely UX — it prevents accidental clicks and clutter
  // for users who shouldn't see those features.
  async function applyAuthGating() {
    const show = (sel) => document.querySelectorAll(sel).forEach(el => el.style.display = "");
    const hide = (sel) => document.querySelectorAll(sel).forEach(el => el.style.display = "none");
    const COMPANY = ".mnav-company-row, .mnav-company-section";
    const ADMIN   = ".mnav-admin-row, .mnav-admin-section";

    // Default-deny: always hide first, then reveal only what auth proves.
    hide(COMPANY);
    hide(ADMIN);

    if (!window.Auth) return;
    try {
      const email = await window.Auth.currentEmail();
      if (!email) return;  // not logged in → keep everything hidden

      // Admin path — strict allowlist from APP_CONFIG.ADMIN_EMAILS + admins table.
      if (window.Auth.isAllowedEmail(email)) {
        show(COMPANY);
        show(ADMIN);
        return;
      }

      // Company/tenant path — must have a row in tenant_users (RLS-protected).
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

      show(COMPANY);
      // NOTE: tenant users do NOT get admin links — admin stays hidden.
    } catch {
      // On any failure, leave links hidden (fail-closed).
    }
  }

  // ── Mount ────────────────────────────────────────────────────
  window.renderMobileNav = (currentPage) => {
    if (document.querySelector(".bottom-nav")) return;

    injectStyles();

    const active = ACTIVE_MAP.hasOwnProperty(currentPage) ? ACTIVE_MAP[currentPage] : currentPage;

    // Inject bottom nav
    const navWrap = document.createElement("div");
    navWrap.innerHTML = bottomNavHTML(tabsFor(active || ""));
    document.body.appendChild(navWrap.firstElementChild);

    // Inject drawer + backdrop
    const drawerWrap = document.createElement("div");
    drawerWrap.innerHTML = drawerHTML();
    document.body.appendChild(drawerWrap);

    const drawer   = document.getElementById("more-drawer");
    const backdrop = document.getElementById("more-backdrop");
    const moreBtn  = document.getElementById("mnav-more-btn");

    function openDrawer() {
      drawer.classList.add("open");
      backdrop.classList.add("open");
      applyAuthGating();
    }
    function closeDrawer() {
      drawer.classList.remove("open");
      backdrop.classList.remove("open");
    }

    moreBtn?.addEventListener("click", openDrawer);
    backdrop.addEventListener("click", closeDrawer);

    // Pre-evaluate auth at mount so admin/company rows are already in the
    // correct state before the user even taps "More". Re-runs on open as
    // a safety net (auth state could change while the page is open).
    applyAuthGating();

    // Swipe down to close
    let startY = 0;
    drawer.addEventListener("touchstart", e => { startY = e.touches[0].clientY; }, { passive: true });
    drawer.addEventListener("touchend", e => {
      if (e.changedTouches[0].clientY - startY > 60) closeDrawer();
    }, { passive: true });

    // Close when navigating from a drawer link
    drawer.querySelectorAll(".mnav-row").forEach(a => {
      a.addEventListener("click", closeDrawer);
    });
  };

  // Extra CSS for the More button to match bottom-nav links style
  (function patchBottomNavCSS() {
    const s = document.createElement("style");
    s.textContent = `
      .mnav-more-btn {
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        gap: 2px;
        background: none; border: none; cursor: pointer;
        color: var(--gray, #64748b);
        font-size: 0.7rem; font-weight: 600;
        padding: 6px 4px; width: 100%; height: 100%;
        position: relative;
      }
      .mnav-more-btn:hover, .mnav-more-btn.active { color: var(--green, #0a6f4d); }
      .mnav-more-btn svg { width: 22px; height: 22px; }
    `;
    document.head.appendChild(s);
  })();

  // Auto-mount on DOMContentLoaded
  document.addEventListener("DOMContentLoaded", () => {
    const page = document.body.dataset.page;
    if (page === undefined) return;
    window.renderMobileNav(page || "index.html");
  });
})();
