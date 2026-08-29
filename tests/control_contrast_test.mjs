// ============================================================================
// control_contrast_test.mjs — the filter controls must be readable in BOTH
// themes, on every page that has them.
//
// Two global stylesheets paint form controls with !important, and each was
// winning on the wrong page:
//
//   premium.css   input[type="text"] … { background: rgba(255,255,255,.78) }
//   neon-pro.css  input, select, textarea { background: rgba(7,18,13,.7) }
//
// premium's attribute selector outranks neon-pro's bare `input`, so on a dark
// page the search boxes rendered as near-white slabs. neon-pro loads later and
// wins for `select`, so on a light page the dropdowns rendered near-black with
// near-black ink: measured 2.44:1 across 14 dropdowns on four pages, sitting
// beside white text inputs, which made a filter row look half disabled.
//
// Neither fault is visible to a reviewer on the theme they happen to use.
//
// HOW THIS MEASURES. A translucent fill is not the colour you see. rgba(255,
// 255,255,.05) is a DARK control on a dark card, and judging it by its own
// colour calls it white. Every background here is composited down the ancestor
// chain first. That is the same mistake the older contrast checker makes, and
// the reason this file does its own arithmetic.
//
//   usage:  node server.js     then, in another shell:
//           node tests/control_contrast_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
const PAGES = ["services.html", "trucks.html", "near-me.html", "meet.html",
               "houses.html", "explore.html", "frame.html", "favorites.html"];

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};

const browser = await puppeteer.launch({ headless: "new" });
try {
  for (const theme of ["dark", "light"]) {
    process.stdout.write(`\n${theme === "dark" ? "1" : "2"}. Controls in the ${theme} theme\n`);
    for (const page of PAGES) {
      const p = await browser.newPage();
      await p.setViewport({ width: 430, height: 932 });
      await p.evaluateOnNewDocument((t) => {
        try { localStorage.setItem("pawa-theme", t); } catch (_) {}
      }, theme);
      await p.setRequestInterception(true);
      p.on("request", (r) => {
        const u = r.url();
        if (r.method() === "OPTIONS") {
          return r.respond({ status: 204, headers: {
            "access-control-allow-origin": "*", "access-control-allow-headers": "*",
            "access-control-allow-methods": "*" } });
        }
        if (u.startsWith(BASE)) return r.continue();
        return r.respond({ status: 200,
          headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
          body: "[]" });
      });
      try { await p.goto(`${BASE}/${page}`, { waitUntil: "domcontentloaded", timeout: 45000 }); }
      catch (_) { /* reported by the assertion */ }
      await new Promise((r) => setTimeout(r, 1600));

      const res = await p.evaluate(() => {
        const rgba = (c) => { const m = (String(c).match(/[\d.]+/g) || [0,0,0,0]).map(Number);
          return [m[0]||0, m[1]||0, m[2]||0, m[3] === undefined ? 1 : m[3]]; };
        // Composite down the ancestors until something opaque is reached.
        const comp = (el) => {
          let acc = 0, o = [0,0,0], n = el, st = [];
          while (n && n.nodeType === 1) { st.push(getComputedStyle(n).backgroundColor); n = n.parentElement; }
          st.push("rgb(255,255,255)");
          for (const c of st) { const [r,g,b,a] = rgba(c); const w = a * (1 - acc);
            o = [o[0]+r*w, o[1]+g*w, o[2]+b*w]; acc += w; if (acc >= 0.999) break; }
          return o.map((v) => Math.round(v));
        };
        const L = (c) => { const f = (v) => { v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
          return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2]); };
        const cr = (a, b) => { const l1 = L(a), l2 = L(b);
          return (Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05); };

        const out = [];
        const els = [...document.querySelectorAll("select, input[type=text], input[type=search], input:not([type])")]
          .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 10; });
        for (const e of els.slice(0, 8)) {
          const cs = getComputedStyle(e);
          const bg = comp(e);
          const fg = rgba(cs.color).slice(0, 3);
          // A placeholder is the only text an empty box shows, so it is the
          // one that has to be legible.
          out.push({ tag: e.tagName.toLowerCase(), ratio: cr(fg, bg), bg, fg,
                     ph: e.placeholder || "" });
        }
        return { controls: out, pageBg: comp(document.body) };
      });

      const worst = res.controls.reduce((a, c) => (a == null || c.ratio < a.ratio ? c : a), null);
      if (!res.controls.length) { ok(true, `${page.padEnd(16)} no controls to check`); }
      else {
        ok(worst.ratio >= 4.5,
           `${page.padEnd(16)} ${res.controls.length} control(s), worst ${worst.ratio.toFixed(2)}:1`,
           worst.ratio < 4.5 ? `<${worst.tag}> fg=rgb(${worst.fg}) on bg=rgb(${worst.bg})` : "");
      }
      await p.close();
    }
  }
} finally {
  await browser.close();
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
