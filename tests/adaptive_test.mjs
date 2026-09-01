// ============================================================================
//  adaptive_test.mjs — the screen the app looked worst on
//
//  css/adaptive.css and js/core/viewport.js were written for one device: an
//  iPhone X. 375 wide, 812 tall, a 44px notch and a 34px home indicator, and
//  about 515 pixels left that a person can actually use once Safari has taken
//  its toolbars. Three things went wrong there at once, every one of them
//  invisible in a desktop browser at the same width:
//
//    the header sat underneath the notch, because nothing reserved the inset;
//    `100vh` resolved to 812 against a visible 635, so a full-height panel ran
//    177px past the bottom of the screen and the row with the button on it
//    could not be reached at all;
//    and the bottom tab bar, drawn for a 390-430px phone, spent 120 of those
//    515 pixels on itself.
//
//  Every section below pins one of the claims the fix makes. They are pinned
//  here rather than left to the eye because all three failures LOOK FINE at
//  375px in a desktop browser: Chrome has no notch to hide behind, and its
//  100vh is the height you can see. The bug only exists on hardware nobody
//  runs the suite on, which is exactly the kind of bug that comes back.
//
//  THE NOTCH IS SIMULATED, AND THAT IS NOT A CHEAT.
//  `env(safe-area-inset-*)` is zero in headless Chrome and there is no flag
//  that changes it. viewport.js therefore reads a `pawa-safe-sim` key before
//  it probes, so a test can hand it the insets a real iPhone would report.
//  That hook existed and nothing used it, which made it a claim rather than a
//  guarantee. This file is what turns it into one. A real device never writes
//  the key, and section 2 checks that the probe is what answers when it is
//  absent.
//
//  Everything external is answered locally, so this spends no quota and does
//  not need Supabase to be reachable. See the browser-test recipe.
//
//  Usage: node server.js   then:  node tests/adaptive_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";

// The devices, and why each one is here. None is a round number somebody
// liked; each is the phone that broke a specific rule.
const IPHONE_X = { w: 375, h: 812 };   // the notched screen the layer is for
const IPHONE_X_SAFARI = { w: 375, h: 635 }; // the same phone, toolbars counted
const IPHONE_13 = { w: 390, h: 844 };  // the phone the app chrome was drawn for
const IPHONE_13_SAFARI = { w: 390, h: 635 }; // wide enough, too short
const DESKTOP = { w: 1200, h: 900 };   // where a phone tab bar looks lost
const NOTCH = { top: 44, bottom: 34, left: 0, right: 0 };

// A stub Supabase. The bell and the home page both read it on load; an
// unanswered request leaves the page waiting and the test times out on
// something that has nothing to do with the viewport.
const stub = `window.supabase={createClient:function(){
function q(){var b={};["select","eq","neq","gt","gte","lt","lte","is","or","order","limit","in"].forEach(function(m){b[m]=function(){return b}});
b.then=function(r,j){return Promise.resolve({data:[],error:null}).then(r,j)};return b}
return{rpc:function(){return Promise.resolve({data:[],error:null})},from:q,
auth:{getSession:function(){return Promise.resolve({data:{session:null},error:null})},
getUser:function(){return Promise.resolve({data:{user:null},error:null})},
onAuthStateChange:function(){return{data:{subscription:{unsubscribe:function(){}}}}},
signOut:function(){return Promise.resolve({})}},
channel:function(){return{on:function(){return this},subscribe:function(){return this}}},removeChannel:function(){},
storage:{from:function(){return{getPublicUrl:function(){return{data:{publicUrl:""}}}}}},
functions:{invoke:function(){return Promise.resolve({data:null,error:null})}}}}};`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

let passed = 0;
const fails = [];
const ok = (cond, what, detail) => {
  if (cond) { passed++; console.log("  PASS  " + what); }
  else { fails.push(what); console.log("  FAIL  " + what); if (detail) console.log("        " + detail); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });

/**
 * A page on a given device.
 *
 * `safe` fakes the notch. `pref` seeds a layout the person chose on a previous
 * visit, which is the only thing allowed to overrule the guess.
 */
async function open({ size = IPHONE_13, safe = null, pref = null, file = "index.html" } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.setViewport({
    width: size.w, height: size.h, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    const u = r.url();
    if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: { "access-control-allow-origin": "*" } });
    if (/cdn\.jsdelivr\.net.*supabase/.test(u)) return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: stub });
    if (/maptiler|mapbox|arcgisonline|cartocdn|tile\.openstreetmap|basemaps/.test(u))
      return r.respond({ status: 200, headers: { "content-type": "image/png", "access-control-allow-origin": "*" }, body: PNG });
    if (/supabase\.co|locationiq|nominatim|osrm/.test(u))
      return r.respond({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
    if (/fonts\.googleapis|fonts\.gstatic/.test(u)) return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    r.continue();
  });
  // Seeding only ever WRITES. Each open() gets its own browser context and so
  // its own empty storage, which means clearing is unnecessary — and this hook
  // runs again on every navigation, so a clear here would wipe a preference
  // the test had just set and reloaded to check.
  await page.evaluateOnNewDocument((sa, pf) => {
    try {
      localStorage.setItem("pawa-theme", "dark");
      if (sa) localStorage.setItem("pawa-safe-sim", JSON.stringify(sa));
      if (pf) localStorage.setItem("pawa-view", pf);
    } catch (e) {}
  }, safe, pref);
  await page.goto(BASE + "/" + file, { waitUntil: "domcontentloaded", timeout: 60000 });
  // Both chromes are built by app-shell.js on DOMContentLoaded, and viewport.js
  // repaints on the same event, so waiting for the nav waits for both.
  await page.waitForFunction(
    () => !!window.PawaView && !!document.querySelector(".app-tabbar") && !!document.querySelector(".app-webnav"),
    { timeout: 30000 });
  await sleep(400);
  return { page, errs, close: () => ctx.close() };
}

// Reads the six numbers viewport.js publishes plus the three attributes it
// stamps. Everything else in this file is written in terms of these.
const readStamp = (page) => page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const num = (n) => parseFloat(cs.getPropertyValue(n)) || 0;
  const r = document.documentElement;
  return {
    vh: num("--app-vh"), vw: num("--app-vw"),
    saTop: num("--sa-top"), saBottom: num("--sa-bottom"),
    shell: r.getAttribute("data-shell"),
    vp: r.getAttribute("data-vp"),
    notch: r.hasAttribute("data-notch"),
    metrics: window.PawaView.metrics(),
    innerH: window.innerHeight, innerW: window.innerWidth,
  };
});

// ---------------------------------------------------------------------------
console.log("\n1. The height a person can see, not the height the page thinks it has");
{
  // The iPhone X in Safari: the page believes it has 812 and the person can
  // see 635. Chrome cannot reproduce that gap, so the honest thing to check is
  // the rule that closes it — --app-vh tracks the VISIBLE viewport, whatever
  // that is, and the utility class every full-height pane uses resolves to it.
  const t = await open({ size: IPHONE_X_SAFARI, safe: NOTCH });
  const st = await readStamp(t.page);
  ok(st.vh === IPHONE_X_SAFARI.h, "--app-vh is the visible height", st.vh + " vs " + IPHONE_X_SAFARI.h);
  ok(st.vh === st.innerH, "and it agrees with what the browser reports", st.vh + " vs " + st.innerH);
  ok(st.metrics.vh === st.vh, "JS and CSS are told the same number", JSON.stringify([st.metrics.vh, st.vh]));

  const pane = await t.page.evaluate(() => {
    const d = document.createElement("div");
    d.className = "u-vh";
    document.body.appendChild(d);
    const full = d.getBoundingClientRect().height;
    d.className = "u-vh-app";
    const inApp = d.getBoundingClientRect().height;
    d.remove();
    return { full, inApp };
  });
  ok(Math.round(pane.full) === IPHONE_X_SAFARI.h,
     "a full-height pane ends where the screen ends, not 177px past it", String(pane.full));
  ok(pane.inApp > 0 && pane.inApp < pane.full,
     "and one that has to clear the chrome is shorter than the screen, never taller",
     JSON.stringify(pane));
  ok(t.errs.length === 0, "no page errors while measuring", t.errs.join(" | "));
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n2. The notch becomes a number that CSS and JS can both read");
{
  const t = await open({ size: IPHONE_X, safe: NOTCH });
  const st = await readStamp(t.page);
  ok(st.saTop === 44, "the top inset is published as an ordinary custom property", String(st.saTop));
  ok(st.saBottom === 34, "and so is the home indicator", String(st.saBottom));
  ok(st.notch, "the screen is marked as notched, so CSS can branch on it");
  ok(st.metrics.safe.top === 44 && st.metrics.safe.bottom === 34,
     "and JS reads the same insets", JSON.stringify(st.metrics.safe));

  // The whole point of publishing the inset: something can now be placed below
  // the notch instead of behind it.
  const top = await t.page.evaluate(() => {
    const d = document.createElement("div");
    d.className = "app-topsafe";
    document.body.appendChild(d);
    const pad = parseFloat(getComputedStyle(d).paddingTop) || 0;
    d.remove();
    const toggle = document.querySelector(".pawa-theme-toggle");
    return { pad, toggleTop: toggle ? toggle.getBoundingClientRect().top : null };
  });
  ok(top.pad >= 44, "a header that opts in clears the notch rather than sitting under it", String(top.pad));
  ok(top.toggleTop === null || top.toggleTop >= 44,
     "and the floating theme toggle is below it too, not behind the hardware", String(top.toggleTop));
  await t.close();
}
{
  // No sim key means the probe answers, and in headless Chrome the probe
  // correctly reports no notch. This is the check that keeps section 2 from
  // being a test of its own fixture.
  const t = await open({ size: IPHONE_X });
  const st = await readStamp(t.page);
  // 44 would mean the fixture leaked; 0 is the probe reporting a browser with
  // no notch, which is the truth here. This is what keeps section 2 from being
  // a test of its own fixture rather than of the code.
  ok(st.saTop === 0 && st.saBottom === 0 && st.notch === false,
     "with no simulation the real probe answers, and finds no notch here",
     JSON.stringify([st.saTop, st.saBottom, st.notch]));
  ok(st.metrics.safe.top === 0, "and JS is told the measured zero, not the faked 44",
     JSON.stringify(st.metrics.safe));
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n3. The device that cannot afford the tab bar is handed the web layout");
{
  const cases = [
    [IPHONE_X, NOTCH, "web", "compact", "an iPhone X: 375 wide with 78px gone to hardware"],
    [IPHONE_13, NOTCH, "app", "regular", "an iPhone 13: the phone the app chrome was drawn for"],
    [IPHONE_13_SAFARI, null, "web", "compact", "wide enough, but too short once Safari has its toolbars"],
    [DESKTOP, null, "web", "wide", "a window where a phone tab bar would look lost"],
  ];
  for (const [size, safe, shell, vp, why] of cases) {
    const t = await open({ size, safe });
    const st = await readStamp(t.page);
    ok(st.shell === shell && st.vp === vp, why + " gets the " + shell + " shell",
       "got shell=" + st.shell + " vp=" + st.vp);
    await t.close();
  }
}

// ---------------------------------------------------------------------------
console.log("\n4. Both chromes are built once, and exactly one of them is showing");
{
  // Building only the active one meant re-rendering on every view change and
  // re-deriving the active tab each time. Building both means the switch is a
  // repaint, which is why it can be instant — but only if the hidden one is
  // genuinely hidden rather than merely off-screen.
  for (const [size, safe, shell] of [[IPHONE_X, NOTCH, "web"], [IPHONE_13, NOTCH, "app"]]) {
    const t = await open({ size, safe });
    const vis = await t.page.evaluate(() => {
      const seen = (el) => {
        if (!el) return false;
        const cs = getComputedStyle(el);
        return cs.display !== "none" && cs.visibility !== "hidden" && el.getBoundingClientRect().height > 0;
      };
      return {
        tabbarInDom: !!document.querySelector(".app-tabbar"),
        webnavInDom: !!document.querySelector(".app-webnav"),
        tabbar: seen(document.querySelector(".app-tabbar")),
        webnav: seen(document.querySelector(".app-webnav")),
      };
    });
    ok(vis.tabbarInDom && vis.webnavInDom, "in " + shell + " mode both chromes are in the document");
    ok(shell === "web" ? (vis.webnav && !vis.tabbar) : (vis.tabbar && !vis.webnav),
       "and only the " + shell + " one is drawn", JSON.stringify(vis));
    await t.close();
  }
}

// ---------------------------------------------------------------------------
console.log("\n5. The two chromes name the same places and light the same one");
{
  // Two navigations built from one list, in two shapes. The moment they are
  // built from two lists they drift, and each looks perfectly right on its own
  // screen — which is the failure this codebase keeps refusing everywhere else.
  const t = await open({ size: IPHONE_X, safe: NOTCH });
  const navs = await t.page.evaluate(() => {
    const read = (sel) => [...document.querySelectorAll(sel + " a")].map((a) => ({
      href: a.getAttribute("href"),
      label: (a.querySelector("span") || {}).textContent || "",
      active: a.classList.contains("active"),
    }));
    return { app: read(".app-tabbar"), web: read(".app-webnav-rail") };
  });
  ok(navs.app.length === 5, "the bottom bar has the five destinations", String(navs.app.length));
  ok(navs.web.length === 5, "and so does the top rail", String(navs.web.length));
  ok(JSON.stringify(navs.app.map((a) => a.href)) === JSON.stringify(navs.web.map((a) => a.href)),
     "the same places, in the same order",
     JSON.stringify([navs.app.map((a) => a.href), navs.web.map((a) => a.href)]));
  ok(JSON.stringify(navs.app.map((a) => a.label)) === JSON.stringify(navs.web.map((a) => a.label)),
     "under the same names, so neither can be translated without the other");
  const activeOf = (l) => l.filter((a) => a.active).map((a) => a.href);
  ok(activeOf(navs.app).length === 1 && JSON.stringify(activeOf(navs.app)) === JSON.stringify(activeOf(navs.web)),
     "and exactly one tab is lit, the same one in both",
     JSON.stringify([activeOf(navs.app), activeOf(navs.web)]));
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n6. A person can overrule the guess, and it sticks");
{
  // The control that makes the whole thing honest. Whatever the device was
  // guessed to want, this has to work on any device, in either direction.
  const t = await open({ size: IPHONE_13, safe: NOTCH });
  ok((await readStamp(t.page)).shell === "app", "the guess on this phone is the app shell");

  await t.page.evaluate(() => window.PawaView.set("web"));
  await sleep(150);
  let st = await readStamp(t.page);
  ok(st.shell === "web", "asking for web overrules a guess of app", st.shell);
  ok(await t.page.evaluate(() => localStorage.getItem("pawa-view")) === "web",
     "and the choice is written down, not held in memory");

  await t.page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await t.page.waitForFunction(() => !!window.PawaView && !!document.querySelector(".app-webnav"), { timeout: 30000 });
  st = await readStamp(t.page);
  ok(st.shell === "web", "it survives coming back to the page", st.shell);
  ok(st.metrics.pref === "web", "as a preference, not a fresh guess that happened to agree", st.metrics.pref);

  await t.page.evaluate(() => window.PawaView.set("auto"));
  await sleep(150);
  st = await readStamp(t.page);
  ok(st.shell === "app" && st.metrics.pref === "auto",
     "and handing the decision back gives this phone its app shell again",
     JSON.stringify([st.shell, st.metrics.pref]));
  ok(await t.page.evaluate(() => localStorage.getItem("pawa-view")) === null,
     "with nothing left behind to remember");
  ok(t.errs.length === 0, "no page errors across the switching", t.errs.join(" | "));
  await t.close();
}
{
  // The other direction, which is the one that is easy to forget: a cramped
  // phone whose owner wants the app chrome anyway is allowed to have it.
  const t = await open({ size: IPHONE_X, safe: NOTCH, pref: "app" });
  const st = await readStamp(t.page);
  ok(st.shell === "app", "a cramped phone that asked for the app shell keeps it", st.shell);
  ok(st.vp === "compact", "and is still measured as cramped, so the density follows", st.vp);
  const bar = await t.page.evaluate(() => {
    const b = document.querySelector(".app-tabbar");
    const a = b.querySelector("a");
    const sa = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sa-bottom")) || 0;
    return {
      h: b.getBoundingClientRect().height,
      // What the BAR costs, as opposed to what the hardware costs. The home
      // indicator's 34px is not the tab bar's to give back.
      cost: b.getBoundingClientRect().height - sa,
      icon: a.querySelector("svg").getBoundingClientRect().width,
      hit: Math.min(a.getBoundingClientRect().height, a.getBoundingClientRect().width),
    };
  });
  ok(bar.icon <= 21, "the icons come down on a screen this size", String(bar.icon));
  // 62px is --tabbar-h at full size. A cramped screen must not pay MORE than a
  // roomy one for the same bar; the home indicator underneath it is hardware.
  ok(bar.cost <= 62, "and the bar itself costs less than it does on a roomy phone",
     bar.cost + " (of " + bar.h + " total, " + (bar.h - bar.cost) + " of it hardware)");
  // app-shell.js's own comment says this is as small as the bar goes precisely
  // because anything smaller drops under the hit minimum. That is a claim, so
  // it gets checked. 40px is the floor mobile_audit holds every control to.
  ok(bar.hit >= 40, "and a tab is still big enough to hit on a moving daladala",
     String(bar.hit));
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n7. The web nav gets out of the way going down and comes straight back");
{
  const t = await open({ size: IPHONE_X, safe: NOTCH });

  // Chrome re-adjusts the scroll position when content ABOVE the viewport
  // changes size, and this page is still filling itself in from the stubbed
  // API while the test scrolls. That adjustment is a scroll event nobody asked
  // for, going the wrong way, and it was flipping the nav between the step and
  // the assertion. mobile_audit turns anchoring off for the same reason.
  await t.page.addStyleTag({ content: "*, *::before, *::after { overflow-anchor: none !important; }" });
  // And wait for the page to stop growing, so the numbers below are stable.
  await t.page.waitForFunction(() => {
    const h = document.documentElement.scrollHeight;
    const was = window.__lastH;
    window.__lastH = h;
    return was === h;
  }, { timeout: 20000, polling: 300 });

  const scrollable = await t.page.evaluate(() =>
    document.documentElement.scrollHeight - window.innerHeight);
  ok(scrollable > 400, "the page is long enough for this to mean anything", String(scrollable));

  // Returns the nav's state AND where the page actually is, so a failure says
  // which of the two went wrong instead of just "not hidden".
  const at = async (y) => {
    if (y !== null) await t.page.evaluate((to) => window.scrollTo(0, to), y);
    await sleep(300);
    return t.page.evaluate(() => ({
      hidden: document.querySelector(".app-webnav").classList.contains("is-hidden"),
      y: Math.round(window.scrollY),
    }));
  };

  let s = await at(null);
  ok(s.hidden === false, "it is showing at the top of the page", JSON.stringify(s));

  s = await at(500);
  ok(s.hidden === true, "scrolling down hides it, so reading gets the whole screen", JSON.stringify(s));

  s = await at(460);
  ok(s.hidden === false, "the first upward nudge brings it back, without scrolling to the top",
     JSON.stringify(s));

  s = await at(640);
  ok(s.hidden === true, "going down again hides it again", JSON.stringify(s));

  s = await at(0);
  ok(s.hidden === false, "and the top of the page always shows it", JSON.stringify(s));
  ok(t.errs.length === 0, "no page errors while scrolling", t.errs.join(" | "));
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n8. The bottom of the screen is handed back");
{
  // 120px is what the bar and the home indicator were holding on a screen with
  // 515 to spend. This is the section that says where it went.
  //
  // ONE PAGE AT A TIME. Opening both and comparing them looks tidier and is
  // wrong: the second one to open is the front tab, so the first one loads
  // throttled in the background, and its content is still arriving when it is
  // measured. That is what made the scroll below appear not to happen at all.
  const pad = (t) => t.page.evaluate(() => {
    const p = document.querySelector(".app-shell-pad");
    // --app-bottom holds a calc(), and a custom property's calc() is never
    // evaluated by getComputedStyle — it comes back as the literal text, which
    // parseFloat reads as 0. The only way to learn the number is to spend it
    // on an element and measure what happened, the same trick viewport.js uses
    // to read the insets.
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;visibility:hidden;height:var(--app-bottom)";
    document.body.appendChild(probe);
    const appBottom = probe.getBoundingClientRect().height;
    probe.remove();
    return { pad: p ? p.getBoundingClientRect().height : null, appBottom };
  });
  const web = await open({ size: IPHONE_X, safe: NOTCH, pref: "web" });
  const w = await pad(web);
  await web.close();

  const app = await open({ size: IPHONE_X, safe: NOTCH, pref: "app" });
  const a = await pad(app);

  ok(a.pad !== null && w.pad !== null, "both shells leave a spacer, so nothing is ever under the chrome");
  ok(a.pad - w.pad >= 40, "the web shell gives the page back the room the bar was holding",
     JSON.stringify([a.pad, w.pad]));
  ok(w.appBottom === 34, "in web mode the only thing left to clear is the home indicator", String(w.appBottom));
  ok(a.appBottom > w.appBottom, "in app mode it is the bar plus the home indicator",
     JSON.stringify([a.appBottom, w.appBottom]));

  // The spacer being the right NUMBER and the bar still covering the last row
  // of content are the same bug wearing different clothes, so this checks the
  // thing itself: scroll to the very end, and see what is under the bar.
  // Getting to the bottom of this page takes more than one scroll, and that is
  // the page being normal rather than the test being fussy: it loads its rows
  // as it goes, so every arrival at the bottom makes a new bottom further
  // down. One scrollTo lands 442px short of a document that grew from 2055 to
  // 2497 underneath it. So: scroll, let it grow, scroll again, until it stops
  // moving. Anchoring off first, or Chrome adds its own corrections on top.
  await app.page.addStyleTag({ content: "*, *::before, *::after { overflow-anchor: none !important; }" });
  for (let i = 0; i < 12; i++) {
    const done = await app.page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      return Math.abs(window.scrollY + window.innerHeight -
                      document.documentElement.scrollHeight) <= 2;
    });
    await sleep(250);
    if (done) break;
  }
  await sleep(300);
  const clear = await app.page.evaluate(() => {
    const bar = document.querySelector(".app-tabbar").getBoundingClientRect();
    const pad = document.querySelector(".app-shell-pad");
    // Whatever the page's real last content is, it is whatever sits above the
    // spacer. If the spacer is doing its job, that element ends above the bar.
    let prev = pad.previousElementSibling;
    while (prev && prev.getBoundingClientRect().height === 0) prev = prev.previousElementSibling;
    return {
      barH: bar.height, barTop: bar.top, padH: pad.getBoundingClientRect().height,
      // Where the page actually is, so a failure here says which of the two
      // went wrong rather than leaving it to be guessed at.
      scrollY: Math.round(window.scrollY),
      docH: document.documentElement.scrollHeight,
      bodyH: document.body.scrollHeight,
      maxScroll: document.documentElement.scrollHeight - window.innerHeight,
      atBottom: Math.abs(window.scrollY + window.innerHeight -
                         document.documentElement.scrollHeight) <= 2,
      lastContentBottom: prev ? prev.getBoundingClientRect().bottom : null,
      lastContent: prev ? prev.tagName.toLowerCase() : null,
    };
  });
  ok(clear.barH > 0, "the bar is really drawn in app mode", String(clear.barH));
  ok(clear.padH >= clear.barH,
     "the spacer is at least as tall as the bar it is standing in for",
     JSON.stringify([clear.padH, clear.barH]));
  // Checked, not assumed: an assertion about the bottom of the page is worth
  // nothing if the page never got there.
  ok(clear.atBottom, "the page really is scrolled to its end", JSON.stringify(clear));
  ok(clear.lastContentBottom === null || clear.lastContentBottom <= clear.barTop + 1,
     "so the last row of content sits above the bar, not under it",
     JSON.stringify(clear));
  await app.close();
}

// ---------------------------------------------------------------------------
console.log("\n9. Nothing runs off the side of the narrowest phone");
{
  // A page 8px wider than the screen turns every vertical scroll into a fight.
  // mobile_audit checks this across six phones; this checks the one it does
  // not have, in the shell it does not know about.
  for (const [pref, tag] of [[null, "iPhone X, web shell"], ["app", "iPhone X, app shell"]]) {
    const t = await open({ size: IPHONE_X, safe: NOTCH, pref });
    const over = await t.page.evaluate(() => {
      const w = window.innerWidth;
      // Same exemption mobile_audit.mjs holds: something inside a deliberate
      // sideways scroller is not overflow, it is the scroller working. The web
      // nav's rail is exactly that — it scrolls its five destinations rather
      // than shrinking their labels past reading size.
      const inScroller = (el) => {
        let p = el.parentElement;
        while (p && p !== document.body) {
          const ov = getComputedStyle(p).overflowX;
          if (ov === "auto" || ov === "scroll") return true;
          p = p.parentElement;
        }
        return false;
      };
      const wide = [...document.querySelectorAll("body *")]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          const cs = getComputedStyle(e);
          if (cs.display === "none" || cs.visibility === "hidden") return false;
          if (r.width <= 0 || r.height <= 0) return false;
          // Wider than the screen all by itself is a broken element; merely
          // sticking out is only broken if nothing is scrolling it.
          return r.right > w + 1 && r.width <= w + 2 && !inScroller(e);
        })
        .slice(0, 6)
        .map((e) => e.tagName.toLowerCase() + "." +
             ((e.className && e.className.baseVal) || e.className || "").toString().trim().split(/\s+/)[0] +
             " to " + Math.round(e.getBoundingClientRect().right));
      return { docW: document.documentElement.scrollWidth, w, wide };
    });
    ok(over.docW <= over.w + 1, tag + ": the document is no wider than the screen",
       over.docW + " vs " + over.w);
    ok(over.wide.length === 0, tag + ": and no single element hangs off the right edge",
       over.wide.join("\n        "));
    ok(t.errs.length === 0, tag + ": no page errors", t.errs.join(" | "));
    await t.close();
  }
}

// ---------------------------------------------------------------------------
console.log("\n10. A rotation is a re-measure, not a reload");
{
  const t = await open({ size: IPHONE_X, safe: NOTCH });
  ok((await readStamp(t.page)).shell === "web", "portrait on this phone is the web shell");

  const heard = await t.page.evaluate(() => {
    window.__views = [];
    window.addEventListener("pawa:viewchange", (e) => window.__views.push(e.detail.mode));
    return true;
  });
  ok(heard, "something can listen for the switch");

  await t.page.setViewport({ width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await sleep(400);
  const land = await readStamp(t.page);
  ok(land.vw === 812 && land.vh === 375, "landscape is measured, not assumed",
     JSON.stringify([land.vw, land.vh]));
  ok(land.vp === "compact", "812 by 375 is still a cramped screen, because height counts too", land.vp);
  const rebuilt = await t.page.evaluate(() => document.querySelectorAll(".app-tabbar").length);
  ok(rebuilt === 1, "and the chrome was repainted, not built a second time", String(rebuilt));
  ok(t.errs.length === 0, "no page errors across the rotation", t.errs.join(" | "));
  await t.close();
}

await browser.close();
console.log("\n" + passed + " passed, " + fails.length + " failed");
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
