/**
 * agent-card.js — the facts about one agent, drawn the same way everywhere.
 *
 * WHY THIS FILE EXISTS
 * Two screens describe the same person from the same query:
 *
 *   agent.html    what a customer sees before they write to you.
 *   profile.html  "Your public page", shown to the agent themselves.
 *
 * The second one only has a reason to exist if it is TRUE. An agent looks at
 * their own storefront to find out whether the empty bio matters, whether the
 * area is right, whether four listings really show as four. A preview drawn by
 * a second piece of code is a preview that will eventually be reassuring about
 * a page that says something else, and the agent would have no way to tell.
 *
 * So the parts that state a FACT live here and are rendered once:
 *
 *   identity()  avatar, name, the badges, where they work, when last seen
 *   stats()     what they have listed, how much of it is verified, since when
 *   bio()       their own words, or the honest absence of them
 *
 * WHAT IS DELIBERATELY NOT HERE
 * The actions. "Message them" and "Call" belong to the visitor's page; "View
 * your page" and "Edit your bio" belong to the owner's. They are the one thing
 * that genuinely differs between the two screens, and pushing them in here
 * behind a flag would make this file a fork with a shared prologue. Each page
 * draws its own buttons under the shared block.
 *
 * It also touches no DOM and does no network: it takes the row pm_agent_card()
 * returned and gives back a string. Both callers already have that row.
 *
 * Styling is css/agent-card.css, which is written against the --pm-* names
 * both pages define.
 */
(function () {
  "use strict";

  function t(key, fallback, vars) {
    var s = (window.t && window.t(key)) || fallback;
    if (s === key) s = fallback;
    if (vars) Object.keys(vars).forEach(function (k) {
      s = String(s).replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
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

  var PIN = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z" stroke="currentColor" stroke-width="2"/>' +
    '<circle cx="12" cy="10" r="2.4" stroke="currentColor" stroke-width="2"/></svg>';

  // ---- identity -------------------------------------------------------------

  /**
   * Who this is and where they work.
   *
   * The broader places are shown MINUS whatever already appears as the area,
   * which is the rule the P-Message agent list follows: without it an agent
   * whose area is "Nyamagana" reads "Nyamagana · Nyamagana" and looks like a
   * data-entry mistake rather than a person.
   */
  /**
   * Ward, district and region, each said by name.
   *
   * They used to be one anonymous string: district, ward and region filtered
   * against the area, sliced to two and joined with a dot. "Kinondoni ·
   * Mikocheni" does not tell a reader which of those is the ward, and the
   * slice quietly dropped the region whenever both of the others were set.
   *
   * The ward in particular is no longer decoration. house_demand_near matches
   * a seeker who can NAME their ward but not pin it against the agent's own
   * ward, so an agent who has not set one is invisible to those requests. See
   * docs/TELLING_AGENTS_WHERE.md.
   *
   * Which is why the two audiences get different rows:
   *
   *   a customer  sees only what is filled in, and never a value that merely
   *               repeats the area above it, because "Area Nyamagana / Ward
   *               Nyamagana" reads as a data-entry fault rather than a place.
   *   the owner   sees all three ALWAYS, duplicates included and blanks
   *               spelled out, because this is the one screen where "Ward, not
   *               set" is the useful sentence. Their own page is a control
   *               panel; the public one is a storefront.
   */
  function places(card, own) {
    var area = String(card.area || "").trim();
    // An agent works in more than one ward, so the value is the whole set with
    // the singular column folded in: pm_agent_card returns both, and an agent
    // who has only ever set the singular one must still read correctly.
    function all(list, one) {
      var seen = {};
      return [].concat(list || [], one ? [one] : []).map(function (v) {
        return String(v == null ? "" : v).trim();
      }).filter(function (v) {
        var k = v.toLowerCase();
        if (!v || seen[k]) return false;
        seen[k] = 1;
        return true;
      }).join(" · ");
    }
    var rows = [
      ["pm_lbl_ward", "Ward", all(card.wards, card.ward)],
      ["pm_lbl_district", "District", all(card.districts, card.district)],
      ["pm_lbl_region", "Region", card.region],
    ];
    var out = rows.map(function (r) {
      var val = String(r[2] == null ? "" : r[2]).trim();
      var dupe = val && val.toLowerCase() === area.toLowerCase();
      if (!own && (!val || dupe)) return "";
      return '<span class="agc-place' + (val ? "" : " is-none") + '">' +
        "<b>" + esc(t(r[0], r[1])) + "</b>" +
        "<span>" + esc(val || t("pm_not_set", "not set")) + "</span></span>";
    }).filter(Boolean).join("");
    return out ? '<span class="agc-places">' + out + "</span>" : "";
  }

  function identity(card, opts) {
    var o = opts || {};
    var name = card.display_name || t("pm_someone", "Someone");
    var area = String(card.area || "").trim();

    var seen = (o.presence !== false && window.PMPresence)
      ? window.PMPresence.html(card.last_seen_at) : "";

    return '<div class="agc-top">' +
      '<span class="agc-av' + (o.guest ? " is-guest" : "") + '" aria-hidden="true">' +
        esc(initials(name)) + "</span>" +
      '<span class="agc-id">' +
        '<span class="agc-name">' + esc(name) +
          (card.is_agent ? ' <span class="agc-badge">' + esc(t("pm_badge_agent", "Agent")) + "</span>" : "") +
          (o.badges || "") +
        "</span>" +
        '<span class="agc-meta">' +
          (area
            ? '<span class="agc-area" title="' + esc(t("pm_area_of", "Area of operation")) + '">' +
                PIN + "<span>" + esc(area) + "</span></span>"
            : '<span class="agc-area is-none">' + esc(t("pm_area_none", "Area not set")) + "</span>") +
          seen +
        "</span>" +
        places(card, !!o.own) +
      "</span>" +
    "</div>";
  }

  // ---- the numbers ----------------------------------------------------------

  var CATS = [
    ["n_houses",   "pm_cat_houses",   "Rooms & houses"],
    ["n_services", "pm_cat_services", "Daily services"],
    ["n_trucks",   "pm_cat_trucks",   "Moving trucks"],
    ["n_jobs",     "pm_cat_jobs",     "Day jobs"],
  ];

  /**
   * What they have listed, and one thing that is not a count.
   *
   * Only the categories they actually have. A row of four tiles where three
   * read 0 is a page telling you what somebody has NOT done, on the one screen
   * that exists to say what they have.
   *
   * `n_verified` and `joined_at` came back from pm_agent_card from the day it
   * was written and were never drawn. Both answer the question a stranger
   * actually has, which is not "how many" but "should I trust this": how much
   * of it we checked, and how long they have been here.
   */
  function stats(card, opts) {
    var o = opts || {};
    var tiles = [];

    CATS.forEach(function (c) {
      var n = Number(card[c[0]]) || 0;
      if (!n) return;
      tiles.push(tile(String(n), t(c[1], c[2])));
    });

    var verified = Number(card.n_verified) || 0;
    if (verified) tiles.push(tile(String(verified), t("agc_verified", "Checked by us"), "is-good"));

    var since = sinceLabel(card.joined_at);
    if (since) tiles.push(tile(since, t("agc_since", "Here since")));

    // Nothing listed and nothing to say about it. The caller draws its own
    // empty state, which differs: a visitor is told to write anyway, an owner
    // is told to post something.
    if (!tiles.length) return "";

    return '<div class="agc-stats' + (o.compact ? " is-compact" : "") + '">' + tiles.join("") + "</div>";
  }

  function tile(value, label, cls) {
    return '<span class="agc-stat' + (cls ? " " + cls : "") + '">' +
      '<b>' + esc(value) + "</b><small>" + esc(label) + "</small></span>";
  }

  /**
   * "2026" or "Aug 2026", never "3 months ago".
   *
   * A relative age has to be recomputed to stay true and reads as precision
   * the row does not have. A month and a year is a fact that stays a fact.
   */
  function sinceLabel(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var lang = (window.getLang && window.getLang()) === "sw" ? "sw-TZ" : "en-GB";
    try {
      return d.toLocaleDateString(lang, { month: "short", year: "numeric" });
    } catch (_) {
      return String(d.getFullYear());
    }
  }

  // ---- their own words ------------------------------------------------------

  /**
   * The bio, or the absence of one said out loud.
   *
   * A blank space under a name reads as "this person had nothing to say",
   * which is a claim about them rather than about our data. The two sides need
   * DIFFERENT sentences for the same emptiness: a visitor is being told not to
   * read anything into it, an owner is being told to go and fix it, and one
   * sentence cannot do both jobs.
   *
   * Escaped, and white-space: pre-line in the stylesheet, so paragraph breaks
   * survive and a URL somebody typed stays visible text rather than becoming a
   * destination this app appears to vouch for.
   */
  function bio(card, opts) {
    var o = opts || {};
    var text = String(card.bio || "").trim();
    if (text) return '<div class="agc-bio">' + esc(text) + "</div>";
    return '<div class="agc-bio is-none">' + esc(o.emptyText ||
      t("ag_no_bio", "They have not written anything about their work yet.")) + "</div>";
  }

  /** Do they have a key to encrypt to? The one thing that gates writing. */
  function reachable(card) { return !!(card && card.reachable); }

  window.AgentCard = {
    identity: identity,
    stats: stats,
    bio: bio,
    reachable: reachable,
    initials: initials,
    sinceLabel: sinceLabel,
  };
})();
