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
    shop: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5z" stroke="#F6C45A" stroke-width="1.7" stroke-linejoin="round"/><path d="M4 8.5 12 13l8-4.5M12 13v7" stroke="#F6C45A" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    pen: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 20h4L20 8l-4-4L4 16z" stroke="#F6C45A" stroke-width="1.7" stroke-linejoin="round"/><path d="M14 6l4 4" stroke="#F6C45A" stroke-width="1.7"/></svg>',
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

    // ---- yours -------------------------------------------------------------
    var mine = [];
    mine.push(row({ href: "p-message.html", icon: ICON.chat, title: t("tab_pmessage", "P-Message"),
                    desc: t("pf_msg_d", "Your encrypted conversations.") }));
    mine.push(row({ href: "favorites.html", icon: ICON.save, title: t("pf_saved", "Saved listings"),
                    desc: t("pf_saved_d", "The places you kept with the heart button.") }));
    html += group(t("pf_g_you", "Yours"), mine);

    // A guest cannot own listings — the database refuses it — so the portals
    // are not offered to one. Showing a door that will not open is worse than
    // not showing it.
    if (me.userId && !me.isGuest) {
      html += group(t("pf_g_work", "Your listings"), [
        row({ href: "agent-houses.html", icon: ICON.house, tint: "ic-gold", title: t("nav_agent_houses", "My House Listings"),
              desc: t("pf_houses_d", "Post rooms and houses, and see who asked about them.") }),
        row({ href: "agent-services.html", icon: ICON.tool, tint: "ic-gold", title: t("nav_agent_services", "My Services"),
              desc: t("pf_services_d", "The work you offer and where you offer it.") }),
        row({ href: "agent-trucks.html", icon: ICON.truck, tint: "ic-gold", title: t("nav_agent_trucks", "My Trucks"),
              desc: t("pf_trucks_d", "Vehicles you hire out.") }),
        // The page a customer lands on from the P-Message agent list. Seeing
        // it is half the point: an agent who has never looked at their own
        // storefront has no reason to think the empty bio on it matters.
        row({ href: "agent.html?u=" + encodeURIComponent(me.userId), icon: ICON.shop, tint: "ic-gold",
              title: t("pf_shop", "Your public page"),
              desc: t("pf_shop_d", "What a customer sees before they write to you.") }),
        row({ act: "agentbio", icon: ICON.pen, tint: "ic-gold",
              title: t("pf_bio", "Your area and your bio"),
              desc: t("pf_bio_d", "Where you work, and what you want customers to know.") }),
      ]);
    }

    // ---- settings ----------------------------------------------------------
    html += group(t("pf_g_settings", "Settings"), [
      row({ act: "lang", icon: ICON.lang, tint: "ic-sky", title: t("pf_lang", "Language"),
            desc: t("pf_lang_d", "Switches the whole site."), value: lang === "sw" ? "Kiswahili" : "English" }),
      row({ act: "theme", icon: ICON.theme, tint: "ic-sky", title: t("pf_theme", "Appearance"),
            desc: t("pf_theme_d", "Dark by default."), value: theme === "light" ? t("pf_light", "Light") : t("pf_dark", "Dark") }),
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
        // The key is deliberately NOT wiped on sign-out: signing out of a
        // shared computer should not destroy the history on your own phone.
        // Ending a GUEST session is different — there is no account to come
        // back to, so the key is dead weight and keeping it would be a lie.
        var guest = me.isGuest;
        if (guest && window.PMCrypto) window.PMCrypto.forget();
        // The pinned keys of everyone that guest identity ever spoke to go
        // with it. Left behind they would be attached to a user id nothing
        // can sign in as again, and a later guest could be handed them.
        if (guest && window.PMTrust) window.PMTrust.forgetAll(me.userId);
        try { if (window.Auth) await window.Auth.signOut(); } catch (_) {}
        location.href = guest ? "index.html" : "profile.html";
      }
    });
  }

  async function boot() {
    if (window.applyTranslations) window.applyTranslations();
    wire();

    // The floating sun/moon toggle is on every page, including this one, so the
    // Appearance row can be changed by something other than itself. Without
    // this it would sit there claiming "Dark" on a light screen.
    window.addEventListener("pawa:themechange", function () { render(); });

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
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
