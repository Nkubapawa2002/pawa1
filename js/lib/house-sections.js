// ============================================================================
//  house-sections.js — the markup for one property, section by section.
//
//  Each function here returns the HTML for exactly one <section>, or "" when
//  that section has nothing to say: a listing with no description gets no
//  "About" card, one with no amenities gets no amenities card, and the section
//  rail is then built from whichever of them actually rendered. That is the
//  rule this file exists to keep — a card that renders "None listed" is a card
//  that wasted a screen of a phone.
//
//  js/pages/house.js decides WHICH sections to draw and in what order, and does
//  all the wiring. This file only knows how each one looks.
//
//  Depends on: house-ui.js (esc, ico, ICO, the label + format helpers),
//  house-spec.js and house-rooms.js (the spec sheet and the room model),
//  pm-reach.js (the encrypted-message button).
// ============================================================================

// The sections this page can draw, in reading order, with the rail label each
// one gets. Built into the rail only when the section actually rendered.
// T() and fillT() come from js/lib/house-ui.js, which loads first and is where
// this page keeps the helpers more than one of its files needs.

// The tab strip down the sheet. Read through T() at call time rather than
// frozen here, because the reader can change language without a reload.
const SECTION_EN = {
  "sec-money":     "Price",
  "sec-rooms":     "Rooms",
  "sec-about":     "About",
  "sec-rules":     "Rules & area",
  "sec-costs":     "Bills",
  "sec-amenities": "Amenities",
  "sec-place":     "Location",
  "sec-move":      "Moving in",
  "sec-nearby":    "Nearby",
  "sec-agent":     "Agent",
};
const SECTION_KEY = {
  "sec-money":     "hs_tab_money",
  "sec-rooms":     "hs_tab_rooms",
  "sec-about":     "hs_tab_about",
  "sec-rules":     "hs_tab_rules",
  "sec-costs":     "hs_tab_costs",
  "sec-amenities": "hs_tab_amenities",
  "sec-place":     "hs_tab_place",
  "sec-move":      "hs_tab_move",
  "sec-nearby":    "hs_tab_nearby",
  "sec-agent":     "hs_tab_agent",
};
const SECTION_LABELS = new Proxy({}, {
  get: (_, id) => (SECTION_EN[id] === undefined
    ? undefined : T(SECTION_KEY[id], SECTION_EN[id])),
  has: (_, id) => id in SECTION_EN,
  ownKeys: () => Reflect.ownKeys(SECTION_EN),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});
const SECTION_ORDER = [
  "sec-money", "sec-rooms", "sec-about", "sec-rules", "sec-costs",
  "sec-amenities", "sec-place", "sec-move", "sec-nearby", "sec-agent",
];

// ============================================================================
// Sections
// ============================================================================

/** The media, with the listing's identity written over its foot. */
function heroHtml(h, slides, photoCount, listing) {
  const verified = h.verified
    ? `<span class="hd-badge verified">${ico(ICO.check, 12)} Verified</span>` : "";
  const roomsFlag = (window.HouseSpec && window.HouseSpec.isRoomByRoom(h))
    ? `<span class="hd-badge is-gold">Room by room</span>` : "";

  const slidesHtml = slides.map((s, i) => s.kind === "video"
    ? `<div class="hd-gallery-slide is-video" data-i="${i}">
         <video src="${esc(s.url)}" controls playsinline preload="${i === 0 ? "metadata" : "none"}"></video>
       </div>`
    : `<div class="hd-gallery-slide" data-i="${i}">
         <img src="${esc(s.url)}" alt="${esc(h.title)} — photo ${i + 1}"
              loading="${i === 0 ? "eager" : "lazy"}" decoding="async">
       </div>`).join("");

  const thumbsHtml = slides.length > 1 ? `
    <div class="hd-gallery-thumbs" id="hdGalleryThumbs" role="tablist" aria-label="Media">
      ${slides.map((s, i) => s.kind === "video"
        ? `<button type="button" class="hd-gallery-thumb ${i === 0 ? "active" : ""}" data-i="${i}" role="tab"
                   aria-label="Open video ${i + 1 - photoCount}">
             <video src="${esc(s.url)}" muted playsinline preload="none"></video>
             <span class="vbadge">${ico(ICO.video, 14)}</span>
           </button>`
        : `<button type="button" class="hd-gallery-thumb ${i === 0 ? "active" : ""}" data-i="${i}" role="tab"
                   aria-label="Open photo ${i + 1}">
             <img src="${esc(s.url)}" alt="" loading="lazy" decoding="async">
           </button>`).join("")}
    </div>` : "";

  const dotsHtml = slides.length > 1 ? `
    <div class="hd-gallery-dots" aria-hidden="true">
      ${slides.map((_, i) => `<span class="hd-gallery-dot ${i === 0 ? "active" : ""}" data-i="${i}"></span>`).join("")}
    </div>` : "";

  const where = [h.area, h.region].filter(Boolean).map(esc).join(", ")
    + (h.address ? ` · ${esc(h.address)}` : "");

  return `
    <div class="hx-hero" id="hxHero">
      <div class="hd-gallery">
        <div class="hd-gallery-stage" id="hdGalleryStage">${slidesHtml}</div>
        ${slides.length > 1 ? `
          <button type="button" class="hd-gallery-nav prev" id="hdGalleryPrev" aria-label="Previous">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <button type="button" class="hd-gallery-nav next" id="hdGalleryNext" aria-label="Next">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
          <div class="hd-gallery-counter" id="hdGalleryCounter">1 / ${slides.length}</div>
          ${dotsHtml}
        ` : ""}
        ${thumbsHtml}
      </div>
      <div class="hx-hero__scrim"></div>
      <div class="hd-hero-badges">
        <span class="hd-badge">${esc(listing)}</span>
        <span class="hd-badge">${esc(labelType(h.type))}</span>
        ${roomsFlag}
        ${verified}
      </div>
      <div class="hx-hero__id">
        <h1 class="hx-hero__title" id="hxHeroTitle">${esc(h.title)}</h1>
        <div class="hx-hero__loc">${ico(ICO.pin, 14)}<span>${where}</span></div>
      </div>
    </div>`;
}

/** The scroll-spy rail, built from the sections that actually rendered. */
function railHtml(ids) {
  if (ids.length < 3) return "";
  return `<nav class="hx-rail" id="hxRail" aria-label="Sections of this listing">
    ${ids.map(id => `<a class="hx-rail__link" href="#${id}" data-sec="${id}">${esc(SECTION_LABELS[id])}</a>`).join("")}
  </nav>`;
}

// ---------------------------------------------------------------- the money
/**
 * The one card that answers "what does this cost".
 *
 * It is re-rendered whenever the reader picks a different space, which is why
 * its contents are split out: the <section> shell keeps its id (the rail points
 * at it) and only the inside is replaced.
 */
function moneySectionHtml(h, list, i) {
  if (!list.length) return "";
  return `<section class="hx-card hx-money" id="sec-money">${moneyInnerHtml(h, list, i)}</section>`;
}

function moneyInnerHtml(h, list, i) {
  const HR = window.HouseRooms;
  const room = list[i];
  const mi = HR.moveIn(h, room);
  const priced = room.price != null && room.price > 0;
  const many = list.length > 1;

  const lead = many ? room.label
             : T(h.listing === "sale" ? "hs_asking" : "hs_rent_here",
                 h.listing === "sale" ? "Asking price" : "Rent for this place");

  const head = priced
    ? `<div class="hd-price">${esc(HR.money(room.price))} <small>${esc(room.periodLabel || "")}</small></div>`
    : `<div class="hx-money__ask">${esc(T("hs_on_request",
        "Price on request. The agent has not named one for this space."))}</div>`;

  // What the headline does NOT say, said once, here.
  const notes = [];
  if (many) notes.push(fillT(T("hs_one_of", "One of <strong>{n}</strong> kinds of space in this listing."),
                             { n: list.length }));
  if ((h.listing || "rent") === "rent" && Number(h.min_months) > 1)
    notes.push(fillT(T("hs_min_months", "Minimum <strong>{n} months</strong> paid upfront."),
                     { n: esc(String(h.min_months)) }));

  return `
    <div class="hx-card__head">
      ${ico(ICO.receipt)}
      <h3>${esc(lead)}</h3>
    </div>
    ${head}
    ${notes.length ? `<p class="hx-money__note">${notes.join(" ")}</p>` : ""}
    ${moveInHtml(mi)}
  `;
}

/**
 * The move-in total, itemised and collapsed.
 *
 * Every line says where its number came from, and the total only adds up what
 * could actually be priced. A figure presented as complete when it is not is
 * worse than no figure: somebody budgets to it and arrives short.
 */
function moveInHtml(mi) {
  if (!mi.lines.length) return "";
  if (mi.simple) {
    return `<ul class="hx-lines" style="margin-top:12px">${mi.lines.map(lineHtml).join("")}</ul>`;
  }

  const total = mi.total != null ? window.HouseRooms.money(mi.total) : "—";
  const assumed = mi.lines.some(l => l.src === "assumed");
  // No commission line at all means nobody is taking one: an owner's listing.
  // The label under "To move in" is a list of what the total is made of, so it
  // must not go on naming a cost that is not in it.
  const hasFee = mi.lines.some(l => l.k === (window.HouseSpec && window.HouseSpec.t
    ? window.HouseSpec.t("m_fee") : "") && !l.free);

  const caveats = [];
  if (mi.open.length) {
    caveats.push(fillT(T(mi.open.length === 1 ? "hs_leaves_out_1" : "hs_leaves_out_n",
                         mi.open.length === 1
                           ? "This total leaves out {what}: the agent has not put a number on it."
                           : "This total leaves out {what}: the agent has not put a number on them."),
                       { what: esc(joinList(mi.open)) }));
  }
  if (assumed) {
    caveats.push(esc(T("hs_assumed_fee",
      "The commission here is the market standard of one month's rent, not a quote from this agent. Confirm it before you sign.")));
  }

  // The chart carries the same figures in its legend and again in its table
  // view, so rendering the itemised lists as well would put every number on
  // screen twice in a row. The lists stay as the fallback for a page that did
  // not bundle the chart.
  const chart = window.HouseCostChart ? window.HouseCostChart.render(mi) : "";

  const m = mi.monthly;
  const monthlyBlock = !m ? "" : `
    <div class="hx-specs-split__label" style="margin-top:16px">${esc(T("hs_then_monthly", "Then, every month"))}</div>
    <ul class="hx-lines">
      <li><span class="hx-line-k">${esc(T("hs_rent", "Rent"))}</span><span class="hx-line-v">${esc(window.HouseRooms.money(m.rent))}</span></li>
      ${m.bills.map(b => `<li${b.amount == null && !b.free ? ' class="is-muted"' : ""}${b.free ? ' class="is-free"' : ""}>
        <span class="hx-line-k">${esc(b.label)}</span>
        <span class="hx-line-v">${esc(billValue(b))}</span>
      </li>`).join("")}
      ${m.hasUnknownBills ? "" : `<li class="is-total">
        <span class="hx-line-k">${esc(T("hs_every_month", "Every month"))}</span>
        <span class="hx-line-v">${esc(window.HouseRooms.money(m.total))}</span>
      </li>`}
    </ul>`;

  return `
    <div class="hx-movein">
      <button type="button" class="hx-movein__toggle" id="hxMoveinBtn"
              aria-expanded="false" aria-controls="hxMoveinBody">
        <span class="hx-movein__label">${esc(T("hs_to_move_in", "To move in"))}
          <small>${hasFee ? "rent upfront + deposit + commission" : "rent upfront + deposit"}</small>
        </span>
        <span class="hx-movein__total">${esc(total)}</span>
        <span class="hx-movein__chev">${ico(ICO.chevron, 16)}</span>
      </button>
      <div class="hx-movein__body" id="hxMoveinBody">
        ${chart || `
        <ul class="hx-lines">
          ${mi.lines.map(lineHtml).join("")}
          ${mi.total != null ? `<li class="is-total">
            <span class="hx-line-k">${esc(T(mi.complete ? "hs_total_all" : "hs_total_priced",
              mi.complete ? "Total to move in" : "Total of the priced items"))}</span>
            <span class="hx-line-v">${esc(total)}</span>
          </li>` : ""}
        </ul>
        ${monthlyBlock}`}
        ${caveats.map(c => `<p class="hx-movein__caveat">${c}</p>`).join("")}
      </div>
    </div>`;
}

function lineHtml(l) {
  return `<li${l.muted ? ' class="is-muted"' : ""}>
    <span class="hx-line-k">${esc(l.k)}${l.sub ? `<small>${esc(l.sub)}</small>` : ""}</span>
    <span class="hx-line-v">${esc(l.v)}</span>
  </li>`;
}

function billValue(b) {
  if (b.billing === "included") return T("hs_bill_included", "Included");
  if (b.billing === "metered")  return T("hs_bill_metered", "Pay as you use");
  // Stated as costing nothing. This is a fact worth reading, and it must not
  // render as "TZS 0" (which looks like a data error) or fall through to
  // "Ask the agent" (which is what it used to do).
  if (b.free)                   return window.HouseSpec && window.HouseSpec.freeLabel
                                  ? window.HouseSpec.freeLabel() : T("hs_free", "Free");
  if (b.amount != null)         return window.HouseRooms.money(b.amount);
  return (window.HouseSpec && window.HouseSpec.t && window.HouseSpec.t("m_ask"))
    || T("hs_ask", "Ask the agent");
}

function joinList(a) {
  if (a.length === 1) return a[0];
  return a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
}

// ---------------------------------------------------------------- the rooms
/**
 * Pick a space; everything about the money follows it.
 *
 * The building's own facts are drawn too, but under their own heading and
 * below — never mixed into the tiles describing the space being priced.
 */
function roomsSectionHtml(h, list, i) {
  const HR = window.HouseRooms;
  if (!HR || !list.length) return "";

  const many = list.length > 1;
  const sub = many
    ? T("hs_rooms_many", "This place is let space by space. Pick one: its price, its specification and the move-in total above all follow your choice.")
    : (list[0].synthetic
        ? T("hs_rooms_legacy", "This listing predates the room-by-room sheet, so what follows is the one space its original entry described.")
        : T("hs_rooms_one", "This listing offers one kind of space."));

  return `<section class="hx-card" id="sec-rooms">
    <div class="hx-card__head">
      ${ico(ICO.door)}
      <h3>${esc(T("hs_h_rooms", "Rooms and specifications"))}</h3>
      ${many ? `<span class="hx-card__count">${list.length}</span>` : ""}
    </div>
    <p class="hx-sub">${esc(sub)}</p>
    ${many ? `<div class="hx-rooms__picker" role="tablist" aria-label="${esc(T("hs_spaces_aria", "Spaces in this listing"))}">
      ${list.map(r => HR.tab(r, r.i === i)).join("")}
    </div>` : ""}
    <div id="hxRoomPanel" role="tabpanel" aria-labelledby="hxRoomTab${i}">
      ${HR.roomPanel(list[i])}
    </div>
    <div class="hx-specs-split">
      <div class="hx-specs-split__label">${esc(T("hs_whole", "The whole property"))}</div>
      <div class="hx-specs">${HR.buildingTiles(h, labelType, formatDate)}</div>
    </div>
  </section>`;
}

function aboutSectionHtml(h) {
  if (!h.description) return "";
  return `<section class="hx-card" id="sec-about">
    <div class="hx-card__head">${ico(ICO.text)}<h3>${esc(T("hs_h_about", "About this property"))}</h3></div>
    <p>${esc(h.description)}</p>
  </section>`;
}

/**
 * The agent's own spec sheet — rules, the area, services, paperwork, and
 * anything they named themselves — as one accordion instead of four full cards
 * that used to push the map and the agent below three screens of text.
 */
function groupsSectionHtml(h) {
  const HS = window.HouseSpec;
  if (!HS) return "";
  const groups = HS.fromRow(h).groups;
  if (!groups.length) return "";

  const items = groups.map((g, i) => {
    // The preset's icon is ours (a path constant in house-spec.js), so it is
    // trusted markup. The title is the agent's, so it is escaped — including
    // when it happens to match a preset.
    const preset = HS.groupPreset(g.key);
    const icon = preset ? ico(preset.icon) : ico(ICO.shield);
    const lines = g.items.map(it => `
      <li>
        <span class="hd-fact-l">${esc(it.label)}</span>
        <span class="hd-fact-v">${esc(it.value)}${it.note ? `<small>${esc(it.note)}</small>` : ""}</span>
      </li>`).join("");
    const open = i === 0;
    return `<div class="hx-acc__item">
      <button type="button" class="hx-acc__btn" aria-expanded="${open}" aria-controls="hxAcc${i}">
        ${icon}
        <span>${esc(g.title)}</span>
        <span class="hx-acc__n">${g.items.length}</span>
        <span class="hx-acc__chev">${ico(ICO.chevron, 16)}</span>
      </button>
      <div class="hx-acc__panel${open ? " is-open" : ""}" id="hxAcc${i}">
        <ul class="hd-facts">${lines}</ul>
      </div>
    </div>`;
  }).join("");

  return `<section class="hx-card" id="sec-rules">
    <div class="hx-card__head">
      ${ico(ICO.shield)}
      <h3>${esc(T("hs_h_rules", "What the agent commits to"))}</h3>
      <span class="hx-card__count">${groups.length}</span>
    </div>
    <p class="hx-sub">${esc(T("hs_rules_sub", "The rules, the neighbourhood, the services and the paperwork, written by the agent in their own words."))}</p>
    <div class="hx-acc">${items}</div>
  </section>`;
}

/** Bills on top of the rent. The move-in card totals them; this names them. */
function billsSectionHtml(h) {
  const costs = (Array.isArray(h.extra_costs) ? h.extra_costs : []).filter(c => c && c.label);
  if (!costs.length) return "";

  const rows = costs.map(c => {
    const amt = Number(c.amount);
    const has = Number.isFinite(amt) && amt > 0;
    const b = c.billing || "month";
    let right;
    if (b === "included")     right = `<span class="hx-tag hx-tag--ok">${esc(T("hs_incl_rent", "Included in the rent"))}</span>`;
    else if (b === "metered") right = `<span class="hx-tag hx-tag--info">${esc(T("hs_bill_metered", "Pay as you use"))}</span>`;
    else if (has)             right = `<span class="hx-line-v">${esc(window.HouseRooms.money(amt))}${
                                        b === "month" ? " / month" : b === "oneoff" ? " once" : ""}</span>`;
    else                      right = `<span class="hx-tag hx-tag--ask">${esc(T("hs_ask", "Ask the agent"))}</span>`;
    return `<li class="hx-bill">
      <span class="hx-bill__k">${costIcon(c.label)}${esc(c.label)}</span>
      ${right}
    </li>`;
  }).join("");

  return `<section class="hx-card" id="sec-costs">
    <div class="hx-card__head">
      ${ico(ICO.bolt)}
      <h3>${esc(T("hs_h_costs", "Bills and extra costs"))}</h3>
      <span class="hx-card__count">${costs.length}</span>
    </div>
    <p class="hx-sub">${esc(T("hs_costs_sub", "What the tenant pays on top of the rent above."))}</p>
    <ul class="hx-lines">${rows}</ul>
  </section>`;
}

/** Amenities. No listing gets an "amenities" card that says there are none. */
function amenitiesSectionHtml(h) {
  const list = (h.amenities || []).filter(Boolean);
  if (!list.length) return "";
  return `<section class="hx-card" id="sec-amenities">
    <div class="hx-card__head">
      ${ico(ICO.sparkle)}
      <h3>${esc(T("hs_h_amenities", "Amenities"))}</h3>
      <span class="hx-card__count">${list.length}</span>
    </div>
    <div class="hd-chips">
      ${list.map(a => `<span class="hd-chip">${amenityIcon(a)}${esc(labelAmenity(a))}</span>`).join("")}
    </div>
  </section>`;
}

/**
 * Where it is.
 *
 * The three actions under the map used to sit in one flat row of equal-looking
 * links, and the one a person actually wants (take me there) was the middle of
 * three and the only one that did not work on its own: it opened Google Maps
 * with a destination and no starting point, so the first thing it asked for was
 * something the app already knew.
 *
 * So the hand-off is now the main action, drawn as one, and it carries its own
 * promise underneath. The second action is the same two points seen rather than
 * followed, and it is a Google Maps link too: a road drawn as a thin line on a
 * 320px square is a worse answer to "which way is it" than the app everyone
 * already has, and it cost a location prompt to draw.
 *
 * NOTHING FLOATS OVER THE TOP OF THE MAP. The category chips that used to sit
 * across it live in `#hdPoi` underneath now, next to the map they drive. A map
 * this size has room for the map or for a toolbar, not both.
 *
 * `mapsUrl` arrives already built by PawaMaps (js/pages/house.js) so the link
 * works before a single line of JavaScript on this page has run. house-place.js
 * then upgrades it in place once a fix is known.
 */
function placeSectionHtml(h, mapsUrl, meetCode, pinLine) {
  const hasPin = mapsUrl ? "" : ` aria-disabled="true"`;
  return `<section class="hx-card" id="sec-place">
    <div class="hx-card__head">${ico(ICO.map)}<h3>${esc(T("hs_h_place", "Where it is"))}</h3></div>
    <p class="hx-sub">${esc(T("hs_place_sub", "The pin, the way there, and how far it is from the places you go."))}</p>
    <div class="hd-map" id="hdMap"></div>

    <div class="hd-go">
      <a class="hd-go__main" id="hdDirBtn"${mapsUrl ? ` href="${mapsUrl}"` : hasPin}
         target="_blank" rel="noopener">
        ${ico(ICO.nav, 18)}
        <span class="hd-go__tx">
          <span class="hd-go__t">${esc(T("hs_dir_go", "Directions in Google Maps"))}</span>
          <small class="hd-go__d">${esc(mapsUrl
            ? T("hs_dir_ready", "Opens with your location and this home already filled in. Nothing to type.")
            : T("hs_dir_nopin", "This listing has no pin yet, so there is nowhere to navigate to."))}</small>
        </span>
      </a>
      <div class="hd-map-actions">
        <a id="hdRouteBtn"${mapsUrl ? ` href="${mapsUrl}"` : hasPin} target="_blank" rel="noopener"
           title="${esc(T("hs_dir_route_d", "The same two points, laid out end to end with the traffic on them."))}">
          ${ico(ICO.route, 15)} ${esc(T("hs_dir_route", "See the whole route in Google Maps"))}</a>
        <a href="meet.html?${meetCode}" target="_blank" rel="noopener">${ico(ICO.video, 15)} ${esc(T("hs_meet", "Live meet with agent"))}</a>
      </div>
      <div class="hd-go__msg" id="hdGoMsg" role="status" aria-live="polite" hidden></div>
    </div>
    <!-- The nearby-category chips mount here: under the map, never over it, and
         under the Google Maps hand-off rather than above it. Eleven wrapped
         chips are 180px, and 180px between the map and the one action on this
         screen somebody is certain to want is the wrong thing to spend them on.
         Here, the map is still on screen when a chip is tapped. -->
    <div class="hd-poi" id="hdPoi" hidden></div>

    ${pinLine}
    <!-- How far is this home from the nearest main (tarmac) road? -->
    <div class="hd-main-road" id="hdMainRoad" hidden></div>
    <!-- How far is this home from the places this person actually goes? The
         saved places come from "Match to my life" on houses.html, so for
         anybody who has used that once there is nothing left to type here. -->
    <div class="hd-commute" id="hdCommute" hidden>
      <p class="hd-commute-label">${esc(T("hs_far_q", "How far is this home from the places you go?"))}</p>
      <div class="hd-saved" id="hdSaved" hidden></div>
      <label class="hd-commute-sub" for="hdCommuteInput">${esc(T("hs_far_other", "Somewhere else"))}</label>
      <div class="hd-commute-row">
        <input type="text" id="hdCommuteInput" autocomplete="off"
          placeholder="${esc(T("hs_far_ph", "Your workplace, school, or an area you know"))}" />
        <button type="button" id="hdCommuteBtn" class="hd-commute-btn">${esc(T("hs_far_go", "Measure"))}</button>
      </div>
      <!-- Google Maps, as soon as the typed area resolves to a point. A real
           anchor with a real href, never a window.open() after an await: the
           second one is a popup the browser blocks. -->
      <a class="hd-commute-open" id="hdCommuteOpen" target="_blank" rel="noopener" hidden>
        ${ico(ICO.nav, 16)}
        <span class="hd-commute-open__tx">
          <span class="hd-commute-open__t">${esc(T("hs_far_open", "Open in Google Maps"))}</span>
          <small class="hd-commute-open__d"></small>
        </span>
      </a>
      <div id="hdCommuteMsg" class="hd-commute-msg" hidden></div>
      <div id="hdCommuteResults" class="hd-commute-results"></div>
    </div>
  </section>`;
}

/**
 * "Now get your things here."
 *
 * The join between the two catalogues this app has always had and never
 * introduced to each other. Everything the panel needs is already on this
 * page: the pin is the destination, the bedroom count is a first guess at how
 * much there is to carry, and the only thing missing is where the reader is
 * standing, which is exactly what the one button buys.
 *
 * The panel itself is js/lib/truck-move-panel.js, mounted after this renders.
 * The card is drawn even on a listing with no pin: the length of the move
 * cannot be measured then, but "which lorries are near me and big enough" is
 * still a question worth answering, and the panel says which half it lost.
 */
function moveSectionHtml(h) {
  if (!window.TruckMovePanel) return "";
  return `<section class="hx-card" id="sec-move">
    <div class="hx-card__head">${ico(ICO.truck)}<h3>${esc(T("hs_h_move", "Moving your things here"))}</h3></div>
    <p class="hx-sub">${esc(T("hs_move_sub",
      "One press finds the lorries that can do this move, closest to you first. Nothing to type."))}</p>
    <div id="hdMovePanel" class="tm"></div>
  </section>`;
}

function nearbySectionHtml(h) {
  return `<section class="hx-card hd-nearby-card" id="sec-nearby">
    <div class="hx-card__head">${ico(ICO.compass)}<h3>${esc(T("hs_h_nearby", "What is nearby"))}</h3></div>
    <p class="hd-nearby-sub">Schools, hospitals, markets, transport and worship around this home.</p>
    <div id="hdNearbyList" class="hd-nearby-list"></div>
  </section>`;
}

/**
 * Who is on the other end of this listing.
 *
 * Two different cards, because they are two different situations for the
 * person reading. An agent's card says "agent". An OWNER's card says so, and
 * says the thing that follows from it: nobody is taking a commission on this
 * room, so there is no agent fee to find on top of the rent, and the number
 * belongs to the person who owns the place.
 *
 * posted_by_owner is set by a database trigger at insert and pinned on update
 * (supabase/features/house/house_owner_accounts.sql). It is never inferred
 * here from a missing agent name or a zero fee, because both of those happen
 * for other reasons.
 */
function agentSectionHtml(h, ctx) {
  const { agentName, agentPhone, agentPhoneClean, waHref, meetCode, initials } = ctx;
  const byOwner = !!(window.OwnerAccount && window.OwnerAccount.isOwnerListing(h));
  const head = byOwner ? T("own_note_t", "Listed by the owner")
                       : T("hd_agent", "Listing agent");
  const role = byOwner
    ? T("own_note_role", "The person who owns it, not an agent.")
    : T("hs_agent_verified", "Verified by Pawa, replies within a day");
  const note = byOwner
    ? `<div class="owner-note">
         <span class="owner-note-ic">${window.OwnerAccount.KEY_SVG}</span>
         <span class="owner-note-tx">
           <span class="owner-note-t">${esc(T("own_note_fee", "No agent fee"))}</span>
           <span class="owner-note-d">${esc(T("own_note_d",
             "There is no agent on this listing, so there is no commission to pay on top of the rent. You are talking to the person who owns it."))}</span>
         </span>
       </div>`
    : "";
  return `<section class="hx-card" id="sec-agent">
    <div class="hx-card__head">${ico(ICO.user)}<h3>${esc(head)}</h3></div>
    ${note}
    <div class="hd-agent">
      <div class="hd-agent-avatar">${esc(initials || "?")}</div>
      <div class="hd-agent-meta">
        <div class="hd-agent-name">${esc(agentName)}</div>
        <div class="hd-agent-role">${esc(role)}</div>
      </div>
    </div>
    <div class="hd-cta-row hd-cta-row-mobile-hide">
      <!-- Message comes first, and that is the point of it being here at all:
           it is the only one of the three that does not cost the seeker their
           phone number before they know the room is free. -->
      ${window.PMReach ? window.PMReach.button(h, { className: "hd-cta hd-cta-msg" }) : ""}
      ${agentPhone ? `<a class="hd-cta hd-cta-call" href="tel:${agentPhoneClean}">${ico(ICO.phone, 16)} Call</a>` : ""}
      ${waHref ? `<a class="hd-cta hd-cta-wa" href="${waHref}" target="_blank" rel="noopener">${ico(ICO.chat, 16)} WhatsApp</a>` : ""}
      <a class="hd-cta hd-cta-meet" href="meet.html?${meetCode}" target="_blank" rel="noopener">${ico(ICO.video, 16)} Request live viewing</a>
    </div>
  </section>`;
}
