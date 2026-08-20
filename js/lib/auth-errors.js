// ============================================================================
//  auth-errors.js — turn a raw auth failure into something a person can act on,
//  without ever naming the machinery behind it.
//
//  Two jobs, and the second one is the important one:
//
//  1. CLASSIFY. Every provider failure gets mapped to one of a fixed set of
//     codes, from the provider's own error code where it has one and from the
//     message text where it doesn't. Anything unrecognised is `unknown`.
//
//  2. REDACT. The UI never renders a raw error string. A raw string is how a
//     sign-in box ends up telling the public which database vendor, which
//     table, which auth server and which policy engine sit behind it — and
//     that is a free reconnaissance report for anyone probing the site. Every
//     code maps to a sentence WE wrote; `unknown` maps to a generic apology.
//     redact() is the last line of defence for text that reaches the UI by
//     some other path.
//
//  Pure and dependency-free on purpose: tests/auth_errors_test.mjs runs it with
//  no DOM. Uses window.t() for translation when it is there, and falls back to
//  the English string baked in here when it is not.
// ============================================================================

(function () {
  "use strict";

  // Words that must never reach a user's screen. Vendor names, protocol names,
  // internal object names — anything that answers "what is this built on?".
  var VENDOR = /\b(supabase|gotrue|postgrest|pgrst|postgres(ql)?|pg_?[a-z]+|row[- ]level security|\brls\b|service[_ ]role|anon key|jwt|jwk|bearer token|refresh[_ ]token|access[_ ]token|clerk|edge function|rpc|relation "[^"]*"|schema "[^"]*"|auth\.users|public\.[a-z_]+)\b/i;

  // code → the English sentence + the i18n key that overrides it.
  // Every sentence tells the person what to DO next, and none of them mention
  // anything the person did not already know about the site.
  var MESSAGES = {
    invalid_credentials: ["auth_err_credentials",
      "That email and password don't match. Check them and try again."],
    email_not_confirmed: ["auth_err_unconfirmed",
      "Your email isn't confirmed yet. Open the confirmation link we sent you, or ask for a new one."],
    user_already_exists: ["auth_err_exists",
      "There's already an account with that email. Sign in instead, or reset the password."],
    weak_password: ["auth_err_weak",
      "That password is too easy to guess. Use at least 8 characters with a mix of letters and numbers."],
    same_password: ["auth_err_same_password",
      "Your new password has to be different from the old one."],
    otp_expired: ["auth_err_code_expired",
      "That code has expired. Ask for a new one and enter it within the hour."],
    otp_invalid: ["auth_err_code_invalid",
      "That code isn't right. Check the six digits and try again."],
    rate_limited: ["auth_err_rate",
      "Too many attempts. Wait a moment before trying again."],
    email_rate_limited: ["auth_err_email_rate",
      "We've sent several emails to that address already. Give it a few minutes before asking for another."],
    invalid_email: ["auth_err_email",
      "That doesn't look like a complete email address."],
    signup_disabled: ["auth_err_signup_off",
      "New accounts are paused right now. Please try again later."],
    guest_disabled: ["auth_err_guest_off",
      "Guest browsing isn't available right now. Sign in or create an account to continue."],
    session_expired: ["auth_err_session",
      "You've been signed out. Sign in again to continue."],
    offline: ["auth_err_offline",
      "We can't reach the network. Check your connection and try again."],
    unavailable: ["auth_err_unavailable",
      "Sign-in is temporarily unavailable. Please try again in a few minutes."],
    unknown: ["auth_err_unknown",
      "Something went wrong on our side. Please try again."],
  };

  // Provider error codes we recognise, mapped onto ours. Checked first,
  // because a code is stable and a message string is not.
  var BY_CODE = {
    invalid_credentials: "invalid_credentials",
    email_not_confirmed: "email_not_confirmed",
    user_already_exists: "user_already_exists",
    email_exists: "user_already_exists",
    user_banned: "invalid_credentials",
    weak_password: "weak_password",
    same_password: "same_password",
    otp_expired: "otp_expired",
    otp_disabled: "unavailable",
    over_request_rate_limit: "rate_limited",
    over_email_send_rate_limit: "email_rate_limited",
    over_sms_send_rate_limit: "rate_limited",
    signup_disabled: "signup_disabled",
    email_provider_disabled: "unavailable",
    anonymous_provider_disabled: "guest_disabled",
    validation_failed: "invalid_email",
    bad_json: "unknown",
    session_not_found: "session_expired",
    session_expired: "session_expired",
    refresh_token_not_found: "session_expired",
    refresh_token_already_used: "session_expired",
    no_authorization: "session_expired",
    request_timeout: "offline",
  };

  // Fallback: match on the message text. Ordered — first hit wins.
  var BY_TEXT = [
    [/invalid login credentials|invalid email or password/i, "invalid_credentials"],
    [/email not confirmed|email address not confirmed/i, "email_not_confirmed"],
    [/already registered|already exists|duplicate key/i, "user_already_exists"],
    [/password should be|password is too (weak|short)|at least \d+ characters/i, "weak_password"],
    [/should be different from the old/i, "same_password"],
    [/token has expired|otp[_ ]expired|code has expired/i, "otp_expired"],
    [/invalid (token|otp|code)|token not found/i, "otp_invalid"],
    [/email rate limit/i, "email_rate_limited"],
    [/rate limit|too many requests/i, "rate_limited"],
    [/unable to validate email|invalid format|valid email/i, "invalid_email"],
    [/signups? (are )?(not allowed|disabled)/i, "signup_disabled"],
    [/anonymous sign-?ins? are disabled/i, "guest_disabled"],
    [/(refresh|access) token|session (from session id )?not found|jwt expired/i, "session_expired"],
    [/failed to fetch|networkerror|network request failed|load failed|err_internet/i, "offline"],
    [/not configured|no client|unavailable|503|502|504/i, "unavailable"],
  ];

  function textOf(err) {
    if (!err) return "";
    if (typeof err === "string") return err;
    return String(err.message || err.msg || err.error_description || err.error || "");
  }

  function statusOf(err) {
    if (!err || typeof err !== "object") return 0;
    var n = Number(err.status || err.statusCode || err.code);
    return isFinite(n) ? n : 0;
  }

  /**
   * The stable code for a failure. Never throws, always returns a key that
   * exists in MESSAGES.
   */
  function code(err) {
    if (!err) return "unknown";
    // The browser being offline beats whatever the error object says.
    if (typeof navigator !== "undefined" && navigator && navigator.onLine === false) return "offline";

    var raw = typeof err === "object" ? String(err.code || err.error_code || "") : "";
    if (raw && Object.prototype.hasOwnProperty.call(BY_CODE, raw)) return BY_CODE[raw];

    var status = statusOf(err);
    if (status === 429) return "rate_limited";

    var text = textOf(err);
    for (var i = 0; i < BY_TEXT.length; i++) {
      if (BY_TEXT[i][0].test(text)) return BY_TEXT[i][1];
    }

    if (status === 401 || status === 403) return "invalid_credentials";
    if (status >= 500) return "unavailable";
    return "unknown";
  }

  /**
   * Strip anything that names the machinery. Used as a net under text that
   * did not come through message() — a caller's own string, a library's
   * label. If a forbidden word is anywhere in it, the whole string is
   * replaced rather than patched: a half-redacted sentence still leaks
   * shape, and a sentence with a hole in it reads as a bug.
   */
  function redact(s) {
    var str = String(s == null ? "" : s);
    if (!str) return "";
    return VENDOR.test(str) ? message("unknown") : str;
  }

  /** True when this text would leak the machinery. For tests and guards. */
  function leaks(s) {
    return VENDOR.test(String(s == null ? "" : s));
  }

  /**
   * The sentence to show. Accepts an error object, or one of our codes
   * directly. Falls back to English when i18n is not loaded.
   */
  function message(errOrCode) {
    var key = (typeof errOrCode === "string" && MESSAGES[errOrCode])
      ? errOrCode
      : code(errOrCode);
    var pair = MESSAGES[key] || MESSAGES.unknown;
    var translated = null;
    try {
      if (typeof window !== "undefined" && typeof window.t === "function") {
        var got = window.t(pair[0]);
        // window.t() returns the key itself when it has no translation.
        if (got && got !== pair[0]) translated = got;
      }
    } catch (_) {}
    var out = translated || pair[1];
    // Belt and braces: a bad translation must not become a leak.
    return leaks(out) ? pair[1] : out;
  }

  /**
   * Seconds the caller should wait before retrying, when the provider says so.
   * Reads Retry-After style hints; 0 when there is none.
   */
  function retryAfter(err) {
    if (!err || typeof err !== "object") return 0;
    var v = err.retryAfter || err.retry_after ||
      (err.headers && typeof err.headers.get === "function" ? err.headers.get("retry-after") : null);
    var n = parseInt(v, 10);
    if (isFinite(n) && n > 0) return Math.min(n, 3600);
    // "For security purposes, you can only request this after 47 seconds."
    var m = /after (\d+) seconds?/i.exec(textOf(err));
    return m ? Math.min(parseInt(m[1], 10), 3600) : 0;
  }

  /**
   * Whether this failure means "the thing you asked for didn't happen because
   * of you" (show it on the field) rather than "our side broke" (show it as a
   * banner). Drives which surface the message lands on.
   */
  function isUserFixable(errOrCode) {
    var key = (typeof errOrCode === "string" && MESSAGES[errOrCode]) ? errOrCode : code(errOrCode);
    return ["invalid_credentials", "email_not_confirmed", "user_already_exists",
      "weak_password", "same_password", "otp_expired", "otp_invalid",
      "invalid_email"].indexOf(key) >= 0;
  }

  var API = { code: code, message: message, redact: redact, leaks: leaks,
    retryAfter: retryAfter, isUserFixable: isUserFixable, MESSAGES: MESSAGES };

  if (typeof window !== "undefined") window.AuthErrors = API;
  if (typeof globalThis !== "undefined") globalThis.AuthErrors = API;
})();
