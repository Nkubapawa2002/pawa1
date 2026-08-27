// ============================================================================
//  house-cost-chart.js — where the money actually goes.
//
//  WHY THIS EXISTS
//  house-rooms.js already works out what it costs to move into one space, and
//  what lands every month after that. Until now both were a list of lines. A
//  list tells you the figures; it does not tell you that the deposit is half
//  of what you have to find on day one, which is the thing that decides
//  whether somebody can take the room at all.
//
//  So: one composition bar per total. Proportion from the bar, exact figures
//  from the legend beside it.
//
//  THE PART THAT NEEDED THINKING: A FREE THING HAS NO WIDTH.
//  Water at zero is one of the best facts a listing can carry, and a stacked
//  bar is exactly the wrong place to put it — a zero-value segment is zero
//  pixels wide, so the good news would be silently dropped by the geometry.
//  Same for a cost nobody stated: a bar cannot draw an unknown.
//
//  The bar therefore carries ONLY what has a price, and everything else is
//  named beside it in its own row: what is included at no cost, and what has
//  not been priced. Nothing is skipped, and nothing is drawn as though it were
//  a number when it is not.
//
//  THE COMMISSION IS HATCHED, on purpose. It is usually this app's assumption
//  (the market's one month), not a figure the agent quoted. A different fill
//  from a solid one is the honest encoding, and it doubles as the secondary
//  encoding that keeps the chart readable without colour.
//
//  COLOUR. The four series were validated with the dataviz palette checker
//  against BOTH surfaces — dark #141A18 and light #ffffff — for the OKLCH
//  lightness band, the chroma floor, colour-vision separation, normal-vision
//  separation and contrast. All pass in both modes:
//
//      #0d9488  rent up front      #b8860b  deposit
//      #2563eb  agent commission   #c2410c  one-off charges
//
//  The brand emerald (#2EE6A6, OKLCH L 0.82) is deliberately NOT used as a
//  fill: it sits far outside the dark band (0.48–0.67) and blows out against
//  the page. It stays where it belongs, on interactive chrome.
//
//  Read by: js/lib/house-sections.js.  Money shape owner: js/lib/house-rooms.js.
// ============================================================================
(function () {
  "use strict";

  // Fixed order, never cycled. A series keeps its colour whatever else is on
  // the chart, so a listing with no one-off charges does not repaint the rest.
  var SERIES = [
    { key: "rent",       cls: "hcc-s1" },
    { key: "deposit",    cls: "hcc-s2" },
    { key: "commission", cls: "hcc-s3" },
    { key: "oneoff",     cls: "hcc-s4" },
  ];
  var SERIES_BY_KEY = {};
  SERIES.forEach(function (s) { SERIES_BY_KEY[s.key] = s; });

  // Below this share of the total a segment is too thin to carry a label, and
  // a label on every segment is noise anyway — the legend has every figure.
  var LABEL_MIN_SHARE = 0.14;
  var MIN_SEG_PCT = 1.5;   // so a small real cost is still visible as a mark

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function money(n) {
    return window.HouseRooms && window.HouseRooms.money
      ? window.HouseRooms.money(n)
      : "TZS " + Number(n || 0).toLocaleString("en-US");
  }
  function freeWord() {
    return window.HouseSpec && window.HouseSpec.freeLabel
      ? window.HouseSpec.freeLabel() : "Free";
  }
  // Every visible word in this file comes from the catalogue, in whichever
  // language the reader is in. The fallbacks exist only so the chart still
  // draws on a page that did not bundle house-spec.js.
  var EN = {
    cost_movein: "To move in", cost_month: "Every month after that",
    cost_open: "Not priced", cost_table: "See the figures as a table",
    cost_item: "Item", cost_amount: "Amount", cost_total: "Total priced",
    cost_assumed: "assumed",
    cost_assumed_full: "this app's assumption, not the agent's price",
  };
  function t(key) {
    var S = window.HouseSpec;
    var v = S && S.t ? S.t(key) : "";
    return v || EN[key] || "";
  }

  /**
   * Which series a move-in line belongs to. The line labels are written for a
   * reader, not for this, so match on what house-rooms.js actually emits.
   */
  function seriesOf(line) {
    var k = String(line.k || "");
    if (/rent/i.test(k)) return "rent";
    if (/deposit|dhamana/i.test(k)) return "deposit";
    if (/commission/i.test(k)) return "commission";
    return "oneoff";
  }

  /**
   * Split priced lines from the two things a bar cannot draw.
   * @returns {{parts:Array, free:Array, open:Array, total:number}}
   */
  function split(lines) {
    var parts = [], free = [], open = [], total = 0;
    (lines || []).forEach(function (ln) {
      if (ln.free) { free.push({ label: ln.k }); return; }
      if (ln.src === "open" || ln.muted) { open.push({ label: ln.k }); return; }
      var amt = readAmount(ln);
      if (amt == null || !(amt > 0)) { open.push({ label: ln.k }); return; }
      parts.push({
        label: ln.k, amount: amt, key: seriesOf(ln),
        assumed: ln.src === "assumed", sub: ln.sub || "",
      });
      total += amt;
    });
    return { parts: parts, free: free, open: open, total: total };
  }

  // house-rooms.js formats the value for display before it reaches us, so the
  // number is read back out of the string it already produced rather than
  // duplicating the arithmetic here and risking the two disagreeing.
  function readAmount(ln) {
    if (typeof ln.amount === "number" && isFinite(ln.amount)) return ln.amount;
    var m = String(ln.v == null ? "" : ln.v).replace(/[,\s]/g, "").match(/\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  function segments(parts, total) {
    if (!total) return [];
    // Every real cost gets at least a sliver, then shares are renormalised so
    // the bar still sums to exactly 100% and no rounding gap opens at the end.
    var raw = parts.map(function (p) {
      return Math.max((p.amount / total) * 100, MIN_SEG_PCT);
    });
    var sum = raw.reduce(function (a, b) { return a + b; }, 0);
    return parts.map(function (p, i) {
      return {
        part: p,
        pct: (raw[i] / sum) * 100,
        share: p.amount / total,
      };
    });
  }

  function barHtml(segs, title) {
    if (!segs.length) return "";
    var cells = segs.map(function (s, i) {
      var cls = (SERIES_BY_KEY[s.part.key] || SERIES[3]).cls;
      var label = s.share >= LABEL_MIN_SHARE
        ? '<span class="hcc-seg__lbl">' + esc(Math.round(s.share * 100)) + '%</span>' : "";
      return '<div class="hcc-seg ' + cls + (s.part.assumed ? " is-assumed" : "") + '"' +
             ' style="flex:' + s.pct.toFixed(3) + ' 1 0"' +
             ' tabindex="0" role="listitem"' +
             ' aria-label="' + esc(s.part.label + ": " + money(s.part.amount) +
                                  (s.part.assumed ? " (" + t("cost_assumed_full") + ")" : "")) + '"' +
             ' data-tip="' + esc(s.part.label + " · " + money(s.part.amount)) + '">' +
             label + '</div>';
    }).join("");
    return '<div class="hcc-bar" role="list" aria-label="' + esc(title) + '">' + cells + '</div>';
  }

  function legendHtml(segs) {
    return '<ul class="hcc-key">' + segs.map(function (s) {
      var cls = (SERIES_BY_KEY[s.part.key] || SERIES[3]).cls;
      return '<li class="hcc-key__i">' +
        '<span class="hcc-dot ' + cls + (s.part.assumed ? " is-assumed" : "") + '" aria-hidden="true"></span>' +
        '<span class="hcc-key__l">' + esc(s.part.label) +
          (s.part.assumed ? '<em class="hcc-assumed">' + esc(t("cost_assumed")) + '</em>' : "") +
        '</span>' +
        '<span class="hcc-key__v">' + esc(money(s.part.amount)) + '</span>' +
      '</li>';
    }).join("") + '</ul>';
  }

  /** The two rows a bar cannot hold. Never omitted when they have content. */
  function asideHtml(free, open) {
    var out = "";
    if (free.length) {
      out += '<div class="hcc-aside hcc-aside--free">' +
        '<span class="hcc-pill">' + esc(freeWord()) + '</span>' +
        '<span class="hcc-aside__l">' + esc(free.map(function (f) { return f.label; }).join(", ")) +
        '</span></div>';
    }
    if (open.length) {
      out += '<div class="hcc-aside hcc-aside--open">' +
        '<span class="hcc-pill hcc-pill--open">' + esc(t("cost_open")) + '</span>' +
        '<span class="hcc-aside__l">' + esc(open.map(function (o) { return o.label; }).join(", ")) +
        '</span></div>';
    }
    return out;
  }

  /** The table view. Every figure, for a reader who cannot use the bar. */
  function tableHtml(segs, free, open, total, title) {
    var rows = segs.map(function (s) {
      return '<tr><td>' + esc(s.part.label) + (s.part.assumed ? " (" + t("cost_assumed") + ")" : "") +
             '</td><td>' + esc(money(s.part.amount)) + '</td></tr>';
    }).join("");
    rows += free.map(function (f) {
      return '<tr><td>' + esc(f.label) + '</td><td>' + esc(freeWord()) + '</td></tr>';
    }).join("");
    rows += open.map(function (o) {
      return '<tr><td>' + esc(o.label) + '</td><td>' + esc(t("cost_open")) + '</td></tr>';
    }).join("");
    return '<details class="hcc-table"><summary>' + esc(t("cost_table")) + '</summary>' +
      '<table><caption>' + esc(title) + '</caption><thead><tr><th>' + esc(t("cost_item")) +
      '</th><th>' + esc(t("cost_amount")) + '</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '<tfoot><tr><th>' + esc(t("cost_total")) + '</th><td>' + esc(money(total)) + '</td></tr></tfoot>' +
      '</table></details>';
  }

  /**
   * One composition block: a bar, its legend, the rows the bar cannot hold,
   * and a table view.
   * @param {{k:string,v:string,src:string,free:boolean,sub:string}[]} lines
   */
  function block(lines, title, opts) {
    var s = split(lines);
    var segs = segments(s.parts, s.total);
    // Nothing priced at all: no bar, but the free and unpriced rows still
    // matter and are still shown. A chart with no data is not a reason to
    // withhold the facts that exist.
    var head = '<div class="hcc-head"><h4 class="hcc-title">' + esc(title) + '</h4>' +
      (s.total ? '<span class="hcc-total">' + esc(money(s.total)) + '</span>' : "") +
      '</div>';
    return '<figure class="hcc"' + (opts && opts.id ? ' id="' + esc(opts.id) + '"' : "") + '>' +
      head +
      barHtml(segs, title) +
      (segs.length ? legendHtml(segs) : "") +
      asideHtml(s.free, s.open) +
      (segs.length ? tableHtml(segs, s.free, s.open, s.total, title) : "") +
    '</figure>';
  }

  /**
   * The whole money picture for one space: what it takes to get in, and what
   * it costs to stay. Two bars, one unit, never a second axis.
   */
  function render(mi) {
    if (!mi || mi.simple) return "";
    var out = "";
    if (mi.lines && mi.lines.length) {
      out += block(mi.lines, t("cost_movein"), { id: "hxCostMoveIn" });
    }
    var m = mi.monthly;
    if (m) {
      var monthly = [{ k: "Rent", v: money(m.rent), amount: m.rent, src: "stated" }];
      (m.bills || []).forEach(function (b) {
        monthly.push({
          k: b.label,
          amount: b.amount,
          v: b.amount != null ? money(b.amount) : "",
          free: !!b.free,
          src: b.amount == null && !b.free ? "open" : "stated",
        });
      });
      out += block(monthly, t("cost_month"), { id: "hxCostMonthly" });
    }
    return out ? '<div class="hcc-wrap">' + out + '</div>' : "";
  }

  /** Tooltip + keyboard focus for the segments. Idempotent. */
  function wire(root) {
    var host = root || document;
    var tip = document.getElementById("hccTip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "hccTip";
      tip.className = "hcc-tip";
      tip.setAttribute("role", "status");
      document.body.appendChild(tip);
    }
    var show = function (el) {
      tip.textContent = el.getAttribute("data-tip") || "";
      var r = el.getBoundingClientRect();
      tip.classList.add("is-on");
      var w = tip.offsetWidth;
      var x = r.left + r.width / 2 - w / 2;
      x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
      tip.style.left = x + "px";
      tip.style.top = (r.top + window.scrollY - tip.offsetHeight - 8) + "px";
    };
    var hide = function () { tip.classList.remove("is-on"); };
    host.querySelectorAll(".hcc-seg").forEach(function (el) {
      if (el.dataset.wired) return;
      el.dataset.wired = "1";
      el.addEventListener("mouseenter", function () { show(el); });
      el.addEventListener("focus", function () { show(el); });
      el.addEventListener("mouseleave", hide);
      el.addEventListener("blur", hide);
      // Touch: a tap shows the figure, a second tap anywhere clears it.
      el.addEventListener("click", function (e) { e.stopPropagation(); show(el); });
    });
    if (!document.body.dataset.hccTapWired) {
      document.body.dataset.hccTapWired = "1";
      document.addEventListener("click", hide);
    }
  }

  window.HouseCostChart = { render: render, wire: wire, block: block, split: split };
})();
