// ============================================================================
//  house-area.js — "what's nearby": the services around one home.
//
//  Split out of js/pages/house.js because it answers a question of its own and
//  has two independent sources for the answer — see the block comment below,
//  which is the important part of this file.
//
//  Depends on: house-ui.js (esc, haversineMetersHd, fmtMetersHd),
//  house-place.js (poiLabel, POI_CACHE_TTL_MS) at call time.
// ============================================================================

// ============================================================================
// "What's nearby" — the services around THIS home, so a seeker understands the
// neighbourhood and not just the four walls.
//
// TWO SOURCES, AND THEY ARE NOT THE SAME CLAIM.
//
//   1. The listing's own `nearby` column. agent-houses.js surveys the area once,
//      when the listing is posted, and stores the result on the row. It is
//      already loaded — it arrived with the listing — so it paints instantly,
//      offline, and identically for every visitor.
//
//      This page used to ignore it completely and fire a fresh Overpass query
//      on every single view: a 1–18 second wait, a shared public API hit per
//      reader, and a card that said "Scanning the area…" while the answer sat
//      in memory.
//
//   2. A live OpenStreetMap scan, for a listing posted before the survey
//      existed or one whose survey came back empty.
//
// The card says which one it is reading. A stored survey is a snapshot from the
// day the listing went up; a live scan is today. Presenting them as one thing
// would let a two-week-old survey pass for a fresh measurement.
//
// Distances are straight-line and marked "~". The map markers give the exact
// road distance on tap.
// ============================================================================
const SUMMARY_RADIUS_M = 1500;

// The category keys agent-houses.js writes, in the order a tenant asks about
// them. Colours are tokens, resolved by the browser inside the page's palette.
const NEARBY_META = {
  schools:    { label: "Schools",             color: "var(--info)" },
  hospitals:  { label: "Hospitals & clinics", color: "var(--danger)" },
  pharmacies: { label: "Pharmacies",          color: "var(--text-err)" },
  markets:    { label: "Markets & shops",     color: "var(--warn)" },
  transport:  { label: "Transport",           color: "var(--green-bright)" },
  banks:      { label: "Banks & ATMs",        color: "var(--green-neon)" },
  worship:    { label: "Mosques & churches",  color: "var(--gold)" },
  food:       { label: "Restaurants & cafes", color: "var(--gold-warm)" },
  leisure:    { label: "Parks & leisure",     color: "var(--green-emerald)" },
  services:   { label: "Public services",     color: "var(--text-info)" },
};
const NEARBY_ORDER = [
  "schools", "hospitals", "pharmacies", "markets", "transport",
  "banks", "worship", "food", "leisure", "services",
];

// The same categories, expressed as OSM tag tests, for the live fallback.
const NEARBY_SUMMARY_GROUPS = [
  { key: "schools",   match: t => /^(school|kindergarten|college|university)$/.test(t.amenity || "") },
  { key: "hospitals", match: t => /^(hospital|clinic|doctors)$/.test(t.amenity || "") },
  { key: "pharmacies",match: t => t.amenity === "pharmacy" },
  { key: "markets",   match: t => t.amenity === "marketplace" || /^(supermarket|convenience|mall)$/.test(t.shop || "") },
  { key: "transport", match: t => t.highway === "bus_stop" || /^(bus_station|taxi)$/.test(t.amenity || "") || t.railway === "station" || !!t.public_transport },
  { key: "banks",     match: t => /^(bank|atm|bureau_de_change)$/.test(t.amenity || "") },
  { key: "worship",   match: t => t.amenity === "place_of_worship" },
];

async function renderNearbySummary(h) {
  const list = document.getElementById("hdNearbyList");
  if (!list) return;

  // 1. The survey that came with the listing. Free, instant, already here.
  const stored = storedNearby(h);
  if (stored.length) { paintNearby(list, stored, "stored"); return; }

  // 2. Nothing stored — scan, but only if we know where the place is.
  const lat = Number(h.lat), lng = Number(h.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    list.innerHTML = `<p class="hd-nearby-msg">This listing has no survey of its area, and no pin to scan around.</p>`;
    return;
  }

  list.innerHTML = `<p class="hd-nearby-msg">Scanning the area around this home…</p>`;
  let els;
  try { els = await fetchNearbySummary(lat, lng); }
  catch (_) {
    list.innerHTML = `<p class="hd-nearby-msg">Couldn't reach OpenStreetMap just now — the map above still shows where it is.</p>`;
    return;
  }

  const groups = NEARBY_SUMMARY_GROUPS.map(g => {
    const meta = NEARBY_META[g.key];
    const seen = new Set();
    const items = [];
    for (const el of els) {
      if (!g.match(el.tags || {})) continue;
      const p = el.center || { lat: el.lat, lon: el.lon };
      if (p.lat == null || p.lon == null) continue;
      const name = poiLabel(el, meta);
      const k = name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({ name, dist: haversineMetersHd(lat, lng, p.lat, p.lon) });
    }
    items.sort((a, b) => a.dist - b.dist);
    return { label: meta.label, color: meta.color, count: items.length, top: items.slice(0, 3) };
  }).filter(g => g.count > 0);

  if (!groups.length) {
    list.innerHTML = `<p class="hd-nearby-msg">No tagged services within ${SUMMARY_RADIUS_M / 1000} km on OpenStreetMap. That is a gap in the map, not necessarily in the neighbourhood.</p>`;
    return;
  }
  paintNearby(list, groups, "live");
}

/**
 * The survey stored on the listing row, read into the shape the card draws.
 *
 * Entries with no name are dropped rather than shown as "Unnamed": a nameless
 * point tells a reader nothing they can act on, and padding the count with them
 * makes a thin area look well served.
 */
function storedNearby(h) {
  const n = h && h.nearby;
  if (!n || typeof n !== "object") return [];
  return NEARBY_ORDER.map(key => {
    const g = n[key];
    if (!g || !Array.isArray(g.items)) return null;
    const items = g.items
      .filter(it => it && it.name)
      .map(it => ({ name: String(it.name), dist: Number(it.dist) }))
      .filter(it => Number.isFinite(it.dist))
      .sort((a, b) => a.dist - b.dist);
    if (!items.length) return null;
    const meta = NEARBY_META[key] || { label: key, color: "var(--text-muted)" };
    return {
      label: String(g.label || meta.label).trim() || meta.label,
      color: meta.color,
      count: items.length,
      top: items.slice(0, 3),
    };
  }).filter(Boolean);
}

function paintNearby(list, groups, source) {
  const cards = groups.map(g => `
    <div class="hd-nearby-cat">
      <div class="hd-nearby-cat-head">
        <span class="hd-nearby-dot" style="background:${g.color}"></span>
        <strong>${esc(g.label)}</strong>
        <span class="hd-nearby-count">${g.count}</span>
      </div>
      <ul class="hd-nearby-items">
        ${g.top.map(it => `<li>
          <span class="hd-nearby-name">${esc(it.name)}</span>
          <span class="hd-nearby-dist">~${fmtMetersHd(Math.round(it.dist))}</span>
        </li>`).join("")}
      </ul>
    </div>`).join("");

  const src = source === "stored"
    ? "Surveyed when this listing was posted, and saved with it. Straight-line distances."
    : `Scanned live from OpenStreetMap within ${SUMMARY_RADIUS_M / 1000} km. Straight-line distances.`;

  list.innerHTML = cards + `<p class="hx-nearby-src">${esc(src)}</p>`;
}

async function fetchNearbySummary(lat, lng) {
  const R = SUMMARY_RADIUS_M;
  const cacheKey = `pawa_nearby_sum_${lat.toFixed(3)}_${lng.toFixed(3)}_${R}`;
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (c && (Date.now() - c.at) < POI_CACHE_TTL_MS) return c.data;
  } catch (_) {}

  const q = `[out:json][timeout:25];(` +
    `node["amenity"~"^(school|kindergarten|college|university|hospital|clinic|doctors|pharmacy|marketplace|bank|atm|bureau_de_change|place_of_worship|bus_station|taxi)$"](around:${R},${lat},${lng});` +
    `node["shop"~"^(supermarket|convenience|mall)$"](around:${R},${lat},${lng});` +
    `node["highway"="bus_stop"](around:${R},${lat},${lng});` +
    `node["railway"="station"](around:${R},${lat},${lng});` +
    `node["public_transport"](around:${R},${lat},${lng});` +
    `);out body 150;`;
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  let lastErr;
  for (const url of endpoints) {
    // fetch() has no native timeout — abort after 18s so a busy/hung Overpass
    // mirror can't leave the card stuck on "Scanning…"; we fall through to the
    // next mirror, then to the graceful failure message.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 18000);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(q),
        signal: ac.signal,
      });
      if (!r.ok) throw new Error("Overpass HTTP " + r.status);
      const j = await r.json();
      const els = (j.elements || []).filter(e => e.tags);
      try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data: els })); } catch (_) {}
      return els;
    } catch (e) { lastErr = e; }
    finally { clearTimeout(timer); }
  }
  throw lastErr || new Error("Overpass unreachable");
}
