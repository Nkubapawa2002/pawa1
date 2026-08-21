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
//      threads and flips to a warning on the assistant thread, which cannot be
//      encrypted because a model that answers you has to read you. Making
//      those two look alike would be the single most dishonest thing this page
//      could do.
//   2. A MESSAGE THAT WILL NOT DECRYPT IS SHOWN, NOT HIDDEN. It means this
//      device's key cannot open it. A gap in a conversation is far more
//      alarming than a line saying why.
//   3. NOTHING IS SENT BEFORE AN IDENTITY EXISTS. The gate at the top is not
//      decoration; without a published key nobody can write to you, and you
//      would never find out.
// ============================================================================

(function () {
  "use strict";

  var el = {};
  ["pmLock", "pmLockText", "pmFpBtn", "pmBroadcastBtn", "pmRoomsBtn", "pmInviteBtn",
   "segChats", "segPeople", "segAi",
   "pmGate", "paneChats", "panePeople", "paneAi", "pmInbox", "pmSearch", "pmRegion",
   "pmPeople", "pmAiRow", "pmConv", "pmBack", "pmConvName", "pmConvSub", "pmVerify",
   "pmLog", "pmConvNote", "pmComposeForm", "pmInput", "pmSendBtn", "pmModalBack", "pmModal",
   "pmTrustBar", "pmWho", "pmCount"]
    .forEach(function (id) { el[id] = document.getElementById(id); });

  var me = null;             // { userId, email, isAdmin }
  var fingerprint = "";
  var ready = false;         // an identity exists and is published
  var seg = "chats";
  var open = null;           // { threadId, name, sub, kind, otherId }
  var live = null;           // realtime subscription for the open thread
  var searchTimer = null;

  var AI_THREAD = "assistant";
  var AI_STORE = "pm-assistant-log-v1";

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
      renderAiRow();
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
        renderAiRow();
        return;
      }
      gate('<div class="pm-note warn">' + esc(t("pm_setup_failed", "Could not set up encryption on this device.")) +
        "<br><small>" + esc((err && err.message) || err) + "</small></div>");
      return;
    }

    await refreshInbox();
    renderAiRow();
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
        showSeg("people");           // a guest came here to find an agent
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
      return '<button class="pm-row" data-thread="' + esc(r.thread_id) + '" data-kind="' + esc(r.kind) +
        '" data-name="' + esc(name) + '" data-sub="' + esc(sub) + '" data-other="' + esc(r.other_id || "") + '">' +
        '<span class="pm-av' + (broadcast ? " is-cast" : group ? " is-room" : "") + '">' +
          (broadcast ? "★" : group ? "◎" : esc(initials(name))) + "</span>" +
        '<span class="pm-rtx"><span class="pm-name">' + esc(name) + guestTag +
          (broadcast ? ' <span class="pm-badge">' + esc(t("pm_badge_cast", "Announcement")) + "</span>" : "") +
          (group ? ' <span class="pm-badge">' + esc(t("pm_badge_room", "Room")) + "</span>" : "") +
        '</span><span class="pm-sub">' + esc(sub || clock(r.last_at)) + "</span></span>" +
        (r.unread ? '<span class="pm-unread">' + r.unread + "</span>" : "") + "</button>";
    }).join("");
  }

  // ---- directory -----------------------------------------------------------
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
    var rows;
    try {
      rows = await window.PMStore.directory({
        region: el.pmRegion ? el.pmRegion.value : "",
        query: el.pmSearch ? el.pmSearch.value.trim() : "",
        // The directory is every registered agent in the country, not a
        // sample of them. 200 was the default and quietly truncated the list
        // once enough agents had signed up to make the tab worth opening.
        limit: 500,
      });
    } catch (err) {
      el.pmPeople.innerHTML = '<div class="pm-empty">' + esc((err && err.message) || err) + "</div>";
      return;
    }

    // The pane is called Agents, but the directory also returns anyone who has
    // simply opened P-Message — which is right for "who wrote to me?" and
    // wrong for "who can help me find a room". Both lists are available; the
    // agents are the default because that is what the tab is for.
    var wantAgents = !el.pmWho || el.pmWho.value !== "all";
    var shown = wantAgents ? rows.filter(function (p) { return p.is_agent; }) : rows;

    if (el.pmCount) {
      el.pmCount.textContent = shown.length
        ? t(wantAgents ? "pm_count_agents" : "pm_count_people",
            wantAgents ? "{n} agents" : "{n} people", { n: shown.length }) +
          (el.pmRegion && el.pmRegion.value ? " · " + el.pmRegion.value : "")
        : "";
    }

    if (!shown.length) {
      el.pmPeople.innerHTML = '<div class="pm-empty">' +
        esc(rows.length && wantAgents
          ? t("pm_no_agents", "No agents match that. Switch to Everyone to see other people on P-Message.")
          : t("pm_no_people", "Nobody matches that yet.")) + "</div>";
      return;
    }
    rows = shown;

    el.pmPeople.innerHTML = rows.map(function (p) {
      return personRow(p);
    }).join("");
  }

  var PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z" stroke="currentColor" stroke-width="2"/>' +
    '<circle cx="12" cy="10" r="2.4" stroke="currentColor" stroke-width="2"/></svg>';

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
  function personRow(p) {
    var name = p.display_name || t("pm_someone", "Someone");
    var area = (p.area || "").trim();

    // The broader places, minus whatever already appears as the area — an
    // agent whose area IS "Nyamagana" should not read "Nyamagana · Nyamagana".
    var where = [p.ward, p.district, p.region].filter(function (v) {
      return v && v.trim() && v.trim().toLowerCase() !== area.toLowerCase();
    });
    var rest = where.slice(0, 2).join(" · ");

    var areaHtml = area
      ? '<span class="pm-area" title="' + esc(t("pm_area_of", "Area of operation")) + '">' +
          PIN_SVG + "<span>" + esc(area) + "</span></span>"
      : '<span class="pm-area is-none"><span>' +
          esc(t("pm_area_none", "Area not set")) + "</span></span>";

    // data-sub is what the conversation header shows, so it stays a plain
    // single line rather than the marked-up version above.
    var sub = [area, rest].filter(Boolean).join(" · ");

    return '<button class="pm-row" data-person="' + esc(p.user_id) + '" data-name="' + esc(name) +
      '" data-sub="' + esc(sub) + '"' + (p.reachable ? "" : ' data-unreachable="1"') + ">" +
      '<span class="pm-av">' + esc(initials(name)) + "</span>" +
      '<span class="pm-rtx"><span class="pm-name">' + esc(name) +
        (p.is_agent ? ' <span class="pm-badge off">' + esc(t("pm_badge_agent", "Agent")) + "</span>" : "") +
        (p.reachable ? "" : ' <span class="pm-badge warn">' + esc(t("pm_badge_unreachable", "Not on P-Message")) + "</span>") +
      "</span>" +
      '<span class="pm-sub">' + areaHtml +
        (rest ? '<span class="pm-where">' + esc(rest) + "</span>" : "") +
      "</span></span></button>";
  }

  // ---- conversation --------------------------------------------------------
  async function openThread(info) {
    open = info;
    el.pmConv.classList.add("is-on");
    el.pmConv.setAttribute("aria-hidden", "false");
    el.pmConvName.textContent = info.name;
    el.pmConvSub.textContent = info.sub || "";
    el.pmVerify.hidden = info.kind === "ai" || !info.otherId;
    el.pmLog.innerHTML = '<div class="pm-empty">' + esc(t("pm_loading", "Loading…")) + "</div>";

    if (info.kind === "ai") {
      lock(false, t("pm_lock_ai", "Not encrypted — the assistant reads this"));
      el.pmConvNote.textContent = t("pm_ai_note", "The assistant reads these messages. Do not send anything private.");
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
      : t("pm_conv_note", "Encrypted on this device. Nobody else — not even us — can read it.");

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

  function setComposerBlocked(on) {
    if (el.pmInput) {
      el.pmInput.disabled = !!on;
      el.pmInput.placeholder = on
        ? t("pm_trust_blocked_ph", "Check their safety number first")
        : t("pm_write_ph", "Write a message");
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

  function closeThread() {
    open = null;
    if (live) { live.unsubscribe(); live = null; }
    if (el.pmTrustBar) el.pmTrustBar.hidden = true;
    setComposerBlocked(false);
    el.pmConv.classList.remove("is-on");
    el.pmConv.setAttribute("aria-hidden", "true");
    lock(ready);
    refreshInbox();
  }

  function renderLog(rows) {
    if (!rows.length) {
      el.pmLog.innerHTML = '<div class="pm-empty">' + esc(t("pm_say_first", "Say the first thing.")) + "</div>";
      return;
    }
    el.pmLog.innerHTML = rows.map(function (m) {
      // An unreadable message is reported, never dropped — see the header.
      var text = m.failed
        ? t("pm_unreadable", "This message was encrypted for another device.")
        : m.text;
      return '<div class="pm-msg' + (m.mine ? " mine" : "") + (m.failed ? " failed" : "") + '">' +
        esc(text) + '<span class="pm-msg-at">' +
        (m.mine ? "" : esc(m.senderName || "") + " · ") + esc(clock(m.at)) + "</span></div>";
    }).join("");
    el.pmLog.scrollTop = el.pmLog.scrollHeight;
  }

  async function sendCurrent(text) {
    if (!open) return;
    if (open.kind === "ai") return sendToAi(text);
    el.pmSendBtn.disabled = true;
    try {
      await window.PMStore.send(open.threadId, text);
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

  // ---- the assistant -------------------------------------------------------
  // Deliberately a separate, local, UNENCRYPTED thread. It reuses window.AI
  // (js/lib/ai.js), the same client chat.html uses — there is no second AI
  // engine here, only a second doorway to the one that exists.
  function aiLog() {
    try { return JSON.parse(localStorage.getItem(AI_STORE) || "[]"); } catch (_) { return []; }
  }
  function saveAiLog(rows) {
    try { localStorage.setItem(AI_STORE, JSON.stringify(rows.slice(-40))); } catch (_) {}
  }

  function renderAiRow() {
    if (!el.pmAiRow) return;
    var last = aiLog().slice(-1)[0];
    el.pmAiRow.innerHTML = '<button class="pm-row" data-ai="1">' +
      '<span class="pm-av is-ai">AI</span><span class="pm-rtx">' +
      '<span class="pm-name">' + esc(t("pm_ai_name", "Maisha assistant")) +
      ' <span class="pm-badge warn">' + esc(t("pm_badge_open", "Not encrypted")) + "</span></span>" +
      '<span class="pm-sub">' + esc(last ? last.text : t("pm_ai_sub", "Ask about rooms, prices, or how something works")) +
      "</span></span></button>";
  }

  function renderAiLog() {
    var rows = aiLog();
    if (!rows.length) {
      el.pmLog.innerHTML = '<div class="pm-empty">' +
        esc(t("pm_ai_empty", "Ask anything about the site, an area, or what a fair price looks like.")) + "</div>";
      return;
    }
    el.pmLog.innerHTML = rows.map(function (m) {
      return '<div class="pm-msg' + (m.role === "user" ? " mine" : "") + '">' + esc(m.text) + "</div>";
    }).join("");
    el.pmLog.scrollTop = el.pmLog.scrollHeight;
  }

  async function sendToAi(text) {
    var rows = aiLog();
    rows.push({ role: "user", text: text });
    saveAiLog(rows); renderAiLog();
    el.pmSendBtn.disabled = true;
    try {
      if (!window.AI) throw new Error("AI unavailable");
      var res = await window.AI.chat({
        messages: rows.map(function (m) { return { role: m.role === "user" ? "user" : "assistant", content: m.text }; }),
        system: "You are the assistant for Maisha na Lifeza, a Tanzanian marketplace for rooms, " +
          "trucks, daily services and day jobs. Answer briefly, in the language the user writes in " +
          "(English or Swahili). You cannot see the user's private messages.",
      });
      rows.push({ role: "assistant", text: res.reply || "…" });
    } catch (err) {
      // The edge function is not deployed in every environment. Say that
      // plainly rather than leaving a message that never gets an answer.
      rows.push({ role: "assistant", text: t("pm_ai_down", "The assistant is not available right now.") });
    }
    saveAiLog(rows); renderAiLog(); renderAiRow();
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

  function showBroadcast() {
    var names = (window.TZ_REGION_CENTERS || []).map(function (r) { return r.name; })
      .filter(Boolean).sort(function (a, b) { return a.localeCompare(b); });
    modal("<h2>" + esc(t("pm_cast_t", "Announce")) + "</h2>" +
      "<p>" + esc(t("pm_cast_d", "Goes to everyone in the scope who uses P-Message. It is encrypted to each of them individually — one sealed copy per person — so it stays unreadable to everyone else, including us.")) + "</p>" +
      "<label>" + esc(t("pm_cast_scope", "Who")) + "</label>" +
      '<select id="pmCastRegion"><option value="">' + esc(t("pm_cast_all", "Everyone in Tanzania")) + "</option>" +
      names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + "</option>"; }).join("") + "</select>" +
      "<label>" + esc(t("pm_cast_title", "Title")) + '</label><input id="pmCastTitle" maxlength="80" />' +
      "<label>" + esc(t("pm_cast_body", "Message")) + '</label><textarea id="pmCastBody"></textarea>' +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn" id="pmCastGo">' + esc(t("pm_cast_send", "Send")) + "</button>" +
        '<button class="pm-btn ghost" id="pmCastCancel">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
      "</div><div class=\"pm-msg-out\" id=\"pmCastMsg\"></div>");

    document.getElementById("pmCastCancel").addEventListener("click", closeModal);
    document.getElementById("pmCastGo").addEventListener("click", async function (e) {
      var btn = e.currentTarget, out = document.getElementById("pmCastMsg");
      var body = document.getElementById("pmCastBody").value.trim();
      if (!body) { out.className = "pm-msg-out bad"; out.textContent = t("pm_cast_empty", "Write something first."); return; }
      btn.disabled = true;
      out.className = "pm-msg-out";
      try {
        var res = await window.PMStore.broadcast({
          region: document.getElementById("pmCastRegion").value || null,
          title: document.getElementById("pmCastTitle").value.trim() || null,
          text: body,
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
      } finally {
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
    var names = (window.TZ_REGION_CENTERS || []).map(function (r) { return r.name; })
      .filter(Boolean).sort(function (a, b) { return a.localeCompare(b); });
    var found = [];

    modal("<h2>" + esc(t("pm_room_t", "Open a room")) + "</h2>" +
      "<p>" + esc(t("pm_room_d", "Everyone in the scope can talk to each other, encrypted to each member individually. Announcements are one-way; a room is not.")) + "</p>" +
      "<label>" + esc(t("pm_room_cat", "What they deal in")) + "</label>" +
      '<select id="pmRoomCat"><option value="">' + esc(t("pm_room_anycat", "Anything")) + "</option>" +
        '<option value="houses">' + esc(t("pm_cat_houses", "Houses & rooms")) + "</option>" +
        '<option value="services">' + esc(t("pm_cat_services", "Daily services")) + "</option>" +
        '<option value="trucks">' + esc(t("pm_cat_trucks", "Moving trucks")) + "</option></select>" +
      "<label>" + esc(t("pm_room_where", "Where")) + "</label>" +
      '<select id="pmRoomRegion"><option value="">' + esc(t("pm_cast_all", "Everyone in Tanzania")) + "</option>" +
      names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + "</option>"; }).join("") + "</select>" +
      "<label>" + esc(t("pm_room_name", "Name of the room")) + '</label><input id="pmRoomTitle" maxlength="80" />' +
      // The room the admin actually wants most of the time is "all of them",
      // and it was reachable only by knowing that leaving both selects alone
      // meant that. One button says it out loud and fills the name in too.
      '<p style="margin-top:12px"><button class="pm-btn ghost" id="pmRoomEveryone" style="width:100%">' +
        esc(t("pm_room_everyone", "Every agent in Tanzania")) + "</button></p>" +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn ghost" id="pmRoomWho">' + esc(t("pm_room_who", "Who is in scope?")) + "</button>" +
        '<button class="pm-btn" id="pmRoomGo" disabled>' + esc(t("pm_room_open", "Open room")) + "</button>" +
        '<button class="pm-btn ghost" id="pmRoomCancel">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
      "</div><div class=\"pm-msg-out\" id=\"pmRoomMsg\"></div>");

    var out = document.getElementById("pmRoomMsg");
    var go = document.getElementById("pmRoomGo");
    var cat = document.getElementById("pmRoomCat");
    var reg = document.getElementById("pmRoomRegion");

    // Changing the scope invalidates the preview. Leaving a stale "12 people"
    // on screen while the selects say something else is how the wrong room
    // gets opened.
    function invalidate() {
      found = []; go.disabled = true;
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
      // Run the preview straight away: the count is the thing that makes this
      // safe to press, and an admin should see who is about to be added
      // before the button that adds them becomes available.
      document.getElementById("pmRoomWho").click();
    });
    document.getElementById("pmRoomWho").addEventListener("click", async function (e) {
      e.currentTarget.disabled = true;
      out.className = "pm-msg-out";
      out.textContent = t("pm_room_looking", "Looking…");
      try {
        found = await window.PMStore.groupCandidates(cat.value || null, reg.value || null);
        if (!found.length) {
          out.className = "pm-msg-out bad";
          out.textContent = t("pm_room_nobody", "Nobody in that scope uses P-Message yet.");
        } else {
          out.className = "pm-msg-out good";
          out.textContent = t("pm_room_found", "{n} people: {who}", {
            n: found.length,
            who: found.slice(0, 6).map(function (p) { return p.display_name || p.user_id; }).join(", ") +
                 (found.length > 6 ? "…" : ""),
          });
          go.disabled = false;
        }
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
      } finally {
        e.currentTarget.disabled = false;
      }
    });

    document.getElementById("pmRoomGo").addEventListener("click", async function (e) {
      if (!found.length) return;
      e.currentTarget.disabled = true;
      out.className = "pm-msg-out";
      out.textContent = t("pm_room_opening", "Opening…");
      try {
        await window.PMStore.groupCreate({
          title: document.getElementById("pmRoomTitle").value.trim() ||
                 t("pm_room", "Room"),
          category: cat.value || null,
          region: reg.value || null,
          members: found.map(function (p) { return p.user_id; }),
        });
        closeModal();
        await refreshInbox();
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
        e.currentTarget.disabled = false;
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
    renderInviteList();

    document.getElementById("pmInvGo").addEventListener("click", async function (e) {
      var out = document.getElementById("pmInvMsg");
      e.currentTarget.disabled = true;
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
        e.currentTarget.disabled = false;
      }
    });
  }

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
            "</div>";
        }).join("");
    } catch (_) { box.innerHTML = ""; }
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
      e.currentTarget.disabled = true;
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
        e.currentTarget.disabled = false;
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
      var row = e.target.closest("[data-thread]");
      if (!row) return;
      openThread({
        threadId: row.dataset.thread, kind: row.dataset.kind,
        name: row.dataset.name, sub: row.dataset.sub, otherId: row.dataset.other || null,
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

    el.pmAiRow && el.pmAiRow.addEventListener("click", function (e) {
      if (!e.target.closest("[data-ai]")) return;
      openThread({ threadId: AI_THREAD, kind: "ai", name: t("pm_ai_name", "Maisha assistant"),
        sub: t("pm_ai_sub2", "Not encrypted") });
    });

    el.pmBack && el.pmBack.addEventListener("click", closeThread);
    el.pmVerify && el.pmVerify.addEventListener("click", openVerify);
    el.pmFpBtn && el.pmFpBtn.addEventListener("click", function () { showBackup(); });
    el.pmBroadcastBtn && el.pmBroadcastBtn.addEventListener("click", showBroadcast);
    el.pmRoomsBtn && el.pmRoomsBtn.addEventListener("click", showRooms);
    el.pmInviteBtn && el.pmInviteBtn.addEventListener("click", showInvite);

    el.pmComposeForm && el.pmComposeForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = el.pmInput.value.trim();
      if (!text) return;
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
