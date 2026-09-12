// ============================================================================
//  pm-people-picker.js — choosing PEOPLE, rather than describing a map square.
// ============================================================================
//  Rooms and announcements used to name their audience with two <select>s: a
//  region and a category. That is a description of a place, and it answers
//  "everybody in Mwanza who lists houses" perfectly well while being unable to
//  answer "these eleven". The room dialog could untick somebody a scope had
//  already caught; the announce dialog could not even do that.
//
//  So there is one picker now, and three screens use it: open a room, add to a
//  room, address an announcement. What it adds over the old one:
//
//    · a search box            — pm_agent_finder has always matched a name, an
//                                area, a ward and a district; nothing asked it
//    · two sources             — the people you deal with, and everybody
//    · a basket that persists  — switch source, search again, change the
//                                region, and what you already chose stays
//                                chosen. This is the piece that makes a
//                                hand-picked set possible at all
//    · ranking                 — PMMatch has ordered the Agents pane since it
//                                shipped and was never wired to the picker
//    · a reason, on the row    — somebody an announcement cannot reach is
//                                drawn greyed and told why, not hidden
//
//  THE GREY ROWS ARE THE HONEST PART. pm_audience_check() answers, per person,
//  whether this account may gather them and whether it may advertise to them.
//  Those answers come from the server, from the same functions that will
//  actually decide, rather than being re-derived here — a second opinion in
//  the browser eventually disagrees with the first, and the moment it does the
//  screen is lying about a permission.
//
//  A BLOCKED PERSON IS ABSENT, NOT GREYED. Everywhere else a refusal is
//  explained; here it must not be, because "you cannot reach X" plus "X used
//  to be here" is a "you have been blocked" oracle. They fall out of
//  pm_my_people entirely and their row in the directory carries no hint.
//
//  Nothing in here touches the network directly: PMStore does that, and the
//  page hands in its own t() and esc() through attach(), the same shape
//  pm-identity-ui.js already uses.
// ============================================================================
(function () {
  "use strict";

  // Injected by the page, so this module carries no second copy of either.
  var t = function (k, f) { return f || k; };
  var esc = function (s) { return String(s == null ? "" : s); };

  function attach(opts) {
    if (opts && opts.t) t = opts.t;
    if (opts && opts.esc) esc = opts.esc;
  }

  // How long to wait after the last keystroke before asking the database.
  var SEARCH_DEBOUNCE_MS = 320;
  // The directory is 500 rows at most; asking for more than a screenful at a
  // time buys nothing a search box does not buy better.
  var PAGE = 300;

  var PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z" stroke="currentColor" stroke-width="2"/>' +
    '<circle cx="12" cy="10" r="2.4" stroke="currentColor" stroke-width="2"/></svg>';

  // ONE list, used by the room scope, the announce scope and this picker.
  // Three separate literals saying the same thing is how a room ends up
  // scoped to something an announcement cannot reach.
  var CATS = ["houses", "services", "trucks", "jobs"];

  function catName(cat) {
    return cat === "houses" ? t("pm_cat_houses", "Rooms & houses")
         : cat === "services" ? t("pm_cat_services", "Daily services")
         : cat === "trucks" ? t("pm_cat_trucks", "Moving trucks")
         : cat === "jobs" ? t("pm_cat_jobs", "Day jobs")
         : t("pm_cat_any", "Anyone");
  }

  function catSelect(id) {
    return '<select id="' + id + '"><option value="">' +
      esc(t("pm_room_anycat", "Anything")) + "</option>" +
      CATS.map(function (c) {
        return '<option value="' + c + '">' + esc(catName(c)) + "</option>";
      }).join("") + "</select>";
  }

  function regionSelect(id, allLabel) {
    var names = (window.TZ_REGION_CENTERS || []).map(function (r) { return r.name; })
      .filter(Boolean).sort(function (a, b) { return a.localeCompare(b); });
    return '<select id="' + id + '"><option value="">' +
      esc(allLabel || t("pm_cast_all", "Everyone in Tanzania")) + "</option>" +
      names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + "</option>"; }).join("") +
      "</select>";
  }

  /**
   * Every distinct place name in a list plus a singular one, in order, with
   * repeats folded out. An agent may cover several wards; dropping the third
   * is dropping the reason somebody would pick them.
   */
  function areaSet(list, one) {
    var seen = {};
    return [].concat(list || [], one ? [one] : []).map(function (v) {
      return String(v == null ? "" : v).trim();
    }).filter(function (v) {
      var k = v.toLowerCase();
      if (!v || seen[k]) return false;
      seen[k] = 1;
      return true;
    });
  }

  /**
   * Where somebody works, in the one shape it is drawn everywhere: the agent
   * list, the room roster, this picker and the conversation header. Four
   * copies of this markup would have drifted within a week, and drifting here
   * means the area is prominent in one place and a grey afterthought in
   * another.
   */
  function whereOf(p, opts) {
    var area = String((p && p.area) || "").trim();
    var wards = areaSet(p && p.wards, p && p.ward);
    var wardTxt = wards.filter(function (v) {
      return v.toLowerCase() !== area.toLowerCase();
    }).join(" · ");
    var rest = [p && p.district, p && p.region].filter(function (v) {
      return v && String(v).trim() && String(v).trim().toLowerCase() !== area.toLowerCase();
    }).slice(0, 2).join(" · ");
    rest = [wardTxt, rest].filter(Boolean).join(" · ");

    // An AGENT with no area is SAID to have none: a blank line reads as
    // "operates nowhere in particular", a claim about them rather than about
    // our data. Somebody who is not an agent has no area of operation to set,
    // so `quiet` says which of the two this is.
    var quiet = opts && opts.quiet;
    var html = area
      ? '<span class="pm-area" title="' + esc(t("pm_area_of", "Area of operation")) + '">' +
          PIN_SVG + "<span>" + esc(area) + "</span></span>"
      : quiet
      ? ""
      : '<span class="pm-area is-none"><span>' +
          esc(t("pm_area_none", "Area not set")) + "</span></span>";

    return {
      area: area,
      rest: rest,
      html: html + (rest ? '<span class="pm-where">' + esc(rest) + "</span>" : ""),
      line: [area, rest].filter(Boolean).join(" · "),
    };
  }

  /** The deal chips. Jobs say "posted", because a job is posted, not owned. */
  function dealsHtml(p) {
    var deals = [
      { n: p.n_houses | 0, label: t("pm_deal_houses", "{n} rooms") },
      { n: p.n_services | 0, label: t("pm_deal_services", "{n} services") },
      { n: p.n_trucks | 0, label: t("pm_deal_trucks", "{n} trucks") },
      { n: p.n_jobs | 0, label: t("pm_deal_jobs", "{n} jobs posted") },
    ].filter(function (d) { return d.n > 0; });
    if (!deals.length) return "";
    return '<span class="pm-deals">' + deals.map(function (d) {
      return '<span class="pm-deal">' + esc(String(d.label).replace("{n}", d.n)) + "</span>";
    }).join("") + "</span>";
  }

  // ---- the picker -----------------------------------------------------------

  /**
   * Draw a picker into `host`.
   *
   * opts: { mode: "room" | "cast" | "add", exclude: [id], chosen: [id],
   *         onChange: function (n) }
   * returns { chosen(), rows(), refresh(), destroy() }
   */
  function mount(host, opts) {
    opts = opts || {};
    // Three modes, and the third is not a relaxation of the other two.
    //
    //   cast   who may be announced to        pm_may_cast_to
    //   room   who may be gathered into one   pm_may_room_with
    //   any    everybody, greyed for nobody
    //
    // "any" exists for BLOCKING, where the reach rules are not merely
    // inapplicable but backwards: the people you most need to block are the
    // ones who can already reach you, and a picker that greys out everybody a
    // rule refuses would refuse to let you block the person the rule let in.
    // pm_block() accepts any id for the same reason.
    var mode = opts.mode === "cast" ? "cast" : opts.mode === "any" ? "any" : "room";
    var exclude = {};
    (opts.exclude || []).forEach(function (id) { exclude[id] = 1; });

    // The basket. Keyed by user id and holding the whole row, because the
    // announcement needs each person's public key at send time and re-fetching
    // it would mean the list that was previewed and the list that is sealed
    // are two different questions.
    var basket = {};
    // Everything currently on screen, and the server's verdict on each.
    var shown = [];
    var verdict = {};
    // "People you deal with" is the right first answer for a room or an
    // announcement, where reach is the question. It is the wrong one for
    // blocking, where the list you want is everybody you can see.
    var source = opts.source === "all" ? "all" : "mine";
    var seq = 0;                 // so a slow answer cannot overwrite a fast one
    var timer = null;

    host.innerHTML =
      '<div class="pm-pk">' +
        '<div class="pm-pk-src" role="tablist">' +
          '<button class="pm-pk-tab' + (source === "mine" ? " is-on" : "") + '" type="button" data-src="mine">' +
            esc(t("pm_pick_src_mine", "People you deal with")) + "</button>" +
          '<button class="pm-pk-tab" type="button" data-src="list">' +
            esc(t("pm_pick_src_list", "Your lists")) + "</button>" +
          '<button class="pm-pk-tab' + (source === "all" ? " is-on" : "") + '" type="button" data-src="all">' +
            esc(t("pm_pick_src_all", "Everyone")) + "</button>" +
        "</div>" +
        '<div class="pm-pk-lists" id="pmPkLists" hidden></div>' +
        '<input class="pm-pk-q" type="search" id="pmPkQ" ' +
          'placeholder="' + esc(t("pm_pick_search", "Search a name, a ward, a district")) + '" />' +
        '<div class="pm-pk-f">' + regionSelect("pmPkRegion", t("pm_pick_anywhere", "Anywhere")) +
          catSelect("pmPkCat") + "</div>" +
        '<div class="pm-pk-basket" id="pmPkBasket" hidden></div>' +
        '<div class="pm-pk-saverow" id="pmPkSaveRow" hidden>' +
          '<input id="pmPkName" maxlength="60" placeholder="' +
            esc(t("pm_pick_save_ph", "Name this list")) + '" />' +
          '<button class="pm-btn" type="button" id="pmPkSaveGo">' +
            esc(t("pm_pick_save_go", "Keep")) + "</button>" +
          '<button class="pm-btn ghost" type="button" id="pmPkSaveNo">' +
            esc(t("pm_cancel", "Cancel")) + "</button>" +
        "</div>" +
        '<div class="pm-pk-msg" id="pmPkMsg"></div>' +
        '<div class="pm-pick-h" id="pmPkHead" hidden>' +
          '<span id="pmPkShown"></span>' +
          '<button class="pm-btn ghost" type="button" data-all="1">' +
            esc(t("pm_pick_all", "All")) + "</button>" +
          '<button class="pm-btn ghost" type="button" data-all="0">' +
            esc(t("pm_pick_none", "None")) + "</button>" +
        "</div>" +
        '<div class="pm-pk-list" id="pmPkList"></div>' +
      "</div>";

    var q = host.querySelector("#pmPkQ");
    var reg = host.querySelector("#pmPkRegion");
    var cat = host.querySelector("#pmPkCat");
    var list = host.querySelector("#pmPkList");
    var msg = host.querySelector("#pmPkMsg");
    var basketEl = host.querySelector("#pmPkBasket");
    var head = host.querySelector("#pmPkHead");
    var shownEl = host.querySelector("#pmPkShown");
    var listsEl = host.querySelector("#pmPkLists");
    var myLists = [];
    var listId = null;             // which saved list is being shown

    function chosenIds() { return Object.keys(basket); }
    function chosenRows() { return chosenIds().map(function (id) { return basket[id]; }); }

    function announce() {
      var n = chosenIds().length;
      drawBasket();
      if (opts.onChange) opts.onChange(n);
    }

    function drawBasket() {
      var ids = chosenIds();
      basketEl.hidden = ids.length === 0;
      if (!ids.length) { basketEl.innerHTML = ""; return; }
      basketEl.innerHTML =
        '<span class="pm-pk-count">' +
          esc(t("pm_pick_chosen", "{n} chosen", { n: ids.length })) + "</span>" +
        ids.map(function (id) {
          var p = basket[id];
          return '<button class="pm-chip" type="button" data-drop="' + esc(id) + '" ' +
            'title="' + esc(t("pm_pick_drop", "Take out")) + '">' +
            esc(p.display_name || id) + "<span aria-hidden=\"true\">&times;</span></button>";
        }).join("") +
        // The whole reason lists exist: the basket dies with the dialog, so
        // the same eleven people are eleven taps again next week unless this
        // is one tap now.
        '<button class="pm-btn ghost pm-pk-save" type="button" data-save="1">' +
          esc(t("pm_pick_save", "Keep as a list")) + "</button>" +
        '<button class="pm-btn ghost pm-pk-clear" type="button" data-clear="1">' +
          esc(t("pm_pick_clear", "Take all out")) + "</button>";
    }

    /** Why this person cannot be had, in the mode we are in. */
    function blockedWhy(p) {
      // Blocking asks no permission and needs no key: the row is a person, not
      // a recipient. Greying here would be the picker refusing to let somebody
      // shut a door the rules had already opened.
      if (mode === "any") return "";
      var v = verdict[p.user_id];
      if (!v) return "";
      if (mode === "cast" && !v.cast) {
        return t("pm_pick_stranger",
          "You have not written to each other yet. Send a message first, then they can be announced to.");
      }
      if (mode !== "cast" && !v.room) {
        return t("pm_pick_private",
          "They have not listed anything, so they can only be added once you have written to each other.");
      }
      if (!p.public_key) {
        return t("pm_pick_nokey", "They have not set up P-Message on a device yet.");
      }
      return "";
    }

    function rowHtml(scored) {
      var p = scored.agent || scored;
      var id = p.user_id;
      var why = blockedWhy(p);
      var on = !!basket[id];
      var w = whereOf(p, { quiet: !p.is_agent });
      var seen = (window.PMPresence && p.last_seen_at) ? window.PMPresence.html(p.last_seen_at) : "";
      return '<label class="pm-pick' + (why ? " is-off" : "") + '">' +
        '<input type="checkbox" value="' + esc(id) + '"' +
          (on ? " checked" : "") + (why ? " disabled" : "") + " />" +
        '<span class="pm-mem-tx"><span class="pm-mem-nm">' +
          esc(p.display_name || t("pm_someone", "Someone")) +
          (p.is_agent ? ' <span class="pm-badge off">' + esc(t("pm_badge_agent", "Agent")) + "</span>" : "") +
          seen +
        "</span>" +
        '<span class="pm-sub">' + w.html + "</span>" +
        dealsHtml(p) +
        (why ? '<span class="pm-pk-why">' + esc(why) + "</span>" : "") +
        "</span></label>";
    }

    function say(text, bad) {
      msg.className = "pm-pk-msg" + (bad ? " bad" : "");
      msg.textContent = text || "";
    }

    /** Everybody currently on screen who this mode may actually take. */
    function takeable() {
      return shown.map(function (s) { return s.agent || s; })
        .filter(function (p) { return !blockedWhy(p); });
    }

    /**
     * What to do when this dialog can take nobody.
     *
     * THE REPORT THAT PROVOKED THIS was "the announce and rooms is not
     * working". They worked. The audience was empty, and on the real data it
     * was empty for everybody: reach needs a direct thread both people have
     * written in or an accepted invite, and the database held zero messages
     * and zero invites. So both dialogs opened, drew an honest sentence, and
     * stopped -- with a send button that could never enable and nothing on
     * screen to press instead.
     *
     * An explanation is not a way out. The sentence already said "write to
     * them first" and "anybody who opens your invite appears here"; both name
     * an action, and neither was reachable from the screen saying it. So the
     * actions are here, and they are the only two that exist: make a link for
     * somebody who has no account, or go and look at everybody.
     *
     * It is drawn for ALL-GREYED as well as for empty, which is the case that
     * had no handling at all: a list of rows with every checkbox disabled
     * looks like a working screen that is ignoring your taps.
     */
    function wayForward() {
      var acts = [];
      if (source === "mine") {
        acts.push('<button class="pm-btn ghost" type="button" data-pk-all="1">' +
          esc(t("pm_pick_go_all", "Look at everyone")) + "</button>");
      }
      // Only on p-message.html, which is the only page that mounts this.
      if (window.PMInviteUI) {
        acts.push('<button class="pm-btn ghost" type="button" data-pk-invite="1">' +
          esc(t("pm_pick_go_invite", "Make an invite link")) + "</button>");
      }
      if (!acts.length) return "";
      return '<div class="pm-pk-way">' +
        '<p>' + esc(t("pm_pick_way_d",
          "Somebody becomes reachable when you have written to each other, or when they open an invite link from you.")) + "</p>" +
        '<div class="pm-pk-way-acts">' + acts.join("") + "</div></div>";
    }

    function draw() {
      if (!shown.length) {
        head.hidden = true;
        list.innerHTML = '<div class="pm-empty">' + esc(source === "mine"
          ? t("pm_pick_mine_none", "Nobody yet. Anybody you write to, and anybody who opens your invite, appears here.")
          : t("pm_pick_none_here", "Nobody matches that yet.")) + "</div>" +
          wayForward();
        return;
      }
      list.innerHTML = shown.map(rowHtml).join("");
      head.hidden = false;
      shownEl.textContent = t("pm_pick_showing", "{n} people", { n: shown.length });
      // Rows, but not one of them can be had. Without this the screen looks
      // fully populated and simply refuses every tap.
      if (!takeable().length) {
        list.insertAdjacentHTML("beforeend",
          '<div class="pm-empty">' + esc(t("pm_pick_none_takeable",
            "None of these can be added yet, for the reason on each row.")) + "</div>" +
          wayForward());
      }
    }

    // "Every agent in Tanzania" used to be its own button on the room dialog,
    // and it was the room an admin wanted most of the time. It is this: leave
    // the search empty, switch to Everyone, press All. The difference is that
    // it now works for any search at all, and that it only ever ticks the
    // people this account may actually take.
    function setAll(on) {
      if (on) takeable().forEach(function (p) { basket[p.user_id] = p; });
      else basket = {};
      Array.prototype.forEach.call(list.querySelectorAll('input[type="checkbox"]'),
        function (i) { if (!i.disabled) i.checked = on; });
      announce();
    }

    /** The saved lists, as a strip of chips above the rows. */
    function drawLists() {
      listsEl.hidden = source !== "list";
      if (source !== "list") return;
      if (!myLists.length) {
        listsEl.innerHTML = '<div class="pm-pk-nolist">' +
          esc(t("pm_pick_nolists", "No lists yet. Choose some people, then keep them as a list.")) + "</div>";
        return;
      }
      listsEl.innerHTML = myLists.map(function (l) {
        return '<button class="pm-chip' + (l.id === listId ? " is-on" : "") +
          '" type="button" data-list="' + esc(l.id) + '">' + esc(l.name) +
          ' <span>' + (l.n_members | 0) + "</span></button>";
      }).join("");
    }

    /** Ask the database, then ask it who may be reached, then draw. */
    function load() {
      var mine = ++seq;
      say(t("pm_room_looking", "Looking…"));
      var query = q.value.trim() || null;
      var p;
      if (source === "mine") {
        p = window.PMStore.myPeople({ query: query, limit: PAGE });
      } else if (source === "list") {
        // pm_list_people already answers may_cast and may_room per row, so a
        // list needs no second round trip. It is a plan rather than a
        // permission, and this is where that shows: somebody saved months ago
        // who has since blocked you comes back greyed, not missing.
        p = listId ? window.PMStore.listPeople(listId) : Promise.resolve([]);
      } else {
        p = window.PMStore.finder({
          query: query, region: reg.value || null,
          category: cat.value || null, limit: PAGE,
        });
      }

      return p.then(function (rows) {
        rows = (rows || []).filter(function (r) { return !exclude[r.user_id]; });
        // A list row carries its own verdict; everything else has to ask.
        if (source === "list") {
          var v = {};
          rows.forEach(function (r) { v[r.user_id] = { room: !!r.may_room, cast: !!r.may_cast }; });
          return { rows: rows, v: v };
        }
        // "any" greys nobody, so the verdict is never read. Asking for it
        // anyway would be a round trip per search whose answer is discarded.
        if (mode === "any") return { rows: rows, v: {} };
        return window.PMStore.audienceCheck(rows.map(function (r) { return r.user_id; }))
          .then(function (v) { return { rows: rows, v: v }; });
      }).then(function (res) {
        if (mine !== seq) return;          // a later search already answered
        verdict = res.v;
        // PMMatch has ranked the Agents pane since it shipped and was never
        // wired to the picker. The rows carry the columns it reads, from
        // either source, which is why pm_my_people returns the finder's shape.
        var need = { category: cat.value || null, query: query, region: reg.value || null };
        shown = window.PMMatch
          ? window.PMMatch.rank(res.rows, need)
          : res.rows.map(function (r) { return { agent: r }; });
        say("");
        draw();
      }).catch(function (err) {
        if (mine !== seq) return;
        say((err && err.message) || String(err), true);
      });
    }

    function debounced() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, SEARCH_DEBOUNCE_MS);
    }

    function onListChange(e) {
      var box = e.target.closest ? e.target.closest('input[type="checkbox"]') : null;
      if (!box) return;
      var id = box.value;
      var hit = shown.filter(function (s) { return (s.agent || s).user_id === id; })[0];
      if (box.checked && hit) basket[id] = hit.agent || hit;
      else delete basket[id];
      announce();
    }

    // Naming a list is an inline field rather than window.prompt: a browser
    // dialog carries chrome nobody here can translate, and this page is read
    // in Swahili as often as in English.
    var saveRow = host.querySelector("#pmPkSaveRow");
    var saveName = host.querySelector("#pmPkName");

    async function saveList() {
      var ids = chosenIds();
      var name = saveName.value.trim();
      if (!ids.length || !name) return;
      var go = host.querySelector("#pmPkSaveGo");
      go.disabled = true;
      try {
        await window.PMStore.listCreate(name, ids);
        myLists = await window.PMStore.lists();
        saveRow.hidden = true;
        saveName.value = "";
        say(t("pm_pick_saved", "Kept as {name}.", { name: name }));
        drawLists();
      } catch (err) {
        say((err && err.message) || String(err), true);
      } finally { go.disabled = false; }
    }

    host.querySelector("#pmPkSaveGo").addEventListener("click", saveList);
    host.querySelector("#pmPkSaveNo").addEventListener("click", function () {
      saveRow.hidden = true;
      saveName.value = "";
    });

    function onBasketClick(e) {
      var save = e.target.closest ? e.target.closest("[data-save]") : null;
      if (save) {
        saveRow.hidden = false;
        saveName.focus();
        return;
      }
      var drop = e.target.closest ? e.target.closest("[data-drop]") : null;
      if (drop) {
        var id = drop.dataset.drop;
        delete basket[id];
        // Walked rather than looked up with a selector built from the id: a
        // user id is somebody else's string, and building a selector out of
        // one is the kind of thing that works until it does not.
        Array.prototype.forEach.call(list.querySelectorAll('input[type="checkbox"]'),
          function (i) { if (i.value === id) i.checked = false; });
        announce();
        return;
      }
      if (e.target.closest && e.target.closest("[data-clear]")) {
        basket = {};
        Array.prototype.forEach.call(list.querySelectorAll('input[type="checkbox"]'),
          function (i) { i.checked = false; });
        announce();
      }
    }

    async function onSrc(e) {
      var b = e.target.closest ? e.target.closest("[data-src]") : null;
      if (!b || b.dataset.src === source) return;
      source = b.dataset.src;
      Array.prototype.forEach.call(host.querySelectorAll("[data-src]"), function (x) {
        x.classList.toggle("is-on", x.dataset.src === source);
      });
      // The region and the category only mean anything against the directory:
      // the people you deal with, and a list, are sets rather than scopes.
      host.querySelector(".pm-pk-f").hidden = source !== "all";
      q.hidden = source === "list";
      if (source === "list" && !myLists.length) {
        // A swallowed failure here reads as "No lists yet", which is a claim
        // about this account rather than about the request. Somebody who saved
        // eleven people last week is told they never did.
        try { myLists = await window.PMStore.lists(); }
        catch (err) { myLists = []; say((err && err.message) || String(err), true); }
      }
      if (source === "list" && !listId && myLists.length) listId = myLists[0].id;
      drawLists();
      load();
    }

    host.querySelector(".pm-pk-src").addEventListener("click", onSrc);
    listsEl.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("[data-list]") : null;
      if (!b || b.dataset.list === listId) return;
      listId = b.dataset.list;
      drawLists();
      load();
    });
    head.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("[data-all]") : null;
      if (!b) return;
      e.preventDefault();
      setAll(b.dataset.all === "1");
    });
    // The two ways out of an empty audience. They are inside #pmPkList because
    // that is what draw() rewrites, so the listener is on the container and
    // bound once -- a listener per redraw is the accumulating-handler bug.
    list.addEventListener("click", function (e) {
      if (!e.target.closest) return;
      if (e.target.closest("[data-pk-all]")) {
        e.preventDefault();
        // Go through the tab itself, so the tab strip, the filters and the
        // source all move together rather than this being a second way to
        // change source that forgets one of the three.
        var tab = host.querySelector('[data-src="all"]');
        if (tab) tab.click();
        return;
      }
      if (e.target.closest("[data-pk-invite]")) {
        e.preventDefault();
        // This replaces the modal the picker is sitting in, deliberately:
        // making a link is a whole task, not a step inside addressing an
        // announcement to nobody.
        if (window.PMInviteUI) window.PMInviteUI.open();
      }
    });
    list.addEventListener("change", onListChange);
    basketEl.addEventListener("click", onBasketClick);
    q.addEventListener("input", debounced);
    reg.addEventListener("change", load);
    cat.addEventListener("change", load);
    host.querySelector(".pm-pk-f").hidden = true;

    (opts.chosen || []).forEach(function (id) { basket[id] = { user_id: id, display_name: id }; });
    announce();
    load();

    return {
      chosen: chosenIds,
      rows: chosenRows,
      refresh: load,
      destroy: function () { if (timer) clearTimeout(timer); seq++; host.innerHTML = ""; },
    };
  }

  window.PMPeoplePicker = {
    attach: attach,
    mount: mount,
    // Re-exported so the page keeps ONE definition of each of these rather
    // than a copy that drifts.
    areaSet: areaSet,
    whereOf: whereOf,
    catName: catName,
    catSelect: catSelect,
    regionSelect: regionSelect,
    dealsHtml: dealsHtml,
    CATS: CATS,
    PIN_SVG: PIN_SVG,
  };
})();
