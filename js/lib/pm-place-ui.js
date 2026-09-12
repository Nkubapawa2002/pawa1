// ============================================================================
//  pm-place-ui.js — a location, put into an encrypted conversation.
//
//  Split out of js/pages/p-message.js. The body below is unchanged except that
//  the page's `open` (the thread on screen) is now read through openThread(),
//  because a module cannot close over a variable the page reassigns.
//
//  THE WIRE FORMAT AND THE SEALING ARE NOT HERE. js/lib/pm-place.js composes
//  the message body and js/lib/pm-store.js seals it; this file is the screen:
//  four doors onto a pin, the strip that shows one waiting to be sent, and the
//  sheet that opens one somebody else sent.
//
//  FOUR DOORS, because a location arrives four different ways and refusing
//  three of them would mean the feature works only for whoever happens to be
//  standing in the right place with the right app open. They are described
//  where they are built, below.
//
//  THE PIN JOINS THE WORDS, it does not go as a second message. "The blue gate,
//  not the green one" and the coordinates are one statement, and splitting them
//  means the sentence can arrive without the place or the place without the
//  sentence. That is why pending() exists: the composer asks this module what
//  is waiting, and clears it only once the send has actually left.
// ============================================================================
(function () {
  "use strict";

  // Handed in by the page. Read at CALL time, never destructured at attach
  // time: the page assigns several of these after it attaches, and a captured
  // copy would be undefined with no error to say so.
  var ctx = {};

  var t = function (k, f) { return f || k; };
  var esc = function (s) { return String(s == null ? "" : s); };
  var el = {};

  function attach(o) {
    ctx = o || {};
    if (ctx.t) t = ctx.t;
    if (ctx.esc) esc = ctx.esc;
    if (ctx.el) el = ctx.el;          // an object, never reassigned by the page
  }

  var modal = function (html) { if (ctx.modal) ctx.modal(html); };
  var closeModal = function () { if (ctx.closeModal) ctx.closeModal(); };
  /** The conversation currently on screen, or null. Live, never a copy. */
  var openThread = function () { return ctx.open ? ctx.open() : null; };

  /** The pin waiting to go with the next message, owned here. */
  var pendingPlace = null;
  //
  //  Four doors, because a location arrives four different ways and refusing
  //  three of them would mean the feature works for whoever happens to be
  //  standing in the right place with the right app open:
  //
  //    here   — this device's GPS, through pawaLocate, which knows how to wait
  //             for a real fix and how to explain a refusal in words.
  //    map    — drag the map, the pin is the middle. For somebody describing a
  //             place they are not at, which is most of the time.
  //    saved  — the book of places this device has already been given
  //             (js/lib/place-book.js). A gate shared last Tuesday is still
  //             the same gate.
  //    code   — the nine characters somebody read out on the phone.
  //
  //  All four end as { lat, lng, acc, label } and are sent as an ordinary
  //  encrypted message (js/lib/pm-place.js explains the wire format and why it
  //  is deliberately plain text).

  var pickMap = null, pickMarker = null, pickTab = "here";

  function showPlacePicker() {
    if (!openThread()) return;
    // Always the first tab, which is also what nearly everybody came for:
    // where I am, now. This used to open on "Saved places" the moment the book
    // had a single row in it, so a returning person was greeted on the THIRD
    // tab by a list of old pins, and the common case went from zero taps to
    // two. Saved places is still one tap away. A picker that opens the same
    // way every time is one less thing to work out.
    pickTab = "here";
    drawPicker();
  }

  /**
   * Who a pin sent right now would actually reach.
   *
   * The picker used to say "whoever you send it to", which is true and no help
   * at all: this screen already knows the answer, and it is the one fact a
   * person hesitates over before sending their exact position. Sending it into
   * a room of thirty is a different decision from sending it to one person,
   * and the copy has to be able to tell those apart before the tap, not after.
   */
  function recipientLine() {
    if (!openThread()) return t("pmp_to_none", "Choose a conversation first.");
    var who = String(openThread().name || "").trim();
    if (openThread().kind === "group") {
      return openThread().size
        ? t("pmp_to_room_n", "Everyone in {room} will see it, {n} people.", { room: who, n: openThread().size })
        : t("pmp_to_room", "Everyone in {room} will see it.", { room: who });
    }
    if (openThread().kind === "broadcast") {
      return t("pmp_to_cast", "Everyone you are broadcasting to will see it.");
    }
    return who
      ? t("pmp_to_one", "Only {name} can open it.", { name: who })
      : t("pmp_to_one_x", "Only the person in this conversation can open it.");
  }

  /**
   * How exact the pin is, in words, BEFORE it is sent.
   *
   * compose() has always written "(~25 m)" into the body, so the reader got
   * this. The sender did not: the strip showed a label or six decimal places,
   * both of which look equally precise whether the fix was five metres or five
   * hundred. A person sending their location to somebody who is going to
   * travel to it should see which of those they are about to promise.
   *
   * COARSE is 100m, which is roughly the difference between a doorway and a
   * block. Under it the number is stated plainly; over it the strip says so
   * and offers another go, because a second fix a few seconds later is very
   * often much better and costs one tap.
   */
  var COARSE_M = 100;

  function accuracyNote(place) {
    if (!place || place.acc == null || !(place.acc > 0)) return null;
    var n = Math.round(place.acc);
    return { n: n, coarse: n > COARSE_M };
  }

  function drawPicker() {
    var tabs = [
      ["here", t("pmp_tab_here", "Where I am")],
      ["map", t("pmp_tab_map", "Point on a map")],
      ["saved", t("pmp_tab_saved", "Saved places")],
      ["code", t("pmp_tab_code", "A code")],
    ];
    modal("<h2>" + esc(t("pmp_send_place", "Send a place")) + "</h2>" +
      // Who first, then how it travels. The order is the order somebody
      // actually asks the questions in.
      '<p class="pm-pick-to">' + esc(recipientLine()) + "</p>" +
      "<p>" + esc(t("pmp_send_d",
        "The pin travels inside the message, so it is encrypted exactly as the words are. Whoever you send it to can open it on a map and use it without coming here.")) + "</p>" +
      '<div class="pm-pick-tabs" role="tablist">' +
        tabs.map(function (row) {
          return '<button class="pm-pick-tab' + (pickTab === row[0] ? " is-on" : "") +
            '" type="button" data-ptab="' + row[0] + '" role="tab">' + esc(row[1]) + "</button>";
        }).join("") +
      "</div>" +
      '<div id="pmPickBody"></div>' +
      '<div class="pm-note" id="pmPickMsg" hidden></div>' +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn ghost" id="pmPickCancel" type="button">' + esc(t("pm_close", "Close")) + "</button>" +
      "</div>");

    document.getElementById("pmPickCancel").addEventListener("click", closePicker);
    document.getElementById("pmModal").querySelector(".pm-pick-tabs")
      .addEventListener("click", function (e) {
        var b = e.target.closest("[data-ptab]");
        if (!b || b.dataset.ptab === pickTab) return;
        pickTab = b.dataset.ptab;
        drawPicker();
      });
    drawPickerBody();
  }

  function closePicker() {
    if (pickMap) { try { pickMap.remove(); } catch (_) {} pickMap = null; pickMarker = null; }
    closeModal();
  }

  function pickMsg(text, kind) {
    var box = document.getElementById("pmPickMsg");
    if (!box) return;
    if (!text) { box.hidden = true; box.textContent = ""; return; }
    box.className = "pm-note" + (kind === "err" ? " warn" : "");
    box.textContent = text;
    box.hidden = false;
  }

  function drawPickerBody() {
    var body = document.getElementById("pmPickBody");
    if (!body) return;
    if (pickMap) { try { pickMap.remove(); } catch (_) {} pickMap = null; pickMarker = null; }
    pickMsg("");

    if (pickTab === "here") {
      body.innerHTML = '<button class="pm-btn" id="pmPickGps" type="button" style="width:100%">' +
        esc(t("pmp_use_gps", "Use where I am now")) + "</button>" +
        '<p style="margin-top:9px">' + esc(t("pmp_gps_d",
          "Your phone decides this, not us, and it is sent only to this conversation.")) + "</p>";
      document.getElementById("pmPickGps").addEventListener("click", useGps);
      return;
    }

    if (pickTab === "map") {
      body.innerHTML = '<div class="pm-pick-map" id="pmPickMap"></div>' +
        '<p style="margin:8px 0 0">' + esc(t("pmp_map_d",
          "Drag the map. The pin is the middle of it.")) + "</p>" +
        '<button class="pm-btn" id="pmPickMapGo" type="button" style="width:100%;margin-top:9px">' +
        esc(t("pmp_send_this", "Send this pin")) + "</button>";
      mountPickMap();
      document.getElementById("pmPickMapGo").addEventListener("click", function () {
        if (!pickMap) return;
        var c = pickMap.getCenter();
        attachPlace({ lat: c.lat, lng: c.lng, acc: null, label: "", source: "map" });
        closePicker();
      });
      return;
    }

    if (pickTab === "saved") {
      var rows = (window.PlaceBook ? window.PlaceBook.list() : []).slice(0, 12);
      if (!rows.length) {
        body.innerHTML = "<p>" + esc(t("pmp_none_saved",
          "No places yet. One arrives here whenever somebody sends you a pin, or when you open a code.")) + "</p>";
        return;
      }
      body.innerHTML = '<div class="pm-pick-list">' + rows.map(function (p) {
        return '<button class="pm-pick-row" type="button" data-psaved="' + esc(p.id) + '">' +
          '<span class="pm-pick-t">' + esc(p.label || window.PlaceBook.coords(p.lat, p.lng)) + "</span>" +
          '<span class="pm-pick-s">' + esc(placeAge(p.at)) + "</span></button>";
      }).join("") + "</div>";
      body.querySelector(".pm-pick-list").addEventListener("click", function (e) {
        var b = e.target.closest("[data-psaved]");
        if (!b) return;
        var hit = window.PlaceBook.list().filter(function (p) { return p.id === b.dataset.psaved; })[0];
        if (!hit) return;
        attachPlace(hit);
        closePicker();
      });
      return;
    }

    // code
    body.innerHTML = '<input id="pmPickCode" type="text" inputmode="latin" autocomplete="off" ' +
        'maxlength="11" placeholder="K7M-2Q9-F3T" />' +
      '<button class="pm-btn" id="pmPickCodeGo" type="button" style="width:100%;margin-top:9px">' +
        esc(t("pmp_open_code", "Open the code")) + "</button>" +
      '<p style="margin-top:9px">' + esc(t("pmp_code_d",
        "Nine characters somebody read out to you. It opens once and the pin is theirs, not ours. We cannot read it either.")) + "</p>";
    var input = document.getElementById("pmPickCode");
    input.addEventListener("input", function () {
      if (!window.LocCode) return;
      var c = window.LocCode.normalize(input.value);
      var atEnd = input.selectionStart === input.value.length;
      input.value = c.length === window.LocCode.CODE_LEN
        ? window.LocCode.format(c) : c.replace(/(.{3})(?=.)/g, "$1-");
      if (atEnd) input.setSelectionRange(input.value.length, input.value.length);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); document.getElementById("pmPickCodeGo").click(); }
    });
    document.getElementById("pmPickCodeGo").addEventListener("click", openPickedCode);
  }

  function placeAge(at) {
    var mins = Math.round((Date.now() - (at || 0)) / 60000);
    if (mins < 1) return t("pmp_ago_now", "just now");
    if (mins < 60) return t("pmp_ago_min", "{n} min", { n: mins });
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return t("pmp_ago_hr", "{n} h", { n: hrs });
    return t("pmp_ago_day", "{n} d", { n: Math.round(hrs / 24) });
  }

  function mountPickMap() {
    var host = document.getElementById("pmPickMap");
    if (!host || !window.L) return;
    // Somewhere sensible to start: the last place this device was given, or
    // the whole country. Opening on the middle of the Atlantic and asking
    // somebody to drag to Mwanza is not a choice.
    var last = (window.PlaceBook ? window.PlaceBook.list() : [])[0];
    var centre = last ? [last.lat, last.lng] : [-6.4, 35.0];
    pickMap = window.L.map(host, { scrollWheelZoom: true, attributionControl: false })
      .setView(centre, last ? 16 : 6);
    if (window.addSatelliteHybrid) window.addSatelliteHybrid(pickMap);
    else window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(pickMap);
    // A crosshair rather than a draggable marker: the pin is always the middle
    // of the map, so there is nothing to lose track of and nothing to explain.
    pickMarker = window.L.marker(centre, { interactive: false }).addTo(pickMap);
    pickMap.on("move", function () {
      if (pickMarker) pickMarker.setLatLng(pickMap.getCenter());
    });
    setTimeout(function () { try { pickMap.invalidateSize(); } catch (_) {} }, 120);
  }

  /**
   * The device's best fix, or a throw. One path, two callers: the picker's
   * "use where I am now" and the attach strip's "try for a closer fix". They
   * had drifted into two copies of this once already.
   */
  function getFix() {
    if (window.pawaLocate && window.pawaLocate.supported()) {
      return window.pawaLocate.best({ targetAccuracy: 50, hardTimeout: 15000 });
    }
    return new Promise(function (res, rej) {
      if (!navigator.geolocation) return rej(new Error("no gps"));
      navigator.geolocation.getCurrentPosition(function (pos) {
        res({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
      }, rej, { enableHighAccuracy: true, timeout: 15000 });
    });
  }

  async function useGps() {
    var btn = document.getElementById("pmPickGps");
    if (btn) { btn.disabled = true; btn.textContent = t("pmp_locating", "Finding you…"); }
    try {
      var fix = await getFix();
      attachPlace({
        lat: fix.lat, lng: fix.lng,
        acc: fix.accuracy == null ? null : Math.round(fix.accuracy),
        label: "", source: "gps",
      });
      closePicker();
    } catch (err) {
      pickMsg((err && err.message) || t("pmp_gps_failed", "Could not get your location."), "err");
      if (btn) { btn.disabled = false; btn.textContent = t("pmp_use_gps", "Use where I am now"); }
    }
  }

  /**
   * Another go at the fix, from the strip, with the picker already gone.
   *
   * KEEPS THE BETTER OF THE TWO. A second reading is usually tighter but not
   * always, and quietly replacing a 20m pin with an 80m one because the person
   * asked for an improvement would be a strange way to answer them. If it is
   * worse, the pin does not move and the strip says the old one is still the
   * one being sent.
   */
  async function retryGps() {
    if (!pendingPlace || pendingPlace.source !== "gps") return;
    var btn = document.getElementById("pmAttachRetry");
    if (btn) { btn.disabled = true; btn.textContent = t("pmp_locating", "Finding you…"); }
    var had = pendingPlace.acc;
    try {
      var fix = await getFix();
      var got = fix.accuracy == null ? null : Math.round(fix.accuracy);
      if (had != null && got != null && got >= had) {
        // Redraw first: drawAttach() rebuilds the strip, so a message written
        // before it would be wiped by the very next paint.
        drawAttach();
        var still = document.getElementById("pmAttachRetry");
        if (still) still.textContent = t("pmp_acc_kept", "Still the closest");
        return;
      }
      attachPlace({ lat: fix.lat, lng: fix.lng, acc: got, label: pendingPlace.label, source: "gps" });
    } catch (_) {
      drawAttach();
      var back = document.getElementById("pmAttachRetry");
      if (back) back.textContent = t("pmp_acc_failed", "Could not get a closer one");
    }
  }

  async function openPickedCode() {
    var input = document.getElementById("pmPickCode");
    var btn = document.getElementById("pmPickCodeGo");
    if (!input || !window.LocShare || !window.LocCode) {
      pickMsg(t("pmp_code_unavailable", "Codes are not available right now."), "err");
      return;
    }
    var problem = window.LocCode.problem(input.value);
    if (problem) { pickMsg(codeReason(problem), "err"); return; }
    btn.disabled = true;
    pickMsg(t("pmp_code_opening", "Opening…"));
    var r = await window.LocShare.open(input.value);
    btn.disabled = false;
    if (!r.ok) { pickMsg(codeReason(r.reason), "err"); return; }
    // Remembered on the way through: a code opens a limited number of times,
    // and losing the pin because the message was not sent would mean asking
    // the person to mint another one.
    var rec = { lat: r.place.lat, lng: r.place.lng, acc: r.place.acc,
                label: r.place.label || "", source: "code" };
    if (window.PlaceBook) window.PlaceBook.add(rec);
    attachPlace(rec);
    closePicker();
  }

  // Every one of these is an ordinary thing that happens to people, so each
  // gets a sentence rather than a code.
  function codeReason(reason) {
    return {
      short: t("pmp_r_short", "That is too short. A code is nine characters."),
      long: t("pmp_r_long", "That is too long. A code is nine characters."),
      chars: t("pmp_r_chars", "A code has no I, L, O or U in it. Check the letters."),
      check: t("pmp_r_check", "That code has a typo in it."),
      expired: t("pmp_r_expired", "That code has expired. Ask for a new one."),
      used_up: t("pmp_r_used", "That code has been opened as many times as it was allowed."),
      revoked: t("pmp_r_revoked", "Whoever made that code has withdrawn it."),
      not_found: t("pmp_r_notfound", "No such code."),
      rate_limited: t("pmp_r_rate", "Too many tries. Wait a moment."),
      signin: t("pmp_r_signin", "Sign in to open a code."),
      // Without this line the guest gate's own visitors — which is most of the
      // people who are handed a code — got "That did not work" and retyped it,
      // because nothing told them the account was the problem rather than the
      // characters.
      forbidden: t("pmp_r_forbidden", "You are here as a guest, and a code needs an account. Sign in, then open it."),
      offline: t("pmp_r_offline", "You are offline."),
    }[reason] || t("pmp_r_failed", "That did not work.");
  }

  /** The place a card's button is standing on, and who put it there. */
  function placeOfButton(btn) {
    var card = btn.closest ? btn.closest(".pm-place") : null;
    var d = (card && card.dataset) || btn.dataset;
    return {
      lat: Number(btn.dataset.plat),
      lng: Number(btn.dataset.plng),
      acc: btn.dataset.pacc ? Number(btn.dataset.pacc) : null,
      label: btn.dataset.plabel || "",
      from: d.pfrom || "",
      fromId: d.pfromid || "",
      guest: d.pguest === "1",
      msgId: d.pmid || "",
      at: d.pat ? (new Date(d.pat).getTime() || null) : null,
    };
  }

  // ---- the pin waiting to be sent ------------------------------------------
  function attachPlace(place) {
    pendingPlace = {
      lat: Number(place.lat), lng: Number(place.lng),
      acc: place.acc == null ? null : Math.round(Number(place.acc)),
      label: String(place.label || ""),
      source: place.source || "map",
    };
    drawAttach();
    if (el.pmInput && !el.pmInput.disabled) el.pmInput.focus();
  }

  function clearAttach() { pendingPlace = null; drawAttach(); }

  function drawAttach() {
    drawPlaceHint();
    if (!el.pmAttach) return;
    if (!pendingPlace) { el.pmAttach.hidden = true; el.pmAttach.innerHTML = ""; return; }
    // The heading names the destination rather than the action. "Sending a
    // place" described what the strip was; it did not say where the place was
    // about to go, which is the thing worth a second look before tapping send.
    var acc = accuracyNote(pendingPlace);
    el.pmAttach.innerHTML =
      '<span class="pm-at-tx"><b>' + esc(recipientLine()) + "</b>" +
      '<span class="pm-at-body">' +
        esc(pendingPlace.label || window.PlaceBook.coords(pendingPlace.lat, pendingPlace.lng)) +
      "</span>" +
      (acc
        ? '<span class="pm-at-acc' + (acc.coarse ? " is-coarse" : "") + '">' +
            esc(acc.coarse
              ? t("pmp_acc_coarse", "Roughly this area, within {n} m.", { n: acc.n })
              : t("pmp_acc_fine", "Exact to {n} m.", { n: acc.n })) +
            // Offered only when the phone is what produced the fix. Retrying a
            // pin somebody dragged on a map would silently move it off the
            // spot they chose, which is the opposite of helpful.
            (pendingPlace.source === "gps"
              ? ' <button class="pm-place-b" type="button" id="pmAttachRetry">' +
                  esc(t("pmp_acc_retry", "Try for a closer fix")) + "</button>"
              : "") +
          "</span>"
        : "") +
      "</span>" +
      // The way out of this conversation. Everything else on this strip sends
      // the pin down the thread that is open; this turns it into nine
      // characters that work for somebody who is not in it, and who may not be
      // on this site at all. See mintPlaceCode().
      '<button class="pm-place-b" type="button" id="pmAttachCode">' +
        esc(t("pmp_give_code", "Give a code")) + "</button>" +
      '<button class="pm-rb-x" type="button" id="pmAttachX" aria-label="' +
        esc(t("pmp_detach", "Do not send it")) + '">×</button>';
    el.pmAttach.hidden = false;
    var x = document.getElementById("pmAttachX");
    if (x) x.addEventListener("click", clearAttach);
    var mk = document.getElementById("pmAttachCode");
    if (mk) mk.addEventListener("click", function () { mintPlaceCode(pendingPlace); });
    var again = document.getElementById("pmAttachRetry");
    if (again) again.addEventListener("click", retryGps);
  }

  /**
   * The same pin, addressed to ANYBODY.
   *
   * A message reaches the person at the other end of the thread. A code reaches
   * whoever you can say nine characters to: on the phone, over WhatsApp, in a
   * shop, to somebody with no account and no intention of making one. That is
   * the gap this closes, and it is why the button sits on the attachment strip
   * rather than in the picker — by the time a pin is waiting there, the place
   * is settled and the only remaining question is who gets it.
   *
   * No second engine: js/lib/loc-share.js mints it, exactly as
   * share-location.html does. The coordinates are sealed under the code in this
   * browser before anything is uploaded, so the server stores ciphertext and
   * never the code. Losing the code loses the place, which is the point.
   */
  async function mintPlaceCode(place) {
    if (!place) return;
    if (!window.LocShare || !window.LocCode) {
      pickMsg(t("pmp_code_unavailable", "Codes are not available right now."), "err");
      return;
    }
    modal("<h2>" + esc(t("pmp_mk_t", "Give this place as a code")) + "</h2>" +
      "<p>" + esc(t("pmp_mk_d",
        "Nine characters anyone can type in, even without an account here. Read them out on the phone or send them however you like. We cannot read the place either.")) + "</p>" +
      '<div class="pm-pick-opts">' +
        '<label>' + esc(t("pmp_mk_ttl", "Works for")) +
          '<select id="pmMkTtl">' +
            '<option value="30">' + esc(t("pmp_mk_30", "30 minutes")) + "</option>" +
            '<option value="120" selected>' + esc(t("pmp_mk_120", "2 hours")) + "</option>" +
            '<option value="1440">' + esc(t("pmp_mk_1440", "24 hours")) + "</option>" +
          "</select></label>" +
        '<label>' + esc(t("pmp_mk_opens", "Can be opened")) +
          '<select id="pmMkOpens">' +
            '<option value="1" selected>' + esc(t("pmp_mk_o1", "once")) + "</option>" +
            '<option value="3">' + esc(t("pmp_mk_o3", "3 times")) + "</option>" +
            '<option value="10">' + esc(t("pmp_mk_o10", "10 times")) + "</option>" +
          "</select></label>" +
      "</div>" +
      '<button class="pm-btn" id="pmMkGo" type="button" style="width:100%;margin-top:11px">' +
        esc(t("pmp_mk_go", "Make the code")) + "</button>" +
      '<div class="pm-msg-out" id="pmMkOut"></div>' +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn ghost" id="pmMkClose" type="button">' + esc(t("pm_close", "Close")) + "</button>" +
      "</div>");

    document.getElementById("pmMkClose").addEventListener("click", closeModal);
    document.getElementById("pmMkGo").addEventListener("click", async function () {
      var go = this, out = document.getElementById("pmMkOut");
      go.disabled = true;
      out.className = "pm-msg-out";
      out.textContent = t("pmp_mk_making", "Making a code…");

      var res = await window.LocShare.create(
        { lat: place.lat, lng: place.lng, acc: place.acc, label: place.label || "" },
        { ttlMinutes: Number(document.getElementById("pmMkTtl").value) || 120,
          maxOpens: Number(document.getElementById("pmMkOpens").value) || 1 });

      if (!res.ok) {
        go.disabled = false;
        out.className = "pm-msg-out bad";
        out.textContent = mintReason(res.reason);
        return;
      }

      var pretty = window.LocCode.format(res.share.code);
      go.hidden = true;
      out.className = "pm-msg-out good";
      out.innerHTML =
        '<div class="pm-code-big">' + esc(pretty) + "</div>" +
        "<p>" + esc(t("pmp_mk_say",
          "Read these to them. O is the number zero; I and L are the number one.")) + "</p>" +
        '<button class="pm-btn" id="pmMkCopy" type="button" style="width:100%">' +
          esc(t("pmp_mk_copy", "Copy the code")) + "</button>";
      document.getElementById("pmMkCopy").addEventListener("click", function () {
        var self = this;
        try { navigator.clipboard.writeText(pretty); } catch (_) {}
        self.textContent = t("pmp_mk_copied", "Copied");
      });
    });
  }

  /** Why a code could not be minted, as the ordinary thing it is. */
  function mintReason(reason) {
    return {
      offline: t("pmp_mk_r_offline", "No connection. Try again when you are back online."),
      busy: t("pmp_mk_r_busy", "Too many codes at once. Wait a moment and try again."),
      exhausted: t("pmp_mk_r_exhausted", "Codes are unavailable right now. Send the pin in the message instead."),
      ticket: t("pmp_mk_r_ticket", "That attempt timed out. Tap it again."),
      signin: t("pmp_mk_r_signin", "Sign in to make a code."),
    }[reason] || t("pmp_mk_r_failed", "Could not make a code. Send the pin in the message instead.");
  }

  /**
   * The same pin, said on the list instead of in the composer.
   *
   * The attachment strip lives inside the conversation. A place arriving on a
   * link has no conversation yet — that is the whole point, somebody has to
   * choose one — so without this the app would be holding a pin with nothing
   * on screen admitting it.
   */
  function drawPlaceHint() {
    if (!el.pmPlaceHint) return;
    if (!pendingPlace) {
      el.pmPlaceHint.hidden = true;
      el.pmPlaceHint.innerHTML = "";
      return;
    }
    el.pmPlaceHint.innerHTML = "<b>" + esc(t("pmp_pick_who", "Choose who to send this place to.")) + "</b><br>" +
      esc(pendingPlace.label || window.PlaceBook.coords(pendingPlace.lat, pendingPlace.lng)) +
      ' <button class="pm-place-b" type="button" id="pmHintDrop" style="margin-left:6px">' +
      esc(t("pmp_detach", "Do not send it")) + "</button>";
    el.pmPlaceHint.hidden = false;
    var drop = document.getElementById("pmHintDrop");
    if (drop) drop.addEventListener("click", clearAttach);
  }

  // ---- opening one somebody sent -------------------------------------------
  var sheetMap = null, sheetPlace = null;

  function openPlaceMap(place) {
    sheetPlace = place;
    if (!el.pmMapSheet) return;
    el.pmMapSheet.classList.add("is-on");
    el.pmMapSheet.setAttribute("aria-hidden", "false");
    if (el.pmMapName) {
      el.pmMapName.textContent = place.label || t("pmp_a_place", "A place");
    }
    if (el.pmMapSub) {
      el.pmMapSub.textContent = window.PlaceBook.coords(place.lat, place.lng) +
        (place.acc ? "  ~" + place.acc + " m" : "");
    }
    drawSheetActs();
    mountSheetMap(place);
  }

  function closePlaceMap() {
    if (sheetMap) { try { sheetMap.remove(); } catch (_) {} sheetMap = null; }
    sheetPlace = null;
    if (!el.pmMapSheet) return;
    el.pmMapSheet.classList.remove("is-on");
    el.pmMapSheet.setAttribute("aria-hidden", "true");
  }

  function mountSheetMap(place) {
    var host = el.pmMapCanvas;
    if (!host || !window.L) return;
    if (sheetMap) { try { sheetMap.remove(); } catch (_) {} sheetMap = null; }
    sheetMap = window.L.map(host, { scrollWheelZoom: true, attributionControl: false })
      .setView([place.lat, place.lng], 17);
    if (window.addSatelliteHybrid) window.addSatelliteHybrid(sheetMap);
    else window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(sheetMap);
    window.L.marker([place.lat, place.lng]).addTo(sheetMap);
    // Accuracy drawn rather than stated: "within 80 m" is a number, and a
    // circle the size of the block is the same fact in a form somebody can
    // act on.
    if (place.acc && place.acc > 0) {
      // The ring takes the page's own brand green rather than a literal, so it
      // follows the theme. It used to be the dark theme's neon green written
      // out, and the palette block at the top of p-message.html says why that
      // is wrong in as many words: that green on white measures 1.5:1, a
      // decoration rather than a mark. The light theme moves --pm-brand to a
      // dark green for exactly that reason, and a colour set from JavaScript
      // was the one place the cascade could not follow it, so the accuracy
      // ring stayed neon on a white map.
      //
      // Read off document.body, NOT :root: this page declares its palette on
      // body[data-page="p-message"], and getPropertyValue on the wrong element
      // returns "" and falls back without saying so.
      // The fallback is currentColor rather than a written-out green: if the
      // token ever fails to resolve, inheriting the page's ink is wrong-looking
      // but always legible, whereas a hardcoded neon is invisible in exactly
      // the theme this change exists to fix.
      var ring = getComputedStyle(document.body)
        .getPropertyValue("--pm-brand").trim() || "currentColor";
      window.L.circle([place.lat, place.lng], {
        radius: place.acc, color: ring, weight: 1, fillOpacity: 0.1,
      }).addTo(sheetMap);
    }
    setTimeout(function () { try { sheetMap.invalidateSize(); } catch (_) {} }, 120);
  }

  /**
   * What can be done with a pin once it is on screen.
   *
   * "Open in Explore" is the one that answers the request behind this whole
   * feature: a place received in a conversation should be usable on the map
   * tab exactly like any other place, with the catalogue around it — what is
   * for rent near this gate, who works this ward.
   */
  function drawSheetActs() {
    if (!el.pmMapActs || !sheetPlace) return;
    var p = sheetPlace;
    var saved = window.PlaceBook && window.PlaceBook.list().some(function (q) {
      return Math.abs(q.lat - p.lat) < 0.00015 && Math.abs(q.lng - p.lng) < 0.00015;
    });
    el.pmMapActs.innerHTML =
      '<button class="pm-place-b is-go" type="button" id="pmMapExplore">' +
        esc(t("pmp_in_explore", "Open on the map tab")) + "</button>" +
      '<button class="pm-place-b" type="button" id="pmMapSave"' + (saved ? " disabled" : "") + ">" +
        esc(saved ? t("pmp_saved", "Saved") : t("pmp_save", "Save this pin")) + "</button>" +
      '<a class="pm-place-b" href="' + esc(window.PMPlace.mapsUrl(p.lat, p.lng)) +
        '" target="_blank" rel="noopener">' + esc(t("pmp_in_maps", "Open in maps app")) + "</a>";

    document.getElementById("pmMapExplore").addEventListener("click", function () {
      // Saved on the way out. Explore is a different page, and a pin that
      // vanished when you walked to the map would be the one thing this
      // feature exists to prevent.
      savePlace(p);
      location.href = "explore.html?view=map&at=" +
        encodeURIComponent(Number(p.lat).toFixed(6) + "," + Number(p.lng).toFixed(6)) +
        (p.label ? "&label=" + encodeURIComponent(p.label.slice(0, 60)) : "");
    });
    document.getElementById("pmMapSave").addEventListener("click", function () {
      savePlace(p);
      drawSheetActs();
    });
  }

  /**
   * Keep a pin.
   *
   * On the device and nowhere else. loc_share goes to real lengths to keep
   * coordinates unreadable to the server; writing an opened one back to a
   * table we can read would undo all of it in a line. place-book.js is the
   * list, and the listing forms read it — which is how a pin received in a
   * conversation becomes a pin on a house.
   */
  /**
   * "Save this pin" — into the device's book, with everything about where it
   * came from.
   *
   * `source` is 'pm' and not 'chat': the listing form has a word for each way
   * a location can arrive and shows it beside the row, and a source nothing
   * recognises was being drawn as "pasted from a link" — which is what a pin
   * somebody stood on and sent looked like at the exact moment the difference
   * mattered. The sender's name and account travel with it for the same
   * reason: three pages later, "exactly as Amina sent it" has to still be a
   * checkable claim rather than a memory.
   */
  function savePlace(place) {
    if (!window.PlaceBook) return;
    window.PlaceBook.add({
      lat: place.lat, lng: place.lng, acc: place.acc,
      label: place.label || "",
      source: "pm",
      from: place.from || (openThread() && openThread().kind === "direct" ? openThread().name : "") || "",
      fromId: place.fromId || "",
      guest: !!place.guest,
      msgId: place.msgId || "",
      threadId: (openThread() && openThread().threadId) || "",
      threadName: (openThread() && openThread().name) || "",
      at: place.at || Date.now(),
    });
  }

  window.PMPlaceUI = {
    attach: attach,
    pick: showPlacePicker,
    attachPlace: attachPlace,
    clear: clearAttach,
    openMap: openPlaceMap,
    closeMap: closePlaceMap,
    save: savePlace,
    placeOf: placeOfButton,
    // A getter, not the value: the composer asks on every submit and the
    // answer changes under it.
    pending: function () { return pendingPlace; },
  };
})();
