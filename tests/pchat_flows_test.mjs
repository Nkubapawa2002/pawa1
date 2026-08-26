// ============================================================================
// pchat_flows_test.mjs — the seven P-Chat destinations, exercised as flows.
//
// pchat_page_test.mjs proves the seven DOORS exist and are distinct. This file
// walks THROUGH them: it opens each destination the tab promises and holds it
// to the things that decide whether a tool is usable on a phone, in a hurry,
// by someone who is not sure what they are doing —
//
//   · a dialog you can get out of (Escape, backdrop, and the button)
//   · focus that goes into it and comes back to where it started
//   · the page behind it not scrolling away underneath
//   · one dialog, however many times the button is pressed
//   · tap targets a thumb can hit
//   · inputs that refuse impossible answers before the network sees them
//   · failures that say something a person can act on
//
//   usage:  node server.js      then, in another shell:
//           node tests/pchat_flows_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
const MIN_TAP = 40;

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
    ["select","eq","neq","gt","gte","lt","lte","in","is","or","filter","order","limit","range","match","insert","delete","update","upsert"]
      .forEach(function (m) { b[m] = function () { return b; }; });
    b.then = function (r, j) { return Promise.resolve({ data: [], error: null }).then(r, j); };
    return b; }
  return { from: builder,
    rpc: function () {
      if (window.__rpcFail) return Promise.resolve({ data: null, error: { message: window.__rpcFail } });
      return Promise.resolve({ data: [], error: null }); },
    auth: { getSession: noSession, getUser: noSession, signOut: noSession,
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; } },
    storage: { from: function () { return { getPublicUrl: function () { return { data: { publicUrl: "" } }; } }; } },
    channel: function () { return { on: function () { return this; }, subscribe: function () { return this; } }; },
    removeChannel: function () {} };
} };`;

const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
});

async function open(path, { width = 390, height = 844, lang = "en" } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  // Our own tagged diagnostics are deliberate: when a send fails the seeker gets
  // plain language and the DETAIL goes to the console for us. Counting those as
  // page errors would punish the fix.
  page.on("console", (m) => {
    const txt = m.text();
    // favicon.ico is not part of any flow; the static server has never served one.
    if (m.type() === "error" && !/^\[[a-z-]+\]/i.test(txt) && !/favicon/i.test(txt)) {
      errs.push("console: " + txt.slice(0, 160));
    }
  });
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
    if (/cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    if (/arcgisonline|basemaps\.cartocdn|api\.mapbox|tile\.openstreetmap|supabase\.co\/storage|\.mp4$/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
    }
    if (/supabase\.co|nominatim|router\.project-osrm/.test(url)) {
      return req.respond({ status: 200, headers: {
        "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
    }
    req.continue();
  });
  // Every page in this file shares one browser context, so localStorage
  // carries over. State the language on every open or the Swahili run silently
  // sets the language for everything opened after it.
  await page.evaluateOnNewDocument((l) => { try { localStorage.setItem("lang", l); } catch (_) {} }, lang);
  await page.goto(`${BASE}/${path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1400));
  return { page, errs };
}

// The smallest box a thumb actually gets for a control: the control itself, or
// the label wrapping it — a 13px checkbox inside a 44px label is a 44px target.
async function smallTargets(page, rootSel, min) {
  return page.evaluate((sel, m) => {
    const root = document.querySelector(sel);
    if (!root) return [];
    return [...root.querySelectorAll("button,select,textarea,a[href],input:not([type=hidden])")]
      .map((el) => {
        const lab = el.closest("label");
        const box = (lab || el).getBoundingClientRect();
        return { id: el.id || el.type || el.tagName, w: Math.round(box.width), h: Math.round(box.height) };
      })
      .filter((x) => x.h > 0 && Math.min(x.w, x.h) < m);
  }, rootSel, min);
}

try {
  // ==========================================================================
  process.stdout.write("\n1. Tell us what you want — the request dialog\n");
  // ==========================================================================
  const { page, errs } = await open("p-chat.html");

  const openModal = async () => {
    await page.click("#pcRequestBtn");
    await new Promise((r) => setTimeout(r, 500));
  };

  await openModal();
  ok((await page.$(".rp-back")) !== null, "the button opens the shared modal");

  ok(await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    const by = d && d.getAttribute("aria-labelledby");
    const t = by && document.getElementById(by);
    return !!(d && (d.getAttribute("aria-label") || (t && t.textContent.trim())));
  }), "the dialog has an accessible name, so a screen reader announces it");

  ok(await page.evaluate(() => getComputedStyle(document.body).overflow === "hidden"),
     "the page behind it stops scrolling while it is open");

  // Pressing the opener again must not stack a second copy.
  await openModal();
  ok((await page.$$eval(".rp-back", (n) => n.length)) === 1,
     "pressing the button twice leaves exactly one dialog");

  // Focus trap: Tab from the last control wraps back inside, not to the page.
  await page.evaluate(() => {
    const d = document.querySelector(".rp-back");
    const f = [...d.querySelectorAll("button,input,select,textarea,a[href]")]
      .filter((e) => e.offsetParent !== null);
    f[f.length - 1].focus();
  });
  await page.keyboard.press("Tab");
  ok(await page.evaluate(() => {
    const d = document.querySelector(".rp-back");
    return !!d && d.contains(document.activeElement);
  }), "Tab from the last control stays inside the dialog instead of reaching the page behind");

  // Escape closes it.
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 350));
  ok((await page.$(".rp-back")) === null, "Escape closes it");
  ok(await page.evaluate(() => getComputedStyle(document.body).overflow !== "hidden"),
     "and the page scrolls again afterwards");
  ok(await page.evaluate(() => document.activeElement && document.activeElement.id === "pcRequestBtn"),
     "and focus goes back to the button that opened it");

  // Tap targets.
  await openModal();
  const small = await smallTargets(page, ".rp-back", MIN_TAP);
  ok(small.length === 0, `every control in the dialog is at least ${MIN_TAP}px for a thumb`,
     small.slice(0, 6).map((s) => `${s.id} ${s.w}x${s.h}`).join(", "));

  // Dates cannot be in the past.
  const dateGuards = await page.evaluate(() => ({
    fromMin: document.getElementById("rpFrom").getAttribute("min"),
    byMin: document.getElementById("rpWhen").getAttribute("min"),
    today: new Date().toISOString().slice(0, 10),
  }));
  ok(dateGuards.fromMin === dateGuards.today && dateGuards.byMin === dateGuards.today,
     "the date fields refuse a date in the past",
     `from.min=${dateGuards.fromMin} by.min=${dateGuards.byMin} today=${dateGuards.today}`);

  // …and "moving in" cannot be before "start looking".
  const order = await page.evaluate(async () => {
    document.getElementById("rpRegion").value = "Mwanza";
    document.getElementById("rpPhone").value = "0712345678";
    document.getElementById("rpFrom").value = "2027-06-01";
    document.getElementById("rpWhen").value = "2027-01-01";
    document.getElementById("rpGo").click();
    await new Promise((r) => setTimeout(r, 500));
    return { msg: (document.getElementById("rpMsg") || {}).textContent || "",
             stillOpen: !!document.querySelector(".rp-back") };
  });
  ok(order.stillOpen && /date|tarehe|before|baada|kabla/i.test(order.msg),
     "a deadline before the start date is refused, with a reason",
     `msg=${JSON.stringify(order.msg)}`);

  // A backend failure must not spill raw database text at the seeker.
  const rawErr = await page.evaluate(async () => {
    window.__rpcFail = 'duplicate key value violates unique constraint "house_demand_pins_pkey"';
    document.getElementById("rpFrom").value = "";
    document.getElementById("rpWhen").value = "";
    document.getElementById("rpGo").click();
    await new Promise((r) => setTimeout(r, 3500));
    return (document.getElementById("rpMsg") || {}).textContent || "";
  });
  ok(rawErr && !/violates|constraint|pkey|PGRST|column |relation /i.test(rawErr),
     "a database error reaches the seeker as plain language, not SQL",
     `msg=${JSON.stringify(rawErr)}`);

  ok(errs.length === 0, "no page errors through the whole flow", errs.slice(0, 3).join(" | "));
  await page.close();

  // ==========================================================================
  process.stdout.write("\n2. Alert me about an area — houses.html?alert=1\n");
  // ==========================================================================
  const a = await open("houses.html?alert=1");

  ok(await a.page.evaluate(() => {
    const b = document.getElementById("alertModalBackdrop");
    return !!b && !b.hidden;
  }), "the deep link really opens the sheet, rather than just landing on houses");

  ok(await a.page.evaluate(() => getComputedStyle(document.body).overflow === "hidden"),
     "the listings behind it stop scrolling");

  ok(await a.page.evaluate(() => {
    const b = document.getElementById("alertModalBackdrop");
    return !!b && b.contains(document.activeElement);
  }), "focus lands inside the sheet, not on the page behind it");

  const smallA = await smallTargets(a.page, "#alertModalBackdrop", MIN_TAP);
  ok(smallA.length === 0, `every control in the sheet is at least ${MIN_TAP}px for a thumb`,
     smallA.slice(0, 6).map((x) => `${x.id} ${x.w}x${x.h}`).join(", "));

  await a.page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 350));
  ok(await a.page.evaluate(() => document.getElementById("alertModalBackdrop").hidden),
     "Escape closes it");
  ok(await a.page.evaluate(() => getComputedStyle(document.body).overflow !== "hidden"),
     "and the listings scroll again afterwards");

  ok(a.errs.length === 0, "no page errors opening or closing it", a.errs.slice(0, 3).join(" | "));
  await a.page.close();

  // Swahili: the sheet is a wall of text, and it used to be English-only.
  const sw = await open("houses.html?alert=1", { lang: "sw" });

  const leaks = await sw.page.evaluate(() => {
    const b = document.getElementById("alertModalBackdrop");
    if (!b || b.hidden) return ["sheet did not open"];
    const english = [
      "Set up an area alert", "Alert radius", "Save alert", "Name this alert",
      "Min bedrooms", "Max price", "Whole ward", "Draw area",
      "Add one or more areas", "Pin not placed yet",
    ];
    const txt = b.innerText || "";
    return english.filter((e) => txt.includes(e));
  });
  ok(leaks.length === 0, "in Swahili the whole sheet is translated — no English left in it",
     leaks.join(" | "));

  const rawKeys = await sw.page.evaluate(() => {
    const b = document.getElementById("alertModalBackdrop");
    return /hal_[a-z_]+/.test(b ? b.innerText : "");
  });
  ok(!rawKeys, "and no raw i18n keys leak through where a string was missed");

  await sw.page.close();

  // ==========================================================================
  process.stdout.write("\n3. Scan near you — near-me.html, and any area by name\n");
  // ==========================================================================
  const nm = await open("near-me.html");
  ok(await nm.page.$("#nmNearBtn") !== null, "the page offers the GPS scan");
  const nmSmall = await smallTargets(nm.page, ".nm-toolbar", MIN_TAP);
  ok(nmSmall.length === 0, `the toolbar controls are at least ${MIN_TAP}px`,
     nmSmall.slice(0, 5).map((x) => `${x.id} ${x.w}x${x.h}`).join(", "));
  // Changing what to show must not throw — the filters re-run the whole render.
  await nm.page.select("#nmKind", "rooms");
  await nm.page.select("#nmRadius", "0");
  await new Promise((r) => setTimeout(r, 600));
  ok(nm.errs.length === 0, "changing the filters re-renders without errors",
     nm.errs.slice(0, 3).join(" | "));
  await nm.page.close();

  const ar = await open("area.html");
  ok(await ar.page.$("#arInput") !== null, "“any area by name” lands on a page with a search box");
  ok(ar.errs.length === 0, "and it loads clean", ar.errs.slice(0, 3).join(" | "));
  await ar.page.close();

  // ==========================================================================
  process.stdout.write("\n4. Read an area as a room for business — frame.html\n");
  // ==========================================================================
  const fr = await open("frame.html");
  ok(await fr.page.$("#frSearch") !== null && await fr.page.$("#frLocateBtn") !== null,
     "both ways in are there — type a place, or use your location");
  ok(await fr.page.evaluate(() => {
    const h = document.getElementById("frHint");
    return !!h && h.textContent.trim().length > 0;
  }), "the hint tells you what to do first, rather than leaving an empty map");
  ok(fr.errs.length === 0, "no page errors", fr.errs.slice(0, 3).join(" | "));
  await fr.page.close();

  // ==========================================================================
  process.stdout.write("\n5. Meet & Locate — meet.html\n");
  // ==========================================================================
  const mt = await open("meet.html");
  ok(await mt.page.$("#createRoomBtn") !== null, "the lobby offers to create a room");
  ok(await mt.page.evaluate(() => {
    const b = document.getElementById("chatPhotoBtn");
    return !!b && !!b.getAttribute("aria-label");
  }), "the icon-only chat controls carry names, so they are not silent to a screen reader");
  ok(mt.errs.length === 0, "no page errors", mt.errs.slice(0, 3).join(" | "));
  await mt.page.close();

  // ==========================================================================
  process.stdout.write("\n6. Share a location — share-location.html\n");
  // ==========================================================================
  // THE REGRESSION THIS FILE EXISTS FOR. P-Chat links here with no ?c= code.
  // The page used to answer "Invalid link — it has no code" with the button
  // disabled: a tool advertised on the tab and dead on arrival.
  const sl = await open("share-location.html");
  const slState = await sl.page.evaluate(() => ({
    disabled: document.getElementById("slBtn").disabled,
    status: (document.getElementById("slStatus") || {}).textContent || "",
    title: (document.getElementById("slTitle") || {}).textContent || "",
  }));
  ok(!slState.disabled, "opened from P-Chat, with no code, the button still works",
     `disabled=${slState.disabled} status=${JSON.stringify(slState.status)}`);
  ok(!/invalid link/i.test(slState.status), "and it does not call the visitor's own link invalid",
     JSON.stringify(slState.status));
  ok(/share a location/i.test(slState.title), "and it offers what P-Chat promised — sharing a spot",
     JSON.stringify(slState.title));
  ok(sl.errs.length === 0, "no page errors", sl.errs.slice(0, 3).join(" | "));
  await sl.page.close();

  // The agent's link (?c=CODE) must still behave as it always did.
  const sla = await open("share-location.html?c=ABC123");
  ok(await sla.page.evaluate(() => /registering this house/i.test(
       (document.getElementById("slLead") || {}).textContent || "")),
     "and the agent's own link still asks the person at the property for the pin");
  await sla.page.close();

  // ==========================================================================
  process.stdout.write("\n7. Jobs and staff — jobs.html\n");
  // ==========================================================================
  const jb = await open("jobs.html");
  ok(await jb.page.$("#jobsPostBtn") !== null && await jb.page.$("#jobsNearBtn") !== null,
     "both sides of the board are there — claim a job, or post one");
  const boardText = await jb.page.evaluate(() => document.body.innerText);
  ok(!/\.sql|supabase\/|SQL editor/i.test(boardText),
     "a worker never sees the admin's SQL file when the board is switched off");
  await jb.page.evaluate(() => document.getElementById("jobsPostBtn").click());
  await new Promise((r) => setTimeout(r, 500));
  ok(await jb.page.evaluate(() => {
    const m = document.getElementById("jobPostModal") || document.querySelector(".jobs-modal");
    return !!m && !m.hidden && getComputedStyle(m).display !== "none";
  }), "the post-a-job form opens");
  ok(jb.errs.length === 0, "no page errors", jb.errs.slice(0, 3).join(" | "));
  await jb.page.close();

} finally {
  await browser.close();
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
