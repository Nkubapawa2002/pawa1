// ============================================================================
//  pm-invite-card.js — an invite link, sent inside an encrypted message.
//
//  THE PROBLEM
//  Making an invite link was never the hard part. Delivering it was, and every
//  one of the five routes on the hand-off step leaves the app: WhatsApp, SMS,
//  the share sheet, the clipboard, a QR code for a camera. There is nothing
//  wrong with any of them — an invite exists to reach somebody who is not here
//  yet, so most of the time it has to leave.
//
//  What was missing is the case where it does NOT: a customer you are already
//  talking to wants to bring their brother, their landlord, their business
//  partner. The link has to travel down the conversation the two of you are
//  already having, and it could not. So it went out through WhatsApp and came
//  back in as a screenshot.
//
//  SAME WIRE FORMAT AS A PLACE, FOR THE SAME REASONS
//  An invite message is an ordinary message whose body carries the link as
//  text. No marker character, no version tag, no attachment table:
//
//   1. **It is already encrypted.** The token is in the message BODY, sealed
//      exactly as the words are. A bearer credential in a side table would have
//      put the one thing that must stay private in the clear.
//   2. **Every reader understands it**, including an older build and including
//      somebody who copies the message into WhatsApp. A card is a nicer way to
//      read the link, never the only way.
//   3. **The link is the link.** read() finds the same URL the QR code encodes
//      and the clipboard copies, so a link pasted in by hand lands on the same
//      card by the same code path.
//
//  THE ONE RULE THAT IS SECURITY AND NOT PRESENTATION
//  Message bodies in this app are escaped and deliberately NOT linkified. That
//  is not an oversight: turning arbitrary text into tappable links inside an
//  encrypted chat is a phishing surface, and the person reading has no way to
//  tell a real invite from a lookalike domain rendered in the same blue.
//
//  So this file does not linkify anything. It recognises exactly one shape:
//  an invite link on THIS APP'S OWN ORIGIN. A message carrying
//  https://not-us.example/p-message.html?i=… is left as plain escaped text,
//  where a person can read the domain and decide for themselves. isOurs()
//  below is the whole of that check and must not be relaxed into a hostname
//  substring test, which is what makes maisha-na-lifeza.attacker.com work.
//
//  WHAT THIS FILE DOES NOT DO
//  It does not create invites, does not accept them, and does not touch the
//  network. js/lib/pm-store.js mints the token and only ever sends its hash;
//  js/pages/p-message.js handles ?i= on arrival. This composes, it reads, and
//  it renders one card.
// ============================================================================
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function t(key, fallback, vars) {
    var s = (window.t && window.t(key)) || fallback;
    if (s === key) s = fallback;
    if (vars) Object.keys(vars).forEach(function (k) {
      s = String(s).replace("{" + k + "}", vars[k]);
    });
    return s;
  }

  /**
   * Is this URL an invite on our own origin?
   *
   * Parsed with the URL constructor against location.href, never matched with
   * a regex over the string. `https://evil.example/?x=https://our.site/p-message.html?i=T`
   * contains our origin as a substring and is not our origin; only a parser
   * knows the difference.
   */
  function isOurs(url) {
    var u;
    try { u = new URL(url, window.location.href); } catch (_) { return false; }
    if (u.origin !== window.location.origin) return false;
    // The path must actually be the invite page. A token on any other page of
    // ours is not an invite and must not be dressed as one.
    if (!/(^|\/)p-message\.html$/i.test(u.pathname)) return false;
    var tok = u.searchParams.get("i");
    return tok && tok.length >= 8 ? { url: u.href, token: tok } : false;
  }

  // Base64url, which is what pm-store.js produces from 32 random bytes. Kept
  // permissive on length: the token format is that file's business, and a
  // reader that insisted on exactly 43 characters would stop drawing cards the
  // day it changed.
  var LINK_RE = /https?:\/\/[^\s<>"']+/gi;

  /**
   * Compose the body of an invite message.
   *
   * `note` goes FIRST for the same reason it does on a place message: the
   * sentence a person wrote is what another person reads, and the credential is
   * what the machine reads. A card that led with a 43-character token would
   * bury the only line written by a human.
   */
  function compose(link, note) {
    if (!link) return "";
    var head = String(note == null ? "" : note).trim();
    var lines = [];
    if (head) lines.push(head);
    else lines.push(t("pmi_body", "Here is a private, encrypted link to chat on Maisha na Lifeza. It works once, and you do not need an account."));
    lines.push(String(link));
    return lines.join("\n");
  }

  /** The invite in this body, or null. */
  function read(body) {
    var text = String(body == null ? "" : body);
    var m = text.match(LINK_RE);
    if (!m) return null;
    for (var i = 0; i < m.length; i++) {
      // Trailing punctuation is part of the sentence, not of the URL.
      var raw = m[i].replace(/[.,;:)\]]+$/, "");
      var hit = isOurs(raw);
      if (hit) return { url: hit.url, token: hit.token, note: noteIn(text) };
    }
    return null;
  }

  /**
   * The human line: what is left once the link is gone.
   *
   * Not "the first line". Somebody may have written two sentences before
   * pasting, and a message that is nothing but a link has no note at all rather
   * than a fabricated one.
   */
  function noteIn(text) {
    var out = String(text).replace(LINK_RE, " ").replace(/\s+/g, " ").trim();
    return out.slice(0, 200);
  }

  /** Cheap enough to run per message. */
  function has(body) { return !!read(body); }

  /** Strip the link so the card is not printed twice under its own words. */
  function stripped(body) { return noteIn(body); }

  var KEY_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M15.5 9.5a4 4 0 1 1-3.9-4l6.9-4 2 3.4-1.7 1 1.2 2-2 1.2-1.2-2-1.6 1z" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';

  /**
   * The card drawn inside a message bubble.
   *
   * `mine` decides which of two true sentences is shown, and they are two
   * different situations for the reader. On the sending side it is a record of
   * something handed over. On the receiving side it is a live credential with
   * a warning attached: whoever opens it first becomes the customer in that
   * conversation, which is inherent to links and cannot be fixed, so it is
   * said out loud rather than discovered.
   */
  function card(inv, opts) {
    var o = opts || {};
    return '<span class="pm-inv-card">' +
      '<span class="pm-inv-card-h">' + KEY_SVG +
        "<b>" + esc(t("pmi_title", "An invitation to talk here")) + "</b></span>" +
      '<span class="pm-inv-card-d">' + esc(o.mine
        ? t("pmi_sent", "You sent this link. Whoever opens it first becomes the person in that conversation.")
        : t("pmi_got", "Opening this starts a private, encrypted conversation. It works once, and it does not need an account.")) +
      "</span>" +
      '<span class="pm-inv-card-acts">' +
        (o.mine ? ""
          : '<a class="pm-inv-card-b is-go" href="' + esc(inv.url) + '">' +
              esc(t("pmi_open", "Open the invitation")) + "</a>") +
        '<button class="pm-inv-card-b" type="button" data-inv-copy="' + esc(inv.url) + '">' +
          esc(t("pmi_copy", "Copy the link")) + "</button>" +
      "</span></span>";
  }

  window.PMInviteCard = {
    compose: compose,
    read: read,
    has: has,
    stripped: stripped,
    card: card,
    isOurs: isOurs,
  };
})();
