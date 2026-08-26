// ============================================================================
//  login_page_test.mjs — login.html in a real browser, driven through every
//  door it offers.
//
//  Covers: field validation, wrong-password handling, the escalating lockout,
//  the passwordless code flow end to end, account creation with the strength
//  meter, the neutral forgot-password reply, the portal chooser, the open
//  redirect guard — and the one that matters most, a sweep of the rendered
//  page for any word that would tell a stranger what this is built on.
//
//  The provider is stubbed at the CDN script (jsDelivr is not reachable from
//  this machine anyway — see the browser-test recipe) so each failure mode can
//  be produced on demand instead of waited for.
//
//    usage:  node server.js      then, in another shell:
//            node tests/login_page_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080/login.html";

// ---------------------------------------------------------------- the stub --
// `window.__mode` decides what the next call does, so one page can be walked
// from "wrong password" to "signed in" without reloading.
const STUB = `(function () {
  window.__calls = [];
  var SESSION = { user: { id: "u-1", email: "juma@example.com", is_anonymous: false },
                  access_token: "t" };
  function note(name, args) { window.__calls.push({ name: name, args: args }); }
  function fail(props) { return Promise.resolve({ data: { session: null, user: null }, error: props }); }
  function builder() {
    var b = {};
    ["select","eq","neq","gt","gte","lt","lte","in","is","or","filter","order","limit","range","match"]
      .forEach(function (m) { b[m] = function () { return b; }; });
    b.then = function (res, rej) {
      var mode = window.__mode || {};
      return Promise.resolve({ data: mode.owns ? [{ id: "x" }] : [], error: null }).then(res, rej);
    };
    return b;
  }
  var handlers = [];
  window.__fireAuthEvent = function (ev) { handlers.forEach(function (h) { h(ev, SESSION); }); };
  window.supabase = {
    createClient: function () {
      return {
        from: builder,
        rpc: function () { return Promise.resolve({ data: null, error: null }); },
        auth: {
          getSession: function () {
            return Promise.resolve({ data: { session: window.__signedIn ? SESSION : null }, error: null });
          },
          getUser: function () { return Promise.resolve({ data: { user: null }, error: null }); },
          signInWithPassword: function (a) {
            note("signInWithPassword", a);
            var m = window.__mode || {};
            if (m.signIn === "wrong") return fail({ code: "invalid_credentials", status: 400,
              message: "Invalid login credentials" });
            if (m.signIn === "unconfirmed") return fail({ code: "email_not_confirmed", status: 400,
              message: "Email not confirmed" });
            if (m.signIn === "raw") return fail({ status: 500,
              message: 'new row violates row-level security policy for table "houses" (PGRST301, supabase)' });
            window.__signedIn = true;
            return Promise.resolve({ data: { session: SESSION }, error: null });
          },
          signInWithOtp: function (a) {
            note("signInWithOtp", a);
            var m = window.__mode || {};
            if (m.otp === "rate") return fail({ status: 429,
              message: "For security purposes, you can only request this after 47 seconds." });
            return Promise.resolve({ data: {}, error: null });
          },
          verifyOtp: function (a) {
            note("verifyOtp", a);
            var m = window.__mode || {};
            if (m.verify === "bad") return fail({ code: "otp_expired",
              message: "Token has expired or is invalid" });
            window.__signedIn = true;
            return Promise.resolve({ data: { session: SESSION }, error: null });
          },
          signUp: function (a) {
            note("signUp", a);
            var m = window.__mode || {};
            if (m.signUp === "exists") return fail({ code: "user_already_exists",
              message: "User already registered" });
            return Promise.resolve({ data: { session: null, user: { id: "u-2" } }, error: null });
          },
          resend: function (a) { note("resend", a); return Promise.resolve({ data: {}, error: null }); },
          resetPasswordForEmail: function (a, b) {
            note("resetPasswordForEmail", [a, b]);
            return Promise.resolve({ data: {}, error: null });
          },
          updateUser: function (a) {
            note("updateUser", a);
            window.__signedIn = true;
            return Promise.resolve({ data: { user: SESSION.user }, error: null });
          },
          signInAnonymously: function () { note("signInAnonymously"); return Promise.resolve({ data: { session: SESSION }, error: null }); },
          signOut: function () { window.__signedIn = false; note("signOut"); return Promise.resolve({ error: null }); },
          onAuthStateChange: function (cb) {
            handlers.push(cb);
            return { data: { subscription: { unsubscribe: function () {} } } };
          },
        },
        storage: { from: function () { return { getPublicUrl: function () { return { data: { publicUrl: "" } }; } }; } },
        channel: function () { return { on: function () { return this; }, subscribe: function () { return this; } }; },
        removeChannel: function () {},
      };
    },
  };
})();`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n          " + detail : "") + "\n"); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll rather than waitForFunction: an injected predicate can wedge and then
// report "waiting failed" for a page that is in fact fine.
async function until(page, fn, arg, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await page.evaluate(fn, arg)) return true; } catch (_) {}
    await wait(120);
  }
  return false;
}

const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
});

const errors = [];
async function newPage(query = "", theme = "dark") {
  const page = await browser.newPage();
  await page.setViewport({ width: 414, height: 900, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("cdn.jsdelivr.net")) return r.respond({ status: 200, contentType: "application/javascript", body: STUB });
    if (u.includes("fonts.googleapis.com") || u.includes("fonts.gstatic.com")) return r.respond({ status: 200, contentType: "text/css", body: "" });
    if (/arcgisonline|cartocdn|mapbox|supabase\.co\/storage/.test(u)) return r.respond({ status: 200, contentType: "image/png", body: PNG });
    if (u.includes("supabase.co")) {
      if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
      return r.respond({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" });
    }
    r.continue();
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.evaluateOnNewDocument((t) => {
    try { localStorage.clear(); localStorage.setItem("pawa-theme", t); } catch (_) {}
  }, theme);
  // The browser on this machine occasionally drops a navigation; one retry
  // costs a second and saves a whole run.
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(BASE + query, { waitUntil: "domcontentloaded", timeout: 25000 });
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
      process.stdout.write("  ....  navigation retry\n");
      await wait(500);
    }
  }
  await until(page, () => !!document.getElementById("cardAuth"));
  await wait(400);
  return page;
}

const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim()).catch(() => "");
const visible = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none";
}, sel);
const type = async (page, sel, v) => {
  await page.$eval(sel, (el) => { el.value = ""; });
  await page.type(sel, v, { delay: 4 });
};

// =========================================================== 1. it renders ==
{
  process.stdout.write("\nthe page renders\n");
  const page = await newPage();
  ok(await visible(page, "#cardAuth"), "the sign-in card is on screen");
  ok(await visible(page, "#panePassword"), "the password pane is the default");
  ok(!(await visible(page, "#paneCode")), "the code pane starts hidden");
  ok(!(await visible(page, "#cardPortal")), "the portal chooser starts hidden");
  ok((await page.$$(".lg-tab")).length === 3, "three ways in are offered");

  // The old screen's most visible bug: the field icon sat on the placeholder.
  const overlap = await page.evaluate(() => {
    const ic = document.querySelector("#panePassword .lg-ic").getBoundingClientRect();
    const input = document.getElementById("pwEmail").getBoundingClientRect();
    const padLeft = parseFloat(getComputedStyle(document.getElementById("pwEmail")).paddingLeft);
    return { icRight: ic.right, textStart: input.left + padLeft };
  });
  ok(overlap.textStart >= overlap.icRight, "the field icon does not sit on the placeholder text",
    `icon ends at ${overlap.icRight}, text starts at ${overlap.textStart}`);

  // The bottom tab bar must not cover the last thing on the page.
  const covered = await page.evaluate(() => {
    const bar = document.querySelector(".app-tabbar");
    const last = document.querySelector(".lg-secure");
    if (!bar || !last) return false;
    document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
    const b = bar.getBoundingClientRect(), l = last.getBoundingClientRect();
    return l.bottom > b.top && l.top < b.bottom;
  });
  ok(!covered, "the bottom tab bar does not cover the end of the page");
  await page.close();
}

// ========================================================== 2. validation ===
{
  process.stdout.write("\nit refuses nonsense before touching the network\n");
  const page = await newPage();
  await type(page, "#pwEmail", "not-an-email");
  await type(page, "#pwPassword", "whatever");
  await page.click("#pwSubmit");
  await wait(250);
  ok(await visible(page, "#pwEmailHint"), "an incomplete address is caught on the field");
  ok((await page.$eval("#pwEmail", (e) => e.getAttribute("aria-invalid"))) === "true",
    "and the field is marked invalid for a screen reader");
  const calls = await page.evaluate(() => window.__calls.length);
  ok(calls === 0, "nothing was sent", `${calls} call(s) made`);

  await type(page, "#pwEmail", "juma@example.com");
  await page.$eval("#pwPassword", (e) => { e.value = ""; });
  await page.click("#pwSubmit");
  await wait(250);
  ok((await text(page, "#pwPassHint")).length > 0, "a missing password is caught too");
  await page.close();
}

// ======================================== 3. wrong password, and the fence ==
{
  process.stdout.write("\na wrong password, said in our words\n");
  const page = await newPage();
  await page.evaluate(() => { window.__mode = { signIn: "wrong" }; });
  await type(page, "#pwEmail", "juma@example.com");
  await type(page, "#pwPassword", "wrong-one");
  await page.click("#pwSubmit");
  ok(await until(page, () => document.getElementById("authMsg").classList.contains("is-show")),
    "a message appears");
  const msg = await text(page, "#authMsg");
  ok(/don't match/i.test(msg), "it says the pair doesn't match", msg);
  ok(!/invalid login credentials/i.test(msg), "the provider's own wording is not shown", msg);

  process.stdout.write("\nthe leak fence, on a page that just took a raw provider error\n");
  await page.evaluate(() => { window.__mode = { signIn: "raw" }; });
  await type(page, "#pwPassword", "another-try");
  await page.click("#pwSubmit");
  await wait(700);
  const shown = await text(page, "#authMsg");
  ok(shown.length > 0, "the failure is still reported to the person", shown);
  const leaked = await page.evaluate(() => {
    const t = document.body.innerText || "";
    const m = t.match(/supabase|postgrest|pgrst|row-level security|\bRLS\b|gotrue|jwt|postgres|service_role|anon key/i);
    return m ? m[0] + " — in: " + t.slice(Math.max(0, m.index - 60), m.index + 60) : null;
  });
  ok(!leaked, "nothing on the rendered page names the machinery", leaked || "");
  await page.close();
}

// ============================================================ 4. lockout ====
{
  process.stdout.write("\nit slows a guesser down\n");
  const page = await newPage();
  await page.evaluate(() => { window.__mode = { signIn: "wrong" }; });
  await type(page, "#pwEmail", "juma@example.com");
  for (let i = 0; i < 5; i++) {
    await type(page, "#pwPassword", "guess" + i);
    await page.click("#pwSubmit");
    await wait(320);
  }
  const msg = await text(page, "#authMsg");
  ok(/wait|seconds/i.test(msg), "after five failures it asks for a pause", msg);
  ok(await page.$eval("#pwSubmit", (b) => b.disabled), "and the button is disabled while it counts down");

  const before = await page.evaluate(() => window.__calls.filter((c) => c.name === "signInWithPassword").length);
  await page.evaluate(() => { document.getElementById("pwSubmit").disabled = false; });
  await page.click("#pwSubmit");
  await wait(300);
  const after = await page.evaluate(() => window.__calls.filter((c) => c.name === "signInWithPassword").length);
  ok(after === before, "and a re-enabled button still sends nothing", `${before} → ${after}`);
  await page.close();
}

// ========================================== 5. the passwordless code flow ===
{
  process.stdout.write("\nsigning in with a six-digit code\n");
  const page = await newPage();
  await page.click('.lg-tab[data-method="code"]');
  await wait(200);
  ok(await visible(page, "#paneCode"), "the code pane opens");
  ok(!(await visible(page, "#panePassword")), "and the password pane closes");
  ok((await text(page, "#authTitle")) !== "Sign in", "the card title follows the tab");

  await type(page, "#codeEmail", "juma@example.com");
  await page.click("#codeSend");
  ok(await until(page, () => !document.getElementById("codeStepEnter").hidden),
    "asking for a code moves to the entry step");
  const sentTo = await text(page, "#codeSentTo");
  ok(/juma@example\.com/.test(sentTo), "it says where the code went", sentTo);
  ok(await page.$eval("#codeResend", (b) => b.disabled), "resend is on a cooldown");
  ok(/\d+s/.test(await text(page, "#codeResend")), "and the cooldown counts down in the label");

  const otpArgs = await page.evaluate(() =>
    window.__calls.find((c) => c.name === "signInWithOtp").args);
  ok(otpArgs.options.shouldCreateUser === false,
    "the code cannot conjure an account for an address you don't own");

  // Letters are dropped; six digits submit on their own.
  await type(page, "#codeInput", "12ab34");
  ok((await page.$eval("#codeInput", (e) => e.value)) === "1234", "letters are stripped as you type");
  await type(page, "#codeInput", "123456");
  ok(await until(page, () => !document.getElementById("cardPortal").hidden),
    "six digits sign you in without pressing anything");
  const verified = await page.evaluate(() => window.__calls.find((c) => c.name === "verifyOtp").args);
  ok(verified.token === "123456" && verified.email === "juma@example.com",
    "the right code went to the right address");
  await page.close();
}

{
  process.stdout.write("\na bad code is survivable\n");
  const page = await newPage();
  await page.click('.lg-tab[data-method="code"]');
  await page.evaluate(() => { window.__mode = { verify: "bad" }; });
  await type(page, "#codeEmail", "juma@example.com");
  await page.click("#codeSend");
  await until(page, () => !document.getElementById("codeStepEnter").hidden);
  await type(page, "#codeInput", "000000");
  await wait(600);
  const msg = await text(page, "#authMsg");
  ok(/expired/i.test(msg), "an expired code says so", msg);
  ok((await page.$eval("#codeInput", (e) => e.getAttribute("aria-invalid"))) === "true",
    "and the field is marked, ready to retype");
  ok(await visible(page, "#codeStepEnter"), "you stay on the entry step rather than starting over");
  await page.close();
}

{
  process.stdout.write("\nthe provider's own cool-off is obeyed\n");
  const page = await newPage();
  await page.click('.lg-tab[data-method="code"]');
  await page.evaluate(() => { window.__mode = { otp: "rate" }; });
  await type(page, "#codeEmail", "juma@example.com");
  await page.click("#codeSend");
  await wait(600);
  const stored = await page.evaluate(() => localStorage.getItem("pawa-auth-attempts"));
  ok(/until/.test(stored || ""), "a 429 with a wait time is written into the local lockout", stored);
  ok(!/47 seconds/.test(await text(page, "#authMsg")), "and the raw sentence is not what the person reads");
  await page.close();
}

// ============================================== 6. creating an account ======
{
  process.stdout.write("\ncreating an account\n");
  const page = await newPage();
  await page.click('.lg-tab[data-method="signup"]');
  await wait(200);
  ok(await visible(page, "#paneSignup"), "the sign-up pane opens");

  await type(page, "#suEmail", "juma@example.com");
  await type(page, "#suPassword", "abc");
  await wait(150);
  ok((await page.$eval("#suMeter", (e) => e.dataset.score)) === "0", "three characters scores nothing");
  ok(/8/.test(await text(page, "#suMeterSay")), "and it says what is missing");

  await type(page, "#suPassword", "password");
  await wait(150);
  ok((await page.$eval("#suMeter", (e) => e.dataset.score)) === "1",
    "a famously common password is capped at weak");

  // A password that contains the address being registered is worthless
  // however long it is, and the screen has to say so rather than just refuse.
  await type(page, "#suPassword", "Juma-2026-Nyumba!");
  await wait(150);
  ok((await page.$eval("#suMeter", (e) => e.dataset.score)) === "1",
    "a password containing the email address is capped at weak");
  ok(/email/i.test(await text(page, "#suMeterSay")), "and it says that is the reason",
    await text(page, "#suMeterSay"));
  ok((await page.$eval('#suReqs li[data-req="notEmail"]', (e) => e.classList.contains("is-met"))) === false,
    "the checklist shows which requirement is unmet");

  await type(page, "#suPassword", "Nyumba-2026-Dar!");
  await wait(150);
  ok((await page.$eval("#suMeter", (e) => e.dataset.score)) === "4", "a real password scores full");
  const met = await page.$$eval("#suReqs li.is-met", (els) => els.length);
  const total = await page.$$eval("#suReqs li[data-req]", (els) => els.length);
  ok(met === total, "every requirement lights up", `${met}/${total}`);

  await type(page, "#suConfirm", "Nyumba-2026-Dab!");
  await wait(150);
  ok((await text(page, "#suConfirmHint")).length > 0, "a mismatch is caught while typing");

  await page.click("#suSubmit");
  await wait(300);
  ok(await visible(page, "#paneSignup"), "and it will not submit with a mismatch");

  await type(page, "#suConfirm", "Nyumba-2026-Dar!");
  await page.click("#suSubmit");
  ok(await until(page, () => !document.getElementById("cardSent").hidden),
    "a good sign-up lands on 'check your inbox'");
  ok(/juma@example\.com/.test(await text(page, "#sentBody")), "which names the address it went to");

  await page.click("#sentResend");
  await wait(400);
  const resent = await page.evaluate(() => window.__calls.some((c) => c.name === "resend"));
  ok(resent, "and can send the confirmation again");
  await page.close();
}

{
  process.stdout.write("\nsigning up with an address that already has an account\n");
  const page = await newPage();
  await page.click('.lg-tab[data-method="signup"]');
  await page.evaluate(() => { window.__mode = { signUp: "exists" }; });
  await type(page, "#suEmail", "juma@example.com");
  await type(page, "#suPassword", "Nyumba-2026-Dar!");
  await type(page, "#suConfirm", "Nyumba-2026-Dar!");
  await page.click("#suSubmit");
  ok(await until(page, () => !document.getElementById("panePassword").hidden),
    "you are moved to the pane that can actually get you in");
  ok((await page.$eval("#pwEmail", (e) => e.value)) === "juma@example.com",
    "with the address carried across so nothing is retyped");
  await page.close();
}

// ============================================ 7. forgot password ============
{
  process.stdout.write("\nforgot password, without confirming who has an account\n");
  const page = await newPage();
  await type(page, "#pwEmail", "stranger@example.com");
  await page.click("#forgotBtn");
  ok(await until(page, () => !document.getElementById("cardSent").hidden), "it moves to the sent card");
  const body = await text(page, "#sentBody");
  ok(/\bif\b/i.test(body), "the wording is conditional — it never confirms the address exists", body);
  const args = await page.evaluate(() => window.__calls.find((c) => c.name === "resetPasswordForEmail").args);
  ok(/login\.html$/.test(args[1].redirectTo), "the link comes back to this page", args[1].redirectTo);
  ok(args[1].redirectTo.startsWith("http://localhost:8080/"), "and only to this origin", args[1].redirectTo);
  await page.close();
}

// ============================================ 8. the reset landing ==========
{
  process.stdout.write("\narriving from a reset link\n");
  const page = await newPage();
  await page.evaluate(() => window.__fireAuthEvent("PASSWORD_RECOVERY"));
  ok(await until(page, () => !document.getElementById("cardRecovery").hidden),
    "the new-password card takes over");
  await type(page, "#recPassword", "short");
  await page.click("#recSubmit");
  await wait(300);
  ok(/strength|strengthen/i.test(await text(page, "#recMsg")), "a weak new password is refused");
  await type(page, "#recPassword", "Nyumba-2026-Dar!");
  await page.click("#recSubmit");
  ok(await until(page, () => window.__calls.some((c) => c.name === "updateUser")),
    "a strong one is saved");
  await page.close();
}

// ============================================ 9. the portal chooser =========
{
  process.stdout.write("\nwhere you land after signing in\n");
  const page = await newPage();
  await page.evaluate(() => { window.__mode = { owns: false }; });
  await type(page, "#pwEmail", "juma@example.com");
  await type(page, "#pwPassword", "correct-horse");
  await page.click("#pwSubmit");
  ok(await until(page, () => !document.getElementById("cardPortal").hidden), "the chooser appears");
  ok(/juma@example\.com/.test(await text(page, "#portalEmail")), "it names the account");
  ok(await visible(page, "#portalEmpty"), "an account with nothing linked is told so, not left blank");
  const hrefs = await page.$$eval("#portalList a", (as) => as.map((a) => a.getAttribute("href")));
  ok(hrefs.includes("index.html"), "and is always offered the ordinary way into the app", hrefs.join(", "));

  await page.click("#portalSignOut");
  ok(await until(page, () => !document.getElementById("cardAuth").hidden), "signing out returns to the form");
  ok((await page.$eval("#pwPassword", (e) => e.value)) === "", "and clears the password field");
  await page.close();
}

// ======================================= 10. the open-redirect guard ========
{
  process.stdout.write("\nthe ?next= guard\n");
  for (const [q, why] of [
    ["?next=//evil.example.com", "a protocol-relative URL is refused"],
    ["?next=https://evil.example.com", "an absolute URL is refused"],
    ["?next=javascript:alert(1)", "a javascript: URL is refused"],
  ]) {
    const page = await newPage(q);
    await type(page, "#pwEmail", "juma@example.com");
    await type(page, "#pwPassword", "correct-horse");
    await page.click("#pwSubmit");
    await wait(900);
    const url = page.url();
    ok(url.startsWith("http://localhost:8080/login.html"), why, "landed on " + url);
    await page.close();
  }
  const page = await newPage("?next=explore.html");
  await type(page, "#pwEmail", "juma@example.com");
  await type(page, "#pwPassword", "correct-horse");
  await page.click("#pwSubmit");
  await wait(1200);
  ok(/explore\.html/.test(page.url()), "a plain relative page is honoured", page.url());
  await page.close();
}

// ============================================ 11. Swahili ===================
{
  process.stdout.write("\nit speaks Swahili too\n");
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("cdn.jsdelivr.net")) return r.respond({ status: 200, contentType: "application/javascript", body: STUB });
    if (u.includes("fonts.g")) return r.respond({ status: 200, contentType: "text/css", body: "" });
    r.continue();
  });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem("lang", "sw"); } catch (_) {} });
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await until(page, () => !!document.getElementById("authTitle"));
  await wait(400);
  ok((await text(page, "#authTitle")) === "Ingia", "the title is translated",
    await text(page, "#authTitle"));
  ok((await text(page, '.lg-tab[data-method="signup"]')) === "Fungua akaunti", "so are the tabs");
  await page.evaluate(() => { window.__mode = { signIn: "wrong" }; });
  await type(page, "#pwEmail", "juma@example.com");
  await type(page, "#pwPassword", "nope");
  await page.click("#pwSubmit");
  await wait(700);
  const msg = await text(page, "#authMsg");
  ok(/havilingani/.test(msg), "and so is the error", msg);
  await page.close();
}

// ============================================ 12. both themes ===============
{
  process.stdout.write("\nboth themes are actually applied\n");
  // The field backgrounds here are translucent — rgba(255,255,255,.05) over a
  // dark page. Reading backgroundColor on its own measures a colour that is
  // never painted and reports 1.13:1 for text that is in fact perfectly
  // legible. So every layer is composited down to the page before the ratio is
  // taken. Making that mistake in a checker instead of a stylesheet is how you
  // end up "fixing" a screen that was fine.
  for (const theme of ["dark", "light"]) {
    const page = await newPage("", theme);
    const seen = await page.evaluate(() => {
      const parse = (c) => {
        const n = (c.match(/[\d.]+/g) || []).map(Number);
        return { r: n[0] || 0, g: n[1] || 0, b: n[2] || 0, a: n.length > 3 ? n[3] : 1 };
      };
      const over = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      });
      const effectiveBg = (el) => {
        const stack = [];
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c.a > 0) stack.push(c);
          if (c.a === 1) break;
        }
        let out = { r: 255, g: 255, b: 255, a: 1 };
        for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
        return out;
      };
      const css = (el) => parse(getComputedStyle(el).color);
      return {
        bodyBg: effectiveBg(document.body),
        bodyText: css(document.body),
        inputBg: effectiveBg(document.getElementById("pwEmail")),
        inputText: css(document.getElementById("pwEmail")),
        cardBg: effectiveBg(document.querySelector(".lg-card")),
        subText: css(document.querySelector(".lg-card-sub")),
        btnBg: effectiveBg(document.getElementById("pwSubmit")),
        btnText: css(document.getElementById("pwSubmit")),
        // The tab bar is injected by app-shell.js with its colours written in
        // JS, which is exactly why the page's own light theme could not reach
        // it: it stayed a dark slab across the foot of a light page.
        tabBg: effectiveBg(document.querySelector(".app-tabbar")),
        tabText: css(document.querySelector(".app-tabbar a:not(.active)")),
      };
    });
    const lum = (c) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    // Text colours here carry alpha (--lg-muted is 60%, the tab labels 65%).
    // Measuring the declared colour instead of the painted one scores a
    // translucent label as if it were solid and reports ~16:1 for ink that is
    // really nearer 5:1 — a checker that flatters the stylesheet is worse than
    // no checker. So the foreground is composited onto its own background
    // first, the same way the backgrounds are already flattened above.
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const ratio = (a, b) => {
      const la = lum(over(a, b)), lb = lum(b);
      const [hi, lo] = la > lb ? [la, lb] : [lb, la];
      return (hi + 0.05) / (lo + 0.05);
    };
    const isDark = lum(seen.bodyText) > lum(seen.bodyBg);
    ok(theme === "dark" ? isDark : !isDark,
      `${theme}: the text/background polarity is right`, JSON.stringify(seen.bodyBg));

    // The old screen's real failure: near-white ink on a near-white field.
    const rIn = ratio(seen.inputText, seen.inputBg);
    ok(rIn >= 4.5, `${theme}: typed text is readable in its field (${rIn.toFixed(2)}:1)`);
    const rSub = ratio(seen.subText, seen.cardBg);
    ok(rSub >= 4.5, `${theme}: the explanatory copy is readable (${rSub.toFixed(2)}:1)`);
    const rBtn = ratio(seen.btnText, seen.btnBg);
    ok(rBtn >= 4.5, `${theme}: the button label is readable (${rBtn.toFixed(2)}:1)`);

    // The tab bar must belong to the same page it sits on: a light page with a
    // dark slab bolted to its foot is the bug this pins down.
    const tabIsDark = lum(seen.tabText) > lum(seen.tabBg);
    ok(theme === "dark" ? tabIsDark : !tabIsDark,
      `${theme}: the tab bar follows the page's theme`, JSON.stringify(seen.tabBg));
    const rTab = ratio(seen.tabText, seen.tabBg);
    ok(rTab >= 4.5, `${theme}: an inactive tab label is readable (${rTab.toFixed(2)}:1)`);
    await page.close();
  }
}

process.stdout.write("\npage errors\n");
const real = errors.filter((e) => !/favicon|manifest|service-?worker|404|Failed to load resource/i.test(e));
ok(real.length === 0, "no uncaught errors on any run", real.slice(0, 5).join(" | "));

await browser.close();
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
