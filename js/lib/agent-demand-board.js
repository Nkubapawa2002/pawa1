// =====================================================================
// Shared agent demand board — the same requests, on a dashboard
// =====================================================================
// Every person actively waiting in the agent's region, their own DISTRICT
// first, is a lead: a renter moving into the area needs a moving truck and
// daily services too, so the same demand is shown on all three portals with
// copy tailored per dashboard.
//
//   window.AgentDemandBoard.load({ sb, agentProfile, mount, kind });
//   kind: "houses" | "services" | "trucks"
//
// THE FETCH, THE RANKING AND THE ROW ARE NOT HERE. They live in
// js/lib/demand-rows.js, because the notification panel draws the same request
// and the two must not be able to disagree about what it says or how it sorts.
// This file is the card around them: a heading that counts, a lead line, and
// the mount.
//
// It used to own all of it, plus a second copy of daysUntil(), inside a card
// painted #fff7ed with #9a3412 ink. That is legible on a white page and a
// bright orange slab on the dark portal, which is where agents actually work.
// The card is on tokens now and follows both themes.
//
// Degrades to nothing if there is no region, no RPC, or no DemandRows, so it
// can never break a dashboard.
(function () {
  "use strict";

  var esc = function (s) {
    return window.escHtml ? window.escHtml(s) : String(s == null ? "" : s)
      .replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
  };
  var T = function (k) { return window.t ? window.t(k) : k; };

  var SHOWN = 12;

  async function load(opts) {
    opts = opts || {};
    var sb = opts.sb;
    var mount = opts.mount;
    var kind = opts.kind || "houses";
    var prof = opts.agentProfile || {};
    var region = prof.region;
    var district = prof.district || null;
    var DR = window.DemandRows;
    var existing = function () { return document.getElementById("agentDemandBoard"); };

    if (!sb || !mount || !region || !DR) {
      var gone = existing(); if (gone) gone.remove();
      return;
    }

    var rows = await DR.fetch({ sb: sb, region: region, district: district, limit: 100 });
    if (!rows.length) {
      var none = existing(); if (none) none.remove();
      return;
    }

    var panel = existing();
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "agentDemandBoard";
      panel.className = "dm-board";
      mount.insertBefore(panel, mount.firstChild);
    }

    var where = district ? esc(district) + " & " + esc(region) : esc(region);
    var urgent = DR.urgentCount(rows);
    var head = T("adb_" + kind + "_head").replace("{n}", rows.length).replace("{where}", where);

    panel.innerHTML =
      '<div class="dm-board__head">' +
        '<h3 class="dm-board__h">' + head + "</h3>" +
        '<button type="button" class="dm-board__x" aria-label="' +
          esc(T("adb_hide")) + '">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
          'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
        "</button>" +
      "</div>" +
      '<p class="dm-board__sub">' +
        (urgent ? "<b>" + esc(T("adb_urgent").replace("{n}", urgent)) + "</b> " : "") +
        esc(T("adb_" + kind + "_sub")) +
      "</p>" +
      DR.html(rows, { limit: SHOWN });

    var x = panel.querySelector(".dm-board__x");
    if (x) x.addEventListener("click", function () { panel.remove(); });
  }

  window.AgentDemandBoard = { load: load };
})();
