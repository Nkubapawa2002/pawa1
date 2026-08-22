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
   "pmTrustBar", "pmWho", "pmCount", "pmCats", "pmShort", "pmMembers"]
    .forEach(function (id) { el[id] = document.getElementById(id); });

  var me = null;             // { userId, email, isAdmin }
  var fingerprint = "";
  var ready = false;         // an identity exists and is published
  var seg = "chats";
  var open = null;           // { threadId, name, sub, kind, otherId }
  var live = null;           // realtime subscription for the open thread
  var inboxLive = null;      // realtime + poll for the thread list itself
  var searchTimer = null;

  var AI_THREAD = "assistant";
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
    watchInbox();
    renderAiRow();
    // Last, because it opens a conversation over the inbox it needs drawn
    // first — and because everything above must work whether or not the link
    // carried a person.
    try { await openRequestedPeer(); } catch (_) {}
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
    // wrong for "who can help me find a room". Both lists are available; the
    // agents are the default because that is what the tab is for.
    //
    // EXCEPT when a category is chosen, and this is the fix day jobs forced.
    // The agent flag is a proxy for "does this person deal in anything"; the
    // category filter is the actual measurement, applied in the database
    // against what they have listed. Running the proxy on top of the
    // measurement can only subtract, and what it subtracted was exactly the
    // people the chip was for: a company that posts day jobs almost never
    // registers as an agent, so "Day jobs" plus the default "Agents" returned
    // an empty screen while the right answers sat one dropdown away. The same
    // was quietly true of a landlord who lists rooms without being an agent.
    // Evidence beats a flag, so with a chip on, the flag stands down.
    var wantAgents = !el.pmWho || el.pmWho.value !== "all";
    var shown = (wantAgents && !category)
      ? rows.filter(function (p) { return p.is_agent; })
      : rows;

    if (!shown.length) {
      el.pmPeople.innerHTML = '<div class="pm-empty">' + esc(emptyWhy(rows.length, wantAgents)) + "</div>";
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
      // "12 agents" would be a lie about a list the agent flag no longer
      // filtered. The word has to follow what is actually on screen.
      var onlyAgents = wantAgents && !category;
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
  function emptyWhy(total, wantAgents) {
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
    if (total && wantAgents) {
      return t("pm_no_agents", "No agents match that. Switch to Everyone to see other people on P-Message.");
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
  function whereOf(p, opts) {
    var area = String((p && p.area) || "").trim();
    // The broader places, minus whatever already appears as the area — an
    // agent whose area IS "Nyamagana" should not read "Nyamagana · Nyamagana".
    var rest = [p && p.ward, p && p.district, p && p.region].filter(function (v) {
      return v && String(v).trim() && String(v).trim().toLowerCase() !== area.toLowerCase();
    }).slice(0, 2).join(" · ");

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

    return '<button class="pm-row is-person" data-person="' + esc(p.user_id) + '" data-name="' + esc(name) +
      '" data-sub="' + esc(sub) + '"' + (p.reachable ? "" : ' data-unreachable="1"') + ">" +
      '<span class="pm-av">' + esc(initials(name)) + "</span>" +
      '<span class="pm-rtx"><span class="pm-name">' + esc(name) + fit +
        (p.is_agent ? ' <span class="pm-badge off">' + esc(t("pm_badge_agent", "Agent")) + "</span>" : "") +
        (p.reachable ? "" : ' <span class="pm-badge warn">' + esc(t("pm_badge_unreachable", "Not on P-Message")) + "</span>") +
      "</span>" +
      '<span class="pm-sub">' + w.html + "</span>" + dealsHtml +
      (why ? '<span class="pm-why">' + esc(why) + "</span>" : "") +
      "</span></button>";
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
    if (info.kind === "group") countMembers(info);
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

    // The header opened with whatever the row that was tapped happened to know
    // — which, from the inbox, is a name and sometimes a region. pm_peer knows
    // where they actually work, and that is the fact worth having on screen
    // while you decide what to ask them.
    var w = whereOf(hit, { quiet: !hit.isAgent });
    if (el.pmConvSub && (w.area || w.rest)) {
      el.pmConvSub.innerHTML = w.html +
        (hit.isGuest ? ' <span class="pm-badge off">' + esc(t("pm_badge_guest", "Guest")) + "</span>" : "");
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

    document.getElementById("pmMemActs").insertAdjacentHTML("afterbegin",
      (canManage ? '<button class="pm-btn" id="pmMemAdd">' + esc(t("pm_mem_add", "Add people")) + "</button>" : "") +
      '<button class="pm-btn danger" id="pmMemLeave">' + esc(t("pm_mem_leave", "Leave room")) + "</button>");

    var add = document.getElementById("pmMemAdd");
    if (add) add.addEventListener("click", function () { showAddMembers(threadId, rows); });

    document.getElementById("pmMemLeave").addEventListener("click", async function (e) {
      var out = document.getElementById("pmMemMsg");
      // Leaving is not undoable by the person leaving — only the owner can put
      // them back — so it asks once rather than acting on a tap.
      if (!confirm(t("pm_mem_leave_q", "Leave this room? You will stop receiving what is said in it."))) return;
      var btn = e.currentTarget;      // captured, never read after an await
      btn.disabled = true;
      try {
        await window.PMStore.groupLeave(threadId);
        closeModal();
        closeThread();
        await refreshInbox();
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
        btn.disabled = false;
      }
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
    var room = open && open.kind === "group";
    el.pmLog.innerHTML = rows.map(function (m) {
      // An unreadable message is reported, never dropped — see the header.
      var text = m.failed
        ? t("pm_unreadable", "This message was encrypted for another device.")
        : m.text;
      // In a room the name beside a message is one its sender chose for
      // themselves, and some of those people have proved nothing about who
      // they are. Saying which is the difference between "the agent said so"
      // and "somebody calling themselves that said so".
      var who = m.mine ? "" : esc(m.senderName || t("pm_someone", "Someone")) +
        (room && m.senderGuest ? " " + esc(t("pm_badge_guest", "Guest")) : "") + " · ";
      return '<div class="pm-msg' + (m.mine ? " mine" : "") + (m.failed ? " failed" : "") + '">' +
        esc(text) + '<span class="pm-msg-at">' + who + esc(clock(m.at)) + "</span></div>";
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
    el.pmMembers && el.pmMembers.addEventListener("click", showMembers);
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
