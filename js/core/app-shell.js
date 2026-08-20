// ============================================================================
//  App shell  (pure native-style chrome for the "Twilight" design pages)
//  - Hides the desktop top nav + the legacy mobile bottom-nav so the screen
//    reads like a real iOS/Android app (in-app header + one bottom tab bar).
//  - Renders the design's 5-tab bar (Home / Explore / P-Chat / P-Message /
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
    pchat: `<svg viewBox="0 0 24 24" fill="none"><path d="M20 12.5a7 7 0 01-7 7H8l-4 3v-4.6A7 7 0 018 5.5h5a7 7 0 017 7z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9.5 15.5V9h3a2.2 2.2 0 010 4.4h-3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    // A speech bubble with a padlock: P-Message is the encrypted one, and the
    // tab bar is the first place that should say so.
    pmessage: `<svg viewBox="0 0 24 24" fill="none"><path d="M21 14a2 2 0 01-2 2H8l-4 3V6a2 2 0 012-2h13a2 2 0 012 2z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><rect x="9.2" y="8.4" width="5.6" height="4" rx="1" stroke="currentColor" stroke-width="1.5"/><path d="M10.6 8.4V7.2a1.4 1.4 0 012.8 0v1.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    profile: `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.7"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  };

  // Which tab a given page belongs to.
  const TAB_OF = {
    "index.html": "home", "": "home",
    "explore.html": "explore",
    "houses.html": "explore", "house.html": "explore", "trucks.html": "explore",
    "truck.html": "explore", "services.html": "explore", "service.html": "explore",
    "near-me.html": "explore", "frame.html": "explore", "jobs.html": "explore",
    "area.html": "explore",
    // Saved listings come out of the catalogue, so favorites.html now lights
    // Explore rather than a tab of its own — its slot in the bar became P-Chat.
    "favorites.html": "explore",
    "p-chat.html": "pchat",
    "p-message.html": "pmessage",
    // chat.html keeps the assistant, the voice agent and the support numbers.
    // P-Message links to it rather than swallowing it.
    "chat.html": "pmessage", "meet.html": "pmessage",
    "profile.html": "profile",
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
        /* .4 painted these 10px labels at 3.44:1 on the bar's own background —
           under the 4.5 the rest of the app holds itself to. .58 keeps the
           inactive/active distinction while staying legible. */
        text-decoration: none; padding: 4px 0; color: rgba(231,241,236,.58);
        -webkit-tap-highlight-color: transparent;
      }
      .app-tabbar a svg { width: 23px; height: 23px; }
      .app-tabbar a span { font-size: 10px; font-weight: 700; }
      .app-tabbar a.active { color: #2EE6A6; }

      /* The bar rides on all 21 app-shell pages, so its colours were the one
         thing a page's light theme could never reach: they are written here,
         not in a stylesheet the page controls. Without this block the tab bar
         stayed a dark slab across the foot of a fully light page. */
      :root[data-theme="light"] .app-tabbar {
        background: rgba(255,255,255,.88);
        border-top: 1px solid rgba(20,32,27,.10);
        box-shadow: 0 -2px 16px rgba(20,40,32,.07);
      }
      :root[data-theme="light"] .app-tabbar a { color: rgba(20,32,27,.65); }
      :root[data-theme="light"] .app-tabbar a.active { color: #0A6647; }

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
      // Explore is the global view across all four catalogues. It used to point
      // at houses.html, which meant the "Explore" tab could only ever show one
      // quarter of what the site offers.
      { id: "explore", href: "explore.html", label: t("tab_explore", "Explore"), icon: ICON.explore },
      { id: "pchat", href: "p-chat.html", label: t("tab_pchat", "P-Chat"), icon: ICON.pchat },
      { id: "pmessage", href: "p-message.html", label: t("tab_pmessage", "P-Message"), icon: ICON.pmessage },
      { id: "profile", href: "profile.html", label: t("tab_profile", "Profile"), icon: ICON.profile },
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

    // The Profile tab used to rewrite itself to agent-houses.html for signed-in
    // users, because login.html had nothing to offer them. profile.html serves
    // every state itself, so the tab now goes to one place for everyone.
  }

  if (document.body) {
    if (document.body.hasAttribute("data-app-shell") || document.body.dataset.page === "index") render();
  }
  document.addEventListener("DOMContentLoaded", () => {
    if (document.body.hasAttribute("data-app-shell") || document.body.dataset.page === "index") render();
  });
})();
