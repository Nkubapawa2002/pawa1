// =====================================================================
// Pawa Bus Cargo — Service Worker
// Strategy: app-shell precache + network-first for HTML + stale-while-
// revalidate for assets. Tiny by design — no offline DB / write queue.
// =====================================================================

const VERSION = "v90-2026-06-03-geolocate-map-expand";
const PRECACHE  = "pawa-precache-" + VERSION;
const RUNTIME   = "pawa-runtime-"  + VERSION;

const APP_SHELL = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./css/mobile.css",
  "./css/houses-pro.css",
  "./css/neon-pro.css",
  "./js/config.js",
  "./js/geo.js",
  "./js/geolocate.js",
  "./js/map-expand.js",
  "./js/i18n.js",
  "./js/data.js",
  "./js/auth.js",
  "./js/nav.js",
  "./js/mobile-nav.js",
  "./js/fab.js",
  "./js/tenant.js",
  "./manifest.json",
  "./icons/icon-maskable.svg",
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
