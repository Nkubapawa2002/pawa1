// Offline unit tests for js/geo-poly.js (point-in-polygon for area alerts).
//   node tests/geo_poly_test.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const code = fs.readFileSync(path.join(root, "js", "geo-poly.js"), "utf8");
const sandbox = { window: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "geo-poly.js" });
const P = sandbox.window.pawaPoly;

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log("  PASS", n); } else { failed++; console.log("  FAIL", n, x != null ? JSON.stringify(x) : ""); } };

// A 1°×1° square around the origin (lng/lat order).
const square = { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
// Square with a hole in the middle (4..6).
const holed = { type: "Polygon", coordinates: [
  [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
  [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
] };
const multi = { type: "MultiPolygon", coordinates: [
  [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
  [[[8, 8], [10, 8], [10, 10], [8, 10], [8, 8]]],
] };

ok("inside square", P.pointInGeom(5, 5, square));
ok("outside square (east)", !P.pointInGeom(15, 5, square));
ok("outside square (south)", !P.pointInGeom(5, -1, square));
ok("inside holed ring but outside hole", P.pointInGeom(2, 2, holed));
ok("inside the hole = NOT in polygon", !P.pointInGeom(5, 5, holed));
ok("multipolygon first part", P.pointInGeom(1, 1, multi));
ok("multipolygon second part", P.pointInGeom(9, 9, multi));
ok("multipolygon gap = outside", !P.pointInGeom(5, 5, multi));

// bbox fast-reject must agree with the real test.
const bb = P.bboxOf(square);
ok("bbox of square", JSON.stringify(bb) === JSON.stringify([0, 0, 10, 10]), bb);
ok("bbox reject short-circuits outside", !P.pointInGeom(50, 50, square, bb));
ok("bbox does not reject a true inside point", P.pointInGeom(5, 5, square, bb));

// centroid is a usable display anchor (roughly centre for a symmetric square).
const c = P.centroidOf(square);
ok("centroid near centre", c && Math.abs(c.lng - 5) < 0.1 && Math.abs(c.lat - 5) < 0.1, c);

// robustness: malformed / empty inputs never throw, always false/null.
ok("null geom → false", P.pointInGeom(1, 1, null) === false);
ok("NaN point → false", P.pointInGeom(NaN, 1, square) === false);
ok("degenerate ring (<3 pts) → false", P.pointInRing(1, 1, [[0, 0], [1, 1]]) === false);
ok("empty rings → false", P.pointInPolygon(1, 1, []) === false);
ok("bboxOf(null) → null", P.bboxOf(null) === null);
ok("centroidOf(null) → null", P.centroidOf(null) === null);

// A realistic concave (L-shaped) ward — point in the notch must read outside.
const Lshape = { type: "Polygon", coordinates: [[[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6], [0, 0]]] };
ok("L-shape: inside the arm", P.pointInGeom(1, 5, Lshape));
ok("L-shape: in the notch = outside", !P.pointInGeom(5, 5, Lshape));

// ---- multi-area OR matching (one alert, several watched areas) ----
// Dar-ish coords so the haversine circle test is realistic.
const circleArea = { kind: "circle", lat: -6.78, lng: 39.28, radius_m: 1000 };  // 1 km
const polyArea = { kind: "custom", geo: square, bbox: P.bboxOf(square) };

ok("area: inside the circle (~0)", P.pointInArea(39.28, -6.78, circleArea));
ok("area: just outside the circle", !P.pointInArea(39.30, -6.78, circleArea));  // ~2.2 km east
ok("area: inside polygon area", P.pointInArea(5, 5, polyArea));
ok("areas: OR matches the polygon one", P.pointInAreas(5, 5, [circleArea, polyArea]));
ok("areas: OR matches the circle one", P.pointInAreas(39.28, -6.78, [circleArea, polyArea]));
ok("areas: in neither = false", !P.pointInAreas(20, 20, [circleArea, polyArea]));
ok("areas: empty list = false", !P.pointInAreas(5, 5, []));
ok("areas: non-array = false", !P.pointInAreas(5, 5, null));
ok("area: radius 0 never matches", !P.pointInArea(39.28, -6.78, { lat: -6.78, lng: 39.28, radius_m: 0 }));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
