// ============================================================================
//  pm-icons.js — the six glyphs P-Message draws, in one place.
//
//  DRAWN, NEVER TYPED, and this is a project-wide rule rather than a P-Message
//  one. A character like a star, a ringed circle or a telephone renders as a
//  full-colour emoji on some phones and as a bare monochrome glyph on others,
//  so the same row looks like two different designs depending on who is
//  holding it. There is no emoji anywhere in this app's interface.
//
//  Lucide-style strokes: they inherit currentColor, so they take the theme and
//  the state of whatever they sit in for free; they scale with the type beside
//  them; and every one is aria-hidden, because the word next to it is what a
//  screen reader should be reading.
//
//  These lived as six `var X_SVG` inside the directory section of
//  p-message.js, which was the wrong home for them the moment the inbox, the
//  conversation and the room roster all started drawing the same three.
// ============================================================================
(function () {
  "use strict";

  window.PMIcons = {
    // An announcement: a speaker, because it is one voice going out.
    cast: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M4 9h3l8-5v16l-8-5H4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' +
      '<path d="M18.5 8.5a5 5 0 0 1 0 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',

    // A room: people, because it is two-way and an announcement is not.
    room: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle cx="9" cy="9" r="3" stroke="currentColor" stroke-width="1.8"/>' +
      '<circle cx="16.5" cy="10.5" r="2.4" stroke="currentColor" stroke-width="1.8"/>' +
      '<path d="M3.5 19a5.5 5.5 0 0 1 11 0M15 19a4.6 4.6 0 0 1 5.5-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',

    // A little open box. NOT a chevron: a chevron means "more of this list",
    // and this one leaves the list entirely.
    box: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="M4 8.5 12 13l8-4.5M12 13v7" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',

    chat: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M20 12a8 8 0 0 1-8 8H5l-1.2 1.2A.5.5 0 0 1 3 20.8V12a8 8 0 1 1 17 0z" ' +
      'stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',

    phone: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M6.5 3.5h3l1.5 4-2 1.4a12 12 0 0 0 6.1 6.1l1.4-2 4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z" ' +
      'stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',

    more: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle cx="5" cy="12" r="1.6" fill="currentColor"/>' +
      '<circle cx="12" cy="12" r="1.6" fill="currentColor"/>' +
      '<circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>',

    // The way out of being reached. A slashed circle rather than a hand or a
    // cross: a cross reads as "close this" and a hand reads as "stop, you may
    // not" -- neither is what a block is, which is "they can no longer start
    // anything new with me".
    block: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="2"/>' +
      '<path d="M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };
})();
