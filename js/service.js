// Service detail page — loads one provider from DataStore.getServices() (DB or
// JSON fallback) by ?id=, renders the gallery, specs, description, provider
// contact (call / WhatsApp) and a mini-map of where they're based. Mirrors
// truck.js.

(function () {
  "use strict";

  const CATEGORY = {
    cleaning: "Cleaning", plumbing: "Plumbing", electrical: "Electrical",
    carpentry: "Carpentry", painting: "Painting", gardening: "Gardening",
    moving_help: "Moving help", laundry: "Laundry", cooking: "Cooking / Chef",
    tutoring: "Tutoring", beauty: "Beauty & Salon", security: "Security",
    childcare: "Childcare", appliance_repair: "Appliance repair", other: "Other",
  };
  const EMOJI = {
    cleaning: "", plumbing: "", electrical: "", carpentry: "", painting: "",
    gardening: "", moving_help: "", laundry: "", cooking: "", tutoring: "",
    beauty: "", security: "", childcare: "", appliance_repair: "", other: "",
  };
  const RATE_UNIT = { hourly: "hr", daily: "day", per_job: "job", monthly: "month" };
  const SERVICE_LABEL = { within_city: "Within city only", region_wide: "Region-wide", cross_region: "Cross-region" };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function photoUrls(s) {
    const arr = (Array.isArray(s.photos) && s.photos.length ? s.photos : [s.photo]).filter(Boolean);
    return arr.map((p) => window.DataStore.servicePhotoUrl(p)).filter(Boolean);
  }
  function formatPrice(s) {
    const p = s.price_tzs || 0;
    let v;
    if (p >= 1_000_000) v = (p / 1_000_000).toFixed(p % 1_000_000 === 0 ? 0 : 1) + "M";
    else if (p >= 1_000) v = (p / 1_000).toFixed(0) + "k";
    else v = String(p);
    return `from TZS ${v} <small>/ ${esc(RATE_UNIT[s.rate_type] || "job")}${s.negotiable ? " · negotiable" : ""}</small>`;
  }
  function cleanPhone(p) { return String(p || "").replace(/[^\d+]/g, ""); }
  function waNumber(p) { return String(p || "").replace(/[^\d]/g, ""); }
  function catLabel(c) { return CATEGORY[c] || "Service"; }
  function catEmoji(c) { return EMOJI[c] || ""; }

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
      bodyEl.innerHTML = `<div class="sd-missing"><h2>Service not found</h2><p>It may have been removed. <a href="services.html">Browse all services →</a></p></div>`;
      return;
    }

    document.title = `${s.title || catLabel(s.category)} — Pawa`;
    const imgs = photoUrls(s);
    const cover = imgs[0] || "";
    const phone = (s.owner && s.owner.phone) || "";
    const wa = (s.owner && (s.owner.whatsapp || s.owner.phone)) || "";
    const loc = [s.area, s.region].filter(Boolean).join(", ");
    const waText = encodeURIComponent(`Hi, I saw your "${s.title || catLabel(s.category)}" service on Pawa. Are you available?`);

    const specs = [
      ["Category", catLabel(s.category)],
      ["Rate", s.price_tzs ? `from TZS ${Number(s.price_tzs).toLocaleString()} / ${RATE_UNIT[s.rate_type] || "job"}` : "—"],
      ["Experience", s.experience_years ? `${s.experience_years} years` : "—"],
      ["Availability", s.availability || "—"],
      ["Coverage", SERVICE_LABEL[s.service_area] || "—"],
      ["Based in", loc || s.region || "—"],
    ];

    bodyEl.removeAttribute("aria-busy");
    bodyEl.innerHTML = `
      <div class="sd-grid">
        <div>
          <div class="sd-gallery-main" id="sdMain" style="${cover ? `background-image:url('${esc(cover)}')` : ""}">${cover ? "" : catEmoji(s.category)}</div>
          ${imgs.length > 1 ? `<div class="sd-thumbs">${imgs.map((u, i) =>
            `<div class="sd-thumb ${i === 0 ? "active" : ""}" data-url="${esc(u)}" style="background-image:url('${esc(u)}')"></div>`).join("")}</div>` : ""}

          <div class="sd-panel" style="margin-top:14px">
            <p class="sd-h">Service details</p>
            <div class="sd-specs">
              ${specs.map(([k, v]) => `<div class="sd-spec"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("")}
            </div>
          </div>

          ${s.description ? `<div class="sd-panel"><p class="sd-h">About this service</p><div class="sd-desc">${esc(s.description)}</div></div>` : ""}
        </div>

        <div>
          <div class="sd-panel">
            <div class="sd-price">${formatPrice(s)}</div>
            <div class="sd-title">${esc(s.title || catLabel(s.category))}</div>
            <div class="sd-loc"> ${esc(loc || s.region || "Tanzania")}</div>
            <div class="sd-badges">
              <span class="sd-badge">${catEmoji(s.category)} ${esc(catLabel(s.category))}</span>
              ${s.experience_years ? `<span class="sd-badge">${esc(s.experience_years)} yrs</span>` : ""}
              ${s.verified ? `<span class="sd-badge verified"> Verified</span>` : ""}
            </div>
          </div>

          <div class="sd-panel">
            <p class="sd-h">Contact the provider</p>
            <div class="sd-owner">${esc((s.owner && s.owner.name) || "Service provider")}</div>
            <div class="sd-cta">
              ${phone ? `<a class="sd-cta-call" href="tel:${esc(cleanPhone(phone))}"> Call ${esc(phone)}</a>` : ""}
              ${wa ? `<a class="sd-cta-wa" href="https://wa.me/${esc(waNumber(wa))}?text=${waText}" target="_blank" rel="noopener"> WhatsApp</a>` : ""}
              <a class="sd-cta-move" href="meet.html" target="_blank" rel="noopener"> Share live location</a>
            </div>
            ${(Number.isFinite(+s.lat) && Number.isFinite(+s.lng)) ? `<div class="sd-minimap" id="sdMap"></div>` : ""}
          </div>
        </div>
      </div>`;

    bodyEl.querySelectorAll(".sd-thumb").forEach((el) => {
      el.addEventListener("click", () => {
        const main = document.getElementById("sdMain");
        main.style.backgroundImage = `url('${el.dataset.url}')`;
        main.textContent = "";
        bodyEl.querySelectorAll(".sd-thumb").forEach((x) => x.classList.remove("active"));
        el.classList.add("active");
      });
    });

    const mapEl = document.getElementById("sdMap");
    if (mapEl && window.L) {
      const m = L.map(mapEl, { scrollWheelZoom: false }).setView([+s.lat, +s.lng], 13);
      window.addSatelliteHybrid(m);
      L.marker([+s.lat, +s.lng]).addTo(m).bindPopup(esc(s.title || catLabel(s.category)));
      setTimeout(() => m.invalidateSize(), 80);
    }
  }

  window.initServicePage = init;
})();
