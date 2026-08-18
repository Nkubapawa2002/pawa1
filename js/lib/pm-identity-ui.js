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

  function attach(opts) {
    host = opts || {};
    if (host.backdrop) {
      host.backdrop.addEventListener("click", function (e) {
        if (e.target === host.backdrop) close();
      });
    }
  }

  function open(html) {
    if (!host || !host.panel) return;
    host.panel.innerHTML = html;
    host.backdrop.classList.add("is-on");
  }
  function close() {
    if (!host || !host.panel) return;
    host.backdrop.classList.remove("is-on");
    host.panel.innerHTML = "";
  }
  var $ = function (id) { return document.getElementById(id); };

  /**
   * Two numbers, side by side, to be read aloud.
   *
   * This dialog is the only defence against the one attack the scheme cannot
   * prevent on its own: public keys come from the same database that stores
   * the messages, so whoever controls it could hand you a key of their own.
   * Comparing twelve digits out of band is what closes that, and no amount of
   * cryptography can do it for two people.
   */
  function safetyNumbers(name, theirs) {
    open("<h2>" + esc(t("pm_verify_t", "Safety numbers")) + "</h2>" +
      "<p>" + esc(t("pm_verify_d", "Read these aloud to each other — on a call, or standing together. If they match, nobody has slipped between you. If they do not, stop and tell us.")) + "</p>" +
      "<label>" + esc(t("pm_verify_yours", "Yours")) + "</label>" +
      '<div class="pm-big-fp">' + esc(fp()) + "</div>" +
      (theirs ? "<label>" + esc(name || "") + '</label><div class="pm-big-fp">' + esc(theirs) + "</div>" : "") +
      '<div class="pm-modal-acts"><button class="pm-btn" id="pmFpOk">' + esc(t("pm_close", "Close")) + "</button></div>");
    $("pmFpOk").addEventListener("click", close);
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
      esc(t("pm_restore", "I have a backup code")) + "</button></p>");

    $("pmBkSkip").addEventListener("click", close);
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
  };
})();
