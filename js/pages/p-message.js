// ============================================================================
//  p-message.js — the P-Message screen.
//
//  Drawing only. Identity, the network and every byte of crypto live in
//  js/lib/pm-store.js and js/lib/p-crypto.js; this file decides what a person
//  sees and what happens when they tap it.
//
//  Three things here are load-bearing and easy to undo by accident:
//
//   1. THE LOCK LINE TELLS THE TRUTH. It reads "End-to-end encrypted" on human
//      threads and flips to a warning on the PN-Zaki thread, which cannot be
//      encrypted because a model that answers you has to read you. Making
//      those two look alike would be the single most dishonest thing this page
//      could do. The microphone follows the same rule: the voice button exists
//      ONLY on that thread, because offering to record a sentence into an
//      end-to-end encrypted conversation would be a promise this page cannot
//      keep.
//   2. A MESSAGE THAT WILL NOT DECRYPT IS SHOWN, NOT HIDDEN. It means this
//      device's key cannot open it. A gap in a conversation is far more
//      alarming than a line saying why.
//   3. NOTHING IS SENT BEFORE AN IDENTITY EXISTS. The gate at the top is not
//      decoration; without a published key nobody can write to you, and you
//      would never find out.
//
//  ONE DOM RULE, BECAUSE IT COST A DAY. Every button handler here is async,
//  and `event.currentTarget` is only valid while the event is dispatching —
//  past the first await it is null. So `e.currentTarget.disabled = false` in a
//  finally block does not re-enable the button; it throws a TypeError and
//  leaves the button dead until the page is reloaded, on precisely the failure
//  path where somebody needs to press it again. Capture it into a local on the
//  first line (`var btn = e.currentTarget`) and never read it again.
// ============================================================================

(function () {
  "use strict";

  var el = {};
  ["pmLock", "pmLockText", "pmFpBtn", "pmBroadcastBtn", "pmRoomsBtn", "pmInviteBtn",
   "segChats", "segPeople", "segAi",
   "pmGate", "paneChats", "panePeople", "paneAi", "pmInbox", "pmSearch", "pmRegion",
   "pmPeople", "pmAiRow", "pmConv", "pmBack", "pmConvName", "pmConvSub", "pmVerify",
   "pmLog", "pmConvNote", "pmComposeForm", "pmInput", "pmSendBtn", "pmModalBack", "pmModal",
   "pmVoiceBtn", "pmVoiceDock",
   "pmTrustBar", "pmWho", "pmCount", "pmCats", "pmShort", "pmMembers", "pmReplyBar",
   "pmPlaceBtn", "pmAttach", "pmPlaceHint", "pmMapSheet", "pmMapBack", "pmMapName", "pmMapSub",
   "pmMapCanvas", "pmMapActs"]
    .forEach(function (id) { el[id] = document.getElementById(id); });

  var me = null;             // { userId, email, isAdmin }
  var fingerprint = "";
  var ready = false;         // an identity exists and is published
  var seg = "chats";
  var open = null;           // { threadId, name, sub, kind, otherId }
  var live = null;           // realtime subscription for the open thread
  var inboxLive = null;      // realtime + poll for the thread list itself
  var searchTimer = null;
  // The message the next send answers, and the rows the log was last drawn
  // from. The rows are kept because a quote is built from THIS DEVICE'S
  // decrypted copy of the original — never from anything the server sent —
  // so the log has to be able to look up what it already opened.
  var replyTo = null;        // { id, name, text } or null
  var lastRows = [];
  // The ids this device is holding back out of the page currently drawn. Kept
  // so the "N are hidden" line and its Show button both work off the same list
  // the log was actually filtered with, rather than re-deriving it and
  // disagreeing with itself after a redraw. See js/lib/pm-hidden.js.
  var hiddenHere = [];
  // The pin waiting to go with the next message. A location is not an
  // attachment in the file sense — it rides inside the encrypted body — but it
  // behaves like one at the composer, and it must be visible while typing or
  // it gets sent to a conversation nobody meant.
  // The pin waiting to be sent is owned by js/lib/pm-place-ui.js; ask it.

  var AI_THREAD = "assistant";
  // Kept only so the log older builds left on the device can be deleted. The
  // assistant thread is memory-only now; see aiLog() near the bottom.
  var AI_STORE = "pm-assistant-log-v1";

  // What the person said they need. "" is a real value meaning "anyone" — with
  // no category there is no such thing as a best match, so the list falls back
  // to plain order and the shortlist line is not drawn at all.
  var category = "";
  // The shortlist target: how confident is confident enough to stop suggesting
  // more people to write to. Four in five, not nine in ten — the difference is
  // several more messages to several more strangers for a small gain.
  var SHORTLIST_TARGET = 0.8;

  function t(key, fallback, vars) {
    var s = window.t ? window.t(key) : key;
    if (!s || s === key) s = fallback;
    if (vars) Object.keys(vars).forEach(function (k) {
      s = String(s).replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
    });
    return s;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // The picker draws people, and drawing a person means saying where they work
  // and what they deal in. Those two answers now live in one module, shared
  // with the picker, the roster and the agent list, so it is handed this
  // page's own t() and esc() rather than growing a second copy of either.
  if (window.PMPeoplePicker) window.PMPeoplePicker.attach({ t: t, esc: esc });

  // --------------------------------------------------------------------------
  //  The keyboard problem.
  //
  //  On a phone the on-screen keyboard does NOT shrink the layout viewport.
  //  A position:fixed conversation therefore keeps its full height, and the
  //  composer sits behind the keyboard: you type and cannot see the words.
  //  window.visualViewport is the one viewport that accounts for it, so its
  //  height and offset are published as CSS variables and the panel is sized
  //  from those. iOS also SCROLLS the layout viewport when the keyboard opens,
  //  which is what --pm-vvt undoes.
  // --------------------------------------------------------------------------
  function trackViewport() {
    var vv = window.visualViewport;
    var root = document.documentElement;
    var apply = function () {
      var h = vv ? vv.height : window.innerHeight;
      var top = vv ? vv.offsetTop : 0;
      root.style.setProperty("--pm-vvh", Math.round(h) + "px");
      root.style.setProperty("--pm-vvt", Math.round(top) + "px");
    };
    apply();
    if (vv) {
      vv.addEventListener("resize", apply);
      vv.addEventListener("scroll", apply);
    }
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", function () { setTimeout(apply, 120); });
  }

  // Grow the composer with what is typed. Height is cleared first so
  // scrollHeight reports the content rather than the box we last set; CSS
  // max-height clamps the result and the textarea scrolls inside itself past
  // that, so a very long message never eats the whole conversation.
  function autosize() {
    var ta = el.pmInput;
    if (!ta) return;
    var wasAtBottom = el.pmLog &&
      el.pmLog.scrollHeight - el.pmLog.scrollTop - el.pmLog.clientHeight < 40;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
    if (wasAtBottom && el.pmLog) el.pmLog.scrollTop = el.pmLog.scrollHeight;
  }

  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
    return parts.map(function (p) { return p.charAt(0).toUpperCase(); }).join("") || "?";
  }
  function clock(iso) {
    try {
      var d = new Date(iso), now = new Date();
      var sameDay = d.toDateString() === now.toDateString();
      return sameDay
        ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleDateString([], { day: "numeric", month: "short" });
    } catch (_) { return ""; }
  }

  // ---- modal ---------------------------------------------------------------
  function modal(html) {
    el.pmModal.innerHTML = html;
    el.pmModalBack.classList.add("is-on");
  }
  function closeModal() {
    el.pmModalBack.classList.remove("is-on");
    el.pmModal.innerHTML = "";
  }
  // ---- the gate ------------------------------------------------------------
  // One panel, one state at a time: signed out, insecure page, or setting up.
  function gate(html) {
    if (!el.pmGate) return;
    if (!html) { el.pmGate.hidden = true; el.pmGate.innerHTML = ""; return; }
    el.pmGate.hidden = false;
    el.pmGate.innerHTML = html;
  }

  async function boot() {
    if (window.applyTranslations) window.applyTranslations();
    fillRegions();
    wire();

    me = await window.PMStore.me();
    if (!me.userId) {
      lock(true);
      showGuestGate();
      renderAiPane();
      takeRequestedZaki();
      return;
    }

    if (!window.PMCrypto || !window.PMCrypto.available()) {
      lock(false, t("pm_lock_none", "Encryption unavailable"));
      gate('<div class="pm-note warn"><b>' + esc(t("pm_insecure_t", "This page is not on a secure connection")) +
        "</b><br>" + esc(t("pm_insecure_d", "Browsers only hand out the encryption tools over https. Open this site with https:// and P-Message will work.")) + "</div>");
      return;
    }

    try {
      var res = await window.PMStore.ensureIdentity();
      fingerprint = res.fingerprint;
      ready = true;
      gate(null);
      lock(true);
      // A door, not a display. The chip says what is behind it and the digits
      // are drawn inside, where there is room for the grid both people have to
      // compare.
      if (el.pmFpBtn) el.pmFpBtn.hidden = false;
      // Rooms and announcements belong to every real account now, not to the
      // one address in ADMIN_EMAILS. What used to be a fence on WHO may send
      // is a fence on WHO they may reach: pm_may_room_with() and
      // pm_may_cast_to() decide per person, in the database, and the picker
      // asks the same two questions before it draws a row.
      //
      // A guest is still refused, here and in both functions. A guest session
      // is a browser tab: the room it opened would outlive the identity that
      // opened it, and there would be nobody left to own it.
      if (!me.isGuest && el.pmBroadcastBtn) el.pmBroadcastBtn.hidden = false;
      if (!me.isGuest && el.pmRoomsBtn) el.pmRoomsBtn.hidden = false;
      if (!me.isGuest && el.pmInviteBtn) el.pmInviteBtn.hidden = false;
      // A brand new device is the moment to say that the key lives HERE, while
      // there is still nothing to lose. Saying it after a lost phone is useless.
      if (res.isNewDevice) setTimeout(showBackup, 400);
    } catch (err) {
      lock(false, t("pm_lock_none", "Encryption unavailable"));
      // A locked device is not a broken one. It has a key; it just has not
      // been opened yet, and saying "could not set up encryption" here would
      // send somebody off to make a second identity and lose their history.
      if (err && err.message === "LOCKED") {
        lock(true);
        showUnlockGate();
        renderAiPane();
        takeRequestedZaki();
        return;
      }
      gate('<div class="pm-note warn">' + esc(t("pm_setup_failed", "Could not set up encryption on this device.")) +
        "<br><small>" + esc((err && err.message) || err) + "</small></div>");
      return;
    }

    // Say we are here, and keep saying it once a minute. Started only after
    // an identity exists, because "so-and-so has P-Message open" is a claim
    // about a person, and until this point there is no person — only a tab.
    // p-message.html is the ONLY page that beats: the sentence on screen is
    // "last opened P-Message", and a beat from anywhere else would quietly
    // turn it into "last used the site".
    if (window.PMPresence) window.PMPresence.start(window.PMStore);

    await refreshInbox();
    watchInbox();
    renderAiPane();
    takeRequestedZaki();
    // Last, because it opens a conversation over the inbox it needs drawn
    // first — and because everything above must work whether or not the link
    // carried a person.
    // Order matters. The pin is picked up FIRST so that when ?to= is also on
    // the link the conversation opens with the place already attached; on its
    // own it waits on the list, which is the honest thing to do — the app
    // cannot know who the pin is for.
    try { takeRequestedPlace(); } catch (_) {}
    try { await openRequestedPeer(); } catch (_) {}
  }

  /**
   * A link that asked for PN-Zaki: p-message.html?seg=ai, plus two optional
   * extras — &ask=<question> to open it already asking, and &voice=1 to open
   * it with the voice dock showing.
   *
   * The dock SHOWING is not the microphone RUNNING. A link that could start
   * recording is a link somebody could send you, and no query string on this
   * site is allowed to open a microphone; the dock's own button does that,
   * with a tap, on this device, by the person holding it.
   *
   * chat.html is the caller that matters: the assistant used to be two tabs
   * at the top of that page, so somebody who knows it from before will go
   * there looking, and this is the door back.
   */
  function takeRequestedZaki() {
    var q;
    try { q = new URLSearchParams(location.search); } catch (_) { return false; }
    if ((q.get("seg") || "") !== "ai") return false;
    showSeg("ai");
    var ask = String(q.get("ask") || "").slice(0, 300).trim();
    var voice = q.get("voice") === "1";
    if (ask || voice) openAi({ ask: ask || null, voice: voice });
    return true;
  }

  /**
   * A place handed over by another page — share-location.html?, a listing, a
   * map — as p-message.html?place=<lat>,<lng>&label=<words>.
   *
   * The link carries the coordinates and nothing else that matters: no thread,
   * no recipient, no claim about who owns the place. Choosing who to send it
   * to is a decision, and a link that made it for you is a link that can send
   * somebody's house to a stranger.
   */
  function takeRequestedPlace() {
    if (!ready || !window.PMPlace || !window.PlaceBook) return false;
    var raw = "", label = "";
    try {
      var q = new URLSearchParams(location.search);
      raw = q.get("place") || "";
      label = q.get("label") || "";
    } catch (_) { return false; }
    if (!raw) return false;

    var hit = window.PlaceBook.parse(raw);
    if (!hit) return false;
    attachPlace({
      lat: hit.lat, lng: hit.lng, acc: null,
      label: String(label || hit.label || "").slice(0, 120),
      source: "link",
    });
    showSeg("chats");
    return true;
  }

  /**
   * Keep the thread list live.
   *
   * Until this existed the only live delivery was per-open-conversation, so a
   * reply that arrived while you were looking at the list — or a whole new
   * conversation somebody started with you — showed up only if you reloaded
   * the page. Two people cannot talk to each other if neither is told the
   * other answered, and "reload to see if anyone wrote" is not a chat feature.
   *
   * Started once, after boot, and torn down before another is made: an unlock
   * or a guest sign-in calls boot() again, and two live channels would mean
   * two refreshes for every message.
   */
  function watchInbox() {
    if (inboxLive) { inboxLive.unsubscribe(); inboxLive = null; }
    if (!ready || !window.PMStore.watchInbox) return;
    inboxLive = window.PMStore.watchInbox(function () {
      // The open conversation has its own subscription and redraws itself; this
      // one only has to keep the list behind it honest.
      refreshInbox();
    });
  }

  /**
   * The key is sealed by this device and has not been opened yet.
   *
   * Deliberately not a modal and not automatic: WebAuthn refuses to prompt
   * without a user gesture, so a page that tried to unlock itself on load
   * would simply fail and look broken. A button is also the honest shape —
   * the person decides when to open their key.
   */
  function showUnlockGate() {
    gate('<div class="pm-note"><b>' + esc(t("pm_locked_t", "Your key is locked to this device")) + "</b><br>" +
      esc(t("pm_locked_d", "Open it with your fingerprint, face or PIN to read and send messages.")) +
      '<div style="margin-top:11px"><button class="pm-btn" id="pmUnlockBtn" type="button">' +
      esc(t("pm_unlock", "Unlock")) + "</button></div>" +
      '<div class="pm-msg-out" id="pmUnlockMsg"></div></div>');

    var btn = document.getElementById("pmUnlockBtn");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      var out = document.getElementById("pmUnlockMsg");
      btn.disabled = true;
      out.className = "pm-msg-out";
      out.textContent = t("pm_lock_prompt", "Confirm with your fingerprint, face or PIN…");
      try {
        await window.PMDeviceLock.unlock();
        await boot();                     // now that the key is in hand
      } catch (err) {
        btn.disabled = false;
        out.className = "pm-msg-out bad";
        var code = (err && err.message) || String(err);
        out.textContent = /NotAllowed|AbortError/i.test(code)
          ? t("pm_lock_cancelled", "Cancelled. Nothing has changed.")
          : code === "WRONG_KEY"
          ? t("pm_lock_wrong_key", "That is not the passkey this key was sealed with. If it was reset, restore from your backup code instead.")
          : code;
      }
    });
  }

  /**
   * The signed-out screen.
   *
   * Not a wall. Somebody looking at a room has no reason to make an account
   * before asking "is this still available?", and a wall there costs the agent
   * the enquiry, not just the visitor the convenience. So the first offer is to
   * chat as a guest — with the SAME encryption; the difference is only that
   * nobody has proved who they are, which is why the thread lives on this
   * device and only agents can be written to.
   */
  function showGuestGate() {
    gate('<div class="pm-note"><b>' + esc(t("pm_guest_t", "Message an agent without an account")) + "</b><br>" +
      esc(t("pm_guest_d", "Give a name they can call you by and start straight away. It is encrypted the same way — but it lives on this device, so clearing your browser loses the conversation.")) +
      "</div>" +
      '<input class="pm-search" id="pmGuestName" maxlength="40" data-i18n-placeholder="pm_guest_name" ' +
      'placeholder="What should agents call you?" />' +
      '<div style="display:flex;gap:9px;flex-wrap:wrap">' +
        '<button class="pm-btn" id="pmGuestGo">' + esc(t("pm_guest_go", "Start chatting")) + "</button>" +
        '<a class="pm-btn ghost" href="login.html" style="text-decoration:none">' +
        esc(t("pm_signin_go", "Sign in")) + "</a>" +
      "</div>" +
      '<div class="pm-msg-out" id="pmGuestMsg"></div>');

    var go = document.getElementById("pmGuestGo");
    var input = document.getElementById("pmGuestName");
    var out = document.getElementById("pmGuestMsg");
    var start = async function () {
      out.className = "pm-msg-out";
      out.textContent = t("pm_working", "Working…");
      go.disabled = true;
      try {
        var res = await window.PMStore.signInAsGuest(input.value);
        fingerprint = res.fingerprint;
        ready = true;
        me = await window.PMStore.me(true);
        gate(null);
        lock(true);
        if (el.pmFpBtn) el.pmFpBtn.hidden = false;
        await refreshInbox();
        watchInbox();
        showSeg("people");           // a guest came here to find an agent
        // Unless they arrived on a ?to= link, in which case they came here
        // for one particular person and the gate was in the way, not the
        // destination.
        try { await openRequestedPeer(); } catch (_) {}
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) === "SHORT_NAME"
          ? t("pm_guest_name_short", "Please give a name of at least two letters.")
          : ((err && err.message) || String(err));
        go.disabled = false;
      }
    };
    go.addEventListener("click", start);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") start(); });
  }

  function lock(on, text) {
    if (!el.pmLock) return;
    el.pmLock.classList.toggle("is-open", !on);
    if (el.pmLockText) {
      el.pmLockText.textContent = text || (on
        ? t("pm_lock_on", "End-to-end encrypted")
        : t("pm_lock_off", "Not encrypted"));
    }
  }

  // ---- segments ------------------------------------------------------------
  function showSeg(which) {
    seg = which;
    [["chats", el.segChats, el.paneChats], ["people", el.segPeople, el.panePeople],
     ["ai", el.segAi, el.paneAi]].forEach(function (row) {
      row[1] && row[1].classList.toggle("is-on", row[0] === which);
      row[2] && row[2].classList.toggle("is-on", row[0] === which);
    });
    if (which === "people" && el.pmPeople && !el.pmPeople.dataset.loaded) refreshPeople();
  }

  // ---- inbox ---------------------------------------------------------------
  async function refreshInbox() {
    if (!ready) return;
    var rows;
    try { rows = await window.PMStore.inbox(); }
    catch (err) { el.pmInbox.innerHTML = '<div class="pm-empty">' + esc((err && err.message) || err) + "</div>"; return; }

    if (!rows.length) {
      el.pmInbox.innerHTML = '<div class="pm-empty">' +
        esc(t("pm_no_chats", "No conversations yet. Open Agents to find someone who works in your area.")) + "</div>";
      return;
    }

    el.pmInbox.innerHTML = rows.map(function (r) {
      var broadcast = r.kind === "broadcast";
      var group = r.kind === "group";
      var name = (broadcast || group)
        ? (r.title || t(group ? "pm_room" : "pm_announcement", group ? "Room" : "Announcement"))
        : (r.other_name || t("pm_someone", "Someone"));
      // A room says where it is and stops there. It deliberately does NOT say
      // how many people are in it: that count is a live query per row, and a
      // thread list that fires one request per line is how a list gets slow.
      var sub = group
        ? t("pm_room_sub", "Group room") + (r.region ? " · " + r.region : " · " + t("pm_nationwide", "Nationwide"))
        : broadcast
        ? t("pm_from_admin", "From the team") + (r.region ? " · " + r.region : " · " + t("pm_nationwide", "Nationwide"))
        : [r.other_area, r.other_region].filter(Boolean).join(" · ");
      // Somebody with no account is worth marking. It is true, and an agent
      // deciding how much time to give an enquiry should know it.
      var guestTag = (!broadcast && r.other_guest)
        ? ' <span class="pm-badge off">' + esc(t("pm_badge_guest", "Guest")) + "</span>" : "";
      // A one to one thread with nobody on the other side. It happens when a
      // guest ends their session: p_message_guest_end.sql drops their key and
      // their memberships, which is right, and leaves this row behind holding
      // ciphertext no living key can open. Saying so is the difference between
      // a conversation that has gone quiet and one that cannot be answered.
      var orphan = !broadcast && !group && !r.other_id;
      var goneTag = orphan
        ? ' <span class="pm-badge off">' + esc(t("pm_badge_left", "Left")) + "</span>" : "";
      // Which rows carry a menu, and why not all of them: see rowMenuKind().
      var menu = rowMenuKind(r, orphan);
      return (menu ? '<div class="pm-chat-wrap">' : "") +
        '<button class="pm-row" data-thread="' + esc(r.thread_id) + '" data-kind="' + esc(r.kind) +
        '" data-name="' + esc(name) + '" data-sub="' + esc(sub) + '" data-other="' + esc(r.other_id || "") +
        // Carried on the ROW as well as on the dots, because opening an
        // announcement has to know whether this reader may add to it before it
        // decides to hand them a composer.
        '" data-role="' + esc(r.my_role || "member") + '">' +
        '<span class="pm-av' + (broadcast ? " is-cast" : group ? " is-room" : "") + '">' +
          (broadcast ? PMIcons.cast : group ? PMIcons.room : esc(initials(name))) + "</span>" +
        '<span class="pm-rtx"><span class="pm-name">' + esc(name) + guestTag + goneTag +
          (broadcast ? ' <span class="pm-badge">' + esc(t("pm_badge_cast", "Announcement")) + "</span>" : "") +
          (group ? ' <span class="pm-badge">' + esc(t("pm_badge_room", "Room")) + "</span>" : "") +
        '</span><span class="pm-sub">' + esc(sub || clock(r.last_at)) + "</span></span>" +
        (r.unread ? '<span class="pm-unread">' + r.unread + "</span>" : "") + "</button>" +
        (menu
          ? '<button class="pm-row-more" type="button" data-chat-menu="' + esc(r.thread_id) + '"' +
            ' data-menu-kind="' + esc(menu) + '" data-name="' + esc(name) + '"' +
            ' data-other="' + esc(r.other_id || "") + '"' +
            ' data-role="' + esc(r.my_role || "member") + '"' +
            ' aria-label="' + esc(t("pm_chat_more", "What to do with this conversation")) + '">' +
            PMIcons.more + "</button></div>"
          : "");
    }).join("");
  }

  /**
   * Which menu a row in the list gets, or "" for no menu at all.
   *
   * Three kinds, and the third is the one that does not exist:
   *
   *   "room"    a group. Everyone in it can leave; its owner, or an admin, can
   *             close it. Until now the only way to either was to open the
   *             room and find the roster sheet, which is a strange place to
   *             keep the way out.
   *   "guest"   a one to one conversation with somebody who has no account,
   *             and "gone", the same thing after they closed their browser.
   *             Both can be deleted outright, for the reasons written at the
   *             top of supabase/features/message/p_message_purge.sql. They are
   *             told apart because the dialog has a different fact to state.
   *   ""        a one to one conversation between two accounts, and every
   *             announcement. Nothing on offer, so no button: a conversation
   *             with another account is also theirs and the database refuses
   *             to let one side erase it, and drawing a dot menu whose only
   *             content is a refusal is worse than drawing nothing.
   *
   * A guest sees no menu anywhere. They cannot delete an agent's copy of a
   * conversation, they are never in a room, and ending the session is on the
   * Profile tab where the rest of their identity lives.
   */
  function rowMenuKind(r, orphan) {
    if (me && me.isGuest) return "";
    if (r.kind === "group") return "room";
    // An announcement, to the person who sent it. Until p_message_announce.sql
    // a broadcast could not be deleted by anyone at all, so it was permanent
    // for every one of the hundreds of people it reached. It reuses the room
    // menu because the two questions are the same, and the copy inside is
    // chosen off this kind so it never calls an announcement a room.
    if (r.kind === "broadcast") {
      return (r.my_role === "owner" || (me && me.isAdmin)) ? "cast" : "";
    }
    if (r.kind !== "direct") return "";
    if (orphan) return "gone";
    if (r.other_guest) return "guest";
    // "chat" is new, and it exists because rooms and announcements stopped
    // being one admin's to send. A conversation between two accounts still has
    // nothing to DELETE from this menu, for the reason above, but it now has
    // something to stop: whoever is on the other side can gather you into a
    // room and can advertise to you, and the block is the way out of both.
    // A guest is excluded by the first line: blocking a browser tab that will
    // not exist tomorrow is a control that does nothing.
    return r.other_id ? "chat" : "";
  }

  // ---- directory -----------------------------------------------------------
  // The Agents pane is js/lib/pm-directory-ui.js now: the rows, the ranking
  // readout, the shortlist line, and the three chips under a row. The page
  // keeps the four names it already called, so nothing below had to change.
  if (window.PMDirectoryUI) window.PMDirectoryUI.attach({
    t: t, esc: esc, el: el, initials: initials,
    // Getters. A chip reassigns `category`, and `ready` flips once the
    // identity is published, both after this attach has run.
    category: function () { return category; },
    ready: function () { return ready; },
    me: function () { return me; },
    modal: modal, closeModal: closeModal,
  });
  function fillRegions() { window.PMDirectoryUI.fillRegions(); }
  function refreshPeople() { return window.PMDirectoryUI.refresh(); }
  function whereOf(p, o) { return window.PMDirectoryUI.whereOf(p, o); }
  function storefrontUrl(id) { return window.PMDirectoryUI.storefrontUrl(id); }
  // ---- conversation --------------------------------------------------------
  async function openThread(info) {
    open = info;
    // A reply belongs to the conversation it was chosen in. Carrying one
    // across would answer a message that is not in the room any more. A pin
    // is worse: it would be sent to whoever the next conversation happens to
    // be with.
    clearReply();
    clearAttach();
    lastRows = [];
    hiddenHere = [];
    el.pmConv.classList.add("is-on");
    el.pmConv.setAttribute("aria-hidden", "false");
    el.pmConvName.textContent = info.name;
    el.pmConvSub.textContent = info.sub || "";
    // The two header buttons answer different questions and swap rather than
    // crowding a bar that already leaves room for the floating theme toggle:
    // a direct thread asks "is this really you?", a room asks "who else is in
    // here?". Neither applies to the assistant.
    el.pmVerify.hidden = info.kind !== "direct" || !info.otherId;
    if (el.pmMembers) el.pmMembers.hidden = info.kind !== "group";
    // Cleared for every thread and re-offered below for PN-Zaki's alone. A
    // microphone on an encrypted thread would be a promise this page cannot
    // keep, and a dock left open from the last thread would be worse than
    // that: it would be one that looks like it applies here.
    if (el.pmVoiceBtn) el.pmVoiceBtn.hidden = true;
    if (voiceUI) voiceUI.hide();
    // The pin button is the other way round: every human thread has it, and
    // PN-Zaki does not. Sending a location to a model is an offer to hand over
    // where you are to something that cannot travel there — and the composer
    // would then carry an attachment the send path silently drops.
    if (el.pmPlaceBtn) el.pmPlaceBtn.hidden = info.kind === "ai";
    if (info.kind === "group") countMembers(info);
    el.pmLog.innerHTML = '<div class="pm-empty">' + esc(t("pm_loading", "Loading…")) + "</div>";

    if (info.kind === "ai") {
      lock(false, t("pm_lock_ai", "Not encrypted. PN-Zaki reads this"));
      el.pmConvNote.textContent = t("pm_ai_note", "PN-Zaki reads these messages. Do not send anything private.");
      // Hidden rather than disabled when voice cannot work here: a missing
      // Supabase URL or a browser with no getUserMedia is a fact about the
      // deployment, and a button that always fails teaches people the feature
      // is broken rather than absent.
      if (el.pmVoiceBtn && window.PNZaki && window.PNZaki.voiceAvailable()) {
        el.pmVoiceBtn.hidden = false;
        if (!el.pmVoiceBtn.innerHTML && window.PNZakiUI) el.pmVoiceBtn.innerHTML = window.PNZakiUI.ICON.mic;
      }
      renderAiLog();
      return;
    }

    lock(true);
    el.pmConvNote.textContent = info.kind === "broadcast"
      ? t("pm_cast_note", "Sent to everyone in this scope. Only you can read your copy.")
      : info.kind === "group"
      // Both halves matter. The first is the promise; the second is the thing
      // people are surprised by, and being surprised by it later feels like a
      // fault rather than a design.
      ? t("pm_room_note", "Encrypted to every member individually. Anything sent before you joined stays unreadable to you.")
      : t("pm_conv_note", "Encrypted on this device. Nobody else can read it, not even us.");

    // Not awaited: the messages should not wait on it, and it guards its own
    // staleness. It is started before the log so a substituted key is on
    // screen at roughly the same moment the conversation is.
    checkTrust(info);

    try {
      var rows = await window.PMStore.messages(info.threadId);
      renderLog(rows);
      await window.PMStore.markRead(info.threadId);
      refreshInbox();
    } catch (err) {
      el.pmLog.innerHTML = '<div class="pm-empty">' + esc((err && err.message) || err) + "</div>";
    }

    if (live) live.unsubscribe();
    live = window.PMStore.subscribe(info.threadId, async function () {
      if (!open || open.threadId !== info.threadId) return;
      try { renderLog(await window.PMStore.messages(info.threadId)); } catch (_) {}
    });
  }

  // ---- is this still the same person? --------------------------------------
  //
  //  Key distribution here is trust-on-first-use, and the failure it cannot
  //  see on its own is a substitution made LATER: the right key for a month,
  //  a different one on the day it matters. So the key is fetched on every
  //  open and compared with what this device wrote down the first time.
  //
  //  When it does not match, the composer is switched off. That is a real
  //  cost and it is the point — the alternative is a warning above a working
  //  text box, which is a warning most people will type straight past. There
  //  are two ways out and both require a person: compare the number, or say
  //  the change was expected.
  async function checkTrust(info) {
    // An announcement is one voice. The server refuses anybody else through
    // pm_can_announce(), so offering them a composer would be handing over a
    // box whose only possible outcome is an error.
    if (info && info.kind === "broadcast" &&
        !(info.myRole === "owner" || (me && me.isAdmin))) {
      setComposerBlocked(true, "cast");
      if (el.pmTrustBar) el.pmTrustBar.hidden = true;
      return;
    }
    setComposerBlocked(false);
    if (el.pmTrustBar) el.pmTrustBar.hidden = true;
    if (!info || info.kind !== "direct" || !info.otherId || !me) return;

    var hit = null;
    try { hit = await window.PMStore.peer(info.otherId); } catch (_) { return; }
    // The thread may have been closed or swapped while that was in flight.
    if (!hit || !open || open.threadId !== info.threadId) return;

    open.peerKey = hit.publicKey;
    open.peerFp = hit.fingerprint;
    open.trust = hit.trust || (window.PMTrust ? window.PMTrust.status(me.userId, info.otherId) : null);

    // The header opened with whatever the row that was tapped happened to know
    // — which, from the inbox, is a name and sometimes a region. pm_peer knows
    // where they actually work, and that is the fact worth having on screen
    // while you decide what to ask them.
    var w = whereOf(hit, { quiet: !hit.isAgent });
    // Presence belongs here more than anywhere: this is the screen where a
    // person is about to spend words. Nothing is drawn for somebody we have
    // never seen — see js/lib/pm-presence.js on why null is not "never".
    var seen = window.PMPresence ? window.PMPresence.html(hit.lastSeenAt) : "";
    // A link to their catalogue, for the same reason the list has one: the
    // answer to "can you find me a room in Tungi" is often visible without
    // anybody having to type it.
    var shop = hit.isAgent
      ? '<a class="pm-open" style="position:static" href="' + storefrontUrl(hit.userId) + '">' +
          PMIcons.box + "<span>" + esc(t("pm_open_listings", "See their work")) + "</span></a>"
      : "";
    if (el.pmConvSub && (w.area || w.rest || seen || shop)) {
      el.pmConvSub.innerHTML = w.html + seen +
        (hit.isGuest ? ' <span class="pm-badge off">' + esc(t("pm_badge_guest", "Guest")) + "</span>" : "") +
        shop;
      open.sub = w.line;
    }

    if (!open.trust || !open.trust.changed) return;
    if (!el.pmTrustBar) return;

    el.pmTrustBar.innerHTML =
      "<span>" + esc(t("pm_trust_bar",
        "{name}'s safety number changed. Check it before sending anything private.",
        { name: info.name || t("pm_someone", "Someone") })) + "</span>" +
      '<button class="pm-btn" id="pmTrustGo" type="button">' + esc(t("pm_verify", "Verify")) + "</button>";
    el.pmTrustBar.hidden = false;
    setComposerBlocked(true);
    var go = document.getElementById("pmTrustGo");
    if (go) go.addEventListener("click", openVerify);
  }

  /**
   * `why` names the reason, because there is more than one now and they need
   * different sentences. Blocking the box without saying why reads as the app
   * being broken rather than as a rule.
   */
  function setComposerBlocked(on, why) {
    if (el.pmInput) {
      el.pmInput.disabled = !!on;
      el.pmInput.placeholder = !on
        ? t("pm_write_ph", "Write a message")
        : why === "cast"
        ? t("pm_cast_read_ph", "Only the sender can add to an announcement")
        : t("pm_trust_blocked_ph", "Check their safety number first");
    }
    if (el.pmSendBtn) el.pmSendBtn.disabled = !!on;
    if (el.pmComposeForm) el.pmComposeForm.classList.toggle("is-blocked", !!on);
  }

  // One entry point for the dialog, so the header button and the alarm bar
  // cannot drift into showing two different things.
  async function openVerify() {
    var theirs = null, key = null;
    if (open && open.otherId) {
      // pm_peer, not the directory: a guest is deliberately absent from the
      // directory, so verifying one there would silently find nobody.
      try {
        var hit = await window.PMStore.peer(open.otherId);
        if (hit) { theirs = hit.fingerprint; key = hit.publicKey; }
      } catch (_) {}
    }
    window.PMIdentityUI.safetyNumbers({
      name: open && open.name,
      theirs: theirs,
      theirKey: key,
      peerId: open && open.otherId,
      meId: me && me.userId,
      onChange: function () { if (open) checkTrust(open); },
    });
  }

  // ---- who is in this room -------------------------------------------------
  //
  //  Rooms shipped with pm_group_add / _remove / _leave and no way to reach
  //  any of them: #pmMembers existed in the markup and was never wired, so an
  //  admin could open a room of two hundred people and then never change it,
  //  and a member could never leave one. That is the gap this section closes.
  //
  //  The roster comes from pm_thread_keys — the SAME call the sender uses to
  //  seal a message. One query means the list of people a message is encrypted
  //  to and the list the screen shows can never disagree about who is in the
  //  room, which is the only kind of disagreement that would matter here.

  /** The member count, in the header, as soon as the room opens. */
  async function countMembers(info) {
    try {
      var n = await window.PMStore.threadSize(info.threadId);
      if (!open || open.threadId !== info.threadId || !n) return;
      open.size = n;
      if (el.pmMembers) {
        el.pmMembers.textContent = t("pm_members_n", "{n} members", { n: n });
      }
    } catch (_) { /* the sheet still works; the count is a convenience */ }
  }

  /**
   * One sentence and a Close button, in the dialog vocabulary this page
   * already has. Not a new toast primitive: there is exactly one thing on this
   * screen that finishes with news rather than with a visible change, and a
   * whole floating-banner system with its own timing and its own CSS would be
   * more moving parts than the sentence is worth.
   */
  function say(text) {
    modal("<p>" + esc(text) + "</p>" +
      '<div class="pm-modal-acts"><button class="pm-btn" id="pmSayX">' +
      esc(t("pm_close", "Close")) + "</button></div>");
    document.getElementById("pmSayX").addEventListener("click", closeModal);
  }

  /**
   * Close a room for everybody in it.
   *
   * The count is in the question because it is the fact that changes the
   * answer: closing a room of two is tidying up and closing a room of eighty
   * is an announcement somebody should have made first.
   */
  // The row menu, the roster, leaving, deleting and blocking are all
  // js/lib/pm-rooms-ui.js now: four questions that are really one question,
  // "this conversation as an object", rather than anything you do inside it.
  if (window.PMRoomsUI) window.PMRoomsUI.attach({
    t: t, esc: esc, modal: modal, closeModal: closeModal,
    say: function (m) { say(m); },
    initials: initials,
    whereOf: function (p, o) { return whereOf(p, o); },
    closeThread: function () { closeThread(); },
    refreshInbox: function () { return refreshInbox(); },
    // Getters: both are reassigned by the page after this attach has run.
    open: function () { return open; },
    me: function () { return me; },
  });
  function showChatMenu(btn) { return window.PMRoomsUI.rowMenu(btn); }
  function showMembers() { return window.PMRoomsUI.roster(); }
  function closeThread() {
    open = null;
    // Walking away from PN-Zaki hangs up. A live microphone behind a screen
    // you have left is the one bug in this feature nobody would forgive.
    if (voiceUI) voiceUI.hide();
    if (el.pmVoiceBtn) el.pmVoiceBtn.hidden = true;
    clearReply();
    clearAttach();
    closePlaceMap();
    lastRows = [];
    hiddenHere = [];
    if (live) { live.unsubscribe(); live = null; }
    if (el.pmTrustBar) el.pmTrustBar.hidden = true;
    setComposerBlocked(false);
    el.pmConv.classList.remove("is-on");
    el.pmConv.setAttribute("aria-hidden", "true");
    lock(ready);
    refreshInbox();
  }

  function renderLog(allRows) {
    // Messages this device was told to stop drawing are taken out HERE, once,
    // before anything else looks at the list. lastRows keeps the FULL page,
    // because a reply quote is rebuilt from it and hiding a message is not the
    // same as saying its id no longer exists: an answer to it must still be
    // able to name what it answers.
    var split = window.PMHidden
      ? window.PMHidden.partition(me && me.userId, allRows || [])
      : { rows: allRows || [], hidden: [] };
    var rows = split.rows;
    hiddenHere = split.hidden;
    lastRows = allRows || [];

    if (!rows.length) {
      el.pmLog.innerHTML = hiddenHere.length
        // Not "say the first thing" — there IS a conversation here and this
        // device is the reason it looks empty. Saying otherwise would be the
        // page lying to the only person who can see the difference.
        ? hiddenNoteHtml()
        : '<div class="pm-empty">' + esc(t("pm_say_first", "Say the first thing.")) + "</div>";
      return;
    }
    var room = open && open.kind === "group";
    el.pmLog.innerHTML = rows.map(function (m) {
      // A withdrawn message and an unreadable one look identical from here and
      // mean opposite things, so they are told apart before anything else. The
      // sender took this one back: there is no ciphertext on the server and no
      // key left to open it with. Calling that "encrypted for another device"
      // would blame this phone for something that happened on theirs.
      var gone = !!m.deletedAt;
      var text = gone
        ? (m.mine ? t("pm_gone_mine", "You deleted this message.")
                  : t("pm_gone", "This message was deleted."))
        : m.failed
        // An unreadable message is reported, never dropped — see the header.
        ? t("pm_unreadable", "This message was encrypted for another device.")
        : m.text;
      // In a room the name beside a message is one its sender chose for
      // themselves, and some of those people have proved nothing about who
      // they are. Saying which is the difference between "the agent said so"
      // and "somebody calling themselves that said so".
      var who = m.mine ? "" : esc(m.senderName || t("pm_someone", "Someone")) +
        (room && m.senderGuest ? " " + esc(t("pm_badge_guest", "Guest")) : "") + " · ";
      // A message carrying coordinates gets a card as well as its words. Not
      // INSTEAD of them: the sentence somebody typed above the pin is often
      // the useful half ("the blue gate, not the green one"), and a card that
      // swallowed it would lose the thing only a person could say.
      var place = (!m.failed && !gone && window.PMPlace) ? window.PMPlace.read(text) : null;
      var shown = place ? placeStripped(text) : text;
      // An invite link gets a card for the same reason a pin does, and under
      // one rule that a pin does not need: ONLY a link on this app's own
      // origin. Bodies here are escaped and never linkified on purpose, and
      // dressing an arbitrary URL as a tappable card inside an encrypted chat
      // is a phishing surface. js/lib/pm-invite-card.js holds that check.
      var invite = (!m.failed && !gone && !place && window.PMInviteCard)
        ? window.PMInviteCard.read(text) : null;
      if (invite) shown = window.PMInviteCard.stripped(text);

      return '<div class="pm-msg' + (m.mine ? " mine" : "") + (m.failed ? " failed" : "") +
        (gone ? " gone" : "") +
        (place ? " has-place" : "") +
        (invite ? " has-invite" : "") +
        '" data-msg="' + esc(m.id || "") + '">' +
        quoteHtml(m) + (place ? window.PMPlace.card(place, {
          // Who sent it, so that saving the pin keeps the one fact the pin
          // itself cannot carry. Only for messages that came IN: a pin this
          // device sent is its own guess coming back, and stamping our own
          // name on it as provenance would be a listing quoting itself.
          from: m.mine ? "" : (m.senderName || ""),
          fromId: m.mine ? "" : (m.senderId || ""),
          guest: !m.mine && !!m.senderGuest,
          msgId: m.id || "", at: m.at || "",
        }) : "") +
        (invite ? window.PMInviteCard.card(invite, { mine: !!m.mine }) : "") +
        esc(shown) +
        '<span class="pm-msg-at">' + who + esc(clock(m.at)) +
        // Answering is offered on every message including one this device
        // cannot open: the id is what gets sent, not the words, so replying
        // to something unreadable is a perfectly sensible thing to do in a
        // room you joined late.
        // A withdrawn message carries neither button. There is nothing to
        // quote, nothing to copy and nothing left to delete, and three dead
        // controls on a tombstone is an invitation to find that out by tapping.
        (m.id && !gone
          ? '<button class="pm-msg-act" type="button" data-reply="' + esc(m.id) + '">' +
              esc(t("pm_reply", "Reply")) + "</button>" : "") +
        // Everything else a person might want to do with one message, behind
        // one dot menu rather than three more words on every bubble. Reply
        // stays outside it because it is the one people came for.
        (m.id && !gone
          ? '<button class="pm-msg-more" type="button" data-menu="' + esc(m.id) + '"' +
              ' aria-label="' + esc(t("pm_msg_more", "More")) + '">' + PMIcons.more + "</button>" : "") +
        "</span></div>";
    }).join("") + hiddenNoteHtml();
    el.pmLog.scrollTop = el.pmLog.scrollHeight;
  }

  /**
   * "You hid three of these."
   *
   * Drawn whenever this device is holding something back, because a
   * conversation with a silent gap in it is the thing this page refuses to do
   * anywhere else: an undecryptable message is SHOWN with a line saying why
   * (see the header of this file), and a message somebody hid deserves the
   * same honesty. It also makes the action undoable without a settings screen,
   * which is the whole reason hiding never destroys anything.
   */
  function hiddenNoteHtml() {
    if (!hiddenHere.length) return "";
    return '<div class="pm-hidnote"><span>' +
      esc(hiddenHere.length === 1
        ? t("pm_hidden_one", "1 message is hidden on this device.")
        : t("pm_hidden_n", "{n} messages are hidden on this device.", { n: hiddenHere.length })) +
      '</span><button class="pm-hidnote-b" type="button" id="pmUnhide">' +
      esc(t("pm_hidden_show", "Show them")) + "</button></div>";
  }

  /**
   * Stop drawing one message here, and say plainly that here is all it means.
   *
   * The dialog is not a confirmation in the usual sense. The action is
   * reversible and destroys nothing, so there is no risk to warn about. What
   * it exists for is the OTHER half: people arrive at a Delete button in a
   * chat app expecting it to reach the other phone, and this one cannot. The
   * sentence explaining that has to be read before the tap, not discovered
   * afterwards when it matters.
   */
  function askHideMessage(id) {
    var src = findRow(id);
    var quoted = (src && !src.failed && src.text) ? snip(src.text) : "";
    modal("<h2>" + esc(t("pm_del_t", "Delete on this device?")) + "</h2>" +
      (quoted ? '<p class="pm-modal-quote">' + esc(quoted) + "</p>" : "") +
      "<p>" + esc(t("pm_del_d",
        "It disappears from this phone only. Whoever you were talking to keeps their copy, and there is no way for this app to reach into their phone and take it back.")) +
      "</p>" +
      "<p>" + esc(t("pm_del_d2", "Nothing is destroyed. You can show it again from the line at the bottom of the conversation.")) + "</p>" +
      '<div class="pm-modal-acts">' +
      '<button class="pm-btn ghost" id="pmDelNo">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
      '<button class="pm-btn is-danger" id="pmDelYes">' + esc(t("pm_del_go", "Hide it here")) + "</button>" +
      "</div>");
    document.getElementById("pmDelNo").addEventListener("click", closeModal);
    document.getElementById("pmDelYes").addEventListener("click", function () {
      var saved = window.PMHidden && window.PMHidden.hide(me && me.userId, id);
      closeModal();
      if (!saved) {
        // A refused write is the one failure worth interrupting for: the
        // message would come straight back on the next redraw and look like
        // the button did nothing.
        alert(t("pm_del_fail", "This browser would not save that, so the message is still here."));
        return;
      }
      // If the message being hidden is the one being answered, the reply strip
      // above the composer is now pointing at something invisible.
      if (replyTo && replyTo.id === id) clearReply();
      renderLog(lastRows);
    });
  }

  function unhideAllHere() {
    if (!window.PMHidden || !hiddenHere.length) return;
    window.PMHidden.showAll(me && me.userId, hiddenHere);
    renderLog(lastRows);
  }

  /**
   * Everything you can do to one message, in one sheet.
   *
   * A sheet rather than three more buttons on the bubble: a chat bubble is
   * already carrying a quote, a place card, a timestamp, a sender name and a
   * Reply, and the fourth thing added to that row is the one that pushes the
   * first off the screen on a 390px phone.
   */
  function showMsgMenu(id) {
    var src = findRow(id);
    if (!src) return;
    var canCopy = !src.failed && !!src.text;
    modal("<h2>" + esc(t("pm_msg_actions", "This message")) + "</h2>" +
      '<div class="pm-sheet">' +
      '<button class="pm-sheet-b" type="button" id="pmMmReply">' +
        "<b>" + esc(t("pm_reply", "Reply")) + "</b><span>" +
        esc(t("pm_msg_reply_d", "Quote it in your next message.")) + "</span></button>" +
      (canCopy
        ? '<button class="pm-sheet-b" type="button" id="pmMmCopy">' +
          "<b>" + esc(t("pm_msg_copy", "Copy the words")) + "</b><span>" +
          esc(t("pm_msg_copy_d", "Put the text on this phone's clipboard.")) + "</span></button>"
        : "") +
      // Unsend comes FIRST of the two deletes, and only on your own messages.
      // It is the one people are looking for when they tap Delete, and putting
      // the device-only one above it is how somebody hides a wrong price on
      // their own phone and leaves it standing on the other.
      (src.mine
        ? '<button class="pm-sheet-b is-danger" type="button" id="pmMmUnsend">' +
          "<b>" + esc(t("pm_unsend", "Delete for everyone")) + "</b><span>" +
          esc(t("pm_unsend_d", "Removes it from the server and from their app. Anything already saved or photographed stays theirs.")) +
          "</span></button>"
        : "") +
      '<button class="pm-sheet-b is-danger" type="button" id="pmMmDel">' +
        "<b>" + esc(t("pm_del_t2", "Delete for me")) + "</b><span>" +
        esc(t("pm_msg_del_d", "Hidden on this device. They keep their copy.")) + "</span></button>" +
      "</div>" +
      '<div class="pm-modal-acts"><button class="pm-btn ghost" id="pmMmX">' +
      esc(t("pm_close", "Close")) + "</button></div>");

    document.getElementById("pmMmX").addEventListener("click", closeModal);
    document.getElementById("pmMmReply").addEventListener("click", function () {
      closeModal();
      setReply(id);
    });
    var copyBtn = document.getElementById("pmMmCopy");
    if (copyBtn) copyBtn.addEventListener("click", function () {
      var text = (findRow(id) || {}).text || "";
      var done = function () {
        copyBtn.classList.add("is-done");
        copyBtn.querySelector("b").textContent = t("pm_msg_copied", "Copied");
      };
      // navigator.clipboard is absent on http and refused in some webviews, so
      // the old selection trick is kept as the fallback rather than the button
      // silently doing nothing on exactly the devices this app is installed on.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { if (legacyCopy(text)) done(); });
      } else if (legacyCopy(text)) { done(); }
    });
    document.getElementById("pmMmDel").addEventListener("click", function () {
      closeModal();
      askHideMessage(id);
    });
    var unsend = document.getElementById("pmMmUnsend");
    if (unsend) unsend.addEventListener("click", function () {
      closeModal();
      askUnsendMessage(id);
    });
  }

  /**
   * Take a message back, from the server and from everybody's app.
   *
   * The dialog carries the one sentence that separates this from the other
   * Delete: what it cannot do. It removes the ciphertext and every key that
   * could open it, so there is nothing left to read anywhere, including here.
   * It does not reach into a phone that already downloaded and opened it, and
   * nothing ever could. Someone deleting a wrong price needs to know which of
   * those two they are getting BEFORE they tap, not afterwards.
   */
  function askUnsendMessage(id) {
    var src = findRow(id);
    var quoted = (src && !src.failed && src.text) ? snip(src.text) : "";
    modal("<h2>" + esc(t("pm_unsend_t", "Delete this for everyone?")) + "</h2>" +
      (quoted ? '<p class="pm-modal-quote">' + esc(quoted) + "</p>" : "") +
      "<p>" + esc(t("pm_unsend_d1",
        "The message is removed from the server, and from the app on every phone it reached. Nobody can open it again, including us.")) + "</p>" +
      "<p>" + esc(t("pm_unsend_d2",
        "What it cannot do is take back a copy somebody already read, photographed or wrote down. Nothing can do that.")) + "</p>" +
      "<p>" + esc(t("pm_unsend_d3",
        "A line saying the message was deleted stays in its place, so the conversation still makes sense.")) + "</p>" +
      '<div class="pm-modal-acts">' +
      '<button class="pm-btn ghost" id="pmUnNo">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
      '<button class="pm-btn is-danger" id="pmUnYes">' + esc(t("pm_unsend_go", "Delete for everyone")) + "</button>" +
      "</div><div class=\"pm-msg-out\" id=\"pmUnMsg\"></div>");

    document.getElementById("pmUnNo").addEventListener("click", closeModal);
    document.getElementById("pmUnYes").addEventListener("click", async function (e) {
      var btn = e.currentTarget;          // captured, never read after an await
      var out = document.getElementById("pmUnMsg");
      btn.disabled = true;
      try {
        var at = await window.PMStore.messageDelete(id);
        // Redraw from the copy in hand rather than refetching the thread: the
        // server has already agreed, and a round trip here is a second of the
        // old text sitting on screen after somebody asked for it to go.
        var row = findRow(id);
        if (row) { row.deletedAt = at || new Date().toISOString(); row.text = null; row.failed = false; }
        if (replyTo && replyTo.id === id) clearReply();
        closeModal();
        renderLog(lastRows);
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
        btn.disabled = false;
      }
    });
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      var done = document.execCommand("copy");
      document.body.removeChild(ta);
      return done;
    } catch (_) { return false; }
  }

  /**
   * The message being answered, drawn above the answer.
   *
   * Built from `lastRows` — the copies THIS DEVICE decrypted — and never from
   * anything the server sent. The server stores only an id (see
   * supabase/features/message/p_message_replies.sql): a preview travelling
   * with the reply would be a second, independent encryption of the same
   * words, and a place where a client could attach text the original never
   * contained.
   *
   * Two honest failures, both said plainly rather than guessed at:
   *   • the original is outside the page that was loaded — "an earlier
   *     message";
   *   • the original is in the page but will not open, because it predates
   *     this device or this membership — the same sentence, because from the
   *     reader's side those are the same fact.
   */
  function quoteHtml(m) {
    if (!m.replyTo) return "";
    var src = findRow(m.replyTo);
    // A withdrawn parent says so. "An earlier message" would be true and
    // useless: the reader can see the answer and is entitled to know that the
    // question was taken back rather than that it scrolled out of reach.
    if (src && src.deletedAt) {
      return '<span class="pm-quote is-gone"><span>' +
        esc(t("pm_gone", "This message was deleted.")) + "</span></span>";
    }
    if (!src || src.failed || !src.text) {
      return '<span class="pm-quote is-gone"><span>' +
        esc(t("pm_reply_gone", "an earlier message")) + "</span></span>";
    }
    var who = src.mine ? t("pm_you_short", "You")
                       : (src.senderName || t("pm_someone", "Someone"));
    return '<button class="pm-quote" type="button" data-goto="' + esc(src.id) + '">' +
      "<b>" + esc(who) + "</b><span>" + esc(snip(src.text)) + "</span></button>";
  }

  function findRow(id) {
    for (var i = 0; i < lastRows.length; i++) {
      if (lastRows[i].id === id) return lastRows[i];
    }
    return null;
  }

  /**
   * The words of a place message, with the machine-readable parts taken out.
   *
   * The card already prints the coordinates and offers the map, so leaving
   * the raw pair and a 60-character URL underneath it says everything twice
   * and makes the bubble twice as tall. What is kept is exactly what a person
   * typed — and when they typed nothing, nothing is kept.
   */
  function placeStripped(text) {
    var out = String(text)
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/geo:\S+/gi, "")
      .replace(/\(?~\s*\d{1,5}\s*m\)?/gi, "")
      .replace(/(-?\d{1,2}\.\d{3,})\s*[,; ]\s*(-?\d{1,3}\.\d{3,})/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();
    // The label is already the card's heading. Repeating it under the card is
    // the same sentence twice.
    return out;
  }

  // One line of it. A quote that can grow to the height of the message it
  // quotes stops being a reference and becomes a second copy.
  function snip(text) {
    var one = String(text || "").replace(/\s+/g, " ").trim();
    return one.length > 90 ? one.slice(0, 89) + "…" : one;
  }

  /**
   * Choose what to answer, or stop answering it.
   *
   * The quoted text is captured HERE, at the moment of choosing, so the strip
   * above the composer keeps saying the same thing even after the log
   * redraws underneath it — which it does on every incoming message.
   */
  function setReply(id) {
    var src = id ? findRow(id) : null;
    if (!src) { clearReply(); return; }
    replyTo = {
      id: src.id,
      name: src.mine ? t("pm_you_short", "You") : (src.senderName || t("pm_someone", "Someone")),
      text: src.failed ? t("pm_reply_gone", "an earlier message") : snip(src.text),
    };
    drawReplyBar();
    if (el.pmInput && !el.pmInput.disabled) el.pmInput.focus();
  }

  function clearReply() {
    replyTo = null;
    drawReplyBar();
  }

  function drawReplyBar() {
    if (!el.pmReplyBar) return;
    if (!replyTo) { el.pmReplyBar.hidden = true; el.pmReplyBar.innerHTML = ""; return; }
    el.pmReplyBar.innerHTML =
      '<span class="pm-rb-tx"><b>' +
        esc(t("pm_reply_to", "Replying to {name}", { name: replyTo.name })) +
      '</b><span class="pm-rb-body">' + esc(replyTo.text) + "</span></span>" +
      '<button class="pm-rb-x" type="button" id="pmReplyX" aria-label="' +
        esc(t("pm_reply_cancel", "Stop replying")) + '">×</button>';
    el.pmReplyBar.hidden = false;
    var x = document.getElementById("pmReplyX");
    if (x) x.addEventListener("click", clearReply);
  }

  // Jump to the message a quote points at. It is the whole reason a quote is
  // tappable: in a busy room the answer is on screen and the question is not.
  function gotoMessage(id) {
    var node = el.pmLog.querySelector('[data-msg="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (!node) return;
    try { node.scrollIntoView({ block: "center", behavior: "smooth" }); }
    catch (_) { node.scrollIntoView(); }
    node.classList.remove("is-flash");
    // Reading offsetWidth restarts the animation; without it a second tap on
    // the same quote does nothing visible.
    void node.offsetWidth;
    node.classList.add("is-flash");
  }

  async function sendCurrent(text) {
    if (!open) return;
    if (open.kind === "ai") return sendToAi(text);
    el.pmSendBtn.disabled = true;
    // Taken and cleared BEFORE the round trip. The strip has to go the moment
    // the message leaves, or a second message typed while the first is still
    // in flight silently answers the same thing again.
    var answering = replyTo ? replyTo.id : null;
    clearReply();
    // The pin joins the words rather than going as a second message: "the blue
    // gate, not the green one" and the coordinates are one statement, and
    // splitting them means the sentence can arrive without the place or the
    // place without the sentence.
    var body = text;
    var pin = pendingPlace();
    if (pin && window.PMPlace) {
      body = window.PMPlace.compose(pin, text);
      clearAttach();
    }
    try {
      await window.PMStore.send(open.threadId, body, { replyTo: answering });
      renderLog(await window.PMStore.messages(open.threadId));
      refreshInbox();
    } catch (err) {
      var msg = (err && err.message) === "NOBODY_REACHABLE"
        ? t("pm_unreachable", "They have not set up P-Message yet, so there is no key to encrypt to.")
        : ((err && err.message) || String(err));
      el.pmLog.insertAdjacentHTML("beforeend",
        '<div class="pm-msg failed">' + esc(msg) + "</div>");
      el.pmLog.scrollTop = el.pmLog.scrollHeight;
    } finally {
      el.pmSendBtn.disabled = false;
    }
  }

  // ---- sending a place -----------------------------------------------------
  // Four doors onto a pin, the strip that holds one before it is sent, and the
  // sheet that opens one somebody sent: all of it is js/lib/pm-place-ui.js now.
  // The page keeps thin names for the handful of call sites it already had, so
  // nothing below this point had to learn a new spelling.
  if (window.PMPlaceUI) window.PMPlaceUI.attach({
    t: t, esc: esc, el: el, modal: modal, closeModal: closeModal,
    // A getter. The module is asked on every draw and `open` is reassigned
    // every time a conversation is opened or closed.
    open: function () { return open; },
  });
  function showPlacePicker() { window.PMPlaceUI.pick(); }
  function attachPlace(p) { return window.PMPlaceUI.attachPlace(p); }
  function clearAttach() { return window.PMPlaceUI.clear(); }
  function openPlaceMap(p) { return window.PMPlaceUI.openMap(p); }
  function closePlaceMap() { return window.PMPlaceUI.closeMap(); }
  function savePlace(p) { return window.PMPlaceUI.save(p); }
  function placeOfButton(b) { return window.PMPlaceUI.placeOf(b); }
  /** The pin waiting to go with the next message, or null. Never cached. */
  function pendingPlace() { return window.PMPlaceUI.pending(); }
  // ---- PN-Zaki -------------------------------------------------------------
  //
  //  The brain, the tool belt and the voice session are in js/lib/pn-zaki.js;
  //  what any of it looks like is in js/lib/pn-zaki-ui.js. This page owns
  //  exactly two things: WHERE PN-Zaki is drawn, and the log.
  //
  //  The log lives in memory, for exactly as long as this page does. A reload
  //  takes it, and that is the point.
  //
  //  It used to be localStorage, which meant the transcript outlived the
  //  conversation it was a transcript of: js/lib/pn-zaki.js keeps the model's
  //  own `conversation` in a plain array, so a refresh already emptied it.
  //  What came back after a reload was a thread the assistant could not
  //  remember a word of. It read like something being continued and answered
  //  like a stranger, and the fix is not to persist the model's side as well:
  //  this is the single thread on this screen that is NOT end-to-end
  //  encrypted, so the less of it that is written down anywhere, the better.
  //  Every other thread here is on the server because it has to reach
  //  somebody else. This one has nowhere to go.
  //
  //  A spoken line and a typed line land in the SAME log, in order, which is
  //  the whole point of folding the old "Voice AI" tab into this thread, and
  //  every writer re-reads the log before appending: a line spoken while a
  //  typed question is still in flight must not be lost under that question's
  //  stale copy of the rows. So aiLog() hands out a COPY and saveAiLog()
  //  replaces the array outright. Nothing mutates it in place.
  var aiRows = [];
  // Earlier versions wrote this log to the device. Delete what they left
  // behind rather than abandoning it there for good. This sits at the top
  // level of the file on purpose, so it runs on every load of this page and
  // not only when somebody opens the assistant. It is still the only thing
  // that deletes the key, so a person who never opens p-message.html again
  // keeps their old log; there is nowhere better to put it, since this page
  // is the only reason the key ever existed.
  try { localStorage.removeItem(AI_STORE); } catch (_) {}
  function aiLog() {
    return aiRows.slice();
  }
  function saveAiLog(rows) {
    aiRows = rows.slice(-40);
  }

  function renderAiPane() {
    if (!el.pmAiRow || !window.PNZakiUI) return;
    var last = aiLog().slice(-1)[0];
    window.PNZakiUI.renderPane(el.pmAiRow, {
      t: t,
      last: last ? last.text : "",
      onOpen: function () { openAi(); },
      onVoice: function () { openAi({ voice: true }); },
      onAsk: function (q) { openAi({ ask: q }); },
    });
  }

  function renderAiLog(thinking) {
    if (!el.pmLog || !window.PNZakiUI) return;
    window.PNZakiUI.renderLog(el.pmLog, aiLog(), { t: t, thinking: !!thinking });
  }

  // The dock is built the first time something asks for it and then kept, so
  // the mic can be shown and hidden without rebuilding a live audio session
  // underneath it.
  var voiceUI = null;
  function voiceDock() {
    if (voiceUI) return voiceUI;
    if (!window.PNZakiUI || !el.pmVoiceDock) return null;
    voiceUI = window.PNZakiUI.attachVoice({
      dock: el.pmVoiceDock,
      t: t,
      // A transcript is a message. It is appended to the same log a typed
      // message goes to, and the log is RE-READ first: a line spoken while a
      // typed question was still in flight would otherwise be overwritten by
      // that question's stale copy of the rows.
      onLine: function (role, text) {
        var rows = aiLog();
        rows.push({ role: role === "user" ? "user" : "assistant", text: text, voice: true });
        saveAiLog(rows);
        if (open && open.kind === "ai") renderAiLog();
        renderAiPane();
      },
      onState: function (state) {
        if (!el.pmVoiceBtn) return;
        el.pmVoiceBtn.classList.toggle("is-on", state !== "idle" && state !== "error");
      },
      onHide: function () {
        if (el.pmVoiceBtn) el.pmVoiceBtn.classList.remove("is-on");
      },
    });
    return voiceUI;
  }

  // The one door into the PN-Zaki thread, from all three ways in: the hero
  // button, the voice button, and a tapped suggestion.
  function openAi(opts) {
    opts = opts || {};
    openThread({
      threadId: AI_THREAD, kind: "ai",
      name: t("pm_ai_name", "PN-Zaki assistant"),
      sub: t("pm_ai_sub_voice", "AI \u00b7 type or talk \u00b7 not encrypted"),
    });
    if (opts.voice) { var d = voiceDock(); if (d) d.show(); }
    // A tapped suggestion is a question somebody asked, not text put in a box
    // for them to press send on — the tap WAS the send.
    if (opts.ask) sendToAi(opts.ask);
  }

  async function sendToAi(text) {
    var rows = aiLog();
    rows.push({ role: "user", text: text });
    saveAiLog(rows);
    renderAiLog(true);
    el.pmSendBtn.disabled = true;
    var answer;
    try {
      if (!window.PNZaki) throw new Error("PN-Zaki unavailable");
      answer = (await window.PNZaki.ask(text)).text;
    } catch (err) {
      // Every brain being unreachable is a deployment fact, not a mystery.
      // Say so plainly rather than leaving a question that never gets an
      // answer sitting at the bottom of the log.
      answer = t("pm_ai_down", "PN-Zaki is not available right now.");
    }
    // Re-read rather than reusing the array from before the await: a spoken
    // line may have landed in the log while the model was thinking, and
    // pushing onto the stale copy would delete it.
    rows = aiLog();
    rows.push({ role: "assistant", text: answer });
    saveAiLog(rows);
    if (open && open.kind === "ai") renderAiLog();
    renderAiPane();
    el.pmSendBtn.disabled = false;
  }

  // ---- safety number, backup, broadcast ------------------------------------
  // The three key dialogs live in js/lib/pm-identity-ui.js, because Profile
  // needs the same ones and two copies of a dialog that hands out a private
  // key is not a duplication worth risking. Wired to this page's modal shell.
  window.PMIdentityUI.attach({
    backdrop: el.pmModalBack, panel: el.pmModal, t: t,
    fingerprint: function () { return fingerprint; },
    userId: function () { return me && me.userId; },
    onChange: async function (res) {
      fingerprint = res.fingerprint;
      // The chip's label does not carry the number, so a new key changes
      // nothing about it. The dialog behind it reads `fingerprint` when it
      // opens, which is what has just moved.
      await refreshInbox();
    },
  });
  var showBackup = function () { window.PMIdentityUI.backup(); };

  // The block dialogs. Handed this page's modal rather than opening one of
  // their own, so there is one backdrop on the screen and one thing that
  // closes it.
  if (window.PMBlock) window.PMBlock.attach({
    t: t, esc: esc, modal: modal, closeModal: closeModal,
    after: async function (msg) { say(msg); await refreshInbox(); },
  });

  // The two dialogs that reach more than one person are js/lib/pm-announce-ui.js
  // now. They share a shape with each other and nothing with the rest of this
  // file, and the reasoning that must not be undone -- the basket IS the
  // audience, a room is not an announcement -- travels with them in that file's
  // header rather than sitting in the middle of this one.
  if (window.PMAnnounceUI) window.PMAnnounceUI.attach({
    t: t, esc: esc, modal: modal, closeModal: closeModal,
    refreshInbox: function () { return refreshInbox(); },
  });
  function showBroadcast() { window.PMAnnounceUI.announce(); }
  function showRooms() { window.PMAnnounceUI.room(); }

  // ---- invite a customer ---------------------------------------------------
  // Two steps, five ways to hand the link over, and a token that is shown once
  // and is not recoverable: all of it is js/lib/pm-invite-ui.js now. The page
  // keeps only the three things it actually touches — the button that opens it,
  // the words an arriving link needs, and the question the backdrop handler
  // asks before it dares close anything.
  if (window.PMInviteUI) window.PMInviteUI.attach({
    t: t, esc: esc, modal: modal, closeModal: closeModal,
    say: function (m) { say(m); },
    refreshInbox: function () { return refreshInbox(); },
  });
  function showInvite() { window.PMInviteUI.open(); }
  function inviteExpiryWords(at) { return window.PMInviteUI.expiryWords(at); }
  // ---- arriving from somewhere that knows who you want ---------------------
  /**
   * `p-message.html?to=<user id>` — open a conversation with one person.
   *
   * jobs.html sends people here: a day job carries a poster, and "message the
   * person hiring" is a different act from "browse the agent directory and
   * find them". Nothing else about the page changes; this is the Agents-row
   * tap performed for somebody who already knew who they meant.
   *
   * The URL carries ONLY the id. The name, where they work and their key all
   * come from pm_peer, so a doctored link cannot put a borrowed name on the
   * conversation header — which, on a screen whose whole job is telling you
   * who you are talking to, is the one thing it must not be able to do.
   *
   * Failure is quiet. Someone who followed a stale link lands on the inbox,
   * which is a page that works, rather than on an error about a user id they
   * never saw.
   */
  async function openRequestedPeer() {
    if (!ready) return false;
    var want = null;
    try { want = new URLSearchParams(location.search).get("to"); } catch (_) { return false; }
    if (!want || want === (me && me.userId)) return false;

    var info = null;
    try { info = await window.PMStore.peer(want); } catch (_) { return false; }
    // No such account. A stale bookmark or a hand-typed id lands on the inbox
    // and nothing is said, because there is nobody to say anything about — an
    // apology naming a user id the reader has never seen explains nothing.
    if (!info) return false;
    if (!info.publicKey) {
      // Somebody real who has never opened P-Message. No key means no way to
      // encrypt, which is a dead end and is said as one — the same sentence
      // the directory uses for an unreachable agent.
      modal("<h2>" + esc(info.displayName || t("pm_someone", "Someone")) + "</h2><p>" +
        esc(t("pm_unreachable_d", "They have not opened P-Message yet, so there is no key to encrypt to. Their listings still carry a phone number.")) +
        '</p><div class="pm-modal-acts"><button class="pm-btn" id="pmToOk">' + esc(t("pm_close", "Close")) + "</button></div>");
      var ok = document.getElementById("pmToOk");
      if (ok) ok.addEventListener("click", closeModal);
      return false;
    }

    try {
      var threadId = await window.PMStore.startDirect(want);
      showSeg("chats");
      await refreshInbox();
      openThread({
        threadId: threadId, kind: "direct",
        name: info.displayName || t("pm_someone", "Someone"),
        sub: whereOf({ area: info.area, ward: info.ward, district: info.district, region: info.region }).line,
        otherId: want,
      });
      return true;
    } catch (_) { return false; }
  }

  // ---- arriving on an invite link ------------------------------------------
  //
  //  Runs before the normal boot decides what to show, because the answer to
  //  "who are you" is different when you arrived holding a link.
  //
  //  This is the half of the feature the sender never sees, and it was the
  //  thinner half by a long way: a name, two sentences and two buttons, on top
  //  of an empty inbox. Somebody who has never heard of this site, sent a link
  //  by a stranger they met once at a viewing, was being asked to tap "Start
  //  chatting" on the strength of a heading.
  //
  //  So it says the three things that decide it: who, what happens to them,
  //  and what it costs. And "Cancel" no longer drops them on an empty screen
  //  with nothing to do.
  async function handleInviteLink() {
    var token = new URLSearchParams(location.search).get("i");
    if (!token) return false;
    // Take it out of the address bar immediately. A bearer token sitting in a
    // URL gets shared, screenshotted and put in a browser history that syncs.
    try { history.replaceState({}, "", location.pathname); } catch (_) {}

    var info = null;
    try { info = await window.PMStore.invitePeek(token); } catch (_) {}
    if (!info) return inviteDead(t("pm_inv_bad_d", "It may have been mistyped. Ask for a new one."));
    if (info.state !== "open") {
      return inviteDead(
        info.state === "used" ? t("pm_inv_used_d", "This link has already been used.")
      : info.state === "expired" ? t("pm_inv_exp_d", "This link has expired.")
      : t("pm_inv_rev_d", "This link was withdrawn."));
    }

    var who = info.agent_name || t("pm_someone", "Someone");
    var expiry = inviteExpiryWords(info.expires_at);

    modal("<h2>" + esc(t("pm_inv_hi", "{who} wants to chat with you", { who: who })) + "</h2>" +
      '<p class="pm-role">' + esc(t("pm_inv_hi_role",
        "You were sent a private link. Opening it starts one conversation, with them, and with nobody else.")) + "</p>" +
      // Three facts, as facts, because this is a stranger's first sentence
      // about this site and a paragraph of reassurance reads as sales.
      '<ul class="pm-inv-facts">' +
        "<li>" + esc(t("pm_inv_fact_free", "No account, no password, no phone number.")) + "</li>" +
        "<li>" + esc(t("pm_inv_fact_e2e", "Your messages are locked on this phone. Nobody else, including us, can open them.")) + "</li>" +
        "<li>" + esc(t("pm_inv_fact_device", "The key stays in this browser. Clearing it, or changing phone, loses the conversation.")) + "</li>" +
      "</ul>" +
      (expiry
        ? '<p class="pm-hint">' + esc(t("pm_inv_expires_on", "It stops working on {date}.", { date: expiry })) + "</p>"
        : "") +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn" id="pmInvOk">' + esc(t("pm_inv_start", "Start chatting")) + "</button>" +
        '<button class="pm-btn ghost" id="pmInvNo">' + esc(t("pm_inv_not_now", "Not now")) + "</button>" +
      "</div>" +
      '<div class="pm-msg-out" id="pmInvOut"></div>');

    // "Not now" used to close the dialog onto an empty inbox belonging to a
    // session that did not exist, which is a dead end wearing the clothes of a
    // choice. It goes home instead: the site has a front page, and somebody
    // who has decided not to open a stranger's link should land on it.
    document.getElementById("pmInvNo").addEventListener("click", function () {
      location.href = "index.html";
    });

    document.getElementById("pmInvOk").addEventListener("click", async function (e) {
      var out = document.getElementById("pmInvOut");
      var btn = e.currentTarget;      // captured, never read after an await
      btn.disabled = true;
      out.className = "pm-msg-out";
      out.textContent = t("pm_inv_setting", "Setting up encryption…");
      try {
        var meNow = await window.PMStore.me();
        if (!meNow || !meNow.userId) await window.PMStore.signInAsGuest(null, null);
        await window.PMStore.ensureIdentity({});
        var threadId = await window.PMStore.inviteAccept(token);
        closeModal();
        await boot();
        openThread({ threadId: threadId, kind: "direct", name: who, sub: "" });
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
        btn.disabled = false;
      }
    });
    return true;
  }

  /**
   * A link that will never work, with the reason.
   *
   * All three reasons get their own sentence, because "this link doesn't work"
   * is the least useful thing to tell somebody standing in a doorway with a
   * phone: withdrawn means ask them, expired means ask for a new one, used
   * means somebody already has this conversation and it may not be you.
   *
   * The way out is the front page, not a closed dialog over a blank screen.
   */
  function inviteDead(why) {
    modal("<h2>" + esc(t("pm_inv_bad_t", "That link does not work")) + "</h2>" +
      "<p>" + esc(why) + "</p>" +
      '<p class="pm-hint">' + esc(t("pm_inv_bad_d2",
        "Nothing has gone wrong on your phone. Ask whoever sent it for another one.")) + "</p>" +
      '<div class="pm-modal-acts">' +
        '<a class="pm-btn" href="index.html">' + esc(t("pm_inv_go_home", "Go to the home page")) + "</a>" +
        '<button class="pm-btn ghost" id="pmInvX">' + esc(t("pm_close", "Close")) + "</button>" +
      "</div>");
    document.getElementById("pmInvX").addEventListener("click", closeModal);
    return true;
  }

  // ---- wiring --------------------------------------------------------------
  function wire() {
    // A tap on the backdrop closes whatever dialog is open, which is right for
    // all of them but one. Step 2 of an invite is holding the ONLY copy of a
    // token the server never saw: closing it there does not dismiss a screen,
    // it destroys a link the agent has not sent yet, and a link that is gone
    // cannot be got back by reopening anything.
    //
    // Capture phase, because PMIdentityUI.attach() has its own backdrop
    // listener that closes on the way up and registration order between the
    // two is not something this should depend on.
    el.pmModalBack && el.pmModalBack.addEventListener("click", function (e) {
      if (e.target !== el.pmModalBack) return;
      // Both conditions, and the second is not belt-and-braces. The pending
      // link lives as long as the page does, so on its own it would go on
      // refusing to close the SAFETY-NUMBER dialog an hour after a link was
      // made, which is a dialog nobody could dismiss. #pmInvMsg2 exists only
      // while the send screen is actually on the glass.
      var out = document.getElementById("pmInvMsg2");
      var pending = window.PMInviteUI && window.PMInviteUI.pending();
      if (!pending || !out) return;
      e.stopPropagation();
      out.className = "pm-msg-out bad";
      out.textContent = t("pm_inv_keep",
        "Send the link first. Closing this loses it, and we cannot show it again.");
    }, true);

    el.segChats && el.segChats.addEventListener("click", function () { showSeg("chats"); });
    el.segPeople && el.segPeople.addEventListener("click", function () { showSeg("people"); });
    el.segAi && el.segAi.addEventListener("click", function () { showSeg("ai"); });

    el.pmInbox && el.pmInbox.addEventListener("click", function (e) {
      // The dots sit BESIDE the row, not inside it: a button cannot contain a
      // button, and browsers repair that markup by moving the inner one out.
      // So this is tested first and returns, rather than relying on the row
      // test failing.
      var menuBtn = e.target.closest("[data-chat-menu]");
      if (menuBtn) { showChatMenu(menuBtn); return; }
      var row = e.target.closest("[data-thread]");
      if (!row) return;
      openThread({
        threadId: row.dataset.thread, kind: row.dataset.kind,
        name: row.dataset.name, sub: row.dataset.sub, otherId: row.dataset.other || null,
        myRole: row.dataset.role || "member",
      });
    });

    el.pmPeople && el.pmPeople.addEventListener("click", async function (e) {
      // The dots sit inside the actions strip, which is a SIBLING of the row
      // button, so this is not a click on the row and must be answered before
      // the row lookup rather than after it.
      var dots = e.target.closest("[data-person-menu]");
      if (dots) { window.PMDirectoryUI.personMenu(dots); return; }
      var row = e.target.closest("[data-person]");
      if (!row) return;
      if (row.dataset.unreachable) {
        // Offering a chat that cannot be encrypted would be a dead end dressed
        // up as a feature.
        modal("<h2>" + esc(row.dataset.name) + "</h2><p>" +
          esc(t("pm_unreachable_d", "They have not opened P-Message yet, so there is no key to encrypt to. Their listings still carry a phone number.")) +
          '</p><div class="pm-modal-acts"><button class="pm-btn" id="pmUnOk">' + esc(t("pm_close", "Close")) + "</button></div>");
        document.getElementById("pmUnOk").addEventListener("click", closeModal);
        return;
      }
      row.disabled = true;
      try {
        var threadId = await window.PMStore.startDirect(row.dataset.person);
        showSeg("chats");
        await refreshInbox();
        openThread({ threadId: threadId, kind: "direct", name: row.dataset.name,
          sub: row.dataset.sub, otherId: row.dataset.person });
      } catch (err) {
        alert((err && err.message) || String(err));
      } finally { row.disabled = false; }
    });

    // The PN-Zaki pane binds its own handlers once, inside
    // js/lib/pn-zaki-ui.js — it is redrawn after every message, and a listener
    // added here on each redraw is the accumulating-handler bug documented at
    // the top of this file.

    // The header microphone shows and hides the dock. It does NOT start
    // recording: that is the dock's own button, and keeping them separate is
    // what stops a thread being opened from opening a microphone.
    el.pmVoiceBtn && el.pmVoiceBtn.addEventListener("click", function () {
      var d = voiceDock();
      if (!d) return;
      if (d.visible()) d.hide(); else d.show();
    });

    // One delegated listener on the log, bound once. The log's innerHTML is
    // rewritten on every incoming message, so anything bound to a bubble
    // would be rebound on each redraw — and with an anonymous handler that
    // accumulates silently (see docs/P_MESSAGE.md on the invite-revoke bug).
    el.pmLog && el.pmLog.addEventListener("click", function (e) {
      var reply = e.target.closest("[data-reply]");
      if (reply) { setReply(reply.dataset.reply); return; }
      var more = e.target.closest("[data-menu]");
      if (more) { showMsgMenu(more.dataset.menu); return; }
      if (e.target.closest("#pmUnhide")) { unhideAllHere(); return; }
      var jump = e.target.closest("[data-goto]");
      if (jump) { gotoMessage(jump.dataset.goto); return; }
      // The coordinates ride on the button itself, not on an index into a
      // list — the log is rewritten on every incoming message, and an index
      // that pointed at row 4 before the redraw points at somebody else's
      // place after it.
      var toMap = e.target.closest("[data-place-map]");
      if (toMap) { openPlaceMap(placeOfButton(toMap)); return; }
      var toSave = e.target.closest("[data-place-save]");
      if (toSave) {
        savePlace(placeOfButton(toSave));
        toSave.disabled = true;
        toSave.textContent = t("pmp_saved", "Saved");
        return;
      }
      // Same reasoning as the pin: the link rides on the button rather than an
      // index into a log that is rewritten on every incoming message.
      var invCopy = e.target.closest("[data-inv-copy]");
      if (invCopy) {
        var was = invCopy.textContent;
        window.PMSafety.copyText(invCopy.dataset.invCopy, function (done) {
          invCopy.textContent = done ? t("pmi_copied", "Copied") : was;
          setTimeout(function () { invCopy.textContent = was; }, 2500);
        });
      }
    });

    el.pmPlaceBtn && el.pmPlaceBtn.addEventListener("click", showPlacePicker);
    el.pmMapBack && el.pmMapBack.addEventListener("click", closePlaceMap);

    el.pmBack && el.pmBack.addEventListener("click", closeThread);
    el.pmVerify && el.pmVerify.addEventListener("click", openVerify);
    el.pmMembers && el.pmMembers.addEventListener("click", showMembers);
    // Named "Your safety number", so it opens the safety numbers. It used to
    // open the BACKUP dialog, which is a different key ritual with a different
    // consequence, and a button that opens something other than its own label
    // is worse on this screen than on any other.
    el.pmFpBtn && el.pmFpBtn.addEventListener("click", function () {
      window.PMIdentityUI.safetyNumbers({ onBackup: showBackup });
    });
    el.pmBroadcastBtn && el.pmBroadcastBtn.addEventListener("click", showBroadcast);
    el.pmRoomsBtn && el.pmRoomsBtn.addEventListener("click", showRooms);
    el.pmInviteBtn && el.pmInviteBtn.addEventListener("click", showInvite);

    el.pmComposeForm && el.pmComposeForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = el.pmInput.value.trim();
      // A pin on its own is a complete message. Requiring words as well would
      // mean somebody standing at a gate has to think of a sentence before
      // they can say where they are.
      if (!text && !pendingPlace()) return;
      // The disabled textarea is the visible gate; this is the one that holds
      // if anything ever re-enables it without clearing the alarm.
      if (open && open.trust && open.trust.changed) { openVerify(); return; }
      el.pmInput.value = "";
      autosize();
      sendCurrent(text);
    });
    el.pmInput && el.pmInput.addEventListener("input", autosize);
    // The keyboard opening is a viewport resize, not a scroll event, so the
    // log has to be pulled back to the newest message by hand.
    el.pmInput && el.pmInput.addEventListener("focus", function () {
      setTimeout(function () {
        if (el.pmLog) el.pmLog.scrollTop = el.pmLog.scrollHeight;
      }, 260);
    });
    el.pmInput && el.pmInput.addEventListener("keydown", function (e) {
      // Enter sends, Shift+Enter breaks the line — the convention every other
      // chat app on the phone already taught them.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        el.pmComposeForm.dispatchEvent(new Event("submit"));
      }
    });

    var reload = function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(refreshPeople, 260);
    };
    el.pmSearch && el.pmSearch.addEventListener("input", reload);
    el.pmRegion && el.pmRegion.addEventListener("change", refreshPeople);
    el.pmWho && el.pmWho.addEventListener("change", refreshPeople);

    // The category chips. Delegated rather than bound one by one, so the strip
    // stays a list of buttons in the markup rather than something JS has to
    // build. Choosing one changes BOTH the query sent to the database and the
    // ranking applied to what comes back — the same word means "only show me
    // people who list these" and "rank them by how well they fit this".
    el.pmCats && el.pmCats.addEventListener("click", function (e) {
      var chip = e.target.closest("[data-cat]");
      if (!chip) return;
      var next = chip.dataset.cat || "";
      if (next === category) return;
      category = next;
      Array.prototype.forEach.call(el.pmCats.querySelectorAll("[data-cat]"), function (b) {
        b.classList.toggle("is-on", b === chip);
        b.setAttribute("aria-selected", b === chip ? "true" : "false");
      });
      // Pull the chosen chip fully into view. The strip scrolls sideways so
      // five chips cost one row, and the cost of that is that the chip at the
      // end can sit half off the screen — the state of the whole list below is
      // then set by something the person cannot see. "nearest" so a chip
      // already fully visible does not jump.
      if (chip.scrollIntoView) {
        try { chip.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" }); }
        catch (_) { chip.scrollIntoView(); }
      }
      refreshPeople();
    });
  }

  // An invite link changes what the page is for, so it is answered first: the
  // arriving customer has no account and boot() would otherwise show them the
  // sign-in gate instead of the invitation they were sent.
  async function start() {
    if (window.applyTranslations) window.applyTranslations();
    trackViewport();
    try { if (await handleInviteLink()) return; } catch (_) {}
    await boot();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
