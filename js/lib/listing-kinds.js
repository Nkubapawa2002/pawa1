// =====================================================================
// listing-kinds.js — the ONE place that turns a stored listing kind into
// a word a person reads.
//
// `cleaning`, `10ton_plus` and `apartment` are what the database holds.
// "Cleaning", "10-tonne+ lorry" and "Apartment" are what a screen shows,
// and until this file existed that translation lived in three separate
// page scripts — services.js, trucks.js and houses.js each carried its own
// copy of its own map. Three copies of a lookup table is three chances for
// the truck page to say "7-tonne lorry" while the agent list says "7ton",
// which reads as two different kinds of truck to the only person who
// matters.
//
// The maps here are the union of those three, and those three now read
// from here.
//
// TWO OF THE THREE ARE FREE TEXT. houses.type and trucks.truck_type carry
// only a 40-character non-blank check, so an agent can type "tipper" and
// mean it. Anything not in a map is title-cased and shown AS TYPED —
// never dropped, never replaced with "Other". A kind we do not recognise
// is still the truest description of the work available, and hiding it
// would lose the one word the customer was scanning for.
//
// Labels go through window.t() so Swahili gets them too; the English
// string stays here as the fallback, so a page that forgets to load
// i18n.js degrades to English rather than to a slug.
// =====================================================================
(function () {
  "use strict";

  // services.category — a fixed set, enforced by services_category_check.
  var SERVICES = {
    cleaning: "Cleaning",
    plumbing: "Plumbing",
    electrical: "Electrical",
    carpentry: "Carpentry",
    painting: "Painting",
    gardening: "Gardening",
    moving_help: "Moving help",
    laundry: "Laundry",
    cooking: "Cooking / Chef",
    tutoring: "Tutoring",
    beauty: "Beauty & Salon",
    security: "Security",
    childcare: "Childcare",
    appliance_repair: "Appliance repair",
    other: "Other",
  };

  // trucks.truck_type — the six the dashboard offers, plus whatever an
  // agent typed into the "other" box.
  var TRUCKS = {
    pickup: "Pickup",
    canter: "Canter",
    "3ton": "3-tonne",
    "7ton": "7-tonne lorry",
    "10ton_plus": "10-tonne+ lorry",
    other: "Other",
  };

  // houses.type — residential and business premises share one column.
  var HOUSES = {
    apartment: "Apartment",
    house: "House",
    plot: "Plot",
    office: "Office",
    shop: "Shop / business",
    warehouse: "Warehouse",
  };

  var MAPS = { services: SERVICES, trucks: TRUCKS, houses: HOUSES };

  // i18n keys are namespaced by catalogue because the same word means
  // different things in two of them: `other` is a service nobody
  // categorised and a truck nobody could name.
  var PREFIX = { services: "kind_svc_", trucks: "kind_truck_", houses: "kind_house_" };

  function titleCase(s) {
    return String(s).replace(/[_-]+/g, " ").replace(/\S+/g, function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    });
  }

  function tr(key, fallback) {
    if (window.t) {
      var got = window.t(key);
      // t() hands back the key itself when there is no entry. That is the
      // signal to fall through to English rather than print "kind_svc_x".
      if (got && got !== key) return got;
    }
    return fallback;
  }

  /**
   * One kind, as a word.
   *
   * @param {string} cat  'houses' | 'services' | 'trucks' | 'jobs'
   * @param {string} kind the stored value
   * @returns {string} "" when there is nothing to say — a day job has no
   *          kind at all (the board has no categories), and an empty
   *          string is how the caller knows to draw nothing rather than
   *          a blank chip.
   */
  function label(cat, kind) {
    var k = String(kind == null ? "" : kind).trim();
    if (!k) return "";
    var map = MAPS[cat];
    if (map && Object.prototype.hasOwnProperty.call(map, k)) {
      return tr((PREFIX[cat] || "kind_") + k, map[k]);
    }
    return titleCase(k);
  }

  /**
   * Several kinds, joined — "Plumbing · Electrical".
   *
   * Deduplicated AFTER labelling, not before: two stored values can land
   * on the same word once an unknown kind is title-cased, and printing it
   * twice makes the agent look like they listed the same thing twice.
   */
  function labels(cat, kinds, opts) {
    var max = (opts && opts.max) || 3;
    var seen = {}, out = [];
    (kinds || []).forEach(function (k) {
      var w = label(cat, k);
      if (!w || seen[w.toLowerCase()]) return;
      seen[w.toLowerCase()] = true;
      out.push(w);
    });
    return out.slice(0, max);
  }

  window.ListingKinds = {
    label: label,
    labels: labels,
    // Exposed so a dashboard can build its own <select> from the same list
    // it will later be read back through.
    known: function (cat) { return Object.keys(MAPS[cat] || {}); },
  };
})();
