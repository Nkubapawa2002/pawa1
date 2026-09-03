// ============================================================================
//  admin-owners.js — the accounts that pay nothing, and what they have used.
// ============================================================================
//  house_owner_accounts.sql gave the catalogue a second kind of account: a
//  landlord listing their own property, with no monthly fee and an allowance
//  of three posts every 180 days instead. The console could see agents and
//  could not see these people at all, so the one question an admin actually
//  gets asked about them had no screen to answer it:
//
//    "I cannot post my fourth room. Why?"
//
//  The answer is a date, and it is here: how many posts that account has used
//  inside the window, and when the oldest of them falls out of it.
//
//  THREE READS, JOINED HERE. account_kinds says who is an owner, owner_posts
//  is the ledger of what they have posted, houses is what is standing now. All
//  three are admin-readable and all three are small; a stored function to do
//  the join would be a fourth thing to keep in step with the allowance.
//
//  THE NUMBERS COME FROM THE DATABASE, not from this file. owner_post_limit()
//  and owner_post_window() are what the trigger enforces, so the console asks
//  for them rather than repeating "3" and "180" in a fourth place.
// ============================================================================
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var esc = window.escHtml || function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  function t(k, en, vars) {
    var s = window.t ? window.t(k) : null;
    if (!s || s === k) s = en;
    if (vars) Object.keys(vars).forEach(function (n) { s = s.split("{" + n + "}").join(String(vars[n])); });
    return s;
  }
  function sb() { return window.SB || (window.DataStore && window.DataStore.sb) || null; }

  function when(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString(
        (window.getLang && window.getLang()) === "sw" ? "sw-TZ" : "en-GB",
        { day: "numeric", month: "short", year: "numeric" });
    } catch (_) { return String(iso).slice(0, 10); }
  }

  var rows = [];
  var limit = 3, windowDays = 180;

  async function load() {
    var c = sb();
    if (!c) return;
    var table = $("ownTable");
    if (table) table.innerHTML = '<tbody><tr><td class="adm-empty">' +
      esc(t("adm_loading", "Loading…")) + "</td></tr></tbody>";

    // The allowance, from the two functions the trigger reads. A console that
    // said "2 of 3 used" after the rule became five would be worse than one
    // that said nothing.
    try {
      var lim = await c.rpc("owner_post_limit");
      if (!lim.error && lim.data != null) limit = Number(lim.data) || limit;
    } catch (_) {}

    var kinds = await c.from("account_kinds").select("user_id,kind,set_at,set_by").eq("kind", "owner");
    if (kinds.error) {
      if (table) table.innerHTML = '<tbody><tr><td class="adm-empty">' + esc(kinds.error.message) + "</td></tr></tbody>";
      return;
    }
    var owners = kinds.data || [];
    var ids = owners.map(function (o) { return o.user_id; });

    var posts = [], houses = [];
    if (ids.length) {
      var since = new Date(Date.now() - windowDays * 86400000).toISOString();
      var p = await c.from("owner_posts").select("user_id,kind,posted_at").in("user_id", ids).gte("posted_at", since);
      if (!p.error) posts = p.data || [];
      var h = await c.from("houses").select("id,owner_user_id,available").in("owner_user_id", ids);
      if (!h.error) houses = h.data || [];
    }

    rows = owners.map(function (o) {
      var mine = posts.filter(function (x) { return x.user_id === o.user_id; });
      var live = houses.filter(function (x) { return x.owner_user_id === o.user_id; });
      var oldest = mine.map(function (x) { return x.posted_at; }).sort()[0] || null;
      return {
        uid: o.user_id,
        since: o.set_at,
        by: o.set_by,
        used: mine.length,
        left: Math.max(0, limit - mine.length),
        // When the oldest post inside the window falls out of it, which is the
        // date an owner at their ceiling is actually asking about. Null when
        // they are not at it, because a date implies a wait that is not there.
        frees: (mine.length >= limit && oldest)
          ? new Date(new Date(oldest).getTime() + windowDays * 86400000).toISOString()
          : null,
        live: live.filter(function (x) { return x.available !== false; }).length,
      };
    });
    draw();
  }

  function draw() {
    var table = $("ownTable");
    if (!table) return;
    var q = (($("ownSearch") && $("ownSearch").value) || "").trim().toLowerCase();
    var list = q ? rows.filter(function (r) { return r.uid.toLowerCase().indexOf(q) >= 0; }) : rows;

    var full = rows.filter(function (r) { return r.left <= 0; }).length;
    var stats = $("ownStats");
    if (stats) {
      stats.innerHTML =
        stat(rows.length, t("adm_own_n", "Owner accounts")) +
        stat(rows.reduce(function (n, r) { return n + r.live; }, 0), t("adm_own_live", "Listings standing")) +
        stat(full, t("adm_own_full", "At their ceiling"), full ? "is-warn" : "") +
        stat(limit, t("adm_own_limit", "Posts allowed")) +
        stat(windowDays, t("adm_own_window", "Days in the window"));
    }
    var badge = $("ownersBadge");
    if (badge) badge.textContent = rows.length ? String(rows.length) : "";

    if (!list.length) {
      table.innerHTML = '<tbody><tr><td class="adm-empty">' +
        esc(rows.length
          ? t("adm_own_nomatch", "No owner account matches that.")
          : t("adm_own_none", "Nobody has claimed an owner account yet.")) + "</td></tr></tbody>";
      return;
    }

    table.innerHTML = "<thead><tr>" +
      "<th>" + esc(t("adm_col_account", "Account")) + "</th>" +
      '<th class="num">' + esc(t("adm_col_used", "Posts used")) + "</th>" +
      '<th class="num">' + esc(t("adm_col_left", "Left")) + "</th>" +
      "<th>" + esc(t("adm_col_frees", "Next slot")) + "</th>" +
      '<th class="num">' + esc(t("adm_col_live", "Listings")) + "</th>" +
      "<th>" + esc(t("adm_col_since", "Owner since")) + "</th>" +
      "</tr></thead><tbody>" +
      list.map(function (r) {
        return "<tr>" +
          "<td><code>" + esc(r.uid) + "</code></td>" +
          '<td class="num">' + r.used + " / " + limit + "</td>" +
          '<td class="num">' + (r.left <= 0
            ? '<span class="adm-sev urgent">' + esc(t("adm_own_at_cap", "none")) + "</span>"
            : r.left) + "</td>" +
          "<td>" + (r.frees ? esc(when(r.frees)) : "—") + "</td>" +
          '<td class="num">' + r.live + "</td>" +
          "<td>" + esc(when(r.since)) + "</td>" +
        "</tr>";
      }).join("") + "</tbody>";
  }

  function stat(n, label, cls) {
    return '<div class="adm-stat' + (cls ? " " + cls : "") + '">' +
      '<span class="adm-stat-n">' + esc(String(n)) + "</span>" +
      '<span class="adm-stat-k">' + esc(label) + "</span></div>";
  }

  function wire() {
    if (!$("ownTable")) return;
    $("ownSearch") && $("ownSearch").addEventListener("input", draw);
    $("ownRefresh") && $("ownRefresh").addEventListener("click", load);
    load();
  }

  window.initAdminOwners = wire;
})();
