// ============================================================================
//  account-kind.js — which of the four kinds this account is, and what that
//  means on screen.
// ============================================================================
//  WHY THIS FILE EXISTS AT ALL
//  login.html has offered four account types since it shipped: Agent, House
//  owner, Job company, Just looking. Counted in production on 2026-09-16,
//  public.account_kinds held ZERO rows and no user carried the metadata either.
//  The picker wrote localStorage, only the OWNER door ever recorded anything,
//  and account_kind() defaults a missing row to 'agent' -- so every account in
//  the system was an agent, including one that had chosen "Just looking".
//
//  Two of the four kinds also meant nothing anywhere: 'company' and 'user' were
//  valid values in a CHECK constraint and no trigger, policy, fee rule or
//  screen branched on either.
//
//  So there are now two halves, and this is the smaller one.
//
//    supabase/features/account/account_kinds_real.sql  refuses a listing from a
//        company or a user account, with a sentence, in the database.
//    this file                                          decides what to DRAW.
//
//  THE SPLIT IS THE WHOLE DESIGN. What a browser hides is a courtesy; what the
//  database refuses is the rule. This file must never be the only thing
//  standing between an account and something it may not do -- that was exactly
//  the mistake the old door made, and js/lib/login-doors.js says so at length
//  in its own header ("it grants nothing... a picker in a browser cannot move
//  any of those"). Hiding the portals is so a person is not invited to fail.
//
//  ONE PLACE, NOT SIX. Five screens want to know whether to draw a "list your
//  house" door. If each asked the question its own way they would disagree
//  within a month, and the one that disagreed generously would be a bug nobody
//  noticed. So: kind() answers once per page, cached, and can() answers every
//  capability question from one table.
//
//  IT DEFAULTS TO THE GENEROUS ANSWER ON PURPOSE. A failed lookup, a missing
//  session, an old browser: all of them come back 'agent', which is what every
//  existing account already is. A network hiccup must not lock somebody out of
//  their own listings page; the database is still there to refuse anything that
//  actually matters.
// ============================================================================
(function () {
  "use strict";

  // The four, and what each may do. Read this table rather than writing
  // `kind === "owner"` at a call site: a fifth kind, or a change to what a
  // company may do, should be one edit here.
  //
  // `list` must agree with public.kind_may_list() in
  // supabase/features/account/account_kinds_real.sql. It is duplicated rather
  // than fetched because a screen needs it synchronously while drawing, and
  // the SQL is the half that is enforced -- if these two ever disagree the
  // database wins and the screen is merely wrong, which is the safe direction.
  var KINDS = {
    agent: {
      list: true, dayJobsPost: false, claimWork: true,
      agentProfile: true, fee: true,
      i18n: "lg_door_agent", note: "ak_note_agent",
    },
    owner: {
      list: true, dayJobsPost: false, claimWork: true,
      // NEVER. An owner with an agent_profiles row is an agent everywhere else
      // in the app, because pm_publish_key() derives pm_keys.is_agent from
      // exactly that row. agent-houses.js already guards this; trucks and
      // services did not, and that is fixed alongside this file.
      agentProfile: false, fee: false,
      i18n: "lg_door_owner", note: "ak_note_owner",
    },
    company: {
      list: false, dayJobsPost: true, claimWork: false,
      agentProfile: false, fee: false,
      i18n: "lg_door_company", note: "ak_note_company",
    },
    user: {
      list: false, dayJobsPost: false, claimWork: true,
      agentProfile: false, fee: false,
      i18n: "lg_door_user", note: "ak_note_user",
    },
  };

  var ORDER = ["agent", "owner", "company", "user"];
  var DEFAULT = "agent";

  var cached = null;        // { kind, mayList, isDefault }
  var inFlight = null;

  function client() {
    return window.SB || (window.DataStore && window.DataStore.sb) || null;
  }

  /**
   * Ask the server which kind this account is.
   *
   * my_account_kind() answers about the CALLER and takes no id, so a browser
   * cannot ask about somebody else. It also reports whether the answer is a
   * real row or the 'agent' default, which the Profile card needs: "treated as
   * an agent" is honest about an account nobody has ever classified, and "you
   * are an agent" is not.
   */
  function load() {
    if (cached) return Promise.resolve(cached);
    if (inFlight) return inFlight;
    var sb = client();
    if (!sb) {
      cached = { kind: DEFAULT, mayList: true, isDefault: true };
      return Promise.resolve(cached);
    }
    inFlight = sb.rpc("my_account_kind").then(function (res) {
      if (res.error) throw res.error;
      var row = (res.data && res.data[0]) || null;
      cached = row
        ? {
            kind: KINDS[row.kind] ? row.kind : DEFAULT,
            mayList: row.may_list !== false,
            isDefault: !!row.is_default,
          }
        : { kind: DEFAULT, mayList: true, isDefault: true };
      return cached;
    }).catch(function () {
      // The generous answer. See the header: a hiccup must not lock somebody
      // out of their own listings, and the database refuses what matters.
      cached = { kind: DEFAULT, mayList: true, isDefault: true };
      return cached;
    }).finally(function () { inFlight = null; });
    return inFlight;
  }

  /** The kind, synchronously, once load() has finished. 'agent' until then. */
  function kind() { return (cached && cached.kind) || DEFAULT; }

  /** True when nobody has ever classified this account. */
  function isDefault() { return cached ? !!cached.isDefault : true; }

  /**
   * May this account do `what`?
   *
   * Names, not booleans at the call site: `can("list")` reads as a question
   * about the account, and `kind === "agent" || kind === "owner"` reads as a
   * list somebody will forget to update.
   */
  function can(what, forKind) {
    var k = KINDS[forKind || kind()] || KINDS[DEFAULT];
    return !!k[what];
  }

  /** The translated name of a kind, for a card or a chip. */
  function name(forKind) {
    var k = forKind || kind();
    var key = (KINDS[k] || KINDS[DEFAULT]).i18n;
    var s = window.t ? window.t(key) : null;
    return (s && s !== key) ? s : k;
  }

  /** One sentence saying what this kind is for. */
  function note(forKind) {
    var k = forKind || kind();
    var key = (KINDS[k] || KINDS[DEFAULT]).note;
    var s = window.t ? window.t(key) : null;
    return (s && s !== key) ? s : "";
  }

  /**
   * Move this account to another kind.
   *
   * Straight through to account_kind_claim(), which carries the refusal rules
   * and is the only thing that may write the row. THE SERVER'S SENTENCE IS
   * THROWN AS-IS: "This account already has an agent page. Ask us to move it to
   * an owner account" is a better message than anything this file could invent,
   * and inventing one would mean maintaining a second copy of rules that live
   * in SQL.
   */
  function claim(next) {
    var sb = client();
    if (!sb) return Promise.reject(new Error("offline"));
    return sb.rpc("account_kind_claim", { p_kind: next }).then(function (res) {
      if (res.error) throw new Error(res.error.message || String(res.error));
      cached = null;            // it changed; ask again rather than guess
      return load();
    });
  }

  window.AccountKind = {
    KINDS: KINDS,
    ORDER: ORDER,
    DEFAULT: DEFAULT,
    load: load,
    kind: kind,
    isDefault: isDefault,
    can: can,
    name: name,
    note: note,
    claim: claim,
    // Tests drive these rather than standing up a session.
    _reset: function () { cached = null; inFlight = null; },
    _set: function (k) { cached = { kind: k, mayList: can("list", k), isDefault: false }; },
  };
})();
