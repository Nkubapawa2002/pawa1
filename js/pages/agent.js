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

  // initials() and the map pin used to live here. Both moved to
  // js/lib/agent-card.js when profile.html started drawing the same block, so
  // there is one copy of what an agent's avatar and area look like.

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

    // The name, the area, the broader places, the presence dot and the bio are
    // all AgentCard's now. What is left here is what only this page knows: the
    // work kinds, whether there is a key to encrypt to, and the number.
    var kinds = (card.kinds || []);
    var kindWords = window.ListingKinds
      ? window.ListingKinds.labels(dominantCat(), kinds, { max: 6 }) : [];

    var canMessage = !!card.reachable;
    // The number off their own listings, or nothing. Same rule as the agent
    // list (js/pages/p-message.js) and as service.js / truck.js: strip
    // everything but digits and a leading plus, and refuse anything too short
    // to be a number, because a dialler opened on three digits is worse than
    // no button at all.
    var tel = callHref(card.phone);

    // Identity, the numbers and the bio come from js/lib/agent-card.js, which
    // profile.html also uses to show an agent their own storefront. Rendering
    // those three here as well is how the preview and the page would drift,
    // and a preview that reassures about a page saying something else is worse
    // than no preview at all.
    el.agCard.innerHTML =
      '<div class="ag-card">' +
        window.AgentCard.identity(card, {
          badges: canMessage ? "" :
            ' <span class="agc-badge warn">' + esc(t("pm_badge_unreachable", "Not on P-Message")) + "</span>",
        }) +
        (kindWords.length
          ? '<span class="pm-kinds">' + kindWords.map(function (w) {
              return '<span class="pm-kind">' + esc(w) + "</span>";
            }).join("") + "</span>"
          : "") +
        window.AgentCard.bio(card) +
        // What they have listed, how much of it we checked, and how long they
        // have been here. Every one of those numbers came back from
        // pm_agent_card the day this page was written and none of them was
        // drawn: the card said who somebody was and left a stranger with no
        // way to weigh it.
        window.AgentCard.stats(card) +
        '<div class="ag-acts">' +
          (canMessage
            ? '<a class="ag-btn" id="agMsg" href="p-message.html?to=' + encodeURIComponent(card.user_id) + '">' +
                esc(t("ag_message", "Message them")) + "</a>"
            : '<button class="ag-btn" type="button" disabled>' +
                esc(t("ag_message", "Message them")) + "</button>") +
          // The same number the P-Message row offers, from the same column, so
          // the list and the page it leads to can never print two different
          // ways of ringing one person. When there is no key to encrypt to,
          // this is the ONLY thing on the card that works, and a disabled
          // button beside a live one has to be the quieter of the two.
          (tel
            ? '<a class="ag-btn' + (canMessage ? " ghost" : "") + '" id="agCall" href="' + esc(tel) + '">' +
                esc(t("pm_act_call", "Call")) + "</a>"
            : "") +
        "</div>" +
        '<div class="ag-note">' + esc(canMessage
          ? t("ag_msg_note", "Messages are encrypted on your device. We cannot read them, and neither can anybody with access to the database.")
          : tel
          // A phone call is not encrypted and this page does not get to imply
          // otherwise on the one card whose other half is a promise about
          // encryption.
          ? t("ag_call_only", "They have not opened P-Message yet, so there is no key to encrypt to. The number is the one they printed on their own listings, and a call is an ordinary call.")
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

  /**
   * A number, or nothing. The one rule, written once per page that dials.
   *
   * It is deliberately a copy of the four lines in p-message.js rather than a
   * shared module: two pages, four lines, no build step, and a lib file whose
   * whole content is one regex is a file people forget exists. If a third page
   * needs it, that is when it earns its own file.
   */
  function callHref(raw) {
    var digits = String(raw || "").replace(/[^0-9+]/g, "");
    digits = digits.charAt(0) === "+" ? "+" + digits.slice(1).replace(/\+/g, "")
                                      : digits.replace(/\+/g, "");
    if (digits.replace(/[^0-9]/g, "").length < 9) return "";
    return "tel:" + digits;
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
