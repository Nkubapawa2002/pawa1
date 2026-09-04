// ============================================================================
//  place-doors.js — the doors a location can arrive through.
//
//  WHY THIS EXISTS
//  A pin used to have three sources and all three needed the person listing to
//  be standing on it: drag it, use GPS, or send a link and wait by the screen.
//  But the location usually already exists. Somebody stood at that gate, that
//  workshop, that yard, and shared it — as nine characters read down a phone
//  call, or as a map link dropped into a P-Message thread in the middle of a
//  conversation about something else.
//
//  agent-houses.html grew these doors first and they made the difference
//  between a listing an agent can post from a bus and one that needs a trip.
//  agent-services.html and agent-trucks.html had none of them: a fundi with no
//  smartphone at the workshop, or an owner whose lorry lives at a yard across
//  town, had no way in at all. This file is that page's doors, lifted out and
//  made to work on any form and with any map library.
//
//  THREE DOORS, ONE DESTINATION:
//
//    1. a code somebody read you, or a link somebody sent  (LocShare/LocCode)
//    2. pins already sitting in your P-Message threads     (PMPlaces)
//    3. ask somebody who is there right now to send it     (meet_rooms)
//
//  plus the book of everything this device has already been given
//  (js/lib/place-book.js), which is not a fourth door but the memory of the
//  other three.
//
//  HOW TO USE IT
//
//      const doors = PlaceDoors.mount({
//        into:    document.getElementById("asLocDoors"),
//        sb:      supabaseClient,          // only door 3 needs this
//        purpose: "service_pin",           // meet_rooms.purpose
//        title:   () => titleInput.value,  // labels a requested pin, optional
//        current: () => pin,               // {lat,lng} or null, for "is-on"
//        onPick:  (place) => { … },        // YOU move your own marker here
//      });
//
//  The caller owns its map. This file never touches one, which is the whole
//  reason it can serve a MapLibre page and two Leaflet pages at once.
//
//  It reads and never writes anything of the user's: no key is minted, no
//  message is marked read, no thread is touched. See pm-places.js for why that
//  matters more than it sounds.
//
//  The i18n keys are the ah_* ones this flow was born with. The prefix is a
//  namespace artefact, not a claim that the words are about houses; renaming
//  forty keys across two languages to fix a prefix would be a translation pass
//  for nothing.
//
//  Styled by: css/place-doors.css
// ============================================================================
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /** t() with the key as its own last resort, which is what window.t does. */
  function tr(key) {
    try { return window.t ? window.t(key) : key; } catch (_) { return key; }
  }

  var IC = {
    card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10h4M7 14h8"/>',
    chat: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4L3 21l1.1-3.6A8.4 8.4 0 1 1 21 11.5z"/>',
    ask:  '<path d="M4 12a8 8 0 0 1 16 0"/><path d="M12 21v-5"/><circle cx="12" cy="12" r="2"/><path d="m8.5 8.5-2-2M15.5 8.5l2-2"/>',
    pin:  '<path d="M12 21s-7-5.5-7-10.5A7 7 0 0 1 19 10.5C19 15.5 12 21 12 21z"/><circle cx="12" cy="10.3" r="2.4"/>',
  };
  function svg(paths, size) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"' +
      ' stroke-linecap="round" stroke-linejoin="round"' +
      (size ? ' width="' + size + '" height="' + size + '"' : "") + ">" + paths + "</svg>";
  }
  var CHEV =
    '<span class="pd-acc__chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"' +
    ' stroke="currentColor" stroke-width="2" stroke-linecap="round"' +
    ' stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>';

  function door(icon, title, sub, body) {
    return '<details class="pd-acc"><summary>' +
      '<span class="pd-acc__ic" aria-hidden="true">' + svg(icon) + "</span>" +
      '<span class="pd-acc__tx"><span>' + esc(title) + "</span>" +
      (sub ? "<small>" + esc(sub) + "</small>" : "") + "</span>" +
      CHEV + "</summary>" +
      '<div class="pd-acc__body">' + body + "</div></details>";
  }

  // How a place arrived, in a word. "Somebody standing there sent this" and "I
  // typed it into a search box" are different kinds of evidence, and whoever
  // is choosing a row is entitled to know which one they are looking at.
  function sourceWord(source) {
    return tr({
      code: "ah_loc_src_code", link: "ah_loc_src_link", gps: "ah_loc_src_gps",
      request: "ah_loc_src_request", map: "ah_loc_src_map",
      pm: "ah_loc_src_pm", chat: "ah_loc_src_pm",
    }[source] || "ah_loc_src_link");
  }

  function agoWords(ms) {
    var mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 1) return tr("ah_ago_now");
    if (mins < 60) return tr("ah_ago_min").replace("{n}", mins);
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return tr("ah_ago_hr").replace("{n}", hrs);
    return tr("ah_ago_day").replace("{n}", Math.round(hrs / 24));
  }

  // Why a code cannot be used, said as the ordinary thing it is. Every one of
  // these happens to real people and none of them is a fault the agent caused.
  function codeReason(reason) {
    var key = {
      short: "ah_loc_r_short", long: "ah_loc_r_long", chars: "ah_loc_r_chars",
      check: "ah_loc_r_check", expired: "ah_loc_r_expired", used_up: "ah_loc_r_used",
      revoked: "ah_loc_r_revoked", not_found: "ah_loc_r_notfound",
      rate_limited: "ah_loc_r_rate", signin: "ah_loc_r_signin", offline: "ah_loc_r_offline",
    }[reason];
    return key ? tr(key) : tr("ah_loc_r_failed");
  }

  // Why there is nothing to show. "Unavailable" would send somebody hunting
  // for a fault that is not there.
  function pmReason(reason) {
    return tr({
      no_crypto: "ah_pm_r_nocrypto", locked: "ah_pm_r_locked", no_key: "ah_pm_r_nokey",
      signed_out: "ah_pm_r_signin", offline: "ah_pm_r_offline", empty: "ah_pm_r_empty",
    }[reason] || "ah_pm_r_failed");
  }

  function randomMeetCode() {
    var A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", s = "";
    for (var i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }

  // ==========================================================================
  function mount(opts) {
    var o = opts || {};
    var root = o.into;
    if (!root) return null;

    var sb = o.sb || (window.DataStore && window.DataStore.sb) || null;
    var current = typeof o.current === "function" ? o.current : function () { return null; };
    var onPick = typeof o.onPick === "function" ? o.onPick : function () {};

    root.classList.add("pd");
    root.innerHTML =
      door(IC.card, tr("ah_loc_h"), tr("ah_loc_sub_short"),
        '<p class="pd-hint">' + esc(tr("ah_loc_sub")) + "</p>" +
        '<div class="pd-row">' +
          '<input class="pd-code" data-pd="code" type="text" inputmode="latin" autocomplete="off"' +
          ' spellcheck="false" maxlength="13" placeholder="K7M-2Q9-F3T"' +
          ' aria-label="' + esc(tr("ah_loc_code_aria")) + '">' +
          '<button type="button" class="pd-btn pd-btn--brand" data-pd="open">' + esc(tr("ah_loc_open")) + "</button>" +
        "</div>" +
        '<div class="pd-row">' +
          '<input data-pd="paste" type="text" autocomplete="off" placeholder="' +
            esc(tr("ah_loc_paste_ph")) + '" aria-label="' + esc(tr("ah_loc_paste_aria")) + '">' +
          '<button type="button" class="pd-btn" data-pd="pasteGo">' + esc(tr("ah_loc_paste_go")) + "</button>" +
        "</div>" +
        '<p class="pd-msg" data-pd="locMsg" role="status" aria-live="polite"></p>' +
        '<div class="pd-list" data-pd="book"></div>' +
        '<p class="pd-hint" data-pd="howto"></p>') +

      door(IC.chat, tr("ah_pm_h"), tr("ah_pm_sub"),
        '<div class="pd-head"><h6>' + esc(tr("ah_pm_lead")) + "</h6>" +
          '<button type="button" class="pd-btn" data-pd="pmScan">' + esc(tr("ah_pm_scan")) + "</button></div>" +
        '<p class="pd-msg" data-pd="pmMsg" role="status" aria-live="polite"></p>' +
        '<div class="pd-list" data-pd="pmList"></div>') +

      door(IC.ask, tr("ah_remote_summary"), tr("ah_remote_sub"),
        '<div class="pd-row"><button type="button" class="pd-btn pd-btn--brand" data-pd="req">' +
          esc(tr("ah_remote_btn")) + "</button></div>" +
        '<div data-pd="reqBox" hidden>' +
          '<p class="pd-hint">' + esc(tr("ah_remote_hint")) + "</p>" +
          '<div class="pd-row">' +
            '<input data-pd="reqLink" readonly aria-label="' + esc(tr("ah_remote_link_aria")) + '">' +
            '<button type="button" class="pd-btn pd-btn--brand" data-pd="reqCopy">' + esc(tr("ah_remote_copy")) + "</button>" +
            '<a class="pd-btn" data-pd="reqWa" target="_blank" rel="noopener">' + esc(tr("ah_remote_wa")) + "</a>" +
          "</div>" +
          '<p class="pd-msg ok" data-pd="reqStatus" role="status" aria-live="polite"></p>' +
        "</div>");

    var el = {};
    root.querySelectorAll("[data-pd]").forEach(function (n) { el[n.dataset.pd] = n; });

    // The "send them this page" line carries a link, so it is the one string
    // here that has to go in as markup rather than text.
    if (el.howto) el.howto.innerHTML = tr("ah_loc_howto");

    function locMsg(text, kind) {
      if (!el.locMsg) return;
      el.locMsg.textContent = text || "";
      el.locMsg.className = "pd-msg" + (kind ? " " + kind : "");
    }
    function pmMsg(text, kind) {
      if (!el.pmMsg) return;
      el.pmMsg.textContent = text || "";
      el.pmMsg.className = "pd-msg" + (kind ? " " + kind : "");
    }

    /**
     * The one place a chosen location leaves this module.
     *
     * A code, a paste, a chat pin and a request all end here, so "the pin
     * moved" means exactly one thing however it happened, and the caller gets
     * one callback instead of four that each forget a different step.
     */
    function use(place, remember) {
      var lat = Number(place.lat), lng = Number(place.lng);
      if (!isFinite(lat) || !isFinite(lng)) return;
      if (remember !== false && window.PlaceBook) window.PlaceBook.add(place);
      onPick(place);
      drawBook();
    }

    function isCurrent(p) {
      var c = current();
      return !!c && c.lat != null &&
        Math.abs(c.lat - p.lat) < 0.00015 && Math.abs(c.lng - p.lng) < 0.00015;
    }

    function placeRow(title, detail, on) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pd-place" + (on ? " is-on" : "");
      b.innerHTML =
        '<span class="pd-place__ic" aria-hidden="true">' + svg(IC.pin, 17) + "</span>" +
        '<span class="pd-place__tx"><span class="pd-place__t">' + esc(title) + "</span>" +
        '<span class="pd-place__d">' + detail + "</span></span>";
      return b;
    }

    // ---- the book: everything this device has already been given -----------
    function drawBook() {
      if (!el.book || !window.PlaceBook) return;
      var rows = window.PlaceBook.list().slice(0, 8);
      el.book.innerHTML = "";
      if (!rows.length) return;
      var lead = document.createElement("p");
      lead.className = "pd-lead";
      lead.textContent = tr("ah_loc_book_lead");
      el.book.appendChild(lead);
      rows.forEach(function (p) {
        var b = placeRow(
          p.label || window.PlaceBook.coords(p.lat, p.lng),
          esc(sourceWord(p.source)) + (p.from ? " · " + esc(p.from) : "") + " · " + esc(agoWords(p.at)),
          isCurrent(p));
        b.addEventListener("click", function () {
          use(p, false);
          locMsg(tr("ah_loc_ok"), "ok");
        });
        el.book.appendChild(b);
      });
    }

    // ---- door 1: a code, or anything a chat carried ------------------------
    if (el.code && window.LocCode) {
      // K7M2Q9F3T typed straight through still reads back as K7M-2Q9-F3T,
      // because the person on the phone is reading it in threes and the box
      // should agree with them.
      el.code.addEventListener("input", function () {
        var c = window.LocCode.normalize(el.code.value);
        var atEnd = el.code.selectionStart === el.code.value.length;
        el.code.value = c.length === window.LocCode.CODE_LEN
          ? window.LocCode.format(c)
          : c.replace(/(.{3})(?=.)/g, "$1-");
        if (atEnd) el.code.setSelectionRange(el.code.value.length, el.code.value.length);
      });
      el.code.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); el.open && el.open.click(); }
      });
    }

    el.open && el.open.addEventListener("click", async function () {
      if (!window.LocShare || !window.LocCode) { locMsg(tr("ah_loc_unavailable"), "err"); return; }
      var raw = (el.code.value || "").trim();
      var problem = window.LocCode.problem(raw);
      if (problem) { locMsg(codeReason(problem), "err"); return; }
      el.open.disabled = true;
      locMsg(tr("ah_loc_opening"));
      try {
        var r = await window.LocShare.open(raw);
        if (!r.ok) { locMsg(codeReason(r.reason), "err"); return; }
        use({
          lat: r.place.lat, lng: r.place.lng, acc: r.place.acc,
          label: r.place.label || "", source: "code", from: window.LocCode.format(raw),
        });
        el.code.value = "";
        locMsg(tr("ah_loc_ok"), "ok");
      } catch (err) {
        console.warn("[place-doors] code open failed", err);
        locMsg(tr("ah_loc_r_failed"), "err");
      } finally {
        el.open.disabled = false;
      }
    });

    /**
     * Whatever a chat carried.
     *
     * A code goes to the code box and opens itself; anything with coordinates
     * in it pins directly. Both are one paste, because somebody copying a
     * message out of P-Message does not know or care which of the two it is.
     */
    function applyPaste(text) {
      if (!window.PlaceBook) return;
      var code = window.PlaceBook.codeIn(text);
      if (code && window.LocCode && el.code) {
        el.code.value = window.LocCode.format(code);
        el.paste.value = "";
        el.open && el.open.click();
        return;
      }
      var hit = window.PlaceBook.parse(text);
      if (!hit) { locMsg(tr("ah_loc_unreadable"), "err"); return; }
      use({ lat: hit.lat, lng: hit.lng, acc: null, label: hit.label, source: "link" });
      el.paste.value = "";
      locMsg(hit.outside ? tr("ah_loc_outside") : tr("ah_loc_ok"), hit.outside ? "err" : "ok");
    }

    el.pasteGo && el.pasteGo.addEventListener("click", function () { applyPaste(el.paste.value); });
    el.paste && el.paste.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); applyPaste(el.paste.value); }
    });

    // ---- door 2: pins still sitting in a conversation ----------------------
    function drawPm(res) {
      if (!el.pmList) return;
      el.pmList.innerHTML = "";
      if (!res) return;
      if (!res.ok || !res.places.length) { pmMsg(pmReason(res.reason), "err"); return; }
      pmMsg("");
      res.places.slice(0, 8).forEach(function (p) {
        // The words first. "The blue gate, second house" is the half a person
        // wrote; six decimal places are only worth reading when there is
        // nothing else, and they stand in when there is not.
        var who = p.fromName || tr("ah_seal_someone");
        var where = (p.threadKind === "group" && p.threadName)
          ? tr("ah_pm_in_room").replace("{room}", p.threadName)
          : tr("ah_pm_in_chat");
        var detail = esc(who) +
          (p.fromGuest ? ' <span class="pd-guest">' + esc(tr("ah_pm_guest")) + "</span>" : "") +
          " · " + esc(where) + " · " + esc(agoWords(p.at)) +
          (p.acc ? " · " + esc(tr("ah_seal_within").replace("{n}", p.acc)) : "");
        var b = placeRow(p.label || window.PlaceBook.coords(p.lat, p.lng), detail, isCurrent(p));
        b.addEventListener("click", function () {
          use({
            lat: p.lat, lng: p.lng, acc: p.acc, label: p.label,
            source: "pm", from: p.fromName, fromId: p.fromId, guest: p.fromGuest,
            threadId: p.threadId, threadName: p.threadName, msgId: p.msgId, at: p.at,
          });
          locMsg(p.outside ? tr("ah_loc_outside") : tr("ah_loc_ok"), p.outside ? "err" : "ok");
        });
        el.pmList.appendChild(b);
      });
    }

    var pmScanning = false;
    async function scanPm(opt) {
      var oo = opt || {};
      if (!window.PMPlaces || !el.pmList || pmScanning) return;
      // Silence on a device that has never opened P-Message and was not asked
      // to look. This panel is about locations somebody sent; an agent who has
      // never used the messenger is owed nothing here until they press it.
      if (!oo.loud && window.PMPlaces.available()) return;
      pmScanning = true;
      if (el.pmScan) el.pmScan.disabled = true;
      pmMsg(tr("ah_pm_looking"));
      try {
        drawPm(await window.PMPlaces.scan({ refresh: !!oo.refresh }));
      } catch (err) {
        console.warn("[place-doors] p-message scan failed", err);
        pmMsg(tr("ah_pm_r_failed"), "err");
      } finally {
        pmScanning = false;
        if (el.pmScan) el.pmScan.disabled = false;
      }
    }
    el.pmScan && el.pmScan.addEventListener("click", function () {
      scanPm({ loud: true, refresh: true });
    });

    // ---- door 3: ask somebody who is there right now -----------------------
    // Reuses the meet room and live_locations realtime infrastructure: this
    // side makes a link, the person there taps "Share my location" on
    // share-location.html, and the pin arrives without either of them typing
    // a coordinate.
    var reqChannel = null, reqPoll = null;
    function reqCleanup() {
      if (reqChannel) { try { sb.removeChannel(reqChannel); } catch (_) {} reqChannel = null; }
      if (reqPoll) { clearInterval(reqPoll); reqPoll = null; }
    }
    function reqApply(row) {
      if (!row || !isFinite(+row.lat) || !isFinite(+row.lng)) return;
      use({
        lat: +row.lat, lng: +row.lng, acc: row.accuracy_m || null,
        label: (typeof o.title === "function" && o.title()) || "",
        source: "request", from: row.display_name || "",
      });
      if (el.reqStatus) el.reqStatus.textContent = tr("ah_remote_got");
      reqCleanup();
    }

    el.req && el.req.addEventListener("click", async function () {
      if (!sb) { if (el.reqStatus) el.reqStatus.textContent = tr("ah_remote_failed"); return; }
      el.req.disabled = true;
      try {
        var code = randomMeetCode();
        var ins = await sb.from("meet_rooms")
          .insert({ code: code, purpose: o.purpose || "listing_pin", created_by: "agent" });
        if (ins.error) throw ins.error;
        var base = location.origin + location.pathname.replace(/[^/]*$/, "");
        var link = base + "share-location.html?c=" + code;
        el.reqBox.hidden = false;
        el.reqLink.value = link;
        el.reqWa.href = "https://wa.me/?text=" +
          encodeURIComponent(tr("ah_remote_wa_text") + " " + link);
        if (el.reqStatus) el.reqStatus.textContent = tr("ah_remote_waiting");
        reqCleanup();
        reqChannel = sb.channel("listing_pin_" + code)
          .on("postgres_changes",
            { event: "*", schema: "public", table: "live_locations", filter: "room_code=eq." + code },
            function (m) { reqApply(m["new"]); })
          .subscribe();
        // A poll behind the socket, because realtime is not enabled on every
        // project and a pin that never arrives looks like the other person's
        // fault rather than a switch nobody flipped.
        reqPoll = setInterval(async function () {
          var r = await sb.from("live_locations")
            .select("lat,lng,accuracy_m,display_name").eq("room_code", code)
            .order("last_seen", { ascending: false }).limit(1);
          if (r.data && r.data[0]) reqApply(r.data[0]);
        }, 4000);
      } catch (e) {
        console.warn("[place-doors] location request failed", e);
        if (el.reqStatus) el.reqStatus.textContent = tr("ah_remote_failed");
      } finally {
        el.req.disabled = false;
      }
    });

    el.reqCopy && el.reqCopy.addEventListener("click", function () {
      el.reqLink.select();
      if (navigator.clipboard) navigator.clipboard.writeText(el.reqLink.value).catch(function () {});
      var was = el.reqCopy.textContent;
      el.reqCopy.textContent = tr("ah_remote_copied");
      setTimeout(function () { el.reqCopy.textContent = was; }, 1500);
    });

    drawBook();
    scanPm({});

    return {
      refresh: function () { drawBook(); },
      scan: function () { return scanPm({ loud: true, refresh: true }); },
      destroy: reqCleanup,
    };
  }

  window.PlaceDoors = { mount: mount };
})();
