// ============================================================================
//  Ride driver matcher — loader for the Rust→WASM `rank_drivers` engine.
//
//  Source: services/rust/src/lib.rs  →  js/house-match.wasm (shared artifact).
//  Ranks the live online drivers nearest a pickup so the rider filters BEFORE
//  requesting and the dispatch chain offers the ride in best-first order.
//
//  window.RideMatch.rankDrivers(pickup, vehicleType, drivers) →
//      [{ driver, score, etaMin }]  sorted best-first, excluded ones dropped.
//  Falls back to identical pure JS if the WASM can't load.
// ============================================================================

(function () {
  const DRV_HEADER = 4, DRV_IN_STRIDE = 5, OUT_STRIDE = 2;
  const STALE_SEC = 90, CITY_KMH = 28;

  let wasm = null, tried = false;
  async function loadWasm() {
    if (tried) return wasm;
    tried = true;
    try {
      const url = new URL("js/house-match.wasm", document.baseURI).href;
      let instance;
      try { ({ instance } = await WebAssembly.instantiateStreaming(fetch(url), {})); }
      catch (_) {
        const bytes = await (await fetch(url)).arrayBuffer();
        ({ instance } = await WebAssembly.instantiate(bytes, {}));
      }
      wasm = instance.exports;
      if (typeof wasm.rank_drivers !== "function") wasm = null; // old cached wasm
    } catch (e) {
      console.warn("[ride-match] WASM unavailable, using JS fallback:", e?.message || e);
      wasm = null;
    }
    return wasm;
  }

  const ageSec = (d) => {
    const t = d.last_seen ? new Date(d.last_seen).getTime() : 0;
    return t ? (Date.now() - t) / 1000 : 1e9;
  };
  const ratingOf = (d) => Number(d.rating ?? d.rating_avg ?? 0) || 0;

  // Map vehicle-type strings → stable numeric codes for this call (so equality
  // works without hardcoding the type list). filter -1 = any.
  function vehicleCoder(vehicleType, drivers) {
    const map = new Map();
    let next = 0;
    const code = (v) => {
      if (v == null || v === "") return -2;           // unknown → never matches a filter
      if (!map.has(v)) map.set(v, next++);
      return map.get(v);
    };
    drivers.forEach(d => code(d.vehicle_type));
    const filter = (vehicleType && vehicleType !== "any") ? code(vehicleType) : -1;
    return { code, filter };
  }

  function rankWasm(pickup, drivers, coder) {
    const n = drivers.length;
    const buf = new Float64Array(DRV_HEADER + n * DRV_IN_STRIDE);
    buf[0] = pickup.lat; buf[1] = pickup.lng; buf[2] = coder.filter; buf[3] = n;
    drivers.forEach((d, i) => {
      const b = DRV_HEADER + i * DRV_IN_STRIDE;
      buf[b] = Number(d.lat); buf[b + 1] = Number(d.lng);
      buf[b + 2] = ratingOf(d); buf[b + 3] = ageSec(d); buf[b + 4] = coder.code(d.vehicle_type);
    });
    const inPtr = wasm.alloc(buf.length);
    new Float64Array(wasm.memory.buffer, inPtr, buf.length).set(buf);
    const outPtr = wasm.rank_drivers(inPtr, buf.length);
    const out = new Float64Array(wasm.memory.buffer, outPtr, n * OUT_STRIDE).slice();
    wasm.dealloc(inPtr, buf.length);
    wasm.dealloc(outPtr, n * OUT_STRIDE);
    return out;
  }

  function rankJs(pickup, drivers, coder) {
    const toRad = x => x * Math.PI / 180;
    const out = new Float64Array(drivers.length * OUT_STRIDE);
    drivers.forEach((d, i) => {
      const vc = coder.code(d.vehicle_type), age = ageSec(d);
      let score = -1, eta = 0;
      if (!(coder.filter >= 0 && vc !== coder.filter) && age <= STALE_SEC &&
          Number.isFinite(+d.lat) && Number.isFinite(+d.lng)) {
        const dLat = toRad(d.lat - pickup.lat), dLng = toRad(d.lng - pickup.lng);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(pickup.lat)) * Math.cos(toRad(d.lat)) * Math.sin(dLng / 2) ** 2;
        const dist = 2 * 6371 * Math.asin(Math.sqrt(a));
        eta = dist / CITY_KMH * 60;
        const prox = 70 * Math.exp(-eta / 4);
        const rate = 20 * (Math.min(5, Math.max(0, ratingOf(d))) / 5);
        const fresh = 10 * Math.min(1, Math.max(0, 1 - age / STALE_SEC));
        score = Math.round(Math.min(100, prox + rate + fresh));
      }
      out[i * OUT_STRIDE] = score; out[i * OUT_STRIDE + 1] = eta;
    });
    return out;
  }

  window.RideMatch = {
    warmup() { return loadWasm(); },
    async rankDrivers(pickup, vehicleType, drivers) {
      drivers = (drivers || []).filter(d => d && d.driver_id && d.lat != null && d.lng != null);
      if (!pickup || !drivers.length) return [];
      const coder = vehicleCoder(vehicleType, drivers);
      await loadWasm();
      let out;
      try { out = wasm ? rankWasm(pickup, drivers, coder) : rankJs(pickup, drivers, coder); }
      catch (e) { console.warn("[ride-match] WASM threw, JS fallback:", e?.message || e); out = rankJs(pickup, drivers, coder); }
      return drivers
        .map((d, i) => ({ driver: d, score: out[i * OUT_STRIDE], etaMin: out[i * OUT_STRIDE + 1] }))
        .filter(x => x.score >= 0)
        .sort((a, b) => b.score - a.score);
    },
    engine() { return wasm ? "wasm" : (tried ? "js" : "unloaded"); }
  };
})();
