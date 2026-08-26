// ============================================================================
//  place-book.js — every exact place this device has been given, in one list.
//
//  THE PROBLEM IT SOLVES
//  A location arrives through a different door every time. Somebody standing
//  at a house reads out nine characters (js/lib/loc-share.js). Somebody pastes
//  a Google Maps link into a P-Message thread. Somebody taps the link an agent
//  sent and their GPS lands in a meet room. The agent's own phone knows where
//  it is standing. Four doors, four shapes, and until now each one ended in a
//  different place — which meant a location you were given on Monday was gone
//  by Tuesday and the agent had to ask for it again.
//
//  So they all end HERE. One list, on the device, newest first, and the
//  listing form reads it as "places people have shared with you". A pin is
//  then a tap rather than a phone call.
//
//  WHY THE DEVICE AND NOT THE DATABASE
//  A place someone shared with you privately is theirs, not ours. loc_share
//  goes to considerable lengths to keep the coordinates unreadable to the
//  server (see supabase/features/location/loc_share.sql); writing the opened
//  result straight back to a table we can read would undo all of it in one
//  line. So the book lives in localStorage, it dies with the site data, and
//  nothing in it is ever uploaded except the one pin the agent deliberately
//  attaches to a listing.
//
//  WHAT parse() ACCEPTS, and why it is a long list
//  Because a chat is a chat. People send whatever their phone produced: a full
//  Google Maps URL, a geo: URI from Android's share sheet, an OpenStreetMap
//  permalink, or they just type "-6.7924, 39.2083". Refusing three of those
//  four and saying "invalid" would be technically correct and useless.
// ============================================================================
(function () {
  "use strict";

  var KEY = "pawa-places-v1";
  var KEEP = 40;

  // Tanzania, generously bounded. A paste that lands outside it is almost
  // always a lat/lng read in the wrong order, which is worth correcting rather
  // than silently pinning a spot in the Indian Ocean.
  var TZ = { minLat: -12.0, maxLat: 0.5, minLng: 28.5, maxLng: 41.5 };

  function inTZ(lat, lng) {
    return lat >= TZ.minLat && lat <= TZ.maxLat && lng >= TZ.minLng && lng <= TZ.maxLng;
  }

  function ok(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) &&
      Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  }

  // ---- the list --------------------------------------------------------------

  function read() {
    var stored = [];
    try { stored = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (_) { stored = []; }
    if (!Array.isArray(stored)) return [];
    return stored.filter(function (p) { return p && ok(Number(p.lat), Number(p.lng)); });
  }

  function write(rows) {
    try { localStorage.setItem(KEY, JSON.stringify(rows.slice(0, KEEP))); } catch (_) {}
  }

  /**
   * Remember a place.
   *
   * `source` is how it arrived — 'code' | 'link' | 'gps' | 'request' | 'map' |
   * 'search' | 'pm' — and it is kept because it is the difference between "a
   * person standing there sent this" and "I typed it into a search box". The
   * first is evidence; the second is a guess, and the listing form says which.
   *
   * `from` is the person, in words, and `fromId` is the same person as an
   * account. Both, because they answer different questions: the words are what
   * a human reads in the list, and the id is what survives somebody renaming
   * themselves. `guest` says that person never proved who they are — a name in
   * a room is one its owner typed, and a form about to put it on a public
   * listing is entitled to know that before it does.
   *
   * The same spot twice is one entry, refreshed: two people can share the same
   * gate an hour apart, and a list with that gate on it four times is a list
   * nobody scrolls.
   */
  function add(place) {
    var lat = Number(place && place.lat), lng = Number(place && place.lng);
    if (!ok(lat, lng)) return null;
    var rec = {
      id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      lat: lat,
      lng: lng,
      acc: place.acc == null ? null : (Math.round(Number(place.acc)) || null),
      label: String(place.label || "").slice(0, 120),
      source: place.source || "link",
      from: String(place.from || "").slice(0, 60),   // who, or which door
      fromId: String(place.fromId || "").slice(0, 64),
      guest: place.guest === true ? true : undefined,
      // Where it was said. Kept so the listing form can show "in the Tungi
      // agents room" rather than a bare name, and so a pin can be traced back
      // to the conversation it came from without the agent searching for it.
      threadId: place.threadId ? String(place.threadId).slice(0, 64) : undefined,
      threadName: place.threadName ? String(place.threadName).slice(0, 60) : undefined,
      msgId: place.msgId ? String(place.msgId).slice(0, 64) : undefined,
      at: place.at || Date.now(),
    };
    var near = function (a, b) { return Math.abs(a - b) < 0.00015; };   // ~15 m
    var rows = read().filter(function (p) {
      return !(near(p.lat, rec.lat) && near(p.lng, rec.lng));
    });
    rows.unshift(rec);
    write(rows);
    return rec;
  }

  function list() { return read(); }

  function remove(id) {
    write(read().filter(function (p) { return p.id !== id; }));
  }

  function clear() { try { localStorage.removeItem(KEY); } catch (_) {} }

  // ---- reading a place out of whatever a person pasted ------------------------

  /**
   * A nine-character Pawa location code inside a longer message, or null.
   *
   * Only the grouped form is matched. Nine unbroken Crockford characters occur
   * inside plate numbers, order references and hashes; "K7M-2Q9-F3T" does not
   * occur by accident, and the check symbol then rejects 31 of every 32 that
   * somehow do. Matching loosely here would mean a chat offering to open a
   * fragment of somebody's invoice number as if it were a house.
   */
  function codeIn(text) {
    var s = String(text == null ? "" : text);
    var re = /\b([0-9A-HJ-NP-TVWXYZ]{3})[-. ]([0-9A-HJ-NP-TVWXYZ]{3})[-. ]([0-9A-HJ-NP-TVWXYZ]{3})\b/gi;
    var m;
    while ((m = re.exec(s))) {
      var candidate = m[1] + m[2] + m[3];
      if (window.LocCode && window.LocCode.problem(candidate) === null) {
        return window.LocCode.normalize(candidate);
      }
    }
    return null;
  }

  // A pasted maps link usually carries the place name in its path
  // (/maps/place/Mlimani+City/) — worth keeping, because "Mlimani City" is a
  // far better thing to find in a list than "-6.7701, 39.2394".
  function labelFor(s) {
    var m = s.match(/\/maps\/place\/([^/@?]+)/i);
    if (m) {
      try { return decodeURIComponent(m[1].replace(/\+/g, " ")).slice(0, 60); } catch (_) { return ""; }
    }
    return "";
  }

  /**
   * Coordinates out of anything a chat can carry, or null.
   *
   * Returns { lat, lng, label, kind, outside } where kind is
   * 'coords' | 'maps' | 'geo' | 'osm' — the caller uses it to say what it
   * recognised, and `outside` warns that the result is not in Tanzania rather
   * than pretending the paste was unreadable.
   */
  function parse(text) {
    var s = String(text == null ? "" : text).trim();
    if (!s) return null;

    var tries = [
      // geo:-6.7924,39.2083;u=25 — Android's share sheet
      { kind: "geo", re: /geo:(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i },
      // !3d-6.79!4d39.20 — the PLACE's coordinates inside a long maps URL.
      // Tried before @lat,lng because a link carries both and this is the pin;
      // the @ pair is only where the camera happened to be sitting.
      { kind: "maps", re: /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/ },
      // ?q= · &query= · &destination= · &ll= — an explicitly requested point
      { kind: "maps", re: /[?&](?:q|query|destination|ll|sll|center|daddr)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i },
      // google.com/maps/@-6.79,39.20,17z — the map's own viewport
      { kind: "maps", re: /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/ },
      // openstreetmap.org/#map=17/-6.79/39.20
      { kind: "osm", re: /#map=\d+(?:\.\d+)?\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/i },
      // openstreetmap.org/?mlat=-6.79&mlon=39.20
      { kind: "osm", re: /[?&]mlat=(-?\d+(?:\.\d+)?)[\s\S]*?[?&]mlon=(-?\d+(?:\.\d+)?)/i },
      // "-6.7924, 39.2083" typed by hand. Three decimals minimum: "5, 10" is
      // not a location, it is two numbers.
      { kind: "coords", re: /(-?\d{1,2}\.\d{3,})\s*[,; ]\s*(-?\d{1,3}\.\d{3,})/ },
    ];

    for (var i = 0; i < tries.length; i++) {
      var m = s.match(tries[i].re);
      if (!m) continue;
      var lat = Number(m[1]), lng = Number(m[2]);
      if (!ok(lat, lng)) continue;
      // A pair that is only valid the other way round is a swap, not a
      // mystery: Tanzania has no negative longitude and no latitude past 41.
      if (!inTZ(lat, lng) && inTZ(lng, lat)) { var swap = lat; lat = lng; lng = swap; }
      return {
        lat: lat, lng: lng, kind: tries[i].kind,
        label: labelFor(s), outside: !inTZ(lat, lng),
      };
    }
    return null;
  }

  /** "-6.792400, 39.208300" — the one place coordinates get formatted to read. */
  function coords(lat, lng) {
    return Number(lat).toFixed(6) + ", " + Number(lng).toFixed(6);
  }

  window.PlaceBook = {
    add: add, list: list, remove: remove, clear: clear,
    parse: parse, codeIn: codeIn, coords: coords, inTZ: inTZ,
    KEY: KEY,
  };
})();
