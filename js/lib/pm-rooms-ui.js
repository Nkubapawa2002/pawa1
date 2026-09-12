// ============================================================================
//  pm-rooms-ui.js — everything you can do TO a conversation, rather than in it.
//
//  Split out of js/pages/p-message.js. The body below is unchanged except that
//  the page's `open` and `me` are read through getters, because a module
//  cannot close over a variable the page reassigns.
//
//  Four questions live here and they are deliberately in one file, because
//  they are all "this conversation, as an object":
//
//    the row menu   what one row in the list offers, and what it does not
//    the roster     who is in a room, adding, removing, leaving
//    delete         closing a room, or deleting a one-to-one that has nobody
//                   left to protect
//    block          the way out of being reached at all
//
//  WHICH ROWS CARRY A MENU, AND WHICH DELIBERATELY DO NOT, is decided by
//  rowMenuKind() on the page, not here. This file is handed the kind and draws
//  what that kind may do.
//
//  THE COPY DISTINGUISHES A ROOM FROM AN ANNOUNCEMENT EVERYWHERE. The two
//  reuse the same sheet because the questions are identical, and the words are
//  chosen off the kind so it never calls an announcement a room. That is worth
//  keeping: they are one-way and two-way respectively, and a person deciding
//  whether to leave one needs to know which they are in.
// ============================================================================
(function () {
  "use strict";

  // Handed in by the page. Read at CALL time, never destructured at attach
  // time: the page reassigns several of these after it attaches, and a
  // captured copy would be stale with nothing to say so.
  var ctx = {};

  var t = function (k, f) { return f || k; };
  var esc = function (s) { return String(s == null ? "" : s); };

  function attach(o) {
    ctx = o || {};
    if (ctx.t) t = ctx.t;
    if (ctx.esc) esc = ctx.esc;
  }

  var modal = function (h) { if (ctx.modal) ctx.modal(h); };
  var closeModal = function () { if (ctx.closeModal) ctx.closeModal(); };
  var say = function (m) { if (ctx.say) ctx.say(m); };
  var initials = function (n) { return ctx.initials ? ctx.initials(n) : ""; };
  var whereOf = function (p, o) { return ctx.whereOf ? ctx.whereOf(p, o) : { html: "" }; };
  var closeThread = function () { if (ctx.closeThread) ctx.closeThread(); };
  var refreshInbox = function () {
    return ctx.refreshInbox ? ctx.refreshInbox() : Promise.resolve();
  };
  /** The conversation on screen, or null. Live, never a copy. */
  var openThread = function () { return ctx.open ? ctx.open() : null; };
  /** { userId, email, isAdmin, isGuest } once the gate has run. */
  var who = function () { return ctx.me ? ctx.me() : null; };
  function askDeleteRoom(threadId, title, memberCount) {
    // pm_thread_size, not the length of the roster. The roster is built from
    // pm_thread_keys, which omits anybody who has not published a key yet, so
    // on a room of forty where a few are still setting up it would understate
    // what is being closed. Falls back to the roster only when the size never
    // arrived, which is better than saying nothing.
    var n = (openThread() && openThread().size) || memberCount || 0;
    modal("<h2>" + esc(t("pm_room_del_t", "Delete this room?")) + "</h2>" +
      '<p class="pm-modal-quote">' + esc(title) + "</p>" +
      // One key per number, because "1 people" is the kind of thing that makes
      // a warning dialog read as a machine rather than a sentence, and Swahili
      // does not inflect this the way English does anyway. Zero is not a
      // count that failed to load: it is what the menu in the thread list
      // passes when pm_thread_size could not be reached, and a warning that
      // says "all 0 people" is a warning nobody will finish reading.
      "<p>" + esc(n === 0
        ? t("pm_room_del_d1_none",
            "It closes for everyone in it, and every message in it is deleted from the server. Nobody can open it again, including us.")
        : n === 1
        ? t("pm_room_del_d1_one",
            "It closes for the one person in it, and every message in it is deleted from the server. Nobody can open it again, including us.")
        : t("pm_room_del_d1",
            "It closes for all {n} people in it, and every message in it is deleted from the server. Nobody can open it again, including us.",
            { n: n })) + "</p>" +
      "<p>" + esc(t("pm_room_del_d2",
        "What people already read on their own phones stays theirs. There is no undo.")) + "</p>" +
      '<div class="pm-modal-acts">' +
      '<button class="pm-btn ghost" id="pmRdNo">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
      '<button class="pm-btn is-danger" id="pmRdYes">' + esc(t("pm_room_del_go", "Delete the room")) + "</button>" +
      "</div><div class=\"pm-msg-out\" id=\"pmRdMsg\"></div>");

    document.getElementById("pmRdNo").addEventListener("click", closeModal);
    document.getElementById("pmRdYes").addEventListener("click", async function (e) {
      var btn = e.currentTarget;        // captured, never read after an await
      var out = document.getElementById("pmRdMsg");
      btn.disabled = true;
      try {
        await window.PMStore.groupDelete(threadId);
        closeModal();
        // Only if the room being closed is the one on screen. This is reached
        // from the thread list too, where closing the conversation pane would
        // be shutting a door that is not open.
        if (openThread() && openThread().threadId === threadId) closeThread();
        await refreshInbox();
        say(t("pm_room_del_ok", "The room is closed."));
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
        btn.disabled = false;
      }
    });
  }

  /**
   * Walk out of a room, from wherever you are standing.
   *
   * Shared by the roster sheet and the menu on the thread list, because the
   * question leaving has to ask is not a property of the screen it was asked
   * from. It asks a DIFFERENT question of an owner and of the last person in
   * the room, since leaving does a different thing in each case: the room
   * carries on under somebody else, or it closes, and neither is what "leave"
   * usually implies.
   *
   * `fail` is the caller's, because the two screens have different places to
   * put an error: the roster has a message line under its buttons, the list
   * menu has one under its own.
   */
  async function leaveRoom(threadId, role, last, fail) {
    var q = last
      ? t("pm_mem_leave_last_q", "You are the only one left. Leaving closes this room and everything in it goes.")
      : role === "owner"
      ? t("pm_mem_leave_own_q", "Leave this room? It stays open and the longest standing member takes it over.")
      : t("pm_mem_leave_q", "Leave this room? You will stop receiving what is said in it.");
    if (!confirm(q)) return false;
    try {
      var what = await window.PMStore.groupLeave(threadId);
      closeModal();
      if (openThread() && openThread().threadId === threadId) closeThread();
      await refreshInbox();
      // Say which of the three things happened. A person who owned a room and
      // expected it to close, or expected it not to, has no way to find out
      // from an inbox that simply has one fewer row in it.
      say(what === "deleted"
        ? t("pm_left_closed", "You were the last one there, so the room is closed.")
        : what === "handed_over"
        ? t("pm_left_handed", "You left. The room stays open and the longest standing member owns it now.")
        : t("pm_left_ok", "You left the room."));
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }

  /**
   * Everything you can do to one row in the thread list, in one sheet.
   *
   * The list had exactly one gesture on it, tap to open, and so the only way
   * out of a room was to go into it first and find the roster sheet, and there
   * was no way at all to be rid of a guest enquiry. Which rows carry these
   * dots, and which deliberately do not, is in rowMenuKind() above.
   *
   * The room's own count is fetched here rather than passed down the row,
   * because a list that asks the size of every room while drawing is the
   * per-row query the inbox is written to avoid. One tap, one question.
   */
  async function showChatMenu(btn) {
    var threadId = btn.dataset.chatMenu;
    var kind = btn.dataset.menuKind;
    var name = btn.dataset.name || t("pm_someone", "Someone");
    var role = btn.dataset.role || "member";
    var other = btn.dataset.other || "";
    var cast = kind === "cast";
    var room = kind === "room" || cast;
    // A conversation between two accounts: nothing to delete, one thing to
    // stop. See rowMenuKind().
    var plain = kind === "chat";
    // The owner of the room, or an admin: the same test pm_group_delete makes,
    // asked here so the button is not offered to somebody the database will
    // turn away. my_role comes down with the row from pm_inbox.
    var canDelete = !room || role === "owner" || !!(who() && who().isAdmin);

    modal("<h2>" + esc(name) + "</h2>" +
      '<div class="pm-sheet">' +
      '<button class="pm-sheet-b" type="button" id="pmCmOpen">' +
        "<b>" + esc(t("pm_chat_open", "Open it")) + "</b><span>" +
        esc(t("pm_chat_open_d", "Read what is there and answer.")) + "</span></button>" +
      (room
        ? '<button class="pm-sheet-b is-danger" type="button" id="pmCmLeave">' +
            "<b>" + esc(cast ? t("pm_cast_leave", "Leave this announcement")
                              : t("pm_mem_leave", "Leave room")) + "</b><span>" +
            esc(t("pm_chat_leave_d", "You stop receiving what is said in it. It stays open for everyone else.")) +
            "</span></button>" +
          (canDelete
            ? '<button class="pm-sheet-b is-danger" type="button" id="pmCmDelRoom">' +
              "<b>" + esc(cast ? t("pm_cast_del", "Delete this announcement")
                                : t("pm_room_del", "Delete room")) + "</b><span>" +
              esc(cast
                ? t("pm_cast_del_d", "It goes from the list of everybody it was sent to, and every message in it is deleted from the server.")
                : t("pm_chat_delroom_d", "Closes it for everyone in it and deletes every message from the server.")) +
              "</span></button>"
            : "")
        : plain
        ? '<button class="pm-sheet-b is-danger" type="button" id="pmCmBlock">' +
            "<b>" + esc(t("pm_block", "Block this person")) + "</b><span>" +
            esc(t("pm_block_d", "They stop being able to add you to a room, announce to you, or start a new conversation. This one stays.")) +
            "</span></button>"
        : '<button class="pm-sheet-b is-danger" type="button" id="pmCmDelChat">' +
            "<b>" + esc(t("pm_chat_del", "Delete this conversation")) + "</b><span>" +
            esc(kind === "gone"
              ? t("pm_chat_del_gone_d", "They have already gone, so nothing here can be opened again.")
              : t("pm_chat_del_guest_d", "They have no account, so the whole conversation goes from the server.")) +
            "</span></button>") +
      "</div>" +
      '<div class="pm-modal-acts"><button class="pm-btn ghost" id="pmCmX">' +
      esc(t("pm_close", "Close")) + "</button></div>" +
      '<div class="pm-msg-out" id="pmCmMsg"></div>');

    document.getElementById("pmCmX").addEventListener("click", closeModal);

    // The row beside these dots already knows its own name, area and the id of
    // whoever is on the other side, and the list's own click handler already
    // knows how to open one. Clicking it is that handler, not a second copy of
    // the four fields it reads.
    document.getElementById("pmCmOpen").addEventListener("click", function () {
      var row = btn.parentNode && btn.parentNode.querySelector(".pm-row");
      closeModal();
      if (row) row.click();
    });

    var fail = function (err) {
      var out = document.getElementById("pmCmMsg");
      if (!out) return;
      out.className = "pm-msg-out bad";
      out.textContent = (err && err.message) || String(err);
    };

    var chat = document.getElementById("pmCmDelChat");
    if (chat) chat.addEventListener("click", function () {
      closeModal();
      askDeleteChat(threadId, name, kind === "gone");
    });

    var block = document.getElementById("pmCmBlock");
    if (block) block.addEventListener("click", function () {
      closeModal();
      window.PMBlock.ask(other, name);
    });

    var leave = document.getElementById("pmCmLeave");
    if (leave) leave.addEventListener("click", async function (e) {
      var b = e.currentTarget;            // captured, never read after an await
      b.disabled = true;
      var n = await roomSize(threadId);
      var went = await leaveRoom(threadId, role, n === 1, fail);
      if (!went) b.disabled = false;
    });

    var delRoom = document.getElementById("pmCmDelRoom");
    if (delRoom) delRoom.addEventListener("click", async function (e) {
      e.currentTarget.disabled = true;
      var n = await roomSize(threadId);
      closeModal();
      askDeleteRoom(threadId, name, n);
    });
  }

  /** The size of a room, or 0 when it could not be asked. */
  async function roomSize(threadId) {
    try { return (await window.PMStore.threadSize(threadId)) || 0; }
    catch (_) { return 0; }
  }

  /**
   * Delete a whole one to one conversation.
   *
   * Only ever offered where there is no second account to protect: the other
   * side has no account, or has already gone. The dialog says which of those
   * two it is, because they leave the reader with different questions, and it
   * says the one thing this cannot do in the same words the unsend dialog
   * uses. A copy somebody already read is theirs, and nothing reaches it.
   */
  function askDeleteChat(threadId, name, gone) {
    modal("<h2>" + esc(t("pm_chat_del_t", "Delete this conversation?")) + "</h2>" +
      '<p class="pm-modal-quote">' + esc(name) + "</p>" +
      "<p>" + esc(gone
        ? t("pm_chat_del_d1_gone",
            "They ended their guest session, so there is nobody on the other side and nothing here can be opened again. The conversation and every message in it are deleted from the server.")
        : t("pm_chat_del_d1_guest",
            "They wrote to you without an account. The conversation and every message in it are deleted from the server, for both of you. Nobody can open them again, including us.")) + "</p>" +
      "<p>" + esc(t("pm_chat_del_d2",
        "What either of you already read on a phone stays there. There is no undo.")) + "</p>" +
      '<div class="pm-modal-acts">' +
      '<button class="pm-btn ghost" id="pmCdNo">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
      '<button class="pm-btn is-danger" id="pmCdYes">' + esc(t("pm_chat_del_go", "Delete it")) + "</button>" +
      "</div><div class=\"pm-msg-out\" id=\"pmCdMsg\"></div>");

    document.getElementById("pmCdNo").addEventListener("click", closeModal);
    document.getElementById("pmCdYes").addEventListener("click", async function (e) {
      var btn = e.currentTarget;          // captured, never read after an await
      var out = document.getElementById("pmCdMsg");
      btn.disabled = true;
      try {
        var res = await window.PMStore.directDelete(threadId);
        closeModal();
        if (openThread() && openThread().threadId === threadId) closeThread();
        await refreshInbox();
        // A row that had already gone on another device is not an error and is
        // not a deletion either. Saying "deleted" there would claim this tap
        // did something it did not do.
        say(res && res.deleted
          ? t("pm_chat_del_ok", "The conversation is deleted.")
          : t("pm_chat_del_already", "That conversation had already gone."));
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
        btn.disabled = false;
      }
    });
  }

  async function showMembers() {
    if (!openThread() || openThread().kind !== "group") return;
    var threadId = openThread().threadId, title = openThread().name;
    modal("<h2>" + esc(title) + "</h2>" +
      '<p>' + esc(t("pm_mem_d", "Everyone here can read what is sent from now on, and nothing that was sent before they joined.")) + "</p>" +
      '<div id="pmMemList"><div class="pm-empty">' + esc(t("pm_loading", "Loading…")) + "</div></div>" +
      '<div class="pm-modal-acts" id="pmMemActs">' +
        '<button class="pm-btn ghost" id="pmMemClose">' + esc(t("pm_close", "Close")) + "</button>" +
      "</div><div class=\"pm-msg-out\" id=\"pmMemMsg\"></div>");
    document.getElementById("pmMemClose").addEventListener("click", closeModal);

    var rows;
    try { rows = await window.PMStore.threadKeys(threadId); }
    catch (err) {
      document.getElementById("pmMemList").innerHTML =
        '<div class="pm-empty">' + esc((err && err.message) || err) + "</div>";
      return;
    }
    // Only the room's owner, or an admin, may change who is in it. Drawing the
    // buttons for anyone else would be offering a door the database will shut:
    // pm_group_add and pm_group_remove check the same thing again.
    var mine = rows.filter(function (r) { return r.userId === (who() && who().userId); })[0];
    var canManage = !!(who() && who().isAdmin) || (mine && mine.role === "owner");

    document.getElementById("pmMemList").innerHTML =
      '<div class="pm-count">' + esc(t("pm_members_n", "{n} members", { n: rows.length })) + "</div>" +
      '<div class="pm-scroll">' + rows.map(function (r) { return memberRow(r, canManage); }).join("") + "</div>";

    // Closing the room is the owner's, or an admin's, which is the same test
    // as adding and removing people. It is deliberately the CURRENT owner
    // rather than whoever opened the room: an owner who leaves hands the room
    // on, and keying this to the original creator would leave rooms that
    // nobody alive can close.
    var canDelete = canManage;

    document.getElementById("pmMemActs").insertAdjacentHTML("afterbegin",
      (canManage ? '<button class="pm-btn" id="pmMemAdd">' + esc(t("pm_mem_add", "Add people")) + "</button>" : "") +
      '<button class="pm-btn danger" id="pmMemLeave">' + esc(t("pm_mem_leave", "Leave room")) + "</button>" +
      (canDelete
        ? '<button class="pm-btn danger" id="pmMemDelete">' + esc(t("pm_room_del", "Delete room")) + "</button>"
        : ""));

    var add = document.getElementById("pmMemAdd");
    if (add) add.addEventListener("click", function () { showAddMembers(threadId, rows); });

    var del = document.getElementById("pmMemDelete");
    if (del) del.addEventListener("click", function () { askDeleteRoom(threadId, title, rows.length); });

    document.getElementById("pmMemLeave").addEventListener("click", async function (e) {
      // Leaving is not undoable by the person leaving, only the owner can put
      // them back, so leaveRoom() asks once rather than acting on a tap.
      var btn = e.currentTarget;      // captured, never read after an await
      btn.disabled = true;
      var went = await leaveRoom(threadId, mine && mine.role, rows.length <= 1, function (err) {
        var out = document.getElementById("pmMemMsg");
        if (!out) return;
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
      });
      if (!went) btn.disabled = false;
    });

    document.getElementById("pmMemList").addEventListener("click", async function (e) {
      var btn = e.target.closest("[data-remove]");
      if (!btn) return;
      var who = btn.dataset.remove;
      if (!confirm(t("pm_mem_remove_q", "Remove {name} from this room?", { name: btn.dataset.name }))) return;
      var out = document.getElementById("pmMemMsg");
      btn.disabled = true;
      try {
        await window.PMStore.groupRemove(threadId, who);
        showMembers();                 // redraw from the database, not from here
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
        btn.disabled = false;
      }
    });
  }

  /**
   * One member: who they are, and WHERE THEY WORK.
   *
   * The second half is the reason a roster is worth opening at all. A list of
   * names in a room of eighty agents tells you nothing you can act on; a list
   * of names with "Nyamagana", "Ilemela", "Sengerema" beside them is a map of
   * who to ask about what.
   */
  function memberRow(m, canManage) {
    var name = m.name || t("pm_someone", "Someone");
    var w = whereOf(m, { quiet: !m.isAgent });
    var isMe = m.userId === (who() && who().userId);
    var tags =
      (m.role === "owner" ? ' <span class="pm-badge">' + esc(t("pm_badge_owner", "Owner")) + "</span>" : "") +
      (m.isAgent ? ' <span class="pm-badge off">' + esc(t("pm_badge_agent", "Agent")) + "</span>" : "") +
      (m.isGuest ? ' <span class="pm-badge off">' + esc(t("pm_badge_guest", "Guest")) + "</span>" : "");

    return '<div class="pm-mem">' +
      '<span class="pm-av">' + esc(initials(name)) + "</span>" +
      '<span class="pm-mem-tx"><span class="pm-mem-nm">' + esc(name) +
        (isMe ? " " + esc(t("pm_you", "(you)")) : "") + tags + "</span>" +
        '<span class="pm-sub">' + w.html + "</span></span>" +
      // An owner cannot be removed — pm_group_remove refuses it — so the
      // button is not drawn rather than drawn and then refused.
      (canManage && !isMe && m.role !== "owner"
        ? '<button class="pm-btn danger" data-remove="' + esc(m.userId) + '" data-name="' + esc(name) + '">' +
          esc(t("pm_mem_remove", "Remove")) + "</button>"
        : "") +
      "</div>";
  }

  /**
   * Adding people to a room that already exists.
   *
   * Same picker as opening one, and the same warning attached to it: they will
   * see what is said from now on and nothing that was said before. That is the
   * honest behaviour of per-message wraps rather than a limitation to
   * apologise for, but somebody joining a room mid-conversation should be told
   * it rather than discover it.
   */
  async function showAddMembers(threadId, existing) {
    var already = {};
    (existing || []).forEach(function (r) { already[r.userId] = true; });

    modal("<h2>" + esc(t("pm_mem_add", "Add people")) + "</h2>" +
      "<p>" + esc(t("pm_mem_add_d", "They will see what is said from now on. Nothing said before they join is readable to them.")) + "</p>" +
      '<div id="pmAddPick"></div>' +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn" id="pmAddGo" disabled>' + esc(t("pm_mem_add_go", "Add selected")) + "</button>" +
        '<button class="pm-btn ghost" id="pmAddCancel">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
      "</div><div class=\"pm-msg-out\" id=\"pmAddMsg\"></div>");

    var out = document.getElementById("pmAddMsg");
    var go = document.getElementById("pmAddGo");
    document.getElementById("pmAddCancel").addEventListener("click", function () { showMembers(); });

    // Somebody already in the room is not a candidate to add. Leaving them in
    // the list with a tick beside them invites an owner to "add" eleven people
    // and be told four were added.
    var picker = window.PMPeoplePicker.mount(document.getElementById("pmAddPick"), {
      mode: "room",
      exclude: Object.keys(already),
      onChange: function (n) { go.disabled = n === 0; },
    });

    go.addEventListener("click", async function (e) {
      var picked = picker.chosen();
      if (!picked.length) return;
      var btn = e.currentTarget;      // captured, never read after an await
      btn.disabled = true;
      out.className = "pm-msg-out";
      out.textContent = t("pm_working", "Working…");
      try {
        var n = await window.PMStore.groupAdd(threadId, picked);
        out.className = "pm-msg-out good";
        out.textContent = t("pm_mem_added", "{n} added.", { n: n });
        setTimeout(function () { showMembers(); }, 700);
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
        btn.disabled = false;
      }
    });
  }

  // The old scope-shaped picker lived here: it drew whoever a category and a
  // region caught, with everybody ticked, and it could not search. It is now
  // js/lib/pm-people-picker.js, which the room dialog, the add-people sheet
  // and the announce dialog all mount, and which keeps a basket so a choice
  // survives changing the search that found it.

  function regionSelect(id, allLabel) { return window.PMPeoplePicker.regionSelect(id, allLabel); }
  function catSelect(id) { return window.PMPeoplePicker.catSelect(id); }

  // One list, four entries, shared with the picker.
  var CATS = window.PMPeoplePicker.CATS;

  window.PMRoomsUI = {
    attach: attach,
    rowMenu: showChatMenu,
    roster: showMembers,
  };
})();
