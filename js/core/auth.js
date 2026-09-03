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

  // ---- session and admin, asked once ---------------------------------------
  //
  // getSession() is called from 28 places and isDbAdmin() from 8, eight of them
  // on agent-houses.html alone. Neither remembered anything: every call went
  // back to the client, and every isDbAdmin() ran a SELECT against `admins`.
  //
  // Both are memoised now, and the ONLY thing that makes this safe is that the
  // cache is dropped the instant the session changes. A stale "yes" here is not
  // a slow page, it is somebody keeping admin after signing out, so:
  //
  //   · the admin entry is stamped with the access token it was computed under,
  //     and that token is read FRESH on every check, never from the session
  //     cache. Getting this wrong is not theoretical: comparing against the
  //     cached session meant the stamp compared a stale token with itself and
  //     matched every time, and a silently-changed identity kept the previous
  //     answer for a minute. See the note on isDbAdmin below.
  //   · signOut() clears both caches synchronously, before and after the call,
  //     rather than waiting for onAuthStateChange to fire.
  //   · onAuthStateChange clears them too, including a subscription of this
  //     module's own so a page that never calls onAuthChange() is still safe.
  //   · the TTLs are the last line, not the first.
  //
  // The single-flight is the same idea as the one in data.js: eight callers
  // asking "am I an admin" in the same tick is one query, not eight.
  const SESSION_TTL_MS = 5000;
  const ADMIN_TTL_MS = 60000;
  let sessionCache = null;      // { at, session }
  let sessionFlight = null;
  let adminCache = null;        // { at, token, value }
  let adminFlight = null;

  function tokenOf(session) {
    return (session && session.access_token) || null;
  }

  function forgetAuthCache() {
    sessionCache = null;
    sessionFlight = null;
    adminCache = null;
    adminFlight = null;
  }

  async function getSession(opts) {
    if (!sb) return null;
    const fresh = opts && opts.fresh;
    if (!fresh && sessionCache && Date.now() - sessionCache.at < SESSION_TTL_MS) {
      return sessionCache.session;
    }
    if (sessionFlight) return sessionFlight;
    sessionFlight = (async () => {
      try {
        const { data } = await sb.auth.getSession();
        const session = data.session || null;
        sessionCache = { at: Date.now(), session };
        return session;
      } catch (_) {
        // Not cached: a transient failure must not be remembered as "signed
        // out" for the length of a TTL.
        return null;
      } finally { sessionFlight = null; }
    })();
    return sessionFlight;
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
    // {fresh: true} on PURPOSE, and it is the whole correctness of this
    // function. The session cache is 5s and the admin cache is 60s, so asking
    // the cached session for the token meant a silently-changed identity kept
    // the previous answer for up to a minute: the token stamp below was
    // comparing a stale token against itself and always matching. A test
    // caught it doing exactly that.
    //
    // It costs nothing worth having. getSession() is a local read in
    // supabase-js; the expensive call here is the SELECT against `admins`, and
    // that is still cached, still single-flighted, and still the thing being
    // saved. Concurrent callers collapse into one lookup either way.
    const session = await getSession({ fresh: true });

    // The email decides. The token is only the CACHE STAMP, and the two must
    // not be conflated: an early version refused anybody whose session carried
    // no access_token, which turned a caching detail into an authorisation
    // rule and locked out every session shaped even slightly differently. A
    // session with no token is checked normally and simply not remembered.
    const email = session && session.user && session.user.email;
    if (!email || !isAllowedEmail(email)) { adminCache = null; return false; }

    const token = tokenOf(session);
    if (token && adminCache && adminCache.token === token &&
        Date.now() - adminCache.at < ADMIN_TTL_MS) {
      return adminCache.value;
    }
    if (adminFlight) return adminFlight;

    adminFlight = (async () => {
      try {
        const { data, error } = await sb.from("admins").select("email").limit(1);
        if (error) return false;                       // never cached
        const value = Array.isArray(data) && data.length > 0;
        // Only cached when there is a token to stamp it with, or the entry
        // could never be invalidated by an identity change.
        if (token) adminCache = { at: Date.now(), token, value };
        return value;
      } catch (_) {
        return false;
      } finally { adminFlight = null; }
    })();
    return adminFlight;
  }

  // ---- Password ------------------------------------------------------------
  async function signIn(email, password) {
    if (!sb) throw noClient();
    forgetAuthCache();
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
    forgetAuthCache();
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
    // Cleared BEFORE the call and again after. The listener above fires too,
    // but it is an event: relying on it alone leaves a window where a read
    // between signOut() and that callback still gets the old answer, and on
    // this path the old answer can be "yes, an admin".
    forgetAuthCache();
    try { await sb.auth.signOut(); } catch (_) {}
    forgetAuthCache();
  }

  function onAuthChange(cb) {
    if (!sb) return { unsubscribe() {} };
    return sb.auth.onAuthStateChange((_event, session) => {
      forgetAuthCache();
      cb(session);
    });
  }

  // And a subscription of our own, so the cache is cleared even on a page that
  // never calls onAuthChange(). Leaving invalidation to whoever happened to
  // subscribe is how a signed-out admin keeps their rights on one screen.
  if (sb && sb.auth && sb.auth.onAuthStateChange) {
    try { sb.auth.onAuthStateChange(() => forgetAuthCache()); } catch (_) {}
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
