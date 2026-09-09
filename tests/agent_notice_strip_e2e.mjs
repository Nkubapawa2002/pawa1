// ============================================================================
// agent_notice_strip_e2e.mjs — the one number this redesign is about.
//
//   THE DASHBOARD IS THE SAME HEIGHT FOR ONE NOTICE OR FOR NINE.
//
// Eight writers used to stack banners at the top of an agent dashboard and
// nothing capped the total, so how far an agent had to scroll to reach their
// own listings depended on how bad a week they were having. This asserts the
// property that replaced that, in a real browser, because it is a layout claim
// and layout claims cannot be checked any other way:
//
//   0 notices  -> exactly 0 pixels, margin included
//   1, 3, 9    -> identical
//   4 words of body vs 400 characters -> identical
//   both themes, both languages        -> identical within each
//
// Plus the pager's contract: absent at one notice, disabled at the ends, and
// focus staying on the arrow so it can be pressed twice.
//
// It drives the strip through its own API rather than through a session, so it
// needs no account and no Supabase. See the browser-test recipe: the OPTIONS
// preflight is answered first or the page hangs with no error at all.
//
//   usage:  node server.js   then:  node tests/agent_notice_strip_e2e.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};

const PORTALS = [
  { page: "agent-houses.html",   gate: "ahAuthCard", dash: "ahDashboard", form: "ahFormSection", host: "ahWarn" },
  { page: "agent-services.html", gate: "asAuthCard", dash: "asDashboard", form: "asFormSection", host: "asWarn" },
  { page: "agent-trucks.html",   gate: "atAuthCard", dash: "atDashboard", form: "atFormSection", host: "atWarn" },
];

async function openDash(browser, portal, { theme = "dark", lang = "en" } = {}) {
  const p = await browser.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  p.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });

  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await p.setRequestInterception(true);
  p.on("request", (req) => {
    // The preflight FIRST. An unanswered OPTIONS produces no error, no timeout
    // and no clue: the page simply never finishes loading.
    if (req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*",
        "access-control-allow-methods": "*" } });
    }
    if (/supabase\.co|locationiq|maptiler|mapbox|tile|fonts\.(googleapis|gstatic)|overpass|osrm|valhalla|nominatim/i.test(req.url())) {
      return req.respond({ status: 200,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: "[]" });
    }
    req.continue();
  });
  // Cleared before the first script runs: data.js reads its cache during boot.
  await p.evaluateOnNewDocument((l) => {
    try { localStorage.clear(); localStorage.setItem("pawa-lang", l); } catch (e) {}
  }, lang);

  await p.goto(`${BASE}/${portal.page}`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  await new Promise((r) => setTimeout(r, 1800));

  // The gate hides everything interesting. Flip the real ids rather than
  // walking the DOM for hidden things, which races the page's own routing.
  await p.evaluate((g, d, f) => {
    document.getElementById(g)?.setAttribute("hidden", "");
    const form = document.getElementById(f); if (form) form.hidden = true;
    const dash = document.getElementById(d); if (dash) dash.hidden = false;
  }, portal.gate, portal.dash, portal.form);
  await new Promise((r) => setTimeout(r, 300));
  return { p, errs };
}

/** Mount the strip and return a measuring function bound to the page. */
async function harness(p, hostId) {
  await p.evaluate((h) => {
    window.__h = window.AgentNoticeStrip.mount({ into: document.getElementById(h) });
    window.__mk = (i, sev, title, body, extra) => Object.assign({
      id: "n" + i, source: "admin", severity: sev, title, body,
      at: new Date(Date.now() - i * 1000).toISOString(),
    }, extra || {});
  }, hostId);
  return {
    set: (js) => p.evaluate(new Function("return " + js)()),
    height: () => p.evaluate((h) => {
      const el = document.getElementById(h);
      const r = el.getBoundingClientRect();
      // Round to whole pixels: sub-pixel noise is not a layout jump.
      return Math.round(r.height);
    }, hostId),
  };
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
try {
  // =====================================================================
  process.stdout.write("\n1. Height does not depend on how many notices arrived\n");
  // =====================================================================
  {
    const { p, errs } = await openDash(browser, PORTALS[0]);
    await harness(p, "ahWarn");
    const H = () => p.evaluate(() => Math.round(document.getElementById("ahWarn").getBoundingClientRect().height));
    const put = (n) => p.evaluate((k) => {
      window.__h.set("admin", Array.from({ length: k }, (_, i) =>
        window.__mk(i, "info", "Notice " + i, "A body for notice " + i)));
    }, n);

    await put(0);
    const zero = await H();
    ok(zero === 0, "no notices costs exactly zero pixels, margin included", "got " + zero);

    await put(1); const h1 = await H();
    await put(3); const h3 = await H();
    await put(9); const h9 = await H();
    ok(h1 > 0, "one notice draws something", "got " + h1);
    ok(h1 === h3 && h3 === h9,
       "one, three and nine notices are all the same height",
       `1=${h1} 3=${h3} 9=${h9}`);

    await put(0);
    ok((await H()) === 0, "and it returns to zero when they are cleared");

    // Content length must not move it either: that is what the clamps are for.
    await p.evaluate(() => window.__h.set("admin", [window.__mk(1, "info", "Short", "Four words only here")]));
    const short = await H();
    await p.evaluate(() => window.__h.set("admin", [window.__mk(1, "info",
      "A headline long enough that it would wrap onto a second line if it could",
      "x".repeat(400))]));
    const long = await H();
    await p.evaluate(() => window.__h.set("admin", [window.__mk(1, "info", "No body", "")]));
    const none = await H();
    ok(short === long && long === none,
       "a four word notice, a 400 character one and one with no body are the same height",
       `short=${short} long=${long} noBody=${none}`);

    ok(errs.length === 0, "no page errors", errs.join(" | "));
    await p.close();
  }

  // =====================================================================
  process.stdout.write("\n2. The pager\n");
  // =====================================================================
  {
    const { p } = await openDash(browser, PORTALS[0]);
    await harness(p, "ahWarn");

    await p.evaluate(() => window.__h.set("admin", [window.__mk(1, "info", "Only one", "b")]));
    ok(await p.evaluate(() => !document.querySelector(".anx-page")),
       "at one notice the pager is absent from the DOM, not merely hidden");

    await p.evaluate(() => window.__h.set("admin", [
      window.__mk(1, "info", "First", "b"), window.__mk(2, "info", "Second", "b")]));
    ok(await p.evaluate(() => !!document.querySelector(".anx-page")), "at two it appears");
    ok(await p.evaluate(() => document.querySelector("[data-anx=prev]").disabled),
       "the back arrow is disabled at the start rather than wrapping");
    ok(await p.evaluate(() => !document.querySelector("[data-anx=next]").disabled),
       "and the forward arrow is live");

    await p.evaluate(() => document.querySelector("[data-anx=next]").focus());
    await p.click("[data-anx=next]");
    await new Promise((r) => setTimeout(r, 100));
    ok(await p.evaluate(() => document.querySelector(".anx-count").textContent === "2/2"),
       "pressing it moves to the second notice",
       await p.evaluate(() => document.querySelector(".anx-count")?.textContent));
    ok(await p.evaluate(() => document.querySelector("[data-anx=next]").disabled),
       "which disables the forward arrow at the end");
    ok(await p.evaluate(() => /2 of 2/.test(document.querySelector(".anx-say").textContent)),
       "and the position is announced, not only drawn",
       await p.evaluate(() => document.querySelector(".anx-say").textContent));

    // A blocking notice arriving must take the screen from wherever the reader is.
    await p.evaluate(() => window.__h.set("sub", [window.__mk(9, "blocking", "Account paused", "b")]));
    ok(await p.evaluate(() => document.querySelector(".anx-title").textContent === "Account paused"),
       "a blocking notice arriving takes the screen from a reader mid-list");
    // ...but only once: after that the pager has to keep working.
    await p.click("[data-anx=next]");
    await new Promise((r) => setTimeout(r, 100));
    ok(await p.evaluate(() => document.querySelector(".anx-title").textContent !== "Account paused"),
       "and it does not drag them back on the next render, which would be a pager that cannot page");

    await p.close();
  }

  // =====================================================================
  process.stdout.write("\n3. Both themes, both languages, all three portals\n");
  // =====================================================================
  {
    const seen = {};
    for (const portal of PORTALS) {
      for (const theme of ["dark", "light"]) {
        for (const lang of ["en", "sw"]) {
          const { p, errs } = await openDash(browser, portal, { theme, lang });
          await harness(p, portal.host);
          const H = () => p.evaluate((h) => Math.round(document.getElementById(h).getBoundingClientRect().height), portal.host);
          await p.evaluate(() => window.__h.set("admin", [window.__mk(1, "warn", "One", "b")]));
          const one = await H();
          await p.evaluate(() => window.__h.set("admin", Array.from({ length: 9 },
            (_, i) => window.__mk(i, "warn", "N" + i, "b" + i))));
          const nine = await H();
          const key = `${portal.page} ${theme}/${lang}`;
          seen[key] = [one, nine];
          ok(one === nine && one > 0, `same height for 1 and 9 on ${key}`, `1=${one} 9=${nine}`);
          ok(errs.length === 0, `no errors on ${key}`, errs.join(" | "));
          await p.close();
        }
      }
    }
    // Not asserting equal heights ACROSS languages: Swahili wraps differently
    // and a different but stable height is correct. The claim is that within
    // one language and theme, the count does not matter.
    process.stdout.write("        " + Object.entries(seen)
      .map(([k, v]) => k + "=" + v[0]).join("\n        ") + "\n");
  }
} finally {
  await browser.close();
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
