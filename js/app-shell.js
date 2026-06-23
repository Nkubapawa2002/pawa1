// ============================================================================
//  App shell  (pure native-style chrome for the "Twilight" design pages)
//  - Hides the desktop top nav + the legacy mobile bottom-nav so the screen
//    reads like a real iOS/Android app (in-app header + one bottom tab bar).
//  - Renders the design's 5-tab bar (Home / Explore / Saved / Messages /
//    Profile), wired to the real pages, with the active tab lit.
//  - Self-contained CSS so it works on any page that loads it.
//  Opt in per page with  <body data-app-shell="index.html">  (value = the
//  filename used to resolve the active tab; falls back to the URL).
// ============================================================================

(function () {
  const t = (k, f) => (window.t && window.t(k)) || f;

  const ICON = {
    home: `<svg viewBox="0 0 24 24" fill="none"><path d="M3 11l9-7 9 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 10v10h14V10" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
    explore: `<svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="M21 21l-4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    saved: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 20s-6.8-4.2-9.1-8.5C1.4 8.4 2.8 5.5 5.7 5.5c1.8 0 3 1 3.8 2.1l.5.7.5-.7c.8-1.1 2-2.1 3.8-2.1 2.9 0 4.3 2.9 2.8 6C18.8 15.8 12 20 12 20z" stroke="currentColor" stroke-width="1.7"/></svg>`,
    messages: `<svg viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H8l-4 3V6a2 2 0 012-2h13a2 2 0 012 2z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`,
    profile: `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.7"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  };

  // Which tab a given page belongs to.
  const TAB_OF = {
    "index.html": "home", "": "home",
    "houses.html": "explore", "house.html": "explore", "trucks.html": "explore",
    "truck.html": "explore", "services.html": "explore", "service.html": "explore",
    "near-me.html": "explore", "frame.html": "explore", "jobs.html": "explore",
    "area.html": "explore",
    "favorites.html": "saved",
    "chat.html": "messages", "meet.html": "messages",
    "login.html": "profile", "agent-houses.html": "profile",
    "agent-services.html": "profile", "agent-trucks.html": "profile",
    "admin.html": "profile", "super-admin.html": "profile",
  };

  function injectStyles() {
    if (document.getElementById("appshell-styles")) return;
    const s = document.createElement("style");
    s.id = "appshell-styles";
    s.textContent = `
      /* Pure app-shell: the desktop top nav + legacy mobile bottom-nav are
         replaced by the in-app header + this single tab bar. */
      body[data-app-shell] .navbar,
      body[data-app-shell] #nav-slot,
      body[data-app-shell] .footer,
      body[data-app-shell] #footer-slot,
      body[data-app-shell] .bottom-nav { display: none !important; }
      body[data-app-shell] { padding-bottom: 0 !important; }

      .app-tabbar {
        position: fixed; left: 50%; transform: translateX(-50%);
        bottom: 0; width: 100%; max-width: 560px; z-index: 900;
        display: flex; padding: 10px 14px calc(env(safe-area-inset-bottom, 0px) + 14px);
        background: rgba(8,16,12,.82);
        -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
        border-top: 1px solid rgba(255,255,255,.07);
        font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      }
      .app-tabbar a {
        flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px;
        text-decoration: none; padding: 4px 0; color: rgba(231,241,236,.4);
        -webkit-tap-highlight-color: transparent;
      }
      .app-tabbar a svg { width: 23px; height: 23px; }
      .app-tabbar a span { font-size: 10px; font-weight: 700; }
      .app-tabbar a.active { color: #2EE6A6; }
      /* room so the last content clears the fixed bar */
      .app-shell-pad { height: calc(86px + env(safe-area-inset-bottom, 0px)); }
    `;
    document.head.appendChild(s);
  }

  function render() {
    if (document.querySelector(".app-tabbar")) return;
    injectStyles();

    const file = (document.body.dataset.appShell ||
      location.pathname.split("/").pop() || "index.html").toLowerCase();
    const active = TAB_OF[file] || "home";

    const tabs = [
      { id: "home", href: "index.html", label: t("nav_home", "Home"), icon: ICON.home },
      { id: "explore", href: "houses.html", label: t("tab_explore", "Explore"), icon: ICON.explore },
      { id: "saved", href: "favorites.html", label: t("tab_saved", "Saved"), icon: ICON.saved },
      { id: "messages", href: "chat.html", label: t("tab_messages", "Messages"), icon: ICON.messages },
      { id: "profile", href: "login.html", label: t("tab_profile", "Profile"), icon: ICON.profile },
    ];

    const nav = document.createElement("nav");
    nav.className = "app-tabbar";
    nav.setAttribute("aria-label", "Primary");
    nav.innerHTML = tabs.map((tab) =>
      `<a href="${tab.href}" class="${tab.id === active ? "active" : ""}"${tab.id === active ? ' aria-current="page"' : ""}>${tab.icon}<span>${tab.label}</span></a>`
    ).join("");
    document.body.appendChild(nav);

    // Spacer so fixed bar never covers the final content.
    if (!document.querySelector(".app-shell-pad")) {
      const pad = document.createElement("div");
      pad.className = "app-shell-pad";
      nav.parentNode.insertBefore(pad, nav);
    }

    // Profile → send signed-in users to their dashboard instead of the login form.
    (async () => {
      try {
        const email = window.Auth && (await window.Auth.currentEmail());
        if (email) {
          const a = nav.querySelector('a[href="login.html"]');
          if (a) a.setAttribute("href", "agent-houses.html");
        }
      } catch (_) {}
    })();
  }

  if (document.body) {
    if (document.body.hasAttribute("data-app-shell") || document.body.dataset.page === "index") render();
  }
  document.addEventListener("DOMContentLoaded", () => {
    if (document.body.hasAttribute("data-app-shell") || document.body.dataset.page === "index") render();
  });
})();
