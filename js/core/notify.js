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
//    Notify.clear(key)         -> clear this row FOR GOOD, item by item
//    Notify.clearAll()
//    Notify.hideBilling(b)     -> stop showing THIS subscription state
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

  // ---- what has been cleared, and will not come back -----------------------
  // "Clear this" is neither a read mark nor a mute; js/lib/notify-clear.js
  // holds the list and the reasoning. WHAT NAMES A ROW is decided here, being
  // a fact about the thing counted rather than about storage: a house is its
  // id, a conversation is its id plus the time of its last message, a changed
  // safety number is the peer plus the moment it changed.
  var CLEARED = function () { return window.NotifyCleared || null; };

  function goneSet(key) {
    var C = CLEARED();
    return C ? C.set(key) : Object.create(null);
  }

  function remember(key, ids) {
    var C = CLEARED();
    return C ? C.remember(key, ids) : false;
  }

  function dropGone(key, rows, idOf) {
    var C = CLEARED();
    return C ? C.drop(key, rows, idOf) : (rows || []);
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
    // `unreadRows` is the per-thread breakdown, and it exists so an unread
    // count can be cleared by identity rather than by tapping a total away.
    var out = { unread: 0, unreadRows: [], newThreads: [], threads: [], userId: null };
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
      var goneMsg = goneSet("messages");
      res.data.forEach(function (t) {
        out.threads.push(t.thread_id);
        var n = Math.max(0, Number(t.unread) || 0);
        if (n > 0 && !goneMsg[t.thread_id + "|" + (t.last_at || "")]) {
          out.unread += n;
          out.unreadRows.push({ id: t.thread_id + "|" + (t.last_at || ""),
                                title: t.title || "", at: t.last_at });
        }
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
   * Every open request routed to this agent.
   *
   * Gated three ways, deliberately. window.DemandRows is loaded on the home
   * page and the three agent portals, window.AgentProfile only knows a region
   * once the agent has set one, and a guest has no profile at all, so a reader
   * who is not an agent never fires this RPC and never sees the section rather
   * than seeing it empty.
   *
   * AgentProfile.get IS ASYNC AND TAKES THE CLIENT. Calling it bare and reading
   * .region off the result reads a property off a pending Promise: undefined,
   * every time, on every page, with no error to notice. That is how this whole
   * section shipped counting nothing. The await is the feature.
   *
   * Twenty, not the hundred the dashboards ask for. The panel is a summary
   * with a door to the full board; a bell that pulls a hundred rows every two
   * minutes is a bell that costs more than it is worth.
   */
  async function demand() {
    var DR = window.DemandRows;
    var AP = window.AgentProfile;
    var D = window.DataStore;
    if (!DR || !AP || !AP.get || !D || !D.sb) return [];
    var prof = null;
    try { prof = await AP.get(D.sb); } catch (_) { return []; }
    if (!prof || !prof.region) return [];
    try {
      return await DR.fetch({
        sb: D.sb, region: prof.region, district: prof.district || null, limit: 20,
      });
    } catch (_) { return []; }
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

  /**
   * The one thing in this panel that is a STATE rather than a row, named so it
   * can be put away.
   *
   * Not the day count: "ends in 5 days" and "ends in 4 days" are the same fact
   * on two mornings, and keying on the number would bring a dismissed reminder
   * back every day, which is the bug this whole change exists to end. Keying on
   * the reason and the date it is about means a dismissal survives until the
   * subscription actually moves — paid, extended, lapsed, paused — and then the
   * new state is genuinely new and says so.
   *
   * This is the honest limit of "never show it again" for the subscription:
   * there is no row to delete, because nothing wrote one. What can be promised
   * is that this exact state stays quiet.
   */
  function billingKey(b) {
    if (!b || !b.reason) return "";
    return b.reason + "|" + (b.paid_until || "") + "|" + (b.status || "");
  }

  function billingHidden(b) {
    var k = billingKey(b);
    if (!k) return false;
    var s = seen();
    return !!(s && s.billingOff === k);
  }

  function hideBilling(b) {
    var k = billingKey(b || (cache && cache._billing));
    if (!k) return false;
    var m = mark();
    m.billingOff = k;
    saveSeen(m);
    if (cache) {
      cache.groups.forEach(function (g) {
        if (g.key === "renew") { g.count = 0; g.alarm = false; g.state = null; }
      });
      Object.assign(cache, tally(cache.groups));
    }
    emit();
    return true;
  }

  function billingAlert(b) {
    if (!b) return null;
    if (billingHidden(b)) return null;
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
  //
  // SECTIONS. Every group declares which of four places it belongs in, and the
  // panel groups by that rather than drawing one flat list. The old list put
  // "somebody is waiting for a place in your district" and "12 new rooms were
  // posted" side by side in the same shape, which is the whole reason this had
  // to be rebuilt.
  //
  //   alarm    something is WRONG. Full width, above everything, no count.
  //   wants    somebody is asking YOU for something. One row each.
  //   account  what the platform has to say about this account. One row each.
  //   nearby   what is merely new in the catalogue. A count and a door.
  //
  // Array order is still the order within a section, so every ordering
  // decision written down below survives.
  var GROUPS = [
    // Trust is FIRST, and it is the only row here that is not news about the
    // catalogue. Somebody's safety number changing is the most serious thing
    // this app can notice, it already blocks the composer in that thread, and
    // until now the only way to find out was to open the conversation. A
    // warning nobody is shown is not a warning.
    { key: "trust",    section: "alarm",   href: "p-message.html",  icon: "shield", alarm: true },
    // What a customer actually wants, routed to the agents who work that
    // ground. It is the one thing in this panel that MAKES an agent money, and
    // until now it never reached the bell at all: it was a card halfway down
    // two of the three dashboards, so an agent out working never saw it.
    // The door is the houses dashboard for all three portals, because
    // agent_profiles has no kind: one profile serves every board, the requests
    // are house_demand_pins, and that page is the only one that also says
    // whether a lead is worth the call.
    { key: "demand",   section: "wants",   href: "agent-houses.html", icon: "hand" },
    // The two rows that are about THIS ACCOUNT rather than about the
    // catalogue. An agent whose subscription runs out on Friday needs to know
    // on Monday, and until now the only place either of these appeared was a
    // banner on a dashboard that somebody out working never opens.
    { key: "renew",    section: "account", href: "profile.html#notices", icon: "clock",  alarm: true },
    { key: "admin",    section: "account", href: "profile.html#notices", icon: "stamp" },
    { key: "houses",   section: "nearby",  href: "houses.html",     icon: "room" },
    { key: "services", section: "nearby",  href: "services.html",   icon: "service" },
    { key: "trucks",   section: "nearby",  href: "trucks.html",     icon: "truck" },
    { key: "jobs",     section: "nearby",  href: "jobs.html",       icon: "job" },
    { key: "messages", section: "nearby",  href: "p-message.html",  icon: "message", live: true },
    { key: "groups",   section: "nearby",  href: "p-message.html",  icon: "group",   live: true },
  ];

  // What the badge counts. Everything else still lights the bell, as a dot:
  // "47" because 47 rooms were posted is a number nobody can act on, and it
  // buries the one customer who is waiting for a call.
  var ADDRESSED_TO_YOU = {
    trust: true, demand: true, renew: true, admin: true, messages: true, groups: true,
  };

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

  /**
   * The two numbers the bell reads.
   *
   * `total` is what the badge SHOWS, and it counts only what is addressed to
   * this reader. `news` is everything else. Written once and called from all
   * three places that produce a state, because when markSeen() recomputed the
   * total with its own inline sum the badge disagreed with itself the moment a
   * row was cleared.
   */
  function tally(groups) {
    var total = 0, news = 0;
    groups.forEach(function (g) {
      if (ADDRESSED_TO_YOU[g.key]) total += g.count; else news += g.count;
    });
    return { total: total, news: news };
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
      demand(),
    ]);
    var homes = narrowToAlerts(results[0]);
    var byKey = {
      houses: homes.rows, services: results[1], trucks: results[2], jobs: results[3],
    };
    // Cleared rows never reach a count. Filtered HERE rather than in the
    // panel, because the badge is built from these numbers: later would leave
    // somebody being told "7" by the bell they just cleared.
    Object.keys(byKey).forEach(function (k) {
      byKey[k] = dropGone(k, byKey[k], function (r) { return r.id; });
    });
    // A muted kind is emptied HERE, before it is counted, rather than hidden
    // at the last moment in the panel. The badge on the bell is built from
    // these counts, so filtering any later would leave a person who switched
    // rooms off still being told "7" by the thing they switched off.
    Object.keys(byKey).forEach(function (k) {
      if (muted(k)) byKey[k] = [];
    });
    var pm = results[4];
    var acct = results[5];
    var wants = results[6];
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

    // Clearing a trust row never unblocks the composer in that conversation,
    // which is pm-trust.js's business and stays shut.
    var alarms = dropGone("trust", trustAlarms(pm.userId), function (r) {
      return r.userId + "|" + (r.changedAt || "");
    });
    wants = dropGone("demand", wants, function (r) { return r.id; });
    pm.newThreads = dropGone("groups", pm.newThreads, function (t) { return t.thread_id; });

    var groups = GROUPS.map(function (g) {
      if (g.key === "trust") {
        return Object.assign({}, g, {
          count: alarms.length,
          _ids: alarms.map(function (r) { return r.userId + "|" + (r.changedAt || ""); }),
          items: alarms.slice(0, MAX_LIST).map(function (r) {
            return { id: r.userId, title: r.name || "", at: r.changedAt };
          }),
        });
      }
      if (g.key === "messages") {
        return Object.assign({}, g, {
          count: pm.unread,
          _ids: pm.unreadRows.map(function (r) { return r.id; }),
          items: [],
        });
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
      // The whole request travels, not a title: the panel draws the row that
      // decides whether to make the call, and every field on it is one the
      // agent needs before ringing a stranger.
      // count is how many were fetched, items is the handful the panel draws.
      // The difference is not a rounding error, it is the "+17 more" line, so
      // the panel is told both rather than left to infer one from the other.
      // demand() asks for 20, so an agent with more than that waiting sees 20
      // and a door to the dashboard, never a number larger than was fetched.
      if (g.key === "demand") {
        return Object.assign({}, g, {
          count: wants.length,
          _ids: wants.map(function (r) { return r.id; }),
          items: wants.slice(0, MAX_LIST),
        });
      }
      // `body` rides along now. A notice that can only be counted is a notice
      // the reader has to leave the page to read.
      if (g.key === "admin") {
        return Object.assign({}, g, {
          count: acct.unread,
          items: acct.items.slice(0, MAX_LIST).map(function (r) {
            return {
              id: r.id, title: r.title || "", body: r.body || "",
              at: r.created_at, severity: r.severity,
            };
          }),
        });
      }
      if (g.key === "groups") {
        return Object.assign({}, g, {
          count: pm.newThreads.length,
          _ids: pm.newThreads.map(function (t) { return t.thread_id; }),
          items: pm.newThreads.slice(0, MAX_LIST).map(function (t) {
            return { id: t.thread_id, title: t.title || "", at: t.last_at };
          }),
        });
      }
      var rows = byKey[g.key] || [];
      return Object.assign({}, g, {
        count: rows.length,
        // EVERY id, not the six drawn: see clear().
        _ids: rows.map(function (r) { return r.id; }),
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
    cache = Object.assign(tally(groups), {
      groups: groups, _threads: pm.threads, _billing: acct.billing,
    });
    return cache;
  }

  function emit() {
    var s = state();
    listeners.forEach(function (fn) { try { fn(s); } catch (_) {} });
    try { window.dispatchEvent(new CustomEvent("pawa:notify", { detail: s })); } catch (_) {}
  }

  function state() {
    return cache || { total: 0, news: 0, groups: GROUPS.map(function (g) {
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
   *
   * ALL OF THAT IS ABOUT TAPPING A ROW, and it still holds. It is not about
   * the clear button: see clear(), which every row now has.
   */
  var UNDISMISSABLE = {
    messages: true, trust: true, admin: true, renew: true, demand: true,
  };

  /**
   * Switching a kind of news off for good.
   *
   * Dismissing used to be a watermark and nothing else: markSeen() moved a
   * timestamp, so a row cleared and came straight back the moment one more
   * room was listed anywhere in the country. That is the right behaviour for
   * "I have read this" and the wrong one for "stop telling me", and there was
   * no way at all to say the second.
   *
   * WHICH kinds may be switched off, and where the answer is stored, both live
   * in js/lib/notify-mute.js — because Profile and the houses banner need the
   * same answer and neither of them wants this engine. What is added HERE is
   * the engine half: zeroing the cache the reader is looking at right now, and
   * going back to the server when something is switched on again.
   */
  var MUTE = function () { return window.NotifyMute || null; };

  function muted(key) {
    var M = MUTE();
    return !!(M && M.isMuted(key));
  }

  function setMuted(key, on) {
    var M = MUTE();
    if (!M || !M.setMuted(key, on)) return false;
    // The mark is what the NEXT poll reads; the cache is what is on screen
    // now. Leaving the two disagreeing is how a row survives its own off
    // switch until something unrelated happens to trigger a redraw.
    if (cache) {
      cache.groups.forEach(function (g) {
        if (g.key === key && on) { g.count = 0; g.items = []; }
      });
      Object.assign(cache, tally(cache.groups));
    }
    emit();
    if (!on) refresh();          // turning one back on has to go and look again
    return true;
  }

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
      Object.assign(cache, tally(cache.groups));
    }
    emit();
  }

  /**
   * CLEAR THIS ROW, AND DO NOT SHOW IT TO ME AGAIN.
   *
   * Writes down every id the row was counting (all of them: clearing "40 new
   * rooms" and remembering six brings thirty-four back on the next poll) and
   * zeroes the cached group, so the badge is right before that poll rather
   * than after it. For the catalogues it moves the watermark too, as belt and
   * braces against a row created before the mark and inserted after it.
   * js/lib/notify-clear.js says why this is neither a read mark nor a mute.
   *
   * EVERY ROW CAN BE CLEARED, and that is the change. UNDISMISSABLE still
   * governs markSeen(), because a tap on a row is not an acknowledgement. A
   * deliberate press on a button that says "clear this" is one, and refusing
   * it left people holding rows they could not put down.
   */
  function clear(key) {
    var g = cache && cache.groups.filter(function (x) { return x.key === key; })[0];
    if (key === "renew") return hideBilling();
    var ids = (g && g._ids) || [];
    remember(key, ids);
    // The mark is what the NEXT poll reads; the cached count is what is on the
    // screen now. Moving one without the other is how a row survives its own
    // clear button until something unrelated triggers a redraw.
    var m = mark();
    if (Object.prototype.hasOwnProperty.call(m, key) && key !== "threads") {
      m[key] = new Date().toISOString();
    }
    if (key === "groups") m.threads = (cache && cache._threads) || m.threads || [];
    saveSeen(m);
    if (cache) {
      cache.groups.forEach(function (x) {
        if (x.key === key) { x.count = 0; x.items = []; x._ids = []; x.alarm = false; }
      });
      Object.assign(cache, tally(cache.groups));
    }
    emit();
    return true;
  }

  /** Every row, gone. The admin notices are rows in the database, and
      notify-ui.js deletes them through Notices.clearAll() before calling this. */
  function clearAll() {
    (cache ? cache.groups : GROUPS).forEach(function (g) {
      if (g.key === "admin") return;
      clear(g.key);
    });
    return true;
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
      Object.assign(cache, tally(cache.groups));
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
    // "Clear this and never show it to me again", row by row. See clear().
    clear: clear,
    clearAll: clearAll,
    hideBilling: hideBilling,
    // Asked by notify-ui.js so "Mark all as read" hides when the only thing
    // left is an alarm that button cannot touch. A second copy of the list
    // over there would drift into offering a button that does nothing.
    isDismissible: function (key) { return !UNDISMISSABLE[key]; },
    // Switching a kind off for good, and the list of what is off. Asked by
    // notify-ui.js for the close button on a row, by profile.js for the
    // screen that offers them back, and by houses.js before it raises a
    // banner or an operating-system notification.
    isMutable: function (key) { return !!(MUTE() && MUTE().isMutable(key)); },
    isMuted: muted,
    setMuted: setMuted,
    mutedKeys: function () { return MUTE() ? MUTE().mutedKeys() : []; },
    get MUTABLE() { return (MUTE() && MUTE().MUTABLE) || {}; },
    on: function (fn) { if (typeof fn === "function") listeners.push(fn); },
    GROUPS: GROUPS,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
