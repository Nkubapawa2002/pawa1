// ============================================================================
// pchat_page_test.mjs — the P-Chat tab, in a real browser.
//
// P-Chat owns no engine: every row is a doorway to a page or modal that
// already exists. So what is worth testing is exactly that — the doors are
// there, they are distinct, they lead somewhere real, they carry both
// languages, and the one row that opens a shared modal really opens it rather
// than reimplementing it.
//
//   usage:  node server.js      then, in another shell:
//           node tests/pchat_page_test.mjs
// ============================================================================
import puppeteer from "puppeteer";
import { existsSync } from "node:fs";

const BASE = "http://localhost:8080";

// Every destination the tab promises, in the order it presents them.
const EXPECTED = [
  { kind: "modal", id: "pcRequestBtn", label: "Tell us what you want" },
  { kind: "link", href: "houses.html?life=1&from=pchat", label: "Match homes to my life" },
  { kind: "link", href: "houses.html?alert=1&from=pchat", label: "Alert me about an area" },
  { kind: "link", href: "near-me.html?from=pchat", label: "Scan areas and services near you" },
  { kind: "link", href: "frame.html?from=pchat", label: "Read any area as a room for business" },
  // One row, not two. "Share my live location" (?live=1) and "Meet & Locate"
  // were the same feature behind two cards: both opened meet.html, and ?live=1
  // only put a focus ring on a button inside that same lobby. The lobby leads
  // with sharing now, so the row that survives is the page itself.
  { kind: "link", href: "meet.html?from=pchat", label: "Meet & Locate" },
  { kind: "link", href: "share-location.html?from=pchat", label: "Share a location" },
  { kind: "link", href: "jobs.html?from=pchat", label: "Jobs and staff" },
];

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
const SUPABASE_STUB = `window.supabase = { createClient: function () {
  var noSession = function () { return Promise.resolve({ data: { session: null, user: null }, error: null }); };
  function builder() { var b = {};
    ["select","eq","neq","gt","gte","lt","lte","in","is","or","filter","order","limit","range","match"]
      .forEach(function (m) { b[m] = function () { return b; }; });
    b.then = function (r, j) { return Promise.resolve({ data: [], error: null }).then(r, j); };
    return b; }
  return { from: builder, rpc: function () { return Promise.resolve({ data: [], error: null }); },
    auth: { getSession: noSession, getUser: noSession, signOut: noSession,
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; } },
    storage: { from: function () { return { getPublicUrl: function () { return { data: { publicUrl: "" } }; } }; } },
    channel: function () { return { on: function () { return this; }, subscribe: function () { return this; } }; },
    removeChannel: function () {} };
} };`;

const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
});
try {
  const open = async (lang, path = "/p-chat.html", settle = 1200) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 1 });
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = req.url();
      if (req.method() === "OPTIONS") {
        return req.respond({ status: 204, headers: {
          "access-control-allow-origin": "*", "access-control-allow-headers": "*",
          "access-control-allow-methods": "*" } });
      }
      if (/cdn\.jsdelivr\.net.*supabase/.test(url)) {
        return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: SUPABASE_STUB });
      }
      if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)) {
        return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
      }
      if (/arcgisonline|basemaps\.cartocdn|api\.mapbox|tile\.openstreetmap|supabase\.co\/storage/.test(url)) {
        return req.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
      }
      if (/supabase\.co|nominatim|router\.project-osrm/.test(url)) {
        return req.respond({ status: 200, headers: {
          "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
      }
      req.continue();
    });
    if (lang) await page.evaluateOnNewDocument((l) => { try { localStorage.setItem("lang", l); } catch (_) {} }, lang);
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise((r) => setTimeout(r, settle));
    return { page, errs };
  };

  process.stdout.write("\n1. Every door is on the page\n");
  const { page, errs } = await open(null);

  const rows = await page.$$eval(".ha-find-card", (n) => n.map((c) => ({
    tag: c.tagName.toLowerCase(),
    href: c.getAttribute("href") || "",
    id: c.id || "",
    title: (c.querySelector(".ha-find-t") || {}).textContent || "",
    desc: ((c.querySelector(".ha-find-d") || {}).textContent || "").trim(),
  })));
  ok(rows.length === EXPECTED.length,
     `all ${EXPECTED.length} tools are present (found ${rows.length})`,
     rows.map((r) => r.title).join(" / "));

  EXPECTED.forEach((want, i) => {
    const got = rows[i] || {};
    const hit = want.kind === "modal"
      ? got.id === want.id && got.tag === "button"
      : got.href === want.href;
    ok(hit, `row ${i + 1} is "${want.label}" → ${want.href || want.id}`,
       `got ${got.tag} href="${got.href}" id="${got.id}" title="${got.title}"`);
  });

  ok(rows.every((r) => r.title.trim() && r.desc), "every row explains itself in a sentence",
     rows.filter((r) => !r.desc).map((r) => r.title).join(","));

  process.stdout.write("\n2. No door leads to the same place twice\n");
  const dests = rows.map((r) => r.href || r.id).filter(Boolean);
  ok(new Set(dests).size === dests.length, "no destination repeats inside the tab", dests.join(" "));
  const localHrefs = await page.$$eval("a[href$='.html'], a[href*='.html?']",
    (n) => n.map((a) => a.getAttribute("href")));
  ok(new Set(localHrefs).size === localHrefs.length,
     "no destination repeats anywhere on the page, secondary links included", localHrefs.join(" "));

  process.stdout.write("\n3. The doors lead somewhere real\n");
  for (const href of [...new Set(localHrefs)]) {
    const file = href.split("?")[0];
    ok(existsSync(file), `${file} exists in the repo`);
  }

  process.stdout.write("\n4. It is the P-Chat tab, and it is lit\n");
  const tabs = await page.$$eval(".app-tabbar a", (n) => n.map((a) => ({
    label: a.textContent.trim(), href: a.getAttribute("href"), active: a.classList.contains("active"),
  })));
  ok(tabs.length === 5, `the bar still has five tabs (${tabs.length})`, JSON.stringify(tabs));
  const pchat = tabs.find((t) => t.href === "p-chat.html");
  ok(!!pchat && pchat.label === "P-Chat", "the third tab reads P-Chat", JSON.stringify(tabs.map((t) => t.label)));
  ok(!!pchat && pchat.active, "and it is the active one while on this page");
  ok(!tabs.some((t) => t.label === "Saved"), "the Saved tab is gone from the bar");

  process.stdout.write("\n5. The shared request modal, not a second copy\n");
  await page.click("#pcRequestBtn");
  await new Promise((r) => setTimeout(r, 700));
  ok(await page.$(".rp-back") !== null,
     "\"Tell us what you want\" opens js/lib/request-place.js — the same modal the homepage opens");
  await page.evaluate(() => document.querySelector(".rp-back")?.remove());

  await page.click("#pcMineBtn");
  await new Promise((r) => setTimeout(r, 700));
  ok(await page.$(".rp-back") !== null, "\"My requests\" opens the same library's list view");
  await page.evaluate(() => document.querySelector(".rp-back")?.remove());

  ok(errs.length === 0, "no page errors", errs.slice(0, 4).join("\n        "));
  await page.close();

  process.stdout.write("\n6. Swahili\n");
  const sw = await open("sw");
  const swText = await sw.page.$$eval(".ha-find-t, .ha-find-d, .pc-group-h, .pc-sub, .pc-more",
    (n) => n.map((e) => e.textContent.trim()));
  ok(swText.length > 0 && !swText.some((s) => /^(pc_|home_|meet_|tab_)/.test(s)),
     "every string resolves — no raw i18n keys leak through",
     swText.filter((s) => /^(pc_|home_|meet_|tab_)/.test(s)).join(","));
  const swTitles = await sw.page.$$eval(".ha-find-t", (n) => n.map((e) => e.textContent.trim()));
  ok(swTitles.some((s) => /Kazi na wafanyakazi|Shiriki mahali/.test(s)),
     "the new rows are actually translated, not just present", swTitles.join(" / "));
  ok(sw.errs.length === 0, "no page errors in Swahili", sw.errs.slice(0, 4).join("\n        "));
  await sw.page.close();

  // -- The boundary --------------------------------------------------------
  //  Explore owns the catalogue; P-Chat owns the errands. near-me, area,
  //  frame, jobs and houses' ?life= / ?alert= modes are BOTH -- reached from
  //  either tab. They stay shared pages, never copies, so the only thing that
  //  may differ between the two visits is which tab stays lit. Resolving that
  //  by filename alone handed you to Explore the moment you tapped a P-Chat
  //  row; these two sections pin down both halves of the fix.
  const litTab = (p) => p.$$eval(".app-tabbar a.active span",
    (n) => (n[0] ? n[0].textContent.trim() : ""));

  process.stdout.write("\n7. An errand started in P-Chat stays in P-Chat\n");
  for (const href of [
    "houses.html?life=1&from=pchat",
    "houses.html?alert=1&from=pchat",
    "houses.html?request=1&from=pchat",
    "near-me.html?from=pchat",
    "area.html?from=pchat",
    "frame.html?from=pchat",
    "meet.html?live=1&from=pchat",
    "meet.html?from=pchat",
    "share-location.html?from=pchat",
    "jobs.html?from=pchat",
  ]) {
    const t = await open("en", "/" + href, 1800);
    const lit = await litTab(t.page);
    ok(lit === "P-Chat", `${href} keeps P-Chat lit`, `lit: ${lit || "no tab lit"}`);
    await t.page.close();
  }

  process.stdout.write("\n8. The same pages reached any other way are unchanged\n");
  for (const [href, owner] of [
    ["houses.html", "Explore"],
    ["near-me.html", "Explore"],
    ["area.html", "Explore"],
    ["frame.html", "Explore"],
    ["jobs.html", "Explore"],
    ["explore.html", "Explore"],
    ["meet.html", "P-Message"],
    // P-Chat is the only tab that leads here, so it owns the page outright.
    ["share-location.html", "P-Chat"],
  ]) {
    const t = await open("en", "/" + href, 1800);
    const lit = await litTab(t.page);
    ok(lit === owner, `${href} on its own still lights ${owner}`, `lit: ${lit || "no tab lit"}`);
    await t.page.close();
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
} finally {
  await browser.close();
}
process.exit(fail === 0 ? 0 : 1);
