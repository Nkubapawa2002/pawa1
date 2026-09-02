// ============================================================================
//  native-feel.js — the small physical things a native app does and a web page
//  usually does not.
//
//  This app ships twice from one codebase: as a PWA and, through Capacitor, as
//  an Android app. Only @capacitor/core and @capacitor/android are installed,
//  so there is no Haptics plugin and no Share plugin to call. Everything here
//  is therefore built on web APIs that the Android WebView implements anyway,
//  which has the useful side effect that the browser build gets the same
//  behaviour instead of a lesser one.
//
//  Four things, and each exists because its absence is felt rather than seen:
//
//    haptic()     a tap that answers. On a phone, a control that changes
//                 something and does not buzz reads as not having worked.
//    pressable()  a press that tracks the finger. The native gesture is: press
//                 down, it shrinks; slide off before letting go, it springs
//                 back and does NOT fire. A :active rule cannot express the
//                 second half, which is the half that makes it feel physical.
//    reveal()     content that arrives rather than being already there.
//    swipeable()  a horizontal drag with a velocity threshold, so a flick and
//                 a slow drag mean the same thing.
//
//  REDUCED MOTION IS NOT A DIMMER SWITCH HERE. Under it, reveal does nothing
//  at all (content is simply present), pressable drops to a colour change with
//  no transform, and haptics stay ON: a vibration is not motion on a screen and
//  somebody who cannot use animation still needs to know their tap landed.
//  Swipe stays on too, because it is an input, not an effect.
// ============================================================================

(function () {
  "use strict";

  const reduced = (() => {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)"); }
    catch (_) { return { matches: false, addEventListener() {} }; }
  })();
  const isReduced = () => !!reduced.matches;

  // ---- haptics -------------------------------------------------------------
  // navigator.vibrate is absent on iOS Safari and refused on a page that has
  // never been touched, so every call is wrapped: a failed buzz must never be
  // the reason a tap handler stops running.
  const PATTERNS = {
    tick:    8,     // moving through a set: one lens to the next
    select:  14,    // a choice landed
    success: [12, 40, 18],
    warn:    [22, 60, 22],
  };
  let hapticsOff = false;
  function haptic(kind) {
    if (hapticsOff) return false;
    try {
      if (!navigator.vibrate) return false;
      return navigator.vibrate(PATTERNS[kind] || PATTERNS.tick);
    } catch (_) { return false; }
  }
  // A page can turn them off wholesale (a settings toggle would call this).
  haptic.disable = (v) => { hapticsOff = v !== false; };

  // ---- pressable -----------------------------------------------------------
  // Pointer events rather than touch events, so a mouse, a finger and a stylus
  // all take the same path. setPointerCapture is what lets us keep receiving
  // moves after the finger leaves the element, which is how "slide off to
  // cancel" is detected at all.
  const PRESS_CANCEL_SLOP = 14;   // px of travel that still counts as a press

  function pressable(el, opts) {
    if (!el || el.__pressable) return;
    el.__pressable = true;
    const o = opts || {};
    let id = null, sx = 0, sy = 0, cancelled = false;

    const down = (e) => {
      if (e.button != null && e.button !== 0) return;
      id = e.pointerId; sx = e.clientX; sy = e.clientY; cancelled = false;
      el.classList.add("is-pressed");
      try { el.setPointerCapture(id); } catch (_) {}
      if (o.hapticOnPress !== false) haptic("tick");
    };
    const move = (e) => {
      if (id === null || e.pointerId !== id || cancelled) return;
      // Travel beyond the slop means the finger is scrolling the page, not
      // pressing this. Releasing it must not count as a tap.
      if (Math.abs(e.clientX - sx) > PRESS_CANCEL_SLOP ||
          Math.abs(e.clientY - sy) > PRESS_CANCEL_SLOP) {
        cancelled = true;
        el.classList.remove("is-pressed");
      }
    };
    const up = () => {
      if (id === null) return;
      try { el.releasePointerCapture(id); } catch (_) {}
      el.classList.remove("is-pressed");
      id = null;
    };

    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("lostpointercapture", up);
  }

  function pressableAll(sel, root) {
    (root || document).querySelectorAll(sel).forEach((el) => pressable(el));
  }

  // ---- reveal --------------------------------------------------------------
  // Once only. A band that re-animates every time it scrolls back into view is
  // the difference between "arrived" and "twitchy".
  function reveal(sel, opts) {
    const o = opts || {};
    const els = typeof sel === "string"
      ? Array.from(document.querySelectorAll(sel)) : [].concat(sel || []);
    if (!els.length) return;
    if (isReduced() || !("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("is-shown"));
      return;
    }
    els.forEach((el) => el.classList.add("will-reveal"));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const i = els.indexOf(el);
        el.style.transitionDelay = ((o.stagger || 0) * Math.max(0, i)) + "ms";
        el.classList.add("is-shown");
        io.unobserve(el);
      });
    }, { rootMargin: o.rootMargin || "0px 0px -10% 0px", threshold: o.threshold || 0.12 });
    els.forEach((el) => io.observe(el));
  }

  // ---- swipeable -----------------------------------------------------------
  // A flick and a slow drag should mean the same thing, so the commit test is
  // distance OR velocity, never distance alone: on a small card the distance
  // needed to feel deliberate is most of the card's width, which makes a quick
  // flick fail and the control feel broken.
  const SWIPE_MIN_PX = 42;
  const SWIPE_MIN_VELOCITY = 0.32;   // px per ms
  const SWIPE_SLOPE = 1.15;          // how much more horizontal than vertical

  function swipeable(el, handlers) {
    if (!el || el.__swipeable) return;
    el.__swipeable = true;
    const h = handlers || {};
    let id = null, sx = 0, sy = 0, t0 = 0, decided = null;

    const down = (e) => {
      id = e.pointerId; sx = e.clientX; sy = e.clientY; t0 = e.timeStamp; decided = null;
    };
    const move = (e) => {
      if (id === null || e.pointerId !== id) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (decided === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
        // Claim the gesture only if it is clearly sideways, otherwise let the
        // page scroll. Getting this backwards makes a carousel that eats the
        // scroll, which is the single most hated thing a carousel can do.
        decided = Math.abs(dx) > Math.abs(dy) * SWIPE_SLOPE ? "x" : "y";
        if (decided === "x") { try { el.setPointerCapture(id); } catch (_) {} }
      }
      if (decided === "x") {
        if (e.cancelable) e.preventDefault();
        if (h.onDrag) h.onDrag(dx);
      }
    };
    const up = (e) => {
      if (id === null) return;
      const dx = (e.clientX || 0) - sx;
      const dt = Math.max(1, (e.timeStamp || 0) - t0);
      const v = Math.abs(dx) / dt;
      const commit = decided === "x" && (Math.abs(dx) > SWIPE_MIN_PX || v > SWIPE_MIN_VELOCITY);
      try { el.releasePointerCapture(id); } catch (_) {}
      id = null;
      if (h.onEnd) h.onEnd();
      if (!commit) return;
      if (dx < 0 && h.onNext) h.onNext();
      if (dx > 0 && h.onPrev) h.onPrev();
    };

    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move, { passive: false });
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", () => { id = null; if (h.onEnd) h.onEnd(); });
  }

  window.NativeFeel = { haptic, pressable, pressableAll, reveal, swipeable, isReduced };
})();
