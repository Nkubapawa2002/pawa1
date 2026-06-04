// =====================================================================
// Pawa Bus Cargo — Live currency / FX rates
// =====================================================================
// Adds live exchange rates on top of the static `formatTZS()` so prices
// can be shown with an "≈ $X" foreign equivalent (useful for diaspora /
// international users browsing fares, parcels and property in TZS).
//
//   • Source: open.er-api.com (ExchangeRate-API open access) — FREE, no
//     API key, CORS-enabled, updates daily. From the public-apis list.
//   • Rates are USD-based and cached in localStorage; we only hit the
//     network when the cache is older than FX_CACHE_HOURS (rates barely
//     move intraday and the free tier refreshes once a day anyway).
//   • Everything degrades gracefully: if the fetch fails or FX is disabled
//     the helpers return "" / null and nothing on the page breaks.
//
// Public API (all on window):
//   PawaFX.ready                  → Promise that resolves once rates load
//   PawaFX.fromTZS(tzs, code)     → Number in `code` (e.g. "USD"), or null
//   PawaFX.format(tzs, code)      → "≈ $1,234" string, or "" if unavailable
//   formatTZSWithUSD(tzs)         → "TZS 100,000 (≈ $38)" convenience wrapper
// =====================================================================
(function () {
  "use strict";

  const cfg = (window.APP_CONFIG || {});
  const FX  = (cfg.FX || {});

  const ENABLED      = FX.ENABLED !== false;                 // default ON
  const ENDPOINT     = FX.ENDPOINT  || "https://open.er-api.com/v6/latest/USD";
  const DISPLAY_CODE = FX.DISPLAY_CURRENCY || "USD";         // what formatTZSWithUSD appends
  const CACHE_HOURS  = FX.CACHE_HOURS != null ? FX.CACHE_HOURS : 12;
  const CACHE_KEY    = "pawa_fx_usd_rates_v1";

  // Currency → display symbol. Falls back to "<CODE> " for anything missing.
  const SYMBOLS = {
    USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", INR: "₹",
    KES: "KSh ", UGX: "USh ", RWF: "FRw ", ZAR: "R ", AED: "AED ",
    TZS: "TZS ",
  };
  function symbolFor(code) {
    return SYMBOLS[code] || (code + " ");
  }

  // USD-based rates table: rates[CODE] = how many CODE per 1 USD.
  let rates = null;

  // ---- cache helpers ----------------------------------------------------
  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !obj.rates || !obj.ts) return null;
      const ageMs = Date.now() - obj.ts;
      if (ageMs > CACHE_HOURS * 3600 * 1000) return obj; // stale but still usable as fallback
      return obj;
    } catch (_) { return null; }
  }
  function writeCache(r) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), rates: r }));
    } catch (_) { /* private mode / quota — ignore */ }
  }
  function isFresh(obj) {
    return obj && (Date.now() - obj.ts) <= CACHE_HOURS * 3600 * 1000;
  }

  // ---- load -------------------------------------------------------------
  async function load() {
    if (!ENABLED) return null;

    const cached = readCache();
    // Serve fresh cache immediately, skip the network entirely.
    if (isFresh(cached)) { rates = cached.rates; return rates; }

    // Use any stale cache as a fallback while we try the network.
    if (cached) rates = cached.rates;

    try {
      const res  = await fetch(ENDPOINT, { headers: { "Accept": "application/json" } });
      if (!res.ok) throw new Error("FX HTTP " + res.status);
      const data = await res.json();
      if (data && data.rates && data.rates.TZS) {
        rates = data.rates;
        writeCache(rates);
      }
    } catch (err) {
      // Network failed — keep whatever stale cache we have (may be null).
      if (window.console) console.warn("[fx] live rates unavailable, using cache:", err.message);
    }
    return rates;
  }

  // ---- conversion -------------------------------------------------------
  // TZS → `code`. Rates are USD-based, so: amount_in_code = tzs / rate_TZS * rate_code.
  function fromTZS(tzs, code) {
    code = code || DISPLAY_CODE;
    const n = Number(tzs);
    if (!rates || !rates.TZS || !rates[code] || isNaN(n)) return null;
    return (n / rates.TZS) * rates[code];
  }

  // TZS → "≈ $1,234" (rounded sensibly). Returns "" when unavailable.
  function format(tzs, code) {
    code = code || DISPLAY_CODE;
    const v = fromTZS(tzs, code);
    if (v == null) return "";
    // Sub-unit amounts keep 2 decimals; larger amounts round to whole units.
    const digits = Math.abs(v) < 100 ? 2 : 0;
    const num = v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return "≈ " + symbolFor(code) + num;
  }

  // ---- expose -----------------------------------------------------------
  const ready = load();

  window.PawaFX = {
    ready,
    fromTZS,
    format,
    get rates() { return rates; },
    DISPLAY_CODE,
  };

  // Convenience wrapper that mirrors window.formatTZS but appends the
  // live foreign equivalent when available, e.g. "TZS 100,000 (≈ $38)".
  // Synchronous: returns the plain TZS string until rates have loaded.
  window.formatTZSWithUSD = function (n) {
    const base = (window.formatTZS ? window.formatTZS(n) : ("TZS " + n));
    const fx   = format(n);
    return fx ? `${base} (${fx})` : base;
  };
})();
