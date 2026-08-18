// =====================================================================
// The national video — one clip, the whole country, view only.
//
// Explore is the national view: every room, truck, service and day job in
// Tanzania in one search. The stage at the bottom of it matches that scope —
// a single video that everyone who opens Explore sees, wherever they are.
//
// WHY THIS DOES NOT CALL current_region_video()
//   That RPC looks like the obvious fit, but with a null region its first
//   query reads `(p_region is null or region = p_region)` — which matches
//   EVERY region, so it returns the newest community clip from anywhere in
//   the country. That is a national *feed*, not a national *default*: it
//   would change under your feet every time somebody in any region posted.
//   Explore's stage is the one admins set deliberately, so this reads the
//   global default row directly (region is null) and nothing else.
//
// The table is public-readable by design, so this works signed out — which
// matters, because most people meeting the site for the first time arrive
// on Explore without an account.
//
// Deliberately view-only: no post button, no region picker, no countdown.
// One slot for 60 million people would be a race nobody could win, and the
// place to post is the homepage, where the slot is your own region's.
//
// Usage (explore.html, after js/lib/video-space.js):
//   window.VideoNational.mount(document.getElementById("nationalVideo"));
// =====================================================================
(function () {
  "use strict";

  var BUCKET = "region-videos";

  // Same accessor as js/lib/video-space.js — read at call time, never cached,
  // because the client is created after this file parses.
  function sb() { return window.SB || null; }

  // Reuse the video-space URL builder when it is loaded, so the two stages can
  // never disagree about where a clip lives. Fall back to the same shape.
  function publicUrl(path) {
    if (window.VideoSpace && window.VideoSpace.publicUrl) {
      return window.VideoSpace.publicUrl(path);
    }
    var cfg = window.APP_CONFIG || {};
    var base = (cfg.SUPABASE_URL || "").replace(/\/+$/, "");
    if (!base || !path) return "";
    return base + "/storage/v1/object/public/" + BUCKET + "/" + path;
  }

  function t(key, fallback) {
    return window.t ? window.t(key, fallback) : fallback;
  }

  /**
   * The global default clip, or null when no admin has set one.
   * Never throws — Explore must render with or without a video.
   */
  async function current() {
    var client = sb();
    if (!client) return null;
    try {
      // .is("region", null) is the whole query: region_video_defaults holds at
      // most one global row, enforced by region_video_defaults_global_uniq.
      var res = await client.from("region_video_defaults")
        .select("storage_path, label")
        .is("region", null)
        .maybeSingle();
      if (res.error || !res.data || !res.data.storage_path) return null;
      return { path: res.data.storage_path, label: res.data.label || null };
    } catch (_) {
      return null;
    }
  }

  /**
   * Render into `root` (the .video-space section) and start playing.
   * Safe to call when the element is absent — Explore still works without it.
   */
  async function mount(root) {
    if (!root) return;
    var video  = root.querySelector("video");
    var badge  = root.querySelector("[data-vn-badge]");
    var unmute = root.querySelector("[data-vn-mute]");
    if (!video) return;

    var setState = function (state) {
      root.classList.remove("is-loading", "is-empty", "is-playing");
      root.classList.add(state);
    };

    var found = await current();
    if (!found) {
      // No default set. The empty copy already explains what belongs here, so
      // there is nothing to say beyond showing it.
      setState("is-empty");
      return;
    }

    video.src = publicUrl(found.path);
    if (badge) badge.textContent = found.label || t("vn_badge", "From Pnzaki");
    setState("is-playing");

    // Hand playback to the shared helper rather than repeating it here: it
    // already loops, mutes, sizes the stage to the clip, plays only once the
    // stage is actually on screen, pauses in a backgrounded tab, and falls
    // back to controls when a browser refuses autoplay. Two copies of that
    // would drift, and the homepage stage is where the edge cases surface.
    var start = function () {
      var p = video.play();
      if (p && p.catch) p.catch(function () { video.controls = true; });
    };
    if (window.VideoSpace && window.VideoSpace.autoplayOnView) {
      window.VideoSpace.autoplayOnView(video);
    } else {
      // video-space.js absent — still loop and play rather than show a
      // one-shot clip that freezes on its last frame.
      video.loop = true;
      video.muted = true;
      start();
    }

    if (unmute) {
      unmute.addEventListener("click", function () {
        video.muted = !video.muted;
        unmute.setAttribute("aria-pressed", String(!video.muted));
        // Unmuting is a deliberate act; make sure it is actually playing.
        if (!video.muted) start();
      });
    }
  }

  window.VideoNational = { mount: mount, current: current, publicUrl: publicUrl };
})();
