// Service detail page — loads one provider from DataStore.getServices() (DB or
// JSON fallback) by ?id=, renders the gallery, specs, what the job comes with,
// the description, provider contact (call / WhatsApp) and a mini-map of where
// they are based. Mirrors truck.js.
//
// EVERY VISIBLE STRING GOES THROUGH T(). This file used to be written in
// English and nowhere else: a Swahili customer met "Category", "Rate",
// "Experience", "About this service" and "Contact the provider" in English on
// the one screen where they decide whether to ring somebody. The scan in
// tests/i18n_coverage.mjs never looked here, and even now it can only reach the
// "not found" state, because a detail sheet with no listing on it shows none of
// these strings and would report clean either way. tests/detail_sheet_i18n_test.mjs
// is the one that renders a real sheet.
//
// The category words are NOT kept here. js/lib/listing-kinds.js is the one
// place a stored kind becomes a word a person reads; three page scripts each
// carrying their own copy of that map is how one screen ends up saying
// "7-tonne lorry" while another says "7ton".

(function () {
  "use strict";

  // t() with a hard fallback: a missing key must show the English word rather
  // than the key name.
  const T = (k, en) => {
    const v = window.t ? window.t(k) : k;
    return v === k && en != null ? en : v;
  };
  const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

  // The unit after the slash in a price. Short on purpose: it sits inside
  // "from TZS 25k / job", where a whole phrase would swamp the figure.
  const RATE_UNIT = {
    hourly: "of_unit_hr", daily: "of_unit_day",
    per_job: "of_unit_job", monthly: "of_unit_month",
  };
  // How far the provider travels, said about them rather than by them: the
  // listing form asks "how far do YOU go", this sheet answers "how far THEY go".
  const COVERAGE = {
    within_city: "of_cov_city", region_wide: "of_cov_region", cross_region: "of_cov_cross",
  };
  const NOTHING = "—";     // an em dash on its own: nobody said

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function photoUrls(s) {
    const arr = (Array.isArray(s.photos) && s.photos.length ? s.photos : [s.photo]).filter(Boolean);
    return arr.map((p) => window.DataStore.servicePhotoUrl(p)).filter(Boolean);
  }
  function catLabel(c) {
    return (window.ListingKinds && window.ListingKinds.label("services", c)) || T("sd_service");
  }
  function rateUnit(r) { return T(RATE_UNIT[r] || "of_unit_job"); }
  function coverage(a) { return COVERAGE[a] ? T(COVERAGE[a]) : NOTHING; }

  /**
   * What the provider said the job comes with.
   *
   * The listing form (agent-services.html) writes these into services.details
   * as a list of catalogue keys and free text, indistinguishable on purpose.
   * js/lib/offer-spec.js turns both into the words a customer reads, in their
   * own language for the catalogue half and exactly as typed for the rest.
   *
   * Nothing is drawn when nothing was said: an empty panel headed "what you
   * get" reads as "nothing", which is not what a blank field means.
   */
  function includesPanel(s) {
    const spec = window.ServiceSpec;
    const raw = s && s.details && Array.isArray(s.details.includes) ? s.details.includes : [];
    if (!spec || !raw.length) return "";
    const labels = spec.labels(raw);
    if (!labels.length) return "";
    return `<div class="sd-panel"><p class="sd-h">${esc(T("of_includes_h"))}</p>
      <ul class="of-list">${labels.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>`;
  }

  // The separator before "negotiable" is joined to it by a
  // non-breaking space (\u00a0), so a price that wraps never leaves a
  // dangling · at the end of the line.
  function formatPrice(s) {
    const p = s.price_tzs || 0;
    let v;
    if (p >= 1_000_000) v = (p / 1_000_000).toFixed(p % 1_000_000 === 0 ? 0 : 1) + "M";
    else if (p >= 1_000) v = (p / 1_000).toFixed(0) + "k";
    else v = String(p);
    return `${esc(T("of_from"))} TZS ${v} <small>/ ${esc(rateUnit(s.rate_type))}` +
      `${s.negotiable ? " ·\u00a0" + esc(T("of_negotiable")) : ""}</small>`;
  }
  function cleanPhone(p) { return String(p || "").replace(/[^\d+]/g, ""); }
  function waNumber(p) { return String(p || "").replace(/[^\d]/g, ""); }

  async function init() {
    const bodyEl = document.getElementById("sdBody");
    const id = new URLSearchParams(location.search).get("id");
    let s = null;
    try {
      const all = await window.DataStore.getServices();
      s = all.find((x) => String(x.id) === String(id));
    } catch (e) { console.warn("[service] load failed", e); }

    if (!s) {
      bodyEl.removeAttribute("aria-busy");
      bodyEl.innerHTML =
        `<div class="sd-missing"><h2>${esc(T("sd_missing_h"))}</h2>` +
        `<p>${esc(T("sd_missing_p"))} ` +
        `<a href="services.html">${esc(T("sd_missing_cta"))}</a></p></div>`;
      return;
    }

    const name = s.title || catLabel(s.category);
    document.title = `${name} · Pawa`;
    const imgs = photoUrls(s);
    const cover = imgs[0] || "";
    const phone = (s.owner && s.owner.phone) || "";
    const wa = (s.owner && (s.owner.whatsapp || s.owner.phone)) || "";
    const loc = [s.area, s.region].filter(Boolean).join(", ");
    const waText = encodeURIComponent(fill(T("sd_wa_text"), { title: name }));

    const specs = [
      [T("sd_k_category"), catLabel(s.category)],
      [T("sd_k_rate"), s.price_tzs
        ? `${T("of_from")} TZS ${Number(s.price_tzs).toLocaleString()} / ${rateUnit(s.rate_type)}`
        : NOTHING],
      [T("sd_k_experience"), s.experience_years
        ? fill(T("sd_years"), { n: s.experience_years }) : NOTHING],
      [T("sd_k_availability"), s.availability || NOTHING],
      [T("sd_k_coverage"), coverage(s.service_area)],
      [T("sd_k_based"), loc || s.region || NOTHING],
    ];

    bodyEl.removeAttribute("aria-busy");
    bodyEl.innerHTML = `
      <div class="sd-grid">
        <div>
          <div class="sd-gallery-main" id="sdMain" style="${cover ? `background-image:url('${esc(cover)}')` : ""}"></div>
          ${imgs.length > 1 ? `<div class="sd-thumbs">${imgs.map((u, i) =>
            `<div class="sd-thumb ${i === 0 ? "active" : ""}" data-url="${esc(u)}" style="background-image:url('${esc(u)}')"></div>`).join("")}</div>` : ""}

          <div class="sd-panel" style="margin-top:14px">
            <p class="sd-h">${esc(T("sd_h_details"))}</p>
            <div class="sd-specs">
              ${specs.map(([k, v]) => `<div class="sd-spec"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("")}
            </div>
          </div>

          ${includesPanel(s)}

          ${s.description ? `<div class="sd-panel"><p class="sd-h">${esc(T("sd_h_about"))}</p><div class="sd-desc">${esc(s.description)}</div></div>` : ""}
        </div>

        <div>
          <div class="sd-panel">
            <div class="sd-price">${formatPrice(s)}</div>
            <div class="sd-title">${esc(name)}</div>
            <div class="sd-loc">${esc(loc || s.region || T("of_tanzania"))}</div>
            <div class="sd-badges">
              <span class="sd-badge">${esc(catLabel(s.category))}</span>
              ${s.experience_years ? `<span class="sd-badge">${esc(fill(T("sd_yrs"), { n: s.experience_years }))}</span>` : ""}
              ${s.verified ? `<span class="sd-badge verified">${esc(T("of_verified"))}</span>` : ""}
            </div>
          </div>

          <div class="sd-panel">
            <p class="sd-h">${esc(T("sd_h_contact"))}</p>
            <div class="sd-owner">${esc((s.owner && s.owner.name) || T("sd_owner"))}</div>
            <div class="sd-cta">
              ${window.PMReach ? window.PMReach.button(s, { className: "sd-cta-msg" }) : ""}
              ${phone ? `<a class="sd-cta-call" href="tel:${esc(cleanPhone(phone))}">${esc(T("of_call"))} ${esc(phone)}</a>` : ""}
              ${wa ? `<a class="sd-cta-wa" href="https://wa.me/${esc(waNumber(wa))}?text=${waText}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
              <a class="sd-cta-move" href="meet.html" target="_blank" rel="noopener">${esc(T("of_share_loc"))}</a>
            </div>
            ${(Number.isFinite(+s.lat) && Number.isFinite(+s.lng)) ? `<div class="sd-minimap" id="sdMap"></div>` : ""}
          </div>
        </div>
      </div>`;

    bodyEl.querySelectorAll(".sd-thumb").forEach((el) => {
      el.addEventListener("click", () => {
        const main = document.getElementById("sdMain");
        main.style.backgroundImage = `url('${el.dataset.url}')`;
        bodyEl.querySelectorAll(".sd-thumb").forEach((x) => x.classList.remove("active"));
        el.classList.add("active");
      });
    });

    const mapEl = document.getElementById("sdMap");
    if (mapEl && window.L) {
      const m = L.map(mapEl, { scrollWheelZoom: false }).setView([+s.lat, +s.lng], 13);
      window.addSatelliteHybrid(m);
      L.marker([+s.lat, +s.lng]).addTo(m).bindPopup(esc(name));
      setTimeout(() => m.invalidateSize(), 80);
    }
  }

  window.initServicePage = init;
})();
