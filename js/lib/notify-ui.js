// ============================================================================
//  Notifications — the bell, the badge, and the panel
// ============================================================================
//  js/core/notify.js works out what is new. This draws it: a bell in the
//  top-right corner carrying a count, and a panel grouped into sections by who
//  a thing is from, so a customer waiting for a call is never the same shape as
//  twelve new rooms.
//
//  Where the bell sits is the page's business, not this file's. On the three
//  agent pages it sits under the theme toggle and rises when the toggle fades;
//  on index.html the toggle takes the left corner and the bell simply owns the
//  right one. css/notify.css carries both.
//
//  Every mark here is a Lucide-style stroke SVG, so it takes the colour of the
//  text beside it and follows the theme without being told to. Every string
//  goes through i18n. Every colour, radius and space is a token.
//
//  WHAT AN ADMIN NOTICE DOES WHEN YOU TAP IT, AND WHY IT CHANGED
//  ------------------------------------------------------------
//  It used to be a link to profile.html#notices, and marking it read happened
//  over there. So a notice tapped HERE was never marked, the two-minute poll
//  brought it straight back, and the same four sentences arrived every day
//  until somebody made the second trip. The panel already has the title and
//  the body in hand, so the tap now OPENS the notice in place and marks it
//  read on the server, and reading it is the last time it appears.
//
//  Every notice also carries a bin. Read is a state; deleted is gone, and
//  "clear these and never show them to me again" is a request that only a
//  delete can answer. See notice_delete / notices_clear in
//  supabase/features/agent/agent_notices.sql.
// ============================================================================
(function () {
  "use strict";

  function tx(key, fallback, vars) {
    var out = fallback;
    if (window.t) {
      var got = window.t(key);
      if (got && got !== key) out = got;
    }
    if (vars) for (var k in vars) out = out.split("{" + k + "}").join(vars[k]);
    return out;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }

  var ICONS = {
    bell:    '<path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/>',
    room:    '<path d="M3 11l9-7 9 7M5 10v10h14V10M9 20v-6h6v6"/>',
    service: '<path d="M14.5 6.5a3.5 3.5 0 0 0 4.6 4.6l-8 8a2.3 2.3 0 0 1-3.2-3.2l8-8a3.5 3.5 0 0 0-1.4-1.4z"/><path d="M14.5 6.5 17 4"/>',
    truck:   '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="1.8"/><circle cx="17.5" cy="18" r="1.8"/>',
    job:     '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12h18"/>',
    message: '<path d="M21 14a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
    group:   '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20c0-3.3 2.9-5 6.5-5s6.5 1.7 6.5 5M17 5.2a3 3 0 0 1 0 6M18.5 20c0-2.6-1-4.2-2.7-5"/>',
    shield:  '<path d="M12 3l7 3v5.5c0 4.3-2.9 7.6-7 9.5-4.1-1.9-7-5.2-7-9.5V6z"/><path d="M12 9v4M12 16h.01"/>',
    clock:   '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.4l3.4 2"/>',
    stamp:   '<path d="M5 20h14M7 16h10v1.5H7z"/><path d="M9 16c0-2-2.5-3-2.5-6a5.5 5.5 0 0 1 11 0c0 3-2.5 4-2.5 6"/>',
    close:   '<path d="M6 6l12 12M18 6L6 18"/>',
    // A bin, not a cross. The cross on the subscription row HIDES a state that
    // is still true; this one deletes a row for good, and the two must not
    // look like the same promise.
    trash:   '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/>' +
             '<path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/>' +
             '<path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    check:   '<path d="M4 12.5l5 5L20 6.5"/>',
    empty:   '<circle cx="12" cy="12" r="9"/><path d="M8.5 13.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01"/>',
    // Somebody with their hand up: a person asking, not a thing posted.
    hand:    '<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 10.5V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M15 11V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a6 6 0 0 1-5.2-3l-1.9-3.3a1.5 1.5 0 0 1 2.4-1.8L9 14"/>',
  };
  function icon(name, cls) {
    return '<svg class="nt-ic' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + (ICONS[name] || "") + "</svg>";
  }

  // One sentence per kind of news, singular and plural, so neither language is
  // left saying "1 new rooms".
  var WORDS = {
    // Not "1 new safety number". Nothing here is news; something is wrong, and
    // the wording has to carry that or the row reads as one more thing posted.
    trust:    { one: ["nt_trust_1", "1 safety number changed"],
                many: ["nt_trusts", "{n} safety numbers changed"] },
    houses:   { one: ["nt_room_1", "1 new room"],       many: ["nt_rooms", "{n} new rooms"] },
    services: { one: ["nt_service_1", "1 new service"], many: ["nt_services", "{n} new services"] },
    trucks:   { one: ["nt_truck_1", "1 new truck"],     many: ["nt_trucks", "{n} new trucks"] },
    jobs:     { one: ["nt_job_1", "1 new day job"],     many: ["nt_jobs", "{n} new day jobs"] },
    messages: { one: ["nt_msg_1", "1 unread message"],  many: ["nt_msgs", "{n} unread messages"] },
    groups:   { one: ["nt_group_1", "1 new group chat"],many: ["nt_groups", "{n} new group chats"] },
    // The requests section draws its own rows and never reaches doorHtml, so
    // these two are the answer to "what if it ever does": a group with no
    // entry here renders a row with no words in it.
    demand:   { one: ["nt_want_1", "1 person is looking for a place"],
                many: ["nt_wants", "{n} people are looking for a place"] },
    // Not "1 new message from the admin" for one and "{n} new" for two: what
    // the admin sent is the same kind of thing either way, and the word that
    // matters is who it is from.
    admin:    { one: ["nt_admin_1", "1 message about your account"],
                many: ["nt_admins", "{n} messages about your account"] },
  };

  /**
   * The subscription row, which is the one row here that is not a count.
   *
   * Six states, and they are not the same sentence with a different number in
   * it: "ends in 5 days" is a reminder, "paused" is a listing that has already
   * left the board, and "not approved yet" is a seven-day window that closed.
   * Telling somebody the wrong one of those is worse than telling them
   * nothing, so each has its own line rather than a shared template.
   */
  var RENEW = {
    ending_0:  ["nt_renew_0",  "Your subscription ends today"],
    ending_1:  ["nt_renew_1",  "Your subscription ends tomorrow"],
    ending_n:  ["nt_renew_n",  "Your subscription ends in {n} days"],
    expired:   ["nt_renew_x",  "Your subscription has run out"],
    overdue:   ["nt_renew_o",  "Your subscription is overdue"],
    cancelled: ["nt_renew_c",  "Your subscription is cancelled"],
    deactivated: ["nt_renew_d", "Your listings are paused"],
    approval_expired: ["nt_renew_a", "Your account is waiting for approval"],
  };
  var RENEW_SUB = {
    ending:    ["nt_renew_ends_d", "Pay the admin before then and they will extend it."],
    expired:   ["nt_renew_off_d", "Your listings are off the public board until it is settled. Pay the admin to put them back."],
    overdue:   ["nt_renew_off_d", "Your listings are off the public board until it is settled. Pay the admin to put them back."],
    cancelled: ["nt_renew_off_d", "Your listings are off the public board until it is settled. Pay the admin to put them back."],
    deactivated: ["nt_renew_dead_d", "An admin has paused this account. Contact them to sort it out."],
    approval_expired: ["nt_renew_app_d", "An admin has to approve this account before your listings go back on the board."],
  };
  var SUBS = {
    trust:    ["nt_trust_d", "Check it before you send anything private. Sending is blocked until you do."],
    houses:   ["nt_room_d", "Rooms and houses posted since you last looked."],
    services: ["nt_service_d", "People offering everyday work near you."],
    trucks:   ["nt_truck_d", "Trucks available for moving."],
    jobs:     ["nt_job_d", "Day jobs you can claim a slot on."],
    messages: ["nt_msg_d", "Encrypted, waiting in P-Message."],
    groups:   ["nt_group_d", "Somebody added you to a conversation."],
    admin:    ["nt_admin_d", "From the Pawa admin, about your listings or your subscription."],
    demand:   ["nt_want_d", "Waiting in your area. Call them before somebody else does."],
  };

  // When the rooms row has been narrowed to this device's own area alerts, it
  // has to say so. "3 new rooms" and "3 new rooms in your areas" are different
  // claims, and a reader who cannot tell which one they are looking at cannot
  // tell whether the alert they saved is doing anything.
  var WATCHED = {
    one:  ["nt_room_w1", "1 new room in your areas"],
    many: ["nt_rooms_w", "{n} new rooms in your areas"],
    sub:  ["nt_room_wd", "Matching the areas and the budget you asked to be told about."],
  };

  function renewWords(g) {
    if (g.state === "ending") {
      var d = Number(g.days);
      var k = d <= 0 ? RENEW.ending_0 : d === 1 ? RENEW.ending_1 : RENEW.ending_n;
      return tx(k[0], k[1], { n: d });
    }
    var w = RENEW[g.state];
    return w ? tx(w[0], w[1]) : "";
  }

  function headline(g) {
    if (g.key === "renew") return renewWords(g);
    var w = (g.watched && g.key === "houses") ? WATCHED : WORDS[g.key];
    if (!w) return "";
    return g.count === 1 ? tx(w.one[0], w.one[1]) : tx(w.many[0], w.many[1], { n: g.count });
  }

  function subline(g) {
    if (g.watched && g.key === "houses") return tx(WATCHED.sub[0], WATCHED.sub[1]);
    if (g.key === "renew") {
      var s = RENEW_SUB[g.state === "ending" ? "ending" : g.state];
      return s ? tx(s[0], s[1]) : "";
    }
    return SUBS[g.key] ? tx(SUBS[g.key][0], SUBS[g.key][1]) : "";
  }

  // ---- when it happened -----------------------------------------------------
  /**
   * How long ago, in the shortest true form.
   *
   * The old panel showed no time at all, which is what made a notice that
   * arrived this morning and one from five weeks ago look identical. Minutes
   * for the first hour, hours for the first day, days after that, and a plain
   * date once "42 d" has stopped meaning anything to a reader.
   */
  function when(iso) {
    if (!iso) return "";
    var t = new Date(iso);
    if (isNaN(t)) return "";
    var mins = Math.floor((Date.now() - t.getTime()) / 60000);
    if (mins < 1) return tx("nt_when_now", "now");
    if (mins < 60) return tx("nt_when_min", "{n} min", { n: mins });
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return tx("nt_when_hour", "{n} h", { n: hrs });
    var days = Math.floor(hrs / 24);
    if (days <= 30) return tx("nt_when_day", "{n} d", { n: days });
    return String(iso).slice(0, 10);
  }

  // ---- the bell -------------------------------------------------------------
  var bell = null, badge = null, panel = null, backdrop = null;

  // Set by anything that changed the server's mind about what is unread:
  // opening a notice, binning one, or emptying the lot. The panel deliberately
  // does NOT re-render on those, because a render would pull the row out from
  // under the reader, so the badge is left saying a number that is no longer
  // true. This is the note that it owes a correction, and closePanel() pays it.
  var stale = false;

  function buildBell() {
    if (document.getElementById("pawa-notify-bell")) return;
    bell = document.createElement("button");
    bell.id = "pawa-notify-bell";
    bell.type = "button";
    bell.className = "pawa-notify-bell";
    bell.innerHTML = icon("bell") + '<span class="pawa-notify-badge" hidden></span>';
    badge = bell.querySelector(".pawa-notify-badge");
    bell.addEventListener("click", function () { openPanel(); });
    document.body.appendChild(bell);
    paintBadge(window.Notify ? window.Notify.state() : { total: 0, news: 0 });
  }

  /**
   * The badge counts what is ADDRESSED to this reader, and nothing else.
   *
   * It used to sum every group, so a quiet week with forty rooms posted read as
   * "40 things to get through" and buried the one customer waiting for a call.
   * Catalogue news still lights the bell, as a dot: there IS something, and the
   * number would not have told anybody what to do about it.
   */
  function paintBadge(st) {
    if (!bell || !badge) return;
    var mine = (st && st.total) || 0;
    var news = (st && st.news) || 0;
    badge.classList.toggle("is-dot", mine === 0 && news > 0);
    badge.textContent = mine === 0 ? "" : mine > 9 ? "9+" : String(mine);
    badge.hidden = mine === 0 && news === 0;
    bell.classList.toggle("has-news", mine > 0 || news > 0);
    var label = mine === 0
      ? tx("nt_open_none", "Notifications, nothing new")
      : tx("nt_open", "Notifications, {n} new", { n: mine });
    bell.setAttribute("aria-label", label);
    bell.setAttribute("title", label);
  }

  // ---- the three shapes a notification can take -----------------------------
  /**
   * Something is WRONG.
   *
   * Above every section, full width, nothing beside it to compare itself
   * against, and never a count: "1" next to a changed safety number reads as
   * one more thing to get through rather than the one thing to stop for.
   */
  function alarmHtml(g) {
    return withPut(g,
      '<a class="nt-alarm" href="' + esc(g.href) + '" data-key="' + esc(g.key) + '">' +
      icon(g.icon) +
      '<span class="nt-alarm-tx">' +
        '<span class="nt-alarm-h">' + esc(headline(g)) + "</span>" +
        '<span class="nt-alarm-d">' + esc(subline(g)) + "</span>" +
      "</span></a>");
  }

  /**
   * A row, and the button that puts it away.
   *
   * Only two things here can be put away, and they are put away differently.
   * A notice is a ROW: the bin deletes it, and it is gone from the bell, the
   * Profile tab and the database at once. The subscription is a STATE: nothing
   * wrote a row for it, so there is nothing to delete and the cross hides the
   * state as it stands today. js/core/notify.js keys that dismissal on the
   * reason and the date, so a subscription that moves speaks up again and one
   * that has not stays quiet. Two marks, because they are two promises.
   *
   * Everything else has no button at all, for the reason it never had one: a
   * customer waiting for a call is answered, an unread message is read, and a
   * changed safety number is compared. None of those is a thing to tidy away.
   */
  function withPut(g, inner) {
    if (g.key !== "renew") return inner;
    return '<div class="nt-line">' + inner +
      '<button type="button" class="nt-put" data-put="billing" aria-label="' +
        esc(tx("nt_hide_sub", "Hide this subscription notice")) + '">' +
        icon("close") + "</button></div>";
  }

  /**
   * One thing addressed to this reader, with when it arrived.
   *
   * An admin notice used to be a count over a fixed sentence: "1 message about
   * your account", then "From the Pawa admin, about your listings or your
   * subscription." What the admin actually SAID was fetched and thrown away.
   */
  function noticeHtml(g, it) {
    var sev = it.severity === "urgent" ? " is-urgent"
      : it.severity === "warn" ? " is-warn" : "";
    var id = esc(it.id || "");
    // A button, not an anchor. It used to be a link to profile.html#notices,
    // where the notice was read and, only there, marked read — so tapping it
    // here left it unread and the poll brought it back. The whole notice is
    // already in `it`; opening it in place is both the shorter route and the
    // one that can mark it read.
    return '<div class="nt-line" data-row="' + id + '">' +
      '<button type="button" class="nt-item' + sev + '" data-open="' + id + '">' +
        '<span class="nt-item-ic">' + icon(g.icon) + "</span>" +
        '<span class="nt-item-tx">' +
          '<span class="nt-item-h">' + esc(it.title || "") + "</span>" +
          (it.body ? '<span class="nt-item-b">' + esc(it.body) + "</span>" : "") +
        "</span>" +
        '<span class="nt-item-when"><span class="nt-item-dot"></span>' +
          esc(when(it.at)) + "</span>" +
      "</button>" +
      '<button type="button" class="nt-put nt-put--kill" data-put="notice:' + id + '" aria-label="' +
        esc(tx("nt_del_one", "Delete this notification")) + '">' +
        icon("trash") + "</button></div>";
  }

  /** Merely new in the catalogue: a count and a door, which is its right shape. */
  function doorHtml(g) {
    return withPut(g, doorInner(g));
  }

  function doorInner(g) {
    var items = (g.items || []).filter(function (i) { return i.title; }).slice(0, 3);
    var preview = items.length
      ? '<span class="nt-row-eg">' +
          items.map(function (i) { return esc(i.title); }).join(" · ") + "</span>"
      : "";
    return '<a class="nt-row" href="' + esc(g.href) + '" data-key="' + esc(g.key) + '">' +
      '<span class="nt-row-ic">' + icon(g.icon) + "</span>" +
      '<span class="nt-row-tx">' +
        '<span class="nt-row-h">' + esc(headline(g)) + "</span>" +
        '<span class="nt-row-d">' + esc(subline(g)) + "</span>" +
        preview +
      "</span>" +
      // The subscription row is a STATE, not a tally, and a "1" beside it reads
      // as one more thing to get through rather than the one thing to act on.
      (g.key === "renew" ? "" :
        '<span class="nt-row-n">' + (g.count > 99 ? "99+" : g.count) + "</span>") +
    "</a>";
  }

  /**
   * What a section holds, which depends on whether its rows are events.
   *
   * A customer request and an admin notice are things that happened to ONE
   * person and are read one at a time. Twelve new rooms is a number. Giving
   * both the same row is what made this panel unreadable.
   */
  function sectionBody(g) {
    if (g.key === "demand") {
      // Three rows, but the true count and the door, so the line underneath
      // reads "+17 more in your area" and goes somewhere. g.items is the
      // handful that travelled; g.count is how many there are.
      return window.DemandRows
        ? window.DemandRows.html(g.items || [], { limit: 3, total: g.count, href: g.href })
        : "";
    }
    if (g.key === "admin") {
      return (g.items || []).map(function (it) { return noticeHtml(g, it); }).join("");
    }
    return doorHtml(g);
  }

  var SECTION_WORDS = {
    wants:   ["nt_sec_wants", "Somebody wants a place"],
    account: ["nt_sec_account", "About your account"],
    nearby:  ["nt_sec_nearby", "New nearby"],
  };
  // Who it is from, in the order it matters: a customer waiting for a call
  // outranks a subscription reminder, and both outrank the catalogue.
  var SECTION_ORDER = ["wants", "account", "nearby"];

  function sectionHtml(name, groups) {
    if (!groups.length) return "";
    // Build the body FIRST. A section can count something it cannot draw: the
    // requests section needs js/lib/demand-rows.js, which only the three agent
    // portals load, and a heading reading "SOMEBODY WANTS A PLACE  4" over
    // nothing at all is worse than no section.
    var body = groups.map(sectionBody).join("");
    if (!body) return "";
    var w = SECTION_WORDS[name];
    var n = groups.reduce(function (a, g) { return a + g.count; }, 0);
    return '<section class="nt-sec" data-sec="' + esc(name) + '">' +
      '<h3 class="nt-sec-h">' + esc(tx(w[0], w[1])) +
        '<span class="nt-sec-n">' + (n > 99 ? "99+" : n) + "</span></h3>" +
      body +
    "</section>";
  }

  // ---- the panel ------------------------------------------------------------
  function emptyHtml() {
    return '<div class="nt-empty">' + icon("empty", "nt-empty-ic") +
      "<b>" + esc(tx("nt_none_t", "Nothing new")) + "</b>" +
      "<span>" + esc(tx("nt_none_d",
        "Nothing has been posted since you last looked. Check back later.")) + "</span></div>";
  }

  function bodyHtml(st) {
    var live = (st.groups || []).filter(function (g) { return g.count > 0; });
    if (!live.length) return emptyHtml();
    // An alarm leaves its section and goes to the rail. Trust is always one;
    // the subscription becomes one only when it is urgent, which is why this
    // reads the flag rather than the key.
    var out = live.filter(function (g) { return g.alarm; }).map(alarmHtml).join("");
    var rest = live.filter(function (g) { return !g.alarm; });
    SECTION_ORDER.forEach(function (name) {
      out += sectionHtml(name, rest.filter(function (g) { return g.section === name; }));
    });
    return out;
  }

  /**
   * The two footer buttons, and whether either still has anything to act on.
   *
   * It asks the PANEL what is on screen, not the engine what it last counted,
   * and that is the point: a notice binned in place is gone from the screen
   * while the engine's cached count still holds it, because the count is only
   * put right when the panel closes. Reading the DOM is the one question whose
   * answer is true at both moments — otherwise binning the last notice leaves
   * "Delete all" sitting over nothing, offering to delete it again.
   *
   * The catalogue half still comes from the engine, because "12 new rooms" is
   * one row whose count no tap in here changes.
   */
  function syncFoot(st) {
    if (!panel) return;
    var hasNotice  = !!panel.querySelector(".nt-line[data-row]");
    var hasBilling = !!panel.querySelector('[data-put="billing"]');
    var read = panel.querySelector('[data-foot="read"]');
    var wipe = panel.querySelector('[data-foot="wipe"]');
    var foot = panel.querySelector(".nt-foot");

    // "Mark all as read" covers what a LOCAL mark can retire plus the notices,
    // which are marked on the server instead. That second half was the one
    // missing: the button hid itself whenever notices were all that was left.
    if (read) read.hidden = !(hasNotice || ((st && st.groups) || []).some(function (g) {
      return g.count > 0 && (!window.Notify || window.Notify.isDismissible(g.key));
    }));

    // "Delete all" is only offered for the two things that can actually be put
    // away for good: the notices, which are rows, and the subscription state,
    // which is hidden until it moves. Offering it over twelve new rooms would
    // promise a delete this app cannot perform.
    if (wipe) wipe.hidden = !(hasNotice || hasBilling);

    if (foot) foot.hidden = (!read || read.hidden) && (!wipe || wipe.hidden);
  }

  function render() {
    if (!panel) return;
    var st = window.Notify ? window.Notify.state() : { total: 0, news: 0, groups: [] };
    panel.querySelector(".nt-body").innerHTML = bodyHtml(st);
    askOff();
    syncFoot(st);
  }

  function buildPanel() {
    if (panel) return;
    backdrop = document.createElement("div");
    backdrop.className = "nt-backdrop";
    backdrop.hidden = true;
    backdrop.addEventListener("click", closePanel);

    panel = document.createElement("div");
    panel.className = "nt-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.hidden = true;
    panel.innerHTML =
      '<div class="nt-head">' +
        "<b>" + esc(tx("nt_title", "Notifications")) + "</b>" +
        '<button type="button" class="nt-x" aria-label="' + esc(tx("nt_close", "Close")) + '">' +
          icon("close") + "</button>" +
      "</div>" +
      '<div class="nt-body"></div>' +
      '<div class="nt-foot" hidden>' +
        '<button type="button" class="nt-clear" data-foot="read" hidden>' + icon("check") +
          "<span>" + esc(tx("nt_mark_all", "Mark all as read")) + "</span></button>" +
        '<button type="button" class="nt-clear nt-clear--kill" data-foot="wipe" hidden>' +
          icon("trash") +
          "<span>" + esc(tx("nt_clear_all", "Delete all")) + "</span></button>" +
        // The question lives in the panel rather than in a window.confirm.
        // The panel is already a modal, and stacking a browser dialog on it is
        // the one thing on this screen a phone renders worse than the screen
        // itself. Hidden, not absent: nothing is rebuilt on the way to a
        // destructive answer.
        '<div class="nt-ask" hidden role="group" aria-label="' +
            esc(tx("nt_clear_all", "Delete all")) + '">' +
          '<p class="nt-ask-q">' + esc(tx("nt_clear_q",
            "Delete every notification? This cannot be undone.")) + "</p>" +
          '<div class="nt-ask-acts">' +
            '<button type="button" class="nt-ask-b" data-foot="cancel">' +
              esc(tx("nt_clear_no", "Cancel")) + "</button>" +
            '<button type="button" class="nt-ask-b is-kill" data-foot="yes">' +
              esc(tx("nt_clear_yes", "Yes, delete")) + "</button>" +
          "</div>" +
        "</div>" +
      "</div>";

    panel.querySelector(".nt-x").addEventListener("click", closePanel);
    // One delegated listener, bound once. Re-binding per row after every
    // render is how a 120 second poll ends up with six listeners on a row that
    // has only been drawn once.
    panel.addEventListener("click", onPanelClick);
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
  }

  // ---- what a tap in the panel means ---------------------------------------
  /** The question, up or down, with the two buttons out of the way while it is. */
  function askOn(on) {
    if (!panel) return;
    var ask = panel.querySelector(".nt-ask");
    if (!ask) return;
    ask.hidden = !on;
    // The buttons go away while the question is up, so the answer is the only
    // thing on the strip and "Delete all" cannot be tapped a second time.
    panel.querySelectorAll('[data-foot="read"], [data-foot="wipe"]').forEach(function (b) {
      b.classList.toggle("is-away", !!on);
    });
    if (on) {
      var yes = ask.querySelector('[data-foot="yes"]');
      if (yes) yes.focus();
    }
  }
  function askOff() { askOn(false); }

  /** An id is a uuid out of our own database, but never build a selector on trust. */
  function cssId(id) {
    return String(id == null ? "" : id).replace(/[^A-Za-z0-9_-]/g, "");
  }

  function lineOf(id) {
    var key = cssId(id);
    return key && panel ? panel.querySelector('.nt-line[data-row="' + key + '"]') : null;
  }

  /**
   * A notice, opened where it already is.
   *
   * The row carries the whole thing, so there is nothing to fetch and nowhere
   * to go: the body un-clamps in place and the notice is marked read on the
   * server. It is deliberately NOT re-rendered afterwards, because a render
   * would drop the row the reader is halfway through: my_notices() stops
   * returning what it has just been told was read. The badge catches up when
   * the panel closes.
   */
  function openNotice(id) {
    var line = lineOf(id);
    if (!line) return;
    line.classList.toggle("is-open");
    if (line.dataset.read === "1") return;
    line.dataset.read = "1";
    var dot = line.querySelector(".nt-item-dot");
    if (dot) dot.remove();
    stale = true;
    if (window.Notices && window.Notices.markRead) window.Notices.markRead(id);
  }

  /**
   * Take one row off the panel without redrawing the rest.
   *
   * A redraw is NOT an option here, and this is the trap worth naming. The
   * engine keeps its own copy of what it last counted and only puts it right
   * on a refresh, so calling render() after binning a row would ask it to draw
   * the panel from a cache that still holds that row, and the notice would
   * reappear on the screen it was just deleted from. Everything that puts a
   * row away does this instead, and the badge is reconciled once, on close.
   */
  function dropLine(line) {
    if (!line || !panel) return;
    var sec = line.closest(".nt-sec");
    line.remove();
    // A heading over nothing is worse than no heading, and the count beside
    // it is already wrong, so the whole section goes when it empties.
    if (sec && !sec.querySelector(".nt-line, .nt-row, .dm-row")) sec.remove();
    if (!panel.querySelector(".nt-sec, .nt-alarm, .nt-line")) {
      panel.querySelector(".nt-body").innerHTML = emptyHtml();
    }
    syncFoot(window.Notify ? window.Notify.state() : null);
  }

  /** Delete one notice, and take its row out without redrawing the others. */
  function killNotice(id) {
    // A deleted notice is one the badge is still counting, and unlike a read
    // one it leaves no opened row behind to notice on the way out. Without
    // this, binning four notices and closing the panel left the bell claiming
    // four until the two-minute poll, which is the same "it came back" the
    // whole change exists to end.
    stale = true;
    dropLine(lineOf(id));
    if (window.Notices && window.Notices.remove) window.Notices.remove(id);
  }

  /**
   * Everything, gone.
   *
   * The rows first, because that is what was asked for. markAllSeen() then
   * retires the catalogue marks, and hideBilling() silences the subscription
   * state, which has no row to delete and would otherwise be the one thing
   * still sitting on a panel the reader has just emptied.
   */
  async function wipeAll() {
    if (window.Notices && window.Notices.clearAll) await window.Notices.clearAll(false);
    if (window.Notify) {
      if (window.Notify.hideBilling) window.Notify.hideBilling();
      window.Notify.markAllSeen();
      await window.Notify.refresh();
    }
    // Refreshed and redrawn here, so the badge is already right and closing
    // owes nothing.
    stale = false;
    render();
  }

  /** Read, not gone: the rows stay in the database and leave the bell. */
  async function readAll() {
    if (window.Notices && window.Notices.markAll) await window.Notices.markAll();
    if (window.Notify) {
      window.Notify.markAllSeen();
      await window.Notify.refresh();
    }
    stale = false;
    render();
  }

  function onPanelClick(e) {
    if (!panel) return;

    var put = e.target.closest("[data-put]");
    if (put && panel.contains(put)) {
      e.preventDefault();
      var what = put.dataset.put;
      if (what === "billing") {
        // hideBilling() zeroes the subscription in the engine's cache, so a
        // render would draw this panel right — but it would also redraw any
        // notice binned a moment ago, because nothing told the engine about
        // those. The same surgery, for the same reason. See dropLine().
        if (window.Notify && window.Notify.hideBilling) window.Notify.hideBilling();
        dropLine(put.closest(".nt-line"));
      } else if (what.indexOf("notice:") === 0) {
        killNotice(what.slice(7));
      }
      return;
    }

    var open = e.target.closest("[data-open]");
    if (open && panel.contains(open)) { openNotice(open.dataset.open); return; }

    var foot = e.target.closest("[data-foot]");
    if (foot && panel.contains(foot)) {
      var act = foot.dataset.foot;
      if (act === "read") { readAll(); return; }
      if (act === "wipe") { askOn(true); return; }
      if (act === "cancel") { askOff(); return; }
      if (act === "yes") { askOff(); wipeAll(); return; }
      return;
    }

    // A row is a door AND a dismissal: opening the page is the same as saying
    // "I have seen these", so the badge does not still claim them on the way
    // back. A customer request carries no data-key and is skipped here: it is
    // answered by the Call button on it, or it passes its date.
    var link = e.target.closest("[data-key]");
    if (link && panel.contains(link) && window.Notify) window.Notify.markSeen(link.dataset.key);
  }

  function openPanel() {
    buildPanel();
    if (window.Notify) window.Notify.refresh();
    render();
    backdrop.hidden = false;
    panel.hidden = false;
    requestAnimationFrame(function () { panel.classList.add("is-on"); });
    document.addEventListener("keydown", onEsc);
    panel.querySelector(".nt-x").focus();
  }

  function closePanel() {
    if (!panel) return;
    askOff();
    // Notices read or binned in place were left on screen on purpose, so the
    // badge is still counting rows the server no longer has. Closing is the
    // moment it is allowed to catch up, because nobody is reading a row that
    // a re-render would now pull away.
    if (stale && window.Notify) window.Notify.refresh();
    stale = false;
    panel.classList.remove("is-on");
    document.removeEventListener("keydown", onEsc);
    // Wait for the slide-out before hiding, or it vanishes instead of leaving.
    setTimeout(function () {
      if (!panel.classList.contains("is-on")) { panel.hidden = true; backdrop.hidden = true; }
    }, 200);
    if (bell) bell.focus();
  }

  function onEsc(e) { if (e.key === "Escape") closePanel(); }

  // ---- boot -----------------------------------------------------------------
  // There is no injectStyles() any more. The panel is styled by css/notify.css,
  // which every page that mounts the bell links, so both themes come from the
  // tokens flipping rather than a second hand-written palette, and
  // scripts/design/check_tokens.mjs can finally read the app's most-seen
  // control.
  function init() {
    if (!document.body) return;
    buildBell();
    if (window.Notify) {
      window.Notify.on(function (st) {
        paintBadge(st);
        if (panel && !panel.hidden) render();
      });
    }
  }

  // The panel, openable by something other than the bell. The agent notice
  // strip gives every notice an action, and when a notice has nowhere else to
  // go that action opens this. Synthesising a click on #pawa-notify-bell was
  // the alternative, and it breaks the moment the bell has not mounted yet.
  window.NotifyUI = { open: openPanel, close: closePanel };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
