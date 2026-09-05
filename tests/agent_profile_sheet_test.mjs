// ============================================================================
//  agent_profile_sheet_test.mjs — the operating-area sheet: can it be left,
//  and does it speak Swahili?
//
//  WHY THIS EXISTS
//  This sheet is the first thing an agent sees after signing in to any of the
//  three dashboards, and for a long time it had exactly one way out: a save
//  that succeeded. A refused answer, an offline phone or a rejected write left
//  the caller's promise pending forever under a backdrop nothing could
//  dismiss, and the dashboard behind it never finished building. Nothing had
//  failed loudly, so there was no error on screen to explain any of it.
//
//  The first half of this file therefore leaves the sheet three different ways
//  and checks the same four things each time: the sheet goes, the page scrolls
//  again, ensure() actually resolves, and the dashboard behind it works.
//
//  The second half is the reason i18n_coverage.mjs cannot cover this. That
//  scan reads what is on a page; this sheet is injected by JavaScript, only
//  for a signed-in agent who has no profile row yet, and the scan is neither.
//  Half its copy sat in hardcoded English through every green run of that
//  test. Here the sheet is opened directly, in Swahili, and read back.
//
//  Run: node tests/agent_profile_sheet_test.mjs   (needs `node server.js` up)
// ============================================================================
import puppeteer from "puppeteer";

const BASE = process.env.PAWA_BASE || "http://localhost:8080";

let pass = 0;
const fails = [];
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); return; }
  fails.push(detail ? msg + "\n        " + detail : msg);
  console.log("  FAIL  " + msg + (detail ? "\n        " + detail : ""));
};

// English that must not survive a switch to Swahili. Every one of these was on
// the sheet in English before this pass. They are phrases, not single words,
// so a Swahili sentence cannot match one by accident.
const ENGLISH = [
  "Your operating area", "Where do you operate?",
  "Tell us the region you belong to", "This is how customers find you",
  "Area of operations", "Type your region",
  "Start typing and pick from the list",
  "Your contact (optional)", "About your work (optional)",
  "Your name", "What you do, how long you have done it",
  "Save & continue", "Not now, take me to my listings",
  "Wards you work in", "Districts you work in",
];

/**
 * A dashboard page with a signed-in agent behind it and an empty database, so
 * the sheet is guaranteed to open. Everything above the Supabase client runs
 * exactly as it does in production.
 *
 * One browser per case, deliberately. Sharing one across the four cases fails
 * on this host every time, at a different case each run: a protocol call to
 * the second or third page simply never comes back. Nothing about the sheet
 * changes between cases, so the shared browser is the variable, and a fresh
 * one per case costs a few seconds and removes it.
 */
async function attempt(lang) {
  const browser = await puppeteer.launch({
    headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
  });
  const page = await browser.newPage();
  const errs = [];
  // The stub blocks every CDN so the fake Supabase client survives the page
  // loading the real one. That also takes maplibre and leaflet down with it,
  // and the map code then throws. Those throws belong to this harness, not to
  // the sheet, so they are named here rather than silently swallowed.
  const HARNESS_NOISE = /maplibregl|\bL is not defined|mapboxgl|leaflet/i;
  page.on("pageerror", (e) => {
    const line = String(e).split("\n")[0];
    if (!HARNESS_NOISE.test(line)) errs.push(line);
  });
  await page.setViewport({ width: 390, height: 1400 });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*",
        "access-control-allow-methods": "*" } });
    }
    if (/supabase\.co|locationiq|maptiler|mapbox|tile|openstreetmap|arcgisonline|cartocdn|overpass|nominatim|jsdelivr|unpkg|esm.sh|fonts\.(googleapis|gstatic)/i.test(req.url())) {
      return req.respond({ status: 200, headers: {
        "content-type": "application/json", "access-control-allow-origin": "*" }, body: "[]" });
    }
    req.continue();
  });

  await page.evaluateOnNewDocument((l) => {
    try { localStorage.clear(); localStorage.setItem("lang", l); } catch (_) {}
    const USER = { id: "00000000-0000-4000-8000-000000000001", email: "agent@example.com" };
    const SESSION = { user: USER, access_token: "stub" };
    // Every query resolves empty, which is what "this agent has no profile
    // and no listings" looks like over the wire.
    function builder() {
      const res = Promise.resolve({ data: [], error: null, count: 0 });
      return new Proxy(res, { get(t, k) {
        if (k === "then" || k === "catch" || k === "finally") return t[k].bind(t);
        return () => builder();
      } });
    }
    window.supabase = { createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: SESSION }, error: null }),
        getUser: async () => ({ data: { user: USER }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signOut: async () => ({ error: null }),
      },
      from: () => builder(), rpc: () => builder(),
      storage: { from: () => ({
        upload: async () => ({ data: {}, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "" } }),
        remove: async () => ({ error: null }) }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      removeChannel: () => {},
    }) };
  }, lang);

  try {
    await page.goto(BASE + "/agent-houses.html", { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
  await new Promise((r) => setTimeout(r, 3500));
  return { browser, page, errs };
}

/**
 * The same, retried. Navigation on this host drops for no reason several times
 * an hour, and once a browser has done that it does not recover: retrying the
 * goto on the same page times out again every time. So a retry throws the
 * whole browser away and starts over, which does recover.
 */
async function open(lang) {
  let last = null;
  for (let i = 0; i < 3; i++) {
    try { return await attempt(lang); } catch (e) { last = e; }
  }
  throw new Error("could not open the dashboard after 3 tries: " +
                  String(last && last.message || last).split(/\r?\n/)[0]);
}

// ---------------------------------------------------------------------------
// 1. Every exit settles, and leaves a working page behind
// ---------------------------------------------------------------------------
console.log("\n1. The sheet can always be left");

for (const exit of ["escape", "button", "backdrop"]) {
  const { browser, page, errs } = await open("en");

  const shown = await page.evaluate(() => !!document.getElementById("agentProfileModal"));

  // Call ensure() ourselves and watch the promise, because the page no longer
  // awaits routeOnAuth() and so cannot tell us whether it settled. A sheet
  // that closes without resolving is the exact bug this file is about, and
  // from the outside it looks identical to one that closed properly.
  await page.evaluate(() => {
    window.__settled = false;
    const sb = window.supabase.createClient();
    window.AgentProfile.ensure(sb).then(() => { window.__settled = true; },
                                        () => { window.__settled = true; });
  });
  await new Promise((r) => setTimeout(r, 400));

  if (exit === "escape") await page.keyboard.press("Escape");
  if (exit === "button") await page.evaluate(() => document.getElementById("apfLater").click());
  if (exit === "backdrop") await page.evaluate(() => {
    document.getElementById("agentProfileModal")
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 900));

  const gone = await page.evaluate(() => !document.getElementById("agentProfileModal"));
  const overflow = await page.evaluate(() => document.body.style.overflow);
  const settled = await page.evaluate(() => window.__settled);

  await page.evaluate(() => document.getElementById("ahNewBtn").click());
  await new Promise((r) => setTimeout(r, 1500));
  const opened = await page.evaluate(() => !document.getElementById("ahFormSection").hidden);

  ok(shown, exit + ": the sheet opens for an agent with no profile");
  ok(gone, exit + ": and closes");
  ok(overflow !== "hidden", exit + ": the page scrolls again",
     'body.style.overflow = "' + overflow + '"');
  ok(settled, exit + ": ensure() resolves rather than hanging forever");
  ok(opened, exit + ": and the dashboard behind it still opens the listing form");
  ok(errs.length === 0, exit + ": no page errors", errs.join("\n        "));
  await browser.close();
}

// ---------------------------------------------------------------------------
// 2. The sheet speaks Swahili
// ---------------------------------------------------------------------------
console.log("\n2. Every word on the sheet is translated");

{
  const { browser, page, errs } = await open("sw");
  const sheet = await page.evaluate(() => {
    const m = document.getElementById("agentProfileModal");
    if (!m) return null;
    const ph = [...m.querySelectorAll("[placeholder]")].map((el) => el.placeholder);
    return { text: m.innerText, placeholders: ph };
  });

  ok(sheet, "the sheet is on screen in Swahili");
  if (sheet) {
    const haystack = sheet.text + "\n" + sheet.placeholders.join("\n");
    const leaked = ENGLISH.filter((s) => haystack.includes(s));
    ok(leaked.length === 0, "no English phrase survives the switch",
       leaked.map((s) => 'still English: "' + s + '"').join("\n        "));
    ok(sheet.placeholders.length >= 5 && sheet.placeholders.every((p) => p.trim()),
       "every input still has a placeholder, in Swahili",
       JSON.stringify(sheet.placeholders));
    // A missing key renders as the key itself, which reads like copy to a scan
    // looking for English and is caught only by its shape.
    const rawKeys = haystack.match(/\bap_[a-z_]+\b/g) || [];
    ok(rawKeys.length === 0, "no key leaked through as its own name",
       [...new Set(rawKeys)].join(", "));
    ok(errs.length === 0, "no page errors", errs.join("\n        "));
  }
  await browser.close();
}

console.log("\n" + pass + " passed, " + fails.length + " failed");
if (fails.length) {
  console.log("\nFailures:\n  " + fails.join("\n  ") + "\n");
  process.exit(1);
}
