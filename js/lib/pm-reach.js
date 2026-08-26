// ============================================================================
//  pm-reach.js — "message the person who posted this", from any listing.
//
//  WHY THIS EXISTS
//  Every catalogue page ends the same way: a phone number and a WhatsApp
//  button. Both work, and both cost the person doing the asking something.
//  Calling a stranger about a room means handing them your number before you
//  know whether the room is still free; WhatsApp means the same number plus
//  whatever your profile photo says about you. For a seeker comparing nine
//  rooms that is nine strangers holding their number, and it is the single
//  most common reason people stop enquiring.
//
//  P-Message already solves this: an end-to-end encrypted thread that carries
//  no phone number in either direction, and that a guest can open without an
//  account (see js/lib/pm-store.js). The day-jobs board has offered it since
//  day_jobs learned who posted a job. Houses, trucks and services all knew the
//  same fact — owner_user_id is on every row and readable by anyone browsing —
//  and none of them offered the door.
//
//  WHAT THIS FILE IS, AND WHY IT IS A FILE
//  One link. The link itself is trivial; what is worth having in one place is
//  the set of decisions around it, because four catalogues making them
//  separately is four chances to make them differently:
//
//    * the URL shape (`p-message.html?to=<user id>`, and NOTHING else — the
//      name, the region and the key all come from pm_peer, so a listing
//      cannot put a borrowed name on the conversation header),
//    * the guard: a listing with no owner recorded gets no button at all
//      rather than a dead one,
//    * the word used, in both languages,
//    * and the honest sub-label, which is the whole reason a seeker picks
//      this over the phone button next to it.
//
//  WHAT IT DELIBERATELY DOES NOT DO
//  It does not check whether the owner has ever opened P-Message. That answer
//  lives behind a key lookup, and asking for it on every card would put a
//  round trip in front of a button that is usually fine. p-message.js already
//  handles the miss properly — it says, in the reader's language, that this
//  person has no key yet and that their listings still carry a number. A
//  spinner here would buy nothing and cost a request per listing.
//
//  It also does not hide the button on your own listing. p-message.js sends
//  `?to=<yourself>` to the inbox, which is a page that works.
// ============================================================================
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function t(key, fallback) {
    var s = (window.t && window.t(key)) || fallback;
    return (!s || s === key) ? fallback : s;
  }

  /** The owner id a catalogue row carries, or "" if it carries none. */
  function ownerOf(row) {
    if (!row || typeof row !== "object") return "";
    return String(row.owner_user_id || row.user_id || "").trim();
  }

  /** `p-message.html?to=<id>`, or "" when there is nobody to open it with. */
  function href(ownerId) {
    var id = String(ownerId == null ? "" : ownerId).trim();
    return id ? "p-message.html?to=" + encodeURIComponent(id) : "";
  }

  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="16" height="16">' +
    '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l2-4.9A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/>' +
    '</svg>';

  /**
   * The button, as HTML.
   *
   * `className` is the caller's, because each detail page styles its own CTA
   * row and a shared class would need a shared stylesheet none of them link.
   * `sub` defaults on: "no phone number needed" is the reason to tap it, and a
   * button that does not say why it is different from the green one beside it
   * is just a third button.
   */
  function button(row, opts) {
    var o = opts || {};
    var id = typeof row === "string" ? row : ownerOf(row);
    var url = href(id);
    if (!url) return "";
    return '<a class="' + esc(o.className || "pmr-btn") + '" href="' + esc(url) + '"' +
      (o.dataTo === false ? "" : ' data-pm-to="' + esc(id) + '"') + ">" +
      (o.icon === false ? "" : ICON) +
      "<span>" + esc(o.label || t("pm_reach", "Message")) + "</span>" +
      (o.sub === false ? ""
        : '<small>' + esc(t("pm_reach_sub", "encrypted — no phone number needed")) + "</small>") +
      "</a>";
  }

  window.PMReach = {
    ownerOf: ownerOf,
    href: href,
    button: button,
  };
})();
