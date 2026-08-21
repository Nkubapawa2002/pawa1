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
      alarm +
      "<p>" + esc(t("pm_verify_d2",
        "Compare these with each other — on a call, or standing together. If they match, nobody has slipped between you.")) + "</p>" +
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
  function backup() {
    open("<h2>" + esc(t("pm_backup_t", "Your key lives on this device")) + "</h2>" +
      "<p>" + esc(t("pm_backup_d", "That is what makes these messages private — and it means clearing this browser's data loses them for good. Save a backup code now and you can restore it on another phone.")) + "</p>" +
      "<label>" + esc(t("pm_backup_pass", "Passphrase (8+ characters)")) + "</label>" +
      '<input type="password" id="pmBkPass" autocomplete="new-password" />' +
      '<div id="pmBkOut"></div>' +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn" id="pmBkMake">' + esc(t("pm_backup_make", "Create code")) + "</button>" +
        '<button class="pm-btn ghost" id="pmBkSkip">' + esc(t("pm_later", "Later")) + "</button>" +
      "</div>" +
      '<div class="pm-msg-out" id="pmBkMsg"></div>' +
      '<p style="margin-top:14px"><button class="pm-btn ghost" id="pmBkRestore" style="width:100%">' +
      esc(t("pm_restore", "I have a backup code")) + "</button></p>" +
      // The device lock belongs on THIS dialog, which is the one that says
      // where the key lives. It appears only once the phone has confirmed it
      // can actually do it, so nobody is offered a door that is painted on.
      '<p style="margin-top:9px" id="pmLockEntry" hidden>' +
        '<button class="pm-btn ghost" id="pmLockGo" style="width:100%"></button></p>');

    $("pmBkSkip").addEventListener("click", close);
    (async function () {
      if (!window.PMDeviceLock || !(await window.PMDeviceLock.supported())) return;
      var wrap = $("pmLockEntry");
      if (!wrap) return;                       // the dialog moved on already
      wrap.hidden = false;
      $("pmLockGo").textContent = window.PMDeviceLock.isEnrolled()
        ? t("pm_lock_manage", "Device lock is on")
        : t("pm_lock_offer", "Protect this key with your fingerprint");
      $("pmLockGo").addEventListener("click", deviceLock);
    })();
    $("pmBkMake").addEventListener("click", async function () {
      var out = $("pmBkMsg");
      try {
        var code = await window.PMCrypto.backup(window.PMStore.current(), $("pmBkPass").value);
        $("pmBkOut").innerHTML =
          "<label>" + esc(t("pm_backup_code", "Your backup code — keep it somewhere safe")) + "</label>" +
          '<div class="pm-code">' + esc(code) + "</div>";
        out.className = "pm-msg-out good";
        out.textContent = t("pm_backup_ok", "Copy it somewhere only you can reach. It is useless without your passphrase.");
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
      }
    });
    $("pmBkRestore").addEventListener("click", restore);
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

  function restore() {
    open("<h2>" + esc(t("pm_restore_t", "Restore your key")) + "</h2>" +
      "<p>" + esc(t("pm_restore_d", "Paste the backup code from your other device. This replaces the key on this one, so anything sent to this device only will stop opening.")) + "</p>" +
      "<label>" + esc(t("pm_restore_code", "Backup code")) + '</label><textarea id="pmRsCode"></textarea>' +
      "<label>" + esc(t("pm_backup_pass", "Passphrase")) + '</label><input type="password" id="pmRsPass" />' +
      '<div class="pm-modal-acts">' +
        '<button class="pm-btn" id="pmRsGo">' + esc(t("pm_restore_go", "Restore")) + "</button>" +
        '<button class="pm-btn ghost" id="pmRsCancel">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
      '</div><div class="pm-msg-out" id="pmRsMsg"></div>');

    $("pmRsCancel").addEventListener("click", close);
    $("pmRsGo").addEventListener("click", async function () {
      var out = $("pmRsMsg");
      out.className = "pm-msg-out";
      out.textContent = t("pm_working", "Working…");
      try {
        var res = await window.PMStore.restoreIdentity($("pmRsCode").value, $("pmRsPass").value);
        out.className = "pm-msg-out good";
        out.textContent = t("pm_restore_ok", "Restored. Your old conversations open again.");
        // The host decides what a new fingerprint means for its own screen —
        // P-Message reloads the inbox, Profile just redraws the number.
        if (host && host.onChange) host.onChange(res);
      } catch (err) {
        out.className = "pm-msg-out bad";
        out.textContent = (err && err.message) || String(err);
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
