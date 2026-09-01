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
    // P-Chat's own tool — no other door leads here, so it is not a shared page.
    // It was missing from this map entirely, which silently lit Home.
    "share-location.html": "pchat",
    "p-message.html": "pmessage",
    // chat.html is the support numbers, and only those: the assistant and the
    // voice agent are PN-Zaki now, inside P-Message itself. It still lights
    // this tab because P-Message is the page that links to it.
    "chat.html": "pmessage", "meet.html": "pmessage",
    "profile.html": "profile",
    "login.html": "profile", "agent-houses.html": "profile",
    "agent-services.html": "profile", "agent-trucks.html": "profile",
    "admin.html": "profile", "super-admin.html": "profile",
  };

  // ── Which tab owns this visit ─────────────────────────────────────────────
  //  TAB_OF answers "which tab owns this PAGE", which is not the same question
  //  as "which tab owns this VISIT". Several pages are shared: near-me, area,
  //  frame, jobs and houses' ?life= / ?alert= / ?request= modes are errands you
  //  start in P-Chat, but they are also catalogue pages you reach from Explore.
  //  Resolving by filename alone lit Explore the instant you tapped a P-Chat
  //  row, so the tab you were standing in went dark mid-errand.
  //
  //  A link may therefore name its origin with ?from=<tab>. That wins over the
  //  filename. Nothing is copied and no page moves — only the lit tab changes.
  //
  //  The choice is remembered per file (not globally) so a reload keeps it,
  //  while walking on to a different page correctly falls back to that page's
  //  own owner: from near-me you are still in the errand, but from the house
  //  you opened out of it you are in the catalogue.
  const TAB_IDS = ["home", "explore", "pchat", "pmessage", "profile"];
  const CTX_KEY = "pawa-tab-from:";

  function resolveTab(file) {
    const fallback = TAB_OF[file] || "home";
    let from = "";
    try { from = new URLSearchParams(location.search).get("from") || ""; } catch (_) {}
    from = from.toLowerCase();

    if (TAB_IDS.includes(from)) {
      try { sessionStorage.setItem(CTX_KEY + file, from); } catch (_) {}
      return from;
    }
    // No param. That is either a reload/back that dropped it, or a genuinely
    // fresh arrival from somewhere else — and those must not be confused:
    // reaching jobs.html from Explore has to light Explore even if an earlier
    // P-Chat errand once stored a context for this same file.
    let nav = "";
    try { nav = (performance.getEntriesByType("navigation")[0] || {}).type || ""; } catch (_) {}
    const resumed = nav === "reload" || nav === "back_forward";
    try {
      if (!resumed) sessionStorage.removeItem(CTX_KEY + file);
      else {
        const kept = sessionStorage.getItem(CTX_KEY + file);
        if (kept && TAB_IDS.includes(kept)) return kept;
      }
    } catch (_) {}
    return fallback;
  }

  // ── The two chromes ───────────────────────────────────────────────────────
  //  Both are built, once, and CSS shows whichever `data-shell` on <html>
  //  asks for. Building only the active one meant re-rendering on every view
  //  change and re-deriving the active tab each time; building both means the
  //  switch is a repaint and nothing else, which is why it can be instant.
  //
  //  APP is the bottom tab bar: five destinations, thumb-height, fixed. It is
  //  the right shape on a phone with room for it.
  //  WEB is a sticky top rail that scrolls away going down and returns coming
  //  up. It is the right shape when there is no room to keep 120px of the
  //  screen permanently spoken for, which on an iPhone X in Safari is a fifth
  //  of everything the person can see.

  function injectStyles() {
    if (document.getElementById("appshell-styles")) return;
    const s = document.createElement("style");
    s.id = "appshell-styles";
    s.textContent = `
      /* Pure app-shell: the desktop top nav + legacy mobile bottom-nav are
         replaced by the in-app header + one of the two chromes below. */
      body[data-app-shell] .navbar,
      body[data-app-shell] #nav-slot,
      body[data-app-shell] .footer,
      body[data-app-shell] #footer-slot,
      body[data-app-shell] .bottom-nav { display: none !important; }
      body[data-app-shell] { padding-bottom: 0 !important; }

      .app-tabbar {
        position: fixed; left: 50%; transform: translateX(-50%);
        bottom: 0; width: 100%; max-width: 560px; z-index: 900;
        display: flex;
        /* The insets come from js/core/viewport.js, which measures them once
           and republishes them as ordinary custom properties. env() is kept
           as the fallback so the bar is still correct before script runs. */
        padding: 8px 14px calc(var(--sa-bottom, env(safe-area-inset-bottom, 0px)) + 10px);
        padding-left: calc(var(--sa-left, 0px) + 14px);
        padding-right: calc(var(--sa-right, 0px) + 14px);
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
        min-width: 0;
      }
      .app-tabbar a svg { width: 23px; height: 23px; }
      .app-tabbar a span {
        font-size: 10px; font-weight: 700;
        max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .app-tabbar a.active { color: #2EE6A6; }

      /* A cramped screen keeps the bar but stops it eating the page: the icons
         come down 3px and the vertical padding halves. Below that it would be
         under the 44px hit minimum, so this is as small as it goes — the
         answer on a screen smaller still is the web chrome, not a smaller
         bar. */
      :root[data-vp="compact"] .app-tabbar { padding-top: 5px; }
      :root[data-vp="compact"] .app-tabbar a { gap: 3px; padding: 2px 0; }
      :root[data-vp="compact"] .app-tabbar a svg { width: 20px; height: 20px; }
      :root[data-vp="compact"] .app-tabbar a span { font-size: 9.5px; }

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

      /* Room so the last content clears whichever chrome is showing. In web
         mode --app-bottom is just the home indicator, so the spacer collapses
         to 0 on a phone without one and the page ends where it ends. */
      .app-shell-pad { height: calc(var(--app-bottom, 86px) + 12px); }
      :root[data-shell="web"] .app-shell-pad { height: calc(var(--sa-bottom, 0px) + 8px); }
    `;
    document.head.appendChild(s);
  }

  function tabList() {
    return [
      { id: "home", href: "index.html", label: t("nav_home", "Home"), icon: ICON.home },
      // Explore is the global view across all four catalogues. It used to point
      // at houses.html, which meant the "Explore" tab could only ever show one
      // quarter of what the site offers.
      { id: "explore", href: "explore.html", label: t("tab_explore", "Explore"), icon: ICON.explore },
      { id: "pchat", href: "p-chat.html", label: t("tab_pchat", "P-Chat"), icon: ICON.pchat },
      { id: "pmessage", href: "p-message.html", label: t("tab_pmessage", "P-Message"), icon: ICON.pmessage },
      { id: "profile", href: "profile.html", label: t("tab_profile", "Profile"), icon: ICON.profile },
    ];
  }

  // ── The web nav hides on the way down ─────────────────────────────────────
  //  Only downward, only past the fold, and it comes straight back on the
  //  first upward pixel. A header that hides while you are reading and
  //  reappears the moment you look for it is the reason a web page feels
  //  roomier than an app on the same screen.
  function wireScrollAway(nav) {
    let last = window.scrollY;
    let ticking = false;
    const REVEAL_AT = 8;   // an upward nudge this small still counts
    const ARM_AFTER = 120; // never hide while the top of the page is in view

    function frame() {
      ticking = false;
      const y = window.scrollY;
      const down = y > last;
      // A view change can leave the class on while the nav is not even
      // showing; cheap to keep it honest here rather than track it.
      if (y <= ARM_AFTER) nav.classList.remove("is-hidden");
      else if (down && y - last > 2) nav.classList.add("is-hidden");
      else if (!down && last - y > REVEAL_AT) nav.classList.remove("is-hidden");
      last = y;
    }
    window.addEventListener("scroll", () => {
      if (!ticking) { ticking = true; requestAnimationFrame(frame); }
    }, { passive: true });
  }

  function render() {
    if (document.querySelector(".app-tabbar")) return;
    injectStyles();

    const file = (document.body.dataset.appShell ||
      location.pathname.split("/").pop() || "index.html").toLowerCase();
    const active = resolveTab(file);
    const tabs = tabList();

    const mark = (tab) =>
      `${tab.id === active ? ' class="active" aria-current="page"' : ""}`;

    // The bottom bar.
    const nav = document.createElement("nav");
    nav.className = "app-tabbar";
    nav.setAttribute("aria-label", t("nav_primary", "Primary"));
    nav.innerHTML = tabs.map((tab) =>
      `<a href="${tab.href}"${mark(tab)}>${tab.icon}<span>${tab.label}</span></a>`
    ).join("");

    // The top rail. Same five destinations, same active tab, different shape:
    // it is one row, it scrolls sideways rather than shrinking its labels, and
    // it is part of the document instead of bolted to the bottom edge.
    const web = document.createElement("nav");
    web.className = "app-webnav";
    web.setAttribute("aria-label", t("nav_primary", "Primary"));
    web.innerHTML =
      `<div class="app-webnav-rail">` +
      tabs.map((tab) =>
        `<a href="${tab.href}"${mark(tab)}>${tab.icon}<span>${tab.label}</span></a>`
      ).join("") +
      `</div>`;

    // The rail goes at the very top of the body so it is the first thing in
    // the flow and `position: sticky` has something to stick to.
    document.body.insertBefore(web, document.body.firstChild);
    document.body.appendChild(nav);
    wireScrollAway(web);

    // Spacer so the fixed bar never covers the final content.
    if (!document.querySelector(".app-shell-pad")) {
      const pad = document.createElement("div");
      pad.className = "app-shell-pad";
      nav.parentNode.insertBefore(pad, nav);
    }

    // The Profile tab used to rewrite itself to agent-houses.html for signed-in
    // users, because login.html had nothing to offer them. profile.html serves
    // every state itself, so the tab now goes to one place for everyone.

    // A view change is a repaint, not a rebuild — but the rail may have been
    // hidden by a scroll that happened in the other shell, so it is reset.
    window.addEventListener("pawa:viewchange", () => {
      web.classList.remove("is-hidden");
    });
  }

  if (document.body) {
    if (document.body.hasAttribute("data-app-shell") || document.body.dataset.page === "index") render();
  }
  document.addEventListener("DOMContentLoaded", () => {
    if (document.body.hasAttribute("data-app-shell") || document.body.dataset.page === "index") render();
  });
})();
