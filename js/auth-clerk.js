// =====================================================================
// auth-clerk.js — Clerk identity, wired as Supabase's THIRD-PARTY issuer.
// ---------------------------------------------------------------------
// Loaded by js/config.js ONLY when CLERK_PUBLISHABLE_KEY + CLERK_DOMAIN are set.
// It loads Clerk (buildless, from your Clerk Frontend API) and REPLACES
// window.Auth with a Clerk-backed implementation that mirrors the Supabase one
// (js/auth.js), so login.js and the dashboard gates keep calling the same API.
//
// Headless on purpose: it drives Clerk's client API directly so the custom
// css/auth.css UI is preserved (no Clerk prebuilt widgets).
//
// PHASE-2 NOTES (need your Clerk instance to finish & test — see
// docs/CLERK_SETUP.md):
//   • Email sign-up needs a verification step (collect the emailed code).
//   • MFA / second-factor sign-in needs a small UI.
//   • Pages that read the session at load (login.js) should re-run on the
//     "clerk-ready" event this file dispatches.
//   • Existing rows store Supabase user UUIDs in owner_user_id; Clerk ids look
//     different, so ownership of pre-Clerk data must be migrated.
// =====================================================================
(function () {
  var cfg = window.APP_CONFIG || {};
  var PK = cfg.CLERK_PUBLISHABLE_KEY, DOMAIN = cfg.CLERK_DOMAIN;
  if (!PK || !DOMAIN) return;

  var s = document.createElement("script");
  s.async = true;
  s.crossOrigin = "anonymous";
  s.setAttribute("data-clerk-publishable-key", PK);
  s.src = "https://" + DOMAIN + "/npm/@clerk/clerk-js@5/dist/clerk.browser.js";
  s.addEventListener("load", init);
  s.addEventListener("error", function () { console.error("[clerk] failed to load bundle from " + DOMAIN); });
  document.head.appendChild(s);

  // Map Clerk's state into the minimal session shape the app expects
  // (session.user.id / session.user.email), mirroring the Supabase session.
  function mapSession() {
    var c = window.Clerk;
    if (!c || !c.user || !c.session) return null;
    var email = "";
    try { email = c.user.primaryEmailAddress ? c.user.primaryEmailAddress.emailAddress : ""; } catch (_) {}
    return { user: { id: c.user.id, email: email }, clerk: true };
  }

  // Same shape, but with the Clerk JWT attached as `access_token` — needed by
  // call sites that hit an Edge Function directly (e.g. dashboard.js sends
  // `Bearer session.access_token`). getToken() is async, so this is too.
  async function mapSessionWithToken() {
    var s = mapSession();
    if (!s) return null;
    var tpl = cfg.CLERK_JWT_TEMPLATE || null;   // role+email claims for Supabase RLS
    try { s.access_token = (await window.Clerk.session.getToken(tpl ? { template: tpl } : undefined)) || null; }
    catch (_) { s.access_token = null; }
    return s;
  }

  // Shared modal that collects a verification code (and optionally a new
  // password). Used by signIn (Client Trust / 2FA), signUp (email verification)
  // and resetPassword — so EVERY page's auth works without its own code UI.
  // Contract: opts.onSubmit(code, password) does the Clerk attempt; throw to
  // show an inline error and keep the modal open; resolve to close. Resolves the
  // returned promise with onSubmit's value, or null if the user cancels.
  function authCodePrompt(opts) {
    opts = opts || {};
    var esc = window.escHtml || function (s) { return String(s == null ? "" : s); };
    return new Promise(function (resolve) {
      var ov = document.createElement("div");
      ov.setAttribute("role", "dialog"); ov.setAttribute("aria-modal", "true");
      ov.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,.62);padding:20px";
      var card = document.createElement("div");
      card.style.cssText = "background:#fff;color:#0f172a;max-width:390px;width:100%;border-radius:16px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.35);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
      card.innerHTML =
        '<h2 style="margin:0 0 6px;font-size:1.15rem">' + esc(opts.title || "Enter your code") + '</h2>' +
        '<p style="margin:0 0 14px;color:#475569">' + (opts.message || "") + '</p>' +
        '<input id="_acpCode" inputmode="numeric" autocomplete="one-time-code" placeholder="Verification code" style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font-size:1rem;margin-bottom:10px" />' +
        (opts.needPassword ? '<input id="_acpPw" type="password" autocomplete="new-password" placeholder="New password (min 8 chars)" style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font-size:1rem;margin-bottom:10px" />' : '') +
        '<div id="_acpMsg" style="min-height:18px;color:#b91c1c;font-size:.86rem;margin:0 0 8px"></div>' +
        '<button id="_acpSubmit" style="width:100%;padding:11px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-weight:600;font-size:1rem;cursor:pointer">' + esc(opts.submitLabel || "Verify") + '</button>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px">' +
          (opts.onResend ? '<button id="_acpResend" style="background:none;border:0;color:#2563eb;cursor:pointer;font-size:.9rem;padding:4px">Resend code</button>' : '<span></span>') +
          '<button id="_acpCancel" style="background:none;border:0;color:#64748b;cursor:pointer;font-size:.9rem;padding:4px">Cancel</button>' +
        '</div>';
      ov.appendChild(card); document.body.appendChild(ov);
      var $ = function (id) { return card.querySelector(id); };
      var codeEl = $("#_acpCode"), pwEl = $("#_acpPw"), msgEl = $("#_acpMsg");
      var submitBtn = $("#_acpSubmit"), resendBtn = $("#_acpResend"), cancelBtn = $("#_acpCancel");
      setTimeout(function () { try { codeEl.focus(); } catch (_) {} }, 30);
      function done(val) { try { ov.remove(); } catch (_) {} resolve(val); }
      function setMsg(t, ok) { msgEl.style.color = ok ? "#15803d" : "#b91c1c"; msgEl.textContent = t || ""; }
      async function doSubmit() {
        var code = (codeEl.value || "").trim();
        if (!code) { setMsg("Enter the code from your email."); return; }
        submitBtn.disabled = true; submitBtn.textContent = "Verifying…"; setMsg("");
        try { done((await opts.onSubmit(code, pwEl ? pwEl.value : undefined)) || true); }
        catch (e) { setMsg((e && e.message) || "That didn't work — try again."); submitBtn.disabled = false; submitBtn.textContent = esc(opts.submitLabel || "Verify"); }
      }
      submitBtn.addEventListener("click", doSubmit);
      card.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); doSubmit(); } });
      if (resendBtn) resendBtn.addEventListener("click", async function () {
        resendBtn.disabled = true; setMsg("Sending a new code…", true);
        try { await opts.onResend(); setMsg("A new code is on its way.", true); }
        catch (_) { setMsg("Couldn't resend — try again."); }
        setTimeout(function () { resendBtn.disabled = false; }, 3000);
      });
      cancelBtn.addEventListener("click", function () { done(null); });
      ov.addEventListener("click", function (e) { if (e.target === ov) done(null); });
    });
  }

  async function init() {
    try { await window.Clerk.load(); }
    catch (e) { console.error("[clerk] load failed", e); return; }
    var Clerk = window.Clerk;

    var esc = window.escHtml || function (s) { return String(s == null ? "" : s); };

    // Resolve a non-"complete" sign-in: finish it directly, or run the shared
    // code modal (Clerk "Client Trust" on a new device, or a real 2nd factor).
    async function finishSignIn(res, email) {
      if (res.status === "complete") {
        await Clerk.setActive({ session: res.createdSessionId });
        return mapSessionWithToken();
      }
      var stage, prep;
      if (res.status === "needs_second_factor" || res.status === "needs_client_trust") {
        var f = (res.supportedSecondFactors || []).find(function (x) { return x.strategy === "email_code"; });
        if (!f) throw new Error("This account needs a verification method that isn't supported here yet.");
        stage = "second";
        prep = function () { return Clerk.client.signIn.prepareSecondFactor(f.emailAddressId ? { strategy: "email_code", emailAddressId: f.emailAddressId } : { strategy: "email_code" }); };
      } else if (res.status === "needs_first_factor") {
        var ff = (res.supportedFirstFactors || []).find(function (x) { return x.strategy === "email_code"; });
        if (!ff) throw new Error("Wrong email or password.");
        stage = "first";
        prep = function () { return Clerk.client.signIn.prepareFirstFactor(ff.emailAddressId ? { strategy: "email_code", emailAddressId: ff.emailAddressId } : { strategy: "email_code" }); };
      } else {
        throw new Error("Additional verification (" + res.status + ") is required. See docs/CLERK_SETUP.md.");
      }
      await prep();
      var session = await authCodePrompt({
        title: "Verify it's you",
        message: "For your security, enter the code we emailed to <b>" + esc(email) + "</b>.",
        onResend: prep,
        onSubmit: async function (code) {
          var ar = stage === "first"
            ? await Clerk.client.signIn.attemptFirstFactor({ strategy: "email_code", code: code })
            : await Clerk.client.signIn.attemptSecondFactor({ strategy: "email_code", code: code });
          if (ar.status !== "complete") throw new Error("That code wasn't accepted — try again.");
          await Clerk.setActive({ session: ar.createdSessionId });
          return mapSessionWithToken();
        },
      });
      if (!session) throw new Error("Sign-in cancelled.");
      return session;
    }

    var ClerkAuth = {
      async getSession() { return mapSessionWithToken(); },
      async currentEmail() { var s = mapSession(); return s ? s.user.email : null; },
      isAllowedEmail: function (email) {
        var list = (cfg.ADMIN_EMAILS || []).map(function (e) { return e.toLowerCase().trim(); });
        return !!email && list.indexOf(String(email).toLowerCase().trim()) !== -1;
      },
      async isDbAdmin() {
        var sb = window.SB || (window.DataStore && window.DataStore.sb);
        var email = await ClerkAuth.currentEmail();
        if (!sb || !email || !ClerkAuth.isAllowedEmail(email)) return false;
        var res = await sb.from("admins").select("email").limit(1);
        return !res.error && Array.isArray(res.data) && res.data.length > 0;
      },
      // Returns a session, throws on bad credentials, or runs the code modal
      // transparently (new-device Client Trust / 2FA) — callers just get a session.
      async signIn(email, password) {
        var res = await Clerk.client.signIn.create({ identifier: email, password: password });
        return finishSignIn(res, email);
      },
      // Creates the account; if Clerk requires email verification, the shared
      // code modal collects it and completes — returns a session either way.
      async signUp(email, password) {
        var su = await Clerk.client.signUp.create({ emailAddress: email, password: password });
        if (su.status === "complete") {
          await Clerk.setActive({ session: su.createdSessionId });
          return mapSessionWithToken();
        }
        await Clerk.client.signUp.prepareEmailAddressVerification({ strategy: "email_code" });
        var session = await authCodePrompt({
          title: "Confirm your email",
          message: "Enter the code we emailed to <b>" + esc(email) + "</b> to finish creating your account.",
          onResend: function () { return Clerk.client.signUp.prepareEmailAddressVerification({ strategy: "email_code" }); },
          onSubmit: async function (code) {
            var ar = await Clerk.client.signUp.attemptEmailAddressVerification({ code: code });
            if (ar.status !== "complete") throw new Error("That code wasn't accepted — try again.");
            await Clerk.setActive({ session: ar.createdSessionId });
            return mapSessionWithToken();
          },
        });
        if (!session) throw new Error("Sign-up cancelled.");
        return session;
      },
      // Forgot password: Clerk emails a reset code; the modal collects code + new
      // password and signs the user in. Returns a session, or null if cancelled.
      async resetPassword(email) {
        var res = await Clerk.client.signIn.create({ identifier: email });
        var ff = (res.supportedFirstFactors || []).find(function (x) { return x.strategy === "reset_password_email_code"; });
        if (!ff) throw new Error("Password reset isn't available for this account.");
        var prep = function () { return Clerk.client.signIn.prepareFirstFactor(ff.emailAddressId ? { strategy: "reset_password_email_code", emailAddressId: ff.emailAddressId } : { strategy: "reset_password_email_code" }); };
        await prep();
        return authCodePrompt({
          title: "Reset your password",
          message: "Enter the code we emailed to <b>" + esc(email) + "</b> and choose a new password.",
          needPassword: true, submitLabel: "Reset password",
          onResend: prep,
          onSubmit: async function (code, newPassword) {
            if (!newPassword || newPassword.length < 8) throw new Error("Use at least 8 characters for the new password.");
            var ar = await Clerk.client.signIn.attemptFirstFactor({ strategy: "reset_password_email_code", code: code, password: newPassword });
            if (ar.status === "needs_second_factor") throw new Error("This account has 2FA — finish reset in the Clerk account portal.");
            if (ar.status !== "complete") throw new Error("That code wasn't accepted — try again.");
            await Clerk.setActive({ session: ar.createdSessionId });
            return mapSessionWithToken();
          },
        });
      },
      async signOut() { try { await Clerk.signOut(); } catch (_) {} },
      onAuthChange: function (cb) {
        var unsub = Clerk.addListener(function () { cb(mapSession()); });
        return { unsubscribe: typeof unsub === "function" ? unsub : function () {} };
      },
    };

    // Swap the Supabase-backed facade for the Clerk one. The sb.auth shim lives
    // in js/data.js (single source of truth) and delegates here via window.Auth,
    // so we don't replace sb.auth from this file anymore.
    window.Auth = ClerkAuth;

    // Let pages that read the session at load re-run now that auth is ready
    // (and the data.js sb.auth shim resolves its _clerkReady gate).
    window.dispatchEvent(new Event("clerk-ready"));

    var s2 = mapSession();
    if (s2 && window.Analytics) window.Analytics.identify(s2.user.id, { email: s2.user.email });
  }
})();
