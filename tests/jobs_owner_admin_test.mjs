// Verifies: (1) company owner sees claimed workers on jobs.html ("My jobs"),
// (2) admin.html and super-admin.html load without JS errors.
// Run: node tests/jobs_owner_admin_test.mjs
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
const failures = [];

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });

async function newPage() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page._errs = [];
  page.on("pageerror", (e) => page._errs.push("PAGEERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_ABORTED|net::/.test(m.text())) page._errs.push(m.text()); });
  return page;
}

// ---- 1. jobs.html owner flow ------------------------------------------------
const page = await newPage();
console.log("→ jobs.html owner flow …");
await page.goto(BASE + "/jobs.html", { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise((r) => setTimeout(r, 2500));

// post a job
await page.click("#jobsPostBtn");
await new Promise((r) => setTimeout(r, 1300));
await page.type("#jpTitle", "__pptr owner test__");
await page.type("#jpDesc", "owner visibility test");
await page.type("#jpPay", "8k");
await page.evaluate(() => {
  document.getElementById("jpWorkers").value = "3";
  document.getElementById("jpDate").value = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
});
await page.type("#jpCompany", "Owner Test Co");
await page.type("#jpPhone", "+255788888888");
await page.evaluate(() => document.getElementById("jpMap").scrollIntoView({ block: "center" }));
await new Promise((r) => setTimeout(r, 500));
const mb = await (await page.$("#jpMap")).boundingBox();
await page.mouse.click(mb.x + mb.width / 2, mb.y + mb.height / 2);
await new Promise((r) => setTimeout(r, 600));
await page.click("#jpSubmit");
await new Promise((r) => setTimeout(r, 4200));
const posted = await page.evaluate(() => document.getElementById("jpStatus").className.includes("ok"));
if (!posted) failures.push("jobs: post failed");
console.log("  posted:", posted);

// claim one slot as a worker → must receive a worker number (on-site ID)
const claimBtn = await page.$(".job-claim-btn");
if (!claimBtn) failures.push("jobs: no claim button after post");
else {
  await claimBtn.click();
  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(() => { document.getElementById("jcName").value = ""; document.getElementById("jcPhone").value = ""; });
  await page.type("#jcName", "Owner Test Worker");
  await page.type("#jcPhone", "+255799999999");
  await page.click("#jcSubmit");
  await new Promise((r) => setTimeout(r, 3000));
  const claim = await page.evaluate(() => ({
    msg: document.getElementById("jcStatus").textContent,
    stored: localStorage.getItem("pawa_my_claims") || "",
  }));
  console.log("  CLAIM:", JSON.stringify(claim));
  if (!/W\d+-\d\d/.test(claim.msg)) failures.push("jobs: claim reply has no worker number");
  if (!/W\d+-\d\d/.test(claim.stored)) failures.push("jobs: worker number not stored locally");
}

// the card must keep showing the worker's own number
await new Promise((r) => setTimeout(r, 3600)); // modal auto-close
const cardCode = await page.evaluate(() => document.querySelector(".job-mycode")?.textContent || "");
console.log("  CARD CODE:", JSON.stringify(cardCode));
if (!/W\d+-\d\d/.test(cardCode)) failures.push("jobs: card does not show my worker number");

// open "My jobs & workers" — ownership comes from the per-job token this
// device stored when posting (pawa_my_posts), not a phone number.
await page.click("#jobsMineBtn");
await new Promise((r) => setTimeout(r, 3500));
const mine = await page.evaluate(() => ({
  modal: !document.getElementById("jobMineBackdrop").hidden,
  ownsToken: !!JSON.parse(localStorage.getItem("pawa_my_posts") || "{}") &&
             Object.values(JSON.parse(localStorage.getItem("pawa_my_posts") || "{}")).some(p => p && p.token),
  jobCount: document.querySelectorAll("#jmResults .jm-job").length,
  firstJob: document.querySelector("#jmResults .jm-job-title")?.textContent || "",
  meta: document.querySelector("#jmResults .jm-job-meta")?.textContent || "",
  workers: [...document.querySelectorAll("#jmResults .jm-worker")].map(li => li.textContent.replace(/\s+/g, " ").trim()),
}));
console.log("  MY JOBS:", JSON.stringify(mine, null, 2));
if (!mine.modal) failures.push("jobs: my-jobs modal did not open");
if (!mine.ownsToken) failures.push("jobs: owner token not stored on device after posting");
if (!mine.jobCount) failures.push("jobs: owner sees no jobs");
if (!mine.workers.some(w => w.includes("Owner Test Worker") && w.includes("255799999999")))
  failures.push("jobs: claimed worker NOT visible to owner");
if (!mine.workers.some(w => /W\d+-\d\d/.test(w)))
  failures.push("jobs: owner does not see the worker's on-site number");
if (page._errs.length) failures.push("jobs.html errors: " + page._errs.join(" | "));
await page.screenshot({ path: "tests/jobs_owner.png" });
await page.close();

// ---- 2. admin.html + super-admin.html load clean -----------------------------
for (const p of ["admin.html", "super-admin.html"]) {
  const pg = await newPage();
  console.log(`→ ${p} …`);
  await pg.goto(`${BASE}/${p}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));
  const st = await pg.evaluate(() => ({
    loginVisible: !!document.querySelector("#loginGate:not([hidden]), #saLoginGate:not([hidden])"),
    panelHidden: !document.querySelector("#adminPanel:not([hidden]), #saPanel:not([hidden])"),
  }));
  console.log("  ", JSON.stringify(st), "errors:", pg._errs.length);
  if (!st.loginVisible) failures.push(`${p}: login gate not shown`);
  if (pg._errs.length) failures.push(`${p} errors: ` + pg._errs.join(" | "));
  await pg.close();
}

await browser.close();
console.log("\n==== RESULT ====");
if (failures.length) { failures.forEach(f => console.log(" ", f)); process.exit(2); }
console.log("  all checks passed");
