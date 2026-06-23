// ============================================================================
//  Houses — mobile filter controller (progressive disclosure).
//  On phones the 10-control filter toolbar is collapsed behind a single
//  "Filters" pill (with a live active-filter count) plus a "Near me" pill that
//  proxies the existing GPS button. This declutters the page so listings are
//  reachable fast, WITHOUT moving any input the page's main JS reads — every
//  control still lives in the same DOM node, just hidden until expanded.
//
//  Self-contained: no dependency on js/houses.js internals. CSS in
//  css/houses-mobile-pro.css only reacts at ≤760px, so this is inert on desktop.
// ============================================================================
(function () {
  "use strict";

  if (!document.body || document.body.dataset.page !== "houses") return;

  var toolbar = document.querySelector(".houses-toolbar");
  if (!toolbar || document.querySelector(".hp-filterbar")) return;

  var SLIDERS =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/>' +
    '<circle cx="9" cy="6" r="2" fill="currentColor" stroke="none"/>' +
    '<circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/>' +
    '<circle cx="8" cy="18" r="2" fill="currentColor" stroke="none"/></svg>';
  var CHEV =
    '<svg class="hp-fb-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M6 9l6 6 6-6"/></svg>';
  var GPS =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/>' +
    '<path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';

  // ---- Build the compact trigger row -------------------------------------
  var bar = document.createElement("div");
  bar.className = "hp-filterbar";

  var toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "hp-fb-toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "housesToolbarRegion");
  toggle.innerHTML = SLIDERS +
    '<span>Filters</span><span class="hp-fb-count" hidden>0</span>' + CHEV;

  var near = document.createElement("button");
  near.type = "button";
  near.className = "hp-fb-near";
  near.setAttribute("aria-label", "Find homes near me");
  near.innerHTML = GPS + "<span>Near me</span>";

  bar.appendChild(toggle);
  bar.appendChild(near);
  toolbar.id = toolbar.id || "housesToolbarRegion";
  toolbar.parentNode.insertBefore(bar, toolbar);

  // ---- Expand / collapse --------------------------------------------------
  function setOpen(open) {
    document.body.classList.toggle("hp-filters-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }
  toggle.addEventListener("click", function () {
    setOpen(!document.body.classList.contains("hp-filters-open"));
  });

  // "Near me" just drives the real (hidden) GPS button so all the existing
  // geolocation logic in js/houses.js runs unchanged.
  near.addEventListener("click", function () {
    var real = document.getElementById("houseNearMeBtn");
    if (real) real.click();
  });

  // ---- Live active-filter count ------------------------------------------
  var IDS = ["filterListing", "filterType", "filterArea", "filterBeds",
             "filterRoom", "filterPrice", "filterSearch"];

  function refreshCount() {
    var n = 0;
    for (var i = 0; i < IDS.length; i++) {
      var el = document.getElementById(IDS[i]);
      if (el && String(el.value || "").trim()) n++;
    }
    var count = toggle.querySelector(".hp-fb-count");
    if (n > 0) {
      count.textContent = String(n);
      count.hidden = false;
      toggle.classList.add("has-active");
    } else {
      count.hidden = true;
      toggle.classList.remove("has-active");
    }
  }

  IDS.forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", refreshCount);
    el.addEventListener("input", refreshCount);
  });
  refreshCount();
  // Filters can be cleared/applied by other code paths; keep the badge honest.
  window.addEventListener("pageshow", refreshCount);
})();
