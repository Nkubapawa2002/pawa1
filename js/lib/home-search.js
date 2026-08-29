// ============================================================================
//  Home search — one box that actually searches the app
// ============================================================================
//  The homepage box said "Search homes, services…" and then, whatever you
//  typed, sent you to houses.html?q=. Services, trucks and day jobs were named
//  in the placeholder and unreachable through it, and you never saw a result
//  until after the page had already changed underneath you.
//
//  It now searches everything, in place, before you commit to going anywhere:
//
//    ExploreIndex.load()   flattens houses + trucks + services + day jobs into
//                          one Item shape with a lowercased search blob
//    ExploreQuery.parse()  turns what was typed into an intent (place, price,
//                          domains, free terms)
//    ExploreRank.rank()    scores every item against that intent
//
//  All three already existed for the Explore tab. Reusing them means the
//  homepage and Explore cannot disagree about what "bedsitter Sinza" means, and
//  it means this file is wiring rather than a second search engine.
//
//  THE CATALOGUE IS LOADED ON FIRST FOCUS, NOT ON PAGE LOAD. It is a pass over
//  every listing, and most people who open the homepage never touch the search
//  box. Typing is the first honest signal that they want it.
//
//  Public API:  HomeSearch.init({ input, box, panel, onSubmit })
// ============================================================================
(function () {
  "use strict";

  var DEBOUNCE_MS = 140;        // fast enough to feel live, slow enough to not thrash
  var MAX_RESULTS = 6;
  var RECENT_KEY = "pawa_home_recent";
  var MAX_RECENT = 5;

  function tx(key, fallback, vars) {
    var out = fallback;
    if (window.t) {
      var got = window.t(key);
      if (got && got !== key) out = got;
    }
    if (vars) for (var k in vars) out = out.split("{" + k + "}").join(vars[k]);
    return out;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }

  var ICONS = {
    room:    '<path d="M3 11l9-7 9 7M5 10v10h14V10M9 20v-6h6v6"/>',
    truck:   '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="1.8"/><circle cx="17.5" cy="18" r="1.8"/>',
    service: '<path d="M14.5 6.5a3.5 3.5 0 0 0 4.6 4.6l-8 8a2.3 2.3 0 0 1-3.2-3.2l8-8a3.5 3.5 0 0 0-1.4-1.4z"/><path d="M14.5 6.5 17 4"/>',
    job:     '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12h18"/>',
    clock:   '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',
    arrow:   '<path d="M5 12h14M13 6l6 6-6 6"/>',
    empty:   '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4M8.5 11h5"/>',
  };
  function icon(name) {
    return '<svg class="hs-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || "") + "</svg>";
  }

  // ---- money, the way the rest of the app writes it -------------------------
  function money(n) {
    n = Number(n) || 0;
    if (!n) return "";
    if (n >= 1e9) return "TZS " + (n / 1e9).toFixed(n % 1e9 ? 1 : 0) + "B";
    if (n >= 1e6) return "TZS " + (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M";
    if (n >= 1e3) return "TZS " + Math.round(n / 1e3) + "k";
    return "TZS " + n;
  }

  // ---- recent searches ------------------------------------------------------
  function recents() {
    try {
      var r = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      return Array.isArray(r) ? r.slice(0, MAX_RECENT) : [];
    } catch (_) { return []; }
  }
  function remember(q) {
    q = String(q || "").trim();
    if (q.length < 2) return;
    try {
      var r = recents().filter(function (x) { return x.toLowerCase() !== q.toLowerCase(); });
      r.unshift(q);
      localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, MAX_RECENT)));
    } catch (_) {}
  }

  // ---- the catalogue, loaded once, on demand --------------------------------
  var catalogue = null, loading = null;
  function catalogueReady() {
    if (catalogue) return Promise.resolve(catalogue);
    if (loading) return loading;
    if (!window.ExploreIndex) return Promise.resolve(null);
    loading = window.ExploreIndex.load().then(function (c) {
      catalogue = c;
      return c;
    }).catch(function () { return null; });
    return loading;
  }

  /**
   * What the app has that matches this query.
   *
   * Returns [] rather than throwing when the engine is not on the page: the
   * box still works, it just goes straight to Explore on Enter instead of
   * showing what is waiting there.
   */
  async function search(q) {
    var cat = await catalogueReady();
    if (!cat || !window.ExploreQuery || !window.ExploreRank) return [];
    var intent = window.ExploreQuery.parse(q, {});
    // rank() hands back scored envelopes — { item, score, signals, distKm } —
    // not the items themselves. Diversity is on so six results are not six
    // rooms when the query also matched a truck and two services.
    var out = window.ExploreRank.rank(cat.items, intent, {
      sort: "best", diversity: true, limit: MAX_RESULTS,
    });
    var scored = (out && out.results) || [];

    // rank() ORDERS a directory, it does not filter one: Explore is a page of
    // everything with the best first, and that is right for a page. A
    // suggestion list is a different promise. Typing "saruji" and being offered
    // a bedsitter, a canter and a cook underneath the one real hit reads as a
    // broken search, even though every one of them is correctly ranked below it.
    //
    // The cut is the engine's own text signal, not a number invented here.
    // Measured against a stubbed catalogue: a real hit scores 1.0, a weak but
    // genuine one 0.255, and something the terms never touched exactly 0.0.
    //
    // The exception is a query with no free terms at all — "sinza", a bare
    // place — where textScore has nothing to compare and returns a uniform 0.5
    // for everything. There, "what is in Sinza" IS the question, and the
    // ranking by place and freshness is the answer, so nothing is dropped.
    var hasTerms = !!(intent.terms && intent.terms.length);
    if (hasTerms) {
      scored = scored.filter(function (r) { return (r.signals && r.signals.text) > 0; });
    }
    return scored.map(function (r) { return r.item; });
  }

  // ---- the panel ------------------------------------------------------------
  function resultRow(item, i) {
    var meta = (window.ExploreIndex && window.ExploreIndex.KIND_META[item.kind]) || {};
    var where = [item.area, item.region].filter(Boolean).join(", ");
    var price = money(item.price);
    return '<a class="hs-row" role="option" id="hs-opt-' + i + '" data-i="' + i + '"' +
      ' href="' + esc(item.href || "#") + '">' +
      '<span class="hs-row-ic hs-k-' + esc(item.kind) + '">' + icon(item.kind) + "</span>" +
      '<span class="hs-row-tx">' +
        '<span class="hs-row-t">' + esc(item.title || meta.one || "") + "</span>" +
        '<span class="hs-row-d">' + esc(meta.one || item.kind) +
          (where ? " · " + esc(where) : "") + "</span>" +
      "</span>" +
      (price ? '<span class="hs-row-p">' + esc(price) + "</span>" : "") +
    "</a>";
  }

  function recentRow(q, i) {
    return '<button type="button" class="hs-row hs-recent" role="option" id="hs-opt-' + i + '"' +
      ' data-i="' + i + '" data-q="' + esc(q) + '">' +
      '<span class="hs-row-ic hs-k-recent">' + icon("clock") + "</span>" +
      '<span class="hs-row-tx"><span class="hs-row-t">' + esc(q) + "</span></span>" +
    "</button>";
  }

  function allRow(q, i) {
    return '<a class="hs-row hs-all" role="option" id="hs-opt-' + i + '" data-i="' + i + '"' +
      ' href="explore.html?q=' + encodeURIComponent(q) + '">' +
      '<span class="hs-row-ic hs-k-all">' + icon("arrow") + "</span>" +
      '<span class="hs-row-tx"><span class="hs-row-t">' +
        esc(tx("hs_all", "Search everything for “{q}”", { q: q })) + "</span></span>" +
    "</a>";
  }

  window.HomeSearch = { init: init, _search: search };

  function init(opts) {
    var input = opts.input, panel = opts.panel, box = opts.box;
    if (!input || !panel) return;
    var timer = null, active = -1, rows = [], lastQ = "";

    function close() {
      panel.hidden = true;
      if (box) box.classList.remove("is-open");
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      active = -1;
    }

    function open() {
      panel.hidden = false;
      if (box) box.classList.add("is-open");
      input.setAttribute("aria-expanded", "true");
    }

    function highlight(n) {
      rows = [].slice.call(panel.querySelectorAll(".hs-row"));
      if (!rows.length) return;
      active = ((n % rows.length) + rows.length) % rows.length;
      rows.forEach(function (r, i) { r.classList.toggle("is-active", i === active); });
      input.setAttribute("aria-activedescendant", rows[active].id);
      rows[active].scrollIntoView({ block: "nearest" });
    }

    function paint(html) {
      panel.innerHTML = html;
      active = -1;
      rows = [].slice.call(panel.querySelectorAll(".hs-row"));
      panel.querySelectorAll(".hs-recent").forEach(function (b) {
        b.addEventListener("click", function () {
          input.value = b.dataset.q;
          run(true);
          input.focus();
        });
      });
      // Remember only what was actually acted on. A query typed and abandoned
      // is not a search anybody made.
      panel.querySelectorAll("a.hs-row").forEach(function (a) {
        a.addEventListener("click", function () { remember(input.value); });
      });
      open();
    }

    function showRecents() {
      var r = recents();
      if (!r.length) { close(); return; }
      paint('<div class="hs-head">' + esc(tx("hs_recent", "Recent searches")) + "</div>" +
        r.map(recentRow).join(""));
    }

    async function run(force) {
      var q = (input.value || "").trim();
      if (!q) { showRecents(); return; }
      if (!force && q === lastQ) return;
      lastQ = q;
      var found = await search(q);
      // The query moved on while we were ranking; that answer is stale.
      if ((input.value || "").trim() !== q) return;
      var i = 0;
      var html = found.length
        ? '<div class="hs-head">' + esc(tx("hs_found", "In the app")) + "</div>" +
          found.map(function (it) { return resultRow(it, i++); }).join("")
        : '<div class="hs-none">' + icon("empty") +
            "<span>" + esc(tx("hs_none", "Nothing in the app matches that yet.")) + "</span></div>";
      paint(html + allRow(q, i));
    }

    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(run, DEBOUNCE_MS);
    });
    input.addEventListener("focus", function () {
      catalogueReady();                 // warm it while they are still typing
      if ((input.value || "").trim()) run(true); else showRecents();
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); highlight(active + 1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); highlight(active - 1); return; }
      if (e.key === "Escape") { close(); return; }
      if (e.key !== "Enter") return;
      e.preventDefault();
      // A highlighted row is a choice. Anything else means "show me everything".
      if (active >= 0 && rows[active]) { remember(input.value); rows[active].click(); return; }
      submit();
    });

    function submit() {
      var q = (input.value || "").trim();
      remember(q);
      if (opts.onSubmit) opts.onSubmit(q);
      // Explore, not houses.html: the box has always claimed to search
      // services and trucks, and this is the page that actually does.
      location.href = "explore.html" + (q ? "?q=" + encodeURIComponent(q) : "");
    }
    if (opts.submitBtn) opts.submitBtn.addEventListener("click", submit);

    document.addEventListener("click", function (e) {
      if (!panel.contains(e.target) && e.target !== input && !(box && box.contains(e.target))) close();
    });

    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", panel.id);
    panel.setAttribute("role", "listbox");
    close();
  }
})();
