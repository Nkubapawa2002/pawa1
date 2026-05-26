// ════════════════════════════════════════════════════════════════════════
// PAWA — PREMIUM INTERACTIONS
// Companion to css/premium.css. Adds the subtle, GPU-cheap touches that
// make the design feel alive without slowing the page down:
//
//   • Reveal-on-scroll for cards (.reveal → .revealed via IntersectionObserver)
//   • 3D tilt on .card / .bf-card / .bus-card hover (desktop pointer only)
//   • Material-style ripple on every <button> / .btn click
//   • Status-bar theme-color sync (Android Chrome / iOS Safari notch)
//
// All effects respect prefers-reduced-motion and skip on touch devices
// where appropriate, so cheap Androids don't stutter.
// ════════════════════════════════════════════════════════════════════════

(function () {
  if (window.__pawaPremiumMounted) return;
  window.__pawaPremiumMounted = true;

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const isTouch      = window.matchMedia?.("(hover: none)").matches
                       || ("ontouchstart" in window);

  // ──────────────────────────────────────────────────────────────────────
  // 1. Reveal cards on scroll
  // ──────────────────────────────────────────────────────────────────────
  function setupReveal() {
    if (reduceMotion || !("IntersectionObserver" in window)) {
      // Just show everything immediately.
      document.querySelectorAll(".card, .bf-card, .bus-card, .agent-card, .stat-card, .feat-card")
        .forEach(el => el.classList.add("revealed"));
      return;
    }
    const ob = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("revealed");
          ob.unobserve(e.target);
        }
      }
    }, { rootMargin: "0px 0px -40px 0px", threshold: 0.05 });

    // Tag the natural card-like elements with .reveal so CSS knows to animate.
    const sel = ".card, .bf-card, .bus-card, .agent-card, .stat-card, .feat-card, .feature-card, .ticket-card";
    document.querySelectorAll(sel).forEach(el => {
      if (!el.classList.contains("reveal")) el.classList.add("reveal");
      ob.observe(el);
    });

    // Re-scan whenever the DOM is re-rendered (e.g. bus grid filter).
    const root = document.body;
    const mo = new MutationObserver(() => {
      document.querySelectorAll(sel).forEach(el => {
        if (!el.classList.contains("reveal")) {
          el.classList.add("reveal");
          ob.observe(el);
        }
      });
    });
    mo.observe(root, { childList: true, subtree: true });
  }

  // ──────────────────────────────────────────────────────────────────────
  // 2. 3D tilt on hover (desktop only)
  // ──────────────────────────────────────────────────────────────────────
  function setupTilt() {
    if (reduceMotion || isTouch) return;
    const sel = ".card, .bf-card, .bus-card, .agent-card, .stat-card, .feat-card, .ticket-card";
    function attach(el) {
      if (el.dataset.tiltBound) return;
      el.dataset.tiltBound = "1";
      el.classList.add("tilt");
      el.addEventListener("pointermove", (e) => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width  - 0.5;  // -0.5 … 0.5
        const py = (e.clientY - r.top)  / r.height - 0.5;
        const max = 6;   // degrees
        el.style.transform =
          `perspective(900px) rotateX(${(-py * max).toFixed(2)}deg) rotateY(${(px * max).toFixed(2)}deg) translateY(-3px)`;
      });
      el.addEventListener("pointerleave", () => { el.style.transform = ""; });
    }
    document.querySelectorAll(sel).forEach(attach);
    new MutationObserver(() => document.querySelectorAll(sel).forEach(attach))
      .observe(document.body, { childList: true, subtree: true });
  }

  // ──────────────────────────────────────────────────────────────────────
  // 3. Material ripple on click
  // ──────────────────────────────────────────────────────────────────────
  function setupRipples() {
    if (reduceMotion) return;
    document.addEventListener("click", (e) => {
      // Most actionable elements: <button>, <a class=btn>, role=button
      const target = e.target.closest("button, .btn, [role='button']");
      if (!target || target.disabled) return;
      // Don't add ripple to the canvas-editor inputs / palette items / FABs
      // which already have their own pressed-state animation.
      if (target.closest(".sePaletteItem, .seItem, .seCell, .pawa-fab, .pcw-fab")) return;
      const rect = target.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const rip = document.createElement("span");
      rip.className = "ripple";
      rip.style.width = rip.style.height = size + "px";
      rip.style.left = (e.clientX - rect.left - size / 2) + "px";
      rip.style.top  = (e.clientY - rect.top  - size / 2) + "px";
      // Ensure position context.
      const cs = getComputedStyle(target);
      if (cs.position === "static") target.style.position = "relative";
      if (cs.overflow === "visible") target.style.overflow = "hidden";
      target.appendChild(rip);
      setTimeout(() => rip.remove(), 600);
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // 4. Sync the address-bar / status-bar colour with the gradient hero
  //    so the page feels seamless edge-to-edge on phones.
  // ──────────────────────────────────────────────────────────────────────
  function syncStatusBar() {
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    // Match the hero gradient start colour.
    meta.content = "#064e3b";
  }

  // ──────────────────────────────────────────────────────────────────────
  // Boot
  // ──────────────────────────────────────────────────────────────────────
  function boot() {
    setupReveal();
    setupTilt();
    setupRipples();
    syncStatusBar();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
