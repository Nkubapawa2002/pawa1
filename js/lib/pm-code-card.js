// ============================================================================
//  pm-code-card.js — a place, sent as a sealed code, inside an encrypted message.
// ============================================================================
//  WHY THIS EXISTS AT ALL
//  share-location.html used to hand a place over by building
//
//      https://www.google.com/maps/search/?api=1&query=-6.812345,39.279876
//
//  and passing it to navigator.share. Two things were wrong with that and only
//  one of them is obvious.
//
//  The obvious one: it leaves the app. Once the sentence is in WhatsApp it is
//  ordinary text in somebody else's client, and every hop can rewrite it.
//
//  The one that matters: THERE IS NOTHING IN THAT LINK TO CHECK. Change two
//  digits and it is still a perfectly valid Google Maps URL pointing somewhere
//  else, and the person opening it has no way to know. That is the whole
//  mechanism of a scam link: not a forged domain, just a number nobody can
//  verify. A landlord sends a doorstep, a middleman edits it, and the customer
//  turns up at a different house believing they were sent there.
//
//  A CODE HAS SOMETHING TO CHECK, THREE TIMES OVER
//  The nine characters are not a pointer to the place, they ARE the key to it
//  (js/lib/loc-code.js):
//
//    · five locator characters, minted server-side through a keyed Feistel
//      bijection, so they cannot be guessed and cannot collide;
//    · three secret characters generated in the sender's browser and never
//      uploaded;
//    · one GF(2^5) parity character over the other eight.
//
//  The coordinates are sealed with AES-256-GCM under a key derived from the
//  whole code, with the handle as additional data, before anything is uploaded.
//  The server stores ciphertext and a peppered hash of the handle. So:
//
//    edit one character  -> the parity fails, or the handle does not resolve;
//    guess a code        -> 32^8 with a server-side rate limit on misses;
//    compel the server   -> it does not hold the code, so it cannot decrypt.
//
//  There is no edit that yields a DIFFERENT VALID PLACE. It fails closed. That
//  is the property a map URL never had and the reason this is the only shape
//  P-Chat is allowed to hand out.
//
//  SAME WIRE FORMAT AS A PIN AND AN INVITE, FOR THE SAME REASONS
//  The body of the message carries the code as text. No marker character, no
//  version tag, no side table:
//
//   1. **It is already encrypted.** The code is the decryption key for the
//      place, and it sits in the message BODY, sealed exactly as the words are.
//      In a side table it would be the one thing in this feature stored in the
//      clear.
//   2. **Every reader understands it.** An older build, a copy-paste, somebody
//      reading the message aloud down a phone: all of them still work, because
//      nine characters a person can say is the fallback. A card is a nicer way
//      to use the code, never the only way.
//   3. **A code typed by hand lands on the same card**, through the same
//      parser, because there is nothing else to be.
//
//  WHY THIS NEEDS NO SAME-ORIGIN CHECK, unlike pm-invite-card.js and
//  pm-listing-card.js. Those two recognise a URL, so they must prove the URL is
//  ours or they become a phishing surface. This recognises nine characters
//  against a parity function. There is no origin to spoof, no domain to
//  misread, and nothing tappable that could go anywhere but LocShare.open().
//  That is the point of using a code rather than a link.
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

  // Nine characters of the alphabet, in up to three dash- or space-separated
  // groups, not glued to a longer word. The word boundaries matter: without
  // them the tail of a wallet address or a booking reference would be read as a
  // code, drawn as a card, and fail to open for a reason nobody could see.
  //
  // Crockford's alphabet has no I, L, O or U, but a PERSON writing a code down
  // does use O and I, so those are matched here and folded to 0 and 1 by
  // LocCode.normalize() exactly as the input box does it. U is not in the
  // alphabet and is not accepted.
  var CODE_RE = /(?:^|[\s(>])([0-9A-HJ-NP-TV-Zoil][0-9A-HJ-NP-TV-Zoil]{2}[\s-]?[0-9A-HJ-NP-TV-Zoil]{3}[\s-]?[0-9A-HJ-NP-TV-Zoil]{3})(?=$|[\s.,;:)<])/gi;

  /**
   * The code in this body, or null.
   *
   * VALIDATED, NOT JUST MATCHED. LocCode.problem() checks the length, the
   * alphabet and the parity character, so a nine-character word that happens to
   * sit in a sentence is rejected here rather than becoming a card that cannot
   * open. One in thirty-two random strings passes parity, which is why the
   * word-boundary rule above carries as much weight as this does.
   */
  function read(body) {
    if (!window.LocCode) return null;
    var text = String(body == null ? "" : body);
    var m, hit = null;
    CODE_RE.lastIndex = 0;
    while ((m = CODE_RE.exec(text)) !== null) {
      var norm = window.LocCode.normalize(m[1]);
      if (norm.length !== window.LocCode.CODE_LEN) continue;
      if (window.LocCode.problem(norm)) continue;
      hit = { code: norm, pretty: window.LocCode.format(norm), raw: m[1] };
      break;
    }
    if (!hit) return null;
    hit.note = noteIn(text, hit.raw);
    return hit;
  }

  /**
   * Compose the body of a message carrying a code.
   *
   * The note goes FIRST, for the reason it does on a pin and an invite: the
   * sentence is the half a person wrote and the half another person reads.
   * "The blue gate, not the green one" is worth more than the coordinates it
   * arrives with, and a body that led with nine characters would bury it.
   */
  function compose(ref, note) {
    if (!ref || !ref.code) return String(note == null ? "" : note);
    var head = String(note == null ? "" : note).trim();
    var lines = [];
    if (head) lines.push(head);
    else lines.push(t("pmc_body", "Here is the place, as a code. Open it in P-Message and the pin appears on a map."));
    lines.push(window.LocCode ? window.LocCode.format(ref.code) : ref.code);
    return lines.join("\n");
  }

  /**
   * The human line: what is left once the code is gone.
   *
   * Only the matched code is removed, not every nine-character run, or a
   * message that mentioned a second code in passing would lose it from the
   * words as well as from the card.
   */
  function noteIn(text, raw) {
    var out = String(text);
    if (raw) out = out.split(raw).join(" ");
    return out.replace(/\s+/g, " ").trim().slice(0, 200);
  }

  /** Strip the code so the card is not printed twice under its own words. */
  function stripped(body) {
    var hit = read(body);
    return hit ? hit.note : String(body == null ? "" : body);
  }

  function has(body) { return !!read(body); }

  var PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z" stroke="currentColor" stroke-width="1.8"/>' +
    '<circle cx="12" cy="10" r="2.3" stroke="currentColor" stroke-width="1.8"/></svg>';

  /**
   * The card drawn inside a message bubble.
   *
   * TWO DIFFERENT SENTENCES, because the two sides are in different positions
   * and one of them has a decision to make. The sender is looking at a record
   * of something handed over, and at a code that is spent when it is opened.
   * The reader is holding a live, limited credential: it opens a set number of
   * times and then it is gone, so that is said out loud here rather than
   * discovered on the second tap.
   *
   * The code is PRINTED on the card, in both directions, and that is
   * deliberate: it is the fallback that works when everything else does not.
   * Somebody on a bad connection can read it down a phone; somebody whose
   * account is a guest session, which LocShare.open() refuses, can at least see
   * what they were sent rather than a dead button.
   */
  function card(ref, opts) {
    var o = opts || {};
    return '<span class="pm-code-card">' +
      '<span class="pm-code-card-h">' + PIN_SVG +
        "<b>" + esc(t("pmc_title", "A place, as a code")) + "</b></span>" +
      '<span class="pm-code-card-c">' + esc(ref.pretty) + "</span>" +
      '<span class="pm-code-card-d">' + esc(o.mine
        ? t("pmc_sent", "You sent this code. It opens a limited number of times, then it stops working.")
        : t("pmc_got", "Open it and the pin appears on a map. It works a limited number of times, so open it when you need it.")) +
      "</span>" +
      '<span class="pm-code-card-acts">' +
        '<button class="pm-code-card-b is-go" type="button" data-code-open="' + esc(ref.code) + '">' +
          esc(t("pmc_open", "Open it")) + "</button>" +
      "</span></span>";
  }

  window.PMCodeCard = {
    compose: compose,
    read: read,
    has: has,
    stripped: stripped,
    card: card,
  };
})();
