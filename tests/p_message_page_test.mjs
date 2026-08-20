// ============================================================================
// p_message_page_test.mjs — the P-Message screen in a real browser.
//
// The database side is proved against production by p_message_db_test.mjs and
// the scheme itself by p_crypto_test.mjs. What is left, and what only a real
// browser can answer, is whether the PAGE keeps the promise it prints at the
// top of itself:
//
//   · plaintext never leaves the tab — asserted against every single request
//     body the page sends, not against the ones we expected it to send;
//   · what the server ends up holding is unreadable;
//   · the lock line tells the truth, and flips on the assistant thread, which
//     is not encrypted and must never look as though it is;
//   · a message this device cannot decrypt is SHOWN as such, not dropped;
//   · the announce button belongs to admins only.
//
// Supabase is stubbed with an in-memory post office that behaves like the real
// RPCs — it stores exactly what it is handed and can no more read it than the
// real one can.
//
//   usage:  node server.js      then, in another shell:
//           node tests/p_message_page_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
const SECRET = "Bei ya mwisho 240000 usimwambie mtu";

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};
const section = (s) => process.stdout.write("\n" + s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the stub post office ---------------------------------------------------
// Deliberately dumb, exactly like the real schema: it holds ciphertext and
// wrapped keys and has no idea what any of it says.
const stub = (email, opts) => `
window.__PM_SENT = [];
window.supabase = { createClient: function () {
  var me = ${JSON.stringify("user_self")};
  // Signed out until signInAnonymously() is called — the guest path.
  var signedIn = ${JSON.stringify(!(opts && opts.signedOut))};
  var anon = false;
  var db = {
    keys: {},                       // user_id -> { public_key, fingerprint, display_name, region, is_agent }
    threads: {},                    // id -> { kind, title, region, members: [] }
    messages: [],                   // { id, thread_id, sender_id, iv, ciphertext }
    wraps: {},                      // message_id -> { user_id: {epk, wrapped_key} }
  };
  // Two other people already on P-Message, one of them holding a key this
  // device has never seen — that is what makes the "cannot decrypt" path real.
  db.keys["agent_juma"] = { public_key: "", fingerprint: "1111 2222 3333",
    display_name: "Juma Mwanga", region: "Mwanza", is_agent: true, area: "Nyamagana" };
  db.keys["agent_neema"] = { public_key: "", fingerprint: "4444 5555 6666",
    display_name: "Neema Kileo", region: "Mwanza", is_agent: true, area: "Ilemela" };

  function rpc(name, args) {
    window.__PM_SENT.push({ name: name, args: JSON.parse(JSON.stringify(args || {})) });
    if (name === "pm_publish_key") {
      db.keys[me] = { public_key: args.p_public_key, fingerprint: args.p_fingerprint,
        display_name: "You", region: "Mwanza", is_agent: false };
      // Give the two agents a key of their own so they are reachable. They are
      // generated here, in the page, precisely so this test never holds their
      // private halves either.
      return Promise.resolve({ data: db.keys[me], error: null });
    }
    if (name === "pm_directory") {
      return Promise.resolve({ data: Object.keys(db.keys).filter(function (k) { return k !== me; })
        .map(function (k) {
          var v = db.keys[k];
          return { user_id: k, display_name: v.display_name, region: v.region, area: v.area || null,
            area_kind: null, district: null, ward: null, is_agent: v.is_agent,
            reachable: !!v.public_key, public_key: v.public_key, fingerprint: v.fingerprint };
        }), error: null });
    }
    if (name === "pm_start_direct") {
      var id = "thread-" + args.p_other;
      db.threads[id] = db.threads[id] || { kind: "direct", members: [me, args.p_other] };
      return Promise.resolve({ data: id, error: null });
    }
    // pm-store.js used to build this from two table reads (pm_members then
    // pm_keys); it is one RPC now, so the stub models the RPC. A member with
    // no published key is omitted, exactly as the real function does — that
    // omission is what makes "nobody reachable" reachable in a test.
    if (name === "pm_group_candidates") {
      return Promise.resolve({
        data: Object.keys(db.keys).filter(function (k) { return k !== me && db.keys[k].public_key; })
          .map(function (k) {
            var v = db.keys[k];
            return { user_id: k, public_key: v.public_key, display_name: v.display_name,
              region: v.region, listings: 1 };
          }),
        error: null,
      });
    }
    if (name === "pm_group_create") {
      var gid = "room-" + (Object.keys(db.threads).length + 1);
      db.threads[gid] = { kind: "group", title: args.p_title, members: (args.p_members || []).concat([me]) };
      return Promise.resolve({ data: gid, error: null });
    }
    if (name === "pm_invite_create") {
      return Promise.resolve({
        data: [{ token_hash: args.p_token_hash,
                 expires_at: new Date(Date.now() + 12096e5).toISOString() }],
        error: null,
      });
    }
    if (name === "pm_invites_mine") return Promise.resolve({ data: [], error: null });
    if (name === "pm_thread_keys") {
      var th = db.threads[args.p_thread];
      var members = (th && th.members) || [];
      return Promise.resolve({
        data: members.map(function (u) {
          var v = db.keys[u] || {};
          return { user_id: u, public_key: v.public_key || "", display_name: v.display_name || null,
            role: u === me ? "owner" : "member", is_guest: false };
        }).filter(function (r) { return r.public_key; }),
        error: null,
      });
    }
    if (name === "pm_send") {
      var mid = "m" + (db.messages.length + 1);
      db.messages.push({ id: mid, thread_id: args.p_thread, sender_id: me,
        iv: args.p_iv, ciphertext: args.p_ciphertext, sent_at: new Date().toISOString() });
      db.wraps[mid] = {};
      (args.p_keys || []).forEach(function (k) { db.wraps[mid][k.user_id] = k; });
      return Promise.resolve({ data: mid, error: null });
    }
    if (name === "pm_thread_messages") {
      var out = db.messages.filter(function (m) { return m.thread_id === args.p_thread; })
        .map(function (m) {
          var w = (db.wraps[m.id] || {})[me];
          if (!w) return null;
          return { id: m.id, thread_id: m.thread_id, sender_id: m.sender_id,
            sender_name: m.sender_id === me ? "You" : (db.keys[m.sender_id] || {}).display_name,
            iv: m.iv, ciphertext: m.ciphertext, epk: w.epk, wrapped_key: w.wrapped_key, sent_at: m.sent_at };
        }).filter(Boolean);
      return Promise.resolve({ data: out, error: null });
    }
    if (name === "pm_inbox") {
      return Promise.resolve({ data: Object.keys(db.threads).map(function (id) {
        var t = db.threads[id];
        var other = (t.members || []).filter(function (u) { return u !== me; })[0];
        return { thread_id: id, kind: t.kind, title: t.title || null, region: t.region || null,
          other_id: other || null, other_name: (db.keys[other] || {}).display_name || null,
          other_region: (db.keys[other] || {}).region || null,
          other_area: (db.keys[other] || {}).area || null,
          last_at: new Date().toISOString(), unread: 0 };
      }), error: null });
    }
    if (name === "pm_mark_read") return Promise.resolve({ data: null, error: null });
    if (name === "pm_recipients") {
      return Promise.resolve({ data: Object.keys(db.keys).filter(function (k) { return k !== me; })
        .map(function (k) { return { user_id: k, public_key: db.keys[k].public_key,
          display_name: db.keys[k].display_name, region: db.keys[k].region }; }), error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }

  function table(name) {
    var b = {};
    ["select", "eq", "neq", "gt", "gte", "lt", "lte", "is", "or", "order", "limit"]
      .forEach(function (m) { b[m] = function () { return b; }; });
    b.in = function (col, vals) { b._ids = vals; return b; };
    b.then = function (res, rej) {
      var data = [];
      if (name === "pm_members") {
        var t = db.threads[b._eq] || null;
        data = Object.keys(db.threads).reduce(function (acc, id) {
          (db.threads[id].members || []).forEach(function (u) { acc.push({ thread_id: id, user_id: u }); });
          return acc;
        }, []);
        if (b._thread) data = data.filter(function (r) { return r.thread_id === b._thread; });
      } else if (name === "pm_keys") {
        data = (b._ids || Object.keys(db.keys)).map(function (u) {
          return { user_id: u, public_key: (db.keys[u] || {}).public_key || "" };
        }).filter(function (r) { return r.public_key; });
      }
      return Promise.resolve({ data: data, error: null }).then(res, rej);
    };
    // pm_members is always filtered by thread_id in pm-store.js.
    var origEq = b.eq;
    b.eq = function (col, val) { if (col === "thread_id") b._thread = val; return b; };
    return b;
  }

  window.__PM_DB = db;
  return {
    rpc: rpc,
    from: table,
    auth: {
      getSession: function () {
        if (!signedIn) return Promise.resolve({ data: { session: null }, error: null });
        return Promise.resolve({ data: { session: { user: {
          id: me, email: anon ? null : ${JSON.stringify(email)}, is_anonymous: anon } } }, error: null });
      },
      signInAnonymously: function () {
        signedIn = true; anon = true; me = "guest_self";
        return Promise.resolve({ data: { user: { id: me, is_anonymous: true } }, error: null });
      },
      getUser: function () { return Promise.resolve({ data: { user: { id: me, email: ${JSON.stringify(email)} } }, error: null }); },
      signOut: function () { return Promise.resolve({ error: null }); },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
    },
    channel: function () { return { on: function () { return this; }, subscribe: function () { return this; } }; },
    removeChannel: function () {},
    storage: { from: function () { return { getPublicUrl: function () { return { data: { publicUrl: "" } }; } }; } },
  };
} };`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
});

async function openPage(email, opts) {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 1 });
  const errs = [];
  const bodies = [];       // every request body the page sends
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    const data = req.postData();
    if (data) bodies.push(data);
    if (req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*",
        "access-control-allow-methods": "*" } });
    }
    if (/cdn\.jsdelivr\.net.*supabase/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: stub(email, opts) });
    }
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    if (/supabase\.co\/storage|arcgisonline|basemaps\.cartocdn/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
    }
    if (/supabase\.co/.test(url)) {
      return req.respond({ status: 200, headers: {
        "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
    }
    req.continue();
  });
  await page.goto(`${BASE}/p-message.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(1600);
  return { page, errs, bodies };
}

try {
  section("1. Setting up on a new device");
  const { page, errs, bodies } = await openPage("someone@example.com");

  ok(await page.$eval("#pmLockText", (n) => n.textContent).then((t) => /encrypted/i.test(t)),
     "the header says the conversations are end-to-end encrypted");
  const fp = await page.$eval("#pmFpBtn", (n) => ({ hidden: n.hidden, text: n.textContent }));
  ok(!fp.hidden && /\d{4} \d{4} \d{4}/.test(fp.text),
     "a safety number was generated and is on screen", fp.text);

  const published = await page.evaluate(() => (window.__PM_SENT || []).find((c) => c.name === "pm_publish_key"));
  ok(!!published, "the public key was published, so other people can write to this device");
  ok(published && !published.args.p_public_key.includes("PRIVATE") && published.args.p_public_key.length > 40,
     "what was published is a public key");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("pm-identity-v1") || "{}"));
  ok(!!stored.privateKey, "the private key stayed in this browser");
  ok(!JSON.stringify(await page.evaluate(() => window.__PM_SENT)).includes(stored.privateKey),
     "and was never sent anywhere");

  section("2. A new device is told where its key lives");
  // This modal opens over everything on first run, on purpose: the one moment
  // worth interrupting somebody is before they have a history to lose.
  ok(await page.$eval("#pmModalBack", (n) => n.classList.contains("is-on")),
     "a brand new device is offered a backup code before anything else");
  ok(/device/i.test(await page.$eval("#pmModal h2", (n) => n.textContent)),
     "and told the key lives on this device", await page.$eval("#pmModal h2", (n) => n.textContent));
  await page.click("#pmBkSkip");
  await sleep(300);
  ok(!(await page.$eval("#pmModalBack", (n) => n.classList.contains("is-on"))), "\"Later\" dismisses it");

  section("3. The agent directory");
  await page.click("#segPeople");
  await sleep(900);
  const people = await page.$$eval("#pmPeople .pm-row", (n) => n.map((r) => ({
    name: (r.querySelector(".pm-name") || {}).textContent.trim(),
    sub: (r.querySelector(".pm-sub") || {}).textContent.trim(),
    unreachable: !!r.dataset.unreachable,
  })));
  if (people.length === 0) {
    const html = await page.$eval("#pmPeople", (n) => n.innerHTML);
    const calls = await page.evaluate(() => window.__PM_SENT.map((c) => c.name));
    process.stdout.write("  DEBUG html=" + html.slice(0, 220) + "\n  DEBUG calls=" + JSON.stringify(calls) + "\n");
  }
  ok(people.length >= 2, `agents are listed (${people.length})`, JSON.stringify(people));
  ok(people.some((p) => /Juma/.test(p.name)), "by name", JSON.stringify(people.map((p) => p.name)));
  ok(people.some((p) => /Nyamagana|Ilemela|Mwanza/.test(p.sub)),
     "with where they operate — the reason to message an agent at all", JSON.stringify(people.map((p) => p.sub)));
  ok(people.some((p) => /Agent/i.test(p.name)), "and marked as agents");

  section("4. Sending something private");
  // Give the agents real keys first — generated in the page, so this test never
  // holds a private half and cannot cheat when it checks the ciphertext.
  await page.evaluate(async () => {
    for (const id of ["agent_juma", "agent_neema"]) {
      const kp = await window.PMCrypto.generateIdentity();
      window.__PM_DB.keys[id].public_key = kp.publicKey;
      window.__PM_KEYS = window.__PM_KEYS || {};
      window.__PM_KEYS[id] = kp;             // kept in the page, never read out
    }
  });
  // The list was drawn while they were still unreachable, so re-run the search
  // to pick up their new keys — the same thing a reload does.
  await page.click("#segPeople");
  await page.evaluate(() => {
    const s = document.getElementById("pmSearch");
    s.value = "";
    s.dispatchEvent(new Event("input"));
  });
  await sleep(900);
  ok(await page.$eval('#pmPeople [data-person="agent_juma"]', (n) => !n.dataset.unreachable),
     "once someone publishes a key they show as reachable");
  await page.evaluate(() => document.querySelector('#pmPeople [data-person="agent_juma"]').click());
  await sleep(1400);

  ok(await page.$eval("#pmConv", (n) => n.classList.contains("is-on")), "the conversation opened");
  ok(/Juma/.test(await page.$eval("#pmConvName", (n) => n.textContent)), "with the right person");

  const bodiesBefore = bodies.length;
  await page.type("#pmInput", SECRET);
  await page.click("#pmSendBtn");
  await sleep(1400);

  const log = await page.$$eval(".pm-msg", (n) => n.map((m) => m.textContent));
  ok(log.some((m) => m.includes(SECRET)), "it appears in the sender's own thread, readable", log.join(" | "));

  section("5. What actually went to the server");
  const sent = await page.evaluate(() => window.__PM_SENT.filter((c) => c.name === "pm_send"));
  ok(sent.length === 1, "exactly one send call", String(sent.length));
  const payload = JSON.stringify(sent[0].args);
  ok(!payload.includes(SECRET), "the call carries no plaintext");
  ok(!payload.includes("240000") && !/usimwambie/i.test(payload),
     "not even the number or a distinctive word from it", payload.slice(0, 160));
  ok(sent[0].args.p_keys.length === 2,
     "one wrapped key per member — the sender's own copy included", String(sent[0].args.p_keys.length));

  // The blunt version: nothing the page put on the wire, anywhere, at any
  // point, contains the message.
  const leaked = bodies.slice(bodiesBefore).filter((b) => b.includes(SECRET) || b.includes("240000"));
  ok(leaked.length === 0,
     "and NO request body the page sent contains the message text", leaked.slice(0, 1).join("").slice(0, 200));

  const held = await page.evaluate(() => JSON.stringify(window.__PM_DB.messages));
  ok(!held.includes(SECRET) && !held.includes("240000"),
     "what the server ends up holding is unreadable", held.slice(0, 160));

  section("6. A message this device cannot open");
  await page.evaluate(() => {
    // A row addressed to us, but wrapped with a key we do not have — exactly
    // what an old message from a previous device looks like.
    const t = "thread-agent_juma";
    window.__PM_DB.messages.push({ id: "mX", thread_id: t, sender_id: "agent_juma",
      iv: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAA", sent_at: new Date().toISOString() });
    window.__PM_DB.wraps["mX"] = { user_self: { epk: "AAAA", wrapped_key: "AAAA" } };
  });
  await page.click("#pmBack"); await sleep(300);
  await page.evaluate(() => document.querySelector('#pmInbox [data-thread]')?.click());
  await sleep(1400);
  const failedShown = await page.$$eval(".pm-msg.failed", (n) => n.map((m) => m.textContent));
  ok(failedShown.length === 1, "it is still in the thread, marked unreadable — not silently dropped",
     JSON.stringify(failedShown));
  const stillThere = await page.$$eval(".pm-msg", (n) => n.map((m) => m.textContent));
  ok(stillThere.some((m) => m.includes(SECRET)), "and the readable messages around it still read fine");

  section("7. The assistant is not dressed up as encrypted");
  await page.click("#pmBack"); await sleep(250);
  await page.click("#segAi"); await sleep(300);
  const warn = await page.$eval("#paneAi .pm-note", (n) => n.textContent);
  ok(/not end-to-end encrypted/i.test(warn), "the assistant pane warns before anything is typed", warn.slice(0, 80));
  const aiBadge = await page.$eval("#pmAiRow .pm-badge", (n) => n.textContent);
  ok(/not encrypted/i.test(aiBadge), "its row carries the warning too", aiBadge);

  await page.evaluate(() => document.querySelector('#pmAiRow [data-ai]')?.click());
  await sleep(500);
  const aiLock = await page.$eval("#pmLockText", (n) => n.textContent);
  ok(/not encrypted/i.test(aiLock),
     "and opening it FLIPS the header lock — the two kinds of thread never look alike", aiLock);
  const aiNote = await page.$eval("#pmConvNote", (n) => n.textContent);
  ok(/assistant reads/i.test(aiNote), "with the reason stated in the composer", aiNote);

  section("8. Announcing is for admins only");
  // Asserted on what is DRAWN, not on the attribute: [hidden] is only a UA
  // display:none and any author display rule silently beats it, so checking
  // n.hidden alone once passed while the button sat there in plain sight.
  ok(await page.$eval("#pmBroadcastBtn", (n) => getComputedStyle(n).display === "none"),
     "an ordinary user gets no announce button — really none, not just hidden=true");
  ok(errs.length === 0, "no page errors", errs.slice(0, 4).join("\n        "));

  // --shot leaves a picture behind. Layout is easier to judge by eye than by
  // assertion, and this run already has the page in a realistic state.
  if (process.argv.includes("--shot")) {
    await page.click("#pmBack");
    await sleep(300);
    await page.click("#segChats");
    await sleep(300);
    await page.screenshot({ path: "tests/shot_pmessage.png", fullPage: true });
    await page.click("#segPeople");
    await sleep(500);
    await page.screenshot({ path: "tests/shot_pmessage_agents.png", fullPage: true });
    await page.click("#segChats");
    await sleep(200);
    await page.evaluate(() => document.querySelector("#pmInbox [data-thread]").click());
    await sleep(900);
    await page.screenshot({ path: "tests/shot_pmessage_thread.png" });
    process.stdout.write("  (screenshots written)\n");
  }
  await page.close();

  const admin = await openPage("pawa4761@gmail.com");
  await sleep(600);
  ok(await admin.page.$eval("#pmBroadcastBtn", (n) => getComputedStyle(n).display !== "none"), "the admin does");
  await admin.page.click("#pmBroadcastBtn");
  await sleep(400);
  const scopes = await admin.page.$$eval("#pmCastRegion option", (n) => n.map((o) => o.textContent));
  ok(scopes.length > 5 && /Everyone in Tanzania/i.test(scopes[0]),
     "and can pick the whole country or one region", scopes.slice(0, 3).join(" / "));
  ok(await admin.page.$("#pmCastBody") !== null, "with a message to write");
  if (process.argv.includes("--shot")) {
    await admin.page.screenshot({ path: "tests/shot_pmessage_announce.png" });
  }

  section("8b. Opening a room");
  await admin.page.evaluate(() => { document.getElementById("pmModalBack").classList.remove("is-on"); });
  ok(await admin.page.$eval("#pmRoomsBtn", (n) => getComputedStyle(n).display !== "none"),
     "the admin gets a Rooms button");
  await admin.page.evaluate(() => document.getElementById("pmRoomsBtn").click());
  await sleep(400);
  const cats = await admin.page.$$eval("#pmRoomCat option", (n) => n.map((o) => o.value));
  ok(cats.join(",") === ",houses,services,trucks",
     "a room is scoped by what people deal in — and 'jobs' is absent, because a day job has no owner to group by",
     cats.join(","));
  // The preview is the safety rail: you must SEE who a scope caught before a
  // room you cannot un-send exists.
  ok(await admin.page.$eval("#pmRoomGo", (n) => n.disabled),
     "and the room cannot be opened until its scope has been previewed");
  await admin.page.evaluate(() => document.getElementById("pmRoomWho").click());
  await sleep(500);
  const preview = await admin.page.$eval("#pmRoomMsg", (n) => n.textContent);
  ok(preview.length > 0, "asking who is in scope answers", preview.slice(0, 70));

  section("8c. Inviting a customer who has no account");
  await admin.page.evaluate(() => { document.getElementById("pmModalBack").classList.remove("is-on"); });
  ok(await admin.page.$eval("#pmInviteBtn", (n) => getComputedStyle(n).display !== "none"),
     "an account holder gets an Invite button");
  await admin.page.evaluate(() => document.getElementById("pmInviteBtn").click());
  await sleep(400);
  await admin.page.evaluate(() => document.getElementById("pmInvGo").click());
  await sleep(600);
  const link = await admin.page.$eval("#pmInvLink", (n) => n.value).catch(() => "");
  ok(/[?&]i=/.test(link), "a link is produced, carrying the token", link.slice(0, 60));
  // The property the whole feature rests on: what the server was told is the
  // HASH, never the token in the link.
  const invCall = await admin.page.evaluate(() =>
    (window.__PM_SENT || []).filter((c) => c.name === "pm_invite_create").slice(-1)[0] || null);
  const tokenInLink = decodeURIComponent((link.split("i=")[1] || ""));
  ok(!!invCall && /^[0-9a-f]{64}$/.test(invCall.args.p_token_hash),
     "and what went to the server is a sha256", invCall ? invCall.args.p_token_hash : "no call");
  ok(!!invCall && invCall.args.p_token_hash !== tokenInLink && tokenInLink.length > 20,
     "which is NOT the token in the link — a stolen database yields no usable invites");
  await admin.page.close();

  section("9. Someone with no account at all");
  // The signed-out screen is not a wall: a person looking at a room has no
  // reason to make an account before asking whether it is still available, and
  // a wall there costs the AGENT the enquiry.
  const guest = await openPage(null, { signedOut: true });
  await sleep(900);

  ok(await guest.page.$("#pmGuestGo") !== null, "the signed-out screen offers to start a chat as a guest");
  const gateText = await guest.page.$eval("#pmGate", (n) => n.textContent);
  ok(/without an account/i.test(gateText), "saying so in as many words", gateText.slice(0, 60));
  ok(/encrypted the same way/i.test(gateText),
     "and promising the same encryption, not a lesser mode", gateText.slice(0, 200));
  ok(/this device/i.test(gateText),
     "while warning that the conversation lives on this device only");
  ok(await guest.page.$('#pmGate a[href="login.html"]') !== null, "signing in is still offered beside it");

  // A name is required — an agent answering an enquiry should have something
  // to call the person.
  await guest.page.click("#pmGuestGo");
  await sleep(500);
  ok(/two letters/i.test(await guest.page.$eval("#pmGuestMsg", (n) => n.textContent)),
     "starting with no name is refused", await guest.page.$eval("#pmGuestMsg", (n) => n.textContent));

  await guest.page.type("#pmGuestName", "Asha");
  await guest.page.click("#pmGuestGo");
  await sleep(1500);

  ok(await guest.page.$eval("#pmGate", (n) => n.hidden), "with a name, the gate gives way");
  const guestLock = await guest.page.$eval("#pmLockText", (n) => n.textContent);
  ok(/encrypted/i.test(guestLock) && !/not/i.test(guestLock),
     "the guest gets the same end-to-end lock as everyone else", guestLock);
  const guestFp = await guest.page.$eval("#pmFpBtn", (n) => n.textContent);
  ok(/\d{4} \d{4} \d{4}/.test(guestFp), "and their own safety number", guestFp);

  const guestPub = await guest.page.evaluate(() =>
    (window.__PM_SENT || []).find((c) => c.name === "pm_publish_key"));
  ok(guestPub && guestPub.args.p_display_name === "Asha",
     "published under the name they gave", JSON.stringify(guestPub && guestPub.args.p_display_name));
  ok(await guest.page.$eval("#panePeople", (n) => n.classList.contains("is-on")),
     "and they land on the agent list, which is what they came for");
  ok(await guest.page.$eval("#pmBroadcastBtn", (n) => getComputedStyle(n).display === "none"),
     "a guest gets no announce button");
  ok(guest.errs.length === 0, "no page errors on the guest path", guest.errs.slice(0, 3).join("\n        "));
  await guest.page.close();

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
} finally {
  await browser.close();
}
process.exit(fail === 0 ? 0 : 1);
