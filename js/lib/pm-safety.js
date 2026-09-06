/**
 * pm-safety.js — one safety number, drawn the same way on every screen.
 *
 * WHY THIS FILE EXISTS
 *
 * A safety number only works if two people can compare two renderings of it.
 * That is the entire feature. So the moment the same number is drawn by two
 * different pieces of code, in two different shapes, the feature is quietly
 * broken: a customer looking at six groups of five on an agent's public page
 * and an agent looking at one unbroken run of thirty digits in their Profile
 * are not comparing, they are guessing.
 *
 * Before this file there were three renderings and they did disagree:
 *
 *   the dialog     a 3x2 grid, 15px mono, readable.        (correct)
 *   Profile        the whole thirty digits jammed into the value slot of a
 *                  list row at 11px and 50% opacity, which shoved the row's
 *                  title into one word per line and made the number itself
 *                  the least legible text on the screen.
 *   P-Message      a header <button> reading "Your safety number 48219 07734
 *                  61285 90046 33517 82960", wrapping mid-number, muted, and
 *                  wired to open the BACKUP dialog.
 *
 * So the grid, the QR payload, the QR drawing and the clipboard fallback all
 * live here, once, and everything else asks for them.
 *
 * WHAT THIS FILE WILL NOT DO
 *
 * It never derives a fingerprint and never fetches one. A number comes in as
 * a string that the caller got from PMCrypto (their own key) or from
 * PMStore.peer (derived on this device from the key that actually arrived).
 * Handing this file a user id and letting it "go and look up their number"
 * would put the lookup one step further from the place that knows whether the
 * key it used was the one the messages are sealed to, and that step is exactly
 * where a safety number stops meaning anything.
 *
 * Styling is css/pm-safety.css. The grid keeps the class name .pm-big-fp,
 * which css/pm-identity.css already styles, so the dialog and the cards are
 * the same object on screen and not merely a similar one.
 */
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function t(key, fallback, vars) {
    var s = window.t ? window.t(key) : key;
    if (!s || s === key) s = fallback;
    if (vars) Object.keys(vars).forEach(function (k) {
      s = String(s).replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
    });
    return s;
  }

  // A key, Lucide-style, inheriting currentColor so it follows the theme and
  // the card's own tint rather than carrying a hex of its own.
  var KEY_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<circle cx="8" cy="12" r="4" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M12 12h9l-2 2.5M17 12v3" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // ---- the number ----------------------------------------------------------

  /**
   * Thirty digits as six groups of five, whatever arrived.
   *
   * Callers hand this either a spaced number or a bare run of digits (the QR
   * payload carries it unspaced), and a grid built from the second one would
   * be a single very long cell. Regrouping here means there is one shape, and
   * the two phones being held side by side cannot end up showing different
   * ones because of where the string came from.
   */
  function groups(value) {
    var raw = String(value == null ? "" : value).trim();
    if (!raw) return [];
    if (/^\d+$/.test(raw.replace(/\s+/g, "")) && raw.replace(/\s+/g, "").length >= 10) {
      return raw.replace(/\s+/g, "").match(/\d{1,5}/g) || [];
    }
    return raw.split(/\s+/);
  }

  /**
   * The grid. Not a paragraph.
   *
   * Reflowed text wraps wherever the box happens to end, so two phones of
   * different widths show two different shapes and comparing them becomes
   * reading rather than matching. Each group is its own cell, so both ends see
   * three across and two down at any width, and a mismatch lands on a line
   * instead of somewhere in a wall.
   *
   * The cells are joined with a space, not butted together: a grid container
   * drops whitespace-only text nodes, so it costs nothing on screen and keeps
   * textContent a real safety number that can be selected, read aloud by a
   * screen reader, and compared by a test.
   */
  function grid(value, opts) {
    var o = opts || {};
    var gs = groups(value);
    if (!gs.length) gs = ["—"];
    return '<div class="pm-big-fp' + (o.small ? " is-small" : "") + '"' +
      (o.label ? ' role="group" aria-label="' + esc(o.label) + '"' : "") + ">" +
      gs.map(function (g) { return "<span>" + esc(g) + "</span>"; }).join(" ") +
      "</div>";
  }

  /** The number as one line, for a clipboard or an aria-label. */
  function plain(value) { return groups(value).join(" "); }

  // ---- the code people point a phone at ------------------------------------
  //
  //  Thirty digits is the honest length for a safety number and a hopeless
  //  length for a human comparison: people skim, agree, and have checked
  //  nothing. So the digits become a QR code, one phone reads the other, and
  //  the comparison is done by something that cannot be bored.
  //
  //    PM2|<user id>|<thirty digits, no spaces>
  //
  //  The user id is in there so a scan can tell "this is the wrong person's
  //  code" apart from "this is the right person with the wrong key", which are
  //  very different things to be told.
  var QR_PREFIX = "PM2";

  function qrPayload(userId, fingerprint) {
    return QR_PREFIX + "|" + String(userId || "") + "|" +
      String(fingerprint || "").replace(/\s+/g, "");
  }
  function parseQrPayload(text) {
    var parts = String(text || "").split("|");
    if (parts.length !== 3 || parts[0] !== QR_PREFIX) return null;
    return { userId: parts[1], digits: parts[2] };
  }

  /**
   * The code as inline SVG rather than a canvas: no draw-after-insert timing
   * to get wrong, and it stays sharp at any size.
   *
   * Always black on white, in both themes, with the four-module quiet zone the
   * spec requires. A themed QR code is a QR code that does not scan: the
   * contrast and the margin ARE the format.
   *
   * Returns "" when js/lib/qr.js is not on the page, so a caller can decide
   * whether to draw the button at all rather than shipping a broken one.
   */
  function qrSvg(text, label) {
    if (!window.QR) return "";
    var code;
    try { code = window.QR.encode(text, { ecc: "M" }); } catch (_) { return ""; }
    var pad = 4, dim = code.size + pad * 2, d = "";
    for (var y = 0; y < code.size; y++) {
      var run = 0;
      for (var x = 0; x <= code.size; x++) {
        if (x < code.size && code.get(x, y)) { run++; continue; }
        if (run) { d += "M" + (x - run + pad) + " " + (y + pad) + "h" + run + "v1h-" + run + "z"; run = 0; }
      }
    }
    return '<div class="pm-qr"><svg viewBox="0 0 ' + dim + " " + dim + '" width="100%" ' +
      'shape-rendering="crispEdges" role="img" aria-label="' + esc(label || "") + '">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="#ffffff"/>' +
      '<path d="' + d + '" fill="#000000"/></svg></div>';
  }

  /** Can this phone read a code, rather than only show one? */
  function canScan() {
    return typeof window.BarcodeDetector !== "undefined" &&
      !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  // ---- the clipboard -------------------------------------------------------

  /**
   * navigator.clipboard is absent on plain http and refused outright in some
   * Android webviews, which are exactly the conditions this app gets installed
   * under. The old selection trick stays as the fallback rather than the
   * button silently doing nothing on those devices.
   */
  function copyText(text, done) {
    var say = done || function () {};
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { say(true); },
        function () { say(legacyCopy(text)); });
      return;
    }
    say(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (_) { return false; }
  }

  // ---- the card ------------------------------------------------------------

  /**
   * The block that carries a safety number on a page rather than in a dialog.
   *
   *   own   Profile. "This is your number, here is the code for their camera."
   *   peer  a public page. "This is theirs, and here is what this device
   *         remembers about it."
   *
   * The two differ in one sentence and one badge, and in nothing else on
   * purpose: whatever an agent memorises from their own screen has to be the
   * same object a customer is looking at, or they are comparing a card with a
   * description of a card.
   *
   * opts:
   *   fingerprint  the number, spaced or not. Required; "" draws nothing.
   *   userId       whose key it is. Only used for the QR payload; without it
   *                the code cannot say who it belongs to, so it is not drawn.
   *   own          true for "Yours", false for someone else's.
   *   name         their name, for the peer heading.
   *   trust        { verified, changed } from PMTrust, peer side only.
   *   note         a sentence under the number. Defaults per side.
   *   idPrefix     unique per card when a page draws more than one.
   *   compact      the number and one line, no buttons and no code. For a
   *                PREVIEW of a page rather than the page: Profile shows the
   *                agent their own storefront, and a second full card there
   *                would put the same number on one screen twice with two sets
   *                of buttons, one of which does nothing a customer would see.
   */
  function card(opts) {
    var o = opts || {};
    var fp = plain(o.fingerprint);
    if (!fp) return "";
    var own = o.own !== false;
    var id = o.idPrefix || (own ? "pmsOwn" : "pmsPeer");
    // A code is only ever YOUR code. It means "point your camera at my screen
    // and let a machine do the comparing", which is a thing you can offer
    // about your own key and nothing else. Drawing one on somebody else's
    // number would be handing a customer a picture of a number the server just
    // gave them and inviting them to check it against itself.
    var code = (own && o.userId && window.QR && !o.compact) ? qrPayload(o.userId, fp) : "";

    var badge = "";
    if (!own && o.trust) {
      badge = o.trust.changed
        ? '<span class="pm-trust-badge is-changed">' + esc(t("pm_trust_changed", "Changed")) + "</span>"
        : o.trust.verified
        ? '<span class="pm-trust-badge is-ok">' + esc(t("pm_trust_verified", "Verified")) + "</span>"
        : '<span class="pm-trust-badge">' + esc(t("pm_trust_unverified", "Not verified")) + "</span>";
    }

    var title = own
      ? t("pf_safety", "Your safety number")
      : t("pms_theirs", "{name}'s safety number", { name: o.name || t("pm_someone", "Someone") });

    var note = o.note || (own
      ? t("pms_own_d", "This comes from the key on this phone. Show it to somebody, or let them scan the code, and they can be sure they are writing to you and not to somebody standing in the middle.")
      : t("pms_peer_d", "Ask them to open Profile and read their number out. If it matches this one, the messages you send can only be opened by them."));

    var head = '<div class="pms' + (o.compact ? " is-compact" : "") + '" id="' + esc(id) + '">' +
      '<div class="pms-h">' +
        '<span class="pms-ic" aria-hidden="true">' + KEY_ICON + "</span>" +
        '<span class="pms-t">' + esc(title) + "</span>" + badge +
      "</div>" +
      grid(fp, { label: title, small: !!o.compact }) +
      '<p class="pms-d">' + esc(note) + "</p>";

    if (o.compact) return head + "</div>";

    return head +
      '<div class="pms-acts">' +
        (code
          ? '<button type="button" class="pms-btn" data-pms="code" aria-expanded="false">' +
            esc(t("pm_qr_show", "Show my code")) + "</button>"
          : "") +
        '<button type="button" class="pms-btn ghost" data-pms="copy">' +
          esc(t("pms_copy", "Copy the number")) + "</button>" +
        (o.verifyAction
          ? '<button type="button" class="pms-btn ghost" data-pms="verify">' +
            esc(o.verifyAction) + "</button>"
          : "") +
      "</div>" +
      (code
        ? '<div class="pms-qr" data-pms-qr hidden>' + qrSvg(code, t("pm_qr_alt", "Your safety code")) +
          '<p class="pms-cap">' + esc(t("pm_qr_cap", "Let them scan this from their phone.")) + "</p></div>"
        : "") +
      '<div class="pms-msg" data-pms-msg role="status" aria-live="polite"></div>' +
      "</div>";
  }

  /**
   * Bind the card's own two buttons. Verify is left to the caller, because
   * what "compare this" means differs by page and this file owns no dialogs.
   *
   * Delegated from the card element, which survives its own redraws, so a page
   * that re-renders does not accumulate listeners. Safe to call twice on the
   * same element: the flag is on the node, not in a closure.
   */
  function wire(root, opts) {
    if (!root || root.dataset.pmsWired === "1") return;
    root.dataset.pmsWired = "1";
    var o = opts || {};

    root.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-pms]");
      if (!btn || !root.contains(btn)) return;
      var act = btn.dataset.pms;

      if (act === "code") {
        var box = root.querySelector("[data-pms-qr]");
        if (!box) return;
        box.hidden = !box.hidden;
        btn.setAttribute("aria-expanded", box.hidden ? "false" : "true");
        btn.textContent = box.hidden
          ? t("pm_qr_show", "Show my code") : t("pm_qr_hide", "Hide my code");
        return;
      }

      if (act === "copy") {
        var num = root.querySelector(".pm-big-fp");
        var text = plain(num ? num.textContent : "");
        copyText(text, function (ok) { say(root, ok
          ? t("pms_copied", "Copied. Paste it wherever you are talking to them.")
          : t("pms_copy_fail", "Copying was refused. Read the number out instead."), ok); });
        return;
      }

      if (act === "verify" && o.onVerify) o.onVerify();
    });
  }

  /** The card's own status line. Never an alert: nothing here is urgent. */
  function say(root, text, good) {
    var out = root.querySelector("[data-pms-msg]");
    if (!out) return;
    out.className = "pms-msg" + (good === false ? " bad" : good ? " good" : "");
    out.textContent = text || "";
  }

  window.PMSafety = {
    groups: groups,
    grid: grid,
    plain: plain,
    card: card,
    wire: wire,
    say: say,
    qrPayload: qrPayload,
    parseQrPayload: parseQrPayload,
    qrSvg: qrSvg,
    canScan: canScan,
    copyText: copyText,
    KEY_ICON: KEY_ICON,
  };
})();
