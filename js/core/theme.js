// ============================================================================
//  Theme switch  (user-selectable Light / Dark — "Twilight" stays the default)
//  - Sets data-theme on <html> BEFORE first paint (load this FIRST in <head>
//    with no defer/async) so there is no flash of the wrong theme.
//  - Persists the explicit choice in localStorage; default = dark (brand).
//  - Injects a native-feeling floating sun/moon toggle, safe-area aware.
//  - Public API: window.PawaTheme.{ get(), set('light'|'dark'), toggle() }
//    Fires a `pawa:themechange` event on window so pages can react.
// ============================================================================

(function () {
  "use strict";

  var KEY = "pawa-theme";                       // 'light' | 'dark'
  var root = document.documentElement;

  function stored() {
    try { return localStorage.getItem(KEY); } catch (_) { return null; }
  }
  // Explicit choice wins; otherwise default to dark ("Twilight" identity).
  function resolve() {
    var s = stored();
    return (s === "light" || s === "dark") ? s : "dark";
  }
  function apply(theme) {
    root.setAttribute("data-theme", theme);
    root.style.colorScheme = theme;             // native controls + scrollbars
  }

  // Apply immediately so the very first paint is already correct.
  apply(resolve());

  function current() { return root.getAttribute("data-theme") || "dark"; }
  function save(theme) {
    try { localStorage.setItem(KEY, theme); } catch (_) {}
  }
  function set(theme) {
    if (theme !== "light" && theme !== "dark") return;
    apply(theme);
    save(theme);
    syncButton();
    try {
      window.dispatchEvent(new CustomEvent("pawa:themechange", { detail: { theme: theme } }));
    } catch (_) {}
  }
  function toggle() { set(current() === "dark" ? "light" : "dark"); }

  window.PawaTheme = { get: current, set: set, toggle: toggle };

  // ── Floating toggle control ────────────────────────────────────────────
  var SUN = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="4.2" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 14.2A8 8 0 1 1 9.8 4a6.5 6.5 0 0 0 10.2 10.2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

  var btn = null;

  function syncButton() {
    if (!btn) return;
    var dark = current() === "dark";
    // Show the icon of the mode you'll switch TO.
    btn.innerHTML = dark ? SUN : MOON;
    // Translated: this button rides on every page, so leaving it in English
    // meant every page in the app had two untranslated strings on it.
    var T = function (k, en) { return window.t ? window.t(k) : en; };
    var label = dark ? T("theme_to_light", "Switch to light mode")
                     : T("theme_to_dark", "Switch to dark mode");
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
  }

  function injectStyles() {
    if (document.getElementById("pawa-theme-toggle-styles")) return;
    var s = document.createElement("style");
    s.id = "pawa-theme-toggle-styles";
    s.textContent = [
      ".pawa-theme-toggle{",
      "  position:fixed; z-index:1000;",
      "  top:calc(env(safe-area-inset-top,0px) + 10px); right:12px;",
      "  width:42px; height:42px; border-radius:50%;",
      "  display:flex; align-items:center; justify-content:center;",
      "  cursor:pointer; -webkit-tap-highlight-color:transparent;",
      "  border:1px solid rgba(255,255,255,.14);",
      "  background:rgba(14,24,18,.55); color:#e7f1ec;",
      "  -webkit-backdrop-filter:blur(14px) saturate(1.1); backdrop-filter:blur(14px) saturate(1.1);",
      "  box-shadow:0 6px 20px rgba(0,0,0,.28);",
      "  transition:opacity .28s ease, transform .28s cubic-bezier(.2,.7,.2,1), background .25s ease, color .25s ease, border-color .25s ease;",
      "}",
      ".pawa-theme-toggle:active{ transform:scale(.9); }",
      // Resting state: out of the way, but still in the layout so the bell
      // below it does not move when it goes. pointer-events:none because a
      // control you cannot see must not be a control you can press by accident.
      ".pawa-theme-toggle.is-idle{",
      "  opacity:0; transform:translateY(-6px) scale(.94); pointer-events:none;",
      "}",
      ".pawa-theme-toggle svg{ width:21px; height:21px; transition:transform .35s cubic-bezier(.2,.7,.2,1); }",
      ".pawa-theme-toggle:hover svg{ transform:rotate(35deg); }",
      // Light-theme appearance of the button itself.
      ":root[data-theme=\"light\"] .pawa-theme-toggle{",
      "  background:rgba(255,255,255,.72); color:#1a1915;",
      "  border-color:rgba(20,20,15,.10);",
      "  box-shadow:0 6px 18px rgba(20,30,25,.14);",
      "}",
      "@media (prefers-reduced-motion: reduce){",
      "  .pawa-theme-toggle, .pawa-theme-toggle svg{ transition:none; }",
      "  .pawa-theme-toggle:hover svg{ transform:none; }",
      "  .pawa-theme-toggle.is-idle{ transform:none; }",
      "}",
    ].join("\n");
    document.head.appendChild(s);
  }


  // ── Auto-hide ──────────────────────────────────────────────────────────
  // The toggle is a control you use once and then stop thinking about, and it
  // sits over the top-right corner of every page — which on a phone is where
  // the content is. So it shows itself for five seconds and then gets out of
  // the way, and any sign of life brings it back for another five.
  //
  // "Any sign of life" is deliberately wide: a tap, a mouse move, a scroll, a
  // key, or coming back to the tab. Somebody who wants the toggle should never
  // have to work out what the magic gesture is; on a phone, touching the screen
  // is the whole vocabulary.
  //
  // It is only ever HIDDEN, never removed: the notification bell below it is
  // positioned against the same corner, and a control that leaves the layout
  // would drag the bell up and down the screen every five seconds.
  var IDLE_MS = 5000;
  var idleTimer = null;

  // The idle state is published on <html> as well as on the button, because
  // the notification bell is stacked underneath this control and has to close
  // the gap when it goes. A class is the whole contract: neither file has to
  // know the other exists, and a page without a bell is unaffected.
  function setIdle(idle) {
    if (!btn) return;
    btn.classList.toggle("is-idle", idle);
    root.classList.toggle("pawa-toggle-idle", idle);
  }

  function wake() {
    if (!btn) return;
    setIdle(false);
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      // Never fade out from under the pointer, or under a keyboard user who is
      // focused on it and about to press it.
      if (!btn) return;
      if (btn.matches(":hover") || document.activeElement === btn) { wake(); return; }
      setIdle(true);
    }, IDLE_MS);
  }

  function watchForLife() {
    ["pointerdown", "pointermove", "touchstart", "keydown", "wheel", "scroll"].forEach(function (ev) {
      window.addEventListener(ev, wake, { passive: true });
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") wake();
    });
  }

  function inject() {
    if (document.getElementById("pawa-theme-toggle")) return;
    if (!document.body) return;
    injectStyles();
    btn = document.createElement("button");
    btn.id = "pawa-theme-toggle";
    btn.type = "button";
    btn.className = "pawa-theme-toggle";
    btn.addEventListener("click", toggle);
    document.body.appendChild(btn);
    syncButton();
    watchForLife();
    wake();               // five seconds of "here I am", then out of the way
  }

  if (document.body) inject();
  document.addEventListener("DOMContentLoaded", inject);
})();
