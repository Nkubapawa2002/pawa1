// ============================================================================
// i18n_coverage.mjs — find the English left behind on a page set to Swahili.
//
// The app ships two languages, and every page carries SOME data-i18n. That is
// what makes an untranslated string hard to see: the title translates, the
// heading translates, and the control you actually have to use is still in
// English. Nobody notices, because whoever reads the page reads English.
//
// So this asks the page itself. It loads with lang=sw and walks every element
// that renders text of its own, skipping the things that are legitimately the
// same in both languages:
//
//   · anything under a [data-i18n*] element (already handled)
//   · proper nouns and data from the database (listing titles, place names)
//   · numbers, prices, distances, codes, punctuation, emoji
//   · text a person never sees (script, style, hidden, aria-hidden)
//
// What is left is a string somebody has to translate. It reports each one with
// the selector that finds it, so the fix is mechanical.
//
//   usage:  node server.js      then, in another shell:
//           node tests/i18n_coverage.mjs                 (every P-Chat door)
//           node tests/i18n_coverage.mjs near-me.html    (just one)
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";

// The seven P-Chat destinations, plus the tab itself — and P-Message, which
// was missing here while 129 of its strings ran on their English fallback with
// no Swahili at all. A coverage checker that does not look at a page cannot
// report anything about it, and a page nobody checks is where the untranslated
// strings collect.
const PAGES = process.argv[2] ? [process.argv[2]] : [
  // The home screen, which was missing from this list while carrying the three
  // bands whose every string is new. It is the first page anybody sees.
  "index.html",
  "p-chat.html",
  "p-message.html",
  // An agent's storefront draws almost everything from JS, so its untranslated
  // strings would never show up in a scan of the markup alone — which is
  // exactly why it belongs on this list rather than being assumed fine.
  "agent.html",
  "profile.html",
  "houses.html?alert=1",
  "near-me.html",
  "area.html",
  "frame.html",
  "meet.html",
  "share-location.html",
  "jobs.html",
  // The three catalogues. They were missing from this list, which is exactly
  // why services.html's whole filter toolbar was still hardcoded English: no
  // scan ever looked at it. houses.html appears twice on purpose — once with
  // ?alert=1 for the area-alert sheet, and once plain for the directory
  // itself, because they are different screens behind one file.
  "houses.html",
  "trucks.html",
  "services.html",
];

// Words that are the same in Swahili, or are not words at all. Kept small and
// explicit — a big allowlist is how a checker stops finding anything.
const SAME_IN_BOTH = new Set([
  "gps", "ai", "sms", "whatsapp", "email", "e-mail", "gb", "mb", "km", "kg", "tzs", "usd",
  "ok", "app", "pdf", "url", "id", "pin", "wifi", "sim", "qr", "pawa", "p-chat", "p-message",
  "google", "facebook", "instagram", "twitter", "x", "tiktok", "youtube", "supabase",
]);

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

let total = 0;
const report = [];

for (const path of PAGES) {
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 1, isMobile: true });
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
    if (/supabase\.co|nominatim|locationiq|router\.project-osrm|overpass/.test(url)) {
      return req.respond({ status: 200, headers: {
        "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
    }
    req.continue();
  });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem("lang", "sw"); } catch (_) {} });
  await page.goto(`${BASE}/${path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2000));

  const found = await page.evaluate((sameInBoth) => {
    const same = new Set(sameInBoth);

    // Text a person can actually read on this page right now.
    function visible(el) {
      if (!el || !el.getClientRects) return false;
      if (el.closest("[aria-hidden=true]")) return false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      return true;
    }

    // A short, stable way to point at the offending element.
    function where(el) {
      if (el.id) return "#" + el.id;
      const cls = (el.className && typeof el.className === "string")
        ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
      return el.tagName.toLowerCase() + cls;
    }

    const hits = [];
    const seen = new Set();
    const skipTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "PATH", "CODE", "PRE"]);

    document.querySelectorAll("*").forEach((el) => {
      if (skipTags.has(el.tagName)) return;
      if (el.closest("[data-i18n],[data-i18n-html]")) return;   // already handled
      if (!visible(el)) return;

      // Only the element's OWN text, so a wrapper is not blamed for its child.
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      const candidates = [];
      if (own) candidates.push(["text", own]);
      // Attributes a person reads, which need their own i18n hook.
      const ph = el.getAttribute && el.getAttribute("placeholder");
      if (ph && !el.hasAttribute("data-i18n-placeholder")) candidates.push(["placeholder", ph]);
      const ttl = el.getAttribute && el.getAttribute("title");
      if (ttl && !el.hasAttribute("data-i18n-title")) candidates.push(["title", ttl]);
      const al = el.getAttribute && el.getAttribute("aria-label");
      if (al && !el.hasAttribute("data-i18n-aria-label")) candidates.push(["aria-label", al]);

      for (const [kind, raw] of candidates) {
        const s = raw.trim();
        if (s.length < 4) continue;                       // "OK", "×", "3 km"
        if (!/[A-Za-z]/.test(s)) continue;                // numbers/punctuation/emoji
        if (/^[\d\s.,:/+×·—–-]+$/.test(s)) continue;
        // Words that carry the judgement. Data from the database (place names,
        // listing titles) is usually one or two capitalised words; a SENTENCE
        // with a lowercase function word is almost always UI copy.
        const words = s.toLowerCase().match(/[a-z][a-z'-]{1,}/g) || [];
        const meaningful = words.filter((w) => !same.has(w));
        if (meaningful.length < 2) continue;
        // English function words are the giveaway that this is a sentence we
        // wrote, not a proper noun that came out of the database.
        const FUNC = /\b(the|a|an|and|or|of|to|in|on|for|with|your|you|we|is|are|it|this|that|from|by|at|near|show|use|within|any|all|only|more|less|see|tap|get|set|add|find|open|send|share|save|start|stop|pick|choose|enter|type|search|help|about|what|when|where|how|why|who)\b/;
        if (!FUNC.test(s.toLowerCase())) continue;
        const key = kind + "|" + s;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ kind, text: s.slice(0, 96), at: where(el) });
      }
    });
    return hits;
  }, [...SAME_IN_BOTH]);

  total += found.length;
  report.push({ path, found });
  await page.close();
}

await browser.close();

for (const { path, found } of report) {
  process.stdout.write(`\n${path} — ${found.length} untranslated\n`);
  found.slice(0, 40).forEach((f) => {
    process.stdout.write(`  ${f.kind.padEnd(11)} ${f.at.padEnd(24)} ${JSON.stringify(f.text)}\n`);
  });
  if (found.length > 40) process.stdout.write(`  … and ${found.length - 40} more\n`);
}
process.stdout.write(`\n${total} untranslated strings across ${report.length} pages\n`);
process.exit(0);
