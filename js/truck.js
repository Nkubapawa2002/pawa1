// Truck detail page — loads one truck from DataStore.getTrucks() (DB or JSON
// fallback) by ?id=, renders the gallery, specs, description, owner contact
// (call / WhatsApp) and a mini-map of where the truck is based.

(function () {
  "use strict";

  const TYPE_LABEL = {
    pickup: "Pickup", canter: "Canter", "3ton": "3-tonne",
    "7ton": "7-tonne lorry", "10ton_plus": "10-tonne+ lorry", other: "Truck",
  };
  const SERVICE_LABEL = {
    within_city: "Within city only", region_wide: "Region-wide", cross_region: "Cross-region",
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function photoUrls(t) {
    const arr = (Array.isArray(t.photos) && t.photos.length ? t.photos : [t.photo]).filter(Boolean);
    return arr.map((p) => window.DataStore.truckPhotoUrl(p)).filter(Boolean);
  }
  function formatPrice(t) {
    const p = t.price_tzs || 0;
    let v;
    if (p >= 1_000_000) v = (p / 1_000_000).toFixed(p % 1_000_000 === 0 ? 0 : 1) + "M";
    else if (p >= 1_000) v = (p / 1_000).toFixed(0) + "k";
    else v = String(p);
    return `from TZS ${v} <small>/ ${esc(t.period || "trip")}${t.negotiable ? " · negotiable" : ""}</small>`;
  }
  function cleanPhone(p) { return String(p || "").replace(/[^\d+]/g, ""); }
  function waNumber(p) { return String(p || "").replace(/[^\d]/g, ""); }

  async function init() {
    const bodyEl = document.getElementById("tdBody");
    const id = new URLSearchParams(location.search).get("id");
    let t = null;
    try {
      const all = await window.DataStore.getTrucks();
      t = all.find((x) => String(x.id) === String(id));
    } catch (e) { console.warn("[truck] load failed", e); }

    if (!t) {
      bodyEl.removeAttribute("aria-busy");
      bodyEl.innerHTML = `<div class="td-missing"><h2>Truck not found</h2><p>It may have been removed. <a href="trucks.html">Browse all trucks →</a></p></div>`;
      return;
    }

    document.title = `${t.title || "Moving truck"} — Pawa`;
    const imgs = photoUrls(t);
    const cover = imgs[0] || "";
    const phone = (t.owner && t.owner.phone) || "";
    const wa = (t.owner && (t.owner.whatsapp || t.owner.phone)) || "";
    const loc = [t.area, t.region].filter(Boolean).join(", ");
    const waText = encodeURIComponent(`Hi, I saw your truck "${t.title || "moving truck"}" on Pawa. Is it available to help me move?`);

    const specs = [
      ["Truck type", TYPE_LABEL[t.truck_type] || "Truck"],
      ["Capacity", t.capacity_tonnes ? `${t.capacity_tonnes} tonnes` : "—"],
      ["Coverage", SERVICE_LABEL[t.service_area] || "—"],
      ["Driver", t.driver_included ? "Included" : "Not included"],
      ["Loaders", t.loaders_included ? "Included" : "On request"],
      ["Based in", loc || t.region || "—"],
    ];

    bodyEl.removeAttribute("aria-busy");
    bodyEl.innerHTML = `
      <div class="td-grid">
        <div>
          <div class="td-gallery-main" id="tdMain" style="${cover ? `background-image:url('${esc(cover)}')` : ""}">${cover ? "" : "🚚"}</div>
          ${imgs.length > 1 ? `<div class="td-thumbs">${imgs.map((u, i) =>
            `<div class="td-thumb ${i === 0 ? "active" : ""}" data-url="${esc(u)}" style="background-image:url('${esc(u)}')"></div>`).join("")}</div>` : ""}

          <div class="td-panel" style="margin-top:14px">
            <p class="td-h">Truck details</p>
            <div class="td-specs">
              ${specs.map(([k, v]) => `<div class="td-spec"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("")}
            </div>
          </div>

          ${t.description ? `<div class="td-panel"><p class="td-h">About this truck</p><div class="td-desc">${esc(t.description)}</div></div>` : ""}
        </div>

        <div>
          <div class="td-panel">
            <div class="td-price">${formatPrice(t)}</div>
            <div class="td-title">${esc(t.title || "Moving truck")}</div>
            <div class="td-loc">📍 ${esc(loc || t.region || "Tanzania")}</div>
            <div class="td-badges">
              <span class="td-badge">${esc(TYPE_LABEL[t.truck_type] || "Truck")}</span>
              ${t.capacity_tonnes ? `<span class="td-badge">${esc(t.capacity_tonnes)}t</span>` : ""}
              ${t.driver_included ? `<span class="td-badge">Driver</span>` : ""}
              ${t.loaders_included ? `<span class="td-badge">Loaders</span>` : ""}
              ${t.verified ? `<span class="td-badge verified">✓ Verified</span>` : ""}
            </div>
          </div>

          <div class="td-panel">
            <p class="td-h">Contact the owner</p>
            <div class="td-owner">${esc((t.owner && t.owner.name) || "Truck owner")}</div>
            <div class="td-cta">
              ${phone ? `<a class="td-cta-call" href="tel:${esc(cleanPhone(phone))}">📞 Call ${esc(phone)}</a>` : ""}
              ${wa ? `<a class="td-cta-wa" href="https://wa.me/${esc(waNumber(wa))}?text=${waText}" target="_blank" rel="noopener">💬 WhatsApp</a>` : ""}
              <a class="td-cta-move" href="meet.html" target="_blank" rel="noopener">📍 Share live location for pickup</a>
            </div>
            ${(Number.isFinite(+t.lat) && Number.isFinite(+t.lng)) ? `<div class="td-minimap" id="tdMap"></div>` : ""}
          </div>
        </div>
      </div>`;

    // Thumbnail switching
    bodyEl.querySelectorAll(".td-thumb").forEach((el) => {
      el.addEventListener("click", () => {
        const main = document.getElementById("tdMain");
        main.style.backgroundImage = `url('${el.dataset.url}')`;
        main.textContent = "";
        bodyEl.querySelectorAll(".td-thumb").forEach((x) => x.classList.remove("active"));
        el.classList.add("active");
      });
    });

    // Mini-map
    const mapEl = document.getElementById("tdMap");
    if (mapEl && window.L) {
      const m = L.map(mapEl, { scrollWheelZoom: false }).setView([+t.lat, +t.lng], 13);
      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        maxZoom: 19, attribution: "&copy; OpenStreetMap &copy; CARTO",
      }).addTo(m);
      L.marker([+t.lat, +t.lng]).addTo(m).bindPopup(esc(t.title || "Moving truck"));
      setTimeout(() => m.invalidateSize(), 80);
    }
  }

  window.initTruckPage = init;
})();
