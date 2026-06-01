// Shared geocoding helper — routes OpenStreetMap/Nominatim lookups through the
// Go map gateway (services/go) when one is available, and falls back to calling
// Nominatim directly if the gateway is unset or unreachable.
//
// The gateway's /osm/search and /osm/reverse endpoints are a verbatim
// passthrough: same query params in, same raw Nominatim JSON out — so callers
// keep their existing parsing untouched. The win is server-side caching, a
// 1 req/s rate limit, and a proper User-Agent (Nominatim blocks abusive direct
// browser traffic).
//
// Usage:
//   const list = await pawaGeo.search("format=jsonv2&limit=8&q=Mlimani+City");
//   const j    = await pawaGeo.reverse("format=jsonv2&zoom=16&lat=-6.7&lon=39.2");
(function () {
  "use strict";

  const NOMINATIM = "https://nominatim.openstreetmap.org";

  // Resolve the gateway base URL (no trailing slash), or "" for direct mode.
  function gatewayBase() {
    const cfg = (window.APP_CONFIG && window.APP_CONFIG.GEO_GATEWAY_URL) || "";
    if (cfg) return cfg.replace(/\/+$/, "");
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "") return "http://127.0.0.1:8091";
    return ""; // production with no gateway configured → call Nominatim directly
  }

  async function call(kind, qs) {
    qs = String(qs || "").replace(/^\?/, "");
    const base = gatewayBase();

    // Prefer the gateway; on any failure fall back to Nominatim so a missing
    // or sleeping gateway never breaks the map.
    if (base) {
      try {
        const r = await fetch(`${base}/osm/${kind}?${qs}`, { headers: { Accept: "application/json" } });
        if (r.ok) return r.json();
      } catch (_) { /* fall through to direct */ }
    }
    const r = await fetch(`${NOMINATIM}/${kind}?${qs}`, { headers: { Accept: "application/json" } });
    return r.json();
  }

  window.pawaGeo = {
    search: (qs) => call("search", qs),
    reverse: (qs) => call("reverse", qs),
    gatewayBase,
  };
})();
