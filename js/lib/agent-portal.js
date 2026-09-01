// ============================================================================
//  agent-portal.js — the section rail shared by agent-houses.html and
//  agent-services.html.
//
//  Both pages ask one long question in several parts. The rail is the map of
//  those parts: it says where you are, what is left, and which sections you
//  have actually answered. Without it a nine-section form on a phone is a
//  scroll with no landmarks, which is how the two pages ended up feeling like
//  a wall of fields.
//
//  Three jobs, and nothing else:
//    1. Highlight the section currently on screen  (IntersectionObserver)
//    2. Tick a section once it holds an answer     (input/change, debounced)
//    3. Scroll to a section when its chip is tapped
//
//  It owns no data and validates nothing. "Done" here means "you put something
//  in it", which is a navigation aid, not a claim about the listing.
// ============================================================================

(function () {
  "use strict";

  /**
   * @param {object} opt
   * @param {string} opt.rail   selector for the <nav> holding the chips
   * @param {string} opt.form   selector for the form the panels live in
   */
  function mount(opt) {
    const rail = document.querySelector(opt.rail);
    const form = document.querySelector(opt.form);
    if (!rail || !form) return null;

    const links = [...rail.querySelectorAll("a[href^='#']")];
    if (!links.length) return null;

    const panels = links
      .map((a) => ({ a, el: document.getElementById(a.getAttribute("href").slice(1)) }))
      .filter((p) => p.el);

    // ---- 1. where am I ----------------------------------------------------
    // Sections are tall, so "visible" is a poor test: two are on screen at
    // once for most of the scroll. The band is the top third of the viewport,
    // and the topmost section touching it wins — which is the one whose
    // heading you just scrolled past.
    const strip = rail.querySelector(".ap-rail__list");
    let active = null;
    function setActive(el) {
      if (el === active) return;
      active = el;
      let onChip = null;
      panels.forEach((p) => {
        const on = p.el === el;
        p.a.classList.toggle("is-on", on);
        if (on) onChip = p.a;
      });
      // On a phone the rail is a horizontal strip wider than the screen, so
      // the chip that just became current is often off the right-hand edge.
      // Nudge the strip, never the page: scrollIntoView() would drag the whole
      // document sideways and fight the scroll that triggered this.
      if (onChip && strip && strip.scrollWidth > strip.clientWidth) {
        const c = onChip.getBoundingClientRect(), s = strip.getBoundingClientRect();
        if (c.left < s.left + 8) strip.scrollBy({ left: c.left - s.left - 12, behavior: "smooth" });
        else if (c.right > s.right - 8) strip.scrollBy({ left: c.right - s.right + 12, behavior: "smooth" });
      }
    }

    const io = new IntersectionObserver(
      () => {
        const line = window.innerHeight * 0.33;
        let best = null;
        for (const p of panels) {
          const top = p.el.getBoundingClientRect().top;
          if (top <= line) best = p.el;
        }
        setActive(best || panels[0].el);
      },
      { rootMargin: "-32% 0px -60% 0px", threshold: [0, 1] }
    );
    panels.forEach((p) => io.observe(p.el));

    // The observer only fires on a crossing, so the first paint and the end of
    // the page (where nothing crosses) need the same read run directly.
    let raf = null;
    function onScroll() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const line = window.innerHeight * 0.33;
        let best = null;
        for (const p of panels) if (p.el.getBoundingClientRect().top <= line) best = p.el;
        setActive(best || panels[0].el);
      });
    }
    window.addEventListener("scroll", onScroll, { passive: true });

    // ---- 2. what have I answered -----------------------------------------
    // A section counts as answered when any control inside it holds a value
    // the agent put there. Checkboxes and selects that ship with a default
    // are excluded: a default is the form's answer, not theirs.
    function isAnswered(el) {
      const ctrls = el.querySelectorAll("input, select, textarea");
      for (const c of ctrls) {
        if (c.type === "hidden" || c.type === "file" || c.disabled) continue;
        if (c.type === "checkbox" || c.type === "radio") continue;
        if (c.tagName === "SELECT") continue;
        if (String(c.value || "").trim()) return true;
      }
      // A tile, a chosen chip or a dropped pin is an answer with no input
      // behind it, so ask the DOM for those too.
      if (el.querySelector(".ap-tile, .ap-chip.is-on, .ah-room, .ah-group")) return true;
      const coords = el.querySelector("[data-has-pin='1']");
      return !!coords;
    }

    let syncTimer = null;
    function syncDone() {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        panels.forEach((p) => p.a.classList.toggle("is-done", isAnswered(p.el)));
      }, 180);
    }
    form.addEventListener("input", syncDone);
    form.addEventListener("change", syncDone);

    // ---- 3. jump ----------------------------------------------------------
    // The rail is sticky, so the browser's own anchor jump lands the heading
    // under it. scroll-margin-top on .ap-panel handles that in CSS; this only
    // adds the smooth motion and respects a reduced-motion preference.
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    rail.addEventListener("click", (e) => {
      const a = e.target.closest("a[href^='#']");
      if (!a) return;
      const el = document.getElementById(a.getAttribute("href").slice(1));
      if (!el) return;
      e.preventDefault();
      el.scrollIntoView({ behavior: calm.matches ? "auto" : "smooth", block: "start" });
      setActive(el);
    });

    setActive(panels[0].el);
    syncDone();

    return {
      /** Re-read every section. Call after loading a listing into the form. */
      refresh() { setActive(panels[0].el); syncDone(); },
      destroy() {
        io.disconnect();
        window.removeEventListener("scroll", onScroll);
      },
    };
  }

  window.AgentPortalRail = { mount };
})();
