// ============================================================================
//  pm-directory-ui.js — the Agents pane: who is out there, and who can help.
//
//  Split out of js/pages/p-message.js. The body below is unchanged except that
//  the page's `category` and `ready` are read through getters now, because a
//  module cannot close over a variable the page reassigns.
//
//  THE RANKING IS NOT HERE. js/lib/pm-match.js decides the order and the
//  reasons, and its design notes are the ones that matter (log-odds, one
//  place term by Math.max and never a sum, stated weights and never fitted
//  ones). This file draws what that returns.
//
//  WHAT A ROW SAYS WHEN IT CANNOT BE WRITTEN TO. actionsHtml() is the honest
//  half of this screen and is easy to "tidy" into a lie. A person with no
//  published key gets NO Message chip -- not a disabled one, and not one that
//  opens a thread that can never be sealed. They keep the number they printed
//  on their own listing and the link to their work, because those still work.
//  Somebody with none of the three gets no strip at all rather than an empty
//  one. And a row says nothing at all about a missing number, because "no
//  number" would be a claim about the person rather than about our data.
//
//  THE CHIPS ARE SIBLINGS OF THE ROW BUTTON, never children: an <a> inside a
//  <button> is invalid markup that browsers repair by moving it, and the
//  repair is what broke this the first time it was tried.
// ============================================================================
(function () {
  "use strict";

  // Handed in by the page. Read at CALL time, never destructured at attach
  // time: the page reassigns several of these after it attaches, and a
  // captured copy would be stale with nothing to say so.
  var ctx = {};

  var t = function (k, f) { return f || k; };
  var esc = function (s) { return String(s == null ? "" : s); };
  var el = {};

  function attach(o) {
    ctx = o || {};
    if (ctx.t) t = ctx.t;
    if (ctx.esc) esc = ctx.esc;
    if (ctx.el) el = ctx.el;          // an object, never reassigned by the page
  }

  /** What the person said they need. "" is a real value meaning "anyone". */
  var category = function () { return ctx.category ? ctx.category() : ""; };
  /** An identity exists and is published. Nothing is drawn before it does. */
  var ready = function () { return ctx.ready ? ctx.ready() : false; };
  var initials = function (n) { return ctx.initials ? ctx.initials(n) : ""; };
  /** { userId, isAdmin, isGuest } once the gate has run, or null. */
  var who = function () { return ctx.me ? ctx.me() : null; };
  var modal = function (h) { if (ctx.modal) ctx.modal(h); };
  var closeModal = function () { if (ctx.closeModal) ctx.closeModal(); };

  // The shortlist target: how confident is confident enough to stop suggesting
  // more people to write to. Four in five, not nine in ten -- the difference is
  // several more messages to several more strangers for a small gain.
  var SHORTLIST_TARGET = 0.8;

  function fillRegions() {
    if (!el.pmRegion) return;
    var names = (window.TZ_REGION_CENTERS || []).map(function (r) { return r.name; })
      .filter(Boolean).sort(function (a, b) { return a.localeCompare(b); });
    el.pmRegion.innerHTML = '<option value="">' + esc(t("pm_region_any", "Every region")) + "</option>" +
      names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + "</option>"; }).join("");
  }

  async function refreshPeople() {
    if (!ready()) {
      el.pmPeople.innerHTML = '<div class="pm-empty">' + esc(t("pm_signin_d2", "Sign in to see who is out there.")) + "</div>";
      return;
    }
    el.pmPeople.dataset.loaded = "1";
    el.pmPeople.innerHTML = '<div class="pm-empty">' + esc(t("pm_loading", "Loading…")) + "</div>";
    if (el.pmCount) el.pmCount.textContent = "";
    if (el.pmShort) el.pmShort.hidden = true;

    var region = el.pmRegion ? el.pmRegion.value : "";
    var query = el.pmSearch ? el.pmSearch.value.trim() : "";
    var rows;
    try {
      // pm_agent_finder, not pm_directory: the same people, plus what each of
      // them actually deals in. Without those counts the category chips would
      // be a filter over nothing and the ranking would have no evidence to
      // rank on.
      rows = await window.PMStore.finder({
        region: region, query: query, category: category() || null,
        // Every registered agent in the country, not a sample of them. 200 was
        // the old default and quietly truncated the list once enough agents
        // had signed up to make the tab worth opening.
        limit: 500,
      });
    } catch (err) {
      el.pmPeople.innerHTML = '<div class="pm-empty">' + esc((err && err.message) || err) + "</div>";
      return;
    }

    // The pane is called Agents, but the directory also returns anyone who has
    // simply opened P-Message — which is right for "who wrote to me?" and
    // wrong for "who can help me find a room".
    //
    // EVIDENCE BEATS A FLAG, and it beats it everywhere now.
    //
    // The rule used to be "is_agent, unless a category chip is on". That
    // exception was forced by day jobs: a company that hires by the day almost
    // never registers as an agent, so the Day jobs chip returned an empty
    // screen with the right answers one dropdown behind it. The flag is a
    // PROXY for "does this person deal in anything"; the listing counts are the
    // MEASUREMENT of it, and running a proxy on top of a measurement can only
    // subtract.
    //
    // The same subtraction was happening with no chip on, silently, to exactly
    // the same people: the company that posts twelve jobs a month, the
    // landlord with four rooms who never registered, the man with two lorries.
    // Every one of them is an agent in the only sense that matters on this
    // screen, somebody with something to offer and a way to be reached, and
    // every one of them was missing from the pane whose whole job is listing
    // them. So the default is now "registered as an agent OR has something
    // listed", and the flag only ever adds.
    //
    // What is still excluded by default is somebody with no listings who
    // merely opened P-Message. They are one dropdown away, where they belong:
    // that is a person, not a provider, and offering them as an answer to
    // "who can move a fridge" would be noise dressed up as a result.
    var wantProviders = !el.pmWho || el.pmWho.value !== "all";
    var shown = (wantProviders && !category())
      ? rows.filter(function (p) { return p.is_agent || hasListings(p); })
      : rows;

    if (!shown.length) {
      el.pmPeople.innerHTML = '<div class="pm-empty">' + esc(emptyWhy(rows.length, wantProviders)) + "</div>";
      return;
    }

    // The order is computed HERE, on the device, and not by the database:
    // it depends on what this person is looking for, and the query that
    // fetched the rows was never told. js/lib/pm-match.js explains every term.
    var need = {
      category: category() || null,
      query: query,
      region: region || null,
    };
    var ranked = window.PMMatch.rank(shown, need);

    if (el.pmCount) {
      // "12 agents" would be a lie about a list that also holds a construction
      // firm and a landlord. The word follows what is actually on screen, row
      // by row, rather than following which filter happens to be set.
      var onlyAgents = ranked.every(function (x) { return !!x.agent.is_agent; });
      el.pmCount.textContent =
        t(onlyAgents ? "pm_count_agents" : "pm_count_people",
          onlyAgents ? "{n} agents" : "{n} people", { n: ranked.length }) +
        (region ? " · " + region : "") +
        (category() ? " · " + catName(category()) : "");
    }

    renderShortlist(ranked);
    el.pmPeople.innerHTML = ranked.map(personRow).join("");
  }

  // Why the list is empty, said precisely. "Nobody matches" is four different
  // situations wearing one sentence, and three of them have a way out that
  // the fourth does not.
  function emptyWhy(total, wantProviders) {
    if (category() && total) {
      // Jobs get their own sentence rather than being forced through the
      // listing one. Nobody "lists day jobs" — a company posts them — and the
      // way out is different too: an employer who has never opened P-Message
      // cannot be found here at all, so the advice has to say so.
      if (category() === "jobs") {
        return t("pm_no_jobs", "Nobody here has posted day jobs in that scope. Try Anyone, a wider region, or the jobs board itself.");
      }
      return t("pm_no_cat", "Nobody listing {what} matches that. Try Anyone, a wider region, or fewer words.",
               { what: catName(category()).toLowerCase() });
    }
    if (total && wantProviders) {
      return t("pm_no_agents", "Nobody with anything listed matches that. Switch to Everyone to see other people on P-Message.");
    }
    return t("pm_no_people", "Nobody matches that yet.");
  }

  // Moved to js/lib/pm-people-picker.js, which draws people on three screens
  // and needed every one of these. Delegating rather than copying: a category
  // added in one place and not the other is how a room ends up scoped to
  // something an announcement cannot reach.
  function catName(cat) { return window.PMPeoplePicker.catName(cat); }

  /**
   * "Write to these three and one of them can probably help."
   *
   * The only number this screen prints, and it is printed because a
   * COMBINATION is the point of it: three separate badges saying 40% cannot
   * be added up by eye, and the answer is not 120%. PMMatch.shortlist does it
   * with a shared-failure factor — agents piled into one ward fail together —
   * so the figure is deliberately lower than the naive one and can never
   * reach certainty.
   *
   * Only drawn with a category chosen. "How likely is somebody to help" has
   * no meaning until "help with what" has been answered, and printing a
   * confident-looking number against an unstated question is the kind of
   * thing this page does not do.
   */
  function renderShortlist(ranked) {
    if (!el.pmShort) return;
    if (!category() || ranked.length < 2) { el.pmShort.hidden = true; return; }

    var s = window.PMMatch.shortlist(ranked, SHORTLIST_TARGET, { max: 5 });
    if (!s.picks.length) { el.pmShort.hidden = true; return; }

    var names = s.picks.map(function (x) {
      return x.agent.display_name || t("pm_someone", "Someone");
    });
    var pct = Math.round(s.p * 100);

    el.pmShort.innerHTML =
      "<span>" + esc(t("pm_short_lead", "Write to {who}", { who: joinNames(names) })) + " — <b>" +
      esc(t("pm_short_odds", "about a {pct}% chance one of them can help", { pct: pct })) + "</b>.</span>" +
      "<small>" + esc(s.capped
        ? t("pm_short_capped", "That is as high as it goes here — messaging more people does not make a thing exist. Estimated from what they list and where they work, not from anyone's replies.")
        : t("pm_short_note", "Estimated from what they list and where they work, not from anyone's replies. People working the same street tend to be out of the same things, so the figure allows for that.")) +
      "</small>";
    el.pmShort.hidden = false;
  }

  function joinNames(names) {
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(", ") + " " + t("pm_and", "and") + " " + names[names.length - 1];
  }

  // Where somebody works, and every ward rather than the first one. Both moved
  // to js/lib/pm-people-picker.js, which draws a person on three screens now:
  // the agent list, the room roster and the picker. Four copies of that markup
  // would have drifted within a week, and drifting here means the area is
  // prominent in one place and a grey afterthought in another.
  function areaSet(list, one) { return window.PMPeoplePicker.areaSet(list, one); }
  function whereOf(p, opts) { return window.PMPeoplePicker.whereOf(p, opts); }

  /**
   * One agent, and above all WHERE THEY WORK.
   *
   * The area of operations is the only reason to pick one agent over another,
   * and it used to be the first of up to four place names run together in a
   * grey subtitle — indistinguishable from the ward, the district and the
   * region behind it. It gets a pin, the brand colour and its own element now.
   *
   * An agent who has not set one is SAID to have not set one. Leaving the line
   * blank reads as "operates nowhere in particular", which is a claim about
   * them rather than about our data.
   */
  function personRow(scored) {
    var p = scored.agent;
    var name = p.display_name || t("pm_someone", "Someone");
    var w = whereOf(p);

    // data-sub is what the conversation header shows, so it stays a plain
    // single line rather than the marked-up version.
    var sub = w.line;

    // What they deal in, as counts. A tick would say "trucks: yes" for one
    // truck and for forty, and those are different claims about a person.
    // The wanted category is tinted so the eye can find it without reading.
    var deals = [
      { cat: "houses", n: p.n_houses | 0, label: t("pm_deal_houses", "{n} rooms") },
      { cat: "services", n: p.n_services | 0, label: t("pm_deal_services", "{n} services") },
      { cat: "trucks", n: p.n_trucks | 0, label: t("pm_deal_trucks", "{n} trucks") },
      // A day job is a thing somebody POSTED, not a thing they own and keep,
      // so it is worded as an act: "12 jobs posted", never "12 jobs". The
      // count is lifetime — see p_message_jobs.sql on why, and note the
      // freshness term is what stops an employer who stopped hiring in 2023
      // from sitting at the top of the list on the strength of it.
      { cat: "jobs", n: p.n_jobs | 0, label: t("pm_deal_jobs", "{n} jobs posted") },
    ].filter(function (d) { return d.n > 0; });
    var dealsHtml = deals.length
      ? '<span class="pm-deals">' + deals.map(function (d) {
          return '<span class="pm-deal' + (d.cat === category() ? " is-want" : "") + '">' +
            esc(d.label.replace("{n}", d.n)) + "</span>";
        }).join("") + "</span>"
      : "";

    // The band, and only when it says something. "Weak match" on a row is
    // noise — the row's POSITION already said that.
    var fit = (category() && p.reachable)
      ? ' <span class="pm-fit ' + esc(scored.band) + '">' + esc(fitWord(scored.band)) + "</span>"
      : "";

    var why = (category() && p.reachable) ? whyLine(scored) : "";

    // What kind of work, in words. "4 services" is the count of a thing
    // whose identity was thrown away one join earlier: a plumber, a
    // hairdresser and a night guard all read the same on that row, and the
    // only way to tell them apart was to open four conversations. With a
    // chip on, the database already narrowed these to that category.
    var kindsHtml = kindsFor(p);

    // Presence. Nothing at all when we have never seen them — an empty badge
    // saying "last seen never" would be a claim about the person rather than
    // about our data, which is the same mistake the area line used to make.
    var seenHtml = (p.reachable && window.PMPresence)
      ? window.PMPresence.html(p.last_seen_at) : "";

    return '<div class="pm-person-wrap">' +
      '<button class="pm-row is-person" data-person="' + esc(p.user_id) + '" data-name="' + esc(name) +
      '" data-sub="' + esc(sub) + '"' + (p.reachable ? "" : ' data-unreachable="1"') + ">" +
      '<span class="pm-av">' + esc(initials(name)) + "</span>" +
      '<span class="pm-rtx"><span class="pm-name">' + esc(name) + fit +
        (p.is_agent ? ' <span class="pm-badge off">' + esc(t("pm_badge_agent", "Agent")) + "</span>" : "") +
        (p.reachable ? "" : ' <span class="pm-badge warn">' + esc(t("pm_badge_unreachable", "Not on P-Message")) + "</span>") +
      "</span>" +
      '<span class="pm-sub">' + w.html + (seenHtml ? seenHtml : "") + "</span>" +
      kindsHtml + dealsHtml +
      (why ? '<span class="pm-why">' + esc(why) + "</span>" : "") +
      "</span></button>" + actionsHtml(p, name, sub) + "</div>";
  }

  /**
   * The two ways of reaching one person, and the way of looking first.
   *
   * These used to be one absolutely-positioned link in the bottom-right corner
   * of the row, with 30px of padding reserved underneath it so a long "why"
   * line would not run behind it. That is a layout holding its breath: the
   * padding is paid by every row including the ones with no link, the link
   * overlaps the row's own tap area, and there was nowhere to put a second
   * action without the two of them fighting over the same corner.
   *
   * They are a row of their own now, under the card, which is what let the
   * phone number in at all.
   *
   * WHY A CALL BUTTON EXISTS ON AN ENCRYPTED SCREEN
   * Because "message them" is not always the question. Somebody who needs a
   * canter this afternoon does not want a conversation, and the number on the
   * listing is the fastest honest route to the lorry. The number shown is one
   * they already published on their own listing, where it is printed beside a
   * Call button that anybody can press without signing in. This saves four
   * taps and a guess about which catalogue to look in, and publishes nothing.
   *
   * The chips are SIBLINGS of the row button, never children: an <a> inside a
   * <button> is invalid markup that browsers repair by moving it, and the
   * repair is what broke this the first time it was tried. Each is its own tap
   * target on purpose. "Write to them", "ring them" and "look at their work
   * first" are three different intentions and one hit area cannot guess which
   * one a thumb meant.
   */
  function actionsHtml(p, name, sub) {
    var acts = [];

    // Writing is first because it is what the tab is for, and because it is
    // the only one of the three that is encrypted.
    if (p.reachable) {
      acts.push('<button class="pm-act is-msg" type="button" data-person="' + esc(p.user_id) +
        '" data-name="' + esc(name) + '" data-sub="' + esc(sub) + '">' + PMIcons.chat +
        "<span>" + esc(t("pm_act_message", "Message")) + "</span></button>");
    }

    // A number they printed on a listing themselves. Absent for anybody who
    // has not, and the row then says nothing at all rather than "no number":
    // that would be a claim about the person rather than about our data, which
    // is the same mistake the area line used to make.
    var tel = callHref(p.phone);
    if (tel) {
      acts.push('<a class="pm-act is-call' + (p.reachable ? "" : " is-only") + '" href="' + esc(tel) + '">' + PMIcons.phone +
        "<span>" + esc(t("pm_act_call", "Call")) + "</span></a>");
    }

    if (hasListings(p)) {
      acts.push('<a class="pm-open" href="' + storefrontUrl(p.user_id) + '" data-open-agent="1">' +
        PMIcons.box + "<span>" + esc(t("pm_open_listings", "See their work")) + "</span></a>");
    }

    // The way OUT. Until this existed, blocking had exactly one door in the
    // whole app -- the dot menu on a conversation row -- which meant you could
    // only stop somebody you were already talking to. On a database where
    // almost nobody has a conversation yet, that is no door at all, and the
    // "People you blocked" list in Profile stood over something nothing could
    // add to. Here it sits beside the people themselves, which is where
    // somebody decides they do not want to hear from one of them.
    //
    // A guest is not offered it, because pm_block() refuses a guest session
    // outright: a block that dies with the browser tab is not a block, and
    // showing the button would be promising one.
    if (!(who() && who().isGuest)) {
      acts.push('<button class="pm-act is-more" type="button" data-person-menu="' +
        esc(p.user_id) + '" data-name="' + esc(name) + '" aria-label="' +
        esc(t("pm_msg_more", "More")) + '">' + window.PMIcons.more + "</button>");
    }

    // Somebody with no key, no number and nothing listed has no action at all,
    // and an empty strip under every such row is a row of wasted height.
    if (!acts.length) return "";
    return '<div class="pm-acts">' + acts.join("") + "</div>";
  }

  /**
   * A number, or nothing.
   *
   * Everything but digits and a leading plus is stripped, the same rule
   * service.js and truck.js already use, so a number typed as
   * "0712 345 678 (call after 6)" dials rather than failing silently. Anything
   * that does not survive that as a plausible number is dropped: a Call button
   * that opens the dialler on three digits is worse than no button, because
   * the person has already decided not to write by the time they find out.
   */
  function callHref(raw) {
    var digits = String(raw || "").replace(/[^0-9+]/g, "");
    // A leading + is kept; any other one is somebody's typo or a range.
    digits = digits.charAt(0) === "+" ? "+" + digits.slice(1).replace(/\+/g, "")
                                      : digits.replace(/\+/g, "");
    if (digits.replace(/[^0-9]/g, "").length < 9) return "";
    return "tel:" + digits;
  }



  function hasListings(p) {
    return ((p.n_houses | 0) + (p.n_services | 0) + (p.n_trucks | 0) + (p.n_jobs | 0)) > 0;
  }

  /**
   * The one place the storefront link is built.
   *
   * The URL carries ONLY the user id — the same rule the ?to= deep link
   * follows. Name, area and listings all come from the database on the far
   * side, so a link somebody doctored cannot put a borrowed name on the page
   * whose whole job is saying who this is.
   */
  function storefrontUrl(userId) {
    return "agent.html?u=" + encodeURIComponent(userId);
  }

  /**
   * The kinds this person deals in, as words.
   *
   * The finder returns them already narrowed to the chosen category and
   * ordered commonest first. Which catalogue to label them against is the
   * chosen category, or — with no chip on — whichever catalogue they have
   * most of, because "cleaning" has to be read as a service and "canter" as
   * a truck and the strings alone do not say which.
   */
  function kindsFor(p) {
    var kinds = p.kinds || [];
    if (!kinds.length || !window.ListingKinds) return "";
    var cat = category() || dominantCat(p);
    var words = window.ListingKinds.labels(cat, kinds, { max: 3 });
    if (!words.length) return "";
    return '<span class="pm-kinds">' + words.map(function (wd) {
      return '<span class="pm-kind">' + esc(wd) + "</span>";
    }).join("") + "</span>";
  }

  function dominantCat(p) {
    var best = "", n = 0;
    [["houses", p.n_houses | 0], ["services", p.n_services | 0],
     ["trucks", p.n_trucks | 0], ["jobs", p.n_jobs | 0]].forEach(function (row) {
      if (row[1] > n) { n = row[1]; best = row[0]; }
    });
    return best;
  }

  function fitWord(b) {
    return b === "strong" ? t("pm_fit_strong", "Strong match")
         : b === "good" ? t("pm_fit_good", "Good match")
         : b === "possible" ? t("pm_fit_possible", "Possible")
         : t("pm_fit_weak", "Weak");
  }

  /**
   * Why this person is where they are in the list.
   *
   * Without it the order is an assertion nobody can check; with it, it is an
   * argument somebody can disagree with — and disagreeing with it is exactly
   * what should happen when the ranking is wrong. Only the terms that HELPED
   * are shown: a row that explained at length why it was ranked low would be
   * a row arguing with itself.
   */
  function whyLine(scored) {
    var bits = [];
    scored.evidence.forEach(function (e) {
      if (e.llr <= 0.15) return;                 // too small to be worth a word
      if (e.why === "category_depth") {
        bits.push(category() === "jobs"
          ? t("pm_why_posted", "posted {n} day jobs", { n: e.detail })
          : t("pm_why_depth", "lists {n} of these", { n: e.detail }));
      }
      else if (e.why === "category_focus") bits.push(t("pm_why_focus", "mostly this kind of work"));
      else if (e.why === "place_area" || e.why === "place_ward") bits.push(t("pm_why_ward", "works right there"));
      else if (e.why === "place_district") bits.push(t("pm_why_district", "same district"));
      else if (e.why === "place_region") bits.push(t("pm_why_region", "same region"));
      else if (e.why === "distance") bits.push(t("pm_why_near", "{km}km away", { km: Math.round(e.detail) }));
      else if (e.why === "freshness") bits.push(t("pm_why_fresh", "listed recently"));
      else if (e.why === "verified") bits.push(t("pm_why_verified", "verified listings"));
    });
    return bits.slice(0, 3).join(" · ");
  }

  /**
   * Everything you can do to a person you are NOT in a conversation with.
   *
   * Today that is one thing, and a one-item sheet is the right shape for it
   * rather than a bare confirm: the three chips beside the row are the things
   * you do WITH somebody, and this is the thing you do ABOUT them. Putting a
   * block chip in that strip would have made the commonest row on the screen
   * offer "message, call, see their work, cut them off" as four equal weights.
   */
  function showPersonMenu(btn) {
    var id = btn.dataset.personMenu;
    var name = btn.dataset.name || t("pm_someone", "Someone");

    modal("<h2>" + esc(name) + "</h2>" +
      '<div class="pm-sheet">' +
        '<button class="pm-sheet-b is-danger" type="button" id="pmPmBlock">' +
          "<b>" + esc(t("pm_block", "Block this person")) + "</b><span>" +
          esc(t("pm_block_d", "They stop being able to add you to a room, announce to you, or start a new conversation. This one stays.")) +
        "</span></button>" +
      "</div>" +
      '<div class="pm-modal-acts"><button class="pm-btn ghost" id="pmPmX">' +
      esc(t("pm_close", "Close")) + "</button></div>");

    document.getElementById("pmPmX").addEventListener("click", closeModal);
    document.getElementById("pmPmBlock").addEventListener("click", function () {
      closeModal();
      // The confirm, the wording and the call are pm-block.js's, not a second
      // copy of them. It is the same dialog the conversation row opens.
      if (window.PMBlock) window.PMBlock.ask(id, name);
    });
  }

  window.PMDirectoryUI = {
    attach: attach,
    fillRegions: fillRegions,
    refresh: refreshPeople,
    personMenu: showPersonMenu,
    // Two answers the rest of the page asks this module for, rather than
    // growing a second copy of either: where somebody works, and the address
    // of their shopfront.
    whereOf: whereOf,
    storefrontUrl: storefrontUrl,
  };
})();
