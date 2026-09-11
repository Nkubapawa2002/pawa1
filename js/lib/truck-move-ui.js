// ============================================================================
//  truck-move-ui.js — window.TruckMoveUI
//
//  The drawing half of the house/truck join. js/lib/truck-match.js works out
//  which lorry suits a move and why; this file turns that answer into the
//  planner and the cards a person reads, and it is shared by all three hosts
//  (house.html, trucks.html, truck.html) so a truck is described the same way
//  wherever it is met.
//
//  IT OWNS NO STATE. Every function takes the move context and returns HTML or
//  wires one element. The three hosts keep their own state because they have
//  genuinely different lives: the house sheet plans ONE move to ONE address,
//  the directory browses every truck with or without a move, and the detail
//  sheet measures a single lorry against whatever plan was carried in.
//
//  EVERY VISIBLE STRING GOES THROUGH T(). The load sizes are the one
//  exception, and they are bilingual inside js/lib/truck-match.js for the
//  reason that file's header gives.
//
//  Styling: css/truck-move.css (.tm-*). Depends at call time on
//  window.TruckMove, and optionally on window.PawaMaps, window.PMReach and
//  window.DataStore; each is guarded, because truck.html and house.html do not
//  load exactly the same set.
// ============================================================================
(function () {
  "use strict";

  // t() with a hard English fallback: a key that has not been added yet must
  // show the English word, never the key name. Same shape as truck.js.
  function T(k, en) {
    var v = window.t ? window.t(k) : k;
    return (v === k && en != null) ? en : v;
  }
  function fill(s, vars) {
    return String(s).replace(/\{(\w+)\}/g, function (m, k) {
      return (vars && k in vars) ? vars[k] : m;
    });
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // --------------------------------------------------------------- the marks
  // Lucide-style stroke SVGs. They inherit currentColor and scale with the
  // type beside them, which is the whole reason this app has no emoji.
  function svg(path, size) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
      (size ? ' width="' + size + '" height="' + size + '"' : "") + ">" + path + "</svg>";
  }
  var ICO = {
    truck: '<path d="M3 16V7a1 1 0 0 1 1-1h9v10M13 9h4l4 4v3h-2"/><circle cx="7" cy="17" r="2"/>' +
           '<circle cx="17" cy="17" r="2"/><path d="M9 17h6"/>',
    pin:   '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
    home:  '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/>',
    box:   '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
    nav:   '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    ask:   '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    user:  '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>' +
           '<path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    scale: '<path d="M12 3v18"/><path d="M5 7h14"/><path d="m5 7-3 6h6z"/><path d="m19 7-3 6h6z"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.1a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7A2 2 0 0 1 22 16.9z"/>',
    chat:  '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l2-4.9A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/>',
    route: '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h5a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h5"/>',
    gps:   '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  };
  function ico(name, size) { return svg(ICO[name] || "", size || 16); }

  // ==========================================================================
  //  SMALL READOUTS
  // ==========================================================================

  /** "from TZS 80k / trip". Never a total: we did not quote this move. */
  function priceHtml(t) {
    var p = Number(t && t.price_tzs) || 0;
    var v;
    if (p >= 1000000) v = (p / 1000000).toFixed(p % 1000000 === 0 ? 0 : 1) + "M";
    else if (p >= 1000) v = Math.round(p / 1000) + "k";
    else v = String(p);
    return '<span class="tm-price">' + esc(T("of_from", "from")) + " TZS " + esc(v) +
      " <small>/ " + esc(T("of_unit_trip", "trip")) + "</small></span>";
  }

  /** Where the lorry sleeps, as one line. */
  function whereText(t) {
    return [t.area, t.district, t.region].filter(Boolean).slice(0, 2).join(", ");
  }

  function photoUrl(t) {
    var p = (t && t.photo) || (t && Array.isArray(t.photos) && t.photos[0]) || "";
    return (p && window.DataStore && window.DataStore.truckPhotoUrl)
      ? window.DataStore.truckPhotoUrl(p) : "";
  }

  // ==========================================================================
  //  THE FIT CHIPS
  //
  //  Each one answers a question the customer would otherwise ask on the
  //  phone, and each says which of three things it is: yes, ask, or nothing
  //  stated. A chip is never drawn for a fact nobody supplied, because an
  //  empty chip reads as a "no".
  // ==========================================================================

  function chip(cls, mark, text) {
    return '<span class="tm-fit' + (cls ? " " + cls : "") + '">' +
      (mark ? ico(mark, 12) : "") + esc(text) + "</span>";
  }

  /** The distance chip: road km and the drive, or the honest absence of both. */
  function distanceChip(row) {
    var TM = window.TruckMove;
    if (!TM) return "";
    if (row._pickupKm != null) {
      var mins = TM.driveMin(row._pickupKm);
      return chip("is-dist is-yes", "nav",
        fill(T("tm_away_min", "{km} away, about {min} min"),
             { km: TM.kmText(row._pickupKm), min: mins }));
    }
    if (row._pickupPending) return chip("is-dist", "", T("tm_measuring", "Measuring the road"));
    if (row._directKm != null) {
      // We know roughly where it is but no road came back. Say so rather than
      // dressing a straight line up as a drive.
      return chip("is-dist", "", T("tm_away_unknown", "Road distance not available"));
    }
    return chip("", "", T("tm_no_pin_truck", "No pin on this truck"));
  }

  function capacityChip(row, ctx) {
    var load = ctx && ctx.load;
    var name = load && window.TruckMove ? window.TruckMove.loadLabel(load) : "";
    if (row._capacity === "fits" && name) {
      return chip("is-yes", "check", fill(T("tm_cap_fits", "Fits {load}"), { load: name }));
    }
    if (row._capacity === "fits") return chip("is-yes", "check", T("tm_cap_ok", "Big enough"));
    // Said plainly, because it is the customer's money: a lorry four times the
    // size of the load will do the job and will be quoted like a lorry four
    // times the size of the load.
    if (row._capacity === "roomy") return chip("", "scale", T("tm_cap_roomy", "Bigger than you need"));
    if (row._capacity === "tight") return chip("is-ask", "ask", T("tm_cap_tight", "Tight for this load"));
    if (row._capacity === "small") return chip("is-ask", "ask", T("tm_cap_small", "Smaller than this load"));
    if (row.capacity_tonnes) {
      return chip("", "scale", fill(T("td_tonnes", "{n} tonnes"), { n: row.capacity_tonnes }));
    }
    return chip("", "scale", T("tm_cap_unknown", "Size not stated"));
  }

  function coverageChip(row) {
    if (row._coverage === "covers") return chip("is-yes", "check", T("tm_cov_yes", "Covers this trip"));
    if (row._coverage === "ask") return chip("is-ask", "ask", T("tm_cov_ask", "Ask about this trip"));
    return chip("is-ask", "ask", T("tm_cov_no", "Further than they usually go"));
  }

  /** The whole row of chips, superlatives first because they are the headline. */
  function fitsHtml(row, ctx) {
    var out = [];
    if (row._closest && !row._best) out.push(chip("is-gold", "nav", T("tm_closest", "Closest to you")));
    if (row._cheapest) out.push(chip("is-gold", "", T("tm_cheapest", "Cheapest here")));
    if (row._biggest) out.push(chip("is-gold", "scale", T("tm_biggest", "Biggest here")));
    out.push(distanceChip(row));
    out.push(capacityChip(row, ctx));
    out.push(coverageChip(row));
    if (row.driver_included) out.push(chip("is-yes", "user", T("tm_driver", "Driver included")));
    if (row.loaders_included) out.push(chip("is-yes", "users", T("tm_loaders", "Loaders included")));
    if (row.verified) out.push(chip("is-yes", "shield", T("of_verified", "Verified")));
    return '<div class="tm-fits">' + out.filter(Boolean).join("") + "</div>";
  }

  // ==========================================================================
  //  THE ACTIONS
  //
  //  The Google Maps link is FIRST and is never a promise we cannot keep: it
  //  is built from what we already hold and carries the whole move, base to
  //  pickup to new home, so nobody types an address that is already on screen.
  //  js/lib/maps-handoff.js explains why it is never awaited.
  // ==========================================================================

  /** The prefilled WhatsApp text: who, what, how far. */
  function waHref(row, ctx) {
    var n = String((row.owner && (row.owner.whatsapp || row.owner.phone)) || "")
      .replace(/[^\d]/g, "");
    if (!n) return "";
    var TM = window.TruckMove;
    var load = ctx && ctx.load && TM ? TM.loadLabel(ctx.load) : "";
    var trip = ctx && ctx.tripKm != null && TM ? TM.kmText(ctx.tripKm) : "";
    var msg;
    if (load && trip) {
      msg = fill(T("tm_wa_full", "Hello, I saw your truck \"{title}\" on Pawa. I am moving {load}, about {km} by road. Is it free?"),
                 { title: row.title || T("td_truck", "Moving truck"), load: load, km: trip });
    } else if (load) {
      msg = fill(T("tm_wa_load", "Hello, I saw your truck \"{title}\" on Pawa. I am moving {load}. Is it free?"),
                 { title: row.title || T("td_truck", "Moving truck"), load: load });
    } else {
      msg = fill(T("td_wa_text", "Hello, I saw your truck \"{title}\" on Pawa. Is it free to help me move?"),
                 { title: row.title || T("td_truck", "Moving truck") });
    }
    return "https://wa.me/" + n + "?text=" + encodeURIComponent(msg);
  }

  /**
   * The Google Maps link for this truck and this move.
   *
   * With a destination it is the move: base, pickup, new home. Without one it
   * is simply the way to the lorry. Either way every box Google would ask
   * about is already filled.
   */
  function mapsHref(row, ctx) {
    if (!window.PawaMaps) return "";
    var TM = window.TruckMove;
    var base = (TM && TM.usable(row)) ? { lat: Number(row.lat), lng: Number(row.lng) } : null;
    var c = ctx || {};
    if (c.to && TM && TM.usable(c.to)) {
      return window.PawaMaps.move({ truck: base, from: c.from, to: c.to });
    }
    if (base) {
      return window.PawaMaps.directions(base, {
        from: c.from || window.PawaMaps.knownOrigin(), mode: "car",
      });
    }
    return "";
  }

  function actsHtml(row, ctx, extra) {
    var phone = (row.owner && (row.owner.phone || row.owner.whatsapp)) || row.phone || "";
    var maps = mapsHref(row, ctx);
    var wa = waHref(row, ctx);
    var out = [];
    if (maps) {
      out.push('<a class="tm-act tm-act--map" href="' + esc(maps) + '" target="_blank" rel="noopener"' +
        ' data-tm-maps="' + esc(row.id) + '">' + ico("nav", 14) + "<span>" +
        esc(ctx && ctx.to ? T("tm_act_route", "Route in Google Maps")
                          : T("tm_act_dir", "Directions in Google Maps")) + "</span></a>");
    }
    if (window.PMReach) {
      var b = window.PMReach.button(row, {
        className: "tm-act tm-act--msg", sub: false, icon: false,
        label: T("pm_reach", "Message"),
      });
      if (b) out.push(b.replace("<span>", ico("chat", 14) + "<span>"));
    }
    if (phone) {
      out.push('<a class="tm-act tm-act--call" href="tel:' + esc(String(phone).replace(/[^\d+]/g, "")) +
        '">' + ico("phone", 14) + "<span>" + esc(T("of_call", "Call")) + "</span></a>");
    }
    if (wa) {
      out.push('<a class="tm-act tm-act--wa" href="' + esc(wa) + '" target="_blank" rel="noopener">' +
        ico("chat", 14) + "<span>WhatsApp</span></a>");
    }
    // The host's own action, if it has one. The directory adds "show it on
    // this map", which only means anything on a page that has a map.
    if (extra) out.push(extra);
    return out.length ? '<div class="tm-acts">' + out.join("") + "</div>" : "";
  }

  // ==========================================================================
  //  THE CARD
  // ==========================================================================

  /**
   * One truck, measured against one move.
   *
   * @param {object} row  a row as TruckMove.rank() returns it
   * @param {object} ctx  the move context
   * @param {object} opts opts.best draws the recommendation crown; opts.href
   *                      overrides the link (the detail sheet carries the plan)
   */
  function cardHtml(row, ctx, opts) {
    var o = opts || {};
    var img = photoUrl(row);
    var where = whereText(row);
    var href = o.href || ("truck.html?id=" + encodeURIComponent(row.id) +
      (ctx && window.TruckMove ? (function () {
        var q = window.TruckMove.encode(ctx);
        return q ? "&" + q : "";
      })() : ""));
    var best = o.best && row._best;
    return '<article class="tm-card' + (best ? " is-best" : "") +
      (row._pickupPending ? " is-pending" : "") + '">' +
      (best ? '<span class="tm-card__crown">' + ico("check", 12) +
              esc(T("tm_best", "Best match")) + "</span>" : "") +
      '<a class="tm-card__photo" href="' + esc(href) + '"' +
        (img ? ' style="background-image:url(\'' + esc(img) + '\')"' : "") +
        ' aria-label="' + esc(row.title || T("td_truck", "Moving truck")) + '">' +
        (img ? "" : ico("truck", 28)) + "</a>" +
      '<div class="tm-card__body">' +
        '<div class="tm-card__top">' +
          '<a class="tm-card__title" href="' + esc(href) + '">' +
            esc(row.title || T("td_truck", "Moving truck")) + "</a>" +
          priceHtml(row) +
        "</div>" +
        (where ? '<p class="tm-card__where">' + esc(where) + "</p>" : "") +
        fitsHtml(row, ctx) +
        actsHtml(row, ctx, o.extra) +
      "</div></article>";
  }

  /** The whole ranked list, with the top row crowned. */
  function listHtml(rows, ctx, opts) {
    var o = opts || {};
    if (!rows || !rows.length) {
      return '<div class="tm-empty">' + esc(T("tm_empty", "No truck matches this move yet.")) +
        ' <a href="trucks.html">' + esc(T("tm_empty_cta", "See every truck")) + "</a></div>";
    }
    var limit = o.limit || rows.length;
    return '<div class="tm-list">' +
      rows.slice(0, limit).map(function (r, i) {
        return cardHtml(r, ctx, {
          best: i === 0 && o.crown !== false,
          extra: typeof o.extra === "function" ? o.extra(r) : o.extra,
        });
      }).join("") + "</div>";
  }

  // ==========================================================================
  //  THE PLANNER
  // ==========================================================================

  /** The load-size chips. */
  function loadsHtml(selected) {
    var TM = window.TruckMove;
    if (!TM) return "";
    return '<div class="tm-loads" role="group" aria-label="' +
      esc(T("tm_load_q", "What are you moving?")) + '">' +
      TM.LOADS.map(function (l) {
        return '<button type="button" class="tm-load" data-tm-load="' + esc(l.key) + '"' +
          ' aria-pressed="' + (l.key === selected ? "true" : "false") + '">' +
          esc(TM.loadLabel(l.key)) + "</button>";
      }).join("") + "</div>";
  }

  /** One leg of the move: the icon, the label, the value and the control. */
  function legHtml(o) {
    return '<div class="tm-leg">' +
      '<span class="tm-leg__ic">' + ico(o.icon, 18) + "</span>" +
      '<span class="tm-leg__tx">' +
        '<span class="tm-leg__k">' + esc(o.label) + "</span>" +
        '<span class="tm-leg__v' + (o.empty ? " is-empty" : "") + '"' +
          (o.id ? ' id="' + esc(o.id) + '"' : "") + ">" + esc(o.value) + "</span>" +
      "</span>" +
      (o.action
        ? '<button type="button" class="tm-leg__act"' +
          (o.actionId ? ' id="' + esc(o.actionId) + '"' : "") + ">" + esc(o.action) + "</button>"
        : "") +
      "</div>";
  }

  window.TruckMoveUI = {
    T: T, fill: fill, esc: esc, ico: ico, ICO: ICO,
    priceHtml: priceHtml,
    whereText: whereText,
    photoUrl: photoUrl,
    chip: chip,
    fitsHtml: fitsHtml,
    actsHtml: actsHtml,
    mapsHref: mapsHref,
    waHref: waHref,
    cardHtml: cardHtml,
    listHtml: listHtml,
    loadsHtml: loadsHtml,
    legHtml: legHtml,
  };
})();
