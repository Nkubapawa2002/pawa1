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
const SECTION_LABELS = {
  "sec-money":     "Price",
  "sec-rooms":     "Rooms",
  "sec-about":     "About",
  "sec-rules":     "Rules & area",
  "sec-costs":     "Bills",
  "sec-amenities": "Amenities",
  "sec-place":     "Location",
  "sec-nearby":    "Nearby",
  "sec-agent":     "Agent",
};
const SECTION_ORDER = [
  "sec-money", "sec-rooms", "sec-about", "sec-rules", "sec-costs",
  "sec-amenities", "sec-place", "sec-nearby", "sec-agent",
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
             : (h.listing === "sale" ? "Asking price" : "Rent for this place");

  const head = priced
    ? `<div class="hd-price">${esc(HR.money(room.price))} <small>${esc(room.periodLabel || "")}</small></div>`
    : `<div class="hx-money__ask">Price on request — the agent has not named one for this space.</div>`;

  // What the headline does NOT say, said once, here.
  const notes = [];
  if (many) notes.push(`One of <strong>${list.length}</strong> kinds of space in this listing.`);
  if ((h.listing || "rent") === "rent" && Number(h.min_months) > 1)
    notes.push(`Minimum <strong>${esc(String(h.min_months))} months</strong> paid upfront.`);

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

  const caveats = [];
  if (mi.open.length) {
    caveats.push(`This total leaves out ${esc(joinList(mi.open))} — the agent has not put a number on ${mi.open.length === 1 ? "it" : "them"}.`);
  }
  if (assumed) {
    caveats.push(`The commission here is the market standard of one month's rent, not a quote from this agent. Confirm it before you sign.`);
  }

  // The chart carries the same figures in its legend and again in its table
  // view, so rendering the itemised lists as well would put every number on
  // screen twice in a row. The lists stay as the fallback for a page that did
  // not bundle the chart.
  const chart = window.HouseCostChart ? window.HouseCostChart.render(mi) : "";

  const m = mi.monthly;
  const monthlyBlock = !m ? "" : `
    <div class="hx-specs-split__label" style="margin-top:16px">Then, every month</div>
    <ul class="hx-lines">
      <li><span class="hx-line-k">Rent</span><span class="hx-line-v">${esc(window.HouseRooms.money(m.rent))}</span></li>
      ${m.bills.map(b => `<li${b.amount == null && !b.free ? ' class="is-muted"' : ""}${b.free ? ' class="is-free"' : ""}>
        <span class="hx-line-k">${esc(b.label)}</span>
        <span class="hx-line-v">${esc(billValue(b))}</span>
      </li>`).join("")}
      ${m.hasUnknownBills ? "" : `<li class="is-total">
        <span class="hx-line-k">Every month</span>
        <span class="hx-line-v">${esc(window.HouseRooms.money(m.total))}</span>
      </li>`}
    </ul>`;

  return `
    <div class="hx-movein">
      <button type="button" class="hx-movein__toggle" id="hxMoveinBtn"
              aria-expanded="false" aria-controls="hxMoveinBody">
        <span class="hx-movein__label">To move in
          <small>rent upfront + deposit + commission</small>
        </span>
        <span class="hx-movein__total">${esc(total)}</span>
        <span class="hx-movein__chev">${ico(ICO.chevron, 16)}</span>
      </button>
      <div class="hx-movein__body" id="hxMoveinBody">
        ${chart || `
        <ul class="hx-lines">
          ${mi.lines.map(lineHtml).join("")}
          ${mi.total != null ? `<li class="is-total">
            <span class="hx-line-k">${mi.complete ? "Total to move in" : "Total of the priced items"}</span>
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
  if (b.billing === "included") return "Included";
  if (b.billing === "metered")  return "Pay as you use";
  // Stated as costing nothing. This is a fact worth reading, and it must not
  // render as "TZS 0" (which looks like a data error) or fall through to
  // "Ask the agent" (which is what it used to do).
  if (b.free)                   return window.HouseSpec && window.HouseSpec.freeLabel
                                  ? window.HouseSpec.freeLabel() : "Free";
  if (b.amount != null)         return window.HouseRooms.money(b.amount);
  return (window.HouseSpec && window.HouseSpec.t && window.HouseSpec.t("m_ask")) || "Ask the agent";
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
    ? `This place is let space by space. Pick one — its price, its specification and the move-in total above all follow your choice.`
    : (list[0].synthetic
        ? `This listing predates the room-by-room sheet, so what follows is the one space its original entry described.`
        : `This listing offers one kind of space.`);

  return `<section class="hx-card" id="sec-rooms">
    <div class="hx-card__head">
      ${ico(ICO.door)}
      <h3>Rooms &amp; specifications</h3>
      ${many ? `<span class="hx-card__count">${list.length}</span>` : ""}
    </div>
    <p class="hx-sub">${esc(sub)}</p>
    ${many ? `<div class="hx-rooms__picker" role="tablist" aria-label="Spaces in this listing">
      ${list.map(r => HR.tab(r, r.i === i)).join("")}
    </div>` : ""}
    <div id="hxRoomPanel" role="tabpanel" aria-labelledby="hxRoomTab${i}">
      ${HR.roomPanel(list[i])}
    </div>
    <div class="hx-specs-split">
      <div class="hx-specs-split__label">The whole property</div>
      <div class="hx-specs">${HR.buildingTiles(h, labelType, formatDate)}</div>
    </div>
  </section>`;
}

function aboutSectionHtml(h) {
  if (!h.description) return "";
  return `<section class="hx-card" id="sec-about">
    <div class="hx-card__head">${ico(ICO.text)}<h3>About this property</h3></div>
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
      <h3>What the agent commits to</h3>
      <span class="hx-card__count">${groups.length}</span>
    </div>
    <p class="hx-sub">The rules, the neighbourhood, the services and the paperwork — written by the agent, in their own words.</p>
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
    if (b === "included")     right = `<span class="hx-tag hx-tag--ok">Included in rent</span>`;
    else if (b === "metered") right = `<span class="hx-tag hx-tag--info">Pay as you use</span>`;
    else if (has)             right = `<span class="hx-line-v">${esc(window.HouseRooms.money(amt))}${
                                        b === "month" ? " / month" : b === "oneoff" ? " once" : ""}</span>`;
    else                      right = `<span class="hx-tag hx-tag--ask">Ask the agent</span>`;
    return `<li class="hx-bill">
      <span class="hx-bill__k">${costIcon(c.label)}${esc(c.label)}</span>
      ${right}
    </li>`;
  }).join("");

  return `<section class="hx-card" id="sec-costs">
    <div class="hx-card__head">
      ${ico(ICO.bolt)}
      <h3>Bills &amp; extra costs</h3>
      <span class="hx-card__count">${costs.length}</span>
    </div>
    <p class="hx-sub">What the tenant pays on top of the rent above.</p>
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
      <h3>Amenities</h3>
      <span class="hx-card__count">${list.length}</span>
    </div>
    <div class="hd-chips">
      ${list.map(a => `<span class="hd-chip">${amenityIcon(a)}${esc(labelAmenity(a))}</span>`).join("")}
    </div>
  </section>`;
}

function placeSectionHtml(h, mapsUrl, meetCode, pinLine) {
  return `<section class="hx-card" id="sec-place">
    <div class="hx-card__head">${ico(ICO.map)}<h3>Where it is</h3></div>
    <div class="hd-map" id="hdMap"></div>
    <div class="hd-map-actions">
      <a href="#" id="hdRouteBtn" role="button">${ico(ICO.route, 15)} Route from my location</a>
      <a href="${mapsUrl}" target="_blank" rel="noopener">${ico(ICO.nav, 15)} Get directions</a>
      <a href="meet.html?${meetCode}" target="_blank" rel="noopener">${ico(ICO.video, 15)} Live meet with agent</a>
    </div>
    ${pinLine}
    <!-- How far is this home from the nearest main (tarmac) road? -->
    <div class="hd-main-road" id="hdMainRoad" hidden></div>
    <!-- Commute tool: how far is this home from your workplace / daily route? -->
    <div class="hd-commute" id="hdCommute" hidden>
      <label class="hd-commute-label" for="hdCommuteInput">How far is this home from your workplace or daily route?</label>
      <div class="hd-commute-row">
        <input type="text" id="hdCommuteInput" autocomplete="off"
          placeholder="e.g. Mlimani City, Muhimbili Hospital, your office area…" />
        <button type="button" id="hdCommuteBtn" class="hd-commute-btn">Measure</button>
      </div>
      <div id="hdCommuteMsg" class="hd-commute-msg" hidden></div>
      <div id="hdCommuteResults" class="hd-commute-results"></div>
    </div>
  </section>`;
}

function nearbySectionHtml(h) {
  return `<section class="hx-card hd-nearby-card" id="sec-nearby">
    <div class="hx-card__head">${ico(ICO.compass)}<h3>What's nearby</h3></div>
    <p class="hd-nearby-sub">Schools, hospitals, markets, transport and worship around this home.</p>
    <div id="hdNearbyList" class="hd-nearby-list"></div>
  </section>`;
}

function agentSectionHtml(h, ctx) {
  const { agentName, agentPhone, agentPhoneClean, waHref, meetCode, initials } = ctx;
  return `<section class="hx-card" id="sec-agent">
    <div class="hx-card__head">${ico(ICO.user)}<h3>Listing agent</h3></div>
    <div class="hd-agent">
      <div class="hd-agent-avatar">${esc(initials || "?")}</div>
      <div class="hd-agent-meta">
        <div class="hd-agent-name">${esc(agentName)}</div>
        <div class="hd-agent-role">Verified by Pawa · responds within 1 day</div>
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
