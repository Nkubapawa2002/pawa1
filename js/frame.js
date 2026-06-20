// =====================================================================
// The Frame — read any area as a "room for business"
// =====================================================================
// Pick a spot (search a place, use GPS, or tap the map) and Pawa reads it
// against the four layers in frame.MD:
//   1. Magnets        — the fixed things that gather a population (OSM POIs)
//   2. Shared services — what many people use daily (food/money/fuel density)
//   3. Population      — estimated from magnet pull + Pawa's own revealed signals
//   4. Key operations  — the engine that pays the area, inferred from the mix
// then scores the frame, contrasts revealed demand vs existing supply (the gap),
// and offers the next action.
//
// Reuses the existing plumbing — no new backend:
//   • pawaGeo (LocationIQ)  reverse-geocode the area name + ward boundary
//   • Overpass (OSM, free)  count + place the magnets and shared services
//   • pawaRoads.nearest     the carrying road ("the river")
//   • DataStore             houses / services / trucks / day_jobs supply + demand
//   • Leaflet + addSatelliteHybrid  the map, same as every other page
//
// Everything degrades gracefully: a dead Overpass, no GPS, RLS-blocked demand —
// each missing input just drops out of the readout instead of breaking the page.
(function () {
  "use strict";

  // ---- magnet taxonomy (mirrors frame.MD §2) -------------------------------
  // weight = how strongly this class pulls a crowd (transport & market lead).
  const MAGNETS = {
    transport:  { label: "Transport", emoji: "", color: "#2563eb", weight: 3.0 },
    market:     { label: "Market",    emoji: "", color: "#d97706", weight: 3.0 },
    learning:   { label: "Learning",  emoji: "", color: "#0891b2", weight: 2.5 },
    health:     { label: "Health",    emoji: "", color: "#dc2626", weight: 2.0 },
    money:      { label: "Money",     emoji: "", color: "#16a34a", weight: 2.0 },
    worship:    { label: "Worship",   emoji: "", color: "#7c3aed", weight: 1.5 },
    government: { label: "Government", emoji: "", color: "#475569", weight: 1.5 },
    leisure:    { label: "Leisure",   emoji: "", color: "#db2777", weight: 1.0 },
    fuel:       { label: "Fuel",      emoji: "", color: "#ea580c", weight: 1.0 },
  };

  // Population type + the product to lead with, keyed by the dominant magnet.
  const POP_TYPE = {
    transport:  { type: "Transient / hub",      lead: "food, short-stay rooms, parcels & storage" },
    market:     { type: "Commercial / trader",  lead: "storage & lockups, trucks, security, short-stay rooms" },
    learning:   { type: "Student",              lead: "shared rooms & hostels, cheap food, printing & repair" },
    health:     { type: "Care / mixed",         lead: "rooms for staff & visitors, pharmacies, food" },
    money:      { type: "Commercial high-street",lead: "offices, rooms, retail services" },
    worship:    { type: "Residential",          lead: "family rooms & houses, daily services" },
    government: { type: "Administrative",        lead: "mid-rent housing, offices, stationery & banking" },
    leisure:    { type: "Mixed / evening",      lead: "food, bars, short-stay, events services" },
    fuel:       { type: "Corridor / passing",   lead: "transport services, food, quick repair (fundi)" },
    _mixed:     { type: "Mixed high-street",    lead: "everything — rooms, services, trucks & jobs" },
    _quiet:     { type: "Dormitory / residential", lead: "rooms & houses to rent, everyday services" },
  };

  // ---- daily-life model (frame.MD §4/§5 made tangible) ---------------------
  // The six parts of a Tanzanian day. Each activity below says which parts it
  // runs in; summing them gives the area's daily RHYTHM (when it's busy), and
  // the activities themselves are what the area actually DOES — the read the
  // founder asked for: "the exact daily activities of an area due to the
  // services available."
  const DAY_PARTS = [
    { key: "dawn",      label: "Dawn",      hours: "5–7" },
    { key: "morning",   label: "Morning",   hours: "7–11" },
    { key: "midday",    label: "Midday",    hours: "11–2" },
    { key: "afternoon", label: "Afternoon", hours: "2–5" },
    { key: "evening",   label: "Evening",   hours: "5–9" },
    { key: "night",     label: "Night",     hours: "9–late" },
  ];

  // What each magnet class makes people DO, and when. Intensity is scaled by how
  // many of that anchor sit in the frame, so a place with a university + a bus
  // stand reads as genuinely busier — across more of the day — than a quiet ward.
  const CLASS_ACTIVITIES = {
    transport: [
      { key: "commute",     ic: "", label: "Commuting & travel", desc: "People stream in and out by daladala, bus, boda & bajaji.", parts: ["dawn", "morning", "evening"], who: ["commuters", "travellers"] },
      { key: "travelfood",  ic: "", label: "Food for travellers", desc: "Chai, mama-lishe & quick meals cluster around the stand.", parts: ["morning", "midday", "evening"], who: ["travellers"] },
      { key: "parcels",     ic: "", label: "Parcels & courier", desc: "Goods and packages ride the buses in and out.", parts: ["morning", "midday", "afternoon"], who: ["traders"] },
    ],
    market: [
      { key: "trade",       ic: "", label: "Buying & selling", desc: "Active trading — retail and wholesale through the day.", parts: ["morning", "midday", "afternoon"], who: ["traders", "shoppers"] },
      { key: "restock",     ic: "", label: "Produce delivery & restock", desc: "Suppliers and trucks drop goods before the rush.", parts: ["dawn", "morning"], who: ["suppliers"] },
      { key: "porter",      ic: "", label: "Porter & loading work (vibarua)", desc: "Casual labour carrying, loading and guarding stock.", parts: ["morning", "midday"], who: ["porters"] },
    ],
    learning: [
      { key: "classes",     ic: "", label: "Classes & lectures", desc: "Campus fills in term — a daily crowd of students & staff.", parts: ["morning", "midday", "afternoon"], who: ["students", "staff"] },
      { key: "stcommute",   ic: "", label: "Student commuting", desc: "Big inflow at the start of day, outflow at dusk.", parts: ["dawn", "morning", "evening"], who: ["students"] },
      { key: "cheapfood",   ic: "", label: "Cheap food & snacks", desc: "Student-priced meals, vendors and groceries.", parts: ["midday", "evening"], who: ["students"] },
      { key: "study",       ic: "", label: "Printing, internet & study", desc: "Stationery, photocopy, data bundles & evening study.", parts: ["afternoon", "evening", "night"], who: ["students"] },
    ],
    health: [
      { key: "clinic",      ic: "", label: "Clinic visits & queues", desc: "Patients arrive early and queue for care.", parts: ["morning", "midday"], who: ["patients", "attendants"] },
      { key: "pharmacy",    ic: "", label: "Pharmacy & medicine runs", desc: "Steady all-day demand at the duka la dawa.", parts: ["morning", "midday", "afternoon", "evening"], who: ["patients"] },
      { key: "care24",      ic: "", label: "Round-the-clock activity", desc: "Emergencies & night staff keep it alive after dark.", parts: ["night"], who: ["staff"] },
    ],
    money: [
      { key: "banking",     ic: "", label: "Banking & cash", desc: "Withdrawals, deposits & mobile-money — surges on payday.", parts: ["morning", "midday", "afternoon"], who: ["workers", "traders"] },
    ],
    worship: [
      { key: "prayer",      ic: "", label: "Prayers & gatherings", desc: "Daily prayers; big crowds on Friday (Jumuah) & Sunday.", parts: ["dawn", "midday", "evening"], who: ["residents", "families"] },
    ],
    government: [
      { key: "admin",       ic: "", label: "Office work & paperwork", desc: "Permits, registration & civic queues on weekdays.", parts: ["morning", "midday", "afternoon"], who: ["workers", "citizens"] },
    ],
    leisure: [
      { key: "social",      ic: "", label: "Socialising & nightlife", desc: "Bars, food & gatherings come alive in the evening.", parts: ["evening", "night"], who: ["youth", "residents"] },
      { key: "sport",       ic: "⚽", label: "Sport & recreation", desc: "Exercise, matches and weekend crowds.", parts: ["morning", "evening"], who: ["residents"] },
    ],
    fuel: [
      { key: "refuel",      ic: "⛽", label: "Refuelling & transit stops", desc: "Drivers pass through — peaks at the rush hours.", parts: ["dawn", "morning", "evening"], who: ["drivers"] },
    ],
  };

  // Weekly pulse notes — the days that spike, by which anchors are present.
  const WEEKLY = [
    { test: (c) => c.learning > 0,   note: "term-time crowds" },
    { test: (c) => c.worship > 0,    note: "Friday & Sunday peaks" },
    { test: (c) => c.market > 0,     note: "market-day surges" },
    { test: (c) => c.money > 0 || c.government > 0, note: "payday & month-end rush" },
    { test: (c) => c.leisure > 0,    note: "weekend evenings" },
  ];

  const OVERPASS_EPS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];

  let map = null, frameLayer = null, roadNetLayer = null, magnetLayer = null, ownLayer = null, centerMarker = null;
  let bestMarker = null, lastBest = null;   // "best spot to list" marker + its latlng
  let frameMarkers = {}, highlightMarker = null;   // frame id → map marker (for list↔map highlight)
  let center = null;            // { lat, lng }
  let radiusM = 1500;
  let busy = false;
  const ownCache = {};          // { houses, services, trucks, jobs } loaded once

  function $(id) { return document.getElementById(id); }
  const esc = (s) => window.escHtml ? window.escHtml(s) : String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const num = (v) => { const n = +v; return Number.isFinite(n) ? n : null; };

  function haversineKm(aLat, aLng, bLat, bLng) {
    const R = 6371, rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  // ---- Overpass: one call → every magnet + shared service in the frame -----
  async function overpassFetch(query) {
    for (const url of OVERPASS_EPS) {
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 26000);
        const r = await fetch(url, {
          method: "POST", signal: ac.signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(query),
        });
        clearTimeout(t);
        if (r.ok) return await r.json();
      } catch (_) { /* try next endpoint */ }
    }
    return null;
  }

  // Map an OSM element's tags → { magnet: <class|null>, service: <bool> }.
  // A node can be both (a marketplace is a magnet AND a shared service).
  function classify(tags) {
    const t = tags || {};
    const a = t.amenity || "", shop = t.shop || "", leisure = t.leisure || "",
          rail = t.railway || "", pt = t.public_transport || "", office = t.office || "";
    let magnet = null, service = false, tag = "";

    if (a === "bus_station" || a === "ferry_terminal" || rail === "station" || pt === "station") { magnet = "transport"; tag = a || (rail === "station" ? "station" : "station"); }
    else if (a === "marketplace" || /^(mall|supermarket|department_store)$/.test(shop)) { magnet = "market"; service = true; tag = a === "marketplace" ? "marketplace" : shop; }
    else if (/^(school|college|university)$/.test(a)) { magnet = "learning"; tag = a; }
    else if (/^(hospital|clinic|doctors)$/.test(a)) { magnet = "health"; tag = a; if (a === "doctors") service = true; }
    else if (a === "bank" || a === "atm") { magnet = "money"; service = true; tag = a; }
    else if (a === "place_of_worship") { magnet = "worship"; tag = "place_of_worship"; }
    else if (a === "townhall" || a === "courthouse" || a === "police" || office === "government") { magnet = "government"; tag = a || "government"; }
    else if (/^(stadium|sports_centre|park)$/.test(leisure) || /^(bar|pub|nightclub)$/.test(a)) { magnet = "leisure"; tag = leisure || a; }
    else if (a === "fuel") { magnet = "fuel"; service = true; tag = "fuel"; }

    // Pure shared-service points (high-frequency daily needs, not crowd magnets).
    if (!magnet && (/^(restaurant|cafe|fast_food|pharmacy)$/.test(a) || /^(convenience|kiosk|bakery|butcher|greengrocer|hairdresser|mobile_phone)$/.test(shop)))
      service = true;

    return { magnet, service, tag };
  }

  async function readMagnets(c, rM) {
    const q =
      `[out:json][timeout:25];(` +
      `nwr["amenity"~"^(bus_station|ferry_terminal|marketplace|place_of_worship|school|college|university|hospital|clinic|doctors|bank|atm|townhall|courthouse|police|bar|pub|nightclub|fuel|restaurant|cafe|fast_food|pharmacy)$"](around:${rM},${c.lat},${c.lng});` +
      `nwr["shop"~"^(mall|supermarket|department_store|convenience|kiosk|bakery|butcher|greengrocer|hairdresser|mobile_phone)$"](around:${rM},${c.lat},${c.lng});` +
      `nwr["railway"="station"](around:${rM},${c.lat},${c.lng});` +
      `nwr["public_transport"="station"](around:${rM},${c.lat},${c.lng});` +
      `nwr["office"="government"](around:${rM},${c.lat},${c.lng});` +
      `nwr["leisure"~"^(stadium|sports_centre|park)$"](around:${rM},${c.lat},${c.lng});` +
      `);out center tags 600;`;

    const j = await overpassFetch(q);
    const counts = {}; Object.keys(MAGNETS).forEach((k) => (counts[k] = 0));
    let serviceCount = 0;
    const pins = [];
    if (!j || !Array.isArray(j.elements)) return { counts, serviceCount, pins, ok: false };

    for (const el of j.elements) {
      const { magnet, service, tag } = classify(el.tags);
      if (service) serviceCount++;
      if (!magnet) continue;
      counts[magnet]++;
      const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
      const lng = el.lon != null ? el.lon : (el.center && el.center.lon);
      if (Number.isFinite(lat) && Number.isFinite(lng) && pins.length < 280) {
        const named = !!(el.tags && (el.tags.name || el.tags["name:en"] || el.tags["name:sw"]));
        const name = (el.tags && (el.tags.name || el.tags["name:en"] || el.tags["name:sw"])) || MAGNETS[magnet].label;
        pins.push({ lat, lng, name, cls: magnet, tag, named });
      }
    }
    return { counts, serviceCount, pins, ok: true };
  }

  // ---- University / student catchment (the campus opportunity) -------------
  // A university is the strongest, most reliable demand engine there is: the
  // closer you are, the more students live there. So we ALWAYS scan 5 km (even
  // for a small frame — a campus 4 km away still shapes the area), rank every
  // campus by distance (nearest first), and read which student "belt" the spot
  // sits in. Closer belt = denser student tenancy = more room/food/service money.
  const UNI_RADIUS_M = 5000;
  function studentBand(km) {
    if (km <= 0.5)  return { key: "prime",    label: "Prime student belt",   density: "very high",     pct: 100, note: "walking distance — rooms here fill with students first" };
    if (km <= 1)    return { key: "inner",    label: "Inner student zone",   density: "high",          pct: 78,  note: "a short walk to campus; heavy student tenancy" };
    if (km <= 2)    return { key: "commuter", label: "Student commuter belt", density: "moderate–high", pct: 55,  note: "a quick daladala / boda hop to campus" };
    if (km <= 3.5)  return { key: "outer",    label: "Outer catchment",      density: "moderate",      pct: 35,  note: "cheaper, quieter rooms for students who want it" };
    return { key: "edge", label: "Edge of catchment", density: "low–moderate", pct: 18, note: "the far edge of the student belt" };
  }

  async function readUniversityCatchment(c) {
    const q = `[out:json][timeout:25];(nwr["amenity"~"^(university|college)$"](around:${UNI_RADIUS_M},${c.lat},${c.lng}););out center tags 80;`;
    const j = await overpassFetch(q);
    if (!j || !Array.isArray(j.elements)) return { unis: [], nearest: null, score: 0, ok: false };
    const seen = new Set();
    const unis = [];
    for (const el of j.elements) {
      const t = el.tags || {};
      const name = t.name || t["name:en"] || t["name:sw"];
      if (!name) continue;
      const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
      const lng = el.lon != null ? el.lon : (el.center && el.center.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue; seen.add(key);
      unis.push({ name, lat, lng, meters: Math.round(haversineKm(c.lat, c.lng, lat, lng) * 1000), kind: t.amenity });
    }
    unis.sort((a, b) => a.meters - b.meters);
    const nearest = unis[0] || null;
    // Closeness curve — high near the campus, fading to ~0 by 5 km — plus a small
    // bump for each extra campus (a multi-campus area is a student town).
    let score = 0;
    if (nearest) score = clamp(Math.round(100 * Math.exp(-(nearest.meters / 1000) / 1.8)) + (unis.length - 1) * 8, 0, 100);
    return { unis, nearest, score, ok: true };
  }

  // A Frame is a "room for business" — so the Frame map only shows listings that
  // ARE business spaces (frames), never normal residential rooms like a master
  // room. A listing qualifies when it's a business-space TYPE (shop / office /
  // warehouse / store / stall / kiosk / godown / lockup), or it's explicitly
  // NAMED a frame / business space (the listing form even suggests "frame" as a
  // custom type). Room-by-room residential rentals (room_kind single/master) and
  // plain dwellings (house / apartment / room / studio) are excluded.
  function isFrameListing(h) {
    if (!h) return false;
    if (h.is_frame === true) return true;     // agent ticked "this is a Frame"
    const roomKind = String(h.room_kind || "").toLowerCase();
    if (roomKind === "single" || roomKind === "master") return false;   // residential rooms
    const type = String(h.type || "").toLowerCase().trim();
    if (/^(house|apartment|villa|studio|room|bedsitter|self.?contained)$/.test(type)) return false;
    if (/^(shop|office|warehouse|store|stall|kiosk|godown|go-?down|commercial|business)$/.test(type)) return true;
    // Custom "other" type or title that names it a frame / business space.
    const text = `${type} ${h.title || ""}`.toLowerCase();
    return /\b(frame|biashara|business|commercial|duka|shop|store|ofisi|office|go-?down|godown|warehouse|kibanda|stall|kiosk|lock-?up|lockup|market\s*stall|maduka)\b/.test(text);
  }

  // ---- Pawa's own revealed signals inside the frame ------------------------
  async function loadOwn() {
    if (ownCache.loaded) return ownCache;
    const [h, s, t] = await Promise.allSettled([
      window.DataStore.getHouses(), window.DataStore.getServices(), window.DataStore.getTrucks(),
    ]);
    // Only business-space "frames" — never normal/residential rooms.
    ownCache.houses = h.status === "fulfilled" && Array.isArray(h.value)
      ? h.value.filter((x) => x.available !== false && isFrameListing(x)) : [];
    ownCache.services = s.status === "fulfilled" && Array.isArray(s.value) ? s.value : [];
    ownCache.trucks = t.status === "fulfilled" && Array.isArray(t.value) ? t.value : [];

    // Day jobs (the labour / operations signal). Anon can read the public board.
    ownCache.jobs = [];
    const sb = window.DataStore.sb;
    if (sb) {
      try {
        const { data } = await sb.from("day_jobs").select("id,title,lat,lng,status,created_at").limit(500);
        if (Array.isArray(data)) ownCache.jobs = data.filter((j) => j.status == null || j.status === "open" || j.status === "claimed");
      } catch (_) {}
    }
    ownCache.loaded = true;
    return ownCache;
  }

  // Demand pins near the centre — via the SECURITY-DEFINER RPC (best effort;
  // returns [] when the RPC isn't installed or RLS hides it from anon).
  async function loadDemand(c, rM) {
    const sb = window.DataStore.sb;
    if (!sb) return [];
    try {
      const { data, error } = await sb.rpc("house_demand_near", {
        p_lat: c.lat, p_lng: c.lng, p_radius_m: Math.max(rM, 1500),
        p_listing: "rent", p_type: null, p_price: 0, p_bedrooms: 0,
      });
      if (error) return [];
      return Array.isArray(data) ? data : [];
    } catch (_) { return []; }
  }

  function within(rows, c, rM) {
    const km = rM / 1000;
    return rows.filter((r) => {
      const lat = num(r.lat), lng = num(r.lng);
      return lat != null && lng != null && haversineKm(c.lat, c.lng, lat, lng) <= km;
    });
  }

  // ---- scoring (frame.MD §6) -----------------------------------------------
  // Every component is normalised to 0–100 with a soft cap, so the final score
  // is comparable across frames and each part can be shown as a reason.
  function score(model) {
    const { counts, serviceCount, supply, demandCount, jobsIn } = model;

    let magnetPull = 0;
    for (const k of Object.keys(MAGNETS)) magnetPull += MAGNETS[k].weight * Math.min(counts[k], 8);
    const pull100 = clamp((magnetPull / 55) * 100, 0, 100);
    const svc100 = clamp((serviceCount / 45) * 100, 0, 100);
    const pop100 = clamp(((magnetPull * 0.55 + serviceCount) / 60) * 100, 0, 100);

    const ra = roadAccess(model.roadsData, model.road);
    const road100 = ra.road100;

    const revealed = demandCount * 8 + jobsIn * 6;
    const demand100 = clamp((revealed / 40) * 100, 0, 100);
    const supplyPenalty = clamp((supply / 28) * 100, 0, 100);

    // Student catchment — a nearby university is a major, dependable demand
    // engine, so it gets real weight of its own (closer campus = higher).
    const student100 = (model.catchment && model.catchment.score) || 0;

    // Road is the root — where people and money flow — so it carries the most
    // weight of any single factor here; the campus pull is right behind.
    const base = 0.22 * pull100 + 0.12 * svc100 + 0.10 * pop100 + 0.24 * road100 + 0.16 * demand100 + 0.16 * student100;
    const total = Math.round(clamp(base - 0.12 * supplyPenalty, 0, 100));
    return { total, pull100, svc100, pop100, road100, demand100, student100, supplyPenalty, magnetPull, revealed, ra };
  }

  // Road-access score (0–100) from the FULL main-road network + junctions:
  //   • how close & high-class the nearest main road is        (reach)
  //   • how many distinct main roads the frame can touch        (connectivity)
  //   • whether a junction/node — where roads unite people — is close (the money point)
  function roadAccess(roadsData, nearestRoad) {
    const roads = (roadsData && roadsData.roads) || (nearestRoad ? [nearestRoad] : []);
    const junctions = (roadsData && roadsData.junctions) || [];
    if (!roads.length) return { road100: 0, reach: 0, conn: 0, node: 0, distinct: 0, nearJ: null };

    const n = roads[0];
    const classBase = /motorway|trunk/.test(n.highway) ? 60 : n.highway === "primary" ? 50 : n.highway === "secondary" ? 38 : 24;
    const closeFactor = clamp(1 - (n.meters / 1500), 0, 1);     // full credit ≤0 m, none ≥1.5 km
    const reach = classBase * (0.45 + 0.55 * closeFactor);

    const distinct = new Set(roads.map((r) => r.name)).size;
    const conn = clamp((distinct - 1) * 9, 0, 25);              // each extra main road adds reach

    let node = 0, nearJ = junctions[0] || null;
    if (nearJ) {
      const km = Math.max(0.4, radiusM / 1000);
      node = clamp(25 * (1 - (nearJ.meters / 1000) / km), 6, 25); // a close junction is a money node
    }
    return { road100: clamp(reach + conn + node, 0, 100), reach: Math.round(reach), conn: Math.round(conn), node: Math.round(node), distinct, nearJ };
  }

  function scoreColor(s) {
    if (s >= 70) return "#0a6f4d";
    if (s >= 45) return "#d97706";
    return "#9a3412";
  }

  // Dominant magnet (by weighted presence) → frame name, population type, engine.
  function dominant(counts) {
    let best = null, bestW = 0;
    for (const k of Object.keys(MAGNETS)) {
      const w = MAGNETS[k].weight * counts[k];
      if (w > bestW) { bestW = w; best = k; }
    }
    return best;
  }

  function topClasses(counts, n) {
    return Object.keys(MAGNETS)
      .filter((k) => counts[k] > 0)
      .sort((a, b) => (MAGNETS[b].weight * counts[b]) - (MAGNETS[a].weight * counts[a]))
      .slice(0, n);
  }

  // ---- build the daily-activity model from the anchors present -------------
  // Pure data in → structured "what happens here, and when" out. The services
  // available to an area dictate its daily activities (a university gathers a
  // crowd; a bus stand & road move people; a market drives trade & labour), so
  // the mix of anchors is translated straight into activities + a day rhythm.
  function buildActivities(counts, serviceCount, road, jobsIn) {
    const CAP = 6;
    const acts = [];
    for (const cls of Object.keys(CLASS_ACTIVITIES)) {
      const n = counts[cls] || 0;
      if (!n) continue;
      const intensity = Math.min(n, CAP) * MAGNETS[cls].weight;
      for (const a of CLASS_ACTIVITIES[cls]) acts.push({ ...a, cls, intensity });
    }

    // The road that MOVES people — weighted by how much traffic it carries.
    const hw = road ? (road.highway || "") : "";
    const roadInt = /motorway|trunk/.test(hw) ? 18 : hw === "primary" ? 12 : hw === "secondary" ? 7 : road ? 3 : 0;
    if (roadInt) acts.push({
      key: "throughflow", ic: "", label: "People & goods moving through", cls: "transport", intensity: roadInt,
      desc: `${(road && road.name) || "The main road"} carries traffic across the area — peaks at the rush hours.`,
      parts: ["dawn", "morning", "evening"], who: ["commuters", "transporters"],
    });

    const errInt = Math.min(serviceCount, 20) * 0.5;
    if (errInt >= 1) acts.push({
      key: "errands", ic: "", label: "Everyday errands", cls: "service", intensity: errInt,
      desc: "Food, airtime, kiosks & quick shopping keep small stalls busy all day.",
      parts: ["morning", "midday", "evening"], who: ["residents"],
    });

    if (jobsIn > 0) acts.push({
      key: "daywork", ic: "", label: "Day-labour (vibarua)", cls: "jobs", intensity: Math.min(jobsIn, 8) * 1.5,
      desc: `${jobsIn} active day-job post${jobsIn === 1 ? "" : "s"} — casual work is being hired here right now.`,
      parts: ["morning", "midday", "afternoon"], who: ["workers"],
    });

    const rhythm = {}; DAY_PARTS.forEach((p) => (rhythm[p.key] = 0));
    for (const a of acts) for (const p of a.parts) rhythm[p.key] += a.intensity;
    const maxR = Math.max(1, ...DAY_PARTS.map((p) => rhythm[p.key]));
    const busiest = DAY_PARTS.filter((p) => rhythm[p.key] >= maxR * 0.82 && rhythm[p.key] > 0).map((p) => p.key);

    const peopleW = {};
    for (const a of acts) for (const w of (a.who || [])) peopleW[w] = (peopleW[w] || 0) + a.intensity;
    const people = Object.keys(peopleW).sort((x, y) => peopleW[y] - peopleW[x]).slice(0, 4);

    const top = acts.slice().sort((x, y) => y.intensity - x.intensity).slice(0, 7);
    const maxI = Math.max(1, ...acts.map((a) => a.intensity));
    const totalIntensity = acts.reduce((s, a) => s + a.intensity, 0);
    const markers = WEEKLY.filter((w) => w.test(counts)).map((w) => w.note);

    return { acts, top, rhythm, maxR, maxI, busiest, people, totalIntensity, diversity: acts.length, markers };
  }

  function partLabel(key) { const p = DAY_PARTS.find((d) => d.key === key); return p ? p.label.toLowerCase() : key; }
  function joinNice(arr) {
    arr = arr.filter(Boolean);
    if (arr.length <= 1) return arr[0] || "";
    return arr.slice(0, -1).join(", ") + " & " + arr[arr.length - 1];
  }
  function cap1(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  // ---- render the "Daily life of this frame" card --------------------------
  function lifeCardHtml(life, popLead) {
    if (!life.acts.length) {
      return `<div class="fr-card fr-life"><h3>Daily life of this frame</h3>
        <div class="fr-pulse">A quiet spot — few services drive a daily crowd here yet. Its value is mostly as a place to live, not a place people come to.</div></div>`;
    }

    const busiestLbl = joinNice(life.busiest.map(partLabel)) || "daytime";
    const topLbls = life.top.slice(0, 3).map((a) => a.label.toLowerCase());
    const pulse = `Busiest in the <b>${esc(busiestLbl)}</b>. The day here runs on <b>${esc(joinNice(topLbls))}</b>.`;

    // Day-rhythm timeline.
    const rhythm = DAY_PARTS.map((p) => {
      const pct = Math.round((life.rhythm[p.key] / life.maxR) * 100);
      const peak = life.busiest.includes(p.key);
      return `<div class="fr-rp ${peak ? "peak" : ""}"><div class="fr-rp-bar"><i style="height:${Math.max(pct, life.rhythm[p.key] > 0 ? 6 : 0)}%"></i></div>` +
        `<div class="fr-rp-l">${p.label}</div><div class="fr-rp-h">${p.hours}</div></div>`;
    }).join("");

    const markers = life.markers.length
      ? `<div class="fr-markers">${life.markers.map((m) => `<span class="fr-marker">${esc(m)}</span>`).join("")}</div>` : "";

    // The activities themselves, strongest first, each with its time-of-day + a
    // little intensity meter so the dominant rhythms stand out.
    const acts = life.top.map((a) => {
      const when = a.parts.length >= 5 ? "all day" : joinNice(a.parts.map(partLabel));
      const w = Math.round((a.intensity / life.maxI) * 100);
      return `<div class="fr-act"><div class="fr-act-ic">${a.ic}</div><div class="fr-act-b">` +
        `<div class="fr-act-t">${esc(a.label)}<small>${esc(when)}</small></div>` +
        `<div class="fr-act-d">${esc(a.desc)}</div>` +
        `<div class="fr-act-meter"><i style="width:${w}%"></i></div></div></div>`;
    }).join("");

    const peopleLine = life.people.length
      ? `<div class="fr-people"><b>Who gathers here:</b> ${esc(joinNice(life.people.map(cap1)))}.</div>` : "";

    // Potential verdict — energy × diversity, then the products to lead with.
    const T = life.totalIntensity, D = life.diversity;
    const energy = T >= 45 ? "High-energy" : T >= 20 ? "Steady, active" : T >= 8 ? "Modest" : "Quiet";
    const useType = D >= 6 ? "mixed-use" : D >= 3 ? "multi-activity" : "focused";
    const foot = T >= 45 ? "all-day footfall" : T >= 20 ? "reliable daytime footfall" : "light footfall";
    const peopleSummary = life.people.length ? cap1(joinNice(life.people)) : "Residents";
    const potential = `<div class="fr-potential"><b>${energy} ${useType} frame.</b> ${esc(peopleSummary)} generate <b>${foot}</b> here. ` +
      `Best business potential: <b>${esc(popLead)}</b>.</div>`;

    return `<div class="fr-card fr-life">
      <h3>Daily life of this frame</h3>
      <div class="fr-pulse">${pulse}</div>
      <div class="fr-rhythm">${rhythm}</div>
      ${markers}
      <div class="fr-acts">${acts}</div>
      ${peopleLine}
      ${potential}
    </div>`;
  }

  // ---- roads readout helpers -----------------------------------------------
  function roadColor(hw) {
    return /motorway|trunk/.test(hw) ? "#b91c1c" : hw === "primary" ? "#ea580c" : hw === "secondary" ? "#d97706"
      : hw === "tertiary" ? "#ca8a04" : "#94a3b8";
  }
  function roadClassLabel(hw) {
    return /motorway/.test(hw) ? "Highway" : hw === "trunk" ? "Trunk" : hw === "primary" ? "Primary" : hw === "secondary" ? "Secondary"
      : hw === "tertiary" ? "Tertiary" : hw === "residential" ? "Street" : hw === "living_street" ? "Street" : hw === "unclassified" ? "Local" : "Road";
  }
  function distM(m) { return m == null ? "" : m <= 15 ? "on it" : m < 1000 ? m + " m" : (m / 1000).toFixed(1) + " km"; }
  function compactK(p) { p = Number(p) || 0; if (p >= 1e9) return (p / 1e9).toFixed(p % 1e9 ? 1 : 0) + "B"; if (p >= 1e6) return (p / 1e6).toFixed(p % 1e6 ? 1 : 0) + "M"; if (p >= 1e3) return Math.round(p / 1e3) + "k"; return String(p); }

  // The list of frames (business spaces) in the gap panel — each with its
  // distance to the nearest road, closest first, so an agent can eyeball them.
  function framesListHtml(frames) {
    if (!frames || !frames.length)
      return `<div class="fr-frames-none">No frames (business spaces) listed here yet — an open gap to fill.</div>`;
    const rows = frames.slice(0, 8).map((f) => {
      const road = f.roadName ? `${distM(f.roadM)} to ${esc(f.roadName)}` : "no road mapped";
      const price = f.priceTzs ? ` · TZS ${compactK(f.priceTzs)}${f.listing === "sale" ? "" : "/" + (f.period === "month" ? "mo" : esc(f.period || "mo"))}` : "";
      const inner = `<span class="fr-frame-name">${esc(f.title)}</span><span class="fr-frame-meta"> ${road}${price}</span>`;
      // Tapping a row highlights the frame on the map (falls back to opening its
      // detail page when it has no map pin).
      return `<button type="button" class="fr-frame-row" data-fid="${esc(f.id || "")}" data-href="${f.href ? esc(f.href) : ""}">${inner}</button>`;
    }).join("");
    const more = frames.length > 8 ? `<div class="fr-frames-more">+ ${frames.length - 8} more</div>` : "";
    return `<div class="fr-frames-sub">The ${frames.length} frame${frames.length === 1 ? "" : "s"} here — tap one to find it on the map (closest to a road first)</div>${rows}${more}`;
  }

  // The Roads & nodes card — every main road in the frame, measured, plus the
  // junctions where roads unite people. The road is the root; this is its card.
  function roadsCardHtml(roadsData) {
    const roads = (roadsData && roadsData.roads) || [];
    const junctions = (roadsData && roadsData.junctions) || [];
    if (!roads.length) {
      return `<div class="fr-card"><h3>Roads &amp; nodes — the root</h3>
        <div class="fr-road-note">No motorway, trunk, primary or secondary road reaches this frame. People here depend on feeder / murram roads — access is the weak point, and that caps how much trade the spot can pull.</div></div>`;
    }
    const n = roads[0];
    const head = `Nearest main road: <b>${esc(n.name)}</b> — ${n.meters <= 15 ? "<b>you're right on it</b>" : "<b>" + distM(n.meters) + "</b> away"} ` +
      `(${roadClassLabel(n.highway).toLowerCase()}). <b>${roads.length}</b> main road${roads.length === 1 ? "" : "s"} touch this frame.`;
    const rows = roads.slice(0, 8).map((r) =>
      `<div class="fr-road-row">
         <span class="fr-rc" style="background:${roadColor(r.highway)}">${roadClassLabel(r.highway)}</span>
         <span class="fr-road-name">${esc(r.name)}</span>
         <span class="fr-road-dist">${distM(r.meters)}</span>
       </div>`).join("");
    let nodeHtml;
    if (junctions.length) {
      const j = junctions[0];
      const names = j.roads.slice(0, 3).map(esc).join(" × ");
      nodeHtml = `<div class="fr-node"><b>Node — where roads unite people:</b> ${names} cross ` +
        `${j.meters <= 15 ? "right here" : "~" + distM(j.meters) + " away"}. Junctions are where foot traffic and money concentrate — the prime spot in the frame.` +
        `${junctions.length > 1 ? ` (${junctions.length} junctions in all.)` : ""}</div>`;
    } else {
      nodeHtml = `<div class="fr-road-note">No crossing of two main roads inside the frame — this is a road-side stretch, not a node. Trade strings along the road rather than pooling at a point.</div>`;
    }

    // Other (smaller) roads nearby, each with how far — the streets a house
    // actually sits on, beyond the carrying roads.
    const others = (roadsData && roadsData.others) || [];
    let othersHtml = "";
    if (others.length) {
      const list = others.slice(0, 6).map((o) =>
        `<div class="fr-road-row other">
           <span class="fr-rc" style="background:${roadColor(o.highway)}">${roadClassLabel(o.highway)}</span>
           <span class="fr-road-name">${esc(o.name)}</span>
           <span class="fr-road-dist">${distM(o.meters)}</span>
         </div>`).join("");
      othersHtml = `<div class="fr-road-sub">Other roads nearby${others.length > 6 ? ` (top 6 of ${others.length})` : ""}</div>${list}`;
    }

    return `<div class="fr-card"><h3>Roads &amp; nodes — the root of the money flow</h3>
      <div class="fr-road-head">${head}</div>${rows}${nodeHtml}${othersHtml}</div>`;
  }

  // ---- most-visited destinations: where daily people go --------------------
  // Each magnet pulls a different size of crowd. Universities & colleges,
  // markets, bus stands, hospitals and stadiums are the big daily destinations;
  // schools, banks and worship are mid. We rank the NAMED anchors by this pull,
  // then measure the main road people use to reach each — so an agent can set up
  // a room / service where those daily flows pass.
  const DEST_WEIGHT = {
    university: 100, college: 82, bus_station: 90, marketplace: 85, ferry_terminal: 70, station: 66,
    mall: 75, department_store: 56, supermarket: 50, hospital: 72, stadium: 60, clinic: 36,
    school: 46, place_of_worship: 42, sports_centre: 34, government: 36, townhall: 36, courthouse: 34,
    police: 30, bank: 30, park: 24, fuel: 20, bar: 24, pub: 24, nightclub: 24, doctors: 22, atm: 14,
  };
  const DEST_LABEL = {
    university: "University", college: "College", bus_station: "Bus stand", marketplace: "Market",
    ferry_terminal: "Ferry", station: "Station", mall: "Mall", department_store: "Store",
    supermarket: "Supermarket", hospital: "Hospital", clinic: "Clinic", school: "School",
    place_of_worship: "Worship", stadium: "Stadium", sports_centre: "Sports centre", government: "Govt office",
    townhall: "Town hall", courthouse: "Court", police: "Police", bank: "Bank", park: "Park", fuel: "Fuel station",
    bar: "Bar", pub: "Bar", nightclub: "Club", doctors: "Clinic", atm: "ATM",
  };
  function destLabel(tag) { return DEST_LABEL[tag] || (tag ? cap1(String(tag).replace(/_/g, " ")) : "Place"); }

  // Rank named anchors by pull, dedupe, and attach the nearest main road (the
  // road people use to get there). Universities/colleges float to the top.
  function buildDestinations(pins, roads) {
    const scored = (pins || []).map((p) => ({ ...p, w: DEST_WEIGHT[p.tag] || 0 }))
      .filter((p) => p.w > 0 && p.named).sort((a, b) => b.w - a.w);
    const out = [];
    for (const p of scored) {
      if (out.some((o) => o.name.toLowerCase() === p.name.toLowerCase() && haversineKm(o.lat, o.lng, p.lat, p.lng) < 0.25)) continue;
      const access = (window.pawaRoads && window.pawaRoads.nearestInSet) ? window.pawaRoads.nearestInSet(p, roads) : null;
      out.push({ ...p, access });
      if (out.length >= 6) break;
    }
    return out;
  }

  function destinationsCardHtml(dests) {
    if (!dests.length) {
      return `<div class="fr-card"><h3>Most-visited places — where daily people go</h3>
        <div class="fr-road-note">No major destinations (universities, colleges, markets, bus stands, hospitals…) are mapped inside this frame, so there's no strong daily pull point to target yet.</div></div>`;
    }
    const maxW = dests[0].w || 100;
    const rows = dests.map((d) => {
      const m = MAGNETS[d.cls] || { color: "#6b7280", emoji: "" };
      const via = (d.access && d.access.road)
        ? `Arrive via <b>${esc(d.access.road.name)}</b> · ${distM(d.access.meters)}`
        : "No main-road access mapped nearby";
      const w = Math.round((d.w / maxW) * 100);
      const big = d.tag === "university" || d.tag === "college";
      return `<div class="fr-dest">
        <div class="fr-dest-ic" style="background:${m.color}">${m.emoji}</div>
        <div class="fr-dest-b">
          <div class="fr-dest-t">${esc(d.name)} <small>${esc(destLabel(d.tag))}${big ? " ★" : ""}</small></div>
          <div class="fr-dest-d">${via}</div>
          <div class="fr-dest-meter"><i style="width:${w}%"></i></div>
        </div></div>`;
    }).join("");
    const top = dests[0];
    const lead = `People here head most to <b>${esc(top.name)}</b>` +
      (top.access && top.access.road ? ` — reached via <b>${esc(top.access.road.name)}</b>` : "") +
      `. Put your frame (business space) or service where these flows pass and you sit in front of the customers.`;
    return `<div class="fr-card"><h3>Most-visited places — where daily people go</h3>
      <div class="fr-road-head">${lead}</div>${rows}</div>`;
  }

  // ---- student-catchment card ----------------------------------------------
  function catchmentCardHtml(cat) {
    if (!cat || !cat.unis || !cat.unis.length) {
      return `<div class="fr-card fr-uni"><h3>&#127891; Student catchment</h3>
        <div class="fr-uni-none">No university or college within 5 km — not a student-driven area. (A campus pulls the densest, most reliable room &amp; food demand there is, so a frame near one plays a different game.)</div></div>`;
    }
    const n = cat.nearest, km = n.meters / 1000, band = studentBand(km);
    const bands = [["prime", "&le;0.5 km"], ["inner", "0.5–1"], ["commuter", "1–2"], ["outer", "2–3.5"], ["edge", "3.5–5"]];
    const ladder = bands.map(([k, r]) => `<div class="fr-uni-band ${band.key === k ? "on" : ""}"><i></i><span>${r}</span></div>`).join("");
    const list = cat.unis.slice(0, 5).map((u, i) =>
      `<div class="fr-uni-row"><span class="fr-uni-n">${i + 1}</span><span class="fr-uni-name">${esc(u.name)}</span><span class="fr-uni-dist">${distM(u.meters)}</span></div>`).join("");
    const lead = `You're <b>${distM(n.meters)}</b> from <b>${esc(n.name)}</b> — the <b>${esc(band.label.toLowerCase())}</b>. ${esc(band.note)}. Student density here: <b>${esc(band.density)}</b>.`;
    return `<div class="fr-card fr-uni">
      <h3>&#127891; Student catchment — the campus opportunity</h3>
      <div class="fr-uni-lead">${lead}</div>
      <div class="fr-uni-ladder">${ladder}</div>
      <div class="fr-uni-sub">${cat.unis.length} campus${cat.unis.length > 1 ? "es" : ""} within 5 km — nearest first</div>
      ${list}
      <div class="fr-uni-opp"><b>Opportunity:</b> shared rooms &amp; hostels, cheap food (mama-lishe), printing &amp; stationery, phone/electronics repair, fast Wi-Fi &amp; laundry. The closer the belt, the denser the demand and the faster a room fills.</div>
    </div>`;
  }

  // ---- best spot to list ---------------------------------------------------
  // The single point that sits closest to BOTH a top destination (the daily
  // crowd) AND a carrying road (the flow + visibility) — where a new room or
  // service would be in front of the most customers. Candidates are the road
  // access-points of the top destinations and the road nodes; each is scored by
  // weighted nearness to destinations × road closeness × a junction bonus.
  function bestSpot(destinations, roadsData) {
    const mains = (roadsData && roadsData.roads) || [];
    const dests = (destinations || []).filter((d) => Number.isFinite(d.lat) && Number.isFinite(d.lng));
    if (!mains.length || !dests.length) return null;

    const cands = [];
    for (const d of dests) {
      if (d.access && d.access.near && Number.isFinite(d.access.near.lat))
        cands.push({ lat: d.access.near.lat, lng: d.access.near.lng, onRoad: d.access.road });
    }
    for (const j of (roadsData.junctions || [])) cands.push({ lat: j.lat, lng: j.lng, junction: j });
    if (!cands.length) return null;

    const evalC = (c) => {
      let pull = 0, nearest = null;
      for (const d of dests) {
        const km = haversineKm(c.lat, c.lng, d.lat, d.lng);
        pull += d.w * Math.exp(-Math.pow(km / 0.4, 2));   // 400 m falloff
        if (!nearest || km < nearest.km) nearest = { d, km };
      }
      const acc = window.pawaRoads && window.pawaRoads.nearestInSet ? window.pawaRoads.nearestInSet(c, mains) : null;
      const roadM = acc ? acc.meters : 9999;
      const roadCloseness = clamp(1 - roadM / 300, 0, 1);
      const node = c.junction ? 1 : (roadsData.junctions || []).some((j) => haversineKm(c.lat, c.lng, j.lat, j.lng) < 0.15) ? 0.5 : 0;
      const s = pull * (0.6 + 0.4 * roadCloseness) * (1 + 0.3 * node);
      return { s, pull, roadM, acc, nearest, node, junction: c.junction, onRoad: c.onRoad };
    };

    let best = null;
    for (const c of cands) {
      const inFrame = haversineKm(center.lat, center.lng, c.lat, c.lng) <= (radiusM / 1000) * 1.05;
      if (!inFrame) continue;
      const r = evalC(c);
      if (!best || r.s > best.r.s) best = { c, r };
    }
    return best;
  }

  function bestSpotCardHtml(best) {
    if (!best || !best.r) return "";
    const r = best.r, c = best.c;
    const roadName = (r.acc && r.acc.road && r.acc.road.name) || (c.onRoad && c.onRoad.name) || "a main road";
    const near = r.nearest;
    const where = [];
    where.push(`On <b>${esc(roadName)}</b>${r.roadM <= 15 ? "" : ` (${distM(r.roadM)} off)`}`);
    if (near) where.push(`~${distM(Math.round(near.km * 1000))} from <b>${esc(near.d.name)}</b>`);
    if (c.junction) where.push("at a road node");
    const why = near
      ? `It sits on a customer-carrying road right by ${esc(near.d.name)} — list here and you're in front of the people heading there every day.`
      : `It sits on a carrying road close to the area's pull points — maximum passing customers.`;
    return `<div class="fr-card fr-best">
      <h3>★ Best spot to list here</h3>
      <div class="fr-best-where">${where.join(" · ")}</div>
      <div class="fr-best-why">${why}</div>
      <button type="button" class="fr-best-btn" id="frBestZoom">Show this spot on the map</button>
    </div>`;
  }

  // ---- render the read-out panel -------------------------------------------
  function renderPanel(model) {
    const { areaName, counts, serviceCount, road, sc, dom, supply, demandCount, jobsIn,
            rooms, servicesN, trucksN } = model;

    const dom1 = dom && MAGNETS[dom];
    const popKey = dom ? dom : (model.magnetPull < 4 ? "_quiet" : "_mixed");
    // If three+ classes are strong and none dominates hard, call it a high-street.
    const strong = topClasses(counts, 4).filter((k) => counts[k] >= 2);
    const pop = (strong.length >= 3) ? POP_TYPE._mixed
      : POP_TYPE[popKey] || POP_TYPE._quiet;

    // A close junction of two main roads makes this a NODE — the money point.
    const nearJ = (model.roadsData && model.roadsData.junctions && model.roadsData.junctions[0]) || null;
    const isNode = nearJ && nearJ.meters <= 300;
    const frameName = isNode ? (dom1 ? `${dom1.label} node frame` : "Road-node frame")
      : dom1 ? `${dom1.label} frame` : (model.magnetPull < 4 ? "Quiet residential frame" : "Mixed frame");

    // ---- "why" sentence ----
    const tops = topClasses(counts, 2).map((k) => `${MAGNETS[k].emoji} ${MAGNETS[k].label.toLowerCase()} (${counts[k]})`);
    const roadBit = road
      ? `on ${esc(road.name)}${/motorway|trunk|primary/.test(road.highway || "") ? " — a carrying road" : ""}`
      : "no major road mapped nearby";
    const whyParts = [];
    if (tops.length) whyParts.push(`anchored by ${tops.join(" + ")}`);
    whyParts.push(roadBit);
    if (isNode && nearJ.roads) whyParts.push(`at a road node where ${esc(nearJ.roads.slice(0, 2).join(" × "))} meet — a money point`);
    // Universities are too important to bury — call out the student belt up top.
    const cat = model.catchment;
    if (cat && cat.nearest) {
      const cb = studentBand(cat.nearest.meters / 1000);
      if (cb.key === "prime" || cb.key === "inner")
        whyParts.push(`in the ${esc(cb.label.toLowerCase())} of ${esc(cat.nearest.name)} — dense student demand`);
      else if (cat.nearest.meters <= UNI_RADIUS_M)
        whyParts.push(`inside ${esc(cat.nearest.name)}'s ${esc(cb.label.toLowerCase())} (${distM(cat.nearest.meters)})`);
    }
    const gapVerdict = verdict(model);
    if (gapVerdict.key === "open") whyParts.push("strong footfall with little Pawa supply yet — an open frame");
    else if (gapVerdict.key === "gap") whyParts.push(`demand here is outrunning supply — a gap to fill`);
    else if (gapVerdict.key === "proven") whyParts.push("already well supplied — optimise & add adjacent products");

    // ---- magnet chips ----
    const chips = topClasses(counts, 6).map((k) =>
      `<span class="fr-chip" style="background:${MAGNETS[k].color}">${MAGNETS[k].emoji} ${MAGNETS[k].label} <small>${counts[k]}</small></span>`
    ).join("") || `<span class="fr-layer-d">No notable magnets mapped here yet.</span>`;

    const layer = (ic, t, d) => `<div class="fr-layer"><div class="fr-layer-ic">${ic}</div><div class="fr-layer-b"><div class="fr-layer-t">${t}</div><div class="fr-layer-d">${d}</div></div></div>`;

    const roadCount = (model.roadsData && model.roadsData.roads && model.roadsData.roads.length) || 0;
    const njCount = (model.roadsData && model.roadsData.junctions && model.roadsData.junctions.length) || 0;
    const roadDesc = road
      ? `Nearest: <strong>${esc(road.name)}</strong> · ${distM(road.meters)} away. ${roadCount} main road${roadCount === 1 ? "" : "s"} reach the frame${njCount ? `, ${njCount} junction${njCount === 1 ? "" : "s"}` : ""} — full breakdown below.`
      : "No motorway / trunk / primary / secondary road within the frame — a feeder catchment, not a carrying node.";

    const popDesc = `${pop.type}. Estimated pull is <strong>${model.magnetPull >= 30 ? "high" : model.magnetPull >= 12 ? "moderate" : "light"}</strong> ` +
      `(${counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0} magnets, ${serviceCount} shared-service points). Lead with: <strong>${pop.lead}</strong>.`;

    const engine = inferEngine(counts, jobsIn, trucksN, dom);

    // The daily-life reading — the centrepiece: what this area DOES all day.
    const life = buildActivities(counts, serviceCount, road, jobsIn);

    const sColor = scoreColor(sc.total);
    const panel = $("frPanel");
    panel.innerHTML =
      // header + score
      `<div class="fr-card">
         <div class="fr-head">
           <div class="fr-head-main">
             <div class="fr-frame-name">${esc(frameName)}</div>
             <div class="fr-frame-area">${esc(areaName || "Selected area")} · ${(radiusM / 1000).toFixed(radiusM % 1000 ? 1 : 0)} km frame</div>
           </div>
           <div class="fr-score" style="background:${sColor}"><b>${sc.total}</b><span>Frame score</span></div>
         </div>
         <div class="fr-why">${whyParts.join("; ")}.</div>
       </div>` +

      // daily life of the frame — the activities the area runs on, hour by hour
      lifeCardHtml(life, pop.lead) +

      // student catchment — the campus opportunity (universities/colleges ≤5 km)
      catchmentCardHtml(model.catchment) +

      // roads & nodes — the root: every main road measured + junctions
      roadsCardHtml(model.roadsData) +

      // most-visited destinations + the roads people use to reach them
      destinationsCardHtml(model.destinations) +

      // the single best spot to plant a new listing
      bestSpotCardHtml(model.best) +

      // four-layer readout
      `<div class="fr-card">
         <h3>The four layers</h3>
         ${layer("", "Magnets — what gathers the crowd", `<div class="fr-chips">${chips}</div>`)}
         ${layer("", "Shared services — what many people use", `${serviceCount} everyday-need points (food, money, fuel, pharmacy, kiosks) inside the frame — the footfall proxy.`)}
         ${layer("", "Population — who sits here", popDesc)}
         ${layer("", "Key operation — how it earns", engine)}
         ${layer("", "The carrying road — the river", roadDesc)}
       </div>` +

      // gap panel
      `<div class="fr-card">
         <h3>Demand vs supply — the gap</h3>
         <span class="fr-gap-verdict ${gapVerdict.cls}">${gapVerdict.label}</span>
         <div class="fr-layer-d">${gapVerdict.note}</div>
         <div class="fr-gap-grid">
           <div class="fr-stat"><b>${rooms + servicesN + trucksN}</b><span>Pawa listings here<br>${rooms} frame${rooms === 1 ? "" : "s"} · ${servicesN} services · ${trucksN} trucks</span></div>
           <div class="fr-stat"><b>${demandCount + jobsIn}</b><span>Revealed demand<br>${demandCount} waiting renters · ${jobsIn} day-job posts</span></div>
         </div>
         ${framesListHtml(model.frames)}
       </div>` +

      // actions
      `<div class="fr-card">
         <h3>Act on this frame</h3>
         <div class="fr-actions">
           <a href="agent-houses.html">List a frame (business space) here</a>
           <a class="ghost" href="houses.html">Set an area alert here</a>
           <a class="ghost" href="near-me.html">See what's nearby</a>
         </div>
       </div>`;

    // Wire the "show best spot" button → fly to it and open its popup.
    const bz = document.getElementById("frBestZoom");
    if (bz) bz.addEventListener("click", () => {
      if (!map || !lastBest) return;
      switchView("map");
      setTimeout(() => {
        map.invalidateSize();
        map.setView([lastBest.lat, lastBest.lng], 16);
        if (bestMarker) bestMarker.openPopup();
      }, 80);
    });

    // Tap a frame row → highlight that frame on the map (or open it if no pin).
    panel.querySelectorAll(".fr-frame-row[data-fid]").forEach((el) => {
      el.addEventListener("click", () => {
        const fid = el.dataset.fid;
        if (fid && frameMarkers[fid]) highlightFrame(fid);
        else if (el.dataset.href) location.href = el.dataset.href;
      });
      if (HOVER_SYNC) {
        el.addEventListener("mouseenter", () => setPinSync(el.dataset.fid, true));
        el.addEventListener("mouseleave", () => setPinSync(el.dataset.fid, false));
      }
    });
  }

  // Fly to a frame's marker, open its popup and drop a short pulsing ring on it.
  function highlightFrame(id) {
    const m = frameMarkers[id];
    if (!map || !m) return;
    switchView("map");
    setTimeout(() => {
      map.invalidateSize();
      const ll = m.getLatLng();
      map.setView(ll, 16);
      m.openPopup();
      if (highlightMarker) { try { map.removeLayer(highlightMarker); } catch (_) {} highlightMarker = null; }
      highlightMarker = L.marker(ll, { interactive: false, zIndexOffset: 2000,
        icon: L.divIcon({ className: "", html: `<div class="fr-hl-ring"></div>`, iconSize: [36, 36], iconAnchor: [18, 18] }) }).addTo(map);
      setTimeout(() => { if (highlightMarker) { try { map.removeLayer(highlightMarker); } catch (_) {} highlightMarker = null; } }, 3200);
    }, 80);
  }

  // Reverse link: tap a frame pin → scroll to and flash its row in the list.
  function flashFrameRow(id) {
    let row = null;
    document.querySelectorAll('#frPanel .fr-frame-row[data-fid]').forEach((r) => {
      if (r.dataset.fid === String(id)) row = r;
    });
    if (!row) return;
    const stage = document.getElementById("frStage");
    const wasMap = stage && stage.dataset.view === "map";
    if (wasMap) switchView("panel");   // bring the read-out into view on mobile
    setTimeout(() => {
      try { row.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
      row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
      setTimeout(() => row.classList.remove("flash"), 1600);
    }, wasMap ? 80 : 0);
  }

  // ---- desktop hover-sync (row ⇄ pin soft highlight, no click) --------------
  // Only on devices with a real hover pointer; touch already has the tap links.
  const HOVER_SYNC = !!(window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches);

  function setPinSync(id, on) {
    const m = frameMarkers[id];
    const elr = m && m.getElement();
    const dot = elr && elr.querySelector(".fr-pin");
    if (dot) dot.classList.toggle("fr-pin-sync", on);
  }
  function setRowSync(id, on) {
    document.querySelectorAll('#frPanel .fr-frame-row[data-fid]').forEach((r) => {
      if (r.dataset.fid === String(id)) r.classList.toggle("sync", on);
    });
  }

  function inferEngine(counts, jobsIn, trucksN, dom) {
    const bits = [];
    if (counts.market >= 2) bits.push("trading hub → storage/lockups, trucks, porters & security");
    if (counts.transport >= 1) bits.push("transport hub → food, parcels, short-stay & repair");
    if (counts.learning >= 1) bits.push("learning town → hostels, cheap food, printing & electronics repair");
    if (counts.health >= 2) bits.push("health node → rooms for staff/visitors, pharmacies");
    if (counts.government >= 1) bits.push("administrative → mid-rent housing, offices, banking");
    if (jobsIn >= 1) bits.push(`active day-labour (${jobsIn} job post${jobsIn === 1 ? "" : "s"})`);
    if (trucksN >= 1) bits.push(`movement corridor (${trucksN} truck${trucksN === 1 ? "" : "s"} working here)`);
    if (!bits.length) return "Mostly residential — the engine is people living here; rooms, houses & everyday services lead.";
    return bits.slice(0, 3).join("; ") + ".";
  }

  function verdict(model) {
    const supply = model.supply;
    const revealed = model.demandCount + model.jobsIn;
    const heat = model.sc.pull100; // footfall heat 0..100
    if (revealed >= 2 && revealed > supply) return {
      key: "gap", cls: "fr-gap-gap", label: "GAP — demand outruns supply",
      note: "Your own users are asking here and not finding enough. The sharpest signal Pawa has — move an agent in.",
    };
    if (heat >= 55 && supply <= 2) return {
      key: "open", cls: "fr-gap-open", label: "OPEN — high footfall, little supply",
      note: "Strong magnets and road carry, but few Pawa listings yet. An open frame for an agent to own.",
    };
    if (supply >= 6) return {
      key: "proven", cls: "fr-gap-proven", label: "PROVEN — already well supplied",
      note: "Lots of listings already. Optimise price and add adjacent products (a room-heavy frame still needs trucks, storage & services).",
    };
    return {
      key: "open", cls: "fr-gap-open", label: "WATCH — building",
      note: "Moderate signals. Worth seeding a listing or two and watching how demand develops.",
    };
  }

  // ---- map -----------------------------------------------------------------
  function initMap() {
    const el = $("frMap");
    if (!window.L || !el) return;
    map = L.map(el, { scrollWheelZoom: true }).setView([-6.4, 35.0], 6);
    window.addSatelliteHybrid && window.addSatelliteHybrid(map);
    map.on("click", (e) => { if (!busy) setCenter({ lat: e.latlng.lat, lng: e.latlng.lng }); });
  }

  function drawFrame(model) {
    if (!map) return;
    [frameLayer, roadNetLayer, magnetLayer, ownLayer].forEach((l) => { if (l) map.removeLayer(l); });
    frameLayer = L.layerGroup().addTo(map);
    roadNetLayer = L.layerGroup().addTo(map);
    magnetLayer = L.layerGroup().addTo(map);
    ownLayer = L.layerGroup().addTo(map);
    frameMarkers = {};   // rebuilt below; the list highlights via these
    if (highlightMarker) { try { map.removeLayer(highlightMarker); } catch (_) {} highlightMarker = null; }

    // The walls — the frame circle.
    L.circle([center.lat, center.lng], {
      radius: radiusM, color: "#0a6f4d", weight: 2, opacity: .9,
      fillColor: "#0a6f4d", fillOpacity: .06, dashArray: "6 6",
    }).addTo(frameLayer);

    // Optional ward outline (if LocationIQ found a real boundary).
    if (model.boundaryGeo) {
      try {
        L.geoJSON(model.boundaryGeo, { interactive: false, style: { color: "#fff", weight: 2.5, opacity: .8, fill: false } }).addTo(frameLayer);
      } catch (_) {}
    }

    // Student catchment — concentric belts around the nearest campus (drawn
    // first, under the roads) + a 🎓 marker on every university/college ≤5 km.
    const cat = model.catchment;
    if (cat && cat.unis && cat.unis.length) {
      const n = cat.nearest;
      const rings = [[5000, .03], [3500, .05], [2000, .075], [1000, .11], [500, .16]];
      rings.forEach(([radM, op]) => {
        L.circle([n.lat, n.lng], { radius: radM, color: "#a78bfa", weight: 1, opacity: .45,
          fillColor: "#7c3aed", fillOpacity: op, interactive: false }).addTo(frameLayer);
      });
      cat.unis.forEach((u) => {
        const icon = L.divIcon({ className: "", html: `<div class="fr-uni-pin">&#127891;</div>`, iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14] });
        L.marker([u.lat, u.lng], { icon }).addTo(magnetLayer)
          .bindPopup(`<strong>${esc(u.name)}</strong><br><small>${esc(u.kind || "university")} · ${distM(u.meters)} from centre — student catchment</small>`);
      });
    }

    // Other (smaller) roads first, thin & grey, so they sit UNDER the carrying
    // roads — every road nearby is drawn and tappable for its distance.
    const others = (model.roadsData && model.roadsData.others) || [];
    others.slice(0, 60).forEach((o) => {
      (o.geoms || []).forEach((g) => {
        const latlngs = g.map((pt) => [pt.lat, pt.lon]);
        if (latlngs.length < 2) return;
        L.polyline(latlngs, { color: "#9aa3af", weight: 2, opacity: .7 }).addTo(roadNetLayer)
          .bindPopup(`<strong>${esc(o.name)}</strong><br><small>${roadClassLabel(o.highway)} · ${distM(o.meters)} from centre</small>`);
      });
    });

    // The road network — the root. Every main road drawn (white casing under a
    // class colour), the connector to the nearest road, and the junction nodes
    // where roads unite people. Drawn under the pins so anchors stay tappable.
    const roads = (model.roadsData && model.roadsData.roads) || [];
    roads.slice(0, 12).forEach((r, idx) => {
      const col = roadColor(r.highway), lead = idx === 0;
      (r.geoms || []).forEach((g) => {
        const latlngs = g.map((pt) => [pt.lat, pt.lon]);
        if (latlngs.length < 2) return;
        L.polyline(latlngs, { color: "#fff", weight: lead ? 7 : 5, opacity: .85, interactive: false }).addTo(roadNetLayer);
        L.polyline(latlngs, { color: col, weight: lead ? 4.5 : 3, opacity: .95 }).addTo(roadNetLayer)
          .bindPopup(`<strong>${esc(r.name)}</strong><br><small>${roadClassLabel(r.highway)} road · ${distM(r.meters)} from centre</small>`);
      });
    });
    const nr = roads[0];
    if (nr && nr.near && Number.isFinite(nr.near.lat) && nr.meters > 15) {
      L.polyline([[center.lat, center.lng], [nr.near.lat, nr.near.lng]],
        { color: "#0a6f4d", weight: 2, opacity: .85, dashArray: "4 5", interactive: false }).addTo(roadNetLayer);
      L.marker([nr.near.lat, nr.near.lng], { interactive: false,
        icon: L.divIcon({ className: "", html: `<div class="fr-roadtag">${distM(nr.meters)}</div>`, iconSize: [1, 1] }) }).addTo(roadNetLayer);
    }
    const junctions = (model.roadsData && model.roadsData.junctions) || [];
    junctions.slice(0, 6).forEach((j) => {
      const icon = L.divIcon({ className: "", html: `<div class="fr-jnode">◆</div>`, iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -12] });
      L.marker([j.lat, j.lng], { icon }).addTo(roadNetLayer)
        .bindPopup(`<strong>Road node</strong><br><small>${j.roads.slice(0, 3).map(esc).join(" × ")}<br>${distM(j.meters)} from centre — where people &amp; money meet</small>`);
    });

    // Magnet pins (teardrops, coloured by class).
    for (const p of model.pins) {
      const m = MAGNETS[p.cls];
      const icon = L.divIcon({
        className: "", html: `<div class="fr-pin" style="background:${m.color}"><span>${m.emoji}</span></div>`,
        iconSize: [26, 26], iconAnchor: [13, 26], popupAnchor: [0, -24],
      });
      L.marker([p.lat, p.lng], { icon }).addTo(magnetLayer)
        .bindPopup(`<strong>${esc(p.name)}</strong><br><small>${m.label} magnet</small>`);
    }

    // Top destinations — where daily people go. Gold halo on the anchor + a gold
    // dashed line to the main road people use to reach it ("where they start").
    const dests = model.destinations || [];
    for (const d of dests) {
      if (d.access && d.access.near && Number.isFinite(d.access.near.lat) && d.access.meters > 15) {
        L.polyline([[d.lat, d.lng], [d.access.near.lat, d.access.near.lng]],
          { color: "#f0a92e", weight: 2.5, opacity: .9, dashArray: "5 5", interactive: false }).addTo(roadNetLayer);
      }
      L.circleMarker([d.lat, d.lng], { radius: 13, color: "#f0a92e", weight: 3, fill: false, opacity: .95 }).addTo(roadNetLayer)
        .bindPopup(`<strong>${esc(d.name)}</strong><br><small>${esc(destLabel(d.tag))} — a top daily destination` +
          (d.access && d.access.road ? `<br>Reached via ${esc(d.access.road.name)} · ${distM(d.access.meters)}` : "") + `</small>`);
    }

    // Pawa's own listings (round green dots) — each measured to the nearest road
    // of ANY kind (the street it sits on) AND to the nearest carrying road, so an
    // agent can pick a house by how close it is to both.
    const mainSet = (model.roadsData && model.roadsData.roads) || [];
    const allSet = mainSet.concat(others);
    for (const o of model.ownPins) {
      const any = (window.pawaRoads && window.pawaRoads.nearestInSet) ? window.pawaRoads.nearestInSet(o, allSet) : null;
      const main = (window.pawaRoads && window.pawaRoads.nearestInSet) ? window.pawaRoads.nearestInSet(o, mainSet) : null;
      if (any && any.near && Number.isFinite(any.near.lat) && any.meters > 12) {
        L.polyline([[o.lat, o.lng], [any.near.lat, any.near.lng]],
          { color: "#0a6f4d", weight: 1.5, opacity: .6, dashArray: "3 5", interactive: false }).addTo(ownLayer);
      }
      const icon = L.divIcon({
        className: "", html: `<div class="fr-pin own"><span>${o.emoji}</span></div>`,
        iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -12],
      });
      const lines = [`<strong>${esc(o.title)}</strong>`, `<small>Pawa ${esc(o.kind)}</small>`];
      if (any && any.road) lines.push(`<small> ${distM(any.meters)} to ${esc(any.road.name)}</small>`);
      if (main && main.road && (!any || main.road.name !== (any.road && any.road.name)))
        lines.push(`<small> ${distM(main.meters)} to ${esc(main.road.name)} (main)</small>`);
      if (o.href) lines.push(`<a href="${esc(o.href)}">View ${o.kind === "frame" ? "frame" : o.kind} →</a>`);
      const mk = L.marker([o.lat, o.lng], { icon }).addTo(ownLayer).bindPopup(lines.join("<br>"));
      if (o.kind === "frame" && o.id) {
        frameMarkers[o.id] = mk;               // row tap → highlight this pin
        mk.on("click", () => flashFrameRow(o.id));   // pin tap → flash its row
        if (HOVER_SYNC) {                            // desktop: hover a pin → sync its row
          mk.on("mouseover", () => setRowSync(o.id, true));
          mk.on("mouseout", () => setRowSync(o.id, false));
        }
      }
    }

    // ★ Best spot to list — a bright star where a new listing would sit in front
    // of the most customers (near a top destination AND on a carrying road).
    lastBest = null; bestMarker = null;
    if (model.best && model.best.c) {
      const b = model.best, c = b.c, rn = (b.r.acc && b.r.acc.road && b.r.acc.road.name) || (c.onRoad && c.onRoad.name) || "a main road";
      lastBest = { lat: c.lat, lng: c.lng };
      const icon = L.divIcon({ className: "", html: `<div class="fr-best-pin">★</div>`, iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -16] });
      bestMarker = L.marker([c.lat, c.lng], { icon, zIndexOffset: 1000 }).addTo(ownLayer)
        .bindPopup(`<strong>★ Best spot to list</strong><br><small>On ${esc(rn)}` +
          (b.r.nearest ? `, ~${distM(Math.round(b.r.nearest.km * 1000))} from ${esc(b.r.nearest.d.name)}` : "") +
          `<br>In front of the daily customer flow.</small>`);
    }

    if (centerMarker) map.removeLayer(centerMarker);
    centerMarker = L.circleMarker([center.lat, center.lng], {
      radius: 7, color: "#fff", weight: 2, fillColor: "#0a6f4d", fillOpacity: 1,
    }).addTo(map).bindPopup("Frame centre");

    try { map.fitBounds(L.circle([center.lat, center.lng], { radius: radiusM }).getBounds().pad(0.15)); } catch (_) {}
  }

  // ---- orchestration -------------------------------------------------------
  async function buildFrame() {
    if (!center || busy) return;
    busy = true;
    setHint(`Reading the frame around this spot <span class="fr-loading"></span>`);
    showLoading();

    // Fire the slow, independent reads together.
    const [mag, ownAll, demand, areaName, roadsData, boundary, catchment] = await Promise.all([
      readMagnets(center, radiusM),
      loadOwn(),
      loadDemand(center, radiusM),
      reverseName(center),
      (window.pawaRoads ? window.pawaRoads.around(center, radiusM).catch(() => ({ roads: [], junctions: [] })) : Promise.resolve({ roads: [], junctions: [] })),
      (window.pawaGeo ? window.pawaGeo.boundary({ lat: center.lat, lng: center.lng }).catch(() => null) : Promise.resolve(null)),
      readUniversityCatchment(center).catch(() => ({ unis: [], nearest: null, score: 0 })),
    ]);
    // The nearest main road stays the headline "the river"; the full network +
    // junctions drive the road-access score and the new Roads & nodes card.
    const road = (roadsData.roads && roadsData.roads[0]) || null;

    const roomsIn = within(ownAll.houses, center, radiusM);
    const servicesIn = within(ownAll.services, center, radiusM);
    const trucksIn = within(ownAll.trucks, center, radiusM);
    const jobsIn = within(ownAll.jobs, center, radiusM);
    const demandIn = within(demand || [], center, radiusM);

    const supply = roomsIn.length + servicesIn.length + trucksIn.length;
    const dom = dominant(mag.counts);

    const partial = {
      counts: mag.counts, serviceCount: mag.serviceCount, road, roadsData, catchment,
      supply, demandCount: demandIn.length, jobsIn: jobsIn.length,
    };
    const sc = score(partial);

    const ownPins = []
      .concat(roomsIn.map((h) => ({ lat: +h.lat, lng: +h.lng, title: h.title || "Frame", kind: "frame", emoji: "", id: h.id, href: h.id ? `house.html?id=${encodeURIComponent(h.id)}` : null })))
      .concat(servicesIn.map((s) => ({ lat: +s.lat, lng: +s.lng, title: s.title || "Service", kind: "service", emoji: "" })))
      .concat(trucksIn.map((t) => ({ lat: +t.lat, lng: +t.lng, title: t.title || "Truck", kind: "truck", emoji: "" })))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

    // Most-visited destinations (universities, markets, bus stands…) + the road
    // people use to reach each — the customer-flow read.
    const destinations = buildDestinations(mag.pins, roadsData.roads || []);
    // The single best point to plant a new listing (near a top destination + on a road).
    const best = bestSpot(destinations, roadsData);

    // The frames (business spaces) here, each measured to its nearest road — so
    // the gap panel can list every business space, closest-to-a-road first.
    const allRoads = (roadsData.roads || []).concat(roadsData.others || []);
    const nis = (window.pawaRoads && window.pawaRoads.nearestInSet) || null;
    const frames = roomsIn.map((h) => {
      const acc = nis ? nis({ lat: +h.lat, lng: +h.lng }, allRoads) : null;
      return {
        id: h.id, title: h.title || "Frame", type: h.type || "",
        priceTzs: Number(h.price_tzs) || 0, listing: h.listing || "rent", period: h.period || "month",
        roadName: acc && acc.road ? acc.road.name : null, roadM: acc ? acc.meters : null,
        href: h.id ? `house.html?id=${encodeURIComponent(h.id)}` : null,
      };
    }).sort((a, b) => (a.roadM == null ? 1e9 : a.roadM) - (b.roadM == null ? 1e9 : b.roadM));

    const model = {
      areaName, counts: mag.counts, serviceCount: mag.serviceCount, road, roadsData, catchment, sc, dom, destinations, best, frames,
      magnetPull: sc.magnetPull, supply, demandCount: demandIn.length, jobsIn: jobsIn.length,
      rooms: roomsIn.length, servicesN: servicesIn.length, trucksN: trucksIn.length,
      pins: mag.pins, ownPins, boundaryGeo: boundary && boundary.geojson,
    };

    renderPanel(model);
    drawFrame(model);
    setHint(mag.ok
      ? `Frame read. Tap another spot on the map, search a place, or change the frame size to read elsewhere.`
      : `Map data (OSM) was slow to answer, so magnets may be incomplete — Pawa's own listings & demand are still shown. Try again or pick another spot.`);
    busy = false;
  }

  function showLoading() {
    const panel = $("frPanel");
    if (panel) panel.innerHTML =
      `<div class="fr-empty"><h3>Reading the frame<span class="fr-loading"></span></h3>
       <p>Counting magnets, measuring the carrying road, and matching Pawa's own demand &amp; supply on this spot.</p></div>`;
  }
  function setHint(html) { const h = $("frHint"); if (h) h.innerHTML = html; }

  async function reverseName(c) {
    if (!window.pawaGeo) return "";
    try {
      const j = await window.pawaGeo.reverse(`format=json&zoom=16&addressdetails=1&lat=${c.lat}&lon=${c.lng}`);
      const a = (j && j.address) || {};
      const near = a.suburb || a.neighbourhood || a.quarter || a.ward || a.residential || a.village || a.city_district;
      const district = a.municipality || a.county || a.city_district || a.city || a.town;
      const region = a.state || a.region;
      return [near, district, region].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).slice(0, 3).join(", ");
    } catch (_) { return ""; }
  }

  function setCenter(c) {
    center = { lat: +c.lat, lng: +c.lng };
    if (map) { try { map.setView([center.lat, center.lng], Math.max(map.getZoom(), 13)); } catch (_) {} }
    buildFrame();
  }

  // ---- input handlers ------------------------------------------------------
  async function searchPlace() {
    const input = $("frSearch"), btn = $("frSearchBtn");
    const q = (input?.value || "").trim();
    if (!q) { input?.focus(); return; }
    const old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Finding…"; }
    try {
      // Gazetteer-first if the page bundled tz-places, else LocationIQ suggest.
      let hit = null;
      if (window.pawaResolvePlace) {
        const r = await window.pawaResolvePlace(q).catch(() => null);
        if (r && Number.isFinite(r.lat) && Number.isFinite(r.lng)) hit = r;
      }
      if (!hit) {
        const hits = await (window.pawaGeo ? window.pawaGeo.suggest(q, { limit: 5 }) : Promise.resolve([])).catch(() => []);
        hit = (hits || []).find((h) => Number.isFinite(h.lat) && Number.isFinite(h.lng)) || null;
      }
      if (!hit) { setHint(`Couldn't find “${esc(q)}” — try a town, ward or landmark name.`); return; }
      setCenter({ lat: hit.lat, lng: hit.lng });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old; }
    }
  }

  async function locateMe() {
    const btn = $("frLocateBtn"), span = btn && btn.querySelector("span");
    const idle = span ? span.textContent : "My location";
    if (btn) btn.disabled = true; if (span) span.textContent = "Locating…";
    try {
      const fix = await window.pawaLocate.bestOrApprox({ targetAccuracy: 50, maxWaitMs: 12000 });
      if (span) span.textContent = fix.approximate ? "Approx. spot" : "My location";
      setCenter({ lat: fix.lat, lng: fix.lng });
    } catch (e) {
      if (span) span.textContent = idle;
      alert(window.pawaLocate ? window.pawaLocate.message(e) : ((e && e.message) || "Couldn't get your location."));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function switchView(view) {
    const stage = $("frStage");
    if (!stage) return;
    stage.dataset.view = view;
    $("frTabPanel")?.classList.toggle("active", view === "panel");
    $("frTabMap")?.classList.toggle("active", view === "map");
    if (view === "map") setTimeout(() => map && map.invalidateSize(), 60);
  }

  // ---- init ----------------------------------------------------------------
  function init() {
    radiusM = parseInt(($("frRadius") && $("frRadius").value) || "1500", 10);
    initMap();

    $("frSearchBtn")?.addEventListener("click", searchPlace);
    $("frSearch")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); searchPlace(); } });
    $("frLocateBtn")?.addEventListener("click", locateMe);
    $("frRadius")?.addEventListener("change", (e) => {
      radiusM = parseInt(e.target.value, 10) || 1500;
      if (center) buildFrame();
    });
    $("frTabPanel")?.addEventListener("click", () => switchView("panel"));
    $("frTabMap")?.addEventListener("click", () => switchView("map"));

    // Warm Pawa's own data so the first frame reads fast.
    loadOwn();
  }

  window.initFramePage = init;
})();
