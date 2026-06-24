// =====================================================================
// Shared agent demand board — region + district match, any dashboard
// =====================================================================
// The same region+district matching the houses dashboard uses, surfaced on the
// services and trucks dashboards too: every person actively waiting in the
// agent's region (their own DISTRICT first) is a lead. A renter moving into the
// area needs a moving truck and daily services, so the same demand is shown,
// with copy tailored per dashboard.
//
//   window.AgentDemandBoard.load({ sb, agentProfile, mount, kind });
//   kind: "houses" | "services" | "trucks"
//
// Runs the matching in Postgres (house_demand_for_agent → house_demand_in_region
// fallback). Degrades to nothing if no region / RPC not installed, so it can
// never break a dashboard.
(function () {
  "use strict";

  const esc = (s) => window.escHtml ? window.escHtml(s) : String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const T = (k) => (window.t ? window.t(k) : k);

  function fmtTzs(p) {
    p = Number(p) || 0;
    if (p >= 1e9) return (p / 1e9).toFixed(p % 1e9 ? 1 : 0) + "B";
    if (p >= 1e6) return (p / 1e6).toFixed(p % 1e6 ? 1 : 0) + "M";
    if (p >= 1e3) return Math.round(p / 1e3) + "k";
    return String(p);
  }
  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const d = new Date(String(dateStr).slice(0, 10) + "T00:00:00");
    if (isNaN(d)) return null;
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return Math.round((d - t) / 86400000);
  }
  function neededByChip(by) {
    const n = daysUntil(by);
    if (n == null) return "";
    const cls = n <= 7 ? "urgent" : n <= 30 ? "soon" : "later";
    const txt = n < 0 ? T("adb_overdue") : n === 0 ? T("adb_today")
      : n <= 60 ? T("adb_in_days").replace("{n}", n) : `${T("adb_by")} ${String(by).slice(0, 10)}`;
    return `<span class="adb-by ${cls}">${T("adb_needs")} ${txt}</span>`;
  }

  function ensureStyles() {
    if (document.getElementById("adbStyles")) return;
    const s = document.createElement("style");
    s.id = "adbStyles";
    s.textContent = `
      #agentDemandBoard{margin:0 0 16px}
      .adb-card{background:#fff7ed;border:1px solid #fcd9a8;border-radius:14px;padding:14px 16px;position:relative}
      .adb-x{position:absolute;top:10px;right:12px;border:0;background:none;font-size:20px;line-height:1;color:#9a3412;cursor:pointer;opacity:.6}
      .adb-x:hover{opacity:1}
      .adb-head{font-weight:800;color:#9a3412;font-size:1rem;margin:0 4px 2px 0;padding-right:20px}
      .adb-sub{font-size:.86rem;color:#9a5b2a;margin:0 0 10px;line-height:1.45}
      .adb-row{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:9px 0;border-top:1px solid #fde3bf}
      .adb-row:first-of-type{border-top:0}
      .adb-who strong{font-size:.92rem;color:#1a1915}
      .adb-who small{display:block;font-size:.78rem;color:#6b6960;margin-top:1px}
      .adb-spec{display:block;font-size:.78rem;color:#5a4a2f;margin-top:3px;line-height:1.4}
      .adb-badge{display:inline-block;font-size:.68rem;font-weight:800;padding:2px 8px;border-radius:999px;margin-left:6px;background:#fde68a;color:#92400e}
      .adb-by{display:inline-block;font-size:.72rem;font-weight:700;padding:2px 8px;border-radius:999px;margin-top:3px}
      .adb-by.urgent{background:#fde6e2;color:#b3261e}.adb-by.soon{background:#fff3d6;color:#946200}.adb-by.later{background:#e7f0ea;color:#41504a}
      .adb-cta{display:flex;gap:6px;flex-shrink:0}
      .adb-btn{display:inline-flex;align-items:center;gap:4px;padding:7px 11px;border-radius:9px;font-weight:700;font-size:.82rem;text-decoration:none;border:0;cursor:pointer}
      .adb-btn.call{background:#0a6f4d;color:#fff}.adb-btn.wa{background:#25d366;color:#063}
      .adb-more{margin-top:10px;font-size:.8rem;color:#9a3412;font-weight:600;text-align:center}`;
    document.head.appendChild(s);
  }

  async function fetchMatches(sb, region, district) {
    // Preferred: region + district (own district ranked first).
    try {
      const { data, error } = await sb.rpc("house_demand_for_agent", {
        p_region: region, p_district: district || null, p_listing: null, p_limit: 100,
      });
      if (!error && Array.isArray(data)) return data;
    } catch (_) {}
    // Fallback: region-only RPC.
    try {
      const { data, error } = await sb.rpc("house_demand_in_region", {
        p_region: region, p_listing: null, p_limit: 100,
      });
      if (!error && Array.isArray(data)) return data;
    } catch (_) {}
    return [];
  }

  async function load(opts) {
    opts = opts || {};
    const sb = opts.sb, mount = opts.mount, kind = opts.kind || "houses";
    const region = opts.agentProfile && opts.agentProfile.region;
    const district = (opts.agentProfile && opts.agentProfile.district) || null;
    const existing = () => document.getElementById("agentDemandBoard");
    if (!sb || !mount || !region) { existing()?.remove(); return; }

    let rows = await fetchMatches(sb, region, district);
    if (!rows.length) { existing()?.remove(); return; }

    // District matches first, then soonest deadline, then newest.
    rows.sort((a, b) => {
      const ad = a.match_level === "district" ? 0 : 1, bd = b.match_level === "district" ? 0 : 1;
      if (ad !== bd) return ad - bd;
      const da = daysUntil(a.needed_by), db = daysUntil(b.needed_by);
      if ((da == null) !== (db == null)) return da == null ? 1 : -1;
      if (da != null && db != null && da !== db) return da - db;
      return 0;
    });

    ensureStyles();
    let panel = existing();
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "agentDemandBoard";
      mount.insertBefore(panel, mount.firstChild);
    }
    const top = rows.slice(0, 12);
    const where = district ? `${esc(district)} & ${esc(region)}` : esc(region);
    const items = top.map((r) => {
      const phone = String(r.phone || "").trim();
      const digits = phone.replace(/\D/g, "");
      const intl = digits.startsWith("0") ? "255" + digits.slice(1) : digits;
      const inDistrict = r.match_level === "district";
      const spec = window.pawaDemandSpec ? window.pawaDemandSpec(r) : "";
      return `<div class="adb-row">
        <div class="adb-who">
          <strong>${esc(r.name || T("adb_waiting_client"))}</strong>${inDistrict ? `<span class="adb-badge">${T("adb_your_district")}</span>` : ""}
          ${r.area ? `<small>${esc(r.area)}</small>` : ""}
          ${spec}
          ${neededByChip(r.needed_by)}
        </div>
        <div class="adb-cta">
          ${phone ? `<a class="adb-btn call" href="tel:${esc(phone)}">${T("action_call")}</a>` : ""}
          ${intl ? `<a class="adb-btn wa" href="https://wa.me/${esc(intl)}" target="_blank" rel="noopener">${T("action_whatsapp")}</a>` : ""}
        </div>
      </div>`;
    }).join("");
    const urgent = top.filter((r) => { const n = daysUntil(r.needed_by); return n != null && n <= 7; }).length;
    const head = T("adb_" + kind + "_head").replace("{n}", rows.length).replace("{where}", where);
    panel.innerHTML = `<div class="adb-card">
      <button type="button" class="adb-x" aria-label="Hide">×</button>
      <div class="adb-head">${head}</div>
      <div class="adb-sub">${urgent ? `<strong>${T("adb_urgent").replace("{n}", urgent)}</strong> ` : ""}${T("adb_" + kind + "_sub")}</div>
      ${items}
      ${rows.length > top.length ? `<div class="adb-more">${T("adb_more").replace("{n}", rows.length - top.length)}</div>` : ""}
    </div>`;
    panel.querySelector(".adb-x")?.addEventListener("click", () => panel.remove());
  }

  window.AgentDemandBoard = { load };
})();
