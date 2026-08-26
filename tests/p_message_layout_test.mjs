// ============================================================================
// p_message_layout_test.mjs — the P-Message conversation as a THING YOU TYPE INTO.
//
// p_message_page_test.mjs proves the page keeps its cryptographic promise.
// This one proves the far more mundane thing that was broken first: that you
// can see what you are writing.
//
// Two bugs are guarded here, both invisible on a desktop browser:
//
//   1. THE KEYBOARD. On a phone the on-screen keyboard does not shrink the
//      layout viewport. A position:fixed inset:0 panel therefore keeps its
//      full height and the composer sits BEHIND the keyboard — you type and
//      the words are under your thumbs. The panel is sized from
//      window.visualViewport instead, republished as --pm-vvh/--pm-vvt.
//   2. THE ONE-LINE BOX. The textarea had a fixed 44px height and nothing
//      grew it, so anything past one line was typed blind. It is now sized
//      from scrollHeight on every keystroke and clamped to 40% of the
//      VISIBLE height — not of 100vh, which with a keyboard open is a
//      completely different number.
//
//   usage:  node server.js      then, in another shell:
//           node tests/p_message_layout_test.mjs
// ============================================================================
import puppeteer from "puppeteer";
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 180000 });
const p = await b.newPage();
await p.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
p.on("pageerror", e => console.log("PAGEERROR:", String(e).split("\n")[0]));
await p.setRequestInterception(true);
p.on("request", r => {
  const u = r.url();
  if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
  if (/cdn\.jsdelivr|fonts\./.test(u)) return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
  if (/supabase\.co/.test(u)) return r.respond({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
  r.continue();
});
await p.goto("http://localhost:8080/p-message.html", { waitUntil: "domcontentloaded" });
await new Promise(r => setTimeout(r, 3000));

let pass = 0, fail = 0;
const ok = (c, m, d) => { c ? (pass++, console.log("  PASS  " + m)) : (fail++, console.log("  FAIL  " + m + (d ? "  [" + d + "]" : ""))); };

// The gate covers the list, so the conversation panel is opened directly —
// this is a layout test, not a flow test.
await p.evaluate(() => {
  document.getElementById("pmConv").classList.add("is-on");
  const log = document.getElementById("pmLog");
  log.innerHTML = Array.from({ length: 30 },
    (_, i) => '<div class="pm-msg' + (i % 2 ? " mine" : "") + '">Message number ' + i + '</div>').join("");
});
await new Promise(r => setTimeout(r, 300));

console.log("\n1. The viewport variables exist and describe the real viewport");
const vv = await p.evaluate(() => ({
  h: getComputedStyle(document.documentElement).getPropertyValue("--pm-vvh").trim(),
  t: getComputedStyle(document.documentElement).getPropertyValue("--pm-vvt").trim(),
  inner: window.innerHeight,
}));
ok(vv.h !== "", "--pm-vvh is published", JSON.stringify(vv));
ok(Math.abs(parseInt(vv.h) - vv.inner) <= 2, "--pm-vvh matches the visible height (" + vv.h + " vs " + vv.inner + "px)");
ok(vv.t === "0px", "--pm-vvt is 0 with no keyboard open");

console.log("\n2. The composer grows with what is typed");
const grow = await p.evaluate(async () => {
  const ta = document.getElementById("pmInput");
  const before = ta.getBoundingClientRect().height;
  ta.focus();
  ta.value = "";
  const heights = [];
  for (let i = 1; i <= 8; i++) {
    ta.value += "Habari yako ndugu, hii ni mstari namba " + i + ".\n";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => requestAnimationFrame(r));
    heights.push(Math.round(ta.getBoundingClientRect().height));
  }
  return { before: Math.round(before), heights, max: Math.round(parseFloat(getComputedStyle(ta).maxHeight)) };
});
ok(grow.before <= 44, "starts as a single line (" + grow.before + "px)");
ok(grow.heights[2] > grow.before, "grows by the third line (" + grow.heights[2] + "px)");
ok(grow.heights[7] > grow.heights[2], "keeps growing (" + grow.heights[7] + "px)");
ok(grow.heights[7] <= grow.max + 1, "but stops at max-height " + grow.max + "px rather than eating the screen");

console.log("\n3. Everything the person is looking at is still on screen");
const box = await p.evaluate(() => {
  const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height }; };
  return { ta: r("pmInput"), send: r("pmSendBtn"), log: r("pmLog"), h: window.innerHeight };
});
ok(box.ta.bottom <= box.h + 1, "the text being typed is inside the viewport (bottom " + Math.round(box.ta.bottom) + " of " + box.h + ")");
ok(box.send.bottom <= box.h + 1, "so is the send button (bottom " + Math.round(box.send.bottom) + ")");
ok(box.log.height > 200, "and the conversation still has room (" + Math.round(box.log.height) + "px)");

console.log("\n4. The log scrolls instead of shoving the composer off the bottom");
const scr = await p.evaluate(() => {
  const l = document.getElementById("pmLog");
  return { scrollable: l.scrollHeight > l.clientHeight, clientH: l.clientHeight, scrollH: l.scrollHeight };
});
ok(scr.scrollable, "30 messages make the log scroll (" + scr.scrollH + " into " + scr.clientH + ")");

console.log("\n5. A shrinking viewport — what the keyboard does — is followed");
await p.setViewport({ width: 390, height: 420, isMobile: true, hasTouch: true });
await new Promise(r => setTimeout(r, 400));
const after = await p.evaluate(() => ({
  vvh: getComputedStyle(document.documentElement).getPropertyValue("--pm-vvh").trim(),
  ta: (b => ({ bottom: b.bottom }))(document.getElementById("pmInput").getBoundingClientRect()),
  conv: (b => ({ height: b.height }))(document.getElementById("pmConv").getBoundingClientRect()),
  h: window.innerHeight,
}));
ok(Math.abs(parseInt(after.vvh) - after.h) <= 2, "--pm-vvh followed it down to " + after.vvh);
ok(Math.round(after.conv.height) <= after.h + 1, "the panel shrank with it (" + Math.round(after.conv.height) + "px)");
ok(after.ta.bottom <= after.h + 1, "and the input is STILL visible (bottom " + Math.round(after.ta.bottom) + " of " + after.h + ")");

await p.screenshot({ path: "tests/shot_pm_keyboard.png" });
await p.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
await new Promise(r => setTimeout(r, 400));
await p.screenshot({ path: "tests/shot_pm_thread.png" });

console.log("\n" + pass + " passed, " + fail + " failed");
await b.close();
process.exit(fail ? 1 : 0);
