// ============================================================================
//  Login — the four doors
//
//  PN-Zaki has four kinds of account and they want different things from the
//  same building. The door asks once, up front, instead of making a landlord
//  hunt for the agent portal.
//
//  The assertion this file exists for is the last one: a door grants NOTHING.
//  It decides where somebody lands. Permission is the database's answer, and if
//  anything ever starts reading the stored type as a capability, the test in
//  section 4 is what should stop it.
//
//  Usage: node server.js   then:  node tests/login_doors_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
let passed = 0;
const fails = [];
const ok = (cond, what, detail) => {
  if (cond) { passed++; console.log("  PASS  " + what); }
  else { fails.push(what); console.log("  FAIL  " + what); if (detail) console.log("        " + detail); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });

async function open({ remember = null, theme = "dark" } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.setViewport({ width: 390, height: 900 });
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    const u = r.url();
    if (/supabase\.co/.test(u)) {
      return r.respond({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
    }
    if (/fonts\.googleapis|fonts\.gstatic/.test(u)) {
      return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    r.continue();
  });
  await page.evaluateOnNewDocument((t, mem) => {
    try {
      localStorage.setItem("pawa-theme", t);
      if (mem) localStorage.setItem("pawa_account_type", mem);
      else localStorage.removeItem("pawa_account_type");
    } catch (e) {}
  }, theme, remember);
  await page.goto(BASE + "/login.html", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => !!window.LoginDoors, { timeout: 20000 });
  return { page, errs, close: () => ctx.close() };
}

// ---------------------------------------------------------------------------
console.log("\n1. Four doors, and each says what it can do");
{
  const t = await open();
  await t.page.waitForSelector(".lg-door", { timeout: 15000 });
  const d = await t.page.evaluate(() => ({
    doors: [...document.querySelectorAll(".lg-door")].map((el) => ({
      key: el.dataset.key,
      name: el.querySelector(".lg-door-t")?.textContent,
      can: [...el.querySelectorAll(".lg-door-can span")].map((s) => s.textContent),
      accent: el.style.getPropertyValue("--d").trim(),
      pressed: el.getAttribute("aria-pressed"),
    })),
    brand: document.querySelector(".lg-brand-name")?.textContent,
    title: document.title,
  }));
  ok(d.doors.length === 4, "exactly four, no more and no fewer", String(d.doors.length));
  ok(d.doors.map((x) => x.key).join() === "agent,owner,company,user",
     "agent, house owner, job company, user", d.doors.map((x) => x.key).join());
  // The chip row is the only thing that tells the four apart at a glance.
  ok(d.doors.every((x) => x.can.length >= 2), "each names what it can actually do",
     d.doors.map((x) => x.key + ":" + x.can.join("/")).join(" | "));
  ok(d.doors[0].can.includes("Trucks") && !d.doors[1].can.includes("Trucks"),
     "an agent lists trucks, a house owner does not");
  ok(d.doors[2].can.some((c) => /job/i.test(c)), "the job company is the one that posts work");
  ok(new Set(d.doors.map((x) => x.accent)).size === 4, "and each carries its own accent");
  ok(d.doors.every((x) => x.pressed === "false"), "nothing is chosen until somebody chooses");
  ok(d.brand === "PN-Zaki", "the page is PN-Zaki", d.brand);
  ok(/PN-Zaki/.test(d.title), "including its title", d.title);
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n2. Choosing one moves to the card and says which door you are in");
{
  const t = await open();
  await t.page.waitForSelector(".lg-door", { timeout: 15000 });
  const before = await t.page.evaluate(() => ({
    step: !document.getElementById("stepDoor").hidden,
    card: !document.getElementById("cardAuth").hidden,
  }));
  ok(before.step && !before.card, "the door step opens first");

  await t.page.click('.lg-door[data-key="company"]');
  await sleep(800);
  const after = await t.page.evaluate(() => ({
    step: !document.getElementById("stepDoor").hidden,
    card: !document.getElementById("cardAuth").hidden,
    chosen: document.getElementById("chosenName")?.textContent,
    chipShown: !document.getElementById("chosenDoor").hidden,
    stored: localStorage.getItem("pawa_account_type"),
  }));
  ok(!after.step && after.card, "the card replaces it");
  ok(after.chipShown && /Job company/.test(after.chosen || ""),
     "the card says which door you came through", after.chosen);
  ok(after.stored === "company", "and the choice is remembered", String(after.stored));

  // Without this a person can fill in a whole registration before noticing the
  // wrong role, and the browser's back button reloads the page and loses it.
  await t.page.click("#chosenDoor");
  await sleep(700);
  const back = await t.page.evaluate(() => !document.getElementById("stepDoor").hidden);
  ok(back, "and it is reversible without losing the page");
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n3. A question already answered is not asked twice");
{
  const t = await open({ remember: "owner" });
  await sleep(700);
  const st = await t.page.evaluate(() => ({
    step: !document.getElementById("stepDoor").hidden,
    card: !document.getElementById("cardAuth").hidden,
    chosen: document.getElementById("chosenName")?.textContent,
  }));
  ok(!st.step && st.card, "somebody coming back lands on the card");
  ok(/House owner/.test(st.chosen || ""), "with their door still named on it", st.chosen);
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n4. A door is a signpost, never a permission");
{
  const t = await open();
  await t.page.waitForSelector(".lg-door", { timeout: 15000 });
  const api = await t.page.evaluate(() => {
    const D = window.LoginDoors;
    // Everything the module will accept, and what it refuses.
    D.set("agent");
    const legit = D.get();
    D.set("superuser");            // not a door
    const afterJunk = D.get();
    return {
      legit, afterJunk,
      keys: D.DOORS.map((x) => x.key),
      // The four destinations, which is all a door actually decides.
      dests: D.DOORS.map((x) => x.key + "->" + x.href),
      hasRoleGrant: Object.keys(D).some((k) => /grant|permission|role|allow/i.test(k)),
    };
  });
  ok(api.legit === "agent", "a real door can be stored");
  ok(api.afterJunk === "agent", "a made-up one is refused, not stored", String(api.afterJunk));
  ok(!api.hasRoleGrant, "the module exposes nothing that sounds like a grant",
     Object.keys(api).join());
  // If this ever changes, whoever changes it has to come and edit this line,
  // which is the point.
  ok(api.dests.join(" ") ===
     "agent->agent-houses.html owner->agent-houses.html company->jobs.html user->index.html",
     "a door decides one thing: where you land", api.dests.join(" "));
  ok(t.errs.length === 0, "no page errors across the whole run", t.errs.slice(0, 2).join(" | "));
  await t.close();
}

console.log("\n" + passed + " passed, " + fails.length + " failed");
await browser.close();
process.exit(fails.length ? 1 : 0);
