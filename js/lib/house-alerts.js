/**
 * house-alerts.js — "tell me about rooms like THIS, here".
 *
 * WHY THIS FILE EXISTS
 * The area alert is the one place on the whole site where somebody states, in
 * their own words, what they want to be told about: this pin, this radius,
 * two bedrooms, under 400,000, for rent, before March. Every one of those
 * criteria was written down inside a closure in js/pages/houses.js, which
 * meant the alert could only ever fire while the reader was already standing
 * on the page they would have gone to anyway.
 *
 * The notification bell (js/core/notify.js) could see none of it. It counted
 * every new room in the country, so the three that actually matched a person's
 * pin were indistinguishable from forty that did not. A count of everything is
 * not a notification; it is a catalogue with a number on it.
 *
 * So the rule "does this listing match this alert" lives here now, once, and
 * both callers ask it. Two copies of that rule is the drift this codebase
 * keeps refusing everywhere else: the page would ping about one set of rooms
 * and the badge would count another, and nothing would catch it, because both
 * would look right on their own screen.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * Drawing, banners, chips, the modal, the "seen ids" bookkeeping. Those are
 * the page's business and each caller keeps its own. This file answers
 * questions and touches no DOM.
 *
 * STORAGE
 * localStorage, and it stays there. An alert is a standing request about
 * where somebody wants to live, which is close to saying where they are; it
 * has never left this device and nothing here starts sending it.
 *
 * SHAPE OF AN ALERT (all fields optional except an area)
 *   { id, name, areas[] | geo+bbox | lat+lng+radius_m, areaKind,
 *     listing: 'rent'|'sale', type, beds, price_max, from: 'YYYY-MM-DD',
 *     until: 'YYYY-MM-DD' }
 */
(function () {
  "use strict";

  var KEY = "pawa_house_geo_alerts";

  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch (_) {
      // A corrupt store means no alerts, never a crash. The bell falls back to
      // counting every new room, which is the behaviour it had before this
      // file existed: worse, but not broken.
      return [];
    }
  }

  function save(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list || [])); return true; }
    catch (_) { return false; }
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  /**
   * Alerts whose "needed by" date has not passed, with the expired ones
   * dropped from storage as a side effect.
   *
   * Silence beats a stale notification: somebody who said "I need a room by
   * March" has either found one or stopped looking, and either way the app
   * pinging them in June is the app not listening.
   */
  function active() {
    var all = load();
    var now = today();
    var live = all.filter(function (a) { return !a.until || a.until >= now; });
    if (live.length !== all.length) save(live);
    return live;
  }

  /**
   * Is this alert inside its own window right now?
   *
   * An alert that has not STARTED is kept but does not fire. "From April" is a
   * real thing to say, and deleting it in March would throw away the request.
   */
  function windowOpen(a) {
    var now = today();
    if (a && a.from && a.from > now) return false;
    if (a && a.until && a.until < now) return false;
    return true;
  }

  /**
   * Every area one alert watches, as a list.
   *
   * One alert can hold several (Mikocheni OR Mbezi OR Sinza). The two older
   * shapes — a bare circle, and a single drawn shape — are wrapped rather than
   * migrated, because an alert somebody saved a year ago is still a sentence
   * they meant and rewriting their storage to read it would be the riskier
   * half of this.
   */
  function areasOf(a) {
    if (!a) return [];
    if (Array.isArray(a.areas) && a.areas.length) return a.areas;
    if (a.geo) return [{ kind: a.areaKind || "custom", geo: a.geo, bbox: a.bbox }];
    if (a.radius_m != null) return [{ kind: "circle", lat: a.lat, lng: a.lng, radius_m: a.radius_m }];
    return [];
  }

  /**
   * Is a point inside any of an alert's areas?
   *
   * Falls back to a circle-only test when js/lib/geo-poly.js has not loaded, so
   * a cached page or a caller that forgot the script tag degrades to matching
   * fewer things rather than silently matching none. A drawn shape cannot be
   * tested without it, and claiming "no match" for one would be a wrong answer
   * where "I cannot tell" is the truth.
   */
  function pointInAlert(lat, lng, a) {
    if (lat == null || lng == null) return false;
    var areas = areasOf(a);
    if (!areas.length) return false;
    if (window.pawaPoly) return window.pawaPoly.pointInAreas(+lng, +lat, areas);
    return areas.some(function (ar) {
      return ar.radius_m && ar.lat != null &&
        haversineM(lat, lng, ar.lat, ar.lng) <= ar.radius_m;
    });
  }

  // Only used by the fallback above. pawaPoly has its own and is preferred.
  function haversineM(lat1, lng1, lat2, lng2) {
    var R = 6371000, rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /**
   * Does a listing satisfy EVERY criterion of one alert?
   *
   * Place, then the four things somebody typed. All of them, not any of them:
   * a person who said "two bedrooms, under 400k, for rent" and gets pinged
   * about a one-bed for sale at nine million learns to ignore the ping, and
   * then the one that mattered arrives and is ignored too.
   */
  function matches(h, a) {
    if (!h || !a) return false;
    if (!pointInAlert(h.lat, h.lng, a)) return false;
    if (a.listing && (h.listing || "rent") !== a.listing) return false;
    if (a.type && (h.type || "house") !== a.type) return false;
    if (a.beds && Number(h.bedrooms || 0) < a.beds) return false;
    if (a.price_max && Number(h.price_tzs || 0) > a.price_max) return false;
    return true;
  }

  /**
   * The listings that match any live alert, each paired with the alert it
   * answered and how far it is from that alert's pin.
   *
   * Returns [] when there are no alerts at all, and the callers treat that as
   * "this person has asked for nothing in particular", never as "nothing
   * matched". Those are different facts and the bell says different things
   * about them.
   */
  function pick(rows) {
    var alerts = active().filter(windowOpen);
    if (!alerts.length) return [];
    var out = [];
    (rows || []).forEach(function (h) {
      if (!h || h.lat == null || h.lng == null) return;
      for (var i = 0; i < alerts.length; i++) {
        if (!matches(h, alerts[i])) continue;
        var a = alerts[i];
        var d = (a.lat != null && a.lng != null)
          ? Math.round(window.pawaPoly
              ? window.pawaPoly.haversineM(h.lat, h.lng, a.lat, a.lng)
              : haversineM(h.lat, h.lng, a.lat, a.lng))
          : null;
        out.push({ h: h, alert: a, dist_m: d });
        return;                      // one row, one reason: the first that fits
      }
    });
    return out;
  }

  /** Is this device watching anything at all? The bell asks before it filters. */
  function any() {
    return active().filter(windowOpen).length > 0;
  }

  window.HouseAlerts = {
    STORAGE_KEY: KEY,
    load: load,
    save: save,
    active: active,
    windowOpen: windowOpen,
    areasOf: areasOf,
    pointInAlert: pointInAlert,
    matches: matches,
    pick: pick,
    any: any,
  };
})();
