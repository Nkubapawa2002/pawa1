/* ===========================================================================
 * video-space.js — the community video slot at the bottom of the homepage.
 *
 * One video per region, live for 9 hours, first upload wins the slot. When the
 * slot is empty or the 9 hours are up it falls back to the admin's default clip.
 *
 * WHAT THIS FILE IS AND IS NOT RESPONSIBLE FOR
 *   The database owns correctness: the "one active video per region" rule is a
 *   partial unique index, the 9-hour clock is set server-side, and every read
 *   filters on expires_at. See supabase/features/video/region_video_space.sql.
 *   The gateway owns the 2m39s cap: services/python trims with ffmpeg.
 *   This file owns the experience — it fails fast on the client so a user on a
 *   Tanzanian mobile link learns their clip is too big BEFORE uploading it, and
 *   learns the slot is taken BEFORE uploading it. Every check here is a
 *   courtesy that is re-run somewhere that a browser cannot reach.
 *
 * UPLOAD ORDER (this order is the point)
 *   1. validate locally      — cheap, instant, no network
 *   2. claim the slot        — ~50ms; the loser of a race stops here
 *   3. normalise via gateway — trim to 2m39s + faststart
 *   4. upload to storage     — the expensive step, only ever reached by a winner
 *   5. publish               — starts the 9-hour clock server-side
 * =========================================================================== */
(function () {
  "use strict";

  // ---- Limits ---------------------------------------------------------------
  // 2 minutes 39 seconds. The browser check is advisory; services/python does
  // the real cut. Kept here so the UI can say "we'll trim it" before uploading.
  var MAX_DURATION_S = 159;

  // Generous enough for 2m39s of phone video, tight enough that the bucket
  // cannot be used as a file drop. Matches the bucket's file_size_limit.
  var MAX_BYTES = 50 * 1024 * 1024;

  // The gateway may cut on a keyframe, landing a little under the cap. Accept a
  // small overshoot so a legitimate trim is never rejected at publish time.
  var DURATION_GRACE_S = 6;

  var BUCKET = "region-videos";
  var ALLOWED_MIME = ["video/mp4", "video/webm", "video/quicktime"];
  var DEFAULT_REGION = "Dar es Salaam";
  var REGION_KEY = "pawa_region";

  function cfg() { return window.APP_CONFIG || {}; }
  function sb() { return window.SB || null; }

  // ---- Region ---------------------------------------------------------------
  // The slot is per region, so we need one before anything else. Preference
  // order: what the user picked > nearest region centre to their last known
  // position > Dar. Never blocks on a GPS prompt — the video space must render
  // for someone who has never granted location.
  function storedRegion() {
    try { return localStorage.getItem(REGION_KEY) || ""; } catch (_) { return ""; }
  }

  function setRegion(name) {
    try { localStorage.setItem(REGION_KEY, name); } catch (_) {}
  }

  function nearestRegion(lat, lng) {
    var centers = window.TZ_REGION_CENTERS || [];
    if (!centers.length) return "";
    var best = "", bestD = Infinity;
    for (var i = 0; i < centers.length; i++) {
      var c = centers[i];
      // Plain squared euclidean on lat/lng. Over Tanzania's span this ranks
      // identically to a great-circle distance and costs nothing.
      var dLat = c.lat - lat, dLng = (c.lng - lng) * Math.cos(lat * Math.PI / 180);
      var d = dLat * dLat + dLng * dLng;
      if (d < bestD) { bestD = d; best = c.name; }
    }
    return best;
  }

  /**
   * Which region's slot this visitor sees. In order:
   *   1. what they picked (persisted)
   *   2. the nearest region centre to their last known position
   *   3. Dar es Salaam
   *
   * Step 2 reads a position the app ALREADY has — written by js/lib/geolocate.js
   * the last time the user granted location on any page. It never asks for one:
   * a permission prompt to decide which video to autoplay is not a trade anyone
   * agreed to, and the homepage does not even load the geolocation helper.
   */
  function resolveRegion() {
    var stored = storedRegion();
    if (stored) return stored;
    try {
      var last = window.pawaLocate && window.pawaLocate.lastKnown
        ? window.pawaLocate.lastKnown()
        : JSON.parse(localStorage.getItem("pawa_last_pos") || "null");
      if (last && isFinite(last.lat) && isFinite(last.lng)) {
        var r = nearestRegion(last.lat, last.lng);
        if (r) return r;
      }
    } catch (_) {}
    return DEFAULT_REGION;
  }

  // ---- Validation -----------------------------------------------------------
  // A File's `type` and `name` come from the page, which comes from the user.
  // Neither is evidence. The container sniff below reads the actual bytes, and
  // the gateway repeats it server-side where a browser cannot interfere.
  function sniffContainer(buf) {
    var b = new Uint8Array(buf);
    if (b.length < 16) return null;
    // ISO-BMFF (mp4 / mov / m4v): a `ftyp` box near the start.
    for (var i = 0; i < Math.min(b.length - 4, 64); i++) {
      if (b[i] === 0x66 && b[i + 1] === 0x74 && b[i + 2] === 0x79 && b[i + 3] === 0x70) return "mp4";
    }
    // Matroska / WebM: EBML header.
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
    return null;
  }

  function readHead(file, bytes) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error("unreadable")); };
      fr.readAsArrayBuffer(file.slice(0, bytes || 64));
    });
  }

  // Duration via a throwaway <video>. Used only to warn "we'll trim this" —
  // a file whose metadata is unreadable is still allowed through, because the
  // gateway will measure it properly with ffprobe.
  function probeDuration(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var v = document.createElement("video");
      var done = function (val) { URL.revokeObjectURL(url); resolve(val); };
      v.preload = "metadata";
      v.onloadedmetadata = function () { done(isFinite(v.duration) ? v.duration : null); };
      v.onerror = function () { done(null); };
      setTimeout(function () { done(null); }, 8000);  // never hang the upload
      v.src = url;
    });
  }

  /** Throws a user-facing Error on refusal; resolves to {container, duration}. */
  async function validate(file) {
    if (!file) throw new Error("Choose a video first.");

    if (file.size > MAX_BYTES) {
      throw new Error(
        "That file is " + (file.size / 1048576).toFixed(1) + " MB. The limit is " +
        (MAX_BYTES / 1048576) + " MB — please record or export a smaller clip."
      );
    }
    if (file.size < 1024) throw new Error("That file is empty or damaged.");

    // MIME is checked because the bucket enforces it too — a file that passes
    // here and fails there would be a confusing late error.
    var mime = (file.type || "").toLowerCase();
    if (mime && ALLOWED_MIME.indexOf(mime) === -1) {
      throw new Error("Only MP4, WebM and MOV videos can be posted.");
    }

    var container = sniffContainer(await readHead(file, 64));
    if (!container) {
      throw new Error("That file is not a video. Please choose an MP4, WebM or MOV.");
    }

    var duration = await probeDuration(file);
    return { container: container, duration: duration, willTrim: duration != null && duration > MAX_DURATION_S };
  }

  // ---- Gateway --------------------------------------------------------------
  function gatewayBase() {
    var u = cfg().VIDEO_GATEWAY_URL || "";
    return u ? u.replace(/\/$/, "") : "";
  }

  /**
   * Trim to 2m39s + faststart. Returns {file, duration, trimmed, ok}.
   * A gateway that is asleep, slow or missing must never lose a user's video —
   * on any failure the original file is passed through with ok:false, and the
   * caller decides whether to warn.
   */
  async function normalize(file) {
    var base = gatewayBase();
    if (!base) return { file: file, duration: null, trimmed: false, ok: false };
    try {
      var res = await fetch(base + "/normalize", {
        method: "POST",
        headers: { "Content-Type": file.type || "video/mp4" },
        body: file,
      });
      if (!res.ok) return { file: file, duration: null, trimmed: false, ok: false };
      var blob = await res.blob();
      if (!blob || !blob.size) return { file: file, duration: null, trimmed: false, ok: false };

      var applied = res.headers.get("X-Faststart") === "applied";
      var dur = parseFloat(res.headers.get("X-Duration") || "");
      var name = applied
        ? (file.name || "video").replace(/\.[^.]+$/, "") + ".mp4"
        : (file.name || "video.mp4");
      return {
        file: new File([blob], name, { type: blob.type || file.type || "video/mp4" }),
        duration: isFinite(dur) ? dur : null,
        trimmed: res.headers.get("X-Trimmed") === "yes",
        ok: true,
      };
    } catch (_) {
      return { file: file, duration: null, trimmed: false, ok: false };
    }
  }

  // ---- The upload flow ------------------------------------------------------
  /**
   * Post a video to a region's slot.
   * @param {File} file
   * @param {string} region
   * @param {(stage:string, detail?:object) => void} [onStage]
   * @returns {Promise<{ok:boolean, reason?:string, expires_at?:string, trimmed?:boolean, free_at?:string, retry_at?:string}>}
   */
  async function post(file, region, onStage) {
    var say = onStage || function () {};
    var client = sb();
    if (!client) return { ok: false, reason: "offline" };

    say("validating");
    var v = await validate(file);          // throws with a user-facing message

    // Claim BEFORE uploading. This is the whole reason the flow has two phases:
    // losing the race after a 40 MB upload on mobile data would be cruel.
    say("claiming");
    var claim = await client.rpc("claim_region_video_slot", { p_region: region });
    if (claim.error) return { ok: false, reason: "rpc_failed", detail: claim.error.message };
    var c = claim.data || {};
    if (!c.ok) return c;                   // slot_busy | rate_limited | auth_required

    // From here on we hold the slot. Any failure must release it rather than
    // leave the region blocked — the claim's own 10-minute expiry is the
    // backstop, but releasing eagerly gives the next person their turn now.
    try {
      say("processing", { willTrim: v.willTrim });
      var norm = await normalize(file);

      var duration = norm.duration != null ? norm.duration : v.duration;
      // If the gateway was unreachable AND the clip is over the cap, we would be
      // publishing an untrimmed video. Refuse rather than break the promise that
      // every video is at most 2m39s.
      if (!norm.ok && v.duration != null && v.duration > MAX_DURATION_S + DURATION_GRACE_S) {
        await release(client, c.claim_id);
        return { ok: false, reason: "gateway_down" };
      }

      say("uploading");
      var session = await client.auth.getSession();
      var uid = session && session.data && session.data.session && session.data.session.user
        ? session.data.session.user.id : null;
      if (!uid) { await release(client, c.claim_id); return { ok: false, reason: "auth_required" }; }

      var ext = norm.file.type === "video/webm" ? "webm" : "mp4";
      var path = uid + "/" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;
      var up = await client.storage.from(BUCKET).upload(path, norm.file, {
        contentType: norm.file.type || "video/mp4",
        upsert: false,
      });
      if (up.error) { await release(client, c.claim_id); return { ok: false, reason: "upload_failed", detail: up.error.message }; }

      say("publishing");
      var pub = await client.rpc("publish_region_video", {
        p_claim_id: c.claim_id,
        p_path: path,
        p_duration_s: duration,
        p_bytes: norm.file.size,
        p_mime: norm.file.type || "video/mp4",
      });
      if (pub.error) {
        await client.storage.from(BUCKET).remove([path]).catch(function () {});
        await release(client, c.claim_id);
        return { ok: false, reason: "rpc_failed", detail: pub.error.message };
      }
      var p = pub.data || {};
      if (!p.ok) {
        // The claim was reaped mid-upload (slow link, >10 min). The object is
        // now an orphan, so remove it instead of leaving it for the collector.
        await client.storage.from(BUCKET).remove([path]).catch(function () {});
        return p;
      }

      setRegion(region);
      return { ok: true, expires_at: p.expires_at, trimmed: norm.trimmed, region: region };
    } catch (err) {
      await release(client, c.claim_id);
      throw err;
    }
  }

  // Give the slot back immediately. Best-effort: the claim expires on its own
  // within 10 minutes regardless, so a failure here is not worth surfacing.
  async function release(client, claimId) {
    if (!claimId) return;
    try { await client.from("region_videos").delete().eq("id", claimId); } catch (_) {}
  }

  // ---- Read -----------------------------------------------------------------
  /** What should play in this region right now. Never throws. */
  async function current(region) {
    var client = sb();
    if (!client) return { source: "none" };
    try {
      var res = await client.rpc("current_region_video", { p_region: region || null });
      if (res.error || !res.data) return { source: "none" };
      return res.data;
    } catch (_) {
      return { source: "none" };
    }
  }

  function publicUrl(path) {
    if (!path) return "";
    if (/^https?:\/\//.test(path)) return path;      // admin may store a full URL
    var base = (cfg().SUPABASE_URL || "").replace(/\/$/, "");
    return base + "/storage/v1/object/public/" + BUCKET + "/" + path;
  }

  // ---- Autoplay -------------------------------------------------------------
  /**
   * Play when the video scrolls into view, pause when it leaves.
   *
   * Autoplay only works muted + playsinline — every mobile browser blocks a
   * video with sound until the user taps. So it starts muted with a visible
   * unmute control, which is also the behaviour people expect from a feed.
   * Reduced-motion users get a paused video with controls instead.
   */
  /**
   * Match the stage's shape to the clip's own.
   *
   * The stage is 9/16 by default because most clips are shot on a phone held
   * upright. A landscape clip in that box was losing roughly half its height
   * to black bars — the "video is tiny, the margins are huge" complaint. Now
   * the box takes the video's real ratio the moment the metadata lands, so it
   * is never letterboxed, and because the ratios then agree, object-fit: cover
   * crops nothing either.
   *
   * Clamped to between 9/16 and 16/9 so one freak upload cannot render the
   * stage as a sliver or a skyscraper.
   */
  function fitStage(video) {
    if (!video) return;
    var stage = video.closest ? video.closest(".vs-stage") : null;
    if (!stage) return;
    var apply = function () {
      var w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return;
      stage.style.aspectRatio = String(Math.min(Math.max(w / h, 9 / 16), 16 / 9));
    };
    if (video.readyState >= 1) apply();   // metadata already in (cached clip)
    video.addEventListener("loadedmetadata", apply);
  }

  function autoplayOnView(video) {
    if (!video) return function () {};
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    video.muted = true;
    // Loop. A nine-hour slot that plays its clip once and then freezes on a
    // random last frame is worse than showing nothing — whoever arrives after
    // the first play sees a still image and assumes the space is broken.
    video.loop = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    fitStage(video);

    if (reduce || !("IntersectionObserver" in window)) {
      video.controls = true;
      return function () {};
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          // play() rejects if the browser still refuses (low power mode, a
          // policy we cannot detect). Fall back to controls so the video is
          // never a dead black rectangle.
          var p = video.play();
          if (p && p.catch) p.catch(function () { video.controls = true; });
        } else if (!video.paused) {
          video.pause();
        }
      });
    }, { threshold: 0.55 });   // over half visible — "reached", not merely peeking

    io.observe(video);
    // A backgrounded tab should not burn a user's data plan.
    var onVis = function () { if (document.hidden && !video.paused) video.pause(); };
    document.addEventListener("visibilitychange", onVis);

    return function () {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }

  window.VideoSpace = {
    MAX_DURATION_S: MAX_DURATION_S,
    MAX_BYTES: MAX_BYTES,
    ALLOWED_MIME: ALLOWED_MIME,
    validate: validate,
    normalize: normalize,
    post: post,
    current: current,
    publicUrl: publicUrl,
    autoplayOnView: autoplayOnView,
    fitStage: fitStage,
    resolveRegion: resolveRegion,
    setRegion: setRegion,
    nearestRegion: nearestRegion,
  };
})();
