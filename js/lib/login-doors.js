// ============================================================================
//  The four doors — who is coming in, and where they land
// ============================================================================
//  PN-Zaki has exactly four kinds of account, and they want different things
//  from the same building:
//
//    agent    lists on behalf of other people: rooms, trucks and services
//    owner    a landlord listing their OWN property, with no agent in between
//    company  hires: posts day jobs and picks the crew
//    user     everybody else: finds a room, calls a fundi, books a truck
//
//  WHAT A DOOR IS. It decides where somebody lands, what the page offers them
//  next, and how the app talks to them. It is intent.
//
//  WHAT A DOOR IS NOT, AND THIS MATTERS. It grants nothing. Every write in this
//  app is fenced in the database — RLS on owner_user_id for the three
//  catalogues, the manage_token for a day job's worker contacts, the admins
//  table for the console. A picker in a browser cannot move any of those, and
//  nothing downstream may ever read this value and conclude somebody is allowed
//  to do something. Permission is the database's answer; this is a signpost.
//
//  It is stored in the Supabase user's own metadata rather than a new table.
//  That is the right home for a signpost: no migration, no RLS surface, no
//  extra read on every page, and it travels with the session. It is also
//  user-writable, which is exactly why the paragraph above is not optional.
//
//  Public API:  LoginDoors.init({ grid, onPick }) · get() · set(key) · meta(key)
// ============================================================================
(function () {
  "use strict";

  var KEY = "pawa_account_type";

  function tx(key, fallback) {
    if (!window.t) return fallback;
    var got = window.t(key);
    return got && got !== key ? got : fallback;
  }

  var svg = function (paths) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
  };

  // The accent is NAMED here and defined in css/login.css. A module that
  // decides where somebody lands should not be holding hex values.
  var DOORS = [
    {
      key: "agent", accent: "var(--lg-door-agent)", href: "agent-houses.html",
      name: ["lg_door_agent", "Agent"],
      what: ["lg_door_agent_d", "You list on behalf of other people and earn from it."],
      can: [["lg_can_rooms", "Rooms"], ["lg_can_trucks", "Trucks"], ["lg_can_services", "Services"]],
      icon: svg('<path d="M12 3l8 3v5c0 5-3.4 8-8 10-4.6-2-8-5-8-10V6z"/><path d="m9 12 2 2 4-4"/>'),
    },
    {
      key: "owner", accent: "var(--lg-door-owner)", href: "agent-houses.html",
      name: ["lg_door_owner", "House owner"],
      what: ["lg_door_owner_d", "Your own property, listed by you, with no agent in between."],
      can: [["lg_can_rooms", "Rooms"], ["lg_can_services", "Services"], ["lg_can_direct", "Direct contact"]],
      icon: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>'),
    },
    {
      key: "company", accent: "var(--lg-door-company)", href: "jobs.html",
      name: ["lg_door_company", "Job company"],
      what: ["lg_door_company_d", "You hire. Post the work and pick the crew that shows up."],
      can: [["lg_can_jobs", "Day jobs"], ["lg_can_crew", "Hire a crew"]],
      icon: svg('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12h18"/>'),
    },
    {
      key: "user", accent: "var(--lg-door-user)", href: "index.html",
      name: ["lg_door_user", "Just looking"],
      what: ["lg_door_user_d", "Find a room, call a fundi, book a truck, claim a day job."],
      can: [["lg_can_find", "Find"], ["lg_can_message", "Message"], ["lg_can_claim", "Claim work"]],
      icon: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>'),
    },
  ];

  function meta(key) {
    for (var i = 0; i < DOORS.length; i++) if (DOORS[i].key === key) return DOORS[i];
    return null;
  }

  function get() {
    try {
      var v = localStorage.getItem(KEY);
      return meta(v) ? v : null;
    } catch (_) { return null; }
  }

  function set(key) {
    if (!meta(key)) return;
    try { localStorage.setItem(KEY, key); } catch (_) {}
  }

  /**
   * The signed-in account's own answer, which outranks anything picked here.
   *
   * Somebody who registered as a landlord and later taps "Agent" at the door
   * has not become an agent; they have mis-tapped. The stored metadata is what
   * the account said about itself at sign-up, so it wins, and the picker is
   * corrected rather than obeyed.
   */
  async function fromAccount() {
    try {
      var s = window.Auth && (await window.Auth.getSession());
      var t = s && s.user && s.user.user_metadata && s.user.user_metadata.account_type;
      return meta(t) ? t : null;
    } catch (_) { return null; }
  }

  function card(d) {
    var can = d.can.map(function (c) { return "<span>" + tx(c[0], c[1]) + "</span>"; }).join("");
    return '<button type="button" class="lg-door" data-key="' + d.key + '"' +
      ' style="--d:' + d.accent + '" aria-pressed="false">' +
      '<span class="lg-door-ic">' + d.icon + "</span>" +
      '<span class="lg-door-tx">' +
        '<span class="lg-door-t">' + tx(d.name[0], d.name[1]) + "</span>" +
        '<span class="lg-door-d">' + tx(d.what[0], d.what[1]) + "</span>" +
        '<span class="lg-door-can">' + can + "</span>" +
      "</span>" +
    "</button>";
  }

  // The pointer-following sheen. Two custom properties for the light's position
  // and two for a small tilt; the transform itself lives in the stylesheet so
  // the reduced-motion opt-out has one place to switch it all off.
  var reduced = false;
  try {
    reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (_) {}

  function wireTilt(el) {
    if (reduced) return;
    el.addEventListener("pointermove", function (e) {
      var r = el.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width;
      var py = (e.clientY - r.top) / r.height;
      el.style.setProperty("--mx", (px * 100).toFixed(1) + "%");
      el.style.setProperty("--my", (py * 100).toFixed(1) + "%");
      el.style.setProperty("--rx", ((px - 0.5) * 5).toFixed(2) + "deg");
      el.style.setProperty("--ry", ((0.5 - py) * 5).toFixed(2) + "deg");
    });
    el.addEventListener("pointerleave", function () {
      el.style.setProperty("--rx", "0deg");
      el.style.setProperty("--ry", "0deg");
    });
  }

  function init(opts) {
    var grid = opts && opts.grid;
    if (!grid) return;
    grid.innerHTML = DOORS.map(card).join("");
    var buttons = [].slice.call(grid.querySelectorAll(".lg-door"));
    buttons.forEach(function (b) {
      wireTilt(b);
      b.addEventListener("click", function () {
        buttons.forEach(function (o) { o.setAttribute("aria-pressed", String(o === b)); });
        set(b.dataset.key);
        if (opts.onPick) opts.onPick(b.dataset.key, meta(b.dataset.key));
      });
    });
    // Arrow keys walk the group, which is what a group of four related choices
    // should do for somebody not using a mouse.
    grid.addEventListener("keydown", function (e) {
      var i = buttons.indexOf(document.activeElement);
      if (i < 0) return;
      var d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1
            : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      buttons[(i + d + buttons.length) % buttons.length].focus();
    });
  }

  window.LoginDoors = {
    DOORS: DOORS, init: init, get: get, set: set, meta: meta,
    fromAccount: fromAccount, STORAGE_KEY: KEY,
  };
})();
