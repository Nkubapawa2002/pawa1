// ============================================================================
//  pick-list.js — "offer a few, keep a box for their own words, fold the rest"
//
//  WHY THIS EXISTS
//  Three listing forms in this app ask the same question in three places:
//  what is this room like, what does this job include, what comes with this
//  truck. Every one of them has a catalogue behind it that will never be
//  finished, and every one of them was answered the same wrong way at first:
//  lay the whole vocabulary out at once. The room card on agent-houses.html
//  opened thirty-three chips under five headings on EVERY room and stood
//  3,267 px tall with a single room in it. An agent meeting that stops
//  reading and taps nothing, and the listing goes up with no facts on it.
//
//  So there is one shape, and this file is it:
//
//    · the chosen items first, because they are the answer
//    · a handful of suggestions offered flat, no headings
//    · a text box that accepts ANYTHING, kept as written
//    · the rest of the catalogue behind one <details>
//
//  Nothing ever leaves the catalogue. Growing it costs nothing, because
//  everything past the top list is already folded.
//
//  A "value" is either a catalogue key ("bath_inside") or the agent's own
//  words ("Corner room, very quiet"). Both are stored the same way and read
//  back the same way, which is the point: an invented characteristic has to
//  read exactly like an offered one or nobody will invent any.
//
//  Used by: agent-houses (per room), agent-services, agent-trucks.
//  Styled by: css/pick-list.css
// ============================================================================
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  var CHEVRON =
    '<span class="pk-more__chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"' +
    ' stroke="currentColor" stroke-width="2" stroke-linecap="round"' +
    ' stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>';

  /** One suggestion chip. `hint` is the second line some catalogues carry. */
  function chip(item) {
    return '<button type="button" class="pk-chip" data-pk="' + esc(item.key) + '">+ ' +
      esc(item.label) + (item.hint ? "<small>" + esc(item.hint) + "</small>" : "") +
      "</button>";
  }

  /**
   * The fold. Returns "" when there is nothing behind it, so a small
   * catalogue does not grow a control that opens onto an empty box.
   */
  function moreBlock(label, groups, inline) {
    var body = (groups || []).map(function (g) {
      if (!g.items || !g.items.length) return "";
      return '<div class="pk__grp">' +
        (g.title ? '<span class="pk__gt">' + esc(g.title) + "</span>" : "") +
        '<div class="pk__chips">' + g.items.map(chip).join("") + "</div></div>";
    }).join("");
    if (!body.replace(/\s/g, "")) return "";
    return '<details class="pk-more' + (inline ? " pk-more--inline" : "") + '">' +
      "<summary><span>" + esc(label) + "</span>" + CHEVRON + "</summary>" +
      '<div class="pk-more__body">' + body + "</div></details>";
  }

  /**
   * The markup for one instance.
   *
   * opts:
   *   question    the heading. This is what the customer decides on, so it is
   *               a heading and not a caption.
   *   help        one line under it, optional
   *   emptyLabel  what the chosen list says while it is empty
   *   ownLabel    placeholder for the "anything else" box
   *   moreLabel   the fold's own words
   *   top         [{key, label, hint}]  offered flat
   *   groups      [{title, items:[…]}]  behind the fold
   */
  function html(opts) {
    var o = opts || {};
    return '<div class="pk">' +
      (o.question ? '<span class="pk__q">' + esc(o.question) + "</span>" : "") +
      (o.help ? '<p class="pk__help">' + esc(o.help) + "</p>" : "") +
      '<ul class="pk__on is-empty" data-empty="' + esc(o.emptyLabel || "") + '"></ul>' +
      '<div class="pk__chips">' + (o.top || []).map(chip).join("") + "</div>" +
      '<div class="pk__own">' +
        '<input type="text" class="pk__ownin" maxlength="60" placeholder="' +
          esc(o.ownLabel || "") + '">' +
        '<button type="button" class="pk__add" aria-label="' + esc(o.ownLabel || "") + '">+</button>' +
      "</div>" +
      moreBlock(o.moreLabel || "", o.groups) +
      "</div>";
  }

  /** The chosen values, in the order they were added. */
  function read(root) {
    if (!root) return [];
    return Array.prototype.slice
      .call(root.querySelectorAll(".pk__on li"))
      .map(function (li) { return li.dataset.pk; })
      .filter(Boolean);
  }

  function repaint(root) {
    var chosen = read(root);
    var lower = chosen.map(function (v) { return v.toLowerCase(); });
    root.querySelectorAll(".pk-chip").forEach(function (b) {
      b.classList.toggle("is-used", lower.indexOf(String(b.dataset.pk).toLowerCase()) >= 0);
    });
    var list = root.querySelector(".pk__on");
    if (list) list.classList.toggle("is-empty", chosen.length === 0);
  }

  /**
   * Add one value, offered or invented.
   *
   * Matching is case-insensitive so that tapping a chip after typing the same
   * words by hand does not put the fact on the listing twice.
   */
  function add(root, value, label) {
    var v = String(value == null ? "" : value).trim().slice(0, 60);
    if (!v || !root) return;
    var have = read(root).map(function (x) { return x.toLowerCase(); });
    if (have.indexOf(v.toLowerCase()) >= 0) return;
    var list = root.querySelector(".pk__on");
    if (!list) return;
    var li = document.createElement("li");
    li.dataset.pk = v;
    li.innerHTML = '<span></span><button type="button" aria-label="' +
      esc(root.dataset.pkRemove || "") + '">×</button>';
    li.querySelector("span").textContent =
      label != null ? label : (root.__pkLabel ? root.__pkLabel(v) : v);
    li.querySelector("button").addEventListener("click", function () {
      li.remove(); repaint(root);
    });
    list.appendChild(li);
    repaint(root);
  }

  /**
   * Attach behaviour to markup produced by html().
   *
   * opts.label(value)  turns a stored value into the words to show. A key
   *                    becomes its catalogue label; the agent's own words are
   *                    already the label and come back untouched.
   * opts.values        what to start with, catalogue keys or free text.
   * opts.removeLabel   aria-label for the × on a chosen item.
   */
  function wire(root, opts) {
    if (!root) return null;
    var o = opts || {};
    root.__pkLabel = typeof o.label === "function" ? o.label : function (v) { return v; };
    root.dataset.pkRemove = o.removeLabel || "";

    root.querySelectorAll(".pk-chip").forEach(function (b) {
      b.addEventListener("click", function () { add(root, b.dataset.pk); });
    });

    var own = root.querySelector(".pk__ownin");
    var addb = root.querySelector(".pk__add");
    if (own && addb) {
      var take = function () { add(root, own.value); own.value = ""; own.focus(); };
      addb.addEventListener("click", take);
      own.addEventListener("keydown", function (e) {
        // Enter inside a form would submit it. Here it means "add this one".
        if (e.key === "Enter") { e.preventDefault(); take(); }
      });
    }

    (Array.isArray(o.values) ? o.values : []).forEach(function (v) { add(root, v); });
    repaint(root);
    return {
      read: function () { return read(root); },
      add: function (v) { add(root, v); },
      clear: function () {
        var list = root.querySelector(".pk__on");
        if (list) list.innerHTML = "";
        repaint(root);
      },
    };
  }

  window.PickList = {
    html: html,
    wire: wire,
    read: read,
    add: add,
    repaint: repaint,
    chip: chip,
    moreBlock: moreBlock,
    CHEVRON: CHEVRON,
  };
})();
