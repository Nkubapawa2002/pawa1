// Shared browser-geolocation helper — one place that gets "use my location"
// right everywhere (houses near-me, GPS pins, ride live tracking, meet).
//
// Why this exists (the bugs it fixes):
//   1. NO PROMPT ON iOS — iOS Safari often won't pop the permission prompt for
//      watchPosition() alone. We always fire a one-shot getCurrentPosition()
//      first, which reliably triggers it.
//   2. "DENIED / BLOCKED" with no way out — we detect a pre-denied permission
//      and return a clear, platform-aware recovery message instead of a silent
//      failure or a raw error string.
//   3. WRONG / INACCURATE SPOT — a single fix is often a coarse cell-tower
//      guess. best() keeps watching for a few seconds and returns the tightest
//      reading (stopping early once it's good enough).
//
// API (window.pawaLocate):
//   pawaLocate.supported()                         -> boolean
//   await pawaLocate.best({ targetAccuracy, maxWaitMs, highAccuracy,
//                           onProgress, signal })   -> { lat, lng, accuracy, ... }
//   const stop = pawaLocate.watch({ onFix, onError, highAccuracy,
//                                   timeout, maximumAge })   // continuous
//   pawaLocate.message(err)                        -> friendly string
//
// best() rejects with a normalised error: { code, message } where code is one
// of "unsupported" | "insecure" | "denied" | "unavailable" | "timeout" |
// "aborted". message() turns any of those (or a raw GeolocationPositionError)
// into something a user can act on.
(function () {
  "use strict";

  function supported() {
    return typeof navigator !== "undefined" && "geolocation" in navigator;
  }

  // Geolocation only works in a secure context (https or localhost). On plain
  // http the call silently fails — surface that as its own clear case.
  function secure() {
    if (typeof window === "undefined") return true;
    if (window.isSecureContext) return true;
    const h = location.hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "";
  }

  function err(code, message) {
    return { code, message };
  }

  // Friendly, actionable copy for each failure mode.
  function message(e) {
    const code = (e && e.code) || "";
    // Raw GeolocationPositionError uses numeric codes 1/2/3.
    if (code === 1 || code === "denied" || (e && e.PERMISSION_DENIED === code)) {
      return "Location is blocked. Tap the lock/ⓘ icon in your browser's address bar and allow Location, then try again. (iPhone: Settings → your browser → Location → While Using.)";
    }
    if (code === 2 || code === "unavailable") {
      return "Your phone can't get a GPS fix right now. Go outside or near a window, or toggle Location Services off and on, then try again.";
    }
    if (code === 3 || code === "timeout") {
      return "Getting your location timed out — the first fix can take up to 30s indoors. Please try again.";
    }
    if (code === "unsupported") return "This device or browser doesn't support location.";
    if (code === "insecure")    return "Location needs a secure (https) connection. Open the site over https and try again.";
    if (code === "aborted")     return "Location request cancelled.";
    return (e && e.message) || "Couldn't get your location. Please try again.";
  }

  // Best-effort check for an already-denied permission, so we can fail fast with
  // recovery guidance instead of hanging on a prompt that will never appear.
  // Returns "granted" | "denied" | "prompt" | "unknown".
  async function permissionState() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return "unknown";
      const st = await navigator.permissions.query({ name: "geolocation" });
      return st.state || "unknown";
    } catch (_) {
      return "unknown";
    }
  }

  function toFix(pos) {
    const c = pos.coords;
    return {
      lat: c.latitude, lng: c.longitude, accuracy: c.accuracy,
      heading: c.heading, speed: c.speed, ts: pos.timestamp,
    };
  }

  // One-shot "best fix": prompt-safe, then tighten for a short window.
  async function best(opts = {}) {
    const {
      targetAccuracy = 25,   // metres — stop early once this good
      maxWaitMs      = 8000,  // hard cap so the caller never hangs
      highAccuracy   = true,
      onProgress,             // called with each improving fix
      signal,                 // optional AbortSignal to cancel (e.g. second tap)
    } = opts;

    if (!supported()) throw err("unsupported");
    if (!secure())    throw err("insecure");
    if (signal && signal.aborted) throw err("aborted");

    if ((await permissionState()) === "denied") throw err("denied");

    return new Promise((resolve, reject) => {
      let bestPos = null;
      let watchId = null;
      let done = false;
      let hardTimer = null;

      const cleanup = () => {
        if (watchId != null) { try { navigator.geolocation.clearWatch(watchId); } catch (_) {} watchId = null; }
        if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      const settleOK = () => {
        if (done) return; done = true; cleanup();
        resolve(toFix(bestPos));
      };
      const settleErr = (e) => {
        if (done) return; done = true; cleanup();
        reject(e);
      };
      const onAbort = () => settleErr(err("aborted"));
      if (signal) signal.addEventListener("abort", onAbort);

      const consider = (pos) => {
        const a = pos.coords.accuracy ?? 1e9;
        if (!bestPos || a < (bestPos.coords.accuracy ?? 1e9)) {
          bestPos = pos;
          if (onProgress) { try { onProgress(toFix(pos)); } catch (_) {} }
        }
        if (a <= targetAccuracy) settleOK();
      };

      // Step 1 — one-shot to force the prompt (iOS) and get an immediate fix.
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          consider(pos);
          if (done) return;
          // Step 2 — keep watching to tighten the fix until good enough / timeout.
          watchId = navigator.geolocation.watchPosition(
            consider,
            () => {},  // ignore mid-watch errors; we already have a fix
            { enableHighAccuracy: highAccuracy, maximumAge: 0, timeout: maxWaitMs }
          );
        },
        (e) => {
          const code = e.code === 1 ? "denied" : e.code === 2 ? "unavailable" : "timeout";
          settleErr(err(code, message(e)));
        },
        { enableHighAccuracy: highAccuracy, maximumAge: 0, timeout: maxWaitMs }
      );

      // Hard stop: return the best we have, or a timeout error if none yet.
      hardTimer = setTimeout(() => {
        if (bestPos) settleOK();
        else settleErr(err("timeout"));
      }, maxWaitMs);
    });
  }

  // Approximate location — a coarse, ALWAYS-available fallback for when precise
  // GPS is denied / unavailable / blocked (desktop without GPS, location off,
  // or a plain-http page). City-level accuracy (~1–50 km). Order of attempts:
  //   1. Google Geolocation API — only if APP_CONFIG.GOOGLE_GEOLOCATION_KEY is
  //      set. With an empty body it geolocates from the request IP.
  //   2. Free, no-key IP geolocation services (HTTPS + CORS), tried in turn.
  // Returns the same shape as best() plus { source, approximate:true, city }.
  async function approximate() {
    const cfg  = (typeof window !== "undefined" && window.APP_CONFIG) || {};
    const gkey = cfg.GOOGLE_GEOLOCATION_KEY;

    if (gkey) {
      try {
        const r = await fetch(
          "https://www.googleapis.com/geolocation/v1/geolocate?key=" + encodeURIComponent(gkey),
          { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
        );
        if (r.ok) {
          const d = await r.json();
          if (d && d.location && isFinite(d.location.lat) && isFinite(d.location.lng)) {
            return { lat: d.location.lat, lng: d.location.lng,
                     accuracy: d.accuracy || 5000, source: "google", approximate: true };
          }
        }
      } catch (_) { /* fall through to free IP services */ }
    }

    const providers = [
      { url: "https://ipwho.is/",                 pick: (d) => (d && d.success !== false && d.latitude != null) ? d : null },
      { url: "https://ipapi.co/json/",            pick: (d) => (d && d.latitude != null) ? d : null },
      { url: "https://get.geojs.io/v1/ip/geo.json", pick: (d) => (d && d.latitude != null) ? d : null },
    ];
    for (const p of providers) {
      try {
        const r = await fetch(p.url);
        if (!r.ok) continue;
        const d = await r.json();
        const hit = p.pick(d);
        if (!hit) continue;
        const lat = parseFloat(hit.latitude), lng = parseFloat(hit.longitude);
        if (isFinite(lat) && isFinite(lng)) {
          return { lat, lng, accuracy: 10000, city: hit.city || null, source: "ip", approximate: true };
        }
      } catch (_) { /* try the next provider */ }
    }
    throw err("unavailable", "Couldn't determine even an approximate location.");
  }

  // Precise GPS first; on ANY failure fall back to approximate (Google/IP) so
  // location-dependent features still work. The returned fix carries
  // approximate:true (and the original GPS error on _gpsError) when it fell
  // back, so callers can show "approximate / city-level" if they want.
  async function bestOrApprox(opts = {}) {
    try {
      return await best(opts);
    } catch (gpsErr) {
      try {
        const a = await approximate();
        a._gpsError = gpsErr;
        return a;
      } catch (_) {
        throw gpsErr;   // surface the actionable GPS error if even IP fails
      }
    }
  }

  // Continuous tracking (ride / meet style). Prompt-safe kick, then watch.
  // Returns a stop() that tears everything down.
  function watch(opts = {}) {
    const {
      onFix, onError,
      highAccuracy = true, timeout = 15000, maximumAge = 5000,
    } = opts;

    if (!supported()) { if (onError) onError(err("unsupported")); return () => {}; }
    if (!secure())    { if (onError) onError(err("insecure"));    return () => {}; }

    let watchId = null;
    let stopped = false;
    const fail = (e) => {
      const code = e.code === 1 ? "denied" : e.code === 2 ? "unavailable" : e.code === 3 ? "timeout" : (e.code || "unavailable");
      if (onError) onError(err(code, message(e)));
    };

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (stopped) return;
        if (onFix) onFix(toFix(pos), pos);
        watchId = navigator.geolocation.watchPosition(
          (p) => { if (!stopped && onFix) onFix(toFix(p), p); },
          fail,
          { enableHighAccuracy: highAccuracy, timeout, maximumAge }
        );
      },
      fail,
      { enableHighAccuracy: highAccuracy, timeout: 20000, maximumAge: 0 }
    );

    return function stop() {
      stopped = true;
      if (watchId != null) { try { navigator.geolocation.clearWatch(watchId); } catch (_) {} watchId = null; }
    };
  }

  window.pawaLocate = { supported, secure, best, bestOrApprox, approximate, watch, message, permissionState };
})();
