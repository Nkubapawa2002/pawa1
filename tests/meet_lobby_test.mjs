// ============================================================================
//  tests/meet_lobby_test.mjs
//  The Meet & Locate lobby, and P-Chat's one door onto it.
//
//  Three things were wrong, and none of them was caught by anything already
//  running, which is why this file exists.
//
//   1. YOU COULD NOT READ WHAT YOU TYPED. Two shared stylesheets claim the
//      field background with !important and disagree, and which one wins turns
//      on the selector SHAPE rather than either file's intent:
//
//         premium.css   input[type="text"] …, select  (0,1,1)
//         neon-pro.css  input, select, textarea       (0,0,1)
//
//      so premium won the typed inputs and neon-pro won the bare selects. The
//      ink followed the theme; the ground never did. Measured: white text on a
//      white field in dark, black text on a black field in light.
//
//      mobile_audit passes this page 102/102 and always did, because
//      contrast_check INFERS a background from the CSS cascade rather than
//      looking at the screen. So the assertion here SAMPLES PIXELS out of a
//      screenshot of the real field, which is the only way to catch a fight
//      between two !important rules neither of which is the one you read.
//
//   2. EVERYBODY WAS TOLD THEY HAD BEEN INVITED. The invite banner ships with
//      the `hidden` attribute and is revealed only for ?code=…, but its own
//      rule set `display: flex`, which beats the UA rule behind the attribute.
//      So a cold visitor was told they were invited to a meet-up that does not
//      exist and instructed to tap a Join button that could not work.
//
//   3. P-CHAT HAD TWO DOORS ONTO ONE ROOM. "Share my live location" and
//      "Meet & Locate" both opened meet.html; ?live=1 only put a focus ring on
//      a button inside the same lobby.
//
//  Run:  node server.js   then   node tests/meet_lobby_test.mjs
// ============================================================================

import puppeteer from "puppeteer";

const fails = [];
let pass = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log("  PASS  " + label); }
  else { fails.push(label + (detail ? "\n        " + detail : "")); console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };

async function open(browser, url, theme) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 390, height: 900, deviceScaleFactor: 1, isMobile: true });
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
  await p.setRequestInterception(true);
  p.on("request", (r) => {
    const u = r.url();
    if (/^http:\/\/localhost:8080\//.test(u)) return r.continue();
    // Everything third-party is answered empty: this test is about the page's
    // own chrome, and a map tile has never made a form field readable.
    return r.respond({ status: 200, headers: CORS, body: "" });
  });
  await p.evaluateOnNewDocument((t) => { try { localStorage.setItem("pawa-theme", t); } catch (_) {} }, theme);
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
  await wait(2500);
  p.__errs = errs;
  return { p, ctx };
}

/** sRGB relative luminance, then the WCAG ratio. */
function ratio(a, b) {
  const lum = ([r, g, b2]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b2);
  };
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * The field's GROUND, sampled off the screen, and its INK, read off the
 * element.
 *
 * The first version of this compared the darkest and lightest pixel in the
 * element's box, and it could not fail: a field's own BORDER is inside its
 * border-box, so a white-on-white field still contained a dark border pixel
 * and scored 16:1. Measuring "is there contrast somewhere in this rectangle"
 * is not the question. The question is whether the TEXT contrasts with the
 * SURFACE IT SITS ON, so the ground is taken as the most common colour along a
 * strip through the middle of the field, well inside the border, and the ink
 * is the computed colour of the text itself.
 */
async function inkAndGround(p, selector) {
  const box = await p.evaluate((sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    if (r.width < 24 || r.height < 12) return null;
    const c = getComputedStyle(e);
    const m = c.color.match(/[\d.]+/g).map(Number);
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             ink: [m[0], m[1], m[2]] };
  }, selector);
  if (!box) return null;

  // Six pixels in from every edge clears the border and the focus ring, and a
  // one-pixel-tall strip through the middle stays off any ascender or
  // descender that happens to reach the padding.
  const INSET = 6;
  const shot = await p.screenshot({ clip: {
    x: box.x + INSET, y: box.y + Math.round(box.h / 2),
    width: Math.max(4, box.w - INSET * 2), height: 1,
  } });

  const ground = await p.evaluate(async (dataUrl) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx2 = c.getContext("2d");
    ctx2.drawImage(img, 0, 0);
    const d = ctx2.getImageData(0, 0, c.width, c.height).data;
    // The most frequent colour along the strip is the field, because the text
    // occupies a minority of it and the glyph edges are all different shades.
    const seen = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const k = d[i] + "," + d[i + 1] + "," + d[i + 2];
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    let best = null, n = -1;
    for (const [k, v] of seen) if (v > n) { n = v; best = k; }
    return best.split(",").map(Number);
  }, "data:image/png;base64," + shot.toString("base64"));

  return { ink: box.ink, ground: ground };
}

const BASE = "http://localhost:8080";
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 180000 });

try {
  // =========================================================================
  section("1. You can read what you type, in both themes");
  // =========================================================================
  for (const theme of ["dark", "light"]) {
    const { p, ctx } = await open(browser, BASE + "/meet.html", theme);

    // Type into the fields so there is real ink to measure, not a placeholder
    // (which is allowed to be faint, and would let the bug through).
    await p.evaluate(() => {
      const n = document.getElementById("createName");
      n.value = "Asha";
      n.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await wait(200);

    for (const [sel, what] of [["#createName", "the name you type"], ["#createRole", "the role you pick"]]) {
      const m = await inkAndGround(p, sel);
      ok(m !== null, `${theme}: ${what} is on screen to be measured`, String(m));
      if (!m) continue;
      const r = ratio(m.ink, m.ground);
      // 4.5:1 is the WCAG floor for body text. The bug measured about 1.1:1,
      // so this is not a close call in either direction.
      ok(r >= 4.5, `${theme}: ${what} contrasts with its own field (${r.toFixed(2)}:1)`,
         `ink rgb(${m.ink.join(",")}) on field rgb(${m.ground.join(",")})`);
    }
    ok(p.__errs.length === 0, `${theme}: the page threw nothing`, p.__errs.join(" | "));
    await ctx.close();
  }

  // =========================================================================
  section("2. Nobody is told they were invited when they were not");
  // =========================================================================
  {
    const { p, ctx } = await open(browser, BASE + "/meet.html?from=pchat", "dark");
    const cold = await p.evaluate(() => {
      const b = document.getElementById("meetInviteBanner");
      return { hiddenAttr: b.hidden, display: getComputedStyle(b).display };
    });
    ok(cold.hiddenAttr === true, "a cold visit leaves the banner's hidden attribute set");
    ok(cold.display === "none",
       "and the attribute actually hides it, rather than being overruled by its own CSS",
       "display: " + cold.display);
    await ctx.close();

    const { p: p2, ctx: ctx2 } = await open(browser, BASE + "/meet.html?code=ABC123", "dark");
    const invited = await p2.evaluate(() => {
      const b = document.getElementById("meetInviteBanner");
      return {
        display: getComputedStyle(b).display,
        code: document.getElementById("joinCode").value,
      };
    });
    ok(invited.display !== "none", "somebody who really was invited still sees it", invited.display);
    ok(invited.code === "ABC123", "with their code already filled in", invited.code);
    await ctx2.close();
  }

  // =========================================================================
  section("3. One door onto the room, not two");
  // =========================================================================
  {
    const { p, ctx } = await open(browser, BASE + "/p-chat.html", "dark");
    const doors = await p.evaluate(() =>
      [...document.querySelectorAll('a[href*="meet.html"]')]
        .map((a) => a.getAttribute("href"))
        // The "still open" banner links back to a room by code and is a
        // different thing: it only exists when a room survived in session
        // storage, and it is not a tool row.
        .filter((h) => !/[?&]code=/.test(h)));
    ok(doors.length === 1, "P-Chat offers exactly one row that opens meet.html", JSON.stringify(doors));
    ok(!doors.some((h) => /live=1/.test(h)),
       "and it is not the ?live=1 variant, which only focused a button in the same lobby");
    await ctx.close();
  }

  // =========================================================================
  section("4. The lobby leads with the thing people came to do");
  // =========================================================================
  {
    const { p, ctx } = await open(browser, BASE + "/meet.html", "dark");
    const order = await p.evaluate(() => {
      const share = document.getElementById("waLiveLobbyBtn");
      const create = document.getElementById("createRoomBtn");
      if (!share || !create) return null;
      return {
        shareFirst: share.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING ? true : false,
        bothPresent: true,
        // meet.js binds by id; the redesign must not have renamed anything.
        join: !!document.getElementById("joinRoomBtn"),
        code: !!document.getElementById("joinCode"),
      };
    });
    ok(order && order.bothPresent, "both actions survive the reorder");
    ok(order && order.shareFirst, "sharing comes before creating a room");
    ok(order && order.join && order.code, "and every id js/pages/meet.js binds to is still there");

    // No marketing kicker above the fold of a utility page.
    const badge = await p.evaluate(() => !!document.querySelector(".fast-hero-badge"));
    ok(!badge, "the dated NEW badge is gone from the hero");
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log("\n" + pass + " passed, " + fails.length + " failed");
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
