// =====================================================================
// pm-presence.js — "are they there right now, and if not, when were they
// last?"
//
// The agent list could say what somebody deals in and where they work. It
// could not say the thing a person actually wants to know before typing:
// is anyone going to read this today. A directory in which most names have
// not opened the app since March is a queue with no server, and the only
// way to discover that was to write to each of them and wait.
//
// TWO HALVES, AND BOTH ARE HERE ON PURPOSE
//   • the heartbeat — start()/stop(), which tell the database this device
//     has P-Message open, no more often than once a minute;
//   • the words — label()/state(), which turn a timestamp into "Online",
//     "Last opened 20 minutes ago" or "Last opened on 14 August".
// Two files would have let the window that decides "online" drift apart
// from the beat that keeps it true.
//
// WHAT IT CLAIMS, EXACTLY
// last_seen is when they last had P-MESSAGE OPEN. Not when they were last
// on the site, not when they published a key. Anything looser would be a
// worse predictor of a reply, which is the only reason the number is on
// screen at all.
//
// NULL IS NOT ZERO. Somebody with no record has not been "away for ever";
// they have not been seen since this shipped. state() returns "unknown"
// and every caller draws nothing — inventing "last seen in June" out of
// when their key row was written would be a guess printed as a fact.
//
// AND IT IS METADATA. Presence is not encrypted and cannot be: the server
// has to hold it to hand it out. The database keeps it out of reach of
// direct reads (pm_presence has RLS and not one policy) and hands it only
// to callers who could already see the person — the directory, a thread
// you share, your own inbox. docs/P_MESSAGE.md lists it beside "who wrote
// to whom, and when".
// =====================================================================
(function () {
  "use strict";

  // Mirrors public.pm_online_window() (150 seconds). The database is the
  // authority; this is the local copy used to colour a dot, and it is
  // refreshed from the server on start() so the two cannot drift.
  var ONLINE_WINDOW_MS = 150 * 1000;

  // Half the window, so one dropped beat never makes a person who is
  // sitting right there look gone. The RPC itself skips the write when the
  // stored value is already fresh, so beating early costs nothing.
  var BEAT_MS = 60 * 1000;

  var timer = null;
  var store = null;

  function now() { return Date.now(); }

  function ms(iso) {
    if (!iso) return null;
    var t = new Date(iso).getTime();
    return isNaN(t) ? null : t;
  }

  /**
   * "online" | "recent" | "away" | "unknown"
   *
   * `recent` exists because "online" and "last seen 4 hours ago" are not
   * the only two states worth telling apart: somebody who closed the tab
   * eight minutes ago is, for the purpose of "will they answer", still
   * there. It gets its own colour and its own sentence.
   */
  function state(iso) {
    var t = ms(iso);
    if (t == null) return "unknown";
    var age = now() - t;
    // A clock ahead of ours is not a person from the future. Treat any
    // negative age as "just now" rather than letting it fall through to
    // "away" via a nonsense number.
    if (age < ONLINE_WINDOW_MS) return "online";
    if (age < 15 * 60 * 1000) return "recent";
    return "away";
  }

  function isOnline(iso) { return state(iso) === "online"; }

  function tr(key, fallback, vars) {
    var s = (window.t && window.t(key)) || fallback;
    if (s === key) s = fallback;
    if (vars) Object.keys(vars).forEach(function (k) {
      s = s.replace("{" + k + "}", vars[k]);
    });
    return s;
  }

  /**
   * The sentence under a name.
   *
   * Coarse on purpose, and coarser the further back it goes. "Last opened
   * 3 days ago" and "last opened 3 days and 4 hours ago" answer the same
   * question, and the second one is a tracking readout. Minutes are the
   * finest it ever gets, matching what the database returns.
   */
  function label(iso) {
    var s = state(iso);
    if (s === "unknown") return "";
    if (s === "online") return tr("pm_seen_online", "Online now");

    var age = Math.max(0, now() - ms(iso));
    var mins = Math.floor(age / 60000);
    if (mins < 60) {
      return mins <= 1
        ? tr("pm_seen_justnow", "Last opened a minute ago")
        : tr("pm_seen_mins", "Last opened {n} minutes ago", { n: mins });
    }
    var hours = Math.floor(mins / 60);
    if (hours < 24) {
      return hours === 1
        ? tr("pm_seen_hour", "Last opened an hour ago")
        : tr("pm_seen_hours", "Last opened {n} hours ago", { n: hours });
    }
    var days = Math.floor(hours / 24);
    if (days < 7) {
      return days === 1
        ? tr("pm_seen_yesterday", "Last opened yesterday")
        : tr("pm_seen_days", "Last opened {n} days ago", { n: days });
    }
    // Past a week the interesting fact is the date, not the arithmetic.
    var d = new Date(ms(iso));
    var when = d.toLocaleDateString(undefined, { day: "numeric", month: "long" });
    return tr("pm_seen_on", "Last opened on {date}", { date: when });
  }

  /**
   * The dot and its sentence, as one span, so every list that draws
   * presence draws the same thing. Returns "" for unknown — a caller that
   * concatenates this into a row gets nothing rather than an empty badge.
   */
  function html(iso) {
    var s = state(iso);
    if (s === "unknown") return "";
    var text = label(iso);
    return '<span class="pm-seen is-' + s + '" title="' + escAttr(text) + '">' +
      '<i aria-hidden="true"></i><span>' + escAttr(text) + "</span></span>";
  }

  function escAttr(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /**
   * Start beating.
   *
   * Called once, by p-message.html and nowhere else. Other pages of the
   * site do not beat, because "last opened P-Message" is the claim, and a
   * heartbeat from houses.html would quietly turn it into "last used the
   * site" — the same number meaning something weaker, with nothing on
   * screen to say so.
   *
   * Beats immediately, then every minute, and again whenever the tab comes
   * back to the front (a phone suspends timers the moment the screen
   * locks, so the interval alone would report somebody as present for the
   * whole night and then absent the moment they returned).
   */
  function start(pmStore) {
    store = pmStore || window.PMStore;
    stop();
    if (!store || !store.touchSeen) return;

    beat();
    timer = setInterval(beat, BEAT_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", beat);

    // Take the window from the database once, so a change there does not
    // need a client release. A failure leaves the local default standing.
    if (store.onlineWindow) {
      store.onlineWindow().then(function (secs) {
        if (secs && secs > 0) ONLINE_WINDOW_MS = secs * 1000;
      }).catch(function () {});
    }
  }

  function onVisible() { if (!document.hidden) beat(); }

  function beat() {
    if (!store || !store.touchSeen) return;
    // Failures are silent by design. A missed heartbeat means somebody
    // looks away for a minute; an error toast over the conversation would
    // be a worse outcome than the thing it reports.
    try { store.touchSeen().catch(function () {}); } catch (_) {}
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", beat);
  }

  window.PMPresence = {
    state: state,
    isOnline: isOnline,
    label: label,
    html: html,
    start: start,
    stop: stop,
    // For tests, which cannot wait 150 real seconds to watch a dot change.
    _window: function () { return ONLINE_WINDOW_MS; },
  };
})();
