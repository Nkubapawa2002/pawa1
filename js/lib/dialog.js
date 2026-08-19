// =====================================================================
// pawaDialog — the four things a modal has to do, in one place
// =====================================================================
// `role="dialog" aria-modal="true"` is a CLAIM. It says: this is the only
// thing on screen, you can get out of it, and your keyboard cannot wander off
// behind it. Nothing enforces that — every sheet in the app has to implement
// it, and every sheet that forgot is a sheet a keyboard user gets stuck in and
// a phone user scrolls the page away underneath.
//
// So it lives here instead, and both the request sheet and the area-alert
// sheet are mounted through it:
//
//   ONE AT A TIME    a double-tapped button (or a deep link that opens a sheet
//                    on a page that already has one) stacks two sheets that
//                    share element ids. The second one wins the id lookups and
//                    the first one is left behind it, still focusable.
//   HELD STILL       the page behind stops scrolling, so a phone doesn't lose
//                    the seeker's place in the feed while they fill a form.
//   A WAY OUT        Escape closes it — on capture, so the sheet answers before
//                    anything on the page does.
//   FOCUS            goes in when it opens and comes back to whatever opened it
//                    when it closes, and Tab cycles inside rather than reaching
//                    the page behind.
//
// Two kinds of sheet, one API. Sheets that are BUILT on demand are removed on
// close; sheets that live in the HTML and are revealed are re-hidden — say
// which with `onClose`:
//
//   pawaDialog.open(el, { onClose: () => el.remove() });          // built
//   pawaDialog.open(el, { onClose: () => { el.hidden = true; } }); // revealed
//   pawaDialog.close(el);          // or el's own close button calls it
//   pawaDialog.isOpen()            // true while any sheet is up
// =====================================================================
(function () {
  "use strict";

  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([type="hidden"]):not([disabled]),' +
    'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  // Only things a person can actually reach: rendered, and not inside a
  // collapsed panel. offsetWidth/Height is the cheap, reliable test.
  function focusables(root) {
    if (!root) return [];
    return Array.prototype.slice.call(root.querySelectorAll(FOCUSABLE))
      .filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement);
  }

  // The sheets currently up, innermost last. Normally 0 or 1 — the stack exists
  // so that a sheet legitimately opened FROM a sheet still restores correctly.
  const stack = [];

  // Drop any entry whose element has left the document. A sheet can disappear
  // without going through close(): something calls .remove() on it directly, a
  // page re-renders the container it lived in, a test tidies up. If the stack
  // kept believing it was open, alreadyOpen() would refuse every dialog from
  // then on and the page behind would stay unscrollable for good — one stray
  // remove() and the app quietly loses all of its sheets.
  function prune() {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (!document.contains(stack[i].el)) {
        const gone = stack.splice(i, 1)[0];
        try { document.removeEventListener("keydown", gone.onKey, true); } catch (_) {}
        if (!stack.length) document.body.style.overflow = gone.prevOverflow || "";
      }
    }
  }

  function isOpen() { prune(); return stack.length > 0; }

  function top() { prune(); return stack.length ? stack[stack.length - 1] : null; }

  function open(el, opts) {
    opts = opts || {};
    if (!el) return false;
    // Already up — put the caller's cursor in it rather than opening a second.
    const live = top();
    if (live && live.el === el) { focusFirst(el); return false; }
    if (live && !opts.stack) { focusFirst(live.el); return false; }

    const entry = {
      el,
      opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      prevOverflow: document.body.style.overflow,
      onClose: typeof opts.onClose === "function" ? opts.onClose : null,
      onKey: null,
    };

    if (opts.labelledBy) el.setAttribute("aria-labelledby", opts.labelledBy);
    document.body.style.overflow = "hidden";

    entry.onKey = (e) => {
      if (top() !== entry) return;                 // only the innermost sheet answers
      if (e.key === "Escape") { e.preventDefault(); close(el); return; }
      if (e.key !== "Tab") return;
      const f = focusables(el);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      const inside = el.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", entry.onKey, true);
    stack.push(entry);
    // Focus goes IN, unless the caller places it itself. A sheet that opens
    // from a deep link with focus still on <body> leaves a keyboard user
    // tabbing through the page behind it to reach the thing in front of them.
    if (opts.autofocus !== false) focusFirst(el, opts.focus);
    return true;
  }

  // Move focus into the sheet. Deferred a frame: a sheet that slides in is not
  // laid out yet on the tick it opens, so its controls have no size and
  // focusables() would find nothing.
  function focusFirst(el, preferred) {
    requestAnimationFrame(() => {
      try {
        const want = preferred && el.querySelector(preferred);
        const target = (want && (want.offsetWidth || want.offsetHeight)) ? want : focusables(el)[0];
        if (target) target.focus();
      } catch (_) {}
    });
  }

  function close(el) {
    const i = el ? stack.findIndex((s) => s.el === el) : stack.length - 1;
    if (i < 0) return false;
    const entry = stack[i];
    stack.splice(i, 1);
    try { document.removeEventListener("keydown", entry.onKey, true); } catch (_) {}
    // Only the last sheet gives the page its scrolling back.
    if (!stack.length) document.body.style.overflow = entry.prevOverflow || "";
    try { if (entry.onClose) entry.onClose(); } catch (_) {}
    const opener = entry.opener;
    if (opener && document.contains(opener)) { try { opener.focus(); } catch (_) {} }
    return true;
  }

  window.pawaDialog = { open, close, isOpen, focusFirst, focusables };
})();
