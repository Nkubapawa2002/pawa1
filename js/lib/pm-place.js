// ============================================================================
//  pm-place.js — a place, sent inside an encrypted message.
//
//  THE PROBLEM
//  Somebody standing at a house can already mint a nine-character code
//  (js/lib/loc-share.js) and read it out. An agent can already type that code
//  into the listing form and have the pin drop. What was missing is the middle:
//  the two of them are already talking in P-Message, and the location could not
//  travel down the conversation they were having. So it went by voice, or by a
//  screenshot, or the agent got on a bus.
//
//  THE WIRE FORMAT IS TEXT, AND THAT IS THE DESIGN
//  A place message is an ordinary message whose body reads:
//
//      Gate is the blue one                 <- whatever they typed, optional
//      -6.792400, 39.208300  (~25 m)
//      https://www.google.com/maps?q=-6.792400,39.208300
//
//  There is no marker character in front of it and no emoji anywhere in it.
//  A marker would have been decoration: nothing detects a place message by
//  looking for one — read() asks place-book.js whether there are coordinates
//  in the text, which is the only question that has ever mattered, and which
//  also catches the maps link somebody pasted by hand.
//
//  Three consequences, and all three are why it is not a private binary blob:
//
//   1. **It is already encrypted.** The coordinates are in the message BODY,
//      so they are sealed exactly as the words are: unreadable to the server,
//      to a database dump, to us. A separate "attachment" table would have put
//      the one part people most want private in the clear.
//   2. **Every reader understands it**, including one running an older build,
//      including somebody who copies the message into WhatsApp or reads it out
//      on the phone. A version tag would have turned those into blank cards.
//   3. **The parser already existed.** js/lib/place-book.js reads maps links,
//      geo: URIs, OSM permalinks and bare coordinates, because a chat carries
//      whatever a phone produced. A pin sent from here and a Google link
//      pasted by hand land on the same card by the same code path.
//
//  ACCURACY IS CARRIED IN WORDS. "(~25 m)" survives being read aloud and being
//  pasted somewhere that only understands the link, and it is the difference
//  between a doorway and a block.
//
//  WHAT THIS FILE DOES NOT DO
//  It does not draw a map and it does not touch the network. It composes,
//  it reads, and it renders one card. The map sheet lives in the page, because
//  Leaflet does, and the book of places lives in place-book.js.
// ============================================================================
(function () {
  "use strict";

  function num(v) { return Number(v); }
  function fine(v) { return Number.isFinite(num(v)); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function t(key, fallback, vars) {
    var s = (window.t && window.t(key)) || fallback;
    if (s === key) s = fallback;
    if (vars) Object.keys(vars).forEach(function (k) {
      s = String(s).replace("{" + k + "}", vars[k]);
    });
    return s;
  }

  /**
   * The link a place message carries.
   *
   * Google Maps rather than something of our own: it is the one URL that
   * opens in a maps app on every phone in the country, and the point of
   * putting it in the body is that the message stays useful after it leaves
   * this app. Nothing is requested from Google by writing it down — it is
   * text in an encrypted body until somebody taps it.
   */
  function mapsUrl(lat, lng) {
    return "https://www.google.com/maps?q=" + num(lat).toFixed(6) + "," + num(lng).toFixed(6);
  }

  /**
   * Compose the body of a place message.
   *
   * `note` is whatever the person typed in the composer. It goes FIRST,
   * because "the gate is the blue one" is the part a human reads and the
   * coordinates are the part a machine reads, and a card that led with six
   * decimal places would bury the only sentence written by a person.
   */
  function compose(place, note) {
    if (!place || !fine(place.lat) || !fine(place.lng)) return "";
    var lat = num(place.lat), lng = num(place.lng);
    var lines = [];

    // No words means no words. Writing "A place" here would put a fabricated
    // sentence in somebody's message, and the reading card already has its own
    // default heading for exactly this case.
    var head = String(note == null ? "" : note).trim();
    if (!head) head = String(place.label || "").trim();
    if (head) lines.push(head);

    var acc = place.acc == null ? null : Math.round(num(place.acc));
    lines.push(window.PlaceBook.coords(lat, lng) +
      (acc && acc > 0 ? "  (~" + acc + " m)" : ""));
    lines.push(mapsUrl(lat, lng));
    return lines.join("\n");
  }

  /**
   * Read a place out of a message body, or null.
   *
   * Delegates the hard part to PlaceBook.parse, which knows every shape a
   * chat can carry. What is added here is the two things only a message
   * knows: the accuracy somebody wrote in words, and the LABEL — the line a
   * person typed, which is the whole message minus the machine-readable
   * parts.
   */
  function read(body) {
    if (!window.PlaceBook) return null;
    var text = String(body == null ? "" : body);
    var hit = window.PlaceBook.parse(text);
    if (!hit) return null;

    return {
      lat: hit.lat,
      lng: hit.lng,
      acc: accuracyIn(text),
      label: labelIn(text) || hit.label || "",
      kind: hit.kind,
      outside: !!hit.outside,
      url: mapsUrl(hit.lat, hit.lng),
    };
  }

  // "(~25 m)" or "~25m" — written by compose(), and forgiving enough to
  // survive being retyped by a person.
  function accuracyIn(text) {
    var m = String(text).match(/~\s*(\d{1,5})\s*m\b/i);
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return n > 0 ? n : null;
  }

  /**
   * The human line: what is left after the coordinates and the link are gone.
   *
   * Not "the first line" — somebody may have typed two sentences before
   * pasting a link, and a message that is nothing BUT a link has no label at
   * all rather than a fabricated one.
   */
  function labelIn(text) {
    var out = String(text)
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/geo:\S+/gi, " ")
      .replace(/(-?\d{1,2}\.\d{3,})\s*[,; ]\s*(-?\d{1,3}\.\d{3,})/g, " ")
      .replace(/\(?~\s*\d{1,5}\s*m\)?/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return out.slice(0, 120);
  }

  /** Does this body carry a place at all? Cheap enough to run per message. */
  function has(body) { return !!read(body); }

  var PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z" stroke="currentColor" stroke-width="2"/>' +
    '<circle cx="12" cy="10" r="2.4" stroke="currentColor" stroke-width="2"/></svg>';

  /**
   * The card drawn inside a message bubble.
   *
   * The buttons carry the coordinates in data attributes rather than an index
   * into a list: the log is rewritten on every incoming message, and an index
   * that pointed at row 4 before the redraw points at somebody else's place
   * after it.
   *
   * `outside` is SAID rather than hidden. A pin that is not in Tanzania is
   * usually a latitude and longitude the wrong way round, and an agent about
   * to drive somewhere is entitled to that warning before they set off.
   *
   * WHO SENT IT rides along in the data attributes, when the caller knows.
   * The card is drawn inside a message and the message knows its sender; the
   * button that saves the pin does not, and by the time that pin reaches a
   * listing form on another page the conversation is long gone. Carrying the
   * name and the account id here is what lets "exactly as Amina sent it"
   * still be true three pages later — and lets the form say whether that
   * person ever proved who they are.
   */
  function card(place, opts) {
    var o = opts || {};
    var label = String(place.label || "").trim();
    var acc = place.acc == null ? null : Math.round(num(place.acc));
    var data = ' data-plat="' + esc(num(place.lat).toFixed(6)) +
               '" data-plng="' + esc(num(place.lng).toFixed(6)) +
               '" data-plabel="' + esc(label) +
               '" data-pacc="' + esc(acc == null ? "" : acc) + '"' +
               (o.from   ? ' data-pfrom="' + esc(o.from) + '"' : "") +
               (o.fromId ? ' data-pfromid="' + esc(o.fromId) + '"' : "") +
               (o.guest  ? ' data-pguest="1"' : "") +
               (o.msgId  ? ' data-pmid="' + esc(o.msgId) + '"' : "") +
               (o.at     ? ' data-pat="' + esc(o.at) + '"' : "");

    return '<span class="pm-place' + (place.outside ? " is-outside" : "") + '"' + data + ">" +
      '<span class="pm-place-h">' + PIN_SVG +
        "<b>" + esc(label || t("pmp_a_place", "A place")) + "</b></span>" +
      '<span class="pm-place-co">' + esc(window.PlaceBook.coords(place.lat, place.lng)) +
        (acc ? " · " + esc(t("pmp_within", "within {n} m", { n: acc })) : "") + "</span>" +
      (place.outside
        ? '<span class="pm-place-warn">' + esc(t("pmp_outside",
            "This pin is not in Tanzania. It is usually a latitude and longitude the wrong way round.")) + "</span>"
        : "") +
      '<span class="pm-place-acts">' +
        '<button class="pm-place-b is-go" type="button" data-place-map="1"' + data + ">" +
          esc(t("pmp_open_map", "Open the map")) + "</button>" +
        (o.save === false ? ""
          : '<button class="pm-place-b" type="button" data-place-save="1"' + data + ">" +
              esc(t("pmp_save", "Save this pin")) + "</button>") +
      "</span></span>";
  }

  window.PMPlace = {
    compose: compose,
    read: read,
    has: has,
    card: card,
    mapsUrl: mapsUrl,
    labelIn: labelIn,
    accuracyIn: accuracyIn,
  };
})();
