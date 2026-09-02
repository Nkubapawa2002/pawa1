// ============================================================================
//  owner-account.js — the landlord who is not an agent, on the client side.
// ============================================================================
//  There are four doors into this app (js/lib/login-doors.js) and one of them
//  is marked VIP: a house owner listing their own property, with no agent in
//  between and no monthly agent fee. The database half of that promise is
//  supabase/features/house/house_owner_accounts.sql. This is the half people
//  see, and it is one file because four screens draw the same two things:
//
//    the badge    on a card, on the home feed, on the listing itself. One
//                 renderer, so "from the owner" cannot mean one thing on the
//                 home page and something subtly different in the directory.
//    the ceiling  three posts every 180 days. The account page has to say
//                 where an owner stands BEFORE they fill in a form, because a
//                 refusal after twenty minutes of typing is not a rule, it is
//                 an ambush.
//
//  THE NUMBERS ARE NEVER WRITTEN HERE. `limit` and `window_days` come down
//  from owner_post_quota(), which reads the same two functions the trigger
//  reads. A constant copied into JavaScript is a sentence that goes on saying
//  "three" for a month after the rule became two.
//
//  AND THE BADGE IS NEVER INFERRED. It is `posted_by_owner` on the row, set by
//  a trigger at insert and pinned on update, so nothing on this side has to
//  guess from an account id, a missing agent name or a zero fee.
// ============================================================================
(function () {
  "use strict";

  function sb() {
    return window.SB || (window.DataStore && window.DataStore.sb) || null;
  }

  function t(key, en, vars) {
    var s = (window.t ? window.t(key) : null);
    if (!s || s === key) s = en;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.split("{" + k + "}").join(String(vars[k]));
      });
    }
    return s;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // A key, drawn rather than typed. No emoji anywhere in this app: a picture
  // glyph renders as a different drawing on every phone and ignores the theme
  // it is sitting in. This one takes currentColor and scales with the type.
  var KEY_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M17 6l2.5 2.5M14.5 8.5 17 11"/></svg>';

  /** Is this listing row one the owner posted themselves? */
  function isOwnerListing(row) {
    return !!(row && (row.posted_by_owner === true || row.postedByOwner === true));
  }

  /**
   * The badge, in one place.
   *
   * `size` is "sm" on a photo card, where it sits beside the Verified chip and
   * must not push it off a 390px screen, and "md" everywhere it stands alone.
   */
  function chip(opts) {
    var o = opts || {};
    return '<span class="owner-chip' + (o.size === "sm" ? " is-sm" : "") +
      (o.className ? " " + o.className : "") + '">' + KEY_SVG +
      "<span>" + esc(t("own_chip", "From the owner")) + "</span></span>";
  }

  /**
   * What this account is allowed to post, straight from the database.
   *
   * Returns null rather than throwing when nobody is signed in or the RPC is
   * not there yet: every caller draws something optional with it, and a home
   * page that fails to load because an account panel could not be filled in is
   * a worse bug than a missing panel.
   */
  async function quota() {
    var c = sb();
    if (!c) return null;
    try {
      var res = await c.rpc("owner_post_quota");
      if (res.error) return null;
      return res.data || null;
    } catch (_) { return null; }
  }

  /**
   * Record on the SERVER what kind of account this is.
   *
   * The door writes user metadata, which is the account's own to rewrite; this
   * writes the row that decides who pays a fee and who is on an allowance.
   * Called at sign-up and again whenever the account page opens, so an account
   * that predates the table is corrected the first time its owner looks at it.
   *
   * Throws with the database's own sentence, because the refusals are specific
   * ("this account already has an agent page") and a generic message would
   * leave somebody guessing at which of them they hit.
   */
  async function claim(kind) {
    var c = sb();
    if (!c) return null;
    var res = await c.rpc("account_kind_claim", { p_kind: kind });
    if (res.error) throw new Error(res.error.message || String(res.error));
    return res.data || null;
  }

  /**
   * "2 of 3 posts left", or the sentence for an account at its ceiling.
   *
   * One key per number, the way the room dialogs in P-Message do it: "1 posts
   * left" is the kind of thing that makes a screen read as a machine, and
   * Swahili does not inflect this the way English does anyway.
   */
  function leftSentence(q) {
    if (!q) return "";
    var n = Number(q.left || 0), limit = Number(q.limit || 0);
    if (n <= 0) return t("own_left_none", "You have used all {limit} of your posts for now.", { limit: limit });
    if (n === 1) return t("own_left_one", "1 post left of {limit}.", { limit: limit });
    return t("own_left_n", "{n} posts left of {limit}.", { n: n, limit: limit });
  }

  /** "The next one frees up on 4 Mar 2027", or "" when they are not waiting. */
  function nextSentence(q) {
    if (!q || !q.next_free_at) return "";
    var d = new Date(q.next_free_at);
    if (isNaN(d.getTime())) return "";
    var when = d.toLocaleDateString((window.getLang && window.getLang()) === "sw" ? "sw-TZ" : "en-GB",
      { day: "numeric", month: "short", year: "numeric" });
    return t("own_next_free", "The next one frees up on {date}.", { date: when });
  }

  window.OwnerAccount = {
    isOwnerListing: isOwnerListing,
    chip: chip,
    quota: quota,
    claim: claim,
    leftSentence: leftSentence,
    nextSentence: nextSentence,
    KEY_SVG: KEY_SVG,
  };
})();
