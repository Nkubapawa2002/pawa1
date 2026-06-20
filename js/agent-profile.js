// =====================================================================
// Shared agent profile — region the agent BELONGS to + the AREA they
// OPERATE in (a ward, district or street). Captured once, right after an
// agent signs in to ANY agent dashboard (houses / trucks / services), and
// reused everywhere:
//   • admin "All Agents" tracker shows where each agent belongs/operates;
//   • new listings are stamped with the agent's region + operating area so a
//     searcher in that area finds the agent's services.
//
// Backed by public.agent_profiles (see supabase/agent_profiles.sql), keyed by
// the agent's auth user id — the same identity the billing tracker uses.
//
// Usage (from a dashboard, after sign-in):
//   const profile = await window.AgentProfile.ensure(sb);
//   // profile.region / profile.area_of_operations are now guaranteed set.
// =====================================================================
(function () {
  "use strict";

  const esc = (s) => (window.escHtml ? window.escHtml(s) : String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));

  // All 31 regions of the United Republic of Tanzania — 26 Mainland + 5 Zanzibar
  // (Unguja & Pemba). Used so an agent (incl. Zanzibar) can ALWAYS pick their
  // region even if the live `regions` table hasn't been seeded with Zanzibar.
  const TZ_REGIONS = [
    "Arusha", "Dar es Salaam", "Dodoma", "Geita", "Iringa", "Kagera", "Katavi",
    "Kigoma", "Kilimanjaro", "Lindi", "Manyara", "Mara", "Mbeya", "Morogoro",
    "Mtwara", "Mwanza", "Njombe", "Pwani", "Rukwa", "Ruvuma", "Shinyanga",
    "Simiyu", "Singida", "Songwe", "Tabora", "Tanga",
    "Kaskazini Unguja", "Kusini Unguja", "Mjini Magharibi",
    "Kaskazini Pemba", "Kusini Pemba",
  ];

  function isComplete(p) {
    return !!(p && p.region && String(p.region).trim() &&
              p.area_of_operations && String(p.area_of_operations).trim());
  }

  async function currentUid(sb) {
    try { const { data } = await sb.auth.getSession(); return data?.session?.user?.id || null; }
    catch (_) { return null; }
  }

  async function get(sb) {
    const uid = await currentUid(sb);
    if (!uid) return null;
    try {
      const { data } = await sb.from("agent_profiles").select("*").eq("user_id", uid).maybeSingle();
      return data || null;
    } catch (_) { return null; }
  }

  async function loadRegions(opts) {
    let list = [];
    if (Array.isArray(opts.regions) && opts.regions.length) list = opts.regions;
    else { try { list = (await window.DataStore?.getRegions?.()) || []; } catch (_) { list = []; } }
    // Always offer every Tanzania + Zanzibar region, even if the live `regions`
    // table is missing some (e.g. Zanzibar). Merge, dedupe (case-insensitive), sort.
    const seen = new Set();
    const merged = [];
    for (const r of [...list, ...TZ_REGIONS]) {
      const name = String(r || "").trim();
      const key = name.toLowerCase();
      if (name && !seen.has(key)) { seen.add(key); merged.push(name); }
    }
    return merged.sort((a, b) => a.localeCompare(b));
  }

  // Map a place-suggestion tag to our stored area_kind + structured fields.
  function classify(pick) {
    if (!pick) return { area_kind: null, district: "", ward: "" };
    const tag = (pick.tag || "").toLowerCase();
    const ctx = (pick.context || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (tag === "ward")     return { area_kind: "ward",     ward: pick.name, district: ctx[0] || "" };
    if (tag === "district") return { area_kind: "district", district: pick.name, ward: "" };
    if (tag === "street" || tag === "road") return { area_kind: "street", district: "", ward: "" };
    // Suburb / Area / Village etc. — treat as a named area, keep its wider parts.
    return { area_kind: "area", ward: "", district: ctx[0] || "" };
  }

  // ---- The modal --------------------------------------------------------
  function buildModal(existing, regions) {
    const wrap = document.createElement("div");
    wrap.id = "agentProfileModal";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.style.cssText =
      "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(10,20,16,.55);backdrop-filter:blur(3px);padding:16px;";
    // Region is a TYPE-TO-FILTER combobox: the agent can type any region and the
    // matching ones (all 31 Tanzania + Zanzibar regions) appear to pick from.
    // We keep the full list on the input as data so the dropdown can filter it.
    wrap.innerHTML = `
      <div class="apf-card" style="background:#fff;color:#0f172a;max-width:440px;width:100%;border-radius:16px;
           box-shadow:0 20px 60px rgba(0,0,0,.35);padding:22px 20px;font-family:inherit;">
        <h2 style="margin:0 0 4px;font-size:1.15rem;">Where do you operate?</h2>
        <p style="margin:0 0 12px;font-size:.88rem;color:#475569;line-height:1.45;">
          Tell us the region you belong to and the area you work in — a <strong>ward</strong>,
          <strong>district</strong> or <strong>street</strong>.</p>
        <p style="margin:0 0 16px;font-size:.83rem;color:#0a6f4d;background:#ecfdf5;border:1px solid #a7f3d0;
           border-radius:9px;padding:9px 11px;line-height:1.45;">
          📍 <strong>This is how customers find you.</strong> Every listing you post is shown to
          people searching <em>your</em> region and area — so setting it correctly puts your
          services in front of your target customers. Get it wrong and the right people won't see you.</p>

        <label style="display:block;font-size:.8rem;font-weight:600;margin:0 0 4px;">Region</label>
        <div style="position:relative;">
          <input id="apfRegion" type="text" autocomplete="off" role="combobox" aria-expanded="false"
            placeholder="Type your region (e.g. Dar es Salaam, Mjini Magharibi…)"
            value="${esc(existing && existing.region || "")}"
            style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:9px;margin:0 0 14px;font-size:.95rem;">
          <div id="apfRegionSuggest" style="position:absolute;left:0;right:0;top:calc(100% - 8px);background:#fff;border:1px solid #e2e8f0;
               border-radius:9px;box-shadow:0 10px 30px rgba(0,0,0,.12);max-height:220px;overflow:auto;z-index:6;display:none;"></div>
        </div>

        <label style="display:block;font-size:.8rem;font-weight:600;margin:0 0 4px;">Area of operations</label>
        <div style="position:relative;">
          <input id="apfArea" type="text" autocomplete="off" placeholder="e.g. Mikocheni (ward), Kinondoni (district), or a street"
            value="${esc(existing && existing.area_of_operations || "")}"
            style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:9px;font-size:.95rem;">
          <div id="apfSuggest" style="position:absolute;left:0;right:0;top:calc(100% + 4px);background:#fff;border:1px solid #e2e8f0;
               border-radius:9px;box-shadow:0 10px 30px rgba(0,0,0,.12);max-height:220px;overflow:auto;z-index:5;display:none;"></div>
        </div>
        <p id="apfAreaHint" style="margin:6px 0 14px;font-size:.76rem;color:#64748b;">
          Start typing and pick from the list to place it precisely — or just type the name.</p>

        <details style="margin:0 0 14px;">
          <summary style="cursor:pointer;font-size:.82rem;color:#475569;">Your contact (optional)</summary>
          <div style="margin-top:10px;">
            <input id="apfName" type="text" placeholder="Your name"
              value="${esc(existing && existing.name || "")}"
              style="width:100%;padding:9px;border:1px solid #cbd5e1;border-radius:9px;margin:0 0 8px;font-size:.92rem;">
            <input id="apfPhone" type="tel" placeholder="Phone (e.g. +255…)"
              value="${esc(existing && existing.phone || "")}"
              style="width:100%;padding:9px;border:1px solid #cbd5e1;border-radius:9px;font-size:.92rem;">
          </div>
        </details>

        <div id="apfMsg" style="display:none;font-size:.82rem;margin:0 0 10px;"></div>
        <button id="apfSave" type="button"
          style="width:100%;padding:12px;border:0;border-radius:10px;background:#0a6f4d;color:#fff;font-size:.98rem;font-weight:600;cursor:pointer;">
          Save &amp; continue</button>
      </div>`;
    return wrap;
  }

  // Show the modal and resolve with the saved profile (never rejects — on a
  // hard failure it resolves null so the dashboard still loads).
  function collect(sb, uid, existing, regions) {
    return new Promise((resolve) => {
      const modal = buildModal(existing, regions);
      document.body.appendChild(modal);
      const $ = (id) => modal.querySelector("#" + id);
      const regionEl = $("apfRegion"), areaEl = $("apfArea"), sugEl = $("apfSuggest");
      const regSugEl = $("apfRegionSuggest");
      const msgEl = $("apfMsg"), saveBtn = $("apfSave");
      let picked = null;          // the chosen place suggestion, if any
      let sugTimer = null;

      // ---- Region type-to-filter combobox ---------------------------------
      // Show the regions whose name contains what the agent typed (all of them
      // when the box is empty/focused), and let them click one to fill it.
      const renderRegions = () => {
        const q = regionEl.value.trim().toLowerCase();
        const hits = regions.filter((r) => !q || r.toLowerCase().includes(q));
        if (!hits.length) { regSugEl.style.display = "none"; regionEl.setAttribute("aria-expanded", "false"); return; }
        regSugEl.innerHTML = hits.map((r) =>
          `<div class="apf-reg" data-r="${esc(r)}" style="padding:9px 11px;cursor:pointer;border-bottom:1px solid #f1f5f9;font-size:.9rem;">${esc(r)}</div>`
        ).join("");
        regSugEl.style.display = "block";
        regionEl.setAttribute("aria-expanded", "true");
        regSugEl.querySelectorAll(".apf-reg").forEach((row) => {
          row.addEventListener("mousedown", (e) => {
            e.preventDefault();
            regionEl.value = row.dataset.r;
            regSugEl.style.display = "none";
            regionEl.setAttribute("aria-expanded", "false");
            areaEl.focus();
          });
        });
      };
      regionEl.addEventListener("focus", renderRegions);
      regionEl.addEventListener("input", renderRegions);
      regionEl.addEventListener("blur", () => setTimeout(() => {
        regSugEl.style.display = "none"; regionEl.setAttribute("aria-expanded", "false");
      }, 150));

      const setMsg = (t, ok) => {
        msgEl.style.display = t ? "block" : "none";
        msgEl.style.color = ok ? "#0a6f4d" : "#b91c1c";
        msgEl.textContent = t || "";
      };

      // Typing the area clears any previous map pick (it no longer matches).
      areaEl.addEventListener("input", () => {
        picked = null;
        const q = areaEl.value.trim();
        clearTimeout(sugTimer);
        if (q.length < 2 || !window.pawaGeo?.suggest) { sugEl.style.display = "none"; return; }
        sugTimer = setTimeout(async () => {
          let hits = [];
          try { hits = await window.pawaGeo.suggest(q, { limit: 8 }); } catch (_) {}
          if (!hits.length) { sugEl.style.display = "none"; return; }
          sugEl.innerHTML = hits.map((h, i) =>
            `<div class="apf-sug" data-i="${i}" style="padding:9px 11px;cursor:pointer;border-bottom:1px solid #f1f5f9;font-size:.88rem;">
               <strong>${esc(h.name)}</strong> <span style="color:#94a3b8;">${esc(h.tag || "")}</span>
               ${h.context ? `<div style="color:#64748b;font-size:.78rem;">${esc(h.context)}</div>` : ""}
             </div>`).join("");
          sugEl.style.display = "block";
          sugEl.querySelectorAll(".apf-sug").forEach((row) => {
            row.addEventListener("mousedown", (e) => {
              e.preventDefault();
              picked = hits[+row.dataset.i];
              areaEl.value = picked.name;
              sugEl.style.display = "none";
              // If the region is still empty, infer it from the pick's context:
              // match any context part against a known region, else take the last part.
              if (!regionEl.value && picked.context) {
                const parts = picked.context.split(",").map((s) => s.trim()).filter(Boolean);
                const match = parts.find((p) => regions.some((r) => r.toLowerCase() === p.toLowerCase()));
                if (match) regionEl.value = regions.find((r) => r.toLowerCase() === match.toLowerCase());
                else if (parts.length) regionEl.value = parts[parts.length - 1];
              }
            });
          });
        }, 280);
      });
      areaEl.addEventListener("blur", () => setTimeout(() => { sugEl.style.display = "none"; }, 150));

      saveBtn.addEventListener("click", async () => {
        const region = regionEl.value.trim();
        const area = areaEl.value.trim();
        if (!region) { setMsg("Please choose your region."); regionEl.focus(); return; }
        if (!area)   { setMsg("Please enter the area you operate in (ward, district or street)."); areaEl.focus(); return; }

        saveBtn.disabled = true; saveBtn.textContent = "Saving…";
        const cls = classify(picked);
        const row = {
          user_id: uid,
          name: ($("apfName").value.trim()) || (existing && existing.name) || null,
          phone: ($("apfPhone").value.trim()) || (existing && existing.phone) || null,
          region,
          area_of_operations: area,
          area_kind: cls.area_kind,
          district: cls.district || (existing && existing.district) || null,
          ward: cls.ward || (existing && existing.ward) || null,
          lat: picked && Number.isFinite(+picked.lat) ? +picked.lat : (existing && existing.lat) || null,
          lng: picked && Number.isFinite(+picked.lng) ? +picked.lng : (existing && existing.lng) || null,
        };
        try {
          const { data, error } = await sb.from("agent_profiles")
            .upsert(row, { onConflict: "user_id" }).select().maybeSingle();
          if (error) throw error;
          modal.remove();
          resolve(data || row);
        } catch (err) {
          saveBtn.disabled = false; saveBtn.textContent = "Save & continue";
          setMsg("Couldn't save: " + (err?.message || "please try again."));
        }
      });

      // Focus the first empty field for a quick path through.
      setTimeout(() => { (regionEl.value ? areaEl : regionEl).focus(); }, 60);
    });
  }

  // Ensure the signed-in agent has a complete profile. If it's already complete
  // returns it immediately; otherwise prompts (required) and returns the saved
  // profile. Returns null only when not signed in or Supabase is unavailable.
  async function ensure(sb, opts = {}) {
    if (!sb) return null;
    const uid = await currentUid(sb);
    if (!uid) return null;
    const existing = await get(sb);
    if (isComplete(existing)) return existing;
    // Don't stack a second modal if ensure() is called again while one is open.
    if (document.getElementById("agentProfileModal")) return existing;
    const regions = await loadRegions(opts);
    return await collect(sb, uid, existing, regions);
  }

  window.AgentProfile = { ensure, get, isComplete };
})();
