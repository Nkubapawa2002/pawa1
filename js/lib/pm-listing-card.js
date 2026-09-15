// ============================================================================
//  pm-listing-card.js — a room, a service or a truck, sent inside an
//  encrypted message.
//
//  THE PROBLEM
//  Every catalogue page in this app can start a conversation with whoever
//  posted a listing: js/lib/pm-reach.js draws that button on house.html,
//  service.html, truck.html and the jobs board. What none of them could do is
//  the other half of the same sentence. A seeker comparing nine rooms wants to
//  ask a friend "what do you think of this one", and an agent holding four
//  rooms in Mikocheni wants to put them in front of the customer who just
//  described Mikocheni. Neither could send the listing itself.
//
//  So it went by screenshot. A screenshot of a room carries no price you can
//  trust, no link, no way to tell whether it is still free, and no way to
//  reach the person who posted it. It is the worst possible object to make a
//  decision about a house from, and it was the only one available.
//
//  SAME WIRE FORMAT AS A PLACE AND AN INVITE, FOR THE SAME REASONS
//  A listing message is an ordinary message whose body carries the listing's
//  own public URL as text. No marker character, no version tag, no attachment
//  table, and nothing new stored on the server:
//
//      Have a look at this one
//      https://<this app>/house.html?id=7f3c…
//
//   1. **It is already encrypted.** The reference is in the message BODY,
//      sealed exactly as the words are. Who is being shown which room is a
//      fact about two people, and a side table would have put it in the clear.
//   2. **Every reader understands it**, including one running an older build,
//      including somebody who reads it out on the phone. A card is a nicer way
//      to read the link, never the only way.
//   3. **The link is the link.** The URL here is the same one house.js already
//      copies from its share button, so a link pasted in by hand lands on the
//      same card by the same code path.
//
//  THE ONE RULE THAT IS SECURITY AND NOT PRESENTATION
//  Copied deliberately from js/lib/pm-invite-card.js, which states it at
//  length: message bodies are escaped and NEVER linkified, because turning
//  arbitrary text into tappable links inside an encrypted chat is a phishing
//  surface. This file recognises exactly one shape, a listing page on THIS
//  APP'S OWN ORIGIN, parsed with the URL constructor. isOurs() is the whole of
//  that check and must not be relaxed into a hostname substring test, which is
//  what makes maisha-na-lifeza.attacker.com work.
//
//  WHY THE CARD ARRIVES EMPTY AND FILLS IN
//  read() is synchronous because js/pages/p-message.js redraws the whole log
//  synchronously on every incoming message, and an await in there would race
//  every other redraw. So card() draws the frame immediately from the two
//  things the body actually carries, the kind and the id, and hydrate() fills
//  in the title, the price and the photo afterwards from DataStore's cache.
//  A card that never fills in says so: "no longer on Pawa" is a real answer
//  and a spinner that spins for ever is not.
//
//  WHAT THIS FILE DOES NOT DO
//  It does not send, it does not encrypt and it owns no map. It composes, it
//  reads, it renders, and it asks DataStore for rows DataStore has usually
//  already fetched.
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
      s = String(s).split("{" + k + "}").join(String(vars[k]));
    });
    return s;
  }

  function ds() { return window.DataStore || null; }

  /**
   * The three kinds a listing message can carry, and everything that differs
   * between them, in one table rather than three branches per function.
   *
   * Day jobs are deliberately absent. They have no detail page — a job card
   * anywhere in this app leads to the jobs board, not to the job — so there is
   * no URL to put in a message, and inventing one would produce a card that
   * opens onto the wrong thing. docs/P_MESSAGE.md lists that gap; when a job
   * grows a page, it gets a row here and nothing else changes.
   */
  var KINDS = {
    house: {
      page: "house.html",
      fetch: function () { return ds() && ds().getHouses(); },
      photo: function (p) { return ds() ? ds().housePhotoUrl(p) : ""; },
      map: function (r) { return window.ExploreIndex && window.ExploreIndex.fromHouse(r); },
      word: function () { return t("pml_k_house", "A room"); },
    },
    service: {
      page: "service.html",
      fetch: function () { return ds() && ds().getServices(); },
      photo: function (p) { return ds() ? ds().servicePhotoUrl(p) : ""; },
      map: function (r) { return window.ExploreIndex && window.ExploreIndex.fromService(r); },
      word: function () { return t("pml_k_service", "A service"); },
    },
    truck: {
      page: "truck.html",
      fetch: function () { return ds() && ds().getTrucks(); },
      photo: function (p) { return ds() ? ds().truckPhotoUrl(p) : ""; },
      map: function (r) { return window.ExploreIndex && window.ExploreIndex.fromTruck(r); },
      word: function () { return t("pml_k_truck", "A truck"); },
    },
  };

  /**
   * Is this URL a listing on our own origin, and which one?
   *
   * Parsed with the URL constructor against location.href, never matched with
   * a regex over the string. `https://evil.example/?x=https://our.site/house.html?id=1`
   * contains our origin as a substring and is not our origin; only a parser
   * knows the difference.
   */
  function isOurs(url) {
    var u;
    try { u = new URL(url, window.location.href); } catch (_) { return false; }
    if (u.origin !== window.location.origin) return false;

    var kind = null;
    Object.keys(KINDS).forEach(function (k) {
      if (new RegExp("(^|/)" + KINDS[k].page.replace(".", "\\.") + "$", "i").test(u.pathname)) kind = k;
    });
    if (!kind) return false;

    var id = u.searchParams.get("id");
    return id ? { url: u.href, kind: kind, id: id } : false;
  }

  /** The absolute URL of a listing on this deployment. */
  function urlFor(kind, id) {
    if (!KINDS[kind] || !id) return "";
    var base = window.location.href;
    try {
      return new URL(KINDS[kind].page + "?id=" + encodeURIComponent(String(id)), base).href;
    } catch (_) { return ""; }
  }

  // ---- the door in, from a catalogue page ----------------------------------
  //
  //  One place builds this URL, for the reason js/lib/pm-reach.js gives about
  //  its own: four catalogues deciding the shape separately is four chances to
  //  decide it differently, and the shape is the part that has to stay honest.
  //
  //  The link carries WHAT and never WHO. Choosing the recipient is a decision
  //  taken on the messages screen, in front of the list of people it could go
  //  to, and a link that made it for you is a link that can put somebody's
  //  room in front of somebody they never meant to show it to. The title is
  //  along for the strip above the composer only, so the sender can see which
  //  room they are holding before anyone is chosen: it is never sent, and the
  //  card at the other end looks the listing up for itself.

  /** `p-message.html?listing=<kind>:<id>`, or "" when there is nothing to send. */
  function sendHref(kind, id, title) {
    if (!KINDS[kind] || !id) return "";
    var q = "listing=" + encodeURIComponent(kind + ":" + String(id));
    var head = String(title == null ? "" : title).trim().slice(0, 120);
    if (head) q += "&t=" + encodeURIComponent(head);
    return "p-message.html?" + q;
  }

  var SEND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="16" height="16">' +
    '<path d="M21.4 2.6 10.8 13.2M21.4 2.6l-6.7 18.8-3.9-8.2-8.2-3.9z"/></svg>';

  /**
   * The button a catalogue page draws.
   *
   * `className` is the caller's, exactly as in pm-reach.js: each detail page
   * styles its own action row, and a shared class would need a shared
   * stylesheet none of them link.
   */
  function sendButton(kind, row, opts) {
    var o = opts || {};
    var id = row && typeof row === "object" ? row.id : row;
    var url = sendHref(kind, id, o.title || (row && row.title) || "");
    if (!url) return "";
    return '<a class="' + esc(o.className || "pml-send") + '" href="' + esc(url) + '"' +
      (o.icon === false ? "" : ' data-pml-send="1"') + ">" +
      (o.icon === false ? "" : SEND_SVG) +
      "<span>" + esc(t("pml_send", "Send it to someone")) + "</span></a>";
  }

  var LINK_RE = /https?:\/\/[^\s<>"']+/gi;

  /**
   * Compose the body of a listing message.
   *
   * `note` goes FIRST for the same reason it does on a place and on an invite:
   * the sentence a person wrote is what another person reads, and the URL is
   * what the machine reads. There is no fabricated default sentence — the card
   * has its own heading for a message that is nothing but a link, and writing
   * "Look at this" into somebody's message puts words in their mouth.
   */
  function compose(ref, note) {
    var url = ref && ref.url ? String(ref.url) : urlFor(ref && ref.kind, ref && ref.id);
    if (!url) return "";
    var head = String(note == null ? "" : note).trim();
    var lines = [];
    if (head) lines.push(head);
    lines.push(url);
    return lines.join("\n");
  }

  /** The listing referred to in this body, or null. */
  function read(body) {
    var text = String(body == null ? "" : body);
    var m = text.match(LINK_RE);
    if (!m) return null;
    for (var i = 0; i < m.length; i++) {
      // Trailing punctuation is part of the sentence, not of the URL.
      var hit = isOurs(m[i].replace(/[.,;:)\]]+$/, ""));
      if (hit) return { url: hit.url, kind: hit.kind, id: hit.id, note: noteIn(text) };
    }
    return null;
  }

  /**
   * The human line: what is left once the link is gone.
   *
   * Not "the first line". Somebody may have written two sentences before
   * pasting, and a message that is nothing but a link has no note at all
   * rather than a fabricated one.
   */
  function noteIn(text) {
    return String(text).replace(LINK_RE, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  }

  /** Cheap enough to run per message. */
  function has(body) { return !!read(body); }

  /** Strip the link so the card is not printed twice under its own words. */
  function stripped(body) { return noteIn(body); }

  // One local copy of the same four lines js/lib/house-map-sheet.js,
  // js/lib/house-rooms.js, js/lib/home-search.js and js/lib/house-cost-chart.js
  // each carry. Worth a fifth rather than a dependency: this file is loaded on
  // a page that has none of those, and the alternative is p-message.html
  // pulling in a house module to print a thousands separator.
  function money(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return "";
    return v.toLocaleString("en-US") + " TZS";
  }

  /**
   * "per month" / "kwa mwezi".
   *
   * js/lib/house-spec.js owns the full list and is the file to change when a
   * period is added. It is 966 lines of room specification and is NOT loaded
   * on p-message.html, so asking for it here would mean loading a house
   * module to print two words. These five keys go through i18n like every
   * other string, which is also what makes them translate.
   */
  var PERIOD = {
    month: ["pml_per_month", "per month"], day: ["pml_per_day", "per day"],
    week: ["pml_per_week", "per week"], year: ["pml_per_year", "per year"],
    trip: ["pml_per_trip", "per trip"], per_job: ["pml_per_job", "per job"],
  };
  function per(unit) {
    if (window.HouseSpec && window.HouseSpec.periodLabel) {
      var s = window.HouseSpec.periodLabel(unit);
      if (s) return s;
    }
    var row = PERIOD[unit];
    return row ? t(row[0], row[1]) : "";
  }

  var TAG_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M20.6 13.4 12 4.8H4.8V12l8.6 8.6a1.7 1.7 0 0 0 2.4 0l4.8-4.8a1.7 1.7 0 0 0 0-2.4z" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>' +
    '<circle cx="8.6" cy="8.6" r="1.3" fill="currentColor"/></svg>';

  /**
   * The card drawn inside a message bubble.
   *
   * The kind and the id ride in data attributes rather than an index into a
   * list, for the reason js/lib/pm-place.js gives about its own coordinates:
   * the log is rewritten on every incoming message, and an index that pointed
   * at row 4 before the redraw points at somebody else's listing after it.
   *
   * Drawn in the "pending" state on purpose. hydrate() is what fills it, and
   * a card that renders its frame immediately is what stops the log jumping
   * about as four listings load at four different speeds.
   */
  function card(ref, opts) {
    var o = opts || {};
    var k = KINDS[ref.kind];
    if (!k) return "";
    return '<span class="pm-lc" data-lc-kind="' + esc(ref.kind) + '" data-lc-id="' + esc(ref.id) +
        '" data-lc-url="' + esc(ref.url || urlFor(ref.kind, ref.id)) + '" data-lc-pending="1">' +
      '<span class="pm-lc-h">' + TAG_SVG + "<b>" + esc(k.word()) + "</b></span>" +
      '<span class="pm-lc-body">' +
        '<span class="pm-lc-t">' + esc(t("pml_loading", "Opening the listing")) + "</span>" +
      "</span>" +
      '<span class="pm-lc-acts">' +
        '<a class="pm-lc-b is-go" href="' + esc(ref.url || urlFor(ref.kind, ref.id)) + '">' +
          esc(t("pml_open", "See the listing")) + "</a>" +
        (o.reach === false ? "" : '<span class="pm-lc-reach" hidden></span>') +
      "</span></span>";
  }

  // Rows already looked up, so a redraw of the log is free. Keyed kind:id, and
  // holding `null` for a listing that is genuinely not there: without the null
  // every redraw would re-ask for the same missing room for ever.
  var seen = {};

  /**
   * Fill in every pending card under `root`.
   *
   * One fetch per KIND, not per card: DataStore.getHouses() and friends read
   * the whole table behind a cache, so three rooms in one conversation cost
   * one request the page had usually already made.
   */
  async function hydrate(root) {
    var scope = root || document;
    var nodes = [].slice.call(scope.querySelectorAll("[data-lc-pending]"));
    if (!nodes.length) return;

    var wanted = {};
    nodes.forEach(function (n) {
      var kind = n.getAttribute("data-lc-kind");
      if (KINDS[kind] && seen[kind + ":" + n.getAttribute("data-lc-id")] === undefined) {
        wanted[kind] = true;
      }
    });

    await Promise.all(Object.keys(wanted).map(async function (kind) {
      var rows = [];
      try { rows = (await KINDS[kind].fetch()) || []; } catch (_) { rows = []; }
      // Remember the misses as well as the hits. A listing taken down is a
      // permanent answer for this page's lifetime, and re-asking on every
      // redraw would turn one dead room into a request per keystroke.
      var found = {};
      rows.forEach(function (r) { found[String(r.id)] = r; });
      nodes.forEach(function (n) {
        if (n.getAttribute("data-lc-kind") !== kind) return;
        var id = n.getAttribute("data-lc-id");
        if (seen[kind + ":" + id] === undefined) seen[kind + ":" + id] = found[id] || null;
      });
    }));

    nodes.forEach(function (n) {
      var kind = n.getAttribute("data-lc-kind");
      var row = seen[kind + ":" + n.getAttribute("data-lc-id")];
      if (row === undefined) return;
      fill(n, kind, row);
    });
  }

  /** Put one looked-up listing into its frame, or say why it is not there. */
  function fill(node, kind, row) {
    node.removeAttribute("data-lc-pending");
    var body = node.querySelector(".pm-lc-body");
    if (!body) return;

    if (!row) {
      node.classList.add("is-gone");
      body.innerHTML = '<span class="pm-lc-t">' +
          esc(t("pml_gone", "This listing is not on Pawa any more.")) + "</span>" +
        '<span class="pm-lc-sub">' +
          esc(t("pml_gone_d", "It was taken down, or it is older than fifteen days.")) + "</span>";
      var go = node.querySelector(".pm-lc-b.is-go");
      if (go) go.remove();
      return;
    }

    var k = KINDS[kind];
    var item = k.map(row) || null;
    var title = String((item && item.title) || row.title || "").trim();
    var photo = (item && item.photo) || k.photo(row.photo);
    var price = money(item ? item.price : row.price_tzs);
    var unit = per(item ? item.priceUnit : row.period);
    var area = String((item && (item.area || item.region)) || row.area || row.region || "").trim();
    var owner = !!row.posted_by_owner;
    var vetted = !!row.verified;

    body.innerHTML =
      (photo ? '<img class="pm-lc-img" src="' + esc(photo) + '" alt="" loading="lazy" />' : "") +
      '<span class="pm-lc-tx">' +
        '<span class="pm-lc-t">' + esc(title || k.word()) + "</span>" +
        (price ? '<span class="pm-lc-p">' + esc(price) + (unit ? " " + esc(unit) : "") + "</span>" : "") +
        (area ? '<span class="pm-lc-sub">' + esc(area) + "</span>" : "") +
        (owner || vetted
          ? '<span class="pm-lc-tags">' +
              (owner ? '<span class="pm-lc-tag is-owner">' + esc(t("pml_owner", "From the owner")) + "</span>" : "") +
              (vetted ? '<span class="pm-lc-tag">' + esc(t("pml_verified", "Verified")) + "</span>" : "") +
            "</span>"
          : "") +
      "</span>";

    // The one thing a card can offer that the listing page cannot: the person
    // who posted it is reachable from here without leaving the conversation.
    // Only when it is somebody else's listing and somebody else's chat.
    var slot = node.querySelector(".pm-lc-reach");
    var ownerId = (item && item.ownerId) || row.owner_user_id || "";
    if (slot && ownerId && window.PMReach) {
      var href = window.PMReach.href(ownerId);
      if (href) {
        slot.hidden = false;
        slot.innerHTML = '<a class="pm-lc-b" href="' + esc(href) + '">' +
          esc(t("pml_ask", "Ask whoever posted it")) + "</a>";
      }
    }
  }

  window.PMListingCard = {
    compose: compose,
    read: read,
    has: has,
    stripped: stripped,
    card: card,
    hydrate: hydrate,
    isOurs: isOurs,
    urlFor: urlFor,
    sendHref: sendHref,
    sendButton: sendButton,
    KINDS: KINDS,
  };
})();
