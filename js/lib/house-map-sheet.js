// ============================================================================
//  house-map-sheet.js — window.HouseMapSheet
//
//  What a pin on the map opens.
//
//  THE PROBLEM
//  Tapping a marker opened a 260px popup holding a photo, a title, a price,
//  "2 bed · 1 bath · 45 m²", and two buttons: Call and WhatsApp. Everything a
//  person actually decides on was somewhere else. Whether the bathroom is
//  inside the room or down the yard, whether "medium" means a bed fits or a
//  family does, what the rules are, and what is owed on top of the rent — none
//  of it was on the map, and neither was a way to get to the place.
//
//  So the popup asked somebody to ring an agent to find out things that were
//  already in the database.
//
//  WHAT THIS DRAWS, AND WHY IN THIS ORDER
//  A sheet, not a popup, so it has room to answer the questions in the order
//  they are asked:
//
//    1. what it looks like        the photographs
//    2. what it costs             the price, and "From" when it is a from-price
//    3. what you actually get     per space: size band with a plain-words
//                                 clarification, and WHERE THE BATHROOM IS on
//                                 its own line
//    4. what else you owe         extra costs, itemised, with "Included" and
//                                 "Free" said as the facts they are
//    5. what the rules are        the agent's own words, not summarised
//    6. how to get there          Google Maps, already filled in
//
//  THE THINGS IT REFUSES TO GUESS
//  A missing bathroom answer draws "The agent has not said", never "outside".
//  A missing size draws nothing. An unpriced cost says "Ask the agent" and a
//  ZERO cost says "Free", because zero is a fact and one of the better ones a
//  listing can carry (HouseSpec.parseCost owns that distinction).
//
//  It is a renderer. It fetches nothing, owns no map, and knows no page: the
//  caller passes a row and gets a sheet, which is what lets houses.html and
//  anything else with pins on it show the same thing.
//
//  Depends on: house-spec.js (the shape and its catalogue), maps-handoff.js
//  (the directions link), listing-kinds.js and owner-account.js when present.
// ============================================================================
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function t(key, fallback, vars) {
    var s = (window.t && window.t(key)) || fallback;
    if (s === key) s = fallback;
    if (vars) Object.keys(vars).forEach(function (k) {
      s = String(s).replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
    });
    return s;
  }

  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) return "";
    return v.toLocaleString("en-US") + " TZS";
  }

  var ICON = {
    nav:   "M3 11l19-9-9 19-2-8z",
    open:  "M14 3h7v7M21 3l-9 9M20 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5",
    phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z",
    chat:  "M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z",
    close: "M18 6 6 18M6 6l12 12",
    bath:  "M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM7 12V6a2 2 0 0 1 4 0",
    ruler: "M3 15 15 3l6 6L9 21zM7 11l2 2M11 7l2 2",
    rules: "M12 3l8 3v6c0 5-3.4 8.2-8 9-4.6-.8-8-4-8-9V6zM9 12l2 2 4-4",
    bolt:  "M13 2 3 14h9l-1 8 10-12h-9z",
  };

  function ico(d, size) {
    var s = size || 15;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
  }

  // ------------------------------------------------------------------ money
  function priceHtml(h) {
    var HS = window.HouseSpec;
    var from = HS && HS.priceFrom(h) && HS.isRoomByRoom(h);
    var p = Number(h.price_tzs) || 0;
    if (!p) return '<span class="hms-price is-ask">' + esc(t("hms_ask", "Ask the agent")) + "</span>";
    var per = h.listing === "sale" ? "" : (HS && HS.periodLabel(h.period)) || h.period || "month";
    return '<span class="hms-price">' +
      (from ? '<small class="hms-from">' + esc(t("hms_from", "From")) + "</small> " : "") +
      esc(money(p)) + (per ? '<small class="hms-per"> ' + esc(per) + "</small>" : "") + "</span>";
  }

  // ------------------------------------------------------------------ rooms
  /**
   * One priced space, with the two facts this whole file exists to surface.
   *
   * The size band gets its plain-words clarification, and the bathroom gets a
   * LINE OF ITS OWN rather than being one chip among thirty-three. A listing
   * that never said where the bathroom is says so; it does not default to the
   * cheaper-sounding answer, which would be this app deciding a viewing on
   * something the agent never wrote down.
   */
  function roomHtml(r) {
    var HS = window.HouseSpec;
    var size = r.sizeBand ? HS.sizeLabel(r.sizeBand) : "";
    var hint = r.sizeBand ? HS.sizeHint(r.sizeBand) : "";
    var bath = HS.bathroom(r);
    var vacant = r.vacant == null ? null : Number(r.vacant);

    // roomLabel() takes a KIND, not a room, and a room may carry free text the
    // agent typed instead. Their own words win: the catalogue exists to save
    // typing, never to overrule it.
    var name = String(r.label || "").trim() || HS.roomLabel(r.kind);
    // periodLabel() already reads "per month" / "kwa mwezi", so a slash in
    // front of it renders "/ per month".
    var per = HS.periodLabel(r.period) || r.period || "";

    return '<div class="hms-room">' +
      '<div class="hms-room-h">' +
        "<b>" + esc(name) + "</b>" +
        (r.price
          ? '<span class="hms-room-p">' + esc(money(r.price)) +
            (per ? "<small> " + esc(per) + "</small>" : "") + "</span>"
          : '<span class="hms-room-p is-ask">' + esc(t("hms_ask", "Ask the agent")) + "</span>") +
      "</div>" +
      (vacant === 0
        ? '<div class="hms-taken">' + esc(t("hms_taken", "All taken right now")) + "</div>"
        : vacant > 0
        ? '<div class="hms-free">' + esc(t("hms_free_n", "{n} free now", { n: vacant })) + "</div>"
        : "") +
      '<div class="hms-facts">' +
        (size
          ? '<div class="hms-fact">' + ico(ICON.ruler, 14) +
              "<span><b>" + esc(size) + "</b>" +
              (hint ? "<small>" + esc(hint) + "</small>" : "") + "</span></div>"
          : "") +
        '<div class="hms-fact' + (bath ? "" : " is-unsaid") + '">' + ico(ICON.bath, 14) +
          "<span><b>" + esc(bath ? bath.label : t("hms_bath_unsaid", "The agent has not said where the bathroom is")) + "</b>" +
          (bath && bath.key === "inside"
            ? "<small>" + esc(t("hms_bath_inside_d", "You do not share it with the other rooms.")) + "</small>"
            : bath
            ? "<small>" + esc(t("hms_bath_out_d", "You share it with the other rooms on the plot.")) + "</small>"
            : "") +
        "</span></div>" +
      "</div></div>";
  }

  function roomsHtml(h) {
    var HS = window.HouseSpec;
    if (!HS) return "";
    var rooms = HS.fromRow(h).rooms;
    if (!rooms.length) return "";
    return '<section class="hms-sec">' +
      '<h4 class="hms-h">' + esc(t("hms_h_rooms", "What you get")) + "</h4>" +
      rooms.map(roomHtml).join("") +
      // The same sentence the detail sheet shows, for the same reason: a band
      // is a bracket and the photographs are the measurement.
      '<p class="hms-note">' + esc(HS.sizeNote()) + "</p>" +
      "</section>";
  }

  // ------------------------------------------------------------------ costs
  /**
   * What is owed on top of the rent.
   *
   * Zero is a FACT, not a blank. HouseSpec.parseCost is the one place that
   * knows "0", "bure" and "imejumuishwa" all mean the same good news, and
   * rendering that as "Ask the agent" turns the best line in a listing into a
   * phone call.
   */
  function costsHtml(h) {
    var HS = window.HouseSpec;
    var costs = (Array.isArray(h.extra_costs) ? h.extra_costs : []).filter(function (c) {
      return c && c.label;
    });
    if (!costs.length) return "";
    return '<section class="hms-sec">' +
      '<h4 class="hms-h">' + ico(ICON.bolt, 14) + esc(t("hms_h_costs", "On top of the rent")) + "</h4>" +
      '<ul class="hms-costs">' + costs.map(function (c) {
        var b = c.billing || "month";
        var right;
        if (b === "included") right = '<span class="hms-tag is-ok">' + esc(t("hms_incl", "Included in the rent")) + "</span>";
        else if (b === "metered") right = '<span class="hms-tag">' + esc(t("hms_metered", "Pay as you use")) + "</span>";
        else {
          var parsed = HS ? HS.parseCost(c.amount) : null;
          right = !parsed || !parsed.known
            ? '<span class="hms-tag is-ask">' + esc(t("hms_ask", "Ask the agent")) + "</span>"
            : parsed.free
            ? '<span class="hms-tag is-ok">' + esc(HS.freeLabel()) + "</span>"
            : '<span class="hms-amt">' + esc(money(parsed.amount)) +
              (b === "oneoff" ? '<small> ' + esc(t("hms_once", "once")) + "</small>"
                              : '<small> / ' + esc(t("hms_month", "month")) + "</small>") + "</span>";
        }
        return "<li><span>" + esc(c.label) + "</span>" + right + "</li>";
      }).join("") + "</ul></section>";
  }

  // ------------------------------------------------------------------ rules
  /**
   * The rules, in the agent's own words and NOT summarised.
   *
   * On the full detail sheet these live in an accordion with three other
   * groups, of which only the first is open. Here they get their own section
   * and every line is visible, because "no children", "three months up front"
   * and "gate locks at ten" are the sentences that end a viewing, and a person
   * standing on a map deciding whether to travel is entitled to read them
   * before they set off rather than after.
   */
  function rulesHtml(h) {
    var HS = window.HouseSpec;
    if (!HS) return "";
    var groups = HS.fromRow(h).groups.filter(function (g) { return g.key === "rules" && g.items.length; });
    if (!groups.length) return "";
    var items = [];
    groups.forEach(function (g) { items = items.concat(g.items); });
    return '<section class="hms-sec">' +
      '<h4 class="hms-h">' + ico(ICON.rules, 14) + esc(t("hms_h_rules", "Rules and regulations")) + "</h4>" +
      '<ul class="hms-rules">' + items.map(function (it) {
        return "<li><b>" + esc(it.label) + "</b><span>" + esc(it.value) +
          (it.note ? "<small>" + esc(it.note) + "</small>" : "") + "</span></li>";
      }).join("") + "</ul></section>";
  }

  // ---------------------------------------------------------------- actions
  function actionsHtml(h) {
    var dir = window.PawaMaps
      ? window.PawaMaps.directions({ lat: h.lat, lng: h.lng },
                                   { from: window.PawaMaps.knownOrigin(), mode: "car" })
      : "";
    var ph = (h.agent && h.agent.phone) || "";
    var tel = ph.replace(/\s+/g, "");
    var wa = ph.replace(/^\+/, "").replace(/\s+/g, "");
    return '<div class="hms-acts">' +
      (dir
        ? '<a class="hms-b is-go" id="hmsDir" href="' + esc(dir) + '" target="_blank" rel="noopener">' +
            ico(ICON.nav, 15) + esc(t("hms_directions", "Directions in Google Maps")) + "</a>"
        : "") +
      '<a class="hms-b" href="house.html?id=' + encodeURIComponent(h.id) + '">' +
        ico(ICON.open, 15) + esc(t("hms_open", "See the full listing")) + "</a>" +
      (tel ? '<a class="hms-b" href="tel:' + esc(tel) + '">' + ico(ICON.phone, 15) +
               esc(t("hms_call", "Call")) + "</a>" : "") +
      (wa ? '<a class="hms-b" href="https://wa.me/' + esc(wa) + '" target="_blank" rel="noopener">' +
              ico(ICON.chat, 15) + esc(t("hms_wa", "WhatsApp")) + "</a>" : "") +
      "</div>";
  }

  // ------------------------------------------------------------------ shell
  function photosHtml(h) {
    var list = (Array.isArray(h.photos) && h.photos.length) ? h.photos : (h.photo ? [h.photo] : []);
    if (!list.length || !window.DataStore) return "";
    return '<div class="hms-shots">' + list.slice(0, 8).map(function (p) {
      return '<img src="' + esc(window.DataStore.housePhotoUrl(p)) + '" alt="" loading="lazy">';
    }).join("") + "</div>";
  }

  function bodyHtml(h) {
    var where = [h.area, h.region].filter(Boolean).join(", ");
    var byOwner = !!(window.OwnerAccount && window.OwnerAccount.isOwnerListing(h));
    return photosHtml(h) +
      '<div class="hms-head">' +
        "<h3>" + esc(h.title || t("hms_a_place", "A place")) + "</h3>" +
        (where ? '<p class="hms-where">' + esc(where) + "</p>" : "") +
        '<div class="hms-badges">' +
          (h.verified ? '<span class="hms-badge is-ok">' + esc(t("hms_verified", "Verified")) + "</span>" : "") +
          (byOwner ? '<span class="hms-badge">' + esc(t("hms_owner", "Listed by the owner")) + "</span>" : "") +
        "</div>" +
        priceHtml(h) +
      "</div>" +
      actionsHtml(h) +
      roomsHtml(h) +
      costsHtml(h) +
      rulesHtml(h);
  }

  var node = null, onCloseCb = null;

  function ensure() {
    if (node) return node;
    node = document.createElement("div");
    node.className = "hms-back";
    node.id = "hmsBack";
    node.innerHTML =
      '<div class="hms" role="dialog" aria-modal="true" aria-labelledby="hmsTitle" tabindex="-1">' +
        '<button class="hms-x" type="button" aria-label="' + esc(t("hms_close", "Close")) + '">' +
          ico(ICON.close, 18) + "</button>" +
        '<div class="hms-body" id="hmsBody"></div>' +
      "</div>";
    document.body.appendChild(node);
    node.addEventListener("click", function (e) {
      // The backdrop closes it; the sheet does not. A tap that lands on a
      // photograph must never dismiss the thing the photograph is in.
      if (e.target === node || e.target.closest(".hms-x")) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && node && node.classList.contains("is-on")) close();
    });
    return node;
  }

  function open(h, opts) {
    if (!h) return;
    var o = opts || {};
    onCloseCb = o.onClose || null;
    var n = ensure();
    n.querySelector("#hmsBody").innerHTML = bodyHtml(h);
    var head = n.querySelector(".hms-head h3");
    if (head) head.id = "hmsTitle";
    n.classList.add("is-on");
    document.body.classList.add("hms-open");
    // The link is complete already; this only upgrades it once the device
    // answers. Never awaited, never blocking a tap. See maps-handoff.js.
    var dir = n.querySelector("#hmsDir");
    if (dir && window.PawaMaps) {
      window.PawaMaps.bindDirections(dir, { lat: h.lat, lng: h.lng }, { mode: "car" });
    }
    var sheet = n.querySelector(".hms");
    if (sheet) { sheet.scrollTop = 0; try { sheet.focus(); } catch (_) {} }
  }

  function close() {
    if (!node) return;
    node.classList.remove("is-on");
    document.body.classList.remove("hms-open");
    if (onCloseCb) { var cb = onCloseCb; onCloseCb = null; cb(); }
  }

  function isOpen() { return !!(node && node.classList.contains("is-on")); }

  window.HouseMapSheet = {
    open: open, close: close, isOpen: isOpen,
    // Exported for tests and for anything that wants the markup without the
    // sheet around it.
    bodyHtml: bodyHtml, roomHtml: roomHtml, costsHtml: costsHtml, rulesHtml: rulesHtml,
  };
})();
