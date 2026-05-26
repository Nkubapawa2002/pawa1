// Register the Pawa service worker. Silently no-ops if not supported.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((e) => {
      console.warn("Service worker registration failed:", e);
    });
  });
}
