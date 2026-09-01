// ============================================================================
//  pm_delete_test.mjs — taking something back.
//
//  Three things people expect from a chat app and could not do here, and the
//  reason each one needs a gate rather than a look:
//
//    1. UNSEND. "Delete" meant "hide it on this phone", which is an honest
//       feature wearing a word that means something else. There is now a real
//       one beside it, and the whole risk of adding it is that the two get
//       confused: a person who taps the device-only Delete on a wrong price
//       leaves the wrong price standing on the other phone. So this file pins
//       WHICH of the two is offered, on whose messages, and what each says.
//
//    2. THE TOMBSTONE. A withdrawn message and one this device cannot decrypt
//       arrive looking almost identical: no readable text, no wrap. They mean
//       opposite things. "This message was encrypted for another device" on
//       something the sender deleted blames the reader's phone for a decision
//       somebody else made, and there is no way for them to tell.
//
//    3. ROOMS. pm_group_delete did not exist and pm_group_leave left dead
//       ends behind: a room with no owner, or one with no members at all
//       holding ciphertext nobody could ever read again. Leaving now reports
//       which of three things it did, and the screen has to say a different
//       sentence for each or the room simply vanishes without explanation.
//
//  The database side of all three is p_message_delete.sql. What only a browser
//  can answer is whether the SCREEN tells the truth about them, so everything
//  here is stubbed at the RPC boundary: the page does its own real encryption,
//  and the stub can no more read it than the real server can.
//
//    usage:  node server.js      then, in another shell:
//            node tests/pm_delete_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const fails = [];
const ok = (cond, what, detail) => {
  if (cond) { passed++; console.log("  PASS  " + what); }
  else { fails.push(what); console.log("  FAIL  " + what); if (detail) console.log("        " + detail); }
};
const section = (s) => console.log("\n" + s);

/**
 * A post office that stores what it is handed and cannot read it.
 *
 * `role` is what the roster reports for this device in the room, which is what
 * the screen keys "can I add, remove and close this room" on. `members` is how
 * many other people are in it, which is what decides whether leaving closes it.
 */
const stub = (opts) => {
  const o = opts || {};
  return `window.supabase = { createClient: function () {
  var me = "me_self";
  var IS_GUEST = ${JSON.stringify(!!o.guest)};
  var db = {
    keys: {
      me_self:  { public_key: "", display_name: "You", is_guest: IS_GUEST },
      peer_ana: { public_key: "", display_name: "Ana", is_agent: true, region: "Mwanza", area: "Nyamagana" },
      peer_bob: { public_key: "", display_name: "Bob", is_agent: true, region: "Mwanza", area: "Ilemela" },
    },
    threads: {},
    messages: [],
    wraps: {},
  };
  window.__PM_SENT = [];
  window.__PM_DB = db;

  var ROLE = ${JSON.stringify(o.role || "member")};
  var ROOM_MEMBERS = ${JSON.stringify(o.roomMembers || ["me_self", "peer_ana", "peer_bob"])};
  var LEAVE_RESULT = ${JSON.stringify(o.leaveResult || "left")};

  db.threads["room-1"] = { kind: "group", title: "Mwanza trucks", members: ROOM_MEMBERS.slice() };

  function rpc(name, args) {
    args = args || {};
    window.__PM_SENT.push({ name: name, args: args });

    if (name === "pm_publish_key") {
      db.keys[me].public_key = args.p_public_key;
      return Promise.resolve({ data: null, error: null });
    }
    if (name === "pm_touch_seen") return Promise.resolve({ data: new Date().toISOString(), error: null });
    if (name === "pm_online_window") return Promise.resolve({ data: 120, error: null });
    if (name === "pm_group_max") return Promise.resolve({ data: 60, error: null });
    if (name === "pm_mark_read") return Promise.resolve({ data: null, error: null });
    if (name === "pm_thread_size") {
      return Promise.resolve({ data: (db.threads[args.p_thread] || {}).members.length, error: null });
    }

    if (name === "pm_directory" || name === "pm_agent_finder" || name === "pm_recipients"
        || name === "pm_invites_mine" || name === "pm_group_candidates") {
      return Promise.resolve({ data: [], error: null });
    }

    if (name === "pm_inbox") {
      return Promise.resolve({ data: Object.keys(db.threads).map(function (id) {
        var th = db.threads[id];
        return { thread_id: id, kind: th.kind, title: th.title || null,
                 other_id: null, other_name: null, unread: 0,
                 last_at: new Date().toISOString() };
      }), error: null });
    }

    if (name === "pm_thread_keys") {
      return Promise.resolve({ data: (db.threads[args.p_thread].members || []).map(function (u) {
        var v = db.keys[u] || {};
        return { user_id: u, public_key: v.public_key || "", display_name: v.display_name || null,
                 role: u === me ? ROLE : "member", is_guest: false, is_agent: !!v.is_agent,
                 region: v.region || null, area: v.area || null, area_kind: null,
                 district: null, ward: null, joined_at: new Date().toISOString() };
      }).filter(function (r) { return r.public_key; }), error: null });
    }

    if (name === "pm_send") {
      var mid = "m" + (db.messages.length + 1);
      db.messages.push({ id: mid, thread_id: args.p_thread, sender_id: me,
        iv: args.p_iv, ciphertext: args.p_ciphertext,
        reply_to: args.p_reply_to || null, deleted_at: null,
        sent_at: new Date().toISOString() });
      db.wraps[mid] = {};
      (args.p_keys || []).forEach(function (k) { db.wraps[mid][k.user_id] = k; });
      return Promise.resolve({ data: mid, error: null });
    }

    // The real one blanks the ciphertext and drops every wrap. The stub does
    // exactly that, so a page that tried to keep showing the old text would
    // have nothing to show it from.
    if (name === "pm_message_delete") {
      var row = db.messages.filter(function (m) { return m.id === args.p_message; })[0];
      if (!row) return Promise.reject(new Error("That message is not there any more"));
      if (row.sender_id !== me) return Promise.reject(new Error("You can only delete your own messages"));
      if (row.deleted_at) return Promise.resolve({ data: row.deleted_at, error: null });
      row.deleted_at = new Date().toISOString();
      row.ciphertext = ""; row.iv = "";
      delete db.wraps[row.id];
      return Promise.resolve({ data: row.deleted_at, error: null });
    }

    if (name === "pm_thread_messages") {
      var out = db.messages.filter(function (m) { return m.thread_id === args.p_thread; })
        .map(function (m) {
          var w = (db.wraps[m.id] || {})[me];
          // A tombstone has no wrap and must come through anyway. This is the
          // third arm the real function grew for exactly this reason: without
          // it a deleted message disappears rather than leaving a mark.
          if (!w && !m.deleted_at) return null;
          return { id: m.id, thread_id: m.thread_id, sender_id: m.sender_id,
                   sender_name: m.sender_id === me ? "You" : (db.keys[m.sender_id] || {}).display_name,
                   sender_guest: false, alg: null, iv: m.iv, ciphertext: m.ciphertext,
                   epk: w ? w.epk : null, wrapped_key: w ? w.wrapped_key : null,
                   generation: null, seq: null, reply_to: m.reply_to || null,
                   sent_at: m.sent_at, deleted_at: m.deleted_at || null };
        }).filter(Boolean);
      return Promise.resolve({ data: out, error: null });
    }

    if (name === "pm_group_delete") {
      if (ROLE !== "owner") return Promise.reject(new Error("Only the owner of this room can delete it"));
      delete db.threads[args.p_thread];
      return Promise.resolve({ data: null, error: null });
    }

    if (name === "pm_group_leave") {
      var th = db.threads[args.p_thread];
      if (th) th.members = th.members.filter(function (u) { return u !== me; });
      if (LEAVE_RESULT === "deleted") delete db.threads[args.p_thread];
      return Promise.resolve({ data: LEAVE_RESULT, error: null });
    }

    return Promise.resolve({ data: [], error: null });
  }

  function table() {
    var b = { _thread: null, _eqId: null };
    ["select", "eq", "neq", "in", "order", "limit", "is", "or", "gte", "lte"].forEach(function (m) {
      b[m] = function (col, val) {
        if (m === "eq" && col === "thread_id") b._thread = val;
        if (m === "eq" && col === "id") b._eqId = val;
        return b;
      };
    });
    b.then = function (res, rej) { return Promise.resolve({ data: [], error: null }).then(res, rej); };
    return b;
  }

  return {
    rpc: rpc,
    from: table,
    auth: {
      getSession: function () {
        return Promise.resolve({ data: { session: { user: {
          id: me, email: IS_GUEST ? null : "me@example.com",
          is_anonymous: IS_GUEST } } }, error: null });
      },
      getUser: function () { return Promise.resolve({ data: { user: { id: me, email: "me@example.com" } }, error: null }); },
      signOut: function () { return Promise.resolve({ error: null }); },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
    },
    channel: function () {
      var ch = { on: function () { return ch; }, subscribe: function () { return ch; } };
      return ch;
    },
    removeChannel: function () {},
    storage: { from: function () { return { getPublicUrl: function () { return { data: { publicUrl: "" } }; } }; } },
  };
} };`;
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const MAP_STUB = (name) =>
  `window.${name}=new Proxy(function(){},{get:function(){return window.${name}},` +
  `apply:function(){return window.${name}},construct:function(){return window.${name}}});`;

const browser = await puppeteer.launch({
  headless: "new", protocolTimeout: 120000,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function openPage(opts) {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900 });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*",
        "access-control-allow-methods": "*" } });
    }
    if (/cdn\.jsdelivr\.net.*supabase/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: stub(opts) });
    }
    if (/fonts\.googleapis|fonts\.gstatic/.test(url) || /cdn\.jsdelivr\.net.*(leaflet|maplibre).*\.css/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    if (/cdn\.jsdelivr\.net.*(leaflet|maplibre)/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "application/javascript" },
        body: MAP_STUB(/leaflet/.test(url) ? "L" : "maplibregl") });
    }
    if (/supabase\.co\/storage|arcgisonline|basemaps\.cartocdn|maptiler|mapbox/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
    }
    if (/supabase\.co|locationiq|nominatim/.test(url)) {
      return req.respond({ status: 200, headers: {
        "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
    }
    req.continue();
  });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem("pawa-theme", "dark"); } catch (e) {} });
  await page.goto(BASE + "/p-message.html", { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.waitForFunction(() => !!window.PMStore && !!document.getElementById("pmLog"), { timeout: 30000 });
  await sleep(1800);
  // A brand new device is offered a backup code over everything else. It is in
  // the way of every dialog this file opens, so it goes first.
  await page.evaluate(() => {
    const b = document.getElementById("pmModalBack");
    if (b && b.classList.contains("is-on")) b.classList.remove("is-on");
  });
  return { page, errs };
}

/** Open the room and send one message through the page's own crypto. */
async function openRoomWithMessage(page, text) {
  await page.evaluate(() => document.querySelector('#pmInbox [data-thread]').click());
  await sleep(1200);
  await page.type("#pmInput", text);
  await page.click("#pmSendBtn");
  await sleep(1500);
}

const bubbles = (page) => page.$$eval(".pm-msg", (n) => n.map((m) => ({
  text: m.textContent, gone: m.classList.contains("gone"),
  failed: m.classList.contains("failed"),
  hasReply: !!m.querySelector("[data-reply]"), hasMenu: !!m.querySelector("[data-menu]"),
})));

try {
  // -------------------------------------------------------------------------
  section("1. A message you sent offers both deletes, and says which is which");
  {
    const { page, errs } = await openPage({ role: "owner" });
    await openRoomWithMessage(page, "Bei ni 240,000 kwa mwezi");

    let rows = await bubbles(page);
    ok(rows.length === 1 && rows[0].text.includes("240,000"),
       "the message is on screen, readable, in the thread that sent it",
       JSON.stringify(rows));

    await page.evaluate(() => document.querySelector("[data-menu]").click());
    await sleep(400);
    const sheet = await page.$eval("#pmModal", (n) => n.textContent);
    ok(/Delete for everyone/i.test(sheet), "the sheet offers to delete it for everyone", sheet.slice(0, 160));
    ok(/Delete for me/i.test(sheet), "and still offers the device-only one beside it");
    // The two are one word apart and do opposite things, so each carries the
    // sentence that separates them. Without this a person hides a wrong price
    // on their own phone and leaves it standing on the other.
    ok(/removes it from the server/i.test(sheet),
       "the one that reaches the other phone says so");
    ok(/hidden on this device/i.test(sheet),
       "and the one that does not says that instead");

    const order = await page.$$eval("#pmModal .pm-sheet-b b", (n) => n.map((x) => x.textContent));
    ok(order.indexOf("Delete for everyone") < order.indexOf("Delete for me"),
       "unsend comes first, because it is the one people are looking for",
       JSON.stringify(order));
    ok(errs.length === 0, "no page errors", errs.join(" | "));
    await page.close();
  }

  // -------------------------------------------------------------------------
  section("2. Unsending really removes it, and leaves a mark where it was");
  {
    const { page, errs } = await openPage({ role: "owner" });
    await openRoomWithMessage(page, "Bei ni 240,000 kwa mwezi");

    await page.evaluate(() => document.querySelector("[data-menu]").click());
    await sleep(350);
    await page.evaluate(() => document.getElementById("pmMmUnsend").click());
    await sleep(350);

    const warn = await page.$eval("#pmModal", (n) => n.textContent);
    ok(/cannot do/i.test(warn) && /already read/i.test(warn),
       "the confirmation says what it cannot do, before the tap and not after",
       warn.slice(0, 200));

    await page.evaluate(() => document.getElementById("pmUnYes").click());
    await sleep(900);

    const call = await page.evaluate(() => (window.__PM_SENT || []).filter((c) => c.name === "pm_message_delete"));
    ok(call.length === 1, "it called the server exactly once", String(call.length));

    const rows = await bubbles(page);
    ok(rows.length === 1, "the bubble is still there, so the conversation keeps its shape",
       JSON.stringify(rows));
    ok(rows[0].gone, "and is marked as withdrawn");
    ok(!rows[0].text.includes("240,000"), "the words are gone from the screen", rows[0].text);
    ok(/You deleted this message/i.test(rows[0].text),
       "and it says who deleted it, in the first person to the person who did",
       rows[0].text);
    // The two states look alike and mean opposite things: one is the sender
    // taking something back, the other is this phone failing to read it.
    ok(!rows[0].failed, "it is NOT dressed as a message this device could not decrypt");

    // Nothing to quote, nothing to copy, nothing left to delete.
    ok(!rows[0].hasReply && !rows[0].hasMenu,
       "a tombstone carries no Reply and no menu, so there is nothing to find out by tapping");

    // What the server is holding afterwards is the real test of the feature.
    const held = await page.evaluate(() => ({
      msg: window.__PM_DB.messages[0],
      wraps: Object.keys(window.__PM_DB.wraps),
    }));
    ok(held.msg.ciphertext === "" && held.msg.iv === "",
       "the server is left holding no ciphertext", JSON.stringify(held.msg));
    ok(held.wraps.length === 0,
       "and no key that could open it, for anybody", JSON.stringify(held.wraps));
    ok(errs.length === 0, "no page errors", errs.join(" | "));
    await page.close();
  }

  // -------------------------------------------------------------------------
  section("3. It survives a redraw, and an answer to it still makes sense");
  {
    const { page, errs } = await openPage({ role: "owner" });
    await openRoomWithMessage(page, "Bei ni 240,000 kwa mwezi");

    // Answer it, THEN withdraw the thing that was answered. This is the case
    // p_message_replies.sql chose ON DELETE SET NULL for and the reason the
    // row is kept rather than removed: the answer must not lose its question.
    await page.evaluate(() => document.querySelector("[data-reply]").click());
    await sleep(300);
    await page.type("#pmInput", "Ni ghali sana");
    await page.click("#pmSendBtn");
    await sleep(1400);

    await page.evaluate(() => document.querySelectorAll("[data-menu]")[0].click());
    await sleep(350);
    await page.evaluate(() => document.getElementById("pmMmUnsend").click());
    await sleep(300);
    await page.evaluate(() => document.getElementById("pmUnYes").click());
    await sleep(900);

    // Refetch rather than trusting the copy on screen. When the button was
    // tapped the page redrew from the row it already held, which is right (a
    // round trip there would leave the old words up for a second), but it
    // means nothing has yet proved that the SERVER's answer produces the same
    // thing. Closing the thread and reopening it runs pm_thread_messages
    // again, which is the path every other device takes.
    //
    // Deliberately NOT a page reload: the stub post office lives in this
    // page's memory, so reloading would hand the test an empty server and
    // prove nothing at all.
    await page.evaluate(() => document.getElementById("pmBack").click());
    await sleep(500);
    await page.evaluate(() => document.querySelector('#pmInbox [data-thread]').click());
    await sleep(1500);

    const rows = await bubbles(page);
    ok(rows.length === 2, "both messages come back from the server", JSON.stringify(rows.map((r) => r.text)));
    ok(rows[0].gone, "the withdrawn one is still a tombstone after a reload");
    ok(/deleted/i.test(rows[0].text) && !rows[0].text.includes("240,000"),
       "with its words still gone", rows[0].text);
    ok(rows[1].text.includes("Ni ghali sana"), "and the answer to it survives", rows[1].text);

    const quote = await page.$eval(".pm-msg:last-child", (n) => {
      const q = n.querySelector(".pm-quote");
      return q ? q.textContent : "";
    });
    ok(/deleted/i.test(quote),
       "the answer's quote says the question was withdrawn, rather than pretending it scrolled away",
       quote);
    ok(errs.length === 0, "no page errors", errs.join(" | "));
    await page.close();
  }

  // -------------------------------------------------------------------------
  section("4. Closing a room is the owner's, and it says what it costs");
  {
    const { page, errs } = await openPage({ role: "owner" });
    await page.evaluate(() => document.querySelector('#pmInbox [data-thread]').click());
    await sleep(1200);
    await page.evaluate(() => document.getElementById("pmMembers").click());
    await sleep(900);

    ok(await page.$("#pmMemDelete") !== null, "an owner is offered a way to close the room");
    ok(await page.$("#pmMemLeave") !== null, "and can still simply leave it");

    await page.evaluate(() => document.getElementById("pmMemDelete").click());
    await sleep(400);
    const ask = await page.$eval("#pmModal", (n) => n.textContent);
    // The count is the fact that changes the answer: closing a room of two is
    // tidying up and closing a room of eighty is an announcement.
    //
    // It has to come from pm_thread_size and not from the roster. Only
    // `me_self` has published a key in this stub, so the roster is ONE row
    // while the room really holds three, and a dialog built from the roster
    // would offer to close a room of three saying it held one.
    ok(/3 people/.test(ask), "the question names how many people it closes for", ask.slice(0, 200));
    ok(!/1 people/.test(ask),
       "counted from the real membership, not from the people who happen to have a key yet",
       ask.slice(0, 200));
    ok(/no undo/i.test(ask), "and says there is no way back");

    await page.evaluate(() => document.getElementById("pmRdYes").click());
    await sleep(900);
    const called = await page.evaluate(() => (window.__PM_SENT || []).filter((c) => c.name === "pm_group_delete"));
    ok(called.length === 1, "closing it calls the server once", String(called.length));
    const after = await page.$eval("#pmModal", (n) => n.textContent);
    ok(/closed/i.test(after), "and the screen says the room is closed", after.slice(0, 120));
    ok(errs.length === 0, "no page errors", errs.join(" | "));
    await page.close();
  }

  // -------------------------------------------------------------------------
  section("5. A member can leave; only the owner can close");
  {
    const { page, errs } = await openPage({ role: "member" });
    await page.evaluate(() => document.querySelector('#pmInbox [data-thread]').click());
    await sleep(1200);
    await page.evaluate(() => document.getElementById("pmMembers").click());
    await sleep(900);

    ok(await page.$("#pmMemLeave") !== null,
       "an ordinary member can leave, which is the whole point of the roster");
    // Drawing it for somebody the database will refuse is offering a door that
    // is already locked.
    ok(await page.$("#pmMemDelete") === null,
       "and is NOT offered a Delete room button the database would refuse");
    ok(await page.$("#pmMemAdd") === null, "nor the Add people button, for the same reason");
    ok(errs.length === 0, "no page errors", errs.join(" | "));
    await page.close();
  }

  // -------------------------------------------------------------------------
  section("6. Leaving says which of the three things it did");
  {
    // An owner walking out of a room that still has people in it. The room
    // carries on under somebody else, and an inbox with one fewer row in it
    // is not a way to find that out.
    const { page, errs } = await openPage({ role: "owner", leaveResult: "handed_over" });
    await page.evaluate(() => document.querySelector('#pmInbox [data-thread]').click());
    await sleep(1200);
    await page.evaluate(() => document.getElementById("pmMembers").click());
    await sleep(900);
    page.on("dialog", (d) => d.accept());
    await page.evaluate(() => document.getElementById("pmMemLeave").click());
    await sleep(1200);
    const said = await page.$eval("#pmModal", (n) => n.textContent);
    ok(/somebody else owns it now|owns it now/i.test(said),
       "an owner who leaves is told the room carries on without them", said.slice(0, 160));
    ok(errs.length === 0, "no page errors", errs.join(" | "));
    await page.close();
  }
  {
    // The last person out. There is nobody left holding a key, so the room is
    // ciphertext that can never be read again and it goes.
    const { page, errs } = await openPage({ role: "owner", roomMembers: ["me_self"], leaveResult: "deleted" });
    await page.evaluate(() => document.querySelector('#pmInbox [data-thread]').click());
    await sleep(1200);
    await page.evaluate(() => document.getElementById("pmMembers").click());
    await sleep(900);
    page.on("dialog", (d) => d.accept());
    await page.evaluate(() => document.getElementById("pmMemLeave").click());
    await sleep(1200);
    const said = await page.$eval("#pmModal", (n) => n.textContent);
    ok(/closed/i.test(said),
       "the last person out is told the room closed behind them", said.slice(0, 160));
    ok(errs.length === 0, "no page errors", errs.join(" | "));
    await page.close();
  }
  // -------------------------------------------------------------------------
  section("7. A guest can take back what a guest sent");
  {
    // The half that was never checked. A guest is a real session with a real
    // key and real messages, and nothing about unsending is different for one:
    // pm_message_delete asks who SENT the message, not what kind of account
    // they hold. Worth pinning, because the guest path is the one people reach
    // without an account and the one nobody tests by hand.
    const { page, errs } = await openPage({ role: "owner", guest: true });
    await openRoomWithMessage(page, "Nipo mlangoni sasa hivi");

    let rows = await bubbles(page);
    ok(rows.length === 1 && rows[0].text.includes("Nipo mlangoni"),
       "a guest's message is on screen the same as anybody's", JSON.stringify(rows));

    await page.evaluate(() => document.querySelector("[data-menu]").click());
    await sleep(400);
    ok(await page.$("#pmMmUnsend") !== null,
       "and a guest is offered Delete for everyone, not just the device-only one");

    await page.evaluate(() => document.getElementById("pmMmUnsend").click());
    await sleep(350);
    await page.evaluate(() => document.getElementById("pmUnYes").click());
    await sleep(900);

    rows = await bubbles(page);
    ok(rows[0].gone && !rows[0].text.includes("Nipo mlangoni"),
       "and it really goes", JSON.stringify(rows));
    const held = await page.evaluate(() => ({
      ct: window.__PM_DB.messages[0].ciphertext,
      wraps: Object.keys(window.__PM_DB.wraps).length,
    }));
    ok(held.ct === "" && held.wraps === 0,
       "leaving the server with no ciphertext and no key, exactly as for an account",
       JSON.stringify(held));
    ok(errs.length === 0, "no page errors", errs.join(" | "));
    await page.close();
  }

} finally {
  await browser.close();
}

console.log("\n" + passed + " passed, " + fails.length + " failed");
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
