// Truck detail page — loads one truck from DataStore.getTrucks() (DB or JSON
// fallback) by ?id=, renders the gallery, specs, what comes with it, the
// description, owner contact (call / WhatsApp) and a mini-map of where the
// truck is based. Mirrors service.js.
//
// EVERY VISIBLE STRING GOES THROUGH T(). This file used to be written in
// English and nowhere else: a Swahili customer met "Truck type", "Capacity",
// "Driver", "Loaders" and "Contact the owner" in English on the one screen
// where they decide whether to ring somebody. The scan in
// tests/i18n_coverage.mjs never looked here, and even now it can only reach the
// "not found" state, because a detail sheet with no listing on it shows none of
// these strings and would report clean either way. tests/detail_sheet_i18n_test.mjs
// is the one that renders a real sheet.
//
// The truck-type words are NOT kept here. js/lib/listing-kinds.js is the one
// place a stored kind becomes a word a person reads, and it already knows that
// trucks.truck_type is free text: a kind nobody recognises is title-cased and
// shown as typed rather than flattened to "Other".

(function () {
  "use strict";

  // t() with a hard fallback: a missing key must show the English word rather
  // than the key name.
  const T = (k, en) => {
    const v = window.t ? window.t(k) : k;
    return v === k && en != null ? en : v;
  };
  const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

  // How far the truck goes, said about the owner rather than by them.
  const COVERAGE = {
    within_city: "of_cov_city", region_wide: "of_cov_region", cross_region: "of_cov_cross",
  };
  const NOTHING = "—";     // an em dash on its own: nobody said

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function photoUrls(t) {
    const arr = (Array.isArray(t.photos) && t.photos.length ? t.photos : [t.photo]).filter(Boolean);
    return arr.map((p) => window.DataStore.truckPhotoUrl(p)).filter(Boolean);
  }
  function typeLabel(tt) {
    return (window.ListingKinds && window.ListingKinds.label("trucks", tt)) || T("td_truck");
  }
  function coverage(a) { return COVERAGE[a] ? T(COVERAGE[a]) : NOTHING; }

  /**
   * What the owner said comes with the truck.
   *
   * The listing form (agent-trucks.html) writes these into trucks.details as a
   * list of catalogue keys and free text, indistinguishable on purpose.
   * js/lib/offer-spec.js turns both into the words a customer reads, in their
   * own language for the catalogue half and exactly as typed for the rest.
   *
   * Nothing is drawn when nothing was said: an empty panel headed "what comes
   * with it" reads as "nothing", which is not what a blank field means.
   */
  function kitPanel(t) {
    const spec = window.TruckSpec;
    const raw = t && t.details && Array.isArray(t.details.kit) ? t.details.kit : [];
    if (!spec || !raw.length) return "";
    const labels = spec.labels(raw);
    if (!labels.length) return "";
    return `<div class="td-panel"><p class="td-h">${esc(T("of_kit_h"))}</p>
      <ul class="of-list">${labels.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>`;
  }

  // The separator before "negotiable" is joined to it by a
  // non-breaking space (\u00a0), so a price that wraps never leaves a
  // dangling · at the end of the line.
  function formatPrice(t) {
    const p = t.price_tzs || 0;
    let v;
    if (p >= 1_000_000) v = (p / 1_000_000).toFixed(p % 1_000_000 === 0 ? 0 : 1) + "M";
    else if (p >= 1_000) v = (p / 1_000).toFixed(0) + "k";
    else v = String(p);
    return `${esc(T("of_from"))} TZS ${v} <small>/ ${esc(T("of_unit_trip"))}` +
      `${t.negotiable ? " ·\u00a0" + esc(T("of_negotiable")) : ""}</small>`;
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
      bodyEl.innerHTML =
        `<div class="td-missing"><h2>${esc(T("td_missing_h"))}</h2>` +
        `<p>${esc(T("td_missing_p"))} ` +
        `<a href="trucks.html">${esc(T("td_missing_cta"))}</a></p></div>`;
      return;
    }

    const name = t.title || T("td_truck");
    document.title = `${name} · Pawa`;
    const imgs = photoUrls(t);
    const cover = imgs[0] || "";
    const phone = (t.owner && t.owner.phone) || "";
    const wa = (t.owner && (t.owner.whatsapp || t.owner.phone)) || "";
    const loc = [t.area, t.region].filter(Boolean).join(", ");
    const waText = encodeURIComponent(fill(T("td_wa_text"), { title: name }));

    const specs = [
      [T("td_k_type"), typeLabel(t.truck_type)],
      [T("td_k_capacity"), t.capacity_tonnes
        ? fill(T("td_tonnes"), { n: t.capacity_tonnes }) : NOTHING],
      [T("td_k_coverage"), coverage(t.service_area)],
      [T("td_k_driver"), T(t.driver_included ? "td_driver_yes" : "td_driver_no")],
      [T("td_k_loaders"), T(t.loaders_included ? "td_loaders_yes" : "td_loaders_no")],
      [T("td_k_based"), loc || t.region || NOTHING],
    ];

    bodyEl.removeAttribute("aria-busy");
    bodyEl.innerHTML = `
      <div class="td-grid">
        <div>
          <div class="td-gallery-main" id="tdMain" style="${cover ? `background-image:url('${esc(cover)}')` : ""}"></div>
          ${imgs.length > 1 ? `<div class="td-thumbs">${imgs.map((u, i) =>
            `<div class="td-thumb ${i === 0 ? "active" : ""}" data-url="${esc(u)}" style="background-image:url('${esc(u)}')"></div>`).join("")}</div>` : ""}

          <div class="td-panel" style="margin-top:14px">
            <p class="td-h">${esc(T("td_h_details"))}</p>
            <div class="td-specs">
              ${specs.map(([k, v]) => `<div class="td-spec"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("")}
            </div>
          </div>

          ${kitPanel(t)}

          ${t.description ? `<div class="td-panel"><p class="td-h">${esc(T("td_h_about"))}</p><div class="td-desc">${esc(t.description)}</div></div>` : ""}
        </div>

        <div>
          <div class="td-panel">
            <div class="td-price">${formatPrice(t)}</div>
            <div class="td-title">${esc(name)}</div>
            <div class="td-loc">${esc(loc || t.region || T("of_tanzania"))}</div>
            <div class="td-badges">
              <span class="td-badge">${esc(typeLabel(t.truck_type))}</span>
              ${t.capacity_tonnes ? `<span class="td-badge">${esc(fill(T("td_t_short"), { n: t.capacity_tonnes }))}</span>` : ""}
              ${t.driver_included ? `<span class="td-badge">${esc(T("td_k_driver"))}</span>` : ""}
              ${t.loaders_included ? `<span class="td-badge">${esc(T("td_k_loaders"))}</span>` : ""}
              ${t.verified ? `<span class="td-badge verified">${esc(T("of_verified"))}</span>` : ""}
            </div>
          </div>

          <div class="td-panel">
            <p class="td-h">${esc(T("td_h_contact"))}</p>
            <div class="td-owner">${esc((t.owner && t.owner.name) || T("td_owner"))}</div>
            <div class="td-cta">
              ${window.PMReach ? window.PMReach.button(t, { className: "td-cta-msg" }) : ""}
              ${phone ? `<a class="td-cta-call" href="tel:${esc(cleanPhone(phone))}">${esc(T("of_call"))} ${esc(phone)}</a>` : ""}
              ${wa ? `<a class="td-cta-wa" href="https://wa.me/${esc(waNumber(wa))}?text=${waText}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
              <a class="td-cta-move" href="meet.html" target="_blank" rel="noopener">${esc(T("td_share_loc"))}</a>
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
        bodyEl.querySelectorAll(".td-thumb").forEach((x) => x.classList.remove("active"));
        el.classList.add("active");
      });
    });

    // Mini-map
    const mapEl = document.getElementById("tdMap");
    if (mapEl && window.L) {
      const m = L.map(mapEl, { scrollWheelZoom: false }).setView([+t.lat, +t.lng], 13);
      window.addSatelliteHybrid(m);
      L.marker([+t.lat, +t.lng]).addTo(m).bindPopup(esc(name));
      setTimeout(() => m.invalidateSize(), 80);
    }
  }

  window.initTruckPage = init;
})();
