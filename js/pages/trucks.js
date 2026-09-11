// ============================================================================
//  trucks.js — the moving-trucks directory (trucks.html)
//
//  WHAT THIS SCREEN IS NOW
//  It used to be a list of lorries with four filters on top, and it answered
//  exactly one question: "what trucks exist?". The question people actually
//  arrive with is "who can move my things from here to there, and what will it
//  cost me" — and after this pass the page is built around that:
//
//    plan      what you are moving, where it is now, where it is going
//    filters   everything an owner can say about a lorry, as something you can
//              filter on: the body, the crew, the kit, the trip, the paperwork
//    results   every truck measured against YOUR move, best match first, each
//              one saying why it is ranked where it is
//    map       your pickup, your destination, the lorries, and the road
//
//  ARRIVING FROM A PROPERTY
//  house.html now carries the same planner (js/lib/truck-move-panel.js) and
//  hands the whole plan over in the query string. Somebody who pressed "find
//  a truck" on a listing lands here with the destination, the load size and
//  their own position already filled in, and a ranked list already on screen.
//  Nothing is asked twice. js/lib/truck-match.js `encode`/`decode` own that
//  format so neither page can drift from it.
//
//  WHERE THE WORK LIVES
//    js/lib/truck-match.js    the ranking, the distances, the coverage read
//    js/lib/truck-move-ui.js  the planner legs, the load chips, the card
//    js/lib/offer-spec.js     the vocabulary the filters and the form share
//    js/lib/maps-handoff.js   the Google Maps link, origin and stop filled in
//    css/trucks-page.css      this page's frame; css/truck-move.css the cards
//
//  GOOGLE MAPS IS THE NAVIGATOR. The route drawn on the Leaflet map below is
//  the PROOF of a distance, and it is measured by our own routing engines. The
//  moment somebody actually wants to drive it they get a Google Maps link with
//  the origin, the stop and the destination already in it. See the rule at the
//  top of js/lib/maps-handoff.js for why that link is never built after an
//  await.
// ============================================================================

(function () {
  "use strict";

  var UI, TM;   // window.TruckMoveUI / window.TruckMove, resolved in init()

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
  function $(id) { return document.getElementById(id); }

  /**
   * A design-system colour, read from the page rather than written here.
   *
   * Leaflet takes colours as strings, so a route line cannot be a var() in a
   * stylesheet. Reading the token off the body at draw time is the next best
   * thing: the lines follow a brand change like everything else, and there is
   * no hex in this file to go stale. The fallback is only ever reached if the
   * token sheet did not load, in which case the map is the least of it.
   */
  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.body).getPropertyValue(name).trim();
      return v || fallback;
    } catch (_) { return fallback; }
  }

  // ==========================================================================
  //  STATE
  // ==========================================================================

  var trucks = [];          // everything the catalogue returned
  var rows = [];            // what is on screen, ranked
  var ctx = null;           // the move: from, to, load, tripKm, roadKm
  var sortMode = "best";

  var filters = {
    type: "", capacity: "", service: "", area: "", q: "", priceMax: 0,
    flags: {},              // driver / loaders / verified / photo / negotiable
    specs: {},              // keys from js/lib/offer-spec.js TRUCK
  };

  var map = null, markers = new Map(), userMarker = null, toMarker = null;
  var routeLayer = null, tripLayer = null;
  var measuring = false;

  // DOM, filled in init()
  var listEl, mapEl, countEl, stageEl, legsEl, loadsEl, tripEl, planMsgEl, specEl;

  // ==========================================================================
  //  THE PLAN
  // ==========================================================================

  function paintLegs() {
    if (!legsEl) return;
    var fromKnown = !!(ctx.from && TM.usable(ctx.from));
    var toKnown = !!(ctx.to && TM.usable(ctx.to));
    legsEl.innerHTML =
      UI.legHtml({
        icon: "gps",
        label: T("tm_leg_from", "Your things are in"),
        value: fromKnown ? (ctx.fromLabel || T("tm_from_here", "Where you are now"))
                         : T("tm_from_unknown", "Not set yet"),
        empty: !fromKnown,
        id: "tkFromValue",
        action: fromKnown ? T("tm_change", "Change") : T("tm_use_gps", "Use my location"),
        actionId: "tkFromBtn",
      }) +
      UI.legHtml({
        icon: "home",
        label: T("tm_leg_to", "Moving to"),
        value: toKnown ? (ctx.toLabel || T("tm_to_pin", "The place you picked"))
                       : T("tm_to_unknown", "Not set yet"),
        empty: !toKnown,
        id: "tkToValue",
        action: T("tm_type", "Type it"),
        actionId: "tkToBtn",
      }) +
      '<div class="tm-where" id="tkWhere" hidden>' +
        '<input type="text" id="tkWhereInput" autocomplete="off" placeholder="' +
          esc(T("tm_where_ph", "A town, ward or area, anywhere in Tanzania")) + '" />' +
        '<button type="button" id="tkWhereGo">' + esc(T("tm_where_go", "Use this")) + "</button>" +
      "</div>";

    $("tkFromBtn").addEventListener("click", function () { locate(true); });
    $("tkToBtn").addEventListener("click", function () { openWhere("to"); });
    $("tkWhereGo").addEventListener("click", resolveWhere);
    $("tkWhereInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); resolveWhere(); }
    });
  }

  var whereTarget = "to";
  function openWhere(which) {
    whereTarget = which;
    var box = $("tkWhere");
    if (!box) return;
    box.hidden = false;
    $("tkWhereInput").focus();
  }

  /**
   * Turn a typed place into a point.
   *
   * pawaGeo.suggest() matches our own gazetteer first and only then asks the
   * geocoder, which is why a ward somebody typed from memory resolves without
   * a round trip. Its top row is the answer; we do not draw a picker here,
   * because the plan is re-editable and a wrong pin costs one more tap.
   */
  async function resolveWhere() {
    var input = $("tkWhereInput");
    var q = (input.value || "").trim();
    if (q.length < 2 || !window.pawaGeo) return;
    say(T("tm_looking", "Looking that place up."));
    try {
      var hits = await window.pawaGeo.suggest(q, { limit: 5, near: ctx.to || ctx.from });
      var hit = (hits || []).find(function (h) { return TM.usable(h); });
      if (!hit) { say(T("tm_where_miss", "We could not find that place. Try the ward or the town."), true); return; }
      var p = { lat: Number(hit.lat), lng: Number(hit.lng) };
      var label = [hit.name, hit.context].filter(Boolean).join(", ");
      if (whereTarget === "to") { ctx.to = p; ctx.toLabel = label; ctx.toRegion = hit.region || ctx.toRegion; }
      else { ctx.from = p; ctx.fromLabel = label; }
      $("tkWhere").hidden = true;
      input.value = "";
      say("");
      paintLegs();
      render();
      measureTrip();
      measurePickups();
    } catch (_) {
      say(T("tm_where_miss", "We could not find that place. Try the ward or the town."), true);
    }
  }

  function paintLoads() {
    if (!loadsEl) return;
    loadsEl.innerHTML = UI.loadsHtml(ctx.load);
  }

  function say(text, warn) {
    if (!planMsgEl) return;
    planMsgEl.hidden = !text;
    planMsgEl.textContent = text || "";
    planMsgEl.classList.toggle("is-warn", !!warn);
  }

  function paintTrip() {
    if (!tripEl) return;
    if (ctx.tripKm == null) { tripEl.hidden = true; return; }
    tripEl.hidden = false;
    tripEl.innerHTML =
      '<span class="tm-trip__n">' + esc(TM.kmText(ctx.tripKm)) + "</span>" +
      "<span>" + esc(fill(T("tm_trip", "by road from where you are, about {min} minutes of driving"),
                          { min: TM.driveMin(ctx.tripKm) })) + "</span>" +
      '<span class="tm-trip__note">' +
        esc(T("tm_trip_note", "The owner quotes the price. This is the distance they will be quoting for.")) +
      "</span>";
  }

  // ==========================================================================
  //  THE FILTERS
  // ==========================================================================

  /**
   * The spec chips, built from the same catalogue the listing form writes.
   *
   * js/lib/offer-spec.js is the single vocabulary: an owner ticks "Tarpaulin
   * over the load" there and a customer filters on the same words here. A
   * second, private list of filter words is how a directory ends up unable to
   * find the thing an agent just listed.
   */
  function buildSpecFilters() {
    if (!specEl || !window.TruckSpec) return;
    var say_ = window.OfferSpec ? window.OfferSpec.say : function (p) { return p && (p.en || p); };
    specEl.innerHTML = window.TruckSpec.GROUPS.map(function (g) {
      return '<div class="tk-group"><p class="tk-group__h">' + esc(say_(g.title)) + "</p>" +
        '<div class="tk-toggles">' + g.items.map(function (it) {
          return '<button type="button" class="tk-toggle" data-tk-spec="' + esc(it.key) +
            '" aria-pressed="false">' + esc(say_(it)) + "</button>";
        }).join("") + "</div></div>";
    }).join("");
  }

  /** One delegated handler for every pill on the page. */
  function wireToggles(root, attr, bag) {
    if (!root) return;
    root.addEventListener("click", function (e) {
      var b = e.target.closest("[" + attr + "]");
      if (!b) return;
      var key = b.getAttribute(attr);
      var on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      if (on) bag[key] = true; else delete bag[key];
      render();
    });
  }

  function kitOf(t) {
    return (t && t.details && Array.isArray(t.details.kit)) ? t.details.kit : [];
  }

  function matchesFilters(t) {
    if (filters.type && t.truck_type !== filters.type) return false;
    if (filters.service && t.service_area !== filters.service) return false;
    if (filters.capacity && !(parseFloat(t.capacity_tonnes) >= parseFloat(filters.capacity))) return false;
    if (filters.priceMax && Number(t.price_tzs) > filters.priceMax) return false;

    if (filters.flags.driver && !t.driver_included) return false;
    if (filters.flags.loaders && !t.loaders_included) return false;
    if (filters.flags.verified && !t.verified) return false;
    if (filters.flags.negotiable && !t.negotiable) return false;
    if (filters.flags.photo && !(t.photo || (Array.isArray(t.photos) && t.photos.length))) return false;

    var wanted = Object.keys(filters.specs);
    if (wanted.length) {
      var kit = kitOf(t);
      // Every chosen characteristic must be present. "Any of them" would let a
      // truck with a tarpaulin answer a search for a tail lift, which is the
      // kind of result that teaches people the filters do not work.
      for (var i = 0; i < wanted.length; i++) {
        if (kit.indexOf(wanted[i]) < 0) {
          // driver and loaders live in their own columns as well as in the
          // characteristics list. The form writes both; an older row may carry
          // only the column.
          if (wanted[i] === "driver" && t.driver_included) continue;
          if (wanted[i] === "loaders" && t.loaders_included) continue;
          return false;
        }
      }
    }

    if (filters.area) {
      var fields = [t.area, t.address, t.region, t.district, t.ward];
      if (!fields.some(function (v) { return String(v || "").toLowerCase().includes(filters.area); })) return false;
    }
    if (filters.q) {
      var hay = [t.title, t.area, t.region, t.district, t.ward, t.address,
                 t.description, t.owner && t.owner.name].join(" ").toLowerCase();
      if (!hay.includes(filters.q)) return false;
    }
    return true;
  }

  function readFilters() {
    filters.type = $("filterType").value;
    filters.service = $("filterService").value;
    filters.capacity = $("filterCapacity").value;
    filters.area = $("filterArea").value.trim().toLowerCase();
    filters.q = $("filterSearch").value.trim().toLowerCase();
    filters.priceMax = parseInt($("filterPrice").value, 10) || 0;
  }

  function resetFilters() {
    ["filterType", "filterService", "filterCapacity", "filterArea", "filterSearch", "filterPrice"]
      .forEach(function (id) { $(id).value = ""; });
    filters.flags = {};
    filters.specs = {};
    document.querySelectorAll("[data-tk-flag],[data-tk-spec]").forEach(function (b) {
      b.setAttribute("aria-pressed", "false");
    });
    readFilters();
    render();
  }

  // ==========================================================================
  //  RENDER
  // ==========================================================================

  function sortRows(list) {
    var kmOf = function (t) {
      return t._pickupKm != null ? t._pickupKm
           : (t._directKm != null ? t._directKm : Infinity);
    };
    if (sortMode === "nearest") return list.slice().sort(function (a, b) { return kmOf(a) - kmOf(b); });
    if (sortMode === "cheapest") return list.slice().sort(function (a, b) {
      return (Number(a.price_tzs) || 1e15) - (Number(b.price_tzs) || 1e15);
    });
    if (sortMode === "biggest") return list.slice().sort(function (a, b) {
      return (Number(b.capacity_tonnes) || 0) - (Number(a.capacity_tonnes) || 0);
    });
    if (sortMode === "newest") {
      // The order DataStore returns is created_at desc, so rebuild it by
      // walking the original array rather than by re-reading a timestamp the
      // JSON fallback does not always carry.
      var order = new Map();
      trucks.forEach(function (t, i) { order.set(t.id, i); });
      return list.slice().sort(function (a, b) {
        return (order.get(a.id) || 0) - (order.get(b.id) || 0);
      });
    }
    return list;   // "best": the order TruckMove.rank() already put them in
  }

  function countText(n) {
    if (!n) return "";
    var word = fill(T(n === 1 ? "tk_n_one" : "tk_n_many", n === 1 ? "{n} truck" : "{n} trucks"), { n: n });
    if (sortMode === "best" && (ctx.from || ctx.load)) {
      return word + ". " + T("tk_n_best", "Best match for your move is first.");
    }
    if (sortMode === "nearest" && ctx.from) {
      return word + ". " + T("tk_n_near", "Nearest to you is first.");
    }
    return word + ".";
  }

  function render() {
    if (!listEl) return;
    var kept = trucks.filter(matchesFilters);
    rows = sortRows(TM.rank(kept, ctx));
    countEl.textContent = countText(rows.length);
    renderList();
    renderMarkers();
  }

  function renderList() {
    listEl.removeAttribute("aria-busy");
    if (!rows.length) {
      listEl.innerHTML =
        '<div class="tm-empty">' + esc(T("tk_empty", "No trucks match your filters yet. Try widening the area or coverage, or")) +
        ' <a href="agent-trucks.html">' + esc(T("tk_empty_cta", "list your own truck")) + "</a>.</div>";
      return;
    }
    listEl.innerHTML = UI.listHtml(rows, ctx, {
      // The crown is a claim about a MOVE. With no plan at all it would be a
      // claim about nothing, so it is only drawn once the reader has said
      // something about what they are moving or where they are.
      crown: sortMode === "best" && !!(ctx.from || ctx.to || ctx.load),
      extra: function (r) {
        if (!TM.usable(r)) return "";
        return '<button type="button" class="tm-act" data-tk-map="' + esc(r.id) + '">' +
          UI.ico("route", 14) + "<span>" + esc(T("tk_show_map", "Show on this map")) + "</span></button>";
      },
    });
  }

  // ==========================================================================
  //  THE MAP
  // ==========================================================================

  function initMap() {
    if (!window.L || !mapEl) return;
    map = L.map(mapEl, { scrollWheelZoom: true }).setView([-6.4, 35.0], 6);  // Tanzania
    if (window.addSatelliteHybrid) window.addSatelliteHybrid(map);
  }

  function renderMarkers() {
    if (!map) return;
    markers.forEach(function (m) { map.removeLayer(m); });
    markers.clear();
    var pts = [];

    rows.forEach(function (t) {
      if (!TM.usable(t)) return;
      var lat = Number(t.lat), lng = Number(t.lng);
      var m = L.marker([lat, lng]).addTo(map);
      m.bindPopup(popupHtml(t));
      markers.set(t.id, m);
      pts.push([lat, lng]);
    });

    if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
    if (ctx.from && TM.usable(ctx.from)) {
      var green = cssVar("--c-brand", "#10b981");
      userMarker = L.circleMarker([ctx.from.lat, ctx.from.lng], {
        radius: 9, color: green, fillColor: green, fillOpacity: .9, weight: 2,
      }).addTo(map).bindPopup(esc(T("tk_leg_you", "Where you are")));
      pts.push([ctx.from.lat, ctx.from.lng]);
    }

    if (toMarker) { map.removeLayer(toMarker); toMarker = null; }
    if (ctx.to && TM.usable(ctx.to)) {
      var gold = cssVar("--c-accent", "#fcd116");
      toMarker = L.circleMarker([ctx.to.lat, ctx.to.lng], {
        radius: 9, color: gold, fillColor: gold, fillOpacity: .9, weight: 2,
      }).addTo(map).bindPopup(esc(ctx.toLabel || T("tk_leg_to", "Where it is going")));
      pts.push([ctx.to.lat, ctx.to.lng]);
    }

    if (pts.length) {
      try { map.fitBounds(pts, { padding: [40, 40], maxZoom: 13 }); } catch (_) {}
    }
  }

  /**
   * The pin's own card.
   *
   * It carries the Google Maps link too, because a map pin is exactly where
   * somebody decides to actually go, and making them scroll back to the list
   * to find the link would be the old "type the address again" problem in a
   * new place.
   */
  function popupHtml(t) {
    var maps = UI.mapsHref(t, ctx);
    var dist = t._pickupKm != null
      ? fill(T("tm_away_min", "{km} away, about {min} min"),
             { km: TM.kmText(t._pickupKm), min: TM.driveMin(t._pickupKm) })
      : "";
    return "<strong>" + esc(t.title || T("td_truck", "Moving truck")) + "</strong><br>" +
      (dist ? esc(dist) + "<br>" : "") +
      (maps ? '<a href="' + esc(maps) + '" target="_blank" rel="noopener">' +
        esc(ctx.to ? T("tm_act_route", "Route in Google Maps") : T("tm_act_dir", "Directions in Google Maps")) +
        "</a><br>" : "") +
      '<a href="truck.html?id=' + encodeURIComponent(t.id) +
        (TM.encode(ctx) ? "&" + TM.encode(ctx) : "") + '">' +
        esc(T("tk_open", "Open this truck")) + "</a>";
  }

  /**
   * Draw the real road from the pickup to one lorry.
   *
   * This is the PROOF of the number on the card, not the way anybody drives
   * it: the Google Maps button beside it is that. When the engines know more
   * than one road, all of them are drawn and the reader taps the one they
   * would take; the chosen one goes solid and its km replaces the estimate.
   */
  async function drawRouteTo(t) {
    if (!map || !window.pawaRoute || !TM.usable(t)) return;
    var origin = ctx.from;
    if (!origin) { origin = await locate(true); if (!origin) return; }
    switchView("map");
    setTimeout(function () { map.invalidateSize(); }, 80);

    var r = await window.pawaRoute.route(origin, { lat: Number(t.lat), lng: Number(t.lng) });
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    if (!r || !r.geojson) {
      var mk = markers.get(t.id);
      if (mk) {
        mk.bindPopup("<strong>" + esc(t.title || T("td_truck", "Moving truck")) + "</strong><br><small>" +
          esc(T("tk_route_fail", "We could not measure that road just now. Please try again.")) +
          "</small>").openPopup();
      }
      return;
    }
    var options = [{ km: r.km, durationMin: r.durationMin, geojson: r.geojson, via: r.via }]
      .concat((r.alts || []).filter(function (a) { return a && a.geojson; }));

    if (!(ctx.roadKm instanceof Map)) ctx.roadKm = new Map();
    ctx.roadKm.set(t.id, options[0].km);
    render();

    routeLayer = L.layerGroup().addTo(map);
    var chosen = cssVar("--c-brand", "#10b981");
    var other = cssVar("--c-text-muted", cssVar("--c-muted", "#8a9c92"));
    var lines = [];
    var styleFor = function (isChosen) {
      return isChosen
        ? { color: chosen, weight: 6, opacity: .95, dashArray: null }
        : { color: other, weight: 4, opacity: .75, dashArray: "7 7" };
    };
    var popupFor = function (o, i) {
      return "<strong>" + esc(t.title || T("td_truck", "Moving truck")) + "</strong><br>" +
        (options.length > 1
          ? esc(fill(T("tk_road_n", "Road {i} of {n}"), { i: i + 1, n: options.length })) + "<br>"
          : "") +
        esc(fill(T("tk_road_len", "{km} by road, {min} minutes of driving"),
                 { km: TM.kmText(o.km), min: Math.round(o.durationMin) })) +
        (options.length > 1
          ? "<br><small>" + esc(T("tk_road_pick", "Tap another line to choose that road.")) + "</small>"
          : "");
    };
    // A white casing under every line first, so a coloured road stays visible
    // on the dark satellite tiles, which otherwise swallow it.
    options.forEach(function (o) {
      L.geoJSON(o.geojson, { interactive: false, style: { color: "#ffffff", weight: 9, opacity: .9 } })
        .addTo(routeLayer);
    });
    options.forEach(function (o, i) {
      var ln = L.geoJSON(o.geojson, { style: styleFor(i === 0) }).addTo(routeLayer);
      ln.bindPopup(popupFor(o, i));
      ln.on("click", function () {
        lines.forEach(function (x, j) { x.setStyle(styleFor(j === i)); });
        ln.bringToFront();
        ctx.roadKm.set(t.id, options[i].km);
        renderList();
      });
      lines.push(ln);
    });
    lines[0].bringToFront();
    try { map.fitBounds(L.featureGroup(lines).getBounds(), { padding: [46, 46] }); } catch (_) {}
    lines[0].openPopup();
  }

  /** The move itself, drawn once, as a dashed gold line under everything. */
  async function drawTrip() {
    if (!map || !window.pawaRoute || !ctx.from || !ctx.to) return;
    try {
      var r = await window.pawaRoute.route(ctx.from, ctx.to);
      if (!r || !r.geojson) return;
      if (tripLayer) { map.removeLayer(tripLayer); }
      tripLayer = L.geoJSON(r.geojson, {
        interactive: false,
        style: { color: cssVar("--c-accent", "#fcd116"), weight: 4, opacity: .8, dashArray: "3 8" },
      }).addTo(map);
    } catch (_) { /* the readout above the map already says we could not. */ }
  }

  // ==========================================================================
  //  MEASUREMENT
  // ==========================================================================

  async function locate(loud) {
    if (!window.pawaLocate) return null;
    var btn = $("truckNearMeBtn");
    if (btn) btn.disabled = true;
    say(T("tm_locating", "Getting your location."));
    try {
      var fix = await window.pawaLocate.bestOrApprox({ targetAccuracy: 50, maxWaitMs: 12000 });
      ctx.from = { lat: fix.lat, lng: fix.lng };
      ctx.fromLabel = fix.approximate
        ? T("tm_from_approx", "Near you, roughly")
        : T("tm_from_here", "Where you are now");
      say("");
      paintLegs();
      if (sortMode === "best" || sortMode === "nearest") render();
      measurePickups();
      measureTrip();
      return ctx.from;
    } catch (e) {
      if (loud) {
        say((e && e.message) || T("tm_gps_fail",
          "We could not get your location. The trucks below are still ranked by size and coverage."), true);
      } else { say(""); }
      return null;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /** Real road km from the pickup to the lorries actually on screen. */
  async function measurePickups() {
    if (!ctx.from || measuring || !rows.length) return;
    measuring = true;
    try {
      var head = rows.slice(0, 40);
      var got = await TM.pickupKm(head, ctx.from);
      if (!(ctx.roadKm instanceof Map)) ctx.roadKm = new Map();
      got.forEach(function (v, k) { ctx.roadKm.set(k, v); });
      render();
    } finally { measuring = false; }
  }

  async function measureTrip() {
    if (!ctx.from || !ctx.to) { ctx.tripKm = null; paintTrip(); return; }
    ctx.tripKm = await TM.roadKm(ctx.from, ctx.to);
    paintTrip();
    renderList();     // the WhatsApp text carries the trip length
    drawTrip();
  }

  // ==========================================================================
  //  WIRING
  // ==========================================================================

  function switchView(view) {
    stageEl.dataset.view = view;
    $("tabList").classList.toggle("active", view === "list");
    $("tabMap").classList.toggle("active", view === "map");
  }

  function fillAreaDatalist() {
    var list = $("filterAreaList");
    var areas = Array.from(new Set(
      trucks.reduce(function (acc, t) {
        return acc.concat([t.region, t.district, t.ward, t.area]);
      }, []).filter(Boolean)
    )).sort();
    list.innerHTML = areas.map(function (a) { return '<option value="' + esc(a) + '"></option>'; }).join("");
  }

  var debTimer = null;
  function debounced(fn) { clearTimeout(debTimer); debTimer = setTimeout(fn, 180); }

  async function init() {
    UI = window.TruckMoveUI;
    TM = window.TruckMove;
    if (!UI || !TM) return;   // the two libraries are this page's floor

    listEl = $("trucksList"); mapEl = $("trucksMap"); countEl = $("trucksCount");
    stageEl = $("trucksStage"); legsEl = $("tkLegs"); loadsEl = $("tkLoads");
    tripEl = $("tkTrip"); planMsgEl = $("tkPlanMsg"); specEl = $("tkSpecGroups");

    // The plan, as it arrived. A person who pressed "find a truck" on a
    // property sheet has already answered all of this.
    ctx = TM.decode(location.search);
    ctx.roadKm = new Map();

    // "How do you want to find a truck? Near me, or a specific area." A good
    // question to open a directory with, and a contradiction to put in front of
    // somebody who answered both halves on the previous screen. js/lib/
    // find-mode.js reveals that block on DOMContentLoaded, which has not fired
    // yet while this runs, so removing the node now is enough: it never looks
    // for it again.
    if (ctx.from || ctx.to) {
      const fm = $("fmTrucks");
      if (fm) fm.remove();
    }

    initMap();
    paintLoads();
    paintLegs();
    buildSpecFilters();

    loadsEl.addEventListener("click", function (e) {
      var b = e.target.closest("[data-tm-load]");
      if (!b) return;
      ctx.load = ctx.load === b.dataset.tmLoad ? null : b.dataset.tmLoad;
      paintLoads();
      render();
    });

    ["filterType", "filterService", "filterCapacity"].forEach(function (id) {
      $(id).addEventListener("change", function () { readFilters(); render(); });
    });
    ["filterArea", "filterSearch", "filterPrice"].forEach(function (id) {
      $(id).addEventListener("input", function () { debounced(function () { readFilters(); render(); }); });
    });
    wireToggles(document.querySelector(".tk-toggles"), "data-tk-flag", filters.flags);
    wireToggles(specEl, "data-tk-spec", filters.specs);
    $("tkReset").addEventListener("click", resetFilters);
    $("truckNearMeBtn").addEventListener("click", function () { locate(true); });
    $("truckSort").addEventListener("change", function () {
      sortMode = $("truckSort").value;
      render();
    });

    // "Show on this map" lives inside the cards, so one delegated handler.
    listEl.addEventListener("click", function (e) {
      var b = e.target.closest("[data-tk-map]");
      if (!b) return;
      e.preventDefault();
      var t = rows.find(function (x) { return String(x.id) === b.dataset.tkMap; });
      if (t) drawRouteTo(t);
    });

    $("tabList").addEventListener("click", function () { switchView("list"); });
    $("tabMap").addEventListener("click", function () {
      switchView("map");
      setTimeout(function () { map && map.invalidateSize(); }, 60);
    });

    try {
      trucks = await window.DataStore.getTrucks();
    } catch (e) {
      console.warn("[trucks] load failed:", e);
      trucks = [];
    }
    fillAreaDatalist();
    readFilters();
    render();

    // A plan that arrived with a pickup already in it gets measured straight
    // away: that person did not come here to press another button.
    if (ctx.from) { measurePickups(); measureTrip(); }
    else if (ctx.to) {
      // They told us where it is going but not where they are. That is the one
      // case where asking is worth it without being asked, because the whole
      // ranking below turns on it.
      locate(false);
    }
  }

  window.initTrucksPage = init;
})();
