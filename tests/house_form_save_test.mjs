// ============================================================================
//  house_form_save_test.mjs — Save on "List your house", and the answer it is
//  waiting for.
//
//  The board was the right shape and it broke the Save button. The listing
//  title is `required` and lives in part 2; the board takes all eight parts out
//  of the layout, and Chrome will not put a validation bubble on a control it
//  cannot focus — so it refused the submit, wrote one line to a console no
//  agent has open, and the button did nothing at all. Nothing on the screen
//  changed, twice, three times, and there was no way to find out why.
//
//  The form is `novalidate` now and the page checks instead. What it owes the
//  agent is three things, and this covers all three:
//
//    · a sentence, where they are looking, naming the PART. On a board of
//      eight tiles "fill in the missing field" is not an instruction;
//    · the part OPEN, with the cursor in the field. Naming somewhere the
//      reader cannot see is only half an answer;
//    · and nothing said about a control the page itself has hidden. The
//      minimum-months row and "specify the kind" are hidden when they do not
//      apply, and neither is an answer anybody owes.
//
//   usage:  node server.js   then:  node tests/house_form_save_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = process.env.PAWA_BASE || "http://localhost:8080";

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Everything off this host answered here, so the form is reachable with no
// network and no session. Same shape as tests/_form_shot.mjs.
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
const errors = [];

async function openForm() {
  const p = await browser.newPage();
  p.on("pageerror", (e) => errors.push(String(e).split("\n")[0]));
  await p.setViewport({ width: 412, height: 915 });
  await p.setRequestInterception(true);
  p.on("request", (r) => {
    const u = r.url();
    if (/service-worker\.js/.test(u)) {
      return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: "" });
    }
    if (/^https?:\/\/(?!localhost)/.test(u)) {
      const kind = r.resourceType();
      if (kind === "script") return r.respond({ status: 200, headers: {
        "content-type": "application/javascript", "access-control-allow-origin": "*" }, body: SDK_STUB });
      if (kind === "stylesheet") return r.respond({ status: 200, headers: {
        "content-type": "text/css", "access-control-allow-origin": "*" }, body: "" });
      return r.respond({ status: 200, headers: {
        "content-type": "application/json", "access-control-allow-origin": "*" }, body: "[]" });
    }
    r.continue();
  });
  await p.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (_) {} });
  await p.goto(`${BASE}/agent-houses.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await p.waitForFunction(() => !!window.HouseSpec, { timeout: 20000 });

  // The form sits behind the portal's auth gate, which needs a real session.
  // Unhidden by hand, as tests/_form_shot.mjs does: what is under test is the
  // submit handler, not the door in front of it.
  //
  // AFTER init, not before. With no session the page ends on the dashboard and
  // re-hides #ahFormSection, so unhiding first leaves the form hidden by the
  // time anything is submitted — and a hidden form section is the one state in
  // which the old firstMissing() found nothing wrong with an empty form.
  await p.evaluate(async () => {
    if (window.initAgentHousesPage) { try { await window.initAgentHousesPage(); } catch (_) {} }
  });
  await wait(400);
  await p.evaluate(() => {
    const gate = document.getElementById("ahAuthCard");
    const dash = document.getElementById("ahDashboard");
    const form = document.getElementById("ahFormSection");
    if (gate) gate.hidden = true;
    if (dash) dash.hidden = true;
    if (form) form.hidden = false;
  });
  // The board is what mounts the workspace, and the workspace is what can open
  // a part. Without it the whole point of the fix is untested.
  await p.waitForFunction(() => !!document.querySelector("[data-aw-go]"), { timeout: 15000 })
    .catch(() => {});
  await wait(500);
  return p;
}

/** What the form is saying, and which part is open. */
const stateOf = (p) => p.evaluate(() => {
  const msg = document.getElementById("ahFormMsg");
  const open = document.querySelector('.ap-panel[data-aw-step="on"]');
  return {
    said: msg && !msg.hidden ? msg.textContent.trim() : "",
    kind: msg ? msg.className : "",
    openPart: open ? open.id : "",
    focus: document.activeElement ? document.activeElement.id : "",
  };
});

try {
  // -------------------------------------------------------------------------
  section("1. The board is up, and the parts are out of the layout");
  const p = await openForm();
  ok(await p.evaluate(() => !!document.querySelector("[data-aw-go]")),
     "the form opens as a board of tiles");
  // This is the condition that broke it: the browser cannot put a bubble on a
  // control inside a part that is not laid out.
  ok(await p.evaluate(() => {
    const t = document.getElementById("ahTitle");
    return !!t && t.getClientRects().length === 0;
  }), "and the required title is not on screen, which is why Chrome gave up silently");
  ok(await p.evaluate(() => document.getElementById("ahForm").hasAttribute("novalidate")),
     "so the form does not ask the browser to validate it any more");

  // -------------------------------------------------------------------------
  section("2. Save with nothing filled in says which part is waiting");
  await p.evaluate(() => {
    document.getElementById("ahTitle").value = "";
    document.getElementById("ahForm").requestSubmit
      ? document.getElementById("ahForm").requestSubmit()
      : document.getElementById("ahForm").dispatchEvent(new Event("submit", { cancelable: true }));
  });
  await wait(700);
  const empty = await stateOf(p);
  ok(empty.said !== "", "the Save button says something, rather than nothing at all", JSON.stringify(empty));
  // "The basics", as part 2's own heading says it. A message that named a field
  // would be a message about somewhere the reader cannot see.
  ok(/basics/i.test(empty.said), "and names the part, the way the tile does", empty.said);
  ok(/error/.test(empty.kind), "worded and coloured as something to fix", empty.kind);
  ok(empty.openPart === "ahSecBasics", "the part it names is now open", empty.openPart);
  ok(empty.focus === "ahTitle", "with the cursor already in the field that is missing", empty.focus);

  // -------------------------------------------------------------------------
  section("3. It stops at the first thing missing, then moves on to the next");
  // A title, but still no pin. The pin is not a form control at all, so it
  // could never have been caught by the browser either way.
  await p.evaluate(() => {
    document.getElementById("ahTitle").value = "2-bed apartment, ocean view";
    document.getElementById("ahForm").requestSubmit();
  });
  await wait(700);
  const noPin = await stateOf(p);
  ok(/pin|map/i.test(noPin.said), "with the title answered it asks for the pin", noPin.said);
  ok(noPin.openPart === "ahSecWhere", "and opens the part with the map on it", noPin.openPart);

  // -------------------------------------------------------------------------
  section("4. Nothing is asked about a box the page itself has hidden");
  // "Specify the kind" only applies when the type is 'something else', and the
  // minimum-months row only to a rental. Neither is an answer anybody owes, and
  // a submit that stopped on one would be unanswerable: the row is not there.
  ok(await p.evaluate(() => {
    const row = document.getElementById("ahTypeOtherRow");
    return !!row && row.hidden;
  }), "the 'specify the kind' row is hidden while the type is an ordinary one");
  await p.evaluate(() => {
    document.getElementById("ahListing").value = "sale";
    document.getElementById("ahListing").dispatchEvent(new Event("change", { bubbles: true }));
  });
  await wait(400);
  await p.evaluate(() => document.getElementById("ahForm").requestSubmit());
  await wait(700);
  const hidden = await stateOf(p);
  ok(!/months|kind/i.test(hidden.said),
     "and a submit never stops on either of them", hidden.said);
  // It is still the pin that is missing, so that is still what it says.
  ok(/pin|map/i.test(hidden.said), "it is still the pin it is waiting for", hidden.said);

  section("5. No errors");
  ok(errors.length === 0, "no page threw anything", errors.join(" | "));
  await p.close();
} catch (e) {
  fail++;
  console.log("  FAIL  the run itself threw\n        " + String(e).split("\n")[0]);
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
