// ============================================================================
//  house_bathroom_test.mjs — "is the bathroom inside the room or outside?"
//
//  It is the question that settles a viewing before anybody spends a Saturday
//  and a daladala fare, and until now the app got it wrong in three separate
//  places at once:
//
//    · the FORM asked it as two of thirty-three characteristic chips, carrying
//      the same weight as "Freshly painted", and let an agent tick "inside"
//      and "outside" on the same room
//    · the DETAIL SHEET read a boolean derived from those chips, so a room
//      marked "Bathroom outside" printed "Shared"
//    · and a room whose agent never mentioned the bathroom ALSO printed
//      "Shared", which is a guess presented as a fact
//
//  Half of this is pure logic and needs no browser; the other half is the
//  form's own control and does. Both are here, because the whole point is that
//  they now agree.
//
//   usage:  node tests/house_bathroom_test.mjs   (needs `node server.js` up)
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import puppeteer from "puppeteer";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.PAWA_BASE || "http://localhost:8080";

let pass = 0;
const fails = [];
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); return; }
  fails.push(detail ? msg + "\n        " + detail : msg);
  console.log("  FAIL  " + msg + (detail ? "\n        " + detail : ""));
};

// --- the logic, straight ----------------------------------------------------
const store = new Map();
const sandbox = {
  console,
  window: {},
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};
sandbox.window.window = sandbox.window;
sandbox.window.localStorage = sandbox.localStorage;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, "js/lib/house-spec.js"), "utf8"), sandbox);
const HS = sandbox.window.HouseSpec;

console.log("\n1. Three answers, and an absence that is not one of them");
{
  const of = (feats, extra) => HS.bathroom(Object.assign({ features: feats }, extra || {}));

  ok(of(["bath_inside"]).key === "inside", "the inside chip reads as inside");
  ok(of(["toilet_inside"]).key === "inside", "and so does the toilet twin");
  ok(of(["bath_shared"]).key === "shared", "the shared chip reads as shared");
  ok(of(["bath_outside"]).key === "outside",
     "and the OUTSIDE chip reads as outside, which used to render as 'Shared'");

  // The one that matters most.
  ok(of(["tiles", "ceiling"]) === null,
     "a room whose agent never said gets NULL, not a guess");
  ok(of([]) === null, "and so does a room with nothing recorded at all");
  ok(HS.bathroomShort({ features: [] }) !== HS.bathroomShort({ features: ["bath_shared"] }),
     "so 'not said' and 'shared' are two different words on screen",
     HS.bathroomShort({ features: [] }) + " vs " + HS.bathroomShort({ features: ["bath_shared"] }));

  // Legacy rows, which had a boolean and no chips.
  ok(of([], { ensuite: true }).key === "inside",
     "an old row carrying ensuite:true still reads as inside");
  ok(of([], { ensuite: false }) === null,
     "but ensuite:false is the ABSENCE of a claim, not a claim of sharing");

  // Contradiction. The form prevents it now; data written before it could not.
  ok(of(["bath_outside", "bath_inside"]).key === "inside",
     "given both, the stronger claim wins rather than whichever came first");
}

console.log("\n2. A size band says what it covers");
{
  ok(HS.sizeLabel("medium") === "Medium", "the band is still the plain word");
  ok(/wardrobe/i.test(HS.sizeHint("medium")),
     "and now carries a sentence about furniture, not a number nobody measured",
     HS.sizeHint("medium"));
  ok(HS.sizeHint("") === "", "a listing with no band gets no sentence");
  ok(/photos/i.test(HS.sizeNote()), "and the bracket caveat is still there");
}

// --- the form's own control -------------------------------------------------
//
// The stub tests/_form_shot.mjs uses. maplibre, leaflet and supabase-js all
// come off a CDN this environment cannot reach, and agent-houses.js does not
// guard on any of them: without a window.supabase that answers, its init never
// gets far enough to wire the Add-a-room button, and the failure is silent.
const SDK_STUB = `(function(){
  function C(){return new Proxy(function(){},{get:(t,k)=>k==="then"?undefined:C(),apply:()=>C(),construct:()=>C()})}
  window.maplibregl=C(); window.L=C();
  function q(){const p=Promise.resolve({data:[],error:null});
    return new Proxy(function(){},{get:(t,k)=>k==="then"?p.then.bind(p):k==="catch"?p.catch.bind(p):q(),apply:()=>q()})}
  window.supabase={createClient:()=>({
    from:()=>q(), rpc:()=>q(), channel:()=>C(), removeChannel:()=>{},
    storage:{from:()=>q()},
    functions:{invoke:()=>Promise.resolve({data:null,error:null})},
    auth:{
      getSession:()=>Promise.resolve({data:{session:null}}),
      getUser:()=>Promise.resolve({data:{user:null}}),
      onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),
      signOut:()=>Promise.resolve({})
    }})};
})();`;

const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
});

console.log("\n3. The form asks it once, plainly, and the answers exclude each other");
{
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  await page.setViewport({ width: 412, height: 915 });
  await page.setRequestInterception(true);
  // Same stub tests/_form_shot.mjs uses: everything off this host is answered
  // here, so the form can be reached without a network or a session.
  page.on("request", (r) => {
    const u = r.url();
    if (/service-worker\.js/.test(u)) {
      return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: "" });
    }
    if (/^https?:\/\/(?!localhost)/.test(u)) {
      const kind = r.resourceType();
      if (kind === "script") return r.respond({ status: 200, headers: {
        "content-type": "application/javascript", "access-control-allow-origin": "*" },
        body: SDK_STUB });
      if (kind === "stylesheet") return r.respond({ status: 200, headers: {
        "content-type": "text/css", "access-control-allow-origin": "*" }, body: "" });
      return r.respond({ status: 200, headers: {
        "content-type": "application/json", "access-control-allow-origin": "*" }, body: "[]" });
    }
    r.continue();
  });
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (_) {} });
  await page.goto(`${BASE}/agent-houses.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => !!window.HouseSpec, { timeout: 20000 });

  // The form sits behind the portal's auth gate, which needs a real session.
  // Unhidden by hand, exactly as tests/_form_shot.mjs does: what is under test
  // is the room card's own control, not the door in front of it.
  await page.evaluate(() => {
    const gate = document.getElementById("ahAuthCard");
    const dash = document.getElementById("ahDashboard");
    const form = document.getElementById("ahFormSection");
    if (gate) gate.hidden = true;
    if (dash) dash.hidden = true;
    if (form) form.hidden = false;
  });
  // initAgentHousesPage is what binds Add-a-room, and with no session the page
  // may never have called it. Calling it twice is harmless; not calling it at
  // all leaves a button nothing is listening to, which is what a first pass at
  // this test spent its time discovering.
  await page.evaluate(async () => {
    if (window.initAgentHousesPage) { try { await window.initAgentHousesPage(); } catch (_) {} }
  });
  await page.waitForFunction(
    () => { const b = document.getElementById("ahAddRoomBtn"); return !!b; },
    { timeout: 10000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));

  // Add a room the way the page does, then drive its bathroom control.
  //
  // Everything below is scoped to ONE room card. init() opens the form with a
  // room already on it and the button adds a second, so a document-wide
  // querySelectorAll counts six buttons and reports the control as broken when
  // it is working perfectly on both cards.
  const built = await page.evaluate(() => {
    const btn = document.getElementById("ahAddRoomBtn");
    if (btn) btn.click();
    const card = document.querySelector(".ah-room");
    if (card) card.id = "underTest";
    return card ? card.querySelectorAll(".ah-bath").length : 0;
  });
  ok(built >= 1, "a room card carries the bathroom question", String(built));

  if (built >= 1) {
    const answers = await page.$$eval("#underTest .ah-bath__b", (els) => els.map((e) => ({
      key: e.dataset.bath, label: e.textContent.trim(),
    })));
    ok(answers.length === 3, "with exactly three answers", JSON.stringify(answers));
    ok(answers.map((a) => a.key).join(",") === "inside,shared,outside",
       "inside, shared, outside", JSON.stringify(answers.map((a) => a.key)));

    const pick = (k) => page.evaluate((key) => {
      document.querySelector(`#underTest .ah-bath__b[data-bath="${key}"]`).click();
      return [...document.querySelectorAll("#underTest .ah-feats__on li")].map((li) => li.dataset.feat);
    }, k);

    let feats = await pick("inside");
    ok(feats.includes("bath_inside"), "choosing inside records it", JSON.stringify(feats));

    feats = await pick("outside");
    ok(feats.includes("bath_outside"), "choosing outside records that", JSON.stringify(feats));
    // THE ASSERTION THE OLD CHIPS COULD NOT PASS.
    ok(!feats.includes("bath_inside"),
       "and REMOVES inside, so one room can never carry two answers",
       JSON.stringify(feats));

    feats = await pick("outside");
    ok(!feats.includes("bath_outside"),
       "tapping the chosen answer again clears it, so an agent who does not know can say nothing");

    const lit = await page.$$eval("#underTest .ah-bath__b", (els) =>
      els.filter((e) => e.classList.contains("is-on")).length);
    ok(lit === 0, "and nothing is lit once it is cleared", String(lit));

    // The other direction: the chip list is the record, so removing a chip has
    // to un-answer the question.
    await page.evaluate(() => {
      document.querySelector('#underTest .ah-fg[data-feat="bath_shared"]').click();
    });
    let onNow = await page.$$eval("#underTest .ah-bath__b.is-on", (els) => els.map((e) => e.dataset.bath));
    ok(onNow.join() === "shared",
       "ticking the chip in the list answers the question above it", JSON.stringify(onNow));
    await page.evaluate(() => {
      document.querySelector('#underTest .ah-feats__on li[data-feat="bath_shared"] button').click();
    });
    onNow = await page.$$eval("#underTest .ah-bath__b.is-on", (els) => els.map((e) => e.dataset.bath));
    ok(onNow.length === 0,
       "and removing it un-answers it, because the list is the record and the question is a view of it",
       JSON.stringify(onNow));

    // The size bracket must not have been disturbed by any of that.
    await page.evaluate(() => document.querySelector('#underTest .ah-band__b[data-band="medium"]').click());
    await page.evaluate(() => document.querySelector('#underTest .ah-bath__b[data-bath="inside"]').click());
    const size = await page.$$eval('#underTest .ah-band__b[data-band]', (els) =>
      els.filter((e) => e.classList.contains("is-on")).map((e) => e.dataset.band));
    ok(size.join() === "medium",
       "answering the bathroom does not clear the size, which shares its styling",
       JSON.stringify(size));
  }

  ok(errs.length === 0, "no page errors", errs.slice(0, 3).join(" | "));
  await page.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
