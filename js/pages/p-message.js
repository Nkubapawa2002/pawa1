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
  el.pmModalBack && el.pmModalBack.addEventListener("click", function (e) {
    if (e.target === el.pmModalBack) closeModal();
  });

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
      gate('<div class="pm-note"><b>' + esc(t("pm_signin_t", "Sign in to use P-Message")) + "</b><br>" +
        esc(t("pm_signin_d", "Your messages are encrypted with a key that belongs to your account, so there is nobody to be as until you sign in.")) +
        '</div><a class="pm-btn" href="login.html" style="display:inline-block;text-decoration:none">' +
        esc(t("pm_signin_go", "Sign in")) + "</a>");
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
      return '<button class="pm-row" data-thread="' + esc(r.thread_id) + '" data-kind="' + esc(r.kind) +
        '" data-name="' + esc(name) + '" data-sub="' + esc(sub) + '" data-other="' + esc(r.other_id || "") + '">' +
        '<span class="pm-av' + (broadcast ? " is-cast" : "") + '">' + (broadcast ? "★" : esc(initials(name))) + "</span>" +
        '<span class="pm-rtx"><span class="pm-name">' + esc(name) +
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
  function showFingerprint(name, theirs) {
    modal("<h2>" + esc(t("pm_verify_t", "Safety numbers")) + "</h2>" +
      "<p>" + esc(t("pm_verify_d", "Read these aloud to each other — on a call, or standing together. If they match, nobody has slipped between you. If they do not, stop and tell us.")) + "</p>" +
      "<label>" + esc(t("pm_verify_yours", "Yours")) + "</label>" +
      '<div class="pm-big-fp">' + esc(fingerprint || "—") + "</div>" +
      (theirs ? "<label>" + esc(name || "") + "</label><div class=\"pm-big-fp\">" + esc(theirs) + "</div>" : "") +
      '<div class="pm-modal-acts"><button class="pm-btn" id="pmFpOk">' + esc(t("pm_close", "Close")) + "</button></div>");
    document.getElementById("pmFpOk").addEventListener("click", closeModal);
  }

  function showBackup() {
    modal("<h2>" + esc(t("pm_backup_t", "Your key lives on this device")) + "</h2>" +
      "<p>" + esc(t("pm_backup_d", "That is what makes these messages private — and it means clearing this browser's data loses them for good. Save a backup code now and you can restore it on another phone.")) + "</p>" +
      "<label>" + esc(t("pm_backup_pass", "Passphrase (8+ characters)")) + "</label>" +
      '<input type="password" id="pmBkPass" autocomplete="new-password" />' +
      '<div id="pmBkOut"></div>' +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn" id="pmBkMake">' + esc(t("pm_backup_make", "Create code")) + "</button>" +
        '<button class="pm-btn ghost" id="pmBkSkip">' + esc(t("pm_later", "Later")) + "</button>" +
      "</div>" +
      '<div class="pm-msg-out" id="pmBkMsg"></div>' +
      '<p style="margin-top:14px"><button class="pm-btn ghost" id="pmBkRestore" style="width:100%">' +
      esc(t("pm_restore", "I have a backup code")) + "</button></p>");

    document.getElementById("pmBkSkip").addEventListener("click", closeModal);
    document.getElementById("pmBkMake").addEventListener("click", async function () {
      var out = document.getElementById("pmBkMsg");
      try {
        var code = await window.PMCrypto.backup(window.PMStore.current(),
          document.getElementById("pmBkPass").value);
        document.getElementById("pmBkOut").innerHTML =
          "<label>" + esc(t("pm_backup_code", "Your backup code — keep it somewhere safe")) + "</label>" +
          '<div class="pm-code">' + esc(code) + "</div>";
        out.className = "pm-msg-out good";
        out.textContent = t("pm_backup_ok", "Copy it somewhere only you can reach. It is useless without your passphrase.");
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
      }
    });
    document.getElementById("pmBkRestore").addEventListener("click", showRestore);
  }

  function showRestore() {
    modal("<h2>" + esc(t("pm_restore_t", "Restore your key")) + "</h2>" +
      "<p>" + esc(t("pm_restore_d", "Paste the backup code from your other device. This replaces the key on this one, so anything sent to this device only will stop opening.")) + "</p>" +
      "<label>" + esc(t("pm_restore_code", "Backup code")) + "</label><textarea id=\"pmRsCode\"></textarea>" +
      "<label>" + esc(t("pm_backup_pass", "Passphrase")) + "</label><input type=\"password\" id=\"pmRsPass\" />" +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn" id="pmRsGo">' + esc(t("pm_restore_go", "Restore")) + "</button>" +
        '<button class="pm-btn ghost" id="pmRsCancel">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
      "</div><div class=\"pm-msg-out\" id=\"pmRsMsg\"></div>");

    document.getElementById("pmRsCancel").addEventListener("click", closeModal);
    document.getElementById("pmRsGo").addEventListener("click", async function () {
      var out = document.getElementById("pmRsMsg");
      out.className = "pm-msg-out"; out.textContent = t("pm_working", "Working…");
      try {
        var res = await window.PMStore.restoreIdentity(
          document.getElementById("pmRsCode").value, document.getElementById("pmRsPass").value);
        fingerprint = res.fingerprint;
        el.pmFpBtn.textContent = t("pm_your_number", "Your safety number {n}", { n: fingerprint });
        out.className = "pm-msg-out good";
        out.textContent = t("pm_restore_ok", "Restored. Your old conversations open again.");
        await refreshInbox();
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
      }
    });
  }

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
        try {
          var rows = await window.PMStore.directory({ limit: 500 });
          var hit = rows.filter(function (r) { return r.user_id === open.otherId; })[0];
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
