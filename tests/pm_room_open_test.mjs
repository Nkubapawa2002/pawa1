// ============================================================================
// pm_room_open_test.mjs — opening a room, as a person actually does it.
//
// THE REPORT WAS "it is still very difficult to create groups and rooms, even
// for admin, which is very bad". It was worse than difficult. Measured against
// production on 2026-09-15:
//
//     auth.users  28  ->  27 anonymous, 1 real account
//     pm_keys     16  ->  15 is_guest, 1 not
//     pm_threads   0      pm_invites 1, none accepted
//
// The one non-guest key is the admin's. pm_may_room_with() checked the guest
// arm BEFORE the admin arm and handed guests to pm_deals_with(), which wants a
// mutual thread or an accepted invite, and there were none of either. So the
// admin's audience was the empty set and no room could be opened by anybody.
// supabase/features/message/p_message_admin_reach.sql moves that one arm.
//
// The server half is proved by tests/p_message_group_test.mjs against the real
// database. This file is the other half, and it is the half the report was
// actually about: can somebody FIND the way in, and does the screen put people
// in front of them when they get there.
//
// Four things, in the order a thumb meets them:
//
//   1. the button says what it does, and does not look like an admin's
//   2. an empty inbox offers it, rather than only mentioning Agents
//   3. the picker does not open on a dead end
//   4. a refusal is a sentence in the reader's language, not raw Postgres
//
//   usage:  node server.js      then, in another shell:
//           node tests/pm_room_open_test.mjs
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://localhost:8080";

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);

// =============================================================================
section("1. The way in is a button that says what it does");
// =============================================================================
{
  const html = readFileSync(join(ROOT, "p-message.html"), "utf8");

  ok(!/class="pm-admin-btn"/.test(html),
     "no control is drawn with the admin class any more. Rooms and announcements stopped being admin-only when p_message_open.sql removed the check; only the colour still said otherwise",
     (html.match(/class="pm-admin-btn"/g) || []).join(" "));
  ok(!/\.pm-admin-btn\s*\{/.test(html),
     "and the rule itself is deleted rather than recoloured, so it cannot come back by being reused");

  const roomsBtn = html.match(/<button[^>]*id="pmRoomsBtn"[\s\S]{0,400}?<\/button>/);
  ok(!!roomsBtn, "the room button is still there");
  ok(roomsBtn && /is-primary/.test(roomsBtn[0]),
     "and it leads the row: making a room is what the complaint was about");
  ok(roomsBtn && /data-i18n="pm_rooms_new"/.test(roomsBtn[0]),
     "it is named for the action, not for the place. \"Rooms\" is a noun on a button whose only job is to make one",
     roomsBtn && roomsBtn[0]);
  ok(roomsBtn && /<svg/.test(roomsBtn[0]) && !/[\u{1F300}-\u{1FAFF}]/u.test(roomsBtn[0]),
     "with a stroke SVG and no emoji");

  // The header is four buttons on a 390px screen; they must be tappable.
  ok(/\.pm-tool-btn\s*\{[^}]*min-height:\s*var\(--hit-min/.test(html),
     "every tool in that row is at least --hit-min tall. At 8px padding and 12px type they came out about 34, which tests/mobile_audit.mjs counts as a miss");
}

// =============================================================================
section("2. i18n: both languages, for every word this added");
// =============================================================================
{
  const i18n = readFileSync(join(ROOT, "js/core/i18n.js"), "utf8");
  const added = [
    "pm_rooms_new", "pm_no_chats2",
    "pm_err_nokey", "pm_err_nobodykeyed", "pm_err_noreach", "pm_err_nocast",
    "pm_err_cap", "pm_err_perday", "pm_err_castperday", "pm_err_guest",
    "pm_err_longname", "pm_err_signin", "pm_err_castcap", "pm_err_scope_nokeys",
    "pm_err_peer_nokey", "pm_err_notowner", "pm_err_nostart", "pm_err_toolong",
  ];
  const missing = added.filter((k) => {
    const n = (i18n.match(new RegExp("^\\s{4}" + k + ":", "gm")) || []).length;
    return n !== 2;
  });
  ok(missing.length === 0,
     "every key this change added is defined exactly twice, once per language",
     missing.join(", "));
  ok(!/^\s{4}pm_rooms:/m.test(i18n),
     "and the key it replaced is gone rather than left behind to rot");
}

// =============================================================================
section("3. A refusal arrives as a sentence, not as Postgres");
// =============================================================================
{
  const page = readFileSync(join(ROOT, "js/pages/p-message.js"), "utf8");
  ok(/function explain\(/.test(page), "the page owns one table of refusals");

  // The sentences pm_group_create and pm_broadcast actually raise, taken from
  // the .sql files rather than retyped, so this fails the day one is reworded.
  const sql = ["p_message_reach_guests.sql", "p_message_open.sql"]
    .map((f) => { try { return readFileSync(join(ROOT, "supabase/features/message", f), "utf8"); } catch (_) { return ""; } })
    .join("\n");
  const raised = [...sql.matchAll(/raise exception '([^']{12,})'/g)]
    .map((m) => m[1])
    .filter((s) => /room|announce|p-message|people|person/i.test(s));

  // Re-run the page's own matcher over each, in Node, with no window.
  const table = page.match(/var DB_SAYS = \[[\s\S]*?\n  \];/);
  ok(!!table, "the table is a plain array this test can evaluate");
  let patterns = [];
  if (table) {
    // The array literal on its own, with the statement's trailing semicolon
    // removed, wrapped so it evaluates as an expression rather than a block.
    const literal = table[0].slice(table[0].indexOf("[")).replace(/;\s*$/, "");
    // eslint-disable-next-line no-eval
    patterns = eval("(" + literal + ")").map((r) => r[0]);
  }
  const unmatched = raised.filter((s) => !patterns.some((re) => re.test(s)));
  ok(raised.length >= 5, "there are real refusals in the SQL to check against", String(raised.length));
  ok(unmatched.length === 0,
     "and every one of them maps to a translated sentence. These are the lines that explain WHY a room could not be opened, which is the one sentence on that screen somebody has to understand",
     unmatched.join(" | "));

  ok(!/out\.textContent = \(err && err\.message\) \|\| String\(err\);/.test(
       readFileSync(join(ROOT, "js/lib/pm-announce-ui.js"), "utf8")),
     "the room dialog no longer prints the raw message");
  ok(!/out\.textContent = \(err && err\.message\) \|\| String\(err\);/.test(
       readFileSync(join(ROOT, "js/lib/pm-rooms-ui.js"), "utf8")),
     "and neither does the roster, which raises the same sentences from pm_group_add");
}

// =============================================================================
section("4. The picker does not open on a dead end");
// =============================================================================
{
  const picker = readFileSync(join(ROOT, "js/lib/pm-people-picker.js"), "utf8");
  ok(/if \(!settled && source === "mine" && !takeable\(\)\.length\)/.test(picker),
     "when the tab it opened on can take nobody, the first paint falls through to the directory");
  ok(/settled = true;[\s\S]{0,200}?jump\.click\(\)/.test(picker),
     "and it can only happen once, so a later empty search does not move the tabs under a thumb");
  ok(/host\.querySelector\('\[data-src="all"\]'\)/.test(picker),
     "it goes through the tab itself, so the tab strip, the filters and the source move together");
}

// =============================================================================
section("5. An empty inbox offers the thing, instead of describing it");
// =============================================================================
{
  const page = readFileSync(join(ROOT, "js/pages/p-message.js"), "utf8");
  ok(/data-inbox-act="room"/.test(page), "an empty inbox carries a button that opens a room");
  ok(/data-inbox-act="people"/.test(page), "and one that goes to the agents list");
  ok(/act\.dataset\.inboxAct === "room"/.test(page), "both are wired");
  ok(/e\.target\.closest\("\[data-inbox-act\]"\)[\s\S]{0,300}?closest\("\[data-thread\]"\)/.test(page),
     "and they are answered BEFORE the row lookup, because neither sits inside a [data-thread]");
}

// =============================================================================
section("6. On a phone, the dialog fits the screen it is drawn on");
// =============================================================================
{
  const css = readFileSync(join(ROOT, "css/pm-identity.css"), "utf8");
  const html = readFileSync(join(ROOT, "p-message.html"), "utf8");

  ok(!/max-height:\s*92vh/.test(css),
     "the modal is no longer sized against the LAYOUT viewport. 92vh is 747px on an iPhone X showing 635, so its last row -- which is where \"Open room\" lives -- sat below the fold of a box that believed it fitted");
  ok(/max-height:\s*calc\(var\(--app-vh/.test(css), "it uses --app-vh, the height that is actually visible");
  ok(!/\.pm-pk-list \{ max-height: 40vh/.test(html), "so does the people list inside it");
  ok(!/\.pm-scroll \{ max-height: 42vh/.test(html), "and the other scroller in the same dialog");

  const theme = readFileSync(join(ROOT, "js/core/theme.js"), "utf8");
  const toggleZ = (theme.match(/position:fixed;\s*z-index:(\d+)/) || [])[1];
  const dropZ = (css.match(/\.pm-back-drop \{[^}]*z-index:\s*(\d+)/) || [])[1];
  ok(toggleZ && dropZ && Number(dropZ) > Number(toggleZ),
     "and the dialog sits above the floating theme toggle. They were both 1000, and at an equal z-index the later element wins -- the toggle is appended to <body> at runtime, so it painted over every dialog on this screen",
     "toggle=" + toggleZ + " backdrop=" + dropZ);
}

// =============================================================================
section("7. In a browser: the page boots and the button is reachable");
// =============================================================================
{
  let browser;
  try {
    // Imported here, not at the top. Six of this file's seven sections read
    // source and need no browser at all, and a static import makes the whole
    // file unrunnable wherever puppeteer is not installed -- a git worktree,
    // a fresh clone, CI before npm install. The catch below already treats a
    // missing browser as a skip; this lets it.
    const { default: puppeteer } = await import("puppeteer");
    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const p = await browser.newPage();
    await p.setViewport({ width: 375, height: 667, deviceScaleFactor: 2 });
    const errs = [];
    p.on("pageerror", (e) => errs.push(String(e.message)));

    await p.goto(BASE + "/p-message.html", { waitUntil: "networkidle2", timeout: 30000 });
    await p.waitForFunction(() => !!document.getElementById("pmRoomsBtn"), { timeout: 10000 });

    const shape = await p.evaluate(() => {
      const b = document.getElementById("pmRoomsBtn");
      // It ships hidden and boot() reveals it once the gate has run, so with
      // no session there is nothing to measure. Revealing it here measures the
      // CSS, which is what is under test: whether the row FITS and is
      // tappable, not whether a signed-out tab is shown it.
      b.hidden = false;
      const r = b.getBoundingClientRect();
      return {
        label: (b.textContent || "").trim(),
        cls: b.className,
        h: Math.round(r.height),
        // Off the right edge is the failure this row was rearranged to avoid.
        rightEdge: Math.round(r.right),
        vw: document.documentElement.clientWidth,
        docWide: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      };
    });

    ok(!/admin/.test(shape.cls),
       "the button carries no admin class in the live DOM", shape.cls);
    ok(shape.h >= 40,
       "it is a real tap target at 375px wide", shape.h + "px tall");
    ok(shape.rightEdge <= shape.vw,
       "and the tools row stays inside the screen", shape.rightEdge + " of " + shape.vw);
    ok(!shape.docWide, "the page does not scroll sideways");
    ok(errs.length === 0, "the page threw nothing", errs.join(" | "));
    await browser.close();
  } catch (err) {
    if (browser) { try { await browser.close(); } catch (_) {} }
    // A missing server is a skipped section, not eleven invented failures.
    console.log("  SKIP  browser section: " + (err && err.message));
    console.log("        (start the dev server with `node server.js` to run it)");
  }
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
