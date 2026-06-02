// ============================================================================
//  House matching engine — loader for the Rust → WASM ranker.
//
//  Source: services/rust/src/lib.rs  →  js/house-match.wasm (prebuilt, 27 KB).
//  The frontend stays buildless: we just fetch + instantiate the .wasm.
//
//  Exposes window.HouseMatch.rank(houses, opts) → Map(id → {score, distKm}).
//  If the WASM can't load (old browser, file:// quirk, fetch blocked), it
//  transparently falls back to an identical pure-JS implementation, so the
//  page always ranks — just a touch slower.
//
//  opts: { anchor:{lat,lng}|null, maxBudget:Number, minBedrooms:Number,
//          listing:'rent'|'sale'|'', type:'apartment'|'house'|'plot'|'office'|'' }
//  A score < 0 means the listing was hard-filtered out (over budget, wrong
//  kind/type) — callers should drop it.
// ============================================================================

(function () {
  const LISTING_CODE = { rent: 0, sale: 1 };
  const TYPE_CODE = { apartment: 0, house: 1, plot: 2, office: 3 };

  const HEADER = 8;
  const IN_STRIDE = 6;
  const OUT_STRIDE = 2;

  let wasm = null;        // instantiated exports, or null while/if unavailable
  let triedLoad = false;

  async function loadWasm() {
    if (triedLoad) return wasm;
    triedLoad = true;
    try {
      // WASM URL relative to the page (works under a GitHub Pages subpath too).
      const url = new URL("js/house-match.wasm", document.baseURI).href;
      let instance;
      if (typeof WebAssembly.instantiateStreaming === "function") {
        try {
          ({ instance } = await WebAssembly.instantiateStreaming(fetch(url), {}));
        } catch (_) {
          // Some servers send the wrong MIME type for .wasm — fall back to ArrayBuffer.
          const bytes = await (await fetch(url)).arrayBuffer();
          ({ instance } = await WebAssembly.instantiate(bytes, {}));
        }
      } else {
        const bytes = await (await fetch(url)).arrayBuffer();
        ({ instance } = await WebAssembly.instantiate(bytes, {}));
      }
      wasm = instance.exports;
    } catch (e) {
      console.warn("[house-match] WASM unavailable, using JS fallback:", e?.message || e);
      wasm = null;
    }
    return wasm;
  }

  function listingCode(v) {
    return v in LISTING_CODE ? LISTING_CODE[v] : -1;
  }
  function typeCode(v) {
    return v in TYPE_CODE ? TYPE_CODE[v] : -1;
  }

  // Pack houses + query into the flat f64 input buffer the ABI expects.
  function packInput(houses, opts) {
    const a = opts.anchor;
    const hasAnchor = !!(a && Number.isFinite(a.lat) && Number.isFinite(a.lng));
    const n = houses.length;
    const buf = new Float64Array(HEADER + n * IN_STRIDE);
    buf[0] = hasAnchor ? a.lat : 0;
    buf[1] = hasAnchor ? a.lng : 0;
    buf[2] = hasAnchor ? 1 : 0;
    buf[3] = opts.maxBudget > 0 ? opts.maxBudget : 0;
    buf[4] = opts.minBedrooms > 0 ? opts.minBedrooms : 0;
    buf[5] = opts.listing ? listingCode(opts.listing) : -1;
    buf[6] = opts.type ? typeCode(opts.type) : -1;
    buf[7] = n;
    for (let i = 0; i < n; i++) {
      const h = houses[i];
      const base = HEADER + i * IN_STRIDE;
      buf[base] = Number.isFinite(h.lat) ? h.lat : NaN;
      buf[base + 1] = Number.isFinite(h.lng) ? h.lng : NaN;
      buf[base + 2] = Number(h.price_tzs) || 0;
      buf[base + 3] = Number(h.bedrooms) || 0;
      buf[base + 4] = listingCode(h.listing);
      buf[base + 5] = typeCode(h.type);
    }
    return buf;
  }

  function rankWasm(houses, opts) {
    const input = packInput(houses, opts);
    const n = houses.length;

    // alloc input, copy in, run, read out, free both. Re-create the memory
    // view after the call in case linear memory grew (which detaches buffers).
    const inPtr = wasm.alloc(input.length);
    new Float64Array(wasm.memory.buffer, inPtr, input.length).set(input);
    const outPtr = wasm.match_listings(inPtr, input.length);
    const out = new Float64Array(wasm.memory.buffer, outPtr, n * OUT_STRIDE).slice();
    wasm.dealloc(inPtr, input.length);
    wasm.dealloc(outPtr, n * OUT_STRIDE);

    const result = new Map();
    for (let i = 0; i < n; i++) {
      result.set(houses[i].id, {
        score: out[i * OUT_STRIDE],
        distKm: out[i * OUT_STRIDE + 1] < 0 ? null : out[i * OUT_STRIDE + 1]
      });
    }
    return result;
  }

  // ---- Pure-JS fallback (mirror of services/rust/src/lib.rs::score) --------
  function toRad(d) { return d * Math.PI / 180; }
  function distKm(aLat, aLng, bLat, bLng) {
    const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
    const x = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(x));
  }
  function rankJs(houses, opts) {
    const a = opts.anchor;
    const hasAnchor = !!(a && Number.isFinite(a.lat) && Number.isFinite(a.lng));
    const maxBudget = opts.maxBudget > 0 ? opts.maxBudget : 0;
    const minBeds = opts.minBedrooms > 0 ? opts.minBedrooms : 0;
    const lf = opts.listing ? listingCode(opts.listing) : -1;
    const tf = opts.type ? typeCode(opts.type) : -1;
    const result = new Map();
    for (const h of houses) {
      const lc = listingCode(h.listing), tc = typeCode(h.type);
      const price = Number(h.price_tzs) || 0, beds = Number(h.bedrooms) || 0;
      if (lf >= 0 && lc !== lf) { result.set(h.id, { score: -1, distKm: null }); continue; }
      if (tf >= 0 && tc !== tf) { result.set(h.id, { score: -1, distKm: null }); continue; }
      if (maxBudget > 0 && price > maxBudget * 1.1) { result.set(h.id, { score: -1, distKm: null }); continue; }
      const d = (hasAnchor && Number.isFinite(h.lat) && Number.isFinite(h.lng))
        ? distKm(a.lat, a.lng, h.lat, h.lng) : NaN;
      const prox = Number.isFinite(d) ? 50 * Math.exp(-d / 5) : 50;
      let priceFit = 30;
      if (maxBudget > 0 && price > 0) { const r = price / maxBudget; priceFit = r <= 0.85 ? 30 : r <= 1 ? 24 : 10; }
      let specFit = 20;
      if (minBeds > 0) specFit = beds >= minBeds ? 20 : beds >= minBeds - 1 ? 10 : 2;
      const score = Math.round(Math.min(100, Math.max(0, prox + priceFit + specFit)));
      result.set(h.id, { score, distKm: Number.isFinite(d) ? d : null });
    }
    return result;
  }

  window.HouseMatch = {
    // Kick off the WASM fetch as early as the page wants to.
    warmup() { return loadWasm(); },

    async rank(houses, opts = {}) {
      if (!Array.isArray(houses) || !houses.length) return new Map();
      const o = {
        anchor: opts.anchor || null,
        maxBudget: Number(opts.maxBudget) || 0,
        minBedrooms: Number(opts.minBedrooms) || 0,
        listing: opts.listing || "",
        type: opts.type || ""
      };
      await loadWasm();
      try {
        return wasm ? rankWasm(houses, o) : rankJs(houses, o);
      } catch (e) {
        console.warn("[house-match] WASM ranking threw, falling back to JS:", e?.message || e);
        return rankJs(houses, o);
      }
    },

    // Expose the engine kind for diagnostics / a tiny UI badge.
    engine() { return wasm ? "wasm" : (triedLoad ? "js" : "unloaded"); }
  };
})();
