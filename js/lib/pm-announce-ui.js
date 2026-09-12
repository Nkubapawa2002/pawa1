// ============================================================================
//  pm-announce-ui.js — the two dialogs that reach more than one person.
//
//  Split out of js/pages/p-message.js, which had grown to 4053 lines and was
//  nine features in one closure. Nothing here changed in the move; what moved
//  is the boundary, and the boundary is the point: these two dialogs share a
//  shape (compose something, choose an audience with the one picker, send once,
//  report honestly) and they share nothing else with the inbox or the thread.
//
//  AN ANNOUNCEMENT CANNOT BE TAKEN BACK AND CANNOT BE EDITED, so it has always
//  shown who it would reach before the send button meant anything. It used to
//  do that in two steps: choose a scope, press "Who would get this?", read a
//  count. All of that machinery existed to keep the preview and the send the
//  same question, and it could still be got wrong -- change a select after
//  previewing and the screen said one thing while the array said another.
//
//  The basket removes the class of bug rather than defending against it. What
//  is on screen IS the array: no scope to re-resolve, nothing to go stale, and
//  no button to forget to press. Do not reintroduce a scope here.
//
//  A ROOM IS NOT AN ANNOUNCEMENT and the copy must keep saying so. An
//  announcement is one-way and its recipients cannot reply into it; a room is
//  two-way and its members can answer and leave. That difference is why the
//  database fences them with two different predicates (pm_may_cast_to and the
//  wider pm_may_room_with), and why the picker is mounted in two modes.
//
//  A room used to be DESCRIBED rather than chosen: a category, a region, and
//  whoever that caught. pm_group_create has ALWAYS taken an explicit list of
//  ids and never re-checked them against either select, so the database was
//  ready for a hand-picked room long before the screen was. The two selects
//  are still here, inside the picker, as a way of NARROWING a search -- never
//  as the definition of the room. Which is why the room's stored region and
//  category are no longer written from them: they were a label that could
//  quietly disagree with the membership, and a label that can lie is worse
//  than no label.
// ============================================================================
(function () {
  "use strict";

  // Handed in by the page. Read at CALL time, never destructured at attach
  // time: the page assigns several of these after it attaches, and a captured
  // copy would be undefined with no error to say so.
  var ctx = {};

  var t = function (k, f) { return f || k; };
  var esc = function (s) { return String(s == null ? "" : s); };

  /** Same shape PMBlock.attach and PMIdentityUI.attach take. */
  function attach(o) {
    ctx = o || {};
    if (ctx.t) t = ctx.t;
    if (ctx.esc) esc = ctx.esc;
  }

  var modal = function (html) { if (ctx.modal) ctx.modal(html); };
  var closeModal = function () { if (ctx.closeModal) ctx.closeModal(); };
  var refreshInbox = function () {
    return ctx.refreshInbox ? ctx.refreshInbox() : Promise.resolve();
  };

  // ---- announce ------------------------------------------------------------

  function announce() {
    var picker = null;

    modal("<h2>" + esc(t("pm_cast_t", "Announce")) + "</h2>" +
      "<p>" + esc(t("pm_cast_d2", "One message to the people you choose. It is encrypted to each of them individually, one sealed copy per person, so it stays unreadable to everyone else including us. They cannot reply into it.")) + "</p>" +
      "<label>" + esc(t("pm_cast_title", "Title")) + '</label><input id="pmCastTitle" maxlength="80" />' +
      "<label>" + esc(t("pm_cast_body", "Message")) + '</label><textarea id="pmCastBody"></textarea>' +
      "<label>" + esc(t("pm_cast_who2", "Who it goes to")) + "</label>" +
      '<div id="pmCastPick"></div>' +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn" id="pmCastGo" disabled>' + esc(t("pm_cast_send", "Send")) + "</button>" +
        '<button class="pm-btn ghost" id="pmCastCancel">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
      "</div><div class=\"pm-msg-out\" id=\"pmCastMsg\"></div>");

    var out = document.getElementById("pmCastMsg");
    var go = document.getElementById("pmCastGo");

    picker = window.PMPeoplePicker.mount(document.getElementById("pmCastPick"), {
      mode: "cast",
      onChange: function (n) {
        go.disabled = n === 0;
        go.textContent = n
          ? t("pm_cast_send_n", "Send to {n}", { n: n })
          : t("pm_cast_send", "Send");
      },
    });

    document.getElementById("pmCastCancel").addEventListener("click", closeModal);

    go.addEventListener("click", async function (e) {
      var btn = e.currentTarget;      // captured, never read after an await
      var body = document.getElementById("pmCastBody").value.trim();
      if (!body) {
        out.className = "pm-msg-out bad";
        out.textContent = t("pm_cast_empty", "Write something first.");
        return;
      }
      // Everyone in the basket who can actually be sealed to. A row with no
      // public key is drawn and explained rather than hidden, so it can be in
      // the basket and still not be a recipient.
      var audience = picker.rows().filter(function (p) { return p.public_key; });
      if (!audience.length) {
        out.className = "pm-msg-out bad";
        out.textContent = t("pm_cast_nokeys", "Nobody you chose has set up P-Message on a device yet.");
        return;
      }
      btn.disabled = true;
      out.className = "pm-msg-out";
      try {
        var res = await window.PMStore.broadcast({
          title: document.getElementById("pmCastTitle").value.trim() || null,
          text: body,
          // The very list that is on screen, not a scope that would be asked
          // about a second time.
          members: audience,
          // Sealing a thousand copies is seconds of CPU; a screen that looks
          // frozen gets tapped again, and then it is sent twice.
          onProgress: function (p) {
            out.textContent = p.phase === "sealing"
              ? t("pm_cast_sealing", "Encrypting for {n} people…", { n: p.total })
              : t("pm_cast_sending", "Sending…");
          },
        });
        out.className = "pm-msg-out good";
        out.textContent = t("pm_cast_ok", "Sent to {n} people.", { n: res.reached });
        await refreshInbox();
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) === "NOBODY_REACHABLE"
          ? t("pm_cast_nokeys", "Nobody you chose has set up P-Message on a device yet.")
          : ((err && err.message) || String(err));
        btn.disabled = false;
      }
    });
  }

  // ---- a room --------------------------------------------------------------

  function room() {
    var picker = null;

    modal("<h2>" + esc(t("pm_room_t", "Open a room")) + "</h2>" +
      "<p>" + esc(t("pm_room_d", "Everyone you put in the room can talk to each other, encrypted to each member individually. Announcements are one-way; a room is not.")) + "</p>" +
      "<label>" + esc(t("pm_room_name", "Name of the room")) + '</label><input id="pmRoomTitle" maxlength="80" />' +
      "<label>" + esc(t("pm_room_people", "Who is in it")) + "</label>" +
      '<div id="pmRoomPick"></div>' +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn" id="pmRoomGo" disabled>' + esc(t("pm_room_open", "Open room")) + "</button>" +
        '<button class="pm-btn ghost" id="pmRoomCancel">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
      "</div><div class=\"pm-msg-out\" id=\"pmRoomMsg\"></div>");

    var out = document.getElementById("pmRoomMsg");
    var go = document.getElementById("pmRoomGo");

    picker = window.PMPeoplePicker.mount(document.getElementById("pmRoomPick"), {
      mode: "room",
      onChange: function (n) {
        go.disabled = n === 0;
        go.textContent = n
          ? t("pm_room_open_n", "Open a room with {n}", { n: n })
          : t("pm_room_open", "Open room");
      },
    });

    document.getElementById("pmRoomCancel").addEventListener("click", closeModal);

    go.addEventListener("click", async function (e) {
      var picked = picker.chosen();
      if (!picked.length) {
        out.className = "pm-msg-out bad";
        out.textContent = t("pm_pick_none_msg", "Choose at least one person.");
        return;
      }
      var btn = e.currentTarget;      // captured, never read after an await
      btn.disabled = true;
      out.className = "pm-msg-out";
      out.textContent = t("pm_room_opening", "Opening…");
      try {
        await window.PMStore.groupCreate({
          title: document.getElementById("pmRoomTitle").value.trim() || t("pm_room", "Room"),
          category: null,
          region: null,
          members: picked,
        });
        closeModal();
        await refreshInbox();
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
        btn.disabled = false;
      }
    });
  }

  window.PMAnnounceUI = { attach: attach, announce: announce, room: room };
})();
