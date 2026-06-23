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
    var label = dark ? "Switch to light mode" : "Switch to dark mode";
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
      "  transition:transform .18s cubic-bezier(.2,.7,.2,1), background .25s ease, color .25s ease, border-color .25s ease;",
      "}",
      ".pawa-theme-toggle:active{ transform:scale(.9); }",
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
      "}",
    ].join("\n");
    document.head.appendChild(s);
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
  }

  if (document.body) inject();
  document.addEventListener("DOMContentLoaded", inject);
})();
