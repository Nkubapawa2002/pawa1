// ============================================================================
//  Notifications — the bell, the badge, and the panel
// ============================================================================
//  js/core/notify.js works out what is new. This draws it: a bell that rides
//  under the theme toggle carrying a count, and a panel listing what changed,
//  each row a door to the page it happened on.
//
//  Every mark here is a Lucide-style stroke SVG, so it takes the colour of the
//  text beside it and follows the theme without being told to. Every string
//  goes through i18n. Every colour, radius and space is a token.
// ============================================================================
(function () {
  "use strict";

  var PANEL_Z = 1050;

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
    check:   '<path d="M4 12.5l5 5L20 6.5"/>',
    empty:   '<circle cx="12" cy="12" r="9"/><path d="M8.5 13.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01"/>',
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

  // ---- the bell -------------------------------------------------------------
  var bell = null, badge = null, panel = null, backdrop = null;

  function injectStyles() {
    if (document.getElementById("pawa-notify-styles")) return;
    var s = document.createElement("style");
    s.id = "pawa-notify-styles";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

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
    paintBadge(window.Notify ? window.Notify.state() : { total: 0 });
  }

  function paintBadge(st) {
    if (!bell || !badge) return;
    var n = (st && st.total) || 0;
    // 9+ rather than a number that grows the pill off the edge of the button.
    badge.textContent = n > 9 ? "9+" : String(n);
    badge.hidden = n === 0;
    bell.classList.toggle("has-news", n > 0);
    var label = n === 0
      ? tx("nt_open_none", "Notifications, nothing new")
      : tx("nt_open", "Notifications, {n} new", { n: n });
    bell.setAttribute("aria-label", label);
    bell.setAttribute("title", label);
  }

  // ---- the panel ------------------------------------------------------------
  function rowsHtml(st) {
    var live = (st.groups || []).filter(function (g) { return g.count > 0; });
    if (!live.length) {
      return '<div class="nt-empty">' + icon("empty", "nt-empty-ic") +
        "<b>" + esc(tx("nt_none_t", "Nothing new")) + "</b>" +
        "<span>" + esc(tx("nt_none_d",
          "Nothing has been posted since you last looked. Check back later.")) + "</span></div>";
    }
    return live.map(function (g) {
      var items = (g.items || []).filter(function (i) { return i.title; }).slice(0, 3);
      var preview = items.length
        ? '<span class="nt-row-eg">' + items.map(function (i) { return esc(i.title); }).join(" · ") + "</span>"
        : "";
      return '<a class="nt-row' + (g.alarm ? " is-alarm" : "") + '" href="' + esc(g.href) +
        '" data-key="' + esc(g.key) + '">' +
        '<span class="nt-row-ic">' + icon(g.icon) + "</span>" +
        '<span class="nt-row-tx">' +
          '<span class="nt-row-h">' + esc(headline(g)) + "</span>" +
          '<span class="nt-row-d">' + esc(subline(g)) + "</span>" +
          preview +
        "</span>" +
        // The subscription row is a STATE, not a tally, and a "1" beside it
        // reads as one more thing to get through rather than the one thing to
        // act on. Every other row is a count and keeps its number.
        (g.key === "renew" ? "" :
          '<span class="nt-row-n">' + (g.count > 99 ? "99+" : g.count) + "</span>") +
      "</a>";
    }).join("");
  }

  function render() {
    if (!panel) return;
    var st = window.Notify ? window.Notify.state() : { total: 0, groups: [] };
    panel.querySelector(".nt-body").innerHTML = rowsHtml(st);
    var clear = panel.querySelector(".nt-clear");
    // The engine owns the list of rows this button cannot touch; asking it
    // beats keeping a second copy here, which is how the button ends up
    // offered for an alarm it will not clear.
    if (clear) clear.hidden = !(st.groups || []).some(function (g) {
      return g.count > 0 && (!window.Notify || window.Notify.isDismissible(g.key));
    });
    // A row is a door AND a dismissal: opening the page is the same as saying
    // "I have seen these", so the badge does not still claim them on the way back.
    panel.querySelectorAll(".nt-row").forEach(function (a) {
      a.addEventListener("click", function () {
        if (window.Notify) window.Notify.markSeen(a.dataset.key);
      });
    });
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
        "<b>" + esc(tx("nt_title", "What's new")) + "</b>" +
        '<button type="button" class="nt-x" aria-label="' + esc(tx("nt_close", "Close")) + '">' +
          icon("close") + "</button>" +
      "</div>" +
      '<div class="nt-body"></div>' +
      '<button type="button" class="nt-clear" hidden>' + icon("check") +
        "<span>" + esc(tx("nt_mark_all", "Mark all as read")) + "</span></button>";

    panel.querySelector(".nt-x").addEventListener("click", closePanel);
    panel.querySelector(".nt-clear").addEventListener("click", function () {
      if (window.Notify) window.Notify.markAllSeen();
      render();
    });
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
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
  function init() {
    if (!document.body) return;
    injectStyles();
    buildBell();
    if (window.Notify) {
      window.Notify.on(function (st) {
        paintBadge(st);
        if (panel && !panel.hidden) render();
      });
    }
  }

  var CSS = [
    /* The bell rides under the theme toggle: same right edge, same size, one
       gap below it. The toggle fades out after five seconds; this does not,
       because a badge nobody can see is not a notification. */
    ".pawa-notify-bell{",
    "  position:fixed; z-index:1000;",
    "  top:calc(env(safe-area-inset-top,0px) + 60px); right:12px;",
    "  width:42px; height:42px; border-radius:50%;",
    "  display:flex; align-items:center; justify-content:center;",
    "  cursor:pointer; -webkit-tap-highlight-color:transparent;",
    "  border:1px solid rgba(255,255,255,.14);",
    "  background:rgba(14,24,18,.55); color:#e7f1ec;",
    "  -webkit-backdrop-filter:blur(14px) saturate(1.1); backdrop-filter:blur(14px) saturate(1.1);",
    "  box-shadow:0 6px 20px rgba(0,0,0,.28);",
    "  transition:transform .18s var(--ease,cubic-bezier(.2,.7,.2,1)), background .25s ease;",
    "}",
    ".pawa-notify-bell:active{ transform:scale(.9); }",
    /* When the theme toggle fades out, the bell takes its slot. Two floating
       controls in the top-right corner is one more than that corner has room
       for on a 390px screen: stacked, the lower one sits on index.html's
       search button. At rest there is now exactly one, in the place the app
       has always put a floating control, and the pair only appears while the
       reader is actually touching the screen. */
    ":root.pawa-toggle-idle .pawa-notify-bell{",
    "  top:calc(env(safe-area-inset-top,0px) + 10px);",
    "}",
    ".pawa-notify-bell{ transition:top .28s var(--ease,cubic-bezier(.2,.7,.2,1)),",
    "  transform .18s var(--ease,cubic-bezier(.2,.7,.2,1)), background .25s ease; }",
    ".pawa-notify-bell .nt-ic{ width:21px; height:21px; }",
    ":root[data-theme=\"light\"] .pawa-notify-bell{",
    "  background:rgba(255,255,255,.72); color:#1a1915;",
    "  border-color:rgba(20,20,15,.10); box-shadow:0 6px 18px rgba(20,30,25,.14);",
    "}",
    /* The badge is the whole point of the control, so it reads as the brand
       colour rather than a warning red: this is news, not an error. */
    ".pawa-notify-badge{",
    "  position:absolute; top:-3px; right:-3px; min-width:18px; height:18px;",
    "  padding:0 5px; border-radius:var(--radius-pill,999px);",
    "  display:flex; align-items:center; justify-content:center;",
    "  font:700 11px/1 var(--font-ui,system-ui,sans-serif);",
    "  font-feature-settings:\"tnum\",\"zero\";",
    "  background:var(--brand-primary); color:var(--text-on-brand);",
    "  box-shadow:0 0 0 2px rgba(0,0,0,.35);",
    "}",
    ":root[data-theme=\"light\"] .pawa-notify-badge{ box-shadow:0 0 0 2px var(--white); }",
    /* display:flex above beats the `hidden` ATTRIBUTE, so a count of zero drew
       a "0" pill instead of nothing. Any element that ships hidden needs this
       line beside its display rule, or the attribute is decorative. */
    ".pawa-notify-badge[hidden]{ display:none; }",
    ".pawa-notify-bell.has-news .nt-ic{ animation:ntRing 1.6s var(--ease,ease) 1; transform-origin:50% 4px; }",
    "@keyframes ntRing{ 0%,100%{transform:rotate(0)} 15%{transform:rotate(13deg)} 30%{transform:rotate(-11deg)} 45%{transform:rotate(7deg)} 60%{transform:rotate(-5deg)} }",

    ".nt-backdrop{ position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:" + PANEL_Z + "; }",
    /* A sheet from the top-right, which is where the bell is: the panel should
       look like it came out of the control that opened it. */
    ".nt-panel{",
    "  position:fixed; z-index:" + (PANEL_Z + 1) + ";",
    "  top:calc(env(safe-area-inset-top,0px) + 10px); right:10px; left:10px;",
    "  max-width:420px; margin-left:auto;",
    "  max-height:min(76vh,560px); display:flex; flex-direction:column;",
    "  background:var(--surface-app); color:var(--text);",
    "  border:1px solid var(--border-strong);",
    "  border-radius:var(--radius-xl,24px); box-shadow:var(--shadow-3,0 16px 36px rgba(0,0,0,.55));",
    "  font-family:var(--font-app,system-ui,sans-serif); overflow:hidden;",
    "  transform:translateY(-10px) scale(.98); opacity:0;",
    "  transition:transform .2s var(--ease,cubic-bezier(.2,.7,.2,1)), opacity .2s ease;",
    "}",
    ".nt-panel.is-on{ transform:none; opacity:1; }",
    ":root[data-theme=\"light\"] .nt-panel{ background:var(--white); color:var(--text-ink); border-color:rgba(20,30,25,.14); }",
    ".nt-head{ display:flex; align-items:center; justify-content:space-between; gap:var(--space-3,12px);",
    "  padding:var(--space-4,16px) var(--space-4,16px) var(--space-2,8px); }",
    ".nt-head b{ font-size:var(--text-md,1.15rem); font-weight:var(--fw-extra,800); }",
    ".nt-x{ width:34px; height:34px; border-radius:var(--radius-pill,999px); border:0; cursor:pointer;",
    "  display:flex; align-items:center; justify-content:center; background:transparent; color:inherit; opacity:.7; }",
    ".nt-x:hover{ opacity:1; background:rgba(127,127,127,.14); }",
    ".nt-x .nt-ic{ width:18px; height:18px; }",
    /* flex:1 with min-height:0 — a flex item will not shrink below its content
       without the second half, so the list overflowed the panel and the button
       below it ended up drawn on top of the last row. */
    ".nt-body{ flex:1 1 auto; min-height:0; overflow-y:auto;",
    "  padding:0 var(--space-2,8px) var(--space-2,8px); }",

    ".nt-row{ display:flex; align-items:flex-start; gap:var(--space-3,12px); text-decoration:none;",
    "  color:inherit; padding:var(--space-3,12px); border-radius:var(--radius,12px);",
    "  transition:background .14s ease; }",
    ".nt-row:hover{ background:rgba(127,127,127,.12); }",
    ".nt-row-ic{ flex:0 0 auto; width:36px; height:36px; border-radius:var(--radius-sm,10px);",
    "  display:flex; align-items:center; justify-content:center;",
    "  background:var(--green-soft); color:var(--brand-primary); }",
    /* An alarm is not news, so it does not wear the brand green every other
       row wears. --warn rather than --danger: the key MAY have changed because
       somebody reinstalled the app, and painting that red would teach people
       to dismiss the one row that is worth stopping for. */
    ".nt-row.is-alarm .nt-row-ic{ background:color-mix(in srgb, var(--warn) 16%, transparent);",
    "  color:var(--warn); }",
    ".nt-row.is-alarm .nt-row-h{ color:var(--warn); }",
    ".nt-row-ic .nt-ic{ width:19px; height:19px; }",
    ".nt-row-tx{ flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }",
    ".nt-row-h{ font-weight:var(--fw-bold,700); font-size:var(--text-sm,.85rem); }",
    ".nt-row-d{ font-size:var(--text-xs,.72rem); opacity:.6; line-height:1.4; }",
    /* The examples are what turn a count into news: "3 new rooms" is a number,
       "Mwenge single, Sinza bedsitter" is a reason to tap. */
    ".nt-row-eg{ font-size:var(--text-xs,.72rem); opacity:.85; margin-top:3px;",
    "  color:var(--link); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
    ":root[data-theme=\"light\"] .nt-row-eg{ color:#0a6647; }",
    ".nt-row-n{ flex:0 0 auto; font-family:var(--font-mono,ui-monospace,monospace);",
    "  font-feature-settings:\"tnum\",\"zero\"; font-weight:var(--fw-bold,700);",
    "  font-size:var(--text-sm,.85rem); opacity:.75; }",

    ".nt-empty{ display:flex; flex-direction:column; align-items:center; gap:var(--space-2,8px);",
    "  text-align:center; padding:var(--space-8,32px) var(--space-5,20px); }",
    ".nt-empty-ic{ width:34px; height:34px; opacity:.35; }",
    ".nt-empty b{ font-size:var(--text-sm,.85rem); font-weight:var(--fw-bold,700); }",
    ".nt-empty span{ font-size:var(--text-xs,.72rem); opacity:.6; line-height:1.5; max-width:26ch; }",

    ".nt-clear{ flex:0 0 auto; display:flex; align-items:center; justify-content:center; gap:var(--space-2,8px);",
    "  width:calc(100% - 16px); margin:0 8px 12px; min-height:var(--hit-min,44px);",
    "  border:1px solid var(--border-strong); background:transparent;",
    "  color:inherit; border-radius:var(--radius,12px); cursor:pointer; font:inherit;",
    "  font-size:var(--text-sm,.85rem); font-weight:var(--fw-semibold,600); }",
    ".nt-clear:hover{ background:rgba(127,127,127,.12); }",
    ".nt-clear .nt-ic{ width:17px; height:17px; }",
    ":root[data-theme=\"light\"] .nt-clear{ border-color:rgba(20,30,25,.16); }",

    "@media (prefers-reduced-motion: reduce){",
    "  .pawa-notify-bell,.nt-panel,.nt-row{ transition:none; }",
    "  .pawa-notify-bell.has-news .nt-ic{ animation:none; }",
    "}",
  ].join("\n");

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
