// ============================================================================
//  admin-duties.js — the rota, as a screen instead of a source file.
// ============================================================================
//  WHAT THIS EXISTS TO END
//  Who a customer talks to used to be two object literals in js/core/config.js:
//
//      { role: "support_role_manager",   name: "xcracker pawa", phone: "+255 741 632 744", whatsapp: "255741622744" }
//      { role: "support_role_organizer", name: "Fatuma Said",   phone: "+255 713 000 002", whatsapp: "255713000002" }
//
//  The first row's two numbers differ by two digits, and nothing on any screen
//  showed them together so nobody could see it. The second is a placeholder
//  that shipped. Both were reachable from P-Message and from Profile, dressed
//  as platform staff, and changing either meant a deploy.
//
//  THE DUTY IS A SELECT, NOT A TEXT FIELD, and that is the one decision here
//  worth defending. A typed job title is an English string on a screen whose
//  contract is that every visible word exists in English and Swahili. So
//  duty_key comes from a fixed vocabulary, translated at the point of drawing;
//  adding one is a line in js/core/i18n.js and a value in the check constraint
//  in supabase/features/account/support_duties.sql, and it is meant to be a
//  visible change rather than a text box somebody fills in at midnight.
//
//  RETIRE, DO NOT DELETE. Taking somebody off duty is an UPDATE that flips
//  is_active, so the rota keeps its history and support_duties_live() stops
//  returning them the same second. Delete is offered too, one confirm behind,
//  and is for a row that should never have existed rather than for a shift
//  that ended.
//
//  EVERY WRITE GOES THROUGH support_duty_set(). The table has RLS on and NO
//  write policy at all, the same shape pm_invites uses, so this file could not
//  forge a set_by even if it tried to write the row directly.
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

  var rows = [];
  var editing = null;        // the id being edited, or null for "adding"

  function say(msg, bad) {
    var out = $("dtMsg");
    if (!out) return;
    out.className = "adm-msg" + (bad ? " is-bad" : msg ? " is-good" : "");
    out.textContent = msg || "";
  }

  // ---- reading ------------------------------------------------------------

  async function load() {
    var c = sb();
    if (!c || !$("dtTable")) return;
    try {
      var res = await c.rpc("support_duties_all");
      if (res.error) throw res.error;
      rows = res.data || [];
    } catch (err) {
      rows = [];
      say((err && err.message) || String(err), true);
    }
    draw();
  }

  function draw() {
    var table = $("dtTable");
    if (!table) return;
    var badge = $("dtiesBadge") || $("dutiesBadge");
    var live = rows.filter(function (r) { return r.is_active; }).length;
    if (badge) badge.textContent = live ? String(live) : "";

    if (!rows.length) {
      // An empty rota is a real state, not a failure. It is also what the app
      // ships as, because the two rows that used to be in config.js were not
      // worth carrying over: see the header.
      table.innerHTML = '<tbody><tr><td class="adm-empty">' +
        esc(t("adm_duty_none",
          "Nobody is on duty. Support shows no contact card until somebody is added here, which is correct: an invented name is worse than none.")) +
        "</td></tr></tbody>";
      return;
    }

    table.innerHTML =
      "<thead><tr>" +
        "<th>" + esc(t("adm_duty_name", "Name")) + "</th>" +
        "<th>" + esc(t("adm_duty_role", "Duty")) + "</th>" +
        "<th>" + esc(t("adm_duty_reach", "Reach them on")) + "</th>" +
        "<th>" + esc(t("adm_duty_region", "Region")) + "</th>" +
        "<th></th>" +
      "</tr></thead><tbody>" +
      rows.map(rowHtml).join("") +
      "</tbody>";
  }

  function rowHtml(r) {
    var duty = window.SupportDuties
      ? window.SupportDuties.dutyName(r.duty_key)
      : r.duty_key;
    // Both numbers, side by side, always. This is the one piece of layout in
    // the file that is there for a reason rather than for tidiness: the bug
    // that started all this was a call number and a WhatsApp number that
    // disagreed, in a place where nothing ever showed them together.
    var reach = [];
    if (r.phone) reach.push('<span class="adm-mono">' + esc(r.phone) + "</span>");
    if (r.whatsapp) reach.push('<span class="adm-mono">wa ' + esc(r.whatsapp) + "</span>");
    return '<tr' + (r.is_active ? "" : ' class="is-off"') + ">" +
      "<td>" + esc(r.name) +
        (r.is_active ? "" : ' <span class="adm-tag">' +
          esc(t("adm_duty_off", "off duty")) + "</span>") + "</td>" +
      "<td>" + esc(duty) + "</td>" +
      "<td>" + (reach.join(" &middot; ") || "&mdash;") + "</td>" +
      "<td>" + esc(r.region || "") + "</td>" +
      '<td class="adm-acts">' +
        '<button class="btn btn-outline btn-sm" type="button" data-duty-edit="' + esc(r.id) + '">' +
          esc(t("adm_duty_edit", "Edit")) + "</button>" +
        '<button class="btn btn-outline btn-sm" type="button" data-duty-toggle="' + esc(r.id) + '">' +
          esc(r.is_active ? t("adm_duty_retire", "Take off duty") : t("adm_duty_restore", "Put back on")) +
        "</button>" +
        '<button class="btn btn-outline btn-sm" type="button" data-duty-del="' + esc(r.id) + '">' +
          esc(t("adm_duty_del", "Delete")) + "</button>" +
      "</td></tr>";
  }

  // ---- writing ------------------------------------------------------------

  function formValues() {
    return {
      name: ($("dtName").value || "").trim(),
      duty_key: $("dtKey").value,
      phone: ($("dtPhone").value || "").trim(),
      whatsapp: ($("dtWa").value || "").trim(),
      region: ($("dtRegion").value || "").trim(),
      sort: Number($("dtSort").value) || 0,
    };
  }

  function fillForm(r) {
    $("dtName").value = r ? r.name || "" : "";
    $("dtKey").value = r ? r.duty_key : "support_role_manager";
    $("dtPhone").value = r ? r.phone || "" : "";
    $("dtWa").value = r ? r.whatsapp || "" : "";
    $("dtRegion").value = r ? r.region || "" : "";
    $("dtSort").value = r ? String(r.sort || 0) : "0";
    editing = r ? r.id : null;
    $("dtSave").textContent = r
      ? t("adm_duty_update", "Save the change")
      : t("adm_duty_save", "Put them on duty");
    var cancel = $("dtCancel");
    if (cancel) cancel.hidden = !r;
  }

  /**
   * Add or edit, through the one function that does both.
   *
   * `active` is carried through rather than defaulted, because
   * support_duty_set() takes the whole row: editing somebody who is off duty
   * and leaving the flag out would quietly put them back on it.
   */
  async function save() {
    var c = sb();
    if (!c) return;
    var v = formValues();
    if (!v.name) { say(t("adm_duty_need_name", "Give them a name."), true); return; }
    if (!v.phone && !v.whatsapp) {
      say(t("adm_duty_need_reach",
        "Give a phone number, a WhatsApp number, or both. A duty nobody can reach is not a duty."), true);
      return;
    }
    var was = editing ? rows.filter(function (r) { return r.id === editing; })[0] : null;
    var btn = $("dtSave");
    btn.disabled = true;
    say(t("adm_duty_saving", "Saving…"));
    try {
      var res = await c.rpc("support_duty_set", {
        p_id: editing,
        p_name: v.name,
        p_duty_key: v.duty_key,
        p_phone: v.phone || null,
        p_whatsapp: v.whatsapp || null,
        p_region: v.region || null,
        p_active: was ? was.is_active : true,
        p_sort: v.sort,
      });
      if (res.error) throw res.error;
      fillForm(null);
      say(t("adm_duty_saved", "Saved."));
      await load();
    } catch (err) {
      say((err && err.message) || String(err), true);
    } finally {
      btn.disabled = false;
    }
  }

  async function toggle(id) {
    var c = sb();
    var r = rows.filter(function (x) { return x.id === id; })[0];
    if (!c || !r) return;
    try {
      var res = await c.rpc("support_duty_set", {
        p_id: r.id, p_name: r.name, p_duty_key: r.duty_key,
        p_phone: r.phone, p_whatsapp: r.whatsapp, p_region: r.region,
        p_active: !r.is_active, p_sort: r.sort,
      });
      if (res.error) throw res.error;
      say(r.is_active
        ? t("adm_duty_retired", "Taken off duty. They are off the support screens now.")
        : t("adm_duty_restored", "Back on duty."));
      await load();
    } catch (err) { say((err && err.message) || String(err), true); }
  }

  async function remove(id) {
    var c = sb();
    var r = rows.filter(function (x) { return x.id === id; })[0];
    if (!c || !r) return;
    // Deliberately a confirm rather than a dialog: this is the rare path, the
    // ordinary way to end a shift is the button beside it, and the sentence
    // says which of the two this is.
    if (!window.confirm(t("adm_duty_del_q",
      "Delete {name} completely? Taking them off duty is usually what you want, and it keeps the record.",
      { name: r.name }))) return;
    try {
      var res = await c.rpc("support_duty_delete", { p_id: id });
      if (res.error) throw res.error;
      if (editing === id) fillForm(null);
      say(t("adm_duty_deleted", "Deleted."));
      await load();
    } catch (err) { say((err && err.message) || String(err), true); }
  }

  // ---- wiring -------------------------------------------------------------

  function wire() {
    if (!$("dtTable")) return;
    $("dtSave") && $("dtSave").addEventListener("click", save);
    $("dtCancel") && $("dtCancel").addEventListener("click", function () {
      fillForm(null);
      say("");
    });
    $("dtRefresh") && $("dtRefresh").addEventListener("click", load);
    // One listener on the table, because draw() rewrites it: a listener per row
    // is the accumulating-handler bug every other file here avoids the same way.
    $("dtTable").addEventListener("click", function (e) {
      if (!e.target.closest) return;
      var ed = e.target.closest("[data-duty-edit]");
      if (ed) {
        var r = rows.filter(function (x) { return x.id === ed.dataset.dutyEdit; })[0];
        if (r) { fillForm(r); say(""); $("dtName").focus(); }
        return;
      }
      var tg = e.target.closest("[data-duty-toggle]");
      if (tg) { toggle(tg.dataset.dutyToggle); return; }
      var dl = e.target.closest("[data-duty-del]");
      if (dl) { remove(dl.dataset.dutyDel); }
    });
    load();
  }

  window.initAdminDuties = wire;
})();
