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
  var pendingPlace = null;   // { lat, lng, acc, label, source } or null

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
      if (el.pmFpBtn) {
        el.pmFpBtn.hidden = false;
        el.pmFpBtn.textContent = t("pm_your_number", "Your safety number {n}", { n: fingerprint });
      }
      if (me.isAdmin && el.pmBroadcastBtn) el.pmBroadcastBtn.hidden = false;
      // Rooms are the admin's to open. Invites belong to anyone with a real
      // account -- an agent inviting a customer is the whole point -- but not
      // to a guest, who would just be minting links from an anonymous tab.
      if (me.isAdmin && el.pmRoomsBtn) el.pmRoomsBtn.hidden = false;
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
        if (el.pmFpBtn) {
          el.pmFpBtn.hidden = false;
          el.pmFpBtn.textContent = t("pm_your_number", "Your safety number {n}", { n: fingerprint });
        }
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
          (broadcast ? CAST_SVG : group ? ROOM_SVG : esc(initials(name))) + "</span>" +
        '<span class="pm-rtx"><span class="pm-name">' + esc(name) + guestTag + goneTag +
          (broadcast ? ' <span class="pm-badge">' + esc(t("pm_badge_cast", "Announcement")) + "</span>" : "") +
          (group ? ' <span class="pm-badge">' + esc(t("pm_badge_room", "Room")) + "</span>" : "") +
        '</span><span class="pm-sub">' + esc(sub || clock(r.last_at)) + "</span></span>" +
        (r.unread ? '<span class="pm-unread">' + r.unread + "</span>" : "") + "</button>" +
        (menu
          ? '<button class="pm-row-more" type="button" data-chat-menu="' + esc(r.thread_id) + '"' +
            ' data-menu-kind="' + esc(menu) + '" data-name="' + esc(name) + '"' +
            ' data-role="' + esc(r.my_role || "member") + '"' +
            ' aria-label="' + esc(t("pm_chat_more", "What to do with this conversation")) + '">' +
            MORE_SVG + "</button></div>"
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
    return "";
  }

  // ---- directory -----------------------------------------------------------
  // Drawn, not typed. A character like a star or a ringed circle renders as a
  // colour emoji on some phones and as a bare glyph on others, so the same row
  // looks like two different designs depending on who is holding it — and this
  // project uses no emoji anywhere.
  var CAST_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M4 9h3l8-5v16l-8-5H4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' +
    '<path d="M18.5 8.5a5 5 0 0 1 0 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  var ROOM_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<circle cx="9" cy="9" r="3" stroke="currentColor" stroke-width="1.8"/>' +
    '<circle cx="16.5" cy="10.5" r="2.4" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M3.5 19a5.5 5.5 0 0 1 11 0M15 19a4.6 4.6 0 0 1 5.5-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  function fillRegions() {
    if (!el.pmRegion) return;
    var names = (window.TZ_REGION_CENTERS || []).map(function (r) { return r.name; })
      .filter(Boolean).sort(function (a, b) { return a.localeCompare(b); });
    el.pmRegion.innerHTML = '<option value="">' + esc(t("pm_region_any", "Every region")) + "</option>" +
      names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + "</option>"; }).join("");
  }

  async function refreshPeople() {
    if (!ready) {
      el.pmPeople.innerHTML = '<div class="pm-empty">' + esc(t("pm_signin_d2", "Sign in to see who is out there.")) + "</div>";
      return;
    }
    el.pmPeople.dataset.loaded = "1";
    el.pmPeople.innerHTML = '<div class="pm-empty">' + esc(t("pm_loading", "Loading…")) + "</div>";
    if (el.pmCount) el.pmCount.textContent = "";
    if (el.pmShort) el.pmShort.hidden = true;

    var region = el.pmRegion ? el.pmRegion.value : "";
    var query = el.pmSearch ? el.pmSearch.value.trim() : "";
    var rows;
    try {
      // pm_agent_finder, not pm_directory: the same people, plus what each of
      // them actually deals in. Without those counts the category chips would
      // be a filter over nothing and the ranking would have no evidence to
      // rank on.
      rows = await window.PMStore.finder({
        region: region, query: query, category: category || null,
        // Every registered agent in the country, not a sample of them. 200 was
        // the old default and quietly truncated the list once enough agents
        // had signed up to make the tab worth opening.
        limit: 500,
      });
    } catch (err) {
      el.pmPeople.innerHTML = '<div class="pm-empty">' + esc((err && err.message) || err) + "</div>";
      return;
    }

    // The pane is called Agents, but the directory also returns anyone who has
    // simply opened P-Message — which is right for "who wrote to me?" and
    // wrong for "who can help me find a room".
    //
    // EVIDENCE BEATS A FLAG, and it beats it everywhere now.
    //
    // The rule used to be "is_agent, unless a category chip is on". That
    // exception was forced by day jobs: a company that hires by the day almost
    // never registers as an agent, so the Day jobs chip returned an empty
    // screen with the right answers one dropdown behind it. The flag is a
    // PROXY for "does this person deal in anything"; the listing counts are the
    // MEASUREMENT of it, and running a proxy on top of a measurement can only
    // subtract.
    //
    // The same subtraction was happening with no chip on, silently, to exactly
    // the same people: the company that posts twelve jobs a month, the
    // landlord with four rooms who never registered, the man with two lorries.
    // Every one of them is an agent in the only sense that matters on this
    // screen, somebody with something to offer and a way to be reached, and
    // every one of them was missing from the pane whose whole job is listing
    // them. So the default is now "registered as an agent OR has something
    // listed", and the flag only ever adds.
    //
    // What is still excluded by default is somebody with no listings who
    // merely opened P-Message. They are one dropdown away, where they belong:
    // that is a person, not a provider, and offering them as an answer to
    // "who can move a fridge" would be noise dressed up as a result.
    var wantProviders = !el.pmWho || el.pmWho.value !== "all";
    var shown = (wantProviders && !category)
      ? rows.filter(function (p) { return p.is_agent || hasListings(p); })
      : rows;

    if (!shown.length) {
      el.pmPeople.innerHTML = '<div class="pm-empty">' + esc(emptyWhy(rows.length, wantProviders)) + "</div>";
      return;
    }

    // The order is computed HERE, on the device, and not by the database:
    // it depends on what this person is looking for, and the query that
    // fetched the rows was never told. js/lib/pm-match.js explains every term.
    var need = {
      category: category || null,
      query: query,
      region: region || null,
    };
    var ranked = window.PMMatch.rank(shown, need);

    if (el.pmCount) {
      // "12 agents" would be a lie about a list that also holds a construction
      // firm and a landlord. The word follows what is actually on screen, row
      // by row, rather than following which filter happens to be set.
      var onlyAgents = ranked.every(function (x) { return !!x.agent.is_agent; });
      el.pmCount.textContent =
        t(onlyAgents ? "pm_count_agents" : "pm_count_people",
          onlyAgents ? "{n} agents" : "{n} people", { n: ranked.length }) +
        (region ? " · " + region : "") +
        (category ? " · " + catName(category) : "");
    }

    renderShortlist(ranked);
    el.pmPeople.innerHTML = ranked.map(personRow).join("");
  }

  // Why the list is empty, said precisely. "Nobody matches" is four different
  // situations wearing one sentence, and three of them have a way out that
  // the fourth does not.
  function emptyWhy(total, wantProviders) {
    if (category && total) {
      // Jobs get their own sentence rather than being forced through the
      // listing one. Nobody "lists day jobs" — a company posts them — and the
      // way out is different too: an employer who has never opened P-Message
      // cannot be found here at all, so the advice has to say so.
      if (category === "jobs") {
        return t("pm_no_jobs", "Nobody here has posted day jobs in that scope. Try Anyone, a wider region, or the jobs board itself.");
      }
      return t("pm_no_cat", "Nobody listing {what} matches that. Try Anyone, a wider region, or fewer words.",
               { what: catName(category).toLowerCase() });
    }
    if (total && wantProviders) {
      return t("pm_no_agents", "Nobody with anything listed matches that. Switch to Everyone to see other people on P-Message.");
    }
    return t("pm_no_people", "Nobody matches that yet.");
  }

  function catName(cat) {
    return cat === "houses" ? t("pm_cat_houses", "Rooms & houses")
         : cat === "services" ? t("pm_cat_services", "Daily services")
         : cat === "trucks" ? t("pm_cat_trucks", "Moving trucks")
         : cat === "jobs" ? t("pm_cat_jobs", "Day jobs")
         : t("pm_cat_any", "Anyone");
  }

  /**
   * "Write to these three and one of them can probably help."
   *
   * The only number this screen prints, and it is printed because a
   * COMBINATION is the point of it: three separate badges saying 40% cannot
   * be added up by eye, and the answer is not 120%. PMMatch.shortlist does it
   * with a shared-failure factor — agents piled into one ward fail together —
   * so the figure is deliberately lower than the naive one and can never
   * reach certainty.
   *
   * Only drawn with a category chosen. "How likely is somebody to help" has
   * no meaning until "help with what" has been answered, and printing a
   * confident-looking number against an unstated question is the kind of
   * thing this page does not do.
   */
  function renderShortlist(ranked) {
    if (!el.pmShort) return;
    if (!category || ranked.length < 2) { el.pmShort.hidden = true; return; }

    var s = window.PMMatch.shortlist(ranked, SHORTLIST_TARGET, { max: 5 });
    if (!s.picks.length) { el.pmShort.hidden = true; return; }

    var names = s.picks.map(function (x) {
      return x.agent.display_name || t("pm_someone", "Someone");
    });
    var pct = Math.round(s.p * 100);

    el.pmShort.innerHTML =
      "<span>" + esc(t("pm_short_lead", "Write to {who}", { who: joinNames(names) })) + " — <b>" +
      esc(t("pm_short_odds", "about a {pct}% chance one of them can help", { pct: pct })) + "</b>.</span>" +
      "<small>" + esc(s.capped
        ? t("pm_short_capped", "That is as high as it goes here — messaging more people does not make a thing exist. Estimated from what they list and where they work, not from anyone's replies.")
        : t("pm_short_note", "Estimated from what they list and where they work, not from anyone's replies. People working the same street tend to be out of the same things, so the figure allows for that.")) +
      "</small>";
    el.pmShort.hidden = false;
  }

  function joinNames(names) {
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(", ") + " " + t("pm_and", "and") + " " + names[names.length - 1];
  }

  var PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z" stroke="currentColor" stroke-width="2"/>' +
    '<circle cx="12" cy="10" r="2.4" stroke="currentColor" stroke-width="2"/></svg>';

  /**
   * Where somebody works, in the one shape it is drawn everywhere.
   *
   * The agent list, the room roster, the admin's picker and the conversation
   * header all answer the same question, and until this existed only the first
   * of them answered it at all. Four copies of the markup would have drifted
   * within a week — and drifting here means the area is prominent in one place
   * and a grey afterthought in another, which is exactly the bug that was
   * fixed in the list and never fixed anywhere else.
   *
   * `p` is { area, ward, district, region }. Returns { html, line }: the
   * marked-up version for a list, and the plain one for a header or a
   * data-attribute, so the two cannot say different things.
   */
  /**
   * Every ward, not the first one.
   *
   * An agent covering Mikocheni, Msasani and Kijitonyama used to read as
   * covering Mikocheni, so the agent somebody was actually looking for looked
   * like the wrong agent. agent_profiles carries the set now
   * (agent_multi_area.sql) and the directory RPCs return it, so the list can
   * say all of it. The singular column is folded in for any agent who has only
   * ever set that one.
   */
  function areaSet(list, one) {
    var seen = {};
    return [].concat(list || [], one ? [one] : []).map(function (v) {
      return String(v == null ? "" : v).trim();
    }).filter(function (v) {
      var k = v.toLowerCase();
      if (!v || seen[k]) return false;
      seen[k] = 1;
      return true;
    });
  }

  function whereOf(p, opts) {
    var area = String((p && p.area) || "").trim();
    // The broader places, minus whatever already appears as the area — an
    // agent whose area IS "Nyamagana" should not read "Nyamagana · Nyamagana".
    // The wards are NOT sliced: dropping the third ward is dropping the reason
    // somebody would pick this agent. The district and region are context and
    // still yield to the area when they repeat it.
    var wards = areaSet(p && p.wards, p && p.ward);
    var wardTxt = wards.filter(function (v) {
      return v.toLowerCase() !== area.toLowerCase();
    }).join(" · ");
    var rest = [p && p.district, p && p.region].filter(function (v) {
      return v && String(v).trim() && String(v).trim().toLowerCase() !== area.toLowerCase();
    }).slice(0, 2).join(" · ");
    rest = [wardTxt, rest].filter(Boolean).join(" · ");

    // An AGENT who has not set one is SAID to have not set one: a blank line
    // reads as "operates nowhere in particular", which is a claim about them
    // rather than about our data. Somebody who is not an agent has no area of
    // operation to set, so telling them theirs is missing would be inventing
    // an omission — `quiet` says which of the two this is.
    var quiet = opts && opts.quiet;
    var html = area
      ? '<span class="pm-area" title="' + esc(t("pm_area_of", "Area of operation")) + '">' +
          PIN_SVG + "<span>" + esc(area) + "</span></span>"
      : quiet
      ? ""
      : '<span class="pm-area is-none"><span>' +
          esc(t("pm_area_none", "Area not set")) + "</span></span>";

    return {
      area: area,
      rest: rest,
      html: html + (rest ? '<span class="pm-where">' + esc(rest) + "</span>" : ""),
      line: [area, rest].filter(Boolean).join(" · "),
    };
  }

  /**
   * One agent, and above all WHERE THEY WORK.
   *
   * The area of operations is the only reason to pick one agent over another,
   * and it used to be the first of up to four place names run together in a
   * grey subtitle — indistinguishable from the ward, the district and the
   * region behind it. It gets a pin, the brand colour and its own element now.
   *
   * An agent who has not set one is SAID to have not set one. Leaving the line
   * blank reads as "operates nowhere in particular", which is a claim about
   * them rather than about our data.
   */
  function personRow(scored) {
    var p = scored.agent;
    var name = p.display_name || t("pm_someone", "Someone");
    var w = whereOf(p);

    // data-sub is what the conversation header shows, so it stays a plain
    // single line rather than the marked-up version.
    var sub = w.line;

    // What they deal in, as counts. A tick would say "trucks: yes" for one
    // truck and for forty, and those are different claims about a person.
    // The wanted category is tinted so the eye can find it without reading.
    var deals = [
      { cat: "houses", n: p.n_houses | 0, label: t("pm_deal_houses", "{n} rooms") },
      { cat: "services", n: p.n_services | 0, label: t("pm_deal_services", "{n} services") },
      { cat: "trucks", n: p.n_trucks | 0, label: t("pm_deal_trucks", "{n} trucks") },
      // A day job is a thing somebody POSTED, not a thing they own and keep,
      // so it is worded as an act: "12 jobs posted", never "12 jobs". The
      // count is lifetime — see p_message_jobs.sql on why, and note the
      // freshness term is what stops an employer who stopped hiring in 2023
      // from sitting at the top of the list on the strength of it.
      { cat: "jobs", n: p.n_jobs | 0, label: t("pm_deal_jobs", "{n} jobs posted") },
    ].filter(function (d) { return d.n > 0; });
    var dealsHtml = deals.length
      ? '<span class="pm-deals">' + deals.map(function (d) {
          return '<span class="pm-deal' + (d.cat === category ? " is-want" : "") + '">' +
            esc(d.label.replace("{n}", d.n)) + "</span>";
        }).join("") + "</span>"
      : "";

    // The band, and only when it says something. "Weak match" on a row is
    // noise — the row's POSITION already said that.
    var fit = (category && p.reachable)
      ? ' <span class="pm-fit ' + esc(scored.band) + '">' + esc(fitWord(scored.band)) + "</span>"
      : "";

    var why = (category && p.reachable) ? whyLine(scored) : "";

    // What kind of work, in words. "4 services" is the count of a thing
    // whose identity was thrown away one join earlier: a plumber, a
    // hairdresser and a night guard all read the same on that row, and the
    // only way to tell them apart was to open four conversations. With a
    // chip on, the database already narrowed these to that category.
    var kindsHtml = kindsFor(p);

    // Presence. Nothing at all when we have never seen them — an empty badge
    // saying "last seen never" would be a claim about the person rather than
    // about our data, which is the same mistake the area line used to make.
    var seenHtml = (p.reachable && window.PMPresence)
      ? window.PMPresence.html(p.last_seen_at) : "";

    return '<div class="pm-person-wrap">' +
      '<button class="pm-row is-person" data-person="' + esc(p.user_id) + '" data-name="' + esc(name) +
      '" data-sub="' + esc(sub) + '"' + (p.reachable ? "" : ' data-unreachable="1"') + ">" +
      '<span class="pm-av">' + esc(initials(name)) + "</span>" +
      '<span class="pm-rtx"><span class="pm-name">' + esc(name) + fit +
        (p.is_agent ? ' <span class="pm-badge off">' + esc(t("pm_badge_agent", "Agent")) + "</span>" : "") +
        (p.reachable ? "" : ' <span class="pm-badge warn">' + esc(t("pm_badge_unreachable", "Not on P-Message")) + "</span>") +
      "</span>" +
      '<span class="pm-sub">' + w.html + (seenHtml ? seenHtml : "") + "</span>" +
      kindsHtml + dealsHtml +
      (why ? '<span class="pm-why">' + esc(why) + "</span>" : "") +
      "</span></button>" + actionsHtml(p, name, sub) + "</div>";
  }

  /**
   * The two ways of reaching one person, and the way of looking first.
   *
   * These used to be one absolutely-positioned link in the bottom-right corner
   * of the row, with 30px of padding reserved underneath it so a long "why"
   * line would not run behind it. That is a layout holding its breath: the
   * padding is paid by every row including the ones with no link, the link
   * overlaps the row's own tap area, and there was nowhere to put a second
   * action without the two of them fighting over the same corner.
   *
   * They are a row of their own now, under the card, which is what let the
   * phone number in at all.
   *
   * WHY A CALL BUTTON EXISTS ON AN ENCRYPTED SCREEN
   * Because "message them" is not always the question. Somebody who needs a
   * canter this afternoon does not want a conversation, and the number on the
   * listing is the fastest honest route to the lorry. The number shown is one
   * they already published on their own listing, where it is printed beside a
   * Call button that anybody can press without signing in. This saves four
   * taps and a guess about which catalogue to look in, and publishes nothing.
   *
   * The chips are SIBLINGS of the row button, never children: an <a> inside a
   * <button> is invalid markup that browsers repair by moving it, and the
   * repair is what broke this the first time it was tried. Each is its own tap
   * target on purpose. "Write to them", "ring them" and "look at their work
   * first" are three different intentions and one hit area cannot guess which
   * one a thumb meant.
   */
  function actionsHtml(p, name, sub) {
    var acts = [];

    // Writing is first because it is what the tab is for, and because it is
    // the only one of the three that is encrypted.
    if (p.reachable) {
      acts.push('<button class="pm-act is-msg" type="button" data-person="' + esc(p.user_id) +
        '" data-name="' + esc(name) + '" data-sub="' + esc(sub) + '">' + CHAT_SVG +
        "<span>" + esc(t("pm_act_message", "Message")) + "</span></button>");
    }

    // A number they printed on a listing themselves. Absent for anybody who
    // has not, and the row then says nothing at all rather than "no number":
    // that would be a claim about the person rather than about our data, which
    // is the same mistake the area line used to make.
    var tel = callHref(p.phone);
    if (tel) {
      acts.push('<a class="pm-act is-call' + (p.reachable ? "" : " is-only") + '" href="' + esc(tel) + '">' + PHONE_SVG +
        "<span>" + esc(t("pm_act_call", "Call")) + "</span></a>");
    }

    if (hasListings(p)) {
      acts.push('<a class="pm-open" href="' + storefrontUrl(p.user_id) + '" data-open-agent="1">' +
        BOX_SVG + "<span>" + esc(t("pm_open_listings", "See their work")) + "</span></a>");
    }

    // Somebody with no key, no number and nothing listed has no action at all,
    // and an empty strip under every such row is a row of wasted height.
    if (!acts.length) return "";
    return '<div class="pm-acts">' + acts.join("") + "</div>";
  }

  /**
   * A number, or nothing.
   *
   * Everything but digits and a leading plus is stripped, the same rule
   * service.js and truck.js already use, so a number typed as
   * "0712 345 678 (call after 6)" dials rather than failing silently. Anything
   * that does not survive that as a plausible number is dropped: a Call button
   * that opens the dialler on three digits is worse than no button, because
   * the person has already decided not to write by the time they find out.
   */
  function callHref(raw) {
    var digits = String(raw || "").replace(/[^0-9+]/g, "");
    // A leading + is kept; any other one is somebody's typo or a range.
    digits = digits.charAt(0) === "+" ? "+" + digits.slice(1).replace(/\+/g, "")
                                      : digits.replace(/\+/g, "");
    if (digits.replace(/[^0-9]/g, "").length < 9) return "";
    return "tel:" + digits;
  }

  // A little open-box glyph. Not a chevron: a chevron means "more of this
  // list", and this leaves the list entirely.
  var BOX_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
    '<path d="M4 8.5 12 13l8-4.5M12 13v7" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

  // Lucide-style strokes, never emoji: they inherit currentColor, scale with
  // the type beside them and are hidden from a screen reader, which is reading
  // the word next to them instead.
  var CHAT_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M20 12a8 8 0 0 1-8 8H5l-1.2 1.2A.5.5 0 0 1 3 20.8V12a8 8 0 1 1 17 0z" ' +
    'stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  var PHONE_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M6.5 3.5h3l1.5 4-2 1.4a12 12 0 0 0 6.1 6.1l1.4-2 4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z" ' +
    'stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  var MORE_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<circle cx="5" cy="12" r="1.6" fill="currentColor"/>' +
    '<circle cx="12" cy="12" r="1.6" fill="currentColor"/>' +
    '<circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>';

  function hasListings(p) {
    return ((p.n_houses | 0) + (p.n_services | 0) + (p.n_trucks | 0) + (p.n_jobs | 0)) > 0;
  }

  /**
   * The one place the storefront link is built.
   *
   * The URL carries ONLY the user id — the same rule the ?to= deep link
   * follows. Name, area and listings all come from the database on the far
   * side, so a link somebody doctored cannot put a borrowed name on the page
   * whose whole job is saying who this is.
   */
  function storefrontUrl(userId) {
    return "agent.html?u=" + encodeURIComponent(userId);
  }

  /**
   * The kinds this person deals in, as words.
   *
   * The finder returns them already narrowed to the chosen category and
   * ordered commonest first. Which catalogue to label them against is the
   * chosen category, or — with no chip on — whichever catalogue they have
   * most of, because "cleaning" has to be read as a service and "canter" as
   * a truck and the strings alone do not say which.
   */
  function kindsFor(p) {
    var kinds = p.kinds || [];
    if (!kinds.length || !window.ListingKinds) return "";
    var cat = category || dominantCat(p);
    var words = window.ListingKinds.labels(cat, kinds, { max: 3 });
    if (!words.length) return "";
    return '<span class="pm-kinds">' + words.map(function (wd) {
      return '<span class="pm-kind">' + esc(wd) + "</span>";
    }).join("") + "</span>";
  }

  function dominantCat(p) {
    var best = "", n = 0;
    [["houses", p.n_houses | 0], ["services", p.n_services | 0],
     ["trucks", p.n_trucks | 0], ["jobs", p.n_jobs | 0]].forEach(function (row) {
      if (row[1] > n) { n = row[1]; best = row[0]; }
    });
    return best;
  }

  function fitWord(b) {
    return b === "strong" ? t("pm_fit_strong", "Strong match")
         : b === "good" ? t("pm_fit_good", "Good match")
         : b === "possible" ? t("pm_fit_possible", "Possible")
         : t("pm_fit_weak", "Weak");
  }

  /**
   * Why this person is where they are in the list.
   *
   * Without it the order is an assertion nobody can check; with it, it is an
   * argument somebody can disagree with — and disagreeing with it is exactly
   * what should happen when the ranking is wrong. Only the terms that HELPED
   * are shown: a row that explained at length why it was ranked low would be
   * a row arguing with itself.
   */
  function whyLine(scored) {
    var bits = [];
    scored.evidence.forEach(function (e) {
      if (e.llr <= 0.15) return;                 // too small to be worth a word
      if (e.why === "category_depth") {
        bits.push(category === "jobs"
          ? t("pm_why_posted", "posted {n} day jobs", { n: e.detail })
          : t("pm_why_depth", "lists {n} of these", { n: e.detail }));
      }
      else if (e.why === "category_focus") bits.push(t("pm_why_focus", "mostly this kind of work"));
      else if (e.why === "place_area" || e.why === "place_ward") bits.push(t("pm_why_ward", "works right there"));
      else if (e.why === "place_district") bits.push(t("pm_why_district", "same district"));
      else if (e.why === "place_region") bits.push(t("pm_why_region", "same region"));
      else if (e.why === "distance") bits.push(t("pm_why_near", "{km}km away", { km: Math.round(e.detail) }));
      else if (e.why === "freshness") bits.push(t("pm_why_fresh", "listed recently"));
      else if (e.why === "verified") bits.push(t("pm_why_verified", "verified listings"));
    });
    return bits.slice(0, 3).join(" · ");
  }

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
          BOX_SVG + "<span>" + esc(t("pm_open_listings", "See their work")) + "</span></a>"
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
  function askDeleteRoom(threadId, title, memberCount) {
    // pm_thread_size, not the length of the roster. The roster is built from
    // pm_thread_keys, which omits anybody who has not published a key yet, so
    // on a room of forty where a few are still setting up it would understate
    // what is being closed. Falls back to the roster only when the size never
    // arrived, which is better than saying nothing.
    var n = (open && open.size) || memberCount || 0;
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
        if (open && open.threadId === threadId) closeThread();
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
      if (open && open.threadId === threadId) closeThread();
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
    var cast = kind === "cast";
    var room = kind === "room" || cast;
    // The owner of the room, or an admin: the same test pm_group_delete makes,
    // asked here so the button is not offered to somebody the database will
    // turn away. my_role comes down with the row from pm_inbox.
    var canDelete = !room || role === "owner" || !!(me && me.isAdmin);

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
        if (open && open.threadId === threadId) closeThread();
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
    if (!open || open.kind !== "group") return;
    var threadId = open.threadId, title = open.name;
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
    var mine = rows.filter(function (r) { return r.userId === (me && me.userId); })[0];
    var canManage = !!(me && me.isAdmin) || (mine && mine.role === "owner");

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
    var isMe = m.userId === (me && me.userId);
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
      "<label>" + esc(t("pm_room_cat", "What they deal in")) + "</label>" + catSelect("pmAddCat") +
      "<label>" + esc(t("pm_room_where", "Where")) + "</label>" + regionSelect("pmAddRegion") +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn ghost" id="pmAddFind">' + esc(t("pm_room_who", "Who is in scope?")) + "</button>" +
        '<button class="pm-btn" id="pmAddGo" disabled>' + esc(t("pm_mem_add_go", "Add selected")) + "</button>" +
        '<button class="pm-btn ghost" id="pmAddCancel">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
      "</div><div class=\"pm-msg-out\" id=\"pmAddMsg\"></div><div id=\"pmAddList\"></div>");

    var out = document.getElementById("pmAddMsg");
    var go = document.getElementById("pmAddGo");
    document.getElementById("pmAddCancel").addEventListener("click", function () { showMembers(); });

    document.getElementById("pmAddFind").addEventListener("click", async function (e) {
      var btn = e.currentTarget;      // captured, never read after an await
      btn.disabled = true;
      out.className = "pm-msg-out";
      out.textContent = t("pm_room_looking", "Looking…");
      try {
        var found = (await window.PMStore.groupCandidates(
          document.getElementById("pmAddCat").value || null,
          document.getElementById("pmAddRegion").value || null))
          // Somebody already in the room is not a candidate to add. Leaving
          // them in the list with a tick beside them invites an admin to
          // "add" eleven people and be told four were added.
          .filter(function (p) { return !already[p.user_id]; });
        out.textContent = "";
        renderPicker("pmAddList", found, go, out, t("pm_mem_add_nobody",
          "Everybody in that scope is already in this room."));
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
      } finally { btn.disabled = false; }
    });

    go.addEventListener("click", async function (e) {
      var picked = pickedIds("pmAddList");
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

  // ---- picking people ------------------------------------------------------
  //
  //  A room's membership used to BE its scope: the screen handed pm_group_create
  //  every candidate the category and region returned, so an admin who wanted
  //  eleven of the fourteen people in Mwanza had no way to say so. The RPC has
  //  always taken an explicit list; only the screen was collapsing the two.
  //
  //  Everyone is ticked to start with, because the scope is a good default and
  //  un-ticking three is less work than ticking eleven. What changes is that
  //  it is now a default rather than the only possibility.
  function renderPicker(boxId, found, goBtn, out, emptyMsg) {
    var box = document.getElementById(boxId);
    if (!box) return;
    if (!found.length) {
      box.innerHTML = '<div class="pm-empty">' +
        esc(emptyMsg || t("pm_room_nobody", "Nobody in that scope uses P-Message yet.")) + "</div>";
      goBtn.disabled = true;
      return;
    }

    box.innerHTML =
      '<div class="pm-pick-h"><span id="' + boxId + 'Count"></span>' +
        '<button class="pm-btn ghost" type="button" data-all="1">' + esc(t("pm_pick_all", "All")) + "</button>" +
        '<button class="pm-btn ghost" type="button" data-all="0">' + esc(t("pm_pick_none", "None")) + "</button>" +
      "</div>" +
      '<div class="pm-scroll">' + found.map(function (p) {
        var w = whereOf({ area: p.area, ward: p.ward, district: p.district, region: p.region },
                        { quiet: !p.is_agent });
        var deals = [
          { n: p.n_houses | 0, label: t("pm_deal_houses", "{n} rooms") },
          { n: p.n_services | 0, label: t("pm_deal_services", "{n} services") },
          { n: p.n_trucks | 0, label: t("pm_deal_trucks", "{n} trucks") },
        ].filter(function (d) { return d.n > 0; });
        return '<label class="pm-pick"><input type="checkbox" checked value="' + esc(p.user_id) + '" />' +
          '<span class="pm-mem-tx"><span class="pm-mem-nm">' +
            esc(p.display_name || p.user_id) +
            (p.is_agent ? ' <span class="pm-badge off">' + esc(t("pm_badge_agent", "Agent")) + "</span>" : "") +
          "</span>" +
          '<span class="pm-sub">' + w.html + "</span>" +
          (deals.length ? '<span class="pm-deals">' + deals.map(function (d) {
            return '<span class="pm-deal">' + esc(d.label.replace("{n}", d.n)) + "</span>";
          }).join("") + "</span>" : "") +
          "</span></label>";
      }).join("") + "</div>";

    var count = function () {
      var n = pickedIds(boxId).length;
      var c = document.getElementById(boxId + "Count");
      if (c) c.textContent = t("pm_pick_n", "{n} of {total} chosen", { n: n, total: found.length });
      goBtn.disabled = n === 0;
      if (out && n === 0) {
        out.className = "pm-msg-out";
        out.textContent = t("pm_pick_none_msg", "Choose at least one person.");
      } else if (out) { out.textContent = ""; }
    };
    box.addEventListener("change", count);
    box.addEventListener("click", function (e) {
      var b = e.target.closest("[data-all]");
      if (!b) return;
      e.preventDefault();
      var on = b.dataset.all === "1";
      Array.prototype.forEach.call(box.querySelectorAll('input[type="checkbox"]'),
        function (i) { i.checked = on; });
      count();
    });
    count();
  }

  function pickedIds(boxId) {
    var box = document.getElementById(boxId);
    if (!box) return [];
    return Array.prototype.slice.call(box.querySelectorAll('input[type="checkbox"]'))
      .filter(function (i) { return i.checked; })
      .map(function (i) { return i.value; });
  }

  function regionSelect(id, allLabel) {
    var names = (window.TZ_REGION_CENTERS || []).map(function (r) { return r.name; })
      .filter(Boolean).sort(function (a, b) { return a.localeCompare(b); });
    return '<select id="' + id + '"><option value="">' +
      esc(allLabel || t("pm_cast_all", "Everyone in Tanzania")) + "</option>" +
      names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + "</option>"; }).join("") +
      "</select>";
  }

  // One list, four entries, used by the room scope, the announce scope and the
  // add-member picker. They were three separate literals saying the same thing
  // before; a category added to one of them and not the others is how a room
  // ends up scoped to something the announcement cannot reach.
  var CATS = ["houses", "services", "trucks", "jobs"];

  function catSelect(id) {
    return '<select id="' + id + '"><option value="">' + esc(t("pm_room_anycat", "Anything")) + "</option>" +
      CATS.map(function (c) {
        return '<option value="' + c + '">' + esc(catName(c)) + "</option>";
      }).join("") + "</select>";
  }

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

      return '<div class="pm-msg' + (m.mine ? " mine" : "") + (m.failed ? " failed" : "") +
        (gone ? " gone" : "") +
        (place ? " has-place" : "") +
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
        }) : "") + esc(shown) +
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
              ' aria-label="' + esc(t("pm_msg_more", "More")) + '">' + MORE_SVG + "</button>" : "") +
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
    if (pendingPlace && window.PMPlace) {
      body = window.PMPlace.compose(pendingPlace, text);
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
    if (!open) return;
    pickTab = window.PlaceBook && window.PlaceBook.list().length ? "saved" : "here";
    drawPicker();
  }

  function drawPicker() {
    var tabs = [
      ["here", t("pmp_tab_here", "Where I am")],
      ["map", t("pmp_tab_map", "Point on a map")],
      ["saved", t("pmp_tab_saved", "Saved places")],
      ["code", t("pmp_tab_code", "A code")],
    ];
    modal("<h2>" + esc(t("pmp_send_place", "Send a place")) + "</h2>" +
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
        "Nine characters somebody read out to you. It opens once and the pin is theirs, not ours — we cannot read it either.")) + "</p>";
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

  async function useGps() {
    var btn = document.getElementById("pmPickGps");
    if (btn) { btn.disabled = true; btn.textContent = t("pmp_locating", "Finding you…"); }
    try {
      var fix = window.pawaLocate && window.pawaLocate.supported()
        ? await window.pawaLocate.best({ targetAccuracy: 50, hardTimeout: 15000 })
        : await new Promise(function (res, rej) {
            if (!navigator.geolocation) return rej(new Error("no gps"));
            navigator.geolocation.getCurrentPosition(function (pos) {
              res({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
            }, rej, { enableHighAccuracy: true, timeout: 15000 });
          });
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
      short: t("pmp_r_short", "That is too short — a code is nine characters."),
      long: t("pmp_r_long", "That is too long — a code is nine characters."),
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
    el.pmAttach.innerHTML =
      '<span class="pm-at-tx"><b>' + esc(t("pmp_attached", "Sending a place")) + "</b>" +
      '<span class="pm-at-body">' +
        esc(pendingPlace.label || window.PlaceBook.coords(pendingPlace.lat, pendingPlace.lng)) +
      "</span></span>" +
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
      window.L.circle([place.lat, place.lng], {
        radius: place.acc, color: "#2EE6A6", weight: 1, fillOpacity: 0.1,
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
      from: place.from || (open && open.kind === "direct" ? open.name : "") || "",
      fromId: place.fromId || "",
      guest: !!place.guest,
      msgId: place.msgId || "",
      threadId: (open && open.threadId) || "",
      threadName: (open && open.name) || "",
      at: place.at || Date.now(),
    });
  }

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
      if (el.pmFpBtn) el.pmFpBtn.textContent = t("pm_your_number", "Your safety number {n}", { n: fingerprint });
      await refreshInbox();
    },
  });
  var showBackup = function () { window.PMIdentityUI.backup(); };

  // An announcement is the one thing on this screen that cannot be taken back
  // and cannot be edited. So it gets the same treatment a room does: say who
  // it would reach, from the SAME query that will send it, before the send
  // button means anything. PMStore.broadcast() takes the resolved list for
  // exactly that reason — if it re-asked the database, the preview would be a
  // different question from the send, and the one thing a preview has to be is
  // the same question.
  function showBroadcast() {
    var audience = null;

    modal("<h2>" + esc(t("pm_cast_t", "Announce")) + "</h2>" +
      "<p>" + esc(t("pm_cast_d", "Goes to everyone in the scope who uses P-Message. It is encrypted to each of them individually — one sealed copy per person — so it stays unreadable to everyone else, including us.")) + "</p>" +
      "<label>" + esc(t("pm_cast_scope", "Where")) + "</label>" + regionSelect("pmCastRegion") +
      // Scoping by what people deal in was missing entirely: a price change
      // that only affects truck owners went to every person in the country,
      // and the way to avoid that was not to send it.
      "<label>" + esc(t("pm_cast_cat", "What they deal in")) + "</label>" + catSelect("pmCastCat") +
      "<label>" + esc(t("pm_cast_title", "Title")) + '</label><input id="pmCastTitle" maxlength="80" />' +
      "<label>" + esc(t("pm_cast_body", "Message")) + '</label><textarea id="pmCastBody"></textarea>' +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn ghost" id="pmCastWho">' + esc(t("pm_cast_who", "Who would get this?")) + "</button>" +
        '<button class="pm-btn" id="pmCastGo" disabled>' + esc(t("pm_cast_send", "Send")) + "</button>" +
        '<button class="pm-btn ghost" id="pmCastCancel">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
      "</div><div class=\"pm-msg-out\" id=\"pmCastMsg\"></div>");

    var out = document.getElementById("pmCastMsg");
    var go = document.getElementById("pmCastGo");
    var reg = document.getElementById("pmCastRegion");
    var cat = document.getElementById("pmCastCat");

    function invalidate() {
      audience = null; go.disabled = true;
      out.className = "pm-msg-out"; out.textContent = "";
    }
    reg.addEventListener("change", invalidate);
    cat.addEventListener("change", invalidate);
    document.getElementById("pmCastCancel").addEventListener("click", closeModal);

    document.getElementById("pmCastWho").addEventListener("click", async function (e) {
      var btn = e.currentTarget;      // captured, never read after an await
      btn.disabled = true;
      out.className = "pm-msg-out";
      out.textContent = t("pm_room_looking", "Looking…");
      try {
        audience = (await window.PMStore.audience({
          region: reg.value || null, category: cat.value || null,
        })).filter(function (p) { return p.public_key; });
        if (!audience.length) {
          out.className = "pm-msg-out bad";
          out.textContent = t("pm_cast_nobody", "Nobody in that scope uses P-Message yet.");
          go.disabled = true;
        } else {
          out.className = "pm-msg-out good";
          out.textContent = t("pm_cast_found", "{n} people: {who}", {
            n: audience.length,
            who: audience.slice(0, 6).map(function (p) { return p.display_name || p.user_id; }).join(", ") +
                 (audience.length > 6 ? "…" : ""),
          });
          go.disabled = false;
        }
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
      } finally { btn.disabled = false; }
    });

    go.addEventListener("click", async function (e) {
      var btn = e.currentTarget;
      var body = document.getElementById("pmCastBody").value.trim();
      if (!body) { out.className = "pm-msg-out bad"; out.textContent = t("pm_cast_empty", "Write something first."); return; }
      if (!audience || !audience.length) return;
      btn.disabled = true;
      out.className = "pm-msg-out";
      try {
        var res = await window.PMStore.broadcast({
          region: reg.value || null,
          title: document.getElementById("pmCastTitle").value.trim() || null,
          text: body,
          // The very list that was previewed, not the scope that produced it.
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
          ? t("pm_cast_nobody", "Nobody in that scope uses P-Message yet.")
          : ((err && err.message) || String(err));
        btn.disabled = false;
      }
    });
  }

  // ---- rooms (admin) -------------------------------------------------------
  // Two steps on purpose: pick a scope, SEE who it caught, then open it. A
  // room is a thing you cannot un-send to people, so the preview is not a
  // nicety — it is the difference between "Mwanza house agents" and "everyone,
  // because I left the category blank".
  function showRooms() {
    var found = [];

    modal("<h2>" + esc(t("pm_room_t", "Open a room")) + "</h2>" +
      "<p>" + esc(t("pm_room_d", "Everyone you put in the room can talk to each other, encrypted to each member individually. Announcements are one-way; a room is not.")) + "</p>" +
      "<label>" + esc(t("pm_room_cat", "What they deal in")) + "</label>" + catSelect("pmRoomCat") +
      "<label>" + esc(t("pm_room_where", "Where")) + "</label>" + regionSelect("pmRoomRegion") +
      "<label>" + esc(t("pm_room_name", "Name of the room")) + '</label><input id="pmRoomTitle" maxlength="80" />' +
      // The room the admin wants most of the time is "all of them", and it was
      // reachable only by knowing that leaving both selects alone meant that.
      // One button says it out loud and fills the name in too.
      '<p style="margin-top:12px"><button class="pm-btn ghost" id="pmRoomEveryone" style="width:100%">' +
        esc(t("pm_room_everyone", "Every agent in Tanzania")) + "</button></p>" +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn ghost" id="pmRoomWho">' + esc(t("pm_room_who", "Who is in scope?")) + "</button>" +
        '<button class="pm-btn" id="pmRoomGo" disabled>' + esc(t("pm_room_open", "Open room")) + "</button>" +
        '<button class="pm-btn ghost" id="pmRoomCancel">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
      "</div><div class=\"pm-msg-out\" id=\"pmRoomMsg\"></div><div id=\"pmRoomList\"></div>");

    var out = document.getElementById("pmRoomMsg");
    var go = document.getElementById("pmRoomGo");
    var cat = document.getElementById("pmRoomCat");
    var reg = document.getElementById("pmRoomRegion");

    // Changing the scope invalidates the preview. Leaving a stale list of
    // twelve ticked names on screen while the selects say something else is
    // how the wrong room gets opened, and a room cannot be un-sent.
    function invalidate() {
      found = []; go.disabled = true;
      document.getElementById("pmRoomList").innerHTML = "";
      out.className = "pm-msg-out"; out.textContent = "";
    }
    cat.addEventListener("change", invalidate);
    reg.addEventListener("change", invalidate);

    document.getElementById("pmRoomCancel").addEventListener("click", closeModal);
    document.getElementById("pmRoomEveryone").addEventListener("click", function () {
      cat.value = "";
      reg.value = "";
      var title = document.getElementById("pmRoomTitle");
      if (!title.value.trim()) title.value = t("pm_room_everyone", "Every agent in Tanzania");
      invalidate();
      // Run the preview straight away: the roster is what makes this safe to
      // press, and an admin should see who is about to be added before the
      // button that adds them becomes available.
      document.getElementById("pmRoomWho").click();
    });

    document.getElementById("pmRoomWho").addEventListener("click", async function (e) {
      var btn = e.currentTarget;      // captured, never read after an await
      btn.disabled = true;
      out.className = "pm-msg-out";
      out.textContent = t("pm_room_looking", "Looking…");
      try {
        found = await window.PMStore.groupCandidates(cat.value || null, reg.value || null);
        if (!found.length) {
          out.className = "pm-msg-out bad";
          out.textContent = t("pm_room_nobody", "Nobody in that scope uses P-Message yet.");
          go.disabled = true;
        } else {
          out.className = "pm-msg-out good";
          out.textContent = t("pm_room_found2",
            "{n} people are in scope. Untick anyone who should not be in the room.", { n: found.length });
          // The scope proposes; the admin decides. Everyone starts ticked
          // because the scope is a good default, and un-ticking three is less
          // work than ticking eleven.
          renderPicker("pmRoomList", found, go, null);
        }
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("pmRoomGo").addEventListener("click", async function (e) {
      var picked = pickedIds("pmRoomList");
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
          category: cat.value || null,
          region: reg.value || null,
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

  // ---- invite a customer ---------------------------------------------------
  // The token is shown ONCE. It is not recoverable, by design — the server
  // holds only its hash — so the copy button matters more than it looks.
  function showInvite() {
    modal("<h2>" + esc(t("pm_inv_t", "Invite a customer")) + "</h2>" +
      "<p>" + esc(t("pm_inv_d", "Make a link and send it however you already talk to them. They can reply encrypted without making an account.")) + "</p>" +
      "<label>" + esc(t("pm_inv_label", "Your note (only you see this)")) + '</label><input id="pmInvLabel" maxlength="60" />' +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn" id="pmInvGo">' + esc(t("pm_inv_make", "Make a link")) + "</button>" +
        '<button class="pm-btn ghost" id="pmInvCancel">' + esc(t("pm_close", "Close")) + "</button>" +
      "</div><div class=\"pm-msg-out\" id=\"pmInvMsg\"></div><div id=\"pmInvList\"></div>");

    document.getElementById("pmInvCancel").addEventListener("click", closeModal);
    // Bound HERE, once, and not inside renderInviteList — that function only
    // rewrites #pmInvList's innerHTML, so the element itself survives every
    // redraw. Re-binding per redraw would leave one extra listener behind each
    // time a link was made or withdrawn, and the next Withdraw would then ask
    // for confirmation N times and fire N revokes: the first succeeds and the
    // rest fail on a hash that is already gone, so a withdrawal that WORKED
    // reports an error.
    document.getElementById("pmInvList").addEventListener("click", onRevokeClick);
    renderInviteList();

    document.getElementById("pmInvGo").addEventListener("click", async function (e) {
      var out = document.getElementById("pmInvMsg");
      var btn = e.currentTarget;      // captured, never read after an await
      btn.disabled = true;
      out.className = "pm-msg-out"; out.textContent = "";
      try {
        var inv = await window.PMStore.inviteCreate(
          document.getElementById("pmInvLabel").value.trim() || null);
        out.className = "pm-msg-out good";
        out.innerHTML = '<input readonly id="pmInvLink" value="' + esc(inv.link) + '" />' +
          '<button class="pm-btn" id="pmInvCopy" style="margin-top:8px">' +
          esc(t("pm_inv_copy", "Copy link")) + "</button>" +
          '<div style="margin-top:6px">' +
          esc(t("pm_inv_once", "This link is shown once and cannot be shown again. It works for one person, and expires.")) +
          "</div>";
        document.getElementById("pmInvCopy").addEventListener("click", function () {
          var f = document.getElementById("pmInvLink");
          f.select();
          try { navigator.clipboard.writeText(inv.link); } catch (_) { document.execCommand("copy"); }
          this.textContent = t("pm_inv_copied", "Copied");
        });
        renderInviteList();
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // A link is a bearer credential: whoever opens it first becomes the customer
  // in that thread. Withdrawing one that went to the wrong number is therefore
  // the whole point of listing them — and pm_invite_revoke has existed since
  // invites shipped with nothing able to call it, because pm_invites_mine did
  // not return the hash the RPC needs to name a link. It does now.
  async function renderInviteList() {
    var box = document.getElementById("pmInvList");
    if (!box) return;
    try {
      var rows = await window.PMStore.invitesMine(20);
      if (!rows.length) { box.innerHTML = ""; return; }
      box.innerHTML = "<h3>" + esc(t("pm_inv_yours", "Your links")) + "</h3>" +
        rows.map(function (r) {
          return '<div class="pm-inv-row"><span>' +
            esc(r.label || t("pm_inv_nolabel", "(no note)")) +
            '</span><span class="pm-badge' + (r.state === "used" ? " ok" : r.state === "open" ? "" : " off") + '">' +
            esc(t("pm_inv_" + r.state, r.state)) + "</span>" +
            (r.guest_name ? '<span class="pm-sub">' + esc(r.guest_name) + "</span>" : "") +
            // Only an unused link can be withdrawn. A used one has already
            // become a conversation, and pm_invite_revoke says so by refusing
            // it — offering the button anyway would be offering a door that
            // is locked on the other side.
            (r.state === "open" && r.token_hash
              ? '<button class="pm-btn danger" data-revoke="' + esc(r.token_hash) + '">' +
                esc(t("pm_inv_revoke", "Withdraw")) + "</button>"
              : "") +
            "</div>";
        }).join("");
    } catch (_) { box.innerHTML = ""; return; }
  }

  // Delegated from #pmInvList, which outlives the rows inside it.
  async function onRevokeClick(e) {
    var btn = e.target.closest("[data-revoke]");
    if (!btn) return;
    if (!confirm(t("pm_inv_revoke_q", "Withdraw this link? Anyone holding it will no longer be able to use it."))) return;
    btn.disabled = true;
    try {
      await window.PMStore.inviteRevoke(btn.dataset.revoke);
      renderInviteList();
    } catch (err) {
      btn.disabled = false;
      var out = document.getElementById("pmInvMsg");
      if (out) { out.className = "pm-msg-out bad"; out.textContent = (err && err.message) || String(err); }
    }
  }

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
  // Runs before the normal boot decides what to show, because the answer to
  // "who are you" is different when you arrived holding a link.
  async function handleInviteLink() {
    var token = new URLSearchParams(location.search).get("i");
    if (!token) return false;
    // Take it out of the address bar immediately. A bearer token sitting in a
    // URL gets shared, screenshotted and put in a browser history that syncs.
    try { history.replaceState({}, "", location.pathname); } catch (_) {}

    var info = null;
    try { info = await window.PMStore.invitePeek(token); } catch (_) {}
    if (!info) {
      modal("<h2>" + esc(t("pm_inv_bad_t", "That link does not work")) + "</h2><p>" +
        esc(t("pm_inv_bad_d", "It may have been mistyped. Ask for a new one.")) + "</p>" +
        '<div class="pm-modal-acts"><button class="pm-btn" id="pmInvX">' +
        esc(t("pm_close", "Close")) + "</button></div>");
      document.getElementById("pmInvX").addEventListener("click", closeModal);
      return true;
    }
    if (info.state !== "open") {
      var why = info.state === "used" ? t("pm_inv_used_d", "This link has already been used.")
              : info.state === "expired" ? t("pm_inv_exp_d", "This link has expired.")
              : t("pm_inv_rev_d", "This link was withdrawn.");
      modal("<h2>" + esc(t("pm_inv_bad_t", "That link does not work")) + "</h2><p>" + esc(why) + "</p>" +
        '<div class="pm-modal-acts"><button class="pm-btn" id="pmInvX">' +
        esc(t("pm_close", "Close")) + "</button></div>");
      document.getElementById("pmInvX").addEventListener("click", closeModal);
      return true;
    }

    modal("<h2>" + esc(t("pm_inv_hi", "{who} wants to chat with you", { who: info.agent_name || t("pm_someone", "Someone") })) + "</h2>" +
      "<p>" + esc(t("pm_inv_hi_d", "You do not need an account. Your messages are encrypted on this device — nobody else, including us, can read them.")) + "</p>" +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn" id="pmInvOk">' + esc(t("pm_inv_start", "Start chatting")) + "</button>" +
        '<button class="pm-btn ghost" id="pmInvNo">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
      "</div><div class=\"pm-msg-out\" id=\"pmInvOut\"></div>");

    document.getElementById("pmInvNo").addEventListener("click", closeModal);
    document.getElementById("pmInvOk").addEventListener("click", async function (e) {
      var out = document.getElementById("pmInvOut");
      var btn = e.currentTarget;      // captured, never read after an await
      btn.disabled = true;
      out.className = "pm-msg-out";
      out.textContent = t("pm_inv_setting", "Setting up encryption…");
      try {
        var who = await window.PMStore.me();
        if (!who || !who.userId) await window.PMStore.signInAsGuest(null, null);
        await window.PMStore.ensureIdentity({});
        var threadId = await window.PMStore.inviteAccept(token);
        closeModal();
        await boot();
        openThread({ threadId: threadId, kind: "direct", name: info.agent_name || t("pm_someone", "Someone"), sub: "" });
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
        btn.disabled = false;
      }
    });
    return true;
  }

  // ---- wiring --------------------------------------------------------------
  function wire() {
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
      }
    });

    el.pmPlaceBtn && el.pmPlaceBtn.addEventListener("click", showPlacePicker);
    el.pmMapBack && el.pmMapBack.addEventListener("click", closePlaceMap);

    el.pmBack && el.pmBack.addEventListener("click", closeThread);
    el.pmVerify && el.pmVerify.addEventListener("click", openVerify);
    el.pmMembers && el.pmMembers.addEventListener("click", showMembers);
    el.pmFpBtn && el.pmFpBtn.addEventListener("click", function () { showBackup(); });
    el.pmBroadcastBtn && el.pmBroadcastBtn.addEventListener("click", showBroadcast);
    el.pmRoomsBtn && el.pmRoomsBtn.addEventListener("click", showRooms);
    el.pmInviteBtn && el.pmInviteBtn.addEventListener("click", showInvite);

    el.pmComposeForm && el.pmComposeForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = el.pmInput.value.trim();
      // A pin on its own is a complete message. Requiring words as well would
      // mean somebody standing at a gate has to think of a sentence before
      // they can say where they are.
      if (!text && !pendingPlace) return;
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
