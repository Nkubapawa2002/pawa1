// ============================================================================
//  agent-notice-strip.js — everything the platform has to say to an agent,
//  in one place, one at a time.
//
//  THE PROBLEM
//  -----------
//  Eight things could write a message into the top of an agent dashboard, and
//  four of them did it the same way: insertBefore(el, mount.firstChild) on the
//  same node. Nothing capped the total, nothing collapsed them, and no writer
//  knew what the others had already put there. A deactivated agent with unread
//  admin mail met three stacked banners before their own properties, on a
//  390px screen.
//
//  THE SHAPE
//  ---------
//  One card. The most urgent notice is in it. A pager reaches the rest. The
//  dashboard is the same height whether nothing has happened or nine things
//  have, which is the property that makes the screen designable at all.
//
//  SOURCES OWN SLICES
//  ------------------
//  set(source, notices) REPLACES everything that source contributed. That is
//  what stops the pile-up, and it matters because every producer here runs
//  more than once: routeOnAuth() re-enters on SIGNED_IN, checkSubscription()
//  has two callers, and the bell polls every 120 seconds. There is deliberately
//  no push().
//
//  WHAT DOES NOT BELONG HERE
//  -------------------------
//  The waiting-renters board and the two coaching cards are CONTENT. The board
//  is the only thing on this page that makes the agent money; putting a lead
//  behind a chevron under a subscription reminder would be the worst possible
//  outcome of this redesign. The owner-quota badge stays too: it sits beside
//  the button it disables, and saying it twice helps nobody.
//
//  NO html FIELD, EVER
//  -------------------
//  `title` and `body` are plain text and are escaped here. An html field is the
//  door the hardcoded hex came back through last time. Anything that wants to
//  be a link is an `action`.
//
//  USAGE
//    const strip = AgentNoticeStrip.mount({ into: document.getElementById("ahWarn") });
//    strip.set("sub", [{ id, severity, title, body, action }]);
//    strip.clear("sub");
// ============================================================================
(function () {
  "use strict";

  // window.t() returns the KEY ITSELF when a string is missing, so a bare
  // t(k) || fallback is truthy and prints "anx_next" on the screen. Both halves
  // have to be checked. See ah_must_signin, which shipped exactly that way.
  function tx(key, en, vars) {
    var out = en;
    if (window.t) {
      var got = window.t(key);
      if (got && got !== key) out = got;
    }
    if (vars) {
      for (var k in vars) out = out.split("{" + k + "}").join(String(vars[k]));
    }
    return out;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }

  // Lucide-style strokes. Never a character and never an emoji: these inherit
  // the theme's colour and scale with the type beside them.
  var PATHS = {
    fatal:    '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    blocking: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16h.01"/>',
    warn:     '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.4l3.4 2"/>',
    info:     '<path d="M21 14a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
    left:     '<path d="m15 18-6-6 6-6"/>',
    right:    '<path d="m9 18 6-6-6-6"/>',
    close:    '<path d="M6 6l12 12M18 6L6 18"/>',
  };

  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + (PATHS[name] || "") + "</svg>";
  }

  // ---- the ladder --------------------------------------------------------
  //  0 fatal     the page itself is broken. Client-side only, never the bell.
  //  1 blocking  the listings are OFF the board right now.
  //  2 warn      they come off soon, or an admin wrote something urgent.
  //  3 info      an ordinary admin message, or an account under review.
  //
  //  There is no "ok" rung. A healthy subscription used to draw a green
  //  "Subscription active until 3 Oct" bar, which is the most-shown notice on
  //  this page and tells the agent nothing they have to act on. It is already
  //  in the bell and on the Profile tab. Dropping it is what turns "the same
  //  height with one notice or nine" into "the same height with NONE or nine",
  //  which for most agents on most days is the whole win.
  var RANK = { fatal: 0, blocking: 1, warn: 2, info: 3 };
  function rankOf(n) {
    var r = RANK[n && n.severity];
    return r == null ? RANK.info : r;
  }

  function time(n) {
    var t = n && n.at ? Date.parse(n.at) : NaN;
    return isNaN(t) ? -Infinity : t;   // undated sorts last within its rung
  }

  /**
   * Total and stable, so the pager index cannot shuffle under the reader
   * between two polls. Rung, then newest first, then the order the sources
   * were registered in, then the id.
   */
  function compare(a, b) {
    return (rankOf(a.n) - rankOf(b.n))
        || (time(b.n) - time(a.n))
        || (a.s - b.s)
        || String(a.n.id).localeCompare(String(b.n.id));
  }

  function mount(opts) {
    opts = opts || {};
    var into = opts.into;
    if (!into) return null;
    // routeOnAuth() re-enters, and it is where this gets mounted. Handing back
    // the same handle is cheaper than making every caller remember.
    if (into._anxHandle) return into._anxHandle;

    var order = [];
    var bySource = Object.create(null);
    var anchor = null;    // the id being shown, NOT its index
    var lastTop = null;   // which id was most urgent at the previous paint

    into.classList.add("anx-host");

    var el = document.createElement("div");
    el.className = "anx";
    into.appendChild(el);

    // The live region is a visually hidden SIBLING of the card, written only
    // when the agent moves the pager or the top item genuinely changes. Putting
    // aria-live on the card itself would re-announce the same sentence on every
    // silent re-render, and this thing re-renders on a 120 second poll.
    var say = document.createElement("p");
    say.className = "anx-say";
    say.setAttribute("role", "status");
    say.setAttribute("aria-live", "polite");
    say.setAttribute("aria-atomic", "true");
    into.appendChild(say);

    function list() {
      var out = [];
      for (var i = 0; i < order.length; i++) {
        var rows = bySource[order[i]];
        if (!rows) continue;
        for (var j = 0; j < rows.length; j++) out.push({ n: rows[j], s: i });
      }
      out.sort(compare);
      return out.map(function (x) { return x.n; });
    }

    function indexOfAnchor(items) {
      for (var i = 0; i < items.length; i++) {
        if (items[i].id === anchor) return i;
      }
      return 0;
    }

    /**
     * Every notice has an action, and that is a layout decision as much as a
     * navigational one: the action row is what makes the card's height the
     * same for a notice that has somewhere to go and one that does not. The
     * fallback opens the bell, which also makes "everything is also in the
     * notifications panel" structural rather than a promise in a comment.
     */
    function actionOf(n) {
      if (n.action) return n.action;
      return {
        label: tx("anx_open_all", "See all"),
        onClick: function () {
          if (window.NotifyUI && window.NotifyUI.open) window.NotifyUI.open();
        },
        quiet: true,
      };
    }

    function paint(announce) {
      var items = list();
      if (!items.length) {
        el.innerHTML = "";
        el.hidden = true;
        say.textContent = "";
        anchor = null;
        return;
      }
      el.hidden = false;

      var at = indexOfAnchor(items);
      // The anchor exists so a 120 second poll cannot yank a reader from "3 of
      // 4" back to the top. It must not survive something worse ARRIVING: a
      // blocking notice means the listings are off the board right now, and it
      // takes the screen once, from wherever the reader was.
      //
      // "Once" is what lastTop buys. Without it the same comparison is true on
      // every subsequent paint, so pressing the next arrow moved the anchor and
      // the very next render dragged it straight back: a pager that could not
      // page. After the jump the reader owns the position again.
      if (at > 0 && items[0].id !== lastTop && rankOf(items[0]) < rankOf(items[at])) at = 0;
      lastTop = items[0].id;
      var n = items[at];
      anchor = n.id;

      var sev = RANK[n.severity] == null ? "info" : n.severity;
      var many = items.length > 1;
      var act = actionOf(n);

      var actHtml = act.href
        ? '<a class="anx-btn' + (act.quiet ? " anx-btn--quiet" : "") + '" href="' + esc(act.href) + '"' +
            (act.external ? ' target="_blank" rel="noopener"' : "") + ">" + esc(act.label) + "</a>"
        : '<button type="button" class="anx-btn' + (act.quiet ? " anx-btn--quiet" : "") +
            '" data-anx="act">' + esc(act.label) + "</button>";

      // The pager is REMOVED at one notice, not hidden: "1 of 1" is a control
      // that cannot do anything, on a strip whose job is to be quiet. The grid
      // track collapses on its own, so the title reclaims the width with no
      // modifier class.
      var pageHtml = many
        ? '<div class="anx-page">' +
            '<button type="button" class="anx-nav" data-anx="prev" ' + (at === 0 ? "disabled " : "") +
              'aria-label="' + esc(tx("anx_prev", "Previous notice")) + '">' + icon("left") + "</button>" +
            '<span class="anx-count" aria-hidden="true">' + (at + 1) + "/" + items.length + "</span>" +
            '<button type="button" class="anx-nav" data-anx="next" ' +
              (at === items.length - 1 ? "disabled " : "") +
              'aria-label="' + esc(tx("anx_next", "Next notice")) + '">' + icon("right") + "</button>" +
          "</div>"
        : "";

      // The pager sits in the ACTION row, not beside the title. On the title row
      // its 28px made a one-notice card 131px and a three-notice card 158px,
      // which is the exact jump this whole thing exists to abolish. The action
      // row already reserves --hit-min, so down here the pager is free.
      el.innerHTML =
        '<section class="anx-card is-' + esc(sev) + '" role="group" aria-label="' +
            esc(tx("anx_a11y", "Account notices")) + '">' +
          '<span class="anx-ic" aria-hidden="true">' + icon(sev) + "</span>" +
          '<p class="anx-title anx-tx">' + esc(n.title || "") + "</p>" +
          '<p class="anx-body anx-tx">' + esc(n.body || "") + "</p>" +
          '<div class="anx-act">' + actHtml + pageHtml +
            (n.dismissible
              ? '<button type="button" class="anx-x" data-anx="dismiss" aria-label="' +
                  esc(tx("anx_dismiss", "Dismiss")) + '">' + icon("close") + "</button>"
              : "") +
          "</div>" +
        "</section>";

      // Position first, then the words. A reader who just pressed the arrow
      // needs to know where they are, not only what changed.
      if (announce) {
        say.textContent =
          tx("anx_of", "{n} of {of}", { n: at + 1, of: items.length }) + ". " +
          (n.title || "") + (n.body ? " " + n.body : "");
      }
    }

    function step(by) {
      var items = list();
      var at = indexOfAnchor(items) + by;
      if (at < 0 || at >= items.length) return;   // ends stop, they do not wrap
      anchor = items[at].id;
      paint(true);
    }

    el.addEventListener("click", function (e) {
      var b = e.target.closest("[data-anx]");
      if (!b || !el.contains(b)) return;
      var what = b.dataset.anx;

      if (what === "next") { step(1); return; }
      if (what === "prev") { step(-1); return; }

      var items = list();
      var n = items[indexOfAnchor(items)];
      if (!n) return;

      if (what === "act") {
        var act = actionOf(n);
        if (typeof act.onClick === "function") act.onClick(n);
        return;
      }
      if (what === "dismiss") {
        for (var k in bySource) {
          var i = bySource[k].indexOf(n);
          if (i >= 0) { bySource[k] = bySource[k].slice(0, i).concat(bySource[k].slice(i + 1)); break; }
        }
        anchor = null;
        paint(false);
        if (typeof n.onDismiss === "function") { try { n.onDismiss(n); } catch (_) {} }
      }
    });

    el.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") { step(1); e.preventDefault(); }
      else if (e.key === "ArrowLeft") { step(-1); e.preventDefault(); }
    });

    var handle = {
      el: el,
      /** Replace everything `source` contributed. The whole anti-pile-up rule. */
      set: function (source, notices) {
        if (order.indexOf(source) < 0) order.push(source);
        bySource[source] = (notices || []).filter(Boolean);
        paint(false);
      },
      clear: function (source) {
        if (source == null) { order = []; bySource = Object.create(null); }
        else bySource[source] = [];
        paint(false);
      },
      count: function () { return list().length; },
      /** Re-render in the current language, after applyTranslations(). */
      refresh: function () { paint(false); },
      destroy: function () {
        el.remove();
        say.remove();
        into.classList.remove("anx-host");
        delete into._anxHandle;
      },
    };
    into._anxHandle = handle;
    return handle;
  }

  window.AgentNoticeStrip = {
    mount: mount,
    // Test seams. The ladder and the sort are pure, so they can be checked
    // without a browser: see tests/agent_notice_sort_test.mjs.
    _rank: rankOf,
    _compare: compare,
  };
})();
