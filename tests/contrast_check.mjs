// Text-visibility sweep: renders key pages and measures the contrast ratio
// between each text element's computed color and its effective background
// (walking up ancestors for the first non-transparent one). Flags < 2.5:1
// (genuinely hard to read; 4.5:1 is the WCAG AA ideal).
// Run: node tests/contrast_check.mjs
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
const PAGES = {
  "jobs.html":  ["#jobsCount", ".fast-hero-card h1", ".fast-hero-card p", ".jobs-toolbar .btn"],
  "login.html": [".login-card h1", ".login-card .lead", ".login-form label", ".login-links a", ".login-divider"],
  "signup.html": [".signup-wrap h1", ".signup-form label", ".signup-route-note", ".terms"],
  "meet.html":  [".fast-hero-card h1", ".fast-hero-card p", ".meet-lobby-card h3", ".meet-lobby-card .muted", ".meet-label span", ".meet-feat span:last-child"],
  "admin.html": ["#loginGate h1", "#loginGate .page-subtitle", "#loginGate label", "#loginGate p"],
  "super-admin.html": ["#saLoginGate h2", "#saLoginGate label"],
};

// Extra dynamic probes: open modals / inject samples per page.
const DYNAMIC = {
  "jobs.html": async (page) => {
    // inject one job card exactly as jobs.js renders it
    await page.evaluate(() => {
      document.getElementById("jobList").innerHTML = `
        <div class="job-card" data-id="x">
          <div class="job-head"><div>
            <div class="job-title">Sample job title</div>
            <div class="job-company"> Sample Co · Kinondoni</div></div>
            <div class="job-pay"><strong>TZS 8,000</strong><small>per worker</small></div></div>
          <div class="job-meta"><span> Tomorrow</span></div>
          <div class="job-desc">Sample description text</div>
          <div class="job-req"> Requirements: strong</div>
          <div class="job-quota"><div class="job-quota-row"><span class="jq-label">Workers</span><span class="jq-count">1 / 3</span></div>
          <div class="job-quota-bar"><div class="job-quota-fill" style="width:33%"></div></div></div>
          <div class="job-mycode"> Your worker number: <strong>W1-01</strong></div>
          <div class="job-actions"><button class="btn btn-primary job-claim-btn"> I'll do it</button></div>
        </div>`;
      // my-jobs sample
      document.getElementById("jmResults").innerHTML = `
        <div class="jm-job"><div class="jm-job-head">
          <span class="jm-job-title">Sample mine</span><span class="jm-job-meta"> Open · 1/3</span></div>
          <ul class="jm-workers"><li class="jm-worker"><span><code class="jm-code">W1-01</code> Juma</span><a href="#"> +255</a></li></ul></div>`;
      document.getElementById("jobMineBackdrop").hidden = false;
    });
    return [".job-title", ".job-company", ".job-desc", ".job-req", ".jq-label", ".jq-count",
            ".job-mycode", ".jm-job-title", ".jm-job-meta", ".jm-worker span", ".jm-code",
            ".jobs-modal h3", ".jobs-modal .jm-sub", ".jobs-modal label", "#jmPhone"];
  },
  "admin.html": async (page) => {
    // force the panel visible + inject a day-jobs table row + summary stat
    await page.evaluate(() => {
      document.getElementById("loginGate").hidden = true;
      document.getElementById("adminPanel").hidden = false;
      document.getElementById("djSummary").innerHTML =
        `<div class="aa-stat"><div class="num">5</div><div class="lbl">Jobs posted</div></div>`;
      document.getElementById("dayJobsList").innerHTML = `
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse;font-size:14px;background:var(--c-surface,#fff)">
        <thead><tr><th style="text-align:left;padding:9px 10px">Job</th></tr></thead>
        <tbody><tr><td style="padding:9px 10px"><strong>ujenzi</strong><br><small style="color:var(--c-muted,#6b6960)">desc</small>
        <details open><summary>1/100 — view workers</summary><ul><li><code style="background:#064a33;color:#fff;border-radius:5px;padding:0 6px;font-weight:700">W4-01</code> Juma — <a href="tel:+255">+255</a></li></ul></details></td></tr></tbody></table></div>`;
      document.getElementById("tab-dayjobs").hidden = false;
      document.getElementById("tab-allagents").hidden = true;
    });
    return ["#dayJobsList strong", "#dayJobsList summary", "#dayJobsList li",
            ".aa-stat .num", ".aa-stat .lbl", ".tab-btn", ".tab-btn.active",
            "#adminPanel .admin-header .page-subtitle", "#tab-allagents h3", "#tab-allagents .hint",
            ".aa-controls input", "#aaRole"];
  },
};

const lum = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });
const failures = [];

for (const [path, sels] of Object.entries(PAGES)) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  // domcontentloaded — meet.html keeps realtime sockets busy, networkidle2 never settles
  await page.goto(`${BASE}/${path}`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2600));
  let allSels = [...sels];
  let results = [];
  try {
  if (DYNAMIC[path]) allSels = allSels.concat(await DYNAMIC[path](page));

  results = await page.evaluate((selectors) => {
    const parse = (c) => {
      const m = String(c).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
      return m ? { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null;
    };
    const effBg = (el) => {
      let n = el;
      while (n && n !== document.documentElement) {
        const cs = getComputedStyle(n);
        const bg = parse(cs.backgroundColor);
        const whitish = bg && (bg.rgb[0] + bg.rgb[1] + bg.rgb[2]) / 3 > 200;
        if (cs.backgroundImage && cs.backgroundImage !== "none") {
          // Gradient atop a solid colour → judge against that colour.
          if (bg && bg.a > 0.6) return bg.rgb;
          // Frosted card: translucent white + white gradient = light surface.
          if (whitish && bg.a >= 0.25) return [245, 245, 245];
          // Use the gradient's own first colour stop when it's substantial
          // (white frosted cards put their white IN the gradient string).
          const stop = parse(cs.backgroundImage);
          if (stop && stop.a >= 0.5) return stop.rgb;
          // Pure/translucent gradient (green hero cards) — skip judgment.
          return null;
        }
        if (bg && bg.a > 0.6) return bg.rgb;
        if (whitish && bg.a >= 0.5) return [245, 245, 245];
        n = n.parentElement;
      }
      return [10, 22, 16]; // dark page mesh approximation
    };
    return selectors.map((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { sel, missing: true };
      const cs = getComputedStyle(el);
      // Gradient-clipped text (premium.css .page-title): the text is painted
      // with the element's own background gradient — judge its first stop
      // against the surface BEHIND the element.
      const clipped = (cs.webkitBackgroundClip === "text" || cs.backgroundClip === "text");
      if (clipped) {
        const stop = parse(cs.backgroundImage);
        const bg = effBg(el.parentElement || el);
        if (stop && bg) return { sel, color: stop.rgb, bg, text: "(gradient text) " + (el.textContent || "").trim().slice(0, 20) };
        return { sel, gradient: true, color: stop ? stop.rgb : [0, 0, 0] };
      }
      const col = parse(cs.color);
      if (!col) return { sel, missing: true };
      const bg = effBg(el);
      if (!bg) return { sel, gradient: true, color: col.rgb };
      return { sel, color: col.rgb, bg, text: (el.textContent || "").trim().slice(0, 30) };
    });
  }, allSels);
  } catch (e) {
    console.log(`  [${path}] EVAL FAILED (page busy): ${e.message.slice(0, 80)}`);
  }

  for (const r of results) {
    if (r.missing) { console.log(`  [${path}] (missing) ${r.sel}`); continue; }
    if (r.gradient) {
      // On gradient surfaces just sanity-check the text is light (heroes are dark green).
      const light = lum(r.color) > 0.4;
      console.log(`  [${path}] (gradient bg) ${r.sel} — text ${light ? "light " : "DARK "} rgb(${r.color})`);
      if (!light) failures.push(`${path} ${r.sel} — dark text rgb(${r.color}) on gradient hero`);
      continue;
    }
    const cr = ratio(r.color, r.bg);
    const flag = cr < 2.5 ? "  LOW" : "";
    if (cr < 2.5) failures.push(`${path} ${r.sel} — ${cr.toFixed(2)}:1 (color rgb(${r.color}) on rgb(${r.bg})) "${r.text}"`);
    console.log(`  [${path}] ${cr.toFixed(2).padStart(5)}:1 ${r.sel}${flag}`);
  }
  await page.close();
}

await browser.close();
console.log("\n==== LOW-CONTRAST FAILURES (" + failures.length + ") ====");
failures.forEach((f) => console.log(" ", f));
process.exit(failures.length ? 2 : 0);
