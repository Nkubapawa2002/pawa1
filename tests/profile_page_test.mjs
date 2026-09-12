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

// `inAdminsTable` is the DATABASE's answer, which is a different question from
// "is this address on the allowlist in config.js". Profile now asks the
// database (Auth.isDbAdmin reads the RLS-protected `admins` table) because the
// allowlist ships to every browser and can be edited in one. The stub has to
// model both or it cannot tell the two apart, which is the whole point.
// `card` is what pm_agent_card() answers for THIS user: the same row, from the
// same call, that agent.html draws a customer's view of. Profile now renders
// the storefront rather than linking to it, so the stub has to be able to hand
// it one, and to hand it nothing (a person with no key yet) as well.
const stub = (session, inAdminsTable, card) => `
window.__PM_SENT = [];
window.supabase = { createClient: function () {
  var session = ${JSON.stringify(session)};
  var inAdmins = ${JSON.stringify(!!inAdminsTable)};
  var CARD = ${JSON.stringify(card || null)};
  function order(step) {
    try {
      var o = JSON.parse(sessionStorage.getItem("__order") || "[]");
      o.push(step);
      sessionStorage.setItem("__order", JSON.stringify(o));
    } catch (e) {}
  }
  function builder(table) { var b = {};
    ["select","eq","neq","gt","gte","lt","lte","in","is","or","filter","order","limit","range","match"]
      .forEach(function (m) { b[m] = function () { return b; }; });
    b.then = function (r, j) {
      // RLS: an admin sees a row here, everybody else sees an empty set.
      var rows = (table === "admins" && inAdmins) ? [{ email: session.user.email }] : [];
      return Promise.resolve({ data: rows, error: null }).then(r, j);
    };
    return b; }
  return {
    from: builder,
    rpc: function (name, args) {
      window.__PM_SENT.push({ name: name, args: args });
      // Survives the redirect that ends a guest session. Without this the
      // assertions read the call log of index.html, which is a different page
      // with a different array.
      try {
        var log = JSON.parse(sessionStorage.getItem("__rpc") || "[]");
        log.push({ name: name, args: args });
        sessionStorage.setItem("__rpc", JSON.stringify(log));
      } catch (e) {}
      // The real function returns a one-row table, so the stub does too: a
      // page that read rows[0] wrongly would pass against a bare object.
      if (name === "pm_agent_card") {
        return Promise.resolve({ data: CARD ? [CARD] : [], error: null });
      }
      // Ending a guest session removes the guest on the SERVER as well. The
      // stub reports what the real function returns so the page can be checked
      // for calling it, and for calling it before it signs out.
      if (name === "account_footprint") {
        return Promise.resolve({ data: {
          houses: 2, services: 1, trucks: 0, jobs: 0,
          requests: 3, tenancies: 0, threads: 4, messages: 9, has_key: true,
        }, error: null });
      }
      if (name === "account_erase") {
        order("erase");
        return Promise.resolve({ data: { houses: 2, services: 1 }, error: null });
      }
      if (name === "pm_guest_forget") {
        order("forget");
        return Promise.resolve({ data: { threads: 2, messages: 0 }, error: null });
      }
      return Promise.resolve({ data: [], error: null });
    },
    auth: {
      getSession: function () { return Promise.resolve({ data: { session: session }, error: null }); },
      getUser: function () { return Promise.resolve({ data: { user: session && session.user }, error: null }); },
      signOut: function () {
        order("signout");
        session = null; return Promise.resolve({ error: null });
      },
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
  const inAdminsTable = !!(opts && opts.inAdminsTable);
  // "missing" is the DEFAULT on purpose: supabase/functions/delete-account
  // has to be deployed by hand, so an app in the wild meets a 404 here until
  // somebody runs the CLI. The fallback that 404 triggers is the path most
  // installs will actually take, so it is the one the suite exercises first.
  const edge = (opts && opts.edge) || "missing";
  const card = (opts && opts.card) || null;
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
      return req.respond({ status: 200, headers: { "content-type": "application/javascript" },
                           body: stub(session, inAdminsTable, card) });
    }
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    // The Edge Function is a different thing from the REST host and has to be
    // answerable separately. Without this branch it falls into the catch-all
    // below, which answers 200 to everything — so a 404 could never be tested
    // and the fallback path would look like it was never taken.
    if (/functions\/v1\/delete-account/.test(url)) {
      return req.respond({
        status: edge === "ok" ? 200 : 404,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: JSON.stringify(edge === "ok"
          ? { ok: true, erased: { houses: 1 }, files: 0 }
          : { error: "not_found" }),
      });
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

    // THE SAFETY NUMBER IS A DOOR ON THIS SCREEN, NOT A DISPLAY.
    //
    // It has been three shapes here. A row with the digits in the value slot,
    // which drew them at 11px and half opacity. Then the full 3x2 card with a
    // QR code and three buttons, which fixed that and introduced the opposite
    // problem: the loudest object on a screen of quiet settings, present on
    // every visit whether or not anybody was comparing anything.
    //
    // Comparing is the feature, so the digits live where the comparing happens
    // — the verify dialog, which shows yours and theirs together and records a
    // verdict. These assertions are the ones that fail if a later edit decides
    // Profile should print them again.
    const onPage = await page.evaluate(() => ({
      card:   !!document.getElementById("pfSafety"),
      digits: !!document.querySelector("#pfMain .pm-big-fp"),
      qr:     !!document.querySelector("#pfMain [data-pms-qr]"),
      // Thirty digits in any shape, anywhere a person can read them.
      loose:  /\d{5}[\s-]?\d{5}[\s-]?\d{5}/.test(document.getElementById("pfMain").innerText),
    }));
    ok(!onPage.card && !onPage.digits, "no safety-number card is drawn on Profile", JSON.stringify(onPage));
    ok(!onPage.qr, "and no QR code either, which is the same number in another alphabet");
    ok(!onPage.loose, "nor thirty digits loose anywhere else on the screen", JSON.stringify(onPage));
    ok(r.some((x) => x.act === "safety"), "there is one row that opens the dialog instead");
    ok(r.some((x) => x.act === "backup") && r.some((x) => x.act === "restore"),
       "with backup and restore beside it");
    ok(!r.some((x) => x.act === "fingerprint"),
       "and no leftover row trying to print thirty digits in the value slot");

    // Profile must never CREATE a key: publishing one would advertise somebody
    // as reachable on P-Message when they never opened it.
    const published = await page.evaluate(() => (window.__PM_SENT || []).map((c) => c.name));
    ok(published.filter((n) => n === "pm_publish_key").length <= 1,
       "it republishes the existing key at most once, and never mints a new one", JSON.stringify(published));

    ok(!(await groups(page)).some((x) => /^Admin$/i.test(x)), "a non-admin sees no admin section");
    ok(errs.length === 0, "no page errors", errs.slice(0, 3).join("\n        "));

    section("4. The key dialogs are the shared ones");
    await page.evaluate(() => document.querySelector('[data-act="safety"]').click());
    await sleep(400);
    ok(await page.$eval("#pfModalBack", (n) => n.classList.contains("is-on")), "the safety-number dialog opens");
    const big = await page.$eval("#pfModal .pm-big-fp", (n) => n.textContent.trim());
    ok(/\d{5}( \d{5}){5}/.test(big), "showing the full thirty digits, not a truncation", big);
    // The one rendering, still shared: the row on Profile changed, pm-safety.js
    // did not, and the dialog is still where the QR for the other phone's
    // camera comes from.
    const shared = await page.evaluate(() => {
      const num = document.querySelector("#pfModal .pm-big-fp");
      const cs = num && getComputedStyle(num);
      return { cells: num ? num.querySelectorAll("span").length : 0,
               cols: cs ? cs.gridTemplateColumns.split(" ").length : 0,
               size: cs ? parseFloat(cs.fontSize) : 0 };
    });
    ok(shared.cells === 6 && shared.cols === 3,
       "laid out as six groups over three columns, the same shape both phones see",
       JSON.stringify(shared));
    ok(shared.size >= 14, "at a size somebody can read out loud", shared.size + "px");
    ok(await page.$eval(".pm-modal", (n) => getComputedStyle(n).backgroundColor !== "rgba(0, 0, 0, 0)"),
       "and it is styled — css/pm-identity.css travelled with the library");
    await page.evaluate(() => document.getElementById("pmFpOk").click());
    await sleep(250);
    ok(!(await page.$eval("#pfModalBack", (n) => n.classList.contains("is-on"))), "and closes");

    // The backup flow is three steps now, one job each. It used to be a single
    // box that printed a hundred characters of base64 with no way to copy them
    // and no way to tell whether you had actually saved anything.
    await page.evaluate(() => document.querySelector('[data-act="backup"]').click());
    await sleep(400);
    ok(await page.$("#pmBkPass") !== null, "the backup dialog is here too, from the same library");
    ok(/1 of 3/i.test(await page.$eval(".pm-steps-n", (n) => n.textContent)),
       "and it says which step it is on, so the middle is not mistaken for a loop");
    ok(await page.$eval("#pmBkMake", (n) => n.disabled),
       "nothing can be created before there is a passphrase to seal it with");

    // Typed twice, because a passphrase mistyped once produces a backup that
    // looks complete and can never be opened by anybody.
    await page.type("#pmBkPass", "a long enough passphrase");
    await sleep(150);
    ok(await page.$eval("#pmBkMake", (n) => n.disabled),
       "and not before it has been confirmed");
    await page.type("#pmBkPass2", "a long enough passphraze");
    await sleep(200);
    ok(/do not match/i.test(await page.$eval("#pmBkMsg", (n) => n.textContent)),
       "a mismatch is caught while it is still being typed, not after the code exists");

    await page.evaluate(() => { document.getElementById("pmBkPass2").value = ""; });
    await page.type("#pmBkPass2", "a long enough passphrase");
    await sleep(200);
    ok(!(await page.$eval("#pmBkMake", (n) => n.disabled)), "matching unlocks it");

    await page.click("#pmBkMake");
    await sleep(1200);
    const code = await page.$eval(".pm-code", (n) => n.textContent.trim());
    ok(code.startsWith("PM1."), "and it really produces a backup code", code.slice(0, 16) + "…");
    ok(!code.includes(KEYPAIR.privateKey.slice(0, 24)),
       "with the private key encrypted inside it, not sitting in the open");

    // The step that did not exist. Without it the code could only be taken off
    // the screen by selecting a hundred characters of base64 with a thumb.
    ok(await page.$("#pmBkCopy") !== null, "there is a way to copy it");
    ok(await page.$("#pmBkFile") !== null,
       "and a way to save it as a file, which survives the browser being cleared");
    ok(await page.$eval(".pm-code", (n) => getComputedStyle(n).userSelect === "all"),
       "and it can still be selected by hand where the clipboard is refused");

    await page.evaluate(() => document.getElementById("pmBkNext").click());
    await sleep(300);
    ok(/saved it/i.test(await page.$eval("#pfModal h2", (n) => n.textContent)),
       "the last step asks whether it was actually saved");
    ok(await page.$("#pmBkBack") !== null,
       "with the code one tap away, so answering honestly costs nothing");
    await page.close();
  }

  section("5. An admin");
  {
    const { page } = await openProfile(
      { user: { id: "admin_1", email: "pawa4761@gmail.com", is_anonymous: false } },
      { withKey: KEYPAIR, inAdminsTable: true });
    ok((await groups(page)).some((x) => /^Admin$/i.test(x)), "gets the admin section");
    const hrefs = (await rows(page)).map((x) => x.href);
    ok(hrefs.includes("admin.html") && hrefs.includes("super-admin.html"), "with both consoles");
    ok(/Admin/.test(await page.$eval("#pfName", (n) => n.textContent)), "and is badged as one");
    await page.close();
  }

  section("5b. An allowlisted address the database does not back");
  {
    // The allowlist in config.js ships to every browser and can be edited in
    // one. It is the weaker of the two checks, and on its own it is not an
    // answer: the `admins` table is. Same address as above, no row behind it.
    const { page } = await openProfile(
      { user: { id: "admin_1", email: "pawa4761@gmail.com", is_anonymous: false } },
      { withKey: KEYPAIR, inAdminsTable: false });
    const g = await groups(page);
    ok(!g.some((x) => /^Admin$/i.test(x)),
       "gets no admin section on the allowlist alone", JSON.stringify(g));
    const hrefs = (await rows(page)).map((x) => x.href);
    ok(!hrefs.includes("admin.html") && !hrefs.includes("super-admin.html"),
       "and no link to either console", hrefs.filter(Boolean).join(" "));
    ok(!/Admin/.test(await page.$eval("#pfName", (n) => n.textContent)),
       "and is not badged as one");
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

  // ==========================================================================
  section("7. Your public page is the page, not a link to it");
  // ==========================================================================
  // The row that used to sit here read "Your public page ›" and said nothing
  // about the state of the thing behind it. An agent has one reason to open
  // their own storefront, which is to find out whether it is any good, and a
  // link cannot answer that. So the page draws it.
  //
  // It is drawn by js/lib/agent-card.js, the SAME module agent.html uses, from
  // the SAME pm_agent_card row. That is the whole claim being tested: a
  // preview assembled separately would eventually reassure an agent about a
  // page that says something else, and they would be the last to know.
  const AGENT = { user: { id: "agent_1", email: "agent@example.com", is_anonymous: false } };
  const CARD = {
    user_id: "agent_1", display_name: "Asha Mwakyusa", is_agent: true, is_guest: false,
    reachable: true, region: "Mwanza", area: "Nyamagana", area_kind: null,
    district: "Nyamagana", ward: null, lat: null, lng: null,
    bio: "Nakodisha vyumba Nyamagana.\nPiga simu wakati wowote.",
    n_houses: 4, n_services: 0, n_trucks: 2, n_jobs: 0, n_verified: 3,
    kinds: null, last_seen_at: null, joined_at: "2026-03-04T09:00:00Z", phone: null,
  };
  {
    const { page, errs } = await openProfile(AGENT, { withKey: KEYPAIR, card: CARD });
    await sleep(900);   // the storefront lands after the first paint, on purpose

    const asked = await page.evaluate(() =>
      (window.__PM_SENT || []).filter((c) => c.name === "pm_agent_card"));
    ok(asked.length === 1 && asked[0].args.p_user === "agent_1",
       "it asks the same question a customer's page asks, about this account",
       JSON.stringify(asked));

    const shop = await page.evaluate(() => {
      const s = document.querySelector(".pf-shop-card");
      if (!s) return null;
      return {
        text: s.textContent,
        name: (s.querySelector(".agc-name") || {}).textContent || "",
        area: (s.querySelector(".agc-area") || {}).textContent || "",
        bio: (s.querySelector(".agc-bio") || {}).textContent || "",
        bioEmpty: !!s.querySelector(".agc-bio.is-none"),
        stats: [...s.querySelectorAll(".agc-stat")].map((n) => n.textContent),
        open: (s.querySelector('a[href^="agent.html"]') || {}).getAttribute
          ? s.querySelector('a[href^="agent.html"]').getAttribute("href") : "",
        edit: !!s.querySelector('[data-act="agentbio"]'),
        warn: !!s.querySelector(".pf-shop-warn"),
      };
    });
    ok(!!shop, "the storefront is drawn on the page itself");
    // The shared classes are the evidence that it came from the shared module
    // rather than from a second copy of the same idea.
    ok(/Asha Mwakyusa/.test(shop.name), "with the name a customer sees", shop.name);
    ok(/Nyamagana/.test(shop.area), "and the area they work in", shop.area);
    ok(!shop.bioEmpty && /Nakodisha/.test(shop.bio), "and their own words", shop.bio);

    // n_verified and joined_at came back from pm_agent_card the day the
    // storefront was written and were drawn nowhere. They answer the question
    // a stranger actually has, which is not "how many" but "should I trust
    // this".
    ok(shop.stats.length >= 3, "the numbers are shown", JSON.stringify(shop.stats));
    ok(shop.stats.some((s) => /^4/.test(s)), "the houses count", JSON.stringify(shop.stats));
    ok(shop.stats.some((s) => /^2/.test(s)), "the trucks count");
    ok(shop.stats.some((s) => /^3/.test(s) && /Checked/i.test(s)),
       "how much of it we checked ourselves", JSON.stringify(shop.stats));
    ok(shop.stats.some((s) => /2026/.test(s)), "and how long they have been here",
       JSON.stringify(shop.stats));
    // A "Daily services 0" tile is the page telling an agent what they have
    // NOT done on the one screen that exists to show what they have.
    ok(!shop.stats.some((s) => /^0/.test(s)), "and nothing they do not have",
       JSON.stringify(shop.stats));

    ok(shop.open === "agent.html?u=agent_1", "it can be opened as a customer sees it", shop.open);
    ok(shop.edit, "and the bio can be edited from beside it");
    ok(!shop.warn, "a reachable agent gets no warning");
    ok(errs.length === 0, "no page errors", errs.slice(0, 3).join("\n        "));
    await page.close();
  }
  {
    // The state worth catching. The storefront exists and looks complete, and
    // nobody can write to them from it, because this device never published a
    // key. Silence is how an agent currently finds that out.
    const { page } = await openProfile(AGENT, {
      withKey: KEYPAIR,
      card: Object.assign({}, CARD, { reachable: false, bio: null }),
    });
    await sleep(900);
    const s = await page.evaluate(() => {
      const c = document.querySelector(".pf-shop-card");
      return { warn: (c.querySelector(".pf-shop-warn") || {}).textContent || "",
               bio: (c.querySelector(".agc-bio") || {}).textContent || "",
               bioEmpty: !!c.querySelector(".agc-bio.is-none") };
    });
    ok(/encryption key/i.test(s.warn),
       "an unreachable storefront says so, on the screen where it can be fixed", s.warn);
    ok(s.bioEmpty, "an empty bio is marked as empty rather than left blank");
    // The visitor's version of this blank reads "they have not written
    // anything yet", which would be the page talking about the agent in the
    // third person to the agent.
    ok(/You have not written/i.test(s.bio),
       "and is worded for the person who can fix it", s.bio);
    await page.close();
  }

  // ==========================================================================
  section("8. Ending a guest session actually ends it");
  // ==========================================================================
  // It used to be three local lines: forget the key, forget the pinned keys,
  // sign out. Everything the guest had put on the server stayed exactly where
  // it was, so the guest went on being a published key that anybody in the
  // thread could still write to, and nothing that arrived could ever be read.
  {
    const { page, errs } = await openProfile(
      { user: { id: "guest_1", email: null, is_anonymous: true } }, { withKey: KEYPAIR });

    const r = await rows(page);
    const end = r.find((x) => x.act === "signout");
    ok(!!end && /guest/i.test(end.title), "a guest is offered a way to end the session", end && end.title);

    // A guest cannot own listings, so none of those doors are drawn.
    ok(!r.some((x) => /^agent-/.test(x.href)),
       "and is not offered the listing portals the database would refuse");

    await page.evaluate(() => document.querySelector('[data-act="signout"]').click());
    await sleep(400);
    const ask = await page.$eval("#pfModal", (n) => n.textContent);
    ok(/cannot be undone/i.test(ask),
       "ending it asks first, and says it cannot be undone", ask.slice(0, 140));
    ok(/removed from the conversations/i.test(ask),
       "and says the guest is removed rather than just signed out");

    // The messages the guest sent are the OTHER person's half of a
    // conversation too. Deleting them by default would rewrite somebody
    // else's history because a stranger closed a tab.
    const wipe = await page.$eval("#pfWipe", (n) => n.checked);
    ok(wipe === false, "deleting what they sent is offered, and is off by default");

    await page.evaluate(() => document.getElementById("pfEndYes").click());
    await sleep(900);

    // Read from sessionStorage, not from window: the flow ends by sending the
    // guest to index.html, so by now window.__PM_SENT is that page's array.
    const log = await page.evaluate(() => JSON.parse(sessionStorage.getItem("__rpc") || "[]"));
    const calls = log.map((c) => c.name);
    ok(calls.includes("pm_guest_forget"),
       "confirming it tells the server to remove the guest", JSON.stringify(calls));
    const args = (log.filter((c) => c.name === "pm_guest_forget")[0] || {}).args || {};
    ok(args.p_wipe_messages === false,
       "with the wipe left off, because the box was not ticked", JSON.stringify(args));

    ok(/index\.html$/.test(page.url()), "and the guest is sent back to the home page", page.url());

    // The ordering is the whole correctness of this flow. signOut first would
    // leave an anonymous call with no app_uid(), the function refuses it, and
    // the guest stays published with nothing on screen to say so.
    const order = await page.evaluate(() => JSON.parse(sessionStorage.getItem("__order") || "[]"));
    ok(order.indexOf("forget") >= 0 && order.indexOf("forget") < order.indexOf("signout"),
       "and it does so BEFORE signing out, while there is still a session to authorise it",
       JSON.stringify(order));
    ok(errs.length === 0, "no page errors", errs.slice(0, 3).join("\n        "));
    await page.close();
  }

  // ==========================================================================
  section("9. Closing an account for good");
  // ==========================================================================
  // Until this existed, nothing in the app could delete an account. The
  // database made that worse rather than easier: houses/services/trucks hold
  // the owner as TEXT with no foreign key, so removing the auth row would have
  // left every listing live on the public board with the person's phone number
  // on it. account_erase() is an explicit, ordered erasure for that reason.
  {
    const { page, errs } = await openProfile(
      // access_token matters: without one the page cannot call the Edge
      // Function at all and would reach the RPC fallback for the wrong
      // reason, passing the assertion below while testing nothing.
      { access_token: "t", user: { id: "u_del", email: "juma@example.com", is_anonymous: false } },
      { withKey: KEYPAIR });

    const r = await rows(page);
    const del = r.find((x) => x.act === "delacct");
    ok(!!del, "an account is offered a way to close itself", JSON.stringify(r.map((x) => x.act)));

    await page.evaluate(() => document.querySelector('[data-act="delacct"]').click());
    await sleep(500);
    const ask = await page.$eval("#pfModal", (n) => n.textContent);

    // "This cannot be undone" without naming what "this" is, is asking for
    // consent to something unnamed.
    ok(/2 rooms and houses/.test(ask) && /3 requests/.test(ask),
       "and is told what it is about to lose, counted", ask.slice(0, 220));
    ok(/cannot be undone/i.test(ask), "that it cannot be undone");
    // The one promise this dialog must not make.
    ok(/sealed with a key we have never held/i.test(ask),
       "and that messages already sent cannot be reached, rather than implying they can");

    // The row sits on a screen people open to change their language. A mis-tap
    // must not be able to reach the button.
    ok(await page.$eval("#pfDelYes", (b) => b.disabled),
       "the button is dead until the address is typed");
    await page.evaluate(() => {
      const f = document.getElementById("pfDelEmail");
      f.value = "wrong@example.com";
      f.dispatchEvent(new Event("input"));
    });
    ok(await page.$eval("#pfDelYes", (b) => b.disabled),
       "and a different address does not wake it");
    await page.evaluate(() => {
      const f = document.getElementById("pfDelEmail");
      f.value = "JUMA@example.com";           // case must not matter
      f.dispatchEvent(new Event("input"));
    });
    ok(!(await page.$eval("#pfDelYes", (b) => b.disabled)),
       "their own address does, whatever the case");

    await page.evaluate(() => document.getElementById("pfDelYes").click());
    await sleep(1200);

    const log = await page.evaluate(() => JSON.parse(sessionStorage.getItem("__rpc") || "[]"));
    const calls = log.map((c) => c.name);
    // The Edge Function is not deployed in this run, so the page must fall
    // back rather than refuse: the person asked to be deleted, and taking
    // their listings down does not need the function.
    ok(calls.includes("account_erase"),
       "with the Edge Function missing it still erases through the database",
       JSON.stringify(calls));
    ok(/index\.html$/.test(page.url()), "and they are sent back to the home page", page.url());

    const order = await page.evaluate(() => JSON.parse(sessionStorage.getItem("__order") || "[]"));
    ok(order.indexOf("erase") >= 0 && order.indexOf("erase") < order.indexOf("signout"),
       "server first, before signing out, while there is still a session to authorise it",
       JSON.stringify(order));
    // The 404 IS the scenario here, and Chrome logs every failed request to
    // the console whether or not the page handled it. Counting it as a page
    // error would mean this section could only pass by not testing the thing
    // it exists to test.
    const real = errs.filter((e) => !/404 \(Not Found\)/.test(e));
    ok(real.length === 0, "no page errors beyond the 404 this section asks for",
       real.slice(0, 3).join("\n        "));
    await page.close();
  }

  section("9b. And a guest is not offered it");
  {
    // A guest has "End this guest session", which is the same act for somebody
    // with no account, and account_erase() refuses a guest session outright.
    // Two doors to the same place, one of which errors, is one door too many.
    const { page } = await openProfile(
      { user: { id: "guest_2", email: null, is_anonymous: true } }, { withKey: KEYPAIR });
    const r = await rows(page);
    ok(!r.some((x) => x.act === "delacct"), "no delete-account row for a guest",
       JSON.stringify(r.map((x) => x.act)));
    await page.close();
  }

  section("9c. When the Edge Function IS deployed, the database is not asked twice");
  {
    const { page } = await openProfile(
      { access_token: "t", user: { id: "u_del2", email: "amina@example.com", is_anonymous: false } },
      { withKey: KEYPAIR, edge: "ok" });
    await page.evaluate(() => document.querySelector('[data-act="delacct"]').click());
    await sleep(500);
    await page.evaluate(() => {
      const f = document.getElementById("pfDelEmail");
      f.value = "amina@example.com";
      f.dispatchEvent(new Event("input"));
      document.getElementById("pfDelYes").click();
    });
    await sleep(1200);
    const calls = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("__rpc") || "[]").map((c) => c.name));
    // The function calls account_erase itself, server-side, as the caller.
    // Calling it again from here would be a second erasure of nothing, and on
    // a slow connection a second round trip for no reason.
    ok(!calls.includes("account_erase"),
       "the page leaves the erasing to the function that already did it",
       JSON.stringify(calls));
    await page.close();
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
} finally {
  await browser.close();
}
process.exit(fail === 0 ? 0 : 1);
