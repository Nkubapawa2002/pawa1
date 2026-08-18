/* ===========================================================================
 * video-space-home.js — mounts the video space at the bottom of index.html.
 *
 * Renders whatever should play in the visitor's region (a community video for
 * its 9 hours, otherwise the admin's default), autoplays it when scrolled into
 * view, and handles posting a new one.
 *
 * The heavy lifting — validation, the slot claim, trimming, the 9-hour clock —
 * lives in js/lib/video-space.js and the database. This file is the screen.
 *
 * THREE THINGS THIS SCREEN OWES THE VISITOR
 *   1. Never a dead black rectangle. There is always a state on show: loading,
 *      empty-and-inviting, or playing.
 *   2. Never a dead end. Every refusal names what to do next, and the two that
 *      are actionable — "sign in" and "wrong region" — put the control right
 *      there instead of describing it.
 *   3. Never a surprise. The region whose slot you are about to take is shown
 *      before you pick a file, not after the upload fails.
 * =========================================================================== */
(function () {
  "use strict";

  var VS = window.VideoSpace;
  var root = document.getElementById("videoSpace");
  if (!VS || !root) return;

  var els = {
    stage:      root.querySelector(".vs-stage"),
    video:      root.querySelector("#vsVideo"),
    empty:      root.querySelector(".vs-empty"),
    badge:      root.querySelector("#vsBadge"),
    region:     root.querySelector("#vsRegion"),
    regionBtn:  root.querySelector("#vsRegionBtn"),
    regionPick: root.querySelector("#vsRegionPick"),
    regionSel:  root.querySelector("#vsRegionSelect"),
    countdown:  root.querySelector("#vsCountdown"),
    unmute:     root.querySelector("#vsUnmute"),
    postBtn:    root.querySelector("#vsPost"),
    postLabel:  root.querySelector("#vsPostLabel"),
    input:      root.querySelector("#vsFile"),
    status:     root.querySelector("#vsStatus"),
    bar:        root.querySelector("#vsBar"),
    hint:       root.querySelector("#vsHint"),
  };

  var region = VS.resolveRegion();
  var stopAutoplay = null;
  var countdownTimer = null;
  var signedIn = null;          // null = not checked yet

  // ---- Copy -----------------------------------------------------------------
  // window.t() returns the KEY when a string is missing, so a bare t("x") can
  // print "vs_badge_default" into the page. Every lookup here falls back to
  // English on a miss, and {placeholders} are filled in after translation so
  // Swahili word order stays free.
  function t(key, fallback, vars) {
    var s = window.t ? window.t(key) : key;
    if (!s || s === key) s = fallback;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
      });
    }
    return s;
  }

  function say(msg, kind) {
    if (!els.status) return;
    els.status.textContent = msg || "";
    els.status.className = "vs-status" + (kind ? " " + kind : "");
  }

  function busy(on) {
    if (els.postBtn) els.postBtn.disabled = !!on;
    if (els.bar) els.bar.hidden = !on;
    root.classList.toggle("is-busy", !!on);
  }

  function state(name) {
    // One class decides what the stage shows, so the three states can never be
    // on screen at once (the old bug: an empty message behind a black video).
    root.classList.remove("is-loading", "is-empty", "is-playing");
    root.classList.add(name);
  }

  // ---- Region ---------------------------------------------------------------
  /**
   * Show `name` as the region in play.
   *
   * Only a DELIBERATE choice is written to localStorage. Persisting the
   * auto-resolved guess would pin a first-time visitor to the "Dar es Salaam"
   * fallback forever — resolveRegion() reads storage first, so a stored guess
   * outranks the better answer it would get once they have a position.
   */
  function applyRegion(name, persist) {
    region = name;
    if (persist) VS.setRegion(name);
    if (els.region) els.region.textContent = name;
    if (els.regionSel) els.regionSel.value = name;
  }

  function fillRegions() {
    if (!els.regionSel || els.regionSel.options.length) return;
    var names = (window.TZ_REGION_CENTERS || [])
      .map(function (r) { return r.name; })
      .sort(function (a, b) { return a.localeCompare(b); });
    // No gazetteer (script blocked, cache miss) → leave the picker out rather
    // than show an empty dropdown; the resolved region still works.
    if (!names.length) {
      if (els.regionBtn) els.regionBtn.hidden = true;
      return;
    }
    names.forEach(function (n) {
      var o = document.createElement("option");
      o.value = o.textContent = n;
      els.regionSel.appendChild(o);
    });
    els.regionSel.value = region;
  }

  function toggleRegionPicker(open) {
    if (!els.regionPick || !els.regionBtn) return;
    var next = open == null ? els.regionPick.hidden : open;
    els.regionPick.hidden = !next;
    els.regionBtn.setAttribute("aria-expanded", String(next));
    if (next && els.regionSel) els.regionSel.focus();
  }

  // ---- Countdown ------------------------------------------------------------
  // "6h 12m left". Rounded to the minute — a ticking second hand on a 9-hour
  // timer is noise, and it would repaint the layout 3,600 times an hour.
  function startCountdown(expiresAt) {
    stopCountdown();
    if (!expiresAt || !els.countdown) return;
    var end = new Date(expiresAt).getTime();
    if (!isFinite(end)) return;

    var tick = function () {
      var left = end - Date.now();
      if (left <= 0) {
        stopCountdown();
        els.countdown.textContent = "";
        load();                       // the slot just freed — show the default
        return;
      }
      var h = Math.floor(left / 3600000);
      var m = Math.floor((left % 3600000) / 60000);
      els.countdown.textContent = h > 0
        ? t("vs_time_left_h", "{h}h {m}m left", { h: h, m: m })
        : t("vs_time_left_m", "{m}m left", { m: m });
    };
    tick();
    countdownTimer = setInterval(tick, 30000);
  }

  function stopCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  // ---- Sign-in state --------------------------------------------------------
  // Checked once, lazily. A signed-out visitor gets "Sign in to post" and is
  // sent to login.html with a way back here, rather than being told to sign in
  // by an error message after they have already chosen a file.
  async function checkSession(recheck) {
    if (recheck) signedIn = null;
    if (signedIn !== null) return signedIn;
    var client = window.SB || null;
    if (!client) { signedIn = false; return signedIn; }
    try {
      var s = await client.auth.getSession();
      signedIn = !!(s && s.data && s.data.session);
    } catch (_) {
      signedIn = false;
    }
    if (els.postLabel) {
      els.postLabel.textContent = signedIn
        ? t("vs_post", "Post yours")
        : t("vs_signin", "Sign in to post");
    }
    return signedIn;
  }

  // ---- Render ---------------------------------------------------------------
  async function load() {
    if (els.region) els.region.textContent = region;
    state("is-loading");

    var cur = await VS.current(region);

    if (stopAutoplay) { stopAutoplay(); stopAutoplay = null; }
    stopCountdown();

    if (!cur || cur.source === "none" || !cur.path) {
      // Nothing live and no default posted yet. Show the invitation rather than
      // an empty black box.
      state("is-empty");
      if (els.video) { els.video.removeAttribute("src"); els.video.load(); }
      if (els.badge) els.badge.textContent = "";
      if (els.countdown) els.countdown.textContent = "";
      return;
    }

    state("is-playing");
    if (els.badge) {
      els.badge.textContent = cur.source === "community"
        ? t("vs_badge_community", "Posted by someone in {region}", { region: cur.region || region })
        : t("vs_badge_default", "From Pnzaki");
    }

    if (els.video) {
      els.video.src = VS.publicUrl(cur.path);
      els.video.load();
      stopAutoplay = VS.autoplayOnView(els.video);
    }

    if (cur.source === "community") startCountdown(cur.expires_at);
    else if (els.countdown) els.countdown.textContent = "";
  }

  // ---- Post -----------------------------------------------------------------
  function stageText(stage, detail) {
    if (stage === "claiming") {
      return t("vs_stage_claiming", "Reserving the space for {region}…", { region: region });
    }
    if (stage === "processing" && detail && detail.willTrim) {
      return t("vs_stage_trimming",
        "Your clip is longer than 2 min 39 s — trimming it to fit…");
    }
    switch (stage) {
      case "validating": return t("vs_stage_validating", "Checking your video…");
      case "processing": return t("vs_stage_processing", "Preparing your video…");
      case "uploading":  return t("vs_stage_uploading", "Uploading…");
      case "publishing": return t("vs_stage_publishing", "Almost there…");
      default:           return t("vs_stage_processing", "Preparing your video…");
    }
  }

  function friendlyFailure(res) {
    var when = function (iso) {
      if (!iso) return "";
      var d = new Date(iso);
      return isFinite(d.getTime())
        ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "";
    };
    switch (res.reason) {
      case "auth_required":
        return t("vs_err_auth", "Sign in first — that's how we keep the space accountable.");
      case "slot_busy":
        return when(res.free_at)
          ? t("vs_err_busy",
              "Someone in {region} got there first. The space frees up at {time} — try again then.",
              { region: region, time: when(res.free_at) })
          : t("vs_err_busy_soon",
              "Someone in {region} got there first. Try again when their 9 hours are up.",
              { region: region });
      case "rate_limited":
        return t("vs_err_rate",
          "You've already posted in the last 9 hours. You can post again at {time}.",
          { time: when(res.retry_at) || "—" });
      case "gateway_down":
        return t("vs_err_gateway",
          "Your clip is longer than 2 min 39 s and the trimming service is asleep right now. " +
          "Wait a minute and try again, or trim it yourself first.");
      case "unknown_region":
        return t("vs_err_region", "We couldn't tell which region you're in. Pick one above and try again.");
      case "claim_lost":
        return t("vs_err_claim_lost", "The upload took too long and the space was released. Please try again.");
      case "upload_failed":
        return t("vs_err_upload", "The upload didn't finish — check your connection and try again.");
      case "offline":
        return t("vs_err_offline", "You appear to be offline.");
      default:
        return t("vs_err_generic", "That didn't work. Please try again.") +
               (res.detail ? " (" + res.detail + ")" : "");
    }
  }

  async function handleFile(file) {
    if (!file) return;
    busy(true);
    say("");
    try {
      var res = await VS.post(file, region, function (stage, detail) {
        say(stageText(stage, detail));
      });

      if (!res.ok) {
        say(friendlyFailure(res), "err");
        // A refusal that the picker can fix should open the picker.
        if (res.reason === "unknown_region" || res.reason === "slot_busy") toggleRegionPicker(true);
        // The session expired mid-flow — re-read it so the button goes back to
        // "Sign in to post" instead of silently failing on the next tap.
        if (res.reason === "auth_required") checkSession(true);
        return;
      }

      say(res.trimmed
        ? t("vs_ok_trimmed", "Posted — trimmed to 2 min 39 s. It's live for the next 9 hours.")
        : t("vs_ok", "Posted. It's live for the next 9 hours."), "ok");
      await load();
    } catch (err) {
      // validate() throws with a message written for a person.
      say((err && err.message) || t("vs_err_generic", "That didn't work. Please try again."), "err");
    } finally {
      busy(false);
      if (els.input) els.input.value = "";   // let the same file be retried
    }
  }

  // ---- Wire up --------------------------------------------------------------
  if (els.postBtn && els.input) {
    els.postBtn.addEventListener("click", async function () {
      if (!(await checkSession())) {
        // Come back here once they are in, instead of dropping them on the
        // portal chooser with no idea what they were doing.
        location.href = "login.html?next=index.html";
        return;
      }
      els.input.click();
    });
    els.input.addEventListener("change", function (e) {
      handleFile(e.target.files && e.target.files[0]);
    });
  }

  if (els.regionBtn) {
    els.regionBtn.addEventListener("click", function () { toggleRegionPicker(); });
  }
  if (els.regionSel) {
    els.regionSel.addEventListener("change", function () {
      applyRegion(els.regionSel.value, true);   // deliberate → remember it
      toggleRegionPicker(false);
      say("");
      load();
    });
  }

  if (els.unmute && els.video) {
    els.unmute.addEventListener("click", function () {
      els.video.muted = !els.video.muted;
      els.unmute.setAttribute("aria-pressed", String(!els.video.muted));
      els.unmute.classList.toggle("is-on", !els.video.muted);
      if (!els.video.muted && els.video.paused) els.video.play().catch(function () {});
    });
  }

  // Defer the first read until the section is near the viewport. The video space
  // sits at the very bottom of a long homepage — loading it at boot would spend
  // a mobile visitor's data on something they may never scroll to.
  function boot() {
    fillRegions();
    applyRegion(region, false);   // a guess until they say otherwise
    checkSession();
    load();
  }

  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) {
        io.disconnect();
        boot();
      }
    }, { rootMargin: "400px 0px" });
    io.observe(root);
  } else {
    boot();
  }
})();
