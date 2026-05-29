// Register the Pawa service worker and auto-reload the page once when a
// NEW service worker takes over — otherwise users keep running cached
// pre-update JS until they manually clear site data. Guarded by
// `navigator.serviceWorker.controller` so the very first install (no
// prior controller) does NOT trigger a spurious reload.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("./service-worker.js")
      .then((reg) => {
        // Nudge the browser to check for updates on every page load.
        reg.update?.().catch(() => {});
      })
      .catch((e) => console.warn("Service worker registration failed:", e));

    if (hadController) {
      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      });
    }
  });
}
