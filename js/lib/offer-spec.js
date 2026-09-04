// ============================================================================
//  offer-spec.js — what a service and a truck actually come with.
//
//  WHY THIS EXISTS
//  A house listing carries a spec sheet (js/lib/house-spec.js) because the
//  facts a tenant decides on never fit a fixed schema. A service and a truck
//  have exactly the same problem and had no answer to it at all: both forms
//  offered a title, a price, a coverage dropdown and a free paragraph, and
//  every fact a customer rings to ask about — do you bring your own tools, is
//  there a tarpaulin, do you work on Sunday, is the driver included, will you
//  give me a receipt — went into the paragraph, where it is invisible to
//  search, impossible to compare, and gone the moment the paragraph gets long.
//
//  So both carry a list of characteristics, drawn by js/lib/pick-list.js under
//  the one rule this app allows a catalogue: offer a few, keep a box for the
//  agent's own words, fold the rest. Nothing here is required and nothing is
//  exclusive; the catalogue can never be finished, which is why the free-text
//  box is not a fallback but the point.
//
//  BILINGUAL IN THIS FILE, not in js/core/i18n.js, for the reason house-spec.js
//  gives at its own top: a hundred short strings that only ever appear
//  together drift apart when they live a thousand lines away from each other,
//  and a half-translated suggestion list is worse than an English one because
//  you cannot tell which half you are looking at.
//
//  Written by: js/pages/agent-services.js, js/pages/agent-trucks.js
//  Read by:    js/pages/services.js, js/pages/trucks.js (to draw them back)
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

  // A catalogue is a flat list of groups. `top` names the handful offered
  // without a heading; everything else is one tap behind the fold, and the
  // split costs nothing to change because both halves come from here.
  function build(groups, topKeys) {
    var byKey = {};
    groups.forEach(function (g) {
      g.items.forEach(function (it) { byKey[it.key] = it; });
    });

    function label(v) {
      if (!v) return "";
      var hit = byKey[v];
      return hit ? say(hit) : String(v);
    }

    return {
      GROUPS: groups,
      TOP: topKeys,
      label: label,
      /** The flat handful, as pick-list wants them. */
      top: function () {
        return topKeys.map(function (k) {
          var it = byKey[k];
          return it ? { key: k, label: say(it) } : null;
        }).filter(Boolean);
      },
      /** Everything else, grouped, as pick-list wants it. */
      rest: function () {
        return groups.map(function (g) {
          return {
            title: say(g.title),
            items: g.items
              .filter(function (it) { return topKeys.indexOf(it.key) < 0; })
              .map(function (it) { return { key: it.key, label: say(it) }; }),
          };
        }).filter(function (g) { return g.items.length; });
      },
      /** True when this listing states the given characteristic. */
      has: function (list, key) {
        return Array.isArray(list) && list.indexOf(key) >= 0;
      },
      /**
       * A stored list, cleaned. Free text is kept as written and capped, so
       * one listing cannot carry a phone book; unknown keys are NOT dropped,
       * because an invented characteristic looks exactly like one.
       */
      normalize: function (list) {
        if (!Array.isArray(list)) return [];
        var out = [], seen = {};
        for (var i = 0; i < list.length && out.length < 24; i++) {
          var v = String(list[i] == null ? "" : list[i]).trim().slice(0, 60);
          if (!v) continue;
          var k = v.toLowerCase();
          if (seen[k]) continue;
          seen[k] = 1;
          out.push(v);
        }
        return out;
      },
      /** Stored values turned into words a reader sees. */
      labels: function (list) {
        var self = this;
        return self.normalize(list).map(label).filter(Boolean);
      },
    };
  }

  // ==========================================================================
  //  A SERVICE — what the provider brings, how they work, what the deal is.
  //
  //  These are the questions a customer asks on the phone before they agree to
  //  a price. Answering them on the listing is the difference between a call
  //  that books and a call that is only research.
  // ==========================================================================
  var SERVICE = build([
    {
      key: "brings",
      title: { en: "What you bring", sw: "Unakuja na nini" },
      items: [
        { key: "own_tools",     en: "I bring my own tools",     sw: "Naja na vifaa vyangu" },
        { key: "own_materials", en: "Materials included",       sw: "Malighafi zimejumuishwa" },
        { key: "own_transport", en: "I arrange my own transport", sw: "Napanga usafiri wangu" },
        { key: "own_ladder",    en: "Ladder and scaffold",      sw: "Ngazi na kiunzi" },
        { key: "own_machine",   en: "Machine work, not by hand", sw: "Kazi ya mashine, si mkono" },
        { key: "own_chemicals", en: "Cleaning chemicals",       sw: "Dawa za usafi" },
        { key: "own_generator", en: "I bring power if there is none", sw: "Naleta umeme kama haupo" },
      ],
    },
    {
      key: "when",
      title: { en: "When you work", sw: "Unafanya kazi lini" },
      items: [
        { key: "same_day",   en: "Same-day work",            sw: "Kazi ya siku hiyo hiyo" },
        { key: "emergency",  en: "Emergency call-out",       sw: "Dharura, wakati wowote" },
        { key: "weekends",   en: "I work weekends",          sw: "Nafanya kazi wikendi" },
        { key: "nights",     en: "I work at night",          sw: "Nafanya kazi usiku" },
        { key: "booking",    en: "By appointment only",      sw: "Kwa miadi pekee" },
        { key: "free_quote", en: "Free quote before I start", sw: "Makadirio bure kabla ya kuanza" },
      ],
    },
    {
      key: "deal",
      title: { en: "The deal", sw: "Makubaliano" },
      items: [
        { key: "guarantee",  en: "Guarantee on the work",    sw: "Dhamana ya kazi" },
        { key: "receipt",    en: "I give a receipt",         sw: "Natoa risiti" },
        { key: "written",    en: "Written quote",            sw: "Makadirio ya maandishi" },
        { key: "mobile_pay", en: "M-Pesa, Tigo Pesa or Airtel Money", sw: "M-Pesa, Tigo Pesa au Airtel Money" },
        { key: "pay_after",  en: "Pay when the work is done", sw: "Lipa kazi ikiisha" },
        { key: "deposit",    en: "A deposit is needed first", sw: "Inahitajika malipo ya awali" },
      ],
    },
    {
      key: "who",
      title: { en: "Who you are", sw: "Wewe ni nani" },
      items: [
        { key: "registered", en: "Registered business",      sw: "Biashara iliyosajiliwa" },
        { key: "team",       en: "I come with a team",       sw: "Naja na kikosi" },
        { key: "alone",      en: "I work alone",             sw: "Nafanya kazi peke yangu" },
        { key: "trained",    en: "Formally trained",         sw: "Nimefundishwa rasmi" },
        { key: "id_ready",   en: "Happy to show ID",         sw: "Tayari kuonyesha kitambulisho" },
        { key: "insured",    en: "Insured work",             sw: "Kazi yenye bima" },
      ],
    },
  ], [
    // The eight that end a phone call one way or the other.
    "own_tools", "free_quote", "same_day", "weekends",
    "guarantee", "receipt", "mobile_pay", "own_transport",
  ]);

  // ==========================================================================
  //  A TRUCK — the body, the crew, the kit, the trip, the paperwork.
  //
  //  `driver` and `loaders` are in here on purpose even though public.trucks
  //  has a boolean for each. The form asks the question once, here, and
  //  js/pages/agent-trucks.js reads the two booleans back off these two chips.
  //  A checkbox one line above a chip that says the same thing can be answered
  //  twice and answered differently, which is how a listing ends up arguing
  //  with itself. The same trap was taken out of the room card on
  //  agent-houses.html ("Own bathroom").
  // ==========================================================================
  var TRUCK = build([
    {
      key: "body",
      title: { en: "The body", sw: "Mwili wa gari" },
      items: [
        { key: "closed_body", en: "Closed body",             sw: "Mwili uliofungwa" },
        { key: "open_body",   en: "Open body",               sw: "Mwili wazi" },
        { key: "tarpaulin",   en: "Tarpaulin over the load", sw: "Turubai juu ya mzigo" },
        { key: "tipper",      en: "Tipper",                  sw: "Tipa" },
        { key: "flatbed",     en: "Flatbed",                 sw: "Sakafu tambarare" },
        { key: "fridge",      en: "Refrigerated",            sw: "Yenye friji" },
        { key: "tail_lift",   en: "Tail lift",               sw: "Lifti ya nyuma" },
        { key: "side_rails",  en: "Side rails",              sw: "Kingo za pembeni" },
      ],
    },
    {
      key: "crew",
      title: { en: "Who comes with it", sw: "Nani anakuja nayo" },
      items: [
        { key: "driver",     en: "Driver included",          sw: "Dereva amejumuishwa" },
        { key: "loaders",    en: "Loaders included",         sw: "Wapakiaji wamejumuishwa" },
        { key: "ride_along", en: "You can ride along",       sw: "Unaweza kupanda nayo" },
        { key: "own_fuel",   en: "Fuel included in the price", sw: "Mafuta yamejumuishwa kwenye bei" },
      ],
    },
    {
      key: "kit",
      title: { en: "The kit on board", sw: "Vifaa vilivyomo" },
      items: [
        { key: "straps",     en: "Ropes and straps",         sw: "Kamba na mikanda" },
        { key: "blankets",   en: "Blankets for furniture",   sw: "Mablanketi ya samani" },
        { key: "trolley",    en: "Trolley",                  sw: "Toroli" },
        { key: "spare_tyre", en: "Spare tyre",               sw: "Tairi la akiba" },
        { key: "extinguisher", en: "Fire extinguisher",      sw: "Kizima moto" },
        { key: "first_aid",  en: "First aid kit",            sw: "Kifaa cha huduma ya kwanza" },
      ],
    },
    {
      key: "trip",
      title: { en: "The trip", sw: "Safari" },
      items: [
        { key: "upcountry",  en: "Upcountry trips",          sw: "Safari za mkoani" },
        { key: "cross_border", en: "Cross-border trips",     sw: "Safari za nje ya nchi" },
        { key: "nights",     en: "Night trips",              sw: "Safari za usiku" },
        { key: "same_day",   en: "Same-day moves",           sw: "Kuhama siku hiyo hiyo" },
        { key: "return_load", en: "Cheaper on a return load", sw: "Nafuu kwa mzigo wa kurudi" },
        { key: "tolls",      en: "Tolls included",           sw: "Ada za barabara zimejumuishwa" },
      ],
    },
    {
      key: "papers",
      title: { en: "The paperwork", sw: "Makaratasi" },
      items: [
        { key: "insured",    en: "The load is insured",      sw: "Mzigo una bima" },
        { key: "licensed",   en: "Licensed carrier",         sw: "Msafirishaji mwenye leseni" },
        { key: "receipt",    en: "I give a receipt",         sw: "Natoa risiti" },
        { key: "contract",   en: "Written agreement",        sw: "Makubaliano ya maandishi" },
        { key: "mobile_pay", en: "M-Pesa, Tigo Pesa or Airtel Money", sw: "M-Pesa, Tigo Pesa au Airtel Money" },
      ],
    },
  ], [
    // The eight a customer moving house asks about before anything else.
    "driver", "loaders", "closed_body", "tarpaulin",
    "straps", "tail_lift", "upcountry", "own_fuel",
  ]);

  window.ServiceSpec = SERVICE;
  window.TruckSpec = TRUCK;
  window.OfferSpec = { say: say, SERVICE: SERVICE, TRUCK: TRUCK };
})();
