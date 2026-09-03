// =====================================================================
// Maisha na Lifeza — Service Worker
// Strategy: app-shell precache + network-first for HTML + stale-while-
// revalidate for assets. Tiny by design — no offline DB / write queue.
// =====================================================================

// Bump on every change to APP_SHELL. The activate handler purges caches whose
// name no longer matches, so an unchanged VERSION leaves existing installs
// serving a precache full of the OLD js/ paths — which, after the core/lib/
// pages restructure, no longer exist.
const VERSION = "v326-2026-09-03-room-characteristics";
const PRECACHE  = "pawa-precache-" + VERSION;
const RUNTIME   = "pawa-runtime-"  + VERSION;

const APP_SHELL = [
  "./",
  "./index.html",
  "./area.html",
  "./css/styles.css",
  "./css/mobile.css",
  "./css/houses-pro.css",
  "./css/houses-mobile-pro.css",
  "./css/neon-pro.css",
  "./css/auth.css",
  "./css/design-system.css",
  "./css/theme-light.css",
  // The adaptive layer, and it is not optional. Every page links it in <head>,
  // and an install that cannot fetch it comes back with the three bugs it
  // exists to fix: a header behind the notch, a 100vh panel hanging past the
  // bottom of the screen, and a tab bar eating a fifth of an iPhone X. The
  // page still renders without it, which is exactly why this had to be
  // listed — the failure is silent and looks like the layout was never fixed.
  "./css/adaptive.css",
  "./css/ds/tokens/fonts.css",
  "./css/ds/tokens/colors.css",
  "./css/ds/tokens/typography.css",
  "./css/ds/tokens/spacing.css",
  "./css/ds/tokens/effects.css",
  "./js/core/config.js",
  "./js/core/analytics.js",
  "./js/core/auth-clerk.js",
  "./js/lib/fx.js",
  "./js/pages/near-me.js",
  "./js/pages/frame.js",
  "./js/lib/request-place.js",
  "./js/lib/geo.js",
  "./js/lib/geo-poly.js",
  "./js/lib/tz-places.js",
  "./js/lib/place-match.js",
  "./js/lib/video-space.js",
  "./js/pages/video-space-home.js",
  // Explore — the global search. Its four libs are precached together because
  // the page is useless with any one of them missing.
  "./explore.html",
  "./js/lib/explore-index.js",
  "./js/lib/explore-query.js",
  "./js/lib/explore-rank.js",
  "./js/lib/explore-match.js",
  "./js/lib/explore-map.js",
  "./js/lib/explore-roads.js",
  "./js/pages/explore.js",
  // The home search reuses Explore's three engine libs above; these are the
  // wiring and the UI on top of them, plus the notification pair. Precached
  // with the homepage because index.html loads all four and is the page most
  // likely to be opened with no signal.
  "./js/lib/home-search.js",
  "./js/core/notify.js",
  "./js/lib/notify-ui.js",
  // The bell's two readers. Without house-alerts.js it counts every new room
  // in the country instead of the ones this device asked about, and without
  // pm-trust.js it never mentions a changed safety number at all. Both fail
  // silently, so a cached install missing them looks like it is working.
  // geo-poly.js is already precached above; house-alerts needs it.
  "./js/lib/house-alerts.js",
  "./js/lib/pm-trust.js",
  // The Frame reads details.rooms through HouseSpec to find business rooms and
  // names their kinds through ListingKinds. Without them it falls back to
  // judging a listing by its type alone, which is the bug they fixed.
  "./js/lib/house-spec.js",
  "./js/lib/listing-kinds.js",
  // The national video stage on explore.html, and the stylesheet both stages
  // share with index.html.
  "./js/lib/video-national.js",
  "./css/video-space.css",
  "./js/pages/area.js",
  "./js/lib/geolocate.js",
  "./js/lib/map-expand.js",
  "./js/core/i18n.js",
  "./js/core/data.js",
  "./js/core/auth.js",
  // The guest fence. It decides what five gated screens draw, so it must
  // never be the one file a cached install is missing.
  "./js/lib/auth-guard.js",
  "./js/lib/auth-ui.js",
  "./js/lib/agent-profile.js",
  "./js/pages/houses-mobile.js",
  "./js/lib/agent-demand-board.js",
  "./js/core/nav.js",
  "./js/pages/home-app.js",
  // The home Frame / earn / trust bands, and the service catalogue the trust
  // strip counts. Both are on the critical path for the home screen: without
  // the catalogue the first stat has nothing to count.
  "./js/pages/home-bands.js",
  "./js/pages/home-live.js",
  "./js/lib/native-feel.js",
  "./js/lib/owner-account.js",
  "./css/owner-badge.css",
  "./js/lib/service-categories.js",
  "./js/core/app-shell.js",
  "./js/core/theme.js",
  // Beside theme.js because it loads beside it, first in every <head> and
  // before first paint. It is what stamps data-shell, so a missing copy does
  // not just lose the measurements — app-shell.js draws both chromes and CSS
  // never learns which one to show.
  "./js/core/viewport.js",
  "./js/pages/tenant.js",
  "./manifest.json",
  "./icons/icon-maskable.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

// Install — precache app shell.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(PRECACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

// Activate — purge old caches.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => ![PRECACHE, RUNTIME].includes(k)).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch — only handle same-origin GETs. Pass-through for everything else
// (Supabase, Anthropic, n8n, AT — those need fresh network every time).
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // HTML pages: network-first so updates land fast; fall back to cache when offline.
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match("./index.html")))
    );
    return;
  }

  // Same-origin static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
