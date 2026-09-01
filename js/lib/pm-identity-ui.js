// ============================================================================
//  pm-identity-ui.js — the three dialogs about a P-Message key.
//
//  Safety numbers, backup, restore. They belong to two screens: P-Message
//  offers them where the key is used, Profile offers them where a person goes
//  looking for account settings. Two copies of a dialog that hands out a
//  private key is not a duplication anyone should risk, so there is one.
//
//  It draws into whatever modal shell the host page provides — the two pages
//  have different chrome — and it owns none of the crypto: PMCrypto does the
//  sealing, PMStore does the publishing.
//
//  Wire it once per page:
//    PMIdentityUI.attach({ backdrop, panel, t, fingerprint(), onChange });
//  then call PMIdentityUI.backup() / .restore() / .safetyNumbers(name, theirs).
// ============================================================================

(function () {
  "use strict";

  var host = null;   // { backdrop, panel, t, fingerprint, onChange }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function t(key, fallback, vars) {
    if (host && host.t) return host.t(key, fallback, vars);
    var s = window.t ? window.t(key) : key;
    if (!s || s === key) s = fallback;
    if (vars) Object.keys(vars).forEach(function (k) {
      s = String(s).replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
    });
    return s;
  }
  function fp() { return (host && host.fingerprint && host.fingerprint()) || "—"; }

  /**
   * A safety number laid out as a grid, not as a paragraph.
   *
   * Thirty digits reflowed by the browser wrap wherever the box happens to
   * end — five groups then one — and comparing two ragged blocks digit by
   * digit is exactly the reading task people give up on. Each group is its own
   * cell, so both phones show the same three-by-two shape whatever their
   * width, and a mismatch is somewhere on a line rather than somewhere in a
   * wall.
   */
  // ---- the code people point a phone at --------------------------------------
  //
  //  Thirty digits is the honest length for a safety number and a hopeless
  //  length for a human comparison — people skim, agree, and have checked
  //  nothing. So the digits become a QR code, one phone reads the other, and
  //  the comparison is done by a machine that cannot be bored.
  //
  //  PM2|<user id>|<thirty digits, no spaces>
  //
  //  The user id is in there so a scan can tell "this is the wrong person's
  //  code" apart from "this is the right person with the wrong key" — two very
  //  different things to be told.
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
   * spec requires. A themed QR code is a QR code that does not scan — the
   * contrast and the margin ARE the format.
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

  function canScan() {
    return typeof window.BarcodeDetector !== "undefined" &&
      !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function fpBlock(value) {
    var groups = String(value || "—").trim().split(/\s+/);
    return '<div class="pm-big-fp">' + groups.map(function (g) {
      return "<span>" + esc(g) + "</span>";
    // Joined with a space, not butted together: a grid container drops
    // whitespace-only text nodes, so it costs nothing on screen, and it keeps
    // textContent a real safety number that can be copied, read by a screen
    // reader, and compared by a test.
    }).join(" ") + "</div>";
  }

  function attach(opts) {
    host = opts || {};
    if (host.backdrop) {
      host.backdrop.addEventListener("click", function (e) {
        if (e.target === host.backdrop) close();
      });
    }
  }

  // Set by any dialog holding something that must be released — at present the
  // camera. Both open() and close() run it, because a dialog is dismissed in
  // more ways than by its own button: the backdrop, the next dialog replacing
  // its markup, or a caller re-rendering. A camera left running behind a
  // closed dialog is not a leak people forgive.
  var activeCleanup = null;
  function runCleanup() {
    var fn = activeCleanup;
    activeCleanup = null;
    if (fn) { try { fn(); } catch (_) {} }
  }

  function open(html) {
    if (!host || !host.panel) return;
    runCleanup();
    host.panel.innerHTML = html;
    host.backdrop.classList.add("is-on");
  }
  function close() {
    if (!host || !host.panel) return;
    runCleanup();
    host.backdrop.classList.remove("is-on");
    host.panel.innerHTML = "";
  }
  var $ = function (id) { return document.getElementById(id); };

  /**
   * Two numbers, side by side — and what this device remembers about theirs.
   *
   * This dialog is the only defence against the one attack the scheme cannot
   * prevent on its own: public keys come from the same database that stores
   * the messages, so whoever controls it could hand you a key of their own.
   *
   * Two things were wrong with the first version and both are fixed here.
   * The number shown for the other person came from the SERVER, so the party
   * being guarded against was supplying the evidence — it is now derived on
   * the device from the key that actually arrived (see PMStore.peer). And
   * comparing it decided nothing and was remembered nowhere, so every fetch
   * was a fresh act of trust; the answer is now written down by PMTrust, and
   * a key that changes later says so, loudly, before anything else happens.
   *
   * Accepts either the old (name, theirs) pair or a descriptor:
   *   { name, theirs, theirKey, peerId, meId, trust, onChange }
   */
  function safetyNumbers(opts, legacyTheirs) {
    var o = (typeof opts === "string" || opts == null)
      ? { name: opts, theirs: legacyTheirs } : opts;

    var trust = o.trust || (window.PMTrust && o.meId && o.peerId
      ? window.PMTrust.status(o.meId, o.peerId) : null);
    var canRecord = !!(window.PMTrust && o.meId && o.peerId && o.theirKey);
    var changed = !!(trust && trust.changed);
    var verified = !!(trust && trust.verified);

    // My own code, for the other phone to read. meId is my user id; on Profile
    // there is no conversation and it comes from the host instead.
    var myId = o.meId || (host && host.userId && host.userId()) || "";
    var myCode = (myId && window.QR && fp() !== "—") ? qrPayload(myId, fp()) : "";
    var scannable = canScan() && canRecord && !!o.theirs;

    var badge = changed
      ? '<span class="pm-trust-badge is-changed">' + esc(t("pm_trust_changed", "Changed")) + "</span>"
      : verified
      ? '<span class="pm-trust-badge is-ok">' + esc(t("pm_trust_verified", "Verified")) + "</span>"
      : '<span class="pm-trust-badge">' + esc(t("pm_trust_unverified", "Not verified")) + "</span>";

    // The alarm goes ABOVE the numbers. Someone who opens this dialog because
    // a thread was blocked must meet the reason before the ritual.
    var alarm = changed
      ? '<div class="pm-alarm">' +
          "<b>" + esc(t("pm_trust_alarm_t", "This person's safety number has changed.")) + "</b> " +
          esc(t("pm_trust_alarm_d",
            "Either they reinstalled or moved to a new phone, or somebody has stepped into the middle of this conversation. There is no way to tell from here. Check the number below with them on a call or in person before you send anything you would not say in public.")) +
          (trust && trust.wasVerified
            ? " <b>" + esc(t("pm_trust_was", "You had verified their previous number.")) + "</b>" : "") +
        "</div>"
      : "";

    open("<h2>" + esc(t("pm_verify_t", "Safety numbers")) + "</h2>" +
      role(t("pm_verify_role",
        "Proof that you are talking to the person you think you are, and that nobody is sitting in the middle reading it.")) +
      alarm +
      "<p>" + esc(t("pm_verify_d2",
        "Compare these with each other, on a call or standing together. If they match, nobody has slipped between you.")) + "</p>" +
      "<label>" + esc(t("pm_verify_yours", "Yours")) + "</label>" +
      fpBlock(fp()) +
      (myCode ? '<div id="pmQrWrap" hidden>' + qrSvg(myCode, t("pm_qr_alt", "Your safety code")) +
        '<p class="pm-qr-cap">' + esc(t("pm_qr_cap", "Let them scan this from their phone.")) + "</p></div>" : "") +
      (o.theirs
        ? "<label>" + esc(o.name || "") + " " + badge + "</label>" + fpBlock(o.theirs)
        : "") +
      '<div class="pm-modal-acts">' +
        // Scanning is the primary action wherever the phone can do it: a
        // machine comparing thirty digits does not skim, and skimming is the
        // whole failure mode of reading them aloud.
        ((scannable && !verified)
          ? '<button class="pm-btn" id="pmFpScan">' + esc(t("pm_qr_scan", "Scan their code")) + "</button>" : "") +
        ((canRecord && !verified && !scannable)
          ? '<button class="pm-btn" id="pmFpMatch">' + esc(t("pm_trust_match", "They match")) + "</button>" : "") +
        '<button class="pm-btn ghost" id="pmFpOk">' + esc(t("pm_close", "Close")) + "</button>" +
      "</div>" +
      (myCode
        ? '<p style="margin-top:9px"><button class="pm-btn ghost" id="pmQrToggle" style="width:100%">' +
          esc(t("pm_qr_show", "Show my code")) + "</button></p>" : "") +
      // Where the camera can scan, reading the digits is still offered — a
      // borrowed phone, a cracked lens, a refused permission. The digits are
      // the fallback, which is exactly why they were not removed.
      ((canRecord && !verified && scannable)
        ? '<p style="margin-top:9px"><button class="pm-btn ghost" id="pmFpMatch" style="width:100%">' +
          esc(t("pm_trust_match_manual", "We compared the digits — they match")) + "</button></p>" : "") +
      // Accepting a change is deliberately the quiet, secondary action: the
      // loud one should be checking, not dismissing.
      (changed && canRecord
        ? '<p style="margin-top:10px"><button class="pm-btn ghost" id="pmFpAccept" style="width:100%">' +
          esc(t("pm_trust_accept", "They told me they changed phone")) + "</button></p>" : "") +
      '<div class="pm-msg-out" id="pmFpMsg"></div>');

    $("pmFpOk").addEventListener("click", close);

    if ($("pmQrToggle")) {
      $("pmQrToggle").addEventListener("click", function () {
        var wrap = $("pmQrWrap");
        wrap.hidden = !wrap.hidden;
        this.textContent = wrap.hidden
          ? t("pm_qr_show", "Show my code") : t("pm_qr_hide", "Hide my code");
      });
    }

    if (scannable && $("pmFpScan")) {
      $("pmFpScan").addEventListener("click", function () { scanFor(o); });
    }

    if (canRecord && !verified && $("pmFpMatch")) {
      $("pmFpMatch").addEventListener("click", function () {
        // Recorded against the key that was on screen while they compared —
        // not against whatever the network might return a moment from now.
        window.PMTrust.markVerified(o.meId, o.peerId, o.theirKey, o.name);
        if (o.onChange) o.onChange();
        var out = $("pmFpMsg");
        out.className = "pm-msg-out good";
        out.textContent = t("pm_trust_saved", "Verified. You will be warned if this ever changes.");
        if ($("pmFpMatch")) $("pmFpMatch").remove();
        if ($("pmFpAccept")) $("pmFpAccept").remove();
        var al = host.panel.querySelector(".pm-alarm");
        if (al) al.remove();
      });
    }

    if (changed && canRecord && $("pmFpAccept")) {
      $("pmFpAccept").addEventListener("click", function () {
        // Back to merely-seen, never to verified: what was verified was the
        // key that is now gone, and nobody has checked this one.
        window.PMTrust.accept(o.meId, o.peerId);
        if (o.onChange) o.onChange();
        var out = $("pmFpMsg");
        out.className = "pm-msg-out";
        out.textContent = t("pm_trust_accepted",
          "Warning cleared. Their number is still unverified — compare it when you can.");
        var al = host.panel.querySelector(".pm-alarm");
        if (al) al.remove();
        if ($("pmFpAccept")) $("pmFpAccept").remove();
      });
    }
  }

  /**
   * Point the camera at the other person's code.
   *
   * BarcodeDetector is the phone's own scanner — hardware-accelerated on
   * Android, and far better at a screen photographed at an angle in bad light
   * than anything this file could manage against a canvas. Where it does not
   * exist (iOS Safari, desktop Chrome) this button is never drawn and the
   * digits carry the feature, which is the whole reason they still exist.
   *
   * THE RESULT IS COMPARED, NOT TRUSTED. A scanned code proves nothing by
   * itself; what matters is whether it matches the key this device was handed
   * for this person. Three outcomes, and they are deliberately different
   * sentences: the wrong person's code, the right person's code that does not
   * match, and a match.
   */
  function scanFor(o) {
    open("<h2>" + esc(t("pm_scan_t", "Scan their code")) + "</h2>" +
      "<p>" + esc(t("pm_scan_d",
        "Ask them to open Verify and tap Show my code, then point this camera at their screen.")) + "</p>" +
      '<div class="pm-scan"><video id="pmScanVid" playsinline muted></video></div>' +
      '<div class="pm-msg-out" id="pmScanMsg"></div>' +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn ghost" id="pmScanBack">' + esc(t("pm_back", "Back")) + "</button>" +
      "</div>");

    var video = $("pmScanVid"), msg = $("pmScanMsg");
    var stream = null, stopped = false;

    var shutdown = function () {
      stopped = true;
      if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
      stream = null;
    };
    // Registered so that closing the modal — including by tapping the
    // backdrop — puts the camera out. A dialog that vanishes while the camera
    // light stays on is the kind of thing people never trust you about again.
    activeCleanup = shutdown;

    $("pmScanBack").addEventListener("click", function () { shutdown(); safetyNumbers(o); });

    var finish = function (hit) {
      shutdown();
      var expect = String(o.theirs || "").replace(/\s+/g, "");
      var problem = null;
      if (hit.userId !== o.peerId) {
        problem = t("pm_scan_wrong_person",
          "That code belongs to a different account. Check you are scanning the right person's screen.");
      } else if (!expect || hit.digits !== expect) {
        problem = t("pm_scan_mismatch",
          "These do NOT match. The key this device was given for them is not the key on their phone. Do not send anything private until you know why.");
      } else {
        window.PMTrust.markVerified(o.meId, o.peerId, o.theirKey, o.name);
        if (o.onChange) o.onChange();
      }
      safetyNumbers(o);                       // redrawn so the badge is current
      var out = $("pmFpMsg");
      if (!out) return;
      out.className = "pm-msg-out " + (problem ? "bad" : "good");
      out.textContent = problem || t("pm_scan_ok",
        "Matched and verified. You will be warned if their key ever changes.");
    };

    (function () {
      var detector;
      try { detector = new window.BarcodeDetector({ formats: ["qr_code"] }); }
      catch (_) {
        msg.className = "pm-msg-out bad";
        msg.textContent = t("pm_scan_no_reader", "This phone cannot read codes. Compare the digits instead.");
        return;
      }
      navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
        .then(function (s) {
          if (stopped) { s.getTracks().forEach(function (tr) { tr.stop(); }); return; }
          stream = s;
          video.srcObject = s;
          return video.play();
        })
        .then(function () {
          var tick = function () {
            if (stopped || !stream) return;
            detector.detect(video).then(function (found) {
              if (stopped) return;
              for (var i = 0; i < (found || []).length; i++) {
                var hit = parseQrPayload(found[i].rawValue);
                if (hit) return finish(hit);
              }
              setTimeout(tick, 220);
            }).catch(function () {
              // A frame that will not decode is the ordinary case, not an error.
              if (!stopped) setTimeout(tick, 220);
            });
          };
          tick();
        })
        .catch(function () {
          msg.className = "pm-msg-out bad";
          msg.textContent = t("pm_scan_no_cam",
            "The camera is not available. Compare the digits instead.");
        });
    })();
  }

  /**
   * The backup code.
   *
   * Offered to a brand-new device before it has a history, because the honest
   * moment to say "this key is the only copy" is while there is still nothing
   * to lose. The code is useless without the passphrase, which is why the
   * passphrase is never stored anywhere.
   */
  // ── The key dialogs, as jobs rather than forms ──────────────────────────
  //
  //  These were one box each with every control in it at once, and the backup
  //  one could not be completed on a phone at all: it printed a hundred-odd
  //  characters of base64 into a <div> with no way to copy them, beside a
  //  passphrase field that never said what the passphrase was for or that
  //  forgetting it destroys the code. You could close that dialog having done
  //  nothing, and nothing said so.
  //
  //  Each one now states its ROLE in a line under the title, and the backup
  //  runs as three steps with one job apiece, because the three jobs have
  //  different failure modes and mixing them is what hid all of them:
  //
  //    1  choose a passphrase   typo it and the code is scrap, so it is typed
  //                             twice and checked before anything is made
  //    2  take the code away    copy it, or save it as a file. This is the
  //                             step that did not exist at all.
  //    3  say you have it       an explicit acknowledgement, because "I closed
  //                             the box" and "I saved my key" are not the same
  //                             thing and only one of them is recoverable.
  //
  //  Nothing about the crypto changed. PMCrypto.backup() and
  //  PMStore.restoreIdentity() are called exactly as they were.

  /** The one line under the title that says what this dialog is FOR. */
  function role(text) {
    return '<p class="pm-role">' + esc(text) + "</p>";
  }

  /** "Step 2 of 3", so a flow with a middle does not feel like a loop. */
  function steps(n, of) {
    var dots = "";
    for (var i = 1; i <= of; i++) {
      dots += '<span class="pm-step-dot' +
        (i === n ? " is-on" : (i < n ? " is-done" : "")) + '"></span>';
    }
    return '<div class="pm-steps"><span class="pm-steps-n">' +
      esc(t("pm_step_n", "Step {n} of {of}", { n: n, of: of })) + "</span>" +
      '<span class="pm-steps-dots" aria-hidden="true">' + dots + "</span></div>";
  }

  /**
   * Step 1. The passphrase, and the two things about it nobody was told: it is
   * chosen HERE and now, so it is not an account password, and if it is
   * forgotten the code becomes scrap, because the code is sealed with it and
   * there is nothing on any server that could unseal it. It is typed twice for
   * exactly that reason: a passphrase mistyped once is a backup that looks
   * complete and can never be opened.
   */
  function backup() {
    open("<h2>" + esc(t("pm_backup_t", "Save a backup of your key")) + "</h2>" +
      role(t("pm_backup_role", "So you can read these conversations on another phone, or on this one after the browser is cleared.")) +
      steps(1, 3) +
      '<div class="pm-note">' + esc(t("pm_backup_why",
        "Your key is on this device and nowhere else. That is what keeps the messages private, and it is why clearing this browser loses them for good.")) + "</div>" +
      '<label for="pmBkPass">' + esc(t("pm_backup_pass2", "Choose a passphrase")) + "</label>" +
      '<input type="password" id="pmBkPass" autocomplete="new-password" placeholder="' +
        esc(t("pm_backup_pass_ph", "at least 8 characters")) + '" />' +
      '<p class="pm-hint">' + esc(t("pm_backup_pass_hint",
        "New, and only for this code. It is not your account password. The code is sealed with it, so if you forget it nobody can open the code, including us.")) + "</p>" +
      '<label for="pmBkPass2">' + esc(t("pm_backup_pass_again", "Type it again")) + "</label>" +
      '<input type="password" id="pmBkPass2" autocomplete="new-password" />' +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn ghost" id="pmBkSkip">' + esc(t("pm_later", "Later")) + "</button>" +
        '<button class="pm-btn" id="pmBkMake" disabled>' + esc(t("pm_backup_make", "Create the code")) + "</button>" +
      "</div>" +
      '<div class="pm-msg-out" id="pmBkMsg"></div>' +
      '<p class="pm-alt"><button class="pm-link" type="button" id="pmBkRestore">' +
      esc(t("pm_restore", "I already have a backup code")) + "</button></p>");

    var pass = $("pmBkPass"), pass2 = $("pmBkPass2"), make = $("pmBkMake"), msg = $("pmBkMsg");

    // Checked as it is typed rather than on submit. A mismatch discovered
    // after the code has been generated is a code that has to be thrown away,
    // and nothing would say which of the two fields held the mistake.
    function check() {
      var a = pass.value, b = pass2.value;
      var ready = a.length >= 8 && a === b;
      make.disabled = !ready;
      if (!a.length) { msg.className = "pm-msg-out"; msg.textContent = ""; return; }
      if (a.length < 8) {
        msg.className = "pm-msg-out";
        msg.textContent = t("pm_backup_short", "A few more characters.");
      } else if (b && a !== b) {
        msg.className = "pm-msg-out bad";
        msg.textContent = t("pm_backup_mismatch", "The two do not match yet.");
      } else if (ready) {
        msg.className = "pm-msg-out good";
        msg.textContent = t("pm_backup_ready", "That will do.");
      } else {
        msg.className = "pm-msg-out";
        msg.textContent = "";
      }
    }
    pass.addEventListener("input", check);
    pass2.addEventListener("input", check);
    pass2.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !make.disabled) { e.preventDefault(); make.click(); }
    });

    $("pmBkSkip").addEventListener("click", close);
    $("pmBkRestore").addEventListener("click", restore);
    make.addEventListener("click", async function () {
      make.disabled = true;
      msg.className = "pm-msg-out";
      msg.textContent = t("pm_working", "Working…");
      try {
        var code = await window.PMCrypto.backup(window.PMStore.current(), pass.value);
        backupCode(code);
      } catch (err) {
        make.disabled = false;
        msg.className = "pm-msg-out bad";
        msg.textContent = (err && err.message) || String(err);
      }
    });
  }

  /**
   * Step 2. The code, and a way to take it with you.
   *
   * This is the step that did not exist. The old dialog printed the code into
   * a box and left somebody to select a hundred characters of base64 with a
   * thumb. Copy is the obvious answer; the FILE is the one that matters on a
   * phone with no clipboard history, because a downloaded file survives the
   * browser being cleared, which is the exact event this feature exists for.
   */
  function backupCode(code) {
    open("<h2>" + esc(t("pm_backup_code_t", "Your backup code")) + "</h2>" +
      role(t("pm_backup_code_role", "Keep it somewhere only you can reach. It is useless to anybody who does not also have your passphrase.")) +
      steps(2, 3) +
      '<div class="pm-code" id="pmBkCode" tabindex="0">' + esc(code) + "</div>" +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn ghost" id="pmBkCopy">' + esc(t("pm_copy", "Copy")) + "</button>" +
        '<button class="pm-btn ghost" id="pmBkFile">' + esc(t("pm_backup_file", "Save as a file")) + "</button>" +
      "</div>" +
      '<div class="pm-msg-out" id="pmBkCodeMsg"></div>' +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn" id="pmBkNext">' + esc(t("pm_continue", "Continue")) + "</button>" +
      "</div>");

    var out = $("pmBkCodeMsg");
    $("pmBkCopy").addEventListener("click", function () {
      copyText(code, function (done) {
        out.className = "pm-msg-out " + (done ? "good" : "bad");
        out.textContent = done
          ? t("pm_copied", "Copied.")
          : t("pm_copy_fail", "This browser would not copy it. Select the code and copy it by hand, or save the file.");
      });
    });
    $("pmBkFile").addEventListener("click", function () {
      var body = t("pm_backup_file_head",
        "Maisha na Lifeza backup key. Paste this into Profile, then Restore from a backup code. It needs the passphrase you chose.") +
        "\n\n" + code + "\n";
      if (saveFile("maisha-backup-key.txt", body)) {
        out.className = "pm-msg-out good";
        out.textContent = t("pm_backup_file_ok", "Saved to your downloads.");
      } else {
        out.className = "pm-msg-out bad";
        out.textContent = t("pm_backup_file_fail", "This browser would not save the file. Copy the code instead.");
      }
    });
    $("pmBkNext").addEventListener("click", function () { backupDone(code); });
  }

  /**
   * Step 3. Say you have it.
   *
   * Not a formality. The failure this whole feature exists to prevent is
   * somebody believing they are backed up when they are not, and the old
   * dialog let you reach that state by closing a box. The way back to the code
   * is on this screen, so answering honestly costs nothing.
   */
  function backupDone(code) {
    open("<h2>" + esc(t("pm_backup_done_t", "Have you saved it?")) + "</h2>" +
      role(t("pm_backup_done_role", "There is no copy anywhere else. If this phone is lost or cleared, that code is the only way back to these conversations.")) +
      steps(3, 3) +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn ghost" id="pmBkBack">' + esc(t("pm_backup_show", "Show it again")) + "</button>" +
        '<button class="pm-btn" id="pmBkYes">' + esc(t("pm_backup_saved", "Yes, it is saved")) + "</button>" +
      "</div>" +
      // The device lock is offered HERE and nowhere earlier: it is only a good
      // idea once a backup exists, because it puts the key behind a passkey
      // that can itself be lost with the phone.
      '<p class="pm-alt" id="pmLockEntry" hidden>' +
        '<button class="pm-link" type="button" id="pmLockGo"></button></p>');

    $("pmBkBack").addEventListener("click", function () { backupCode(code); });
    $("pmBkYes").addEventListener("click", close);
    (async function () {
      if (!window.PMDeviceLock || !(await window.PMDeviceLock.supported())) return;
      var wrap = $("pmLockEntry");
      if (!wrap) return;                       // the dialog moved on already
      wrap.hidden = false;
      $("pmLockGo").textContent = window.PMDeviceLock.isEnrolled()
        ? t("pm_lock_manage", "Device lock is on")
        : t("pm_lock_offer", "Also protect this key with your fingerprint");
      $("pmLockGo").addEventListener("click", deviceLock);
    })();
  }

  /**
   * Clipboard, with the fallback that matters.
   *
   * navigator.clipboard is absent on plain http and refused outright in some
   * Android webviews, which are exactly the conditions this app gets installed
   * under. The old selection trick stays as the fallback rather than the
   * button silently doing nothing on those devices.
   */
  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { done(true); },
        function () { done(legacyCopy(text)); });
      return;
    }
    done(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      var done = document.execCommand("copy");
      document.body.removeChild(ta);
      return done;
    } catch (_) { return false; }
  }

  /** A text file, through a blob URL. Returns false rather than throwing. */
  function saveFile(name, body) {
    try {
      var blob = new Blob([body], { type: "text/plain;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return true;
    } catch (_) { return false; }
  }

  /**
   * Put the private key behind the phone's own fingerprint or face check.
   *
   * The flow insists on a backup code FIRST, and generates one here rather
   * than asking whether you have one. That is because the failure this
   * prevents is not "you are locked out for a minute" — it is "the passkey is
   * gone and so is every message you have ever received". A tick-box saying
   * "I already have one" is the version of this that loses people's data.
   *
   * There is no plaintext fallback left behind afterwards. That is what makes
   * it worth doing, and it is why the warning is worded plainly instead of
   * being softened.
   */
  function deviceLock() {
    var DL = window.PMDeviceLock;
    if (!DL) return;

    var enrolled = DL.isEnrolled();
    open("<h2>" + esc(t("pm_lock_t", "Protect your key with this device")) + "</h2>" +
      (enrolled
        ? "<p>" + esc(t("pm_lock_on_d",
            "Your key is stored sealed on this phone. Opening it asks for your fingerprint, face or PIN, and nothing on this device can read it without that.")) + "</p>"
        : "<p>" + esc(t("pm_lock_off_d",
            "Right now your key is stored in this browser in the clear, so anything that can run code on this site — or anyone holding your unlocked phone — can read it. Sealing it means the phone's own security hardware has to let it out.")) + "</p>" +
          '<div class="pm-alarm">' +
            "<b>" + esc(t("pm_lock_warn_t", "There is no way back without your backup code.")) + "</b> " +
            esc(t("pm_lock_warn_d",
              "If this phone's fingerprint or face data is reset, or its passkeys are cleared, the sealed key cannot be opened by anyone — including us. So a backup code is made first, and you must save it before this can be turned on.")) +
          "</div>" +
          "<label>" + esc(t("pm_backup_pass", "Passphrase (8+ characters)")) + "</label>" +
          '<input type="password" id="pmLkPass" autocomplete="new-password" />' +
          '<div id="pmLkOut"></div>') +
      '<div class="pm-modal-acts">' +
        (enrolled
          ? '<button class="pm-btn ghost" id="pmLkOff">' + esc(t("pm_lock_turn_off", "Turn off")) + "</button>"
          : '<button class="pm-btn" id="pmLkMake">' + esc(t("pm_lock_step1", "Make my backup code")) + "</button>") +
        '<button class="pm-btn ghost" id="pmLkClose">' + esc(t("pm_close", "Close")) + "</button>" +
      "</div>" +
      '<div class="pm-msg-out" id="pmLkMsg"></div>');

    $("pmLkClose").addEventListener("click", close);

    if (enrolled) {
      $("pmLkOff").addEventListener("click", async function () {
        var out = $("pmLkMsg");
        this.disabled = true;
        out.className = "pm-msg-out";
        out.textContent = t("pm_working", "Working…");
        try {
          // Unlock first if this session has not already: disable() must have
          // the key in hand before it drops the only sealed copy of it.
          if (DL.isLocked()) await DL.unlock();
          await DL.disable();
          out.className = "pm-msg-out";
          out.textContent = t("pm_lock_off_ok",
            "Device lock is off. Your key is back in this browser's storage.");
          this.remove();
        } catch (err) {
          out.className = "pm-msg-out bad";
          out.textContent = lockError(err);
          this.disabled = false;
        }
      });
      return;
    }

    $("pmLkMake").addEventListener("click", async function () {
      var out = $("pmLkMsg");
      try {
        var code = await window.PMCrypto.backup(window.PMStore.current(), $("pmLkPass").value);
        $("pmLkOut").innerHTML =
          "<label>" + esc(t("pm_backup_code", "Your backup code — keep it somewhere safe")) + "</label>" +
          '<div class="pm-code">' + esc(code) + "</div>";
        out.className = "pm-msg-out good";
        out.textContent = t("pm_lock_step2",
          "Save that somewhere only you can reach, then seal the key.");
        this.textContent = t("pm_lock_step3", "I have saved it — seal my key");
        this.onclick = seal;
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
      }
    });

    async function seal() {
      var btn = $("pmLkMake"), out = $("pmLkMsg");
      btn.disabled = true;
      out.className = "pm-msg-out";
      out.textContent = t("pm_lock_prompt", "Confirm with your fingerprint, face or PIN…");
      try {
        await DL.enroll(window.PMStore.current(), {
          userId: (host && host.userId && host.userId()) || "pm-user",
          backupSaved: true,
        });
        out.className = "pm-msg-out good";
        out.textContent = t("pm_lock_on_ok",
          "Sealed. From now on this key is opened by this device and nothing else.");
        btn.remove();
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = lockError(err);
        btn.disabled = false;
      }
    }
  }

  function lockError(err) {
    var code = (err && err.message) || String(err);
    if (code === "NO_PRF") {
      return t("pm_lock_no_prf",
        "This phone can check your fingerprint but will not derive a key from it, so the key cannot be sealed here. Nothing has changed.");
    }
    if (code === "UNSUPPORTED") {
      return t("pm_lock_unsupported", "This browser cannot do that. Nothing has changed.");
    }
    if (code === "WRONG_KEY") {
      return t("pm_lock_wrong_key",
        "That is not the passkey this key was sealed with. If it was reset, restore from your backup code instead.");
    }
    if (/NotAllowed|AbortError|CANCELLED/i.test(code)) {
      return t("pm_lock_cancelled", "Cancelled. Nothing has changed.");
    }
    return code;
  }

  /**
   * Put a key from another phone onto this one.
   *
   * The role line matters more here than anywhere else, because this dialog
   * REPLACES something. The old one said so in a sentence above the fields,
   * where it read as preamble; what it costs is now a warning block of its
   * own, and the button stays disabled until there is actually something to
   * restore, so nobody learns the consequence from an error message.
   */
  function restore() {
    open("<h2>" + esc(t("pm_restore_t", "Restore a key from a backup code")) + "</h2>" +
      role(t("pm_restore_role", "For a new phone, or this one after the browser was cleared. It puts the key from your backup code onto this device.")) +
      '<div class="pm-note is-warn">' + esc(t("pm_restore_warn",
        "This replaces the key that is on this device now. Anything sent to THIS device before today stops opening, and there is no way back unless you also have a backup of the key it replaces.")) + "</div>" +
      '<label for="pmRsCode">' + esc(t("pm_restore_code", "Backup code")) + "</label>" +
      '<textarea id="pmRsCode" autocomplete="off" spellcheck="false" placeholder="' +
        esc(t("pm_restore_code_ph", "paste the whole code")) + '"></textarea>' +
      '<label for="pmRsPass">' + esc(t("pm_restore_pass", "The passphrase you chose when you made it")) + "</label>" +
      '<input type="password" id="pmRsPass" autocomplete="current-password" />' +
      '<p class="pm-hint">' + esc(t("pm_restore_hint",
        "Both have to be right. The code cannot be opened without the passphrase, and we cannot look either of them up.")) + "</p>" +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn ghost" id="pmRsCancel">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
        '<button class="pm-btn" id="pmRsGo" disabled>' + esc(t("pm_restore_go", "Restore this key")) + "</button>" +
      '</div><div class="pm-msg-out" id="pmRsMsg"></div>');

    var code = $("pmRsCode"), pass = $("pmRsPass"), go = $("pmRsGo"), out = $("pmRsMsg");

    // Disabled until both fields hold something. A "Restore" that can only
    // ever answer "wrong passphrase" is a button that teaches nothing.
    function check() { go.disabled = !(code.value.trim() && pass.value); }
    code.addEventListener("input", check);
    pass.addEventListener("input", check);

    $("pmRsCancel").addEventListener("click", close);
    go.addEventListener("click", async function () {
      go.disabled = true;
      out.className = "pm-msg-out";
      out.textContent = t("pm_working", "Working…");
      try {
        var res = await window.PMStore.restoreIdentity(code.value.trim(), pass.value);
        out.className = "pm-msg-out good";
        out.textContent = t("pm_restore_ok", "Restored. Your old conversations open again.");
        // The host decides what a new fingerprint means for its own screen:
        // P-Message reloads the inbox, Profile just redraws the number.
        if (host && host.onChange) host.onChange(res);
      } catch (err) {
        go.disabled = false;
        out.className = "pm-msg-out bad";
        // The two real failures are a mistyped passphrase and a truncated
        // paste, and the raw error says neither. Naming both is the difference
        // between trying again and giving up.
        out.textContent = (err && err.message) || String(err);
        out.textContent += " " + t("pm_restore_retry",
          "Check the passphrase, and that the whole code was pasted.");
      }
    });
  }

  window.PMIdentityUI = {
    attach: attach,
    open: open,
    close: close,
    safetyNumbers: safetyNumbers,
    backup: backup,
    restore: restore,
    deviceLock: deviceLock,
  };
})();
