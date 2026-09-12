// ============================================================================
//  pm-invite-ui.js — the link that makes a stranger reachable.
//
//  Split out of js/pages/p-message.js. Nothing in the body below changed in
//  the move.
//
//  WHY THIS IS THE MOST IMPORTANT DIALOG ON THE SCREEN, AND IT IS NOT OBVIOUS.
//  Everything else in P-Message can only reach somebody who is already
//  reachable: the directory lists people who published a key, and a room or an
//  announcement may only include people you already deal with. An invite is the
//  ONLY way a person who has never opened the site becomes somebody you can
//  write to. It is the bottom of the whole reach graph, which is why the empty
//  state of the people picker points here rather than merely apologising.
//
//  An agent met somebody at a viewing and has a phone number and nothing else.
//  There is no key to encrypt to, because that person has never opened the
//  site, so no thread can exist yet. An invite is the missing direction: a link
//  that mints a session, a key and a thread the moment it is opened.
//
//  THE HARD PART IS THE HAND-OFF, AND IT WAS THE PART THAT WAS MISSING.
//  Making the link was one button and one field; delivering it was "here is the
//  URL in a text box, good luck". So the flow is two steps, and the second is
//  the one that matters:
//
//    1. make    a note for yourself, and optionally their phone number.
//    2. send    WhatsApp or SMS straight at that number, the phone's own share
//               sheet, the clipboard, or a QR code they scan off this screen
//               while standing in front of you.
//
//  The code is the only one of those five that involves nobody else at all: the
//  link goes from this screen into that camera and touches no network, no
//  carrier and no messaging company. For a link that is a bearer credential,
//  handed over in person, that is the right default and it is why it is offered
//  rather than merely possible.
//
//  THE TOKEN IS SHOWN ONCE. It is not recoverable, by design: the server holds
//  only its sha256, so a link nobody kept is a link nobody can send. That is
//  what step 2 exists to protect against, and why a tap on the backdrop while
//  step 2 is open is caught by the page rather than closing the dialog. The
//  page asks pending() to know whether it is in that state.
// ============================================================================
(function () {
  "use strict";

  // Handed in by the page. Read at CALL time, never destructured at attach
  // time: the page assigns several of these after it attaches, and a captured
  // copy would be undefined with no error to say so.
  var ctx = {};

  var t = function (k, f) { return f || k; };
  var esc = function (s) { return String(s == null ? "" : s); };

  function attach(o) {
    ctx = o || {};
    if (ctx.t) t = ctx.t;
    if (ctx.esc) esc = ctx.esc;
  }

  var modal = function (html) { if (ctx.modal) ctx.modal(html); };
  var closeModal = function () { if (ctx.closeModal) ctx.closeModal(); };
  var say = function (m) { if (ctx.say) ctx.say(m); };
  var refreshInbox = function () {
    return ctx.refreshInbox ? ctx.refreshInbox() : Promise.resolve();
  };
  //
  //  An agent met somebody at a viewing and has a phone number and nothing
  //  else. There is no key to encrypt to, because that person has never opened
  //  the site, so no thread can exist yet. An invite is the missing direction:
  //  a link that mints a session, a key and a thread the moment it is opened.
  //
  //  THE HARD PART IS THE HAND-OFF, AND IT WAS THE PART THAT WAS MISSING.
  //  Making the link was one button and one field; delivering it was "here is
  //  the URL in a text box, good luck". So the flow is two steps now, and the
  //  second step is the one that matters:
  //
  //    1. make    a note for yourself, and optionally their phone number.
  //    2. send    WhatsApp or SMS straight at that number, the phone's own
  //               share sheet, the clipboard, or a QR code they scan off this
  //               screen while standing in front of you.
  //
  //  The code is the only one of those five that involves nobody else at all:
  //  the link goes from this screen into that camera and touches no network,
  //  no carrier and no messaging company. For a link that is a bearer
  //  credential, handed over in person, that is the right default and it is
  //  why it is offered rather than merely possible.
  //
  //  THE TOKEN IS SHOWN ONCE. It is not recoverable, by design: the server
  //  holds only its sha256, so a link nobody kept is a link nobody can send.
  //  That is what step 2 exists to protect against, and why a tap on the
  //  backdrop while step 2 is open is caught in wire() rather than closing it.

  /** The state of the link currently being handed over, or null on step 1. */
  var invMade = null;

  function showInvite() {
    invMade = null;
    modal("<h2>" + esc(t("pm_inv_t", "Invite a customer")) + "</h2>" +
      '<p class="pm-role">' + esc(t("pm_inv_role",
        "A link that gives one person an encrypted conversation with you, without an account and without giving them your number.")) + "</p>" +
      "<p>" + esc(t("pm_inv_d2",
        "Write yourself a note so you know who it went to. Add their number and the next screen can send it straight to them.")) + "</p>" +
      "<label>" + esc(t("pm_inv_label", "Your note (only you see this)")) +
        '</label><input id="pmInvLabel" maxlength="60" autocomplete="off" />' +
      "<label>" + esc(t("pm_inv_phone", "Their phone number (optional)")) +
        '</label><input id="pmInvPhone" type="tel" inputmode="tel" maxlength="20" autocomplete="off" placeholder="0712 345 678" />' +
      '<p class="pm-hint">' + esc(t("pm_inv_phone_d",
        "Kept on this phone only. It is never sent to us, and it is only used to open WhatsApp or the message app at the right person.")) + "</p>" +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn" id="pmInvGo">' + esc(t("pm_inv_make", "Make a link")) + "</button>" +
        '<button class="pm-btn ghost" id="pmInvCancel">' + esc(t("pm_close", "Close")) + "</button>" +
      "</div>" +
      '<div class="pm-msg-out" id="pmInvMsg"></div>' +
      '<div id="pmInvList"></div>');

    document.getElementById("pmInvCancel").addEventListener("click", closeModal);
    // Bound HERE, once, and not inside renderInviteList — that function only
    // rewrites #pmInvList's innerHTML, so the element itself survives every
    // redraw. Re-binding per redraw would leave one extra listener behind each
    // time a link was made or withdrawn, and the next Withdraw would then ask
    // for confirmation N times and fire N revokes: the first succeeds and the
    // rest fail on a hash that is already gone, so a withdrawal that WORKED
    // reports an error.
    document.getElementById("pmInvList").addEventListener("click", onInviteListClick);
    renderInviteList();

    document.getElementById("pmInvGo").addEventListener("click", async function (e) {
      var out = document.getElementById("pmInvMsg");
      var btn = e.currentTarget;      // captured, never read after an await
      btn.disabled = true;
      out.className = "pm-msg-out"; out.textContent = "";
      try {
        var label = document.getElementById("pmInvLabel").value.trim();
        var phone = document.getElementById("pmInvPhone").value.trim();
        var inv = await window.PMStore.inviteCreate(label || null);
        invMade = { link: inv.link, label: label, phone: phone, expiresAt: inv.expiresAt };
        showInviteSend();
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
        btn.disabled = false;
      }
    });
  }

  // ---- step 2: getting it into their hands ---------------------------------

  /**
   * A Tanzanian mobile number in the form wa.me wants: digits only, country
   * code included, no plus. 0712 345 678 is the way it is written here and
   * 255712345678 is the way it has to be sent, and the gap between those two
   * is the reason a "WhatsApp" button that simply used what was typed would
   * open an empty chooser about a quarter of the time.
   *
   * Returns "" for anything too short to be a number, so a half-typed field
   * gets the share sheet rather than a dialler pointed at three digits.
   */
  function intlPhone(raw) {
    var digits = String(raw || "").replace(/\D/g, "");
    if (digits.indexOf("00") === 0) digits = digits.slice(2);
    if (digits.charAt(0) === "0") digits = "255" + digits.slice(1);
    else if (digits.length === 9) digits = "255" + digits;   // 712345678
    return digits.length >= 11 ? digits : "";
  }

  /** "expires on 20 September", or "" when the server did not say. */
  function inviteExpiryWords(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var lang = (window.getLang && window.getLang()) === "sw" ? "sw-TZ" : "en-GB";
    try { return d.toLocaleDateString(lang, { day: "numeric", month: "long" }); }
    catch (_) { return d.toISOString().slice(0, 10); }
  }

  function showInviteSend() {
    var link = invMade.link;
    var intl = intlPhone(invMade.phone);
    var who = invMade.label || (invMade.phone || "").trim();
    // What goes in the message body. Their name is not in it: the agent's note
    // is for the agent ("the couple from Kariakoo") and putting it in the text
    // would send somebody a message describing them in the third person.
    var text = t("pm_inv_msg", "Here is a private, encrypted link to chat with me on Maisha na Lifeza. It works once, and you do not need an account. {link}", { link: link });
    var enc = encodeURIComponent(text);

    var canShare = !!(navigator.share);
    // RFC 5724 says sms:<number>?body=<text> and Android obeys it. iOS does
    // not: with a number present Safari wants an ampersand, and given a
    // question mark it opens the message app with an empty body, which is the
    // one failure that looks like the app working. One character, and it is
    // the difference between a link that arrives and a blank draft.
    var smsSep = /iPad|iPhone|iPod/.test(navigator.userAgent || "") ? "&" : "?";
    var expiry = inviteExpiryWords(invMade.expiresAt);

    modal("<h2>" + esc(t("pm_inv_send_t", "Send it to them")) + "</h2>" +
      // The dots come from the key dialogs, which had this problem first: a
      // second screen with no counter on it reads as the first one having
      // reopened.
      window.PMIdentityUI.steps(2, 2) +
      '<p class="pm-role">' + esc(who
        ? t("pm_inv_send_who", "The link for {who} is ready.", { who: who })
        : t("pm_inv_send_ready", "The link is ready.")) + "</p>" +
      '<div class="pm-note is-warn">' + esc(t("pm_inv_once2",
        "This is the only time this link is shown. We keep no copy of it, so if you leave without sending it you will have to make another.")) +
        (expiry ? " " + esc(t("pm_inv_expires_on", "It stops working on {date}.", { date: expiry })) : "") +
      "</div>" +
      '<input readonly id="pmInvLink" value="' + esc(link) + '" />' +
      '<div class="pm-inv-send">' +
        (intl
          ? '<a class="pm-btn" id="pmInvWa" target="_blank" rel="noopener" href="https://wa.me/' +
            esc(intl) + "?text=" + enc + '">' + esc(t("pm_inv_wa_to", "WhatsApp them")) + "</a>" +
            '<a class="pm-btn ghost" id="pmInvSms" href="sms:+' + esc(intl) + smsSep + "body=" + enc + '">' +
            esc(t("pm_inv_sms_to", "Text them")) + "</a>"
          : '<a class="pm-btn" id="pmInvWa" target="_blank" rel="noopener" href="https://wa.me/?text=' + enc + '">' +
            esc(t("pm_inv_wa", "Send on WhatsApp")) + "</a>" +
            '<a class="pm-btn ghost" id="pmInvSms" href="sms:?body=' + enc + '">' +
            esc(t("pm_inv_sms", "Send by SMS")) + "</a>") +
        (canShare
          ? '<button class="pm-btn ghost" id="pmInvShare">' + esc(t("pm_inv_share", "Other apps")) + "</button>"
          : "") +
        '<button class="pm-btn ghost" id="pmInvCopy">' + esc(t("pm_inv_copy", "Copy link")) + "</button>" +
      "</div>" +
      // The route that does NOT leave the app. Every other one here hands the
      // link to a different program, which is right for reaching somebody who
      // is not here yet. This one is for the other case: a person you are
      // already talking to, who wants to pass it on to somebody else.
      '<div class="pm-inv-here">' +
        '<button class="pm-btn ghost" id="pmInvHereGo" style="width:100%">' +
          esc(t("pm_inv_here", "Send it in a conversation")) + "</button>" +
        '<p class="pm-inv-here-d">' + esc(t("pm_inv_here_d",
          "For somebody you already talk to here who wants to pass it on. Pick the conversation it goes into.")) + "</p>" +
        '<div id="pmInvHereList" class="pm-inv-here-list" hidden></div>' +
      "</div>" +
      // The hand-off with nobody in the middle. Standing in front of somebody
      // is the situation invites were written for, and until now the answer
      // was "message it to yourself and read it out".
      (window.QR
        ? '<p style="margin-top:12px"><button class="pm-btn ghost" id="pmInvQrGo" style="width:100%">' +
          esc(t("pm_inv_qr", "Show a code they can scan")) + "</button></p>" +
          '<div id="pmInvQr" hidden>' +
            (window.PMSafety ? window.PMSafety.qrSvg(link, t("pm_inv_qr_alt", "Invite code")) : "") +
            '<p class="pm-qr-cap">' + esc(t("pm_inv_qr_d",
              "Let them point their camera at this. The link goes straight from this screen to their phone.")) + "</p>" +
          "</div>"
        : "") +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn ghost" id="pmInvDone">' + esc(t("pm_inv_done", "Done")) + "</button>" +
      "</div>" +
      '<div class="pm-msg-out" id="pmInvMsg2"></div>');

    var out = document.getElementById("pmInvMsg2");
    var said = function (msg, good) {
      out.className = "pm-msg-out" + (good === false ? " bad" : good ? " good" : "");
      out.textContent = msg;
    };

    document.getElementById("pmInvDone").addEventListener("click", function () {
      invMade = null;
      showInvite();
    });

    document.getElementById("pmInvCopy").addEventListener("click", function () {
      var f = document.getElementById("pmInvLink");
      try { f.select(); } catch (_) {}
      window.PMSafety.copyText(link, function (ok) {
        said(ok ? t("pm_inv_copied", "Copied") : t("pm_inv_copy_fail",
          "Copying was refused. Select the link above and copy it by hand."), ok);
      });
    });

    if (document.getElementById("pmInvShare")) {
      document.getElementById("pmInvShare").addEventListener("click", async function () {
        try {
          await navigator.share({ title: t("pm_inv_t", "Invite a customer"), text: text });
        } catch (_) {
          // Cancelling the share sheet rejects, and telling somebody their own
          // cancellation failed is noise. Only a share that could not open at
          // all is worth a word, and there is no way to tell the two apart, so
          // this says nothing.
        }
      });
    }

    if (document.getElementById("pmInvQrGo")) {
      document.getElementById("pmInvQrGo").addEventListener("click", function () {
        var box = document.getElementById("pmInvQr");
        box.hidden = !box.hidden;
        this.textContent = box.hidden
          ? t("pm_inv_qr", "Show a code they can scan")
          : t("pm_inv_qr_hide", "Hide the code");
      });
    }

    // ---- into a conversation that already exists ---------------------------
    //
    //  The list is fetched on the tap rather than drawn with the dialog. It is
    //  a round trip, and paying for it on every invite so that most people can
    //  ignore a list they did not ask for is the wrong trade.
    //
    //  ANNOUNCEMENTS ARE NOT OFFERED. An announcement is one-way by design
    //  (pm_can_announce welds the composer shut for everybody but its owner),
    //  so a link sent into one reaches people who cannot answer it, and an
    //  invite whose whole purpose is starting a conversation would land in the
    //  one place where conversation is impossible.
    var hereGo = document.getElementById("pmInvHereGo");
    if (hereGo) {
      hereGo.addEventListener("click", async function () {
        var box = document.getElementById("pmInvHereList");
        if (!box.hidden) { box.hidden = true; return; }
        box.hidden = false;
        box.innerHTML = '<p class="pm-inv-here-d">' + esc(t("pm_loading", "Loading…")) + "</p>";

        var rows = [];
        try { rows = await window.PMStore.inbox(); } catch (_) { rows = []; }
        var pick = rows.filter(function (r) { return r.kind === "direct" || r.kind === "group"; });

        if (!pick.length) {
          box.innerHTML = '<p class="pm-inv-here-d">' + esc(t("pm_inv_here_none",
            "You have no conversations yet, so there is nowhere in the app to send it. Use one of the ways above.")) + "</p>";
          return;
        }

        box.innerHTML = '<p class="pm-inv-here-d">' + esc(t("pm_inv_here_pick", "Which conversation?")) + "</p>" +
          pick.map(function (r, i) {
            var name = r.kind === "group"
              ? (r.title || t("pm_room", "Room"))
              : (r.other_name || t("pm_someone", "Someone"));
            var sub = r.kind === "group"
              ? t("pm_room_sub", "Group room")
              : [r.other_area, r.other_region].filter(Boolean).join(" · ");
            return '<button class="pm-inv-here-row" type="button" data-here="' + i + '">' +
              '<span class="pm-inv-here-n">' + esc(name) + "</span>" +
              (sub ? '<span class="pm-inv-here-s">' + esc(sub) + "</span>" : "") +
              "</button>";
          }).join("");

        box.querySelectorAll("[data-here]").forEach(function (b) {
          b.addEventListener("click", async function () {
            var r = pick[parseInt(b.dataset.here, 10)];
            if (!r) return;
            box.querySelectorAll("[data-here]").forEach(function (x) { x.disabled = true; });
            try {
              // No note. invMade.label is the AGENT's private word for this
              // customer ("the couple from Kariakoo"), and putting it in the
              // body would send somebody a message describing them in the
              // third person. compose() writes the neutral sentence instead.
              await window.PMStore.send(r.thread_id, window.PMInviteCard.compose(link, ""));
              said(t("pm_inv_here_sent", "Sent into that conversation."), true);
              box.hidden = true;
              refreshInbox();
            } catch (_) {
              said(t("pm_inv_here_fail", "That could not be sent. Try one of the other ways above."), false);
              box.querySelectorAll("[data-here]").forEach(function (x) { x.disabled = false; });
            }
          });
        });
      });
    }
  }

  // ---- the links you have out there ----------------------------------------
  //
  //  Two sections, and the split is the whole point. A link is a bearer
  //  credential: whoever opens it first becomes the customer in that thread,
  //  so the list exists to answer "what is still out there in the world". A
  //  list where three dead entries sit above the one live one cannot answer
  //  that, and it was answering it worse every week, because nothing could
  //  ever be removed.
  //
  //  live      open links, newest first, each with Withdraw.
  //  finished  used, withdrawn and expired, each with a Remove, and a Clear
  //            for the lot. A finished link cannot hurt anybody; it is only
  //            clutter, and clutter on this screen hides the one row that
  //            matters.
  //
  //  Withdrawing does NOT remove. The row stays and says "Withdrawn", so a
  //  customer who opens that link is told it was withdrawn rather than that
  //  they may have mistyped it. Removing it is the separate, deliberate act
  //  underneath, and the database enforces that order (p_message_invite_forget
  //  refuses a link that is still open).
  async function renderInviteList() {
    var box = document.getElementById("pmInvList");
    if (!box) return;
    var rows;
    try {
      rows = await window.PMStore.invitesMine(50);
    } catch (_) { box.innerHTML = ""; return; }
    if (!rows.length) { box.innerHTML = ""; return; }

    var live = rows.filter(function (r) { return r.state === "open"; });
    var done = rows.filter(function (r) { return r.state !== "open"; });

    box.innerHTML =
      '<div class="pm-inv-head">' +
        '<h3 class="pm-inv-h">' + esc(t("pm_inv_yours", "Your links")) + "</h3>" +
        (done.length
          ? '<button type="button" class="pm-link" data-inv-clear>' +
            esc(t("pm_inv_clear", "Clear finished")) + "</button>"
          : "") +
      "</div>" +
      (live.length
        ? live.map(inviteRow).join("")
        : '<p class="pm-inv-none">' + esc(t("pm_inv_no_live",
            "No links are waiting to be opened.")) + "</p>") +
      (done.length
        ? '<div class="pm-inv-done"><span class="pm-inv-sec">' +
          esc(t("pm_inv_finished", "Finished")) + "</span>" +
          done.map(inviteRow).join("") + "</div>"
        : "");
  }

  /**
   * One link. The state is a word, and beside it the fact that word implies:
   * how long an open one has left, who used a used one, when a dead one died.
   * "OPEN" on its own says nothing an agent can act on.
   */
  function inviteRow(r) {
    var live = r.state === "open";
    var when = live ? daysLeft(r.expires_at) : agoWords(r.created_at);
    return '<div class="pm-inv-row' + (live ? " is-live" : "") + '">' +
      '<span class="pm-inv-tx">' +
        '<span class="pm-inv-label">' +
          esc(r.label || r.guest_name || t("pm_inv_nolabel", "(no note)")) + "</span>" +
        '<span class="pm-inv-meta">' +
          '<span class="pm-badge' + (r.state === "used" ? " ok" : live ? "" : " off") + '">' +
            esc(t("pm_inv_" + r.state, r.state)) + "</span>" +
          (r.guest_name && r.label
            ? '<span class="pm-inv-who">' + esc(r.guest_name) + "</span>" : "") +
          (when ? '<span class="pm-inv-when">' + esc(when) + "</span>" : "") +
        "</span>" +
      "</span>" +
      (live
        ? '<button type="button" class="pm-btn danger pm-inv-act" data-revoke="' + esc(r.token_hash) + '">' +
          esc(t("pm_inv_revoke", "Withdraw")) + "</button>"
        // A finished link is clutter, not danger, so removing it is an icon
        // and not a red button competing with the one above it.
        : '<button type="button" class="pm-inv-x" data-forget="' + esc(r.token_hash) + '" ' +
          'aria-label="' + esc(t("pm_inv_forget", "Remove from this list")) + '" ' +
          'title="' + esc(t("pm_inv_forget", "Remove from this list")) + '">' +
          '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" ' +
          'stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>') +
      "</div>";
  }

  /** "12 days left", or "expires today". Never a date: this is a countdown. */
  function daysLeft(iso) {
    if (!iso) return "";
    var ms = new Date(iso).getTime() - Date.now();
    if (isNaN(ms)) return "";
    var days = Math.floor(ms / 86400000);
    if (days <= 0) return t("pm_inv_today", "expires today");
    if (days === 1) return t("pm_inv_1day", "1 day left");
    return t("pm_inv_days", "{n} days left", { n: days });
  }

  /** "3 days ago". Coarse on purpose: nothing here turns on the hour. */
  function agoWords(iso) {
    if (!iso) return "";
    var ms = Date.now() - new Date(iso).getTime();
    if (isNaN(ms)) return "";
    var days = Math.floor(ms / 86400000);
    if (days <= 0) return t("pm_inv_ago_today", "today");
    if (days === 1) return t("pm_inv_ago_1day", "yesterday");
    return t("pm_inv_ago_days", "{n} days ago", { n: days });
  }

  // Delegated from #pmInvList, which outlives every row inside it.
  async function onInviteListClick(e) {
    var revoke = e.target.closest("[data-revoke]");
    if (revoke) return askRevoke(revoke);
    var forget = e.target.closest("[data-forget]");
    if (forget) return doForget(forget);
    var clear = e.target.closest("[data-inv-clear]");
    if (clear) return askClear(clear);
  }

  /**
   * Withdrawing is destructive and irreversible, so it is confirmed, and the
   * confirmation is IN the dialog.
   *
   * window.confirm() was doing this job, which meant an untranslated system
   * box in whatever language the phone is set to, on top of a screen that has
   * been careful to be in two. It also cannot say what it is about to affect,
   * so "Withdraw this link?" was the whole warning for an act that can cut off
   * somebody who is holding it.
   */
  function askRevoke(btn) {
    var row = btn.closest(".pm-inv-row");
    var name = row ? row.querySelector(".pm-inv-label").textContent : "";
    confirmInRow(row, t("pm_inv_revoke_q2",
      "Withdraw the link for {who}? Anybody holding it will no longer be able to open it.", { who: name }),
      t("pm_inv_revoke", "Withdraw"), async function (say) {
        try {
          await window.PMStore.inviteRevoke(btn.dataset.revoke);
          await renderInviteList();
        } catch (err) { say((err && err.message) || String(err)); }
      });
  }

  /**
   * Removing a finished link is not confirmed. Nothing can go wrong: the link
   * is already dead, the row is a note to the agent about it, and a
   * confirmation for an act with no consequence trains people to tap through
   * the ones that have.
   */
  async function doForget(btn) {
    btn.disabled = true;
    try {
      await window.PMStore.inviteForget(btn.dataset.forget);
      await renderInviteList();
    } catch (err) {
      btn.disabled = false;
      var out = document.getElementById("pmInvMsg");
      if (out) { out.className = "pm-msg-out bad"; out.textContent = (err && err.message) || String(err); }
    }
  }

  function askClear(btn) {
    var host = btn.closest(".pm-inv-head");
    confirmInRow(host, t("pm_inv_clear_q",
      "Remove every finished link from this list? The links themselves are already dead, so nothing changes for anybody holding one."),
      t("pm_inv_clear_go", "Remove them"), async function (say) {
        try {
          await window.PMStore.invitesClearFinished();
          await renderInviteList();
        } catch (err) { say((err && err.message) || String(err)); }
      });
  }

  /**
   * A confirmation that replaces the row it is about, rather than covering the
   * whole screen. The thing being decided stays visible, which is most of what
   * a confirmation is for.
   *
   * The callback is handed a `say` for reporting a failure, because by the
   * time it runs the strip has already gone and there is nowhere else for a
   * message to land.
   */
  function confirmInRow(anchor, question, goLabel, run) {
    if (!anchor) return;
    var strip = document.createElement("div");
    strip.className = "pm-inv-ask";
    strip.innerHTML = '<span>' + esc(question) + "</span>" +
      '<span class="pm-inv-ask-acts">' +
        '<button type="button" class="pm-btn danger" data-ask="go">' + esc(goLabel) + "</button>" +
        '<button type="button" class="pm-btn ghost" data-ask="no">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
      "</span>";
    anchor.insertAdjacentElement("afterend", strip);
    anchor.hidden = true;

    strip.addEventListener("click", async function (e) {
      var b = e.target.closest("[data-ask]");
      if (!b) return;
      if (b.dataset.ask === "no") { anchor.hidden = false; strip.remove(); return; }
      strip.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
      await run(function (msg) {
        var out = document.getElementById("pmInvMsg");
        if (out) { out.className = "pm-msg-out bad"; out.textContent = msg; }
        if (anchor.isConnected) anchor.hidden = false;
        strip.remove();
      });
    });
  }
  window.PMInviteUI = {
    attach: attach,
    open: showInvite,
    expiryWords: inviteExpiryWords,
    // The page's backdrop handler needs to know a link is mid-hand-off, so it
    // can refuse to close over the one screen that holds an unrecoverable
    // token. A getter, not the value: invMade changes under it.
    pending: function () { return invMade; },
  };
})();
