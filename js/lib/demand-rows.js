// ============================================================================
//  demand-rows.js — one customer request, drawn once
// ============================================================================
//  A seeker fills in js/lib/request-place.js, which writes house_demand_pins
//  and tags the row with a region and a district. house_demand_for_agent()
//  then routes it to the agents who work that ground: same district first,
//  same region after. That is the most valuable thing this app knows, and
//  until now it was drawn twice, differently:
//
//    js/lib/agent-demand-board.js   services + trucks, region+district match,
//                                   a cream card with brown ink
//    js/pages/agent-houses.js       houses only, a RADIUS match instead, its
//                                   own card, its own copy of daysUntil()
//
//  Two implementations of "somebody near you is looking for a place", on three
//  pages that are otherwise one system, and neither of them reached the bell.
//
//  This owns the fetch, the ranking and the row. The three dashboards mount it
//  and so does the notification panel, so a request looks and sorts the same
//  wherever it is read.
//
//    DemandRows.fetch({ sb, region, district, listing, limit }) -> [row]
//    DemandRows.sort(rows)                                      -> [row]
//    DemandRows.html(rows, { limit, total, href, noteOf })      -> string
//    DemandRows.rowHtml(row, { note })                          -> string
//    DemandRows.daysUntil(iso)                                  -> number|null
//    DemandRows.urgency(iso)                                    -> { level, days }
//    DemandRows.urgentCount(rows)                               -> number
//    DemandRows.phones(raw)                                     -> { tel, wa }
//
//  Styled by css/notify.css (.dm-*), which every surface that mounts this
//  already links.
// ============================================================================
(function () {
  "use strict";

  var esc = function (s) {
    return window.escHtml ? window.escHtml(s) : String(s == null ? "" : s)
      .replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
  };
  var T = function (k) { return window.t ? window.t(k) : k; };

  /**
   * Days between today and a date, floored to whole days at midnight.
   *
   * Midnight on both sides, not `Date.now()`: a deadline at 09:00 tomorrow is
   * "tomorrow", not "in 0 days", and an agent reading it at 23:50 and at 00:10
   * must be told the same thing.
   */
  function daysUntil(dateStr) {
    if (!dateStr) return null;
    var d = new Date(String(dateStr).slice(0, 10) + "T00:00:00");
    if (isNaN(d)) return null;
    var t = new Date();
    t.setHours(0, 0, 0, 0);
    return Math.round((d - t) / 86400000);
  }

  /** How hard the deadline is pressing: what colours the chip and the sort. */
  function urgency(needed_by) {
    var n = daysUntil(needed_by);
    if (n == null) return { level: "none", days: null };
    if (n < 0) return { level: "over", days: n };
    if (n <= 7) return { level: "urgent", days: n };
    if (n <= 30) return { level: "soon", days: n };
    return { level: "later", days: n };
  }

  function byChip(needed_by) {
    var u = urgency(needed_by);
    if (u.level === "none") return "";
    var txt = u.level === "over" ? T("adb_overdue")
      : u.days === 0 ? T("adb_today")
      : u.days <= 60 ? T("adb_in_days").replace("{n}", u.days)
      : T("adb_by") + " " + String(needed_by).slice(0, 10);
    return '<span class="dm-by is-' + u.level + '">' +
      esc(T("adb_needs")) + " " + esc(txt) + "</span>";
  }

  /**
   * A phone number, in the two shapes the two buttons need.
   *
   * Tanzanian numbers are written 0712… locally and 255712… internationally,
   * and wa.me will not accept the leading zero. tel: takes it either way.
   */
  function phones(raw) {
    var phone = String(raw || "").trim();
    var digits = phone.replace(/\D/g, "");
    if (!digits) return { tel: "", wa: "" };
    return { tel: phone, wa: digits.charAt(0) === "0" ? "255" + digits.slice(1) : digits };
  }

  // ---- the fetch -----------------------------------------------------------
  /**
   * Every open request routed to this agent, best match first.
   *
   * Two RPCs, because the district-aware one is newer: a deployment that has
   * not run house_demand_for_agent.sql still answers house_demand_in_region.
   * Both return nothing rather than throwing when the agent has no region, so
   * every caller can treat "no region" and "no requests" the same way.
   */
  async function fetchRows(opts) {
    opts = opts || {};
    var sb = opts.sb;
    var region = opts.region;
    if (!sb || !region) return [];
    var district = opts.district || null;
    var listing = opts.listing || null;
    var limit = opts.limit || 100;

    var rows = null;
    try {
      var a = await sb.rpc("house_demand_for_agent", {
        p_region: region, p_district: district, p_listing: listing, p_limit: limit,
      });
      if (!a.error && Array.isArray(a.data)) rows = a.data;
    } catch (_) {}
    if (!rows) {
      try {
        var b = await sb.rpc("house_demand_in_region", {
          p_region: region, p_listing: listing, p_limit: limit,
        });
        if (!b.error && Array.isArray(b.data)) rows = b.data;
      } catch (_) {}
    }
    return sort(rows || []);
  }

  /**
   * Own district first, then the soonest deadline, then whatever the server
   * gave us. A request with no deadline sorts last rather than first: no date
   * is not urgency, and putting it above somebody who moves on Friday is the
   * one ordering that costs an agent a deal.
   */
  function sort(rows) {
    return rows.slice().sort(function (a, b) {
      var ad = a.match_level === "district" ? 0 : 1;
      var bd = b.match_level === "district" ? 0 : 1;
      if (ad !== bd) return ad - bd;
      var da = daysUntil(a.needed_by), db = daysUntil(b.needed_by);
      if ((da == null) !== (db == null)) return da == null ? 1 : -1;
      if (da != null && db != null && da !== db) return da - db;
      return 0;
    });
  }

  // ---- the row -------------------------------------------------------------
  /**
   * One request, with everything needed to decide whether to ring.
   *
   * A name, where they are, what they asked for, when they need it, and the
   * two ways to reach them. An agent should never have to open anything to
   * know whether this call is worth making.
   */
  function rowHtml(r, opts) {
    opts = opts || {};
    var p = phones(r.phone);
    var inDistrict = r.match_level === "district";
    var spec = window.pawaDemandSpec ? window.pawaDemandSpec(r) : "";
    // `note` is the houses dashboard saying why a lead may not be worth the
    // call: a ceiling under the agent's cheapest unit, or the opposite of what
    // they list. Advisory, so the row is dimmed and never hidden.
    // The note says what is wrong with the lead; noteTitle says what that
    // means for the reader. Two different sentences, and the second one is
    // the one an agent needs before deciding not to ring somebody.
    var noteAttr = opts.noteTitle ? ' title="' + esc(opts.noteTitle) + '"' : "";
    return '<article class="dm-row' + (opts.note ? " is-dim" : "") + '">' +
      '<div class="dm-who">' +
        '<b class="dm-name">' + esc(r.name || T("adb_waiting_client")) + "</b>" +
        (inDistrict ? '<span class="dm-tag">' + esc(T("adb_your_district")) + "</span>" : "") +
        (opts.note ? '<span class="dm-note"' + noteAttr + '>' + esc(opts.note) + "</span>" : "") +
      "</div>" +
      (r.area ? '<div class="dm-area">' + esc(r.area) + "</div>" : "") +
      spec +
      byChip(r.needed_by) +
      (p.tel || p.wa ?
        '<div class="dm-acts">' +
          (p.tel ? '<a class="dm-btn dm-btn--call" href="tel:' + esc(p.tel) + '">' +
            esc(T("action_call")) + "</a>" : "") +
          (p.wa ? '<a class="dm-btn dm-btn--wa" href="https://wa.me/' + esc(p.wa) +
            '" target="_blank" rel="noopener">' + esc(T("action_whatsapp")) + "</a>" : "") +
        "</div>" : "") +
    "</article>";
  }

  /**
   * A list of requests, and the one line under it that says what is not shown.
   *
   * `total` is how many there ARE, which is not always how many were handed
   * over. The bell counts every request routed to this agent but carries only
   * the first few rows, so measuring the overflow against the slice prints
   * "+3 more" under a heading that reads 20. A caller passing the whole list
   * can leave it out.
   *
   * `href` turns that line into the door. The sentence admitting that
   * seventeen people are not shown is the sentence you tap to reach them,
   * which is one element rather than two, and a section that hides people
   * with no way through is worse than one that never mentioned them.
   */
  function html(rows, opts) {
    opts = opts || {};
    var list = rows || [];
    var top = opts.limit ? list.slice(0, opts.limit) : list;
    // `noteOf` lets a caller annotate a row without this file knowing what the
    // annotation means.
    var noteOf = typeof opts.noteOf === "function" ? opts.noteOf : function () { return ""; };
    var out = top.map(function (r) {
      return rowHtml(r, { note: noteOf(r), noteTitle: opts.noteTitle });
    }).join("");
    var total = opts.total == null ? list.length : (Number(opts.total) || 0);
    var hidden = Math.max(0, total - top.length);
    if (opts.href) {
      var label = hidden ? T("adb_more").replace("{n}", hidden) : T("adb_see_all");
      out += '<a class="dm-more" href="' + esc(opts.href) + '">' + esc(label) + "</a>";
    } else if (hidden) {
      out += '<p class="dm-more">' +
        esc(T("adb_more").replace("{n}", hidden)) + "</p>";
    }
    return out;
  }

  /** How many of these need a place within the week. Used in the lead line. */
  function urgentCount(rows) {
    return (rows || []).filter(function (r) {
      var n = daysUntil(r.needed_by);
      return n != null && n <= 7;
    }).length;
  }

  window.DemandRows = {
    fetch: fetchRows,
    sort: sort,
    html: html,
    rowHtml: rowHtml,
    daysUntil: daysUntil,
    urgency: urgency,
    urgentCount: urgentCount,
    phones: phones,
  };
})();
