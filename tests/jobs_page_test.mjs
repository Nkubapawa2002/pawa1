// Headless check of jobs.html: console errors, key UI elements, post-modal,
// claim flow against the live DB. Run: node tests/jobs_page_test.mjs
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
const errors = [];
const logs = [];

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
// Emulate GPS in Dar es Salaam so "Jobs near me" can be tested headless.
const ctx = browser.defaultBrowserContext();
await ctx.overridePermissions(BASE, ["geolocation"]);
await page.setGeolocation({ latitude: -6.8, longitude: 39.28, accuracy: 25 });

page.on("console", (m) => {
  const t = m.type();
  const txt = m.text();
  logs.push(`[${t}] ${txt}`);
  if (t === "error") errors.push(txt);
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("requestfailed", (r) => {
  const u = r.url();
  if (!u.includes("favicon")) errors.push(`REQFAIL: ${u} — ${r.failure()?.errorText}`);
});

console.log("→ loading jobs.html …");
await page.goto(BASE + "/jobs.html", { waitUntil: "networkidle2", timeout: 45000 });
await new Promise((r) => setTimeout(r, 3500));   // let supabase fetch + map settle

// ---- 1. basic render state ------------------------------------------------
const state = await page.evaluate(() => {
  const listEl = document.getElementById("jobList");
  return {
    title: document.title,
    hasNav: !!document.querySelector(".navbar"),
    navHasJobs: !!document.querySelector('.nav-dropdown a[href="jobs.html"]'),
    listHtml: (listEl?.innerHTML || "").slice(0, 300),
    listBusy: listEl?.getAttribute("aria-busy"),
    cardCount: document.querySelectorAll(".job-card").length,
    emptyShown: !!document.querySelector(".jobs-empty"),
    mapCanvas: !!document.querySelector("#jobsMap canvas"),
    postBtn: !!document.getElementById("jobsPostBtn"),
    nearBtn: !!document.getElementById("jobsNearBtn"),
  };
});
console.log("STATE:", JSON.stringify(state, null, 2));

// ---- 2. open the post modal ------------------------------------------------
await page.click("#jobsPostBtn");
await new Promise((r) => setTimeout(r, 1200));
const postState = await page.evaluate(() => {
  const bd = document.getElementById("jobPostBackdrop");
  return {
    modalVisible: bd && !bd.hidden,
    leafletTiles: document.querySelectorAll("#jpMap .leaflet-tile").length,
    fields: ["jpTitle","jpDesc","jpWorkers","jpPay","jpDate","jpCompany","jpPhone"]
      .every((id) => !!document.getElementById(id)),
  };
});
console.log("POST MODAL:", JSON.stringify(postState));

// ---- 3. fill the form, pin via map click, submit (real insert) -------------
await page.type("#jpTitle", "__pptr test job__");
await page.type("#jpDesc", "automated test — safe to delete");
await page.type("#jpWorkers", "");           // keep default 1 → set to 2
await page.evaluate(() => { document.getElementById("jpWorkers").value = "2"; });
await page.type("#jpPay", "5k");
await page.evaluate(() => { document.getElementById("jpDate").value = new Date(Date.now() + 86400000).toISOString().slice(0,10); });
await page.type("#jpCompany", "Pptr Test Co");
await page.type("#jpPhone", "+255744444444");
// click the middle of the picker map to drop the pin (scroll it into view
// inside the modal's scroll container first)
await page.evaluate(() => document.getElementById("jpMap").scrollIntoView({ block: "center" }));
await new Promise((r) => setTimeout(r, 500));
const mapBox = await (await page.$("#jpMap")).boundingBox();
await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
await new Promise((r) => setTimeout(r, 600));
const pinTxt = await page.evaluate(() => document.getElementById("jpCoords").textContent);
console.log("PIN:", pinTxt);

await page.click("#jpSubmit");
await new Promise((r) => setTimeout(r, 4000));
const postResult = await page.evaluate(() => ({
  status: document.getElementById("jpStatus").textContent,
  statusClass: document.getElementById("jpStatus").className,
  cards: document.querySelectorAll(".job-card").length,
  firstCard: document.querySelector(".job-card .job-title")?.textContent || "",
}));
console.log("POST RESULT:", JSON.stringify(postResult));

// ---- 4. claim a slot on the new job ----------------------------------------
await new Promise((r) => setTimeout(r, 1800)); // modal auto-close
const claimable = await page.$(".job-claim-btn");
if (claimable) {
  await claimable.click();
  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(() => { document.getElementById("jcName").value = ""; document.getElementById("jcPhone").value = ""; });
  await page.type("#jcName", "Pptr Worker");
  await page.type("#jcPhone", "+255755555555");
  await page.click("#jcSubmit");
  await new Promise((r) => setTimeout(r, 3000));
  const claimResult = await page.evaluate(() => ({
    status: document.getElementById("jcStatus").textContent,
    statusClass: document.getElementById("jcStatus").className,
    quota: document.querySelector(".job-card .jq-count")?.textContent || "",
    barWidth: document.querySelector(".job-card .job-quota-fill")?.style.width || "",
  }));
  console.log("CLAIM RESULT:", JSON.stringify(claimResult));
} else {
  console.log("CLAIM: no claim button found");
}

// ---- 5. second claim with a different phone → job must lock as FULL --------
await new Promise((r) => setTimeout(r, 1800)); // first claim modal auto-close
const claim2 = await page.$(".job-claim-btn");
if (claim2) {
  await claim2.click();
  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(() => { document.getElementById("jcName").value = ""; document.getElementById("jcPhone").value = ""; });
  await page.type("#jcName", "Pptr Worker Two");
  await page.type("#jcPhone", "+255766666666");
  await page.click("#jcSubmit");
  await new Promise((r) => setTimeout(r, 3000));
  const fullState = await page.evaluate(() => ({
    status: document.getElementById("jcStatus").textContent,
    quota: document.querySelector(".job-card .jq-count")?.textContent || "",
    fullBadge: !!document.querySelector(".job-card .job-full-badge"),
    claimBtnLeft: document.querySelectorAll(".job-claim-btn").length,
    cardIsFull: !!document.querySelector(".job-card.is-full"),
  }));
  console.log("FULL LOCKOUT:", JSON.stringify(fullState));
  await new Promise((r) => setTimeout(r, 1800));
} else {
  console.log("FULL LOCKOUT: no second claim button (unexpected)");
}

// ---- 6. "Jobs near me" — distance sort with emulated GPS -------------------
await page.click("#jobsNearBtn");
await new Promise((r) => setTimeout(r, 5000));
const nearState = await page.evaluate(() => ({
  distShown: document.querySelector(".job-card .job-dist")?.textContent || "(none)",
  banner: document.getElementById("jobsBanner")?.textContent || "",
}));
console.log("NEAR ME:", JSON.stringify(nearState));

await page.screenshot({ path: "tests/jobs_page.png", fullPage: true });
console.log("\nscreenshot → tests/jobs_page.png");

console.log("\n==== CONSOLE ERRORS (" + errors.length + ") ====");
errors.forEach((e) => console.log(" •", e));

await browser.close();
process.exit(errors.length ? 2 : 0);
