// Offline unit tests for the routing engine in js/geo.js — no network.
// Loads geo.js in a VM sandbox with a mocked fetch + storage, then drives
// pawaRoute.table / pawaRoute.route through the failure modes that matter in
// production: endpoint failover, transient 429s, malformed listings, cache
// reuse, >99-destination chunking, total OSRM outage, and route alternatives.
//
//   node tests/geo_route_test.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const code = fs.readFileSync(path.join(root, "js", "geo.js"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS", name); }
  else { failed++; console.log("  FAIL", name, extra != null ? "→ " + JSON.stringify(extra) : ""); }
}
const near = (a, b, eps = 1e-6) => typeof a === "number" && Math.abs(a - b) <= eps;

function mkStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
}

// Build a fresh, isolated geo.js instance with its own fetch spy + caches.
function loadGeo(fetchImpl) {
  const calls = [];
  const fetchSpy = (url, opts) => { calls.push(String(url)); return fetchImpl(String(url), opts); };
  const sandbox = {
    window: { APP_CONFIG: { LOCATIONIQ_KEY: "" } },
    console, setTimeout, clearTimeout,
    AbortController,
    sessionStorage: mkStore(), localStorage: mkStore(),
    fetch: fetchSpy,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "geo.js" });
  return { win: sandbox.window, calls };
}

const res = (status, body) => Promise.resolve({
  ok: status >= 200 && status < 300, status, json: async () => body,
});
const isPrimary = (u) => u.includes("router.project-osrm.org");
const isFallback = (u) => u.includes("routing.openstreetmap.de");
// Build an OSRM table reply: distances row = [0, d1, d2, …] in metres.
const tableReply = (n) => ({ code: "Ok", distances: [[0, ...Array.from({ length: n }, (_, i) => (i + 1) * 1000)]] });

const A = { lat: -6.8368, lng: 39.3200 };          // Dar es Salaam city
const far = { lat: -3.3869, lng: 36.6830 };        // Arusha (~450 km — no ferry)

async function run() {
  // 1) Failover: primary always 429, fallback serves the table.
  {
    const { win, calls } = loadGeo((u) =>
      isPrimary(u) ? res(429, {}) :
      isFallback(u) && u.includes("/table/") ? res(200, tableReply(1)) : res(500, {}));
    const km = await win.pawaRoute.table(A, [{ lat: -7.1, lng: 39.2 }]);
    ok("failover: real km from fallback", near(km[0], 1), km);
    ok("failover: primary was tried", calls.some(isPrimary));
    ok("failover: fallback was tried", calls.some(isFallback));
    // After success, fallback becomes preferred → next call hits it first.
    const before = calls.length;
    await win.pawaRoute.table(A, [{ lat: -7.2, lng: 39.25 }]);
    ok("failover: sticks to working endpoint", isFallback(calls[before]), calls[before]);
  }

  // 2) Malformed point must not poison the batch.
  {
    const { win } = loadGeo((u) => u.includes("/table/") ? res(200, tableReply(2)) : res(500, {}));
    const km = await win.pawaRoute.table(A, [
      { lat: -7.1, lng: 39.2 }, { lat: NaN, lng: 39.2 }, { lat: -7.0, lng: 39.3 },
    ]);
    ok("bad-point: length preserved", km.length === 3, km);
    ok("bad-point: NaN slot is null", km[1] === null, km);
    ok("bad-point: valid slots resolved", near(km[0], 1) && near(km[2], 2), km);
  }

  // 3) Bad origin → all null, zero network.
  {
    const { win, calls } = loadGeo(() => res(200, tableReply(1)));
    const km = await win.pawaRoute.table({ lat: NaN, lng: 1 }, [{ lat: -7, lng: 39 }]);
    ok("bad-origin: all null", km.length === 1 && km[0] === null, km);
    ok("bad-origin: no network call", calls.length === 0, calls.length);
  }

  // 4) Per-pair cache reuse: identical second call makes no new request.
  {
    const { win, calls } = loadGeo((u) => u.includes("/table/") ? res(200, tableReply(1)) : res(500, {}));
    const pts = [{ lat: -7.1, lng: 39.2 }];
    await win.pawaRoute.table(A, pts);
    const after = calls.length;
    const km = await win.pawaRoute.table(A, pts);
    ok("cache: second call hits cache", calls.length === after && near(km[0], 1), { after, now: calls.length });
  }

  // 5) Chunking: 150 destinations → two table calls, all filled.
  {
    let n0 = 0;
    const { win, calls } = loadGeo((u) => {
      if (!u.includes("/table/")) return res(500, {});
      // count destinations = semicolons (origin + dests) minus 1
      const coordPart = u.split("/table/v1/driving/")[1].split("?")[0];
      const dests = coordPart.split(";").length - 1;
      n0++;
      return res(200, tableReply(dests));
    });
    const pts = Array.from({ length: 150 }, (_, i) => ({ lat: -7 - i * 0.001, lng: 39 + i * 0.001 }));
    const km = await win.pawaRoute.table(A, pts);
    ok("chunk: two table calls", calls.filter((u) => u.includes("/table/")).length === 2, calls.length);
    ok("chunk: every destination resolved", km.length === 150 && km.every((x) => typeof x === "number"));
  }

  // 6) Total OSRM outage → all null, no throw.
  {
    const { win } = loadGeo(() => Promise.reject(new Error("network down")));
    let threw = false, km;
    try { km = await win.pawaRoute.table(A, [{ lat: -7.1, lng: 39.2 }, { lat: -7.2, lng: 39.3 }]); }
    catch (_) { threw = true; }
    ok("outage: no throw", !threw);
    ok("outage: all null", Array.isArray(km) && km.length === 2 && km.every((x) => x === null), km);
  }

  // 7) code !== "Ok" is treated as failure (and tries the other endpoint).
  {
    const { win, calls } = loadGeo((u) => res(200, { code: "NoRoute" }));
    const km = await win.pawaRoute.table(A, [{ lat: -7.1, lng: 39.2 }]);
    ok("noroute: null result", km[0] === null, km);
    ok("noroute: both endpoints tried", calls.some(isPrimary) && calls.some(isFallback));
  }

  // 8) routeLine returns the fastest leg + alternatives (no ferry on a long inland trip).
  {
    const routeReply = {
      code: "Ok",
      routes: [
        { distance: 460000, duration: 21600, geometry: { type: "LineString", coordinates: [[39.32, -6.83], [36.68, -3.38]] }, legs: [{ distance: 460000 }] },
        { distance: 500000, duration: 23000, geometry: { type: "LineString", coordinates: [[39.32, -6.83], [37, -4], [36.68, -3.38]] }, legs: [{ distance: 500000 }] },
      ],
    };
    const { win } = loadGeo((u) => u.includes("/route/") ? res(200, routeReply) : res(500, {}));
    const r = await win.pawaRoute.route(A, far);
    ok("route: fastest leg first", r && near(r.km, 460), r && r.km);
    ok("route: alternative present", r && Array.isArray(r.alts) && r.alts.length === 1, r && r.alts);
    ok("route: geometry passed through", r && r.geojson && r.geojson.coordinates.length === 2);
  }

  // 9) routeLine with bad coords → null, no network.
  {
    const { win, calls } = loadGeo(() => res(200, {}));
    const r = await win.pawaRoute.route(A, { lat: NaN, lng: 39 });
    ok("route bad-dest: null", r === null);
    ok("route bad-dest: no network", calls.length === 0, calls.length);
  }

  // 10) Ferry-aware table: a water-separated dest where the road is a big detour
  //     gets re-measured via the ferry route and ranks by the shorter distance.
  {
    const acrossWater = { lat: -6.86, lng: 39.29 };   // Kigamboni side of the ferry
    const ferryRoute = {
      code: "Ok",
      routes: [{
        distance: 8000, duration: 1200,
        geometry: { type: "LineString", coordinates: [[39.32, -6.8368], [39.29, -6.86]] },
        legs: [{ distance: 3000 }, { distance: 1000 }, { distance: 4000 }],  // land · crossing · land
      }],
    };
    const { win, calls } = loadGeo((u) =>
      u.includes("/table/") ? res(200, { code: "Ok", distances: [[0, 25000]] }) :  // 25 km bridge detour
      u.includes("/route/") ? res(200, ferryRoute) : res(500, {}));
    const km = await win.pawaRoute.table(A, [acrossWater]);
    ok("ferry: shorter ferry km wins over the road detour", near(km[0], 8, 0.001), km);
    ok("ferry: a route call was made for the correction", calls.some((u) => u.includes("/route/")));
  }

  // 11) Ferry-aware table: a normal dest (road ≈ crow-flies) is NOT ferry-probed.
  {
    const { win, calls } = loadGeo((u) =>
      u.includes("/table/") ? res(200, { code: "Ok", distances: [[0, 5000]] }) : res(500, {}));
    const km = await win.pawaRoute.table(A, [{ lat: -6.86, lng: 39.30 }]);  // ~4 km crow, 5 km road
    ok("no-ferry: keeps the road km", near(km[0], 5), km);
    ok("no-ferry: no extra route call", !calls.some((u) => u.includes("/route/")), calls);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
