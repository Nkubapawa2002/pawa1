// ============================================================================
// profile_page_test.mjs — the Profile tab, in a real browser.
//
// Profile has three states and the whole point of the page is that they differ
// honestly:
//
//   signed out  says there is nothing here yet, and offers BOTH ways in
//   guest       says what a guest session costs, before it costs it
//   signed in   the account, the key, the listings, the settings
//
// The traps worth testing are the ones where a state shows something it should
// not: listing portals offered to a guest (the database refuses them), or an
// encryption section for somebody who has no key.
//
//   usage:  node server.js      then, in another shell:
//           node tests/profile_page_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};
const section = (s) => process.stdout.write("\n" + s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stub = (session) => `
window.__PM_SENT = [];
window.supabase = { createClient: function () {
  var session = ${JSON.stringify(session)};
  function builder() { var b = {};
    ["select","eq","neq","gt","gte","lt","lte","in","is","or","filter","order","limit","range","match"]
      .forEach(function (m) { b[m] = function () { return b; }; });
    b.then = function (r, j) { return Promise.resolve({ data: [], error: null }).then(r, j); };
    return b; }
  return {
    from: builder,
    rpc: function (name, args) {
      window.__PM_SENT.push({ name: name, args: args });
      return Promise.resolve({ data: [], error: null });
    },
    auth: {
      getSession: function () { return Promise.resolve({ data: { session: session }, error: null }); },
      getUser: function () { return Promise.resolve({ data: { user: session && session.user }, error: null }); },
      signOut: function () { session = null; return Promise.resolve({ error: null }); },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
    },
    channel: function () { return { on: function () { return this; }, subscribe: function () { return this; } }; },
    removeChannel: function () {},
    storage: { from: function () { return { getPublicUrl: function () { return { data: { publicUrl: "" } }; } }; } },
  };
} };`;

const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
});

async function openProfile(session, opts) {
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
      return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: stub(session) });
    }
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    if (/supabase\.co/.test(url)) {
      return req.respond({ status: 200, headers: {
        "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
    }
    req.continue();
  });
  // A key on the device is what makes the encryption section appear, so it is
  // planted (or not) before the page runs, exactly as P-Message would leave it.
  if (opts && opts.withKey) {
    await page.evaluateOnNewDocument((k) => {
      try { localStorage.setItem("pm-identity-v1", k); } catch (_) {}
    }, JSON.stringify(opts.withKey));
  }
  await page.goto(`${BASE}/profile.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(1300);
  return { page, errs };
}

const rows = (page) => page.$$eval(".ha-find-card", (n) => n.map((r) => ({
  title: (r.querySelector(".ha-find-t") || {}).textContent.trim(),
  href: r.getAttribute("href") || "",
  act: r.dataset.act || "",
  value: (r.querySelector(".pf-val") || {}).textContent || "",
})));
const groups = (page) => page.$$eval(".pf-group-h", (n) => n.map((h) => h.textContent.trim()));

// A real keypair, generated the way the app generates one, so the safety
// number on screen is a genuine digest rather than a fixture string.
const KEYPAIR = await (async () => {
  const { webcrypto } = await import("node:crypto");
  const pair = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return {
    publicKey: b64u(await webcrypto.subtle.exportKey("spki", pair.publicKey)),
    privateKey: b64u(await webcrypto.subtle.exportKey("pkcs8", pair.privateKey)),
  };
})();

try {
  section("1. Signed out");
  {
    const { page, errs } = await openProfile(null);
    ok(/Not signed in/i.test(await page.$eval("#pfWho", (n) => n.textContent)),
       "says so rather than pretending to be somebody");
    const acts = await page.$$eval(".pf-acts a", (n) => n.map((a) => a.getAttribute("href")));
    ok(acts.includes("login.html"), "offers signing in");
    ok(acts.includes("p-message.html"),
       "and offers a guest chat beside it — the account is not the only way in", JSON.stringify(acts));
    const g = await groups(page);
    ok(!g.some((x) => /encryption key/i.test(x)),
       "no encryption section for somebody who has no key", JSON.stringify(g));
    ok(!g.some((x) => /Your listings/i.test(x)), "and no listing portals");
    ok(errs.length === 0, "no page errors", errs.slice(0, 3).join("\n        "));
    await page.close();
  }

  section("2. A guest");
  {
    const { page, errs } = await openProfile(
      { user: { id: "guest_1", email: null, is_anonymous: true } }, { withKey: KEYPAIR });
    ok(/Guest/i.test(await page.$eval("#pfName", (n) => n.textContent)), "is named as one");
    ok(/this device only/i.test(await page.$eval("#pfWho", (n) => n.textContent)),
       "with the catch stated in the header", await page.$eval("#pfWho", (n) => n.textContent));
    const warn = await page.$eval(".pf-note.warn", (n) => n.textContent);
    ok(/clearing it|another phone/i.test(warn),
       "and spelled out before it costs anything", warn.slice(0, 90));

    const g = await groups(page);
    ok(!g.some((x) => /Your listings/i.test(x)),
       "a guest is NOT offered the listing portals — the database refuses them, so the door would not open",
       JSON.stringify(g));
    ok(g.some((x) => /encryption key/i.test(x)),
       "but does get their encryption key, because a guest's chat is encrypted like anyone's");

    const r = await rows(page);
    const out = r.find((x) => x.act === "signout");
    ok(out && /guest session/i.test(out.title),
       "and signing out is described as ending the session, not leaving an account", out && out.title);
    ok(errs.length === 0, "no page errors", errs.slice(0, 3).join("\n        "));
    await page.close();
  }

  section("3. A signed-in agent");
  {
    const { page, errs } = await openProfile(
      { user: { id: "agent_1", email: "agent@example.com", is_anonymous: false } }, { withKey: KEYPAIR });
    ok(/agent/i.test(await page.$eval("#pfName", (n) => n.textContent)), "is named from their account");
    ok(/agent@example.com/.test(await page.$eval("#pfWho", (n) => n.textContent)), "with their email");

    const r = await rows(page);
    const hrefs = r.map((x) => x.href).filter(Boolean);
    ["p-message.html", "favorites.html", "agent-houses.html", "agent-services.html", "agent-trucks.html"]
      .forEach((h) => ok(hrefs.includes(h), `links to ${h}`, JSON.stringify(hrefs)));
    ok(new Set(hrefs).size === hrefs.length, "and no destination appears twice", JSON.stringify(hrefs));

    const fp = r.find((x) => x.act === "fingerprint");
    ok(fp && /\d{5}( \d{5}){5}/.test(fp.value),
       "the safety number is read from the key already on the device", fp && fp.value);
    ok(r.some((x) => x.act === "backup") && r.some((x) => x.act === "restore"),
       "with backup and restore beside it");

    // Profile must never CREATE a key: publishing one would advertise somebody
    // as reachable on P-Message when they never opened it.
    const published = await page.evaluate(() => (window.__PM_SENT || []).map((c) => c.name));
    ok(published.filter((n) => n === "pm_publish_key").length <= 1,
       "it republishes the existing key at most once, and never mints a new one", JSON.stringify(published));

    ok(!(await groups(page)).some((x) => /^Admin$/i.test(x)), "a non-admin sees no admin section");
    ok(errs.length === 0, "no page errors", errs.slice(0, 3).join("\n        "));

    section("4. The key dialogs are the shared ones");
    await page.evaluate(() => document.querySelector('[data-act="fingerprint"]').click());
    await sleep(400);
    ok(await page.$eval("#pfModalBack", (n) => n.classList.contains("is-on")), "the safety-number dialog opens");
    const big = await page.$eval(".pm-big-fp", (n) => n.textContent.trim());
    ok(/\d{5}( \d{5}){5}/.test(big), "showing the full thirty digits, not a truncation", big);
    ok(await page.$eval(".pm-modal", (n) => getComputedStyle(n).backgroundColor !== "rgba(0, 0, 0, 0)"),
       "and it is styled — css/pm-identity.css travelled with the library");
    await page.evaluate(() => document.getElementById("pmFpOk").click());
    await sleep(250);
    ok(!(await page.$eval("#pfModalBack", (n) => n.classList.contains("is-on"))), "and closes");

    await page.evaluate(() => document.querySelector('[data-act="backup"]').click());
    await sleep(400);
    ok(await page.$("#pmBkPass") !== null, "the backup dialog is here too, from the same library");
    await page.type("#pmBkPass", "a long enough passphrase");
    await page.click("#pmBkMake");
    await sleep(900);
    const code = await page.$eval(".pm-code", (n) => n.textContent.trim());
    ok(code.startsWith("PM1."), "and it really produces a backup code", code.slice(0, 16) + "…");
    ok(!code.includes(KEYPAIR.privateKey.slice(0, 24)),
       "with the private key encrypted inside it, not sitting in the open");
    await page.close();
  }

  section("5. An admin");
  {
    const { page } = await openProfile(
      { user: { id: "admin_1", email: "pawa4761@gmail.com", is_anonymous: false } }, { withKey: KEYPAIR });
    ok((await groups(page)).some((x) => /^Admin$/i.test(x)), "gets the admin section");
    const hrefs = (await rows(page)).map((x) => x.href);
    ok(hrefs.includes("admin.html") && hrefs.includes("super-admin.html"), "with both consoles");
    ok(/Admin/.test(await page.$eval("#pfName", (n) => n.textContent)), "and is badged as one");
    await page.close();
  }

  section("6. Settings");
  {
    const { page } = await openProfile(
      { user: { id: "u1", email: "someone@example.com", is_anonymous: false } });
    const r = await rows(page);
    const lang = r.find((x) => x.act === "lang");
    const theme = r.find((x) => x.act === "theme");
    ok(lang && /English|Kiswahili/.test(lang.value), "language shows the current choice", lang && lang.value);
    ok(theme && /Dark|Light/.test(theme.value), "so does appearance", theme && theme.value);

    await page.evaluate(() => document.querySelector('[data-act="theme"]').click());
    await sleep(400);
    ok(await page.evaluate(() => document.documentElement.getAttribute("data-theme")) === "light",
       "tapping appearance really switches the theme");
    const after = (await rows(page)).find((x) => x.act === "theme");
    ok(after && /Light/i.test(after.value), "and the row updates to match", after && after.value);

    // The floating toggle is a second way to change the theme, so the row has
    // to follow it rather than only its own tap.
    await page.evaluate(() => window.PawaTheme.set("dark"));
    await sleep(400);
    const back = (await rows(page)).find((x) => x.act === "theme");
    ok(back && /Dark/i.test(back.value),
       "and follows the floating theme toggle too, instead of going stale", back && back.value);

    if (process.argv.includes("--shot")) {
      await sleep(200);
      await page.screenshot({ path: "tests/shot_profile.png", fullPage: true });
      process.stdout.write("  (screenshot written)\n");
    }
    await page.close();
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
} finally {
  await browser.close();
}
process.exit(fail === 0 ? 0 : 1);
