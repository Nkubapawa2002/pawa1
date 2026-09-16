// ============================================================================
//  support-duties.js — who is on duty, read from the database instead of typed.
// ============================================================================
//  WHAT THIS IS FOR
//  Three screens ask "who does a person talk to": chat.html draws the cards,
//  Profile's subscription dialog puts a contact line in a sentence, and the
//  agent dashboards attach one to a billing notice. All three used to read
//  APP_CONFIG.SUPPORT_CONTACTS, which was two hand-typed rows in
//  js/core/config.js — one of them a placeholder number, the other with a call
//  number and a WhatsApp number that disagreed by two digits. The reasoning is
//  at the top of supabase/features/account/support_duties.sql.
//
//  ONE FETCH PER PAGE, SHARED. Three callers on one page must not be three
//  round trips, and two of them are synchronous by nature (they build a string
//  inside a notice that is already being rendered). So:
//
//    load()    async, idempotent, returns the rows. Every caller gets the same
//              in-flight promise rather than starting a second request.
//    cached()  synchronous. The rows if load() has finished, [] if not. A
//              caller that gets [] draws NOTHING rather than a placeholder,
//              which is the whole point of this file.
//
//  AN EMPTY ROTA IS A REAL STATE, NOT AN ERROR. Nobody on duty means no card,
//  no name, no number. It must never fall back to a built-in person: that is
//  the bug this replaces, and a "temporary" default in here would quietly
//  become the same permanent fiction in a different file.
//
//  THE DUTY IS A KEY. duty_key comes back as an i18n key ('support_role_manager'
//  and four others, fixed by a check constraint in the SQL) and is translated
//  here through the same window.t() everything else uses. It is never printed
//  raw: a key that reached the screen would print as `support_role_manager`,
//  which is the failure mode js/lib/pm-i18n-style code exists to avoid.
// ============================================================================
(function () {
  "use strict";

  var rows = null;        // null = never loaded; [] = loaded and empty
  var inFlight = null;

  // The same accessor every other lib uses, rather than a second supabase
  // client: a duplicate client is a duplicate auth session. Both of these are
  // the client OBJECT and not a getter -- js/core/data.js sets window.SB at
  // create time and exports the same reference as DataStore.sb.
  function client() {
    return window.SB || (window.DataStore && window.DataStore.sb) || null;
  }

  /**
   * Fetch the rota once.
   *
   * NEVER THROWS. A support rota that could not be fetched is a screen with no
   * contact card on it, which is exactly what an empty rota looks like, and
   * both are better than an error dialog in the middle of a billing notice.
   * The console line is deliberate: this failing silently forever is how
   * somebody spends an afternoon wondering where the numbers went.
   */
  function load() {
    if (rows) return Promise.resolve(rows);
    if (inFlight) return inFlight;
    var sb = client();
    if (!sb) { rows = []; return Promise.resolve(rows); }
    inFlight = sb.rpc("support_duties_live").then(function (res) {
      if (res.error) throw res.error;
      rows = (res.data || []).map(function (r) {
        return {
          id: r.id,
          name: String(r.name || ""),
          dutyKey: String(r.duty_key || ""),
          phone: String(r.phone || ""),
          whatsapp: String(r.whatsapp || ""),
          region: String(r.region || ""),
        };
      });
      return rows;
    }).catch(function (err) {
      // eslint-disable-next-line no-console
      console.warn("support duties could not be read:", (err && err.message) || err);
      rows = [];
      return rows;
    }).finally(function () { inFlight = null; });
    return inFlight;
  }

  /** The rows, or [] if load() has not finished. Never null, never invented. */
  function cached() { return rows || []; }

  /** The first person on the rota, or null. The SQL fixes the order. */
  function first() { return cached()[0] || null; }

  /** The duty, in the reader's language. Never the raw key. */
  function dutyName(dutyKey) {
    var s = window.t ? window.t(dutyKey) : null;
    if (s && s !== dutyKey) return s;
    // A key with no translation is a deployment that added a duty to the check
    // constraint and forgot i18n.js. Say something true rather than the key.
    return window.t ? (window.t("support_role_generic") || "Support") : "Support";
  }

  /** tel: for a phone, https://wa.me/ for a WhatsApp number, else "". */
  function reachHref(person) {
    if (!person) return "";
    if (person.whatsapp) return "https://wa.me/" + encodeURIComponent(person.whatsapp);
    if (person.phone) return "tel:" + String(person.phone).replace(/\s/g, "");
    return "";
  }

  window.SupportDuties = {
    load: load,
    cached: cached,
    first: first,
    dutyName: dutyName,
    reachHref: reachHref,
    // Tests reach for this rather than reloading a page to clear a cache.
    _reset: function () { rows = null; inFlight = null; },
  };

  // SELF-STARTING, because two of the three callers are synchronous and run
  // inside a render they do not control: a notice on an agent dashboard builds
  // its contact line while the dashboard is drawing, long before any page
  // script would have thought to await anything. A page that includes this
  // file gets the rota; there is no call to forget.
  //
  // Deferred to the next tick rather than run at parse time, because
  // js/core/data.js may be below this in the script order on a page that adds
  // it later, and client() would come back null exactly once and cache [].
  function start() { try { load(); } catch (_) { /* never fatal */ } }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    setTimeout(start, 0);
  }
})();
