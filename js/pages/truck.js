// ============================================================================
//  Truck detail page  (truck.html?id=t-001)
//
//  ONE LORRY, AND THE ONE QUESTION THE READER HAS
//  This sheet used to answer "what is this truck": a gallery, six facts, a
//  paragraph and a phone number. The question somebody arriving from a
//  property sheet actually has is "will THIS one do MY move?", and until now
//  they had to work it out themselves from a tonnage and a coverage word.
//
//  So the sheet is arranged around that:
//
//    identity   the photos, the price, what it is, where it is based
//    your move  the plan they carried in, measured against this lorry: how far
//               it is from them, whether it fits the load, whether the trip is
//               inside what the owner offers, and a Google Maps link with the
//               base, the pickup and the new home already filled in
//    facts      the spec tiles
//    kit        what comes with it, grouped the way the owner was asked
//    about      their own words
//    place      where it sleeps, and the way there
//    contact    the encrypted door first, then the phone
//
//  THE PLAN RIDES IN THE URL. js/lib/truck-match.js owns that format
//  (encode/decode), so the property sheet, the directory and this page cannot
//  drift from each other. Arriving with no plan, the "your move" panel simply
//  does not draw: an empty panel headed "your move" reads as "we lost it".
//
//  EVERY VISIBLE STRING GOES THROUGH T(). This file used to be written in
//  English and nowhere else: a Swahili customer met "Truck type", "Capacity",
//  "Driver", "Loaders" and "Contact the owner" in English on the one screen
//  where they decide whether to ring somebody. The scan in
//  tests/i18n_coverage.mjs never looked here, and even now it can only reach
//  the "not found" state, because a detail sheet with no listing on it shows
//  none of these strings. tests/detail_sheet_i18n_test.mjs is the one that
//  renders a real sheet.
//
//  The truck-type words are NOT kept here. js/lib/listing-kinds.js is the one
//  place a stored kind becomes a word a person reads, and it already knows
//  that trucks.truck_type is free text: a kind nobody recognises is
//  title-cased and shown as typed rather than flattened to "Other".
// ============================================================================

(function () {
  "use strict";

  // t() with a hard fallback: a missing key must show the English word rather
  // than the key name.
  const T = (k, en) => {
    const v = window.t ? window.t(k) : k;
    return v === k && en != null ? en : v;
  };
  const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

  // How far the truck goes, said about the owner rather than by them.
  const COVERAGE = {
    within_city: "of_cov_city", region_wide: "of_cov_region", cross_region: "of_cov_cross",
  };
  const NOTHING = "—";     // an em dash on its own: nobody said

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function photoUrls(t) {
    const arr = (Array.isArray(t.photos) && t.photos.length ? t.photos : [t.photo]).filter(Boolean);
    return arr.map((p) => window.DataStore.truckPhotoUrl(p)).filter(Boolean);
  }
  function typeLabel(tt) {
    return (window.ListingKinds && window.ListingKinds.label("trucks", tt)) || T("td_truck", "Moving truck");
  }
  function coverage(a) { return COVERAGE[a] ? T(COVERAGE[a]) : NOTHING; }

  /**
   * What the owner said comes with the truck, in the groups they were asked in.
   *
   * The listing form (agent-trucks.html) writes these into trucks.details as a
   * list of catalogue keys and free text, indistinguishable on purpose.
   * js/lib/offer-spec.js turns both into the words a customer reads, in their
   * own language for the catalogue half and exactly as typed for the rest.
   *
   * The grouping is new, and it is the difference between five answers and one
   * wall of eighteen ticks: the body, the crew, the kit, the trip, the
   * paperwork. Anything the catalogue does not recognise is the owner's own
   * sentence, and it goes last under its own heading rather than being dropped
   * or guessed at.
   *
   * Nothing is drawn when nothing was said: an empty panel headed "what comes
   * with it" reads as "nothing", which is not what a blank field means.
   */
  function kitPanel(t) {
    const spec = window.TruckSpec;
    const raw = t && t.details && Array.isArray(t.details.kit) ? t.details.kit : [];
    if (!spec || !raw.length) return "";
    const list = spec.normalize(raw);
    if (!list.length) return "";

    const say = window.OfferSpec ? window.OfferSpec.say : (p) => (p && (p.en || p)) || "";
    const seen = new Set();
    const groups = spec.GROUPS.map((g) => {
      const items = g.items
        .filter((it) => list.indexOf(it.key) >= 0)
        .map((it) => { seen.add(it.key); return say(it); });
      return items.length ? { title: say(g.title), items } : null;
    }).filter(Boolean);

    // Whatever the owner typed themselves. Never translated, never normalised.
    const own = list.filter((v) => !seen.has(v));
    if (own.length) groups.push({ title: T("td_kit_own", "In their own words"), items: own });
    if (!groups.length) return "";

    return `<div class="td-panel"><p class="td-h">${esc(T("of_kit_h", "What comes with it"))}</p>
      ${groups.map((g) => `<div class="td-kit-group"><h4>${esc(g.title)}</h4>
        <ul class="of-list">${g.items.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>`).join("")}
    </div>`;
  }

  // The separator before "negotiable" is joined to it by a non-breaking space
  // ( ), so a price that wraps never leaves a dangling separator at the
  // end of the line.
  function formatPrice(t) {
    const p = t.price_tzs || 0;
    let v;
    if (p >= 1_000_000) v = (p / 1_000_000).toFixed(p % 1_000_000 === 0 ? 0 : 1) + "M";
    else if (p >= 1_000) v = (p / 1_000).toFixed(0) + "k";
    else v = String(p);
    return `${esc(T("of_from", "from"))} TZS ${v} <small>/ ${esc(T("of_unit_trip", "trip"))}` +
      `${t.negotiable ? " · " + esc(T("of_negotiable", "negotiable")) : ""}</small>`;
  }
  function cleanPhone(p) { return String(p || "").replace(/[^\d+]/g, ""); }
  function waNumber(p) { return String(p || "").replace(/[^\d]/g, ""); }

  // ==========================================================================
  //  "WILL IT DO MY MOVE?"
  // ==========================================================================

  /**
   * The panel that measures THIS lorry against the plan the reader carried in.
   *
   * Drawn only when there is a plan. With nothing carried in, the page still
   * offers the one thing it can offer cold: a location button, which turns
   * into the same panel the moment it answers.
   */
  function movePanel(t, ctx) {
    const UI = window.TruckMoveUI, TM = window.TruckMove;
    if (!UI || !TM) return "";
    const planned = !!(ctx && (ctx.to || ctx.from || ctx.load));
    return `<div class="td-panel tm" id="tdMovePanel">
      <p class="td-h">${esc(T("td_h_move", "Your move"))}</p>
      <div id="tdMoveBody">${planned ? "" :
        `<p class="tm-msg">${esc(T("td_move_cold",
          "Say where your things are and we will measure the road from this truck to you."))}</p>`}</div>
      <button type="button" class="tm-go" id="tdMoveBtn">${UI.ico("gps", 18)}<span>${
        esc(planned ? T("td_move_check", "Measure this truck against my move")
                    : T("tm_use_gps", "Use my location"))}</span></button>
      <p class="tm-msg" id="tdMoveMsg" role="status" aria-live="polite" hidden></p>
    </div>`;
  }

  /** Redraw the panel body from whatever the plan now holds. */
  function paintMove(t, ctx) {
    const UI = window.TruckMoveUI, TM = window.TruckMove;
    const body = document.getElementById("tdMoveBody");
    if (!body || !UI || !TM) return;
    const ranked = TM.rank([t], ctx);
    const row = ranked[0];
    // One card, and no crown on it: a recommendation needs something to have
    // been chosen over, and this sheet only ever shows one lorry.
    body.innerHTML =
      (ctx.tripKm != null
        ? `<div class="tm-trip"><span class="tm-trip__n">${esc(TM.kmText(ctx.tripKm))}</span>` +
          `<span>${esc(fill(T("tm_trip", "by road from where you are, about {min} minutes of driving"),
                            { min: TM.driveMin(ctx.tripKm) }))}</span>` +
          `<span class="tm-trip__note">${esc(T("tm_trip_note",
            "The owner quotes the price. This is the distance they will be quoting for."))}</span></div>`
        : "") +
      UI.fitsHtml(row, ctx) +
      UI.actsHtml(row, ctx);
  }

  // ==========================================================================
  //  RENDER
  // ==========================================================================

  async function init() {
    const bodyEl = document.getElementById("tdBody");
    const params = new URLSearchParams(location.search);
    const id = params.get("id");
    const TM = window.TruckMove;
    // The plan, exactly as the property sheet or the directory handed it over.
    const ctx = TM ? TM.decode(location.search) : { to: null, from: null, load: null };
    if (ctx) ctx.roadKm = new Map();

    let t = null;
    try {
      const all = await window.DataStore.getTrucks();
      t = all.find((x) => String(x.id) === String(id));
    } catch (e) { console.warn("[truck] load failed", e); }

    if (!t) {
      bodyEl.removeAttribute("aria-busy");
      bodyEl.innerHTML =
        `<div class="td-missing"><h2>${esc(T("td_missing_h", "Truck not found"))}</h2>` +
        `<p>${esc(T("td_missing_p", "It may have been taken down."))} ` +
        `<a href="trucks.html">${esc(T("td_missing_cta", "Browse all trucks"))}</a></p></div>`;
      return;
    }

    // Back to wherever the reader came from, carrying the plan with them: a
    // back button that drops the move is how somebody ends up re-typing an
    // address they entered two screens ago.
    const back = document.getElementById("tdBack");
    if (back && TM) {
      const q = TM.encode(ctx);
      if (q) back.href = "trucks.html?" + q;
    }

    const name = t.title || T("td_truck", "Moving truck");
    document.title = `${name} · Pawa`;
    const imgs = photoUrls(t);
    const cover = imgs[0] || "";
    const phone = (t.owner && t.owner.phone) || "";
    const wa = (t.owner && (t.owner.whatsapp || t.owner.phone)) || "";
    const loc = [t.area, t.region].filter(Boolean).join(", ");
    const waText = encodeURIComponent(fill(T("td_wa_text",
      "Hello, I saw your truck \"{title}\" on Pawa. Is it free to help me move?"), { title: name }));

    const specs = [
      [T("td_k_type", "Truck type"), typeLabel(t.truck_type), false],
      [T("td_k_capacity", "Capacity"), t.capacity_tonnes
        ? fill(T("td_tonnes", "{n} tonnes"), { n: t.capacity_tonnes }) : NOTHING, true],
      [T("td_k_coverage", "How far it goes"), coverage(t.service_area), false],
      [T("td_k_driver", "Driver"), T(t.driver_included ? "td_driver_yes" : "td_driver_no"), false],
      [T("td_k_loaders", "Loaders"), T(t.loaders_included ? "td_loaders_yes" : "td_loaders_no"), false],
      [T("td_k_based", "Based in"), loc || t.region || NOTHING, false],
    ];

    // The pin, handed to the app that actually navigates. Built now, from what
    // we already know, so the link is complete before the page has finished
    // drawing. See the rule at the top of js/lib/maps-handoff.js.
    const hasPin = !!(window.TruckMove && window.TruckMove.usable(t));
    // Did a move arrive with the reader? It changes what this sheet offers:
    // with a plan the panel routes the whole move, without one the sheet can
    // only offer the way to the lorry.
    const hasPlan = !!(ctx && (ctx.to || ctx.from || ctx.load));
    const dirUrl = (hasPin && window.PawaMaps)
      ? window.PawaMaps.directions({ lat: +t.lat, lng: +t.lng },
          { from: ctx.from || window.PawaMaps.knownOrigin(), mode: "car" })
      : "";

    bodyEl.removeAttribute("aria-busy");
    bodyEl.innerHTML = `
      <div class="td-grid">
        <div>
          <div class="td-gallery-main" id="tdMain" style="${cover ? `background-image:url('${esc(cover)}')` : ""}">
            ${cover ? "" : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 16V7a1 1 0 0 1 1-1h9v10M13 9h4l4 4v3h-2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M9 17h6"/></svg>`}
          </div>
          ${imgs.length > 1 ? `<div class="td-thumbs">${imgs.map((u, i) =>
            `<div class="td-thumb ${i === 0 ? "active" : ""}" data-url="${esc(u)}" style="background-image:url('${esc(u)}')"></div>`).join("")}</div>` : ""}

          <div class="td-panel" style="margin-top:14px">
            <p class="td-h">${esc(T("td_h_details", "Truck details"))}</p>
            <div class="td-specs">
              ${specs.map(([k, v, fig]) => `<div class="td-spec"><div class="k">${esc(k)}</div>` +
                `<div class="v${fig ? " is-figure" : ""}">${esc(v)}</div></div>`).join("")}
            </div>
          </div>

          ${kitPanel(t)}

          ${t.description ? `<div class="td-panel"><p class="td-h">${esc(T("td_h_about", "About this truck"))}</p><div class="td-desc">${esc(t.description)}</div></div>` : ""}
        </div>

        <div>
          <div class="td-panel">
            <div class="td-price">${formatPrice(t)}</div>
            <div class="td-title">${esc(name)}</div>
            <div class="td-loc">${esc(loc || t.region || T("of_tanzania", "Tanzania"))}</div>
            <div class="td-badges">
              <span class="td-badge">${esc(typeLabel(t.truck_type))}</span>
              ${t.capacity_tonnes ? `<span class="td-badge">${esc(fill(T("td_t_short", "{n}t"), { n: t.capacity_tonnes }))}</span>` : ""}
              ${t.driver_included ? `<span class="td-badge">${esc(T("td_k_driver", "Driver"))}</span>` : ""}
              ${t.loaders_included ? `<span class="td-badge">${esc(T("td_k_loaders", "Loaders"))}</span>` : ""}
              ${t.verified ? `<span class="td-badge verified">${esc(T("of_verified", "Verified"))}</span>` : ""}
            </div>
          </div>

          ${movePanel(t, ctx)}

          <div class="td-panel">
            <p class="td-h">${esc(T("td_h_contact", "Contact the owner"))}</p>
            <div class="td-owner">${esc((t.owner && t.owner.name) || T("td_owner", "Truck owner"))}</div>
            <div class="td-cta">
              ${window.PMReach ? window.PMReach.button(t, { className: "td-cta-msg" }) : ""}
              ${phone ? `<a class="td-cta-call" href="tel:${esc(cleanPhone(phone))}">${esc(T("of_call", "Call"))} ${esc(phone)}</a>` : ""}
              ${wa ? `<a class="td-cta-wa" href="https://wa.me/${esc(waNumber(wa))}?text=${waText}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
              <a class="td-cta-move" href="meet.html" target="_blank" rel="noopener">${esc(T("td_share_loc", "Share live location for the pickup"))}</a>
            </div>
            <!-- Only when there is no move to route. With a plan carried in,
                 the panel above already offers "Route in Google Maps", which
                 is the same link with the pickup and the new home on it, and
                 two Google Maps buttons on one screen is a question about
                 which one is the real one. -->
            ${(dirUrl && !hasPlan) ? `<div class="td-cta" style="margin-top:10px">
              <a class="td-cta-call" id="tdDirBtn" href="${esc(dirUrl)}" target="_blank" rel="noopener">${esc(T("tm_act_dir", "Directions in Google Maps"))}</a>
            </div>` : ""}
            ${hasPin ? `<div class="td-minimap" id="tdMap"></div>` : ""}
          </div>
        </div>
      </div>`;

    wireThumbs(bodyEl);
    wireMap(t, name);
    wireMove(t, ctx);

    // The directions link is upgraded in place once a fresher fix arrives, and
    // never awaited before a tap. maps-handoff.js explains why.
    const dirBtn = document.getElementById("tdDirBtn");
    if (dirBtn && hasPin && window.PawaMaps) {
      window.PawaMaps.bindDirections(dirBtn, { lat: +t.lat, lng: +t.lng },
        { from: ctx.from, mode: "car" });
    }
  }

  function wireThumbs(bodyEl) {
    bodyEl.querySelectorAll(".td-thumb").forEach((el) => {
      el.addEventListener("click", () => {
        const main = document.getElementById("tdMain");
        main.style.backgroundImage = `url('${el.dataset.url}')`;
        main.innerHTML = "";
        bodyEl.querySelectorAll(".td-thumb").forEach((x) => x.classList.remove("active"));
        el.classList.add("active");
      });
    });
  }

  function wireMap(t, name) {
    const mapEl = document.getElementById("tdMap");
    if (!mapEl || !window.L) return;
    const m = L.map(mapEl, { scrollWheelZoom: false }).setView([+t.lat, +t.lng], 13);
    if (window.addSatelliteHybrid) window.addSatelliteHybrid(m);
    L.marker([+t.lat, +t.lng]).addTo(m).bindPopup(esc(name));
    setTimeout(() => m.invalidateSize(), 80);
  }

  /**
   * The move panel's one button.
   *
   * It does the two measurements that need the network, in the order that puts
   * something on screen soonest: the fit chips first (no network at all), then
   * the road to the lorry, then the length of the move.
   */
  function wireMove(t, ctx) {
    const btn = document.getElementById("tdMoveBtn");
    const msg = document.getElementById("tdMoveMsg");
    const TM = window.TruckMove;
    if (!btn || !TM) return;

    const say = (text, warn) => {
      if (!msg) return;
      msg.hidden = !text;
      msg.textContent = text || "";
      msg.classList.toggle("is-warn", !!warn);
    };

    /** The two road measurements, and the repaint that follows them. */
    const measure = async () => {
      if (!ctx.from) return;
      say(T("tm_measuring_all", "Measuring the roads."));
      ctx.roadKm = await TM.pickupKm([t], ctx.from);
      if (ctx.to) ctx.tripKm = await TM.roadKm(ctx.from, ctx.to);
      paintMove(t, ctx);
      say("");
      // Nothing left for it to do. A button that repeats work already on the
      // screen above it is a button somebody presses to find out what it does.
      btn.hidden = true;
    };

    // A plan that arrived with a pickup in it is already answerable, and it is
    // measured WITHOUT a press. There is no permission prompt to buy here: the
    // reader carried their own position over from the previous screen, so
    // making them ask again for a number we can already work out would leave
    // "measuring the road" on the card as a permanent label.
    if (ctx.from || ctx.to || ctx.load) {
      paintMove(t, ctx);
      if (ctx.from) measure();
    }

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        if (!ctx.from && window.pawaLocate) {
          say(T("tm_locating", "Getting your location."));
          try {
            const fix = await window.pawaLocate.bestOrApprox({ targetAccuracy: 60, maxWaitMs: 12000 });
            ctx.from = { lat: fix.lat, lng: fix.lng };
          } catch (e) {
            say((e && e.message) || T("tm_gps_fail",
              "We could not get your location. The trucks below are still ranked by size and coverage."), true);
          }
        }
        paintMove(t, ctx);
        await measure();
      } finally {
        btn.disabled = false;
      }
    });
  }

  window.initTruckPage = init;
})();
