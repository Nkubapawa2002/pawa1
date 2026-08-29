// ============================================================================
//  Notifications — what happened in the app since you last looked
// ============================================================================
//  Six things can be news: a new room, a new service, a new truck, a new day
//  job, a message you have not read, and a group somebody added you to. This
//  file works out how many of each there are. js/lib/notify-ui.js draws them.
//
//  HOW "NEW" IS DECIDED, AND WHY IT IS NOT A SUBSCRIPTION FOR EVERYTHING.
//  Supabase Realtime only broadcasts tables that are in the `supabase_realtime`
//  publication, and today that is day_jobs and pm_messages (plus meet_rooms and
//  live_locations, which are not catalogue news). houses, services and trucks
//  are NOT published, so there is no live event to listen for on the three
//  catalogues that matter most.
//
//  Rather than add three tables to a publication — which broadcasts every row
//  change to every connected client for a catalogue nobody is watching live —
//  "new" is measured against a mark this device keeps: the last time it looked.
//  Anything created after that mark is news. That works signed out, works for a
//  guest, survives a reload, costs one cached read per catalogue, and does not
//  need a single new database object. Realtime is layered on top for the two
//  tables that already carry it, so a day job or a message that lands while the
//  app is open bumps the badge without waiting for a refresh.
//
//  THE FIRST RUN SEEDS THE MARK TO NOW. A visitor opening the app for the first
//  time has no unread history; they have a catalogue. Telling them "47 new
//  rooms" would be true and useless, and it would teach them to ignore the
//  badge on the day it finally means something.
//
//  Public API:
//    Notify.state()            -> { total, groups: [ {key, count, href, …} ] }
//    Notify.refresh()          -> re-read everything, returns state()
//    Notify.markSeen(key)      -> one category is no longer news
//    Notify.markAllSeen()
//    Notify.on(fn)             -> called with state() whenever it changes
//  Fires `pawa:notify` on window as well, for anything that would rather listen
//  than register.
// ============================================================================
(function () {
  "use strict";

  var SEEN_KEY = "pawa_notify_seen";
  // A catalogue read is cached for two minutes inside DataStore, so polling
  // faster than that buys nothing but work.
  var POLL_MS = 120000;
  // Enough to show "9+" without ever loading a page's worth of rows to count.
  var MAX_LIST = 6;

  var listeners = [];
  // True only for the run that created the mark, so the first inbox read can
  // adopt the threads that already exist instead of announcing them.
  var justSeeded = false;
  var cache = null;                 // last computed state
  var pollTimer = null;
  var channels = [];

  // ---- the mark this device keeps ------------------------------------------
  function seen() {
    try {
      var raw = JSON.parse(localStorage.getItem(SEEN_KEY) || "null");
      if (raw && typeof raw === "object") return raw;
    } catch (_) {}
    return null;
  }
  function saveSeen(next) {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(next)); } catch (_) {}
  }
  /** The mark, seeded to now on a first run so history is not reported as news. */
  function mark() {
    var s = seen();
    if (s) return s;
    var now = new Date().toISOString();
    s = { houses: now, services: now, trucks: now, jobs: now, threads: [], seededAt: now };
    saveSeen(s);
    justSeeded = true;
    return s;
  }

  function isNewer(row, iso) {
    if (!row || !row.created_at || !iso) return false;
    return String(row.created_at) > String(iso);
  }

  // ---- the six sources -----------------------------------------------------
  // Each returns rows created after the mark. A source that throws is a source
  // that contributes nothing, never one that breaks the badge: a signed-out
  // visitor has no inbox, and a catalogue can be unreachable on a bad link.
  async function catalogue(getter, since) {
    try {
      var rows = await getter();
      if (!Array.isArray(rows)) return [];
      return rows.filter(function (r) { return isNewer(r, since); });
    } catch (_) { return []; }
  }

  /**
   * The P-Message side: unread messages, and threads that appeared without
   * this device ever having seen them, which is what being added to a group
   * looks like from the outside. There is no "invite addressed to me" row to
   * read — pm_invite_create mints a link, and pm_group_add simply makes you a
   * member — so a thread id nobody here has seen before IS the invitation.
   */
  async function inbox(knownThreads) {
    var out = { unread: 0, newThreads: [], threads: [] };
    var D = window.DataStore;
    if (!D || !D.sb) return out;
    try {
      if (!window.Auth || !(await window.Auth.getSession())) return out;
    } catch (_) { return out; }
    try {
      var res = await D.sb.rpc("pm_inbox");
      if (res.error || !Array.isArray(res.data)) return out;
      var known = {};
      (knownThreads || []).forEach(function (id) { known[id] = true; });
      res.data.forEach(function (t) {
        out.threads.push(t.thread_id);
        out.unread += Math.max(0, Number(t.unread) || 0);
        if (!known[t.thread_id] && t.kind === "group") out.newThreads.push(t);
      });
    } catch (_) {}
    return out;
  }

  // ---- putting it together -------------------------------------------------
  var GROUPS = [
    { key: "houses",   href: "houses.html",     icon: "room" },
    { key: "services", href: "services.html",   icon: "service" },
    { key: "trucks",   href: "trucks.html",     icon: "truck" },
    { key: "jobs",     href: "jobs.html",       icon: "job" },
    { key: "messages", href: "p-message.html",  icon: "message", live: true },
    { key: "groups",   href: "p-message.html",  icon: "group",   live: true },
  ];

  async function compute() {
    var m = mark();
    var D = window.DataStore || {};
    var results = await Promise.all([
      catalogue(function () { return D.getHouses ? D.getHouses() : []; }, m.houses),
      catalogue(function () { return D.getServices ? D.getServices() : []; }, m.services),
      catalogue(function () { return D.getTrucks ? D.getTrucks() : []; }, m.trucks),
      catalogue(function () { return D.getDayJobs ? D.getDayJobs() : []; }, m.jobs),
      inbox(m.threads),
    ]);
    var byKey = {
      houses: results[0], services: results[1], trucks: results[2], jobs: results[3],
    };
    var pm = results[4];

    // The same reasoning that seeds the catalogue timestamps applies to the
    // inbox: on the run that creates the mark, the groups a person is already
    // in are not an invitation, they are their inbox. Adopt them once, quietly,
    // and only announce what arrives after that. Unread MESSAGES are exempt —
    // those are live state, true on day one as much as on day ten.
    if (justSeeded) {
      justSeeded = false;
      m.threads = pm.threads;
      saveSeen(m);
      pm.newThreads = [];
    }

    var groups = GROUPS.map(function (g) {
      if (g.key === "messages") {
        return Object.assign({}, g, { count: pm.unread, items: [] });
      }
      if (g.key === "groups") {
        return Object.assign({}, g, {
          count: pm.newThreads.length,
          items: pm.newThreads.slice(0, MAX_LIST).map(function (t) {
            return { id: t.thread_id, title: t.title || "", at: t.last_at };
          }),
        });
      }
      var rows = byKey[g.key] || [];
      return Object.assign({}, g, {
        count: rows.length,
        items: rows.slice(0, MAX_LIST).map(function (r) {
          return { id: r.id, title: r.title || "", at: r.created_at };
        }),
      });
    });

    // Remembered so markAllSeen can retire the threads it just showed without
    // fetching the inbox a second time.
    cache = {
      total: groups.reduce(function (n, g) { return n + g.count; }, 0),
      groups: groups,
      _threads: pm.threads,
    };
    return cache;
  }

  function emit() {
    var s = state();
    listeners.forEach(function (fn) { try { fn(s); } catch (_) {} });
    try { window.dispatchEvent(new CustomEvent("pawa:notify", { detail: s })); } catch (_) {}
  }

  function state() {
    return cache || { total: 0, groups: GROUPS.map(function (g) {
      return Object.assign({}, g, { count: 0, items: [] });
    }) };
  }

  async function refresh() {
    await compute();
    emit();
    return cache;
  }

  /**
   * One category stops being news.
   *
   * `messages` is deliberately NOT dismissible here. An unread count belongs to
   * the conversation, not to this badge, and clearing it from a panel the
   * sender cannot see would be this app lying to its own reader about what they
   * have read. It clears when the conversation is opened, which is the only
   * place it means anything.
   */
  function markSeen(key) {
    var m = mark();
    var now = new Date().toISOString();
    if (key === "groups") {
      m.threads = (cache && cache._threads) || m.threads || [];
    } else if (key !== "messages" && Object.prototype.hasOwnProperty.call(m, key)) {
      m[key] = now;
    }
    saveSeen(m);
    // Recompute from what is already loaded rather than re-reading everything.
    if (cache) {
      cache.groups.forEach(function (g) { if (g.key === key) { g.count = 0; g.items = []; } });
      cache.total = cache.groups.reduce(function (n, g) { return n + g.count; }, 0);
    }
    emit();
  }

  function markAllSeen() {
    ["houses", "services", "trucks", "jobs", "groups"].forEach(function (k) {
      var m = mark(), now = new Date().toISOString();
      if (k === "groups") m.threads = (cache && cache._threads) || m.threads || [];
      else m[k] = now;
      saveSeen(m);
    });
    if (cache) {
      cache.groups.forEach(function (g) {
        if (g.key !== "messages") { g.count = 0; g.items = []; }
      });
      cache.total = cache.groups.reduce(function (n, g) { return n + g.count; }, 0);
    }
    emit();
  }

  // ---- live, where the publication allows it -------------------------------
  function subscribe() {
    var sb = window.DataStore && window.DataStore.sb;
    if (!sb || channels.length) return;
    // day_jobs and pm_messages are the only two of ours in supabase_realtime.
    // Everything else waits for the next poll or the next time the tab is
    // brought back, which is honest: we cannot hear what is not broadcast.
    [["day_jobs", "pawa-notify-jobs"], ["pm_messages", "pawa-notify-pm"]].forEach(function (pair) {
      try {
        var ch = sb.channel(pair[1])
          .on("postgres_changes", { event: "INSERT", schema: "public", table: pair[0] }, function () {
            refresh();
          })
          .subscribe();
        channels.push(ch);
      } catch (_) {}
    });
  }

  function start() {
    refresh();
    subscribe();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    // Coming back to the tab is the moment a person expects the badge to be
    // right, and it costs one cached read.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") refresh();
    });
  }

  window.Notify = {
    state: state,
    refresh: refresh,
    markSeen: markSeen,
    markAllSeen: markAllSeen,
    on: function (fn) { if (typeof fn === "function") listeners.push(fn); },
    GROUPS: GROUPS,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
