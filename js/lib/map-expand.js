// Shared "maximize / minimize" affordance for inline maps — same feel as the
// Meet & Locate side-panel toggle, but it grows the map in place (taller within
// the page) and shrinks it back. Works with both MapLibre (.resize()) and
// Leaflet (.invalidateSize()) instances.
//
// Usage:
//   pawaMapExpand("hdMap", () => map);                 // sizer === map element
//   pawaMapExpand(".ah-pin-picker", () => pinMap);     // sizer wraps the map
//
// - First arg is the element (or id/selector) whose height should grow; for a
//   map that fills an absolutely-positioned wrapper, pass that wrapper.
// - Second arg is a getter returning the current map instance (maps are often
//   recreated, so we fetch it fresh on each toggle).
// - It injects one floating button (chevron + Maximize/Minimize) and toggles the
//   `.pawa-map-expanded` class, then calls the right resize method after the CSS
//   transition so tiles re-render at the new size.
(function () {
  "use strict";

  const CHEV_UP   = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
  const CHEV_DOWN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  function resizeMap(map) {
    if (!map) return;
    try {
      if (typeof map.resize === "function") map.resize();            // MapLibre / Mapbox
      else if (typeof map.invalidateSize === "function") map.invalidateSize(); // Leaflet
    } catch (_) { /* map may be gone — ignore */ }
  }

  function pawaMapExpand(sizer, getMap, opts = {}) {
    const el = typeof sizer === "string"
      ? (document.getElementById(sizer) || document.querySelector(sizer))
      : sizer;
    if (!el || el.dataset.pawaExpand) return null;   // missing or already wired
    el.dataset.pawaExpand = "1";

    // The button is absolutely positioned, so the host must be a positioning
    // context. Don't clobber an existing non-static position.
    if (getComputedStyle(el).position === "static") el.style.position = "relative";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pawa-map-expand-btn";
    btn.setAttribute("aria-pressed", "false");

    const sync = () => {
      const on = el.classList.contains("pawa-map-expanded");
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.setAttribute("aria-label", on ? "Minimize map" : "Maximize map");
      btn.innerHTML = (on ? CHEV_DOWN : CHEV_UP) +
        `<span>${on ? "Minimize" : "Maximize"}</span>`;
    };

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.toggle("pawa-map-expanded");
      sync();
      // Re-measure after the height transition (matches the CSS ~320ms).
      const map = typeof getMap === "function" ? getMap() : getMap;
      setTimeout(() => resizeMap(map), 340);
      // A couple of nudges in case the transition timing varies by device.
      setTimeout(() => resizeMap(map), 520);
    });

    sync();
    (opts.mountIn || el).appendChild(btn);
    return {
      collapse() { el.classList.remove("pawa-map-expanded"); sync(); },
      isExpanded() { return el.classList.contains("pawa-map-expanded"); },
    };
  }

  window.pawaMapExpand = pawaMapExpand;
})();
