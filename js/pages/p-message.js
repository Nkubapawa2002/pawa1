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
  ["pmLock", "pmLockText", "pmFpBtn", "pmBroadcastBtn", "segChats", "segPeople", "segAi",
   "pmGate", "paneChats", "panePeople", "paneAi", "pmInbox", "pmSearch", "pmRegion",
   "pmPeople", "pmAiRow", "pmConv", "pmBack", "pmConvName", "pmConvSub", "pmVerify",
   "pmLog", "pmConvNote", "pmComposeForm", "pmInput", "pmSendBtn", "pmModalBack", "pmModal"]
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
      // A brand new device is the moment to say that the key lives HERE, while
      // there is still nothing to lose. Saying it after a lost phone is useless.
      if (res.isNewDevice) setTimeout(showBackup, 400);
    } catch (err) {
      lock(false, t("pm_lock_none", "Encryption unavailable"));
      gate('<div class="pm-note warn">' + esc(t("pm_setup_failed", "Could not set up encryption on this device.")) +
        "<br><small>" + esc((err && err.message) || err) + "</small></div>");
      return;
    }

    await refreshInbox();
    renderAiRow();
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
      var name = broadcast
        ? (r.title || t("pm_announcement", "Announcement"))
        : (r.other_name || t("pm_someone", "Someone"));
      var sub = broadcast
        ? t("pm_from_admin", "From the team") + (r.region ? " · " + r.region : " · " + t("pm_nationwide", "Nationwide"))
        : [r.other_area, r.other_region].filter(Boolean).join(" · ");
      // Somebody with no account is worth marking. It is true, and an agent
      // deciding how much time to give an enquiry should know it.
      var guestTag = (!broadcast && r.other_guest)
        ? ' <span class="pm-badge off">' + esc(t("pm_badge_guest", "Guest")) + "</span>" : "";
      return '<button class="pm-row" data-thread="' + esc(r.thread_id) + '" data-kind="' + esc(r.kind) +
        '" data-name="' + esc(name) + '" data-sub="' + esc(sub) + '" data-other="' + esc(r.other_id || "") + '">' +
        '<span class="pm-av' + (broadcast ? " is-cast" : "") + '">' + (broadcast ? "★" : esc(initials(name))) + "</span>" +
        '<span class="pm-rtx"><span class="pm-name">' + esc(name) + guestTag +
          (broadcast ? ' <span class="pm-badge">' + esc(t("pm_badge_cast", "Announcement")) + "</span>" : "") +
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
    var rows;
    try {
      rows = await window.PMStore.directory({
        region: el.pmRegion ? el.pmRegion.value : "",
        query: el.pmSearch ? el.pmSearch.value.trim() : "",
      });
    } catch (err) {
      el.pmPeople.innerHTML = '<div class="pm-empty">' + esc((err && err.message) || err) + "</div>";
      return;
    }

    if (!rows.length) {
      el.pmPeople.innerHTML = '<div class="pm-empty">' + esc(t("pm_no_people", "Nobody matches that yet.")) + "</div>";
      return;
    }

    el.pmPeople.innerHTML = rows.map(function (p) {
      var name = p.display_name || t("pm_someone", "Someone");
      // "Where they work" is the whole reason to message an agent, so the area
      // of operations is the subtitle — not their region, which is coarse, and
      // not their phone, which this page never sees.
      var where = [p.area, p.ward, p.district, p.region].filter(Boolean);
      var sub = where.length ? where.slice(0, 2).join(" · ") : (p.region || "");
      return '<button class="pm-row" data-person="' + esc(p.user_id) + '" data-name="' + esc(name) +
        '" data-sub="' + esc(sub) + '"' + (p.reachable ? "" : " data-unreachable=\"1\"") + ">" +
        '<span class="pm-av">' + esc(initials(name)) + "</span>" +
        '<span class="pm-rtx"><span class="pm-name">' + esc(name) +
          (p.is_agent ? ' <span class="pm-badge off">' + esc(t("pm_badge_agent", "Agent")) + "</span>" : "") +
          (p.reachable ? "" : ' <span class="pm-badge warn">' + esc(t("pm_badge_unreachable", "Not on P-Message")) + "</span>") +
        '</span><span class="pm-sub">' + esc(sub) + "</span></span></button>";
    }).join("");
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
      : t("pm_conv_note", "Encrypted on this device. Nobody else — not even us — can read it.");

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

  function closeThread() {
    open = null;
    if (live) { live.unsubscribe(); live = null; }
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
    onChange: async function (res) {
      fingerprint = res.fingerprint;
      if (el.pmFpBtn) el.pmFpBtn.textContent = t("pm_your_number", "Your safety number {n}", { n: fingerprint });
      await refreshInbox();
    },
  });
  var showFingerprint = function (name, theirs) { window.PMIdentityUI.safetyNumbers(name, theirs); };
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
    el.pmVerify && el.pmVerify.addEventListener("click", async function () {
      var theirs = null;
      if (open && open.otherId) {
        // pm_peer, not the directory: a guest is deliberately absent from the
        // directory, so verifying one there would silently find nobody.
        try {
          var hit = await window.PMStore.peer(open.otherId);
          theirs = hit && hit.fingerprint;
        } catch (_) {}
      }
      showFingerprint(open && open.name, theirs);
    });
    el.pmFpBtn && el.pmFpBtn.addEventListener("click", function () { showBackup(); });
    el.pmBroadcastBtn && el.pmBroadcastBtn.addEventListener("click", showBroadcast);

    el.pmComposeForm && el.pmComposeForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = el.pmInput.value.trim();
      if (!text) return;
      el.pmInput.value = "";
      sendCurrent(text);
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
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
