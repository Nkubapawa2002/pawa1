#!/usr/bin/env node
// ============================================================================
//  driver.mjs — drive the running Pawa app from the command line.
//
//  The app is a static PWA served by server.js on :8080. Everything it needs
//  at runtime (Supabase, MapTiler, LocationIQ, Google Fonts) is a NETWORK call
//  to somebody else's server, which is why a naive puppeteer script against
//  this repo hangs, empties itself, or 429s at random. This driver exists so
//  the next agent does not rediscover that.
//
//  What it handles for you, all of which cost real time to find:
//
//   · the OPTIONS preflight. Miss it and a page waits on CORS forever, with no
//     error anywhere. This is the single most common "the page never loads".
//   · localStorage cleared before every load. js/core/data.js keeps a keyed
//     cache there WITH A TTL, so an empty result from one run is reused by the
//     next and a feature looks intermittently broken when nothing is.
//   · retries. Puppeteer on Windows fails to launch or times out navigating
//     for no reason, several times an hour. Everything here retries.
//   · the auth gate. The interesting screens (the listing form, the service
//     form) only exist after sign-in. `form` reveals them without a session.
//
//  Usage (from the repo root, server already running):
//
//    node .claude/skills/run-pawa2/driver.mjs check  index.html
//    node .claude/skills/run-pawa2/driver.mjs shot   p-message.html --theme=light
//    node .claude/skills/run-pawa2/driver.mjs form   agent-houses.html
//    node .claude/skills/run-pawa2/driver.mjs eval   index.html "document.title"
//
//  Exit code is non-zero when a page reports errors, so it works in a loop.
// ============================================================================

import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.PAWA_BASE || "http://localhost:8080";
const OUTDIR = process.env.PAWA_OUT || "shots";

const argv = process.argv.slice(2);
const cmd = argv[0];
const page = argv[1];
const rest = argv.slice(2);
const flag = (n, d) => {
  const hit = rest.find((a) => a.startsWith("--" + n + "="));
  return hit ? hit.slice(n.length + 3) : d;
};
const has = (n) => rest.includes("--" + n);

const THEME = flag("theme", "dark");
const WIDTH = Number(flag("w", 390));
const HEIGHT = Number(flag("h", 1400));
const WAIT = Number(flag("wait", 2500));

// Coordinates the app will accept as a remembered fix, and a place someone
// "sent you", for the flows that only appear once those exist.
const FIX = { lat: -6.7724, lng: 39.2083, accuracy: 30 };

function usage(msg) {
  if (msg) console.error("error: " + msg + "\n");
  console.error(`pawa driver

  check <page>            load it, report console errors, 404s, sideways scroll
  shot  <page>            the above, and write a PNG into ${OUTDIR}/
  form  <page>            reveal the signed-in form on an agent portal, then shot
  eval  <page> "<expr>"   evaluate an expression in the page and print the result
  pages                   list the pages that are wired up

  --theme=dark|light      default dark
  --w=390 --h=1400        viewport
  --wait=2500             ms to settle after DOMContentLoaded
  --live                  do NOT stub the network (real tiles, real Supabase)
  --seed                  seed a GPS fix + two shared places before loading
  --full                  full-page screenshot instead of viewport

  PAWA_BASE=${BASE}   PAWA_OUT=${OUTDIR}`);
  process.exit(msg ? 2 : 0);
}

// ---------------------------------------------------------------------------
// Retry. Both launch and navigation fail spuriously on this host.
// ---------------------------------------------------------------------------
async function withRetry(label, fn, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (i < tries) console.error(`  (${label} attempt ${i} failed, retrying)`);
    }
  }
  throw last;
}

// ---------------------------------------------------------------------------
// One prepared page. This is the part worth copying into any new script.
// ---------------------------------------------------------------------------
async function openPage(browser, url, opts = {}) {
  const p = await browser.newPage();
  const errs = [];
  const notFound = [];

  p.on("pageerror", (e) => errs.push("pageerror: " + String(e).split("\n")[0]));
  p.on("console", (m) => {
    if (m.type() === "error") errs.push("console: " + m.text().slice(0, 200));
  });
  p.on("response", (r) => {
    if (r.status() === 404 && r.url().startsWith(BASE)) {
      notFound.push(r.url().slice(BASE.length));
    }
  });

  await p.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 2 });

  if (!opts.live) {
    await p.setRequestInterception(true);
    p.on("request", (req) => {
      const u = req.url();
      // The preflight FIRST. Without this the page waits on CORS forever and
      // nothing anywhere says so.
      if (req.method() === "OPTIONS") {
        return req.respond({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "*",
            "access-control-allow-methods": "*",
          },
        });
      }
      if (opts.route) {
        const canned = opts.route(u, req);
        if (canned) return req.respond(canned);
      }
      if (/supabase\.co|locationiq|maptiler|mapbox|tile|fonts\.(googleapis|gstatic)/i.test(u)) {
        return req.respond({
          status: 200,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: "[]",
        });
      }
      req.continue();
    });
  }

  // Cleared BEFORE the first script runs. data.js reads its keyed cache during
  // boot, so clearing after goto() is already too late.
  await p.evaluateOnNewDocument((seed, fix) => {
    try {
      localStorage.clear();
      if (seed) {
        localStorage.setItem("pawa_last_pos", JSON.stringify({ ...fix, at: Date.now() }));
        localStorage.setItem("pawa-places-v1", JSON.stringify([
          { lat: -6.8123, lng: 39.2801, label: "Kwa Ndege, nyuma ya shule", source: "chat", at: Date.now() },
          { lat: -6.7724, lng: 39.2083, label: "Mikocheni gate", source: "code", at: Date.now() - 60000 },
        ]));
      }
    } catch (e) {}
  }, !!opts.seed, FIX);

  await withRetry("navigate", () =>
    p.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }));

  await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), THEME);
  await new Promise((r) => setTimeout(r, WAIT));
  return { p, errs, notFound };
}

// The two agent portals hide everything interesting behind a sign-in card.
// These are the real element ids; guessing from the DOM races the page's own
// auth routing and measures whichever won.
const PORTAL = {
  "agent-houses.html":   { gate: "ahAuthCard", form: "ahFormSection" },
  "agent-services.html": { gate: "asAuthCard", form: "asFormSection" },
};

async function revealForm(p, pageName) {
  const ids = PORTAL[pageName];
  if (!ids) throw new Error(`no known auth gate for ${pageName} (known: ${Object.keys(PORTAL).join(", ")})`);
  const ok = await p.evaluate((g, f) => {
    const gate = document.getElementById(g);
    if (gate) gate.hidden = true;
    const form = document.getElementById(f);
    if (!form) return false;
    form.hidden = false;
    let n = form.parentElement;
    while (n) { if (n.hidden) n.hidden = false; n = n.parentElement; }
    document.querySelectorAll(`#${f} [hidden]`).forEach((el) => {
      if (el.querySelector && el.querySelector("input,select,textarea,.ap-drop")) el.hidden = false;
    });
    return true;
  }, ids.gate, ids.form);
  if (!ok) throw new Error(`#${ids.form} not found on ${pageName}`);
  await new Promise((r) => setTimeout(r, 1200));
}

async function health(p) {
  return await p.evaluate(() => ({
    title: document.title,
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
    clientW: document.documentElement.clientWidth,
  }));
}

function report(name, h, errs, notFound) {
  const sideways = h.scrollW > h.clientW;
  console.log(`${name}`);
  console.log(`  title      ${h.title}`);
  console.log(`  size       ${h.scrollW} x ${h.scrollH}` + (sideways ? "   <-- SCROLLS SIDEWAYS" : ""));
  if (notFound.length) console.log(`  404        ${[...new Set(notFound)].slice(0, 6).join(", ")}`);
  console.log(`  errors     ${errs.length ? "" : "none"}`);
  errs.slice(0, 6).forEach((e) => console.log("    " + e));
  return errs.length === 0 && !sideways && notFound.length === 0;
}

// ---------------------------------------------------------------------------
async function main() {
  if (!cmd || cmd === "help" || cmd === "--help") usage();

  if (cmd === "pages") {
    const list = fs.readdirSync(process.cwd())
      .filter((f) => f.endsWith(".html")).sort();
    console.log(list.join("\n"));
    return true;
  }

  if (!page) usage("missing <page>");

  const browser = await withRetry("launch", () =>
    puppeteer.launch({ headless: "new", args: ["--no-sandbox"] }));

  try {
    const url = `${BASE}/${page.replace(/^\//, "")}`;
    const { p, errs, notFound } = await openPage(browser, url,
      { live: has("live"), seed: has("seed") });

    if (cmd === "eval") {
      const expr = rest.filter((a) => !a.startsWith("--"))[0];
      if (!expr) usage('missing "<expr>"');
      const out = await p.evaluate((e) => {
        try { return JSON.stringify(eval(e), null, 1); }
        catch (err) { return "threw: " + err.message; }
      }, expr);
      console.log(out);
      return true;
    }

    if (cmd === "form") await revealForm(p, page.replace(/^\//, ""));

    const h = await health(p);
    const ok = report(page, h, errs, notFound);

    if (cmd === "shot" || cmd === "form") {
      fs.mkdirSync(OUTDIR, { recursive: true });
      const file = path.join(OUTDIR,
        `${page.replace(/\.html$/, "").replace(/[^\w-]/g, "_")}_${THEME}${cmd === "form" ? "_form" : ""}.png`);
      await p.screenshot({ path: file, fullPage: has("full") });
      console.log(`  shot       ${file}`);
    }
    return ok;
  } finally {
    await browser.close();
  }
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((e) => { console.error(String(e.message || e)); process.exit(2); });
