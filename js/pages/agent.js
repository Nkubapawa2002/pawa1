// ============================================================================
//  agent.js — one agent's storefront: who they are, and everything they list.
//
//  The screen that did not exist. Somebody scanning the P-Message agent list
//  could see a name, an area and "4 services", and the only way to find out
//  what those four services WERE was to open a conversation and ask. This
//  page is the answer to "let me look first", and the link on every agent row
//  points here.
//
//  THE URL CARRIES ONLY AN ID. p-message.html?to= follows the same rule and
//  for the same reason: the name, the area, the bio and the catalogue all
//  come back from the database, so a link somebody doctored cannot put a
//  borrowed name on the one page whose whole job is saying who this is.
//
//  SIGNED-IN ONLY, and that is the database's rule rather than this file's —
//  pm_agent_card() and pm_agent_listings() both refuse when app_uid() is
//  null. The directory has always been closed to anonymous callers
//  (app_is_guest() is what keeps the catalogue shut), and a storefront that
//  worked signed-out would be a way to enumerate every agent in the country
//  without an account.
//
//  Two calls, not one: the card is the page's identity and is drawn the
//  moment it lands, without waiting on a catalogue that may be sixty rows.
// ============================================================================
(function () {
  "use strict";

  var el = {};
  ["agCard", "agWork", "agBack"].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  var userId = new URLSearchParams(location.search).get("u") || "";
  var card = null;
  var listings = [];
  var section = "";          // "" = everything, else houses|services|trucks|jobs

  function t(key, fallback, vars) {
    var s = (window.t && window.t(key)) || fallback;
    if (s === key) s = fallback;
    if (vars) Object.keys(vars).forEach(function (k) {
      s = String(s).replace("{" + k + "}", vars[k]);
    });
    return s;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
    return parts.map(function (p) { return p.charAt(0).toUpperCase(); }).join("") || "?";
  }

  var PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z" stroke="currentColor" stroke-width="2"/>' +
    '<circle cx="12" cy="10" r="2.4" stroke="currentColor" stroke-width="2"/></svg>';

  // ---- price ---------------------------------------------------------------
  // 1,250,000 as "1.3M" rather than in full: on a card the magnitude is the
  // decision and the exact figure belongs on the listing's own page, where
  // there is room to say what it includes.
  function money(n) {
    var p = Number(n) || 0;
    if (p >= 1000000) return (p / 1000000).toFixed(p % 1000000 === 0 ? 0 : 1) + "M";
    if (p >= 1000) return Math.round(p / 1000) + "k";
    return String(p);
  }

  // The unit is stored per catalogue with its own vocabulary — houses.period,
  // services.rate_type, trucks.period, day_jobs.pay_note. The first three are
  // short words; pay_note is free text an employer typed, so it is shown as
  // typed and clipped rather than looked up in a table it was never in.
  var UNITS = {
    hourly: "hr", daily: "day", per_job: "job", monthly: "month",
    month: "month", week: "week", day: "day", night: "night", trip: "trip",
    sale: "", total: "",
  };

  function unitOf(row) {
    var u = String(row.unit || "").trim();
    if (!u) return "";
    if (row.cat === "jobs") return u.length > 22 ? u.slice(0, 21) + "…" : u;
    if (Object.prototype.hasOwnProperty.call(UNITS, u)) {
      return UNITS[u] ? "/ " + t("ag_unit_" + u, UNITS[u]) : "";
    }
    return "/ " + u;
  }

  // ---- where a card leads --------------------------------------------------
  // Three of the four catalogues have a detail page keyed by id. Day jobs do
  // not — the board is a single list with no per-job route — so a job card
  // goes to the board itself rather than to a URL that would 404. When jobs
  // grow a detail page this is the one line to change.
  function listingHref(row) {
    if (row.cat === "houses") return "house.html?id=" + encodeURIComponent(row.listing_id);
    if (row.cat === "services") return "service.html?id=" + encodeURIComponent(row.listing_id);
    if (row.cat === "trucks") return "truck.html?id=" + encodeURIComponent(row.listing_id);
    return "jobs.html";
  }

  function photoUrl(row) {
    var ds = window.DataStore;
    if (!ds || !row.photo) return "";
    if (row.cat === "houses") return ds.housePhotoUrl(row.photo);
    if (row.cat === "services") return ds.servicePhotoUrl(row.photo);
    if (row.cat === "trucks") return ds.truckPhotoUrl(row.photo);
    return "";
  }

  function catName(cat) {
    return cat === "houses" ? t("pm_cat_houses", "Rooms & houses")
         : cat === "services" ? t("pm_cat_services", "Daily services")
         : cat === "trucks" ? t("pm_cat_trucks", "Moving trucks")
         : cat === "jobs" ? t("pm_cat_jobs", "Day jobs")
         : t("pm_cat_any", "Anyone");
  }

  // ---- the card ------------------------------------------------------------
  function renderCard() {
    if (!el.agCard) return;
    el.agCard.setAttribute("aria-busy", "false");

    var name = card.display_name || t("pm_someone", "Someone");
    var area = String(card.area || "").trim();
    // The broader places, minus whatever already appears as the area — the
    // same rule the agent list follows, so an agent whose area IS "Nyamagana"
    // never reads "Nyamagana · Nyamagana".
    var rest = [card.district, card.ward, card.region].filter(function (v) {
      return v && String(v).trim() && String(v).trim().toLowerCase() !== area.toLowerCase();
    }).slice(0, 2).join(" · ");

    var seen = window.PMPresence ? window.PMPresence.html(card.last_seen_at) : "";

    var kinds = (card.kinds || []);
    var kindWords = window.ListingKinds
      ? window.ListingKinds.labels(dominantCat(), kinds, { max: 6 }) : [];

    // A bio nobody wrote is SAID to be missing rather than left blank. A blank
    // space under a name reads as "this person had nothing to say", which is a
    // claim about them instead of about our data.
    var bio = String(card.bio || "").trim();

    var canMessage = !!card.reachable;

    el.agCard.innerHTML =
      '<div class="ag-card">' +
        '<div class="ag-top">' +
          '<span class="ag-av">' + esc(initials(name)) + "</span>" +
          '<span class="ag-id">' +
            '<span class="ag-name">' + esc(name) +
              (card.is_agent ? ' <span class="ag-badge">' + esc(t("pm_badge_agent", "Agent")) + "</span>" : "") +
              (canMessage ? "" : ' <span class="ag-badge warn">' + esc(t("pm_badge_unreachable", "Not on P-Message")) + "</span>") +
            "</span>" +
            '<span class="ag-meta">' +
              (area
                ? '<span class="ag-area" title="' + esc(t("pm_area_of", "Area of operation")) + '">' +
                    PIN_SVG + "<span>" + esc(area) + "</span></span>"
                : '<span class="ag-area is-none">' + esc(t("pm_area_none", "Area not set")) + "</span>") +
              (rest ? "<span>" + esc(rest) + "</span>" : "") +
              seen +
            "</span>" +
          "</span>" +
        "</div>" +
        (kindWords.length
          ? '<span class="pm-kinds">' + kindWords.map(function (w) {
              return '<span class="pm-kind">' + esc(w) + "</span>";
            }).join("") + "</span>"
          : "") +
        '<div class="ag-bio' + (bio ? "" : " is-none") + '">' +
          esc(bio || t("ag_no_bio", "They have not written anything about their work yet.")) +
        "</div>" +
        '<div class="ag-acts">' +
          (canMessage
            ? '<a class="ag-btn" id="agMsg" href="p-message.html?to=' + encodeURIComponent(card.user_id) + '">' +
                esc(t("ag_message", "Message them")) + "</a>"
            : '<button class="ag-btn" type="button" disabled>' +
                esc(t("ag_message", "Message them")) + "</button>") +
        "</div>" +
        '<div class="ag-note">' + esc(canMessage
          ? t("ag_msg_note", "Messages are encrypted on your device. We cannot read them, and neither can anybody with access to the database.")
          : t("pm_unreachable_d", "They have not opened P-Message yet, so there is no key to encrypt to. Their listings still carry a phone number.")) +
        "</div>" +
      "</div>";
  }

  // Which catalogue to label the kinds against: "cleaning" has to be read as a
  // service and "canter" as a truck, and the stored strings alone do not say
  // which. Whichever they have most of is the best single guess, and with a
  // section chosen the guess is not needed at all.
  function dominantCat() {
    if (section) return section;
    var best = "", n = 0;
    [["houses", card.n_houses | 0], ["services", card.n_services | 0],
     ["trucks", card.n_trucks | 0], ["jobs", card.n_jobs | 0]].forEach(function (row) {
      if (row[1] > n) { n = row[1]; best = row[0]; }
    });
    return best;
  }

  // ---- the catalogue -------------------------------------------------------
  function renderWork() {
    if (!el.agWork) return;

    if (!listings.length) {
      el.agWork.innerHTML = '<div class="ag-empty">' +
        esc(t("ag_nothing", "Nothing listed yet. Write to them anyway — plenty of work never makes it onto a board.")) +
        "</div>";
      return;
    }

    // Only the sections they actually have. A "Moving trucks (0)" chip is a
    // question the page already knows the answer to.
    var have = ["houses", "services", "trucks", "jobs"].filter(function (c) {
      return listings.some(function (r) { return r.cat === c; });
    });

    var chips = have.length > 1
      ? '<div class="ag-secs" role="tablist">' +
          '<button class="ag-sec' + (section ? "" : " is-on") + '" data-sec="" role="tab">' +
            esc(t("ag_all", "Everything")) + " (" + listings.length + ")</button>" +
          have.map(function (c) {
            var n = listings.filter(function (r) { return r.cat === c; }).length;
            return '<button class="ag-sec' + (section === c ? " is-on" : "") +
              '" data-sec="' + c + '" role="tab">' + esc(catName(c)) + " (" + n + ")</button>";
          }).join("") +
        "</div>"
      : "";

    var shown = section
      ? listings.filter(function (r) { return r.cat === section; })
      : listings;

    el.agWork.innerHTML = chips +
      '<div class="ag-grid">' + shown.map(itemCard).join("") + "</div>";
  }

  function itemCard(row) {
    var img = photoUrl(row);
    var kind = window.ListingKinds ? window.ListingKinds.label(row.cat, row.kind) : "";
    var unit = unitOf(row);
    var where = [row.area, row.region].filter(Boolean).join(" · ");

    return '<a class="ag-item' + (row.active ? "" : " is-off") + '" href="' + esc(listingHref(row)) + '">' +
      '<span class="ag-shot"' + (img ? ' style="background-image:url(' + esc(img) + ')"' : "") + ">" +
        (img ? "" : esc(catName(row.cat))) +
      "</span>" +
      '<span class="ag-tx">' +
        '<span class="ag-t">' + esc(row.title || catName(row.cat)) + "</span>" +
        '<span class="ag-sub">' +
          (kind ? '<span class="pm-kind">' + esc(kind) + "</span>" : "") +
          (where ? "<span>" + esc(where) + "</span>" : "") +
          (row.verified ? ' <span class="ag-badge">' + esc(t("ag_verified", "Verified")) + "</span>" : "") +
          // A day job that has closed is still evidence about who this is; it
          // just is not an offer any more, and saying so beats letting
          // somebody write about a job that filled last Tuesday.
          (row.active ? "" : ' <span class="ag-badge warn">' + esc(t("ag_closed", "Closed")) + "</span>") +
        "</span>" +
        (Number(row.price_tzs) > 0
          ? '<span class="ag-price">' + esc(money(row.price_tzs)) +
              " <small>TZS" + (unit ? " " + esc(unit) : "") + "</small></span>"
          : "") +
      "</span></a>";
  }

  // ---- boot ----------------------------------------------------------------
  function fail(msg) {
    if (el.agCard) {
      el.agCard.setAttribute("aria-busy", "false");
      el.agCard.innerHTML = '<div class="ag-card"><div class="ag-empty">' + esc(msg) + "</div></div>";
    }
    if (el.agWork) el.agWork.innerHTML = "";
  }

  async function start() {
    if (window.applyTranslations) window.applyTranslations();

    if (!userId) {
      fail(t("ag_no_id", "No agent chosen. Open somebody from the Agents tab in P-Message."));
      return;
    }

    var me = null;
    try { me = await window.PMStore.me(); } catch (_) {}
    if (!me || !me.userId) {
      // Not an error and not a dead end: say what to do. The directory has
      // always been closed to anonymous callers, so this is the rule working
      // rather than something going wrong.
      fail(t("ag_signin", "Sign in to see who this is and what they list."));
      return;
    }

    try {
      card = await window.PMStore.agentCard(userId);
    } catch (err) {
      fail((err && err.message) || String(err));
      return;
    }
    if (!card) {
      fail(t("ag_nobody", "There is nobody here. The link may be old, or they may have removed their account."));
      return;
    }
    renderCard();
    document.title = (card.display_name || t("pm_someone", "Someone")) + " — Maisha na Lifeza";

    try {
      listings = await window.PMStore.agentListings(userId, 60);
    } catch (_) {
      listings = [];
    }
    renderWork();

    // One delegated listener, bound once, on a container whose innerHTML is
    // rewritten on every section change. Binding per chip would rebind on
    // each redraw and accumulate.
    el.agWork.addEventListener("click", function (e) {
      var chip = e.target.closest("[data-sec]");
      if (!chip) return;
      var next = chip.dataset.sec || "";
      if (next === section) return;
      section = next;
      renderWork();
      // The kinds under the name are labelled against the chosen section, so
      // the card has to follow the chips rather than sit on the guess it made
      // before anything was chosen.
      renderCard();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
