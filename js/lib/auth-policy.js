// ============================================================================
//  auth-policy.js — the rules a sign-in screen enforces before it ever talks
//  to the network: is this an email, is this password worth having, and has
//  this browser been guessing at the same account all afternoon?
//
//  All three are pure functions over their inputs (the throttle takes its
//  storage as an argument), so tests/auth_policy_test.mjs can run them with no
//  DOM, no clock and no network.
//
//  What this is NOT: a substitute for the server. A browser-side lockout stops
//  a person mashing the button and a script pointed at the page; it does not
//  stop anyone who skips the page. The provider's own rate limiting is the
//  real fence. This one exists so an honest person who mistyped gets told to
//  slow down in words, instead of collecting 40 failures and a silent block.
// ============================================================================

(function () {
  "use strict";

  // ---- Email --------------------------------------------------------------
  // Deliberately permissive: the only authority on whether an address exists
  // is the email that gets delivered to it. This catches the typo class —
  // missing @, missing dot, trailing comma — and nothing else.
  var EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

  function normalizeEmail(v) {
    return String(v == null ? "" : v).trim().toLowerCase();
  }
  function isEmail(v) {
    return EMAIL_RE.test(normalizeEmail(v));
  }

  // ---- Password strength --------------------------------------------------
  var MIN_LEN = 8;
  var STRONG_LEN = 12;

  // The ones that get tried first, plus the local flavours a Tanzanian site
  // actually sees. Not a substitute for a breach list — a floor.
  var COMMON = [
    "password", "passw0rd", "12345678", "123456789", "1234567890", "qwerty",
    "qwertyui", "abc12345", "11111111", "00000000", "iloveyou", "sunshine",
    "princess", "football", "baseball", "welcome1", "admin123", "letmein",
    "monkey12", "dragon12", "trustno1", "maisha123", "lifeza123", "tanzania",
    "habari123", "mambo123", "jambo123", "karibu123", "salama123", "asante123",
  ];

  /**
   * Score a password 0–4 and say exactly which requirements it has met, so the
   * UI can show a checklist rather than a bar the person cannot argue with.
   *
   * @param {string} pw
   * @param {string} [email]  the address being registered — a password that
   *                          contains it is worthless, however long it is.
   * @returns {{score:number, label:string, ok:boolean, checks:object, failed:string}}
   */
  function scorePassword(pw, email) {
    var s = String(pw == null ? "" : pw);
    var local = normalizeEmail(email).split("@")[0];
    var lower = s.toLowerCase();

    var checks = {
      length: s.length >= MIN_LEN,
      letter: /[a-z]/i.test(s),
      number: /\d/.test(s),
      mixed: /[a-z]/.test(s) && /[A-Z]/.test(s),
      symbol: /[^\w\s]/.test(s),
      long: s.length >= STRONG_LEN,
      // A password that is a run of one character, or a straight keyboard/number
      // run, is length without entropy.
      varied: !/^(.)\1+$/.test(s) && !/^(0123456789|1234567890|abcdefgh|qwertyui)/i.test(lower),
      notCommon: !COMMON.some(function (c) { return lower === c || lower.indexOf(c) === 0; }),
      notEmail: !(local.length >= 3 && lower.indexOf(local) >= 0),
    };

    // The four hard requirements. Everything else only moves the score.
    var required = checks.length && checks.letter && checks.number &&
      checks.varied && checks.notCommon && checks.notEmail;

    var score = 0;
    if (s.length >= 6) score = 1;
    if (required) score = 2;
    if (required && (checks.mixed || checks.symbol) && s.length >= 10) score = 3;
    if (required && checks.mixed && checks.symbol && checks.long) score = 4;
    if (!checks.varied || !checks.notCommon || !checks.notEmail) score = Math.min(score, 1);
    if (!s) score = 0;

    // The single most useful thing to say about why it isn't accepted yet.
    var failed = "";
    if (!s) failed = "empty";
    else if (!checks.length) failed = "length";
    else if (!checks.notCommon) failed = "common";
    else if (!checks.varied) failed = "varied";
    else if (!checks.notEmail) failed = "email";
    else if (!checks.letter) failed = "letter";
    else if (!checks.number) failed = "number";

    var LABELS = ["", "weak", "fair", "good", "strong"];
    return { score: score, label: LABELS[score] || "", ok: required, checks: checks, failed: failed };
  }

  // ---- Failed-attempt throttle -------------------------------------------
  // Failures are recorded per identifier (the email being tried) so one
  // person's fat fingers do not lock out a shared device, and are kept in
  // localStorage so a page reload is not a reset.
  var THROTTLE = {
    key: "pawa-auth-attempts",
    max: 5,           // failures allowed inside the window
    windowMs: 15 * 60 * 1000,
    // Escalating cool-offs, in seconds, by how many times we have locked out.
    steps: [30, 60, 300, 900],
    maxEntries: 20,   // never let the record grow without bound
  };

  function readAll(store) {
    try {
      var raw = store && store.getItem(THROTTLE.key);
      var obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === "object" ? obj : {};
    } catch (_) { return {}; }
  }

  function writeAll(store, obj) {
    try {
      // Drop the oldest entries rather than growing forever.
      var keys = Object.keys(obj);
      if (keys.length > THROTTLE.maxEntries) {
        keys.sort(function (a, b) { return (obj[a].at || 0) - (obj[b].at || 0); });
        keys.slice(0, keys.length - THROTTLE.maxEntries).forEach(function (k) { delete obj[k]; });
      }
      store && store.setItem(THROTTLE.key, JSON.stringify(obj));
    } catch (_) {}
  }

  function bucketKey(id) {
    return normalizeEmail(id) || "_";
  }

  /**
   * How this identifier stands right now.
   * @returns {{locked:boolean, secondsLeft:number, fails:number, remaining:number}}
   */
  function attemptState(store, id, now) {
    var t = now == null ? Date.now() : now;
    var all = readAll(store);
    var e = all[bucketKey(id)];
    if (!e) return { locked: false, secondsLeft: 0, fails: 0, remaining: THROTTLE.max };
    if (e.until && e.until > t) {
      return { locked: true, secondsLeft: Math.ceil((e.until - t) / 1000), fails: e.fails || 0, remaining: 0 };
    }
    // Failures older than the window no longer count against anyone.
    var fails = (e.at && t - e.at > THROTTLE.windowMs) ? 0 : (e.fails || 0);
    return { locked: false, secondsLeft: 0, fails: fails, remaining: Math.max(0, THROTTLE.max - fails) };
  }

  /** Record a failure; returns the new state (possibly locked). */
  function recordFailure(store, id, now) {
    var t = now == null ? Date.now() : now;
    var all = readAll(store);
    var k = bucketKey(id);
    var e = all[k] || { fails: 0, locks: 0, at: t, until: 0 };
    if (e.at && t - e.at > THROTTLE.windowMs) e.fails = 0;   // window rolled over
    e.fails = (e.fails || 0) + 1;
    e.at = t;
    if (e.fails >= THROTTLE.max) {
      var step = THROTTLE.steps[Math.min(e.locks || 0, THROTTLE.steps.length - 1)];
      e.until = t + step * 1000;
      e.locks = (e.locks || 0) + 1;
      e.fails = 0;                                            // the lock replaces the count
    }
    all[k] = e;
    writeAll(store, all);
    return attemptState(store, id, t);
  }

  /** A success wipes the record for that identifier. */
  function recordSuccess(store, id) {
    var all = readAll(store);
    delete all[bucketKey(id)];
    writeAll(store, all);
  }

  /** Force a cool-off the server asked for (a 429 with a Retry-After). */
  function lockFor(store, id, seconds, now) {
    var t = now == null ? Date.now() : now;
    var all = readAll(store);
    var k = bucketKey(id);
    var e = all[k] || { fails: 0, locks: 0 };
    e.at = t;
    e.until = Math.max(e.until || 0, t + Math.max(1, seconds) * 1000);
    all[k] = e;
    writeAll(store, all);
    return attemptState(store, id, t);
  }

  var API = {
    isEmail: isEmail,
    normalizeEmail: normalizeEmail,
    scorePassword: scorePassword,
    attemptState: attemptState,
    recordFailure: recordFailure,
    recordSuccess: recordSuccess,
    lockFor: lockFor,
    MIN_LEN: MIN_LEN,
    THROTTLE: THROTTLE,
  };

  if (typeof window !== "undefined") window.AuthPolicy = API;
  if (typeof globalThis !== "undefined") globalThis.AuthPolicy = API;
})();
