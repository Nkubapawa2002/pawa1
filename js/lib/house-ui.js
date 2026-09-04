// ============================================================================
//  house-ui.js — the property screen's presentation primitives.
//
//  Escaping, the icon set, the label dictionaries, the money/date/price
//  formatters, the favourites store, the empty states, and the two distance
//  helpers. Everything here is small, pure and used by more than one of the
//  three files that draw this screen, which is the only reason it is its own
//  file: js/pages/house.js had grown to 1,900 lines and every one of these was
//  buried in it.
//
//  LOAD FIRST. js/lib/house-place.js builds its category table at parse time
//  and calls ico() while doing so, so this has to have run already.
//
//  Globals published (deliberately, this codebase is plain <script> tags, no
//  modules): esc, ico, ICO, stateHtml, emptyState, formatPrice, formatDate,
//  labelType, labelAmenity, amenityIcon, costIcon, roomCodeFor, getFavs,
//  haversineMetersHd, fmtMetersHd.
// ============================================================================

// ============================================================================
// Icons — Lucide-style strokes at a consistent 1.8 weight. No emoji anywhere
// in this page's chrome: the brand's icon language is line SVG, and an emoji
// renders differently on every phone in the country.
// ============================================================================
function ico(d, size) {
  return `<svg width="${size || 17}" height="${size || 17}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true"><path d="${d}"/></svg>`;
}
const ICO = {
  pin:      "M12 21s-7-5.5-7-10.5A7 7 0 0 1 19 10.5C19 15.5 12 21 12 21zM12 11h.01",
  door:     "M3 21h18M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M14.5 12h.01",
  text:     "M4 6h16M4 12h16M4 18h10",
  shield:   "M12 3l8 3v6c0 5-3.4 8.2-8 9-4.6-.8-8-4-8-9V6zM9 12l2 2 4-4",
  receipt:  "M6 2h12v20l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  sparkle:  "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  map:      "M9 3 3 6v15l6-3 6 3 6-3V3l-6 3zM9 3v15M15 6v15",
  compass:  "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5z",
  user:     "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  chevron:  "M6 9l6 6 6-6",
  check:    "M20 6 9 17l-5-5",
  phone:    "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z",
  chat:     "M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z",
  video:    "M23 7l-7 5 7 5zM1 5h15v14H1z",
  route:    "M9 20l-5.4 1.8L5.4 16 3 4l9 4 9-4-1.2 6",
  nav:      "M3 11l19-9-9 19-2-8z",
  bolt:     "M13 2 3 14h9l-1 8 10-12h-9z",
  drop:     "M12 22a7 7 0 0 0 7-7c0-4-7-13-7-13S5 11 5 15a7 7 0 0 0 7 7z",
  wifi:     "M5 12.5a10 10 0 0 1 14 0M8.5 16a5.5 5.5 0 0 1 7 0M12 20h.01M2 9a15 15 0 0 1 20 0",
  trash:    "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6",
  lock:     "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  car:      "M5 17H3v-5l2-5h14l2 5v5h-2M5 17a2 2 0 1 0 4 0M15 17a2 2 0 1 0 4 0M5 17h10M3 12h18",
  tv:       "M2 7h20v12H2zM8 3l4 4 4-4",
  tool:     "M14.7 6.3a4 4 0 0 1-5 5L4 17v3h3l5.7-5.7a4 4 0 0 0 5-5l-2 2-2.6-.7-.7-2.6z",
  building: "M3 21h18M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M15 9h2a2 2 0 0 1 2 2v10M9 7h2M9 11h2M9 15h2",
  tree:     "M12 22v-6M12 16l-4-4h8zM12 12 8 8h8z",
  cross:    "M12 3v6M9 6h6M6 21h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2z",
  cart:     "M2 3h3l2.7 12.4a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L21 7H6M9 21h.01M18 21h.01",
  bus:      "M6 18v2M18 18v2M4 15h16M5 18h14a1 1 0 0 0 1-1V6a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v11a1 1 0 0 0 1 1zM8 18h8",
  bank:     "M3 10h18L12 3zM5 10v8M10 10v8M14 10v8M19 10v8M3 21h18",
  fork:     "M7 3v8a2 2 0 0 0 4 0V3M9 11v10M17 3c-1.5 2-2 4-2 6v3h3V3z",
  pray:     "M12 2v6M9 5h6M6 22V11l6-4 6 4v11zM10 22v-5h4v5",
  fuel:     "M3 21h11V3H3zM7 8h3M14 8h3a2 2 0 0 1 2 2v7a1.5 1.5 0 0 0 3 0V9l-3-3",
  park:     "M12 22a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 17V7h3.5a3 3 0 0 1 0 6H9",
};

function haversineMetersHd(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}
function fmtMetersHd(m) { return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`; }

function stateHtml(title, body) {
  return `<div class="hd-state"><h3>${esc(title)}</h3><p>${body}</p></div>`;
}

function emptyState({ title, sub, ctaHref, ctaLabel, danger = false }) {
  const art = danger
    ? `<div class="hp-empty__art" style="background:var(--c-danger-soft,#fce4e4);color:var(--c-danger,#b91c1c);box-shadow:inset 0 0 0 1px rgba(185,28,28,.18)">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><circle cx="12" cy="16" r="1"/>
         </svg>
       </div>`
    : `<div class="hp-empty__art" aria-hidden="true">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
           <path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>
         </svg>
       </div>`;
  return `<div class="hp-empty" role="${danger ? 'alert' : 'status'}">
    ${art}
    <div class="hp-empty__title">${esc(title)}</div>
    <div class="hp-empty__sub">${sub}</div>
    ${ctaHref ? `<a class="hp-empty__cta" href="${ctaHref}">${esc(ctaLabel)}</a>` : ""}
  </div>`;
}

function formatPrice(h) {
  const p = h.price_tzs || 0;
  let value;
  if (p >= 1_000_000_000) value = (p / 1_000_000_000).toFixed(2) + "B";
  else if (p >= 1_000_000) value = (p / 1_000_000).toFixed(p % 1_000_000 === 0 ? 0 : 1) + "M";
  else if (p >= 1_000)     value = (p / 1_000).toFixed(0) + "k";
  else value = String(p);
  const unit = h.listing === "sale" ? "TZS" : `TZS / ${h.period || "month"}`;
  return { value, unit };
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  } catch { return iso; }
}

// t() with the English word as its own last resort, because t() hands back the
// KEY when there is no entry and a screen reading "ah_am_parking" is worse than
// one reading "Parking".
//
// Published under T as well, because js/pages/house.js and
// js/lib/house-sections.js both need it and both are plain scripts sharing one
// global scope: two `const fillT` there is a SyntaxError that takes the whole
// page down, and two `function T` is worse, because it is legal and the second
// one silently wins. house-ui.js loads before both, which is why it lives here.
function tr(key, en) {
  if (window.t) {
    var got = window.t(key);
    if (got && got !== key) return got;
  }
  return en;
}
var T = tr;
/** "{n} months" with the numbers put where the sentence wants them. */
function fillT(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, function (m, k) {
    return (k in vars) ? vars[k] : m;
  });
}

/**
 * The kind of property, as a word.
 *
 * This used to be a fourth private copy of the map in js/lib/listing-kinds.js,
 * whose whole reason for existing is that three page scripts each carrying
 * their own is how one screen says "Shop / business" while another says "shop".
 * It also means houses.type gets its Swahili here for the first time, and that
 * a kind an agent typed themselves is title-cased and shown AS TYPED rather
 * than flattened to "Property".
 */
function labelType(t) {
  if (window.ListingKinds) {
    var w = window.ListingKinds.label("houses", t);
    if (w) return w;
  }
  return t || tr("hd_property", "Property");
}

/**
 * An amenity, as a word.
 *
 * The keys are the ones agent-houses.html writes, and the strings it offers
 * them under are already in js/core/i18n.js as ah_am_*. Reading those means the
 * chip a landlord ticked and the chip a tenant reads are the same string in
 * both languages, rather than two lists that drift.
 */
var AMENITY_I18N = {
  parking: "ah_am_parking",
  security: "ah_am_security",
  water_tank: "ah_am_water_tank",
  borehole: "ah_am_borehole",
  generator: "ah_am_generator",
  wifi: "ah_am_wifi",
  pool: "ah_am_pool",
  gym: "ah_am_gym",
  garden: "ah_am_garden",
  elevator: "ah_am_elevator",
  water_connection: "ah_am_water_conn",
  electricity_connection: "ah_am_elec_conn",
};
var AMENITY_EN = {
  parking: "Parking", security: "Security", water_tank: "Water tank",
  borehole: "Borehole", generator: "Generator", wifi: "Wi-Fi",
  pool: "Swimming pool", gym: "Gym", garden: "Garden", elevator: "Elevator",
  water_connection: "Water (utility)", electricity_connection: "Electricity (utility)",
};

function labelAmenity(k) {
  // An agent can add any amenity they like on the listing form, and a custom
  // one arrives here as the words they typed. Those are shown as written.
  if (!AMENITY_I18N[k]) return String(k || "").replace(/_/g, " ");
  return tr(AMENITY_I18N[k], AMENITY_EN[k]);
}

// Line icons for the amenity chips. The map used to hold emoji, which had all
// been stripped to empty strings at some point — so every chip rendered a
// leading space and no icon at all. Line SVGs also render the same on every
// phone in the country, which an emoji does not.
function amenityIcon(k) {
  const d = ({
    parking:                ICO.car,
    security:               ICO.lock,
    water_tank:             ICO.drop,
    borehole:               ICO.drop,
    generator:              ICO.bolt,
    wifi:                   ICO.wifi,
    pool:                   ICO.drop,
    gym:                    ICO.sparkle,
    garden:                 ICO.tree,
    elevator:               ICO.building,
    water_connection:       ICO.drop,
    electricity_connection: ICO.bolt,
  })[k] || ICO.check;
  return ico(d, 15);
}

// Pick an icon for an additional-cost line by matching keywords in its label,
// in both languages — an agent types "Umeme" as readily as "Electricity".
function costIcon(label) {
  const s = String(label || "").toLowerCase();
  let d = ICO.receipt;
  if (/electric|umeme|luku|power/.test(s))              d = ICO.bolt;
  else if (/water|maji/.test(s))                        d = ICO.drop;
  else if (/garbage|waste|taka|rubbish|trash/.test(s))  d = ICO.trash;
  else if (/secur|usalama|guard|askari/.test(s))        d = ICO.lock;
  else if (/internet|wifi|wi-fi|data/.test(s))          d = ICO.wifi;
  else if (/gas/.test(s))                               d = ICO.bolt;
  else if (/service|maintenance|matengenezo/.test(s))   d = ICO.tool;
  else if (/park/.test(s))                              d = ICO.car;
  else if (/cable|tv|dstv|startimes/.test(s))           d = ICO.tv;
  return ico(d, 16);
}

// Stable 6-character room code derived from the listing id — same listing
// always yields the same code so multiple buyers + agent land in one room.
function roomCodeFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) { code += chars[h % chars.length]; h = Math.floor(h / chars.length) + 17; }
  return code;
}

function getFavs() {
  try { return new Set(JSON.parse(localStorage.getItem("pawa_house_favs") || "[]")); }
  catch { return new Set(); }
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
