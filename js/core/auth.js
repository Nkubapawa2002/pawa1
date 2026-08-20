// =====================================================
// Auth helper — the one place the app talks to the identity provider.
//
// Every method either resolves with what was asked for, or throws an error
// object that js/lib/auth-errors.js knows how to turn into a sentence. It
// never throws a sentence of its own that names the provider: the code below
// carries codes ("unavailable"), and the words live in auth-errors.js, so
// there is exactly one place to audit for leaks.
//
// Admin gating still lives here: only emails in APP_CONFIG.ADMIN_EMAILS AND
// present in the `admins` table can pass isDbAdmin().
// =====================================================

window.Auth = (() => {
  const sb = window.SB || (window.DataStore && window.DataStore.sb);
  const cfg = window.APP_CONFIG || {};

  // Thrown when there is no client at all (bad config, blocked CDN, offline
  // first load). `code` is what auth-errors.js reads; the message is a
  // developer note that must never be rendered.
  function noClient() {
    const e = new Error("auth client unavailable");
    e.code = "email_provider_disabled";   // → "temporarily unavailable"
    return e;
  }

  // Where confirmation / recovery links come back to. Same-origin by
  // construction, so it cannot be turned into an open redirect.
  function callbackUrl() {
    try { return location.origin + location.pathname.replace(/[^/]*$/, "login.html"); }
    catch (_) { return ""; }
  }

  async function getSession() {
    if (!sb) return null;
    try {
      const { data } = await sb.auth.getSession();
      return data.session || null;
    } catch (_) { return null; }
  }

  async function currentEmail() {
    const s = await getSession();
    return s?.user?.email || null;
  }

  function isAllowedEmail(email) {
    const list = (cfg.ADMIN_EMAILS || []).map(e => e.toLowerCase().trim());
    return !!email && list.includes(email.toLowerCase().trim());
  }

  // Verifies the email is also in the `admins` DB table (RLS-protected).
  async function isDbAdmin() {
    if (!sb) return false;
    const email = await currentEmail();
    if (!email || !isAllowedEmail(email)) return false;
    const { data, error } = await sb.from("admins").select("email").limit(1);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  }

  // ---- Password ------------------------------------------------------------
  async function signIn(email, password) {
    if (!sb) throw noClient();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  }

  async function signUp(email, password, meta) {
    if (!sb) throw noClient();
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { emailRedirectTo: callbackUrl(), data: meta || undefined },
    });
    if (error) throw error;
    // With email confirmation on, `session` is null and `user` is pending.
    return { session: data.session || null, user: data.user || null,
             needsConfirmation: !data.session };
  }

  async function resendConfirmation(email) {
    if (!sb) throw noClient();
    const { error } = await sb.auth.resend({
      type: "signup", email, options: { emailRedirectTo: callbackUrl() },
    });
    if (error) throw error;
    return true;
  }

  // ---- Passwordless: a six-digit code by email -----------------------------
  // shouldCreateUser is false for sign-in so this cannot be used to conjure
  // accounts for addresses the person does not control, and true for sign-up.
  async function sendCode(email, { createUser = false } = {}) {
    if (!sb) throw noClient();
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: !!createUser, emailRedirectTo: callbackUrl() },
    });
    if (error) throw error;
    return true;
  }

  async function verifyCode(email, token, type) {
    if (!sb) throw noClient();
    const { data, error } = await sb.auth.verifyOtp({
      email, token: String(token || "").trim(), type: type || "email",
    });
    if (error) throw error;
    return data.session;
  }

  // ---- Recovery ------------------------------------------------------------
  async function sendReset(email) {
    if (!sb) throw noClient();
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: callbackUrl() });
    if (error) throw error;
    return true;
  }

  async function updatePassword(password) {
    if (!sb) throw noClient();
    const { error } = await sb.auth.updateUser({ password });
    if (error) throw error;
    return true;
  }

  // ---- Guest ---------------------------------------------------------------
  // A real authenticated session with no identity attached. The database
  // fences it separately (app_is_guest()); this only opens the door.
  async function signInAsGuest() {
    if (!sb) throw noClient();
    const { data, error } = await sb.auth.signInAnonymously();
    if (error) throw error;
    return data.session;
  }

  async function signOut() {
    if (!sb) return;
    try { await sb.auth.signOut(); } catch (_) {}
  }

  function onAuthChange(cb) {
    if (!sb) return { unsubscribe() {} };
    return sb.auth.onAuthStateChange((_event, session) => cb(session));
  }

  // True only when the client in this browser actually implements passkeys.
  // The account system may have them enabled while the shipped client build
  // does not expose them — offering a button that cannot work is worse than
  // not offering one.
  function supportsPasskeys() {
    try {
      return !!(sb && sb.auth && typeof sb.auth.signInWithWebAuthn === "function" &&
        typeof window.PublicKeyCredential === "function");
    } catch (_) { return false; }
  }

  // Whether sign-in is possible at all right now. The UI asks before it draws
  // a form the person cannot use.
  function isReady() { return !!sb; }

  return {
    getSession, currentEmail, isAllowedEmail, isDbAdmin,
    signIn, signUp, resendConfirmation,
    sendCode, verifyCode,
    sendReset, updatePassword,
    signInAsGuest, signOut, onAuthChange,
    supportsPasskeys, isReady, callbackUrl,
  };
})();
