// ============================================================================
//  profile.js — the fifth tab.
//
//  Three states, one page, and the difference between them is the whole job:
//
//    signed out   there is nothing here yet, and the honest thing is to say so
//                 and point at the two ways in — an account, or a guest chat.
//    guest        a real session with no name behind it. The page says what
//                 that costs (this device only) rather than letting somebody
//                 discover it when they change phone.
//    signed in    the account, the encryption key, the listings, the settings.
//
//  Everything it links to already exists somewhere. The rows are the shared
//  card style (css/action-cards.css) and the key dialogs are the shared
//  library (js/lib/pm-identity-ui.js), so this page introduces one new idea —
//  a home for "you" — and no new copies of anything.
// ============================================================================

(function () {
  "use strict";

  var el = {};
  ["pfAvatar", "pfName", "pfWho", "pfMain", "pfModalBack", "pfModal"]
    .forEach(function (id) { el[id] = document.getElementById(id); });

  var me = null;
  var fingerprint = "";
  // Whether the DATABASE agrees this is an admin, not just the list in
  // config.js. That list ships to every browser and is trivially edited in
  // one; isDbAdmin() reads the `admins` table through RLS, so it is the copy
  // that cannot be talked into a different answer. The console links are the
  // only thing on this page gated on it, and they wait for it.
  var adminConfirmed = false;
  // The row pm_agent_card() returns for this user: the SAME call agent.html
  // makes when a customer opens their page. Null until it lands, and null
  // forever for a guest, so everything that reads it must cope with that.
  var storeCard = null;

  function t(key, fallback, vars) {
    var s = window.t ? window.t(key) : key;
    if (!s || s === key) s = fallback;
    if (vars) Object.keys(vars).forEach(function (k) {
      s = String(s).replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
    });
    return s;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
    return parts.map(function (p) { return p.charAt(0).toUpperCase(); }).join("") || "?";
  }

  // ---- rows ----------------------------------------------------------------
  // One builder for every row on the page, so a link and an action are the same
  // object to read and the same thing to look at.
  function row(o) {
    var inner =
      '<span class="ha-find-ic ' + (o.tint || "ic-emerald") + '" aria-hidden="true">' + (o.icon || "") + "</span>" +
      '<span class="ha-find-tx"><span class="ha-find-t">' + esc(o.title) + "</span>" +
      (o.desc ? '<span class="ha-find-d">' + esc(o.desc) + "</span>" : "") + "</span>" +
      (o.value ? '<span class="pf-val' + (o.mono ? " mono" : "") + '">' + esc(o.value) + "</span>" : "");
    return o.href
      ? '<a class="ha-find-card" href="' + esc(o.href) + '">' + inner + "</a>"
      : '<button type="button" class="ha-find-card" data-act="' + esc(o.act) + '">' + inner + "</button>";
  }
  function group(title, rows) {
    if (!rows.length) return "";
    return '<section class="pf-group"><h2 class="pf-group-h">' + esc(title) + "</h2>" +
      '<div class="ha-find">' + rows.join("") + "</div></section>";
  }

  // ---- your public page ----------------------------------------------------
  //
  //  storeCard is the row pm_agent_card() returned for THIS user: the same
  //  call, with the same argument, that agent.html makes when a customer opens
  //  the page. It arrives after the first paint (see load()), so everything
  //  below has to read correctly while it is still null.

  /** A count for a listings row, or "" so the row simply has no value. */
  function countOf(field) {
    if (!storeCard) return "";
    return String(Number(storeCard[field]) || 0);
  }

  /**
   * The storefront, as a customer sees it, with the two things the OWNER can
   * do to it underneath.
   *
   * Three states, and the middle one is the reason this is a card rather than
   * a link:
   *
   *   still loading   a quiet placeholder, never a wrong number.
   *   no key yet      the page exists but nobody can write to them from it,
   *                   and that is worth saying on the screen where it can be
   *                   fixed rather than discovering it from silence.
   *   drawn           identity, the numbers, the bio, exactly as published.
   */
  function storefrontHtml() {
    var head = '<h2 class="pf-group-h">' + esc(t("pf_shop", "Your public page")) + "</h2>";

    if (!storeCard) {
      return '<section class="pf-group pf-shop">' + head +
        '<div class="pf-shop-card is-wait">' +
          '<span class="pf-shop-wait">' + esc(t("pm_loading", "Loading…")) + "</span>" +
        "</div></section>";
    }

    var url = "agent.html?u=" + encodeURIComponent(me.userId);
    // The bio's empty state is written for the person who can fix it. The
    // visitor's version of the same blank says "they have not written
    // anything yet", which would be this page telling an agent about
    // themselves in the third person.
    var body =
      window.AgentCard.identity(storeCard, { presence: false }) +
      window.AgentCard.bio(storeCard, {
        emptyText: t("pf_shop_nobio", "You have not written anything about your work yet. This is the space a customer reads first."),
      }) +
      window.AgentCard.stats(storeCard, { compact: true });

    var warn = window.AgentCard.reachable(storeCard) ? ""
      : '<p class="pf-shop-warn">' +
        esc(t("pf_shop_nokey", "Nobody can write to you from this page yet, because this device has not published an encryption key. Open P-Message once and it will.")) +
        "</p>";

    return '<section class="pf-group pf-shop">' + head +
      '<div class="pf-shop-card">' + body + warn +
        '<div class="pf-shop-acts">' +
          '<a class="pm-btn" href="' + esc(url) + '">' + esc(t("pf_shop_open", "Open it")) + "</a>" +
          '<button class="pm-btn ghost" type="button" data-act="agentbio">' +
            esc(t("pf_shop_edit", "Edit area and bio")) + "</button>" +
        "</div>" +
      "</div>" +
      '<p class="pf-shop-note">' + esc(t("pf_shop_d2", "This is the page a customer lands on from the agent list, exactly as it appears to them.")) + "</p>" +
      "</section>";
  }

  // ---- the layout switch ---------------------------------------------------
  // Not a row(): the choice is three-way and worth showing all three of at
  // once. Whatever the device was guessed to want, this is where a person
  // says otherwise, on any device, in either direction, and it sticks.
  function layoutRow() {
    var V = window.PawaView;
    if (!V) return "";
    var pref = V.pref();
    var mode = V.mode();
    var shown = pref === "auto"
      ? (mode === "web" ? t("pf_layout_v_auto_web", "Auto, web") : t("pf_layout_v_auto_app", "Auto, app"))
      : (pref === "web" ? t("pf_layout_v_web", "Web") : t("pf_layout_v_app", "App"));
    var opt = function (id, label) {
      return '<button type="button" data-view="' + id + '" aria-pressed="' +
        (pref === id ? "true" : "false") + '">' + esc(label) + "</button>";
    };
    return '<div class="ha-find-card pf-layout-row">' +
      '<span class="ha-find-ic ic-sky" aria-hidden="true">' + ICON.layout + "</span>" +
      '<span class="ha-find-tx"><span class="ha-find-t">' + esc(t("pf_layout", "Layout")) + "</span>" +
      '<span class="ha-find-d">' + esc(t("pf_layout_d", "App keeps the tab bar at the bottom. Web scrolls it away, which suits a small or short screen.")) + "</span>" +
      '<span class="app-view-switch" role="group" aria-label="' + esc(t("pf_layout", "Layout")) + '">' +
      opt("app", t("pf_layout_app", "App")) +
      opt("web", t("pf_layout_web", "Web")) +
      opt("auto", t("pf_layout_auto", "Auto")) +
      "</span></span>" +
      '<span class="pf-val">' + esc(shown) + "</span></div>";
  }

  var ICON = {
    key: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="8" cy="12" r="4" stroke="#2EE6A6" stroke-width="1.7"/><path d="M12 12h9l-2 2.5M17 12v3" stroke="#2EE6A6" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    save: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M5 4h14v17l-7-4-7 4z" stroke="#2EE6A6" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    house: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 11l9-7 9 7M5 10v10h14V10" stroke="#F6C45A" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    tool: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.3L3 18l3 3 6.4-6.3a4 4 0 0 0 5.3-5.4l-2.9 2.9-2.1-2.1z" stroke="#F6C45A" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    truck: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M1 6h13v9H1zM14 9h4l3 3v3h-7z" stroke="#F6C45A" stroke-width="1.7" stroke-linejoin="round"/><circle cx="5.5" cy="18" r="1.7" stroke="#F6C45A" stroke-width="1.7"/><circle cx="17.5" cy="18" r="1.7" stroke="#F6C45A" stroke-width="1.7"/></svg>',
    lang: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#5EB7FF" stroke-width="1.7"/><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" stroke="#5EB7FF" stroke-width="1.5"/></svg>',
    theme: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M20 14.2A8 8 0 1 1 9.8 4a6.5 6.5 0 0 0 10.2 10.2z" stroke="#5EB7FF" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    shield: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z" stroke="#C594FF" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    out: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M15 4h4v16h-4M11 16l4-4-4-4M15 12H4" stroke="#FF8AA8" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chat: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="#2EE6A6" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    // Two panes, one tall and one wide: the choice this row is offering.
    layout: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="7" height="16" rx="1.6" stroke="#5EB7FF" stroke-width="1.7"/><rect x="13" y="4" width="8" height="9" rx="1.6" stroke="#5EB7FF" stroke-width="1.7"/><path d="M13 16.5h8M13 19.5h5" stroke="#5EB7FF" stroke-width="1.7" stroke-linecap="round"/></svg>',
  };

  // ---- render --------------------------------------------------------------
  async function render() {
    var lang = (window.getLang && window.getLang()) || "en";
    var theme = (window.PawaTheme && window.PawaTheme.get()) || "dark";
    var html = "";

    if (!me.userId) {
      el.pfAvatar.textContent = "·";
      el.pfName.textContent = t("pf_hello", "Hello");
      el.pfWho.textContent = t("pf_signed_out", "Not signed in");
      html += '<div class="pf-note"><b>' + esc(t("pf_out_t", "Nothing here yet")) + "</b><br>" +
        esc(t("pf_out_d", "Sign in to manage your listings and keep your conversations across devices. Or just message an agent as a guest, encrypted the same way.")) +
        '</div><div class="pf-acts">' +
        '<a class="pm-btn" href="login.html">' + esc(t("pm_signin_go", "Sign in")) + "</a>" +
        '<a class="pm-btn ghost" href="p-message.html">' + esc(t("pf_guest_go", "Chat as a guest")) + "</a>" +
        "</div>";
    } else {
      var name = me.isGuest
        ? (t("pf_guest_name", "Guest"))
        : (me.email || t("pf_you", "You"));
      el.pfAvatar.textContent = initials(me.isGuest ? "G" : name);
      el.pfAvatar.classList.toggle("is-guest", !!me.isGuest);
      el.pfName.innerHTML = esc(me.isGuest ? t("pf_guest_name", "Guest") : String(name).split("@")[0]) +
        (adminConfirmed ? ' <span class="pf-tag admin">' + esc(t("pf_admin", "Admin")) + "</span>" : "") +
        (me.isGuest ? ' <span class="pf-tag guest">' + esc(t("pm_badge_guest", "Guest")) + "</span>" : "");
      el.pfWho.textContent = me.isGuest
        ? t("pf_guest_who", "No account. This device only.")
        : (me.email || "");

      if (me.isGuest) {
        // Said here, plainly, while it is still fixable. A guest who changes
        // phone loses the thread AND the key that opens it, and finding that
        // out afterwards is finding out too late.
        html += '<div class="pf-note warn"><b>' + esc(t("pf_guest_t", "You are browsing as a guest")) + "</b><br>" +
          esc(t("pf_guest_d", "Your conversations and the key that opens them live in this browser. Clearing it, or moving to another phone, loses both. An account keeps them.")) +
          '</div><div class="pf-acts"><a class="pm-btn" href="login.html">' +
          esc(t("pf_make_account", "Sign in to keep them")) + "</a></div>";
      }
    }

    // ---- encryption --------------------------------------------------------
    // The key is the account, so it sits above the listings rather than under
    // a settings heading three taps down.
    if (me.userId && fingerprint) {
      html += group(t("pf_g_key", "Your encryption key"), [
        row({ act: "fingerprint", icon: ICON.key, title: t("pf_safety", "Your safety number"),
              desc: t("pf_safety_d", "Read it aloud to someone to prove nobody is in between."),
              value: fingerprint, mono: true }),
        row({ act: "backup", icon: ICON.key, tint: "ic-gold", title: t("pf_backup", "Save a backup code"),
              desc: t("pf_backup_d", "The only copy of this key is on this device. A code lets you restore it on another.") }),
        row({ act: "restore", icon: ICON.key, tint: "ic-gold", title: t("pf_restore", "Restore from a backup code"),
              desc: t("pf_restore_d", "Replaces the key on this device with one from another.") }),
      ]);
    }

    // ---- your public page --------------------------------------------------
    // The storefront, drawn HERE rather than described in a row that links to
    // it. An agent who has never opened their own page has no reason to think
    // the empty bio on it matters, and "Your public page ›" was a row that
    // said nothing about the state of the thing behind it.
    //
    // It is the same block agent.html draws, from the same query, through
    // js/lib/agent-card.js. That is the whole point: a preview assembled
    // separately would eventually reassure about a page that says something
    // else, and the agent would be the last to find out.
    if (me.userId && !me.isGuest) html += storefrontHtml();

    // ---- yours -------------------------------------------------------------
    var mine = [];
    mine.push(row({ href: "p-message.html", icon: ICON.chat, title: t("tab_pmessage", "P-Message"),
                    desc: t("pf_msg_d", "Your encrypted conversations.") }));
    mine.push(row({ href: "favorites.html", icon: ICON.save, title: t("pf_saved", "Saved listings"),
                    desc: t("pf_saved_d", "The places you kept with the heart button.") }));
    html += group(t("pf_g_you", "Yours"), mine);

    // A guest cannot own listings, the database refuses it, so the portals are
    // not offered to one. Showing a door that will not open is worse than not
    // showing it.
    //
    // Each row carries its own COUNT, from the storefront query above. A
    // dashboard link that says how many things are behind it is the difference
    // between a menu and a page: "My Services 0" is the one row on this screen
    // that has ever told an agent something they did not know.
    if (me.userId && !me.isGuest) {
      html += group(t("pf_g_work", "Your listings"), [
        row({ href: "agent-houses.html", icon: ICON.house, tint: "ic-gold", title: t("nav_agent_houses", "My House Listings"),
              desc: t("pf_houses_d", "Post rooms and houses, and see who asked about them."),
              value: countOf("n_houses") }),
        row({ href: "agent-services.html", icon: ICON.tool, tint: "ic-gold", title: t("nav_agent_services", "My Services"),
              desc: t("pf_services_d", "The work you offer and where you offer it."),
              value: countOf("n_services") }),
        row({ href: "agent-trucks.html", icon: ICON.truck, tint: "ic-gold", title: t("nav_agent_trucks", "My Trucks"),
              desc: t("pf_trucks_d", "Vehicles you hire out."),
              value: countOf("n_trucks") }),
      ]);
    }

    // ---- settings ----------------------------------------------------------
    html += group(t("pf_g_settings", "Settings"), [
      row({ act: "lang", icon: ICON.lang, tint: "ic-sky", title: t("pf_lang", "Language"),
            desc: t("pf_lang_d", "Switches the whole site."), value: lang === "sw" ? "Kiswahili" : "English" }),
      row({ act: "theme", icon: ICON.theme, tint: "ic-sky", title: t("pf_theme", "Appearance"),
            desc: t("pf_theme_d", "Dark by default."), value: theme === "light" ? t("pf_light", "Light") : t("pf_dark", "Dark") }),
      layoutRow(),
    ]);

    if (adminConfirmed) {
      html += group(t("pf_g_admin", "Admin"), [
        row({ href: "admin.html", icon: ICON.shield, tint: "ic-violet", title: t("nav_admin", "Admin"),
              desc: t("pf_admin_d", "Listings, agents, payments, the video space.") }),
        row({ href: "super-admin.html", icon: ICON.shield, tint: "ic-violet", title: t("nav_super_admin", "Super Admin"),
              desc: t("pf_super_d", "Tenants and the accounts behind them.") }),
      ]);
    }

    if (me.userId) {
      html += group("", [
        row({ act: "signout", icon: ICON.out, tint: "ic-rose",
              title: me.isGuest ? t("pf_end_guest", "End this guest session") : t("pf_signout", "Sign out"),
              desc: me.isGuest
                ? t("pf_end_guest_d", "Leaves the conversation unreadable on this device. There is no account to come back to.")
                : t("pf_signout_d", "Your key stays on this device.") }),
      ]);
    }

    el.pfMain.innerHTML = html;
  }

  // ---- actions -------------------------------------------------------------
  function wire() {
    el.pfMain.addEventListener("click", async function (e) {
      var seg = e.target.closest("[data-view]");
      if (seg) {
        if (window.PawaView) window.PawaView.set(seg.dataset.view);
        return render();
      }

      var btn = e.target.closest("[data-act]");
      if (!btn) return;
      var act = btn.dataset.act;

      if (act === "fingerprint") return window.PMIdentityUI.safetyNumbers();
      if (act === "backup") return window.PMIdentityUI.backup();
      if (act === "restore") return window.PMIdentityUI.restore();

      if (act === "agentbio") {
        var sb = window.DataStore && window.DataStore.sb;
        if (!sb || !window.AgentProfile) return;
        // Redraw afterwards: nothing on this screen shows the bio, but the
        // region row above it can change, and a screen that quietly disagrees
        // with what was just saved is worse than one that flickers.
        window.AgentProfile.edit(sb).then(function () { render(); }).catch(function () {});
        return;
      }
      if (act === "lang") {
        // setLang reloads the page, which is how every other language switch on
        // the site behaves — no half-translated screen.
        var next = ((window.getLang && window.getLang()) === "sw") ? "en" : "sw";
        if (window.setLang) window.setLang(next);
        return;
      }
      if (act === "theme") {
        if (window.PawaTheme) window.PawaTheme.toggle();
        return render();
      }
      if (act === "signout") {
        // Ending a GUEST session is not signing out, and the two used to run
        // the same three lines. Signing out of an account destroys nothing on
        // purpose: the key stays so a shared computer does not take your
        // history with it. A guest has no account to come back to, so the
        // opposite is true, and until now "ending" one left the guest
        // published in pm_keys and sitting in every thread they had joined.
        if (me.isGuest) return askEndGuest();
        try { if (window.Auth) await window.Auth.signOut(); } catch (_) {}
        location.href = "profile.html";
      }
    });
  }

  /**
   * End a guest session, and say what that removes.
   *
   * Three different things happen and only one of them was ever mentioned:
   *
   *   the key on this device is forgotten, so the thread stops opening HERE;
   *   the guest identity is deleted on the server, so nobody can write to it
   *     again and it disappears from the rosters it was sitting in;
   *   and what they SENT stays with the people they sent it to, unless they
   *     ask otherwise, because it is those people's conversation too.
   *
   * The third is the one worth a checkbox rather than a default. Erasing
   * somebody else's copy of a conversation because a stranger closed a tab is
   * not tidying up.
   */
  function askEndGuest() {
    window.PMIdentityUI.open("<h2>" + esc(t("pf_end_t", "End this guest session?")) + "</h2>" +
      "<p>" + esc(t("pf_end_d1",
        "There is no account behind a guest, so this cannot be undone and there is nothing to sign back into.")) + "</p>" +
      "<p>" + esc(t("pf_end_d2",
        "Your key is forgotten on this phone, and the guest is removed from the conversations it joined so nobody can write to it again.")) + "</p>" +
      '<label class="pf-check"><input type="checkbox" id="pfWipe" />' +
        "<span>" + esc(t("pf_end_wipe",
          "Also delete the messages I sent, for everyone")) + "</span></label>" +
      '<p class="pf-check-d">' + esc(t("pf_end_wipe_d",
        "Off by default. What you sent is the other person's half of the conversation as well, and a copy they already read cannot be taken back.")) + "</p>" +
      '<div class="pm-modal-acts">' +
      '<button class="pm-btn ghost" id="pfEndNo">' + esc(t("pm_cancel", "Cancel")) + "</button>" +
      '<button class="pm-btn is-danger" id="pfEndYes">' + esc(t("pf_end_go", "End the session")) + "</button>" +
      "</div><div class=\"pm-msg-out\" id=\"pfEndMsg\"></div>");

    document.getElementById("pfEndNo").addEventListener("click", window.PMIdentityUI.close);
    document.getElementById("pfEndYes").addEventListener("click", async function (e) {
      var btn = e.currentTarget;          // captured, never read after an await
      var out = document.getElementById("pfEndMsg");
      var wipe = !!document.getElementById("pfWipe").checked;
      btn.disabled = true;
      out.className = "pm-msg-out";
      out.textContent = t("pm_working", "Working…");

      // The SERVER first, while there is still a session to authorise it. Doing
      // it after signOut would be an anonymous call with no app_uid(), which
      // the function refuses, and the guest would be left published exactly as
      // before with nothing on screen to say so.
      var wiped = null;
      try {
        if (window.PMStore && window.PMStore.guestForget) {
          wiped = await window.PMStore.guestForget(wipe);
        }
      } catch (err) {
        // A failure here matters enough to stop: carrying on would forget the
        // key locally and leave a reachable identity nobody can ever read.
        btn.disabled = false;
        out.className = "pm-msg-out bad";
        out.textContent = ((err && err.message) || String(err)) + " " +
          t("pf_end_fail", "Nothing was changed. Try again when you have a connection.");
        return;
      }

      // Only now the local half. The key is dead weight once the identity is
      // gone, and keeping it would be a lie about what this device can open.
      if (window.PMCrypto) window.PMCrypto.forget();
      // The pinned keys of everyone that guest identity ever spoke to go with
      // it. Left behind they would be attached to a user id nothing can sign
      // in as again, and a later guest on this phone could be handed them.
      if (window.PMTrust) window.PMTrust.forgetAll(me.userId);
      try { if (window.Auth) await window.Auth.signOut(); } catch (_) {}
      location.href = "index.html";
    });
  }

  async function boot() {
    if (window.applyTranslations) window.applyTranslations();
    wire();

    // The floating sun/moon toggle is on every page, including this one, so the
    // Appearance row can be changed by something other than itself. Without
    // this it would sit there claiming "Dark" on a light screen.
    window.addEventListener("pawa:themechange", function () { render(); });
    // Auto resolves differently after a rotation or a window resize, and the
    // row shows which way it went, so it has to be told.
    window.addEventListener("pawa:viewchange", function () { render(); });

    window.PMIdentityUI.attach({
      backdrop: el.pfModalBack, panel: el.pfModal, t: t,
      fingerprint: function () { return fingerprint; },
      userId: function () { return me && me.userId; },
      onChange: async function (res) { fingerprint = res.fingerprint; await render(); },
    });

    me = await window.PMStore.me();
    // Asked once, after the session is known, and never for a guest: an
    // anonymous session has no email for the table to hold. Failure is "no",
    // so a blocked or offline read hides the console rather than opening it.
    if (me.userId && !me.isGuest && me.isAdmin && window.Auth && window.Auth.isDbAdmin) {
      try { adminConfirmed = await window.Auth.isDbAdmin(); } catch (_) { adminConfirmed = false; }
    }
    // The fingerprint is read from the key already on this device — Profile
    // never CREATES one. Someone who has not opened P-Message has no key yet,
    // and inventing one here would publish them as reachable when they have
    // not asked to be.
    if (me.userId && window.PMCrypto && window.PMCrypto.available()) {
      var stored = window.PMCrypto.load();
      if (stored) {
        try { fingerprint = await window.PMCrypto.fingerprint(stored.publicKey); } catch (_) {}
        try { await window.PMStore.ensureIdentity(); } catch (_) {}
      }
    }
    await render();

    // The storefront comes AFTER the first paint, deliberately. It is one more
    // round trip and everything above it, including the sign-out row and the
    // key dialogs, is drawable from what this device already knows. Blocking
    // the whole page on a catalogue query would make the tab feel slower for
    // the benefit of one card, and the card is written to read correctly while
    // it is still missing.
    //
    // Only for an account. pm_agent_card refuses a guest, and a guest has no
    // storefront to preview.
    if (me.userId && !me.isGuest && window.PMStore.agentCard) {
      try {
        storeCard = await window.PMStore.agentCard(me.userId);
      } catch (_) {
        // A failed lookup leaves the placeholder rather than a wrong number.
        // There is nothing here worth interrupting the page for.
        storeCard = null;
      }
      if (storeCard) await render();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
