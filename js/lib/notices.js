// ============================================================================
//  notices.js — what the platform has to say to this account about itself.
// ============================================================================
//  Two things arrive from one RPC (supabase/features/agent/agent_notices.sql):
//
//    notices   what an admin DID, or wrote. Approved, deactivated, a payment
//              recorded, a subscription running out, or a message they typed.
//              Written by the database on every change in the tracker, so
//              nothing depends on a panel remembering to send it.
//    billing   the state of the subscription right now, whether or not any row
//              has been written about it yet.
//
//  ONE MODULE, because three surfaces show the same facts and must not be able
//  to disagree about them: the bell on every page (js/core/notify.js), the
//  Profile tab's own list, and the card on an agent dashboard.
//
//  days_left IS NOT COMPUTED HERE. It comes down from the server, because a
//  phone with the wrong date would otherwise tell somebody their cover ends
//  next week when it ended yesterday, and that is the one number this whole
//  feature exists to get right.
//
//  Public API:
//    Notices.load(force)     -> { unread, notices: [...], billing }
//    Notices.markRead(id)    -> true when a row was actually marked
//    Notices.markAll()       -> how many were marked
//    Notices.billingLine(b)  -> one sentence about where the subscription is
//    Notices.severityTint(s) -> the action-card tint class for a severity
// ============================================================================
(function () {
  "use strict";

  var EMPTY = { unread: 0, notices: [], billing: null };
  var cache = null;
  var pending = null;

  function sb() {
    return window.SB || (window.DataStore && window.DataStore.sb) || null;
  }

  function t(key, en, vars) {
    var s = window.t ? window.t(key) : null;
    if (!s || s === key) s = en;
    if (vars) {
      Object.keys(vars).forEach(function (k) { s = s.split("{" + k + "}").join(String(vars[k])); });
    }
    return s;
  }

  /**
   * Read them. Cached, because the bell polls on a two-minute beat and the
   * Profile tab redraws on every tap: without this, opening the language row
   * would cost a round trip to the notices table.
   *
   * Never throws and never rejects. A signed-out visitor, a client that has
   * not loaded, an RPC that is not deployed yet: all of them mean "nothing to
   * say", and a bell that broke the page it rides on would be a worse bug than
   * a quiet one.
   */
  async function load(force) {
    if (cache && !force) return cache;
    if (pending && !force) return pending;
    var c = sb();
    if (!c) return EMPTY;
    pending = (async function () {
      try {
        var res = await c.rpc("my_notices");
        if (res.error || !res.data) return EMPTY;
        cache = {
          unread: Number(res.data.unread) || 0,
          notices: Array.isArray(res.data.notices) ? res.data.notices : [],
          billing: res.data.billing || null,
        };
        return cache;
      } catch (_) {
        return EMPTY;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  async function markRead(id) {
    var c = sb();
    if (!c || !id) return false;
    try {
      var res = await c.rpc("notice_mark_read", { p_id: id });
      if (res.error) return false;
      if (cache) {
        cache.notices = cache.notices.filter(function (n) { return n.id !== id; });
        cache.unread = Math.max(0, cache.unread - 1);
      }
      return !!res.data;
    } catch (_) { return false; }
  }

  async function markAll() {
    var c = sb();
    if (!c) return 0;
    try {
      var res = await c.rpc("notices_mark_all_read");
      if (res.error) return 0;
      if (cache) { cache.notices = []; cache.unread = 0; }
      return Number(res.data) || 0;
    } catch (_) { return 0; }
  }

  /**
   * Where the subscription stands, in one sentence.
   *
   * Each state gets its own line rather than a template with a number in it,
   * because they are not variations on one another: "ends in 5 days" is a
   * reminder, "paused" means the listings have already left the board, and
   * telling somebody the wrong one of those is worse than saying nothing.
   */
  function billingLine(b) {
    if (!b) return "";
    var d = (b.days_left === null || b.days_left === undefined) ? null : Number(b.days_left);
    switch (b.reason) {
      case "deactivated":
        return t("nb_b_dead", "An admin has paused this account. Your listings are off the board until it is sorted out.");
      case "cancelled":
        return t("nb_b_cancelled", "This subscription is cancelled. Your listings are off the board.");
      case "overdue":
        return t("nb_b_overdue", "This subscription is overdue. Your listings are off the board until it is settled.");
      case "expired":
        return t("nb_b_expired", "Your subscription has run out, so your listings are off the board.");
      case "approval_expired":
        return t("nb_b_approval", "An admin has to approve this account before your listings go back on the board.");
      case "preview":
        return t("nb_b_preview", "Your listings are live while an admin looks at the account.");
      case "active":
        if (d === null) return t("nb_b_active", "Your listings are live.");
        if (d <= 0) return t("nb_b_today", "Your subscription ends today. Pay the admin to keep your listings on the board.");
        if (d === 1) return t("nb_b_tomorrow", "Your subscription ends tomorrow. Pay the admin to keep your listings on the board.");
        if (d <= 7) return t("nb_b_soon", "Your subscription ends in {n} days. Pay the admin before then.", { n: d });
        return t("nb_b_until", "Your subscription runs to {date}.", { date: dateWord(b.paid_until) });
      default:
        return "";
    }
  }

  /** A date a person reads, in whichever language they are in. */
  function dateWord(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try {
      return d.toLocaleDateString((window.getLang && window.getLang()) === "sw" ? "sw-TZ" : "en-GB",
        { day: "numeric", month: "short", year: "numeric" });
    } catch (_) { return String(iso); }
  }

  /**
   * Is this state worth interrupting somebody about?
   *
   * The same question js/core/notify.js asks for the bell, answered in one
   * place so a Profile tab that says "all good" can never sit under a bell
   * that says otherwise.
   */
  function needsAttention(b) {
    if (!b) return false;
    if (b.reason === "preview" || b.reason === "none") return false;
    if (b.reason !== "active") return true;
    var d = (b.days_left === null || b.days_left === undefined) ? null : Number(b.days_left);
    return d !== null && d <= 7;
  }

  function severityTint(s) {
    return s === "urgent" ? "ic-rose" : s === "warn" ? "ic-gold" : "ic-sky";
  }

  window.Notices = {
    load: load,
    markRead: markRead,
    markAll: markAll,
    billingLine: billingLine,
    needsAttention: needsAttention,
    severityTint: severityTint,
    dateWord: dateWord,
    clearCache: function () { cache = null; },
  };
})();
