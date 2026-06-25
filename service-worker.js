// =====================================================================
// Maisha na Lifeza — Service Worker
// Strategy: app-shell precache + network-first for HTML + stale-while-
// revalidate for assets. Tiny by design — no offline DB / write queue.
// =====================================================================

const VERSION = "v295-2026-06-25-video-faststart-cors-fix";
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
  "./js/config.js",
  "./js/analytics.js",
  "./js/auth-clerk.js",
  "./js/fx.js",
  "./js/near-me.js",
  "./js/frame.js",
  "./js/request-place.js",
  "./js/geo.js",
  "./js/geo-poly.js",
  "./js/tz-places.js",
  "./js/area.js",
  "./js/geolocate.js",
  "./js/map-expand.js",
  "./js/i18n.js",
  "./js/data.js",
  "./js/auth.js",
  "./js/auth-ui.js",
  "./js/agent-profile.js",
  "./js/houses-mobile.js",
  "./js/agent-demand-board.js",
  "./js/nav.js",
  "./js/home-app.js",
  "./js/app-shell.js",
  "./js/theme.js",
  "./js/mobile-nav.js",
  "./js/fab.js",
  "./js/tenant.js",
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
