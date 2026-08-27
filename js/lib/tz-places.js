// Shared dataset of Tanzanian places used by ride.js and meet.js
// Keep coordinates as approximate centroids — good enough for map markers.

window.TZ_UNIVERSITIES = [
  // Dar es Salaam
  { name: "University of Dar es Salaam (UDSM)",                   kind: "university", city: "Dar es Salaam", lat: -6.7798, lng: 39.2069 },
  { name: "Muhimbili University of Health & Allied Sciences",     kind: "university", city: "Dar es Salaam", lat: -6.8094, lng: 39.2784 },
  { name: "Ardhi University",                                     kind: "university", city: "Dar es Salaam", lat: -6.7733, lng: 39.2103 },
  { name: "Open University of Tanzania",                          kind: "university", city: "Dar es Salaam", lat: -6.8369, lng: 39.2697 },
  { name: "Hubert Kairuki Memorial University",                   kind: "university", city: "Dar es Salaam", lat: -6.7600, lng: 39.2350 },
  { name: "International Medical & Technological University",     kind: "university", city: "Dar es Salaam", lat: -6.7980, lng: 39.2540 },
  { name: "Kampala International University - Dar es Salaam",     kind: "university", city: "Dar es Salaam", lat: -6.8161, lng: 39.2803 },
  { name: "Dar es Salaam Tumaini University",                     kind: "university", city: "Dar es Salaam", lat: -6.8210, lng: 39.2770 },
  { name: "Dar es Salaam Institute of Technology (DIT)",          kind: "institute",  city: "Dar es Salaam", lat: -6.8167, lng: 39.2833 },
  { name: "Institute of Finance Management (IFM)",                kind: "institute",  city: "Dar es Salaam", lat: -6.8169, lng: 39.2871 },
  { name: "College of Business Education (CBE)",                  kind: "college",    city: "Dar es Salaam", lat: -6.8156, lng: 39.2809 },
  { name: "National Institute of Transport (NIT)",                kind: "institute",  city: "Dar es Salaam", lat: -6.8240, lng: 39.2440 },
  { name: "Tanzania Institute of Accountancy (TIA)",              kind: "institute",  city: "Dar es Salaam", lat: -6.8196, lng: 39.2800 },
  // Almost nobody types this one's legal name. It is "Mwl. Nyerere" on the sign,
  // "Mwalimu Nyerere University" in conversation, and LocationIQ cannot geocode
  // any of those — the online geocoder answers "Unable to geocode" for the full
  // name and returns a DIFFERENT institute 800 km away in Tabora for the short
  // one. So the ways people actually say it are listed here, where the local
  // matcher can reach them without a round trip.
  { name: "Mwalimu Nyerere Memorial Academy (Kigamboni)",         kind: "university", city: "Dar es Salaam", lat: -6.8265, lng: 39.3055, aliases: ["mwalimu nyerere", "mwl nyerere", "mwalimu nyerere university", "mwl nyerere university", "nyerere academy", "mnma", "kivukoni academy", "chuo cha mwalimu nyerere", "kigamboni ferry academy"] },

  // Morogoro
  { name: "Sokoine University of Agriculture (SUA)",              kind: "university", city: "Morogoro",      lat: -6.8489, lng: 37.6533 },
  { name: "Mzumbe University",                                    kind: "university", city: "Morogoro",      lat: -6.9158, lng: 37.4944 },
  { name: "Jordan University College",                            kind: "college",    city: "Morogoro",      lat: -6.8167, lng: 37.6833 },

  // Dodoma
  { name: "University of Dodoma (UDOM)",                          kind: "university", city: "Dodoma",        lat: -6.1810, lng: 35.7780 },
  { name: "St. John's University of Tanzania",                    kind: "university", city: "Dodoma",        lat: -6.1660, lng: 35.7480 },
  { name: "College of Business Education - Dodoma",               kind: "college",    city: "Dodoma",        lat: -6.1700, lng: 35.7390 },

  // Arusha / Kilimanjaro region
  { name: "Nelson Mandela African Institute of Science & Tech.",  kind: "institute",  city: "Arusha",        lat: -3.4032, lng: 36.7867 },
  { name: "Mount Meru University",                                kind: "university", city: "Arusha",        lat: -3.3700, lng: 36.6900 },
  { name: "Tumaini University Makumira",                          kind: "university", city: "Usa River",     lat: -3.3300, lng: 36.8900 },
  { name: "Institute of Accountancy Arusha (IAA)",                kind: "institute",  city: "Arusha",        lat: -3.3600, lng: 36.6800 },
  { name: "Mwenge Catholic University",                           kind: "university", city: "Moshi",         lat: -3.3500, lng: 37.3300 },
  { name: "Stefano Moshi Memorial University College",            kind: "college",    city: "Moshi",         lat: -3.3300, lng: 37.3500 },
  { name: "Kilimanjaro Christian Medical University College",     kind: "college",    city: "Moshi",         lat: -3.3520, lng: 37.3440 },

  // Mwanza
  { name: "St. Augustine University of Tanzania (SAUT)",          kind: "university", city: "Mwanza",        lat: -2.5717, lng: 32.8967 },
  { name: "Catholic University of Health & Allied Sciences",      kind: "university", city: "Mwanza",        lat: -2.5169, lng: 32.9192 },
  { name: "Bugando University - College",                         kind: "college",    city: "Mwanza",        lat: -2.5160, lng: 32.9180 },

  // Mara — the OTHER university named after Nyerere. Listed so that a search for
  // "Nyerere university" offers both and the nearer one wins, instead of one of
  // them being silently unreachable.
  { name: "Mwalimu Julius K. Nyerere University of Agriculture & Technology (MJNUAT)", kind: "university", city: "Butiama", lat: -1.7667, lng: 34.0167, aliases: ["mjnuat", "nyerere university of agriculture", "butiama university"] },

  // Iringa
  { name: "University of Iringa",                                 kind: "university", city: "Iringa",        lat: -7.7700, lng: 35.7000 },
  { name: "Mkwawa University College of Education (MUCE)",        kind: "college",    city: "Iringa",        lat: -7.7670, lng: 35.6790 },
  { name: "Ruaha Catholic University (RUCU)",                     kind: "university", city: "Iringa",        lat: -7.7730, lng: 35.6900 },

  // Mbeya
  { name: "Mbeya University of Science & Technology",             kind: "university", city: "Mbeya",         lat: -8.9180, lng: 33.4520 },
  { name: "Teofilo Kisanji University",                           kind: "university", city: "Mbeya",         lat: -8.9050, lng: 33.4500 },

  // Tanga / Zanzibar / Mtwara / Bukoba / Tabora
  { name: "Eckernforde Tanga University",                         kind: "university", city: "Tanga",         lat: -5.0700, lng: 39.0950 },
  { name: "State University of Zanzibar (SUZA)",                  kind: "university", city: "Zanzibar",      lat: -6.1663, lng: 39.2026 },
  { name: "Zanzibar University",                                  kind: "university", city: "Zanzibar",      lat: -6.1340, lng: 39.2070 },
  { name: "Stella Maris Mtwara University College",               kind: "college",    city: "Mtwara",        lat: -10.2667,lng: 40.1833 },
  { name: "Kampala International University - Bukoba",            kind: "college",    city: "Bukoba",        lat: -1.3300, lng: 31.8120 },
  { name: "Tabora Teachers College",                              kind: "college",    city: "Tabora",        lat: -5.0200, lng: 32.8030 },
];

// Famous non-university landmarks people actually type when searching for an
// area: malls, airports, hospitals, markets, transport hubs and stadiums. These
// give the Houses alert / commute / near-me search an EXACT pin instantly
// (gazetteer-first) instead of waiting on — and sometimes mis-resolving with —
// the online geocoder. `aliases` lists the short/common names users type.
// Coordinates are approximate centroids — fine for "rank/alert near this spot".
window.TZ_LANDMARKS = [
  // ---- Dar es Salaam — malls & shopping ----
  { name: "Mlimani City Mall", kind: "mall", city: "Dar es Salaam", lat: -6.7726, lng: 39.2389, aliases: ["mlimani city", "mlimani mall"] },
  { name: "Mwenge", kind: "area", city: "Dar es Salaam", lat: -6.7686, lng: 39.2249, aliases: ["mwenge"] },
  { name: "Quality Center Mall (Mikocheni)", kind: "mall", city: "Dar es Salaam", lat: -6.7642, lng: 39.2613, aliases: ["quality center", "quality centre"] },
  { name: "Msasani Slipway", kind: "mall", city: "Dar es Salaam", lat: -6.7470, lng: 39.2770, aliases: ["slipway", "msasani slipway"] },
  { name: "GSM Mall (Mbezi Beach)", kind: "mall", city: "Dar es Salaam", lat: -6.7270, lng: 39.2230, aliases: ["gsm mall", "gsm"] },
  // ---- Dar es Salaam — civic / transport / markets ----
  { name: "Posta (City Centre)", kind: "area", city: "Dar es Salaam", lat: -6.8147, lng: 39.2895, aliases: ["posta", "city centre", "city center", "mjini"] },
  { name: "Kariakoo Market", kind: "market", city: "Dar es Salaam", lat: -6.8203, lng: 39.2756, aliases: ["kariakoo"] },
  { name: "Kivukoni Ferry Terminal", kind: "transport", city: "Dar es Salaam", lat: -6.8160, lng: 39.2900, aliases: ["kivukoni", "kivukoni ferry"] },
  { name: "Ubungo Bus Terminal", kind: "transport", city: "Dar es Salaam", lat: -6.8038, lng: 39.2206, aliases: ["ubungo", "ubungo terminal", "ubungo bus stand"] },
  { name: "Magufuli Bus Terminal (Mbezi)", kind: "transport", city: "Dar es Salaam", lat: -6.7430, lng: 39.1480, aliases: ["magufuli terminal", "mbezi terminal", "mbezi bus"] },
  // ---- Dar es Salaam — hospitals & stadiums ----
  { name: "Muhimbili National Hospital", kind: "hospital", city: "Dar es Salaam", lat: -6.8060, lng: 39.2756, aliases: ["muhimbili", "muhimbili hospital"] },
  { name: "Aga Khan Hospital (Dar)", kind: "hospital", city: "Dar es Salaam", lat: -6.8120, lng: 39.2890, aliases: ["aga khan", "aga khan hospital"] },
  { name: "Benjamin Mkapa National Stadium", kind: "stadium", city: "Dar es Salaam", lat: -6.8662, lng: 39.2589, aliases: ["national stadium", "mkapa stadium", "uwanja wa taifa"] },
  { name: "Uhuru Stadium", kind: "stadium", city: "Dar es Salaam", lat: -6.8210, lng: 39.2730, aliases: ["uhuru stadium"] },
  // ---- Airports (national) ----
  { name: "Julius Nyerere International Airport (JNIA)", kind: "airport", city: "Dar es Salaam", lat: -6.8781, lng: 39.2026, aliases: ["jnia", "dar airport", "uwanja wa ndege dar"] },
  { name: "Kilimanjaro International Airport (KIA)", kind: "airport", city: "Kilimanjaro", lat: -3.4294, lng: 37.0745, aliases: ["kia", "kilimanjaro airport"] },
  { name: "Abeid Amani Karume International Airport", kind: "airport", city: "Zanzibar", lat: -6.2220, lng: 39.2249, aliases: ["zanzibar airport", "karume airport"] },
  { name: "Mwanza Airport", kind: "airport", city: "Mwanza", lat: -2.4445, lng: 32.9327, aliases: ["mwanza airport"] },
  // ---- Other regions — key landmarks ----
  { name: "Kilimanjaro Christian Medical Centre (KCMC)", kind: "hospital", city: "Moshi", lat: -3.3530, lng: 37.3380, aliases: ["kcmc"] },
  { name: "Bugando Medical Centre", kind: "hospital", city: "Mwanza", lat: -2.5160, lng: 32.9180, aliases: ["bugando", "bugando hospital"] },
  { name: "Clock Tower (Arusha)", kind: "area", city: "Arusha", lat: -3.3690, lng: 36.6830, aliases: ["clock tower", "arusha clock tower"] },
  { name: "Stone Town (Zanzibar)", kind: "area", city: "Zanzibar", lat: -6.1620, lng: 39.1920, aliases: ["stone town", "mji mkongwe"] },
  // ---- Dar es Salaam — common residential areas/wards people browse ----
  // These give the Houses area-filter an instant, correct circle (centroids are
  // approximate — fine for a neighbourhood circle the user can resize).
  { name: "Kigamboni", kind: "area", city: "Dar es Salaam", lat: -6.8450, lng: 39.3050, r: 4500, aliases: ["kigamboni"] },
  { name: "Mikocheni", kind: "area", city: "Dar es Salaam", lat: -6.7600, lng: 39.2620, aliases: ["mikocheni"] },
  { name: "Masaki", kind: "area", city: "Dar es Salaam", lat: -6.7430, lng: 39.2810, aliases: ["masaki"] },
  { name: "Oyster Bay", kind: "area", city: "Dar es Salaam", lat: -6.7770, lng: 39.2850, aliases: ["oyster bay", "oysterbay"] },
  { name: "Msasani", kind: "area", city: "Dar es Salaam", lat: -6.7550, lng: 39.2730, aliases: ["msasani"] },
  { name: "Upanga", kind: "area", city: "Dar es Salaam", lat: -6.8050, lng: 39.2880, aliases: ["upanga"] },
  { name: "Sinza", kind: "area", city: "Dar es Salaam", lat: -6.7790, lng: 39.2200, aliases: ["sinza"] },
  { name: "Mwananyamala", kind: "area", city: "Dar es Salaam", lat: -6.7800, lng: 39.2500, aliases: ["mwananyamala"] },
  { name: "Magomeni", kind: "area", city: "Dar es Salaam", lat: -6.8000, lng: 39.2550, aliases: ["magomeni"] },
  { name: "Tabata", kind: "area", city: "Dar es Salaam", lat: -6.8400, lng: 39.2300, aliases: ["tabata"] },
  { name: "Mbezi Beach", kind: "area", city: "Dar es Salaam", lat: -6.7200, lng: 39.2200, aliases: ["mbezi beach", "mbezi"] },
  { name: "Tegeta", kind: "area", city: "Dar es Salaam", lat: -6.6400, lng: 39.2100, aliases: ["tegeta"] },
  { name: "Kimara", kind: "area", city: "Dar es Salaam", lat: -6.7800, lng: 39.1500, aliases: ["kimara"] },
];

// Every region of the United Republic of Tanzania (26 Mainland + 5 Zanzibar),
// at its administrative centre / main town, so the map architecture (instant
// resolve → area circle → spatial filter → distance ranking) works NATIONWIDE,
// not only Dar es Salaam. Typing a region name OR its capital drops a circle
// there. Aliases include the headquarters town and common spellings; anything
// not here still resolves through the online geocoder (pawaGeo.suggest).
window.TZ_REGION_CENTERS = [
  // ---- Mainland ----
  { name: "Arusha",        kind: "region", lat: -3.3869,  lng: 36.6830, aliases: ["arusha"] },
  { name: "Dar es Salaam", kind: "region", lat: -6.8161,  lng: 39.2803, aliases: ["dar es salaam", "dar", "dsm", "mkoa wa dar"] },
  { name: "Dodoma",        kind: "region", lat: -6.1722,  lng: 35.7395, aliases: ["dodoma"] },
  { name: "Geita",         kind: "region", lat: -2.8725,  lng: 32.2300, aliases: ["geita"] },
  { name: "Iringa",        kind: "region", lat: -7.7707,  lng: 35.6920, aliases: ["iringa"] },
  { name: "Kagera",        kind: "region", lat: -1.3320,  lng: 31.8120, aliases: ["kagera", "bukoba"] },
  { name: "Katavi",        kind: "region", lat: -6.3440,  lng: 31.0700, aliases: ["katavi", "mpanda"] },
  { name: "Kigoma",        kind: "region", lat: -4.8769,  lng: 29.6267, aliases: ["kigoma"] },
  { name: "Kilimanjaro",   kind: "region", lat: -3.3349,  lng: 37.3408, aliases: ["kilimanjaro", "moshi"] },
  { name: "Lindi",         kind: "region", lat: -9.9989,  lng: 39.7163, aliases: ["lindi"] },
  { name: "Manyara",       kind: "region", lat: -4.2200,  lng: 35.7470, aliases: ["manyara", "babati"] },
  { name: "Mara",          kind: "region", lat: -1.5000,  lng: 33.8000, aliases: ["mara", "musoma"] },
  { name: "Mbeya",         kind: "region", lat: -8.9094,  lng: 33.4608, aliases: ["mbeya"] },
  { name: "Morogoro",      kind: "region", lat: -6.8278,  lng: 37.6591, aliases: ["morogoro"] },
  { name: "Mtwara",        kind: "region", lat: -10.2667, lng: 40.1833, aliases: ["mtwara"] },
  { name: "Mwanza",        kind: "region", lat: -2.5164,  lng: 32.9175, aliases: ["mwanza"] },
  { name: "Njombe",        kind: "region", lat: -9.3333,  lng: 34.7667, aliases: ["njombe"] },
  { name: "Pwani",         kind: "region", lat: -6.7700,  lng: 38.9150, aliases: ["pwani", "coast", "kibaha"] },
  { name: "Rukwa",         kind: "region", lat: -7.9667,  lng: 31.6167, aliases: ["rukwa", "sumbawanga"] },
  { name: "Ruvuma",        kind: "region", lat: -10.6833, lng: 35.6500, aliases: ["ruvuma", "songea"] },
  { name: "Shinyanga",     kind: "region", lat: -3.6619,  lng: 33.4214, aliases: ["shinyanga"] },
  { name: "Simiyu",        kind: "region", lat: -2.7980,  lng: 33.9890, aliases: ["simiyu", "bariadi"] },
  { name: "Singida",       kind: "region", lat: -4.8167,  lng: 34.7500, aliases: ["singida"] },
  { name: "Songwe",        kind: "region", lat: -9.1000,  lng: 32.9333, aliases: ["songwe", "vwawa"] },
  { name: "Tabora",        kind: "region", lat: -5.0167,  lng: 32.8000, aliases: ["tabora"] },
  { name: "Tanga",         kind: "region", lat: -5.0689,  lng: 39.0988, aliases: ["tanga"] },
  // ---- Zanzibar (Unguja & Pemba) ----
  { name: "Mjini Magharibi",   kind: "region", lat: -6.1659, lng: 39.2026, aliases: ["mjini magharibi", "zanzibar", "zanzibar city", "zanzibar town", "unguja"] },
  { name: "Kaskazini Unguja",  kind: "region", lat: -5.8760, lng: 39.2530, aliases: ["kaskazini unguja", "north unguja", "mkokotoni"] },
  { name: "Kusini Unguja",     kind: "region", lat: -6.1330, lng: 39.3270, aliases: ["kusini unguja", "south unguja", "koani", "paje"] },
  { name: "Kaskazini Pemba",   kind: "region", lat: -5.0560, lng: 39.7280, aliases: ["kaskazini pemba", "north pemba", "wete", "pemba"] },
  { name: "Kusini Pemba",      kind: "region", lat: -5.2460, lng: 39.7660, aliases: ["kusini pemba", "south pemba", "chake chake", "mkoani"] },
];

// ----------------------------------------------------------------------------
//  Resolve a free-text place name to coordinates, gazetteer-first.
//  Returns { lat, lng, name, kind } or null. Matches the full institution
//  name, the same name without its parenthetical, the abbreviation in
//  parentheses (e.g. "UDSM", "UDOM", "SAUT") and any listed `aliases` (e.g.
//  "Mlimani City", "JNIA", "Kariakoo"). The longest token that appears in the
//  query wins, so "University of Dar es Salaam" beats a bare "Dar".
//  Used by the Houses page to drop an exact pin on a searched landmark and
//  measure how far listings (and the user's home) are from it.
// ----------------------------------------------------------------------------
// `opts.near` ({lat,lng}) is optional and only ever breaks a TIE between two
// equally-named places — the reason a Dar listing searching "Nyerere university"
// gets the Kigamboni campus rather than the one in Mara.
window.resolveTzPlace = function (query, opts) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[.,()]/g, " ").replace(/\s+/g, " ").trim();
  const t = norm(query);
  if (t.length < 2) return null;
  let best = null;
  // Region centres come LAST so a specific POI/area beats a whole-region centroid
  // on an equal-strength match (strict ">" keeps the earlier, more specific one),
  // while a region still resolves when it's the only/strongest match.
  const all = [...(window.TZ_UNIVERSITIES || []), ...(window.TZ_LANDMARKS || []), ...(window.TZ_REGION_CENTERS || [])];
  for (const p of all) {
    if (!p || !p.name || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    const tokens = new Set();
    tokens.add(norm(p.name));
    // A parenthetical is only an ABBREVIATION token when it's uppercase, e.g.
    // "(UDSM)", "(KIA)". A Title-case parenthetical like "(Mikocheni)" is a
    // location qualifier, not an abbreviation — counting it would make "Mikocheni"
    // resolve to "Quality Center Mall (Mikocheni)" instead of the Mikocheni area.
    const abbr = (p.name.match(/\(([^)]+)\)/) || [])[1];
    if (abbr && /^[A-Z0-9.\s/&-]{2,}$/.test(abbr.trim())) tokens.add(norm(abbr));
    const noParen = norm(p.name.replace(/\s*\([^)]*\)\s*/g, " "));
    if (noParen) tokens.add(noParen);
    for (const a of (p.aliases || [])) tokens.add(norm(a));
    for (const tok of tokens) {
      if (!tok || tok.length < 2) continue;
      const exact = t === tok;
      const hit = exact || t.includes(tok) || (tok.length >= 4 && tok.includes(t));
      if (!hit) continue;
      // An EXACT name/alias match always beats a mere substring containment, so a
      // one-word query like "Mwenge" lands on the Dar es Salaam area rather than a
      // university 500 km away whose long name happens to contain the word.
      const score = Math.min(t.length, tok.length) + (exact ? 1000 : 0);
      // `r` (optional, metres) is an AREA's coverage radius. It lets callers
      // measure "to <area>" against the WHOLE neighbourhood — inside = you're
      // there — instead of a single centroid point. Points (malls, airports)
      // carry no `r`, so they keep their exact-pin behaviour.
      if (!best || score > best._score) best = { lat: p.lat, lng: p.lng, name: p.name, kind: p.kind, r: p.r, _score: score };
    }
  }
  if (best) return best;

  // Nothing contained a token literally. That is not the same as "we don't know
  // this place" — it is usually one wrong letter, an abbreviation, or the same
  // institution said in Swahili. pawaPlaceMatch scores those properly, so give
  // it the last word before answering null.
  //
  // Strictly additive in two ways, both deliberate. It runs ONLY after the
  // exact-containment pass above has failed, so no lookup that used to succeed
  // can change its answer. And it accepts only an `exact` match — every word
  // typed is a word the place is called, just arranged or translated
  // differently ("chuo kikuu cha dar es salaam" → University of Dar es Salaam).
  //
  // A SPELLING GUESS IS STILL REFUSED HERE, however high it scores. This
  // function's callers act on its answer with nobody watching, and "Mikoceni"
  // must keep returning null so the caller offers a choice instead of moving a
  // map to a letter the user did not type. The guesses live in
  // closestTzPlaces() below, which exists to be shown to a person.
  const pm = window.pawaPlaceMatch;
  if (pm) {
    const hit = pm.best(query, { min: pm.STRONG, near: opts && opts.near });
    if (hit && hit.exact) {
      return { lat: hit.lat, lng: hit.lng, name: hit.name, kind: hit.kind, r: hit.r, _score: hit.score };
    }
  }
  return null;
};

// ----------------------------------------------------------------------------
// closestTzPlaces(query, limit) — "did you mean…" for a search that found
// nothing.
//
// resolveTzPlace above only answers when a token actually APPEARS in the query,
// so one wrong letter ("Mikoceni", "Mbeya Mjini" typed as "Mbea") answers
// nothing at all, and the search box dead-ends on "No matches in Tanzania."
// That is the wrong answer to give someone in a country whose place names are
// spelled several ways and rarely typed twice the same. This scores every
// gazetteer entry by how much of it the query looks like and hands back the
// nearest few, so the user is always offered somewhere to go.
//
// Returns [{ name, lat, lng, kind, score }] best first, score in 0..1.
//
// The real scoring lives in pawaPlaceMatch, which knows about abbreviations,
// Swahili, word importance and how far away each candidate is. What stays here
// is the ORIGINAL bigram scorer, used only on pages that do not load
// place-match.js — a raw dice coefficient answers something rather than
// dead-ending, which was the point of this function in the first place.
// ----------------------------------------------------------------------------
window.closestTzPlaces = function (query, limit, opts) {
  const pm = window.pawaPlaceMatch;
  if (pm) {
    // Two letters is not a query. A "did you mean" that answers anything has to
    // be able to say no, and at two characters every place in the country is
    // equally plausible — the floor is the original one, kept.
    if (String(query || "").trim().length < 3) return [];
    return pm.search(query, { limit: limit || 5, near: opts && opts.near })
      .map((r) => ({ name: r.name, lat: r.lat, lng: r.lng, kind: r.kind, score: r.score }));
  }
  const norm = (s) => String(s || "").toLowerCase().replace(/[.,()]/g, " ").replace(/\s+/g, " ").trim();
  const q = norm(query);
  if (q.length < 3) return [];
  const bigrams = (s) => {
    const set = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      set.set(g, (set.get(g) || 0) + 1);
    }
    return set;
  };
  const dice = (a, b) => {
    if (!a.size || !b.size) return 0;
    let shared = 0, total = 0;
    a.forEach((n, g) => { shared += Math.min(n, b.get(g) || 0); total += n; });
    b.forEach((n) => { total += n; });
    return (2 * shared) / total;
  };
  const qg = bigrams(q);
  const all = [...(window.TZ_UNIVERSITIES || []), ...(window.TZ_LANDMARKS || []), ...(window.TZ_REGION_CENTERS || [])];
  const scored = [];
  for (const p of all) {
    if (!p || !p.name || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    // Score against every name the place answers to and keep its best, so an
    // abbreviation or alias is as good a way in as the full name.
    const names = new Set([norm(p.name), norm(p.name.replace(/\s*\([^)]*\)\s*/g, " "))]);
    // Same rule resolveTzPlace uses: an UPPERCASE parenthetical is an
    // abbreviation the place answers to ("(UDSM)"), a Title-case one is a
    // location qualifier ("(Mikocheni)") and must not become its name.
    const abbr = (p.name.match(/\(([^)]+)\)/) || [])[1];
    if (abbr && /^[A-Z0-9.\s/&-]{2,}$/.test(abbr.trim())) names.add(norm(abbr));
    for (const a of (p.aliases || [])) names.add(norm(a));
    let best = 0;
    for (const n of names) {
      if (!n || n.length < 2) continue;
      best = Math.max(best, dice(qg, bigrams(n)));
    }
    if (best > 0.34) scored.push({ name: p.name, lat: p.lat, lng: p.lng, kind: p.kind, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit || 5);
};
