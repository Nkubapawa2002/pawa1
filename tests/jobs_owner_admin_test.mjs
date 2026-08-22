// Verifies: (1) company owner sees claimed workers on jobs.html ("My jobs"),
// (2) admin.html and super-admin.html load without JS errors.
// Run: node tests/jobs_owner_admin_test.mjs
//
// THIS TEST WRITES TO PRODUCTION. There is no fixture database here, and the
// flow being checked — post a job, claim a slot, read the worker back as the
// owner — is three RPCs deep and only means anything against the real ones. So
// it posts a job titled `__pptr owner test__` and DELETES IT AT BOTH ENDS, the
// same way the pm_* database tests handle their `pmtest_` rows.
//
// The cleanup is not tidiness. day_jobs is the live jobs board: a leftover row
// is a fake job with a fake phone number sitting in front of people looking for
// work. Eight of them had accumulated before this was added.
//
// It also waits on conditions rather than on the clock. Every step here crosses
// a real network — Supabase for the post, Nominatim for the reverse-geocode
// inside the submit handler, map tiles behind the pin — so "wait 1300ms and
// then click" is a guess that holds on a fast run and fails on a slow one. It
// was failing that way: the submit landed before the form was ready, nothing
// happened, and the run then died on a claim dialog that had never opened.
import puppeteer from "puppeteer";
import { runSql, literal } from "../scripts/db/sql.mjs";

const BASE = "http://localhost:8080";
const JOB_TITLE = "__pptr owner test__";
const WORKER_NAME = "Owner Test Worker";
const failures = [];

// ---- production cleanup -----------------------------------------------------
// Children first: day_job_claims and the two ownership tables key off job_id.
// Matched on the title rather than on ids captured during the run, so a run
// that died halfway through still gets swept up by the next one.
async function cleanup() {
  await runSql(`
    delete from public.day_job_claims
      where job_id in (select id from public.day_jobs where title like '__pptr%');
    delete from public.day_job_owner_tokens
      where job_id in (select id from public.day_jobs where title like '__pptr%');
    delete from public.day_job_owners
      where job_id in (select id from public.day_jobs where title like '__pptr%');
    delete from public.day_jobs where title like '__pptr%';
  `);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Click something that is really there and really visible.
 *
 * page.click() resolves an element to a viewport point and clicks the point, so
 * it hits whatever is painted on top. On this page the submit button sits
 * directly under a Leaflet map that has just been scrolled into view, which is
 * how "Node is either not clickable or not an Element" happened. Scrolling the
 * target to the middle first puts it clear of the map, and waiting for a
 * non-zero box means we are not clicking at a element that has not been laid
 * out yet.
 */
async function clickWhenReady(page, selector, timeout = 15000) {
  await page.waitForSelector(selector, { visible: true, timeout });
  await page.evaluate((s) => {
    document.querySelector(s).scrollIntoView({ block: "center", behavior: "instant" });
  }, selector);
  await page.waitForFunction((s) => {
    const n = document.querySelector(s);
    if (!n) return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !n.disabled;
  }, { timeout }, selector);
  await page.click(selector);
}

/** Wait for #<id> to carry one of the status classes the page sets. */
async function waitForStatus(page, id, timeout = 30000) {
  try {
    await page.waitForFunction((i) => {
      const n = document.getElementById(i);
      return !!n && /\b(ok|err)\b/.test(n.className);
    }, { timeout }, id);
  } catch (_) { /* the caller's assertion reports it */ }
  return page.evaluate((i) => {
    const n = document.getElementById(i);
    return { cls: n ? n.className : "(missing)", text: n ? n.textContent.trim() : "" };
  }, id);
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });

async function newPage() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page._errs = [];
  page.on("pageerror", (e) => page._errs.push("PAGEERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_ABORTED|net::/.test(m.text())) page._errs.push(m.text()); });
  return page;
}

try {
  await cleanup();                       // in case an earlier run died mid-flight

  // ---- 1. jobs.html owner flow ----------------------------------------------
  const page = await newPage();
  console.log("→ jobs.html owner flow …");
  await page.goto(BASE + "/jobs.html", { waitUntil: "domcontentloaded", timeout: 60000 });

  // post a job
  await clickWhenReady(page, "#jobsPostBtn");
  await page.waitForSelector("#jpTitle", { visible: true, timeout: 15000 });
  await page.type("#jpTitle", JOB_TITLE);
  await page.type("#jpDesc", "owner visibility test");
  await page.type("#jpPay", "8k");
  await page.evaluate(() => {
    document.getElementById("jpWorkers").value = "3";
    document.getElementById("jpDate").value = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  });
  await page.type("#jpCompany", "Owner Test Co");
  await page.type("#jpPhone", "+255788888888");

  // Pin the location. The handler refuses to post without one, and the pin is
  // set by a real map click rather than by writing a variable, because "the
  // map accepts a tap" is part of what this is checking.
  await page.evaluate(() => document.getElementById("jpMap").scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForFunction(() => {
    const r = document.getElementById("jpMap").getBoundingClientRect();
    return r.width > 50 && r.height > 50;
  }, { timeout: 15000 });
  const mb = await (await page.$("#jpMap")).boundingBox();
  await page.mouse.click(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await page.waitForFunction(
    () => /-?\d+\.\d+/.test(document.getElementById("jpCoords").textContent),
    { timeout: 15000 });

  // The form must actually be submittable before we claim the click failed —
  // an unfilled `required` field blocks submit silently and would look
  // identical to a broken handler.
  const invalid = await page.evaluate(() =>
    [...document.querySelectorAll("#jobPostForm input, #jobPostForm textarea, #jobPostForm select")]
      .filter((n) => !n.checkValidity()).map((n) => n.id));
  if (invalid.length) failures.push("jobs: form not fillable, invalid fields: " + invalid.join(", "));

  await clickWhenReady(page, "#jpSubmit");
  const post = await waitForStatus(page, "jpStatus");
  const posted = post.cls.includes("ok");
  if (!posted) failures.push("jobs: post failed — " + post.cls + " " + post.text);
  console.log("  posted:", posted, posted ? "" : JSON.stringify(post));

  // The post dialog closes ITSELF, 1.6s after a successful post. Until it does,
  // its backdrop covers the board — so a claim click sent too early lands on
  // the backdrop, which is wired to dismiss it, and the claim dialog never
  // opens. That is the failure this test was dying on, and it is invisible from
  // the outside: the post genuinely succeeded, and the next step just found
  // nothing to click.
  if (posted) {
    try {
      await page.waitForFunction(
        () => document.getElementById("jobPostBackdrop").hidden, { timeout: 15000 });
    } catch (_) { failures.push("jobs: post dialog never closed itself"); }
  }

  // claim one slot as a worker → must receive a worker number (on-site ID)
  const claimBtn = posted ? await page.$(".job-claim-btn") : null;
  if (!claimBtn) {
    if (posted) failures.push("jobs: no claim button after post");
  } else {
    await clickWhenReady(page, ".job-claim-btn");
    await page.waitForSelector("#jcSubmit", { visible: true, timeout: 15000 });
    await page.evaluate(() => { document.getElementById("jcName").value = ""; document.getElementById("jcPhone").value = ""; });
    await page.type("#jcName", WORKER_NAME);
    await page.type("#jcPhone", "+255799999999");
    await clickWhenReady(page, "#jcSubmit");
    const cs = await waitForStatus(page, "jcStatus");
    const claim = await page.evaluate(() => ({
      msg: document.getElementById("jcStatus").textContent,
      stored: localStorage.getItem("pawa_my_claims") || "",
    }));
    console.log("  CLAIM:", JSON.stringify(claim));
    if (!/W\d+-\d\d/.test(claim.msg)) failures.push("jobs: claim reply has no worker number — " + cs.cls);
    if (!/W\d+-\d\d/.test(claim.stored)) failures.push("jobs: worker number not stored locally");
  }

  // The claim dialog closes itself too, 3.2s after a successful claim — same
  // trap as the post dialog above, one backdrop further on.
  if (claimBtn) {
    try {
      await page.waitForFunction(
        () => document.getElementById("jobClaimBackdrop").hidden, { timeout: 15000 });
    } catch (_) { failures.push("jobs: claim dialog never closed itself"); }
  }

  // the card must keep showing the worker's own number, once the modal has
  // closed itself and the list has been redrawn
  let cardCode = "";
  if (posted) {
    try {
      await page.waitForFunction(
        () => /W\d+-\d\d/.test(document.querySelector(".job-mycode")?.textContent || ""),
        { timeout: 15000 });
    } catch (_) { /* asserted below */ }
    cardCode = await page.evaluate(() => document.querySelector(".job-mycode")?.textContent || "");
  }
  console.log("  CARD CODE:", JSON.stringify(cardCode));
  if (!/W\d+-\d\d/.test(cardCode)) failures.push("jobs: card does not show my worker number");

  // open "My jobs & workers" — ownership comes from the per-job token this
  // device stored when posting (pawa_my_posts), not a phone number.
  await clickWhenReady(page, "#jobsMineBtn");
  try {
    await page.waitForFunction(
      () => !document.getElementById("jobMineBackdrop").hidden &&
            document.querySelectorAll("#jmResults .jm-job").length > 0,
      { timeout: 20000 });
  } catch (_) { /* asserted below */ }
  const mine = await page.evaluate(() => ({
    modal: !document.getElementById("jobMineBackdrop").hidden,
    ownsToken: Object.values(JSON.parse(localStorage.getItem("pawa_my_posts") || "{}"))
                 .some((p) => p && p.token),
    jobCount: document.querySelectorAll("#jmResults .jm-job").length,
    firstJob: document.querySelector("#jmResults .jm-job-title")?.textContent || "",
    meta: document.querySelector("#jmResults .jm-job-meta")?.textContent || "",
    workers: [...document.querySelectorAll("#jmResults .jm-worker")].map((li) => li.textContent.replace(/\s+/g, " ").trim()),
  }));
  console.log("  MY JOBS:", JSON.stringify(mine, null, 2));
  if (!mine.modal) failures.push("jobs: my-jobs modal did not open");
  if (!mine.ownsToken) failures.push("jobs: owner token not stored on device after posting");
  if (!mine.jobCount) failures.push("jobs: owner sees no jobs");
  if (!mine.workers.some((w) => w.includes(WORKER_NAME) && w.includes("255799999999")))
    failures.push("jobs: claimed worker NOT visible to owner");
  if (!mine.workers.some((w) => /W\d+-\d\d/.test(w)))
    failures.push("jobs: owner does not see the worker's on-site number");
  if (page._errs.length) failures.push("jobs.html errors: " + page._errs.join(" | "));
  await page.screenshot({ path: "tests/jobs_owner.png" });
  await page.close();

  // ---- 2. admin.html + super-admin.html load clean ---------------------------
  for (const p of ["admin.html", "super-admin.html"]) {
    const pg = await newPage();
    console.log(`→ ${p} …`);
    await pg.goto(`${BASE}/${p}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    try {
      await pg.waitForSelector("#loginGate:not([hidden]), #saLoginGate:not([hidden])",
        { visible: true, timeout: 20000 });
    } catch (_) { /* asserted below */ }
    const st = await pg.evaluate(() => ({
      loginVisible: !!document.querySelector("#loginGate:not([hidden]), #saLoginGate:not([hidden])"),
      panelHidden: !document.querySelector("#adminPanel:not([hidden]), #saPanel:not([hidden])"),
    }));
    console.log("  ", JSON.stringify(st), "errors:", pg._errs.length);
    if (!st.loginVisible) failures.push(`${p}: login gate not shown`);
    if (pg._errs.length) failures.push(`${p} errors: ` + pg._errs.join(" | "));
    await pg.close();
  }
} catch (err) {
  // Counted, not swallowed. An exception here used to end the process with a
  // stack trace and no RESULT line, which reads as a crashed harness rather
  // than as a failing test.
  failures.push("threw: " + (err && err.stack ? err.stack.split("\n")[0] : err));
} finally {
  await browser.close();
  try {
    await cleanup();
    const left = await runSql(
      `select count(*)::int as n from public.day_jobs where title like '__pptr%';`);
    const n = left && left[0] ? Number(left[0].n) : -1;
    if (n !== 0) failures.push(`cleanup: ${n} test job(s) still in production`);
    else console.log("\n  (test rows removed from production)");
  } catch (err) {
    failures.push("cleanup FAILED, rows left in production: " + (err && err.message ? err.message : err));
  }
}

console.log("\n==== RESULT ====");
if (failures.length) { failures.forEach((f) => console.log(" ", f)); process.exit(2); }
console.log("  all checks passed");
