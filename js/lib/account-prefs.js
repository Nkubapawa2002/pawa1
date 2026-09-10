// ============================================================================
//  account-prefs.js — window.AccountPrefs
//
//  "Each type of account should be shown things in its own preferences."
//
//  WHAT AN ACCOUNT TYPE IS HERE, AND WHAT IT IS NOT
//  Nobody in this app is assigned a type. A person who lists a house is a house
//  owner; if they later post a truck they are that too, and they never stopped
//  being somebody looking for a room. So a type is not a field on a row and
//  must not become one: it is DERIVED from what the account has actually
//  listed, exactly the way P-Message derives it (pm_owner_listings, four arms,
//  one per catalogue).
//
//  That derivation is why this file takes the counts as an argument rather than
//  fetching them. The caller already knows — Profile has them on screen — and a
//  library that went and asked again would be a second answer to a question
//  that already had one.
//
//  WHERE THE ANSWERS LIVE
//  localStorage, keyed by the signed-in user id, the same shape and for the
//  same reasons as js/lib/pm-trust.js and js/lib/pm-hidden.js:
//
//   · a preference is not a fact about the world, it is a fact about how one
//     person wants their screen arranged, and it changes nothing anybody else
//     can see. Putting it in Postgres would mean a table, a policy, a
//     migration and a round trip, for a value only this device reads.
//   · it survives a sign-out and comes back, because the key is the user id.
//   · a guest gets their own bucket, which is destroyed with the session, and
//     that is the right lifetime for a guest's window dressing.
//
//  It is NOT the place for anything that must be true on another device. If a
//  preference ever needs to follow somebody to a new phone, it belongs in the
//  database and this file is the wrong home for it.
//
//  Pure except for storage: no DOM, no network.
// ============================================================================
(function () {
  "use strict";

  var KEY = "pawa-prefs-v1";

  // The four catalogues, and the fifth thing everybody is. `seeker` has no
  // listing behind it because it is what an account is before it lists
  // anything, and remains while it lists everything.
  var TYPES = [
    { key: "houses",   count: "houses",   i18n: "pref_t_houses" },
    { key: "services", count: "services", i18n: "pref_t_services" },
    { key: "trucks",   count: "trucks",   i18n: "pref_t_trucks" },
    { key: "jobs",     count: "jobs",     i18n: "pref_t_jobs" },
  ];

  // What each owner type can choose, and the default.
  //
  // "fair" is the default for an owner and NOT for a seeker, and the asymmetry
  // is deliberate: the fair queue exists to stop an owner being buried, and an
  // owner is the person it is a promise to. A seeker keeps the order that
  // answers their search best, because a rotation that outranked relevance
  // would be a worse search for everybody (js/lib/listing-order.js says so at
  // greater length).
  var ORDERS = [
    { key: "fair",        i18n: "pref_o_fair",        d: "pref_o_fair_d" },
    { key: "newest",      i18n: "pref_o_newest",      d: "pref_o_newest_d" },
    { key: "recommended", i18n: "pref_o_recommended", d: "pref_o_recommended_d" },
  ];

  var DEFAULTS = { order: "fair", notify: true };

  function read() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || "{}");
      return v && typeof v === "object" ? v : {};
    } catch (_) { return {}; }
  }

  function write(all) {
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch (_) { /* private mode */ }
  }

  /**
   * Whose preferences these are.
   *
   * An unknown identity gets its OWN bucket rather than sharing the signed-out
   * one. Two people using one phone must not inherit each other's settings,
   * and "signed out" is a third person, not the absence of one.
   */
  function bucket(userId) {
    return "u:" + String(userId == null ? "" : userId);
  }

  /** Everything set for one account type, defaults filled in. */
  function get(userId, type) {
    var mine = read()[bucket(userId)] || {};
    var one = mine[type] || {};
    return {
      order: ORDERS.some(function (o) { return o.key === one.order; }) ? one.order : DEFAULTS.order,
      notify: typeof one.notify === "boolean" ? one.notify : DEFAULTS.notify,
    };
  }

  /** Change one setting. Returns the whole of that type's settings after it. */
  function set(userId, type, patch) {
    var all = read();
    var b = bucket(userId);
    // A new object every time rather than mutating what read() returned: this
    // is the same immutability rule the rest of the repo follows, and here it
    // also means a failed write cannot leave a half-applied value in memory
    // that the next get() reports as saved.
    var mine = Object.assign({}, all[b]);
    mine[type] = Object.assign({}, mine[type], patch || {});
    all = Object.assign({}, all, {});
    all[b] = mine;
    write(all);
    return get(userId, type);
  }

  /** Forget one account entirely. Used when a guest session ends. */
  function forget(userId) {
    var all = read();
    if (!(bucket(userId) in all)) return;
    var next = {};
    Object.keys(all).forEach(function (k) { if (k !== bucket(userId)) next[k] = all[k]; });
    write(next);
  }

  /**
   * Which types this account actually is, from what it has listed.
   *
   * `counts` is { houses, services, trucks, jobs } as the caller already has
   * them. A type with nothing in it is not returned: a preferences screen
   * offering to arrange a truck catalogue to somebody who has never listed a
   * truck is a form to be worked through, which is the thing this app keeps
   * deciding not to build.
   */
  function typesOf(counts) {
    var c = counts || {};
    return TYPES.filter(function (t) { return Number(c[t.count]) > 0; });
  }

  window.AccountPrefs = {
    KEY: KEY,
    TYPES: TYPES,
    ORDERS: ORDERS,
    DEFAULTS: DEFAULTS,
    get: get,
    set: set,
    forget: forget,
    typesOf: typesOf,
  };
})();
