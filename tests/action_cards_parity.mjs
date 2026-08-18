// ============================================================================
// action_cards_parity.mjs — proof that moving the helper-card CSS out of
// index.html's <style> block into css/action-cards.css changed nothing.
//
// Screenshots cannot answer this: the homepage rotates its hero and its feed,
// so two runs of the SAME code differ byte for byte. What is actually being
// asked is "do these elements still compute to the same styles and boxes?", so
// that is what gets measured.
//
// The baseline is index.html exactly as it is committed, written out to a
// temporary file at the repo root (same relative paths, so it loads the same
// assets) and served alongside the working copy.
//
//   usage:  node server.js      then, in another shell:
//           node tests/action_cards_parity.mjs
// ============================================================================
import puppeteer from "puppeteer";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";

const BASE = "http://localhost:8080";
const BASELINE = "_index_baseline.html";

// Everything the extracted rules set, plus the box itself — if any of these
// moved, the homepage moved.
const PROPS = ["display", "alignItems", "gap", "width", "textAlign", "backgroundColor",
  "borderTopWidth", "borderTopColor", "borderTopLeftRadius", "padding", "cursor",
  "fontSize", "fontWeight", "color", "lineHeight", "borderRadius", "transitionProperty"];

const measure = () => {
  const out = [];
  const seen = (el, tag) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const styles = {};
    for (const p of ["display", "alignItems", "gap", "width", "textAlign", "backgroundColor",
      "borderTopWidth", "borderTopColor", "borderTopLeftRadius", "padding", "cursor",
      "fontSize", "fontWeight", "color", "lineHeight", "borderRadius", "transitionProperty"]) {
      styles[p] = cs[p];
    }
    out.push({ tag, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], styles });
  };
  document.querySelectorAll(".ha-find").forEach((el, i) => seen(el, `.ha-find[${i}]`));
  document.querySelectorAll(".ha-find-sub").forEach((el, i) => seen(el, `.ha-find-sub[${i}]`));
  document.querySelectorAll(".ha-find-card").forEach((el, i) => {
    seen(el, `.ha-find-card[${i}]`);
    const ic = el.querySelector(".ha-find-ic");
    const t = el.querySelector(".ha-find-t");
    const d = el.querySelector(".ha-find-d");
    if (ic) seen(ic, `.ha-find-ic[${i}]`);
    if (t) seen(t, `.ha-find-t[${i}]`);
    if (d) seen(d, `.ha-find-d[${i}]`);
  });
  return out;
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

writeFileSync(BASELINE, execSync("git show HEAD:index.html", { encoding: "utf8", maxBuffer: 32e6 }));

let pass = 0, fail = 0;
const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
});
try {
  const grab = async (path, theme) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = req.url();
      if (req.method() === "OPTIONS") {
        return req.respond({ status: 204, headers: {
          "access-control-allow-origin": "*", "access-control-allow-headers": "*",
          "access-control-allow-methods": "*" } });
      }
      if (/cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)) {
        return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
      }
      if (/arcgisonline|basemaps\.cartocdn|api\.mapbox|tile\.openstreetmap|supabase\.co\/storage|\.mp4$/.test(url)) {
        return req.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
      }
      if (/supabase\.co/.test(url)) {
        return req.respond({ status: 200, headers: {
          "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
      }
      req.continue();
    });
    // Theme is stamped on <html> by js/core/theme.js from localStorage, so it
    // has to be set before the document runs.
    await page.evaluateOnNewDocument((t) => {
      try { localStorage.setItem("pawa-theme", t); } catch (_) {}
    }, theme);
    await page.goto(`${BASE}/${path}`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1800));
    const data = await page.evaluate(measure);
    await page.close();
    return data;
  };

  for (const theme of ["dark", "light"]) {
    process.stdout.write(`\n${theme} mode\n`);
    const before = await grab(BASELINE, theme);
    const after = await grab("index.html", theme);

    if (before.length === 0) {
      fail++; process.stdout.write("  FAIL  the baseline page has no .ha-find elements to compare\n");
      continue;
    }
    if (before.length !== after.length) {
      fail++; process.stdout.write(`  FAIL  element count changed: ${before.length} → ${after.length}\n`);
      continue;
    }
    pass++; process.stdout.write(`  PASS  same ${before.length} elements present\n`);

    const diffs = [];
    before.forEach((b, i) => {
      const a = after[i];
      if (JSON.stringify(b.rect) !== JSON.stringify(a.rect)) {
        diffs.push(`${b.tag} box ${JSON.stringify(b.rect)} → ${JSON.stringify(a.rect)}`);
      }
      for (const p of PROPS) {
        if (b.styles[p] !== a.styles[p]) diffs.push(`${b.tag} ${p}: "${b.styles[p]}" → "${a.styles[p]}"`);
      }
    });
    if (diffs.length) {
      fail++;
      process.stdout.write(`  FAIL  ${diffs.length} difference(s)\n        ` + diffs.slice(0, 12).join("\n        ") + "\n");
    } else {
      pass++;
      process.stdout.write("  PASS  every box and computed style is identical\n");
    }
  }
} finally {
  await browser.close();
  try { unlinkSync(BASELINE); } catch (_) {}
}
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
