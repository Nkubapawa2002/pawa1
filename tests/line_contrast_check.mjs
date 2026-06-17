// Offline visibility check for the MAP ROUTE-LINE palette (no browser/network).
// The route lines are drawn over the CARTO Voyager basemap (and optionally Esri
// satellite). Two things must hold for the routing UI to read clearly:
//   1) every line is visible against the map surfaces it crosses, and
//   2) the amber straight-line ESTIMATE is perceptually distinct from the green
//      real-road lines — an estimate must never be mistaken for a real road.
// Run: node tests/line_contrast_check.mjs
//
// Colours are the single source of truth for the styles used in
// js/{geo,near-me,services,trucks,house}.js — keep them in sync if those change.

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const LINES = {
  "road chosen (solid green)": hex("#0a6f4d"),
  "road alt (dashed green)":   hex("#5e8a79"),
  "estimate (dashed amber)":   hex("#b26a00"),
};

// Representative map surfaces a line is drawn on.
const SURFACES = {
  "Voyager land (cream)":  [242, 239, 233],
  "Voyager water (blue)":  [181, 208, 231],
  "Voyager road (white)":  [255, 255, 255],
  "satellite (dark)":      [70, 80, 60],
};

// ---- WCAG contrast (same math as tests/contrast_check.mjs) ----
const lum = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };

// ---- perceptual distance (CIE76 ΔE in Lab) for distinguishing the lines ----
function lab([r, g, b]) {
  let [x, y, z] = [r, g, b].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  // sRGB → XYZ (D65)
  let X = x * 0.4124 + y * 0.3576 + z * 0.1805;
  let Y = x * 0.2126 + y * 0.7152 + z * 0.0722;
  let Z = x * 0.0193 + y * 0.1192 + z * 0.9505;
  [X, Y, Z] = [X / 0.95047, Y / 1.0, Z / 1.08883].map((t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
const deltaE = (a, b) => { const [la, lb] = [lab(a), lab(b)]; return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]); };

// Every line is drawn over a WHITE CASING (see js/{geo,near-me,...}.js), so a
// route is visible on a surface when EITHER the coloured line OR its white
// casing contrasts with that surface — the casing is what rescues the green
// lines on dark satellite imagery.
const CASING = [255, 255, 255];

// Thresholds: lines are thick strokes, so a lower visibility bar than body text
// is acceptable; 1.8:1 reads clearly for a 4–6 px line. ΔE ≥ 25 = obviously different colour.
const MIN_VISIBLE = 1.8;
const MIN_DISTINCT = 25;

let failed = 0;
console.log("== route visibility vs map surfaces (line OR white casing) ==");
for (const [lname, lc] of Object.entries(LINES)) {
  for (const [sname, sc] of Object.entries(SURFACES)) {
    const crLine = ratio(lc, sc), crCasing = ratio(CASING, sc);
    const cr = Math.max(crLine, crCasing);
    const bad = cr < MIN_VISIBLE;
    if (bad) failed++;
    const via = crCasing > crLine ? "casing" : "line";
    console.log(`  ${cr.toFixed(2).padStart(5)}:1 (${via})  ${lname.padEnd(26)} on ${sname}${bad ? "   LOW" : ""}`);
  }
}

console.log("\n== line-vs-line distinguishability (ΔE, want estimate ≠ roads) ==");
const names = Object.keys(LINES);
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const de = deltaE(LINES[names[i]], LINES[names[j]]);
    // The two greens may legitimately be close (distinguished by weight/dash);
    // only the amber-vs-green pairs MUST be perceptually distinct.
    const isEstimatePair = names[i].includes("estimate") || names[j].includes("estimate");
    const bad = isEstimatePair && de < MIN_DISTINCT;
    if (bad) failed++;
    console.log(`  ΔE ${de.toFixed(1).padStart(5)}  ${names[i]}  vs  ${names[j]}${bad ? "   TOO SIMILAR" : ""}`);
  }
}

console.log(`\n${failed ? failed + " problem(s)" : "all line colours visible and distinct"}`);
process.exit(failed ? 1 : 0);
