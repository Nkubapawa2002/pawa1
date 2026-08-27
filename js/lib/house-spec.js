// ============================================================================
//  house-spec.js — the shape of "everything else about this place".
//
//  WHY THIS EXISTS
//  The listing form used to be a fixed schema: bedrooms, bathrooms, size, one
//  room category, one price. Every fact that did not have a box got typed into
//  the description, where it is invisible to search, impossible to compare and
//  gone the moment the paragraph gets long. And there are a LOT of such facts
//  in a Tanzanian letting: whether the deposit is one month or two, that the
//  gate closes at ten, that water comes three days a week, that the road turns
//  to sand in the rain, that the plot has a title deed and the landlord signs
//  in person. Those are the facts a tenant actually decides on.
//
//  So a listing carries a SPEC SHEET, and it has exactly two moving parts:
//
//    rooms[]   the things that have a price. A plot with three singles at
//              60,000 and a master at 150,000 is one listing with four rooms,
//              not four listings or one lie. `kind` is free text with a long
//              suggestion list behind it — "single" and "master" are offered,
//              "godown", "kibanda" and anything the agent invents are equally
//              valid, because the catalogue can never be finished.
//
//    groups[]  every other fact, as a titled group of label→value lines.
//              Four groups come ready-made with suggestions (rules, the area,
//              services, paperwork) and the fifth is one the agent names
//              themselves. There is no fixed list of categories, on purpose:
//              the rule is "suggest a lot, forbid nothing".
//
//  THE CATALOGUE IS BILINGUAL IN THIS FILE, not in js/core/i18n.js. Around two
//  hundred short strings that only ever appear together belong next to each
//  other — split across two dictionaries a thousand lines apart they drift, and
//  a half-translated suggestion list is worse than an English one because you
//  cannot tell which half you are looking at.
//
//  Read by: js/pages/agent-houses.js (writes it), js/pages/house.js (draws
//  it), js/pages/houses.js (reads the cheapest room for a "from" price).
// ============================================================================
(function () {
  "use strict";

  function lang() {
    try { return (window.getLang && window.getLang()) === "sw" ? "sw" : "en"; }
    catch (_) { return "en"; }
  }

  /** Pick the current language out of an { en, sw } pair. */
  function say(pair) {
    if (pair == null) return "";
    if (typeof pair === "string") return pair;
    return pair[lang()] || pair.en || "";
  }

  // ---------------------------------------------------------------- room kinds
  // Offered as one-tap chips in the form and as a datalist behind the free-text
  // box. Order is the order a Tanzanian agent meets them, not alphabetical.
  var ROOM_KINDS = [
    { key: "single",          en: "Single room",            sw: "Chumba kimoja",
      hint: { en: "Shared bathroom and kitchen", sw: "Bafu na jiko la kushirikiana" } },
    { key: "master",          en: "Master room",            sw: "Chumba cha master",
      hint: { en: "Self-contained — its own bathroom", sw: "Self — bafu lake ndani" } },
    { key: "self_contained",  en: "Self-contained room",    sw: "Chumba self-contained",
      hint: { en: "Own bathroom and cooking space", sw: "Bafu na sehemu ya kupikia" } },
    { key: "bedsitter",       en: "Bedsitter",              sw: "Bedsita",
      hint: { en: "One room, everything in it", sw: "Chumba kimoja, kila kitu ndani" } },
    { key: "two_in_one",      en: "Two-in-one",             sw: "Vyumba viwili",
      hint: { en: "Sitting room plus bedroom", sw: "Sebule na chumba" } },
    { key: "one_bedroom",     en: "One-bedroom flat",       sw: "Fleti ya chumba kimoja" },
    { key: "two_bedroom",     en: "Two-bedroom flat",       sw: "Fleti ya vyumba viwili" },
    { key: "three_bedroom",   en: "Three-bedroom house",    sw: "Nyumba ya vyumba vitatu" },
    { key: "whole_house",     en: "Whole house",            sw: "Nyumba nzima" },
    { key: "servant_quarter", en: "Servant quarter",        sw: "Chumba cha mfanyakazi",
      hint: { en: "The outside room — \"boy's quarter\"", sw: "Chumba cha nje" } },
    { key: "shop_frame",      en: "Shop / frame",           sw: "Frem / duka" },
    { key: "kiosk",           en: "Kiosk / stall",          sw: "Kibanda / genge" },
    { key: "office_suite",    en: "Office suite",           sw: "Ofisi" },
    { key: "godown",          en: "Godown / store",         sw: "Ghala" },
    { key: "hall",            en: "Hall / event space",     sw: "Ukumbi" },
    { key: "parking_bay",     en: "Parking bay",            sw: "Nafasi ya kuegesha" },
    { key: "plot",            en: "Plot / land",            sw: "Kiwanja" },
    { key: "farm",            en: "Farm / shamba",          sw: "Shamba" },
    { key: "rooftop",         en: "Rooftop space",          sw: "Eneo la juu ya paa" },
  ];

  var ROOM_BY_KEY = {};
  ROOM_KINDS.forEach(function (r) { ROOM_BY_KEY[r.key] = r; });

  // How often the money changes hands. `total` is a sale or a one-off.
  var PERIODS = [
    { key: "month",  en: "per month",  sw: "kwa mwezi" },
    { key: "day",    en: "per day",    sw: "kwa siku" },
    { key: "week",   en: "per week",   sw: "kwa wiki" },
    { key: "year",   en: "per year",   sw: "kwa mwaka" },
    { key: "total",  en: "total",      sw: "jumla" },
  ];

  // ------------------------------------------------------------- room size
  // Square metres were asked for and almost never given: an agent standing in
  // a room in Tabata does not have a tape measure, and a number typed to fill
  // a box is worse than no number because it looks measured. What a renter
  // actually needs is the bracket — and then the photographs, which are the
  // honest size record and are already on every listing.
  //
  // So: three brackets, one tap, and the page tells the reader to judge the
  // rest from the pictures rather than pretending 18 m² was surveyed.
  var SIZE_BANDS = [
    { key: "small",  en: "Small",  sw: "Kidogo",
      hint: { en: "A bed and a little space around it",
              sw: "Kitanda na nafasi kidogo pembeni" } },
    { key: "medium", en: "Medium", sw: "Wastani",
      hint: { en: "Bed, wardrobe and room to move",
              sw: "Kitanda, kabati na nafasi ya kupita" } },
    { key: "large",  en: "Large",  sw: "Kubwa",
      hint: { en: "Bed, seating and space left over",
              sw: "Kitanda, sehemu ya kukaa na nafasi ya ziada" } },
  ];
  var SIZE_BY_KEY = {};
  SIZE_BANDS.forEach(function (b) { SIZE_BY_KEY[b.key] = b; });

  // The line shown wherever a size is shown. It is the same sentence every
  // time, on purpose: a bracket is a bracket, and the photos are the detail.
  var SIZE_PHOTO_NOTE = {
    en: "Sizes are a bracket, not a survey — the photos are the real measure.",
    sw: "Ukubwa ni kadirio, si upimaji — picha ndizo kipimo halisi.",
  };

  // ------------------------------------------------- room characteristics
  // The thing renters actually decide on, and the thing the old schema had no
  // box for. "Is the bathroom inside or outside" settles a viewing before
  // anybody travels; so does a tiled floor, a sink board, a ceiling, a window
  // that opens onto something other than a wall.
  //
  // Grouped only so the chips are findable. Nothing here is required, nothing
  // is exclusive, and the agent can add any characteristic that is not on this
  // list — the catalogue can never be finished, which is the same rule the
  // room kinds and the fact groups already follow.
  var FEATURE_GROUPS = [
    {
      key: "bathroom",
      title: { en: "Bathroom & toilet", sw: "Bafu na choo" },
      items: [
        { key: "bath_inside",   en: "Bathroom inside the room",  sw: "Bafu ndani ya chumba" },
        { key: "bath_shared",   en: "Shared bathroom",           sw: "Bafu la kushirikiana" },
        { key: "bath_outside",  en: "Bathroom outside",          sw: "Bafu liko nje" },
        { key: "toilet_inside", en: "Toilet inside",             sw: "Choo ndani" },
        { key: "toilet_shared", en: "Shared toilet",             sw: "Choo cha kushirikiana" },
        { key: "hot_water",     en: "Hot water / shower heater", sw: "Maji ya moto / hita ya bafu" },
        { key: "western_toilet", en: "Sitting toilet",           sw: "Choo cha kukaa" },
        { key: "squat_toilet",  en: "Squat toilet",              sw: "Choo cha kuchuchumaa" },
      ],
    },
    {
      key: "finish",
      title: { en: "Floor, walls & ceiling", sw: "Sakafu, kuta na dari" },
      items: [
        { key: "tiles",         en: "Tiled floor",               sw: "Sakafu ya tiles" },
        { key: "cement_floor",  en: "Cement floor",              sw: "Sakafu ya saruji" },
        { key: "ceiling",       en: "Ceiling board fitted",      sw: "Dari limewekwa" },
        { key: "painted",       en: "Freshly painted",           sw: "Imepakwa rangi mpya" },
        { key: "plastered",     en: "Plastered walls",           sw: "Kuta zimepigwa plasta" },
        { key: "big_windows",   en: "Big windows / good light",  sw: "Madirisha makubwa / mwanga mzuri" },
        { key: "grill_windows", en: "Window grills",             sw: "Nondo za madirisha" },
      ],
    },
    {
      key: "kitchen",
      title: { en: "Kitchen & water", sw: "Jiko na maji" },
      items: [
        { key: "sink_board",    en: "Sink board fitted",         sw: "Sinki na meza ya jiko" },
        { key: "kitchen_inside", en: "Kitchen inside",           sw: "Jiko ndani" },
        { key: "kitchen_shared", en: "Shared kitchen",           sw: "Jiko la kushirikiana" },
        { key: "tap_inside",    en: "Water tap inside",          sw: "Bomba la maji ndani" },
        { key: "water_tank",    en: "Water tank on the plot",    sw: "Tank la maji" },
        { key: "well",          en: "Well / borehole",           sw: "Kisima" },
      ],
    },
    {
      key: "power",
      title: { en: "Power & connections", sw: "Umeme na miunganisho" },
      items: [
        { key: "own_meter",     en: "Own LUKU meter",            sw: "LUKU yake mwenyewe" },
        { key: "shared_meter",  en: "Shared meter",              sw: "LUKU ya kushirikiana" },
        { key: "sockets",       en: "Plenty of sockets",         sw: "Soketi za kutosha" },
        { key: "dstv",          en: "DSTV / aerial point",       sw: "Kituo cha DSTV / antena" },
        { key: "internet",      en: "Internet available",        sw: "Intaneti inapatikana" },
      ],
    },
    {
      key: "space",
      title: { en: "Space & access", sw: "Nafasi na maingilio" },
      items: [
        { key: "own_entrance",  en: "Own entrance",              sw: "Mlango wake mwenyewe" },
        { key: "wardrobe",      en: "Built-in wardrobe",         sw: "Kabati la ukutani" },
        { key: "balcony",       en: "Balcony / veranda",         sw: "Baraza / balcony" },
        { key: "parking",       en: "Parking space",             sw: "Nafasi ya kuegesha" },
        { key: "store",         en: "Store room",                sw: "Chumba cha kuhifadhi" },
        { key: "ground_floor",  en: "Ground floor",              sw: "Ghorofa ya chini" },
        { key: "upstairs",      en: "Upstairs",                  sw: "Ghorofani" },
        { key: "furnished",     en: "Furnished",                 sw: "Ina samani" },
      ],
    },
  ];

  var FEATURE_BY_KEY = {};
  FEATURE_GROUPS.forEach(function (g) {
    g.items.forEach(function (it) { FEATURE_BY_KEY[it.key] = it; });
  });

  /**
   * A stored characteristic is either a catalogue key or free text the agent
   * typed. Both are returned as a plain label, so nothing downstream has to
   * care which it was — the point of "forbid nothing" is that the invented
   * ones read exactly like the offered ones.
   */
  function featureLabel(f) {
    if (!f) return "";
    if (typeof f === "string") {
      var hit = FEATURE_BY_KEY[f];
      return hit ? say(hit) : f;
    }
    if (f.key && FEATURE_BY_KEY[f.key]) return say(FEATURE_BY_KEY[f.key]);
    return str(f.text || f.label || "", 60);
  }

  function sizeLabel(key) {
    var b = SIZE_BY_KEY[key];
    return b ? say(b) : "";
  }
  function sizeHint(key) {
    var b = SIZE_BY_KEY[key];
    return b && b.hint ? say(b.hint) : "";
  }

  // ------------------------------------------------------- free vs unknown
  // A cost of zero is a FACT — "water is included", "no service charge" — and
  // it is one of the better facts a listing can carry. It was being thrown in
  // with the unknowns and rendered "Ask the agent", which turns the best news
  // in the listing into a chore for the reader and a phone call for the agent.
  //
  // Agents write this several ways and all of them are meant to say the same
  // thing, in either language.
  var FREE_WORDS = /^\s*(0|0\/=|free|no charge|none|included|inclusive|bure|bila malipo|hakuna|imejumuishwa|zero)\s*$/i;

  /**
   * @returns {{known:boolean, free:boolean, amount:number|null}}
   *   known:false  nothing usable was given — the honest answer is "ask".
   *   free:true    stated as costing nothing. Say "Free", never "Ask".
   */
  function parseCost(v) {
    if (v == null || v === "") return { known: false, free: false, amount: null };
    if (typeof v === "number") {
      if (!isFinite(v)) return { known: false, free: false, amount: null };
      return v <= 0 ? { known: true, free: true, amount: 0 }
                    : { known: true, free: false, amount: v };
    }
    var s = String(v).trim();
    if (!s) return { known: false, free: false, amount: null };
    if (FREE_WORDS.test(s)) return { known: true, free: true, amount: 0 };
    // "TZS 5,000", "5000/=", "5,000 kwa mwezi" — take the first number in it.
    var m = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    if (!m) return { known: false, free: false, amount: null };
    var n = parseFloat(m[0]);
    if (!isFinite(n)) return { known: false, free: false, amount: null };
    return n <= 0 ? { known: true, free: true, amount: 0 }
                  : { known: true, free: false, amount: n };
  }

  var FREE_LABEL = { en: "Free", sw: "Bure" };

  // The handful of UI labels that belong to this catalogue. They live here for
  // the reason stated at the top of the file: a label and the list it labels
  // drift apart when they live in two dictionaries, and these are read only by
  // the form and the page that draw SIZE_BANDS and FEATURE_GROUPS.
  var UI = {
    size_q:      { en: "How big is it?",            sw: "Ni kubwa kiasi gani?" },
    size_help:   { en: "Pick the bracket — the photos show the rest.",
                   sw: "Chagua kadirio — picha zinaonyesha mengine." },
    feats_q:     { en: "What does it have?",        sw: "Ina nini?" },
    feats_help:  { en: "Tap what fits. Anything not here, type it — your words are kept as written.",
                   sw: "Gusa vinavyofaa. Kisichopo, kiandike — maneno yako yanahifadhiwa." },
    feats_add:   { en: "Add your own…",           sw: "Ongeza chako…" },
    feats_none:  { en: "Nothing chosen yet",        sw: "Hakuna kilichochaguliwa" },
    remove:      { en: "Remove",                    sw: "Ondoa" },
  };

  // ------------------------------------------------------------ group presets
  // Each item is a LINE the agent can add: a label, and values worth offering.
  // Every one of them is editable and none is required — the suggestions exist
  // so the common case is tapping, not typing.
  var GROUPS = [
    {
      key: "rules",
      icon: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
      title: { en: "Rules & regulations", sw: "Sheria na masharti" },
      blurb: {
        en: "The house rules a tenant agrees to. Say them here and nobody argues at the gate.",
        sw: "Masharti ya nyumba anayokubali mpangaji. Yaandike hapa ili yasibishaniwe langoni.",
      },
      items: [
        { label: { en: "Deposit", sw: "Dhamana" }, values: [
          { en: "1 month, refundable", sw: "Mwezi 1, inarudishwa" },
          { en: "2 months, refundable", sw: "Miezi 2, inarudishwa" },
          { en: "None", sw: "Hakuna" }] },
        { label: { en: "Notice to leave", sw: "Taarifa ya kuhama" }, values: [
          { en: "1 month", sw: "Mwezi 1" }, { en: "2 months", sw: "Miezi 2" },
          { en: "3 months", sw: "Miezi 3" }] },
        { label: { en: "Rent is due", sw: "Kodi hulipwa" }, values: [
          { en: "1st of the month", sw: "Tarehe 1 ya mwezi" },
          { en: "5th of the month", sw: "Tarehe 5 ya mwezi" },
          { en: "6 months in advance", sw: "Miezi 6 kabla" }] },
        { label: { en: "Payment method", sw: "Njia ya malipo" }, values: [
          { en: "M-Pesa, Tigo Pesa or Airtel Money", sw: "M-Pesa, Tigo Pesa au Airtel Money" },
          { en: "Bank transfer", sw: "Kupitia benki" },
          { en: "Cash to the landlord", sw: "Fedha taslimu kwa mwenye nyumba" }] },
        { label: { en: "Contract", sw: "Mkataba" }, values: [
          { en: "Written, 12 months", sw: "Wa maandishi, miezi 12" },
          { en: "Written, 6 months", sw: "Wa maandishi, miezi 6" },
          { en: "Verbal", sw: "Wa mdomo" }] },
        { label: { en: "Visitors", sw: "Wageni" }, values: [
          { en: "Allowed", sw: "Wanaruhusiwa" },
          { en: "Allowed until 22:00", sw: "Hadi saa 4 usiku" },
          { en: "No overnight guests", sw: "Hawaruhusiwi kulala" }] },
        { label: { en: "Pets", sw: "Wanyama wa nyumbani" }, values: [
          { en: "Allowed", sw: "Wanaruhusiwa" }, { en: "Not allowed", sw: "Hawaruhusiwi" },
          { en: "Small pets only", sw: "Wadogo pekee" }] },
        { label: { en: "Smoking", sw: "Kuvuta sigara" }, values: [
          { en: "Not allowed indoors", sw: "Hairuhusiwi ndani" },
          { en: "Allowed outside", sw: "Inaruhusiwa nje" }] },
        { label: { en: "Noise", sw: "Kelele" }, values: [
          { en: "Quiet after 22:00", sw: "Utulivu baada ya saa 4 usiku" }] },
        { label: { en: "Cooking", sw: "Kupika" }, values: [
          { en: "Shared kitchen", sw: "Jiko la pamoja" },
          { en: "No cooking in the room", sw: "Hakuna kupika chumbani" },
          { en: "Charcoal not allowed", sw: "Mkaa hauruhusiwi" }] },
        { label: { en: "Gate closes", sw: "Lango hufungwa" }, values: [
          { en: "22:00", sw: "Saa 4 usiku" }, { en: "23:00", sw: "Saa 5 usiku" },
          { en: "Never — 24-hour guard", sw: "Halifungwi — mlinzi saa 24" }] },
        { label: { en: "Sub-letting", sw: "Kupangisha tena" }, values: [
          { en: "Not allowed", sw: "Hairuhusiwi" },
          { en: "Allowed with consent", sw: "Kwa ruhusa ya mwenye nyumba" }] },
        { label: { en: "Business from the house", sw: "Biashara nyumbani" }, values: [
          { en: "Not allowed", sw: "Hairuhusiwi" },
          { en: "Allowed with the landlord's consent", sw: "Kwa ruhusa ya mwenye nyumba" }] },
        { label: { en: "Repairs", sw: "Matengenezo" }, values: [
          { en: "Landlord: the building. Tenant: breakages.",
            sw: "Mwenye nyumba: jengo. Mpangaji: alichovunja." }] },
        { label: { en: "Who may rent", sw: "Wanaoruhusiwa kupanga" }, values: [
          { en: "Families only", sw: "Familia pekee" },
          { en: "Singles welcome", sw: "Wasio na familia wanakaribishwa" },
          { en: "Ladies only", sw: "Wanawake pekee" },
          { en: "Students welcome", sw: "Wanafunzi wanakaribishwa" }] },
      ],
    },
    {
      key: "area",
      icon: "M12 21s-7-5.5-7-10.5A7 7 0 0 1 19 10.5C19 15.5 12 21 12 21z",
      title: { en: "In this area", sw: "Katika eneo hili" },
      blurb: {
        en: "What the neighbourhood gives you — water, power, the road, transport. The map cannot say these. You can.",
        sw: "Eneo linatoa nini — maji, umeme, barabara, usafiri. Ramani haiwezi kusema haya; wewe unaweza.",
      },
      items: [
        { label: { en: "Water", sw: "Maji" }, values: [
          { en: "Tap water every day (DAWASA)", sw: "Maji ya bomba kila siku (DAWASA)" },
          { en: "Borehole on the plot", sw: "Kisima kwenye kiwanja" },
          { en: "Tap 3 days a week", sw: "Bomba siku 3 kwa wiki" },
          { en: "Bought by bowser", sw: "Yananunuliwa kwa bawaza" }] },
        { label: { en: "Electricity", sw: "Umeme" }, values: [
          { en: "TANESCO, LUKU prepaid meter", sw: "TANESCO, mita ya LUKU" },
          { en: "Shared meter", sw: "Mita ya pamoja" },
          { en: "Solar backup", sw: "Sola ya akiba" }] },
        { label: { en: "Road to the gate", sw: "Barabara hadi langoni" }, values: [
          { en: "Tarmac", sw: "Lami" }, { en: "Graded murram", sw: "Changarawe" },
          { en: "Sandy — hard in the rain", sw: "Mchanga — ngumu mvua ikinyesha" }] },
        { label: { en: "Flooding", sw: "Mafuriko" }, values: [
          { en: "Never floods", sw: "Hayajawahi kutokea" },
          { en: "Floods in heavy rain", sw: "Hutokea mvua kubwa ikinyesha" }] },
        { label: { en: "Transport", sw: "Usafiri" }, values: [
          { en: "Dala dala stand, 5 minutes' walk", sw: "Stendi ya daladala, dakika 5 kwa miguu" },
          { en: "Bajaji at the junction", sw: "Bajaji njia panda" },
          { en: "BRT station, 10 minutes", sw: "Kituo cha mwendokasi, dakika 10" }] },
        { label: { en: "Market", sw: "Soko" }, values: [
          { en: "Daily market, 10 minutes", sw: "Soko la kila siku, dakika 10" }] },
        { label: { en: "School", sw: "Shule" }, values: [
          { en: "Primary school 400 m", sw: "Shule ya msingi mita 400" },
          { en: "Secondary school 1 km", sw: "Sekondari km 1" }] },
        { label: { en: "Health", sw: "Afya" }, values: [
          { en: "Dispensary 1 km", sw: "Zahanati km 1" },
          { en: "Hospital 3 km", sw: "Hospitali km 3" }] },
        { label: { en: "Worship", sw: "Ibada" }, values: [
          { en: "Mosque 200 m", sw: "Msikiti mita 200" },
          { en: "Church 500 m", sw: "Kanisa mita 500" }] },
        { label: { en: "Security", sw: "Usalama" }, values: [
          { en: "Street guard at night", sw: "Mlinzi wa mtaa usiku" },
          { en: "Gated street", sw: "Mtaa wenye lango" },
          { en: "Police post 1 km", sw: "Kituo cha polisi km 1" }] },
        { label: { en: "Mobile network", sw: "Mtandao wa simu" }, values: [
          { en: "Vodacom and Airtel 4G, strong", sw: "Vodacom na Airtel 4G, nzuri" }] },
        { label: { en: "Noise", sw: "Kelele" }, values: [
          { en: "Quiet residential street", sw: "Mtaa tulivu wa makazi" },
          { en: "Busy road frontage", sw: "Barabara yenye shughuli" }] },
        { label: { en: "Neighbours", sw: "Majirani" }, values: [
          { en: "Families", sw: "Familia" }, { en: "Students", sw: "Wanafunzi" },
          { en: "Mixed", sw: "Mchanganyiko" }] },
      ],
    },
    {
      key: "services",
      icon: "M14.7 6.3a4 4 0 0 1-5 5L4 17v3h3l5.7-5.7a4 4 0 0 0 5-5l-2 2-2.6-.7-.7-2.6 2-2z",
      title: { en: "Services included", sw: "Huduma zinazojumuishwa" },
      blurb: {
        en: "What comes with the place, and whether it is already paid for.",
        sw: "Kinachokuja na nyumba, na kama kimeshalipiwa.",
      },
      items: [
        { label: { en: "Garbage collection", sw: "Kuzoa taka" }, values: [
          { en: "Weekly, included", sw: "Kila wiki, imejumuishwa" },
          { en: "Weekly, TZS 5,000 a month", sw: "Kila wiki, TZS 5,000 kwa mwezi" }] },
        { label: { en: "Security guard", sw: "Mlinzi" }, values: [
          { en: "24 hours, included", sw: "Saa 24, imejumuishwa" },
          { en: "Nights only", sw: "Usiku pekee" }] },
        { label: { en: "Cleaning", sw: "Usafi" }, values: [
          { en: "Common areas, twice a week", sw: "Maeneo ya pamoja, mara mbili kwa wiki" }] },
        { label: { en: "Internet", sw: "Intaneti" }, values: [
          { en: "WiFi included", sw: "WiFi imejumuishwa" },
          { en: "Fibre available — you pay the provider", sw: "Fiber ipo — unalipa mwenyewe" }] },
        { label: { en: "Water pumping", sw: "Kusukuma maji" }, values: [
          { en: "Tank filled by the landlord", sw: "Tangi hujazwa na mwenye nyumba" }] },
        { label: { en: "Caretaker", sw: "Mtunzaji" }, values: [
          { en: "Lives on site", sw: "Anaishi hapo hapo" }] },
        { label: { en: "Parking", sw: "Kuegesha" }, values: [
          { en: "One car, included", sw: "Gari moja, imejumuishwa" }] },
        { label: { en: "Generator", sw: "Jenereta" }, values: [
          { en: "Shared — tenants buy the fuel", sw: "Ya pamoja — wapangaji hununua mafuta" }] },
        { label: { en: "Laundry", sw: "Kufua" }, values: [
          { en: "Drying lines on the roof", sw: "Kamba za kuanika juu ya paa" }] },
      ],
    },
    {
      key: "legal",
      icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
      title: { en: "Paperwork & legal", sw: "Nyaraka na sheria" },
      blurb: {
        en: "What you can show, and who signs. This is what turns a viewing into a deal.",
        sw: "Unachoweza kuonyesha, na nani anasaini. Hii ndiyo hugeuza ziara kuwa mkataba.",
      },
      items: [
        { label: { en: "Ownership document", sw: "Hati ya umiliki" }, values: [
          { en: "Title deed available", sw: "Hati miliki ipo" },
          { en: "Offer letter", sw: "Barua ya ofa" },
          { en: "Customary right of occupancy", sw: "Hati ya kimila" }] },
        { label: { en: "Land rent", sw: "Kodi ya ardhi" }, values: [
          { en: "Paid up to date", sw: "Imelipwa hadi sasa" }] },
        { label: { en: "Lease", sw: "Mkataba wa pango" }, values: [
          { en: "Written, signed at the house", sw: "Wa maandishi, husainiwa nyumbani" },
          { en: "Registered with the ward office", sw: "Umesajiliwa ofisi ya kata" }] },
        { label: { en: "You sign with", sw: "Unasaini na" }, values: [
          { en: "The landlord, in person", sw: "Mwenye nyumba mwenyewe" },
          { en: "This agent, on the landlord's behalf", sw: "Wakala huyu, kwa niaba" }] },
        { label: { en: "Receipt", sw: "Risiti" }, values: [
          { en: "Rent receipt book", sw: "Kitabu cha risiti" },
          { en: "TRA receipt issued", sw: "Risiti ya TRA hutolewa" }] },
        { label: { en: "ID required", sw: "Kitambulisho kinachohitajika" }, values: [
          { en: "NIDA or passport copy", sw: "Nakala ya NIDA au pasipoti" }] },
        { label: { en: "Agent fee", sw: "Ada ya dalali" }, values: [
          { en: "One month's rent, on signing", sw: "Kodi ya mwezi mmoja, wakati wa kusaini" }] },
      ],
    },
    {
      key: "custom",
      icon: "M12 5v14M5 12h14",
      title: { en: "Anything else", sw: "Kitu kingine chochote" },
      blurb: {
        en: "Name the category yourself and put anything in it. Nothing here is fixed.",
        sw: "Taja kichwa mwenyewe na weka chochote ndani yake. Hakuna kilichofungwa hapa.",
      },
      items: [],
    },
  ];

  var GROUP_BY_KEY = {};
  GROUPS.forEach(function (g) { GROUP_BY_KEY[g.key] = g; });

  // ------------------------------------------------------------------ cleaning
  function str(v, max) {
    return String(v == null ? "" : v).trim().slice(0, max || 120);
  }
  function num(v) {
    var n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  function int(v, min, max) {
    var n = Math.round(Number(v));
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  var MAX_ROOMS = 24;
  var MAX_GROUPS = 12;
  var MAX_ITEMS = 40;

  /**
   * A spec sheet, cleaned. Anything unrecognised is dropped rather than
   * carried: this is what goes into the database and out to every reader, so
   * "whatever the agent typed" has to stop being arbitrary somewhere, and the
   * one place it stops is here.
   *
   * Empty rooms and empty lines are removed — an agent who taps "+ Add detail"
   * twice and fills one should not publish a blank row.
   */
  var MAX_FEATURES = 24;

  /**
   * Stored as a flat array of strings: a catalogue key ("tiles") or whatever
   * the agent typed. One shape, because two would mean every reader has to
   * branch, and the whole point is that an invented characteristic behaves
   * exactly like an offered one.
   */
  function normalizeFeatures(list) {
    if (!Array.isArray(list)) return [];
    var out = [], seen = {};
    list.forEach(function (f) {
      var v = "";
      if (typeof f === "string") v = f.trim();
      else if (f && typeof f === "object") v = String(f.key || f.text || f.label || "").trim();
      if (!v) return;
      v = str(v, 60);
      var k = v.toLowerCase();
      if (seen[k]) return;
      seen[k] = 1;
      if (out.length < MAX_FEATURES) out.push(v);
    });
    return out;
  }

  function normalize(details) {
    var out = { v: 1, rooms: [], groups: [] };
    if (!details || typeof details !== "object") return out;

    (Array.isArray(details.rooms) ? details.rooms : []).slice(0, MAX_ROOMS).forEach(function (r) {
      if (!r || typeof r !== "object") return;
      var kind = str(r.kind, 40);
      var price = num(r.price);
      if (!kind && price == null) return;
      out.rooms.push({
        kind: kind || "other",
        price: price,
        period: PERIODS.some(function (p) { return p.key === r.period; }) ? r.period : "month",
        count: int(r.count, 1, 99),
        vacant: r.vacant == null || r.vacant === "" ? null : int(r.vacant, 0, 99),
        ensuite: !!r.ensuite,
        // Kept because listings already carry it and a real measurement should
        // never be thrown away. New listings write `sizeBand` instead.
        size: num(r.size),
        sizeBand: SIZE_BY_KEY[r.sizeBand] ? r.sizeBand : null,
        // Characteristics: catalogue keys and free text, side by side, capped
        // so one listing cannot carry a phone book. Free text is trimmed and
        // de-duped against itself but never checked against the catalogue —
        // "forbid nothing" means an agent's own word stands as written.
        features: normalizeFeatures(r.features),
        note: str(r.note, 200),
      });
    });

    (Array.isArray(details.groups) ? details.groups : []).slice(0, MAX_GROUPS).forEach(function (g) {
      if (!g || typeof g !== "object") return;
      var items = (Array.isArray(g.items) ? g.items : []).slice(0, MAX_ITEMS)
        .map(function (it) {
          if (!it || typeof it !== "object") return null;
          return { label: str(it.label, 60), value: str(it.value, 220), note: str(it.note, 200) };
        })
        .filter(function (it) { return it && it.label && (it.value || it.note); });
      var title = str(g.title, 60);
      if (!title || !items.length) return;
      out.groups.push({
        key: GROUP_BY_KEY[g.key] ? g.key : "custom",
        title: title,
        items: items,
      });
    });

    return out;
  }

  /** Nothing worth drawing? Then the reader draws nothing, not an empty card. */
  function isEmpty(details) {
    var d = normalize(details);
    return !d.rooms.length && !d.groups.length;
  }

  /**
   * The spec sheet for a saved listing, including one synthesised from the
   * columns that predate it.
   *
   * A listing saved before this feature still has a room category and a price
   * in `room_kind` / `price_tzs`. Reading those back as a one-line rooms table
   * means the new detail page says the same thing about an old listing as it
   * does about a new one — rather than the old ones quietly losing the only
   * room fact they had.
   */
  function fromRow(row) {
    var d = normalize(row && row.details);
    if (!d.rooms.length && row && (row.room_kind === "single" || row.room_kind === "master")) {
      d.rooms.push({
        kind: row.room_kind, price: num(row.price_tzs),
        period: row.period === "total" ? "total" : "month",
        count: 1, vacant: null, ensuite: row.room_kind === "master",
        size: num(row.size_sqm), note: "",
      });
    }
    return d;
  }

  /**
   * The cheapest room, for a "from TZS 60,000" headline.
   *
   * Only rooms that actually name a price count. A listing whose rooms are all
   * "ask the agent" has no from-price, and inventing one from the top-level
   * figure would put a number on the card that no room in the building rents
   * for.
   */
  function priceFrom(row) {
    var d = fromRow(row);
    var best = null;
    d.rooms.forEach(function (r) {
      if (r.price == null || r.price <= 0) return;
      if (!best || r.price < best.price) best = r;
    });
    if (!best) return null;
    return { amount: best.price, period: best.period, kind: best.kind, many: d.rooms.length > 1 };
  }

  /** "Master room", "Godown", or whatever the agent typed, title-cased. */
  function roomLabel(kind) {
    var k = str(kind, 40);
    if (!k) return "";
    if (ROOM_BY_KEY[k]) return say(ROOM_BY_KEY[k]);
    return k.replace(/[_-]+/g, " ").replace(/\S+/g, function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    });
  }

  function periodLabel(period) {
    for (var i = 0; i < PERIODS.length; i++) if (PERIODS[i].key === period) return say(PERIODS[i]);
    return "";
  }

  /**
   * Does this listing rent room by room?
   *
   * Two or more priced rooms, or one room that is not the whole unit. Used by
   * the card to decide between "TZS 900,000 / month" and "from TZS 60,000 —
   * 4 room types".
   */
  function isRoomByRoom(row) {
    var d = fromRow(row);
    if (d.rooms.length > 1) return true;
    if (d.rooms.length === 1) {
      var k = d.rooms[0].kind;
      return k !== "whole_house" && k !== "plot" && k !== "farm";
    }
    return false;
  }

  // "whole unit" is a question about the listing, not about one room: three
  // kinds of space carry it, and so does a listing that never broke itself
  // into rooms at all.
  var WHOLE_KINDS = { whole_house: 1, plot: 1, farm: 1 };

  /**
   * Every room category this listing actually offers.
   *
   * `room_kind` holds ONE value and a listing holds up to twenty-four, so the
   * column has to pick — agent-houses.js makes it pick the cheapest room,
   * because that is the one a "singles under 80,000" filter is asking about.
   * Which means the master room on that same plot is, as far as any column is
   * concerned, not there. This is the list that says it is.
   */
  function roomKinds(row) {
    var seen = {}, out = [];
    fromRow(row).rooms.forEach(function (r) {
      if (r.kind && !seen[r.kind]) { seen[r.kind] = 1; out.push(r.kind); }
    });
    return out;
  }
  /** The same list as words, for a search index. */
  function roomWords(row) {
    return roomKinds(row).map(function (k) {
      var p = ROOM_BY_KEY[k];
      // Both languages, because the index is searched in both and a Swahili
      // seeker typing "chumba kimoja" is asking for the same room.
      return p ? [p.en, p.sw].join(" ") : roomLabel(k);
    });
  }

  /**
   * Does this listing offer a room that satisfies ALL of these at once?
   *
   * The "at once" is the whole point. Filtering kind and budget separately
   * against the flat columns says yes to a plot whose single room is 80,000
   * and whose master is 400,000 when somebody asks for a master under
   * 100,000 — the listing has a master, and it has something under 100,000,
   * and they are not the same room. So a room has to clear both bars itself.
   *
   * `want` is { kind, priceMin, priceMax }, all optional.
   *   kind      a ROOM_KINDS key, "whole", or free text the agent invented
   *   priceMin  inclusive floor
   *   priceMax  inclusive ceiling (pass any grace already applied)
   *
   * A listing with no spec sheet falls back to its columns, so an old row
   * answers exactly as it did before this function existed.
   *
   * A room with NO price passes a budget filter. "Ask the agent" is not a
   * statement that it is expensive, and hiding it would quietly bury every
   * negotiable room in the country.
   */
  function offers(row, want) {
    var w = want || {};
    var kind = str(w.kind, 40);
    var min = w.priceMin == null ? null : Number(w.priceMin);
    var max = w.priceMax == null ? null : Number(w.priceMax);
    var rooms = fromRow(row).rooms;

    function priceOk(p) {
      if (p == null || !(p > 0)) return true;   // unpriced — see above
      if (max != null && p > max) return false;
      if (min != null && p < min) return false;
      return true;
    }

    // No sheet: the columns are all there is, and they are one room's worth.
    if (!rooms.length) {
      if (kind === "whole") {
        if (row && (row.room_kind === "single" || row.room_kind === "master")) return false;
      } else if (kind) {
        if (!row || row.room_kind !== kind) return false;
      }
      return priceOk(num(row && row.price_tzs));
    }

    if (kind === "whole") {
      var whole = rooms.filter(function (r) { return WHOLE_KINDS[r.kind]; });
      // A sheet that never names a whole-unit space is a room-by-room
      // listing, which is exactly what "whole unit" excludes.
      if (!whole.length) return false;
      return whole.some(function (r) { return priceOk(r.price); });
    }

    var pool = kind
      ? rooms.filter(function (r) { return r.kind === kind; })
      : rooms;
    if (!pool.length) return false;
    return pool.some(function (r) { return priceOk(r.price); });
  }

  window.HouseSpec = {
    ROOM_KINDS: ROOM_KINDS,
    PERIODS: PERIODS,
    GROUPS: GROUPS,
    SIZE_BANDS: SIZE_BANDS,
    SIZE_PHOTO_NOTE: SIZE_PHOTO_NOTE,
    FEATURE_GROUPS: FEATURE_GROUPS,
    featureLabel: featureLabel,
    featureLabels: function (list) {
      return normalizeFeatures(list).map(featureLabel).filter(Boolean);
    },
    sizeLabel: sizeLabel,
    sizeHint: sizeHint,
    sizeNote: function () { return say(SIZE_PHOTO_NOTE); },
    parseCost: parseCost,
    freeLabel: function () { return say(FREE_LABEL); },
    t: function (key) { return UI[key] ? say(UI[key]) : ""; },
    groupPreset: function (key) { return GROUP_BY_KEY[key] || null; },
    say: say,
    normalize: normalize,
    fromRow: fromRow,
    isEmpty: isEmpty,
    priceFrom: priceFrom,
    roomLabel: roomLabel,
    periodLabel: periodLabel,
    isRoomByRoom: isRoomByRoom,
    roomKinds: roomKinds,
    roomWords: roomWords,
    offers: offers,
  };
})();
