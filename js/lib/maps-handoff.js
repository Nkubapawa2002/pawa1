// ============================================================================
//  maps-handoff.js — window.PawaMaps
//
//  Every "take me there" in the app, handed to Google Maps with the boxes
//  already filled.
//
//  The app has always been able to draw a route itself: js/lib/geo.js measures
//  the real road with OSRM and Valhalla, and house-place.js paints it on the
//  MapLibre map. That is a good answer to "how far is it". It is a poor answer
//  to "get me there", because the person then has to type the address again
//  into the app that actually navigates. Nine links in this repo already point
//  at Google Maps and NOT ONE of them sets an origin, so every one of them
//  lands on a screen asking where you are starting from.
//
//  So this file exists to make the hand-off complete: destination, origin and
//  travel mode, every time, from what the app already knows.
//
//  ---------------------------------------------------------------------------
//  THE ONE RULE THAT MAKES THIS WORK: NEVER AWAIT BEFORE NAVIGATING.
//
//  A GPS fix takes seconds. A popup opened seconds after the tap is blocked by
//  every browser, and a link whose href is rewritten after the click has
//  already been followed. So `href` is ALWAYS valid the moment it is written:
//
//    · we know where you are  -> origin is your coordinates, exact
//    · we do not              -> origin is omitted, and Google Maps uses the
//                                device's own location, which is the same
//                                answer one step later
//
//  Either way nobody types anything. The fix is then requested in the
//  background and the href is upgraded in place for the next tap. That is why
//  there is no async open() in here and must not be one.
//  ---------------------------------------------------------------------------
//
//  Depends on: nothing at load time. Uses window.pawaLocate (js/lib/geolocate.js)
//  and window.pawaCommute (js/lib/commute-score.js) when they are present, and
//  degrades to a destination-only link when they are not.
// ============================================================================
(function () {
  "use strict";

  // Google's documented universal cross-platform URL. `api=1` is what promises
  // the parameter names below will keep working; without it the link is a
  // legacy format Google is free to change.
  var DIR_BASE    = "https://www.google.com/maps/dir/?api=1";
  var SEARCH_BASE = "https://www.google.com/maps/search/?api=1";

  // Six decimals is about 11 cm. More is noise, and it is noise that makes a
  // shared link look machine-generated.
  var PRECISION = 6;

  // How stale a remembered fix may be and still be used as an origin without
  // asking. Twenty minutes: long enough to survive reading a listing, short
  // enough that it cannot silently route somebody from the last town they were
  // in. Past this we simply omit the origin, which is never wrong, only vaguer.
  var FIX_MAX_AGE_MS = 20 * 60 * 1000;

  // The app's travel modes are Tanzanian (bodaboda, bajaji, daladala). Google
  // has four. Mapping is a judgement, so it is written down once here rather
  // than guessed at each call site:
  //   bodaboda and bajaji follow the road network a car follows, so driving is
  //   the honest estimate of the ROUTE even though the time will differ;
  //   daladala is public transport and Google routes it as such where it has
  //   the data, falling back to driving on its own when it does not.
  var TRAVEL_MODE = {
    walk:     "walking",
    bodaboda: "driving",
    bajaji:   "driving",
    daladala: "transit",
    car:      "driving",
  };
  var DEFAULT_MODE = "driving";

  function fine(n) { return typeof n === "number" && isFinite(n); }
  function num(n)  { return typeof n === "number" ? n : parseFloat(n); }

  /** A point is usable only if BOTH halves are real numbers. */
  function usable(p) {
    return !!p && fine(num(p.lat)) && fine(num(p.lng));
  }

  /** "lat,lng" the way Google wants it. */
  function coords(p) {
    return num(p.lat).toFixed(PRECISION) + "," + num(p.lng).toFixed(PRECISION);
  }

  function travelMode(mode) {
    return TRAVEL_MODE[mode] || (mode && TRAVEL_MODE[String(mode).toLowerCase()]) || DEFAULT_MODE;
  }

  // --------------------------------------------------------------- the URLs

  /**
   * Directions, with as much filled in as we honestly can.
   *
   * @param {{lat,lng}}  to    required — where they are going
   * @param {object}    [opts]
   * @param {{lat,lng}}  opts.from   omit to let Google use the device location
   * @param {string}     opts.mode   a pawaCommute mode key, or a Google one
   * @returns {string}   "" when there is no destination worth linking to
   */
  function directions(to, opts) {
    if (!usable(to)) return "";
    var o = opts || {};
    var url = DIR_BASE + "&destination=" + encodeURIComponent(coords(to));
    // Omitted deliberately when unknown. An origin of "" or "current+location"
    // is not a documented value and Google treats it as a place name to search.
    if (usable(o.from)) url += "&origin=" + encodeURIComponent(coords(o.from));
    url += "&travelmode=" + travelMode(o.mode);
    return url;
  }

  /**
   * A dropped pin rather than a route. `query` carries the coordinates and
   * `query_place_id` is not ours to give, so the label rides along in the
   * coordinates' place only when there are no coordinates at all.
   */
  function pin(p, label) {
    if (usable(p)) return SEARCH_BASE + "&query=" + encodeURIComponent(coords(p));
    var q = String(label == null ? "" : label).trim();
    return q ? SEARCH_BASE + "&query=" + encodeURIComponent(q) : "";
  }

  // ------------------------------------------------------- where the user is

  /**
   * The best origin available WITHOUT asking anybody anything.
   *
   * Returns null rather than a guess. Every caller treats null as "omit the
   * origin", which is a working link, so there is never a reason to invent one.
   */
  function knownOrigin() {
    if (!window.pawaLocate || !window.pawaLocate.lastKnown) return null;
    var fix = null;
    try { fix = window.pawaLocate.lastKnown(); } catch (_) { return null; }
    if (!usable(fix)) return null;
    var age = Date.now() - (Number(fix.at) || 0);
    if (!(age >= 0) || age > FIX_MAX_AGE_MS) return null;
    return { lat: num(fix.lat), lng: num(fix.lng) };
  }

  /**
   * Ask the device for a fix in the background and hand it back.
   *
   * Never awaited by anything that navigates. `pawaLocate.best()` writes the
   * result to the same store `knownOrigin()` reads, so the only job here is to
   * start it and to swallow a refusal: somebody who declines the permission
   * prompt has answered the question, and an error dialog on top of that is
   * just the app asking twice.
   */
  function warmOrigin(onFix) {
    if (!window.pawaLocate || !window.pawaLocate.best) return;
    var p;
    try { p = window.pawaLocate.best({ targetAccuracy: 80, hardTimeout: 15000 }); } catch (_) { return; }
    if (!p || !p.then) return;
    p.then(function (fix) {
      if (usable(fix) && typeof onFix === "function") onFix({ lat: num(fix.lat), lng: num(fix.lng) });
    }).catch(function () { /* declined, or no signal. The link still works. */ });
  }

  // ------------------------------------------------------- the saved places
  // "Match to my life" on houses.html already asks people to save the places
  // they travel to, workplace first, and stores them on the device. The detail
  // sheet has never read them, which is why it asks for a workplace that the
  // person has already typed once. Same key, same shape, read-only here.

  var PLACES_KEY = "pawa_house_my_places";

  function savedPlaces() {
    try {
      var v = JSON.parse(localStorage.getItem(PLACES_KEY) || "[]");
      return Array.isArray(v) ? v.filter(usable) : [];
    } catch (_) { return []; }
  }

  /** The workplace, or the closest thing to one that was saved. */
  function workplace() {
    var all = savedPlaces();
    for (var i = 0; i < all.length; i++) if (all[i].kind === "work") return all[i];
    return null;
  }

  /** A place's own travel mode, falling back to the app's default. */
  function modeOf(place) {
    return (place && place.mode) || "car";
  }

  // ------------------------------------------------------------ the binding
  /**
   * Make one anchor a live directions link.
   *
   * The anchor is given a working href IMMEDIATELY and a better one later if
   * the device answers. Returns a function that re-points it at a new
   * destination, so a map sheet that changes house can reuse the same node.
   *
   * @param {HTMLAnchorElement} a
   * @param {{lat,lng}} to
   * @param {object} [opts]  from / mode, as `directions`
   */
  function bindDirections(a, to, opts) {
    if (!a) return function () {};
    var o = opts || {};
    var dest = to;

    function paint() {
      var href = directions(dest, { from: o.from || knownOrigin(), mode: o.mode });
      if (href) {
        a.href = href;
        a.removeAttribute("aria-disabled");
      } else {
        // No pin on the listing. A link to nowhere is worse than a dead one,
        // because it opens Google Maps on whatever it decides "" means.
        a.removeAttribute("href");
        a.setAttribute("aria-disabled", "true");
      }
    }
    paint();

    // Only when the caller has not pinned an origin of its own. Warming on
    // pointerdown rather than on load keeps the permission prompt tied to an
    // intention: nobody is asked for their location for opening a page.
    if (!usable(o.from)) {
      var warmed = false;
      a.addEventListener("pointerdown", function () {
        if (warmed) return;
        warmed = true;
        warmOrigin(function () { paint(); });
      });
    }

    return function retarget(next, nextOpts) {
      dest = next;
      if (nextOpts) o = nextOpts;
      paint();
    };
  }

  window.PawaMaps = {
    directions: directions,
    pin: pin,
    knownOrigin: knownOrigin,
    warmOrigin: warmOrigin,
    savedPlaces: savedPlaces,
    workplace: workplace,
    modeOf: modeOf,
    travelMode: travelMode,
    bindDirections: bindDirections,
    usable: usable,
    coords: coords,
    TRAVEL_MODE: TRAVEL_MODE,
    FIX_MAX_AGE_MS: FIX_MAX_AGE_MS,
    PLACES_KEY: PLACES_KEY,
  };
})();
