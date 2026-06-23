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

  // ---- Native sheet styling --------------------------------------------
  // Token-driven so the sheet matches the active "Twilight" theme (dark by
  // default, warm-cream when the user flips to light). Every colour reads a
  // --n-* / --c-* design token with a dark fallback, so it still looks native
  // even on a page that hasn't loaded the full token stack.
  const PIN_SVG =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>' +
    '<circle cx="12" cy="10" r="2.6" stroke="currentColor" stroke-width="1.7"/></svg>';

  function injectStyles() {
    if (document.getElementById("apf-styles")) return;
    const s = document.createElement("style");
    s.id = "apf-styles";
    s.textContent = `
      .apf-modal{ position:fixed; inset:0; z-index:99999; display:flex;
        align-items:flex-end; justify-content:center;
        background:rgba(4,10,8,.62);
        -webkit-backdrop-filter:blur(8px) saturate(1.1); backdrop-filter:blur(8px) saturate(1.1);
        font-family:var(--c-font-body,'Inter',-apple-system,system-ui,sans-serif);
        opacity:0; transition:opacity .28s ease; }
      .apf-modal.is-in{ opacity:1; }
      @media (min-width:600px){ .apf-modal{ align-items:center; padding:20px; } }

      .apf-card{ box-sizing:border-box; width:100%; max-width:480px;
        background:var(--n-surface,#0f221a); color:var(--n-text,#f0f5f2);
        border:1px solid var(--n-border-strong,rgba(255,255,255,.12)); border-bottom:none;
        border-radius:26px 26px 0 0; box-shadow:0 -22px 60px rgba(0,0,0,.5);
        padding:8px 20px calc(env(safe-area-inset-bottom,0px) + 22px);
        max-height:92vh; max-height:92dvh; overflow-y:auto; -webkit-overflow-scrolling:touch;
        transform:translateY(100%); transition:transform .42s cubic-bezier(.32,.72,0,1); }
      .apf-modal.is-in .apf-card{ transform:translateY(0); }
      @media (min-width:600px){
        .apf-card{ border:1px solid var(--n-border-strong,rgba(255,255,255,.12));
          border-radius:24px; box-shadow:0 28px 70px rgba(0,0,0,.55);
          padding-top:22px; transform:translateY(14px) scale(.98); }
        .apf-modal.is-in .apf-card{ transform:translateY(0) scale(1); }
      }

      .apf-grab{ width:38px; height:4px; border-radius:999px;
        background:var(--n-border-strong,rgba(255,255,255,.18)); margin:6px auto 16px; }
      @media (min-width:600px){ .apf-grab{ display:none; } }

      .apf-eyebrow{ margin:0 0 7px; font-size:.7rem; font-weight:700; letter-spacing:.13em;
        text-transform:uppercase; color:var(--n-green-bright,#34d399); }
      .apf-title{ margin:0 0 7px; font-family:var(--c-font-display,Georgia,'Times New Roman',serif);
        font-size:1.55rem; line-height:1.12; font-weight:600; letter-spacing:-.02em;
        color:var(--n-text,#f0f5f2); }
      .apf-sub{ margin:0 0 16px; font-size:.9rem; line-height:1.5; color:var(--n-text-muted,#8a9c92); }
      .apf-sub strong{ color:var(--n-text-soft,#c8d3cd); font-weight:600; }

      .apf-note{ display:flex; gap:10px; margin:0 0 22px; padding:12px 14px; border-radius:14px;
        background:var(--n-green-soft,rgba(16,185,129,.10));
        border:1px solid var(--n-green-line,rgba(16,185,129,.25));
        font-size:.82rem; line-height:1.5; color:var(--n-text-soft,#c8d3cd); }
      .apf-note svg{ flex:none; width:18px; height:18px; margin-top:1px; color:var(--n-green-bright,#34d399); }
      .apf-note strong{ color:var(--n-text,#f0f5f2); font-weight:700; }

      .apf-label{ display:block; margin:0 0 7px; font-size:.78rem; font-weight:700;
        letter-spacing:.01em; color:var(--n-text-soft,#c8d3cd); }
      .apf-field{ position:relative; margin:0 0 16px; }
      .apf-input{ box-sizing:border-box; width:100%; min-height:52px; padding:14px;
        font-size:16px; font-family:inherit; color:var(--n-text,#f0f5f2);
        background:var(--n-surface-2,#142b22);
        border:1px solid var(--n-border-strong,rgba(255,255,255,.12)); border-radius:14px;
        -webkit-appearance:none; appearance:none;
        transition:border-color .18s ease, box-shadow .18s ease, background .18s ease; }
      .apf-input::placeholder{ color:var(--n-text-faint,#586a60); }
      .apf-input:hover{ border-color:var(--n-green-line,rgba(16,185,129,.4)); }
      .apf-input:focus{ outline:none; border-color:var(--n-green,#10b981);
        background:var(--n-surface,#0f221a); box-shadow:0 0 0 4px rgba(16,185,129,.18); }

      .apf-suggest{ position:absolute; left:0; right:0; top:calc(100% + 6px); z-index:6;
        background:var(--n-surface-2,#142b22);
        border:1px solid var(--n-border-strong,rgba(255,255,255,.14)); border-radius:14px;
        box-shadow:0 18px 44px rgba(0,0,0,.5); max-height:240px; overflow:auto;
        -webkit-overflow-scrolling:touch; display:none; }
      .apf-row{ padding:12px 14px; cursor:pointer; font-size:.92rem; color:var(--n-text-soft,#c8d3cd);
        border-bottom:1px solid var(--n-border,rgba(255,255,255,.06)); transition:background .12s ease; }
      .apf-row:last-child{ border-bottom:none; }
      .apf-row:hover, .apf-row.is-active{ background:var(--n-green-soft,rgba(16,185,129,.14)); color:var(--n-text,#f0f5f2); }
      .apf-row strong{ color:var(--n-text,#f0f5f2); font-weight:600; }
      .apf-row .apf-tag{ margin-left:5px; font-size:.74rem; text-transform:uppercase;
        letter-spacing:.06em; color:var(--n-text-faint,#586a60); }
      .apf-row .apf-ctx{ margin-top:2px; font-size:.78rem; color:var(--n-text-muted,#8a9c92); }

      .apf-hint{ margin:-7px 0 18px; font-size:.76rem; line-height:1.45; color:var(--n-text-muted,#8a9c92); }

      .apf-details{ margin:0 0 18px; overflow:hidden; border-radius:14px;
        border:1px solid var(--n-border,rgba(255,255,255,.08)); background:var(--n-surface-2,#142b22); }
      .apf-summary{ display:flex; align-items:center; justify-content:space-between;
        padding:14px; cursor:pointer; list-style:none; font-size:.86rem; font-weight:600;
        color:var(--n-text-soft,#c8d3cd); -webkit-tap-highlight-color:transparent; }
      .apf-summary::-webkit-details-marker{ display:none; }
      .apf-summary::after{ content:""; width:9px; height:9px; opacity:.55;
        border-right:2px solid currentColor; border-bottom:2px solid currentColor;
        transform:rotate(45deg); transition:transform .2s ease; }
      .apf-details[open] .apf-summary::after{ transform:rotate(-135deg); }
      .apf-details__body{ display:flex; flex-direction:column; gap:10px; padding:2px 14px 16px; }

      .apf-msg{ display:none; margin:0 0 12px; padding:11px 13px; border-radius:12px;
        font-size:.84rem; line-height:1.4; }
      .apf-msg.is-err{ display:block; background:var(--n-surface-err,#2a0d0d);
        color:var(--n-text-err,#fecaca); border:1px solid rgba(248,113,113,.3); }
      .apf-msg.is-ok{ display:block; background:var(--n-surface-ok,#052619);
        color:var(--n-text-ok,#86efac); border:1px solid rgba(52,211,153,.3); }

      .apf-save{ width:100%; min-height:54px; padding:15px; border:0; border-radius:16px;
        cursor:pointer; font-family:inherit; font-size:1rem; font-weight:700; letter-spacing:.01em;
        color:var(--n-text-on-brand,#051a10);
        background:linear-gradient(180deg, var(--n-green-bright,#34d399), var(--n-green,#10b981));
        box-shadow:0 8px 24px rgba(16,185,129,.32);
        transition:transform .14s cubic-bezier(.2,.7,.2,1), box-shadow .2s ease, opacity .2s ease;
        -webkit-tap-highlight-color:transparent; }
      .apf-save:hover{ box-shadow:0 10px 30px rgba(16,185,129,.42); }
      .apf-save:active{ transform:scale(.97); }
      .apf-save:disabled{ opacity:.6; cursor:not-allowed; transform:none; box-shadow:none; }
      .apf-save:focus-visible{ outline:3px solid rgba(52,211,153,.5); outline-offset:3px; }

      @media (prefers-reduced-motion: reduce){
        .apf-modal, .apf-card, .apf-save, .apf-row, .apf-input{ transition:opacity .15s linear !important; }
        .apf-card{ transform:none !important; }
      }`;
    document.head.appendChild(s);
  }

  // ---- The modal --------------------------------------------------------
  function buildModal(existing, regions) {
    injectStyles();
    const wrap = document.createElement("div");
    wrap.id = "agentProfileModal";
    wrap.className = "apf-modal";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "apfTitle");
    // Region is a TYPE-TO-FILTER combobox: the agent can type any region and the
    // matching ones (all 31 Tanzania + Zanzibar regions) appear to pick from.
    wrap.innerHTML = `
      <div class="apf-card" role="document">
        <div class="apf-grab" aria-hidden="true"></div>
        <p class="apf-eyebrow">Your operating area</p>
        <h2 id="apfTitle" class="apf-title">Where do you operate?</h2>
        <p class="apf-sub">
          Tell us the region you belong to and the area you work in — a <strong>ward</strong>,
          <strong>district</strong> or <strong>street</strong>.</p>
        <p class="apf-note">
          ${PIN_SVG}
          <span><strong>This is how customers find you.</strong> Every listing you post is shown to
          people searching <em>your</em> region and area — set it right and the right people see you.</span></p>

        <label class="apf-label" for="apfRegion">Region</label>
        <div class="apf-field">
          <input id="apfRegion" class="apf-input" type="text" autocomplete="off" role="combobox" aria-expanded="false"
            placeholder="Type your region (e.g. Dar es Salaam…)"
            value="${esc(existing && existing.region || "")}">
          <div id="apfRegionSuggest" class="apf-suggest"></div>
        </div>

        <label class="apf-label" for="apfArea">Area of operations</label>
        <div class="apf-field">
          <input id="apfArea" class="apf-input" type="text" autocomplete="off"
            placeholder="e.g. Mikocheni (ward), Kinondoni (district), a street"
            value="${esc(existing && existing.area_of_operations || "")}">
          <div id="apfSuggest" class="apf-suggest"></div>
        </div>
        <p id="apfAreaHint" class="apf-hint">
          Start typing and pick from the list to place it precisely — or just type the name.</p>

        <details class="apf-details">
          <summary class="apf-summary">Your contact (optional)</summary>
          <div class="apf-details__body">
            <input id="apfName" class="apf-input" type="text" placeholder="Your name" autocomplete="name"
              value="${esc(existing && existing.name || "")}">
            <input id="apfPhone" class="apf-input" type="tel" placeholder="Phone (e.g. +255…)" autocomplete="tel"
              value="${esc(existing && existing.phone || "")}">
          </div>
        </details>

        <div id="apfMsg" class="apf-msg" role="alert" aria-live="polite"></div>
        <button id="apfSave" class="apf-save" type="button">Save &amp; continue</button>
      </div>`;
    return wrap;
  }

  // Show the modal and resolve with the saved profile (never rejects — on a
  // hard failure it resolves null so the dashboard still loads).
  function collect(sb, uid, existing, regions) {
    return new Promise((resolve) => {
      const modal = buildModal(existing, regions);
      document.body.appendChild(modal);
      // Lock the page behind the sheet so only the sheet scrolls (native feel).
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      const closeModal = () => { document.body.style.overflow = prevOverflow; modal.remove(); };
      // Next frame: flip to .is-in so the backdrop fades and the sheet springs up.
      requestAnimationFrame(() => modal.classList.add("is-in"));
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
          `<div class="apf-row apf-reg" data-r="${esc(r)}">${esc(r)}</div>`
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
        msgEl.className = "apf-msg" + (t ? (ok ? " is-ok" : " is-err") : "");
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
            `<div class="apf-row apf-sug" data-i="${i}">
               <strong>${esc(h.name)}</strong><span class="apf-tag">${esc(h.tag || "")}</span>
               ${h.context ? `<div class="apf-ctx">${esc(h.context)}</div>` : ""}
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
          closeModal();
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
