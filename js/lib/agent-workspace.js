// ============================================================================
//  agent-workspace.js — the board and the steps behind "List your house".
//
//  WHAT IT REPLACES
//  ----------------
//  AgentPortalRail turned the eight sections of the listing form into a sticky
//  index beside them. The index was right; the layout under it was not. All
//  eight sections stayed on the page at once, which on a 390px phone measured
//  6.5 screens empty and 13 screens with four room types and five bills in it.
//  An index into thirteen screens is still thirteen screens.
//
//  WHAT IT DOES INSTEAD
//  --------------------
//  Two views over the same markup, and no markup of its own beyond furniture:
//
//    THE BOARD    all eight parts as tiles, each with a live one-line summary
//                 of what is actually in it, and a tick when it holds an
//                 answer. The whole listing on one screen. This is where the
//                 agent starts, returns, and saves from.
//    A STEP       one part, with the other seven taken out of the layout, a
//                 progress bar above it and Back / Next under it.
//
//  Nothing is hidden from the agent: every part is one tap from the board and
//  the save button is on both views. What is hidden is the other seven parts'
//  LAYOUT, which is the whole cost.
//
//  WHAT IT DOES NOT DO
//  -------------------
//  It does not validate, submit, or know one field from another. The page owns
//  all of that. This owns which panel is on screen and what the tiles say.
//
//  USAGE
//    const ws = AgentWorkspace.mount({
//      form: "#ahForm",
//      panels: ".ap-panel",
//      summarize(panel) { return "4 photos" | "" },   // optional
//      onStep(panel, i) { map.resize(); },            // optional
//    });
//    ws.refresh();     // re-read every tile (after loading a listing in)
//    ws.toBoard();     // show the board
// ============================================================================
(function () {
  "use strict";

  const t = (k) => (window.t ? window.t(k) : k);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Lucide-style strokes. Never a character and never an emoji: these have to
  // inherit the theme's colour and scale with the type beside them.
  const ICON = {
    tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>',
  };

  /**
   * Is this control hidden by its own panel?
   *
   * `closest("[hidden]")` on its own is the wrong question: the whole form
   * section is hidden until the agent opens it, so at mount time every control
   * on the page answers yes and every tile reports an empty section. Only a
   * hidden ancestor INSIDE the panel says anything about the control, and that
   * is the one case this needs to catch: the rent-only rows the page hides
   * when a listing is switched to a sale.
   */
  function hiddenInPanel(ctrl, panel) {
    const h = ctrl.closest("[hidden]");
    return !!h && panel.contains(h);
  }

  /**
   * Is this control's value the agent's, or the form's?
   *
   * `defaultValue` is the `value` attribute as written in the markup, so
   * "minimum months to pay upfront", which ships as 1, and the bedroom and
   * bathroom counts, which ship as 0, do not tick a section the agent has
   * never opened. A tile that ticks itself is worse than no tile: it reports
   * work nobody did.
   */
  function isOwnAnswer(c) {
    const v = String(c.value == null ? "" : c.value).trim();
    if (!v) return false;
    return v !== String(c.defaultValue == null ? "" : c.defaultValue).trim();
  }

  /** Every control in the panel that the agent could answer. */
  function answerable(panel) {
    return Array.from(panel.querySelectorAll("input, select, textarea")).filter(
      (c) =>
        c.type !== "hidden" &&
        c.type !== "file" &&
        !c.disabled &&
        !hiddenInPanel(c, panel)
    );
  }

  /**
   * Does this panel hold an answer the agent put there?
   *
   * A default is the form's answer, not theirs. Selects are excluded outright:
   * every select on this form ships with a valid first option, so one can
   * never distinguish a choice from the absence of one. A chosen chip, a media
   * tile, a room row or a dropped pin is an answer with no input behind it, so
   * the DOM is asked for those separately.
   */
  function isAnswered(panel) {
    for (const c of answerable(panel)) {
      if (c.type === "checkbox" || c.type === "radio") { if (c.checked) return true; continue; }
      if (c.tagName === "SELECT") continue;
      if (isOwnAnswer(c)) return true;
    }
    return !!panel.querySelector(
      ".ap-tile, .ah-media-tile, .ap-chip.is-on, .ah-chip.active, .ah-room, .ah-group, .ah-cost"
    );
  }

  /**
   * The fallback line under a tile's name.
   *
   * The page passes a `summarize` that says something specific for the parts
   * where a count is a poor description of the answer (a pin is set or it is
   * not; a price is a figure, not a field). Everywhere else this counts what
   * the agent has actually filled in, which is honest and needs no knowledge
   * of the page at all.
   */
  function genericSummary(panel) {
    let filled = 0;
    let total = 0;
    for (const c of answerable(panel)) {
      if (c.type === "checkbox" || c.type === "radio") continue;
      if (c.tagName === "SELECT") continue;
      total++;
      if (isOwnAnswer(c)) filled++;
    }
    const chips = panel.querySelectorAll(".ap-chip.is-on, .ah-chip.active").length;
    if (chips) return t("aw_sum_chosen").replace("{n}", chips);
    if (!total) return "";
    if (!filled) return t("aw_sum_empty");
    return t("aw_sum_filled").replace("{n}", filled).replace("{of}", total);
  }

  function mount(opts) {
    const form = document.querySelector(opts.form || "#ahForm");
    if (!form) return null;

    const panels = Array.from(form.querySelectorAll(opts.panels || ".ap-panel"));
    if (!panels.length) return null;

    // The name each tile and step bar shows. It is already on the page, in
    // both languages, as the panel's own heading. Reading it from there means
    // there is exactly one copy of every section name in the repo.
    const nameOf = (p) => {
      const h = p.querySelector(".ap-panel__tx h3");
      return h ? h.textContent.trim() : p.id;
    };

    document.body.classList.add("aw-on");

    // ---- furniture -------------------------------------------------------
    // Built here rather than written into the page, because it is chrome, not
    // content, and because a second copy of it in agent-services.html is
    // exactly how the portal ended up with two of everything the first time.
    const board = document.createElement("section");
    board.className = "aw-board";
    board.id = "awBoard";

    const stepbar = document.createElement("div");
    stepbar.className = "aw-stepbar";
    stepbar.hidden = true;

    const nav = document.createElement("div");
    nav.className = "aw-nav";
    nav.hidden = true;

    // The board sits where the first panel was, the bar above it, the nav at
    // the end. Anchoring on the first panel rather than on the form's first
    // child keeps whatever the page puts above it (a title, a notice) where
    // the page put it.
    form.insertBefore(stepbar, panels[0]);
    form.insertBefore(board, panels[0]);
    form.appendChild(nav);

    stepbar.innerHTML = `
      <button type="button" class="aw-back" data-aw="board">
        ${ICON.left}${ICON.grid}<span>${esc(t("aw_all_parts"))}</span>
      </button>
      <span class="aw-meter">
        <span class="aw-meter__bars" aria-hidden="true"></span>
        <span class="aw-meter__n"></span>
      </span>`;

    nav.innerHTML = `
      <button type="button" class="ah-btn" data-aw="prev">
        ${ICON.left}<span>${esc(t("aw_prev"))}</span>
      </button>
      <button type="button" class="ah-btn ah-btn-brand" data-aw="next">
        <span>${esc(t("aw_next"))}</span>${ICON.right}
      </button>`;

    board.innerHTML = `
      <div class="aw-board__head">
        <span class="aw-board__tx">
          <span class="aw-board__k" data-aw="kicker"></span>
          <span class="aw-board__h" data-aw="worktitle"></span>
        </span>
        <span class="aw-meter">
          <span class="aw-meter__bars" aria-hidden="true"></span>
          <span class="aw-meter__n"></span>
        </span>
      </div>
      <div class="aw-tiles" data-aw="tiles"></div>
      <div class="aw-board__acts" data-aw="acts"></div>`;

    const tilesEl = board.querySelector('[data-aw="tiles"]');
    const workTitle = board.querySelector('[data-aw="worktitle"]');
    const kicker = board.querySelector('[data-aw="kicker"]');

    // The listing's own action bar MOVES onto the board rather than being
    // rebuilt there. Save and Cancel keep their ids, their listeners and their
    // note about nothing being published until you save, so nothing downstream
    // has to know the board exists. A rebuilt copy would have meant two
    // elements answering to #ahSaveBtn, which is how a form ends up with a
    // button that looks right and submits nothing.
    const acts = board.querySelector('[data-aw="acts"]');
    const pageActions = form.querySelector(opts.actions || ".ap-actions");
    if (pageActions) acts.appendChild(pageActions);

    // Anything the page says about the listing as a whole belongs on the board
    // and nowhere else. Repeating it above all eight parts is 180px of every
    // step spent on a notice the agent read once, and the place it actually
    // matters is beside the button that publishes.
    if (opts.boardOnly) {
      // The anchor walks forward with each move. Inserting every element after
      // the head instead would hand back the list in reverse.
      let after = board.querySelector(".aw-board__head");
      for (const el of Array.from(form.querySelectorAll(opts.boardOnly))) {
        after.parentNode.insertBefore(el, after.nextSibling);
        after = el;
      }
    }

    tilesEl.innerHTML = panels
      .map(
        (p, i) => `
      <button type="button" class="aw-tile" data-aw-go="${i}">
        <span class="aw-tile__top">
          <span class="aw-tile__n">${i + 1}</span>
          <span class="aw-tile__name">${esc(nameOf(p))}</span>
          <span class="aw-tile__tick">${ICON.tick}</span>
        </span>
        <span class="aw-tile__sum"></span>
      </button>`
      )
      .join("");

    const tiles = Array.from(tilesEl.querySelectorAll(".aw-tile"));
    const meters = Array.from(form.querySelectorAll(".aw-meter"));
    meters.forEach((m) => {
      m.querySelector(".aw-meter__bars").innerHTML = panels
        .map(() => '<span class="aw-meter__b"></span>').join("");
    });

    // ---- state -----------------------------------------------------------
    let current = -1;   // -1 is the board
    let settled = false; // the first toBoard() is the mount, not a navigation

    function paintMeters(done) {
      for (const m of meters) {
        const bars = m.querySelectorAll(".aw-meter__b");
        panels.forEach((_, i) => bars[i] && bars[i].classList.toggle("is-done", done[i]));
        m.querySelector(".aw-meter__n").textContent =
          t("aw_done_of").replace("{n}", done.filter(Boolean).length).replace("{of}", panels.length);
      }
    }

    function refresh() {
      const done = panels.map(isAnswered);
      panels.forEach((p, i) => {
        const custom = opts.summarize ? opts.summarize(p, done[i]) : null;
        const line = custom != null && custom !== "" ? custom : genericSummary(p);
        tiles[i].classList.toggle("is-done", done[i]);
        tiles[i].querySelector(".aw-tile__sum").textContent = line;
        // Re-read rather than cached at mount: this can be mounted before
        // applyTranslations() has run, and a board of English tiles over a
        // Swahili form is the exact half-translated screen the copy rules
        // exist to prevent.
        tiles[i].querySelector(".aw-tile__name").textContent = nameOf(p);
      });
      paintMeters(done);

      const titleField = document.getElementById(opts.titleField || "ahTitle");
      const typed = titleField ? String(titleField.value || "").trim() : "";
      workTitle.textContent = typed || t("aw_untitled");
      // "Add a new listing" or "Editing this listing", whichever the page put
      // in its own heading. Read rather than reproduced, so the board can
      // never disagree with the form about which one it is.
      const pageTitle = form.querySelector(opts.title || ".ap-title");
      if (pageTitle) kicker.textContent = pageTitle.textContent.trim();
    }

    /** The chrome's own labels, for the same reason the tile names are re-read. */
    function relabel() {
      stepbar.querySelector(".aw-back span").textContent = t("aw_all_parts");
      const isLast = current === panels.length - 1;
      nav.querySelector('[data-aw="next"] span').textContent = isLast ? t("aw_done") : t("aw_next");
      nav.querySelector('[data-aw="prev"] span').textContent =
        current <= 0 ? t("aw_all_parts") : t("aw_prev");
    }

    function toBoard() {
      current = -1;
      panels.forEach((p) => p.setAttribute("data-aw-step", "off"));
      board.hidden = false;
      stepbar.hidden = true;
      nav.hidden = true;
      relabel();
      refresh();
      // The board is short. Landing halfway down it, which is where the last
      // step left the scroll, reads as a page that failed to change. The
      // exception is the mount itself: this runs while the page is still
      // assembling, and yanking the document to the top then would undo a
      // deep link or a restored scroll position for a form nobody has opened.
      if (settled) window.scrollTo({ top: 0, behavior: "auto" });
      settled = true;
    }

    function go(i) {
      const n = panels.length;
      if (i < 0 || i >= n) return toBoard();
      current = i;
      panels.forEach((p, j) => p.setAttribute("data-aw-step", j === i ? "on" : "off"));
      board.hidden = true;
      stepbar.hidden = false;
      nav.hidden = false;

      relabel();
      refresh();
      window.scrollTo({ top: 0, behavior: "auto" });
      // MapLibre sizes itself to a container it can measure. The pin map lives
      // in a panel that was display:none a moment ago, so it has to be told.
      if (opts.onStep) { try { opts.onStep(panels[i], i); } catch (e) {} }
    }

    // ---- wiring ----------------------------------------------------------
    tilesEl.addEventListener("click", (e) => {
      const tile = e.target.closest("[data-aw-go]");
      if (tile) go(Number(tile.dataset.awGo));
    });

    form.addEventListener("click", (e) => {
      const b = e.target.closest("[data-aw]");
      if (!b || !form.contains(b)) return;
      const act = b.dataset.aw;
      if (act === "board") toBoard();
      else if (act === "next") go(current + 1);
      else if (act === "prev") current === 0 ? toBoard() : go(current - 1);
    });

    // Tiles are only as useful as they are current. Recomputing on every
    // keystroke would be wasteful and pointless: nobody is looking at the
    // board while typing into a step. Recomputing when a field is left is
    // both cheap and exactly when the answer changed.
    form.addEventListener("change", refresh);
    form.addEventListener("input", (e) => {
      if (e.target && e.target.id === "ahTitle") {
        workTitle.textContent = String(e.target.value || "").trim() || t("aw_untitled");
      }
    });

    toBoard();

    return {
      refresh,
      toBoard,
      go,
      panels,
      get index() { return current; },
    };
  }

  window.AgentWorkspace = { mount };
})();
