// ============================================================================
//  house-rooms.js — "which space, and what does IT cost?"
//
//  WHY THIS EXISTS
//  A Tanzanian letting is rarely one price. One plot holds four singles at
//  60,000 and a master at 150,000; a block holds a godown, two frames and a
//  rooftop. js/lib/house-spec.js already models that honestly — `details.rooms[]`
//  is the listing's real shape — but the detail page did not draw it that way.
//  It drew TWO accounts of the same building, side by side:
//
//    1. a tile grid built from the flat columns (room_kind, bedrooms,
//       bathrooms, size_sqm, price_tzs), and
//    2. a static price table built from details.rooms[].
//
//  And `room_kind` / `price_tzs` are not facts about the listing at all — they
//  are the CHEAPEST room's category and price, projected onto two columns by
//  agent-houses.js so old queries keep working (see house-spec.js). So the tile
//  reading "Room: Single" sat directly beside "4 bedrooms" and a master room's
//  entry in the table below, and a reader had no way to know which of the three
//  the headline price belonged to.
//
//  This module makes the page pick ONE account and hold it: the reader selects
//  a space, and the price, the specification tiles, the vacancy and the whole
//  move-in total then speak about THAT space and nothing else. The building's
//  own facts (how many bedrooms it has in total, its plot size, its type) are
//  still drawn — but under their own heading, so they can never be mistaken for
//  a description of the room being priced.
//
//  THE MONEY IS THE OTHER HALF. "TZS 60,000 / month" is not what it costs to
//  move in. It costs the months paid upfront, plus the deposit the agent wrote
//  into their own rules, plus the agent's commission, plus any one-off charge —
//  and those four numbers used to live in three different cards, never added
//  up. moveIn() adds them up, per room, and is explicit about which parts are
//  stated by the agent and which are this app's assumption.
//
//  Nothing here invents a figure. A room with no price stays "Ask the agent",
//  an unparseable deposit is reported as unparsed, and a total that had to
//  leave something out says so.
//
//  Read by: js/pages/house.js.  Shape owner: js/lib/house-spec.js.
// ============================================================================
(function () {
  "use strict";

  // The TZ market standard: the finder's fee is one month's rent, paid once on
  // signing. It is an ASSUMPTION, not a quote, and every figure derived from it
  // is flagged so the page can say so out loud.
  var DEFAULT_AGENT_FEE_MONTHS = 1;

  // Deposits are written as prose in the rules group ("2 months, refundable",
  // "Miezi 2", "Hakuna"). These read the number back out of that prose, in both
  // languages, and give up rather than guess.
  var DEPOSIT_LABELS = /^(deposit|dhamana|kianzio)$/i;
  var DEPOSIT_NONE   = /^\s*(none|no deposit|hakuna|hamna)\b/i;
  var DEPOSIT_MONTHS = /(\d+)\s*(month|months|mwezi|miezi)/i;

  // "What did the agent mean by this figure" is decided in exactly one place —
  // house-spec.js — so the form, the money engine and the page can never
  // disagree about whether 0 means free or means nobody said. The fallbacks
  // keep this module usable on a page that did not bundle house-spec.js.
  function cost(v) {
    var S = window.HouseSpec;
    if (S && S.parseCost) return S.parseCost(v);
    var n = Number(v);
    if (v == null || v === "" || !isFinite(n)) return { known: false, free: false, amount: null };
    return n <= 0 ? { known: true, free: true, amount: 0 } : { known: true, free: false, amount: n };
  }
  function freeWord() {
    var S = window.HouseSpec;
    return S && S.freeLabel ? S.freeLabel() : "Free";
  }
  // The money lines read in whichever language the reader is in. The fallbacks
  // keep this module usable on a page that did not bundle house-spec.js.
  var EN = {
    m_rent: "Rent", m_price: "Price", m_first: "First month's rent",
    m_upfront: "months' rent, upfront", m_deposit: "Deposit", m_none: "None",
    m_fee: "Agent commission",
    m_fee_sub: "usually one month's rent, not quoted by this agent",
    m_fee_owner: "no agent on this listing",
    m_ask: "Ask the agent", m_oneoff: "one-off",
  };
  function t(key) {
    var S = window.HouseSpec;
    var v = S && S.t ? S.t(key) : "";
    return v || EN[key] || "";
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function money(n) {
    return (window.formatTZS || function (v) {
      return "TZS " + Number(v || 0).toLocaleString("en-US");
    })(n);
  }

  function spec() { return window.HouseSpec || null; }

  // -------------------------------------------------------------- the model
  /**
   * Every priced space in this listing, in the order the agent entered them.
   *
   * A listing saved before the spec sheet existed has no rooms[] — only the two
   * flat columns. Rather than draw nothing, we synthesise the one space those
   * columns describe and mark it `synthetic`, so the page reads the same way
   * for an old listing as for a new one and callers can still tell them apart.
   */
  function rooms(row) {
    var HS = spec();
    var list = HS ? HS.fromRow(row).rooms.slice() : [];

    if (!list.length) {
      var price = Number(row && row.price_tzs);
      list.push({
        kind: (row && row.room_kind) || "whole_house",
        price: Number.isFinite(price) && price > 0 ? price : null,
        period: (row && row.period) === "total" ? "total" : (row && row.period) || "month",
        count: 1,
        vacant: null,
        ensuite: false,
        size: Number(row && row.size_sqm) || null,
        sizeBand: null,
        features: [],
        note: "",
        synthetic: true,
      });
    }

    var cheapest = null;
    list.forEach(function (r) {
      if (r.price == null || !(r.price > 0)) return;
      if (cheapest == null || r.price < cheapest) cheapest = r.price;
    });

    return list.map(function (r, i) {
      return {
        i: i,
        kind: r.kind,
        label: HS ? HS.roomLabel(r.kind) : String(r.kind || ""),
        price: r.price,
        period: r.period,
        periodLabel: HS ? HS.periodLabel(r.period) : "",
        count: r.count || 1,
        vacant: r.vacant,
        ensuite: !!r.ensuite,
        size: r.size,
        sizeBand: r.sizeBand || null,
        features: Array.isArray(r.features) ? r.features : [],
        // What the room is LIKE, in the agent's words, beside the chips that
        // say what it HAS. Captured on the form and never shown is the same as
        // not captured.
        traits: r.traits || "",
        note: r.note || "",
        synthetic: !!r.synthetic,
        // vacant === 0 is "every one of these is taken right now", which is a
        // real and useful state. vacant == null is "the agent did not say",
        // which is NOT the same thing and must never be drawn as though it is.
        taken: r.vacant === 0,
        cheapest: cheapest != null && r.price === cheapest && list.length > 1,
      };
    });
  }

  /** The room a reader should land on: the cheapest one still available. */
  function defaultRoom(list) {
    var free = list.filter(function (r) { return !r.taken; });
    var pool = free.length ? free : list;
    var best = pool[0];
    pool.forEach(function (r) {
      if (r.price != null && r.price > 0 && (best.price == null || r.price < best.price)) best = r;
    });
    return best.i;
  }

  // ------------------------------------------------------------- the deposit
  /**
   * What the agent wrote in their own "Deposit" line, read back as a number of
   * months where that is possible.
   *
   * Returns { months, none, text } — `months` null when the line says something
   * this cannot parse ("negotiable", "one month plus the water bill"). A null
   * months is NOT zero: the caller must show the agent's words and leave the
   * total open, because quietly treating an unreadable deposit as no deposit is
   * how somebody arrives at a signing 150,000 short.
   */
  function deposit(row) {
    var HS = spec();
    if (!HS) return null;
    var found = null;
    HS.fromRow(row).groups.forEach(function (g) {
      g.items.forEach(function (it) {
        if (found || !DEPOSIT_LABELS.test(String(it.label || "").trim())) return;
        found = { text: it.value, note: it.note || "" };
      });
    });
    if (!found) return null;
    if (DEPOSIT_NONE.test(found.text)) return { months: 0, none: true, text: found.text };
    var m = DEPOSIT_MONTHS.exec(found.text);
    return { months: m ? parseInt(m[1], 10) : null, none: false, text: found.text };
  }

  // ------------------------------------------------------------- the money
  /**
   * What it costs to move into ONE named space, itemised.
   *
   * Every line carries where it came from:
   *   stated   the agent wrote this number
   *   assumed  the market default, used because the agent left it blank
   *   open     something is owed here and we cannot price it
   *
   * `total` only ever adds up the lines it could price, and `open` is what the
   * caller must show alongside it. A total presented as complete when it is not
   * is worse than no total at all.
   */
  function moveIn(row, room) {
    var isRent   = (row.listing || "rent") === "rent";
    var perMonth = room.period === "month";
    var rent     = room.price != null && room.price > 0 ? room.price : null;
    var lines    = [];
    var open     = [];
    var total    = 0;

    // A sale, or a space priced per day / week / year / total, has no move-in
    // arithmetic that this app can honestly do. Say the price and stop.
    if (!isRent || !perMonth) {
      if (rent != null) {
        lines.push({ k: isRent ? t("m_rent") : t("m_price"), v: money(rent), sub: room.periodLabel, src: "stated" });
        total = rent;
      } else {
        open.push("The price of this space");
      }
      return { lines: lines, open: open, total: rent, complete: rent != null, monthly: null, simple: true };
    }

    // 1. Rent paid upfront.
    var months = Math.max(1, Math.round(Number(row.min_months) || 1));
    if (rent != null) {
      var upfront = rent * months;
      lines.push({
        k: months > 1 ? months + " " + t("m_upfront") : t("m_first"),
        v: money(upfront),
        sub: months > 1 ? money(rent) + " x " + months : null,
        src: "stated",
      });
      total += upfront;
    } else {
      open.push("The rent for this space");
    }

    // 2. The deposit the agent named in their own rules.
    var dep = deposit(row);
    if (dep && dep.none) {
      lines.push({ k: t("m_deposit"), v: t("m_none"), src: "stated", muted: true });
    } else if (dep && dep.months != null && rent != null) {
      var depAmt = rent * dep.months;
      lines.push({
        k: t("m_deposit"),
        v: money(depAmt),
        sub: dep.text,
        src: "stated",
      });
      total += depAmt;
    } else if (dep) {
      lines.push({ k: t("m_deposit"), v: dep.text, src: "open", muted: true });
      open.push("The deposit (" + dep.text + ")");
    }

    // 3. The agent's commission. Stated, or the market's one month.
    //
    //    ...unless there is no agent. On a listing the owner posted themselves
    //    there is nobody to pay a commission to, and assuming the market's
    //    month here would invent the single largest cost on the page and put
    //    it directly under a card that says there is no agent fee. Said as a
    //    LINE rather than left out, because "no commission" is the best news
    //    on the page and a reader comparing two rooms has to be able to see
    //    it. Same reasoning as the zero one-off charges below.
    var feeStated = Number(row.agent_fee_tzs);
    var byOwner = !!(window.OwnerAccount && window.OwnerAccount.isOwnerListing(row));
    if (byOwner) {
      lines.push({ k: t("m_fee"), v: freeWord(), sub: t("m_fee_owner"), src: "stated", free: true });
    } else if (Number.isFinite(feeStated) && feeStated > 0) {
      lines.push({ k: t("m_fee"), v: money(feeStated), src: "stated" });
      total += feeStated;
    } else if (rent != null) {
      var feeAssumed = rent * DEFAULT_AGENT_FEE_MONTHS;
      lines.push({
        k: t("m_fee"),
        v: money(feeAssumed),
        sub: t("m_fee_sub"),
        src: "assumed",
      });
      total += feeAssumed;
    }

    // 4. One-off charges the agent itemised (connection fees, keys, a survey).
    // Zero is an answer, not a gap: "no connection fee" is one of the better
    // things a listing can say, and it used to be filed with the unknowns and
    // rendered "Ask the agent" — turning the best news in the listing into a
    // phone call. cost() tells the three apart: stated, stated-as-free, absent.
    (Array.isArray(row.extra_costs) ? row.extra_costs : []).forEach(function (c) {
      if (!c || !c.label || c.billing !== "oneoff") return;
      var p = cost(c.amount);
      if (p.free) {
        lines.push({ k: c.label, v: freeWord(), sub: t("m_oneoff"), src: "stated", free: true });
      } else if (p.known) {
        lines.push({ k: c.label, v: money(p.amount), sub: t("m_oneoff"), src: "stated" });
        total += p.amount;
      } else {
        lines.push({ k: c.label, v: t("m_ask"), src: "open", muted: true });
        open.push(c.label);
      }
    });

    // ...and what lands every month after that, which is a different question.
    var bills = [];
    (Array.isArray(row.extra_costs) ? row.extra_costs : []).forEach(function (c) {
      if (!c || !c.label || c.billing === "oneoff") return;
      var p = cost(c.amount);
      bills.push({
        label: c.label,
        // amount 0 with free:true is "water is included". amount null is "we
        // do not know". They must not collapse into the same null again.
        amount: p.known ? p.amount : null,
        free: p.free,
        billing: c.billing || "month",
      });
    });
    var billTotal = bills.reduce(function (s, b) {
      return b.billing === "month" && b.amount != null ? s + b.amount : s;
    }, 0);

    return {
      lines: lines,
      open: open,
      total: lines.length ? total : null,
      complete: open.length === 0 && rent != null,
      months: months,
      monthly: rent == null ? null : {
        rent: rent,
        bills: bills,
        total: billTotal > 0 ? rent + billTotal : rent,
        hasUnknownBills: bills.some(function (b) { return b.amount == null && !b.free && b.billing === "month"; }),
      },
      simple: false,
    };
  }

  // -------------------------------------------------------------- rendering
  var ICONS = {
    size:   'M3 8V5a2 2 0 0 1 2-2h3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M21 16v3a2 2 0 0 1-2 2h-3',
    bath:   'M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM5 12V6a2 2 0 0 1 4 0M8 6h2M7 19l-1 2M18 19l1 2',
    count:  'M3 21h18M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M14.5 12h.01',
    bed:    'M3 18v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5M3 18v2M21 18v2M7 11V8a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v3',
    type:   'M3 11l9-7 9 7M5 10v10h14V10M9 20v-6h6v6',
    chair:  'M3 12V8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4M3 12a2 2 0 0 1 2 2v3h14v-3a2 2 0 0 1 2-2M5 17v2M19 17v2',
    date:   'M3 4h18v18H3zM16 2v4M8 2v4M3 10h18',
    clock:  'M12 13V9M12 13l2.5 2M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM5 3L2 6M19 3l3 3',
    tag:    'M20.6 13.4 12 22l-9-9V3h10zM7.5 7.5h.01',
  };

  function icon(d) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
           'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
  }

  function tile(d, value, label, opts) {
    opts = opts || {};
    return '<div class="hx-spec' + (opts.feature ? " hx-spec--feature" : "") + '">' +
      '<span class="hx-spec__icon">' + icon(d) + '</span>' +
      '<span class="hx-spec__val">' + (opts.raw ? value : esc(String(value))) + '</span>' +
      '<span class="hx-spec__lbl">' + esc(label) + '</span>' +
    '</div>';
  }

  /** The tiles that describe THE SELECTED SPACE — never the building. */
  function roomTiles(room) {
    var S = window.HouseSpec;
    var out = [];
    out.push(tile(ICONS.tag, room.label, "This space", { feature: true }));
    // A bracket the agent chose beats a square-metre figure they estimated to
    // fill a box. Both are shown when both exist — a real measurement is worth
    // keeping — but the bracket leads, because it is the one that was meant.
    if (room.sizeBand && S && S.sizeLabel) {
      out.push(tile(ICONS.size, S.sizeLabel(room.sizeBand), "Size"));
    }
    if (room.size) out.push(tile(ICONS.size, room.size + ' <small>m&sup2;</small>', "Floor area", { raw: true }));
    out.push(tile(ICONS.bath, room.ensuite ? "Own" : "Shared", "Bathroom"));
    if (room.count > 1) out.push(tile(ICONS.count, room.count, "Of this kind"));
    if (room.periodLabel) out.push(tile(ICONS.clock, room.periodLabel.replace(/^per\s+/i, ""), "Billed per"));
    return out.join("");
  }

  /**
   * The characteristics of the selected space — "bathroom inside", "tiled
   * floor", "sink board", and whatever else the agent wrote.
   *
   * These are the facts a renter decides on and the old schema had no box for,
   * so they used to end up in the description where they cannot be compared.
   * Rendered as plain chips: no icons, because the catalogue is open and an
   * agent's invented characteristic would be the only one without a picture.
   */
  function roomFeaturesHtml(room) {
    var S = window.HouseSpec;
    var labels = S && S.featureLabels ? S.featureLabels(room && room.features)
      : (Array.isArray(room && room.features) ? room.features.slice() : []);
    if (!labels.length) return "";
    return '<ul class="hx-feats">' + labels.map(function (l) {
      return '<li class="hx-feat">' + esc(l) + '</li>';
    }).join("") + '</ul>';
  }

  /** The "judge the rest from the photos" line, shown under a size bracket. */
  function sizeNoteHtml(room) {
    var S = window.HouseSpec;
    if (!room || !room.sizeBand || !S || !S.sizeNote) return "";
    var hint = S.sizeHint ? S.sizeHint(room.sizeBand) : "";
    return '<p class="hx-size-note">' + esc(S.sizeNote()) +
      (hint ? ' <span class="hx-size-hint">' + esc(hint) + '</span>' : "") + '</p>';
  }

  /**
   * The tiles that describe THE BUILDING.
   *
   * room_kind is deliberately absent: it holds the cheapest room's category,
   * the picker above already names every category properly, and a "Room:
   * Single" tile next to "4 bedrooms" is exactly the confusion this rebuild
   * exists to remove.
   */
  function buildingTiles(row, labelType, formatDate) {
    var out = [];
    out.push(tile(ICONS.type, labelType(row.type), "Property"));
    if (row.bedrooms)  out.push(tile(ICONS.bed,  row.bedrooms,  row.bedrooms === 1 ? "Bedroom" : "Bedrooms"));
    if (row.bathrooms) out.push(tile(ICONS.bath, row.bathrooms, row.bathrooms === 1 ? "Bathroom" : "Bathrooms"));
    if (row.size_sqm)  out.push(tile(ICONS.size, row.size_sqm + ' <small>m&sup2;</small>', "Total size", { raw: true }));
    if (row.furnished && row.furnished !== "n/a" && row.furnished !== "no")
      out.push(tile(ICONS.chair, row.furnished === "yes" ? "Furnished" : "Semi", "Furnishing"));
    if ((row.listing || "rent") === "rent" && Number(row.min_months) > 1)
      out.push(tile(ICONS.clock, row.min_months + ' <small>mo</small>', "Pay upfront", { raw: true }));
    if (row.available_from) out.push(tile(ICONS.date, formatDate(row.available_from), "Available"));
    return out.join("");
  }

  /** One tab in the picker. */
  function tab(room, selected) {
    var price = room.price != null && room.price > 0 ? money(room.price) : t("m_ask");
    return '<button type="button" role="tab" class="hx-roomtab' + (room.taken ? " is-taken" : "") + '"' +
      ' aria-selected="' + (selected ? "true" : "false") + '"' +
      ' id="hxRoomTab' + room.i + '" aria-controls="hxRoomPanel" data-room="' + room.i + '">' +
      '<span class="hx-roomtab__k">' + esc(room.label) + '</span>' +
      '<span class="hx-roomtab__p">' + esc(price) + '</span>' +
      (room.cheapest ? '<span class="hx-roomtab__flag">Cheapest</span>' : "") +
    '</button>';
  }

  /** The vacancy meter for the selected space. */
  function vacancy(room) {
    if (room.vacant == null) return "";
    var free = Math.max(0, Math.min(room.count, room.vacant));
    var pips = "";
    for (var i = 0; i < room.count && i < 24; i++) {
      pips += '<span class="hx-vacancy__pip ' + (i < free ? "is-free" : "is-taken") + '"></span>';
    }
    var word = free === 0
      ? "All taken right now"
      : (room.count > 1 ? free + " of " + room.count + " free now" : "Free now");
    return '<div class="hx-vacancy' + (free === 0 ? " hx-vacancy--none" : "") + '">' +
      '<div class="hx-vacancy__row"><span>' + esc(word) + '</span></div>' +
      '<div class="hx-vacancy__pips">' + pips + '</div>' +
    '</div>';
  }

  /** The selected space's panel: name, note, price, vacancy, its own tiles. */
  function roomPanel(room) {
    var priced = room.price != null && room.price > 0;
    return '<div class="hx-room">' +
      '<div class="hx-room__top">' +
        '<div>' +
          '<div class="hx-room__name">' + esc(room.label) + '</div>' +
          (room.traits ? '<div class="hx-room__traits">' + esc(room.traits) + '</div>' : "") +
          (room.note ? '<div class="hx-room__note">' + esc(room.note) + '</div>' : "") +
        '</div>' +
        '<div class="hx-room__price' + (priced ? "" : " is-ask") + '">' +
          (priced
            ? esc(money(room.price)) + '<small>' + esc(room.periodLabel) + '</small>'
            : "Ask the agent") +
        '</div>' +
      '</div>' +
      vacancy(room) +
    '</div>' +
    '<div class="hx-specs-split">' +
      '<div class="hx-specs-split__label">What this space is</div>' +
      '<div class="hx-specs">' + roomTiles(room) + '</div>' +
      sizeNoteHtml(room) +
      featuresBlock(room) +
    '</div>';
  }

  /** The characteristics list, under its own label so it reads as a list of
   *  facts rather than more tiles. Absent entirely when there are none — an
   *  empty "Characteristics" heading says nothing and costs a screenful. */
  function featuresBlock(room) {
    var html = roomFeaturesHtml(room);
    if (!html) return "";
    return '<div class="hx-specs-split__label hx-specs-split__label--sub">' +
      'What it has' + '</div>' + html;
  }

  window.HouseRooms = {
    rooms: rooms,
    defaultRoom: defaultRoom,
    deposit: deposit,
    moveIn: moveIn,
    money: money,
    icon: icon,
    ICONS: ICONS,
    tile: tile,
    tab: tab,
    roomPanel: roomPanel,
    buildingTiles: buildingTiles,
    roomFeaturesHtml: roomFeaturesHtml,
    sizeNoteHtml: sizeNoteHtml,
  };
})();
