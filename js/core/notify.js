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
    // userId rides back with the inbox rather than being fetched a second
    // time: this function already has the session in hand, and the trust
    // alarms below are scoped by exactly that id.
    var out = { unread: 0, newThreads: [], threads: [], userId: null };
    var D = window.DataStore;
    if (!D || !D.sb) return out;
    try {
      var sess = window.Auth && await window.Auth.getSession();
      if (!sess) return out;
      out.userId = (sess.user && sess.user.id) || null;
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

  /**
   * What the platform has to say to this account about itself.
   *
   * Two different things arrive in one call (supabase/features/agent/
   * agent_notices.sql):
   *
   *   notices   what an admin did, or wrote. Approved, deactivated, a payment
   *             recorded, or a message they typed. Rows, with an unread count.
   *   billing   the state of the subscription right now, whether or not any
   *             row has been written about it yet. days_left is computed on
   *             the SERVER: a phone with the wrong date must not be able to
   *             tell somebody their cover ends next week when it ended
   *             yesterday.
   *
   * Everything degrades to "nothing to say" — signed out, no client, an RPC
   * that is not deployed. A bell that breaks the page it rides on would be
   * worse than a bell that is quiet.
   */
  async function notices() {
    var out = { unread: 0, items: [], billing: null };
    var D = window.DataStore;
    if (!D || !D.sb) return out;
    try {
      var sess = window.Auth && await window.Auth.getSession();
      if (!sess || (sess.user && sess.user.is_anonymous === true)) return out;
    } catch (_) { return out; }
    try {
      var res = await D.sb.rpc("my_notices");
      if (res.error || !res.data) return out;
      out.unread = Number(res.data.unread) || 0;
      out.items = Array.isArray(res.data.notices) ? res.data.notices : [];
      out.billing = res.data.billing || null;
    } catch (_) {}
    return out;
  }

  /**
   * Is the subscription worth interrupting somebody about?
   *
   * Only ever ONE row, never a count: an account has one subscription and the
   * question is what state it is in. RENEW_DAYS is the point at which "later"
   * becomes "this week", and it is deliberately the same number the sweep in
   * agent_notices_remind() defaults to, so the bell and the written reminder
   * appear together rather than a week apart.
   */
  var RENEW_DAYS = 7;
  function billingAlert(b) {
    if (!b) return null;
    var left = (b.days_left === null || b.days_left === undefined) ? null : Number(b.days_left);
    // Off the board already. The three reasons differ in why, and the panel
    // says which, because "pay" and "talk to the admin" are different actions.
    if (b.reason === "deactivated" || b.reason === "cancelled" || b.reason === "overdue"
        || b.reason === "expired" || b.reason === "approval_expired") {
      return { state: b.reason, days: left, urgent: true };
    }
    if (b.reason === "preview") return null;   // the seven-day window, not news
    if (left !== null && left <= RENEW_DAYS) {
      return { state: "ending", days: Math.max(0, left), urgent: left <= 2 };
    }
    return null;
  }

  // ---- putting it together -------------------------------------------------
  var GROUPS = [
    // Trust is FIRST, and it is the only row here that is not news about the
    // catalogue. Somebody's safety number changing is the most serious thing
    // this app can notice, it already blocks the composer in that thread, and
    // until now the only way to find out was to open the conversation. A
    // warning nobody is shown is not a warning.
    { key: "trust",    href: "p-message.html",  icon: "shield", alarm: true },
    // The two rows that are about THIS ACCOUNT rather than about the
    // catalogue, and they come second only to a changed safety number. An
    // agent whose subscription runs out on Friday needs to know on Monday, and
    // until now the only place either of these appeared was a banner on a
    // dashboard that somebody out working never opens.
    { key: "renew",    href: "profile.html#notices", icon: "clock",  alarm: true },
    { key: "admin",    href: "profile.html#notices", icon: "stamp" },
    { key: "houses",   href: "houses.html",     icon: "room" },
    { key: "services", href: "services.html",   icon: "service" },
    { key: "trucks",   href: "trucks.html",     icon: "truck" },
    { key: "jobs",     href: "jobs.html",       icon: "job" },
    { key: "messages", href: "p-message.html",  icon: "message", live: true },
    { key: "groups",   href: "p-message.html",  icon: "group",   live: true },
  ];

  /**
   * Peers whose key is not the one this device wrote down.
   *
   * Pure localStorage, no network, no session round-trip: js/lib/pm-trust.js
   * already keeps the verdicts, scoped by my own user id, and the alarm is
   * STICKY by design — it is written down rather than recomputed, so a
   * re-fetch cannot clear it. Reading it here costs nothing and cannot fail
   * in a way that matters: no PMTrust, or no signed-in id, means no rows.
   *
   * Deliberately NOT dismissible from the panel, for the same reason unread
   * messages are not: it clears when a person compares the number or says the
   * change was expected, and nowhere else. A badge that could be tapped away
   * would let somebody dismiss the one alarm that is worth stopping for.
   */
  function trustAlarms(userId) {
    try {
      if (!userId || !window.PMTrust || !window.PMTrust.list) return [];
      return window.PMTrust.list(userId).filter(function (r) {
        return r.state === window.PMTrust.CHANGED;
      });
    } catch (_) { return []; }
  }

  /**
   * The rooms this person actually asked about.
   *
   * An area alert is the ONE place on the site where somebody states what they
   * want to be told about: this pin, this radius, two bedrooms, under 400,000,
   * for rent. Until this, the bell could not see any of it and counted every
   * new room in the country, so the three that matched were indistinguishable
   * from forty that did not. A count of everything is not a notification.
   *
   * With no alerts saved, nothing is narrowed: a person who has asked for
   * nothing in particular wants the catalogue, and filtering it to empty would
   * be the badge deciding on their behalf that nothing is news.
   *
   * The rule lives in js/lib/house-alerts.js, which houses.html uses for its
   * own banner. One rule, two callers: the page and the badge must never be
   * able to describe different rooms.
   */
  function narrowToAlerts(rows) {
    var HA = window.HouseAlerts;
    if (!HA || !HA.any()) return { rows: rows, watched: false };
    var picked = HA.pick(rows).map(function (p) { return p.h; });
    return { rows: picked, watched: true };
  }

  async function compute() {
    var m = mark();
    var D = window.DataStore || {};
    var results = await Promise.all([
      catalogue(function () { return D.getHouses ? D.getHouses() : []; }, m.houses),
      catalogue(function () { return D.getServices ? D.getServices() : []; }, m.services),
      catalogue(function () { return D.getTrucks ? D.getTrucks() : []; }, m.trucks),
      catalogue(function () { return D.getDayJobs ? D.getDayJobs() : []; }, m.jobs),
      inbox(m.threads),
      notices(),
    ]);
    var homes = narrowToAlerts(results[0]);
    var byKey = {
      houses: homes.rows, services: results[1], trucks: results[2], jobs: results[3],
    };
    var pm = results[4];
    var acct = results[5];
    var bill = billingAlert(acct.billing);

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

    var alarms = trustAlarms(pm.userId);

    var groups = GROUPS.map(function (g) {
      if (g.key === "trust") {
        return Object.assign({}, g, {
          count: alarms.length,
          items: alarms.slice(0, MAX_LIST).map(function (r) {
            return { id: r.userId, title: r.name || "", at: r.changedAt };
          }),
        });
      }
      if (g.key === "messages") {
        return Object.assign({}, g, { count: pm.unread, items: [] });
      }
      // One row, never a count: an account has one subscription, and what the
      // reader needs is which state it is in and how long is left.
      if (g.key === "renew") {
        return Object.assign({}, g, {
          count: bill ? 1 : 0,
          state: bill && bill.state,
          days: bill && bill.days,
          alarm: !!(bill && bill.urgent),
          items: [],
        });
      }
      if (g.key === "admin") {
        return Object.assign({}, g, {
          count: acct.unread,
          items: acct.items.slice(0, MAX_LIST).map(function (r) {
            return { id: r.id, title: r.title || "", at: r.created_at, severity: r.severity };
          }),
        });
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
        // Only the rooms row can be narrowed, and the panel has to SAY when it
        // was: "3 new rooms" and "3 new rooms in your areas" are different
        // claims, and a reader who cannot tell which one they are being shown
        // cannot tell whether their alert is working.
        watched: g.key === "houses" ? homes.watched : false,
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
   *
   * `trust` is not dismissible for a harder reason. A changed safety number is
   * the one alarm worth stopping for, the alarm is sticky precisely so it
   * cannot be cleared by doing nothing, and a badge that could be tapped away
   * would hand somebody the "do nothing" exit that pm-trust.js exists to
   * close. It clears by comparing the number or by saying the change was
   * expected, both of which happen in the conversation.
   *
   * `admin` and `renew` are not dismissible either, for the same reason as
   * messages: they clear by being DEALT WITH. A notice clears when it is read
   * on the Profile tab, and a subscription warning clears when the
   * subscription is renewed. A badge that could be tapped away would let
   * somebody dismiss the reminder that their listings come off the board on
   * Friday, which is the one this whole feature exists to deliver.
   */
  var UNDISMISSABLE = { messages: true, trust: true, admin: true, renew: true };

  function markSeen(key) {
    var m = mark();
    var now = new Date().toISOString();
    if (key === "groups") {
      m.threads = (cache && cache._threads) || m.threads || [];
    } else if (!UNDISMISSABLE[key] && Object.prototype.hasOwnProperty.call(m, key)) {
      m[key] = now;
    }
    saveSeen(m);
    // Recompute from what is already loaded rather than re-reading everything.
    // The undismissable pair is skipped HERE too, not only above: zeroing the
    // cached count is what the reader actually sees, so clearing it while the
    // mark stays put would make the row vanish on tap and come back on the
    // next poll. For trust that is the whole hole this closes; a tap on the
    // row is a door to the conversation, never an acknowledgement.
    if (cache) {
      cache.groups.forEach(function (g) {
        if (g.key === key && !UNDISMISSABLE[key]) { g.count = 0; g.items = []; }
      });
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
        if (!UNDISMISSABLE[g.key]) { g.count = 0; g.items = []; }
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
    // Asked by notify-ui.js so "Mark all as read" hides when the only thing
    // left is an alarm that button cannot touch. A second copy of the list
    // over there would drift into offering a button that does nothing.
    isDismissible: function (key) { return !UNDISMISSABLE[key]; },
    on: function (fn) { if (typeof fn === "function") listeners.push(fn); },
    GROUPS: GROUPS,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
