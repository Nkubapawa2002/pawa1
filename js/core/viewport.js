// ============================================================================
//  Viewport  (the one place that knows how big the screen really is)
//
//  Three facts every screen needs and none of them could get from CSS alone:
//
//  1. THE REAL HEIGHT. `100vh` on iOS Safari is the height the page would have
//     if the browser chrome were gone, not the height you can see. On an
//     iPhone X that is 812 against a visible 635, so a "full height" panel
//     hangs 177px past the bottom of the screen and its last row, usually the
//     one with the button, is unreachable. This writes `--app-vh` from the
//     visual viewport and keeps it current.
//
//  2. THE NOTCH. `env(safe-area-inset-*)` only exists inside CSS, so nothing
//     could branch on it. The insets are probed once and republished as
//     `--sa-top` .. `--sa-right`, which are ordinary custom properties: CSS can
//     use them in `calc()`, JS can read them, and a test can fake them.
//
//  3. WHICH SHELL THIS DEVICE WANTS. A 375x812 phone with a notch has about
//     515 usable pixels in Safari. The native app chrome, tuned for a 390-430
//     phone, spends 120 of them on a bottom tab bar. That is the screen the
//     app looked worst on, so a device that cramped is handed the web layout
//     instead, which scrolls its chrome away.
//
//  Load FIRST in <head>, no defer, immediately after theme.js: the shell and
//  the page stylesheets both branch on what this stamps, and stamping it after
//  first paint is a visible jump.
//
//  Public API, window.PawaView:
//    .mode()                 'app' or 'web', what is showing now
//    .pref()                 'app', 'web' or 'auto'
//    .set(pref)              persist a preference and apply it
//    .metrics()              { w, h, vh, safe, compact, notch, ... }
//    .isCompact()            true on a screen too small for the app chrome
//  Fires `pawa:viewchange` on window with { mode, pref, reason }.
// ============================================================================

(function () {
  "use strict";

  var root = document.documentElement;
  var PREF_KEY = "pawa-view";        // 'app' | 'web' | 'auto'
  var SIM_KEY = "pawa-safe-sim";     // test-only inset override, see readSafe()

  // -- Thresholds ------------------------------------------------------------
  // Named, because each one is a real device and not a round number somebody
  // liked. 380 is above the iPhone X / SE / mini width (375) and below the
  // iPhone 13 (390). 700 is the visible height an iPhone X has in Safari once
  // its own toolbars are counted (635) plus headroom. 900 is where a tablet
  // stops being a phone.
  var COMPACT_W = 380;
  var SHORT_H = 700;
  var WIDE_W = 900;

  // -- Safe-area insets ------------------------------------------------------
  // env() is only legal inside a CSS declaration, so the only way to learn the
  // numbers is to spend them on a throwaway element and read them back.
  var probe = null;
  function readSafe() {
    // A test cannot give Chrome a notch, and the notch is the whole reason
    // this file exists, so the insets can be simulated. Only ever set by a
    // test; a real device never writes this key.
    try {
      var sim = localStorage.getItem(SIM_KEY);
      if (sim) {
        var p = JSON.parse(sim);
        return {
          top: +p.top || 0, bottom: +p.bottom || 0,
          left: +p.left || 0, right: +p.right || 0, simulated: true,
        };
      }
    } catch (_) {}

    if (!probe) {
      probe = document.createElement("div");
      probe.setAttribute("aria-hidden", "true");
      probe.style.cssText =
        "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
        "padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);" +
        "padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px);";
      (document.body || root).appendChild(probe);
    }
    var cs = getComputedStyle(probe);
    return {
      top: parseFloat(cs.paddingTop) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
      right: parseFloat(cs.paddingRight) || 0,
      simulated: false,
    };
  }

  // -- Preference ------------------------------------------------------------
  function storedPref() {
    try {
      var v = localStorage.getItem(PREF_KEY);
      return (v === "app" || v === "web") ? v : "auto";
    } catch (_) { return "auto"; }
  }

  var state = {
    w: 0, h: 0, vh: 0,
    safe: { top: 0, bottom: 0, left: 0, right: 0, simulated: false },
    compact: false, short: false, notch: false, wide: false,
    mode: "app", pref: storedPref(),
  };

  function measure() {
    var vv = window.visualViewport;
    var w = Math.round((vv && vv.width) || window.innerWidth || root.clientWidth || 0);
    // The visual viewport is what the person can see. innerHeight is what the
    // page thinks it has. They differ by the browser toolbars, which is the
    // whole 100vh problem, so the smaller of the two is the honest number.
    var innerH = window.innerHeight || root.clientHeight || 0;
    var visH = Math.round((vv && vv.height) || innerH);
    var safe = readSafe();

    // Usable height is what is left once the notch and the home indicator have
    // taken their cut. That, not the raw height, decides whether the app
    // chrome fits.
    var usable = visH - safe.top - safe.bottom;

    state.w = w;
    state.h = innerH;
    state.vh = visH;
    state.safe = safe;
    state.notch = safe.top > 20;
    state.short = usable > 0 && usable <= SHORT_H;
    state.wide = w >= WIDE_W;
    // Cramped means the native chrome costs more than the screen can spare:
    // a narrow screen, a short one, or a narrow one that also gives up 78px
    // to a notch and a home indicator.
    state.compact = !state.wide && (w <= COMPACT_W || state.short || (state.notch && w < 390));
    return state;
  }

  function resolveMode() {
    if (state.pref === "app" || state.pref === "web") return state.pref;
    // Automatic. The web layout is for the two ends: screens too cramped to
    // spend 120px on a tab bar, and screens big enough that a phone tab bar
    // looks lost on them.
    return (state.compact || state.wide) ? "web" : "app";
  }

  function px(n) { return Math.round(n) + "px"; }

  function paint(reason) {
    measure();
    var mode = resolveMode();
    var changed = mode !== state.mode;
    state.mode = mode;

    var s = root.style;
    s.setProperty("--app-vh", px(state.vh));
    s.setProperty("--app-vw", px(state.w));
    s.setProperty("--sa-top", px(state.safe.top));
    s.setProperty("--sa-bottom", px(state.safe.bottom));
    s.setProperty("--sa-left", px(state.safe.left));
    s.setProperty("--sa-right", px(state.safe.right));

    root.setAttribute("data-shell", mode);
    root.setAttribute("data-vp", state.wide ? "wide" : state.compact ? "compact" : "regular");
    if (state.notch) root.setAttribute("data-notch", "1");
    else root.removeAttribute("data-notch");

    if (changed || reason === "init" || reason === "pref") {
      try {
        window.dispatchEvent(new CustomEvent("pawa:viewchange", {
          detail: { mode: mode, pref: state.pref, reason: reason || "resize" },
        }));
      } catch (_) {}
    }
  }

  // Stamp before first paint. The probe needs a parent, and in <head> there is
  // no body yet, so the insets land on the second pass; everything else, which
  // is what decides the layout, is correct from the very first frame.
  paint("init");

  // -- Keeping it current ----------------------------------------------------
  // Two frames, not one: an orientation change reports the old size on the
  // first, and the on-screen keyboard resizes the visual viewport without
  // firing a window resize at all.
  var pending = 0;
  function schedule(reason) {
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(function () {
      pending = requestAnimationFrame(function () { pending = 0; paint(reason); });
    });
  }

  window.addEventListener("resize", function () { schedule("resize"); });
  window.addEventListener("orientationchange", function () { schedule("orientation"); });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", function () { schedule("resize"); });
  }
  document.addEventListener("DOMContentLoaded", function () { paint("ready"); });
  window.addEventListener("pageshow", function () { schedule("pageshow"); });

  // -- API -------------------------------------------------------------------
  window.PawaView = {
    mode: function () { return state.mode; },
    pref: function () { return state.pref; },
    isCompact: function () { return state.compact; },
    metrics: function () {
      return {
        w: state.w, h: state.h, vh: state.vh,
        safe: {
          top: state.safe.top, bottom: state.safe.bottom,
          left: state.safe.left, right: state.safe.right,
        },
        compact: state.compact, short: state.short,
        notch: state.notch, wide: state.wide,
        mode: state.mode, pref: state.pref,
      };
    },
    set: function (pref) {
      if (pref !== "app" && pref !== "web" && pref !== "auto") return;
      state.pref = pref;
      try {
        if (pref === "auto") localStorage.removeItem(PREF_KEY);
        else localStorage.setItem(PREF_KEY, pref);
      } catch (_) {}
      paint("pref");
    },
    toggle: function () { window.PawaView.set(state.mode === "app" ? "web" : "app"); },
    refresh: function () { paint("refresh"); },
  };
})();
