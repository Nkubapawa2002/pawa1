// ============================================================================
//  admin-notices.js — the half of the notice system a person types.
// ============================================================================
//  supabase/features/agent/agent_notices.sql writes a notice on every change
//  an admin makes in the tracker: approved, deactivated, paid, overdue. Those
//  are automatic and they are the majority. This file is the rest:
//
//    write one       to a single account, or to everyone in a state that is
//                    worth writing to (lapsed, deactivated, ending soon).
//    remind          run the renewal sweep for a window of days. Safe to press
//                    twice, safe to press daily: the database keys each notice
//                    by the expiry date it is warning about.
//    and the log     what has gone out and whether it has been read, because
//                    "did they get told?" is the question an admin asks after
//                    somebody phones to complain.
//
//  WHO GETS IT is resolved HERE, from agent_billing, rather than in a stored
//  function. The three audiences are the same three the tracker already
//  filters by on screen, and an admin who has just looked at a list of eleven
//  lapsed agents should be writing to those eleven, not to whatever a second
//  definition of "lapsed" living in the database happens to return.
//
//  Every recipient is an ACCOUNT. agent_billing also holds 'ph:' keys, which
//  are phone numbers off a listing with nobody signed in behind them; there is
//  no inbox to write to, so they are skipped rather than counted.
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

  function say(el, kind, msg) {
    if (!el) return;
    el.className = "adm-out" + (kind ? " " + kind : "");
    el.textContent = msg || "";
  }

  function when(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString(
        (window.getLang && window.getLang()) === "sw" ? "sw-TZ" : "en-GB",
        { day: "numeric", month: "short", year: "numeric" });
    } catch (_) { return String(iso).slice(0, 10); }
  }

  // ---- who ------------------------------------------------------------------
  /**
   * The accounts behind an audience.
   *
   * Reads agent_billing, which the admin policy opens in full, and returns the
   * user ids of every 'uid:' key in the state asked for. A phone-only key is
   * dropped: there is no account behind it to receive anything.
   */
  async function recipients(audience) {
    var c = sb();
    if (!c) return [];
    var today = new Date().toISOString().slice(0, 10);
    var q = c.from("agent_billing").select("agent_key,active,status,paid_until").like("agent_key", "uid:%");
    var res = await q;
    if (res.error) throw new Error(res.error.message);
    var rows = res.data || [];
    var soon = new Date();
    soon.setDate(soon.getDate() + 7);
    var soonStr = soon.toISOString().slice(0, 10);

    return rows.filter(function (r) {
      if (audience === "deactivated") return r.active === false;
      if (audience === "unpaid") {
        if (r.active === false) return false;
        if (r.status === "overdue" || r.status === "cancelled") return true;
        return !!r.paid_until && r.paid_until < today;
      }
      if (audience === "expiring") {
        if (r.active === false) return false;
        return !!r.paid_until && r.paid_until >= today && r.paid_until <= soonStr;
      }
      return false;
    }).map(function (r) { return r.agent_key.slice(4); }).filter(Boolean);
  }

  // ---- send -----------------------------------------------------------------
  async function send() {
    var out = $("ntOut");
    var c = sb();
    if (!c) return;
    var who = $("ntWho").value;
    var title = ($("ntTitle").value || "").trim();
    var body = ($("ntBody").value || "").trim();
    var severity = $("ntSeverity").value || "info";

    if (!title) { say(out, "bad", t("adm_not_need_title", "Give it a title. That is the line they see in the bell.")); return; }

    var uids = [];
    try {
      if (who === "one") {
        var one = ($("ntUid").value || "").trim();
        if (!one) { say(out, "bad", t("adm_not_need_uid", "Paste the account id from the agents table.")); return; }
        uids = [one];
      } else {
        uids = await recipients(who);
      }
    } catch (err) {
      say(out, "bad", (err && err.message) || String(err));
      return;
    }

    if (!uids.length) { say(out, "bad", t("adm_not_nobody", "Nobody is in that state right now.")); return; }

    var btn = $("ntSend");
    btn.disabled = true;
    say(out, "", t("adm_working", "Working…"));
    try {
      var email = null;
      try { email = await window.Auth.currentEmail(); } catch (_) {}
      var rows = uids.map(function (u) {
        return {
          to_user_id: u, title: title, body: body,
          kind: who === "one" ? "individual" : who,
          severity: severity, created_by: email || "admin",
        };
      });
      var res = await c.from("agent_messages").insert(rows);
      if (res.error) throw new Error(res.error.message);
      say(out, "ok", uids.length === 1
        ? t("adm_not_sent_1", "Sent. It is in their notifications now.")
        : t("adm_not_sent_n", "Sent to {n} accounts.", { n: uids.length }));
      $("ntTitle").value = "";
      $("ntBody").value = "";
      drawSent();
    } catch (err) {
      say(out, "bad", (err && err.message) || String(err));
    } finally {
      btn.disabled = false;
    }
  }

  // ---- remind ---------------------------------------------------------------
  async function remind() {
    var out = $("ntRemOut");
    var c = sb();
    if (!c) return;
    var days = parseInt($("ntRemDays").value, 10) || 7;
    var btn = $("ntRemind");
    btn.disabled = true;
    say(out, "", t("adm_working", "Working…"));
    try {
      var res = await c.rpc("agent_notices_remind", { p_days: days });
      if (res.error) throw new Error(res.error.message);
      var n = Number(res.data) || 0;
      // Zero is an answer and a good one: either nobody is close to expiring,
      // or everybody who is has already been told. Reporting it as a failure
      // would have an admin pressing the button again.
      say(out, "ok", n === 0
        ? t("adm_rem_none", "Nobody new to remind. Everyone in that window has already been told.")
        : t("adm_rem_sent", "Reminded {n} agents.", { n: n }));
      drawSent();
    } catch (err) {
      say(out, "bad", (err && err.message) || String(err));
    } finally {
      btn.disabled = false;
    }
  }

  // ---- the log --------------------------------------------------------------
  async function drawSent() {
    var table = $("ntSentTable");
    if (!table) return;
    var c = sb();
    if (!c) return;
    table.innerHTML = '<tbody><tr><td class="adm-empty">' + esc(t("adm_loading", "Loading…")) + "</td></tr></tbody>";
    var res = await c.from("agent_messages")
      .select("id,to_user_id,title,body,kind,severity,created_by,created_at,read_at")
      .order("created_at", { ascending: false })
      .limit(60);
    if (res.error) {
      table.innerHTML = '<tbody><tr><td class="adm-empty">' + esc(res.error.message) + "</td></tr></tbody>";
      return;
    }
    var rows = res.data || [];
    if (!rows.length) {
      table.innerHTML = '<tbody><tr><td class="adm-empty">' +
        esc(t("adm_sent_none", "Nothing has been sent yet.")) + "</td></tr></tbody>";
      return;
    }
    var head = "<thead><tr>" +
      "<th>" + esc(t("adm_col_when", "When")) + "</th>" +
      "<th>" + esc(t("adm_col_who", "To")) + "</th>" +
      "<th>" + esc(t("adm_col_what", "Notice")) + "</th>" +
      "<th>" + esc(t("adm_col_from", "From")) + "</th>" +
      "<th>" + esc(t("adm_col_read", "Read")) + "</th>" +
      "</tr></thead>";
    var body = rows.map(function (r) {
      var sev = r.severity || "info";
      return "<tr>" +
        "<td>" + esc(when(r.created_at)) + "</td>" +
        "<td><code>" + esc(String(r.to_user_id || "").slice(0, 12)) + "</code></td>" +
        "<td><b>" + esc(r.title || "") + "</b>" +
          '<span class="adm-sev ' + esc(sev) + '" style="margin-left:8px">' + esc(sev) + "</span>" +
          (r.body ? '<div class="adm-sub" style="margin:2px 0 0">' + esc(String(r.body).slice(0, 120)) + "</div>" : "") +
        "</td>" +
        // 'system' is the database itself, writing on a change in the tracker.
        // Worth showing: it is the difference between a notice somebody typed
        // and one the platform sent on their behalf.
        "<td>" + esc(r.created_by === "system"
          ? t("adm_from_system", "automatic") : (r.created_by || "")) + "</td>" +
        "<td>" + (r.read_at ? esc(when(r.read_at)) : "—") + "</td>" +
      "</tr>";
    }).join("");
    table.innerHTML = head + "<tbody>" + body + "</tbody>";

    var unread = rows.filter(function (r) { return !r.read_at; }).length;
    var badge = $("noticesBadge");
    if (badge) badge.textContent = unread ? String(unread) : "";
  }

  // ---- wiring ---------------------------------------------------------------
  function wire() {
    if (!$("ntSend")) return;
    $("ntSend").addEventListener("click", send);
    $("ntRemind").addEventListener("click", remind);
    // The account-id field only makes sense for one recipient. Hiding it for
    // the group audiences is the difference between a form and a quiz.
    $("ntWho").addEventListener("change", function () {
      $("ntOneRow").hidden = $("ntWho").value !== "one";
    });
    drawSent();
  }

  window.initAdminNotices = wire;
})();
