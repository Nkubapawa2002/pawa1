/* ===========================================================================
 * explore-index.js — the one catalogue behind the Explore tab.
 *
 * Everything the site offers lives in four tables that were designed
 * separately and share almost nothing: houses, trucks, services, day_jobs.
 * Explore has to search across all of them at once, rank them against each
 * other, and match a room to the trucks near it. None of that is possible
 * while a room is `price_tzs/period` and a job is `pay_tzs/pay_note`.
 *
 * So this file does exactly one thing: it flattens all four into ONE shape,
 * and nothing downstream ever sees a raw row again. The ranker, the matcher
 * and the screen all speak `Item`.
 *
 * WHAT AN ITEM IS
 *   kind      'room' | 'truck' | 'service' | 'job'   — the vertical
 *   id, title, href                                  — identity + where to go
 *   price, priceUnit                                 — normalised to TZS
 *   lat, lng, region, area                           — the geo anchor
 *   facets                                           — the per-kind specifics
 *   text                                             — lowercased search blob
 *
 * WHY NORMALISE IN THE BROWSER AND NOT IN SQL
 *   A database view over four tables would be tidier, but it would also make
 *   Explore the only page that cannot work from the bundled JSON fallback —
 *   and a directory that goes blank when Supabase hiccups is worse than one
 *   that ranks a little less precisely. DataStore already owns the
 *   Supabase-then-JSON dance for three of the four; this rides on it.
 *
 * COST
 *   One pass over every listing, memoised for the page's lifetime. Tanzania's
 *   whole catalogue is thousands of rows, not millions — small enough that
 *   ranking in JS beats a round trip, and small enough that the honest answer
 *   to "why not paginate server-side?" is: it would be slower.
 * =========================================================================== */
(function () {
  "use strict";

  var KINDS = ["room", "truck", "service", "job"];

  // Per-vertical identity. The colours are the ones index.html already uses
  // for its category tabs, so a truck is the same gold everywhere on the site.
  var KIND_META = {
    room:    { label: "Rooms & homes", one: "Room",    accent: "#2EE6A6", rgb: "46,230,166" },
    truck:   { label: "Trucks",        one: "Truck",   accent: "#F6C45A", rgb: "246,196,90" },
    service: { label: "Services",      one: "Service", accent: "#A855F7", rgb: "168,85,247" },
    job:     { label: "Day jobs",      one: "Job",     accent: "#FF8A4C", rgb: "255,138,76" },
  };

  var SERVICE_LABEL = {
    cleaning: "Cleaning", plumbing: "Plumbing", electrical: "Electrical",
    carpentry: "Carpentry", painting: "Painting", gardening: "Gardening",
    moving_help: "Moving help", laundry: "Laundry", cooking: "Cooking",
    tutoring: "Tutoring", beauty: "Beauty", security: "Security",
    childcare: "Childcare", appliance_repair: "Appliance repair", other: "Service",
  };

  function ds() { return window.DataStore || null; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function str(v) { return v == null ? "" : String(v); }

  // A listing without coordinates cannot be ranked by distance or matched to
  // anything nearby. It is NOT dropped — plenty of real listings only name an
  // area — but the ranker needs to know, so this is explicit rather than a
  // pair of silent nulls.
  function hasPin(lat, lng) {
    return isFinite(lat) && isFinite(lng) && (lat !== 0 || lng !== 0);
  }

  // The search blob. Everything a person might type is folded in once, here,
  // so matching never has to know which field a word came from. Field weight
  // is the ranker's job (see explore-rank.js) — this is just the corpus.
  function blob(parts) {
    return parts.filter(Boolean).join(" ").toLowerCase().replace(/\s+/g, " ").trim();
  }

  // ---- Normalisers ----------------------------------------------------------
  // One per table. Each is a pure row → Item, and each is the ONLY place that
  // knows that table's column names.

  function fromHouse(h) {
    var lat = num(h.lat), lng = num(h.lng);
    // room_kind names ONE room, and a listing can hold up to twenty-four. A
    // plot with three singles and a master reads "single" in the column, so
    // searching Explore for "master" used to miss it — with a master room
    // standing empty. HouseSpec.roomWords() says every category the spec sheet
    // actually offers, in both languages. It is optional here: explore.html
    // does not need house-spec.js loaded for the rest of the index to work.
    var sheetWords = window.HouseSpec ? window.HouseSpec.roomWords(h) : [];
    var kindWords = [h.type, h.listing === "rent" ? "for rent kupanga" : "for sale kuuza",
                     h.room_kind === "master" ? "master self contained" : "",
                     h.room_kind === "single" ? "single room chumba kimoja" : ""]
                    .concat(sheetWords);
    return {
      kind: "room",
      id: str(h.id),
      title: str(h.title),
      href: "house.html?id=" + encodeURIComponent(str(h.id)),
      photo: ds() ? ds().housePhotoUrl(h.photo) : "",
      price: num(h.price_tzs) || 0,
      priceUnit: h.listing === "sale" ? "total" : (str(h.period) || "month"),
      lat: lat, lng: lng, pinned: hasPin(lat, lng),
      region: str(h.region), area: str(h.area) || str(h.ward) || str(h.district),
      address: str(h.address),
      verified: !!h.verified,
      createdAt: h.created_at || null,
      ownerId: h.owner_user_id || null,
      facets: {
        type: str(h.type), listing: str(h.listing),
        bedrooms: num(h.bedrooms) || 0, bathrooms: num(h.bathrooms) || 0,
        roomKind: str(h.room_kind), sizeSqm: num(h.size_sqm),
        furnished: str(h.furnished), amenities: h.amenities || [],
      },
      text: blob([h.title, h.type, h.area, h.ward, h.district, h.region,
                  h.address, h.description, (h.amenities || []).join(" ")].concat(kindWords)),
    };
  }

  function fromTruck(t) {
    var lat = num(t.lat), lng = num(t.lng);
    return {
      kind: "truck",
      id: str(t.id),
      title: str(t.title),
      href: "truck.html?id=" + encodeURIComponent(str(t.id)),
      photo: ds() ? ds().truckPhotoUrl(t.photo) : "",
      price: num(t.price_tzs) || 0,
      priceUnit: str(t.period) || "trip",
      lat: lat, lng: lng, pinned: hasPin(lat, lng),
      region: str(t.region), area: str(t.area) || str(t.ward) || str(t.district),
      address: str(t.address),
      verified: !!t.verified,
      createdAt: t.created_at || null,
      ownerId: t.owner_user_id || null,
      facets: {
        truckType: str(t.truck_type),
        capacityT: num(t.capacity_tonnes),
        serviceArea: str(t.service_area),
        driverIncluded: !!t.driver_included,
        loadersIncluded: !!t.loaders_included,
        negotiable: !!t.negotiable,
      },
      // "lori", "gari la mizigo" and "kuhamisha" are what people actually type.
      text: blob([t.title, t.truck_type, t.area, t.ward, t.district, t.region,
                  t.address, t.description,
                  "truck lori gari la mizigo moving kuhamisha kubeba",
                  t.loaders_included ? "loaders wapakiaji" : "",
                  t.capacity_tonnes ? t.capacity_tonnes + " tonne tani" : ""]),
    };
  }

  function fromService(s) {
    var lat = num(s.lat), lng = num(s.lng);
    var cat = str(s.category);
    return {
      kind: "service",
      id: str(s.id),
      title: str(s.title),
      href: "service.html?id=" + encodeURIComponent(str(s.id)),
      photo: ds() ? ds().servicePhotoUrl(s.photo) : "",
      price: num(s.price_tzs) || 0,
      priceUnit: str(s.rate_type) || "per_job",
      lat: lat, lng: lng, pinned: hasPin(lat, lng),
      region: str(s.region), area: str(s.area),
      address: str(s.address),
      verified: !!s.verified,
      createdAt: s.created_at || null,
      ownerId: s.owner_user_id || null,
      facets: {
        category: cat, categoryLabel: SERVICE_LABEL[cat] || "Service",
        rateType: str(s.rate_type), experienceYears: num(s.experience_years),
        serviceArea: str(s.service_area), availability: str(s.availability),
        negotiable: !!s.negotiable,
      },
      text: blob([s.title, cat, SERVICE_LABEL[cat], s.area, s.region, s.address,
                  s.description, s.availability, serviceSynonyms(cat), "fundi service huduma"]),
    };
  }

  function fromJob(j) {
    var lat = num(j.lat), lng = num(j.lng);
    return {
      kind: "job",
      id: "job-" + str(j.id),
      title: str(j.title),
      // There is no job detail page — jobs.html deep-links to the card.
      href: "jobs.html#job-" + encodeURIComponent(str(j.id)),
      photo: "",
      price: num(j.pay_tzs) || 0,
      priceUnit: "per worker",
      lat: lat, lng: lng, pinned: hasPin(lat, lng),
      region: str(j.region), area: str(j.area),
      address: "",
      verified: false,
      createdAt: j.created_at || null,
      ownerId: null,
      facets: {
        company: str(j.company_name), phone: str(j.company_phone),
        workersNeeded: num(j.workers_needed) || 1,
        claimed: num(j.claimed_count) || 0,
        spotsLeft: Math.max(0, (num(j.workers_needed) || 1) - (num(j.claimed_count) || 0)),
        workDate: j.work_date || null, timeNote: str(j.time_note),
        payNote: str(j.pay_note), requirements: str(j.requirements),
      },
      text: blob([j.title, j.description, j.requirements, j.company_name,
                  j.area, j.region, j.pay_note, j.time_note,
                  "job kazi ajira vibarua work siku"]),
    };
  }

  // The category codes are English enum values, but half the country searches
  // in Swahili and the other half types the trade, not the category. Folding
  // both into the blob is what makes "fundi umeme" find an `electrical`.
  function serviceSynonyms(cat) {
    return ({
      cleaning: "usafi kusafisha cleaner maid dada wa kazi",
      plumbing: "mabomba bomba fundi maji plumber",
      electrical: "umeme fundi umeme electrician wiring",
      carpentry: "seremala useremala carpenter fundi mbao furniture",
      painting: "rangi kupaka rangi painter",
      gardening: "bustani shamba mtunza bustani gardener landscaping",
      moving_help: "kupakia kuhamisha wapakiaji loaders movers porter",
      laundry: "dobi kufua nguo washing",
      cooking: "mpishi kupika chef cook catering",
      tutoring: "mwalimu kufundisha teacher tuition masomo",
      beauty: "urembo saluni salon kinyozi barber hair",
      security: "ulinzi mlinzi guard askari",
      childcare: "yaya kulea mtoto nanny babysitter",
      appliance_repair: "kutengeneza friji tv fundi vifaa repair technician",
      other: "",
    })[cat] || "";
  }

  // ---- Load -----------------------------------------------------------------
  var memo = null;

  /**
   * Every listing on the site, normalised, in one array.
   *
   * A vertical that fails to load is skipped, not fatal: Explore showing three
   * of four catalogues is a far better answer than an error page. Which ones
   * came back is reported in `.sources` so the screen can say so honestly
   * rather than implying the missing vertical is simply empty.
   *
   * @returns {Promise<{items:Array, sources:Object, counts:Object}>}
   */
  async function load(opts) {
    opts = opts || {};
    if (memo && !opts.fresh) return memo;
    var store = ds();
    if (!store) return { items: [], sources: {}, counts: {} };

    var jobs = [
      ["room",    store.getHouses.bind(store),   fromHouse],
      ["truck",   store.getTrucks.bind(store),   fromTruck],
      ["service", store.getServices.bind(store), fromService],
      ["job",     store.getDayJobs ? store.getDayJobs.bind(store) : null, fromJob],
    ];

    var settled = await Promise.all(jobs.map(async function (j) {
      var kind = j[0], fetcher = j[1], map = j[2];
      if (!fetcher) return { kind: kind, ok: false, rows: [] };
      try {
        var rows = await fetcher({ fresh: !!opts.fresh });
        return { kind: kind, ok: true, rows: (rows || []).map(map) };
      } catch (e) {
        console.warn("[explore] " + kind + " failed to load:", (e && e.message) || e);
        return { kind: kind, ok: false, rows: [] };
      }
    }));

    var items = [], sources = {}, counts = {};
    settled.forEach(function (s) {
      sources[s.kind] = s.ok;
      counts[s.kind] = s.rows.length;
      // A row with no title is a broken record, not a listing — it can never
      // be a useful search result, so it never enters the corpus.
      s.rows.forEach(function (it) { if (it.title) items.push(it); });
    });

    memo = { items: items, sources: sources, counts: counts, at: Date.now() };
    return memo;
  }

  function invalidate() { memo = null; }

  window.ExploreIndex = {
    KINDS: KINDS,
    KIND_META: KIND_META,
    SERVICE_LABEL: SERVICE_LABEL,
    load: load,
    invalidate: invalidate,
    // Exposed for tests and for the matcher, which builds items on the fly.
    fromHouse: fromHouse, fromTruck: fromTruck,
    fromService: fromService, fromJob: fromJob,
  };
})();
