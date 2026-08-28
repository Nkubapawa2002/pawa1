// =====================================================================
// Maisha na Lifeza — Service Worker
// Strategy: app-shell precache + network-first for HTML + stale-while-
// revalidate for assets. Tiny by design — no offline DB / write queue.
// =====================================================================

// Bump on every change to APP_SHELL. The activate handler purges caches whose
// name no longer matches, so an unchanged VERSION leaves existing installs
// serving a precache full of the OLD js/ paths — which, after the core/lib/
// pages restructure, no longer exist.
const VERSION = "v308-2026-08-28-home-bands";
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
  "./js/lib/service-categories.js",
  "./js/core/app-shell.js",
  "./js/core/theme.js",
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
