// =====================================================================
// pawaCommute — how well a home fits the week you actually live
// =====================================================================
// "Match to my life" ranks listings by travel to the places a person named.
// The first version summed one number: minutes = km / speed, added up across
// every place, lowest total wins. That is a distance calculation wearing the
// word "life", and it gets four things wrong that change which home comes top.
//
//   IT WEIGHED A CAFE LIKE A WORKPLACE. A commute made ten times a week and a
//   favourite spot visited once counted the same. The whole promise of the
//   feature is in that difference, so it is now the centre of the maths: legs
//   are weighted by how often the person actually goes.
//
//   IT LIKED LOPSIDED HOMES. 30 + 30 and 5 + 55 both total 60, but the second
//   means an hour of someone's day, every day, on one trip. A weighted mean
//   alone still cannot tell them apart, so the worst single trip is priced in
//   beside the average.
//
//   IT PRICED EVERY TRIP AS PURE MOVEMENT. km / speed says a 700 m daladala
//   ride takes 2.6 minutes. It does not — you wait for the daladala. Every
//   mode gets a fixed cost for the part of the trip that is not moving, which
//   is also what makes walking correctly win at short range.
//
//   IT GAVE AWAY MINUTES IT DID NOT KNOW. A leg still being measured, or one
//   no router could solve, contributed ZERO and was compared against homes
//   whose legs were fully known — so the least-known home floated to the top.
//   Nothing is invented here now: incompleteness is a TIER, not a number.
//
// Kept deliberately: only REAL road distance is ever scored. A crow-flies
// figure to your workplace is worse than no figure, and houses.js has always
// refused to fake one.
//
// Pure functions, no DOM, no network — so tests/commute_score_test.mjs can
// drive the maths directly instead of inferring it from a rendered list.
// =====================================================================
(function () {
  "use strict";

  // Speed is only half of a trip. `fixed` is the part that does not scale with
  // distance: finding the vehicle, waiting for it, parking at the other end.
  // Rough, honest figures for Dar es Salaam rather than false precision — what
  // matters is that they are not ZERO, because zero is what made every short
  // trip look free.
  const MODES = {
    walk:     { label: "Walk",     kmh: 4.5, fixed: 0 },
    bodaboda: { label: "Bodaboda", kmh: 22,  fixed: 3 },  // flag one down
    bajaji:   { label: "Bajaji",   kmh: 18,  fixed: 4 },
    daladala: { label: "Daladala", kmh: 16,  fixed: 8 },  // wait, and often a transfer
    car:      { label: "Car",      kmh: 26,  fixed: 5 },  // get it out, park it
  };

  // Default visits per week, by what kind of place it is. A starting point the
  // person can overrule per place — the point is that the default is never
  // "all places are equal", which is the one answer that is certainly wrong.
  const KIND_TRIPS = { work: 5, school: 5, family: 1, fav: 1, custom: 2 };

  // How much the ranking listens to the typical trip vs the worst one.
  // 1.0 would be the old behaviour (averages only) and would keep calling
  // 5+55 as good as 30+30; 0 would rank purely on the single worst trip and
  // ignore everything else. 0.7 leans on the ordinary week while leaving a
  // brutal outlier able to sink a home.
  const BALANCE = 0.7;

  // Tiers keep unknowns OUT of the numbers instead of pricing them at zero.
  // Everything in a lower tier ranks above everything in a higher one, so a
  // home whose legs are all measured always beats one still measuring, and a
  // home with a leg no router could solve never wins on the strength of the
  // leg it could not answer.
  const TIER = { ROUTED: 0, MEASURING: 1, NO_ROUTE: 2, UNSCORED: 3 };

  function modeOf(m) { return MODES[m] || MODES.car; }

  // Door to door: the fixed cost of using the mode at all, plus the moving part.
  function travelMin(km, mode) {
    if (!Number.isFinite(km) || km < 0) return null;
    const m = modeOf(mode);
    return m.fixed + (km / m.kmh) * 60;
  }

  // Visits per week for a place: what they set, else what its kind implies.
  // Clamped because this multiplies every minute in the score, and a stray 0
  // would silently delete a place from the ranking while leaving its chip up.
  function tripsFor(place) {
    const raw = place && Number(place.perWeek);
    const n = Number.isFinite(raw) && raw > 0 ? raw : KIND_TRIPS[place && place.kind];
    return Math.min(21, Math.max(1, Number.isFinite(n) ? n : 2));
  }

  // legs: [{ place: {mode, maxMin, perWeek, kind}, km: number|null, state }]
  //   state "road"      — a real road distance, km is a number
  //         "measuring" — not fetched yet
  //         "noroad"    — routed, no road found
  //
  // Returns the numbers the list sorts on and the card explains itself with:
  //   tier      TIER.* — compared BEFORE score, never blended into it
  //   score     the ranking number, in minutes; lower is better
  //   meanMin   the weighted average trip — "a typical journey from here"
  //   worstMin  the single worst trip
  //   weekMin   minutes on the road in a normal week, both directions.
  //             The one figure in here a person can feel, so it is what the
  //             card shows; the others are how the order is decided.
  //   pass      false when a measured leg busts that place's own max-time.
  function score(legs) {
    const measured = [];
    let measuring = false, noroad = false, pass = true;

    for (const leg of legs || []) {
      if (leg.state === "measuring") { measuring = true; continue; }
      if (leg.state === "noroad")    { noroad = true;    continue; }
      const min = travelMin(leg.km, leg.place && leg.place.mode);
      if (min === null) { noroad = true; continue; }
      const trips = tripsFor(leg.place);
      const cap = leg.place && leg.place.maxMin;
      if (cap && min > cap) pass = false;
      measured.push({ min, trips });
    }

    if (!measured.length) {
      return { tier: noroad ? TIER.NO_ROUTE : measuring ? TIER.MEASURING : TIER.UNSCORED,
               score: Infinity, meanMin: null, worstMin: null, weekMin: null, pass };
    }

    const totalTrips = measured.reduce((s, l) => s + l.trips, 0);
    const meanMin  = measured.reduce((s, l) => s + l.min * l.trips, 0) / totalTrips;
    const worstMin = measured.reduce((m, l) => Math.max(m, l.min), 0);
    // Both directions: a visit is a there AND a back.
    const weekMin  = measured.reduce((s, l) => s + l.min * l.trips * 2, 0);

    return {
      tier: noroad ? TIER.NO_ROUTE : measuring ? TIER.MEASURING : TIER.ROUTED,
      score: BALANCE * meanMin + (1 - BALANCE) * worstMin,
      meanMin, worstMin, weekMin, pass,
    };
  }

  // Sort comparator: tier first, then score. Exported so the list and any
  // future caller order things the same way rather than re-deriving it.
  function compare(a, b) {
    const ta = a ? a.tier : TIER.UNSCORED, tb = b ? b.tier : TIER.UNSCORED;
    if (ta !== tb) return ta - tb;
    const sa = a ? a.score : Infinity, sb = b ? b.score : Infinity;
    return sa - sb;
  }

  window.pawaCommute = { MODES, KIND_TRIPS, TIER, BALANCE, modeOf, travelMin, tripsFor, score, compare };
})();
