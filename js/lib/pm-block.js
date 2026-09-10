// ============================================================================
//  pm-block.js — the way out, now that anybody can gather and advertise.
// ============================================================================
//  Rooms and announcements used to be one admin's to send. They belong to
//  every account now, which is the point of the work this file is part of, and
//  which is also why this file has to exist: a feature that lets people reach
//  each other without a way to stop being reached is only half a feature.
//
//  WHAT A BLOCK DOES
//    · they cannot add you to a room
//    · they cannot include you in an announcement
//    · they cannot start a new conversation with you
//  All three are enforced in the database, inside the SECURITY DEFINER
//  functions, not here. This module is a door onto a lock that already works.
//
//  WHAT IT DOES NOT DO, and the dialog says all of it out loud:
//    · it does not un-deliver what has already arrived
//    · it does not take either of you out of a room you already share
//    · it does not delete this conversation. That is a separate act with a
//      separate button, and pretending otherwise would be the kind of lie
//      about a safety control that gets acted on
//    · the other person is not told
//
//  A block that quietly does less than people assume is worse than no block,
//  so the limits are in the confirm dialog rather than in a help page.
//
//  ASYMMETRY IS DELIBERATE. pm_blocks_mine() returns who YOU blocked. There is
//  no call anywhere that answers "who blocked me", because that is the one
//  question a block exists in order not to answer, and because knowing invites
//  the reply that the block was there to prevent.
// ============================================================================
(function () {
  "use strict";

  var t = function (k, f) { return f || k; };
  var esc = function (s) { return String(s == null ? "" : s); };
  var modal = null, closeModal = null, after = null;

  /**
   * Hand in the page's own helpers. Same shape pm-identity-ui.js uses, so
   * this module carries no second copy of t(), esc() or the modal.
   * `after` is called once a block lands, so the list can be redrawn.
   */
  function attach(o) {
    o = o || {};
    if (o.t) t = o.t;
    if (o.esc) esc = o.esc;
    if (o.modal) modal = o.modal;
    if (o.closeModal) closeModal = o.closeModal;
    if (o.after) after = o.after;
  }

  /** Confirm, then block. `userId` is who; `name` is only for the heading. */
  function ask(userId, name) {
    if (!modal) return;
    modal("<h2>" + esc(t("pm_block_t", "Block this person?")) + "</h2>" +
      '<p class="pm-modal-quote">' + esc(name || t("pm_someone", "Someone")) + "</p>" +
      "<p>" + esc(t("pm_block_does",
        "They will not be able to add you to a room, include you in an announcement, or start a new conversation with you.")) + "</p>" +
      '<p class="pm-note">' + esc(t("pm_block_not",
        "It does not delete this conversation and it does not reach messages already on either phone. It does not take either of you out of a room you are both already in. They are not told.")) + "</p>" +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn ghost" id="pmBlNo">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
        '<button class="pm-btn is-danger" id="pmBlYes">' + esc(t("pm_block_go", "Block them")) + "</button>" +
      "</div><div class=\"pm-msg-out\" id=\"pmBlMsg\"></div>");

    document.getElementById("pmBlNo").addEventListener("click", closeModal);
    document.getElementById("pmBlYes").addEventListener("click", async function (e) {
      var btn = e.currentTarget;        // captured, never read after an await
      var out = document.getElementById("pmBlMsg");
      btn.disabled = true;
      try {
        await window.PMStore.blockAdd(userId);
        closeModal();
        if (after) after(t("pm_block_ok", "Blocked. They cannot reach you with anything new."));
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
        btn.disabled = false;
      }
    });
  }

  /** Everybody you have blocked, with a way back. Reached from Profile. */
  async function list() {
    if (!modal) return;
    modal("<h2>" + esc(t("pm_blocked_t", "People you blocked")) + "</h2>" +
      '<div id="pmBlList"><div class="pm-empty">' + esc(t("pm_loading", "Loading…")) + "</div></div>" +
      '<div class="pm-modal-acts"><button class="pm-btn ghost" id="pmBlX">' +
        esc(t("pm_close", "Close")) + "</button></div>" +
      '<div class="pm-msg-out" id="pmBlLMsg"></div>');
    document.getElementById("pmBlX").addEventListener("click", closeModal);

    var box = document.getElementById("pmBlList");
    var rows = [];
    try { rows = await window.PMStore.blocksMine(); }
    catch (err) {
      box.innerHTML = '<div class="pm-empty">' + esc((err && err.message) || String(err)) + "</div>";
      return;
    }
    draw(rows);

    function draw(list_) {
      if (!list_.length) {
        box.innerHTML = '<div class="pm-empty">' +
          esc(t("pm_blocked_none", "You have not blocked anybody.")) + "</div>";
        return;
      }
      box.innerHTML = list_.map(function (r) {
        return '<div class="pm-mem"><span class="pm-mem-tx"><span class="pm-mem-nm">' +
          esc(r.display_name || r.user_id) + "</span>" +
          (r.region ? '<span class="pm-sub">' + esc(r.region) + "</span>" : "") +
          '</span><button class="pm-btn ghost" type="button" data-unblock="' + esc(r.user_id) + '">' +
          esc(t("pm_unblock", "Unblock")) + "</button></div>";
      }).join("");
    }

    // Bound once on the container, not per row: the list is rewritten in place
    // on every unblock, so a listener per button would accumulate.
    box.addEventListener("click", async function (e) {
      var b = e.target.closest ? e.target.closest("[data-unblock]") : null;
      if (!b) return;
      b.disabled = true;
      var out = document.getElementById("pmBlLMsg");
      try {
        await window.PMStore.blockRemove(b.dataset.unblock);
        rows = rows.filter(function (r) { return r.user_id !== b.dataset.unblock; });
        draw(rows);
      } catch (err) {
        b.disabled = false;
        if (out) { out.className = "pm-msg-out bad"; out.textContent = (err && err.message) || String(err); }
      }
    });
  }

  window.PMBlock = { attach: attach, ask: ask, list: list };
})();
