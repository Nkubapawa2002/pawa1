// ============================================================================
// mobile_audit.mjs — the production gate for the app-shell tabs.
//
// Every screen, on six real phone sizes, in both themes, checked for the three
// things that break on a phone and are invisible on a laptop:
//
//   1. HORIZONTAL OVERFLOW. A page 8px wider than the screen turns every
//      vertical scroll into a fight. Checked on the document AND on every
//      element, because one wide row is enough.
//   2. CONTRAST. WCAG AA thresholds — 4.5:1 for normal text, 3:1 for large or
//      bold. This is where a dark-theme colour left on a light page, or a
//      muted grey on grey, shows up.
//   3. TAP TARGETS. Anything meant to be pressed, under 40px in its smallest
//      dimension, is a thing people miss on a moving daladala. An invisible
//      hit area grown with a pseudo-element counts — that is a real fix.
//
// HOW THE BACKGROUND IS MEASURED, AND WHY IT IS DONE THE HARD WAY
// Walking the CSS cascade to work out what sits behind a piece of text was
// tried and was wrong twice, both times inventing failures on pages that were
// perfectly readable — which buries the real ones. Radial gradients, stacked
// translucency and backdrop blur cannot be resolved from computed styles.
//
// So the page is screenshotted with every glyph made transparent, the shot is
// read back through a canvas, and each element's background is the median
// pixel inside its own box. That is what the eye actually sees.
//
// The shot is taken one VIEWPORT at a time, scrolling down. A fullPage capture
// resizes the viewport to stitch, which re-lays-out the page and shifts every
// coordinate the sampling depends on — elements were reporting positions 300px
// past the end of their own document.
//
//   usage:  node server.js      then, in another shell:
//           node tests/mobile_audit.mjs            (all pages)
//           node tests/mobile_audit.mjs p-message  (one)
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";

const DEVICES = [
  { name: "Android 320", w: 320, h: 568 },
  { name: "Android 360", w: 360, h: 640 },
  { name: "iPhone SE",   w: 375, h: 667 },
  { name: "iPhone 13",   w: 390, h: 844 },
  { name: "Pixel 7",     w: 412, h: 915 },
  { name: "iPhone Max",  w: 430, h: 932 },
];

const SESSION = {
  agent: { user: { id: "audit_agent", email: "agent@example.com", is_anonymous: false } },
  admin: { user: { id: "audit_admin", email: "pawa4761@gmail.com", is_anonymous: false } },
};

const PAGES = [
  { file: "index.html", label: "Home" },
  { file: "explore.html", label: "Explore" },
  { file: "p-chat.html", label: "P-Chat" },
  { file: "p-message.html", label: "P-Message", session: SESSION.admin, prep: seedMessages },
  { file: "profile.html", label: "Profile", session: SESSION.agent, key: true },

  // The seven doors P-Chat opens. The tab itself is above; these are where it
  // SENDS people, and a tab is only as good as what is behind it. They are
  // audited on the same six phones, in both themes, for the same three things.
  { file: "houses.html?alert=1", label: "Area alert" },
  { file: "near-me.html", label: "Near me" },
  { file: "area.html", label: "Area by name" },
  { file: "frame.html", label: "Frame" },
  { file: "meet.html", label: "Meet & Locate" },
  { file: "share-location.html", label: "Share a location" },
  { file: "jobs.html", label: "Jobs and staff" },
];

let pass = 0, fail = 0;
const findings = [];
const ok = (cond, msg, detail) => {
  if (cond) pass++;
  else { fail++; findings.push(msg + (detail ? "\n        " + detail : "")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const stub = (session) => `
window.__PM_SENT = [];
window.supabase = { createClient: function () {
  var session = ${JSON.stringify(session || null)};
  var me = session && session.user ? session.user.id : null;
  var db = { keys: {}, threads: {}, messages: [], wraps: {} };
  window.__PM_DB = db;
  function rpc(name, args) {
    window.__PM_SENT.push({ name: name, args: args });
    if (name === "pm_publish_key") {
      db.keys[me] = { public_key: args.p_public_key, fingerprint: args.p_fingerprint,
        display_name: "You", region: "Mwanza", is_agent: false, is_guest: false };
      return Promise.resolve({ data: db.keys[me], error: null });
    }
    if (name === "pm_directory") {
      return Promise.resolve({ data: Object.keys(db.keys).filter(function (k) { return k !== me; })
        .map(function (k) { var v = db.keys[k];
          return { user_id: k, display_name: v.display_name, region: v.region, area: v.area || null,
            area_kind: null, district: null, ward: null, is_agent: v.is_agent,
            reachable: !!v.public_key, public_key: v.public_key, fingerprint: v.fingerprint }; }), error: null });
    }
    if (name === "pm_inbox") {
      return Promise.resolve({ data: Object.keys(db.threads).map(function (id) {
        var t = db.threads[id];
        var other = (t.members || []).filter(function (u) { return u !== me; })[0];
        return { thread_id: id, kind: t.kind, title: t.title || null, region: t.region || null,
          other_id: other || null, other_name: (db.keys[other] || {}).display_name || null,
          other_region: (db.keys[other] || {}).region || null,
          other_area: (db.keys[other] || {}).area || null,
          other_guest: (db.keys[other] || {}).is_guest || false,
          last_at: new Date().toISOString(), unread: t.unread || 0 }; }), error: null });
    }
    if (name === "pm_thread_messages") {
      return Promise.resolve({ data: db.messages.filter(function (m) { return m.thread_id === args.p_thread; })
        .map(function (m) { var w = (db.wraps[m.id] || {})[me];
          return w ? Object.assign({}, m, w) : null; }).filter(Boolean), error: null });
    }
    return Promise.resolve({ data: [], error: null });
  }
  function table() { var b = {};
    ["select","eq","neq","gt","gte","lt","lte","is","or","order","limit","in","match","filter","range"]
      .forEach(function (m) { b[m] = function () { return b; }; });
    b.then = function (r, j) { return Promise.resolve({ data: [], error: null }).then(r, j); };
    return b; }
  return { rpc: rpc, from: table,
    auth: {
      getSession: function () { return Promise.resolve({ data: { session: session }, error: null }); },
      getUser: function () { return Promise.resolve({ data: { user: session && session.user }, error: null }); },
      signInAnonymously: function () { return Promise.resolve({ data: {}, error: null }); },
      signOut: function () { return Promise.resolve({ error: null }); },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
    },
    channel: function () { return { on: function () { return this; }, subscribe: function () { return this; } }; },
    removeChannel: function () {},
    storage: { from: function () { return { getPublicUrl: function () { return { data: { publicUrl: "" } }; } }; } },
  };
} };`;

// An empty P-Message has no rows to overflow and nothing to measure, so the
// audit would pass on a blank screen. Give it the longest realistic content.
async function seedMessages(page) {
  await page.evaluate(async () => {
    const db = window.__PM_DB;
    const me = "audit_admin";
    for (const [id, name, area] of [
      ["a1", "Juma Mwanga wa Nyamagana", "Nyamagana, Mwanza"],
      ["a2", "Neema Kileo", "Ilemela"],
    ]) {
      const kp = await window.PMCrypto.generateIdentity();
      db.keys[id] = { public_key: kp.publicKey, fingerprint: await window.PMCrypto.fingerprint(kp.publicKey),
        display_name: name, region: "Mwanza", area: area, is_agent: true, is_guest: id === "a2" };
    }
    db.threads.t1 = { kind: "direct", members: [me, "a1"], unread: 3 };
    db.threads.t2 = { kind: "broadcast", title: "Huduma itasimama kesho usiku", region: null, members: [me] };

    const mine = window.PMStore.current();
    const long = "Habari ndugu, nimeona tangazo lako la chumba cha Nyamagana. " +
      "Je bado kipo? Naweza kuja kesho asubuhi saa tatu kuangalia.";
    const sealed = await window.PMCrypto.seal({
      threadId: "t1", senderId: me, plaintext: long,
      recipients: [{ userId: me, publicKey: mine.publicKey }, { userId: "a1", publicKey: db.keys.a1.public_key }],
    });
    db.messages.push({ id: "m1", thread_id: "t1", sender_id: me, sender_name: "You",
      iv: sealed.iv, ciphertext: sealed.ciphertext, sent_at: new Date().toISOString() });
    db.wraps.m1 = {};
    sealed.keys.forEach((k) => { db.wraps.m1[k.user_id] = k; });
  });
  await sleep(400);
}

// ---- the measurement, run inside the page for ONE viewport -----------------
// Geometry and colours only, no pixels: sampling the shot is SCORE's job, and
// a second unreachable copy of the colour maths sat here for a while. What is
// read here is read while the text is blanked, immediately before the
// screenshot, so the rects and the shot describe one frozen frame.
const MEASURE = () => {
  const vw = window.innerWidth, vh = window.innerHeight;

  // WHAT IS BEHIND THIS TEXT, ACCORDING TO THE CASCADE.
  // Walk up until something paints an opaque colour. That is the exact answer
  // for the common case — a <span> inside a coloured button, a row inside a
  // card — and it cannot be knocked off by the page having moved between the
  // measurement and the photograph.
  //
  // It gives up, deliberately, the moment it meets a background IMAGE, a
  // gradient or a backdrop-filter: those are unresolvable from computed styles,
  // and they are the whole reason this file samples pixels at all. Returning
  // null hands the element back to the camera.
  const solidBehind = (node) => {
    let el = node;
    while (el && el !== document.documentElement) {
      const s = getComputedStyle(el);
      if (s.backgroundImage && s.backgroundImage !== "none") return null;
      if ((s.backdropFilter && s.backdropFilter !== "none") ||
          (s.webkitBackdropFilter && s.webkitBackdropFilter !== "none")) return null;
      if (Number(s.opacity) < 1) return null;
      const m = String(s.backgroundColor).match(/[\d.]+/g);
      if (m && m.length >= 3 && (m.length < 4 || Number(m[3]) === 1)) return s.backgroundColor;
      el = el.parentElement;
    }
    return null;
  };
  // The scroll position these rects were taken at. The pixels must come from
  // the same one or every background sample is off by the difference.
  const out = { wide: [], contrast: [], taps: [], scrollY: window.scrollY };
  const label = (el) => {
    const id = el.id ? "#" + el.id : "";
    const cls = (el.className && typeof el.className === "string")
      ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    return el.tagName.toLowerCase() + id + cls;
  };
  // A pseudo-element with negative insets IS a hit area — the standard way to
  // grow a touch target without moving the layout — so it counts to the size.
  const hitBox = (el, r) => {
    let grow = 0;
    for (const which of ["::before", "::after"]) {
      const cs = getComputedStyle(el, which);
      if (!cs || cs.content === "none" || cs.position !== "absolute") continue;
      const vals = ["top", "bottom", "left", "right"].map((s) => parseFloat(cs[s]));
      if (vals.some((v) => isNaN(v))) continue;
      const inset = Math.min(...vals);
      if (inset < 0) grow = Math.max(grow, -inset);
    }
    return { w: r.width + grow * 2, h: r.height + grow * 2 };
  };

  document.querySelectorAll("body *").forEach((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) <= 0.05) return;
    if (r.width <= 0 || r.height <= 0) return;
    if (r.bottom < 0 || r.top > vh) return;              // not in this viewport

    if (r.right > vw + 1 && r.width <= vw + 2) {
      let scroller = el.parentElement, inScroller = false;
      while (scroller && scroller !== document.body) {
        const ov = getComputedStyle(scroller).overflowX;
        if (ov === "auto" || ov === "scroll") { inScroller = true; break; }
        scroller = scroller.parentElement;
      }
      if (!inScroller) out.wide.push({ el: label(el), right: Math.round(r.right), vw });
    }

    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3 && n.textContent.trim().length > 1)
      .map((n) => n.textContent.trim()).join(" ");
    // Is this text actually the topmost thing at its own centre? The bottom
    // tab bar is fixed and translucent, so a row scrolled under it was being
    // sampled THROUGH it — a dark green band read as pale green and the audit
    // reported a contrast failure on a band nobody can see anyway.
    const mid = document.elementFromPoint(
      Math.min(vw - 1, Math.max(0, r.left + r.width / 2)),
      Math.min(vh - 1, Math.max(0, r.top + r.height / 2)));
    const onTop = mid && (mid === el || el.contains(mid) || mid.contains(el));
    // Fully inside the viewport, or the sampled box would include the grey
    // beyond the edge of the shot.
    if (own && onTop && r.top >= 0 && r.bottom <= vh) {
      const size = parseFloat(cs.fontSize) || 16;
      const weight = Number(cs.fontWeight) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5;
      out.contrast.push({
        el: label(el), text: own.slice(0, 40), color: cs.color, need, size: Math.round(size),
        // What the CASCADE says is behind these words — null when only the
        // camera can answer. See solidBehind() above and its use in SCORE.
        ownBg: solidBehind(el),
        box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      });
    }

    const tag = el.tagName.toLowerCase();
    const pressable = tag === "button" || tag === "select" ||
      (tag === "a" && el.getAttribute("href")) ||
      (tag === "input" && !["hidden", "text", "search", "password", "email", "number"].includes(el.type));
    if (pressable) {
      const box = hitBox(el, r);
      if (Math.min(box.w, box.h) < 40) {
        out.taps.push({ el: label(el), w: Math.round(box.w), h: Math.round(box.h) });
      }
    }
  });
  return out;
};

// Score the captured candidates against the pixels of the shot.
const SCORE = (items) => {
  const px = window.__AUDIT_PIXELS;
  const lum = (c) => {
    const m = String(c).match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    const [r, g, b] = m.slice(0, 3).map(Number).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const L1 = lum(a), L2 = lum(b);
    if (L1 === null || L2 === null) return null;
    return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  };
  // An element that paints its OWN opaque background does not need the camera:
  // the cascade already knows what is behind its text, exactly, and cannot be
  // thrown off by the page having moved a few pixels between the measurement
  // and the shot. Sampling exists for the hard cases — translucency, gradients,
  // backdrop blur, and text sitting on a background it inherited from an
  // ancestor — and those are precisely the ones where alpha < 1 or the colour
  // is transparent.
  //
  // This was found by an active tab that measured 1.11:1 white-on-cream in the
  // report while its own pixels, sampled at that instant, were the dark green
  // the CSS asked for: a sampling artefact reported as a real failure, which is
  // the one thing a gate must not do.
  const opaqueOwn = (c) => {
    const s = String(c || "");
    if (!s || s === "transparent") return null;
    const m = s.match(/[\d.]+/g);
    if (!m) return null;
    if (m.length >= 4 && Number(m[3]) < 1) return null;   // translucent: sample it
    return s;
  };
  const bgOf = (r) => {
    if (!px) return null;
    const k = px.scale;
    // The middle 60%: a border, a focus ring or the bright edge of a gradient
    // is not what sits behind the words.
    const insetX = (r.right - r.left) * 0.2, insetY = (r.bottom - r.top) * 0.2;
    const x0 = Math.max(0, Math.round((r.left + insetX) * k));
    const y0 = Math.max(0, Math.round((r.top + insetY) * k));
    const x1 = Math.min(px.width - 1, Math.round((r.right - insetX) * k));
    const y1 = Math.min(px.height - 1, Math.round((r.bottom - insetY) * k));
    if (x1 <= x0 || y1 <= y0) return null;
    const rs = [], gs = [], bs = [];
    const stepX = Math.max(1, Math.floor((x1 - x0) / 12));
    const stepY = Math.max(1, Math.floor((y1 - y0) / 6));
    for (let y = y0; y <= y1; y += stepY) {
      for (let x = x0; x <= x1; x += stepX) {
        const i = (y * px.width + x) * 4;
        rs.push(px.data[i]); gs.push(px.data[i + 1]); bs.push(px.data[i + 2]);
      }
    }
    if (!rs.length) return null;
    const mid = (a) => { a.sort((m, n) => m - n); return a[Math.floor(a.length / 2)]; };
    return `rgb(${mid(rs)}, ${mid(gs)}, ${mid(bs)})`;
  };
  return items.map((it) => {
    const bg = opaqueOwn(it.ownBg) || bgOf(it.box);
    const cr = bg ? ratio(it.color, bg) : null;
    return (cr !== null && cr < it.need)
      ? { el: it.el, text: it.text, color: it.color, bg, need: it.need, size: it.size,
          ratio: Math.round(cr * 100) / 100 }
      : null;
  }).filter(Boolean);
};

// Hold until the page stops moving: the scroll position AND the document
// height unchanged across four frames. A fixed sleep guessed at this and lost
// on slower pages, where the feed was still growing when the shot was taken.
const SETTLE = async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  let still = 0, lastY = -1, lastH = -1;
  for (let i = 0; i < 90 && still < 4; i++) {
    await frame();
    const y = window.scrollY, h = document.documentElement.scrollHeight;
    still = (y === lastY && h === lastH) ? still + 1 : 0;
    lastY = y; lastH = h;
  }
};
const LOAD_PIXELS = async (b64) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b64; });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  window.__AUDIT_PIXELS = {
    width: c.width, height: c.height,
    data: ctx.getImageData(0, 0, c.width, c.height).data,
    scale: c.width / window.innerWidth,
  };
};

// ---- driver ----------------------------------------------------------------
const only = process.argv[2];
const pages = only ? PAGES.filter((p) => p.file.includes(only)) : PAGES;

const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 180000,
});
try {
  for (const spec of pages) {
    for (const theme of ["dark", "light"]) {
      for (const dev of DEVICES) {
        const page = await browser.newPage();
        await page.setViewport({ width: dev.w, height: dev.h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        await page.setRequestInterception(true);
        page.on("request", (req) => {
          const url = req.url();
          if (req.method() === "OPTIONS") {
            return req.respond({ status: 204, headers: {
              "access-control-allow-origin": "*", "access-control-allow-headers": "*",
              "access-control-allow-methods": "*" } });
          }
          if (/cdn\.jsdelivr\.net.*supabase/.test(url)) {
            return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: stub(spec.session) });
          }
          if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)) {
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
        await page.evaluateOnNewDocument((t, k) => {
          try {
            localStorage.setItem("pawa-theme", t);
            if (k) localStorage.setItem("pm-identity-v1", k);
          } catch (_) {}
        }, theme, spec.key ? JSON.stringify({ publicKey: "x", privateKey: "y" }) : null);

        await page.goto(`${BASE}/${spec.file}`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        await sleep(1800);
        if (spec.prep) await spec.prep(page).catch(() => {});

        await page.addStyleTag({ content:
          // -webkit-text-fill-color, NOT color: the glyphs go invisible for the
          // screenshot but getComputedStyle().color still reports what the author
          // wrote. Blanking `color` made every element report rgba(0,0,0,0) as its
          // own text colour, so every contrast reading was of transparent-on-…
          // — a whole page of invented failures with no real one among them.
          ".audit-hide *, .audit-hide { -webkit-text-fill-color: transparent !important; " +
          "text-shadow: none !important; } " +
          // Deterministic shots. Without this the spinning ring on the feedback
          // pill lands on a different colour every run, and a colour caught
          // mid-transition reads as rgba(0,0,0,0).
          // overflow-anchor: Chrome re-adjusts the scroll position when content
          // above the viewport changes size, which is what moved the page between
          // the measurement and the shot.
          "*, *::before, *::after { animation: none !important; transition: none !important; " +
          "overflow-anchor: none !important; }" });

        const where = `${spec.label} · ${theme} · ${dev.name} (${dev.w}px)`;
        const seen = new Set();
        const all = { wide: [], contrast: [], taps: [] };
        const geom = await page.evaluate(() => ({
          docH: document.documentElement.scrollHeight,
          vh: window.innerHeight,
          vw: window.innerWidth,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
        }));
        ok(geom.overflow <= 1, `${where}: page is ${geom.overflow}px wider than the screen`);
        // AND the screen has to be the screen. When something does not fit,
        // a phone does not clip it — it widens the layout viewport and renders
        // the whole page shrunk, which the overflow check above cannot see
        // because it compares against the ALREADY-widened viewport. Four of
        // these pages were being served at 91% and reporting no overflow.
        ok(geom.vw <= dev.w + 1,
           `${where}: laid out ${geom.vw}px wide, so the page is zoomed out to ${Math.round(dev.w / geom.vw * 100)}% to fit`);

        // One viewport at a time, capped so a very long feed does not turn a
        // single check into a hundred screenshots.
        for (let y = 0, step = 0; y < geom.docH && step < 6; y += geom.vh, step++) {
          // Rects and pixels have to describe ONE frame. A lazy image finishing,
          // or the feed appending a row, moves the page under the measurement —
          // it drifted 26px on the homepage and every background read after that
          // point belonged to a different band than the text it was scored
          // against. So: settle, measure, shoot, then check the page did not
          // move, and throw the frame away and take it again if it did.
          let part = null;
          for (let tryN = 0; tryN < 3; tryN++) {
            await page.evaluate((yy) => window.scrollTo(0, yy), y);
            await page.evaluate(SETTLE);
            await page.evaluate(() => { document.body.classList.add("audit-hide"); });
            await sleep(80);
            const cand = await page.evaluate(MEASURE);
            const shot = await page.screenshot({ encoding: "base64" });
            const movedBy = await page.evaluate((was) => window.scrollY - was, cand.scrollY);
            if (movedBy !== 0 && tryN < 2) {
              await page.evaluate(() => { document.body.classList.remove("audit-hide"); });
              await sleep(300);
              continue;
            }
            await page.evaluate(LOAD_PIXELS, shot);
            cand.contrast = await page.evaluate(SCORE, cand.contrast);
            await page.evaluate(() => { document.body.classList.remove("audit-hide"); });
            ok(movedBy === 0, `${where}: page moved ${movedBy}px between the measurement and the shot`);
            part = cand;
            break;
          }
          for (const kind of ["wide", "contrast", "taps"]) {
            for (const item of part[kind]) {
              const key = kind + "|" + item.el + "|" + (item.text || "");
              if (seen.has(key)) continue;
              seen.add(key);
              all[kind].push(item);
            }
          }
        }

        ok(all.wide.length === 0, `${where}: ${all.wide.length} element(s) past the right edge`,
           all.wide.slice(0, 4).map((w) => `${w.el} ends at ${w.right} of ${w.vw}`).join("\n        "));
        ok(all.contrast.length === 0, `${where}: ${all.contrast.length} low-contrast text`,
           all.contrast.slice(0, 8).map((c) =>
             `${c.ratio}:1 (needs ${c.need}) ${c.el} ${c.size}px "${c.text}" ${c.color} on ${c.bg}`).join("\n        "));
        ok(all.taps.length === 0, `${where}: ${all.taps.length} tap target(s) under 40px`,
           all.taps.slice(0, 20).map((t) => `${t.el} ${t.w}x${t.h}`).join("\n        "));

        await page.close();
      }
    }
    process.stdout.write(`  checked ${spec.label}\n`);
  }
} finally {
  await browser.close();
}

if (findings.length) {
  process.stdout.write("\nFINDINGS\n");
  findings.forEach((f) => process.stdout.write("  · " + f + "\n"));
}
process.stdout.write(`\n${pass} checks passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
